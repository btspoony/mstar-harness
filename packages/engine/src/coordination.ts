/**
 * Plan-scoped coordination core (mstar-iteration/references/plan-scoped-pm.md).
 *
 * Public surface of the scoped plan-PM route:
 *
 * - `resolvePlanScope` / `resolveProcessHarnessDir` — the process root and the
 *   plan scope pinned from the **prepared Assignment** (never from the working
 *   directory's own artifacts).
 * - `bindPlanSession` — the one-time session bind (fresh L1 claim) and the
 *   read-only resume of an already-bound session.
 * - `readPlanCoordination` / `readCoordinatedArtifact` — reads.
 * - `mutatePlanCoordination` / `replaceCoordinatedArtifact` — the two locked
 *   writers.
 * - `showPrepareWorkflow` / `amendPrepareWorkflow` — the workflow-level guard
 *   for a Prepare lifecycle that must register newly approved plan rows and
 *   the reviewed integration checkout without a generic snapshot replacement
 *   (spec: the guarded, coordinator-authenticated Prepare-stage amendment).
 *
 * ## Operation scope
 *
 * Implemented operations: `prepare`, `progress`, `residual-add`,
 * `residual-close`, `handoff`, `accept`, `return`, `integration-start`,
 * `integration-accept`, `complete`, `reconcile`. `replaceCoordinatedArtifact`
 * covers the snapshot, status and project-register kinds; `review`/`json` are
 * not coordinated artifacts and refuse with
 * `coordination.scoped-writer-required` rather than no-op silently (§B
 * "unimplemented operations must be absent, not stubbed").
 *
 * ## Lock order (spec §C3)
 *
 * Snapshot before register. The pure domain path (`packages/engine/src/*`)
 * never acquires the root lock while holding a snapshot lock; the writers here
 * take the snapshot lock first and only then the project-register lock.
 * `withProtectedWrite` wraps every store write, so a protected coordination
 * document (`status.json`, a workflow `snapshot.json`, a project
 * `residuals.json`) can only be written from inside this module's locked
 * sections.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { GateResult } from "./core.js";
import {
  CoordinationError,
  assertExactKeys,
  canonicalTarget,
  evidenceRefOf,
  isArtifactVersion,
  isNonEmptyString,
  isPlainObject,
  readArtifactBytes,
  sha256Bytes,
  validatePlanHandoff,
  validatePlanProgress,
  validatePreparedCoordination,
  validateRowCoordination,
  withProtectedWrite,
  type EvidenceRef,
  type HandoffIntegration,
  type HandoffState,
  type PlanHandoff,
  type PlanProgress,
  type PreparedCoordination,
  type RowCoordination,
} from "./coordination-write.js";
import {
  claimLease,
  transferLease,
  validateExecutionLease,
  withStatusWriteLock,
  type ExecutionLease,
  type IntegrationMergeLease,
} from "./lease.js";
import {
  assertSafePathComponent,
  canonicalizeNearestExisting,
  resolveHarnessDir,
  resolvePlanDir,
  resolveProjectDir,
  resolveSddDir,
  resolveWorkflowDir,
} from "./path.js";
import {
  PROJECT_REGISTER_FILE,
  _DEFAULT_PROJECT,
  findingsCleanupGate,
  validateProjectRegister,
  type ProjectRegisterDoc,
  type ProjectRegisterEntry,
} from "./project.js";
import { parseCompassFrontmatterText } from "./iteration.js";
import { rowPlanIds, validatePlanRow, validateResidual, validateStatusV2, type PlanRow, type StatusV2Doc } from "./status.js";
import { getArtifactStore, resolveArtifactPath, type ArtifactRef, type ArtifactStore } from "./store.js";
import { isDistinctCheckout, readMainWorktree, type MainWorktreeInfo } from "./worktree.js";
import {
  isStandaloneDevelopmentWorkflow,
  rowValidationRoute,
  readWorkflowSnapshot,
  validateWorkflowSnapshot,
  WORKFLOW_TERMINAL_STATUSES,
  writeWorkflowSnapshot,
  type WorkflowBranchAnchors,
  type WorkflowExecutionPolicy,
  type WorkflowSnapshot,
} from "./workflow.js";

/* ------------------------------------------------------------------------ *
 * § Types — public surface
 * ------------------------------------------------------------------------ */

/**
 * Re-exported from the storage layer because this module is the public entry
 * point for the scoped writers: callers catch `CoordinationError` and branch
 * on its `code` without importing the storage layer directly.
 */
export { CoordinationError };

/** Bind roles: one coordinator per lifecycle, one plan session per plan. */
export type CoordinationRole = "plan-pm" | "coordinator";

/**
 * Scope address, both forms required by spec §B: from a pinned Assignment
 * path, or from a workflow/plan pair resolved through that row's `prepared`
 * block. Both forms resolve to the same `ResolvedPlanScope`.
 */
export type PlanScopeInput =
  | { assignmentPath: string }
  | { workflowId: string; planId: string; harnessDir?: string };

/** The fully pinned plan scope (spec §B `ResolvedPlanScope`). */
export type ResolvedPlanScope = {
  harnessRoot: string;
  workflowId: string;
  planId: string;
  /** `{WORKFLOW_DIR}/<workflow-id>/snapshot.json`. */
  snapshotPath: string;
  /** The plan markdown pinned by the Assignment `Plan Path`. */
  planPath: string;
  assignmentPath: string;
  worktreePath: string;
  workingBranch: string;
  projectId: string;
  sddDir: string;
};

/**
 * Session envelope persisted at
 * `{WORKFLOW_DIR}/<workflow-id>/sessions/<role>-<session-id>.json` (mode `0600`).
 * The envelope is the durable proof of who holds the session: the snapshot
 * stores its canonical path and every later call must present the same file.
 */
export type CoordinationSession = {
  schema_version: 1;
  role: CoordinationRole;
  session_id: string;
  workflow_id: string;
  plan_id?: string;
  harness_root: string;
};

/**
 * Bind addressing (spec §B). A fresh bind generates the session UUID and
 * creates `<workflow-dir>/<workflow-id>/sessions/<role>-<session-id>.json`
 * itself, unless the caller supplies `sessionId` — then the engine adopts that
 * value as the identity after validating it as a single safe path component (it
 * names the envelope's file, prefixed by the role). An existing session is
 * reached only through its explicit `resumePath`, which resumes read-only,
 * never writes and never re-identifies.
 */
export type BindPlanSessionInput =
  | { scope: PlanScopeInput; cwd: string; sessionId?: string }
  | { coordinator: true; workflowId: string; harnessDir?: string; cwd: string; sessionId?: string }
  | { resumePath: string; cwd: string };

/** One artifact read: payload plus the byte version it was read at. */
export type VersionedArtifact = { payload: unknown; version: string };

/** Everything `mstar plan show` needs, in one read. */
export type PlanCoordinationView = {
  /** Row `coordination.revision` (`0` when the row is not yet coordinated). */
  revision: number;
  /** `sha256:…` of the snapshot bytes, or `"absent"`. */
  snapshot_version: string;
  /** `sha256:…` of this plan's project register bytes, or `"absent"`. */
  register_version: string;
  /** `null` while the row carries no `prepared` block. */
  scope: ResolvedPlanScope | null;
  row: PlanRow;
  prepared?: PreparedCoordination;
  session: CoordinationSession;
  session_file: string;
  /** Operations this session may run now — implemented operations only. */
  allowed_operations: string[];
};

/** Success shape of a coordination call. */
export type CoordinationResult = {
  ok: true;
  operation: string;
  session: CoordinationSession;
  session_file: string;
  /** `claimed` / `resumed` / `prepared` / `progressed` / `residual-added` / `residual-closed`. */
  outcome?: string;
  view?: PlanCoordinationView;
};

/** One residual being registered: the nine v1 fields (+ optional `detail_doc`). */
export type ResidualInput = {
  id: string;
  title: string;
  severity: string;
  source: string;
  scope: string;
  decision: string;
  owner: string;
  target: string;
  tracking: string;
  detail_doc?: string;
};

export type PrepareCoordinationRequest = {
  kind: "prepare";
  /** The plan's pinned Assignment (absolute). */
  assignmentPath: string;
  expectedRevision: number;
};

export type ProgressCoordinationRequest = {
  kind: "progress";
  progress: PlanProgress;
  expectedRevision: number;
};

export type ResidualAddCoordinationRequest = {
  kind: "residual-add";
  entries: ResidualInput[];
  expectedRegisterVersion: string;
  /** Optional extra guard: the row revision must still match. */
  expectedRevision?: number;
};

export type ResidualCloseCoordinationRequest = {
  kind: "residual-close";
  entryId: string;
  note: string;
  expectedRegisterVersion: string;
  expectedRevision?: number;
};

/**
 * Handoff evidence (spec §D). Slice A types it so the union is stable; the
 * operations that consume it arrive with the handoff slice.
 */
export type HandoffEvidence = {
  source_sha: string;
  review_base: string;
  review_head: string;
  qc: { decision: "Approve" | "Approve with residuals"; reports: string[]; consolidated: string };
  qa: { gate: "mandatory" | "pm-acceptance"; decision: "pass"; report: string };
};

/**
 * The operation surface (spec §B): every kind is implemented and typed, so an
 * unknown shape is refused as `coordination.invalid-input` rather than
 * silently accepted.
 */
export type PlanCoordinationOperation =
  | { kind: "prepare"; assignmentPath: string }
  | { kind: "progress"; progress: PlanProgress }
  | { kind: "residual-add"; entries: ResidualInput[]; expectedRegisterVersion: string }
  | { kind: "residual-close"; entryId: string; note: string; expectedRegisterVersion: string }
  | { kind: "handoff"; evidence: HandoffEvidence }
  | { kind: "accept"; handoffId: string }
  | { kind: "return"; handoffId: string; reason: string }
  | { kind: "integration-start"; handoffId: string }
  | { kind: "integration-accept"; handoffId: string }
  | { kind: "complete"; handoffId: string }
  | { kind: "repair-delivery-source"; handoffId: string }
  | { kind: "reconcile"; handoffId: string };

/** One whole coordination request: one session, one operation, one precondition. */
export type CoordinationRequest = {
  sessionPath: string;
  /** Required for a coordinator session; never another plan for a plan session. */
  planId?: string;
  /** The selected row's `coordination.revision` from `show` (absent row = 0). */
  expectedRevision: number;
  operation: PlanCoordinationOperation;
};

/** Coordinator replacement of a coordinated artifact (spec §B). */
export type CoordinatedReplacement = {
  harnessRoot: string;
  ref: ArtifactRef;
  payload: unknown;
  /** Byte version the writer expects (`sha256:…`, or `absent` to create). */
  expectedVersion: string;
  /** Required for snapshot replacement (the coordinator session envelope). */
  sessionPath?: string;
};

/* ------------------------------------------------------------------------ *
 * § Constants
 * ------------------------------------------------------------------------ */

const SESSION_DIR = "sessions";
const SNAPSHOT_FILE = "snapshot.json";
const ENVELOPE_KEYS = ["schema_version", "role", "session_id", "workflow_id", "plan_id", "harness_root"] as const;
const RESIDUAL_INPUT_KEYS = [
  "id",
  "title",
  "severity",
  "source",
  "scope",
  "decision",
  "owner",
  "target",
  "tracking",
  "detail_doc",
] as const;
const ASSIGNMENT_QA_GATES: Record<string, true> = { mandatory: true, "pm-acceptance": true };
const ASSIGNMENT_FINDINGS_MODES: Record<string, true> = { "zero-residual": true, "allow-residual": true };

/** The operations this slice implements — the only ones ever advertised. */
const IMPLEMENTED_OPERATIONS: Record<string, true> = {
  prepare: true,
  progress: true,
  "residual-add": true,
  "residual-close": true,
  handoff: true,
  accept: true,
  return: true,
  "integration-start": true,
  "integration-accept": true,
  complete: true,
  "repair-delivery-source": true,
  reconcile: true,
};

/* ------------------------------------------------------------------------ *
 * § Small helpers
 * ------------------------------------------------------------------------ */

/** ISO-8601 timestamp for `prepared_at` / `bound_at` / snapshot `updated_at`. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Local calendar date `YYYY-MM-DD` (harness docs use local dates). */
function todayString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `error.code` when the thrown value carries a POSIX errno string. */
function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Row statuses a claim may start from (mirrors the pure lease transition). */
function isClaimableStatus(status: string): boolean {
  return status === "Todo" || status === "Blocked";
}

function invalidInput(message: string, details: Record<string, unknown> = {}): CoordinationError {
  return new CoordinationError("coordination.invalid-input", message, details);
}

function summarize(violations: readonly { code: string; message: string }[]): string {
  return violations.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
}

function assertViolationFree(violations: readonly { code: string; message: string }[], what: string): void {
  if (violations.length > 0) {
    throw new CoordinationError("coordination.invalid-input", `${what} is invalid \u2014 ${summarize(violations)}`, {
      violations: violations.map((entry) => entry.code),
    });
  }
}

function rowCoordinationOf(row: PlanRow): RowCoordination | undefined {
  const value = row.coordination;
  if (!isPlainObject(value)) return undefined;
  // Boundary cast: every row `coordination` block reaching here was written
  // through this module and validated by `validateRowCoordination`.
  const coordination = value as RowCoordination;
  return coordination;
}

function rowStatusOf(row: PlanRow): string {
  return isNonEmptyString(row.status) ? row.status : "";
}

/** Working branches a plan row reports (`metadata.track_branches` / `working_branch`). */
function reportedBranchesOf(row: PlanRow): string[] {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const out: string[] = [];
  if (isNonEmptyString(metadata.working_branch)) out.push(metadata.working_branch);
  if (Array.isArray(metadata.track_branches)) {
    for (const branch of metadata.track_branches) if (isNonEmptyString(branch)) out.push(branch);
  }
  return out;
}

function snapshotPathOf(harnessRoot: string, workflowId: string): string {
  return join(resolveWorkflowDir(harnessRoot, { harnessDir: harnessRoot }), workflowId, SNAPSHOT_FILE);
}

/**
 * The envelope path for one role. The role prefixes the file name so the two
 * sessions a workflow needs — coordinator and plan-pm — never collide on it,
 * even when a host supplies the same identity to both binds; the identity in
 * the payload is what stays shared.
 */
function sessionFilePath(
  harnessRoot: string,
  workflowId: string,
  role: CoordinationRole,
  sessionId: string,
): string {
  return join(
    resolveWorkflowDir(harnessRoot, { harnessDir: harnessRoot }),
    workflowId,
    SESSION_DIR,
    `${role}-${sessionId}.json`,
  );
}

/**
 * The canonical local store, pinned to `harnessRoot`. A remote/injected store
 * cannot serve this surface: every caller resolves paths from the same
 * FsStore path table, so a non-local store is refused rather than silently
 * writing somewhere else.
 */
function localStore(harnessRoot: string): ArtifactStore & { root: string } {
  let store: ArtifactStore;
  try {
    store = getArtifactStore();
  } catch (error) {
    throw new CoordinationError(
      "coordination.local-store-required",
      `no artifact store is resolvable from ${resolve(process.cwd())} \u2014 scoped coordination requires createFsStore(<control harness root>): ${errorMessage(error)}`,
      { harness_root: harnessRoot },
    );
  }
  const root = "root" in store ? store.root : undefined;
  if (typeof root !== "string") {
    throw new CoordinationError(
      "coordination.local-store-required",
      "the active ArtifactStore exposes no local root \u2014 scoped coordination requires the canonical FsStore",
      { harness_root: harnessRoot },
    );
  }
  const actual = canonicalTarget(root);
  const expected = canonicalTarget(harnessRoot);
  if (actual !== expected) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `active ArtifactStore root ${actual} does not match the resolved control harness root ${expected}`,
      { expected, actual },
    );
  }
  // Narrowed by the `root` presence + string check above: this is the FsStore
  // contract (`createFsStore` is the only local-root implementation).
  const local = store as ArtifactStore & { root: string };
  return local;
}

/* ------------------------------------------------------------------------ *
 * § Process root
 * ------------------------------------------------------------------------ */

/** `true` when `child` is `parent` or lives below it (both canonical). */
function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * The process-wide harness root (spec §C1): resolved from the **main**
 * worktree's root, never from the checkout the process happens to sit in.
 * This is the fix for the process-root bug — a process inside a linked
 * worktree must not resolve the worktree's own `.mstar`.
 *
 * Returns `null` when no harness root is resolvable (the unscoped CLI keeps
 * its existing non-Git fallback). Throws `coordination.not-in-git` when the
 * cwd is provably a linked checkout (a `.git` **file**) whose main worktree
 * cannot be read — falling back to local artifacts there is exactly the bug.
 */
export function resolveProcessHarnessDir(cwd: string = process.cwd(), harnessDir?: string): string | null {
  if (isNonEmptyString(harnessDir)) return resolve(cwd, harnessDir);
  const start = resolve(cwd);
  const main: MainWorktreeInfo | null = readMainWorktree(start);
  if (main !== null) return resolveHarnessDir(main.root);
  for (let dir = start; ; dir = dirname(dir)) {
    let linked = false;
    try {
      linked = statSync(join(dir, ".git")).isFile();
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (linked) {
      throw new CoordinationError(
        "coordination.not-in-git",
        `${start} is a linked checkout (${join(dir, ".git")} is a file) whose main worktree is unreadable \u2014 refusing to resolve a process harness root from local artifacts`,
        { cwd: start, marker: join(dir, ".git") },
      );
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolveHarnessDir(start);
}

/* ------------------------------------------------------------------------ *
 * § Assignment headers
 * ------------------------------------------------------------------------ */

type AssignmentHeaders = {
  assignmentPath: string;
  executionScope: string;
  executeAs: string;
  delegation: string;
  controlHarnessRoot: string;
  workflowId: string;
  planId: string;
  planPath: string;
  worktreePath: string;
  workingBranch: string;
  sddDir: string;
  qaGate: string;
  findingsCleanup: string;
  prepareGate: string;
};

const ASSIGNMENT_FIELDS: ReadonlyArray<{ header: string; field: keyof AssignmentHeaders }> = [
  { header: "execution scope", field: "executionScope" },
  { header: "execute as", field: "executeAs" },
  { header: "delegation", field: "delegation" },
  { header: "control harness root", field: "controlHarnessRoot" },
  { header: "workflow id", field: "workflowId" },
  { header: "plan id", field: "planId" },
  { header: "plan path", field: "planPath" },
  { header: "worktree path", field: "worktreePath" },
  { header: "working branch", field: "workingBranch" },
  { header: "sdd dir", field: "sddDir" },
  { header: "qa gate", field: "qaGate" },
  { header: "findings cleanup", field: "findingsCleanup" },
  { header: "prepare gate", field: "prepareGate" },
];

const ABSOLUTE_PATH_HEADERS = ["control harness root", "plan path", "worktree path", "sdd dir"] as const;

/**
 * Parse the pinned Assignment's C1 header block. Strict by contract: every
 * required header must be present exactly once with a legal value, otherwise
 * the scope cannot be pinned and the call fails loudly. Lines inside fenced
 * code blocks are never headers; unknown headers (the assignment's own prose,
 * `IDENTITY:`, …) are ignored.
 */
function parseAssignmentFile(assignmentPath: string): AssignmentHeaders {
  const abs = resolve(assignmentPath);
  if (!existsSync(abs)) {
    throw new CoordinationError("coordination.assignment-invalid", `Assignment not found: ${abs}`, { path: abs });
  }
  const text = readFileSync(abs, "utf8");
  const values = new Map<string, string>();
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\*{0,2}([A-Za-z][A-Za-z ]*[A-Za-z])\*{0,2}:\s*(\S.*)$/.exec(line);
    if (match === null) continue;
    const header = match[1].trim().toLowerCase();
    if (!ASSIGNMENT_FIELDS.some((field) => field.header === header)) continue;
    const value = match[2].trim();
    const prior = values.get(header);
    if (prior !== undefined && prior !== value) {
      throw new CoordinationError(
        "coordination.assignment-invalid",
        `${abs} declares conflicting duplicate header "${match[1].trim()}" (${prior} vs ${value})`,
        { path: abs, header: header },
      );
    }
    values.set(header, value);
  }
  const missing = ASSIGNMENT_FIELDS.filter((field) => !values.has(field.header)).map((field) => field.header);
  if (missing.length > 0) {
    throw new CoordinationError(
      "coordination.assignment-invalid",
      `${abs} is missing required scoped-Assignment header(s): ${missing.join(", ")}`,
      { path: abs, missing },
    );
  }
  const requireHeader = (header: string): string => {
    const declared = values.get(header);
    if (declared === undefined) {
      throw new CoordinationError(
        "coordination.assignment-invalid",
        `${abs} is missing required scoped-Assignment header "${header}"`,
        { path: abs, header },
      );
    }
    return declared;
  };
  for (const header of ABSOLUTE_PATH_HEADERS) {
    if (!isAbsolute(requireHeader(header))) {
      throw new CoordinationError(
        "coordination.assignment-invalid",
        `${abs} header "${header}" must be an absolute path`,
        { path: abs, header },
      );
    }
  }
  const executionScope = requireHeader("execution scope").toLowerCase();
  if (executionScope !== "plan") throw invalidInput(`Assignment "Execution scope" must be "plan" \u2014 got ${requireHeader("execution scope")}`, { path: abs });
  const executeAs = requireHeader("execute as");
  if (executeAs !== "project-manager") {
    throw invalidInput(`Assignment "Execute as" must be "project-manager" \u2014 got ${executeAs}`, { path: abs });
  }
  const delegation = requireHeader("delegation");
  if (!delegation.toLowerCase().startsWith("allowed")) {
    throw invalidInput(
      `Assignment "Delegation" must start with "allowed" (plan-local delegation only) \u2014 got ${delegation}`,
      { path: abs },
    );
  }
  const qaGate = requireHeader("qa gate").toLowerCase();
  if (ASSIGNMENT_QA_GATES[qaGate] !== true) {
    throw invalidInput(`Assignment "QA gate" must be one of ${Object.keys(ASSIGNMENT_QA_GATES).join(", ")} \u2014 got ${requireHeader("qa gate")}`, { path: abs });
  }
  const findingsCleanup = requireHeader("findings cleanup").toLowerCase();
  if (ASSIGNMENT_FINDINGS_MODES[findingsCleanup] !== true) {
    throw invalidInput(
      `Assignment "Findings cleanup" must be one of ${Object.keys(ASSIGNMENT_FINDINGS_MODES).join(", ")} \u2014 got ${requireHeader("findings cleanup")}`,
      { path: abs },
    );
  }
  const prepareGate = requireHeader("prepare gate").toLowerCase();
  if (prepareGate !== "go") {
    throw invalidInput(`Assignment "Prepare gate" must be "go" \u2014 got ${requireHeader("prepare gate")}`, { path: abs });
  }
  return {
    assignmentPath: canonicalTarget(abs),
    executionScope,
    executeAs,
    delegation,
    controlHarnessRoot: canonicalizeNearestExisting(requireHeader("control harness root")),
    workflowId: requireHeader("workflow id"),
    planId: requireHeader("plan id"),
    planPath: canonicalizeNearestExisting(requireHeader("plan path")),
    worktreePath: canonicalizeNearestExisting(requireHeader("worktree path")),
    workingBranch: requireHeader("working branch"),
    sddDir: canonicalizeNearestExisting(requireHeader("sdd dir")),
    qaGate,
    findingsCleanup,
    prepareGate,
  };
}

/** `true` when `planId` is safe to use as a single path component. */
function safePlanId(planId: string, where: string): string {
  try {
    assertSafePathComponent(planId, where);
  } catch (error) {
    throw invalidInput(`${where} ${JSON.stringify(planId)} is not a safe path component: ${errorMessage(error)}`, {
      plan_id: planId,
    });
  }
  return planId;
}

/** Longest session id the envelope contract accepts. */
const SESSION_ID_MAX_LENGTH = 128;

/**
 * The caller-supplied session identity, validated **before any write**. The id
 * names the envelope's file (`sessionFilePath`), so a value that could name
 * another directory or another file is refused here rather than left to a
 * filesystem error. `undefined` keeps the engine-generated UUID.
 */
function safeSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidInput("sessionId must be a string");
  if (value.length > SESSION_ID_MAX_LENGTH) {
    throw new CoordinationError(
      "coordination.invalid-session-id",
      `session id is longer than ${SESSION_ID_MAX_LENGTH} characters: ${JSON.stringify(value)}`,
      { session_id: value, max_length: SESSION_ID_MAX_LENGTH },
    );
  }
  try {
    assertSafePathComponent(value, "session id");
  } catch (error) {
    throw new CoordinationError(
      "coordination.invalid-session-id",
      `session id ${JSON.stringify(value)} is not a safe path component: ${errorMessage(error)}`,
      { session_id: value },
    );
  }
  return value;
}

/* ------------------------------------------------------------------------ *
 * § Scope resolution
 * ------------------------------------------------------------------------ */

type ScopeResolutionOptions = {
  /** Control root already chosen by the caller (must agree with the Assignment). */
  chosenRoot?: string | undefined;
  /** When `true` the row must already carry a matching `prepared` block. */
  requirePrepared: boolean;
  /** Snapshot already read by the caller (avoids a second read). */
  preloaded?: { snapshot: WorkflowSnapshot } | undefined;
};

function readSnapshot(dir: string): WorkflowSnapshot {
  const snapshotPath = join(dir, SNAPSHOT_FILE);
  if (!existsSync(snapshotPath)) {
    throw new CoordinationError("coordination.workflow-not-found", `workflow snapshot not found: ${snapshotPath}`, {
      path: snapshotPath,
    });
  }
  try {
    return readWorkflowSnapshot(dir).snapshot;
  } catch (error) {
    throw new CoordinationError(
      "coordination.store",
      `workflow snapshot is unreadable or invalid at ${snapshotPath}: ${errorMessage(error)}`,
      { path: snapshotPath },
    );
  }
}

function findPlanRow(snapshot: WorkflowSnapshot, planId: string): { row: PlanRow; index: number } {
  const matches = snapshot.plans
    .map((row, index) => ({ row, index }))
    .filter((entry) => rowPlanIds(entry.row).includes(planId));
  if (matches.length === 0) {
    throw new CoordinationError("coordination.plan-not-found", `plan ${planId} is not a row of workflow ${snapshot.id}`, {
      workflow_id: snapshot.id,
      plan_id: planId,
    });
  }
  if (matches.length > 1) {
    throw new CoordinationError(
      "coordination.store",
      `workflow ${snapshot.id} has ${matches.length} rows claiming plan id ${planId} \u2014 refusing to pick one`,
      { workflow_id: snapshot.id, plan_id: planId },
    );
  }
  return matches[0];
}

/** Project bucket of a plan row — `metadata.project_id` else `_default`. */
function projectIdOf(row: PlanRow): string {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const declared = metadata.project_id;
  if (isNonEmptyString(declared)) return safePlanId(declared, "metadata.project_id");
  return _DEFAULT_PROJECT;
}

function registerPathOf(harnessRoot: string, projectId: string): string {
  return join(resolveProjectDir(harnessRoot, { harnessDir: harnessRoot }), projectId, PROJECT_REGISTER_FILE);
}

function scopeFromAssignment(
  assignment: AssignmentHeaders,
  cwd: string,
  options: ScopeResolutionOptions,
): ResolvedPlanScope {
  const harnessRoot = assignment.controlHarnessRoot;
  // The Git-dependent process-root re-derivation cross-checks only callers
  // that bring no root of their own. Every session-scoped path (resume, read,
  // bind, and the sessionScope/coordinatorScope mutations) pins `chosenRoot`
  // to the root the session recorded and validated at bind time — re-deriving
  // it through Git from `session.harness_root` would probe from inside the
  // harness dir, so with `git` missing the guess lands on a nested candidate
  // and refuses as scope-mismatch before the operation's own proof can answer
  // (spec §D2: unavailable Git is the operation's `git-unavailable`).
  const processRoot = options.chosenRoot === undefined ? resolveProcessHarnessDir(cwd) : null;
  if (processRoot !== null && canonicalTarget(processRoot) !== harnessRoot) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `Assignment "Control harness root" ${harnessRoot} does not match the process harness root ${canonicalTarget(processRoot)}`,
      { expected: harnessRoot, actual: canonicalTarget(processRoot) },
    );
  }
  if (options.chosenRoot !== undefined && canonicalizeNearestExisting(options.chosenRoot) !== harnessRoot) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `Assignment "Control harness root" ${harnessRoot} does not match the requested harness root ${canonicalizeNearestExisting(options.chosenRoot)}`,
      { expected: harnessRoot, actual: canonicalizeNearestExisting(options.chosenRoot) },
    );
  }
  safePlanId(assignment.workflowId, "Workflow id");
  safePlanId(assignment.planId, "Plan id");

  const snapshot = options.preloaded?.snapshot ?? readSnapshot(dirname(snapshotPathOf(harnessRoot, assignment.workflowId)));
  if (snapshot.id !== assignment.workflowId) {
    throw new CoordinationError(
      "coordination.workflow-not-found",
      `workflow snapshot ${snapshot.id} does not match Assignment "Workflow id" ${assignment.workflowId}`,
      { expected: assignment.workflowId, actual: snapshot.id },
    );
  }
  const { row } = findPlanRow(snapshot, assignment.planId);
  const prepared = rowCoordinationOf(row)?.prepared;
  if (prepared === undefined) {
    if (options.requirePrepared) {
      throw new CoordinationError(
        "coordination.not-prepared",
        `plan ${assignment.planId} has no prepared Assignment \u2014 the coordinator must run \`prepare\` first`,
        { workflow_id: assignment.workflowId, plan_id: assignment.planId },
      );
    }
  } else if (canonicalTarget(prepared.assignment_path) !== assignment.assignmentPath) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `plan ${assignment.planId} is prepared from ${prepared.assignment_path}, not from ${assignment.assignmentPath}`,
      { expected: prepared.assignment_path, actual: assignment.assignmentPath },
    );
  }

  const expectedSdd = canonicalizeNearestExisting(resolveSddDir(harnessRoot, assignment.planId));
  if (assignment.sddDir !== expectedSdd) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `Assignment "SDD dir" ${assignment.sddDir} does not match the engine's ${expectedSdd}`,
      { expected: expectedSdd, actual: assignment.sddDir },
    );
  }
  const planDir = canonicalizeNearestExisting(resolvePlanDir(harnessRoot));
  if (dirname(assignment.planPath) !== planDir || basename(assignment.planPath) !== `${assignment.planId}.md`) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `Assignment "Plan Path" ${assignment.planPath} is not ${join(planDir, `${assignment.planId}.md`)}`,
      { expected: join(planDir, `${assignment.planId}.md`), actual: assignment.planPath },
    );
  }

  return {
    harnessRoot,
    workflowId: assignment.workflowId,
    planId: assignment.planId,
    snapshotPath: snapshotPathOf(harnessRoot, assignment.workflowId),
    planPath: assignment.planPath,
    assignmentPath: assignment.assignmentPath,
    worktreePath: assignment.worktreePath,
    workingBranch: assignment.workingBranch,
    projectId: projectIdOf(row),
    sddDir: expectedSdd,
  };
}

/** Discriminate the two scope-address forms without asserting a shape. */
function isAssignmentScopeInput(input: PlanScopeInput): input is { assignmentPath: string } {
  return "assignmentPath" in input;
}

/**
 * Resolve the plan scope (spec §B). Form A pins the scope from the Assignment
 * itself; form B starts from `{workflowId, planId}` and reads the pinned
 * Assignment path out of that row's `prepared` block — never "the first
 * unfinished row".
 */
export async function resolvePlanScope(input: PlanScopeInput, cwd: string = process.cwd()): Promise<ResolvedPlanScope> {
  assertExactKeys(input, ["assignmentPath", "workflowId", "planId", "harnessDir"], "scope input");
  if (isAssignmentScopeInput(input)) {
    if ("workflowId" in input || "planId" in input || "harnessDir" in input) {
      throw invalidInput("pass either an assignmentPath or a workflowId/planId pair, never both");
    }
    if (!isNonEmptyString(input.assignmentPath) || !isAbsolute(input.assignmentPath)) {
      throw invalidInput("assignmentPath must be an absolute path");
    }
    const assignment = parseAssignmentFile(input.assignmentPath);
    return scopeFromAssignment(assignment, cwd, { requirePrepared: true });
  }
  const { workflowId, planId, harnessDir } = input;
  if (!isNonEmptyString(workflowId) || !isNonEmptyString(planId)) {
    throw invalidInput("workflowId and planId are required");
  }
  if (harnessDir !== undefined && !isNonEmptyString(harnessDir)) {
    throw invalidInput("harnessDir must be a non-empty path when provided");
  }
  const harnessRoot = resolveProcessHarnessDir(cwd, harnessDir);
  if (harnessRoot === null) {
    throw new CoordinationError(
      "coordination.harness-not-found",
      `no harness root is resolvable from ${resolve(cwd)} \u2014 pass the control harness root explicitly`,
      { cwd: resolve(cwd) },
    );
  }
  const snapshot = readSnapshot(dirname(snapshotPathOf(harnessRoot, workflowId)));
  const { row } = findPlanRow(snapshot, planId);
  const prepared = rowCoordinationOf(row)?.prepared;
  if (prepared === undefined || !isNonEmptyString(prepared.assignment_path)) {
    throw new CoordinationError(
      "coordination.not-prepared",
      `plan ${planId} has no prepared Assignment \u2014 the coordinator must run \`prepare\` first`,
      { workflow_id: workflowId, plan_id: planId },
    );
  }
  const assignment = parseAssignmentFile(prepared.assignment_path);
  return scopeFromAssignment(assignment, cwd, { requirePrepared: true, chosenRoot: harnessRoot, preloaded: { snapshot } });
}

/* ------------------------------------------------------------------------ *
 * § Session envelopes
 * ------------------------------------------------------------------------ */

/** Read and validate a session envelope (throws `coordination.session-*`). */
export function readSessionEnvelope(sessionPath: string): CoordinationSession {
  if (!isNonEmptyString(sessionPath) || !isAbsolute(sessionPath)) {
    throw invalidInput("sessionPath must be an absolute path");
  }
  const abs = resolve(sessionPath);
  if (!existsSync(abs)) {
    throw new CoordinationError("coordination.session-not-found", `session envelope not found: ${abs}`, { path: abs });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    throw new CoordinationError("coordination.store", `session envelope is not valid JSON: ${abs}: ${errorMessage(error)}`, {
      path: abs,
    });
  }
  if (!isPlainObject(parsed)) {
    throw new CoordinationError("coordination.store", `session envelope must be an object: ${abs}`, { path: abs });
  }
  assertExactKeys(parsed, ENVELOPE_KEYS, `session envelope ${abs}`);
  if (parsed.schema_version !== 1) {
    throw invalidInput(`session envelope ${abs} must declare schema_version 1`, { path: abs });
  }
  const role = parsed.role;
  if (role !== "plan-pm" && role !== "coordinator") {
    throw new CoordinationError("coordination.session-role", `session envelope ${abs} has role ${JSON.stringify(role)}`, {
      path: abs,
    });
  }
  const sessionId = parsed.session_id;
  const workflowId = parsed.workflow_id;
  const harnessRoot = parsed.harness_root;
  if (!isNonEmptyString(sessionId)) {
    throw invalidInput(`session envelope ${abs} requires a non-empty session_id`, { path: abs });
  }
  if (!isNonEmptyString(workflowId)) {
    throw invalidInput(`session envelope ${abs} requires a non-empty workflow_id`, { path: abs });
  }
  if (!isNonEmptyString(harnessRoot)) {
    throw invalidInput(`session envelope ${abs} requires a non-empty harness_root`, { path: abs });
  }
  if (!isAbsolute(harnessRoot)) {
    throw invalidInput(`session envelope ${abs} harness_root must be absolute`, { path: abs });
  }
  const planId = parsed.plan_id;
  if (role === "plan-pm" && !isNonEmptyString(planId)) {
    throw new CoordinationError("coordination.session-role", `a plan-pm session envelope requires plan_id: ${abs}`, {
      path: abs,
    });
  }
  if (role === "coordinator" && planId !== undefined) {
    throw new CoordinationError("coordination.session-role", `a coordinator session envelope takes no plan_id: ${abs}`, {
      path: abs,
    });
  }
  const session: CoordinationSession = {
    schema_version: 1,
    role,
    session_id: sessionId,
    workflow_id: workflowId,
    harness_root: harnessRoot,
  };
  if (role === "plan-pm" && isNonEmptyString(planId)) session.plan_id = planId;
  return session;
}

function createSessionEnvelope(session: CoordinationSession): string {
  const path = sessionFilePath(session.harness_root, session.workflow_id, session.role, session.session_id);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      throw new CoordinationError(
        "coordination.session-mismatch",
        `session envelope already exists: ${path} \u2014 resume it instead of re-binding`,
        { path },
      );
    }
    throw new CoordinationError("coordination.store", `cannot create session envelope ${path}: ${errorMessage(error)}`, {
      path,
    });
  }
  return path;
}

function dropSessionEnvelope(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* the bind failed; a leftover envelope is harmless but never trusted */
  }
}

/* ------------------------------------------------------------------------ *
 * § Snapshot reads + writers
 * ------------------------------------------------------------------------ */

/** Assert the resolved snapshot path is the store's own path for this ref. */
function assertSnapshotPath(harnessRoot: string, workflowId: string, snapshotPath: string): string {
  const fromTable = resolveArtifactPath(harnessRoot, { kind: "snapshot", key: workflowId });
  if (canonicalizeNearestExisting(fromTable) !== canonicalizeNearestExisting(snapshotPath)) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `resolved snapshot path ${snapshotPath} is not the store's ${fromTable}`,
      { expected: fromTable, actual: snapshotPath },
    );
  }
  return snapshotPath;
}

/** Validate + write the snapshot inside the protected-write context. */
async function commitSnapshot(
  harnessRoot: string,
  workflowId: string,
  snapshotPath: string,
  next: WorkflowSnapshot,
): Promise<void> {
  const store = localStore(harnessRoot);
  assertSnapshotPath(harnessRoot, workflowId, snapshotPath);
  const gate = validateWorkflowSnapshot(next);
  if (!gate.ok) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `refusing to write a snapshot that fails validation \u2014 ${summarize(gate.violations)}`,
      { violations: gate.violations.map((entry) => entry.code) },
    );
  }
  await withProtectedWrite(snapshotPath, "put", () => store.put({ kind: "snapshot", key: workflowId, payload: next }));
}

type RowCommit = {
  row: PlanRow;
  coordination: RowCoordination;
  /** Snapshot-level fields this row mutation owns (e.g. the merge lease). */
  topLevel?: Partial<WorkflowSnapshot>;
  /** Snapshot-level keys this row mutation deletes in the same write. */
  dropTopLevel?: readonly string[];
};

type RowContext = {
  scope: ResolvedPlanScope;
  snapshot: WorkflowSnapshot;
  row: PlanRow;
  rowIndex: number;
  coordination: RowCoordination | undefined;
  revision: number;
};

/**
 * The single locked read-check-mutate-write path for one plan row.
 *
 * `expectedRevision: null` means "no revision precondition" (bind only). The
 * whole section runs under the snapshot write lock, so the read, the
 * revision/assignment checks and the write are atomic against other
 * coordinated writers.
 */
async function withRowCommit(
  scope: ResolvedPlanScope,
  opts: {
    expectedRevision: number | null;
    /** `prepare` rewrites the pin itself, so it may not re-check the old hash. */
    freshness?: boolean;
    precheck: (context: RowContext) => void | Promise<void>;
    mutate: (context: RowContext) => RowCommit | null | Promise<RowCommit | null>;
  },
): Promise<{ snapshot: WorkflowSnapshot; row: PlanRow; outcome: string }> {
  localStore(scope.harnessRoot);
  assertSnapshotPath(scope.harnessRoot, scope.workflowId, scope.snapshotPath);
  let outcome = "unchanged";
  const result = await withStatusWriteLock(scope.snapshotPath, async () => {
    const snapshot = readSnapshot(dirname(scope.snapshotPath));
    const { row, index } = findPlanRow(snapshot, scope.planId);
    const coordination = rowCoordinationOf(row);
    const context: RowContext = {
      scope,
      snapshot,
      row,
      rowIndex: index,
      coordination,
      revision: coordination?.revision ?? 0,
    };
    // Every row mutation re-authenticates the row's pin: an Assignment edited
    // after `prepare` invalidates the row until the coordinator re-prepares.
    if (opts.freshness !== false && coordination?.prepared !== undefined) {
      assertPreparedFresh(scope, coordination.prepared);
    }
    await opts.precheck(context);
    if (opts.expectedRevision !== null && context.revision !== opts.expectedRevision) {
      throw new CoordinationError(
        "coordination.version-conflict",
        `plan ${scope.planId} is at row revision ${context.revision}, expected ${opts.expectedRevision} \u2014 re-run \`mstar plan show\` and retry`,
        { expected: opts.expectedRevision, actual: context.revision, plan_id: scope.planId },
      );
    }
    const commit = await opts.mutate(context);
    if (commit === null) return { snapshot, row, outcome };
    outcome = "mutated";
    const nextSnapshot: WorkflowSnapshot = {
      ...snapshot,
      ...(commit.topLevel ?? {}),
      updated_at: nowIso(),
      plans: snapshot.plans.map((entry, i) => (i === index ? commit.row : entry)),
    };
    for (const key of commit.dropTopLevel ?? []) {
      delete (nextSnapshot as Record<string, unknown>)[key];
    }
    await commitSnapshot(scope.harnessRoot, scope.workflowId, scope.snapshotPath, nextSnapshot);
    return { snapshot: nextSnapshot, row: commit.row, outcome };
  });
  return result;
}

/** Re-verify the prepared Assignment hash; a changed Assignment is stale. */
function assertPreparedFresh(scope: ResolvedPlanScope, prepared: PreparedCoordination): void {
  if (!existsSync(scope.assignmentPath)) {
    throw new CoordinationError("coordination.assignment-stale", `prepared Assignment is gone: ${scope.assignmentPath}`, {
      path: scope.assignmentPath,
    });
  }
  const actual = sha256Bytes(readFileSync(scope.assignmentPath));
  if (actual !== prepared.assignment_sha256) {
    throw new CoordinationError(
      "coordination.assignment-stale",
      `Assignment ${scope.assignmentPath} changed after preparation (${prepared.assignment_sha256} \u2192 ${actual}) \u2014 the coordinator must re-run \`prepare\``,
      { path: scope.assignmentPath, expected: prepared.assignment_sha256, actual },
    );
  }
}

/** A coordinator session must match the snapshot's coordinator binding. */
function assertCoordinatorBinding(session: CoordinationSession, sessionPath: string, snapshot: WorkflowSnapshot): void {
  const coordinator = snapshot.coordination?.coordinator;
  if (coordinator === undefined) {
    throw new CoordinationError(
      "coordination.not-prepared",
      `workflow ${snapshot.id} has no coordinator binding \u2014 bind the coordinator session first`,
      { workflow_id: snapshot.id },
    );
  }
  if (coordinator.session_id !== session.session_id) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `workflow ${snapshot.id} is bound to coordinator session ${coordinator.session_id}, not ${session.session_id}`,
      { expected: coordinator.session_id, actual: session.session_id },
    );
  }
  if (canonicalTarget(coordinator.session_file) !== canonicalTarget(sessionPath)) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `coordinator session file ${sessionPath} is not the bound ${coordinator.session_file}`,
      { expected: coordinator.session_file, actual: canonicalTarget(sessionPath) },
    );
  }
}

/**
 * The row's own execution lease, validated (spec §C2/§C3: a released lease is
 * deleted, `null`/tombstone objects are invalid). Fails closed — callers that
 * need a holder never proceed on an absent or malformed lease.
 */
function requireExecutionLease(row: PlanRow, planId: string, what: string): ExecutionLease {
  const gate = validateExecutionLease(row.execution_lease);
  if (!gate.ok) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires ${planId} to hold an active execution lease \u2014 ${summarize(gate.violations)}`,
      { plan_id: planId, violations: gate.violations.map((entry) => entry.code) },
    );
  }
  // Boundary cast: `validateExecutionLease` just proved the shape.
  return row.execution_lease as ExecutionLease;
}

/** The row's execution lease, proven to be held by `holder` (spec §D). */
function assertExecutionHolder(row: PlanRow, holder: string, planId: string, what: string): void {
  const lease = requireExecutionLease(row, planId, what);
  if (lease.holder !== holder) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `${what} requires ${planId}'s execution lease held by ${holder} \u2014 it is held by ${lease.holder}`,
      { plan_id: planId, expected: holder, actual: lease.holder },
    );
  }
}

/**
 * A plan session must match the row's session binding, and — for a write — must
 * still hold the row's execution lease: identity is not ownership, and a
 * transferred or released lease ends the plan's authority (§D "claim before
 * InProgress"; §E keeps both leases until complete). Only the read paths
 * (`show`/`resume`) pass `readOnly`, because a completed row carries no lease
 * yet stays reportable.
 */
function assertRowBinding(
  session: CoordinationSession,
  sessionPath: string,
  row: PlanRow,
  planId: string,
  options: { readOnly?: boolean } = {},
): void {
  const binding = rowCoordinationOf(row)?.session;
  if (binding === undefined) {
    throw new CoordinationError("coordination.not-prepared", `plan ${planId} has no bound plan session`, {
      plan_id: planId,
    });
  }
  if (binding.session_id !== session.session_id) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `plan ${planId} is bound to session ${binding.session_id}, not ${session.session_id}`,
      { expected: binding.session_id, actual: session.session_id },
    );
  }
  if (canonicalTarget(binding.session_file) !== canonicalTarget(sessionPath)) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `session file ${sessionPath} is not the bound ${binding.session_file}`,
      { expected: binding.session_file, actual: canonicalTarget(sessionPath) },
    );
  }
  if (options.readOnly !== true) assertExecutionHolder(row, session.session_id, planId, "a plan-owned write");
}

/** Reject row mutations while a handoff owns the plan's transition. */
function assertNoHandoff(context: RowContext): void {
  const handoff = context.coordination?.handoff;
  if (handoff === undefined || handoff.state === "returned") return;
  throw new CoordinationError(
    "coordination.invalid-transition",
    `plan ${context.scope.planId} is handed off (state ${String(handoff.state)}) \u2014 the plan session owns no transition until the coordinator returns or completes it`,
    { plan_id: context.scope.planId, state: handoff.state },
  );
}

function allowedOperations(
  role: CoordinationRole,
  sessionId: string,
  snapshot: WorkflowSnapshot,
  row: PlanRow,
): string[] {
  const coordination = rowCoordinationOf(row);
  const status = rowStatusOf(row);
  const handoff = coordination?.handoff;
  const out: string[] = [];
  if (role === "coordinator") {
    // The coordinator seat is per workflow: an unbound session advertises nothing.
    if (snapshot.coordination?.coordinator.session_id !== sessionId) return [];
    if (
      coordination?.prepared === undefined &&
      coordination?.session === undefined &&
      handoff === undefined &&
      isClaimableStatus(status)
    ) {
      out.push("prepare");
    }
    switch (handoff?.state) {
      case "submitted":
        out.push("accept", "return");
        break;
      case "accepted":
        if (isStandaloneDevelopmentWorkflow(snapshot)) {
          out.push("return", "complete", "repair-delivery-source");
        } else {
          out.push("return", "integration-start");
        }
        break;
      case "integrating":
        out.push("integration-accept", "complete", "reconcile");
        break;
      case "merged":
        out.push("complete", "reconcile");
        break;
      case "completed":
        out.push("reconcile");
        break;
      default:
        break;
    }
  } else if (coordination?.session?.session_id === sessionId && coordination.prepared !== undefined) {
    // A plan session keeps only `handoff`: returning a handoff restores the
    // same session, so both directions stay available to it without rebinding.
    if (handoff === undefined || handoff.state === "returned") {
      out.push("progress", "residual-add", "residual-close", "handoff");
    }
  }
  return out.filter((kind) => IMPLEMENTED_OPERATIONS[kind] === true);
}

/* ------------------------------------------------------------------------ *
 * § Reads
 * ------------------------------------------------------------------------ */

function buildView(
  harnessRoot: string,
  workflowId: string,
  projectId: string,
  scope: ResolvedPlanScope | null,
  snapshot: WorkflowSnapshot,
  row: PlanRow,
  session: CoordinationSession,
  sessionPath: string,
): PlanCoordinationView {
  const coordination = rowCoordinationOf(row);
  const snapshotBytes = readArtifactBytes(snapshotPathOf(harnessRoot, workflowId));
  const registerBytes = readArtifactBytes(registerPathOf(harnessRoot, projectId));
  return {
    revision: coordination?.revision ?? 0,
    snapshot_version: snapshotBytes?.version ?? "absent",
    register_version: registerBytes?.version ?? "absent",
    scope,
    row,
    prepared: coordination?.prepared,
    session,
    session_file: canonicalTarget(sessionPath),
    allowed_operations: allowedOperations(session.role, session.session_id, snapshot, row),
  };
}

/**
 * Read this session's plan coordination view (spec §B). A coordinator session
 * must select a plan; a plan session reads only its own row. A row that is not
 * yet prepared yields `scope: null` and the raw row.
 */
export async function readPlanCoordination(
  sessionPath: string,
  planId?: string,
  cwd: string = process.cwd(),
): Promise<PlanCoordinationView> {
  const session = readSessionEnvelope(sessionPath);
  if (planId !== undefined && !isNonEmptyString(planId)) throw invalidInput("planId must be a non-empty string");
  let targetPlanId: string;
  if (session.role === "coordinator") {
    if (planId === undefined) {
      throw invalidInput("a coordinator session must select a plan (`--plan <id>`)", { session_id: session.session_id });
    }
    targetPlanId = safePlanId(planId, "planId");
  } else {
    const own = session.plan_id;
    if (!isNonEmptyString(own)) {
      throw new CoordinationError("coordination.session-role", `plan session ${session.session_id} carries no plan id`, {
        session_id: session.session_id,
      });
    }
    if (planId !== undefined && planId !== own) {
      throw new CoordinationError(
        "coordination.session-mismatch",
        `plan session ${session.session_id} reads only its own plan ${own}, not ${planId}`,
        { expected: own, actual: planId },
      );
    }
    targetPlanId = own;
  }

  const harnessRoot = canonicalizeNearestExisting(session.harness_root);
  const processRoot = resolveProcessHarnessDir(cwd);
  if (processRoot !== null && canonicalTarget(processRoot) !== harnessRoot) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `session ${session.session_id} belongs to harness root ${harnessRoot}, but this process resolves ${canonicalTarget(processRoot)}`,
      { expected: harnessRoot, actual: canonicalTarget(processRoot) },
    );
  }
  localStore(harnessRoot);
  const snapshotPath = snapshotPathOf(harnessRoot, session.workflow_id);
  assertSnapshotPath(harnessRoot, session.workflow_id, snapshotPath);
  const snapshot = readSnapshot(dirname(snapshotPath));
  const { row } = findPlanRow(snapshot, targetPlanId);
  if (session.role === "coordinator") {
    assertCoordinatorBinding(session, sessionPath, snapshot);
  } else {
    assertRowBinding(session, sessionPath, row, targetPlanId, { readOnly: true });
  }

  const prepared = rowCoordinationOf(row)?.prepared;
  let scope: ResolvedPlanScope | null = null;
  if (prepared !== undefined) {
    const assignment = parseAssignmentFile(prepared.assignment_path);
    scope = scopeFromAssignment(assignment, cwd, {
      requirePrepared: true,
      chosenRoot: harnessRoot,
      preloaded: { snapshot },
    });
    assertPreparedFresh(scope, prepared);
  }
  return buildView(
    harnessRoot,
    session.workflow_id,
    projectIdOf(row),
    scope,
    snapshot,
    row,
    session,
    sessionPath,
  );
}

/**
 * Read one coordinated artifact plus its byte version, from a **single** byte
 * read. `payload` is `undefined` and `version` is `"absent"` when the document
 * does not exist. Snapshot payloads are validated before they are handed out.
 */
export async function readCoordinatedArtifact(
  harnessRoot: string,
  ref: ArtifactRef,
): Promise<VersionedArtifact> {
  if (!isPlainObject(ref) || !isNonEmptyString(ref.kind) || !isNonEmptyString(ref.key)) {
    throw invalidInput("ref must be an ArtifactRef with kind and key");
  }
  const root = canonicalizeNearestExisting(harnessRoot);
  localStore(root);
  const path = resolveArtifactPath(root, ref);
  const bytes = readArtifactBytes(path);
  if (bytes === undefined) return { payload: undefined, version: "absent" };
  if (bytes.payload !== undefined) assertStoredArtifact(ref.kind, bytes.payload, path, root);
  return { payload: bytes.payload, version: bytes.version };
}

/**
 * Validate a stored artifact against its kind's owner validator. The read
 * surface fails loud on invalid content instead of handing out a document the
 * scoped writers would refuse to write back.
 */
function assertStoredArtifact(kind: string, payload: unknown, path: string, harnessRoot: string): void {
  let gate: GateResult | undefined;
  if (kind === "snapshot") gate = validateWorkflowSnapshot(payload);
  else if (kind === "status") gate = validateStatusV2(payload as StatusV2Doc, { harnessDir: harnessRoot });
  else if (kind === "residuals") gate = validateProjectRegister(payload);
  if (gate === undefined || gate.ok) return;
  throw new CoordinationError(
    "coordination.store",
    `${kind} ${path} fails validation \u2014 ${summarize(gate.violations)}`,
    { path, kind, violations: gate.violations.map((entry) => entry.code) },
  );
}

/* ------------------------------------------------------------------------ *
 * § bindPlanSession
 * ------------------------------------------------------------------------ */

type BindContext = {
  harnessRoot: string;
  workflowId: string;
};

/**
 * Root register check (spec §C1): the workflow must be an active entry. The
 * entry is returned so callers that must re-check its declared lifecycle
 * status (the Prepare amendment) read the same document this check accepted.
 */
function assertRootRegisterEntry(harnessRoot: string, workflowId: string): Record<string, unknown> {
  const store = localStore(harnessRoot);
  const path = resolveArtifactPath(harnessRoot, { kind: "status", key: "root" });
  if (!existsSync(path)) {
    throw new CoordinationError("coordination.workflow-not-found", `root status.json not found: ${path}`, { path });
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CoordinationError("coordination.store", `root status.json is not valid JSON: ${path}: ${errorMessage(error)}`, {
      path,
    });
  }
  const workflows = isPlainObject(doc) && Array.isArray(doc.workflows) ? doc.workflows : [];
  const entry = workflows.find(
    (candidate) => isPlainObject(candidate) && candidate.id === workflowId,
  );
  if (entry === undefined) {
    throw new CoordinationError(
      "coordination.workflow-not-found",
      `workflow ${workflowId} is not an active entry of ${path} (kind ${store.root})`,
      { path, workflow_id: workflowId },
    );
  }
  // Boundary cast: the predicate above proved a plain object.
  return entry as Record<string, unknown>;
}

/** Coordinator residency (spec §C1): main worktree or recorded integration worktree. */
function assertCoordinatorResidency(cwd: string, snapshot: WorkflowSnapshot): MainWorktreeInfo {
  const main = readMainWorktree(cwd);
  if (main === null) {
    throw new CoordinationError(
      "coordination.not-in-git",
      `coordinator binding requires a Git process root \u2014 ${resolve(cwd)} has no readable main worktree`,
      { cwd: resolve(cwd) },
    );
  }
  const here = canonicalizeNearestExisting(cwd);
  const allowed = [canonicalTarget(main.root)];
  const integration = snapshot.integration_worktree_path;
  if (isNonEmptyString(integration)) allowed.push(canonicalizeNearestExisting(integration));
  if (!allowed.some((candidate) => isWithin(candidate, here))) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `a coordinator session must be bound from the main worktree or the recorded integration worktree \u2014 ${here} is neither (${allowed.join(", ")})`,
      { cwd: here, allowed },
    );
  }
  return main;
}

/**
 * Fresh coordinator bind (spec §C1). The engine generates the session UUID —
 * or adopts the caller-supplied one — and creates the envelope **inside** the
 * validated critical section, then records the binding in the same snapshot
 * commit. A crash between the two leaves an orphan envelope that grants
 * nothing: every later call matches the snapshot.
 */
async function bindCoordinatorSession(
  cwd: string,
  workflowId: string,
  harnessDir?: string,
  sessionId?: string,
): Promise<CoordinationResult> {
  const harnessRoot = requireProcessRoot(cwd, harnessDir);
  safePlanId(workflowId, "workflowId");
  const snapshotPath = snapshotPathOf(harnessRoot, workflowId);
  assertSnapshotPath(harnessRoot, workflowId, snapshotPath);

  assertCoordinatorResidency(cwd, readSnapshot(dirname(snapshotPath)));
  const session: CoordinationSession = {
    schema_version: 1,
    role: "coordinator",
    session_id: sessionId ?? randomUUID(),
    workflow_id: workflowId,
    harness_root: harnessRoot,
  };
  let created = "";
  try {
    await withStatusWriteLock(snapshotPath, async () => {
      const snapshot = readSnapshot(dirname(snapshotPath));
      if (snapshot.status !== "running") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `workflow ${workflowId} is ${String(snapshot.status)} \u2014 a coordinator session binds only to a running lifecycle`,
          { workflow_id: workflowId, status: snapshot.status },
        );
      }
      assertRootRegisterEntry(harnessRoot, workflowId);
      const existing = snapshot.coordination?.coordinator;
      if (existing !== undefined) {
        throw new CoordinationError(
          "coordination.duplicate-holder",
          `workflow ${workflowId} already has coordinator session ${existing.session_id} \u2014 resume it instead of binding a second one`,
          { holder: existing.session_id, session_file: existing.session_file },
        );
      }
      created = createSessionEnvelope(session);
      const next: WorkflowSnapshot = {
        ...snapshot,
        updated_at: nowIso(),
        coordination: {
          coordinator: { session_id: session.session_id, session_file: canonicalTarget(created), bound_at: nowIso() },
        },
      };
      await commitSnapshot(harnessRoot, workflowId, snapshotPath, next);
    });
  } catch (error) {
    if (created !== "") dropSessionEnvelope(created);
    throw error;
  }
  // No `view`: a coordinator session binds the lifecycle, not one plan row —
  // the caller selects a plan explicitly (`plan show --plan <id>`).
  return { ok: true, operation: "bind", session, session_file: created, outcome: "bound" };
}


function requireProcessRoot(cwd: string, harnessDir?: string): string {
  const root = resolveProcessHarnessDir(cwd, harnessDir);
  if (root === null) {
    throw new CoordinationError(
      "coordination.harness-not-found",
      `no harness root is resolvable from ${resolve(cwd)} \u2014 pass the control harness root explicitly`,
      { cwd: resolve(cwd) },
    );
  }
  return root;
}

/**
 * Fresh plan bind (spec §C2): the scope is already pinned and validated. The
 * engine generates the session UUID — or adopts the caller-supplied one —
 * creates the envelope inside the validated critical section, claims the L1
 * lease and writes the row session, status and revision in one snapshot
 * commit.
 */
async function bindPlanSessionForPlan(scope: ResolvedPlanScope, sessionId?: string): Promise<CoordinationResult> {
  const { harnessRoot, workflowId, planId } = scope;
  const snapshotPath = snapshotPathOf(harnessRoot, workflowId);
  assertSnapshotPath(harnessRoot, workflowId, snapshotPath);
  const snapshot = readSnapshot(dirname(snapshotPath));
  const { row } = findPlanRow(snapshot, planId);
  const prepared = rowCoordinationOf(row)?.prepared;
  if (prepared === undefined) {
    throw new CoordinationError(
      "coordination.not-prepared",
      `plan ${planId} has no prepared Assignment \u2014 the coordinator must run \`prepare\` first`,
      { workflow_id: workflowId, plan_id: planId },
    );
  }
  const assignment = parseAssignmentFile(prepared.assignment_path);
  const pinned = scopeFromAssignment(assignment, harnessRoot, {
    requirePrepared: true,
    chosenRoot: harnessRoot,
    preloaded: { snapshot },
  });
  assertPreparedFresh(pinned, prepared);
  if (!existsSync(scope.worktreePath) || !statSync(scope.worktreePath).isDirectory()) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `Assignment "Worktree path" ${scope.worktreePath} is not an existing directory \u2014 create the plan worktree before binding`,
      { path: scope.worktreePath },
    );
  }


  const session: CoordinationSession = {
    schema_version: 1,
    role: "plan-pm",
    session_id: sessionId ?? randomUUID(),
    workflow_id: workflowId,
    plan_id: planId,
    harness_root: harnessRoot,
  };
  let created = "";
  const result = await withRowCommit(scope, {
    expectedRevision: null,
    precheck: (context) => {
      if (context.coordination?.prepared === undefined) {
        throw new CoordinationError("coordination.not-prepared", `plan ${planId} is not prepared`, { plan_id: planId });
      }
      if (context.coordination.session !== undefined) {
        throw new CoordinationError(
          "coordination.duplicate-holder",
          `plan ${planId} is already bound to session ${context.coordination.session.session_id} \u2014 resume it instead of binding a second one`,
          { holder: context.coordination.session.session_id, session_file: context.coordination.session.session_file },
        );
      }
      if (context.coordination.handoff !== undefined) {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${planId} is handed off (state ${String(context.coordination.handoff.state)}) \u2014 the plan session cannot rebind`,
          { plan_id: planId, state: context.coordination.handoff.state },
        );
      }
    },
    mutate: (context) => {
      created = createSessionEnvelope(session);
      const transition = claimLease(context.row, session.session_id, {
        worktree_path: scope.worktreePath,
        working_branch: scope.workingBranch,
        session_label: "plan-pm",
      });
      if (!transition.ok) throw leaseFailure(transition.violations);
      const nextCoordination: RowCoordination = {
        ...(context.coordination ?? { revision: 0 }),
        revision: context.revision + 1,
        session: { session_id: session.session_id, session_file: canonicalTarget(created), bound_at: nowIso() },
      };
      assertViolationFree(validateRowCoordination(nextCoordination), `plan ${planId} coordination`);
      return { row: { ...transition.row, coordination: nextCoordination }, coordination: nextCoordination };
    },
  }).catch((error: unknown) => {
    if (created !== "") dropSessionEnvelope(created);
    throw error;
  });

  return {
    ok: true,
    operation: "bind",
    session,
    session_file: created,
    outcome: "claimed",
    view: buildView(harnessRoot, workflowId, scope.projectId, scope, result.snapshot, result.row, session, created),
  };
}

/** Map a pure lease-transition failure onto the coordination error contract. */
function leaseFailure(violations: readonly { code: string; message: string }[]): CoordinationError {
  const codes = violations.map((entry) => entry.code);
  const message = summarize(violations);
  if (codes.includes("lease.claim.other-holder")) {
    return new CoordinationError("coordination.duplicate-holder", message, { violations: codes });
  }
  return new CoordinationError("coordination.invalid-transition", message, { violations: codes });
}

/**
 * Bind a session (spec §C2). A fresh bind creates the envelope, claims the L1
 * lease and records the binding in the same snapshot commit; an existing
 * envelope is a **read-only** resume that only re-verifies the binding.
 */
/**
 * Bind a session (spec §B, §C2). Fresh addressing never supplies a session
 * path: the engine generates the UUID — or adopts the caller-supplied
 * `sessionId`, refused unless it is a single safe path component — and creates
 * the envelope. `resumePath` names an existing envelope and resumes read-only,
 * so it takes no identity input at all.
 */
export async function bindPlanSession(input: BindPlanSessionInput): Promise<CoordinationResult> {
  if (!isPlainObject(input)) throw invalidInput("bind input must be an object");
  if ("resumePath" in input) {
    assertExactKeys(input, ["resumePath", "cwd"], "bind resume input");
    requireCwd(input.cwd);
    return resumeBoundSession(input.resumePath);
  }
  if ("coordinator" in input) {
    assertExactKeys(input, ["coordinator", "workflowId", "harnessDir", "cwd", "sessionId"], "bind coordinator input");
    if (input.coordinator !== true) throw invalidInput("`coordinator` is only meaningful as true");
    if (!isNonEmptyString(input.workflowId)) throw invalidInput("workflowId is required");
    requireCwd(input.cwd);
    const sessionId = safeSessionId(input.sessionId);
    return bindCoordinatorSession(input.cwd, input.workflowId, input.harnessDir, sessionId);
  }
  assertExactKeys(input, ["scope", "cwd", "sessionId"], "bind plan input");
  if (!isPlainObject(input.scope)) throw invalidInput("a plan bind requires a scope");
  requireCwd(input.cwd);
  const sessionId = safeSessionId(input.sessionId);
  return bindPlanSessionForPlan(await resolvePlanScope(input.scope, input.cwd), sessionId);
}

/** Every bind form is a cooperative local call: it needs a real cwd. */
function requireCwd(cwd: string): void {
  if (!isNonEmptyString(cwd) || !isAbsolute(cwd)) throw invalidInput("bind input requires an absolute cwd");
}

/**
 * Resume an existing session envelope (spec §C2). Read-only: it re-verifies the
 * persisted binding (and, for a plan session, its lease) and writes nothing. A
 * handed-off or released plan is reported as such rather than reacquired.
 */
function resumeBoundSession(resumePath: string): CoordinationResult {
  if (!isNonEmptyString(resumePath) || !isAbsolute(resumePath)) {
    throw invalidInput("resumePath must be an absolute path");
  }
  const sessionPath = canonicalTarget(resumePath);
  const session = readSessionEnvelope(sessionPath);
  const harnessRoot = canonicalizeNearestExisting(session.harness_root);
  localStore(harnessRoot);
  const snapshotPath = snapshotPathOf(harnessRoot, session.workflow_id);
  assertSnapshotPath(harnessRoot, session.workflow_id, snapshotPath);
  const snapshot = readSnapshot(dirname(snapshotPath));
  if (session.role === "coordinator") {
    assertCoordinatorBinding(session, sessionPath, snapshot);
    return { ok: true, operation: "bind", session, session_file: sessionPath, outcome: "resumed" };
  }
  const planId = session.plan_id;
  if (!isNonEmptyString(planId)) {
    throw new CoordinationError("coordination.session-role", `plan session ${session.session_id} carries no plan id`, {
      session_id: session.session_id,
    });
  }
  const { row } = findPlanRow(snapshot, planId);
  assertRowBinding(session, sessionPath, row, planId, { readOnly: true });
  // A session that no longer holds the row's lease was released: report it, do
  // not reacquire (spec §C2 never infers a resume). `holder` is the ownership
  // field — any other value that happens to equal the session id is not a claim.
  const lease = row.execution_lease;
  if (!isPlainObject(lease) || lease.holder !== session.session_id) {
    throw new CoordinationError(
      "coordination.duplicate-holder",
      `plan ${planId} holds no live lease for session ${session.session_id} \u2014 it was released; a fresh bind is required`,
      { plan_id: planId, session_id: session.session_id },
    );
  }
  const prepared = rowCoordinationOf(row)?.prepared;
  if (prepared === undefined) {
    throw new CoordinationError("coordination.not-prepared", `plan ${planId} has no prepared Assignment`, {
      plan_id: planId,
    });
  }
  const assignment = parseAssignmentFile(prepared.assignment_path);
  const scope = scopeFromAssignment(assignment, harnessRoot, {
    requirePrepared: true,
    chosenRoot: harnessRoot,
    preloaded: { snapshot },
  });
  assertPreparedFresh(scope, prepared);
  return {
    ok: true,
    operation: "bind",
    session,
    session_file: sessionPath,
    outcome: "resumed",
    view: buildView(harnessRoot, session.workflow_id, scope.projectId, scope, snapshot, row, session, sessionPath),
  };
}

/* ------------------------------------------------------------------------ *
 * § mutatePlanCoordination
 * ------------------------------------------------------------------------ */

/** Absolute, existing evidence inside the plan's own plan/SDD area. */
function assertEvidenceInsidePlan(scope: ResolvedPlanScope, paths: readonly string[]): void {
  const roots = [canonicalizeNearestExisting(dirname(scope.planPath)), scope.sddDir];
  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw invalidInput(`evidence path must be absolute: ${path}`, { path });
    }
    const abs = canonicalizeNearestExisting(path);
    if (!roots.some((root) => isWithin(root, abs))) {
      throw new CoordinationError(
        "coordination.path-mismatch",
        `evidence path ${path} is outside this plan's own plan/SDD area (${roots.join(", ")})`,
        { path: abs, allowed: roots },
      );
    }
    if (!existsSync(abs)) {
      throw new CoordinationError("coordination.evidence-stale", `evidence path does not exist: ${path}`, { path: abs });
    }
  }
}

/** Track branches belong to this plan only — never main/integration/another plan. */
function assertTrackBranches(context: RowContext, branches: readonly string[]): void {
  const forbidden = new Set<string>();
  if (isPlainObject(context.snapshot.branch)) {
    for (const value of Object.values(context.snapshot.branch)) if (isNonEmptyString(value)) forbidden.add(value);
  }
  for (const row of context.snapshot.plans) {
    if (rowPlanIds(row).includes(context.scope.planId)) continue;
    for (const branch of reportedBranchesOf(row)) forbidden.add(branch);
  }
  const seen = new Set<string>();
  for (const branch of branches) {
    if (seen.has(branch)) throw invalidInput(`track branch ${branch} is reported twice`, { branch });
    seen.add(branch);
    if (forbidden.has(branch)) {
      throw new CoordinationError(
        "coordination.invalid-input",
        `track branch ${branch} belongs to main/integration or another plan \u2014 a plan reports only its own L2 track branches`,
        { branch },
      );
    }
  }
}

/** Allowed row-status transitions for a plan session's progress report. */
const PROGRESS_TRANSITIONS: Record<string, readonly string[]> = {
  InProgress: ["InProgress", "InReview", "Blocked"],
  InReview: ["InReview", "InProgress", "Blocked"],
  Blocked: ["Blocked", "InProgress"],
};

async function mutatePrepare(
  scope: ResolvedPlanScope,
  assignment: AssignmentHeaders,
  session: CoordinationSession,
  sessionPath: string,
  request: PrepareCoordinationRequest,
): Promise<CoordinationResult> {
  if (!existsSync(scope.planPath)) {
    throw new CoordinationError("coordination.plan-not-found", `plan markdown not found: ${scope.planPath}`, {
      path: scope.planPath,
    });
  }
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    // `prepare` is the writer of the pin; it must not re-check the pin it replaces.
    freshness: false,
    precheck: (context) => {
      if (session.role !== "coordinator") {
        throw new CoordinationError("coordination.session-role", "only a coordinator session may prepare a plan", {
          role: session.role,
        });
      }
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      if (context.coordination?.prepared !== undefined) {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} is already prepared from ${context.coordination.prepared.assignment_path}`,
          { plan_id: scope.planId },
        );
      }
      if (context.coordination?.session !== undefined) {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} already has a bound plan session \u2014 preparation precedes the bind`,
          { plan_id: scope.planId },
        );
      }
      if (context.coordination?.handoff !== undefined) {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} is handed off \u2014 preparation precedes the handoff`,
          { plan_id: scope.planId },
        );
      }
      // §D prepare: Todo/Blocked with no execution lease — a sealed row with a
      // second owner would make the plan session ambiguous. `null` and
      // tombstone objects are existing keys, not absent ones.
      if (context.row.execution_lease !== undefined) {
        throw new CoordinationError(
          "coordination.duplicate-holder",
          `plan ${scope.planId} already carries an execution lease \u2014 prepare must not seal a second owner`,
          { plan_id: scope.planId, holder: isPlainObject(context.row.execution_lease) ? context.row.execution_lease.holder : null },
        );
      }
      if (!isClaimableStatus(rowStatusOf(context.row))) {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} is ${rowStatusOf(context.row)} \u2014 prepare requires Todo or Blocked`,
          { plan_id: scope.planId, status: context.row.status },
        );
      }
    },
    mutate: (context) => {
      // Hashes are read inside the lock so the pinned bytes are the ones the
      // revision they are stored with was committed against.
      const prepared: PreparedCoordination = {
        assignment_path: scope.assignmentPath,
        assignment_sha256: sha256Bytes(readFileSync(scope.assignmentPath)),
        plan_sha256: sha256Bytes(readFileSync(scope.planPath)),
        qa_gate: assignment.qaGate,
        findings_cleanup: assignment.findingsCleanup,
        prepared_by: session.session_id,
        prepared_at: nowIso(),
      };
      assertViolationFree(validatePreparedCoordination(prepared), "prepared block");
      const nextCoordination: RowCoordination = {
        ...(context.coordination ?? { revision: 0 }),
        revision: context.revision + 1,
        prepared,
      };
      assertViolationFree(validateRowCoordination(nextCoordination), `plan ${scope.planId} coordination`);
      return { row: { ...context.row, coordination: nextCoordination }, coordination: nextCoordination };
    },
  });
  return {
    ok: true,
    operation: "prepare",
    session,
    session_file: sessionPath,
    outcome: "prepared",
    view: buildView(
      scope.harnessRoot,
      scope.workflowId,
      scope.projectId,
      scope,
      result.snapshot,
      result.row,
      session,
      sessionPath,
    ),
  };
}

async function mutateProgress(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: ProgressCoordinationRequest,
): Promise<CoordinationResult> {
  const progress = request.progress;
  assertViolationFree(validatePlanProgress(progress), "progress");
  assertEvidenceInsidePlan(scope, progress.evidence_paths);
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    precheck: (context) => {
      assertRowBinding(session, sessionPath, context.row, scope.planId);
      assertNoHandoff(context);
      const status = rowStatusOf(context.row);
      const allowed = PROGRESS_TRANSITIONS[status];
      if (allowed === undefined) {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} is ${status || "unstatused"} \u2014 progress is reported only while executing (${Object.keys(PROGRESS_TRANSITIONS).join(", ")})`,
          { plan_id: scope.planId, status: context.row.status },
        );
      }
      if (!allowed.includes(progress.status)) {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} cannot move ${status} \u2192 ${progress.status} (allowed: ${allowed.join(", ")})`,
          { plan_id: scope.planId, from: status, to: progress.status },
        );
      }
      if (progress.track_branches !== undefined) assertTrackBranches(context, progress.track_branches);
    },
    mutate: (context) => {
      const metadata = isPlainObject(context.row.metadata) ? context.row.metadata : {};
      const nextMetadata =
        progress.track_branches !== undefined ? { ...metadata, track_branches: [...progress.track_branches] } : metadata;
      const nextCoordination: RowCoordination = {
        ...(context.coordination ?? { revision: 0 }),
        revision: context.revision + 1,
        progress: {
          status: progress.status,
          summary: progress.summary,
          evidence_paths: [...progress.evidence_paths],
          ...(progress.track_branches !== undefined ? { track_branches: [...progress.track_branches] } : {}),
        },
      };
      assertViolationFree(validateRowCoordination(nextCoordination), `plan ${scope.planId} coordination`);
      const row: PlanRow = { ...context.row, status: progress.status, coordination: nextCoordination };
      if (nextMetadata !== context.row.metadata) row.metadata = nextMetadata;
      return { row, coordination: nextCoordination };
    },
  });
  return {
    ok: true,
    operation: "progress",
    session,
    session_file: sessionPath,
    outcome: "progressed",
    view: buildView(
      scope.harnessRoot,
      scope.workflowId,
      scope.projectId,
      scope,
      result.snapshot,
      result.row,
      session,
      sessionPath,
    ),
  };
}

/* ------------------------------------------------------------------------ *
 * § Residual operations
 * ------------------------------------------------------------------------ */

type RegisterBytes = { doc: ProjectRegisterDoc; version: string; path: string };

/**
 * The project register as stored, or the absent placeholder (spec §C3): absent
 * bytes are a legitimate empty state, but existing bytes are validated before
 * anyone reads findings or transforms residuals — a malformed document fails
 * and is never normalized into an empty register.
 */
function readRegister(harnessRoot: string, projectId: string): RegisterBytes {
  const path = registerPathOf(harnessRoot, projectId);
  const bytes = readArtifactBytes(path);
  if (bytes === undefined) return { doc: {}, version: "absent", path };
  const gate = validateProjectRegister(bytes.payload);
  if (!gate.ok) {
    throw new CoordinationError(
      "coordination.store",
      `project register ${path} is malformed \u2014 ${summarize(gate.violations)}`,
      { path, violations: gate.violations.map((entry) => entry.code) },
    );
  }
  // Boundary cast: `validateProjectRegister` just proved the document shape.
  return { doc: bytes.payload as ProjectRegisterDoc, version: bytes.version, path };
}

function registerEntriesOf(doc: ProjectRegisterDoc, planId: string): ProjectRegisterEntry[] {
  const entries = doc.entries;
  if (entries === undefined) return [];
  if (!isPlainObject(entries)) {
    throw new CoordinationError("coordination.store", "project register `entries` must be an object", {});
  }
  const bucket = entries[planId];
  if (bucket === undefined) return [];
  if (!Array.isArray(bucket)) {
    throw new CoordinationError(
      "coordination.store",
      `project register entries[${planId}] must be an array`,
      { plan_id: planId },
    );
  }
  // Boundary cast: buckets are written only through `writeRegister`, which
  // validates the whole document with `validateProjectRegister`.
  const list = bucket as ProjectRegisterEntry[];
  return list;
}

/** Validate the caller's residual fields (the nine v1 fields + `detail_doc`). */
function assertResidualInputs(entries: readonly ResidualInput[]): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw invalidInput("residual-add requires at least one entry");
  }
  for (const entry of entries) {
    if (!isPlainObject(entry)) throw invalidInput("each residual entry must be an object");
    assertExactKeys(entry, RESIDUAL_INPUT_KEYS, "residual input");
    const residual = validateResidual(entry);
    if (!residual.ok) {
      throw new CoordinationError(
        "coordination.invalid-input",
        `residual ${String(entry.id)} is invalid \u2014 ${summarize(residual.violations)}`,
        { violations: residual.violations.map((violation) => violation.code) },
      );
    }
  }
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw invalidInput("residual ids must be unique within one call", { ids });
}

async function mutateResidualAdd(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: ResidualAddCoordinationRequest,
): Promise<CoordinationResult> {
  assertResidualInputs(request.entries);
  assertExpectedRegisterVersion(request.expectedRegisterVersion);
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision ?? null,
    precheck: (context) => {
      assertRowBinding(session, sessionPath, context.row, scope.planId);
      assertNoHandoff(context);
    },
    mutate: async (context) => {
      assertNoHandoff(context);
      // Register write happens under the snapshot lock (lock order
      // snapshot → register) so the row state checked above cannot change
      // between the check and the register CAS.
      await writeRegister(scope, request.expectedRegisterVersion, (doc) => {
        const bucket = registerEntriesOf(doc, scope.planId);
        const existing = new Set(bucket.map((entry) => (isNonEmptyString(entry.id) ? entry.id : "")));
        for (const entry of request.entries) {
          if (existing.has(entry.id)) {
            throw invalidInput(`residual ${entry.id} already exists on plan ${scope.planId}`, { id: entry.id });
          }
        }
        const appended: ProjectRegisterEntry[] = request.entries.map((entry) => ({
          ...entry,
          source_plan: scope.planId,
          lifecycle_id: scope.workflowId,
          registered_at: todayString(),
        }));
        return {
          ...doc,
          entries: { ...(isPlainObject(doc.entries) ? doc.entries : {}), [scope.planId]: [...bucket, ...appended] },
        };
      });
      return null;
    },
  });
  return {
    ok: true,
    operation: "residual-add",
    session,
    session_file: sessionPath,
    outcome: "residual-added",
    view: buildView(
      scope.harnessRoot,
      scope.workflowId,
      scope.projectId,
      scope,
      result.snapshot,
      result.row,
      session,
      sessionPath,
    ),
  };
}

async function mutateResidualClose(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: ResidualCloseCoordinationRequest,
): Promise<CoordinationResult> {
  if (!isNonEmptyString(request.entryId)) throw invalidInput("entryId is required");
  if (!isNonEmptyString(request.note)) throw invalidInput("a residual close requires a non-blank note");
  assertExpectedRegisterVersion(request.expectedRegisterVersion);
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision ?? null,
    precheck: (context) => {
      assertRowBinding(session, sessionPath, context.row, scope.planId);
      assertNoHandoff(context);
    },
    mutate: async (context) => {
      assertNoHandoff(context);
      await writeRegister(scope, request.expectedRegisterVersion, (doc) => {
        const bucket = registerEntriesOf(doc, scope.planId);
        const index = bucket.findIndex((entry) => entry.id === request.entryId);
        if (index < 0) {
          throw invalidInput(`residual ${request.entryId} is not registered on plan ${scope.planId}`, {
            id: request.entryId,
            plan_id: scope.planId,
          });
        }
        const target = bucket[index];
        if (isNonEmptyString(target.lifecycle) && target.lifecycle !== "open") {
          throw new CoordinationError(
            "coordination.invalid-transition",
            `residual ${request.entryId} is already ${String(target.lifecycle)}`,
            { id: request.entryId, lifecycle: target.lifecycle },
          );
        }
        const closed: ProjectRegisterEntry = {
          ...target,
          lifecycle: "resolved",
          closed_at: todayString(),
          closure_note: request.note,
        };
        const next = [...bucket];
        next[index] = closed;
        return { ...doc, entries: { ...(isPlainObject(doc.entries) ? doc.entries : {}), [scope.planId]: next } };
      });
      return null;
    },
  });
  return {
    ok: true,
    operation: "residual-close",
    session,
    session_file: sessionPath,
    outcome: "residual-closed",
    view: buildView(
      scope.harnessRoot,
      scope.workflowId,
      scope.projectId,
      scope,
      result.snapshot,
      result.row,
      session,
      sessionPath,
    ),
  };
}

function assertExpectedRegisterVersion(version: string): void {
  if (!isNonEmptyString(version)) {
    throw new CoordinationError(
      "coordination.expected-version-required",
      "residual writes require expectedRegisterVersion (the register's sha256:\u2026 version, or \"absent\" to create it)",
      {},
    );
  }
  if (version !== "absent" && !isArtifactVersion(version)) {
    throw invalidInput(`expectedRegisterVersion must be "absent" or sha256:<hex> \u2014 got ${version}`, { version });
  }
}

/**
 * Compare-and-swap the plan's register bucket under the register lock. The
 * version precondition is checked **inside** the lock against a fresh byte
 * read, so a concurrent writer is always detected.
 */
async function writeRegister(
  scope: ResolvedPlanScope,
  expectedVersion: string,
  transform: (doc: ProjectRegisterDoc) => ProjectRegisterDoc,
): Promise<void> {
  const store = localStore(scope.harnessRoot);
  const path = registerPathOf(scope.harnessRoot, scope.projectId);
  const fromTable = resolveArtifactPath(scope.harnessRoot, { kind: "residuals", key: scope.projectId });
  if (canonicalizeNearestExisting(fromTable) !== canonicalizeNearestExisting(path)) {
    throw new CoordinationError("coordination.path-mismatch", `resolved register path ${path} is not the store's ${fromTable}`, {
      expected: fromTable,
      actual: path,
    });
  }
  // The project directory is created by the first write; the lock needs it first.
  mkdirSync(dirname(path), { recursive: true });
  await withStatusWriteLock(path, async () => {
    const current = readRegister(scope.harnessRoot, scope.projectId);
    if (current.version !== expectedVersion) {
      throw new CoordinationError(
        "coordination.version-conflict",
        `${path} is at version ${current.version}, expected ${expectedVersion} \u2014 re-run \`mstar plan show\` and retry`,
        { expected: expectedVersion, actual: current.version, path },
      );
    }
    const next = transform(current.doc);
    const gate = validateProjectRegister(next);
    if (!gate.ok) {
      throw new CoordinationError(
        "coordination.invalid-transition",
        `refusing to write a project register that fails validation \u2014 ${summarize(gate.violations)}`,
        { path, violations: gate.violations.map((entry) => entry.code) },
      );
    }
    await withProtectedWrite(path, "put", () =>
      store.put({ kind: "residuals", key: scope.projectId, payload: next }),
    );
  });
}

/* ------------------------------------------------------------------------ *
 * § Coordination request dispatch
 * ------------------------------------------------------------------------ */

/**
 * Run one coordinated mutation (spec §B/§D). Every call re-authenticates the
 * session from its envelope, re-checks the Assignment hash, enforces the
 * revision/register precondition under the lock, and writes through
 * `withProtectedWrite`. The operation surface is a closed discriminated union:
 * an unknown key anywhere is rejected before any state is touched.
 */
export async function mutatePlanCoordination(request: CoordinationRequest): Promise<CoordinationResult> {
  assertExactKeys(request, ["sessionPath", "planId", "expectedRevision", "operation"], "coordination request");
  if (!isNonEmptyString(request.sessionPath) || !isAbsolute(request.sessionPath)) {
    throw invalidInput("a coordination request requires an absolute sessionPath");
  }
  if (request.planId !== undefined && !isNonEmptyString(request.planId)) {
    throw invalidInput("planId must be a non-empty string");
  }
  assertExpectedRevision(request.expectedRevision);
  const expectedRevision = request.expectedRevision;
  const operation = request.operation;
  if (!isPlainObject(operation) || !isNonEmptyString(operation.kind)) {
    throw invalidInput("a coordination request requires an operation with a kind");
  }
  if ("expectedRevision" in operation) {
    throw invalidInput("expectedRevision belongs to the request, not the operation");
  }
  const kind = operation.kind;
  if (IMPLEMENTED_OPERATIONS[kind] !== true) {
    throw new CoordinationError("coordination.unknown-operation", `${kind} is not a coordination operation`, {
      operation: kind,
    });
  }
  const session = readSessionEnvelope(request.sessionPath);
  assertSessionRole(session, kind);
  assertRequestedPlan(session, request.planId);
  const sessionAbs = canonicalTarget(request.sessionPath);

  switch (operation.kind) {
    case "prepare": {
      assertExactKeys(operation, ["kind", "assignmentPath"], "prepare operation");
      if (!isNonEmptyString(operation.assignmentPath) || !isAbsolute(operation.assignmentPath)) {
        throw invalidInput("prepare requires an absolute assignmentPath");
      }
      const assignment = parseAssignmentFile(operation.assignmentPath);
      // The session's own harness root is the anchor: mutations never depend on
      // the caller's process cwd. Pinning chosenRoot keeps prepare off the
      // Git-dependent process-root re-derivation too — with git unavailable
      // the degraded probe must not masquerade as a scope mismatch; the Git
      // read itself surfaces coordination.git-unavailable.
      const scope = scopeFromAssignment(assignment, session.harness_root, {
        requirePrepared: false,
        chosenRoot: session.harness_root,
      });
      if (request.planId !== undefined && request.planId !== scope.planId) {
        throw new CoordinationError(
          "coordination.scope-mismatch",
          `request planId ${request.planId} is not the Assignment's plan ${scope.planId}`,
          { expected: scope.planId, actual: request.planId },
        );
      }
      return mutatePrepare(scope, assignment, session, sessionAbs, { ...operation, expectedRevision });
    }
    case "progress": {
      assertExactKeys(operation, ["kind", "progress"], "progress operation");
      return mutateProgress(await sessionScope(session), session, sessionAbs, { ...operation, expectedRevision });
    }
    case "residual-add": {
      assertExactKeys(operation, ["kind", "entries", "expectedRegisterVersion"], "residual-add operation");
      return mutateResidualAdd(await sessionScope(session), session, sessionAbs, { ...operation, expectedRevision });
    }
    case "residual-close": {
      assertExactKeys(operation, ["kind", "entryId", "note", "expectedRegisterVersion"], "residual-close operation");
      return mutateResidualClose(await sessionScope(session), session, sessionAbs, { ...operation, expectedRevision });
    }
    case "handoff": {
      assertExactKeys(operation, ["kind", "evidence"], "handoff operation");
      return mutateHandoff(await sessionScope(session), session, sessionAbs, {
        evidence: operation.evidence,
        expectedRevision,
      });
    }
    case "accept": {
      assertExactKeys(operation, ["kind", "handoffId"], "accept operation");
      return mutateAccept(await coordinatorScope(session, request.planId, kind), session, sessionAbs, {
        handoffId: namedHandoffId(operation),
        expectedRevision,
      });
    }
    case "return": {
      assertExactKeys(operation, ["kind", "handoffId", "reason"], "return operation");
      if (!isNonEmptyString(operation.reason)) throw invalidInput("return requires a non-empty reason");
      return mutateReturn(await coordinatorScope(session, request.planId, kind), session, sessionAbs, {
        handoffId: namedHandoffId(operation),
        reason: operation.reason,
        expectedRevision,
      });
    }
    case "integration-start": {
      assertExactKeys(operation, ["kind", "handoffId"], "integration-start operation");
      return mutateIntegrationStart(await coordinatorScope(session, request.planId, kind), session, sessionAbs, {
        handoffId: namedHandoffId(operation),
        expectedRevision,
      });
    }
    case "integration-accept": {
      assertExactKeys(operation, ["kind", "handoffId"], "integration-accept operation");
      return mutateIntegrationAccept(await coordinatorScope(session, request.planId, kind), session, sessionAbs, {
        handoffId: namedHandoffId(operation),
        expectedRevision,
      });
    }
    case "complete": {
      assertExactKeys(operation, ["kind", "handoffId"], "complete operation");
      return mutateComplete(await coordinatorScope(session, request.planId, kind), session, sessionAbs, {
        handoffId: namedHandoffId(operation),
        expectedRevision,
      });
    }
    case "repair-delivery-source": {
      assertExactKeys(operation, ["kind", "handoffId"], "repair-delivery-source operation");
      return mutateRepairDeliverySource(await coordinatorScope(session, request.planId, kind), session, sessionAbs, {
        handoffId: namedHandoffId(operation),
        expectedRevision,
      });
    }
    case "reconcile": {
      assertExactKeys(operation, ["kind", "handoffId"], "reconcile operation");
      return mutateReconcile(await coordinatorScope(session, request.planId, kind), session, sessionAbs, {
        handoffId: namedHandoffId(operation),
        expectedRevision,
      });
    }
    default:
      throw new CoordinationError(
        "coordination.unknown-operation",
        `${String(kind)} is not a coordination operation`,
        { operation: String(kind) },
      );
  }
}

/** A plan session addresses only its own plan; a coordinator selects one. */
function assertRequestedPlan(session: CoordinationSession, requestedPlanId: string | undefined): void {
  if (requestedPlanId === undefined || session.role === "coordinator") return;
  if (session.plan_id !== requestedPlanId) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `plan session ${session.session_id} addresses only its own plan ${String(session.plan_id)}, not ${requestedPlanId}`,
      { expected: session.plan_id, actual: requestedPlanId },
    );
  }
}


function assertExpectedRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 0) {
    throw invalidInput(`expectedRevision must be a nonnegative integer \u2014 got ${JSON.stringify(revision)}`, { revision });
  }
}

/** Operations only a coordinator session may issue (spec §D/§E). */
const COORDINATOR_OPERATIONS: readonly string[] = [
  "prepare",
  "accept",
  "return",
  "integration-start",
  "integration-accept",
  "complete",
  "repair-delivery-source",
  "reconcile",
];

function assertSessionRole(session: CoordinationSession, kind: string): void {
  const coordinatorOperation = COORDINATOR_OPERATIONS.includes(kind);
  if (coordinatorOperation && session.role !== "coordinator") {
    throw new CoordinationError(
      "coordination.session-role",
      `${kind} requires a coordinator session, not ${session.role}`,
      { role: session.role, operation: kind },
    );
  }
  if (!coordinatorOperation && session.role !== "plan-pm") {
    throw new CoordinationError(
      "coordination.session-role",
      `${kind} is a plan-session operation (a coordinator session coordinates, it does not execute)`,
      { role: session.role, operation: kind },
    );
  }
}

/**
 * Scope of the row a coordinator session mutates: a coordinator addresses plans
 * by id inside its own workflow, never by a plan session envelope.
 */
async function coordinatorScope(
  session: CoordinationSession,
  planId: string | undefined,
  kind: string,
): Promise<ResolvedPlanScope> {
  if (!isNonEmptyString(planId)) throw invalidInput(`${kind} requires the planId of the row it transitions`);
  return resolvePlanScope(
    { workflowId: session.workflow_id, planId, harnessDir: session.harness_root },
    session.harness_root,
  );
}

/** Scope of the plan a session mutates: a plan session mutates only its own row. */
async function sessionScope(session: CoordinationSession): Promise<ResolvedPlanScope> {
  if (session.role === "coordinator") {
    throw new CoordinationError("coordination.session-role", "coordinator sessions do not execute plan operations", {
      role: session.role,
    });
  }
  const planId = session.plan_id;
  if (!isNonEmptyString(planId)) {
    throw new CoordinationError("coordination.session-role", `plan session ${session.session_id} carries no plan id`, {
      session_id: session.session_id,
    });
  }
  return resolvePlanScope(
    { workflowId: session.workflow_id, planId, harnessDir: session.harness_root },
    session.harness_root,
  );
}

/* ------------------------------------------------------------------------ *
 * § Git proof (spec §D/§E)
 * ------------------------------------------------------------------------ */

/** A full Git object id (40- or 64-hex); abbreviations are never expanded. */
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** In-flight Git operations: a checkout holding one is never proof. */
const UNFINISHED_GIT_OPERATIONS: ReadonlyArray<readonly [string, string]> = [
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
];

/** QC verdicts a handoff may carry (spec §D). */
const HANDOFF_QC_DECISIONS: readonly string[] = ["Approve", "Approve with residuals"];

/** Assignment QA gates a handoff may carry (spec §D). */
const HANDOFF_QA_GATES: readonly string[] = ["mandatory", "pm-acceptance"];

type GitCheckout = { head: string; clean: boolean; operation: string | undefined };

/**
 * How long one read-only Git read may take. The snapshot write lock waits 30s,
 * so a `git` that never answers (a stalled filesystem, a contended lock) has to
 * give up well short of it rather than hold the row for the whole budget.
 */
const GIT_READ_TIMEOUT_MS = 10_000;

/**
 * One own property of an unknown thrown value, read without asserting a shape.
 */
function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.entries(value).find(([name]) => name === key)?.[1];
}

/**
 * The environment could not answer a Git read — a missing or non-executable
 * `git`, or a read that outlived its timeout. That says nothing about whether a
 * branch merged or diverged, so it is refused as its own failure instead of
 * being reported as repository state (spec §E — nothing is repaired by
 * guessing).
 */
function gitUnavailable(cwd: string, args: readonly string[], error: unknown): CoordinationError {
  const code = propertyOf(error, "code");
  const signal = propertyOf(error, "signal");
  const message = propertyOf(error, "message");
  const timedOut = code === "ETIMEDOUT";
  const cause = timedOut
    ? `git did not answer within ${GIT_READ_TIMEOUT_MS}ms${typeof signal === "string" ? ` (${signal})` : ""}`
    : typeof code === "string"
      ? code
      : typeof message === "string"
        ? message
        : String(error);
  return new CoordinationError(
    "coordination.git-unavailable",
    `cannot read Git state at ${cwd} (git ${args.join(" ")}): ${cause}`,
    { path: cwd, command: `git ${args.join(" ")}`, cause },
  );
}

/**
 * One read-only `git` read. Every argument is a separate argv entry, so branch
 * names, worktree paths and revisions never reach a shell.
 *
 * A non-zero exit is the repository answering — no such object, not an
 * ancestor, not a worktree — and resolves to `undefined`. An error without an
 * exit status means `git` itself never answered, which is refused rather than
 * folded into `undefined` (see `gitUnavailable`).
 */
function gitRead(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: GIT_READ_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    if (typeof propertyOf(error, "status") === "number") return undefined;
    throw gitUnavailable(cwd, args, error);
  }
}

function gitObjectExists(cwd: string, sha: string): boolean {
  return gitRead(cwd, ["cat-file", "-e", `${sha}^{commit}`]) !== undefined;
}

function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return gitRead(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]) !== undefined;
}

/** `undefined` when `path` is not a readable Git worktree. */
function gitCheckout(path: string): GitCheckout | undefined {
  const head = gitRead(path, ["rev-parse", "HEAD"]);
  if (head === undefined || !GIT_OBJECT_ID.test(head)) return undefined;
  const dirty = gitRead(path, ["status", "--porcelain"]);
  if (dirty === undefined) return undefined;
  let operation: string | undefined;
  for (const [marker, label] of UNFINISHED_GIT_OPERATIONS) {
    const markerPath = gitRead(path, ["rev-parse", "--git-path", marker]);
    if (markerPath !== undefined && markerPath.length > 0 && existsSync(resolve(path, markerPath))) {
      operation = label;
      break;
    }
  }
  return { head, clean: dirty.length === 0, operation };
}

function assertGitObjectId(value: unknown, what: string): string {
  if (typeof value !== "string" || !GIT_OBJECT_ID.test(value)) {
    throw invalidInput(`${what} must be a full Git object id (40 or 64 lowercase hex), not an abbreviation`, {
      field: what,
    });
  }
  return value;
}

function gitProof(message: string, details: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.git-proof", message, details);
}

/**
 * Feature-side proof (spec §D): the pinned commit is what the recorded plan
 * worktree has checked out, the worktree is clean, and no Git operation is
 * half-finished. Required at handoff, accept and integration-start.
 */
function assertFeatureCheckout(scope: ResolvedPlanScope, sourceSha: string, what: string): void {
  const checkout = gitCheckout(scope.worktreePath);
  if (checkout === undefined) {
    throw new CoordinationError(
      "coordination.not-in-git",
      `${what} requires the plan worktree ${scope.worktreePath} to be a readable Git worktree`,
      { plan_id: scope.planId, worktree_path: scope.worktreePath },
    );
  }
  if (checkout.operation !== undefined) {
    throw gitProof(
      `${what} requires a clean plan worktree \u2014 ${scope.worktreePath} has an unfinished ${checkout.operation}`,
      { plan_id: scope.planId, operation: checkout.operation },
    );
  }
  if (!checkout.clean) {
    throw gitProof(`${what} requires a clean plan worktree \u2014 ${scope.worktreePath} has uncommitted changes`, {
      plan_id: scope.planId,
      head: checkout.head,
    });
  }
  if (checkout.head !== sourceSha) {
    throw gitProof(
      `${what} requires the plan worktree HEAD to be the pinned source ${sourceSha} \u2014 ${scope.worktreePath} is at ${checkout.head}`,
      { plan_id: scope.planId, expected: sourceSha, actual: checkout.head },
    );
  }
}

/* ------------------------------------------------------------------------ *
 * § Handoff, accept and return (spec §D)
 * ------------------------------------------------------------------------ */

/** One evidence path as supplied by the plan session (a path, never a ref). */
function evidencePath(value: unknown, what: string): string {
  if (!isNonEmptyString(value) || !isAbsolute(value)) {
    throw invalidInput(`${what} must be an absolute path`, { field: what });
  }
  return canonicalTarget(value);
}

function evidenceRef(value: unknown, what: string): EvidenceRef {
  const path = evidencePath(value, what);
  if (!existsSync(path)) throw invalidInput(`${what} does not exist: ${path}`, { field: what, path });
  return evidenceRefOf(path);
}

/**
 * Handoff evidence validated and hashed for the durable record (spec §D). The
 * plan worktree is not a caller input: it is read from the persisted scope, so
 * a conforming caller cannot be rejected for omitting or spoofing it.
 */
type HandoffEvidenceInput = {
  source_sha: string;
  review_base: string;
  review_head: string;
  qc_decision: string;
  qc_reports: EvidenceRef[];
  qc_consolidated: EvidenceRef;
  qa_gate: string;
  qa_report: EvidenceRef;
  evidence_paths: string[];
};

/** The plan session supplies paths and revisions only — never state or holder. */
function readHandoffEvidence(value: unknown): HandoffEvidenceInput {
  if (!isPlainObject(value)) {
    throw invalidInput("handoff requires an evidence object with source_sha, review_base, review_head, qc and qa");
  }
  assertExactKeys(value, ["source_sha", "review_base", "review_head", "qc", "qa"], "handoff evidence");
  const source_sha = assertGitObjectId(value.source_sha, "evidence.source_sha");
  const review_base = assertGitObjectId(value.review_base, "evidence.review_base");
  const review_head = assertGitObjectId(value.review_head, "evidence.review_head");
  const qc = value.qc;
  if (!isPlainObject(qc)) throw invalidInput("handoff evidence requires a qc object");
  assertExactKeys(qc, ["decision", "reports", "consolidated"], "handoff evidence qc");
  if (typeof qc.decision !== "string" || !HANDOFF_QC_DECISIONS.includes(qc.decision)) {
    throw invalidInput(`handoff evidence qc.decision must be one of ${HANDOFF_QC_DECISIONS.join(", ")}`, {
      field: "evidence.qc.decision",
    });
  }
  if (!Array.isArray(qc.reports) || qc.reports.length === 0) {
    throw invalidInput("handoff evidence qc.reports must list at least one QC report path", {
      field: "evidence.qc.reports",
    });
  }
  const qc_reports = qc.reports.map((entry, index) => evidenceRef(entry, `evidence.qc.reports[${index}]`));
  const qc_consolidated = evidenceRef(qc.consolidated, "evidence.qc.consolidated");
  const qa = value.qa;
  if (!isPlainObject(qa)) throw invalidInput("handoff evidence requires a qa object");
  assertExactKeys(qa, ["gate", "decision", "report"], "handoff evidence qa");
  if (typeof qa.gate !== "string" || !HANDOFF_QA_GATES.includes(qa.gate)) {
    throw invalidInput(`handoff evidence qa.gate must be one of ${HANDOFF_QA_GATES.join(", ")}`, {
      field: "evidence.qa.gate",
    });
  }
  if (qa.decision !== "pass") {
    throw invalidInput("handoff evidence qa.decision must be pass", { field: "evidence.qa.decision" });
  }
  const qa_report = evidenceRef(qa.report, "evidence.qa.report");
  return {
    source_sha,
    review_base,
    review_head,
    qc_decision: qc.decision,
    qc_reports,
    qc_consolidated,
    qa_gate: qa.gate,
    qa_report,
    evidence_paths: [...qc_reports.map((ref) => ref.path), qc_consolidated.path, qa_report.path],
  };
}

/** The handoff id a coordinator transition names; the mutation re-checks it under the lock. */
function namedHandoffId(operation: { handoffId?: unknown }): string {
  if (!isNonEmptyString(operation.handoffId)) {
    throw invalidInput("a coordinator transition requires the non-empty handoffId it names");
  }
  return operation.handoffId;
}

/**
 * The handoff of a plan the operation named, or a refusal when the row has none
 * or holds a different one. This runs inside the row lock: the id the caller
 * read before the call is a precondition of the mutation, never a hint — a
 * concurrent `return` plus a fresh handoff leaves the new attempt untouched
 * (spec §B).
 */
function requireHandoff(context: RowContext, planId: string, namedHandoffId: string): PlanHandoff {
  const handoff = context.coordination?.handoff;
  if (handoff === undefined) {
    throw new CoordinationError("coordination.invalid-transition", `plan ${planId} has no handoff to transition`, {
      plan_id: planId,
    });
  }
  if (handoff.id !== namedHandoffId) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${planId} handoff ${handoff.id} is not the handoff this command named (${namedHandoffId}) \u2014 a replaced handoff is a different attempt`,
      { plan_id: planId, expected: namedHandoffId, actual: handoff.id },
    );
  }
  return handoff;
}

/**
 * The Assignment QA gate, the evidence containment and the findings cleanup
 * gate a handoff must clear (spec §D).
 */
async function assertHandoffGates(
  scope: ResolvedPlanScope,
  prepared: PreparedCoordination,
  input: HandoffEvidenceInput,
): Promise<void> {
  if (input.qa_gate !== prepared.qa_gate) {
    throw new CoordinationError(
      "coordination.assignment-stale",
      `handoff qa.gate ${input.qa_gate} is not the Assignment's QA gate ${prepared.qa_gate}`,
      { plan_id: scope.planId, expected: prepared.qa_gate, actual: input.qa_gate },
    );
  }
  assertEvidenceInsidePlan(scope, input.evidence_paths);
  await assertFindingsClosed(scope, prepared, "hand off");
}

/**
 * The findings cleanup gate of a prepared plan (spec §D/§E): handoff and
 * completion both demand it, so a plan returned for rework cannot complete
 * while the findings it was told to close are still open.
 *
 * The register is read **under its own write lock** (§C3). The caller already
 * holds the snapshot lock, so the order is always snapshot → register, and a
 * concurrent residual write cannot slip between the gate and the row commit it
 * authorizes. A register that does not exist yet is still a valid empty read.
 */
async function assertFindingsClosed(
  scope: ResolvedPlanScope,
  prepared: PreparedCoordination,
  what: string,
): Promise<void> {
  const path = registerPathOf(scope.harnessRoot, scope.projectId);
  // The project directory is created by the first write; the lock needs it first.
  mkdirSync(dirname(path), { recursive: true });
  const gate = await withStatusWriteLock(path, () => {
    const register = readRegister(scope.harnessRoot, scope.projectId);
    return findingsCleanupGate(register.doc, scope.planId, {
      mode: prepared.findings_cleanup === "zero-residual" ? "zero-residual" : "allow-residual",
    });
  });
  if (!gate.ok) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${scope.planId} cannot ${what} while findings are open (${prepared.findings_cleanup}): ${summarize(gate.violations)}`,
      { plan_id: scope.planId, findings_cleanup: prepared.findings_cleanup },
    );
  }
}

/**
 * Revalidate the hash pins of a sealed handoff (spec §D/§E): accept,
 * integration-start, integration-accept and complete all re-check that the QC
 * and QA reports still are the bytes their verdicts were recorded against.
 */
function assertEvidenceDigests(handoff: PlanHandoff): void {
  for (const ref of [...handoff.qc.reports, handoff.qc.consolidated, handoff.qa.report]) {
    let actual: string | undefined;
    try {
      actual = evidenceRefOf(ref.path).sha256;
    } catch {
      actual = undefined;
    }
    if (actual !== ref.sha256) {
      throw new CoordinationError(
        "coordination.evidence-stale",
        `handoff evidence ${ref.path} no longer matches its recorded digest`,
        { path: ref.path, expected: ref.sha256, actual },
      );
    }
  }
}

/**
 * Feature HEAD, cleanliness and the review range of one handoff (spec §D). The
 * worktree is the persisted scope's — never an evidence field.
 */
function assertHandoffGitProof(
  scope: ResolvedPlanScope,
  input: HandoffEvidenceInput,
  what: string,
): void {
  assertFeatureCheckout(scope, input.source_sha, what);
  if (input.review_head !== input.source_sha) {
    throw gitProof(
      `${what} requires review_head to be the pinned source ${input.source_sha} \u2014 got ${input.review_head}`,
      { plan_id: scope.planId, source_sha: input.source_sha, review_head: input.review_head },
    );
  }
  if (!gitObjectExists(scope.worktreePath, input.review_base)) {
    throw gitProof(`${what} review base ${input.review_base} is not a commit of ${scope.worktreePath}`, {
      plan_id: scope.planId,
      review_base: input.review_base,
    });
  }
  if (!gitIsAncestor(scope.worktreePath, input.review_base, input.review_head)) {
    throw gitProof(
      `${what} review range ${input.review_base}..${input.review_head} is not an ancestry`,
      { plan_id: scope.planId, review_base: input.review_base, review_head: input.review_head },
    );
  }
}

type HandoffRequest = { evidence: unknown; expectedRevision: number };

async function mutateHandoff(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: HandoffRequest,
): Promise<CoordinationResult> {
  const input = readHandoffEvidence(request.evidence);
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    precheck: async (context) => {
      assertRowBinding(session, sessionPath, context.row, scope.planId);
      const coordination = context.coordination ?? { revision: 0 };
      const prepared = coordination.prepared;
      if (prepared === undefined) {
        throw new CoordinationError(
          "coordination.not-prepared",
          `plan ${scope.planId} is not prepared in this workflow \u2014 prepare records the Assignment pins a handoff cites`,
          { plan_id: scope.planId },
        );
      }
      const previous = coordination.handoff;
      if (previous !== undefined && previous.state !== "returned") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} is handed off (state ${previous.state}) \u2014 only a returned handoff can be handed off again`,
          { plan_id: scope.planId, state: previous.state, handoff_id: previous.id },
        );
      }
      const status = rowStatusOf(context.row);
      if (status !== "InReview") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `handoff requires ${scope.planId} to be InReview \u2014 it is ${status || "unstatused"}`,
          { plan_id: scope.planId, status: context.row.status },
        );
      }
      assertHandoffGitProof(scope, input, "handoff");
      await assertHandoffGates(scope, prepared, input);
    },
    mutate: (context) => {
      const coordination = context.coordination ?? { revision: 0 };
      const previous = coordination.handoff;
      const record: PlanHandoff = {
        id: randomUUID(),
        attempt: previous === undefined ? 1 : previous.attempt + 1,
        state: "submitted",
        submitted_by: session.session_id,
        submitted_at: nowIso(),
        source_branch: scope.workingBranch,
        source_sha: input.source_sha,
        worktree_path: scope.worktreePath,
        review_base: input.review_base,
        review_head: input.review_head,
        qc: {
          decision: input.qc_decision,
          reports: input.qc_reports,
          consolidated: input.qc_consolidated,
        },
        qa: { gate: input.qa_gate, decision: "pass", report: input.qa_report },
      };
      const nextCoordination: RowCoordination = {
        ...coordination,
        revision: context.revision + 1,
        handoff: record,
      };
      assertViolationFree(validateRowCoordination(nextCoordination), `plan ${scope.planId} coordination`);
      // The execution lease stays with the plan session: handoff is not release.
      return { row: { ...context.row, coordination: nextCoordination }, coordination: nextCoordination };
    },
  });
  return {
    ok: true,
    operation: "handoff",
    session,
    session_file: sessionPath,
    outcome: "handed-off",
    view: buildView(scope.harnessRoot, scope.workflowId, scope.projectId, scope, result.snapshot, result.row, session, sessionPath),
  };
}

/**
 * Move the row's execution lease, failing closed (spec §D/§E): the lease must
 * exist and be held by `from`, because every caller here hands ownership over.
 * An absent, `null` or foreign lease is a refusal — never a silent no-op that
 * leaves the row owned by nobody or by the wrong session.
 */
function transferRowLease(row: PlanRow, from: string, to: string, what: string, planId: string): PlanRow {
  assertExecutionHolder(row, from, planId, what);
  const transferred = transferLease(row, from, to);
  if (!transferred.ok) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} cannot move the execution lease: ${summarize(transferred.violations)}`,
      { plan_id: planId, holder: from },
    );
  }
  return transferred.row;
}

type AcceptRequest = { handoffId: string; expectedRevision: number };

async function mutateAccept(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: AcceptRequest,
): Promise<CoordinationResult> {
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    precheck: (context) => {
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      if (handoff.state !== "submitted") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} handoff is ${handoff.state} \u2014 accept requires submitted`,
          { plan_id: scope.planId, state: handoff.state },
        );
      }
      if (rowStatusOf(context.row) !== "InReview") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `accept requires ${scope.planId} to still be InReview`,
          { plan_id: scope.planId, status: context.row.status },
        );
      }
      assertFeatureCheckout(scope, handoff.source_sha, "accept");
      assertEvidenceDigests(handoff);
    },
    mutate: (context) => {
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      const row = transferRowLease(context.row, handoff.submitted_by, session.session_id, "accept", scope.planId);
      const nextCoordination: RowCoordination = {
        ...(context.coordination ?? { revision: 0 }),
        revision: context.revision + 1,
        handoff: { ...handoff, state: "accepted", accepted_by: session.session_id, accepted_at: nowIso() },
      };
      assertViolationFree(validateRowCoordination(nextCoordination), `plan ${scope.planId} coordination`);
      // InReview is preserved: the coordinator now holds the row.
      return { row: { ...row, coordination: nextCoordination }, coordination: nextCoordination };
    },
  });
  return {
    ok: true,
    operation: "accept",
    session,
    session_file: sessionPath,
    outcome: "accepted",
    view: buildView(scope.harnessRoot, scope.workflowId, scope.projectId, scope, result.snapshot, result.row, session, sessionPath),
  };
}

type ReturnRequest = { handoffId: string; reason: string; expectedRevision: number };

async function mutateReturn(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: ReturnRequest,
): Promise<CoordinationResult> {
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    precheck: (context) => {
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      if (handoff.state !== "submitted" && handoff.state !== "accepted") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} handoff is ${handoff.state} \u2014 a return requires submitted or accepted`,
          { plan_id: scope.planId, state: handoff.state },
        );
      }
    },
    mutate: (context) => {
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      // The lease follows the record (spec §D): handoff keeps the plan's lease,
      // accept moves it to the coordinator, so a return from `submitted` only
      // proves the plan session still holds it, while a return from `accepted`
      // restores it — neither may re-claim on the plan's behalf.
      let row: PlanRow;
      if (handoff.state === "accepted") {
        row = transferRowLease(context.row, session.session_id, handoff.submitted_by, "return", scope.planId);
      } else {
        assertExecutionHolder(context.row, handoff.submitted_by, scope.planId, "return");
        row = context.row;
      }
      const nextCoordination: RowCoordination = {
        ...(context.coordination ?? { revision: 0 }),
        revision: context.revision + 1,
        handoff: { ...handoff, state: "returned", returned_at: nowIso(), return_reason: request.reason },
      };
      assertViolationFree(validateRowCoordination(nextCoordination), `plan ${scope.planId} coordination`);
      // A returned plan is being worked on again: InProgress, same session.
      const nextRow: PlanRow = { ...row, status: "InProgress", coordination: nextCoordination };
      return { row: nextRow, coordination: nextCoordination };
    },
  });
  return {
    ok: true,
    operation: "return",
    session,
    session_file: sessionPath,
    outcome: "returned",
    view: buildView(scope.harnessRoot, scope.workflowId, scope.projectId, scope, result.snapshot, result.row, session, sessionPath),
  };
}

/* ------------------------------------------------------------------------ *
 * § Integration, complete and reconcile (spec §E)
 * ------------------------------------------------------------------------ */

/** The integration anchors the snapshot names for a workflow (spec §E). */
type IntegrationAnchors = { targetBranch: string; worktreePath: string };

function integrationUnresolved(message: string, details: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.integration-unresolved", message, details);
}

function integrationDiverged(message: string, details: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.integration-diverged", message, details);
}

/**
 * The recorded integration target of a workflow (spec §E). A missing anchor is
 * an unresolved integration — never guessed from the current branch.
 */
function integrationAnchors(snapshot: WorkflowSnapshot, planId: string): IntegrationAnchors {
  const targetBranch = snapshot.branch?.integration;
  const worktreePath = snapshot.integration_worktree_path;
  if (!isNonEmptyString(targetBranch) || !isNonEmptyString(worktreePath)) {
    throw integrationUnresolved(
      `plan ${planId} has no integration target \u2014 the snapshot must name branch.integration and integration_worktree_path`,
      { plan_id: planId },
    );
  }
  return { targetBranch, worktreePath: canonicalTarget(worktreePath) };
}

/**
 * The recorded integration checkout: readable, on its recorded target branch,
 * and free of uncommitted changes or half-finished Git operations (spec §E).
 */
function assertIntegrationCheckout(anchors: IntegrationAnchors, planId: string): GitCheckout {
  const checkout = gitCheckout(anchors.worktreePath);
  if (checkout === undefined) {
    throw integrationDiverged(
      `plan ${planId} integration checkout ${anchors.worktreePath} is not a readable Git worktree`,
      { plan_id: planId, worktree_path: anchors.worktreePath },
    );
  }
  const branch = gitRead(anchors.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== anchors.targetBranch) {
    throw integrationDiverged(
      `plan ${planId} integration checkout ${anchors.worktreePath} is on ${branch || "a detached HEAD"}, not the recorded target ${anchors.targetBranch}`,
      { plan_id: planId, expected: anchors.targetBranch, actual: branch },
    );
  }
  if (checkout.operation !== undefined || !checkout.clean) {
    throw integrationUnresolved(
      `plan ${planId} integration checkout ${anchors.worktreePath} ${
        checkout.operation === undefined ? "has uncommitted changes" : `has an unfinished ${checkout.operation}`
      } \u2014 finish or abort it, then retry`,
      { plan_id: planId, operation: checkout.operation, head: checkout.head },
    );
  }
  return checkout;
}

/** The parent ids carried by one `<sha> <parent>…` rev-list line. */
function parentIdsOf(line: string): string[] {
  return line
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(1);
}

/** Parents of one pinned commit in a repository. */
function commitParents(path: string, sha: string): string[] | undefined {
  const line = gitRead(path, ["rev-list", "--parents", "-n", "1", sha]);
  if (line === undefined) return undefined;
  return parentIdsOf(line);
}

/** What proving one integration attempt from the pinned objects yields (spec §E). */
type IntegrationProof =
  | { kind: "proven"; resultSha: string }
  | { kind: "pending" }
  | { kind: "diverged"; reason: string };

/**
 * Prove the attempt from the pinned objects (spec §E): the pinned base must
 * still be an ancestor of `head`, the integration HEAD the proof is taken
 * against — otherwise the checkout has moved on and no merge in it belongs to
 * this attempt. Given that, either the source was already an ancestor of the
 * recorded base, or the first-parent path from the base to `head` carries
 * exactly one merge whose parents are exactly base then source. Zero
 * candidates is `pending` (nothing merged yet); several are `diverged` — a
 * result is never picked out of a set.
 */
function integrationProof(path: string, head: string, baseSha: string, sourceSha: string): IntegrationProof {
  if (!gitObjectExists(path, baseSha)) {
    return { kind: "diverged", reason: `the pinned base ${baseSha} is unavailable` };
  }
  if (!gitObjectExists(path, sourceSha)) {
    return { kind: "diverged", reason: `the pinned source ${sourceSha} is unavailable` };
  }
  if (!gitObjectExists(path, head)) {
    return { kind: "diverged", reason: `the integration HEAD ${head} is unavailable` };
  }
  if (!gitIsAncestor(path, baseSha, head)) {
    return {
      kind: "diverged",
      reason: `the pinned base ${baseSha} is not an ancestor of the integration HEAD ${head}`,
    };
  }
  if (gitIsAncestor(path, sourceSha, baseSha)) return { kind: "proven", resultSha: baseSha };
  const range = gitRead(path, ["rev-list", "--first-parent", "--parents", `${baseSha}..${head}`]);
  if (range === undefined) {
    return { kind: "diverged", reason: `the first-parent path ${baseSha}..HEAD is unreadable` };
  }
  // One call carries the parents of every commit on the path: the proof never
  // spawns a Git process per commit, and a commit whose parents the repository
  // cannot report is a diverged path rather than a silently skipped candidate.
  const candidates = range
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((line) => line.split(" ").map((entry) => entry.trim()).filter((entry) => entry.length > 0))
    .filter((ids) => ids.length === 3 && ids[1] === baseSha && ids[2] === sourceSha)
    .map((ids) => ids[0]);
  if (candidates.length === 0) return { kind: "pending" };
  if (candidates.length > 1) {
    return {
      kind: "diverged",
      reason: `${candidates.length} merges of ${sourceSha} onto ${baseSha} exist (${candidates.join(", ")})`,
    };
  }
  return { kind: "proven", resultSha: candidates[0] };
}

/**
 * Verify the recorded result of a finished attempt (spec §E): the recorded
 * commit is an object of the repository, is either the recorded base (the
 * source was already an ancestor) or exactly the two-parent merge of base then
 * source, and stays reachable from the current target HEAD when one is known.
 */
function assertRecordedResult(
  path: string,
  planId: string,
  integration: HandoffIntegration,
  sourceSha: string,
  head: string | undefined,
): string {
  const baseSha = integration.base_sha;
  const resultSha = integration.result_sha;
  if (!isNonEmptyString(resultSha)) {
    throw integrationUnresolved(`plan ${planId} integration attempt has no recorded result`, { plan_id: planId });
  }
  if (!gitObjectExists(path, resultSha) || !gitObjectExists(path, baseSha) || !gitObjectExists(path, sourceSha)) {
    throw integrationDiverged(
      `plan ${planId} recorded result ${resultSha} is not an object of ${path} together with its pins`,
      { plan_id: planId, result: resultSha, base: baseSha, source: sourceSha, path },
    );
  }
  if (head !== undefined && !gitIsAncestor(path, resultSha, head)) {
    throw integrationDiverged(
      `plan ${planId} recorded result ${resultSha} is not reachable from the integration HEAD ${head}`,
      { plan_id: planId, result: resultSha, head },
    );
  }
  if (resultSha === baseSha) {
    if (!gitIsAncestor(path, sourceSha, baseSha)) {
      throw integrationDiverged(
        `plan ${planId} recorded result is the base ${baseSha} but ${sourceSha} never was its ancestor`,
        { plan_id: planId, result: resultSha, source: sourceSha },
      );
    }
    return resultSha;
  }
  const parents = commitParents(path, resultSha);
  if (parents === undefined || parents.length !== 2 || parents[0] !== baseSha || parents[1] !== sourceSha) {
    throw integrationDiverged(
      `plan ${planId} recorded result ${resultSha} carries parents ${JSON.stringify(parents ?? null)}, expected [${baseSha}, ${sourceSha}]`,
      { plan_id: planId, result: resultSha, parents: parents ?? null },
    );
  }
  return resultSha;
}

/** The integration attempt recorded on a handoff, or a refusal (spec §E). */
function requireIntegration(handoff: PlanHandoff, planId: string): HandoffIntegration {
  const integration = handoff.integration;
  if (integration === undefined) {
    throw integrationUnresolved(`plan ${planId} handoff ${handoff.id} has no integration attempt`, {
      plan_id: planId,
      handoff_id: handoff.id,
    });
  }
  return integration;
}

/**
 * The workflow's merge lease, but only when it names THIS attempt (spec §E).
 * The lease is a single workflow-wide top-level claim, so a holder match alone
 * is not ownership: a lease that names another plan, or another source branch,
 * belongs to a different attempt and must never be released or re-pinned by
 * this one — the same plan can integrate more than once.
 */
function mergeLeaseOfAttempt(
  snapshot: WorkflowSnapshot,
  planId: string,
  handoff: PlanHandoff,
): IntegrationMergeLease | undefined {
  const lease = snapshot.integration_merge_lease;
  if (lease === undefined) return undefined;
  if (lease.plan_id !== planId) return undefined;
  if (lease.source_branch !== handoff.source_branch) return undefined;
  return lease;
}

/** The workflow's merge lease is absent, or this coordinator's own for this attempt (spec §E). */
function assertMergeLease(
  snapshot: WorkflowSnapshot,
  session: CoordinationSession,
  planId: string,
  handoff: PlanHandoff,
): void {
  const lease = snapshot.integration_merge_lease;
  if (lease === undefined) return;
  if (lease.holder !== session.session_id) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `plan ${planId} integration is held by ${lease.holder}, not ${session.session_id}`,
      { plan_id: planId, holder: lease.holder, session_id: session.session_id },
    );
  }
  if (lease.plan_id !== planId || lease.source_branch !== handoff.source_branch) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${planId} merge lease claims plan ${lease.plan_id} source ${lease.source_branch}, not this attempt (${planId} source ${handoff.source_branch}) \u2014 a foreign claim is never reused or released`,
      {
        plan_id: planId,
        holder_plan_id: lease.plan_id,
        holder_source_branch: lease.source_branch,
        source_branch: handoff.source_branch,
      },
    );
  }
}

/** A readable repository for pinned-object proof, most specific first (spec §E). */
function proofRepository(candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (!isNonEmptyString(candidate)) continue;
    if (gitCheckout(candidate) !== undefined) return candidate;
  }
  return undefined;
}

type IntegrationStartRequest = { handoffId: string; expectedRevision: number };

/**
 * Start one integration attempt (spec §E): claim the workflow's merge lease,
 * record the attempt base and the source pin before Git runs, and keep the row
 * InReview with the coordinator's execution ownership. A retry of an already
 * started attempt re-verifies the pins and returns without moving the base.
 */
async function mutateIntegrationStart(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: IntegrationStartRequest,
): Promise<CoordinationResult> {
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    precheck: (context) => {
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      if (handoff.state !== "accepted" && handoff.state !== "integrating") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} handoff is ${handoff.state} \u2014 integration-start requires accepted (or a started attempt to re-verify)`,
          { plan_id: scope.planId, state: handoff.state },
        );
      }
      assertEvidenceDigests(handoff);
      assertFeatureCheckout(scope, handoff.source_sha, "integration-start");
      // The coordinator owns the row between accept and complete: integration
      // must never proceed on a row nobody holds (spec §D/§E — both leases stay
      // until complete, so an absent one means ownership was lost).
      assertExecutionHolder(context.row, session.session_id, scope.planId, "integration-start");
      assertMergeLease(context.snapshot, session, scope.planId, handoff);
      assertIntegrationCheckout(integrationAnchors(context.snapshot, scope.planId), scope.planId);
    },
    mutate: (context) => {
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      // A started attempt is never re-pinned: the recorded base stays the one
      // the coordinator merged onto.
      if (handoff.state === "integrating") return null;
      const anchors = integrationAnchors(context.snapshot, scope.planId);
      const checkout = assertIntegrationCheckout(anchors, scope.planId);
      const integration: HandoffIntegration = {
        target_branch: anchors.targetBranch,
        worktree_path: anchors.worktreePath,
        base_sha: checkout.head,
        started_at: nowIso(),
      };
      const nextCoordination: RowCoordination = {
        ...(context.coordination ?? { revision: 0 }),
        revision: context.revision + 1,
        handoff: { ...handoff, state: "integrating", integration },
      };
      assertViolationFree(validateRowCoordination(nextCoordination), `plan ${scope.planId} coordination`);
      const lease: IntegrationMergeLease = {
        holder: session.session_id,
        claimed_at: nowIso(),
        plan_id: scope.planId,
        source_branch: handoff.source_branch,
        target_branch: anchors.targetBranch,
      };
      return {
        row: { ...context.row, coordination: nextCoordination },
        coordination: nextCoordination,
        topLevel: { integration_merge_lease: lease },
      };
    },
  });
  return {
    ok: true,
    operation: "integration-start",
    session,
    session_file: sessionPath,
    outcome: result.outcome === "mutated" ? "integrating" : "already-integrating",
    view: buildView(
      scope.harnessRoot,
      scope.workflowId,
      scope.projectId,
      scope,
      result.snapshot,
      result.row,
      session,
      sessionPath,
    ),
  };
}

type IntegrationAcceptRequest = { handoffId: string; expectedRevision: number };

/**
 * Accept the finished integration (spec §E): prove the merge from the pinned
 * objects, record the observed result, and keep both leases and InReview until
 * complete. Nothing is proven by the branch merely existing.
 */
async function mutateIntegrationAccept(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: IntegrationAcceptRequest,
): Promise<CoordinationResult> {
  let proof: IntegrationProof = { kind: "pending" };
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    precheck: (context) => {
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      if (handoff.state !== "integrating") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `plan ${scope.planId} handoff is ${handoff.state} \u2014 integration-accept requires an integrating attempt`,
          { plan_id: scope.planId, state: handoff.state },
        );
      }
      if (rowStatusOf(context.row) !== "InReview") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `integration-accept requires ${scope.planId} to still be InReview`,
          { plan_id: scope.planId, status: context.row.status },
        );
      }
      assertEvidenceDigests(handoff);
      assertExecutionHolder(context.row, session.session_id, scope.planId, "integration-accept");
      assertMergeLease(context.snapshot, session, scope.planId, handoff);
      const integration = requireIntegration(handoff, scope.planId);
      const anchors = integrationAnchors(context.snapshot, scope.planId);
      const checkout = assertIntegrationCheckout(anchors, scope.planId);
      proof = integrationProof(anchors.worktreePath, checkout.head, integration.base_sha, handoff.source_sha);
      if (proof.kind === "diverged") {
        throw integrationDiverged(`plan ${scope.planId} integration cannot be proven \u2014 ${proof.reason}`, {
          plan_id: scope.planId,
          base: integration.base_sha,
          source: handoff.source_sha,
        });
      }
      if (proof.kind === "pending") {
        throw integrationUnresolved(
          `plan ${scope.planId} integration shows no merge of ${handoff.source_sha} onto ${integration.base_sha} yet \u2014 run the coordinator merge, then accept`,
          { plan_id: scope.planId, base: integration.base_sha, source: handoff.source_sha },
        );
      }
    },
    mutate: (context) => {
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      const integration = requireIntegration(handoff, scope.planId);
      if (proof.kind !== "proven") return null;
      const merged: HandoffIntegration = { ...integration, result_sha: proof.resultSha, verified_at: nowIso() };
      const nextCoordination: RowCoordination = {
        ...(context.coordination ?? { revision: 0 }),
        revision: context.revision + 1,
        handoff: { ...handoff, state: "merged", integration: merged },
      };
      assertViolationFree(validateRowCoordination(nextCoordination), `plan ${scope.planId} coordination`);
      // Both leases and InReview stay: complete releases them (spec §E).
      return { row: { ...context.row, coordination: nextCoordination }, coordination: nextCoordination };
    },
  });
  return {
    ok: true,
    operation: "integration-accept",
    session,
    session_file: sessionPath,
    outcome: "merged",
    view: buildView(
      scope.harnessRoot,
      scope.workflowId,
      scope.projectId,
      scope,
      result.snapshot,
      result.row,
      session,
      sessionPath,
    ),
  };
}


function validateRowCoordinationInContext(context: RowContext, coordination: RowCoordination, what: string): void {
  assertViolationFree(validateRowCoordination(coordination, what, rowValidationRoute(context.snapshot, context.row)), what);
}

function standaloneDeliveryAnchors(snapshot: WorkflowSnapshot, planId: string): { source: string; target: string } {
  const source = snapshot.branch?.source;
  const target = snapshot.branch?.target;
  if (!isNonEmptyString(source) || !isNonEmptyString(target)) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${planId} has no delivery anchors \u2014 the snapshot must name branch.source and branch.target`,
      { plan_id: planId },
    );
  }
  return { source, target };
}

function assertStandaloneRoute(snapshot: WorkflowSnapshot, planId: string, what: string): void {
  if (!isStandaloneDevelopmentWorkflow(snapshot)) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires a standalone development workflow for plan ${planId}`,
      { plan_id: planId },
    );
  }
}

function assertNoIntegrationContamination(
  context: RowContext,
  planId: string,
  handoff: PlanHandoff,
  what: string,
  code: CoordinationError["code"] = "coordination.invalid-transition",
): void {
  if (handoff.integration !== undefined) {
    throw new CoordinationError(
      code,
      `${what} refuses plan ${planId} because the handoff already carries an integration record`,
      { plan_id: planId },
    );
  }
  if (context.snapshot.integration_worktree_path !== undefined) {
    throw new CoordinationError(
      code,
      `${what} refuses plan ${planId} because the snapshot names integration_worktree_path`,
      { plan_id: planId },
    );
  }
  if (isNonEmptyString(context.snapshot.branch?.integration)) {
    throw new CoordinationError(
      code,
      `${what} refuses plan ${planId} because the snapshot names branch.integration`,
      { plan_id: planId, integration: context.snapshot.branch?.integration },
    );
  }
  if (context.snapshot.integration_merge_lease !== undefined) {
    throw new CoordinationError(
      code,
      `${what} refuses plan ${planId} because the snapshot carries an integration merge lease`,
      { plan_id: planId },
    );
  }
}

function assertAcceptedReviewDecision(handoff: PlanHandoff, planId: string, what: string): void {
  if (handoff.qc.decision !== "Approve" && handoff.qc.decision !== "Approve with residuals") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires an accepted QC decision for plan ${planId} \u2014 got ${handoff.qc.decision}`,
      { plan_id: planId, decision: handoff.qc.decision },
    );
  }
  if (handoff.qa.decision !== "pass") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires QA decision pass for plan ${planId} \u2014 got ${handoff.qa.decision}`,
      { plan_id: planId, decision: handoff.qa.decision },
    );
  }
}

function assertStandaloneBranchIdentity(
  context: RowContext,
  scope: ResolvedPlanScope,
  handoff: PlanHandoff,
  anchors: { source: string; target: string },
  what: string,
  requireLease = true,
): void {
  const worktree = canonicalTarget(scope.worktreePath);
  if (handoff.source_branch !== anchors.source) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `${what} requires handoff.source_branch ${handoff.source_branch} to equal the registered delivery source ${anchors.source}`,
      { plan_id: scope.planId, expected: anchors.source, actual: handoff.source_branch },
    );
  }
  if (requireLease) {
    const lease = requireExecutionLease(context.row, scope.planId, what);
    if (scope.workingBranch !== anchors.source) {
      throw new CoordinationError(
        "coordination.scope-mismatch",
        `${what} requires the prepared working branch ${scope.workingBranch} to equal the registered delivery source ${anchors.source}`,
        { plan_id: scope.planId, expected: anchors.source, actual: scope.workingBranch },
      );
    }
    if (lease.working_branch !== anchors.source) {
      throw new CoordinationError(
        "coordination.scope-mismatch",
        `${what} requires the execution lease working branch ${lease.working_branch} to equal the registered delivery source ${anchors.source}`,
        { plan_id: scope.planId, expected: anchors.source, actual: lease.working_branch },
      );
    }
    if (canonicalTarget(lease.worktree_path) !== worktree) {
      throw new CoordinationError(
        "coordination.path-mismatch",
        `${what} requires the execution lease worktree ${lease.worktree_path} to equal the prepared scope ${worktree}`,
        { plan_id: scope.planId, expected: worktree, actual: lease.worktree_path },
      );
    }
  }
  if (canonicalTarget(handoff.worktree_path) !== worktree) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `${what} requires the handoff worktree ${handoff.worktree_path} to equal the prepared scope ${worktree}`,
      { plan_id: scope.planId, expected: worktree, actual: handoff.worktree_path },
    );
  }
  const metadata = context.row.metadata;
  if (isPlainObject(metadata) && metadata.working_branch !== undefined && metadata.working_branch !== anchors.source) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `${what} requires row metadata.working_branch to equal the registered delivery source ${anchors.source}`,
      { plan_id: scope.planId, expected: anchors.source, actual: metadata.working_branch },
    );
  }
  if (isPlainObject(metadata) && metadata.worktree_path !== undefined && canonicalTarget(String(metadata.worktree_path)) !== worktree) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `${what} requires row metadata.worktree_path to equal the prepared scope ${worktree}`,
      { plan_id: scope.planId, expected: worktree, actual: metadata.worktree_path },
    );
  }
}

function assertStandaloneSourceGitProof(scope: ResolvedPlanScope, handoff: PlanHandoff, sourceBranch: string, what: string): void {
  assertFeatureCheckout(scope, handoff.source_sha, what);
  const branch = gitRead(scope.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== sourceBranch) {
    throw gitProof(
      `${what} requires the plan worktree ${scope.worktreePath} to be on ${sourceBranch} \u2014 got ${branch || "a detached HEAD"}`,
      { plan_id: scope.planId, expected: sourceBranch, actual: branch },
    );
  }
  const refTip = gitRead(scope.worktreePath, ["rev-parse", `refs/heads/${sourceBranch}`]);
  if (refTip !== handoff.source_sha) {
    throw gitProof(
      `${what} requires refs/heads/${sourceBranch} to resolve to the pinned source ${handoff.source_sha} \u2014 got ${refTip || "missing"}`,
      { plan_id: scope.planId, expected: handoff.source_sha, actual: refTip },
    );
  }
  if (handoff.review_head !== handoff.source_sha) {
    throw gitProof(
      `${what} requires review_head to be the pinned source ${handoff.source_sha} \u2014 got ${handoff.review_head}`,
      { plan_id: scope.planId, source_sha: handoff.source_sha, review_head: handoff.review_head },
    );
  }
  if (!gitObjectExists(scope.worktreePath, handoff.review_base)) {
    throw gitProof(`${what} review base ${handoff.review_base} is not a commit of ${scope.worktreePath}`, {
      plan_id: scope.planId,
      review_base: handoff.review_base,
    });
  }
  if (!gitIsAncestor(scope.worktreePath, handoff.review_base, handoff.review_head)) {
    throw gitProof(
      `${what} review range ${handoff.review_base}..${handoff.review_head} is not an ancestry`,
      { plan_id: scope.planId, review_base: handoff.review_base, review_head: handoff.review_head },
    );
  }
}

async function assertStandaloneCompletionPrecheck(
  context: RowContext,
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  handoff: PlanHandoff,
): Promise<void> {
  assertStandaloneRoute(context.snapshot, scope.planId, "complete");
  if (context.snapshot.status !== "running") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `complete requires workflow ${context.snapshot.id} to still be running \u2014 got ${context.snapshot.status}`,
      { workflow_id: context.snapshot.id, status: context.snapshot.status },
    );
  }
  if (handoff.state !== "accepted") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${scope.planId} handoff is ${handoff.state} \u2014 standalone complete requires an accepted handoff`,
      { plan_id: scope.planId, state: handoff.state },
    );
  }
  if (rowStatusOf(context.row) !== "InReview") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `complete requires ${scope.planId} to still be InReview`,
      { plan_id: scope.planId, status: context.row.status },
    );
  }
  const prepared = context.coordination?.prepared;
  if (prepared === undefined) {
    throw new CoordinationError(
      "coordination.not-prepared",
      `plan ${scope.planId} is not prepared in this workflow`,
      { plan_id: scope.planId },
    );
  }
  assertNoIntegrationContamination(context, scope.planId, handoff, "complete");
  assertEvidenceDigests(handoff);
  assertAcceptedReviewDecision(handoff, scope.planId, "complete");
  if (handoff.qa.gate !== prepared.qa_gate) {
    throw new CoordinationError(
      "coordination.assignment-stale",
      `complete qa.gate ${handoff.qa.gate} is not the Assignment's QA gate ${prepared.qa_gate}`,
      { plan_id: scope.planId, expected: prepared.qa_gate, actual: handoff.qa.gate },
    );
  }
  await assertFindingsClosed(scope, prepared, "complete");
  assertExecutionHolder(context.row, session.session_id, scope.planId, "complete");
  const anchors = standaloneDeliveryAnchors(context.snapshot, scope.planId);
  assertStandaloneBranchIdentity(context, scope, handoff, anchors, "complete");
  assertStandaloneSourceGitProof(scope, handoff, anchors.source, "complete");
}


function requireAcceptedHandoffForRepair(
  context: RowContext,
  planId: string,
  namedHandoffId: string,
): PlanHandoff {
  const handoff = context.coordination?.handoff;
  if (
    handoff === undefined ||
    handoff.id !== namedHandoffId ||
    handoff.state !== "accepted" ||
    rowStatusOf(context.row) !== "InReview"
  ) {
    throw new CoordinationError(
      "coordination.delivery-source-repair.no-accepted-handoff",
      `repair-delivery-source requires plan ${planId} to carry the named accepted handoff while InReview`,
      { plan_id: planId, handoff_id: namedHandoffId, state: handoff?.state, status: context.row.status },
    );
  }
  return handoff;
}

function assertRepairNotTerminal(snapshot: WorkflowSnapshot): void {
  if ((WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(snapshot.status)) {
    throw new CoordinationError(
      "coordination.delivery-source-repair.terminal",
      `repair-delivery-source refuses workflow ${snapshot.id} in terminal status ${snapshot.status}`,
      { workflow_id: snapshot.id, status: snapshot.status },
    );
  }
}

function assertLegacyRepairShape(
  snapshot: WorkflowSnapshot,
  planId: string,
  handoff: PlanHandoff,
): { target: string; candidateSource: string } {
  const source = snapshot.branch?.source;
  const target = snapshot.branch?.target;
  if (!isNonEmptyString(source) || !isNonEmptyString(target)) {
    throw new CoordinationError(
      "coordination.delivery-source-repair.not-legacy-shape",
      `repair-delivery-source requires nonblank delivery anchors on plan ${planId}`,
      { plan_id: planId },
    );
  }
  const candidateSource = handoff.source_branch;
  if (!isNonEmptyString(candidateSource)) {
    throw new CoordinationError(
      "coordination.delivery-source-repair.not-legacy-shape",
      `repair-delivery-source requires the accepted handoff to name a nonblank source branch for plan ${planId}`,
      { plan_id: planId },
    );
  }
  if (source === candidateSource) {
    throw new CoordinationError(
      "coordination.delivery-source-repair.already-aligned",
      `repair-delivery-source refuses plan ${planId} because branch.source already equals the accepted handoff source ${candidateSource}`,
      { plan_id: planId, source, candidate: candidateSource },
    );
  }
  if (source !== target) {
    throw new CoordinationError(
      "coordination.delivery-source-repair.not-legacy-shape",
      `repair-delivery-source requires the legacy shape branch.source === branch.target for plan ${planId} \u2014 got source ${source} and target ${target}`,
      { plan_id: planId, source, target },
    );
  }
  return { target, candidateSource };
}

function assertRepairBranchIdentity(
  context: RowContext,
  scope: ResolvedPlanScope,
  handoff: PlanHandoff,
  candidateSource: string,
  what: string,
): void {
  const worktree = canonicalTarget(scope.worktreePath);
  if (handoff.source_branch !== candidateSource) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `${what} requires handoff.source_branch ${handoff.source_branch} to equal the candidate delivery source ${candidateSource}`,
      { plan_id: scope.planId, expected: candidateSource, actual: handoff.source_branch },
    );
  }
  const lease = requireExecutionLease(context.row, scope.planId, what);
  if (scope.workingBranch !== candidateSource) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `${what} requires the prepared working branch ${scope.workingBranch} to equal the candidate delivery source ${candidateSource}`,
      { plan_id: scope.planId, expected: candidateSource, actual: scope.workingBranch },
    );
  }
  if (lease.working_branch !== candidateSource) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `${what} requires the execution lease working branch ${lease.working_branch} to equal the candidate delivery source ${candidateSource}`,
      { plan_id: scope.planId, expected: candidateSource, actual: lease.working_branch },
    );
  }
  if (canonicalTarget(lease.worktree_path) !== worktree) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `${what} requires the execution lease worktree ${lease.worktree_path} to equal the prepared scope ${worktree}`,
      { plan_id: scope.planId, expected: worktree, actual: lease.worktree_path },
    );
  }
  if (canonicalTarget(handoff.worktree_path) !== worktree) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `${what} requires the handoff worktree ${handoff.worktree_path} to equal the prepared scope ${worktree}`,
      { plan_id: scope.planId, expected: worktree, actual: handoff.worktree_path },
    );
  }
  const metadata = context.row.metadata;
  if (isPlainObject(metadata) && metadata.working_branch !== undefined && metadata.working_branch !== candidateSource) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `${what} requires row metadata.working_branch to equal the candidate delivery source ${candidateSource}`,
      { plan_id: scope.planId, expected: candidateSource, actual: metadata.working_branch },
    );
  }
  if (isPlainObject(metadata) && metadata.worktree_path !== undefined && canonicalTarget(String(metadata.worktree_path)) !== worktree) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `${what} requires row metadata.worktree_path to equal the prepared scope ${worktree}`,
      { plan_id: scope.planId, expected: worktree, actual: metadata.worktree_path },
    );
  }
}

function assertDeliveryPrCompatible(
  snapshot: WorkflowSnapshot,
  candidateSource: string,
  registeredTarget: string,
  planId: string,
): void {
  const pr = snapshot.delivery?.pr;
  if (pr === undefined) return;
  if (pr.head !== candidateSource || pr.target !== registeredTarget) {
    throw new CoordinationError(
      "coordination.delivery-source-repair.pr-conflict",
      `repair-delivery-source refuses plan ${planId} because stored PR identity head ${JSON.stringify(pr.head)} target ${JSON.stringify(pr.target)} conflicts with candidate source ${candidateSource} and registered target ${registeredTarget}`,
      { plan_id: planId, pr_head: pr.head, pr_target: pr.target, candidate: candidateSource, target: registeredTarget },
    );
  }
}

function assertRepairDeliverySourceAdmission(context: RowContext, scope: ResolvedPlanScope): void {
  if (!isStandaloneDevelopmentWorkflow(context.snapshot)) {
    throw new CoordinationError(
      "coordination.delivery-source-repair.unsupported-workflow",
      `repair-delivery-source requires a single-row standalone development workflow for plan ${scope.planId}`,
      { plan_id: scope.planId, workflow_id: context.snapshot.id },
    );
  }
  assertRepairNotTerminal(context.snapshot);
  if (context.snapshot.status === "paused") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `repair-delivery-source refuses paused workflow ${context.snapshot.id}`,
      { workflow_id: context.snapshot.id, status: context.snapshot.status },
    );
  }
  if (context.snapshot.status !== "running") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `repair-delivery-source requires workflow ${context.snapshot.id} to still be running \u2014 got ${context.snapshot.status}`,
      { workflow_id: context.snapshot.id, status: context.snapshot.status },
    );
  }
}

async function assertRepairDeliverySourcePrecheck(
  context: RowContext,
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  handoff: PlanHandoff,
): Promise<void> {
  assertNoIntegrationContamination(
    context,
    scope.planId,
    handoff,
    "repair-delivery-source",
    "coordination.delivery-source-repair.not-legacy-shape",
  );
  const prepared = context.coordination?.prepared;
  if (prepared === undefined) {
    throw new CoordinationError(
      "coordination.not-prepared",
      `plan ${scope.planId} is not prepared in this workflow`,
      { plan_id: scope.planId },
    );
  }
  assertEvidenceDigests(handoff);
  assertAcceptedReviewDecision(handoff, scope.planId, "repair-delivery-source");
  if (handoff.qa.gate !== prepared.qa_gate) {
    throw new CoordinationError(
      "coordination.assignment-stale",
      `repair-delivery-source qa.gate ${handoff.qa.gate} is not the Assignment's QA gate ${prepared.qa_gate}`,
      { plan_id: scope.planId, expected: prepared.qa_gate, actual: handoff.qa.gate },
    );
  }
  await assertFindingsClosed(scope, prepared, "repair-delivery-source");
  assertExecutionHolder(context.row, session.session_id, scope.planId, "repair-delivery-source");
  const { target, candidateSource } = assertLegacyRepairShape(context.snapshot, scope.planId, handoff);
  assertRepairBranchIdentity(context, scope, handoff, candidateSource, "repair-delivery-source");
  assertDeliveryPrCompatible(context.snapshot, candidateSource, target, scope.planId);
  assertStandaloneSourceGitProof(scope, handoff, candidateSource, "repair-delivery-source");
}

function repairDeliverySourceRow(
  context: RowContext,
  scope: ResolvedPlanScope,
  candidateSource: string,
): RowCommit {
  const nextCoordination: RowCoordination = {
    ...(context.coordination ?? { revision: 0 }),
    revision: context.revision + 1,
  };
  validateRowCoordinationInContext(context, nextCoordination, `plan ${scope.planId} coordination`);
  const currentBranch = context.snapshot.branch ?? {};
  return {
    row: { ...context.row, coordination: nextCoordination },
    coordination: nextCoordination,
    topLevel: {
      branch: { ...currentBranch, source: candidateSource },
    },
  };
}

type RepairDeliverySourceRequest = { handoffId: string; expectedRevision: number };

async function mutateRepairDeliverySource(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: RepairDeliverySourceRequest,
): Promise<CoordinationResult> {
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    precheck: async (context) => {
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      assertRepairDeliverySourceAdmission(context, scope);
      const handoff = requireAcceptedHandoffForRepair(context, scope.planId, request.handoffId);
      await assertRepairDeliverySourcePrecheck(context, scope, session, handoff);
    },
    mutate: (context) => {
      const handoff = requireAcceptedHandoffForRepair(context, scope.planId, request.handoffId);
      const { candidateSource } = assertLegacyRepairShape(context.snapshot, scope.planId, handoff);
      return repairDeliverySourceRow(context, scope, candidateSource);
    },
  });
  return {
    ok: true,
    operation: "repair-delivery-source",
    session,
    session_file: sessionPath,
    outcome: "delivery-source-repaired",
    view: buildView(
      scope.harnessRoot,
      scope.workflowId,
      scope.projectId,
      scope,
      result.snapshot,
      result.row,
      session,
      sessionPath,
    ),
  };
}

function completeStandaloneRow(context: RowContext, scope: ResolvedPlanScope, handoff: PlanHandoff): RowCommit {
  const metadata = isPlainObject(context.row.metadata) ? { ...context.row.metadata } : {};
  metadata.working_branch = handoff.source_branch;
  metadata.worktree_path = handoff.worktree_path;
  const nextCoordination: RowCoordination = {
    ...(context.coordination ?? { revision: 0 }),
    revision: context.revision + 1,
    handoff: { ...handoff, state: "completed", completed_at: nowIso() },
  };
  validateRowCoordinationInContext(context, nextCoordination, `plan ${scope.planId} coordination`);
  const nextRow: PlanRow = { ...context.row, status: "Done", metadata, coordination: nextCoordination };
  delete nextRow.execution_lease;
  return { row: nextRow, coordination: nextCoordination };
}

function assertStandaloneCompletedReplay(
  context: RowContext,
  scope: ResolvedPlanScope,
  handoff: PlanHandoff,
): void {
  assertStandaloneRoute(context.snapshot, scope.planId, "reconcile");
  if (rowStatusOf(context.row) !== "Done") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `reconcile requires ${scope.planId} to be Done for a standalone completed replay`,
      { plan_id: scope.planId, status: context.row.status },
    );
  }
  if (context.row.execution_lease !== undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `reconcile requires no execution lease on ${scope.planId} for a standalone completed replay`,
      { plan_id: scope.planId },
    );
  }
  if (context.snapshot.integration_merge_lease !== undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `reconcile requires no integration merge lease for a standalone completed replay of ${scope.planId}`,
      { plan_id: scope.planId },
    );
  }
  assertNoIntegrationContamination(context, scope.planId, handoff, "reconcile");
  const storedHandoffViolations = validatePlanHandoff(
    handoff,
    `plan ${scope.planId} coordination.handoff`,
    "standalone-development",
  );
  const storedHandoffFailure = storedHandoffViolations.find((entry) => !entry.ok);
  if (storedHandoffFailure !== undefined) {
    throw new CoordinationError(
      storedHandoffFailure.code as CoordinationError["code"],
      storedHandoffFailure.message,
      { plan_id: scope.planId },
    );
  }
  const anchors = standaloneDeliveryAnchors(context.snapshot, scope.planId);
  assertStandaloneBranchIdentity(context, scope, handoff, anchors, "reconcile", false);
  const repository = proofRepository([handoff.worktree_path, scope.worktreePath, scope.harnessRoot]);
  if (repository !== undefined && !gitObjectExists(repository, handoff.source_sha)) {
    throw gitProof(
      `reconcile cannot re-verify the pinned standalone source ${handoff.source_sha} for plan ${scope.planId}`,
      { plan_id: scope.planId, source_sha: handoff.source_sha },
    );
  }
}

async function assertIterationCompletionPrecheck(
  context: RowContext,
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  handoff: PlanHandoff,
): Promise<void> {
  if (handoff.state !== "merged") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${scope.planId} handoff is ${handoff.state} \u2014 complete requires a merged attempt`,
      { plan_id: scope.planId, state: handoff.state },
    );
  }
  if (rowStatusOf(context.row) !== "InReview") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `complete requires ${scope.planId} to still be InReview`,
      { plan_id: scope.planId, status: context.row.status },
    );
  }
  const prepared = context.coordination?.prepared;
  if (prepared === undefined) {
    throw new CoordinationError(
      "coordination.not-prepared",
      `plan ${scope.planId} is not prepared in this workflow`,
      { plan_id: scope.planId },
    );
  }
  assertEvidenceDigests(handoff);
  await assertFindingsClosed(scope, prepared, "complete");
  assertExecutionHolder(context.row, session.session_id, scope.planId, "complete");
  assertMergeLease(context.snapshot, session, scope.planId, handoff);
  const integration = requireIntegration(handoff, scope.planId);
  const anchors = integrationAnchors(context.snapshot, scope.planId);
  const checkout = assertIntegrationCheckout(anchors, scope.planId);
  assertRecordedResult(anchors.worktreePath, scope.planId, integration, handoff.source_sha, checkout.head);
}

/**
 * The atomic completion delta (spec §E): `Done`, the retained branch/worktree
 * metadata and `track_branches`, the completed handoff, and one write that
 * releases the row's execution lease and this workflow's merge lease. Cleanup
 * authority is what the retained metadata preserves — the leases do not.
 */
function completeRow(
  context: RowContext,
  scope: ResolvedPlanScope,
  handoff: PlanHandoff,
  resultSha: string,
): RowCommit {
  const integration = requireIntegration(handoff, scope.planId);
  const completed: HandoffIntegration = { ...integration, result_sha: resultSha, verified_at: nowIso() };
  const nextCoordination: RowCoordination = {
    ...(context.coordination ?? { revision: 0 }),
    revision: context.revision + 1,
    handoff: { ...handoff, state: "completed", integration: completed, completed_at: nowIso() },
  };
  assertViolationFree(validateRowCoordination(nextCoordination), `plan ${scope.planId} coordination`);
  const nextRow: PlanRow = { ...context.row, status: "Done", coordination: nextCoordination };
  delete nextRow.execution_lease;
  // Only this attempt's own claim is released: a lease naming another plan or
  // another source branch is not this completion's to drop (spec §E).
  const release = mergeLeaseOfAttempt(context.snapshot, scope.planId, handoff);
  return {
    row: nextRow,
    coordination: nextCoordination,
    dropTopLevel: release === undefined ? [] : ["integration_merge_lease"],
  };
}

type CompleteRequest = { handoffId: string; expectedRevision: number };

let completeStandaloneMutateGapForTest: (() => void) | undefined;

/** Test-only hook to observe the precheck→mutate gap in standalone complete. */
export function setCompleteStandaloneMutateGapForTest(callback: (() => void) | undefined): void {
  completeStandaloneMutateGapForTest = callback;
}

/**
 * Complete a merged plan (spec §E): re-prove the recorded result, re-check the
 * evidence digests and the findings gate, then apply the completion delta.
 * After integration started the proof is the pinned objects alone — a feature
 * worktree that authorized cleanup may already be gone.
 */
async function mutateComplete(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: CompleteRequest,
): Promise<CoordinationResult> {
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    precheck: async (context) => {
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      if (isStandaloneDevelopmentWorkflow(context.snapshot)) {
        await assertStandaloneCompletionPrecheck(context, scope, session, handoff);
        return;
      }
      await assertIterationCompletionPrecheck(context, scope, session, handoff);
    },
    mutate: (context) => {
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      if (isStandaloneDevelopmentWorkflow(context.snapshot)) {
        completeStandaloneMutateGapForTest?.();
        const anchors = standaloneDeliveryAnchors(context.snapshot, scope.planId);
        assertStandaloneSourceGitProof(scope, handoff, anchors.source, "complete");
        return completeStandaloneRow(context, scope, handoff);
      }
      const integration = requireIntegration(handoff, scope.planId);
      const resultSha = assertRecordedResult(
        integration.worktree_path,
        scope.planId,
        integration,
        handoff.source_sha,
        undefined,
      );
      return completeRow(context, scope, handoff, resultSha);
    },
  });
  return {
    ok: true,
    operation: "complete",
    session,
    session_file: sessionPath,
    outcome: "completed",
    view: buildView(
      scope.harnessRoot,
      scope.workflowId,
      scope.projectId,
      scope,
      result.snapshot,
      result.row,
      session,
      sessionPath,
    ),
  };
}

/** One reconcile decision: its outcome label and the delta it applies. */
type ReconcilePlan = { outcome: string; apply: (context: RowContext) => RowCommit | null };

/**
 * Classify one un-reconciled attempt (spec §E) and never run a merge:
 *
 * - `integrating` with the base unmoved and the source unmerged is
 *   `retry-ready`: back to `accepted`, the attempt block and this holder's
 *   merge lease released, the row still InReview with its execution lease.
 * - `integrating` with a proven result, and `merged` with a still-valid
 *   recorded proof, complete normally (the same atomic delta).
 * - an unfinished or dirty integration checkout is left untouched
 *   (`integration-unresolved`), as is a moved branch, an unexpected parent
 *   graph, several matching merges or unavailable objects
 *   (`integration-diverged`) — nothing is repaired by guessing.
 * - `completed` with a valid recorded proof is a read-only no-op: replay never
 *   resurrects ownership or rewrites timestamps.
 */
async function classifyReconcile(
  context: RowContext,
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  handoff: PlanHandoff,
  expectedHandoffId: string,
): Promise<ReconcilePlan> {
  const planId = scope.planId;
  const prepared = context.coordination?.prepared;
  if (prepared === undefined) {
    throw new CoordinationError("coordination.not-prepared", `plan ${planId} is not prepared in this workflow`, {
      plan_id: planId,
    });
  }
  if (handoff.state === "completed") {
    if (isStandaloneDevelopmentWorkflow(context.snapshot)) {
      assertStandaloneCompletedReplay(context, scope, handoff);
      return { outcome: "already-completed", apply: () => null };
    }
    const integration = requireIntegration(handoff, planId);
    const repository = proofRepository([integration.worktree_path, handoff.worktree_path, session.harness_root]);
    if (repository === undefined) {
      throw integrationDiverged(`plan ${planId} has no readable integration repository to re-verify ${integration.result_sha}`, {
        plan_id: planId,
        worktree_path: integration.worktree_path,
      });
    }
    const head = gitRead(repository, ["rev-parse", integration.target_branch]);
    assertRecordedResult(repository, planId, integration, handoff.source_sha, head);
    return { outcome: "already-completed", apply: () => null };
  }
  if (handoff.state === "integrating" || handoff.state === "merged") {
    assertEvidenceDigests(handoff);
    const integration = requireIntegration(handoff, planId);
    const anchors = integrationAnchors(context.snapshot, planId);
    const checkout = assertIntegrationCheckout(anchors, planId);
    // `completed` above is the read-only replay; every other path completes the
    // row, so the coordinator must still hold the execution lease it received
    // at accept (spec §E — nothing is replayed into ownership).
    assertExecutionHolder(context.row, session.session_id, planId, "reconcile");
    assertMergeLease(context.snapshot, session, planId, handoff);
    const merged = async (resultSha: string): Promise<ReconcilePlan> => {
      await assertFindingsClosed(scope, prepared, "complete");
      return {
        outcome: "completed",
        apply: (current) => completeRow(current, scope, requireHandoff(current, planId, expectedHandoffId), resultSha),
      };
    };
    if (handoff.state === "merged") {
      const resultSha = assertRecordedResult(anchors.worktreePath, planId, integration, handoff.source_sha, checkout.head);
      return await merged(resultSha);
    }
    const proof = integrationProof(anchors.worktreePath, checkout.head, integration.base_sha, handoff.source_sha);
    if (proof.kind === "diverged") {
      throw integrationDiverged(`plan ${planId} integration cannot be reconciled \u2014 ${proof.reason}`, {
        plan_id: planId,
        base: integration.base_sha,
        source: handoff.source_sha,
      });
    }
    if (proof.kind === "proven") return await merged(proof.resultSha);
    if (checkout.head !== integration.base_sha) {
      throw integrationDiverged(
        `plan ${planId} integration HEAD ${checkout.head} moved past the attempt base ${integration.base_sha} without a merge of ${handoff.source_sha}`,
        { plan_id: planId, base: integration.base_sha, head: checkout.head },
      );
    }
    return {
      outcome: "retry-ready",
      apply: (current) => {
        const currentHandoff = requireHandoff(current, planId, expectedHandoffId);
        const returned: PlanHandoff = { ...currentHandoff, state: "accepted" };
        delete returned.integration;
        const nextCoordination: RowCoordination = {
          ...(current.coordination ?? { revision: 0 }),
          revision: current.revision + 1,
          handoff: returned,
        };
        assertViolationFree(validateRowCoordination(nextCoordination), `plan ${planId} coordination`);
        // InReview and the coordinator's execution lease stay: only the
        // abandoned attempt's own artifacts are released (a lease naming
        // another plan or branch is not this attempt's claim).
        const release = mergeLeaseOfAttempt(current.snapshot, planId, currentHandoff);
        return {
          row: { ...current.row, coordination: nextCoordination },
          coordination: nextCoordination,
          dropTopLevel: release === undefined ? [] : ["integration_merge_lease"],
        };
      },
    };
  }
  throw new CoordinationError(
    "coordination.invalid-transition",
    `plan ${planId} handoff is ${handoff.state} \u2014 reconcile recovers only integrating, merged or completed attempts`,
    { plan_id: planId, state: handoff.state },
  );
}

type ReconcileRequest = { handoffId: string; expectedRevision: number };

/**
 * Reconcile one crash-interrupted integration attempt (spec §E). Reconciliation
 * classifies and completes; it never merges, never re-pins and never guesses.
 */
async function mutateReconcile(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: ReconcileRequest,
): Promise<CoordinationResult> {
  let plan: ReconcilePlan = { outcome: "unchanged", apply: () => null };
  const result = await withRowCommit(scope, {
    expectedRevision: request.expectedRevision,
    precheck: async (context) => {
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      const handoff = requireHandoff(context, scope.planId, request.handoffId);
      plan = await classifyReconcile(context, scope, session, handoff, request.handoffId);
    },
    mutate: (context) => plan.apply(context),
  });
  return {
    ok: true,
    operation: "reconcile",
    session,
    session_file: sessionPath,
    outcome: plan.outcome,
    view: buildView(
      scope.harnessRoot,
      scope.workflowId,
      scope.projectId,
      scope,
      result.snapshot,
      result.row,
      session,
      sessionPath,
    ),
  };
}

/* ------------------------------------------------------------------------ *
 * § replaceCoordinatedArtifact
 * ------------------------------------------------------------------------ */

/**
 * Replace a coordinated artifact with an exact-version precondition (spec §B,
 * §C4 line 156). Snapshot replacement goes through the canonical snapshot
 * writer (coordinator session, phase-only delta, locked CAS); the root status
 * and a project register are written with the same byte-version CAS under
 * root → snapshot → destination locks, refusing any document that carries
 * coordinated ownership. `review`/`json` are not coordinated artifacts, so
 * they refuse explicitly instead of silently no-opping.
 */
export async function replaceCoordinatedArtifact(input: CoordinatedReplacement): Promise<VersionedArtifact> {
  assertExactKeys(
    input,
    ["harnessRoot", "ref", "payload", "expectedVersion", "sessionPath"],
    "replacement",
  );
  if (!isNonEmptyString(input.harnessRoot) || !isAbsolute(input.harnessRoot)) {
    throw invalidInput("harnessRoot must be an absolute path");
  }
  if (!isPlainObject(input.ref) || !isNonEmptyString(input.ref.kind) || !isNonEmptyString(input.ref.key)) {
    throw invalidInput("ref must be an ArtifactRef with kind and key");
  }
  if (!isNonEmptyString(input.expectedVersion)) {
    throw new CoordinationError(
      "coordination.expected-version-required",
      "a coordinated replacement requires expectedVersion (sha256:\u2026 or \"absent\")",
      {},
    );
  }
  if (input.expectedVersion !== "absent" && !isArtifactVersion(input.expectedVersion)) {
    throw invalidInput(`expectedVersion must be "absent" or sha256:<hex> \u2014 got ${input.expectedVersion}`, {});
  }
  const kind = input.ref.kind;
  if (kind === "status") {
    const root = canonicalizeNearestExisting(input.harnessRoot);
    await replaceRootStatus(input, root);
    return readCoordinatedArtifact(root, input.ref);
  }
  if (kind === "residuals") {
    const root = canonicalizeNearestExisting(input.harnessRoot);
    await replaceProjectRegister(input, root);
    return readCoordinatedArtifact(root, input.ref);
  }
  if (kind !== "snapshot") {
    throw new CoordinationError(
      "coordination.scoped-writer-required",
      `kind ${kind} has no coordinated writer \u2014 a scoped replacement covers snapshot, status and residuals; ${kind} keeps its own writer`,
      { kind },
    );
  }
  const harnessRoot = canonicalizeNearestExisting(input.harnessRoot);
  localStore(harnessRoot);
  if (!isNonEmptyString(input.sessionPath) || !isAbsolute(input.sessionPath)) {
    throw new CoordinationError(
      "coordination.session-role",
      "a coordinated snapshot replacement requires the coordinator session envelope",
      { kind: input.ref.kind },
    );
  }
  const session = readSessionEnvelope(input.sessionPath);
  if (session.role !== "coordinator") {
    throw new CoordinationError("coordination.session-role", `a coordinator session is required, not ${session.role}`, {
      role: session.role,
    });
  }
  if (session.workflow_id !== input.ref.key) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `session ${session.session_id} coordinates workflow ${session.workflow_id}, not ${input.ref.key}`,
      { expected: session.workflow_id, actual: input.ref.key },
    );
  }
  const snapshotPath = resolveArtifactPath(harnessRoot, input.ref);
  assertSnapshotPath(harnessRoot, input.ref.key, snapshotPath);
  if (!existsSync(snapshotPath)) {
    throw new CoordinationError("coordination.workflow-not-found", `workflow snapshot not found: ${snapshotPath}`, {
      path: snapshotPath,
    });
  }
  const current = readSnapshot(dirname(snapshotPath));
  if (current.coordination === undefined) {
    throw new CoordinationError(
      "coordination.not-prepared",
      `workflow ${current.id} has no coordinator binding \u2014 a coordinated snapshot replacement requires one`,
      { workflow_id: current.id },
    );
  }
  if (!isPlainObject(input.payload)) {
    throw invalidInput("a snapshot payload must be an object");
  }
  if (input.payload.id !== input.ref.key) {
    throw invalidInput(
      `snapshot payload id ${JSON.stringify(input.payload.id)} does not match ref key ${JSON.stringify(input.ref.key)}`,
      {},
    );
  }
  const gate = validateWorkflowSnapshot(input.payload);
  if (!gate.ok) {
    throw invalidInput(`snapshot payload fails validation \u2014 ${summarize(gate.violations)}`, {
      violations: gate.violations.map((entry) => entry.code),
    });
  }
  // Boundary cast: the payload passed the snapshot gate immediately above and
  // `writeWorkflowSnapshot` re-validates the merged document before writing.
  const payload = input.payload as WorkflowSnapshot;
  await writeWorkflowSnapshot(payload, dirname(snapshotPath), {
    expectedVersion: input.expectedVersion,
    sessionPath: canonicalTarget(input.sessionPath),
  });
  return readCoordinatedArtifact(harnessRoot, input.ref);
}

function artifactVersionConflict(path: string, expected: string, actual: string): CoordinationError {
  return new CoordinationError(
    "coordination.version-conflict",
    `${path} is at version ${actual}, expected ${expected} \u2014 re-read it (\`persist get --versioned\`) and retry`,
    { expected, actual, path },
  );
}

function scopedWriterRequired(message: string, details: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.scoped-writer-required", message, details);
}

/** One workflow a root status doc registers, with its resolved snapshot path. */
type WorkflowEntryRef = { id: string; dir: string; snapshotPath: string };

/** Coordination ownership discovered from validated workflow snapshots. */
type CoordinatedOwnership = { workflows: string[]; plans: Set<string> };

/**
 * The workflow entries one root status doc registers (spec §C "protection
 * discovery"). Entries are engine-written and harness-relative; a malformed
 * one refuses the replacement rather than silently dropping a protected
 * workflow from the discovered set.
 */
function registeredWorkflowEntries(harnessRoot: string, doc: unknown, statusPath: string): WorkflowEntryRef[] {
  const workflows = isPlainObject(doc) && Array.isArray(doc.workflows) ? doc.workflows : [];
  const entries: WorkflowEntryRef[] = [];
  for (const entry of workflows) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.dir)) {
      throw new CoordinationError(
        "coordination.store",
        `root ${statusPath} holds a malformed workflow entry \u2014 refusing to classify coordination ownership`,
        { path: statusPath },
      );
    }
    if (isAbsolute(entry.dir) || entry.dir.split(/[\\/]+/).includes("..")) {
      throw new CoordinationError(
        "coordination.store",
        `root ${statusPath} holds a workflow entry whose dir ${JSON.stringify(entry.dir)} is not harness-relative`,
        { path: statusPath, dir: entry.dir },
      );
    }
    entries.push({ id: entry.id, dir: entry.dir, snapshotPath: join(harnessRoot, entry.dir, "snapshot.json") });
  }
  entries.sort((left, right) =>
    canonicalizeNearestExisting(left.snapshotPath).localeCompare(canonicalizeNearestExisting(right.snapshotPath)),
  );
  return entries;
}

/**
 * Hold every entry's snapshot lock, in canonical path order, across `run`
 * (spec §C lock order: root → snapshots → destination). Holding them through
 * the destination write is what keeps the discovered protected set stable.
 */
async function withSnapshotLocks<T>(entries: readonly WorkflowEntryRef[], run: () => Promise<T>): Promise<T> {
  const next = entries[0];
  if (next === undefined) return run();
  return withStatusWriteLock(next.snapshotPath, () => withSnapshotLocks(entries.slice(1), run));
}

/**
 * Ownership of the entries whose snapshot locks are held. Reading a snapshot
 * outside that set would be the unlocked scan spec §C forbids, so it refuses.
 */
function coordinatedOwnershipOf(
  locked: readonly WorkflowEntryRef[],
  subset: readonly WorkflowEntryRef[],
): CoordinatedOwnership {
  const workflows: string[] = [];
  const plans = new Set<string>();
  // Membership is decided by canonical snapshot path, never by object
  // identity: a replacement that retains an existing workflow passes its own
  // entry object for the very file the lock was taken on (spec §C4 — the
  // guard judges the document set, not the caller's instances).
  const lockedPaths = new Set(locked.map((entry) => canonicalizeNearestExisting(entry.snapshotPath)));
  for (const entry of subset) {
    const snapshotPath = canonicalizeNearestExisting(entry.snapshotPath);
    if (!lockedPaths.has(snapshotPath)) {
      throw new CoordinationError(
        "coordination.store",
        `snapshot ${snapshotPath} was not locked before the protection discovery`,
        { path: snapshotPath },
      );
    }
    const snapshot = readSnapshot(dirname(entry.snapshotPath));
    if (snapshot.coordination === undefined) continue;
    workflows.push(entry.id);
    for (const row of snapshot.plans ?? []) {
      if (!isPlainObject(row)) continue;
      const coordination = row.coordination;
      // Every address the row answers to (`id` and/or legacy `plan_id`): a
      // prepared row reachable under either key makes that key protected.
      if (isPlainObject(coordination) && coordination.prepared !== undefined) {
        for (const planId of rowPlanIds(row)) plans.add(planId);
      }
    }
  }
  return { workflows, plans };
}

/** The workflow entries both documents name, deduplicated by canonical snapshot path. */
function lockableEntries(...groups: readonly WorkflowEntryRef[][]): WorkflowEntryRef[] {
  const byPath = new Map<string, WorkflowEntryRef>();
  for (const entry of groups.flat()) {
    const key = canonicalizeNearestExisting(entry.snapshotPath);
    if (!byPath.has(key)) byPath.set(key, entry);
  }
  return [...byPath.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, entry]) => entry);
}

/** Bucket keys (plan ids) a project register doc holds, if any. */
function registerBucketKeys(doc: unknown): string[] {
  if (!isPlainObject(doc)) return [];
  const entries = doc.entries;
  return isPlainObject(entries) ? Object.keys(entries) : [];
}

/**
 * Replace the root status.json under its own lock (spec §C2 line 156). The
 * whole-writer cutover refuses any root that registers a coordinated workflow
 * — current or proposed — because those rows belong to the scoped writers.
 */
async function replaceRootStatus(input: CoordinatedReplacement, harnessRoot: string): Promise<void> {
  const store = localStore(harnessRoot);
  const statusPath = resolveArtifactPath(harnessRoot, input.ref);
  const fromTable = resolveArtifactPath(harnessRoot, { kind: "status", key: "root" });
  if (canonicalizeNearestExisting(fromTable) !== canonicalizeNearestExisting(statusPath)) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `resolved status path ${statusPath} is not the store's ${fromTable}`,
      { expected: fromTable, actual: statusPath },
    );
  }
  if (!isPlainObject(input.payload)) throw invalidInput("a status payload must be an object");
  // The store's status slot is typed; `validateStatusV2` below is what proves
  // the payload actually carries that shape before anything is written.
  const statusDoc = input.payload as StatusV2Doc;
  const gate = validateStatusV2(statusDoc, { harnessDir: harnessRoot });
  if (!gate.ok) {
    throw invalidInput(`status payload fails validation \u2014 ${summarize(gate.violations)}`, {
      violations: gate.violations.map((entry) => entry.code),
    });
  }
  await withStatusWriteLock(statusPath, async () => {
    const current = readArtifactBytes(statusPath);
    const version = current === undefined ? "absent" : current.version;
    if (version !== input.expectedVersion) throw artifactVersionConflict(statusPath, input.expectedVersion, version);
    const currentEntries = registeredWorkflowEntries(harnessRoot, current?.payload, statusPath);
    const proposedEntries = registeredWorkflowEntries(harnessRoot, input.payload, statusPath);
    const lockedEntries = lockableEntries(currentEntries, proposedEntries);
    await withSnapshotLocks(lockedEntries, async () => {
      const currentOwnership = coordinatedOwnershipOf(lockedEntries, currentEntries);
      if (currentOwnership.workflows.length > 0) {
        throw scopedWriterRequired(
          `refusing to replace ${statusPath}: it registers coordinated workflows ${currentOwnership.workflows.join(", ")} \u2014 the scoped writers own those rows`,
          { path: statusPath, workflows: currentOwnership.workflows, side: "current" },
        );
      }
      const proposedOwnership = coordinatedOwnershipOf(lockedEntries, proposedEntries);
      if (proposedOwnership.workflows.length > 0) {
        throw scopedWriterRequired(
          `refusing to replace ${statusPath} with a root that registers coordinated workflows ${proposedOwnership.workflows.join(", ")}`,
          { path: statusPath, workflows: proposedOwnership.workflows, side: "proposed" },
        );
      }
      await withProtectedWrite(statusPath, "put", () => store.put({ kind: "status", key: "root", payload: statusDoc }));
    });
  });
}

/**
 * Replace one project register under root → snapshot → register locks (spec
 * §C2 line 156): a bucket keyed by a plan id some coordinated workflow
 * prepared is refused — current or proposed — so a legacy helper can never
 * rewrite or bump coordinated residuals.
 */
async function replaceProjectRegister(input: CoordinatedReplacement, harnessRoot: string): Promise<void> {
  const store = localStore(harnessRoot);
  const projectId = input.ref.key;
  const registerPath = resolveArtifactPath(harnessRoot, input.ref);
  const fromTable = resolveArtifactPath(harnessRoot, { kind: "residuals", key: projectId });
  if (canonicalizeNearestExisting(fromTable) !== canonicalizeNearestExisting(registerPath)) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `resolved register path ${registerPath} is not the store's ${fromTable}`,
      { expected: fromTable, actual: registerPath },
    );
  }
  if (!isPlainObject(input.payload)) throw invalidInput("a project register payload must be an object");
  const gate = validateProjectRegister(input.payload);
  if (!gate.ok) {
    throw invalidInput(`project register payload fails validation \u2014 ${summarize(gate.violations)}`, {
      violations: gate.violations.map((entry) => entry.code),
    });
  }
  const statusPath = resolveArtifactPath(harnessRoot, { kind: "status", key: "root" });
  // The project directory is created by the first write; the lock needs it first.
  mkdirSync(dirname(registerPath), { recursive: true });
  await withStatusWriteLock(statusPath, async () => {
    const rootBytes = readArtifactBytes(statusPath);
    const rootEntries = registeredWorkflowEntries(harnessRoot, rootBytes?.payload, statusPath);
    await withSnapshotLocks(rootEntries, async () => {
      const ownership = coordinatedOwnershipOf(rootEntries, rootEntries);
      await withStatusWriteLock(registerPath, async () => {
        const current = readArtifactBytes(registerPath);
        const version = current === undefined ? "absent" : current.version;
        if (version !== input.expectedVersion) throw artifactVersionConflict(registerPath, input.expectedVersion, version);
        // The protected set was discovered under root + snapshot locks that are
        // still held, so rechecking it here against the frozen set is enough.
        for (const [side, doc] of [
          ["current", current?.payload],
          ["proposed", input.payload],
        ] as const) {
          const coordinated = registerBucketKeys(doc).filter((key) => ownership.plans.has(key));
          if (coordinated.length > 0) {
            throw scopedWriterRequired(
              `refusing to replace ${registerPath}: ${side} buckets ${coordinated.join(", ")} belong to coordinated plans \u2014 use residual-add/residual-close`,
              { path: registerPath, plans: coordinated, side },
            );
          }
        }
        await withProtectedWrite(registerPath, "put", () =>
          store.put({ kind: "residuals", key: projectId, payload: input.payload }),
        );
      });
    });
  });
}

/* ------------------------------------------------------------------------ *
 * § Prepare workflow amendment (show-prepare / amend-prepare)
 * ------------------------------------------------------------------------ */

/**
 * The guarded, coordinator-authenticated Prepare-stage amendment (§ New API and
 * CLI, frozen). One approved plan row: the plan markdown that carries it plus
 * the metadata the row records. Nothing else is addressable — the verb cannot
 * edit an existing row.
 */
export type PreparePlanAppend = Readonly<{
  id: string;
  title: string;
  file: string;
  metadata: Readonly<{
    primary_spec: string;
    spec_refs: readonly string[];
    iteration_compass: string;
    iteration_refs: readonly string[];
    working_branch: string;
    spec_integration_branch: string;
    merge_target: string;
  }>;
}>;

/**
 * The whole structural delta one amendment may apply (§ Admission and mutation
 * step 5): the caller's main-worktree branch, the approved plan appends, the
 * reviewed integration checkout, and the single approved execution-policy key.
 */
export type PrepareWorkflowPatch = Readonly<{
  mainWorktreeBranch: string;
  appendPlans: readonly PreparePlanAppend[];
  integrationWorktreePath?: string;
  planParallelism?: "serial" | "parallel";
}>;

/** What a coordinator observes about one workflow before amending it. */
export type PrepareWorkflowView = Readonly<{
  workflowId: string;
  /** `sha256:<64 hex>` of the snapshot bytes (the amendment CAS token). */
  snapshotVersion: string;
  /** `sha256:<64 hex>` of the reviewed compass Markdown bytes (CAS token). */
  compassVersion: string;
  /** Plan ids in row order — including this call's own appends on success. */
  planIds: readonly string[];
  /** `true` when `amendPrepareWorkflow` is admitted with fresh tokens. */
  allowed: boolean;
  /** One `<reason>: <message>` line per admission blocker; empty when allowed. */
  blockers: readonly string[];
}>;

/** Success shape of the verb: the existing envelope with a workflow view. */
export type PrepareWorkflowResult = Omit<CoordinationResult, "view"> & { view: PrepareWorkflowView };

/** Refusal reasons of the Prepare amendment (spec § Admission and mutation). */
type PrepareAmendmentReason =
  | "stale"
  | "invalid-patch"
  | "not-prepare"
  | "execution-started"
  | "duplicate-plan"
  | "invalid-plan"
  | "compass-mismatch"
  | "invalid-worktree";

/** One `coordination.prepare-amendment.<reason>` code (`coordination-write.ts`). */
type PrepareAmendmentCode = `coordination.prepare-amendment.${PrepareAmendmentReason}`;

/** Prepare stage the amendment requires; every other phase refuses. */
const PREPARE_PHASE = "phase-1-prepare";

/**
 * Patch keys the amendment accepts. Any other key is an arbitrary-field
 * attempt, not a future-proof extension (spec § Admission and mutation step 4).
 */
const PREPARE_PATCH_KEYS: readonly string[] = [
  "mainWorktreeBranch",
  "appendPlans",
  "integrationWorktreePath",
  "planParallelism",
];

/** One plan append carries exactly these fields — no runtime row state. */
const PREPARE_APPEND_KEYS: readonly string[] = ["id", "title", "file", "metadata"];

/** Row metadata the amendment may record (spec § New API and CLI, frozen). */
const PREPARE_APPEND_METADATA_KEYS: readonly string[] = [
  "primary_spec",
  "spec_refs",
  "iteration_compass",
  "iteration_refs",
  "working_branch",
  "spec_integration_branch",
  "merge_target",
];

/** The only `plan_parallelism` values the approved concurrency contract names. */
const PLAN_PARALLELISM_VALUES: readonly string[] = ["serial", "parallel"];

function prepareAmendmentRefusal(
  reason: PrepareAmendmentReason,
  message: string,
  details: Record<string, unknown> = {},
): CoordinationError {
  const code: PrepareAmendmentCode = `coordination.prepare-amendment.${reason}`;
  return new CoordinationError(code, message, details);
}

/** The addressed workflow of one workflow-level verb. */
type PrepareWorkflowScope = {
  session: CoordinationSession;
  /** Canonical envelope path (the result's `session_file`). */
  sessionPath: string;
  harnessRoot: string;
  workflowId: string;
  snapshotPath: string;
};

/**
 * Resolve the workflow one coordinator envelope addresses (§ Admission and
 * mutation step 1). The envelope's own `harness_root` and `workflow_id` are
 * the only address: no caller-supplied root or workflow id retargets it. The
 * active store must be that root and the process root must agree, so a linked
 * checkout's own artifacts can never be read as the control root. Every
 * refusal here is an existing auth/scope error, never a new one.
 */
function prepareWorkflowScope(sessionPath: string, cwd: string): PrepareWorkflowScope {
  const session = readSessionEnvelope(sessionPath);
  if (session.role !== "coordinator") {
    throw new CoordinationError(
      "coordination.session-role",
      `workflow Prepare verbs require a coordinator session, not ${session.role}`,
      { actual: session.role },
    );
  }
  const harnessRoot = canonicalizeNearestExisting(session.harness_root);
  localStore(harnessRoot);
  const processRoot = resolveProcessHarnessDir(cwd);
  if (processRoot !== null && canonicalTarget(processRoot) !== harnessRoot) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `session ${session.session_id} belongs to harness root ${harnessRoot}, but this process resolves ${canonicalTarget(processRoot)}`,
      { expected: harnessRoot, actual: canonicalTarget(processRoot) },
    );
  }
  const workflowId = safePlanId(session.workflow_id, "workflow_id");
  const snapshotPath = assertSnapshotPath(harnessRoot, workflowId, snapshotPathOf(harnessRoot, workflowId));
  return { session, sessionPath: canonicalTarget(sessionPath), harnessRoot, workflowId, snapshotPath };
}

/**
 * The stored snapshot plus the byte version of the file it came from. The
 * version is the CAS token of the exact bytes on disk; the payload comes from
 * the canonical reader (strict validation, one in-memory legacy-alias
 * normalization). Both reads happen inside one locked section for a writer —
 * the snapshot lock, not an editor or power-loss transaction, is this
 * verb's boundary (spec § Admission and mutation step 7).
 */
function readPrepareSnapshot(snapshotPath: string): { snapshot: WorkflowSnapshot; version: string } {
  const bytes = readArtifactBytes(snapshotPath);
  if (bytes === undefined) {
    throw new CoordinationError("coordination.workflow-not-found", `workflow snapshot not found: ${snapshotPath}`, {
      path: snapshotPath,
    });
  }
  return { snapshot: readSnapshot(dirname(snapshotPath)), version: bytes.version };
}

/** The reviewed compass of a workflow plus the declarations it binds. */
type PrepareCompass = {
  /** Canonical compass path (`snapshot.compass_ref` resolved). */
  path: string;
  /** `sha256:<64 hex>` of the Markdown bytes — the compass CAS token. */
  version: string;
  /** `plans:` frontmatter ids, validated as declared (non-empty, unique). */
  planIds: readonly string[];
  specIntegrationBranch?: string;
  integrationWorktreePath?: string;
};

/**
 * One optional compass declaration (`spec_integration_branch`,
 * `integration_worktree_path`) of an amendment-reviewed compass. Absence
 * leaves the declaration unset — there is then nothing to compare — while a
 * key that is present without a usable value (a YAML list, a number, an empty
 * value) refuses: the declaration feeds an agreement check, so a malformed
 * value must never read as no declaration at all.
 */
function prepareCompassDeclaration(
  frontmatter: Record<string, unknown>,
  key: string,
  workflowId: string,
  path: string,
): string | undefined {
  const value = frontmatter[key];
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${workflowId} compass ${path} declares a malformed ${key} \u2014 every declaration must be a non-empty string`,
      { workflow_id: workflowId, path, field: key, actual: value },
    );
  }
  return value;
}

/**
 * Read the workflow's own reviewed compass (`snapshot.compass_ref`) and the
 * declarations an amendment must agree with (§ Admission and mutation step 6).
 * The token is the raw-byte SHA-256 of the Markdown (`sha256Bytes`), rendered
 * in the same `sha256:<hex>` form as the snapshot version. A missing, escaping,
 * unreadable or unparsable compass refuses, and so does one that does not
 * declares its own `iteration_id` or whose `plans` list is malformed (an entry
 * that is not a non-empty string) or repeats an id, or whose
 * `spec_integration_branch` / `integration_worktree_path` is present but not a
 * non-empty string: the reviewed declaration is read exactly as written —
 * never filtered, deduplicated or borrowed from another lifecycle — because an
 * unverifiable declaration cannot approve a structural delta.
 */
function readPrepareCompass(harnessRoot: string, snapshot: WorkflowSnapshot): PrepareCompass {
  const ref = snapshot.compass_ref;
  if (!isNonEmptyString(ref) || isAbsolute(ref)) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} declares no usable compass_ref \u2014 the amendment requires the reviewed iteration compass`,
      { workflow_id: snapshot.id, actual: ref ?? null },
    );
  }
  const root = canonicalizeNearestExisting(harnessRoot);
  const path = canonicalTarget(join(harnessRoot, ref));
  if (!isWithin(root, path)) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass_ref ${JSON.stringify(ref)} resolves outside the harness root ${root}`,
      { workflow_id: snapshot.id, path, expected: ref },
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} is unreadable: ${errorMessage(error)}`,
      { workflow_id: snapshot.id, path },
    );
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseCompassFrontmatterText(bytes.toString("utf8"), path);
  } catch (error) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} has no parsable frontmatter: ${errorMessage(error)}`,
      { workflow_id: snapshot.id, path },
    );
  }
  // The declaration is read exactly as written. A missing lifecycle identity
  // cannot bind the compass to this workflow, and a malformed or repeated plan
  // entry means the reviewed list is not the exact set it appears to be — none
  // of that is repaired by filtering or deduplicating before the comparison.
  const iterationId = frontmatter.iteration_id;
  if (!isNonEmptyString(iterationId)) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} declares no iteration_id \u2014 a lifecycle amends only its own compass`,
      { workflow_id: snapshot.id, path, actual: iterationId ?? null },
    );
  }
  if (iterationId !== snapshot.id) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `compass ${path} declares iteration_id ${iterationId}, not workflow ${snapshot.id} \u2014 a lifecycle amends only its own compass`,
      { workflow_id: snapshot.id, expected: snapshot.id, actual: iterationId },
    );
  }
  const declaredPlans: unknown = frontmatter.plans;
  if (!Array.isArray(declaredPlans) || declaredPlans.length === 0) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} declares no plan ids in its frontmatter \u2014 the amendment cannot verify the approved plan set`,
      { workflow_id: snapshot.id, path, actual: declaredPlans ?? null },
    );
  }
  const malformed = declaredPlans.filter((entry) => !isNonEmptyString(entry));
  if (malformed.length > 0) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} declares ${malformed.length} malformed plan id(s) \u2014 every plans entry must be a non-empty string`,
      { workflow_id: snapshot.id, path, plans: declaredPlans },
    );
  }
  const planIds = declaredPlans as readonly string[];
  if (new Set(planIds).size !== planIds.length) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} declares the same plan id more than once \u2014 the reviewed plan set is not a multiset`,
      { workflow_id: snapshot.id, path, plans: planIds },
    );
  }
  // A declaration that is present is read exactly as written: a value that is
  // not a usable string refuses here rather than vanishing, so the agreement
  // checks further down can never be skipped by a malformed key.
  const specIntegrationBranch = prepareCompassDeclaration(frontmatter, "spec_integration_branch", snapshot.id, path);
  const integrationWorktreePath = prepareCompassDeclaration(frontmatter, "integration_worktree_path", snapshot.id, path);
  return {
    path,
    version: `sha256:${sha256Bytes(bytes)}`,
    planIds,
    ...(specIntegrationBranch !== undefined ? { specIntegrationBranch } : {}),
    ...(integrationWorktreePath !== undefined ? { integrationWorktreePath } : {}),
  };
}

/** Admitted, or the reason an amendment must not run. */
type PrepareAdmission =
  | { ok: true }
  | { ok: false; reason: PrepareAmendmentReason; message: string; details: Record<string, unknown> };

/**
 * The Prepare/no-execution admission (§ Admission and mutation step 3): the
 * lifecycle is running in `phase-1-prepare`, its root register entry is still
 * an active one, and NO execution ownership exists anywhere in the document —
 * no row lease, no row coordination block (preparation, session binding,
 * progress/QC evidence, handoff and reconcile state all live there), no row
 * that left `Todo`/progress 0, and no workflow-level merge lease. A row that
 * carries evidence refuses here; resetting it to Todo would erase nothing and
 * is exactly what this verb must not do.
 */
function prepareAdmission(harnessRoot: string, workflowId: string, snapshot: WorkflowSnapshot): PrepareAdmission {
  const entry = assertRootRegisterEntry(harnessRoot, workflowId);
  if (isNonEmptyString(entry.status) && entry.status !== "running") {
    return {
      ok: false,
      reason: "not-prepare",
      message: `root register entry ${workflowId} is ${entry.status} \u2014 the amendment is available only while the lifecycle runs`,
      details: { workflow_id: workflowId, status: entry.status },
    };
  }
  if (snapshot.status !== "running") {
    return {
      ok: false,
      reason: "not-prepare",
      message: `workflow ${workflowId} is ${snapshot.status} \u2014 the amendment is available only in Prepare`,
      details: { workflow_id: workflowId, status: snapshot.status },
    };
  }
  if (snapshot.phase !== PREPARE_PHASE) {
    return {
      ok: false,
      reason: "not-prepare",
      message: `workflow ${workflowId} is in ${snapshot.phase ?? "no declared phase"}, not ${PREPARE_PHASE}`,
      details: { workflow_id: workflowId, expected: PREPARE_PHASE, actual: snapshot.phase ?? null },
    };
  }
  if (snapshot.integration_merge_lease !== undefined) {
    return {
      ok: false,
      reason: "execution-started",
      message: `workflow ${workflowId} carries an integration merge lease \u2014 execution ownership already exists`,
      details: { workflow_id: workflowId },
    };
  }
  for (const row of snapshot.plans) {
    const planId = rowPlanIds(row)[0] ?? "";
    const status = rowStatusOf(row);
    if (status !== "Todo") {
      return {
        ok: false,
        reason: "execution-started",
        message: `plan ${planId} is ${status} \u2014 the amendment is available only while every row is Todo`,
        details: { workflow_id: workflowId, plan_id: planId, actual: status },
      };
    }
    if (row.progress !== undefined && row.progress !== 0) {
      return {
        ok: false,
        reason: "execution-started",
        message: `plan ${planId} reports progress ${JSON.stringify(row.progress)} \u2014 the amendment must not rewrite executed work`,
        details: { workflow_id: workflowId, plan_id: planId, actual: row.progress },
      };
    }
    if (row.execution_lease !== undefined) {
      return {
        ok: false,
        reason: "execution-started",
        message: `plan ${planId} carries an execution lease \u2014 the plan has an owner and is no longer in Prepare`,
        details: { workflow_id: workflowId, plan_id: planId, holder: isPlainObject(row.execution_lease) ? row.execution_lease.holder : null },
      };
    }
    if (row.coordination !== undefined) {
      return {
        ok: false,
        reason: "execution-started",
        message: `plan ${planId} carries a coordination block \u2014 preparation or execution evidence already exists for this row`,
        details: { workflow_id: workflowId, plan_id: planId, revision: rowCoordinationOf(row)?.revision ?? null },
      };
    }
  }
  return { ok: true };
}

/**
 * The plan-markdown labels the amendment actually consults. Every other
 * `Label: value` line is plan-body content, and a real multi-task plan repeats
 * those per task (`**Files:**`, `**Interfaces:**`, `**Task budget:**`) with a
 * different value each time — so a repeated label outside this set is not a
 * declaration conflict.
 */
const PLAN_CONSULTED_HEADERS: Record<string, true> = {
  plan_id: true,
  "main worktree branch": true,
  "working branch": true,
};

/**
 * The consulted headers one plan markdown declares, keyed by lowercased label —
 * the idiom `parseAssignmentFile` uses for Assignment headers, widened to the
 * forms real plan documents actually use: the colon inside the bold
 * (`**plan_id:** value`, the dominant form in `{PLAN_DIR}`) and the colon
 * after it (`**Main worktree branch**: value`). A plain `Label: value` line is
 * accepted too. Fenced code is skipped so a quoted example is never read as a
 * declaration, and a consulted label twice with different values refuses
 * instead of silently picking one.
 */
function planHeadersOf(planPath: string, planId: string): Map<string, string> {
  const headers = new Map<string, string>();
  // The fence is tracked by its marker character and run length: it is closed
  // only by a run of the same character at least as long, so a `~~~` example is
  // never read as a declaration and a shorter backtick run inside a longer
  // fence cannot close it early.
  let marker: string | undefined;
  let markerLength = 0;
  for (const raw of readFileSync(planPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const run = fence[1]!;
      if (marker === undefined) {
        marker = run.charAt(0);
        markerLength = run.length;
      } else if (run.charAt(0) === marker && run.length >= markerLength) {
        marker = undefined;
      }
      continue;
    }
    if (marker !== undefined) continue;
    // `**Label:** value` / `**Label**: value` / `Label: value`: the label may
    // not contain `:` or `*` (those are the markup), and the value starts at
    // the first non-space character after the closing markup and colon.
    const match = /^\*{0,2}([^:*]+?)\*{0,2}:\*{0,2}\s*(\S.*)$/.exec(line);
    if (match === null) continue;
    const label = match[1]!.trim();
    const key = label.toLowerCase();
    if (PLAN_CONSULTED_HEADERS[key] !== true) continue;
    const value = match[2]!.trim();
    const prior = headers.get(key);
    if (prior !== undefined && prior !== value) {
      throw prepareAmendmentRefusal(
        "invalid-plan",
        `plan ${planId} markdown declares conflicting "${label}" headers (${prior} vs ${value})`,
        { plan_id: planId, header: label },
      );
    }
    headers.set(key, value);
  }
  return headers;
}

/**
 * One plan metadata reference: absolute, inside the harness root (canonical,
 * so a symlink out of it is an escape), and an existing file. `iteration_compass`
 * is additionally required to BE this workflow's compass — the caller checks
 * that, because only it knows the resolved compass path.
 */
function prepareReferencePath(harnessRoot: string, value: unknown, field: string, planId: string): string {
  if (!isNonEmptyString(value) || !isAbsolute(value)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${planId} ${field} must be an absolute path \u2014 got ${JSON.stringify(value ?? null)}`,
      { plan_id: planId, field, actual: value ?? null },
    );
  }
  const canonical = canonicalTarget(value);
  if (!isWithin(canonicalizeNearestExisting(harnessRoot), canonical)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${planId} ${field} ${canonical} escapes the harness root ${harnessRoot}`,
      { plan_id: planId, field, path: canonical, expected: harnessRoot },
    );
  }
  if (!existsSync(canonical) || !statSync(canonical).isFile()) {
    throw prepareAmendmentRefusal("invalid-plan", `plan ${planId} ${field} does not exist: ${canonical}`, {
      plan_id: planId,
      field,
      path: canonical,
    });
  }
  return canonical;
}

/** A list-valued metadata reference; every entry obeys the single-path rule. */
function prepareReferenceList(harnessRoot: string, value: unknown, field: string, planId: string): string[] {
  if (!Array.isArray(value)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${planId} ${field} must be an array of absolute paths \u2014 got ${JSON.stringify(value ?? null)}`,
      { plan_id: planId, field, actual: value ?? null },
    );
  }
  return value.map((entry, index) => prepareReferencePath(harnessRoot, entry, `${field}[${index}]`, planId));
}

/** One required non-empty string metadata value. */
function prepareMetadataString(metadata: Record<string, unknown>, key: string, planId: string): string {
  const value = metadata[key];
  if (!isNonEmptyString(value)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${planId} metadata.${key} must be a non-empty string \u2014 got ${JSON.stringify(value ?? null)}`,
      { plan_id: planId, field: `metadata.${key}`, actual: value ?? null },
    );
  }
  return value;
}

/**
 * One appended plan, validated against its own plan markdown, the workflow's
 * recorded anchors and the reviewed compass (§ Admission and mutation steps 4
 * and 6). The row is constructed here — Todo, progress 0, the project-manager
 * owner, a creation timestamp — so no runtime field can travel through the
 * patch.
 */
function readPlanAppend(
  value: unknown,
  context: { harnessRoot: string; snapshot: WorkflowSnapshot; compass: PrepareCompass; mainWorktreeBranch: string },
): PlanRow {
  if (!isPlainObject(value)) {
    throw prepareAmendmentRefusal("invalid-plan", "every appendPlans entry must be an object", { actual: value ?? null });
  }
  const unexpected = Object.keys(value).filter((key) => !PREPARE_APPEND_KEYS.includes(key));
  if (unexpected.length > 0) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `a plan append accepts only ${PREPARE_APPEND_KEYS.join(", ")} \u2014 unexpected key(s): ${unexpected.join(", ")}`,
      { allowed: [...PREPARE_APPEND_KEYS], unexpected },
    );
  }
  const id = value.id;
  if (!isNonEmptyString(id)) {
    throw prepareAmendmentRefusal("invalid-plan", `a plan append requires a non-empty id \u2014 got ${JSON.stringify(id ?? null)}`, {
      actual: id ?? null,
    });
  }
  try {
    assertSafePathComponent(id, "plan id");
  } catch (error) {
    throw prepareAmendmentRefusal("invalid-plan", `plan id ${JSON.stringify(id)} is not a safe path component: ${errorMessage(error)}`, {
      plan_id: id,
    });
  }
  const title = value.title;
  if (!isNonEmptyString(title)) {
    throw prepareAmendmentRefusal("invalid-plan", `plan ${id} requires a non-empty title`, { plan_id: id, actual: title ?? null });
  }
  const declaredFile = value.file;
  if (!isNonEmptyString(declaredFile) || !isAbsolute(declaredFile)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} file must be the absolute plan path \u2014 got ${JSON.stringify(declaredFile ?? null)}`,
      { plan_id: id, actual: declaredFile ?? null },
    );
  }
  // The PlanRow `file` convention, resolved by the plan resolver: the row's own
  // plan file is `{PLAN_DIR}/<plan-id>.md`. This is the only path field — the
  // patch introduces no second absolute-path key (spec § Admission step 4).
  const planPath = canonicalTarget(declaredFile);
  const planDir = canonicalizeNearestExisting(resolvePlanDir(context.harnessRoot));
  if (dirname(planPath) !== planDir || basename(planPath) !== `${id}.md`) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} file ${planPath} is not ${join(planDir, `${id}.md`)}`,
      { plan_id: id, expected: join(planDir, `${id}.md`), actual: planPath },
    );
  }
  if (!existsSync(planPath) || !statSync(planPath).isFile()) {
    throw prepareAmendmentRefusal("invalid-plan", `plan ${id} markdown not found: ${planPath}`, { plan_id: id, path: planPath });
  }
  const headers = planHeadersOf(planPath, id);
  const declaredPlanId = headers.get("plan_id");
  if (declaredPlanId === undefined) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} markdown ${planPath} declares no plan_id header \u2014 the row cannot be traced to its reviewed plan`,
      { plan_id: id, path: planPath },
    );
  }
  if (declaredPlanId !== id) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan append id ${id} does not match the plan markdown header plan_id ${declaredPlanId} (${planPath})`,
      { plan_id: id, expected: id, actual: declaredPlanId, path: planPath },
    );
  }

  const metadata = value.metadata;
  if (!isPlainObject(metadata)) {
    throw prepareAmendmentRefusal("invalid-plan", `plan ${id} metadata must be an object`, { plan_id: id, actual: metadata ?? null });
  }
  const unexpectedMetadata = Object.keys(metadata).filter((key) => !PREPARE_APPEND_METADATA_KEYS.includes(key));
  if (unexpectedMetadata.length > 0) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} metadata accepts only ${PREPARE_APPEND_METADATA_KEYS.join(", ")} \u2014 unexpected key(s): ${unexpectedMetadata.join(", ")}`,
      { plan_id: id, allowed: [...PREPARE_APPEND_METADATA_KEYS], unexpected: unexpectedMetadata },
    );
  }
  const primarySpec = prepareReferencePath(context.harnessRoot, metadata.primary_spec, "metadata.primary_spec", id);
  const specRefs = prepareReferenceList(context.harnessRoot, metadata.spec_refs, "metadata.spec_refs", id);
  const iterationCompass = prepareReferencePath(context.harnessRoot, metadata.iteration_compass, "metadata.iteration_compass", id);
  if (iterationCompass !== context.compass.path) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `plan ${id} metadata.iteration_compass ${iterationCompass} is not this workflow's reviewed compass ${context.compass.path}`,
      { plan_id: id, expected: context.compass.path, actual: iterationCompass },
    );
  }
  const iterationRefs = prepareReferenceList(context.harnessRoot, metadata.iteration_refs, "metadata.iteration_refs", id);
  const workingBranch = prepareMetadataString(metadata, "working_branch", id);
  const specIntegrationBranch = prepareMetadataString(metadata, "spec_integration_branch", id);
  const mergeTarget = prepareMetadataString(metadata, "merge_target", id);

  // Branch metadata must match the reviewed plan and the lifecycle it joins: a
  // row never claims the main, integration or target branch as its own work.
  const anchors: WorkflowBranchAnchors = context.snapshot.branch ?? {};
  for (const [label, branch] of [
    ["branch.base", anchors.base],
    ["branch.integration", anchors.integration],
    ["branch.target", anchors.target],
  ] as const) {
    if (isNonEmptyString(branch) && branch === workingBranch) {
      throw prepareAmendmentRefusal(
        "invalid-plan",
        `plan ${id} metadata.working_branch ${workingBranch} is the workflow's ${label} \u2014 a plan row owns its own feature branch`,
        { plan_id: id, field: "metadata.working_branch", actual: workingBranch },
      );
    }
  }
  // The plan document is the reviewed authority for the branch metadata: both
  // headers are required, and an absent one is never treated as agreement with
  // the branches the append itself claims.
  const declaredWorking = headers.get("working branch");
  if (declaredWorking === undefined) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} markdown ${planPath} declares no Working branch header \u2014 the appended row's branch metadata cannot be verified against the reviewed plan`,
      { plan_id: id, field: "metadata.working_branch", path: planPath },
    );
  }
  if (declaredWorking !== workingBranch) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} metadata.working_branch ${workingBranch} does not match the Working branch declared by ${planPath} (${declaredWorking})`,
      { plan_id: id, expected: declaredWorking, actual: workingBranch, path: planPath },
    );
  }
  const declaredMain = headers.get("main worktree branch");
  if (declaredMain === undefined) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} markdown ${planPath} declares no Main worktree branch header \u2014 the amendment cannot verify the branch the reviewed plan was written against`,
      { plan_id: id, field: "mainWorktreeBranch", path: planPath },
    );
  }
  if (declaredMain !== context.mainWorktreeBranch) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} metadata records main worktree branch ${context.mainWorktreeBranch}, but ${planPath} declares ${declaredMain}`,
      { plan_id: id, expected: declaredMain, actual: context.mainWorktreeBranch, path: planPath },
    );
  }
  if (isNonEmptyString(anchors.integration)) {
    for (const [field, recorded] of [
      ["metadata.spec_integration_branch", specIntegrationBranch],
      ["metadata.merge_target", mergeTarget],
    ] as const) {
      if (recorded !== anchors.integration) {
        throw prepareAmendmentRefusal(
          "invalid-plan",
          `plan ${id} ${field} ${recorded} is not the workflow's integration branch ${anchors.integration}`,
          { plan_id: id, expected: anchors.integration, actual: recorded },
        );
      }
    }
  }
  if (context.compass.specIntegrationBranch !== undefined && specIntegrationBranch !== context.compass.specIntegrationBranch) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `plan ${id} metadata.spec_integration_branch ${specIntegrationBranch} is not the reviewed compass integration branch ${context.compass.specIntegrationBranch}`,
      { plan_id: id, expected: context.compass.specIntegrationBranch, actual: specIntegrationBranch },
    );
  }

  const row: PlanRow = {
    id,
    title,
    file: planPath,
    status: "Todo",
    owner: "project-manager",
    progress: 0,
    created_at: nowIso(),
    metadata: {
      primary_spec: primarySpec,
      spec_refs: specRefs,
      iteration_compass: iterationCompass,
      iteration_refs: iterationRefs,
      working_branch: workingBranch,
      spec_integration_branch: specIntegrationBranch,
      merge_target: mergeTarget,
    },
  };
  const gate = validatePlanRow(row);
  if (!gate.ok) {
    throw prepareAmendmentRefusal("invalid-plan", `constructed row ${id} fails plan-row validation \u2014 ${summarize(gate.violations)}`, {
      plan_id: id,
      violations: gate.violations.map((entry) => entry.code),
    });
  }
  return row;
}

/**
 * The recorded integration checkout (§ Admission and mutation step 5): real and
 * canonical, a distinct Git checkout of the repository that owns the validated
 * control harness root, and actually on the workflow's recorded
 * `branch.integration`. Nothing is created, switched, fetched or cleaned — a
 * wrong or aliased checkout refuses instead.
 */
function readIntegrationWorktreePath(
  value: unknown,
  context: { harnessRoot: string; snapshot: WorkflowSnapshot; main: MainWorktreeInfo },
): string {
  const refuse = (message: string, details: Record<string, unknown> = {}): never => {
    throw prepareAmendmentRefusal("invalid-worktree", message, details);
  };
  if (!isNonEmptyString(value) || !isAbsolute(value)) {
    return refuse(`integrationWorktreePath must be an absolute path \u2014 got ${JSON.stringify(value ?? null)}`, {
      actual: value ?? null,
    });
  }
  const path = canonicalTarget(value);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return refuse(`integration checkout ${path} does not exist`, { path, expected: value });
  }
  const mainRoot = canonicalTarget(context.main.root);
  const control = canonicalizeNearestExisting(context.harnessRoot);
  // The repository that owns the validated control harness root is the only
  // anchor this proof may use. A coordinator envelope can be presented from a
  // different clone of the same project, whose own repository — and whose own
  // checkouts — are not this lifecycle's; anchoring on the repository enclosing
  // the caller's cwd alone would record that clone's checkout. So the caller's
  // enclosing repository must be the control root's repository, and so must the
  // candidate.
  const controlRepo = readMainWorktree(control);
  if (controlRepo === null) {
    return refuse(
      `the control harness root ${control} has no readable Git main worktree \u2014 the integration checkout cannot be proven to be a checkout of this repository`,
      { path, harness_root: control },
    );
  }
  const controlMainRoot = canonicalTarget(controlRepo.root);
  if (controlMainRoot !== mainRoot) {
    return refuse(
      `this call runs from the main worktree of ${mainRoot}, not the repository owning the control harness root ${control} (${controlMainRoot}) \u2014 the recorded checkout must belong to that repository`,
      { path, expected: controlMainRoot, actual: mainRoot },
    );
  }
  if (path === mainRoot || path === control) {
    return refuse(`integration checkout ${path} is the main/control checkout \u2014 a dedicated integration worktree is required`, {
      path,
      expected: `a checkout distinct from ${mainRoot}`,
    });
  }
  const repo = readMainWorktree(path);
  if (repo === null || canonicalTarget(repo.root) !== controlMainRoot) {
    return refuse(
      `integration checkout ${path} is not a checkout of the repository owning the control harness root ${control} (${controlMainRoot})`,
      {
        path,
        expected: controlMainRoot,
        actual: repo === null ? null : canonicalTarget(repo.root),
      },
    );
  }
  if (!isDistinctCheckout(context.main.root, path)) {
    return refuse(`integration checkout ${path} is not a distinct checkout (same Git checkout as ${mainRoot})`, {
      path,
      expected: `a checkout distinct from ${mainRoot}`,
    });
  }
  const integrationBranch = context.snapshot.branch?.integration;
  if (!isNonEmptyString(integrationBranch)) {
    return refuse(
      `workflow ${context.snapshot.id} records no branch.integration \u2014 the integration checkout cannot be verified`,
      { workflow_id: context.snapshot.id, path },
    );
  }
  const branch = gitRead(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== integrationBranch) {
    return refuse(
      `integration checkout ${path} is on ${branch === undefined ? "an unreadable checkout" : branch || "a detached HEAD"}, not the recorded ${integrationBranch}`,
      { path, expected: integrationBranch, actual: branch ?? null },
    );
  }
  return path;
}

/** The validated delta of one amendment. */
type PrepareProposal = {
  rows: PlanRow[];
  integrationWorktreePath?: string;
  planParallelism?: string;
};

/** Set-equality over plan ids (declaration order is never a requirement). */
function samePlanIdSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  for (const id of leftSet) if (!rightSet.has(id)) return false;
  return true;
}

/**
 * The patch, validated against the workflow, the plan files and the reviewed
 * compass (§ Admission and mutation steps 4–6): unknown keys, duplicate or
 * colliding ids, malformed metadata, escaping or missing references,
 * mismatched plan headers, a patch that changes nothing, a plan set the
 * compass does not declare, and an integration branch or checkout the
 * workflow does not own all refuse here — before anything is written.
 */
function readPreparePatch(
  patch: unknown,
  context: { harnessRoot: string; snapshot: WorkflowSnapshot; compass: PrepareCompass; main: MainWorktreeInfo },
): PrepareProposal {
  if (!isPlainObject(patch)) {
    throw prepareAmendmentRefusal("invalid-patch", "the amendment patch must be an object", { actual: patch ?? null });
  }
  const unexpected = Object.keys(patch).filter((key) => !PREPARE_PATCH_KEYS.includes(key));
  if (unexpected.length > 0) {
    throw prepareAmendmentRefusal(
      "invalid-patch",
      `the amendment patch accepts only ${PREPARE_PATCH_KEYS.join(", ")} \u2014 unexpected key(s): ${unexpected.join(", ")}`,
      { allowed: [...PREPARE_PATCH_KEYS], unexpected },
    );
  }
  const mainWorktreeBranch = patch.mainWorktreeBranch;
  if (!isNonEmptyString(mainWorktreeBranch)) {
    throw prepareAmendmentRefusal(
      "invalid-patch",
      `the amendment patch requires mainWorktreeBranch as a non-empty string \u2014 got ${JSON.stringify(mainWorktreeBranch ?? null)}`,
      { actual: mainWorktreeBranch ?? null },
    );
  }
  // The caller's checkout identity: the Git-derived main worktree must be on
  // the branch this patch declares. `branch.base` is a recorded anchor, not
  // residency, so it is never the expectation here.
  if (context.main.branch !== mainWorktreeBranch) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `the main worktree ${context.main.root} is on ${context.main.branch === "" ? "a detached HEAD" : context.main.branch}, but this amendment declares ${mainWorktreeBranch}`,
      { expected: mainWorktreeBranch, actual: context.main.branch },
    );
  }
  const rawAppends = patch.appendPlans;
  if (!Array.isArray(rawAppends)) {
    throw prepareAmendmentRefusal("invalid-patch", "the amendment patch requires appendPlans as an array", {
      actual: rawAppends ?? null,
    });
  }
  const requestedParallelism = patch.planParallelism;
  if (
    requestedParallelism !== undefined &&
    !(isNonEmptyString(requestedParallelism) && PLAN_PARALLELISM_VALUES.includes(requestedParallelism))
  ) {
    throw prepareAmendmentRefusal(
      "invalid-patch",
      `planParallelism must be one of ${PLAN_PARALLELISM_VALUES.join(" | ")} \u2014 got ${JSON.stringify(requestedParallelism ?? null)}`,
      { allowed: [...PLAN_PARALLELISM_VALUES], actual: requestedParallelism ?? null },
    );
  }
  const planParallelism: string | undefined = isNonEmptyString(requestedParallelism) ? requestedParallelism : undefined;

  // Duplicate ids are refused as their own reason: an id already registered in
  // the workflow (old rows are preserved by value, never replaced) or the same
  // id twice in one patch.
  const existingIds = new Set(context.snapshot.plans.flatMap((row) => rowPlanIds(row)));
  const declaredIds = new Set<string>();
  for (const entry of rawAppends) {
    const id = isPlainObject(entry) ? entry.id : undefined;
    if (!isNonEmptyString(id)) continue; // the entry's own shape refuses below
    if (existingIds.has(id)) {
      throw prepareAmendmentRefusal(
        "duplicate-plan",
        `plan ${id} is already a row of workflow ${context.snapshot.id} \u2014 the amendment appends new rows and never replaces existing ones`,
        { plan_id: id, workflow_id: context.snapshot.id },
      );
    }
    if (declaredIds.has(id)) {
      throw prepareAmendmentRefusal("duplicate-plan", `plan ${id} appears twice in one patch`, { plan_id: id });
    }
    declaredIds.add(id);
  }

  const rows = rawAppends.map((entry) =>
    readPlanAppend(entry, {
      harnessRoot: context.harnessRoot,
      snapshot: context.snapshot,
      compass: context.compass,
      mainWorktreeBranch,
    }),
  );
  const integrationWorktreePath =
    patch.integrationWorktreePath === undefined
      ? undefined
      : readIntegrationWorktreePath(patch.integrationWorktreePath, context);

  const recordedPath = isNonEmptyString(context.snapshot.integration_worktree_path)
    ? canonicalTarget(context.snapshot.integration_worktree_path)
    : undefined;
  const recordedParallelism = isPlainObject(context.snapshot.execution_policy)
    ? context.snapshot.execution_policy.plan_parallelism
    : undefined;
  const changesPath = integrationWorktreePath !== undefined && integrationWorktreePath !== recordedPath;
  const changesPolicy = planParallelism !== undefined && planParallelism !== recordedParallelism;
  if (rows.length === 0 && !changesPath && !changesPolicy) {
    throw prepareAmendmentRefusal(
      "invalid-patch",
      `the patch changes nothing on workflow ${context.snapshot.id} \u2014 it appends no plan, records no new integration checkout and no different plan parallelism`,
      { workflow_id: context.snapshot.id },
    );
  }
  // The reviewed declaration binds the workflow's own recorded integration
  // branch too, and no amendment edits that anchor — so the comparison belongs
  // here, where every patch is validated, and not only on the per-append path:
  // an amendment that appends nothing (a policy or checkout recording) must
  // refuse a workflow whose recorded branch contradicts the reviewed compass
  // just the same (spec § Admission and mutation step 6).
  if (context.compass.specIntegrationBranch !== undefined) {
    const recordedBranch = context.snapshot.branch?.integration;
    if (!isNonEmptyString(recordedBranch) || recordedBranch !== context.compass.specIntegrationBranch) {
      throw prepareAmendmentRefusal(
        "compass-mismatch",
        `workflow ${context.snapshot.id} records integration branch ${JSON.stringify(recordedBranch ?? null)}, but the reviewed compass ${context.compass.path} declares ${context.compass.specIntegrationBranch}`,
        { expected: context.compass.specIntegrationBranch, actual: recordedBranch ?? null },
      );
    }
  }
  // The reviewed declaration binds the checkout this commit would leave in
  // place — the patch's own validated path when it names one, otherwise the
  // recorded path the spread preserves. Comparing the *effective* path is what
  // makes both a retained conflict (patch omits the field) and a still
  // unrecorded declaration refuse, while an explicit correction that names the
  // reviewed checkout in the same call stays lawful (spec § Admission and
  // mutation step 6).
  if (context.compass.integrationWorktreePath !== undefined) {
    const declaredPath = canonicalTarget(context.compass.integrationWorktreePath);
    const effectivePath = integrationWorktreePath ?? recordedPath;
    if (effectivePath !== declaredPath) {
      throw prepareAmendmentRefusal(
        "compass-mismatch",
        `workflow ${context.snapshot.id} would record integration checkout ${effectivePath ?? "(none)"}, but the reviewed compass ${context.compass.path} declares ${declaredPath}`,
        { path: effectivePath ?? null, expected: declaredPath, actual: effectivePath ?? null },
      );
    }
  }

  // The resulting workflow must declare exactly the plan set the reviewed
  // compass declares: not one undeclared row, and none of the compass's plans
  // left unregistered (spec § Admission and mutation step 6).
  const proposedIds = [
    ...context.snapshot.plans.flatMap((row) => rowPlanIds(row)),
    ...rows.map((row) => rowPlanIds(row)[0] ?? ""),
  ];
  if (!samePlanIdSet(context.compass.planIds, proposedIds)) {
    const missing = context.compass.planIds.filter((id) => !proposedIds.includes(id));
    const undeclared = proposedIds.filter((id) => !context.compass.planIds.includes(id));
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `the amended workflow's plan ids must match the reviewed compass ${context.compass.path} exactly \u2014 missing: ${missing.join(", ") || "(none)"}; not declared by the compass: ${undeclared.join(", ") || "(none)"}`,
      { expected: [...context.compass.planIds], actual: proposedIds, missing, undeclared },
    );
  }
  return {
    rows,
    ...(integrationWorktreePath !== undefined ? { integrationWorktreePath } : {}),
    ...(planParallelism !== undefined ? { planParallelism } : {}),
  };
}

/** The raw-byte version token one amendment call must present. */
function prepareVersionToken(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw invalidInput(`prepare amendment ${field} is required \u2014 read it from \`show-prepare\``, { field });
  }
  const bare = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw invalidInput(
      `prepare amendment ${field} must be a raw-byte sha256 version ("sha256:<64 hex>" or "<64 hex>") \u2014 got ${JSON.stringify(value)}`,
      { field },
    );
  }
  return value;
}

/** Digest of a token that may carry the `sha256:` prefix (compare-only). */
function prepareVersionDigest(token: string): string {
  return token.startsWith("sha256:") ? token.slice("sha256:".length) : token;
}

/**
 * Read the workflow-level Prepare view of one coordinator-bound workflow
 * (spec § New API and CLI). Read-only: no snapshot lock, nothing written. The
 * two byte versions are the tokens `amendPrepareWorkflow` requires, and
 * `allowed`/`blockers` report the Prepare/no-execution admission exactly as the
 * mutation evaluates it — an inadmissible *lifecycle state* is readable, not an
 * error, so a caller can inspect a workflow before deciding to amend it.
 * Problems that make the documents or the caller's identity unusable — a
 * missing/foreign/mismatched envelope, an unregistered or unreadable snapshot,
 * an unreadable or borrowed compass — still refuse with their own code, because
 * no trustworthy answer can be produced from them.
 */
export async function showPrepareWorkflow(
  input: Readonly<{ sessionPath: string; cwd?: string }>,
): Promise<PrepareWorkflowResult> {
  assertExactKeys(input as unknown as Record<string, unknown>, ["sessionPath", "cwd"], "prepare workflow read");
  const cwd = input.cwd ?? process.cwd();
  const scope = prepareWorkflowScope(input.sessionPath, cwd);
  const { snapshot, version } = readPrepareSnapshot(scope.snapshotPath);
  assertCoordinatorBinding(scope.session, scope.sessionPath, snapshot);
  const compass = readPrepareCompass(scope.harnessRoot, snapshot);
  const admission = prepareAdmission(scope.harnessRoot, scope.workflowId, snapshot);
  return {
    ok: true,
    operation: "show-prepare",
    session: scope.session,
    session_file: scope.sessionPath,
    view: {
      workflowId: scope.workflowId,
      snapshotVersion: version,
      compassVersion: compass.version,
      planIds: snapshot.plans.map((row) => rowPlanIds(row)[0] ?? ""),
      allowed: admission.ok,
      blockers: admission.ok ? [] : [`${admission.reason}: ${admission.message}`],
    },
  };
}

/**
 * Apply one approved Prepare structural amendment (spec § Admission and
 * mutation). The CAS read, both version comparisons, the admission, the whole
 * patch validation, the compass recheck and the single atomic write all run
 * under the canonical snapshot write lock, so two callers presenting the same
 * tokens cannot both succeed: the loser inspects the winner's bytes and
 * refuses as `stale`. Every refusal happens before any write — the protected
 * snapshot, root register, other workflows and the compass stay byte-identical.
 *
 * A lock that cannot be acquired refuses explicitly (the shared
 * `withStatusWriteLock` Blocked error); Git-unavailable probes refuse through
 * the existing `coordination.git-unavailable`.
 */
export async function amendPrepareWorkflow(
  input: Readonly<{
    sessionPath: string;
    cwd?: string;
    expectedSnapshotVersion: string;
    expectedCompassVersion: string;
    patch: PrepareWorkflowPatch;
  }>,
): Promise<PrepareWorkflowResult> {
  assertExactKeys(
    input as unknown as Record<string, unknown>,
    ["sessionPath", "cwd", "expectedSnapshotVersion", "expectedCompassVersion", "patch"],
    "prepare amendment input",
  );
  const cwd = input.cwd ?? process.cwd();
  const expectedSnapshotVersion = prepareVersionToken(input.expectedSnapshotVersion, "expectedSnapshotVersion");
  const expectedCompassVersion = prepareVersionToken(input.expectedCompassVersion, "expectedCompassVersion");
  const scope = prepareWorkflowScope(input.sessionPath, cwd);
  const committed = await withStatusWriteLock(scope.snapshotPath, async () => {
    const { snapshot, version } = readPrepareSnapshot(scope.snapshotPath);
    assertCoordinatorBinding(scope.session, scope.sessionPath, snapshot);
    const main = assertCoordinatorResidency(cwd, snapshot);
    // Both byte versions are compared against the bytes inspected inside this
    // locked section (spec § Admission and mutation step 3).
    if (prepareVersionDigest(version) !== prepareVersionDigest(expectedSnapshotVersion)) {
      throw prepareAmendmentRefusal(
        "stale",
        `snapshot ${scope.snapshotPath} is at ${version}, this call expected ${expectedSnapshotVersion} \u2014 re-read \`workflow show-prepare\` and review again`,
        { path: scope.snapshotPath, expected: expectedSnapshotVersion, actual: version },
      );
    }
    const compass = readPrepareCompass(scope.harnessRoot, snapshot);
    if (prepareVersionDigest(compass.version) !== prepareVersionDigest(expectedCompassVersion)) {
      throw prepareAmendmentRefusal(
        "stale",
        `compass ${compass.path} is at ${compass.version}, this call expected ${expectedCompassVersion} \u2014 re-read \`workflow show-prepare\` and review again`,
        { path: compass.path, expected: expectedCompassVersion, actual: compass.version },
      );
    }
    const admission = prepareAdmission(scope.harnessRoot, scope.workflowId, snapshot);
    if (!admission.ok) throw prepareAmendmentRefusal(admission.reason, admission.message, admission.details);
    const proposal = readPreparePatch(input.patch, { harnessRoot: scope.harnessRoot, snapshot, compass, main });
    // Old rows and unknown fields are taken from disk by value — only the new
    // rows, the requested whitelist projections and `updated_at` are new. The
    // policy copy carries the stored object's own keys, so keys this verb may
    // not edit survive it.
    const executionPolicy: WorkflowExecutionPolicy = { ...(snapshot.execution_policy ?? {}) };
    if (proposal.planParallelism !== undefined) executionPolicy.plan_parallelism = proposal.planParallelism;
    const next: WorkflowSnapshot = {
      ...snapshot,
      updated_at: nowIso(),
      plans: [...snapshot.plans, ...proposal.rows],
      ...(proposal.integrationWorktreePath !== undefined
        ? { integration_worktree_path: proposal.integrationWorktreePath }
        : {}),
      ...(proposal.planParallelism !== undefined ? { execution_policy: executionPolicy } : {}),
    };
    // The reviewed declaration must still be the bytes this call inspected when
    // the amendment lands (spec § Admission and mutation step 7).
    const rechecked = readPrepareCompass(scope.harnessRoot, snapshot);
    if (prepareVersionDigest(rechecked.version) !== prepareVersionDigest(compass.version)) {
      throw prepareAmendmentRefusal(
        "stale",
        `compass ${compass.path} changed while this amendment was being applied (${compass.version} \u2192 ${rechecked.version}) \u2014 re-read \`workflow show-prepare\` and review again`,
        { path: compass.path, expected: compass.version, actual: rechecked.version },
      );
    }
    await commitSnapshot(scope.harnessRoot, scope.workflowId, scope.snapshotPath, next);
    // The returned CAS token is read from the bytes this call just wrote,
    // inside the critical section: a version read after the lock is released
    // could name a competing commit that landed in between, while the reported
    // plan ids and compass version would still be this call's.
    const written = readArtifactBytes(scope.snapshotPath);
    if (written === undefined) {
      throw new CoordinationError(
        "coordination.store",
        `snapshot ${scope.snapshotPath} is unreadable after this call committed it`,
        { path: scope.snapshotPath },
      );
    }
    return {
      planIds: next.plans.map((row) => rowPlanIds(row)[0] ?? ""),
      compassVersion: compass.version,
      snapshotVersion: written.version,
    };
  });
  return {
    ok: true,
    operation: "amend-prepare",
    session: scope.session,
    session_file: scope.sessionPath,
    outcome: "amended",
    // The delta only appends admissible Todo rows and records the requested
    // path/policy, so the workflow stays admissible after the commit.
    view: {
      workflowId: scope.workflowId,
      snapshotVersion: committed.snapshotVersion,
      compassVersion: committed.compassVersion,
      planIds: committed.planIds,
      allowed: true,
      blockers: [],
    },
  };
}
