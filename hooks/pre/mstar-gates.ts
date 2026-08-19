/**
 * mstar-gates — omp `tool_call` pre-hook: blocking enforcement gate for
 * harness coordination-document writes and task dispatches.
 *
 * Loaded by omp as a plugin extension module at session startup (one module,
 * one handler — registration order within a module is stable). The factory
 * registers exactly ONE `tool_call` handler; the handler returns
 * `{ block: true, reason }` ONLY when `Enforcement: hard` governs the event
 * (compass `enforcement: hard` for coordination writes, Assignment-header
 * `Enforcement: hard` per dispatch entry) AND engine validation produced
 * violations. Everything else returns `undefined` — silent pass.
 *
 * Gate 1 (writes) targets the three v3 coordination documents (compass
 * ruling 7 — hard cutover): the v2 root `{HARNESS_DIR}/status.json`
 * (engine `status.validateStatus`), workflow snapshots
 * `{HARNESS_DIR}/workflows/<id>/snapshot.json`
 * (`workflow.validateWorkflowSnapshot`) and project registers
 * `{HARNESS_DIR}/projects/<id>/residuals.json`
 * (`project.validateProjectRegister` — the v1 root `residual_findings`
 * surface is gone, so the residual write gate moved to the register path).
 *
 * Engine-version compatibility (hotfix): `composeDispatchGate` is loaded
 * LAZILY (module-level cached dynamic import, `loadComposeDispatchGate`) —
 * the export exists only in the engine release containing it, so a static
 * named import would fail at module link on older engines and drop the
 * WHOLE hook (both gates). When the export is missing, Gate 2 (task
 * dispatch) is skipped entirely — no blocking, no violations — with a
 * one-time `pi.logger.warn`; Gate 1 (writes) keeps working.
 * `dispatchGateLoader` is the exported test seam: smoke scripts replace
 * its `load` to simulate an old engine build (or an import failure).
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
 * a gated document that does not exist yet (fresh scaffold/init) passes
 * silently, mirroring opencode `validateStatusWrite`'s existsSync guard.
 * Size guard (qc3 F-005, extended per fix-wave S-d): content strings beyond
 * ~2MB AND on-disk gated documents beyond ~2MB (the edit path, which carries
 * no content string) are skipped without parsing — a pathologically large
 * write must not approach omp's 30s handler timeout (fail-CLOSED in soft
 * mode); the oversized write/edit passes silently (documented degradation,
 * same as other content-glue limits).
 *
 * Engine-version compatibility (qc3 F-001, fix-wave W-B): besides
 * `composeDispatchGate` (Gate 2, lazy-loaded below), the snapshot/register
 * validators (`validateWorkflowSnapshot` / `validateProjectRegister`) are
 * P1-only exports absent from the published engine floor `^2.0.2` — they
 * are lazy-loaded via `newValidatorsLoader`. On a stale engine, Gate 1
 * skips snapshot/register targets (silent pass, one-time warning) while
 * the root `status.json` gate keeps working; the hook module itself always
 * links.
 *
 * No semantic fork: every rule check is an engine call (status.validateStatus,
 * workflow.validateWorkflowSnapshot, project.validateProjectRegister,
 * dispatch.composeDispatchGate — the single shared host dispatch-gate
 * composition, qc1 F-001/F-006 — status.resolveCompassEnforcement …). Local
 * code is shape-guards (path/basename filtering, task wire-shape
 * extraction), the JSON.parse glue for `input.content`, and reason
 * formatting — the same composition `packages/opencode/src/mstar.ts`
 * `validateStatusWrite` / `validateDispatchAssignment` uses, with omp's
 * `{ block, reason }` refusal channel instead of the log channel.
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  isReadOnlyAssignmentRole,
  parseAssignmentFields,
  readJson,
  resolveRepoEnforcement,
  resolveHarnessDir,
  validateStatus,
} from "@mstar-harness/engine";
import type { StatusV2Doc, ValidationResult } from "@mstar-harness/engine";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const STATUS_FILE = "status.json";
const SNAPSHOT_FILE = "snapshot.json";
const REGISTER_FILE = "residuals.json";
const STATUS_SKILL_POINTER = "skill: mstar-plan-artifacts/references/status-and-residuals.md";
const DISPATCH_SKILL_POINTER = "skill: mstar-dispatch-gates";

/**
 * Engine-version compat (qc3 F-001 / fix-wave W-B): `validateWorkflowSnapshot`
 * and `validateProjectRegister` postdate the published engine floor
 * (`^2.0.2` lacks them) — a static named import would fail at module link
 * on older engines and drop the WHOLE hook (both gates). They are loaded
 * LAZILY (module-level cached dynamic import, same pattern as
 * `loadComposeDispatchGate`). When either export is missing, Gate 1 skips
 * snapshot/register targets entirely (silent pass) with a one-time warning;
 * the root `status.json` gate (static `validateStatus`, present in every
 * published engine) keeps working.
 */
type NewValidators = {
  validateWorkflowSnapshot: (doc: unknown) => { ok: boolean; violations: ValidationResult[] };
  validateProjectRegister: (doc: unknown) => { ok: boolean; violations: ValidationResult[] };
};

type NewValidatorsLoad =
  | { status: "ok"; validators: NewValidators }
  | { status: "missing" }
  | { status: "error"; error: unknown };

let cachedNewValidators: Promise<NewValidatorsLoad> | null = null;

export function loadNewValidators(): Promise<NewValidatorsLoad> {
  cachedNewValidators ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.validateWorkflowSnapshot === "function" && typeof mod.validateProjectRegister === "function"
        ? ({
            status: "ok",
            validators: {
              validateWorkflowSnapshot: mod.validateWorkflowSnapshot,
              validateProjectRegister: mod.validateProjectRegister,
            },
          } as const)
        : ({ status: "missing" } as const),
    )
    .catch((error: unknown) => ({ status: "error", error } as const));
  return cachedNewValidators;
}

/** Test seam (smoke scripts): replace `load` to simulate an engine build
 * without the P1 validators (missing) or a broken engine import (error). */
export const newValidatorsLoader: { load: () => Promise<NewValidatorsLoad> } = {
  load: loadNewValidators,
};

/** One-time degradation warnings for the P1 validators (module-level flags;
 * degrade path must never throw — optional chaining + local try/catch). */
let newValidatorsWarned = false;
let newValidatorsImportErrorWarned = false;

function warnNewValidatorsDegraded(logger: unknown, reason: "missing" | "error", error?: unknown): void {
  if (reason === "missing") {
    if (newValidatorsWarned) return;
    newValidatorsWarned = true;
  } else {
    if (newValidatorsImportErrorWarned) return;
    newValidatorsImportErrorWarned = true;
  }
  const message =
    reason === "missing"
      ? "mstar-gates: installed engine lacks validateWorkflowSnapshot/validateProjectRegister — snapshot/register write gate skipped; status.json gate unaffected; upgrade the engine (next release)"
      : `mstar-gates: snapshot/register write gate disabled: engine import failed — ${error instanceof Error ? error.message : String(error)}; status.json gate unaffected`;
  try {
    (
      logger as
        | { warn?: (message: string, context?: Record<string, unknown>) => void }
        | undefined
    )?.warn?.(message);
  } catch {
    // degrade path must never throw
  }
}

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

/** Gated harness coordination documents in v3 (compass ruling 7 — hard
 * cutover): the root `status.json` (v2), workflow snapshots
 * (`workflows/<id>/snapshot.json`) and project registers
 * (`projects/<id>/residuals.json`). Each kind maps to its engine
 * validator; everything else is not a gated coordination write. */
type HarnessDocKind = "status" | "snapshot" | "register";

/**
 * Classify `targetPath` as a canonical `{HARNESS_DIR}` coordination
 * document: basename is `status.json` at the harness root, `snapshot.json`
 * under `workflows/<id>/`, or `residuals.json` under `projects/<id>/`
 * (harness-relative, one path component each), AND
 * `resolveHarnessDir(dirname(path))` resolves. Everything else is not a
 * gated write. Returns the harness dir + doc kind when gated.
 */
function harnessDocKindOfTarget(targetPath: unknown): { harnessDir: string; kind: HarnessDocKind } | null {
  if (typeof targetPath !== "string" || targetPath.trim() === "") return null;
  const resolved = resolve(targetPath);
  const name = basename(resolved);
  if (name !== STATUS_FILE && name !== SNAPSHOT_FILE && name !== REGISTER_FILE) return null;
  const harnessDir = resolveHarnessDir(dirname(resolved));
  if (harnessDir === null) return null;
  const rel = relative(harnessDir, resolved);
  if (name === STATUS_FILE && rel === STATUS_FILE) return { harnessDir, kind: "status" };
  if (name === SNAPSHOT_FILE && /^workflows\/[^/]+\/snapshot\.json$/.test(rel)) return { harnessDir, kind: "snapshot" };
  if (name === REGISTER_FILE && /^projects\/[^/]+\/residuals\.json$/.test(rel)) return { harnessDir, kind: "register" };
  return null;
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
 * Validate the document being written to a gated harness coordination
 * document. `input.content` as a string is the new document: JSON.parse it
 * and run the matching engine validator on the parsed doc — a parse failure
 * is a violation (`status.invalid-json`, the same code/message shape the
 * engine emits for an unparseable file). Parsed `null` / non-object / array
 * content is a `status.invalid-json` violation too (qc3 F-004 — the JSON
 * literal `null` would otherwise slip through `validateStatus`'s
 * destructuring into the outer catch's silent pass). Without a content
 * string (edit-style events) the on-disk file is validated — unless it does
 * not exist yet (fresh scaffold/init write): nothing to validate, silent
 * pass. Never throws (the validators catch their own read errors).
 */
function validateStatusWriteDoc(
  content: unknown,
  filePath: string,
  kind: HarnessDocKind,
  newValidators: NewValidators | null,
): ValidationResult[] {
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
          message: `${basename(filePath)} content must be a JSON object`,
        },
      ];
    }
    return validateDocByKind(doc, kind, newValidators);
  }
  if (!existsSync(filePath)) return []; // fresh scaffold/init write — nothing to validate
  // Size guard on the ON-DISK edit path (qc2 S-1 / qc3 S-5 / fix-wave S-d):
  // edit events carry no content string, so the guard above never ran —
  // stat the target and apply the same 2MB skip before read+parse+validate
  // (a pathologically large gated doc must not approach omp's 30s handler
  // timeout; oversized edits pass silently, same documented degradation).
  try {
    if (statSync(filePath).size > MAX_STATUS_CONTENT_LENGTH) return [];
  } catch {
    return []; // unreadable target — silent pass (degrade path must never throw)
  }
  if (kind === "status") return validateStatus(filePath).violations; // path form handles invalid JSON itself
  let doc: unknown;
  try {
    doc = readJson(filePath);
  } catch (error) {
    // Mirror the engine's unparseable-file violation for snapshot/register
    // targets (their validators take a doc, not a path).
    return [
      {
        ok: false,
        severity: "high",
        code: "status.invalid-json",
        message: (error as Error).message,
      },
    ];
  }
  return validateDocByKind(doc, kind, newValidators);
}

/** Run the validator matching the gated doc kind (v3 hard cutover). The
 * snapshot/register validators are P1-only engine exports — callers pass
 * the lazily-loaded set; `null` (stale engine) can never be reached for
 * those kinds because `gateStatusWrite` skips them before calling. */
function validateDocByKind(doc: unknown, kind: HarnessDocKind, newValidators: NewValidators | null): ValidationResult[] {
  if (kind === "snapshot") return newValidators!.validateWorkflowSnapshot(doc).violations;
  if (kind === "register") return newValidators!.validateProjectRegister(doc).violations;
  return validateStatus(doc as StatusV2Doc).violations;
}

// ---------------------------------------------------------------------------
// Gate 1 — status.json writes
// ---------------------------------------------------------------------------

/**
 * Block a `write`/`edit` tool_call when it targets a canonical
 * `{HARNESS_DIR}` coordination document (v2 root status.json / workflow
 * snapshot / project register) with violations and the harness compass
 * declares `enforcement: hard`. Soft (or no compass) → silent pass.
 *
 * Snapshot/register targets need the lazily-loaded P1 validators
 * (engine-version compat, fix-wave W-B): on a stale engine the loader
 * reports missing/error and those targets are SKIPPED (silent pass) with
 * a one-time warning — the root status.json gate keeps working.
 */
async function gateStatusWrite(
  eventInput: unknown,
  warnDegraded: (reason: "missing" | "error", error?: unknown) => void,
): Promise<{ block: true; reason: string } | undefined> {
  const input = eventInput as Record<string, unknown>;
  let newValidators: NewValidatorsLoad | null = null;
  for (const rawPath of eventTargetPaths(input)) {
    const target = harnessDocKindOfTarget(rawPath);
    if (target === null) continue; // not a gated coordination write — silent pass
    let validatorsForKind: NewValidators | null = null;
    if (target.kind !== "status") {
      newValidators ??= await newValidatorsLoader.load();
      if (newValidators.status !== "ok") {
        warnDegraded(newValidators.status, newValidators.status === "error" ? newValidators.error : undefined);
        continue; // stale engine — skip snapshot/register validation (silent pass)
      }
      validatorsForKind = newValidators.validators;
    }
    const violations = validateStatusWriteDoc(input.content, resolve(rawPath), target.kind, validatorsForKind);
    if (violations.length === 0) continue;
    const enforcement = resolveRepoEnforcement(target.harnessDir);
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
 * Engine-version compat: `composeDispatchGate` postdates the engine release
 * containing it (published floor `^2.0.2` lacks it) — a static named import
 * would fail at module link on older engines and drop the WHOLE hook (both
 * gates), so it is loaded lazily and cached (same pattern as
 * `newValidatorsLoader` above). The loader returns a DISCRIMINATED result so
 * a missing export (`missing`) is never conflated with a real import
 * failure (`error`): Gate 2 skips itself either way (see `gateTaskDispatch`),
 * but the two produce different one-time warnings.
 */
type DispatchGateFn = (text: string, options?: { agent?: string; writable?: boolean }) => {
  ok: boolean;
  shaped: boolean;
  enforcement: { hard: boolean };
  violations: ValidationResult[];
};

type ComposeDispatchGateLoad =
  | { status: "ok"; gate: DispatchGateFn }
  | { status: "missing" }
  | { status: "error"; error: unknown };

let cachedDispatchGate: Promise<ComposeDispatchGateLoad> | null = null;

export function loadComposeDispatchGate(): Promise<ComposeDispatchGateLoad> {
  cachedDispatchGate ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.composeDispatchGate === "function"
        ? ({ status: "ok", gate: mod.composeDispatchGate as DispatchGateFn } as const)
        : ({ status: "missing" } as const),
    )
    .catch((error: unknown) => ({ status: "error", error } as const));
  return cachedDispatchGate;
}

/**
 * Test seam for the degradation path: smoke scripts replace `load` to
 * simulate an engine build without `composeDispatchGate` (missing) or a
 * broken engine import (error) — ESM namespace bindings are read-only, so
 * the holder indirection is what makes the degrade cases stub-able.
 * Runtime default is the cached loader.
 */
export const dispatchGateLoader: { load: () => Promise<ComposeDispatchGateLoad> } = {
  load: loadComposeDispatchGate,
};

/** One-time degradation warnings (module-level flags): emitted via the
 * extension logger on the first task event while Gate 2 is unavailable —
 * one message for a missing `composeDispatchGate` export (upgrade hint), a
 * DIFFERENT one for a real engine import failure (no upgrade claim — the
 * module itself is broken). Defensive — the logger may be absent, and the
 * degrade path must never throw (optional chaining + local try/catch). */
let dispatchGateWarned = false;
let dispatchGateImportErrorWarned = false;

function warnDispatchGateDegraded(logger: unknown, reason: "missing" | "error", error?: unknown): void {
  if (reason === "missing") {
    if (dispatchGateWarned) return;
    dispatchGateWarned = true;
  } else {
    if (dispatchGateImportErrorWarned) return;
    dispatchGateImportErrorWarned = true;
  }
  const message =
    reason === "missing"
      ? "mstar-gates: installed engine lacks composeDispatchGate — task dispatch gate (Gate 2) disabled; status gate unaffected; upgrade the engine (next release)"
      : `mstar-gates: task dispatch gate (Gate 2) disabled: engine import failed — ${error instanceof Error ? error.message : String(error)}; status gate unaffected`;
  try {
    (
      logger as
        | { warn?: (message: string, context?: Record<string, unknown>) => void }
        | undefined
    )?.warn?.(message);
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
 * When the engine build lacks `composeDispatchGate` (predating the export)
 * or the engine import itself fails, Gate 2 is SKIPPED entirely — no
 * blocking, no violations — with a one-time warning; Gate 1 (status) keeps
 * working (engine-version compatibility).
 */
async function gateTaskDispatch(
  eventInput: unknown,
  warnDegraded: (reason: "missing" | "error", error?: unknown) => void,
): Promise<{ block: true; reason: string } | undefined> {
  const load = await dispatchGateLoader.load();
  if (load.status !== "ok") {
    warnDegraded(load.status, load.status === "error" ? load.error : undefined);
    return undefined;
  }
  const composeDispatchGate = load.gate;
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
  const warnDegraded = (reason: "missing" | "error", error?: unknown): void =>
    warnDispatchGateDegraded(pi.logger, reason, error);
  const warnValidatorsDegraded = (reason: "missing" | "error", error?: unknown): void =>
    warnNewValidatorsDegraded(pi.logger, reason, error);
  pi.on("tool_call", async (event) => {
    try {
      const toolName = event?.toolName ?? "";
      let block: { block: true; reason: string } | undefined;
      if (toolName === "write" || toolName === "edit") {
        block = await gateStatusWrite(event?.input, warnValidatorsDegraded);
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
