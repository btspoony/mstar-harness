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
 * Hard invariant — NEVER throw, NEVER block on failure: omp fails CLOSED
 * (`{ block: true, reason: "Extension <path> failed: …" }`) when a handler
 * throws or times out, so the handler catches every unexpected error and
 * degrades to a silent pass. A broken engine import, a malformed event, or
 * invalid JSON in content all pass — hard-gate opt-in is per compass /
 * Assignment, never global, and an engine failure must not harden a workflow
 * that was soft.
 *
 * No semantic fork: every rule check is an engine call (status.validateStatus,
 * dispatch.validateAssignmentFields / antiRecursionPrecheck /
 * assertDefaultBranchProtected / parseEnforcementFlag …). Local code is
 * shape-guards (path/basename filtering, Assignment-shape detection, task
 * wire-shape extraction), the JSON.parse glue for `input.content`, and
 * reason formatting — the same composition `packages/opencode/src/mstar.ts`
 * `validateStatusWrite` / `validateDispatchAssignment` use, with omp's
 * `{ block, reason }` refusal channel instead of the log channel.
 */
import { basename, dirname, join, resolve } from "node:path";
import {
  antiRecursionPrecheck,
  assertDefaultBranchProtected,
  assignmentHeaderRegion,
  isReadOnlyAssignmentRole,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  parseEnforcementFlag,
  resolveCompassEnforcement,
  resolveHarnessDir,
  validateAssignmentFields,
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

/** `## Assignment` heading marker (same shape-guard as opencode mstar.ts). */
const ASSIGNMENT_HEADING_RE = /^#{1,6}\s+Assignment\s*$/m;
/** Assignment header field line (`Execute as` / `Delegation` / `Task category`). */
const ASSIGNMENT_FIELD_RE =
  /^[ \t]*(?:[-*][ \t]+)?\*{0,2}(Execute as|Delegation|Task category)\*{0,2}[ \t]*:[ \t]*(\S.*)$/gm;

/**
 * True when the text looks like an Assignment: carries the `## Assignment`
 * heading or at least one core field line. Non-Assignment prompts pass
 * silently — no false positives. Non-string input is never shaped.
 */
function isAssignmentShaped(assignmentText: unknown): boolean {
  if (typeof assignmentText !== "string") return false;
  return ASSIGNMENT_HEADING_RE.test(assignmentText) || assignmentText.match(ASSIGNMENT_FIELD_RE) !== null;
}

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
 * Validate the document being written to a gated status.json. `input.content`
 * as a string is the new document: JSON.parse it and run the engine validator
 * on the parsed doc — a parse failure is a violation (`status.invalid-json`,
 * the same code/message shape the engine emits for an unparseable file).
 * Without a content string (edit-style events) the on-disk file is validated.
 * Never throws (validateStatus catches its own read errors).
 */
function validateStatusWriteDoc(content: unknown, filePath: string): ValidationResult[] {
  if (typeof content === "string") {
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
    return validateStatus(doc as StatusDoc).violations;
  }
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
 * Validate one dispatch entry mirroring the opencode `validateDispatchAssignment`
 * composition (engine calls only): field validation with `writable: false` for
 * read-only roles, anti-recursion precheck against the host role binding
 * (`entry.agent`), and the default-branch gate for writable roles. Returns the
 * entry's violations and its OWN header enforcement flag.
 */
function validateDispatchEntry(entry: DispatchEntry): { violations: ValidationResult[]; hard: boolean } {
  const text = entry.task;
  // Shape guard: non-Assignment entries (plain task instructions) pass silently.
  if (!isAssignmentShaped(text)) return { violations: [], hard: false };

  const violations: ValidationResult[] = [];
  const fields = parseAssignmentFields(text);
  // Read-only roles (scout/explore) skip the branch-form/default-branch gates.
  const writable = isReadOnlyAssignmentRole(fields.executeAs ?? "") ? false : undefined;
  violations.push(...validateAssignmentFields(text, { writable }).violations);

  // Anti-recursion NEVER red line: entry.agent (flat form: input.agent) must
  // not equal the entry's own `Execute as`.
  const agent = entry.agent ?? "";
  if (agent.trim() !== "") {
    violations.push(...antiRecursionPrecheck(agent, fields.executeAs ?? "").violations);
  }

  // Default-branch gate for writable roles: branch from the entry's own
  // branch forms; a well-formed direct-on exception is honored only when its
  // branch is the one being checked.
  if (writable !== false) {
    const forms = parseAssignmentBranchForms(text);
    const branch = forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch;
    if (branch !== undefined && branch.trim() !== "") {
      const directOnException = parseBranchPolicyDirectOnBranch(text) === branch.trim();
      violations.push(...assertDefaultBranchProtected(branch.trim(), { directOnException }).violations);
    }
  }

  // Enforcement per entry: the entry's OWN header flag (assignmentHeaderRegion
  // — an example `**Enforcement**: hard` line in the task body never hardens).
  const enforcement = parseEnforcementFlag(assignmentHeaderRegion(text));
  return { violations, hard: enforcement.hard };
}

/**
 * Block a `task` tool_call when any Assignment-shaped entry carries
 * `Enforcement: hard` in its header AND has violations. Per-entry violations
 * only — soft entries never block; no hard violations → silent pass.
 */
function gateTaskDispatch(eventInput: unknown): { block: true; reason: string } | undefined {
  const blocked: string[] = [];
  for (const entry of taskDispatchEntries(eventInput)) {
    const { violations, hard } = validateDispatchEntry(entry);
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
  pi.on("tool_call", async (event) => {
    try {
      const toolName = event?.toolName ?? "";
      let block: { block: true; reason: string } | undefined;
      if (toolName === "write" || toolName === "edit") {
        block = gateStatusWrite(event?.input);
      } else if (toolName === "task") {
        block = gateTaskDispatch(event?.input);
      }
      return block;
    } catch {
      // NEVER throw, NEVER block on unexpected errors: omp fails CLOSED when
      // a handler throws — every unexpected failure degrades to silent pass.
      return undefined;
    }
  });
}
