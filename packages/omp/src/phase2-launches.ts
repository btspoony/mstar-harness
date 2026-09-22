/**
 * Phase-2 launch admission — the local transport-intent journal for extra
 * plan-scoped primary sessions.
 *
 * Primary spec: `mstar-host/references/omp.md` § Phase-2 plan instances (capacity,
 * reservation and recovery, and the skill-driven transport boundary). This module owns exactly one file —
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
 * 1. Resume the caller's own `ExecutionBinding` against the CURRENT DB
 *    authority (`resumeExecutionSession`) — the reference is a lookup, not a
 *    bearer credential: a foreign root, a stale epoch, a copy of another
 *    session's reference or an inactive row refuses, and no pre-activation file
 *    envelope is ever consulted as a fallback. The workflow's own authority then
 *    has to name this session as its bound coordinator: a plan session, another
 *    workflow's session or a replacement holder cannot touch this workflow's
 *    journal.
 * 2. Hold the §4.3 file lock ladder **once**: the maintenance exclusion, then
 *    the canonical workflow status lock. The journal sits in the same canonical
 *    workflow directory as `snapshot.json`, so `withStatusWriteLock(snapshotPath)`
 *    IS the canonical snapshot → journal critical section (a nested acquisition
 *    on the same lockdir is the documented reentrancy bug, never a second lock).
 *    No SQL statement, host spawn or ledger append ever runs inside it.
 * 3. Inside the lock, reread the journal, then the live settings, and admit
 *    against those reads; the journal is written last, through the engine's
 *    atomic `writeJson`, after `assertExecutionSessionCurrent` has re-checked the
 *    bound store/session/epoch synchronously. The journal is the only document
 *    this module ever writes, and reading an old one is not writing it.
 *
 * Capacity is the union **by plan id** of outstanding (non-refused) intents and
 * active engine plan-primary bindings, so a plan that is both pending and bound
 * counts once and two asynchronous starts cannot both take the last slot. A
 * durable handoff (`submitted` / `accepted` / `integrating` / `merged` /
 * `completed`) releases a plan **only for the identity it actually belongs to**
 * — the row's own bound session, or an intent whose recorded plan, prepared
 * Assignment pin, launching coordinator, handing-off session and assigned
 * checkout all match. `returned` reactivates it, and a stale or foreign intent
 * is never silently reclaimed. An owner or epoch change keeps every unresolved
 * intent occupied: the new binding never drops a reservation and launches again,
 * and only recorded native transport evidence or explicit stopped-owner
 * reconciliation discharges it. Lowering the cap pauses further side-effecting
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
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertBranchAlignment,
  assertExecutionSessionCurrent,
  canonicalizeNearestExisting,
  executionContextFor,
  isDistinctCheckout,
  probeCheckoutRoot,
  readExecutionAuthority,
  readMainWorktree,
  resolveWorkflowDir,
  resumeExecutionSession,
  storeDbPath,
  withStatusWriteLock,
  writeJson,
} from "@mstar-harness/engine";
import type {
  ExecutionBinding,
  ExecutionIdentity,
  ExecutionPlanView,
  ExecutionRead,
  ExecutionSessionRef,
  ExecutionState,
  ExecutionToken,
} from "@mstar-harness/engine";
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

/**
 * The journal's own owner block (§6): the store/epoch/native session that wrote
 * the document. It is provenance, never authority — the current authority is
 * always the DB binding the call resumed, and an owner change keeps every
 * unresolved intent occupied instead of handing the journal over silently.
 */
type JournalOwner = { storeId: string; epoch: number; sessionId: string; workflowId: string };

/** The exact version-1 document this v2 journal was adopted from, as retained provenance. */
type LegacyJournal = { version: 1; file_sha256: string; coordinator: { session_id: string; session_file: string } };

/** Plugin-owned journal document v2: the owner, an optional v1 adoption record, and intent entries. */
type JournalDoc = {
  version: 2;
  workflow_id: string;
  owner: JournalOwner;
  legacy?: LegacyJournal;
  intents: LaunchIntent[];
};

/** One admitted journal document: the v2 form, or the v1 form still awaiting adoption. */
type JournalRead = { doc: JournalDoc } | { legacy: { doc: LegacyDocument; sha256: string } };

/** The version-1 shape as read: validated before it is ever rewritten. */
type LegacyDocument = {
  version: 1;
  workflow_id: string;
  coordinator: { session_id: string; session_file: string };
  intents: LaunchIntent[];
};

type LaunchState = LaunchIntent["state"];
type LaunchObservation = Extract<Phase2Request, { operation: "record-launch" }>["observation"];
type ReserveRequest = Extract<Phase2Request, { operation: "reserve-launch" }>;
type RecordRequest = Extract<Phase2Request, { operation: "record-launch" }>;

/**
 * §6 the launch authority: the caller's own cwd, the identity it acquired from
 * the native session, and the `ExecutionBinding` that identity adopted. Model
 * input never reaches this object — the host adapter builds it.
 */
export type ExecutionLaunchAuthority = Readonly<{
  cwd: string;
  identity: ExecutionIdentity;
  binding: ExecutionBinding;
}>;

/** Result of both journal calls (spec §C): a persisted intent, or a refusal. */
export type PlanLaunchResult =
  | { ok: true; intent: LaunchIntent; applied: boolean }
  | { ok: false; code: string; message: string };

/** A refusal that pre-empts the rest of the admission path, or `null` when it passes. */
type Refusal = { ok: false; code: string; message: string } | null;

const JOURNAL_FILE = "omp-launches.json";
const WORKFLOW_SNAPSHOT_FILE = "snapshot.json";
/** The version this module writes (§6 `omp-launch-v2`). */
const JOURNAL_VERSION = 2;
/** The pre-activation generation it adopts, retained with the old bytes' digest. */
const LEGACY_JOURNAL_VERSION = 1;

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

function validateAuthority(authority: ExecutionLaunchAuthority): Refusal {
  if (!nonEmpty(authority?.cwd) || !isAbsolute(authority.cwd)) {
    return refuse("launch.invalid-request", "authority requires an absolute cwd");
  }
  const identity = authority?.identity;
  if (
    identity === undefined ||
    !nonEmpty(identity.sessionId) ||
    !nonEmpty(identity.workflowId) ||
    identity.role !== "coordinator" ||
    identity.planId !== null
  ) {
    return refuse(
      "launch.invalid-request",
      "authority requires the host-acquired coordinator identity (a native session id, the workflow, role coordinator and no plan) \u2014 it is never taken from the request",
    );
  }
  const binding = authority?.binding;
  if (binding === undefined || binding.version !== 1 || !nonEmpty(binding.harnessRoot) || !isAbsolute(binding.harnessRoot)) {
    return refuse(
      "launch.invalid-request",
      "authority requires an adopted ExecutionBinding carrying the canonical control root it was adopted from",
    );
  }
  const session = binding.session;
  // A copy-only reference never matches the independently acquired identity: the
  // binding must describe exactly the session this call acquired, so a reference
  // copied from another session, workflow, role or plan refuses here — before any
  // store, snapshot or journal is touched.
  if (
    !nonEmpty(session?.storeId) ||
    session.workflowId !== identity.workflowId ||
    session.role !== identity.role ||
    session.sessionId !== identity.sessionId ||
    session.planId !== identity.planId ||
    typeof session.epoch !== "number" ||
    !Number.isSafeInteger(session.epoch) ||
    session.epoch <= 0
  ) {
    return refuse(
      "launch.invalid-request",
      "the adopted binding does not describe the identity this call acquired; a foreign, copied or malformed reference is refused before any store or file is read",
    );
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Caller identity, workflow resolution and the current authority
 * ------------------------------------------------------------------------- */

type ResolvedAuthority = {
  workflowId: string;
  harnessRoot: string;
  snapshotPath: string;
  journalPath: string;
};

/**
 * Pure path resolution for the call: the canonical control root of the adopted
 * binding and the lifecycle's canonical workflow directory, which the status
 * lock and the journal both live in. No store, envelope or snapshot is read
 * here — the workflow directory is a path, never an authority.
 */
function resolveAuthority(
  authority: ExecutionLaunchAuthority,
): { ok: true; value: ResolvedAuthority } | { ok: false; code: string; message: string } {
  const harnessRoot = canonicalizeNearestExisting(authority.binding.harnessRoot);
  let workflowDir: string;
  try {
    workflowDir = join(resolveWorkflowDir(authority.cwd, { harnessDir: harnessRoot }), authority.identity.workflowId);
  } catch (error) {
    return refuse(
      "launch.harness-unresolvable",
      `the control root ${harnessRoot} does not resolve a workflow dir from ${authority.cwd}: ${messageOf(error)}`,
    );
  }
  return {
    ok: true,
    value: {
      workflowId: authority.identity.workflowId,
      harnessRoot,
      snapshotPath: join(workflowDir, WORKFLOW_SNAPSHOT_FILE),
      journalPath: join(workflowDir, JOURNAL_FILE),
    },
  };
}

/** The engine context of this acquired identity: the store address plus the trusted caller. */
function executionContextOf(authority: ExecutionLaunchAuthority) {
  return executionContextFor({ harnessDir: authority.binding.harnessRoot }, authority.identity);
}

/** The stable engine refusal code of a thrown error, or the caller's own default. */
function engineCodeOf(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.includes(".") ? code : fallback;
}

/**
 * Resume the adopted binding against the CURRENT store. The reference is a
 * lookup, not a bearer credential: a foreign control root, a stale epoch, a
 * revoked/suspended row or a caller that is not the reference refuses here, and
 * no coordinator session envelope is ever consulted as a fallback.
 */
async function resumeCurrentAuthority(authority: ExecutionLaunchAuthority): Promise<Refusal> {
  try {
    await resumeExecutionSession(executionContextOf(authority), authority.binding.session);
  } catch (error) {
    return refuse(
      engineCodeOf(error, "launch.session-denied"),
      `the adopted execution binding no longer authorizes this call: ${messageOf(error)}`,
    );
  }
  return null;
}

/**
 * The workflow's DB authority, reduced to the facts this module admits against:
 * the lifecycle's status/phase, its integration checkout, its plan views and the
 * session that currently holds the coordinator seat.
 */
type ActiveWorkflow = Readonly<{
  status: string;
  phase: string | null | undefined;
  integrationWorktreePath: string | undefined;
  plans: readonly ExecutionPlanView[];
  coordinator: ExecutionSessionRef | null;
  workflowToken: ExecutionToken;
}>;

async function readActiveWorkflow(
  resolved: ResolvedAuthority,
): Promise<{ ok: true; workflow: ActiveWorkflow } | { ok: false; code: string; message: string }> {
  let read: ExecutionRead<ExecutionState | ExecutionPlanView>;
  try {
    read = await readExecutionAuthority({ harnessDir: resolved.harnessRoot }, { workflowId: resolved.workflowId });
  } catch (error) {
    return refuse(
      engineCodeOf(error, "launch.authority-unreadable"),
      `the execution authority of ${resolved.harnessRoot} cannot serve workflow ${resolved.workflowId}: ${messageOf(error)}`,
    );
  }
  const workflow = "workflows" in read.data ? read.data.workflows[0] : undefined;
  if (workflow === undefined) {
    return refuse(
      "coordination.workflow-not-found",
      `the execution authority read of workflow ${resolved.workflowId} returned no active lifecycle; nothing was admitted`,
    );
  }
  return {
    ok: true,
    workflow: {
      status: workflow.state.status,
      phase: workflow.state.phase,
      integrationWorktreePath: workflow.state.integration_worktree_path,
      plans: workflow.plans,
      coordinator: workflow.coordinator,
      workflowToken: workflow.workflowToken,
    },
  };
}

/**
 * The caller must be exactly the workflow's bound coordinator, in the exact
 * accepted Phase-2 state. Anything else (another holder, a non-running
 * lifecycle, a drifted or absent phase projection) disables admission.
 */
function assertOwnCoordinator(identity: ExecutionIdentity, workflow: ActiveWorkflow): Refusal {
  const coordinator = workflow.coordinator;
  if (coordinator === null || coordinator.sessionId !== identity.sessionId) {
    return refuse(
      "launch.session-denied",
      `workflow ${identity.workflowId} is bound to coordinator session ${coordinator?.sessionId ?? "(none)"}, not to this session ${identity.sessionId}`,
    );
  }
  if (workflow.status !== "running" || workflow.phase !== PHASE_2_EXECUTE) {
    return refuse(
      "launch.phase-inactive",
      `workflow ${identity.workflowId} is ${workflow.status} at phase ${JSON.stringify(workflow.phase ?? null)}; extra primaries require "${PHASE_2_EXECUTE}"`,
    );
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Journal read (fail-closed reconstruction)
 * ------------------------------------------------------------------------- */

function emptyJournal(workflowId: string, owner: JournalOwner): JournalDoc {
  return { version: JOURNAL_VERSION, workflow_id: workflowId, owner, intents: [] };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLaunchIntent(value: unknown): value is LaunchIntent {
  if (!isPlainRecord(value)) return false;
  const entry = value;
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

function intentsOf(value: unknown): LaunchIntent[] | null {
  return Array.isArray(value) && value.every(isLaunchIntent) ? value : null;
}

/** The owner block of a version-2 journal, or `null` when it is not one. */
function ownerOf(value: unknown): JournalOwner | null {
  if (!isPlainRecord(value)) return null;
  const { storeId, epoch, sessionId, workflowId } = value;
  if (!nonEmpty(storeId) || !nonEmpty(sessionId) || !nonEmpty(workflowId)) return null;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0) return null;
  return { storeId, epoch, sessionId, workflowId };
}

/** The retained version-1 provenance block, or `null` when it is malformed. */
function legacyOf(value: unknown): LegacyJournal | null {
  if (!isPlainRecord(value)) return null;
  const coordinator = value.coordinator;
  if (!nonEmpty(value.file_sha256) || !isPlainRecord(coordinator)) return null;
  if (!nonEmpty(coordinator.session_id) || !nonEmpty(coordinator.session_file)) return null;
  if (value.version !== LEGACY_JOURNAL_VERSION) return null;
  return { version: LEGACY_JOURNAL_VERSION, file_sha256: value.file_sha256, coordinator: { session_id: coordinator.session_id, session_file: coordinator.session_file } };
}

/**
 * Read the journal, or refuse. A present-but-unparseable, foreign or malformed
 * journal is never silently reset — capacity decisions are made from these
 * entries, so an untrusted read must fail closed instead of widening the cap.
 *
 * A version-1 document is returned as the legacy form it is (with the digest of
 * its exact bytes) and is adopted into version 2 only when a legitimate write
 * happens: reading an old journal is not writing it, and its intents, states,
 * targets, evidence paths and coordinator provenance survive adoption verbatim.
 */
function readJournal(
  journalPath: string,
  workflowId: string,
  owner: JournalOwner,
): { ok: true; read: JournalRead } | { ok: false; code: string; message: string } {
  if (!existsSync(journalPath)) return { ok: true, read: { doc: emptyJournal(workflowId, owner) } };
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = readFileSync(journalPath);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return refuse("launch.journal-corrupt", `transport journal ${journalPath} is not readable JSON: ${messageOf(error)}`);
  }
  if (!isPlainRecord(parsed)) {
    return refuse("launch.journal-corrupt", `transport journal ${journalPath} must be an object`);
  }
  if (parsed.workflow_id !== workflowId) {
    return refuse(
      "launch.journal-corrupt",
      `transport journal ${journalPath} belongs to workflow ${JSON.stringify(parsed.workflow_id)}, not ${workflowId}`,
    );
  }
  const intents = intentsOf(parsed.intents);
  if (intents === null) {
    return refuse("launch.journal-corrupt", `transport journal ${journalPath} carries entries this plugin cannot trust`);
  }
  if (parsed.version === JOURNAL_VERSION) {
    const journalOwner = ownerOf(parsed.owner);
    if (journalOwner === null) {
      return refuse("launch.journal-corrupt", `transport journal ${journalPath} declares no valid owner block`);
    }
    const legacy = parsed.legacy === undefined ? undefined : legacyOf(parsed.legacy);
    if (parsed.legacy !== undefined && legacy === null) {
      return refuse("launch.journal-corrupt", `transport journal ${journalPath} carries a malformed legacy adoption record`);
    }
    return { ok: true, read: { doc: { version: JOURNAL_VERSION, workflow_id: workflowId, owner: journalOwner, ...(legacy === null || legacy === undefined ? {} : { legacy }), intents } } };
  }
  if (parsed.version === LEGACY_JOURNAL_VERSION) {
    const coordinator = parsed.coordinator;
    if (!isPlainRecord(coordinator) || !nonEmpty(coordinator.session_id) || !nonEmpty(coordinator.session_file)) {
      return refuse("launch.journal-corrupt", `transport journal ${journalPath} declares no recorded coordinator provenance`);
    }
    return {
      ok: true,
      read: {
        legacy: {
          doc: {
            version: LEGACY_JOURNAL_VERSION,
            workflow_id: workflowId,
            coordinator: { session_id: coordinator.session_id, session_file: coordinator.session_file },
            intents,
          },
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
    };
  }
  return refuse(
    "launch.journal-corrupt",
    `transport journal ${journalPath} declares version ${JSON.stringify(parsed.version)}; this reader understands version ${JOURNAL_VERSION} and the legacy version ${LEGACY_JOURNAL_VERSION} it adopts`,
  );
}

/**
 * The document to write: an already-current journal as it stands, or a legacy
 * one adopted under the current owner with its exact bytes' digest and its
 * coordinator provenance retained.
 */
function adoptedJournal(read: JournalRead, owner: JournalOwner, workflowId: string): JournalDoc {
  if ("doc" in read) return read.doc;
  return {
    version: JOURNAL_VERSION,
    workflow_id: workflowId,
    owner,
    legacy: { version: LEGACY_JOURNAL_VERSION, file_sha256: read.legacy.sha256, coordinator: read.legacy.doc.coordinator },
    intents: read.legacy.doc.intents,
  };
}

/* ------------------------------------------------------------------------- *
 * Occupancy (union by plan id: outstanding intents ∪ active engine bindings)
 * ------------------------------------------------------------------------- */

function planIdOf(view: ExecutionPlanView): string | null {
  if (nonEmpty(view.plan.id)) return view.plan.id;
  if (nonEmpty(view.plan.plan_id)) return view.plan.plan_id;
  return null;
}

function findPlanView(workflow: ActiveWorkflow, planId: string): ExecutionPlanView | null {
  for (const view of workflow.plans) if (planIdOf(view) === planId) return view;
  return null;
}

/** The view's coordination block, or null when absent/malformed. */
function rowCoordinationOf(view: ExecutionPlanView): Record<string, unknown> | null {
  return isPlainRecord(view.coordination) ? view.coordination : null;
}

/** The view's persisted durable handoff record, or null when absent/non-durable. */
function durableHandoffOf(view: ExecutionPlanView): Record<string, unknown> | null {
  const handoff = rowCoordinationOf(view)?.handoff;
  if (!isPlainRecord(handoff)) return null;
  return typeof handoff.state === "string" && DURABLE_HANDOFF_STATES[handoff.state] === true ? handoff : null;
}

/** The plan session the store currently binds this row to, or null when it binds none. */
function boundSessionOf(view: ExecutionPlanView): ExecutionSessionRef | null {
  return view.session;
}

/** Real bound plan session plus the execution lease held by that same session. */
function hasActiveBinding(view: ExecutionPlanView): boolean {
  const session = boundSessionOf(view);
  return session !== null && view.executionLease !== null && view.executionLease.holder === session.sessionId;
}

/**
 * True only when this row's OWN durable handoff proves its bound plan session
 * reached the scoped stop: the handoff was submitted by exactly the session the
 * row is bound to. An unbound or foreign handoff proves nothing and keeps the
 * row occupied.
 */
function boundSessionReachedStop(view: ExecutionPlanView): boolean {
  const handoff = durableHandoffOf(view);
  const session = boundSessionOf(view);
  return handoff !== null && session !== null && handoff.submitted_by === session.sessionId;
}

/**
 * True only when a durable handoff by THIS launch's child proves the intent
 * reached its scoped stop. Identity is matched term by term — plan row,
 * prepared Assignment pin, the launching coordinator, the bound plan session
 * that handed off, and the launch's own assigned checkout. Any mismatch
 * (prepared-hash drift, another session, another attempt, another worktree, a
 * coordinator that has since been replaced) is NOT a release: the intent keeps
 * occupying its slot until a durable handoff matches or an explicit observation
 * discharges it.
 */
function intentReachedStop(workflow: ActiveWorkflow, intent: LaunchIntent): boolean {
  const view = findPlanView(workflow, intent.planId);
  if (view === null) return false;
  if (workflow.coordinator === null || workflow.coordinator.sessionId !== intent.coordinatorSessionId) return false;
  const prepared = preparedOf(view);
  if (prepared === null || prepared.assignment_sha256 !== intent.preparedHash) return false;
  const handoff = durableHandoffOf(view);
  const session = boundSessionOf(view);
  if (handoff === null || session === null) return false;
  if (handoff.submitted_by !== session.sessionId) return false;
  return handoff.worktree_path === intent.worktreePath;
}

/**
 * Occupancy set: each plan id counted once, whether it is pending in the journal
 * or bound in the engine. `refused` intents never occupy (the refusal proved no
 * process/prompt exists). A durable handoff releases the plan only for the
 * identity it actually belongs to: the row's own binding, or an intent whose
 * recorded plan/prepared pin/coordinator/session-checkout identity matches that
 * handoff. A stale or foreign intent is never silently reclaimed.
 */
function occupancyOf(workflow: ActiveWorkflow, intents: readonly LaunchIntent[]): Set<string> {
  const occupied = new Set<string>();
  for (const view of workflow.plans) {
    const planId = planIdOf(view);
    if (planId === null) continue;
    if (hasActiveBinding(view) && !boundSessionReachedStop(view)) occupied.add(planId);
  }
  for (const intent of intents) {
    if (intent.state === "refused" || intentReachedStop(workflow, intent)) continue;
    occupied.add(intent.planId);
  }
  return occupied;
}

/* ------------------------------------------------------------------------- *
 * Independent-prepared-plan admission (spec §C reserve prerequisites)
 * ------------------------------------------------------------------------- */

function preparedOf(view: ExecutionPlanView): Record<string, unknown> | null {
  const prepared = rowCoordinationOf(view)?.prepared;
  return isPlainRecord(prepared) ? prepared : null;
}

/** The plan row must be an unstarted, unowned, unbound coordinator-prepared row. */
function assertPlanAvailable(view: ExecutionPlanView, planId: string): Refusal {
  const status = view.plan.status;
  if (status !== "Todo" && status !== "Blocked") {
    return refuse("launch.plan-unavailable", `plan ${planId} is ${JSON.stringify(status ?? null)}; only a Todo/Blocked plan is launchable`);
  }
  if (view.session !== null) {
    return refuse("launch.plan-unavailable", `plan ${planId} is already bound to a plan session`);
  }
  if (rowCoordinationOf(view)?.handoff !== undefined) {
    return refuse("launch.plan-unavailable", `plan ${planId} carries a handoff record; a launched plan has not handed off yet`);
  }
  if (view.executionLease !== null) {
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
 * The plan scope a launch admits against, taken entirely from the DB plan view:
 * the row's own worktree/branch metadata (the same fields `planLeaseScope`
 * requires of any bindable plan) plus the prepared Assignment pin. Nothing here
 * reads the retired workflow snapshot — on an ACTIVE root that file is refused
 * as a source outright, so a snapshot-reading resolver cannot serve this route.
 */
type LaunchScope = Readonly<{ assignmentPath: string; worktreePath: string; workingBranch: string }>;

function launchScopeOf(
  view: ExecutionPlanView,
  prepared: Record<string, unknown>,
  planId: string,
): { ok: true; scope: LaunchScope } | { ok: false; code: string; message: string } {
  const metadata = isPlainRecord(view.plan.metadata) ? view.plan.metadata : null;
  const worktreePath = metadata?.worktree_path;
  const workingBranch = metadata?.working_branch;
  if (!nonEmpty(worktreePath) || !isAbsolute(worktreePath) || !nonEmpty(workingBranch)) {
    return {
      ok: false,
      code: "launch.plan-unavailable",
      message:
        `plan ${planId} records no plan worktree/branch scope (metadata.worktree_path must be an absolute path and ` +
        `metadata.working_branch a non-empty branch), so no launch can be admitted for it`,
    };
  }
  return { ok: true, scope: { assignmentPath: prepared.assignment_path as string, worktreePath, workingBranch } };
}
/**
 * The assigned worktree must be an existing, canonical, distinct feature
 * checkout of the same repository, on the plan row's recorded branch — and
 * never the lifecycle's integration checkout (spec §C).
 */
function assertLaunchWorktree(scope: LaunchScope, authority: ExecutionLaunchAuthority, workflow: ActiveWorkflow): Refusal {
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

  const integration = workflow.integrationWorktreePath;
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
 * File-lock ladder (§4.3)
 * ------------------------------------------------------------------------- */

/** Bounded wait for the maintenance exclusion; the engine's own test override decides the test window. */
function maintenanceLockWaitMs(): number {
  if (process.env.MSTAR_STORE_TEST_RUNNER === "1") {
    const parsed = Number.parseInt(process.env.MSTAR_EXECUTION_MIGRATION_LOCK_WAIT_MS ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 30_000;
}

/**
 * The §4.3 maintenance exclusion every cooperative file writer takes BEFORE the
 * workflow lock. The key is computed from the engine's own `storeDbPath`, so it
 * is byte-identical to the key the migration/retire/restore ladder takes and
 * cannot drift from it. Holding it is not a claim about any host process: it
 * only keeps this journal write out of an activation/restore window.
 */
function withMaintenanceExclusion<T>(harnessRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = join(dirname(storeDbPath({ harnessDir: harnessRoot })), ".execution-maintenance", "execution-migration");
  mkdirSync(dirname(key), { recursive: true });
  return withStatusWriteLock(key, fn, { timeoutMs: maintenanceLockWaitMs() });
}

/**
 * §4.3 the final synchronous identity check immediately before the file commit:
 * the bound store/session/epoch is re-read under the held locks, so an epoch
 * change that landed while this call was admitting refuses instead of writing.
 */
function assertCurrentSessionSynchronously(authority: ExecutionLaunchAuthority): Refusal {
  try {
    assertExecutionSessionCurrent(executionContextOf(authority), authority.binding.session);
  } catch (error) {
    return refuse(
      engineCodeOf(error, "launch.session-denied"),
      `the execution binding stopped being current before the journal write: ${messageOf(error)}`,
    );
  }
  return null;
}

/**
 * The owner block this call would write (§6): its own store, epoch and native
 * session. Named apart from the journal reader's `ownerOf(value)` — the two take
 * different inputs, and a module-level name collision would silently hand the
 * parsed-owner decode a value it cannot read.
 */
function ownerFromAuthority(authority: ExecutionLaunchAuthority): JournalOwner {
  return {
    storeId: authority.binding.session.storeId,
    epoch: authority.binding.session.epoch,
    sessionId: authority.identity.sessionId,
    workflowId: authority.identity.workflowId,
  };
}

/* ------------------------------------------------------------------------- *
 * reserve-launch
 * ------------------------------------------------------------------------- */

export async function reservePlanLaunch(
  request: Extract<Phase2Request, { operation: "reserve-launch" }>,
  authority: ExecutionLaunchAuthority,
): Promise<PlanLaunchResult> {
  const invalid = validateAuthority(authority) ?? validateReserveRequest(request);
  if (invalid !== null) return invalid;

  const resolved = resolveAuthority(authority);
  if (resolved.ok === false) return resolved;
  const { workflowId, harnessRoot, snapshotPath, journalPath } = resolved.value;

  // §4.3: the resume and the workflow read happen BEFORE any lock, so no host
  // query or SQL statement is ever taken inside the file critical section.
  const stale = await resumeCurrentAuthority(authority);
  if (stale !== null) return stale;
  const active = await readActiveWorkflow(resolved.value);
  if (active.ok === false) return active;
  const workflow = active.workflow;

  const own = assertOwnCoordinator(authority.identity, workflow);
  if (own !== null) return own;

  const owner = ownerFromAuthority(authority);

  return withMaintenanceExclusion(harnessRoot, () =>
    withStatusWriteLock(snapshotPath, async () => {
      const journal = readJournal(journalPath, workflowId, owner);
      if (journal.ok === false) return journal;
      // Reading an old journal is not writing it: adoption happens here, as part
      // of a legitimate write, and keeps every intent and its provenance.
      const doc = adoptedJournal(journal.read, owner, workflowId);

      const planId = request.planId;
      const view = findPlanView(workflow, planId);
      if (view === null) return refuse("launch.plan-not-found", `workflow ${workflowId} has no plan row ${planId}`);
      const prepared = preparedOf(view);
      if (prepared === null || !nonEmpty(prepared.assignment_sha256)) {
        return refuse("launch.plan-not-prepared", `plan ${planId} has no hash-pinned prepared Assignment`);
      }
      const preparedHash = prepared.assignment_sha256;

      // Duplicate identical request: the recorded intent is returned only after
      // the current authority was revalidated by the resume above, so a stale or
      // foreign caller never receives a reservation it no longer holds. Any other
      // outstanding intent for this plan is a duplicate owner and refuses.
      const live = doc.intents.filter(
        (entry) => entry.planId === planId && entry.state !== "refused" && !intentReachedStop(workflow, entry),
      );
      const identical = live.find((entry) => entry.preparedHash === preparedHash);
      if (identical !== undefined) return { ok: true, intent: identical, applied: false };
      if (live.length > 0) {
        return refuse(
          "launch.plan-occupied",
          `plan ${planId} already has an outstanding launch intent ${live[0]!.id} (${live[0]!.state}); an uncertain or pre-bind intent needs a durable handoff or explicit human recovery`,
        );
      }

      const available = assertPlanAvailable(view, planId);
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

      // The scope comes from the DB plan view (§6): the row's own
      // worktree/branch metadata plus the prepared pin validated above. The
      // retired-snapshot resolver is NOT used — on an ACTIVE root the snapshot is
      // refused as a source (`execution.consumer-not-ready`), so a
      // snapshot-reading resolver cannot serve this route at all.
      const scoped = launchScopeOf(view, prepared, planId);
      if (scoped.ok === false) return scoped;
      const scope = scoped.scope;

      const worktree = assertLaunchWorktree(scope, authority, workflow);
      if (worktree !== null) return worktree;

      const capability = assertTransportCapability(request);
      if (capability !== null) return capability;

      const occupancy = occupancyOf(workflow, doc.intents);
      if (occupancy.size + 1 > settings.value.maxPlanInstances) {
        return refuse(
          "launch.capacity-exceeded",
          `${occupancy.size} plan primaries are already pending or active (${[...occupancy].join(", ") || "none"}); maxPlanInstances is ${settings.value.maxPlanInstances}`,
        );
      }

      const intent: LaunchIntent = {
        id: `phase2-launch:${planId}:${doc.intents.filter((entry) => entry.planId === planId).length + 1}`,
        workflowId,
        coordinatorSessionId: authority.identity.sessionId,
        planId,
        preparedHash,
        assignmentPath: scope.assignmentPath,
        worktreePath: scope.worktreePath,
        transport: request.transport,
        state: "reserved",
        evidencePaths: [],
      };
      const committed = assertCurrentSessionSynchronously(authority);
      if (committed !== null) return committed;
      writeJson<JournalDoc>(journalPath, { ...doc, owner, intents: [...doc.intents, intent] });
      return { ok: true, intent, applied: true };
    }),
  );
}

/* ------------------------------------------------------------------------- *
 * record-launch
 * ------------------------------------------------------------------------- */

export async function recordPlanLaunch(
  request: Extract<Phase2Request, { operation: "record-launch" }>,
  authority: ExecutionLaunchAuthority,
): Promise<PlanLaunchResult> {
  const invalid = validateAuthority(authority) ?? validateRecordRequest(request);
  if (invalid !== null) return invalid;

  const resolved = resolveAuthority(authority);
  if (resolved.ok === false) return resolved;
  const { workflowId, harnessRoot, snapshotPath, journalPath } = resolved.value;

  const stale = await resumeCurrentAuthority(authority);
  if (stale !== null) return stale;
  const active = await readActiveWorkflow(resolved.value);
  if (active.ok === false) return active;
  const workflow = active.workflow;

  const own = assertOwnCoordinator(authority.identity, workflow);
  if (own !== null) return own;

  const owner = ownerFromAuthority(authority);

  return withMaintenanceExclusion(harnessRoot, () =>
    withStatusWriteLock(snapshotPath, async () => {
      const journal = readJournal(journalPath, workflowId, owner);
      if (journal.ok === false) return journal;
      const doc = adoptedJournal(journal.read, owner, workflowId);

      const intent = doc.intents.find((entry) => entry.id === request.intentId);
      if (intent === undefined) {
        return refuse("launch.intent-not-found", `no launch intent ${request.intentId} in ${journalPath}`);
      }
      if (intent.workflowId !== workflowId) {
        return refuse("launch.session-denied", `launch intent ${intent.id} belongs to another workflow`);
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

      // A side-effecting observation authorizes a real process or prompt, so only
      // the coordinator that reserved THIS intent may record it. The observations
      // that merely report what the transport already did (`submitted`, `refused`,
      // `uncertain`) may be recorded by any coordinator currently bound to this
      // workflow: that is the recorded native transport evidence which discharges
      // an intent left behind by a replaced owner, and it is why an owner or
      // epoch change never has to drop a reservation.
      if (SIDE_EFFECTING_OBSERVATIONS[request.observation] === true && intent.coordinatorSessionId !== authority.identity.sessionId) {
        return refuse(
          "launch.session-denied",
          `launch intent ${intent.id} was reserved by coordinator session ${intent.coordinatorSessionId}; a ${request.observation} observation would start work, and only that reserving session may record it`,
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

        const view = findPlanView(workflow, intent.planId);
        if (view === null) return refuse("launch.plan-unavailable", `plan ${intent.planId} left the workflow`);
        const prepared = preparedOf(view);
        if (prepared === null || prepared.assignment_sha256 !== intent.preparedHash) {
          return refuse(
            "launch.prepared-hash-drift",
            `plan ${intent.planId} is no longer prepared from the Assignment this launch was reserved for`,
          );
        }
        const drift = assertPreparedHash(prepared, intent.planId);
        if (drift !== null) return drift;

        const availability = assertPlanAvailable(view, intent.planId);
        if (availability !== null) {
          return refuse("launch.plan-occupied", `plan ${intent.planId} is no longer free for this launch: ${availability.message}`);
        }

        const occupancy = occupancyOf(workflow, doc.intents);
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
      const committed = assertCurrentSessionSynchronously(authority);
      if (committed !== null) return committed;
      writeJson<JournalDoc>(journalPath, {
        ...doc,
        owner,
        intents: doc.intents.map((entry) => (entry.id === intent.id ? next : entry)),
      });
      return { ok: true, intent: next, applied: true };
    }),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
