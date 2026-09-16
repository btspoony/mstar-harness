/**
 * phase2-orchestration — omp extension: the native `mstar_phase2` tool and the
 * bounded host lifecycle adapter for Phase-2 opportunity reminders.
 *
 * Primary spec: `{SPECS_DIR}/omp-phase2-instances.md` §A (native observation),
 * §B (reminder event/latch) and §C (capacity/reservation); plan
 * the registered Phase-2 instances plan T3. The two decisions this module consumes
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
 * identities (`mstar plan bind --coordinator` mints its own UUID), so the
 * binding records **both**: the envelope path is the engine-side ownership
 * reference every later probe re-verifies against the snapshot, and the host
 * session id is the exact-session filter for the ledger. What this does not
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
 * - `before_agent_start` / `tool_result` only consume native-result coverage
 *   (the recently settled ids the host's delivery already owns).
 * - `agent_end` is the sole emission point: at most one `pi.sendMessage`
 *   advisory (`{triggerTurn:true, deliverAs:"followUp"}`) per **changed**
 *   observation, recorded with `appendEntry` before it is sent.
 * - session start/switch/branch/tree reconstruct from the ledger with the exact
 *   host session identity; `session_shutdown` invalidates the callback
 *   generation so a late asynchronous sample can never emit into a dead one.
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
  probeCheckoutRoot,
  readMainWorktree,
  readSessionEnvelope,
  readWorkflowSnapshot,
  resolveWorkflowDir,
} from "@mstar-harness/engine";
import type { CoordinationSession, PlanRow, WorkflowSnapshot } from "@mstar-harness/engine";
import {
  decidePhase2Reminder,
  readPhase2Settings,
  type CheckpointReason,
  type Phase2Observation,
  type Phase2Request,
  type ReminderState,
} from "../phase2-orchestration";
import { recordPlanLaunch, reservePlanLaunch, type PlanLaunchResult } from "../phase2-launches";

/** Ledger `customType` of this feature's decision records (the only writer). */
export const PHASE2_CUSTOM_TYPE = "mstar:phase2";
/** `customType` of the bounded Phase-2 advisory (`agent_end`, triggerTurn+followUp). */
export const PHASE2_ADVISORY_CUSTOM_TYPE = "mstar:phase2-advisory";
/** `customType` of a bounded diagnostic notice — informational, never a continuation. */
export const PHASE2_NOTICE_CUSTOM_TYPE = "mstar:phase2-notice";
/** The exact accepted engine phase label for "this coordinator is executing Phase 2". */
export const PHASE2_PHASE = "phase-2-execute";
/** The single tool this extension registers (never an activation command). */
const TOOL_NAME = "mstar_phase2";
/** Record schema version; bumped only by a deliberate migration. */
const RECORD_VERSION = 1;
/** Plugin-owned transport journal written by T2 (`phase2-launches.ts`). */
const JOURNAL_FILE = "omp-launches.json";

/** The advisory body: a pointer to the shared checkpoint, and nothing more. */
const ADVISORY_TEXT = [
  "Phase-2 opportunity reminder: run the shared rescheduling checkpoint",
  "({SPECS_DIR}/phase2-proactive-scheduling.md) and honor any blocker before dispatching.",
  "This is an observation, not a dispatch: it asserts nothing about any plan being ready.",
].join(" ");

/* ------------------------------------------------------------------------- *
 * Durable records (session ledger only — never a second status register)
 * ------------------------------------------------------------------------- */

export type Phase2BindingRecord = Readonly<{
  version: 1;
  kind: "bind";
  workflowId: string;
  hostSessionId: string;
  coordinatorSessionPath: string;
  /** The engine `session_id` of that envelope at bind time — re-read and compared on every probe. */
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

export type Phase2Record = Phase2BindingRecord | Phase2CheckpointRecord | Phase2ReminderRecord | Phase2TurnRecord;

export type Phase2SessionState = Readonly<{
  /** The session's own identity pointer, or `null` when it never bound (or the binding is not a record for this session). */
  binding: Phase2BindingRecord | null;
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

/** Structural guard for a record read back from the ledger (`data` is `unknown`). */
function isPhase2Record(value: unknown): value is Phase2Record {
  if (!isPlainObject(value)) return false;
  if (value.version !== RECORD_VERSION) return false;
  if (!isNonEmptyString(value.hostSessionId) || !isNonEmptyString(value.workflowId)) return false;
  switch (value.kind) {
    case "bind":
      return (
        isNonEmptyString(value.coordinatorSessionPath) &&
        isNonEmptyString(value.coordinatorSessionId) &&
        isNonEmptyString(value.harnessRoot)
      );
    case "checkpoint":
      return (
        CHECKPOINT_REASONS.includes(value.reason as CheckpointReason) &&
        (CHECKPOINT_DECISIONS as readonly unknown[]).includes(value.decision) &&
        typeof value.note === "string" &&
        (value.observationKey === null || isNonEmptyString(value.observationKey))
      );
    case "reminder":
      return isNonEmptyString(value.observationKey);
    case "user-turn":
      return true;
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
 * latch that belongs to it. Records for a *different* workflow than the current
 * binding are ignored, so a stale binding from an earlier lifecycle cannot keep
 * a key acknowledged or a block asserted in the new one.
 */
export function derivePhase2State(entries: readonly SessionEntry[], sessionId: string): Phase2SessionState {
  const records = readPhase2Records(entries, sessionId);
  let binding: Phase2BindingRecord | null = null;
  for (const record of records) {
    if (record.kind === "bind") binding = record;
  }
  if (binding === null) {
    return { binding: null, reminder: { acknowledgedKey: null, remindedKeys: [], blocked: false } };
  }
  let acknowledgedKey: string | null = null;
  let blocked = false;
  const remindedKeys: string[] = [];
  for (const record of records) {
    if (record.workflowId !== binding.workflowId) continue;
    if (record.kind === "checkpoint") {
      blocked = record.decision === "blocked";
      if (record.observationKey !== null) acknowledgedKey = record.observationKey;
    } else if (record.kind === "user-turn") {
      blocked = false;
    } else if (record.kind === "reminder") {
      remindedKeys.push(record.observationKey);
    }
  }
  return { binding, reminder: { acknowledgedKey, remindedKeys, blocked } };
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

type WorkflowProbe =
  | Readonly<{ ok: true; workflowDir: string; snapshot: WorkflowSnapshot }>
  | Readonly<{ ok: false; code: string; message: string }>;

type SamplingResult = Readonly<{
  /** The bound coordinator owns a live workflow in `phase-2-execute`. */
  ownedPhase2: boolean;
  /** The computed observation, or `null` when any required read failed (never a guessed key). */
  observation: Phase2Observation | null;
  /** The first refusal, for a bounded diagnostic; `null` when the sample was complete. */
  refusal: Readonly<{ code: string; message: string }> | null;
}>;

/** `null` when `snapshot.status` is terminal. */
function workflowIsTerminal(snapshot: WorkflowSnapshot): boolean {
  return (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(snapshot.status);
}

/**
 * Resolve the workflow directory under the binding's own control harness root
 * and read the named snapshot, then verify that this session is still exactly
 * the snapshot's bound coordinator and (when required) that the lifecycle is
 * running in `phase-2-execute`.
 */
function probeWorkflow(ctx: ExtensionContext, binding: Phase2BindingRecord, requirePhase2: boolean): WorkflowProbe {
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
    };
  }
  if (workflowIsTerminal(snapshot)) {
    return {
      ok: false,
      code: "phase2.workflow-terminal",
      message: `workflow ${snapshot.id} is ${snapshot.status}; the Phase-2 observation disables itself on a terminal lifecycle`,
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
    };
  }
  if (requirePhase2 && (snapshot.status !== "running" || snapshot.phase !== PHASE2_PHASE)) {
    return {
      ok: false,
      code: "phase2.phase-inactive",
      message: `workflow ${snapshot.id} is ${snapshot.status} at phase ${JSON.stringify(snapshot.phase ?? null)}; the Phase-2 observation requires "${PHASE2_PHASE}"`,
    };
  }
  return { ok: true, workflowDir, snapshot };
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

  /** One bounded diagnostic per code and generation: repeated identical refusals stay silent. */
  const diagnose = (code: string, message: string): void => {
    if (gate.reported.has(code)) return;
    gate.reported.add(code);
    notice(`Phase-2 observation inactive (${code}): ${message}`);
  };

  const appendRecord = (record: Phase2Record): boolean => {
    try {
      pi.appendEntry(PHASE2_CUSTOM_TYPE, record);
      return true;
    } catch {
      return false;
    }
  };

  /** Codes that mean the binding is no longer current: the bound envelope is gone or replaced. */
  const STALE_CODES = ["phase2.envelope-unreadable", "phase2.ownership-drift"];

  /**
   * The one ownership probe every tool and event uses: it re-reads the bound
   * envelope and the named snapshot, and marks this instance's binding
   * not-current when either half no longer matches. The mark is local and
   * process-scoped (the durable binding record is never rewritten as if the
   * child had handed off); a later `bind` with the current envelope clears it.
   */
  const probeOwnership = (ctx: ExtensionContext, binding: Phase2BindingRecord, requirePhase2: boolean): WorkflowProbe => {
    const probe = probeWorkflow(ctx, binding, requirePhase2);
    if (!probe.ok && STALE_CODES.includes(probe.code)) gate.stale = { code: probe.code, message: probe.message };
    return probe;
  };

  /** A refusal sentence a caller sees only while its binding is marked not-current. */
  const staleHint = (): string =>
    gate.stale === null
      ? ""
      : " The local binding is marked not-current; re-run {operation:\"bind\"} with the current coordinator envelope before relying on this session.";

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
  const sample = async (ctx: ExtensionContext, binding: Phase2BindingRecord, probe: WorkflowProbe): Promise<SamplingResult> => {
    if (!probe.ok) return { ownedPhase2: false, observation: null, refusal: { code: probe.code, message: probe.message } };

    const snapshot = ctx.getAsyncJobSnapshot();
    if (snapshot === null) {
      return {
        ownedPhase2: true,
        observation: null,
        refusal: {
          code: "phase2.snapshot-unavailable",
          message: "the host async-job snapshot is unavailable for this session; null is not \"no jobs\"",
        },
      };
    }

    const settings = await readPhase2Settings(ctx.cwd);
    if (!settings.ok) {
      return {
        ownedPhase2: true,
        observation: null,
        refusal: { code: `phase2.${settings.reason}`, message: settings.message },
      };
    }

    const running = snapshot.running.map((job) => ({ id: job.id, type: job.type, status: job.status }));
    const terminalIds = snapshot.recent.filter((job) => job.status !== "running").map((job) => job.id);
    const recentTerminalIds = terminalIds.filter((id) => !consumedTerminalIds.has(id));
    const launchFacts = settings.value.phase2PlanInstances
      ? `${journalFactsOf(probe.workflowDir)}:${settings.value.maxPlanInstances}`
      : "";
    const key = phase2ObservationKey({
      workflowId: binding.workflowId,
      hostSessionId: binding.hostSessionId,
      running,
      planFacts: planFactsOf(probe.snapshot),
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
    };
  };

  /**
   * Consume native-result coverage: the ids the host's completion delivery owns
   * for this session are marked seen, so a later sample never mistakes an
   * already-delivered result for a fresh opportunity.
   */
  const consumeNativeResults = (ctx: ExtensionContext): void => {
    const snapshot = ctx.getAsyncJobSnapshot();
    if (snapshot === null) return;
    for (const job of snapshot.recent) {
      if (job.status !== "running") consumedTerminalIds.add(job.id);
    }
  };

  /**
   * The sole emission point. At most one bounded advisory per changed
   * observation; the key is recorded **before** it is sent, and any
   * unavailable/foreign/drifted fact results in silence.
   */
  const emitAdvisory = async (ctx: ExtensionContext): Promise<void> => {
    const state = derivePhase2State(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
    if (state.binding === null) return;
    const generation = gate.generation;
    const probed = probeOwnership(ctx, state.binding, true);
    const sampled = await sample(ctx, state.binding, probed);
    if (generation !== gate.generation || gate.navigationPending) return;
    if (sampled.refusal !== null) diagnose(sampled.refusal.code, sampled.refusal.message);

    const observation = sampled.observation ?? NO_OBSERVATION;
    const decision = decidePhase2Reminder(state.reminder, observation, {
      boundPhase2: sampled.ownedPhase2,
      pendingMessages: ctx.hasPendingMessages(),
      userTurn: gate.userTurn,
      snapshotAvailable: sampled.observation !== null,
    });
    gate.userTurn = false;
    if (decision === "silent") return;

    // Record-before-send: the latch is durable before the advisory can be seen.
    const recorded = appendRecord({
      version: RECORD_VERSION,
      kind: "reminder",
      hostSessionId: state.binding.hostSessionId,
      workflowId: state.binding.workflowId,
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

  /** `bind` — record this session's observation identity for one explicit workflow. */
  const bind = (params: Extract<Phase2Request, { operation: "bind" }>, ctx: ExtensionContext): ToolOutcome => {
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

    const sessionPath = canonicalizeNearestExisting(params.coordinatorSessionPath);
    let envelope: CoordinationSession;
    try {
      envelope = readSessionEnvelope(sessionPath);
    } catch (error) {
      return refuse("phase2.envelope-unreadable", `no readable coordination session envelope at ${sessionPath}: ${String(error)}`);
    }
    if (envelope.role !== "coordinator") {
      return refuse(
        "phase2.plan-pm-session",
        `session ${envelope.session_id} is a ${envelope.role} session; a scoped-plan PM never binds the Phase-2 observation`,
      );
    }
    if (envelope.workflow_id !== params.workflowId) {
      return refuse(
        "phase2.workflow-mismatch",
        `the session envelope binds workflow ${envelope.workflow_id}, not the named ${params.workflowId}`,
      );
    }
    const harnessRoot = canonicalizeNearestExisting(envelope.harness_root);

    let workflowDir: string;
    try {
      workflowDir = join(resolveWorkflowDir(ctx.cwd, { harnessDir: harnessRoot }), params.workflowId);
    } catch (error) {
      return refuse(
        "phase2.harness-unresolvable",
        `the envelope's control harness root ${harnessRoot} does not resolve a workflow dir from ${ctx.cwd}: ${String(error)}`,
      );
    }
    let snapshot: WorkflowSnapshot;
    try {
      snapshot = readWorkflowSnapshot(workflowDir).snapshot;
    } catch (error) {
      return refuse("phase2.snapshot-unreadable", `cannot read the workflow snapshot for ${params.workflowId}: ${String(error)}`);
    }
    if (snapshot.id !== params.workflowId) {
      return refuse(
        "phase2.workflow-mismatch",
        `the snapshot at ${workflowDir} describes workflow ${snapshot.id}, not ${params.workflowId}`,
      );
    }
    if (workflowIsTerminal(snapshot)) {
      return refuse("phase2.workflow-terminal", `workflow ${snapshot.id} is ${snapshot.status}; nothing was bound.`);
    }
    const coordinator = snapshot.coordination?.coordinator;
    if (coordinator?.session_id !== envelope.session_id || coordinator.session_file !== sessionPath) {
      return refuse(
        "phase2.coordinator-mismatch",
        `workflow ${snapshot.id} is bound to coordinator envelope ${coordinator?.session_file ?? "(none)"}, not to ${sessionPath}`,
      );
    }
    // The engine's own coordinator-residency rule, read strictly: the caller's
    // own checkout root must be the main worktree or the recorded integration
    // worktree. (A bare path-prefix test would also accept a linked plan
    // worktree that merely sits under the repository root, which is exactly the
    // checkout an extra primary runs in.)
    const main = readMainWorktree(ctx.cwd);
    const allowed: string[] = [];
    if (main !== null) allowed.push(canonicalizeNearestExisting(main.root));
    if (isNonEmptyString(snapshot.integration_worktree_path)) {
      allowed.push(canonicalizeNearestExisting(snapshot.integration_worktree_path));
    }
    const checkout = probeCheckoutRoot(ctx.cwd);
    const here = checkout === null ? null : canonicalizeNearestExisting(checkout);
    if (here === null || !allowed.includes(here)) {
      return refuse(
        "phase2.scope-mismatch",
        `a coordinator session binds from the main worktree or the recorded integration worktree; ${here ?? ctx.cwd} is neither (${allowed.join(", ") || "none resolvable"})`,
      );
    }

    const existing = derivePhase2State(ctx.sessionManager.getEntries(), hostSessionId).binding;
    if (
      existing !== null &&
      existing.workflowId === params.workflowId &&
      existing.coordinatorSessionPath === sessionPath &&
      existing.coordinatorSessionId === envelope.session_id &&
      existing.harnessRoot === harnessRoot
    ) {
      gate.stale = null;
      return outcome(true, false, `this session is already bound to ${params.workflowId}; the identity pointer is unchanged.`, {
        code: "already-bound",
        applied: false,
        workflowId: params.workflowId,
        hostSessionId,
        coordinatorSessionPath: sessionPath,
        coordinatorSessionId: envelope.session_id,
      });
    }

    const record: Phase2BindingRecord = {
      version: RECORD_VERSION,
      kind: "bind",
      workflowId: params.workflowId,
      hostSessionId,
      coordinatorSessionPath: sessionPath,
      coordinatorSessionId: envelope.session_id,
      harnessRoot,
    };
    if (!appendRecord(record)) {
      return refuse("phase2.record-failed", "the observation identity could not be recorded in this session; nothing was bound.");
    }
    gate.reported.clear();
    gate.stale = null;
    return outcome(true, false, `bound the Phase-2 observation to workflow ${params.workflowId}.`, {
      code: "bound",
      applied: true,
      workflowId: params.workflowId,
      hostSessionId,
      coordinatorSessionPath: sessionPath,
      coordinatorSessionId: envelope.session_id,
      harnessRoot,
      phase: snapshot.phase ?? null,
    });
  };

  /** `checkpoint` — acknowledge the scheduling spec against the sample taken now. */
  const checkpoint = async (
    params: Extract<Phase2Request, { operation: "checkpoint" }>,
    ctx: ExtensionContext,
  ): Promise<ToolOutcome> => {
    const state = derivePhase2State(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
    if (state.binding === null) {
      return refuse("phase2.not-bound", "this session holds no Phase-2 observation binding; call {operation:\"bind\"} first.");
    }
    const probe = probeOwnership(ctx, state.binding, true);
    if (!probe.ok) {
      return refuse(probe.code, `${probe.message}. The checkpoint was not recorded.${staleHint()}`);
    }
    const sampled = await sample(ctx, state.binding, probe);
    if (sampled.refusal !== null) diagnose(sampled.refusal.code, sampled.refusal.message);
    const key = sampled.observation?.key ?? null;
    const blocked = params.decision === "blocked";
    if (
      !appendRecord({
        version: RECORD_VERSION,
        kind: "checkpoint",
        hostSessionId: state.binding.hostSessionId,
        workflowId: state.binding.workflowId,
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

  /** `reserve-launch` / `record-launch` — the T2 journal, with authority from this session's binding. */
  const launch = async (
    request: Extract<Phase2Request, { operation: "reserve-launch" } | { operation: "record-launch" }>,
    ctx: ExtensionContext,
  ): Promise<ToolOutcome> => {
    const state = derivePhase2State(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
    if (state.binding === null) {
      return refuse("phase2.not-bound", "this session holds no Phase-2 observation binding; call {operation:\"bind\"} first.");
    }
    const probe = probeOwnership(ctx, state.binding, true);
    if (!probe.ok) return refuse(probe.code, `${probe.message}. No launch bookkeeping was written.${staleHint()}`);

    const authority = { coordinatorSessionPath: state.binding.coordinatorSessionPath, cwd: ctx.cwd };
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

  /* ---------------------------------------------------------------- tool --- */

  const skillRef = z.object({ name: z.string(), source: z.string() }).strict();
  const capabilityRef = z.object({ executable: z.string(), version: z.string(), target: z.string() }).strict();
  const bindRequest = z
    .object({ operation: z.literal("bind"), workflowId: z.string(), coordinatorSessionPath: z.string() })
    .strict();
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
      'Morning Star Phase-2 host observation. `{operation:"bind"}` records this coordinator session\'s identity pointer for one explicitly named workflow (authority is derived from the session envelope and the named snapshot, never from the call). `{operation:"checkpoint"}` acknowledges a run of the shared rescheduling checkpoint against the sample taken at that moment and can assert a block. `{operation:"reserve-launch"}` and `{operation:"record-launch"}` admit and record one extra plan-primary launch intent in the plugin\'s local transport journal; the optional Herdr/tmux skill performs every CLI call. Not a user activation command: nothing is spawned, merged, leased or written to engine state.',
    parameters: z.union([bindRequest, checkpointRequest, reserveRequest, recordRequest]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const request = params as unknown as Phase2Request;
        const result =
          request.operation === "bind"
            ? bind(request, ctx)
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
    if (state.binding === null || !state.reminder.blocked) return;
    // A recorded block is cleared by a real user turn — durably, so a reload
    // cannot resurrect a blocker the user already overrode.
    appendRecord({
      version: RECORD_VERSION,
      kind: "user-turn",
      hostSessionId: state.binding.hostSessionId,
      workflowId: state.binding.workflowId,
    });
  });

  // Sampling boundaries that only consume native-result coverage.
  pi.on("before_agent_start", (_event, ctx) => {
    consumeNativeResults(ctx);
  });
  pi.on("tool_result", (_event, ctx) => {
    consumeNativeResults(ctx);
  });

  // The one emission point.
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
