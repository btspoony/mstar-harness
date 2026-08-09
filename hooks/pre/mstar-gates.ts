/**
 * mstar-gates — omp `tool_call` pre-hook: blocking enforcement gate for
 * status.json writes and task dispatches.
 *
 * Loaded by omp as a plugin extension module at session startup (one module,
 * one handler — registration order within a module is stable). The factory
 * registers exactly ONE `tool_call` handler; the handler returns
 * `{ block: true, reason }` ONLY when `Enforcement: hard` governs the event
 * (compass `enforcement: hard` for status.json writes, Assignment-header
 * `Enforcement: hard` per dispatch entry) AND engine validation produced
 * violations. Everything else returns `undefined` — silent pass.
 *
 * Engine-version compatibility (hotfix): `composeDispatchGate` is loaded
 * LAZILY (module-level cached dynamic import, `loadComposeDispatchGate`) —
 * published engine 2.0.2 predates the export, and a static named import
 * would fail at module link and drop the WHOLE hook (both gates). When the
 * export is missing, Gate 2 (task dispatch) is skipped entirely — no
 * blocking, no violations — with a one-time `pi.logger.warn`; Gate 1
 * (status) keeps working. `dispatchGateLoader` is the exported test seam:
 * smoke scripts replace its `load` to simulate an old engine build.
 *
 * Hard invariant — NEVER throw, NEVER block on failure: omp fails CLOSED
 * (`{ block: true, reason: "Extension <path> failed: …" }`) when a handler
 * throws or times out, so the handler catches every unexpected error and
 * degrades to a silent pass. A broken engine import or a malformed event
 * passes — hard-gate opt-in is per compass / Assignment, never global, and
 * Invalid JSON
 * in write content is NOT a silent pass: Gate 1 reports it as
 * `status.invalid-json` (same shape as the engine's own unparseable-file
 * violation), which can block under a hard compass. A content-less write to
 * a status.json that does not exist yet (fresh scaffold/init) passes
 * silently, mirroring opencode `validateStatusWrite`'s existsSync guard.
 * Size guard (qc3 F-005): content strings beyond ~2MB are skipped without
 * parsing — a pathologically large write must not approach omp's 30s
 * handler timeout (fail-CLOSED in soft mode); the oversized write passes
 * silently (documented degradation, same as other content-glue limits).
 *
 * No semantic fork: every rule check is an engine call (status.validateStatus,
 * dispatch.composeDispatchGate — the single shared host dispatch-gate
 * composition, qc1 F-001/F-006 — status.resolveCompassEnforcement …). Local
 * code is shape-guards (path/basename filtering, task wire-shape
 * extraction), the JSON.parse glue for `input.content`, and reason
 * formatting — the same composition `packages/opencode/src/mstar.ts`
 * `validateStatusWrite` / `validateDispatchAssignment` use, with omp's
 * `{ block, reason }` refusal channel instead of the log channel.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  isReadOnlyAssignmentRole,
  parseAssignmentFields,
  resolveCompassEnforcement,
  resolveHarnessDir,
  validateStatus,
} from "@mstar-harness/engine";
import type { StatusDoc, ValidationResult } from "@mstar-harness/engine";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const STATUS_FILE = "status.json";
const STATUS_SKILL_POINTER = "skill: mstar-plan-artifacts/references/status-and-residuals.md";
const DISPATCH_SKILL_POINTER = "skill: mstar-dispatch-gates";

// ---------------------------------------------------------------------------
// Shape guards (glue only — field parsing/semantics live in the engine)
// ---------------------------------------------------------------------------

/** Target paths from a write/edit event: `input.path` (string) plus `input.paths` (array). */
function eventTargetPaths(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim() !== "") paths.push(value);
  };
  push(record.path);
  if (Array.isArray(record.paths)) {
    for (const value of record.paths) push(value);
  }
  return paths;
}

/**
 * True when `targetPath` is the canonical `{HARNESS_DIR}/status.json`:
 * basename is `status.json` AND `resolveHarnessDir(dirname(path))` resolves
 * AND `join(harnessDir, "status.json")` equals the resolved path. Everything
 * else is not a gated status write. Returns the harness dir when gated.
 */
function harnessDirOfStatusPath(targetPath: unknown): string | null {
  if (typeof targetPath !== "string" || targetPath.trim() === "") return null;
  const resolved = resolve(targetPath);
  if (basename(resolved) !== STATUS_FILE) return null;
  const harnessDir = resolveHarnessDir(dirname(resolved));
  if (harnessDir === null) return null;
  if (join(harnessDir, STATUS_FILE) !== resolved) return null;
  return harnessDir;
}

// ---------------------------------------------------------------------------
// Dispatch wire shapes (spike Q3): flat `{name?, agent?, task?, …}` AND batch
// `{context, tasks: [{name?, agent?, task?, …}]}` — both handled.
// ---------------------------------------------------------------------------

type DispatchEntry = { name: string; agent: string; task: string };

/** Extract dispatch entries from a `task` tool event input (both wire shapes). */
function taskDispatchEntries(input: unknown): DispatchEntry[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  const toEntry = (raw: unknown): DispatchEntry | null => {
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    return {
      name: typeof entry.name === "string" ? entry.name : "",
      agent: typeof entry.agent === "string" ? entry.agent : "",
      task: typeof entry.task === "string" ? entry.task : "",
    };
  };
  if (Array.isArray(record.tasks)) {
    const entries: DispatchEntry[] = [];
    for (const raw of record.tasks) {
      const entry = toEntry(raw);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }
  // Flat form: the input itself is the entry (`input.task` single string).
  const flat = toEntry(record);
  return flat !== null && flat.task !== "" ? [flat] : [];
}

// ---------------------------------------------------------------------------
// Violation formatting
// ---------------------------------------------------------------------------

function violationLine(violation: ValidationResult): string {
  return `[${violation.severity}] ${violation.code}: ${violation.message}${
    violation.fix ? ` (fix: ${violation.fix})` : ""
  }`;
}

/**
 * Size guard (qc3 F-005): content strings beyond ~2MB are skipped without
 * parsing — a pathologically large write must not approach omp's 30s handler
 * timeout (which fails CLOSED even in soft mode). The oversized write passes
 * silently; documented in the module header.
 */
const MAX_STATUS_CONTENT_LENGTH = 2 * 1024 * 1024;

/**
 * Validate the document being written to a gated status.json. `input.content`
 * as a string is the new document: JSON.parse it and run the engine validator
 * on the parsed doc — a parse failure is a violation (`status.invalid-json`,
 * the same code/message shape the engine emits for an unparseable file).
 * Parsed `null` / non-object / array content is a `status.invalid-json`
 * violation too (qc3 F-004 — the JSON literal `null` would otherwise slip
 * through `validateStatus`'s destructuring into the outer catch's silent
 * pass). Without a content string (edit-style events) the on-disk file is
 * validated — unless it does not exist yet (fresh scaffold/init write):
 * nothing to validate, silent pass (mirrors opencode `validateStatusWrite`'s
 * existsSync guard → null). Never throws (validateStatus catches its own
 * read errors).
 */
function validateStatusWriteDoc(content: unknown, filePath: string): ValidationResult[] {
  if (typeof content === "string") {
    if (content.length > MAX_STATUS_CONTENT_LENGTH) return []; // size guard — silent pass
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch (error) {
      return [
        {
          ok: false,
          severity: "high",
          code: "status.invalid-json",
          message: (error as Error).message,
        },
      ];
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      return [
        {
          ok: false,
          severity: "high",
          code: "status.invalid-json",
          message: "status.json content must be a JSON object",
        },
      ];
    }
    return validateStatus(doc as StatusDoc).violations;
  }
  if (!existsSync(filePath)) return []; // fresh scaffold/init write — nothing to validate
  return validateStatus(filePath).violations;
}

// ---------------------------------------------------------------------------
// Gate 1 — status.json writes
// ---------------------------------------------------------------------------

/**
 * Block a `write`/`edit` tool_call when it targets a canonical
 * `{HARNESS_DIR}/status.json` with violations and the harness compass
 * declares `enforcement: hard`. Soft (or no compass) → silent pass.
 */
function gateStatusWrite(eventInput: unknown): { block: true; reason: string } | undefined {
  const input = eventInput as Record<string, unknown>;
  for (const rawPath of eventTargetPaths(input)) {
    const harnessDir = harnessDirOfStatusPath(rawPath);
    if (harnessDir === null) continue; // not a gated status write — silent pass
    const violations = validateStatusWriteDoc(input.content, resolve(rawPath));
    if (violations.length === 0) continue;
    const enforcement = resolveCompassEnforcement(harnessDir);
    if (!enforcement.hard) continue; // soft mode — silent pass
    const reason = violations.map((v) => `${violationLine(v)} (${STATUS_SKILL_POINTER})`).join("\n");
    return { block: true, reason };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Gate 2 — task dispatch
// ---------------------------------------------------------------------------

/**
 * Engine-version compat: `composeDispatchGate` is the ONLY engine export the
 * hook needs that postdates the published 2.0.2 — everything else is
 * statically imported above. A static named import would fail at module link
 * on old engines and drop the WHOLE hook (both gates), so it is loaded
 * lazily and cached; any build lacking the export resolves to `null` and
 * Gate 2 skips itself (see `gateTaskDispatch`).
 */
type DispatchGateFn = (text: string, options?: { agent?: string; writable?: boolean }) => {
  ok: boolean;
  shaped: boolean;
  enforcement: { hard: boolean };
  violations: ValidationResult[];
};

let cachedDispatchGate: Promise<DispatchGateFn | null> | null = null;

export function loadComposeDispatchGate(): Promise<DispatchGateFn | null> {
  cachedDispatchGate ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.composeDispatchGate === "function" ? (mod.composeDispatchGate as DispatchGateFn) : null,
    )
    .catch(() => null);
  return cachedDispatchGate;
}

/**
 * Test seam for the degradation path: smoke scripts replace `load` to
 * simulate an engine build without `composeDispatchGate` (ESM namespace
 * bindings are read-only, so the holder indirection is what makes the
 * missing-export case stub-able). Runtime default is the cached loader.
 */
export const dispatchGateLoader: { load: () => Promise<DispatchGateFn | null> } = {
  load: loadComposeDispatchGate,
};

/** One-time degradation warning (module-level flag): emitted via the
 * extension logger on the first task event while `composeDispatchGate` is
 * missing. Defensive — the logger may be absent, and the degrade path must
 * never throw (optional chaining + local try/catch). */
let dispatchGateWarned = false;

function warnDispatchGateDegraded(logger: unknown): void {
  if (dispatchGateWarned) return;
  dispatchGateWarned = true;
  try {
    (
      logger as
        | { warn?: (message: string, context?: Record<string, unknown>) => void }
        | undefined
    )?.warn?.(
      "mstar-gates: installed engine lacks composeDispatchGate — task dispatch gate (Gate 2) disabled; status gate unaffected; upgrade the engine (next release)",
    );
  } catch {
    // degrade path must never throw
  }
}

/**
 * Validate one dispatch entry via the engine's single shared composition
 * `dispatch.composeDispatchGate` (qc1 F-001/F-006 — the same composition
 * opencode `validateDispatchAssignment` and `mstar_dispatch_validate` use,
 * incl. the `$MSTAR_WORKING_BRANCH` env fallback, qc1 F-002 / qc2 F-007 /
 * qc3 F-008): field validation with `writable: false` for read-only roles,
 * anti-recursion precheck against the host role binding (`entry.agent`),
 * and the default-branch gate for writable roles. Returns the entry's
 * violations and its OWN header enforcement flag (an example
 * `**Enforcement**: hard` line in the task body never hardens).
 */
function validateDispatchEntry(
  entry: DispatchEntry,
  composeDispatchGate: DispatchGateFn,
): { violations: ValidationResult[]; hard: boolean } {
  const text = entry.task;
  // Read-only roles (scout/explore) skip the branch-form/default-branch gates.
  const writable = isReadOnlyAssignmentRole(parseAssignmentFields(text).executeAs ?? "") ? false : undefined;
  const composed = composeDispatchGate(text, { agent: entry.agent, writable });
  return { violations: composed.violations, hard: composed.enforcement.hard };
}

/**
 * Block a `task` tool_call when any Assignment-shaped entry carries
 * `Enforcement: hard` in its header AND has violations. Per-entry violations
 * only — soft entries never block; no hard violations → silent pass.
 *
 * When the engine build lacks `composeDispatchGate` (pre-2.0.3), Gate 2 is
 * SKIPPED entirely — no blocking, no violations — with a one-time warning;
 * Gate 1 (status) keeps working (engine-version compatibility).
 */
async function gateTaskDispatch(
  eventInput: unknown,
  warnDegraded: () => void,
): Promise<{ block: true; reason: string } | undefined> {
  const composeDispatchGate = await dispatchGateLoader.load();
  if (composeDispatchGate === null) {
    warnDegraded();
    return undefined;
  }
  const blocked: string[] = [];
  for (const entry of taskDispatchEntries(eventInput)) {
    const { violations, hard } = validateDispatchEntry(entry, composeDispatchGate);
    if (!hard || violations.length === 0) continue;
    const label = entry.name !== "" ? `"${entry.name}"` : entry.agent !== "" ? `agent "${entry.agent}"` : "(unnamed)";
    for (const violation of violations) {
      blocked.push(`task dispatch entry ${label}: ${violationLine(violation)} (${DISPATCH_SKILL_POINTER})`);
    }
  }
  if (blocked.length === 0) return undefined;
  return { block: true, reason: blocked.join("\n") };
}

// ---------------------------------------------------------------------------
// Factory: one module, one handler
// ---------------------------------------------------------------------------

export default function mstarGates(pi: ExtensionAPI): void {
  const warnDegraded = (): void => warnDispatchGateDegraded(pi.logger);
  pi.on("tool_call", async (event) => {
    try {
      const toolName = event?.toolName ?? "";
      let block: { block: true; reason: string } | undefined;
      if (toolName === "write" || toolName === "edit") {
        block = gateStatusWrite(event?.input);
      } else if (toolName === "task") {
        block = await gateTaskDispatch(event?.input, warnDegraded);
      }
      return block;
    } catch {
      // NEVER throw, NEVER block on unexpected errors: omp fails CLOSED when
      // a handler throws — every unexpected failure degrades to silent pass.
      return undefined;
    }
  });
}
