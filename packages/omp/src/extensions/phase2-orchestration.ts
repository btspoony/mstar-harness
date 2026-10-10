/**
 * omp Phase-2 coordinator observation adapter. The host-facing `mstar_phase2`
 * tool binds only to the ACTIVE execution DB authority; workflow lifecycle,
 * coordinator identity and plan facts are re-read through that authority on
 * every probe. The adapter records only this host session's identity pointer
 * and checkpoint/reminder facts in its own hidden ledger.
 *
 * The host's async-job snapshot is session-local and may be unavailable. An
 * unavailable snapshot produces no observation, never an empty-job inference.
 * Notices are bounded, deduplicated by observation key and emitted only after
 * the corresponding ledger record is appended.
 *
 * No process spawn, screen parsing, plan launch, engine-row mutation, timer,
 * polling loop, fabricated job event or stop-loop continuation occurs here.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  WORKFLOW_TERMINAL_STATUSES,
  canonicalizeNearestExisting,
  executionContextFor,
  probeCheckoutRoot,
  readExecutionAuthority,
  readMainWorktree,
  resolveHarnessDir,
  resumeExecutionSession,
  resolveWorkflowDir,
} from "@mstar-harness/engine";
import type {
  ExecutionBinding,
  ExecutionIdentity,
  ExecutionPlanView,
  ExecutionRead,
  ExecutionState,
} from "@mstar-harness/engine";
import {
  decidePhase2Reminder,
  type CheckpointReason,
  type Phase2Observation,
  type Phase2Request,
  type ReminderState,
} from "../phase2-orchestration";
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
  | Phase2CheckpointRecord
  | Phase2ReminderRecord
  | Phase2TurnRecord;

export type Phase2SessionState = Readonly<{
  /** The session's own ACTIVE binding, or `null` when it never adopted one. */
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

/** The stable engine refusal code of a thrown error, or this adapter's own default. */
function engineCodeOf(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.includes(".") ? code : fallback;
}

/**
 * Structural guard for the §3.1 binding value a record persists. Its rules are
 * the engine's own reference shape (`execution-session.ts` `assertRefShape`):
 * the workflow's coordinator seat — its role, and no per-plan scope at all — so
 * an "ACTIVE" binding this guard admits is one the engine could actually accept;
 * a record whose declared shape is impossible is history, not a binding. A
 * `planId` member is rejected outright rather than normalized away: silently
 * dropping it would re-home the removed scoped seat as coordinator history.
 */
function isExecutionBinding(value: unknown): value is ExecutionBinding {
  if (!isPlainObject(value) || value.version !== 1 || !isNonEmptyString(value.harnessRoot)) return false;
  const session = value.session;
  if (!isPlainObject(session)) return false;
  if (!isNonEmptyString(session.storeId) || !isNonEmptyString(session.sessionId) || !isNonEmptyString(session.workflowId)) return false;
  if (session.role !== "coordinator") return false;
  if ("planId" in session) return false;
  return typeof session.epoch === "number" && Number.isSafeInteger(session.epoch) && session.epoch > 0;
}

/**
 * The same adopted execution binding, compared on its real §3.1 fields rather
 * than a serialized envelope: version, the canonical control root, and the
 * session reference's store/epoch/workflow/role/session identity. Every field is
 * a value fact, so two bindings are equal exactly when they describe the same
 * stored row — the idempotent same-bind check needs no byte rendering.
 */
function sameExecutionBinding(a: ExecutionBinding, b: ExecutionBinding): boolean {
  return (
    a.version === b.version &&
    a.harnessRoot === b.harnessRoot &&
    a.session.storeId === b.session.storeId &&
    a.session.epoch === b.session.epoch &&
    a.session.workflowId === b.session.workflowId &&
    a.session.role === b.session.role &&
    a.session.sessionId === b.session.sessionId
  );
}

/** Structural guard for a record read back from the ledger (`data` is `unknown`). */
function isPhase2Record(value: unknown): value is Phase2Record {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.hostSessionId) || !isNonEmptyString(value.workflowId)) return false;
  switch (value.kind) {
    case "bind":
      return value.version === BIND_RECORD_VERSION && isExecutionBinding(value.executionBinding);
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
    return { binding: null, reminder: { acknowledgedKey: null, remindedKeys: [], blocked: false } };
  }
  const binding = records[bindingIndex] as Phase2BindingRecord;
  let acknowledgedKey: string | null = null;
  let blocked = false;
  const remindedKeys: string[] = [];
  for (const record of records.slice(bindingIndex + 1)) {
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
  /** Engine plan facts, already reduced to `id/status/coordination-revision`. */
  planFacts: readonly string[];
}>;

/** Stable, sorted projection digest: the observation identity compared and latched. */
export function phase2ObservationKey(facts: Phase2ObservationFacts): string {
  const lines = [
    `workflow:${facts.workflowId}`,
    `session:${facts.hostSessionId}`,
    ...facts.running.map((job) => `job:${job.id}:${job.type}:${job.status}`).sort(),
    ...facts.planFacts.slice().sort()
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}


/* ------------------------------------------------------------------------- *
 * Engine probes (read-only; ownership and phase are re-read every time)
 * ------------------------------------------------------------------------- */

/** The observed lifecycle a diagnostic may cite — only from a successfully read authority. */
type ObservedStatus = Readonly<{ workflowId: string; status: string }>;

/**
 * One successful ACTIVE DB ownership probe, with the lifecycle facts consumed
 * by the observation projection and the workflow directory that scopes it.
 */
type WorkflowProbe =
  | Readonly<{
      ok: true;
      workflowId: string;
      status: string;
      phase: string | null;
      workflowDir: string;
      planFacts: readonly string[];
      binding: ExecutionBinding;
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

/** `null` when an ACTIVE workflow status is terminal. */
function workflowIsTerminal(state: { status: string }): boolean {
  return (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(state.status);
}

/** Per-plan stable facts from the DB view — the same terms, from the authoritative source. */
function planFactsOfView(views: readonly ExecutionPlanView[]): readonly string[] {
  const facts: string[] = [];
  for (const view of views) {
    const planId = isNonEmptyString(view.plan.id) ? view.plan.id : isNonEmptyString(view.plan.plan_id) ? view.plan.plan_id : "";
    if (planId === "") continue;
    const coordination = isPlainObject(view.coordination) ? view.coordination : null;
    facts.push(
      [
        `plan:${planId}`,
        isNonEmptyString(view.plan.status) ? view.plan.status : "",
        coordination !== null && typeof coordination.revision === "number" ? String(coordination.revision) : "",
      ].join(":"),
    );
  }
  return facts;
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
    role: "coordinator",
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

  const STALE_CODES = [
    "store.stale-epoch",
    "execution.session-unavailable",
    "execution.scope-mismatch",
    "phase2.binding-stale",
  ];

  const bindingTermsOf = (
    state: Phase2SessionState,
  ): Readonly<{ workflowId: string; hostSessionId: string }> | null =>
    state.binding === null ? null : { workflowId: state.binding.workflowId, hostSessionId: state.binding.hostSessionId };

  const probeOwnership = async (
    ctx: ExtensionContext,
    state: Phase2SessionState,
    requirePhase2: boolean,
  ): Promise<WorkflowProbe> => {
    const probe =
      state.binding === null
        ? ({
            ok: false,
            code: "phase2.not-bound",
            message: "this session holds no Phase-2 observation binding",
          } as const)
        : await probeActiveWorkflow(ctx, state.binding, requirePhase2);
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
   * host snapshot and the engine facts the key is computed from. Every failure
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

    const running = snapshot.running.map((job) => ({ id: job.id, type: job.type, status: job.status }));
    const terminalIds = snapshot.recent.filter((job) => job.status !== "running").map((job) => job.id);
    const recentTerminalIds = terminalIds.filter((id) => !consumedTerminalIds.has(id));
    const key = phase2ObservationKey({
      workflowId: terms.workflowId,
      hostSessionId: terms.hostSessionId,
      running,
      planFacts: probe.planFacts,
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
    const identity: ExecutionIdentity = { source: "host", sessionId: hostSessionId, workflowId, role: "coordinator" };
    try {
      await resumeExecutionSession(executionContextFor({ harnessDir: harnessRoot }, identity), coordinator);
    } catch (error) {
      return refuse(engineCodeOf(error, "phase2.binding-stale"), `the DB coordinator binding of workflow ${workflowId} is not current: ${String(error)}`);
    }
    const executionBinding = executionBindingOf(harnessRoot, coordinator);
    const existing = derivePhase2State(ctx.sessionManager.getEntries(), hostSessionId).binding;
    if (existing !== null && existing.workflowId === workflowId && sameExecutionBinding(existing.executionBinding, executionBinding)) {
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
  /** `bind` adopts this session's ACTIVE DB coordinator identity for one workflow. */
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
    return bindActive(params.workflowId, ctx, hostSessionId, ownHarness);
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

  pi.registerTool({
    name: TOOL_NAME,
    label: "Phase-2 orchestration",
    description:
      'Morning Star Phase-2 host observation. `{operation:"bind"}` adopts this session\'s identity pointer for one explicitly named workflow from the ACTIVE DB coordinator binding, never from the call. `{operation:"checkpoint"}` acknowledges a run of the shared rescheduling checkpoint against the sample taken at that moment and can assert a block. `{operation:"export-history"}` returns THIS session\'s bounded hidden-history evidence bytes for one workflow (no file is written and no authority is granted). Not a user activation command: nothing is spawned, merged or written to engine state.',
    parameters: z.union([bindRequest, exportHistoryRequest, checkpointRequest]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const request = params as unknown as Phase2Request;
        const result =
          request.operation === "bind"
            ? await bind(request, ctx)
            : request.operation === "export-history"
              ? await exportHistory(request, ctx)
              : await checkpoint(request, ctx);
        return {
          content: [{ type: "text", text: result.text }],
          details: { mstarPhase2: result.details, ok: result.ok },
          isError: result.isError,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `the phase-2 tool failed without touching engine or model state: ${String(error)}` }],
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
