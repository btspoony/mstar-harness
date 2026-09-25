/**
 * phase2-orchestration — omp extension: the native `mstar_phase2` tool and the
 * bounded host lifecycle adapter for Phase-2 opportunity reminders.
 *
 * Primary spec: `mstar-host/references/omp.md` § Phase-2 plan instances (native
 * observation, reminder event/latch and capacity/reservation). The two decisions this module consumes
 * live next to it and are not re-implemented here:
 *
 * - `./phase2-orchestration` (T1) owns the native settings decode and
 *   `decidePhase2Reminder`, the once-per-changed-state latch.
 * - `./phase2-launches` (T2) owns the transport-intent journal, capacity
 *   admission and the observed transport transitions.
 *
 * What this adapter adds is exactly the host half: one registered tool whose
 * operations are the frozen `Phase2Request` union, the identity pointer that
 * makes a call's authority come from the session rather than from the caller,
 * and an event wiring that samples the host's own async-job snapshot at
 * supported lifecycle boundaries.
 *
 * ## What the host actually offers (and what it does not)
 *
 * `ctx.getAsyncJobSnapshot()` returns `{ running, recent, delivery } | null`
 * for **this session's own** jobs; rows carry only
 * `id/type/status/label/startTime/agentId`, `recent` defaults to five rows and
 * is not a durable history, and there is no public job-settled event, no
 * review-result API and no cancellation of an already delivered notice. So:
 *
 * - `null` means "unavailable", never "no jobs" — an unavailable snapshot
 *   yields `snapshotAvailable: false` and therefore silence.
 * - A disappeared `recent` row is not a new opportunity.
 * - A job that settles is already covered by the host's own completion
 *   delivery to the owning session, which is why a newly observed terminal id
 *   *suppresses* the plugin advisory for that observation instead of
 *   duplicating its text.
 * - No `job_settled` event is fabricated, no timer or polling loop exists, and
 *   `session_stop` is deliberately not subscribed (the host already defers it
 *   for background completions).
 *
 * ## Authority comes from the session, never from the call
 *
 * `{operation:"bind"}` is the coordinator's first Phase-2 host action. It takes
 * the explicit workflow id and the coordinator's own session envelope, then
 * derives everything else from host and engine facts: the host session id from
 * `ctx.sessionManager`, the control harness root from the real envelope, the
 * workflow directory from the engine's own resolver under that root, and the
 * ownership/phase projection from the named snapshot. A leaf/task session
 * (`session_init` in its own ledger), a `plan-pm` envelope, an envelope naming
 * another workflow, and a snapshot bound to a different coordinator envelope
 * are all refused before anything is written. So is a caller that does not sit
 * in the main worktree or the recorded integration worktree — the engine's own
 * coordinator-residency rule, re-read read-only, which is what keeps an extra
 * primary running in its plan's feature checkout out of the coordinator's
 * observation.
 *
 * The engine's coordinator envelope id and the host's session id are different
 * identities (a CLI `plan bind --coordinator` adopts the explicitly supplied
 * `--session-id`, while the host-owned `mstar_coordinator` tool derives the
 * native id from the host), so the binding records **both**: the envelope path
 * is the engine-side ownership reference every later probe re-verifies against
 * the snapshot, and the host session id is the exact-session filter for the
 * ledger. What this does not
 * claim: it is not cryptographic proof that the caller is that host session —
 * the host exposes no attributed identity to extensions. The residency gate,
 * the task-session refusal and the envelope/snapshot agreement are the
 * available evidence; the boundary is disclosed rather than papered over.
 *
 * Only the identity pointer is persisted (`pi.appendEntry("mstar:phase2", …)`),
 * exact-session filtered on replay, so a forked session inherits no authority.
 * `bind` is plugin observation binding — not the engine's `plan bind` — and it
 * writes no credential, no engine row and no second status register. Every tool
 * call and every event re-reads **both halves of the ownership pair**: the bound
 * coordinator envelope at the recorded path (its `session_id` must still equal
 * the one recorded at bind time) and the named snapshot's coordinator identity,
 * plus the snapshot's lifecycle phase. A missing envelope, a same-path
 * replacement with a new engine session id, or a drifted snapshot marks this
 * instance's binding **not-current** — reminders stay silent and admission
 * refuses — and is never written as if the child had handed off. Rebinding with
 * the current envelope clears the mark. The accepted phase label is exactly
 * `phase-2-execute`; any other phase is inert with a bounded one-time diagnostic
 * rather than a guessed observation key.
 *
 * ## Lifecycle
 *
 * - `input` marks explicit steering and clears a recorded block.
 * - `agent_end` is the sole emission point: at most one `pi.sendMessage`
 *   advisory (`{triggerTurn:true, deliverAs:"followUp"}`) per **changed**
 *   observation, recorded with `appendEntry` before it is sent. Native-result
 *   coverage is sampled first, then those settled ids are marked consumed, so a
 *   tool-using turn cannot hide the jobs the host just delivered.
 * - session start/switch/branch/tree reconstruct from the ledger with the exact
 *   host session identity; `session_shutdown` invalidates the callback
 *   generation so a late asynchronous sample can never emit into a dead one.
 *
 * ## Execution authority (2b: the observation runs on the DB binding)
 *
 * The engine's route (`resolveExecutionReadRoute`, plan S2) decides which
 * authority answers, and the caller never selects one:
 *
 * - ACTIVE (`execution`): `bind` adopts this session's own DB coordinator
 *   binding (`ExecutionBinding`) after resuming it against the current
 *   store/epoch, and every later probe resumes that binding and reads the
 *   workflow's DB authority. The coordinator envelope and the workflow snapshot
 *   are retired here and are never opened — no fallback, and no synthesized
 *   identity.
 * - pre-activation (`files`): the file route still answers, so `bind` adopts the
 *   workflow's OWN recorded coordinator envelope (resolved from the snapshot by
 *   the host, never supplied by the call) and records a legacy binding. The §5
 *   readiness check refuses that arm outright the moment the authority becomes
 *   ACTIVE, and an active binding always supersedes a legacy record.
 *
 * A store that exists and cannot be read keeps its own refusal, and a harness
 * with no store at all keeps the unchanged file route (§2.1: absence is not an
 * authority verdict). `{operation:"export-history"}` is read-only evidence: one
 * carrying session's own hidden history bound to one workflow, canonical bytes
 * and digest returned to the caller, no file written and no authority granted.
 *
 * Not here, by contract: no process spawn, no screen parsing, no multiplexer
 * execution, no engine-row mutation, no lease release, no job-label plan
 * inference, no timer and no stop-loop continuation. The optional Herdr/tmux
 * transport is PM-executed skill work (plan T4); this module only admits and
 * records its intents through T2.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  WORKFLOW_TERMINAL_STATUSES,
  canonicalizeNearestExisting,
  executionContextFor,
  probeCheckoutRoot,
  readExecutionAuthority,
  readMainWorktree,
  readSessionEnvelope,
  readWorkflowSnapshot,
  resolveExecutionReadRoute,
  resolveHarnessDir,
  resumeExecutionSession,
  resolveWorkflowDir,
  serializeExecutionValue,
} from "@mstar-harness/engine";
import type {
  CoordinationSession,
  ExecutionBinding,
  ExecutionIdentity,
  ExecutionPlanView,
  ExecutionRead,
  ExecutionState,
  PlanRow,
  WorkflowSnapshot,
} from "@mstar-harness/engine";
import {
  decidePhase2Reminder,
  readPhase2Settings,
  type CheckpointReason,
  type Phase2Observation,
  type Phase2Request,
  type ReminderState,
} from "../phase2-orchestration";
import { recordPlanLaunch, reservePlanLaunch, type ExecutionLaunchAuthority, type PlanLaunchResult } from "../phase2-launches";
import { executionBindingOf } from "../coordinator-identity";
import {
  buildExecutionHostInventory,
  exportExecutionHostInventory,
  inventoryDigest,
  type ExecutionHostInventory,
} from "../execution-host-inventory";
import { PHASE2_NOTICE_CUSTOM_TYPE, fallbackNotice, formatNotice, statusNotice } from "../notices";

/** Ledger `customType` of this feature's decision records (the only writer). */
export const PHASE2_CUSTOM_TYPE = "mstar:phase2";
/** `customType` of the bounded Phase-2 advisory (`agent_end`, triggerTurn+followUp). */
export const PHASE2_ADVISORY_CUSTOM_TYPE = "mstar:advisory";
/** `customType` of a bounded diagnostic notice — informational, never a continuation. */
export { PHASE2_NOTICE_CUSTOM_TYPE };
/** The exact accepted engine phase label for "this coordinator is executing Phase 2". */
export const PHASE2_PHASE = "phase-2-execute";
/** The single tool this extension registers (never an activation command). */
const TOOL_NAME = "mstar_phase2";
/** Record schema version of the decision records; bumped only by a deliberate migration. */
const RECORD_VERSION = 1;
/** Record schema version of the ACTIVE observation binding (the §3.1 `ExecutionBinding` generation). */
const BIND_RECORD_VERSION = 2;
/** The pre-activation binding generation, kept readable as legacy history. */
const LEGACY_BIND_RECORD_VERSION = 1;
/** Plugin-owned transport journal written by T2 (`phase2-launches.ts`). */
const JOURNAL_FILE = "omp-launches.json";

/** The advisory body: a pointer to the shared checkpoint, and nothing more. */
const ADVISORY_TEXT = [
  "Phase-2 opportunity reminder: run the shared rescheduling checkpoint",
  "(mstar-iteration/references/phase-2-worktree-lease.md §2.4) and honor any blocker before dispatching.",
  "This is an observation, not a dispatch: it asserts nothing about any plan being ready.",
].join(" ");

/* ------------------------------------------------------------------------- *
 * Durable records (session ledger only — never a second status register)
 * ------------------------------------------------------------------------- */

/**
 * The durable observation binding as this cutover writes it (§6): the session's
 * own `ExecutionBinding`, adopted from the DB session authority. It carries the
 * engine session reference and the canonical control root it was adopted from —
 * never a session envelope path, and never a caller-supplied identity.
 */
export type Phase2BindingRecord = Readonly<{
  version: 2;
  kind: "bind";
  workflowId: string;
  hostSessionId: string;
  executionBinding: ExecutionBinding;
}>;

/**
 * The pre-activation bind record (prerequisite contract §3.2), kept readable as
 * legacy history: it names a coordinator session ENVELOPE, which is exactly the
 * retired transport. It is never written again, never upgraded into a DB
 * binding, and never consulted while an active binding answers.
 */
export type Phase2LegacyBindingRecord = Readonly<{
  version: 1;
  kind: "bind";
  workflowId: string;
  hostSessionId: string;
  coordinatorSessionPath: string;
  coordinatorSessionId: string;
  harnessRoot: string;
}>;

export type Phase2CheckpointRecord = Readonly<{
  version: 1;
  kind: "checkpoint";
  hostSessionId: string;
  workflowId: string;
  reason: CheckpointReason;
  decision: "dispatched" | "wait" | "blocked";
  note: string;
  /** The runtime-attached key of the sample this checkpoint was taken against; `null` when no sample was available. */
  observationKey: string | null;
}>;

export type Phase2ReminderRecord = Readonly<{
  version: 1;
  kind: "reminder";
  hostSessionId: string;
  workflowId: string;
  observationKey: string;
}>;

/** An explicit user turn: the one thing besides a PM checkpoint that clears a recorded block. */
export type Phase2TurnRecord = Readonly<{
  version: 1;
  kind: "user-turn";
  hostSessionId: string;
  workflowId: string;
}>;

export type Phase2Record =
  | Phase2BindingRecord
  | Phase2LegacyBindingRecord
  | Phase2CheckpointRecord
  | Phase2ReminderRecord
  | Phase2TurnRecord;

export type Phase2SessionState = Readonly<{
  /** The session's own ACTIVE binding, or `null` when it never adopted one. */
  binding: Phase2BindingRecord | null;
  /** The pre-activation envelope binding of this session: history only, used only while no active binding exists. */
  legacy: Phase2LegacyBindingRecord | null;
  reminder: ReminderState;
}>;

const CHECKPOINT_REASONS: readonly CheckpointReason[] = [
  "before-wait",
  "result-settled",
  "dependency-changed",
  "ownership-changed",
  "capacity-changed",
];

const CHECKPOINT_DECISIONS = ["dispatched", "wait", "blocked"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** The stable engine refusal code of a thrown error, or this adapter's own default. */
function engineCodeOf(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.includes(".") ? code : fallback;
}

/**
 * Structural guard for the §3.1 binding value a record persists. Its rules are
 * the engine's own reference shape (`execution-session.ts` `assertRefShape`),
 * including the **cross-field** role pairing — a `coordinator` reference carries
 * a null plan id and a `plan-pm` reference a non-empty one — so an "ACTIVE"
 * binding this guard admits is one the engine could actually accept; a record
 * whose declared pairing is impossible is history, not a binding.
 */
function isExecutionBinding(value: unknown): value is ExecutionBinding {
  if (!isPlainObject(value) || value.version !== 1 || !isNonEmptyString(value.harnessRoot)) return false;
  const session = value.session;
  if (!isPlainObject(session)) return false;
  if (!isNonEmptyString(session.storeId) || !isNonEmptyString(session.sessionId) || !isNonEmptyString(session.workflowId)) return false;
  if (session.role === "coordinator" && session.planId !== null) return false;
  if (session.role === "plan-pm" && !isNonEmptyString(session.planId)) return false;
  if (session.role !== "coordinator" && session.role !== "plan-pm") return false;
  return typeof session.epoch === "number" && Number.isSafeInteger(session.epoch) && session.epoch > 0;
}

/** Structural guard for a record read back from the ledger (`data` is `unknown`). */
function isPhase2Record(value: unknown): value is Phase2Record {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.hostSessionId) || !isNonEmptyString(value.workflowId)) return false;
  switch (value.kind) {
    case "bind":
      // Two generations share the kind: the active binding this cutover writes,
      // and the pre-activation envelope record kept readable as history.
      if (value.version === BIND_RECORD_VERSION) return isExecutionBinding(value.executionBinding);
      return (
        value.version === LEGACY_BIND_RECORD_VERSION &&
        isNonEmptyString(value.coordinatorSessionPath) &&
        isNonEmptyString(value.coordinatorSessionId) &&
        isNonEmptyString(value.harnessRoot)
      );
    case "checkpoint":
      return (
        value.version === RECORD_VERSION &&
        CHECKPOINT_REASONS.includes(value.reason as CheckpointReason) &&
        (CHECKPOINT_DECISIONS as readonly unknown[]).includes(value.decision) &&
        typeof value.note === "string" &&
        (value.observationKey === null || isNonEmptyString(value.observationKey))
      );
    case "reminder":
      return value.version === RECORD_VERSION && isNonEmptyString(value.observationKey);
    case "user-turn":
      return value.version === RECORD_VERSION;
    default:
      return false;
  }
}

/**
 * Every durable record written for **this** session, in recorded ledger order.
 * The session-id filter is exact: a fork copies its parent's entries into a new
 * session file, and those records must not be mistaken for this session's
 * binding or latch.
 */
export function readPhase2Records(entries: readonly SessionEntry[], sessionId: string): readonly Phase2Record[] {
  const records: Phase2Record[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PHASE2_CUSTOM_TYPE) continue;
    if (!isPhase2Record(entry.data)) continue;
    if (entry.data.hostSessionId !== sessionId) continue;
    records.push(entry.data);
  }
  return records;
}

/**
 * Replay this session's durable state: the newest binding plus the reminder
 * latch that belongs to it. Only records written **after** that binding are
 * counted — a rebind (a new coordinator envelope for the same workflow) starts a
 * fresh latch, so an earlier block or acknowledgment cannot suppress the new
 * binding's valid opportunities, and records for a different workflow cannot
 * either.
 */
export function derivePhase2State(entries: readonly SessionEntry[], sessionId: string): Phase2SessionState {
  const records = readPhase2Records(entries, sessionId);
  let bindingIndex = -1;
  for (const [index, record] of records.entries()) {
    if (record.kind === "bind") bindingIndex = index;
  }
  if (bindingIndex === -1) {
    return { binding: null, legacy: null, reminder: { acknowledgedKey: null, remindedKeys: [], blocked: false } };
  }
  const newest = records[bindingIndex] as Phase2BindingRecord | Phase2LegacyBindingRecord;
  // The newest bind record is the session's current binding, whichever
  // generation wrote it: the active record is authoritative, and a legacy
  // envelope record stays the pre-activation route only while no active one
  // supersedes it.
  const active = newest.version === BIND_RECORD_VERSION ? (newest as Phase2BindingRecord) : null;
  const legacy = newest.version === LEGACY_BIND_RECORD_VERSION ? (newest as Phase2LegacyBindingRecord) : null;
  let acknowledgedKey: string | null = null;
  let blocked = false;
  const remindedKeys: string[] = [];
  for (const record of records.slice(bindingIndex + 1)) {
    if (record.workflowId !== newest.workflowId) continue;
    if (record.kind === "checkpoint") {
      blocked = record.decision === "blocked";
      if (record.observationKey !== null) acknowledgedKey = record.observationKey;
    } else if (record.kind === "user-turn") {
      blocked = false;
    } else if (record.kind === "reminder") {
      remindedKeys.push(record.observationKey);
    }
  }
  return { binding: active, legacy, reminder: { acknowledgedKey, remindedKeys, blocked } };
}

/* ------------------------------------------------------------------------- *
 * Observation projection (canonical, hashed — never a ready list)
 * ------------------------------------------------------------------------- */

/** One running async job, reduced to the fields the projection admits. */
export type Phase2RunningJob = Readonly<{ id: string; type: string; status: string }>;

/**
 * The canonical projection facts. Labels, timestamps, last-read times,
 * `updated_at`, result text and recent-job eviction are deliberately absent:
 * the key may change only when the *opportunity* changed.
 */
export type Phase2ObservationFacts = Readonly<{
  workflowId: string;
  hostSessionId: string;
  running: readonly Phase2RunningJob[];
  /** Engine plan facts, already reduced to `id/status/revision/prepared/session/handoff/lease-holder`. */
  planFacts: readonly string[];
  /** Transport-journal byte version + latest valid capacity; `""` when launch mode is off. */
  launchFacts: string;
}>;

/** Stable, sorted projection digest: the observation identity compared and latched. */
export function phase2ObservationKey(facts: Phase2ObservationFacts): string {
  const lines = [
    `workflow:${facts.workflowId}`,
    `session:${facts.hostSessionId}`,
    ...facts.running.map((job) => `job:${job.id}:${job.type}:${job.status}`).sort(),
    ...facts.planFacts.slice().sort(),
    facts.launchFacts === "" ? "launch:off" : `launch:${facts.launchFacts}`,
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Per-plan stable facts: identity, status, coordination revision, prepared pin, bound session, handoff state, lease holder. */
function planFactsOf(snapshot: WorkflowSnapshot): readonly string[] {
  const facts: string[] = [];
  for (const row of snapshot.plans as readonly PlanRow[]) {
    const planId = isNonEmptyString(row.id) ? row.id : isNonEmptyString(row.plan_id) ? row.plan_id : "";
    if (planId === "") continue;
    const coordination = isPlainObject(row.coordination) ? row.coordination : null;
    const prepared = isPlainObject(coordination?.prepared) ? coordination.prepared : null;
    const session = isPlainObject(coordination?.session) ? coordination.session : null;
    const handoff = isPlainObject(coordination?.handoff) ? coordination.handoff : null;
    const lease = isPlainObject(row.execution_lease) ? row.execution_lease : null;
    facts.push(
      [
        `plan:${planId}`,
        isNonEmptyString(row.status) ? row.status : "",
        coordination !== null && typeof coordination.revision === "number" ? String(coordination.revision) : "",
        prepared !== null && isNonEmptyString(prepared.assignment_sha256) ? prepared.assignment_sha256 : "",
        session !== null && isNonEmptyString(session.session_id) ? session.session_id : "",
        handoff !== null && isNonEmptyString(handoff.state) ? handoff.state : "",
        lease !== null && isNonEmptyString(lease.holder) ? lease.holder : "",
      ].join(":"),
    );
  }
  return facts;
}

/** `sha256:` of the journal bytes (its byte version), or `absent` / `unreadable`. */
function journalFactsOf(workflowDir: string): string {
  const path = join(workflowDir, JOURNAL_FILE);
  if (!existsSync(path)) return "absent";
  try {
    return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    return "unreadable";
  }
}

/* ------------------------------------------------------------------------- *
 * Engine probes (read-only; ownership and phase are re-read every time)
 * ------------------------------------------------------------------------- */

/** The observed lifecycle a diagnostic may cite — only from a successfully read authority. */
type ObservedStatus = Readonly<{ workflowId: string; status: string }>;

/**
 * One successful ownership probe, in the one shape both authorities answer with:
 * the lifecycle facts the observation projection admits, the workflow directory
 * whose journal bytes the projection hashes, and the terminal/phase verdict the
 * caller asked for.
 */
type WorkflowProbe =
  | Readonly<{
      ok: true;
      workflowId: string;
      status: string;
      phase: string | null;
      workflowDir: string;
      planFacts: readonly string[];
      /** The active DB binding the probe resolved, when the ACTIVE authority answered (`null` on the file route). */
      binding: ExecutionBinding | null;
    }>
  | Readonly<{ ok: false; code: string; message: string; observed?: ObservedStatus }>;

type SamplingResult = Readonly<{
  /** The bound coordinator owns a live workflow in `phase-2-execute`. */
  ownedPhase2: boolean;
  /** The computed observation, or `null` when any required read failed (never a guessed key). */
  observation: Phase2Observation | null;
  /** The first refusal, for a bounded diagnostic; `null` when the sample was complete. */
  refusal: Readonly<{ code: string; message: string; observed?: ObservedStatus }> | null;
  /** Every terminal id **this sample** saw in `recent`; the decision consumes exactly these. */
  terminalIds: readonly string[];
}>;

/** `null` when `snapshot.status` is terminal. */
function workflowIsTerminal(snapshot: { status: string }): boolean {
  return (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(snapshot.status);
}

/** Per-plan stable facts from the DB view — the same terms, from the authoritative source. */
function planFactsOfView(views: readonly ExecutionPlanView[]): readonly string[] {
  const facts: string[] = [];
  for (const view of views) {
    const planId = isNonEmptyString(view.plan.id) ? view.plan.id : isNonEmptyString(view.plan.plan_id) ? view.plan.plan_id : "";
    if (planId === "") continue;
    const coordination = isPlainObject(view.coordination) ? view.coordination : null;
    const prepared = isPlainObject(coordination?.prepared) ? coordination.prepared : null;
    const handoff = isPlainObject(coordination?.handoff) ? coordination.handoff : null;
    facts.push(
      [
        `plan:${planId}`,
        isNonEmptyString(view.plan.status) ? view.plan.status : "",
        coordination !== null && typeof coordination.revision === "number" ? String(coordination.revision) : "",
        prepared !== null && isNonEmptyString(prepared.assignment_sha256) ? prepared.assignment_sha256 : "",
        view.session === null ? "" : view.session.sessionId,
        handoff !== null && isNonEmptyString(handoff.state) ? handoff.state : "",
        view.executionLease === null || !isNonEmptyString(view.executionLease.holder) ? "" : view.executionLease.holder,
      ].join(":"),
    );
  }
  return facts;
}

/**
 * §5 the execution-authority readiness of one LEGACY file observation, as a
 * refusal verdict (or `null` when the file route still answers).
 *
 * The pre-activation arm reads the coordinator envelope (a file session
 * credential) and the workflow snapshot, so while an execution authority is
 * ACTIVE both documents are retired and the honest answer is not-ready — never
 * the retired bytes and never a synthesized binding
 * (`execution.consumer-not-ready`). A store that EXISTS and cannot be read keeps
 * its own refusal (the engine's code, passed through unchanged), and a harness
 * with no store at all keeps the unchanged file route (§2.1: absence is not an
 * authority verdict). The ACTIVE arm never calls this: it resumes the adopted
 * binding against the DB instead.
 */
async function executionRefusal(
  harnessRoot: string,
): Promise<Readonly<{ code: string; message: string }> | null> {
  let route: "execution" | "files";
  try {
    route = await resolveExecutionReadRoute({ harnessDir: harnessRoot });
  } catch (error) {
    const refusal = error as { code?: unknown; message?: unknown };
    const code = typeof refusal?.code === "string" ? refusal.code : "store.authority-unreadable";
    return {
      code,
      message:
        `the execution authority of ${harnessRoot} could not be read (${code}): ` +
        `${typeof refusal?.message === "string" ? refusal.message : String(error)} — the coordinator envelope and the ` +
        "workflow snapshot are retired while that authority governs them, so no file-route observation is available",
    };
  }
  if (route !== "execution") return null;
  return {
    code: "execution.consumer-not-ready",
    message:
      `the execution authority of ${harnessRoot} is ACTIVE, so the coordinator envelope and the workflow snapshot are ` +
      "retired as an observation route. Nothing was read: a legacy envelope binding is history only, so re-bind this " +
      "session through the ACTIVE route ({operation:\"bind\", workflowId}) and observe through the DB session binding",
  };
}

/**
 * The pre-activation arm of the ownership probe: this session's legacy envelope
 * binding, re-verified against the envelope itself and against the workflow
 * snapshot's own recorded coordinator. It is the unchanged file transport, and
 * it is unreachable once an active binding answers — the caller only takes this
 * arm for a legacy record, and the §5 readiness check refuses it the moment the
 * execution authority becomes ACTIVE.
 */
async function probeLegacyWorkflow(
  ctx: ExtensionContext,
  binding: Phase2LegacyBindingRecord,
  requirePhase2: boolean,
): Promise<WorkflowProbe> {
  // §5 before the envelope is even opened: while the execution authority is
  // ACTIVE the envelope and the snapshot are retired as an observation route.
  const execution = await executionRefusal(binding.harnessRoot);
  if (execution !== null) return { ok: false, code: execution.code, message: execution.message };
  // The bound envelope itself is re-read first: it is half of the ownership
  // pair, and a same-path replacement (a new engine session id) must not keep a
  // stale binding alive.
  let envelope: CoordinationSession;
  try {
    envelope = readSessionEnvelope(binding.coordinatorSessionPath);
  } catch (error) {
    return {
      ok: false,
      code: "phase2.envelope-unreadable",
      message: `the bound coordinator envelope ${binding.coordinatorSessionPath} can no longer be read: ${String(error)}`,
    };
  }
  if (
    envelope.role !== "coordinator" ||
    envelope.workflow_id !== binding.workflowId ||
    envelope.session_id !== binding.coordinatorSessionId
  ) {
    return {
      ok: false,
      code: "phase2.ownership-drift",
      message: `the envelope at ${binding.coordinatorSessionPath} is no longer the bound one (session ${envelope.session_id} of workflow ${envelope.workflow_id}, role ${envelope.role}; the binding recorded session ${binding.coordinatorSessionId} of workflow ${binding.workflowId})`,
    };
  }

  let workflowDir: string;
  try {
    workflowDir = join(resolveWorkflowDir(ctx.cwd, { harnessDir: binding.harnessRoot }), binding.workflowId);
  } catch (error) {
    return {
      ok: false,
      code: "phase2.harness-unresolvable",
      message: `the control harness root ${binding.harnessRoot} does not resolve a workflow dir from ${ctx.cwd}: ${String(error)}`,
    };
  }

  let snapshot: WorkflowSnapshot;
  try {
    snapshot = readWorkflowSnapshot(workflowDir).snapshot;
  } catch (error) {
    return {
      ok: false,
      code: "phase2.snapshot-unreadable",
      message: `cannot read the workflow snapshot for ${binding.workflowId} at ${workflowDir}: ${String(error)}`,
    };
  }
  if (snapshot.id !== binding.workflowId) {
    return {
      ok: false,
      code: "phase2.workflow-mismatch",
      message: `the snapshot at ${workflowDir} describes workflow ${snapshot.id}, not ${binding.workflowId}`,
      observed: { workflowId: snapshot.id, status: snapshot.status },
    };
  }
  if (workflowIsTerminal(snapshot)) {
    return {
      ok: false,
      code: "phase2.workflow-terminal",
      message: `workflow ${snapshot.id} is ${snapshot.status}`,
      observed: { workflowId: snapshot.id, status: snapshot.status },
    };
  }
  const coordinator = snapshot.coordination?.coordinator;
  if (
    coordinator === undefined ||
    coordinator.session_file !== binding.coordinatorSessionPath ||
    coordinator.session_id !== envelope.session_id
  ) {
    return {
      ok: false,
      code: "phase2.ownership-drift",
      message: `workflow ${snapshot.id} is bound to coordinator envelope ${coordinator?.session_file ?? "(none)"} (session ${coordinator?.session_id ?? "(none)"}), not to ${binding.coordinatorSessionPath} (session ${envelope.session_id})`,
      observed: { workflowId: snapshot.id, status: snapshot.status },
    };
  }
  if (requirePhase2 && (snapshot.status !== "running" || snapshot.phase !== PHASE2_PHASE)) {
    return {
      ok: false,
      code: "phase2.phase-inactive",
      message: `workflow ${snapshot.id} is ${snapshot.status} at phase ${JSON.stringify(snapshot.phase ?? null)}; the Phase-2 observation requires "${PHASE2_PHASE}"`,
      observed: { workflowId: snapshot.id, status: snapshot.status },
    };
  }
  return {
    ok: true,
    workflowId: snapshot.id,
    status: snapshot.status,
    phase: snapshot.phase ?? null,
    workflowDir,
    planFacts: planFactsOf(snapshot),
    binding: null,
  };
}

/**
 * The ACTIVE arm of the ownership probe: the session's own `ExecutionBinding` is
 * resumed against the CURRENT store (a stale epoch, a foreign root or a revoked
 * row refuses, and no envelope is consulted as a fallback), then the workflow's
 * DB authority answers with the lifecycle, the plan views and the session that
 * holds the coordinator seat. Ownership and phase are re-read on every probe.
 */
async function probeActiveWorkflow(
  ctx: ExtensionContext,
  binding: Phase2BindingRecord,
  requirePhase2: boolean,
): Promise<WorkflowProbe> {
  const adopted = binding.executionBinding;
  const identity: ExecutionIdentity = {
    source: "host",
    sessionId: adopted.session.sessionId,
    workflowId: adopted.session.workflowId,
    role: adopted.session.role,
    planId: adopted.session.planId,
  };
  try {
    await resumeExecutionSession(executionContextFor({ harnessDir: adopted.harnessRoot }, identity), adopted.session);
  } catch (error) {
    return {
      ok: false,
      code: engineCodeOf(error, "phase2.binding-stale"),
      message: `the adopted execution binding of workflow ${binding.workflowId} no longer authorizes this session: ${String(error)}`,
    };
  }
  let read: ExecutionRead<ExecutionState | ExecutionPlanView>;
  try {
    read = await readExecutionAuthority({ harnessDir: adopted.harnessRoot }, { workflowId: binding.workflowId });
  } catch (error) {
    return {
      ok: false,
      code: engineCodeOf(error, "phase2.authority-unreadable"),
      message: `the execution authority of ${adopted.harnessRoot} cannot serve workflow ${binding.workflowId}: ${String(error)}`,
    };
  }
  const workflow = "workflows" in read.data ? read.data.workflows[0] : undefined;
  if (workflow === undefined) {
    return {
      ok: false,
      code: "coordination.workflow-not-found",
      message: `the execution authority read of workflow ${binding.workflowId} returned no active lifecycle`,
    };
  }
  let workflowDir: string;
  try {
    workflowDir = join(resolveWorkflowDir(ctx.cwd, { harnessDir: adopted.harnessRoot }), binding.workflowId);
  } catch (error) {
    return {
      ok: false,
      code: "phase2.harness-unresolvable",
      message: `the control harness root ${adopted.harnessRoot} does not resolve a workflow dir from ${ctx.cwd}: ${String(error)}`,
    };
  }
  if (workflow.coordinator === null || workflow.coordinator.sessionId !== identity.sessionId) {
    return {
      ok: false,
      code: "phase2.ownership-drift",
      message: `workflow ${binding.workflowId} is bound to coordinator session ${workflow.coordinator?.sessionId ?? "(none)"}, not to this session ${identity.sessionId}`,
      observed: { workflowId: binding.workflowId, status: workflow.state.status },
    };
  }
  if (workflowIsTerminal(workflow.state)) {
    return {
      ok: false,
      code: "phase2.workflow-terminal",
      message: `workflow ${binding.workflowId} is ${workflow.state.status}`,
      observed: { workflowId: binding.workflowId, status: workflow.state.status },
    };
  }
  if (requirePhase2 && (workflow.state.status !== "running" || workflow.state.phase !== PHASE2_PHASE)) {
    return {
      ok: false,
      code: "phase2.phase-inactive",
      message: `workflow ${binding.workflowId} is ${workflow.state.status} at phase ${JSON.stringify(workflow.state.phase ?? null)}; the Phase-2 observation requires "${PHASE2_PHASE}"`,
      observed: { workflowId: binding.workflowId, status: workflow.state.status },
    };
  }
  return {
    ok: true,
    workflowId: binding.workflowId,
    status: workflow.state.status,
    phase: workflow.state.phase ?? null,
    workflowDir,
    planFacts: planFactsOfView(workflow.plans),
    binding: adopted,
  };
}

/* ------------------------------------------------------------------------- *
 * Extension factory
 * ------------------------------------------------------------------------- */

/** Tool outcome shape every path returns (the host renders it in TUI/print/JSON/RPC alike). */
type ToolOutcome = Readonly<{ ok: boolean; isError: boolean; text: string; details: Record<string, unknown> }>;

function outcome(ok: boolean, isError: boolean, text: string, details: Record<string, unknown> = {}): ToolOutcome {
  return { ok, isError, text, details };
}

/** A refusal: the machine code is visible to the caller in the result details *and* in the text. */
function refuse(code: string, message: string): ToolOutcome {
  return outcome(false, true, `${message} (${code})`, { code });
}

/** An empty observation, used only together with `snapshotAvailable: false`. */
const NO_OBSERVATION: Phase2Observation = { key: "", hasRunningJobs: false, nativeDeliveryPending: false, recentTerminalIds: [] };

/**
 * Test seam for the awaited settings read, following this package's own
 * precedent (the model-handoff adapter's readiness seam). The read sits between
 * the snapshot a decision is taken against and the moment its ids are consumed,
 * so a test can hold it open and settle a job inside that window.
 */
export const phase2Seams = {
  readSettings: readPhase2Settings,
};

export default function phase2Orchestration(pi: ExtensionAPI): void {
  const z = pi.zod;
  /** Per-process state: a gate/fence and the coverage of native results already seen. */
  const gate = {
    /** Monotonic fence; every navigation/session step advances it. */
    generation: 0,
    navigationPending: false,
    /** An explicit user turn is the current continuation (cleared once it ends). */
    userTurn: false,
    /** Diagnostic codes already reported for the current generation — the "bounded" half. */
    reported: new Set<string>(),
    /** Set when a probe finds the binding no longer current (envelope gone or replaced). */
    stale: null as Readonly<{ code: string; message: string }> | null,
  };
  /** Recently settled job ids whose completion the host's own delivery already owns. */
  const consumedTerminalIds = new Set<string>();

  /** Durable, coordinator-visible notice. Never log-only, never throws into the host. */
  const notice = (text: string): void => {
    try {
      pi.sendMessage({ customType: PHASE2_NOTICE_CUSTOM_TYPE, content: text, display: true });
    } catch {
      // An unavailable notice channel at teardown must not break the caller.
    }
  };

  /**
   * One bounded diagnostic per code and generation: repeated identical refusals
   * stay silent. The title comes from the shared notice shape — a status title
   * only when a successfully read snapshot supplied the observed id/status,
   * otherwise a fallback that asserts no workflow status.
   */
  const diagnose = (code: string, message: string, observed?: ObservedStatus): void => {
    if (gate.reported.has(code)) return;
    gate.reported.add(code);
    const detail = `${message} (${code})`;
    notice(formatNotice(observed === undefined ? fallbackNotice({ subject: "the Phase-2 observation", detail }) : statusNotice({ ...observed, detail })));
  };

  const appendRecord = (record: Phase2Record): boolean => {
    try {
      pi.appendEntry(PHASE2_CUSTOM_TYPE, record);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Codes that mean the binding is no longer current for THIS session, so the
   * local (process-scoped) marker and its "re-run bind" hint apply: the DB
   * authority says the reference is stale, revoked or foreign
   * (`store.stale-epoch`, `execution.session-unavailable`,
   * `execution.scope-mismatch` — the active-route analogue of the retired
   * envelope's gone/replaced cases), the adopted binding refused for a binding
   * reason of this adapter's own, or a legacy envelope record is gone/replaced.
   */
  const STALE_CODES = [
    "store.stale-epoch",
    "execution.session-unavailable",
    "execution.scope-mismatch",
    "phase2.binding-stale",
    "phase2.envelope-unreadable",
    "phase2.ownership-drift",
  ];

  /** The identity terms of the session's current binding record, whichever generation wrote it. */
  const bindingTermsOf = (state: Phase2SessionState): Readonly<{ workflowId: string; hostSessionId: string }> | null => {
    const record = state.binding ?? state.legacy;
    return record === null ? null : { workflowId: record.workflowId, hostSessionId: record.hostSessionId };
  };

  /**
   * The one ownership probe every tool and event uses. It picks the arm the
   * session's own binding record declares — the ACTIVE DB binding, or the
   * pre-activation envelope binding — and marks this instance's binding
   * not-current when that authority no longer answers for this session. The mark
   * is local and process-scoped (the durable binding record is never rewritten as
   * if the child had handed off); a later `bind` clears it.
   */
  const probeOwnership = async (
    ctx: ExtensionContext,
    state: Phase2SessionState,
    requirePhase2: boolean,
  ): Promise<WorkflowProbe> => {
    const probe =
      state.binding !== null
        ? await probeActiveWorkflow(ctx, state.binding, requirePhase2)
        : state.legacy !== null
          ? await probeLegacyWorkflow(ctx, state.legacy, requirePhase2)
          : ({
              ok: false,
              code: "phase2.not-bound",
              message: "this session holds no Phase-2 observation binding",
            } as const);
    if (!probe.ok && STALE_CODES.includes(probe.code)) gate.stale = { code: probe.code, message: probe.message };
    return probe;
  };

  /** A refusal sentence a caller sees only while its binding is marked not-current. */
  const staleHint = (): string =>
    gate.stale === null
      ? ""
      : " The local binding is marked not-current; re-run {operation:\"bind\", workflowId} in this session before relying on it.";

  /** Reset per-process observation state; called on load and on every session navigation. */
  const resetGate = (): void => {
    gate.generation += 1;
    gate.navigationPending = false;
    gate.userTurn = false;
    gate.reported.clear();
    gate.stale = null;
    consumedTerminalIds.clear();
  };

  /* ------------------------------------------------------------ sampling --- */

  /**
   * Sample the current opportunity from an already-taken workflow probe: the
   * host snapshot, the settings that decide whether launch facts are part of the
   * projection, and the engine facts the key is computed from. Every failure
   * yields `observation: null` — never a key derived from a partial read.
   */
  const sample = async (
    ctx: ExtensionContext,
    terms: Readonly<{ workflowId: string; hostSessionId: string }>,
    probe: WorkflowProbe,
  ): Promise<SamplingResult> => {
    if (!probe.ok)
      return {
        ownedPhase2: false,
        observation: null,
        refusal: { code: probe.code, message: probe.message, observed: probe.observed },
        terminalIds: [],
      };

    const observed: ObservedStatus = { workflowId: probe.workflowId, status: probe.status };
    const snapshot = ctx.getAsyncJobSnapshot();
    if (snapshot === null) {
      return {
        ownedPhase2: true,
        observation: null,
        refusal: {
          code: "phase2.snapshot-unavailable",
          message: "the host async-job snapshot is unavailable for this session; null is not \"no jobs\"",
          observed,
        },
        terminalIds: [],
      };
    }

    const settings = await phase2Seams.readSettings(ctx.cwd);
    if (!settings.ok) {
      return {
        ownedPhase2: true,
        observation: null,
        refusal: { code: `phase2.${settings.reason}`, message: settings.message, observed },
        terminalIds: [],
      };
    }

    const running = snapshot.running.map((job) => ({ id: job.id, type: job.type, status: job.status }));
    const terminalIds = snapshot.recent.filter((job) => job.status !== "running").map((job) => job.id);
    const recentTerminalIds = terminalIds.filter((id) => !consumedTerminalIds.has(id));
    const launchFacts = settings.value.phase2PlanInstances
      ? `${journalFactsOf(probe.workflowDir)}:${settings.value.maxPlanInstances}`
      : "";
    const key = phase2ObservationKey({
      workflowId: terms.workflowId,
      hostSessionId: terms.hostSessionId,
      running,
      planFacts: probe.planFacts,
      launchFacts,
    });
    return {
      ownedPhase2: true,
      observation: {
        key,
        hasRunningJobs: running.length > 0,
        nativeDeliveryPending:
          snapshot.delivery.queued > 0 || snapshot.delivery.delivering || snapshot.delivery.pendingJobIds.length > 0,
        recentTerminalIds,
      },
      refusal: null,
      terminalIds,
    };
  };

  /**
   * The sole emission point. At most one bounded advisory per changed
   * observation; the key is recorded **before** it is sent, and any
   * unavailable/foreign/drifted fact results in silence.
   */
  const emitAdvisory = async (ctx: ExtensionContext): Promise<void> => {
    const state = derivePhase2State(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
    const terms = bindingTermsOf(state);
    if (terms === null) return;
    const generation = gate.generation;
    const probed = await probeOwnership(ctx, state, true);
    const sampled = await sample(ctx, terms, probed);
    if (generation !== gate.generation || gate.navigationPending) return;
    if (sampled.refusal !== null) diagnose(sampled.refusal.code, sampled.refusal.message, sampled.refusal.observed);

    const observation = sampled.observation ?? NO_OBSERVATION;
    const decision = decidePhase2Reminder(state.reminder, observation, {
      boundPhase2: sampled.ownedPhase2,
      pendingMessages: ctx.hasPendingMessages(),
      userTurn: gate.userTurn,
      snapshotAvailable: sampled.observation !== null,
    });
    gate.userTurn = false;
    // Consume exactly the terminals the decision used — this sample's own ids,
    // never a second snapshot taken after the settings await. A job that settles
    // inside that window stays unconsumed: the decision saw it as running (so
    // this turn can still be nudged about the changed opportunity), and the next
    // turn sees a freshly delivered terminal, which stays silent rather than
    // nudging a second time.
    for (const id of sampled.terminalIds) consumedTerminalIds.add(id);
    if (decision === "silent") return;

    // Record-before-send: the latch is durable before the advisory can be seen.
    const recorded = appendRecord({
      version: RECORD_VERSION,
      kind: "reminder",
      hostSessionId: terms.hostSessionId,
      workflowId: terms.workflowId,
      observationKey: observation.key,
    });
    if (!recorded) return;
    try {
      pi.sendMessage(
        { customType: PHASE2_ADVISORY_CUSTOM_TYPE, content: ADVISORY_TEXT, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // The advisory channel was unavailable at teardown; nothing else changed.
    }
  };

  /* ---------------------------------------------------------- operations --- */

  /** The engine's own coordinator-residency rule: main worktree, or the recorded integration worktree. */
  const residencyRefusal = (ctx: ExtensionContext, integrationWorktreePath: string | undefined): ToolOutcome | null => {
    const main = readMainWorktree(ctx.cwd);
    const allowed: string[] = [];
    if (main !== null) allowed.push(canonicalizeNearestExisting(main.root));
    if (isNonEmptyString(integrationWorktreePath)) allowed.push(canonicalizeNearestExisting(integrationWorktreePath));
    const checkout = probeCheckoutRoot(ctx.cwd);
    const here = checkout === null ? null : canonicalizeNearestExisting(checkout);
    if (here === null || !allowed.includes(here)) {
      return refuse(
        "phase2.scope-mismatch",
        `a coordinator session binds from the main worktree or the recorded integration worktree; ${here ?? ctx.cwd} is neither (${allowed.join(", ") || "none resolvable"})`,
      );
    }
    return null;
  };

  /** The ACTIVE bind: adopt this session's own DB coordinator binding for one workflow. */
  const bindActive = async (
    workflowId: string,
    ctx: ExtensionContext,
    hostSessionId: string,
    harnessRoot: string,
  ): Promise<ToolOutcome> => {
    let read: ExecutionRead<ExecutionState | ExecutionPlanView>;
    try {
      read = await readExecutionAuthority({ harnessDir: harnessRoot }, { workflowId });
    } catch (error) {
      return refuse(engineCodeOf(error, "phase2.authority-unreadable"), `the execution authority of ${harnessRoot} cannot serve workflow ${workflowId}: ${String(error)}`);
    }
    const workflow = "workflows" in read.data ? read.data.workflows[0] : undefined;
    if (workflow === undefined) {
      return refuse("coordination.workflow-not-found", `the execution authority holds no active lifecycle ${workflowId}; nothing was bound.`);
    }
    const coordinator = workflow.coordinator;
    if (coordinator === null || coordinator.sessionId !== hostSessionId) {
      return refuse(
        "phase2.coordinator-mismatch",
        `workflow ${workflowId} is bound to coordinator session ${coordinator?.sessionId ?? "(none)"}, not to this host session ${hostSessionId}; nothing was bound.`,
      );
    }
    const residency = residencyRefusal(ctx, workflow.state.integration_worktree_path);
    if (residency !== null) return residency;
    // The adopted reference is resumed against the current epoch/root before it
    // is recorded: a stale, revoked or foreign row is never persisted as a
    // binding (and no envelope stands in for it).
    const identity: ExecutionIdentity = { source: "host", sessionId: hostSessionId, workflowId, role: "coordinator", planId: null };
    try {
      await resumeExecutionSession(executionContextFor({ harnessDir: harnessRoot }, identity), coordinator);
    } catch (error) {
      return refuse(engineCodeOf(error, "phase2.binding-stale"), `the DB coordinator binding of workflow ${workflowId} is not current: ${String(error)}`);
    }
    const executionBinding = executionBindingOf(harnessRoot, coordinator);
    const existing = derivePhase2State(ctx.sessionManager.getEntries(), hostSessionId).binding;
    if (existing !== null && existing.workflowId === workflowId && serializeExecutionValue(existing.executionBinding) === serializeExecutionValue(executionBinding)) {
      gate.stale = null;
      return outcome(true, false, `this session is already bound to ${workflowId}; the identity pointer is unchanged.`, {
        code: "already-bound",
        applied: false,
        workflowId,
        hostSessionId,
        storeId: coordinator.storeId,
        epoch: coordinator.epoch,
      });
    }
    const record: Phase2BindingRecord = { version: BIND_RECORD_VERSION, kind: "bind", workflowId, hostSessionId, executionBinding };
    if (!appendRecord(record)) {
      return refuse("phase2.record-failed", "the observation identity could not be recorded in this session; nothing was bound.");
    }
    gate.reported.clear();
    gate.stale = null;
    return outcome(true, false, `bound the Phase-2 observation of workflow ${workflowId} to this session's execution authority (store epoch ${coordinator.epoch}).`, {
      code: "bound",
      applied: true,
      workflowId,
      hostSessionId,
      storeId: coordinator.storeId,
      epoch: coordinator.epoch,
      phase: workflow.state.phase ?? null,
    });
  };

  /**
   * The PRE-ACTIVATION bind: the file route still answers, so the observation
   * adopts the workflow's OWN recorded coordinator envelope — resolved from the
   * workflow snapshot by the host, never supplied by the caller — and records a
   * legacy binding. The moment the execution authority becomes ACTIVE this arm is
   * refused by the route probe, and the ACTIVE arm supersedes it.
   */
  const bindLegacy = async (
    workflowId: string,
    ctx: ExtensionContext,
    hostSessionId: string,
    harnessRoot: string,
  ): Promise<ToolOutcome> => {
    let workflowDir: string;
    try {
      workflowDir = join(resolveWorkflowDir(ctx.cwd, { harnessDir: harnessRoot }), workflowId);
    } catch (error) {
      return refuse("phase2.harness-unresolvable", `the control harness root ${harnessRoot} does not resolve a workflow dir from ${ctx.cwd}: ${String(error)}`);
    }
    let snapshot: WorkflowSnapshot;
    try {
      snapshot = readWorkflowSnapshot(workflowDir).snapshot;
    } catch (error) {
      return refuse("phase2.snapshot-unreadable", `cannot read the workflow snapshot for ${workflowId}: ${String(error)}`);
    }
    if (snapshot.id !== workflowId) {
      return refuse("phase2.workflow-mismatch", `the snapshot at ${workflowDir} describes workflow ${snapshot.id}, not ${workflowId}`);
    }
    if (workflowIsTerminal(snapshot)) {
      return refuse("phase2.workflow-terminal", `workflow ${snapshot.id} is ${snapshot.status}; nothing was bound.`);
    }
    const coordinator = snapshot.coordination?.coordinator;
    if (coordinator === undefined) {
      return refuse(
        "phase2.coordinator-mismatch",
        `workflow ${workflowId} records no coordinator binding; this session cannot observe a workflow that has no coordinator.`,
      );
    }
    const residency = residencyRefusal(ctx, snapshot.integration_worktree_path);
    if (residency !== null) return residency;

    const sessionPath = canonicalizeNearestExisting(coordinator.session_file);
    let envelope: CoordinationSession;
    try {
      envelope = readSessionEnvelope(sessionPath);
    } catch (error) {
      return refuse("phase2.envelope-unreadable", `the recorded coordinator envelope ${sessionPath} can no longer be read: ${String(error)}`);
    }
    if (envelope.role !== "coordinator") {
      return refuse("phase2.plan-pm-session", `session ${envelope.session_id} is a ${envelope.role} session; a scoped-plan PM never binds the Phase-2 observation`);
    }
    if (envelope.workflow_id !== workflowId || envelope.session_id !== coordinator.session_id) {
      return refuse(
        "phase2.coordinator-mismatch",
        `the envelope at ${sessionPath} is session ${envelope.session_id} of workflow ${envelope.workflow_id}, not the recorded coordinator ${coordinator.session_id} of ${workflowId}`,
      );
    }
    const envelopeRoot = canonicalizeNearestExisting(envelope.harness_root);
    const existing = derivePhase2State(ctx.sessionManager.getEntries(), hostSessionId).legacy;
    if (
      existing !== null &&
      existing.workflowId === workflowId &&
      existing.coordinatorSessionPath === sessionPath &&
      existing.coordinatorSessionId === envelope.session_id &&
      existing.harnessRoot === envelopeRoot
    ) {
      gate.stale = null;
      return outcome(true, false, `this session is already bound to ${workflowId}; the identity pointer is unchanged.`, {
        code: "already-bound",
        applied: false,
        workflowId,
        hostSessionId,
        coordinatorSessionId: envelope.session_id,
      });
    }
    const record: Phase2LegacyBindingRecord = {
      version: LEGACY_BIND_RECORD_VERSION,
      kind: "bind",
      workflowId,
      hostSessionId,
      coordinatorSessionPath: sessionPath,
      coordinatorSessionId: envelope.session_id,
      harnessRoot: envelopeRoot,
    };
    if (!appendRecord(record)) {
      return refuse("phase2.record-failed", "the observation identity could not be recorded in this session; nothing was bound.");
    }
    gate.reported.clear();
    gate.stale = null;
    return outcome(true, false, `bound the Phase-2 observation of workflow ${workflowId} to the recorded coordinator session ${envelope.session_id} (pre-activation file route).`, {
      code: "bound",
      applied: true,
      workflowId,
      hostSessionId,
      coordinatorSessionId: envelope.session_id,
      harnessRoot: envelopeRoot,
      phase: snapshot.phase ?? null,
    });
  };

  /**
   * `bind` — adopt this session's observation identity for one explicit workflow
   * from whatever authority the addressed control root has: the DB session
   * binding when the execution authority is ACTIVE, the recorded coordinator
   * envelope on the pre-activation file route. The route is read from the root,
   * never selected by the call, and the identity is always host-derived.
   */
  const bind = async (params: Extract<Phase2Request, { operation: "bind" }>, ctx: ExtensionContext): Promise<ToolOutcome> => {
    const hostSessionId = ctx.sessionManager.getSessionId();
    if (hostSessionId === "") {
      return refuse("phase2.task-session", "the host session has no id; no observation identity was recorded.");
    }
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "session_init")) {
      return refuse(
        "phase2.task-session",
        "this session is a leaf/subagent (task) session, not the iteration coordinator; no observation identity was recorded.",
      );
    }
    let ownHarness: string | null = null;
    try {
      const resolved = resolveHarnessDir(ctx.cwd);
      ownHarness = resolved === null ? null : canonicalizeNearestExisting(resolved);
    } catch {
      ownHarness = null;
    }
    if (ownHarness === null) {
      return refuse("phase2.harness-not-found", `no canonical control harness root is resolvable from ${ctx.cwd}; nothing was bound.`);
    }
    let route: "execution" | "files";
    try {
      route = await resolveExecutionReadRoute({ harnessDir: ownHarness });
    } catch (error) {
      const code = engineCodeOf(error, "store.authority-unreadable");
      return refuse(code, `the execution authority of ${ownHarness} could not be read (${code}): ${String(error)}`);
    }
    return route === "execution"
      ? bindActive(params.workflowId, ctx, hostSessionId, ownHarness)
      : bindLegacy(params.workflowId, ctx, hostSessionId, ownHarness);
  };

  /** `checkpoint` — acknowledge the scheduling spec against the sample taken now. */
  const checkpoint = async (
    params: Extract<Phase2Request, { operation: "checkpoint" }>,
    ctx: ExtensionContext,
  ): Promise<ToolOutcome> => {
    const state = derivePhase2State(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
    const terms = bindingTermsOf(state);
    if (terms === null) {
      return refuse("phase2.not-bound", "this session holds no Phase-2 observation binding; call {operation:\"bind\", workflowId} first.");
    }
    const probe = await probeOwnership(ctx, state, true);
    if (!probe.ok) {
      return refuse(probe.code, `${probe.message}. The checkpoint was not recorded.${staleHint()}`);
    }
    const sampled = await sample(ctx, terms, probe);
    if (sampled.refusal !== null) diagnose(sampled.refusal.code, sampled.refusal.message, sampled.refusal.observed);
    const key = sampled.observation?.key ?? null;
    const blocked = params.decision === "blocked";
    if (
      !appendRecord({
        version: RECORD_VERSION,
        kind: "checkpoint",
        hostSessionId: terms.hostSessionId,
        workflowId: terms.workflowId,
        reason: params.reason,
        decision: params.decision,
        note: params.note,
        observationKey: key,
      })
    ) {
      return refuse("phase2.record-failed", "the checkpoint could not be recorded in this session; advisory state is unchanged.");
    }
    return outcome(true, false, `checkpoint recorded (${params.decision}, ${params.reason})${blocked ? "; advisory continuation is suppressed until a new user turn or a later checkpoint" : ""}.`, {
      code: "recorded",
      applied: true,
      decision: params.decision,
      reason: params.reason,
      observationKey: key,
      blocked,
      sampled: key !== null,
    });
  };

  /** `reserve-launch` / `record-launch` — the T2 journal, with authority from this session's ACTIVE binding. */
  const launch = async (
    request: Extract<Phase2Request, { operation: "reserve-launch" } | { operation: "record-launch" }>,
    ctx: ExtensionContext,
  ): Promise<ToolOutcome> => {
    const state = derivePhase2State(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
    const terms = bindingTermsOf(state);
    if (terms === null) {
      return refuse("phase2.not-bound", "this session holds no Phase-2 observation binding; call {operation:\"bind\", workflowId} first.");
    }
    if (state.binding === null) {
      // The launch journal is adopted under the ACTIVE authority (§6): a legacy
      // envelope binding never carries launch authority, and the file route is
      // migration history for this surface.
      return refuse(
        "phase2.binding-legacy",
        `this session's observation binding for ${terms.workflowId} is the pre-activation envelope record; the launch journal requires the ACTIVE execution authority. Re-bind through {operation:"bind", workflowId} once the execution authority is active.`,
      );
    }
    const probe = await probeOwnership(ctx, state, true);
    if (!probe.ok) return refuse(probe.code, `${probe.message}. No launch bookkeeping was written.${staleHint()}`);

    const authority: ExecutionLaunchAuthority = {
      cwd: ctx.cwd,
      identity: {
        source: "host",
        sessionId: state.binding.hostSessionId,
        workflowId: state.binding.workflowId,
        role: "coordinator",
        planId: null,
      },
      binding: state.binding.executionBinding,
    };
    let result: PlanLaunchResult;
    try {
      result =
        request.operation === "reserve-launch"
          ? await reservePlanLaunch(request, authority)
          : await recordPlanLaunch(request, authority);
    } catch (error) {
      return refuse("phase2.journal-failed", `the transport-intent journal refused this call: ${String(error)}`);
    }
    if (!result.ok) return refuse(result.code, result.message);

    const intent = result.intent;
    const action = request.operation === "reserve-launch" ? "reserved" : "recorded";
    const applied = result.applied;
    const text = applied
      ? `${action} launch intent ${intent.id} for plan ${intent.planId} as ${intent.state}${intent.target === undefined ? "" : ` in ${intent.target}`}; the recorded transition authorizes the matching PM action.`
      : `launch intent ${intent.id} for plan ${intent.planId} is already ${intent.state}; this call wrote nothing and authorizes no side effect.`;
    return outcome(true, false, text, {
      code: applied ? action : "replayed",
      applied,
      intent: {
        id: intent.id,
        planId: intent.planId,
        state: intent.state,
        transport: intent.transport,
        target: intent.target ?? null,
        preparedHash: intent.preparedHash,
        evidencePaths: intent.evidencePaths,
      },
    });
  };

  /**
   * `export-history` — the §4.2 read-only bounded evidence operation (H2's
   * producer amendment). It exports THIS carrying session's own hidden history as
   * one canonical document bound to one workflow, plus the exact H1 export
   * digest. It binds nothing, stops nothing, adopts nothing, spawns nothing,
   * writes no file and requires no operator attestation: the coordinator saves
   * the returned bytes through the existing file-write channel at the explicit
   * evidence path it chooses, and C3 aggregates one document per named native
   * session. A carrying leaf may export its own readable history — this grants no
   * coordinator authority — and a session whose own ledger cannot be read refuses
   * instead of fabricating a wider scan.
   */
  const exportHistory = async (
    params: Extract<Phase2Request, { operation: "export-history" }>,
    ctx: ExtensionContext,
  ): Promise<ToolOutcome> => {
    const hostSessionId = ctx.sessionManager.getSessionId();
    if (hostSessionId === "") {
      return refuse("phase2.task-session", "the host session has no native id, so no inventory can be attributed to it; nothing was exported.");
    }
    let entries: readonly SessionEntry[];
    try {
      entries = ctx.sessionManager.getEntries();
    } catch (error) {
      return refuse(
        "phase2.ledger-unreadable",
        `this session's own ledger cannot be read (${String(error)}), so no inventory was exported; a full scan is never fabricated`,
      );
    }
    let inventory: ExecutionHostInventory;
    try {
      inventory = buildExecutionHostInventory({ workflowId: params.workflowId, hostSessionId, entries });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return refuse(typeof code === "string" ? code : "inventory.failed", error instanceof Error ? error.message : String(error));
    }
    return outcome(true, false, exportExecutionHostInventory(inventory), {
      code: "exported",
      workflowId: inventory.workflowId,
      hostSessionId: inventory.hostSessionId,
      exportSha256: inventory.export.sha256,
      evidenceSha256: inventoryDigest(inventory),
      records: inventory.export.document.records.length,
      diagnostics: inventory.export.document.diagnostics.length,
    });
  };

  /* ---------------------------------------------------------------- tool --- */

  const skillRef = z.object({ name: z.string(), source: z.string() }).strict();
  const capabilityRef = z.object({ executable: z.string(), version: z.string(), target: z.string() }).strict();
  const bindRequest = z.object({ operation: z.literal("bind"), workflowId: z.string() }).strict();
  const exportHistoryRequest = z.object({ operation: z.literal("export-history"), workflowId: z.string() }).strict();
  const checkpointRequest = z
    .object({
      operation: z.literal("checkpoint"),
      reason: z.enum(["before-wait", "result-settled", "dependency-changed", "ownership-changed", "capacity-changed"]),
      decision: z.enum(["dispatched", "wait", "blocked"]),
      note: z.string(),
    })
    .strict();
  const reserveRequest = z
    .object({
      operation: z.literal("reserve-launch"),
      planId: z.string(),
      transport: z.enum(["herdr", "tmux"]),
      skill: skillRef,
      capability: capabilityRef,
    })
    .strict();
  const recordRequest = z
    .object({
      operation: z.literal("record-launch"),
      intentId: z.string(),
      observation: z.enum(["starting", "created", "submitting", "submitted", "refused", "uncertain"]),
      target: z.string().optional(),
      evidencePath: z.string(),
    })
    .strict()
    // The same rule T2's validator enforces, refused one layer earlier so a
    // malformed transition never reaches the journal at all. The predicate form
    // (`refine`) is the one both supported host type surfaces declare, so this
    // schema compiles against the pinned host regardless of which copy of its
    // type declarations a tree happens to resolve.
    .refine(
      (value) => value.observation !== "created" || (value.target !== undefined && value.target !== ""),
      "record-launch created requires the returned opaque target",
    );

  pi.registerTool({
    name: TOOL_NAME,
    label: "Phase-2 orchestration",
    description:
      'Morning Star Phase-2 host observation. `{operation:"bind"}` adopts this session\'s identity pointer for one explicitly named workflow from whatever authority the control root has (the active DB session binding, or the recorded coordinator envelope pre-activation) \u2014 never from the call. `{operation:"checkpoint"}` acknowledges a run of the shared rescheduling checkpoint against the sample taken at that moment and can assert a block. `{operation:"reserve-launch"}` and `{operation:"record-launch"}` admit and record one extra plan-primary launch intent in the plugin\'s local transport journal under the ACTIVE execution authority; the optional Herdr/tmux skill performs every CLI call. `{operation:"export-history"}` returns THIS session\'s bounded hidden-history evidence bytes for one workflow (no file is written and no authority is granted). Not a user activation command: nothing is spawned, merged, leased or written to engine state.',
    parameters: z.union([bindRequest, exportHistoryRequest, checkpointRequest, reserveRequest, recordRequest]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const request = params as unknown as Phase2Request;
        const result =
          request.operation === "bind"
            ? await bind(request, ctx)
            : request.operation === "export-history"
              ? await exportHistory(request, ctx)
              : request.operation === "checkpoint"
                ? await checkpoint(request, ctx)
                : await launch(request, ctx);
        return {
          content: [{ type: "text", text: result.text }],
          details: { mstarPhase2: result.details, ok: result.ok },
          isError: result.isError,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `the phase-2 tool failed without touching engine, journal or model state: ${String(error)}` }],
          details: { mstarPhase2: { code: "tool-error" }, ok: false },
          isError: true,
        };
      }
    },
  });

  /* -------------------------------------------------------------- events --- */

  // Explicit steering only from a real user turn: another extension's injected
  // input is not the user taking over.
  pi.on("input", (event, ctx) => {
    const explicit = event.source === "interactive" || event.source === "rpc";
    if (!explicit) return;
    gate.userTurn = true;
    const state = derivePhase2State(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
    const terms = bindingTermsOf(state);
    if (terms === null || !state.reminder.blocked) return;
    // A recorded block is cleared by a real user turn — durably, so a reload
    // cannot resurrect a blocker the user already overrode.
    appendRecord({
      version: RECORD_VERSION,
      kind: "user-turn",
      hostSessionId: terms.hostSessionId,
      workflowId: terms.workflowId,
    });
  });

  // The one emission point (native-result coverage is consumed inside it).
  pi.on("agent_end", async (_event, ctx) => {
    await emitAdvisory(ctx);
  });

  /**
   * Navigation and session reconstruction advance the fence and drop per-process
   * observation state; durable state is replayed from the ledger at every use,
   * so nothing has to be guessed away here. No navigation is ever cancelled:
   * this extension holds no invoked action to protect.
   */
  const beforeNavigation = (): void => {
    gate.navigationPending = true;
    gate.generation += 1;
    gate.reported.clear();
    consumedTerminalIds.clear();
  };

  pi.on("session_before_switch", () => beforeNavigation());
  pi.on("session_before_branch", () => beforeNavigation());
  pi.on("session_before_tree", () => beforeNavigation());
  pi.on("session_switch", () => resetGate());
  pi.on("session_branch", () => resetGate());
  pi.on("session_tree", () => resetGate());
  pi.on("session_start", () => resetGate());

  // Process exit: drop in-memory state only. No claim is made about process
  // termination, plugin unload or a half-written session file.
  pi.on("session_shutdown", () => {
    gate.navigationPending = true;
    gate.generation += 1;
    gate.userTurn = false;
    gate.reported.clear();
    consumedTerminalIds.clear();
  });
}
