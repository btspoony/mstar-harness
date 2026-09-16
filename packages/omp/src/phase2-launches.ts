/**
 * Phase-2 launch admission — the local transport-intent journal for extra
 * plan-scoped primary sessions.
 *
 * Primary spec: `{SPECS_DIR}/omp-phase2-instances.md` §C (capacity, reservation
 * and recovery) + §D (skill-driven transport boundary); plan
 * `20260916-omp-phase2-instances` T2. This module owns exactly one file —
 * `{WORKFLOW_DIR}/<workflow-id>/omp-launches.json` — and that file is transport
 * bookkeeping only: never lifecycle state, never a second ownership truth, and
 * never a substitute for the engine's scope/lease/handoff verbs.
 *
 * - `reservePlanLaunch` admits one intent from the coordinator and appends it
 *   as `reserved`.
 * - `recordPlanLaunch` persists the PM's observed transport transitions
 *   (`reserved → starting → created → submitting → submitted`, plus the
 *   terminal `refused` / `uncertain` observations) and appends the caller's
 *   read-only evidence path. Only a newly persisted transition reports
 *   `applied: true`; an observation repeated for the state already on disk is
 *   an idempotent replay (`applied: false`, no write, no side effect), which is
 *   what stops a blind duplicate submission.
 *
 * Both calls, in order:
 *
 * 1. Resolve the caller FROM the coordinator session envelope and require that
 *    exact envelope to be the workflow snapshot's bound coordinator: a plan
 *    session, another workflow's session or a replacement holder cannot touch
 *    this workflow's journal.
 * 2. Hold the canonical write lock **once**. The journal sits in the same
 *    canonical workflow directory as `snapshot.json`, so
 *    `withStatusWriteLock(snapshotPath)` IS the canonical snapshot → journal
 *    critical section (a nested acquisition on the same lockdir is the
 *    documented reentrancy bug, never a second lock).
 * 3. Inside the lock, reread the snapshot, then the journal, then the live
 *    settings, and admit against those reads; the journal is written last,
 *    through the engine's atomic `writeJson`, and it is the only document this
 *    module ever writes.
 *
 * Capacity is the union **by plan id** of outstanding (non-refused) intents and
 * active engine plan-primary bindings, so a plan that is both pending and bound
 * counts once and two asynchronous starts cannot both take the last slot. A
 * durable handoff (`submitted` / `accepted` / `integrating` / `merged` /
 * `completed`) proves the child reached its scoped stop and releases the plan;
 * `returned` reactivates it. Lowering the cap pauses further side-effecting
 * transitions without editing, revoking or killing anything that exists.
 *
 * `uncertain` is terminal and stays occupied: a malformed response, a timeout
 * or a stalled prompt is never auto-retried, and only a durable handoff or an
 * explicit human recovery discharges it. Pane ids, PIDs and idle/done labels
 * are recorded observations and grant nothing.
 *
 * Two admission readings worth stating, because the frozen request carries no
 * field for either:
 *
 * - The **reserve call itself records PM's dependency readiness**. The shared
 *   scheduling contract keeps no persisted ready set (that would be a second
 *   status register), so this module verifies the coordinator-prepared row,
 *   worktree and transport prerequisites and takes the caller's readiness
 *   assertion for the one fact it cannot read: that the plan's dependencies are
 *   satisfied. It stores no readiness state of its own.
 * - `skill.source` is the PM's **skill-catalog assertion** (opaque, non-empty),
 *   not a filesystem path: the module reads no skill catalog and imposes no
 *   mandatory external skill dependency. The verifiable half of the capability
 *   is the CLI executable and the caller's matching managed environment, plus
 *   the read-only evidence files recorded on each transition.
 *
 * Not here, by contract: no process spawn, no screen parsing, no engine-row
 * mutation, no lease release, no timer/polling loop, and no ownership or
 * completion inference from the transport. The optional Herdr/tmux skill
 * performs every side-effecting CLI call; the child's own `bind` / `handoff`
 * stay the only writers of engine ownership.
 */
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  assertBranchAlignment,
  canonicalizeNearestExisting,
  isDistinctCheckout,
  probeCheckoutRoot,
  readMainWorktree,
  readSessionEnvelope,
  readWorkflowSnapshot,
  resolvePlanScope,
  resolveWorkflowDir,
  withStatusWriteLock,
  writeJson,
} from "@mstar-harness/engine";
import type { CoordinationSession, PlanRow, ResolvedPlanScope, WorkflowSnapshot } from "@mstar-harness/engine";
import { readPhase2Settings, type Phase2Request } from "./phase2-orchestration";

/* ------------------------------------------------------------------------- *
 * Journal shape (spec §C)
 * ------------------------------------------------------------------------- */

export type LaunchIntent = Readonly<{
  id: string;
  workflowId: string;
  coordinatorSessionId: string;
  planId: string;
  preparedHash: string;
  assignmentPath: string;
  worktreePath: string;
  transport: "herdr" | "tmux";
  state: "reserved" | "starting" | "created" | "submitting" | "submitted" | "refused" | "uncertain";
  target?: string;
  evidencePaths: readonly string[];
}>;

/** Plugin-owned journal document: `version:1`, identity, and intent entries only. */
type JournalDoc = {
  version: 1;
  workflow_id: string;
  coordinator: { session_id: string; session_file: string };
  intents: LaunchIntent[];
};

type LaunchState = LaunchIntent["state"];
type LaunchObservation = Extract<Phase2Request, { operation: "record-launch" }>["observation"];
type ReserveRequest = Extract<Phase2Request, { operation: "reserve-launch" }>;
type RecordRequest = Extract<Phase2Request, { operation: "record-launch" }>;
type Authority = Readonly<{ coordinatorSessionPath: string; cwd: string }>;

/** Result of both journal calls (spec §C): a persisted intent, or a refusal. */
export type PlanLaunchResult =
  | { ok: true; intent: LaunchIntent; applied: boolean }
  | { ok: false; code: string; message: string };

/** A refusal that pre-empts the rest of the admission path, or `null` when it passes. */
type Refusal = { ok: false; code: string; message: string } | null;

const JOURNAL_FILE = "omp-launches.json";
const WORKFLOW_SNAPSHOT_FILE = "snapshot.json";
const JOURNAL_VERSION = 1;

/** Exact accepted engine phase label for "this coordinator is executing Phase 2". */
const PHASE_2_EXECUTE = "phase-2-execute";

/** Handoff states that prove the child reached its scoped stop (spec §C occupancy). */
const DURABLE_HANDOFF_STATES: Readonly<Record<string, true>> = {
  submitted: true,
  accepted: true,
  integrating: true,
  merged: true,
  completed: true,
};

/**
 * Legal forward observations, keyed by the observation itself (a persisted
 * observation is also the resulting intent state). `refused` is legal only
 * where no process/prompt can exist yet; from `submitting` onward a lost
 * outcome is `uncertain`, never `refused`.
 */
const FORWARD_OBSERVATIONS: Readonly<Record<LaunchObservation, readonly LaunchState[]>> = {
  starting: ["reserved"],
  created: ["starting"],
  submitting: ["created"],
  submitted: ["submitting"],
  refused: ["reserved", "starting", "created"],
  uncertain: ["reserved", "starting", "created", "submitting"],
};

/** Observations that authorize a side-effecting CLI call, so they rerun every gate. */
const SIDE_EFFECTING_OBSERVATIONS: Readonly<Record<string, true>> = {
  starting: true,
  created: true,
  submitting: true,
};

const LAUNCH_STATES: Readonly<Record<string, true>> = {
  reserved: true,
  starting: true,
  created: true,
  submitting: true,
  submitted: true,
  refused: true,
  uncertain: true,
};

const TRANSPORTS: Readonly<Record<string, true>> = { herdr: true, tmux: true };

function refuse(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/* ------------------------------------------------------------------------- *
 * Request validation
 * ------------------------------------------------------------------------- */

/** Reject a malformed request before any path, file or lock is touched. */
function validateReserveRequest(request: ReserveRequest): Refusal {
  if (request.planId.trim() === "") return refuse("launch.invalid-request", "reserve-launch requires a planId");
  if (TRANSPORTS[request.transport] !== true) {
    return refuse("launch.invalid-request", `unknown transport ${JSON.stringify(request.transport)}`);
  }
  if (!nonEmpty(request.skill?.name) || !nonEmpty(request.skill?.source)) {
    return refuse("launch.invalid-request", "reserve-launch requires the skill name and its catalog source");
  }
  if (!nonEmpty(request.capability?.executable) || !nonEmpty(request.capability?.version) || !nonEmpty(request.capability?.target)) {
    return refuse(
      "launch.invalid-request",
      "reserve-launch requires the asserted CLI executable, its version/help reading and the caller's managed target",
    );
  }
  return null;
}

function validateRecordRequest(request: RecordRequest): Refusal {
  if (!nonEmpty(request.intentId)) return refuse("launch.invalid-request", "record-launch requires an intentId");
  if (!Object.hasOwn(FORWARD_OBSERVATIONS, request.observation)) {
    return refuse("launch.invalid-request", `unknown launch observation ${JSON.stringify(request.observation)}`);
  }
  if (!nonEmpty(request.evidencePath) || !isAbsolute(request.evidencePath)) {
    return refuse("launch.invalid-request", "record-launch requires an absolute evidencePath");
  }
  if (request.target !== undefined && !nonEmpty(request.target)) {
    return refuse("launch.invalid-request", "record-launch target must be a non-empty string when provided");
  }
  if (request.observation === "created" && !nonEmpty(request.target)) {
    return refuse("launch.invalid-request", "record-launch created requires the returned opaque target");
  }
  return null;
}

function validateAuthority(authority: Authority): Refusal {
  if (!nonEmpty(authority?.coordinatorSessionPath) || !isAbsolute(authority.coordinatorSessionPath)) {
    return refuse("launch.invalid-request", "authority requires an absolute coordinatorSessionPath");
  }
  if (!nonEmpty(authority?.cwd) || !isAbsolute(authority.cwd)) {
    return refuse("launch.invalid-request", "authority requires an absolute cwd");
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Caller identity and workflow resolution
 * ------------------------------------------------------------------------- */

type ResolvedAuthority = {
  session: CoordinationSession;
  sessionPath: string;
  harnessRoot: string;
  workflowDir: string;
  snapshotPath: string;
  journalPath: string;
};

/**
 * Resolve the caller from its own envelope: engine-validated session identity,
 * the lifecycle's canonical workflow directory, and the two canonical documents
 * this module reads under one lock.
 */
function resolveAuthority(authority: Authority): { ok: true; value: ResolvedAuthority } | { ok: false; code: string; message: string } {
  let session: CoordinationSession;
  try {
    session = readSessionEnvelope(authority.coordinatorSessionPath);
  } catch (error) {
    return refuse("launch.session-denied", `no readable coordination session envelope: ${messageOf(error)}`);
  }
  if (session.role !== "coordinator") {
    return refuse(
      "launch.session-denied",
      `session ${session.session_id} is a ${session.role}; only the lifecycle coordinator may launch additional plan primaries`,
    );
  }
  const sessionPath = canonicalizeNearestExisting(authority.coordinatorSessionPath);
  const harnessRoot = canonicalizeNearestExisting(session.harness_root);
  const workflowDir = join(resolveWorkflowDir(authority.cwd, { harnessDir: harnessRoot }), session.workflow_id);
  return {
    ok: true,
    value: {
      session,
      sessionPath,
      harnessRoot,
      workflowDir,
      snapshotPath: join(workflowDir, WORKFLOW_SNAPSHOT_FILE),
      journalPath: join(workflowDir, JOURNAL_FILE),
    },
  };
}

/**
 * The caller must be exactly the workflow's bound coordinator, in the exact
 * accepted Phase-2 state. Anything else (another holder, a terminal lifecycle,
 * a drifted or absent phase projection) disables admission.
 */
function assertOwnCoordinator(resolved: ResolvedAuthority, snapshot: WorkflowSnapshot): Refusal {
  const coordinator = snapshot.coordination?.coordinator;
  if (coordinator === undefined || coordinator.session_id !== resolved.session.session_id || coordinator.session_file !== resolved.sessionPath) {
    return refuse(
      "launch.session-denied",
      `workflow ${resolved.session.workflow_id} is bound to coordinator ${coordinator?.session_id ?? "(none)"} at ${coordinator?.session_file ?? "(none)"}, not to this session ${resolved.session.session_id} at ${resolved.sessionPath}`,
    );
  }
  if (snapshot.status !== "running" || snapshot.phase !== PHASE_2_EXECUTE) {
    return refuse(
      "launch.phase-inactive",
      `workflow ${snapshot.id} is ${snapshot.status} at phase ${JSON.stringify(snapshot.phase ?? null)}; extra primaries require "${PHASE_2_EXECUTE}"`,
    );
  }
  return null;
}

function readSnapshot(resolved: ResolvedAuthority): { ok: true; snapshot: WorkflowSnapshot } | { ok: false; code: string; message: string } {
  try {
    return { ok: true, snapshot: readWorkflowSnapshot(resolved.workflowDir).snapshot };
  } catch (error) {
    return refuse("launch.snapshot-unreadable", `cannot read the workflow snapshot at ${resolved.snapshotPath}: ${messageOf(error)}`);
  }
}

/* ------------------------------------------------------------------------- *
 * Journal read (fail-closed reconstruction)
 * ------------------------------------------------------------------------- */

function emptyJournal(session: CoordinationSession, sessionPath: string): JournalDoc {
  return {
    version: JOURNAL_VERSION,
    workflow_id: session.workflow_id,
    coordinator: { session_id: session.session_id, session_file: sessionPath },
    intents: [],
  };
}

function isLaunchIntent(value: unknown): value is LaunchIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    nonEmpty(entry.id) &&
    nonEmpty(entry.workflowId) &&
    nonEmpty(entry.coordinatorSessionId) &&
    nonEmpty(entry.planId) &&
    nonEmpty(entry.preparedHash) &&
    nonEmpty(entry.assignmentPath) &&
    typeof entry.worktreePath === "string" &&
    typeof entry.transport === "string" &&
    TRANSPORTS[entry.transport] === true &&
    typeof entry.state === "string" &&
    LAUNCH_STATES[entry.state] === true &&
    (entry.target === undefined || nonEmpty(entry.target)) &&
    Array.isArray(entry.evidencePaths) &&
    entry.evidencePaths.every((path) => nonEmpty(path))
  );
}

/**
 * Read the journal, or refuse. A present-but-unparseable, foreign or malformed
 * journal is never silently reset — capacity decisions are made from these
 * entries, so an untrusted read must fail closed instead of widening the cap.
 */
function readJournal(
  journalPath: string,
  session: CoordinationSession,
  sessionPath: string,
): { ok: true; doc: JournalDoc } | { ok: false; code: string; message: string } {
  if (!existsSync(journalPath)) return { ok: true, doc: emptyJournal(session, sessionPath) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch (error) {
    return refuse("launch.journal-corrupt", `transport journal ${journalPath} is not valid JSON: ${messageOf(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("launch.journal-corrupt", `transport journal ${journalPath} must be an object`);
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.version !== JOURNAL_VERSION) {
    return refuse("launch.journal-corrupt", `transport journal ${journalPath} must declare version ${JOURNAL_VERSION}`);
  }
  if (doc.workflow_id !== session.workflow_id) {
    return refuse(
      "launch.journal-corrupt",
      `transport journal ${journalPath} belongs to workflow ${JSON.stringify(doc.workflow_id)}, not ${session.workflow_id}`,
    );
  }
  const coordinator = doc.coordinator;
  if (
    typeof coordinator !== "object" ||
    coordinator === null ||
    (coordinator as Record<string, unknown>).session_id !== session.session_id ||
    (coordinator as Record<string, unknown>).session_file !== sessionPath
  ) {
    return refuse(
      "launch.journal-corrupt",
      `transport journal ${journalPath} was opened by another coordinator session; explicit recovery is required, never a takeover`,
    );
  }
  if (!Array.isArray(doc.intents) || !doc.intents.every(isLaunchIntent)) {
    return refuse("launch.journal-corrupt", `transport journal ${journalPath} carries entries this plugin cannot trust`);
  }
  return { ok: true, doc: { version: JOURNAL_VERSION, workflow_id: session.workflow_id, coordinator: { session_id: session.session_id, session_file: sessionPath }, intents: doc.intents } };
}

/* ------------------------------------------------------------------------- *
 * Occupancy (union by plan id: outstanding intents ∪ active engine bindings)
 * ------------------------------------------------------------------------- */

function planIdOf(row: PlanRow): string | null {
  if (nonEmpty(row.id)) return row.id;
  if (nonEmpty(row.plan_id)) return row.plan_id;
  return null;
}

function findPlanRow(snapshot: WorkflowSnapshot, planId: string): PlanRow | null {
  for (const row of snapshot.plans) if (planIdOf(row) === planId) return row;
  return null;
}

/** The row's coordination block, or null when absent/malformed. */
function rowCoordinationOf(row: PlanRow): Record<string, unknown> | null {
  const coordination = (row as Record<string, unknown>).coordination;
  if (typeof coordination !== "object" || coordination === null || Array.isArray(coordination)) return null;
  return coordination as Record<string, unknown>;
}

/** A durable handoff proves the child reached its scoped stop (spec §C). */
function durableHandoffStateOf(row: PlanRow): string | null {
  const handoff = rowCoordinationOf(row)?.handoff;
  if (typeof handoff !== "object" || handoff === null) return null;
  const state = (handoff as Record<string, unknown>).state;
  return typeof state === "string" && DURABLE_HANDOFF_STATES[state] === true ? state : null;
}

/** Real `coordination.session` plus execution authority of the same session. */
function hasActiveBinding(row: PlanRow): boolean {
  const coordination = rowCoordinationOf(row);
  const session = coordination?.session;
  if (typeof session !== "object" || session === null) return false;
  const sessionId = (session as Record<string, unknown>).session_id;
  if (!nonEmpty(sessionId)) return false;
  const lease = (row as Record<string, unknown>).execution_lease;
  if (typeof lease !== "object" || lease === null) return false;
  return (lease as Record<string, unknown>).holder === sessionId;
}

/**
 * Occupancy set: each plan id counted once, whether it is pending in the journal
 * or bound in the engine. `refused` intents never occupy (the refusal proved no
 * process/prompt exists); a durable handoff releases the plan even while its
 * intent or a coordinator lease remains.
 */
function occupancyOf(snapshot: WorkflowSnapshot, intents: readonly LaunchIntent[]): Set<string> {
  const occupied = new Set<string>();
  for (const row of snapshot.plans) {
    const planId = planIdOf(row);
    if (planId === null || durableHandoffStateOf(row) !== null) continue;
    if (hasActiveBinding(row)) occupied.add(planId);
  }
  for (const intent of intents) {
    if (intent.state === "refused") continue;
    const row = findPlanRow(snapshot, intent.planId);
    if (row !== null && durableHandoffStateOf(row) !== null) continue;
    occupied.add(intent.planId);
  }
  return occupied;
}

/* ------------------------------------------------------------------------- *
 * Independent-prepared-plan admission (spec §C reserve prerequisites)
 * ------------------------------------------------------------------------- */

function preparedOf(row: PlanRow): Record<string, unknown> | null {
  const prepared = rowCoordinationOf(row)?.prepared;
  if (typeof prepared !== "object" || prepared === null) return null;
  return prepared as Record<string, unknown>;
}

/** The plan row must be an unstarted, unowned, unbound coordinator-prepared row. */
function assertPlanAvailable(row: PlanRow, planId: string): Refusal {
  const status = row.status;
  if (status !== "Todo" && status !== "Blocked") {
    return refuse("launch.plan-unavailable", `plan ${planId} is ${JSON.stringify(status ?? null)}; only a Todo/Blocked plan is launchable`);
  }
  const coordination = rowCoordinationOf(row);
  if (coordination?.session !== undefined) {
    return refuse("launch.plan-unavailable", `plan ${planId} is already bound to a plan session`);
  }
  if (coordination?.handoff !== undefined) {
    return refuse("launch.plan-unavailable", `plan ${planId} carries a handoff record; a launched plan has not handed off yet`);
  }
  if ((row as Record<string, unknown>).execution_lease !== undefined) {
    return refuse("launch.plan-unavailable", `plan ${planId} carries an execution lease`);
  }
  return null;
}

function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** The pinned Assignment must still be the bytes the coordinator prepared. */
function assertPreparedHash(prepared: Record<string, unknown>, planId: string): Refusal {
  const assignmentPath = prepared.assignment_path;
  const expected = prepared.assignment_sha256;
  if (!nonEmpty(assignmentPath) || !nonEmpty(expected)) {
    return refuse("launch.plan-not-prepared", `plan ${planId} has no hash-pinned prepared Assignment`);
  }
  const actual = sha256File(assignmentPath);
  if (actual === null) {
    return refuse("launch.prepared-hash-drift", `the prepared Assignment ${assignmentPath} of plan ${planId} is unreadable or missing`);
  }
  if (actual !== expected) {
    return refuse(
      "launch.prepared-hash-drift",
      `the prepared Assignment of plan ${planId} changed on disk (prepared ${expected}, now ${actual}) — re-prepare before launching`,
    );
  }
  return null;
}

/**
 * The assigned worktree must be an existing, canonical, distinct feature
 * checkout of the same repository, on the Assignment's Working branch — and
 * never the lifecycle's integration checkout (spec §C).
 */
function assertLaunchWorktree(scope: ResolvedPlanScope, authority: Authority, snapshot: WorkflowSnapshot): Refusal {
  const worktreePath = scope.worktreePath;
  let isDirectory = false;
  try {
    isDirectory = statSync(worktreePath).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return refuse("launch.worktree-unavailable", `the assigned worktree ${worktreePath} is not an existing directory`);
  }

  const candidateRoot = probeCheckoutRoot(worktreePath);
  const controlRoot = probeCheckoutRoot(authority.cwd);
  if (candidateRoot === null || controlRoot === null) {
    return refuse(
      "launch.worktree-unavailable",
      `cannot prove a Git checkout identity for ${worktreePath} and ${authority.cwd}`,
    );
  }

  const integration = snapshot.integration_worktree_path;
  if (integration !== undefined && canonicalizeNearestExisting(integration) === candidateRoot) {
    return refuse("launch.worktree-unavailable", `${worktreePath} is the lifecycle integration checkout, not a plan worktree`);
  }
  if (candidateRoot === controlRoot || !isDistinctCheckout(authority.cwd, worktreePath)) {
    return refuse(
      "launch.worktree-unavailable",
      `${worktreePath} is not a checkout distinct from the coordinator's own checkout ${controlRoot}`,
    );
  }

  const candidateMain = readMainWorktree(worktreePath);
  const controlMain = readMainWorktree(authority.cwd);
  if (candidateMain === null || controlMain === null || candidateMain.root !== controlMain.root) {
    return refuse(
      "launch.worktree-unavailable",
      `${worktreePath} is not a worktree of the same repository as ${authority.cwd}`,
    );
  }

  const branch = assertBranchAlignment(worktreePath, scope.workingBranch);
  if (!branch.ok) {
    return refuse(
      "launch.worktree-unavailable",
      `${worktreePath} is not on its assigned branch ${scope.workingBranch}: ${branch.violations.map((entry) => entry.message).join("; ")}`,
    );
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Transport capability (spec §D prerequisites, read-only)
 * ------------------------------------------------------------------------- */

function executableResolves(executable: string): boolean {
  const isExecutableFile = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(executable) || executable.includes("/")) return isExecutableFile(resolve(executable));
  const path = process.env.PATH ?? "";
  return path
    .split(delimiter)
    .some((entry) => entry.trim() !== "" && isExecutableFile(join(entry, executable)));
}

/** Managed environments this caller is actually inside, per transport. */
function managedEnvironments(): ReadonlySet<string> {
  const found = new Set<string>();
  if (process.env.HERDR_ENV === "1") found.add("herdr");
  if (nonEmpty(process.env.TMUX)) found.add("tmux");
  return found;
}

/**
 * Every prerequisite, checked read-only: the skill assertion, the CLI
 * executable, and the caller's matching managed environment. Both environments
 * visible at once is a visible refusal — never a focus-based selection — and a
 * missing prerequisite authorizes no process start.
 */
function assertTransportCapability(request: ReserveRequest): Refusal {
  if (!executableResolves(request.capability.executable)) {
    return refuse(
      "launch.capability-unavailable",
      `${request.transport} CLI ${JSON.stringify(request.capability.executable)} does not resolve to an executable file`,
    );
  }
  const environments = managedEnvironments();
  if (environments.size > 1) {
    return refuse(
      "launch.capability-unavailable",
      `this caller is inside more than one managed environment (${[...environments].join(", ")}); ambiguity is refused, not resolved by focus`,
    );
  }
  if (!environments.has(request.transport)) {
    return refuse(
      "launch.capability-unavailable",
      `this caller is not inside the ${request.transport} managed environment (${request.transport === "herdr" ? "HERDR_ENV=1" : "TMUX"} unset); the skill ${JSON.stringify(request.skill.name)} from ${JSON.stringify(request.skill.source)} cannot be driven`,
    );
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * reserve-launch
 * ------------------------------------------------------------------------- */

export async function reservePlanLaunch(
  request: Extract<Phase2Request, { operation: "reserve-launch" }>,
  authority: Readonly<{ coordinatorSessionPath: string; cwd: string }>,
): Promise<PlanLaunchResult> {
  const invalid = validateAuthority(authority) ?? validateReserveRequest(request);
  if (invalid !== null) return invalid;

  const resolved = resolveAuthority(authority);
  if (resolved.ok === false) return resolved;
  const resolvedAuthority = resolved.value;
  const { session, sessionPath, harnessRoot, workflowDir, snapshotPath, journalPath } = resolvedAuthority;

  return withStatusWriteLock(snapshotPath, async () => {
    // Canonical snapshot → journal: never the other order.
    const read = readSnapshot(resolvedAuthority);
    if (read.ok === false) return read;
    const snapshot = read.snapshot;

    const own = assertOwnCoordinator(resolvedAuthority, snapshot);
    if (own !== null) return own;

    const journal = readJournal(journalPath, session, sessionPath);
    if (journal.ok === false) return journal;
    const doc = journal.doc;

    const planId = request.planId;
    const row = findPlanRow(snapshot, planId);
    if (row === null) return refuse("launch.plan-not-found", `workflow ${snapshot.id} has no plan row ${planId}`);
    const prepared = preparedOf(row);
    if (prepared === null || !nonEmpty(prepared.assignment_sha256)) {
      return refuse("launch.plan-not-prepared", `plan ${planId} has no hash-pinned prepared Assignment`);
    }
    const preparedHash = prepared.assignment_sha256;

    // Duplicate identical request: the recorded intent is returned without
    // another authorization, so it never consumes a second slot. Any other
    // outstanding intent for this plan is a duplicate owner and refuses.
    const live = doc.intents.filter((entry) => {
      if (entry.planId !== planId || entry.state === "refused") return false;
      const entryRow = findPlanRow(snapshot, entry.planId);
      return !(entryRow !== null && durableHandoffStateOf(entryRow) !== null);
    });
    const identical = live.find((entry) => entry.preparedHash === preparedHash);
    if (identical !== undefined) return { ok: true, intent: identical, applied: false };
    if (live.length > 0) {
      return refuse(
        "launch.plan-occupied",
        `plan ${planId} already has an outstanding launch intent ${live[0]!.id} (${live[0]!.state}); an uncertain or pre-bind intent needs a durable handoff or explicit human recovery`,
      );
    }

    const available = assertPlanAvailable(row, planId);
    if (available !== null) return available;

    const settings = await readPhase2Settings(authority.cwd);
    if (settings.ok === false) {
      return refuse(
        settings.reason === "invalid-settings" ? "launch.settings-invalid" : "launch.settings-read-failed",
        settings.message,
      );
    }
    if (!settings.value.phase2PlanInstances) {
      return refuse("launch.settings-disabled", "phase2PlanInstances is off; extra plan primaries require the explicit opt-in");
    }

    const drift = assertPreparedHash(prepared, planId);
    if (drift !== null) return drift;

    let scope: ResolvedPlanScope;
    try {
      scope = await resolvePlanScope({ workflowId: session.workflow_id, planId, harnessDir: harnessRoot }, authority.cwd);
    } catch (error) {
      return refuse("launch.plan-unavailable", `plan ${planId} scope is not resolvable for a launch: ${messageOf(error)}`);
    }

    const worktree = assertLaunchWorktree(scope, authority, snapshot);
    if (worktree !== null) return worktree;

    const capability = assertTransportCapability(request);
    if (capability !== null) return capability;

    const occupancy = occupancyOf(snapshot, doc.intents);
    if (occupancy.size + 1 > settings.value.maxPlanInstances) {
      return refuse(
        "launch.capacity-exceeded",
        `${occupancy.size} plan primaries are already pending or active (${[...occupancy].join(", ") || "none"}); maxPlanInstances is ${settings.value.maxPlanInstances}`,
      );
    }

    const intent: LaunchIntent = {
      id: `phase2-launch:${planId}:${doc.intents.filter((entry) => entry.planId === planId).length + 1}`,
      workflowId: session.workflow_id,
      coordinatorSessionId: session.session_id,
      planId,
      preparedHash,
      assignmentPath: scope.assignmentPath,
      worktreePath: scope.worktreePath,
      transport: request.transport,
      state: "reserved",
      evidencePaths: [],
    };
    writeJson<JournalDoc>(journalPath, { ...doc, intents: [...doc.intents, intent] });
    return { ok: true, intent, applied: true };
  });
}

/* ------------------------------------------------------------------------- *
 * record-launch
 * ------------------------------------------------------------------------- */

export async function recordPlanLaunch(
  request: Extract<Phase2Request, { operation: "record-launch" }>,
  authority: Readonly<{ coordinatorSessionPath: string; cwd: string }>,
): Promise<PlanLaunchResult> {
  const invalid = validateAuthority(authority) ?? validateRecordRequest(request);
  if (invalid !== null) return invalid;

  const resolved = resolveAuthority(authority);
  if (resolved.ok === false) return resolved;
  const { session, sessionPath, harnessRoot, workflowDir, snapshotPath, journalPath } = resolved.value;
  const resolvedAuthority = { session, sessionPath, harnessRoot, workflowDir, snapshotPath, journalPath };

  return withStatusWriteLock(snapshotPath, async () => {
    const read = readSnapshot(resolvedAuthority);
    if (read.ok === false) return read;
    const snapshot = read.snapshot;

    const own = assertOwnCoordinator(resolvedAuthority, snapshot);
    if (own !== null) return own;

    const journal = readJournal(journalPath, session, sessionPath);
    if (journal.ok === false) return journal;
    const doc = journal.doc;

    const intent = doc.intents.find((entry) => entry.id === request.intentId);
    if (intent === undefined) {
      return refuse("launch.intent-not-found", `no launch intent ${request.intentId} in ${journalPath}`);
    }
    if (intent.coordinatorSessionId !== session.session_id || intent.workflowId !== session.workflow_id) {
      return refuse("launch.session-denied", `launch intent ${intent.id} belongs to another coordinator workflow`);
    }
    if (request.target !== undefined && intent.target !== undefined && request.target !== intent.target) {
      return refuse(
        "launch.transition-invalid",
        `launch intent ${intent.id} is already bound to target ${intent.target}; a transition never re-points a recorded target`,
      );
    }

    // Idempotent replay: the same observation for the state already on disk
    // authorizes no side effect and writes nothing.
    if (intent.state === request.observation) return { ok: true, intent, applied: false };

    if (!FORWARD_OBSERVATIONS[request.observation].includes(intent.state)) {
      return refuse(
        "launch.transition-invalid",
        `${request.observation} is not a legal transition from ${intent.state} for launch intent ${intent.id}${
          intent.state === "uncertain" ? " — an uncertain submission is terminal and is never retried" : ""
        }`,
      );
    }

    if (SIDE_EFFECTING_OBSERVATIONS[request.observation] === true) {
      const settings = await readPhase2Settings(authority.cwd);
      if (settings.ok === false) {
        return refuse(
          settings.reason === "invalid-settings" ? "launch.settings-invalid" : "launch.settings-read-failed",
          settings.message,
        );
      }
      if (!settings.value.phase2PlanInstances) {
        return refuse("launch.settings-disabled", `${request.observation} would start work while phase2PlanInstances is off`);
      }

      const row = findPlanRow(snapshot, intent.planId);
      if (row === null) return refuse("launch.plan-unavailable", `plan ${intent.planId} left the workflow snapshot`);
      const prepared = preparedOf(row);
      if (prepared === null || prepared.assignment_sha256 !== intent.preparedHash) {
        return refuse(
          "launch.prepared-hash-drift",
          `plan ${intent.planId} is no longer prepared from the Assignment this launch was reserved for`,
        );
      }
      const drift = assertPreparedHash(prepared, intent.planId);
      if (drift !== null) return drift;

      const availability = assertPlanAvailable(row, intent.planId);
      if (availability !== null) {
        return refuse("launch.plan-occupied", `plan ${intent.planId} is no longer free for this launch: ${availability.message}`);
      }

      const occupancy = occupancyOf(snapshot, doc.intents);
      if (occupancy.size > settings.value.maxPlanInstances) {
        return refuse(
          "launch.capacity-exceeded",
          `${occupancy.size} plan primaries are pending or active (${[...occupancy].join(", ")}) against maxPlanInstances ${settings.value.maxPlanInstances}; the existing intents are left untouched`,
        );
      }
    }

    const evidencePaths = intent.evidencePaths.includes(request.evidencePath)
      ? intent.evidencePaths
      : [...intent.evidencePaths, request.evidencePath];
    const next: LaunchIntent = {
      ...intent,
      state: request.observation,
      ...(request.target !== undefined ? { target: request.target } : {}),
      evidencePaths,
    };
    writeJson<JournalDoc>(journalPath, {
      ...doc,
      intents: doc.intents.map((entry) => (entry.id === intent.id ? next : entry)),
    });
    return { ok: true, intent: next, applied: true };
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
