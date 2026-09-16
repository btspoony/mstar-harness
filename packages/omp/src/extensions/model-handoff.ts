/**
 * model-handoff — omp extension: the coordinator-session half of the Morning
 * Star iteration model handoff.
 *
 * The saved preference lives in native omp plugin settings
 * (`packages/omp/src/model-handoff-settings.ts`, read through the exported
 * `getPluginSettings` helper — never a second settings file or UI). This module
 * owns the *session* half: it arms `@slow` at an explicit new-iteration start,
 * observes unowned model changes while that arm is pending, guards session
 * navigation around an invoked model action, and recovers a durable attempt as
 * `uncertain`.
 *
 * ## What this module may claim — and what it must not
 *
 * The host exposes no attributed model-selection event and no cancellation for
 * an already invoked `setModel` (spec §B1), so:
 *
 * - Pending cancellation is a **conservative observation**, not exact user
 *   attribution: a new unowned `model_change` entry, or a live model that
 *   differs from the armed baseline, cancels the not-yet-executed switch.
 *   Another extension or a host-driven change can therefore cancel a pending
 *   handoff too; that safety bias is disclosed rather than hidden.
 * - The durable record is appended **before** the action
 *   (attempt-before-action) and an interrupted attempt recovers as `uncertain`
 *   with no retry. `appendEntry` is not a flush/storage acknowledgement, so this
 *   is at-most-once per *persisted* attempt under normal session persistence —
 *   **not** exactly-once and not power-loss durable. No earlier model is ever
 *   restored "back".
 * - Same-model reselection and transactional withdrawal of an already invoked
 *   action are not requirements; nothing here claims them.
 *
 * ## Lifecycle (durable state is the session ledger, never a second store)
 *
 * `pi.appendEntry("mstar:model-handoff", HandoffRecord)` is the only writer.
 * Every decision replays the full ledger (`getEntries()`) with exact session-ID
 * filtering, so a fork with a new session ID inherits no authority and a
 * terminal binding cannot be resurrected by tree navigation.
 *
 * - **Arm** (`mstar_model_handoff` `{operation:"start"}`): the PM's first
 *   preparation action. A false/absent preference is inert and writes nothing;
 *   the explicit E1 reservation is validated by
 *   `packages/omp/src/model-handoff-readiness.ts`; the arm attempt is recorded,
 *   `@slow` is selected once through `pi.setModel`, and `pending` is entered
 *   only when the live model *and* the newest ledger entry agree on `@slow`.
 * - **Fire** (`{operation:"phase1-complete"}`): re-reads the preference, runs
 *   the frozen E2 readiness checkpoint, then performs — synchronously, with no
 *   `await` in between — the final pending scan, the `pending → attempting`
 *   record append, the navigation-guard arm and the single public `setModel`.
 * - **Observation** (`input`, `before_agent_start`, `tool_result`, `agent_end`,
 *   navigation-before events, reconstruction) only ever *cancels*; it never
 *   switches a model and never selects `@slow` again.
 * - **Navigation**: while an action is in flight, a navigation-before handler
 *   returns `{ cancel: true }` immediately (no `await` inside the handler — an
 *   extension-handler timeout would otherwise let navigation continue). When
 *   navigation arrives first it advances a generation fence before any
 *   asynchronous callback can start an action; the fence clears only on the
 *   matching post-navigation event plus reconstruction. If no post-event arrives
 *   (e.g. another extension cancelled the navigation) the suspended condition
 *   stays visibly recorded instead of being guessed away.
 *
 * The extension never writes role mappings, thinking level, service tiers, goal
 * state, workflow lifecycle or another session's model, and it never shadows a
 * native command or key.
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { inspectPhase1Readiness, reserveHandoffBinding } from "../model-handoff-readiness";
import type {
  HandoffBinding,
  HandoffBindingInput,
  HandoffEntry,
  Phase1CompletionInput,
  Phase1Receipt,
} from "../model-handoff-readiness";
import { readHandoffSettings } from "../model-handoff-settings";

/** Ledger `customType` of the durable handoff record (the only writer). */
export const HANDOFF_CUSTOM_TYPE = "mstar:model-handoff";
/** Ledger `customType` of the durable coordinator-visible notice. */
export const HANDOFF_NOTICE_CUSTOM_TYPE = "mstar:model-handoff-notice";
/** Tool the PM calls as its first preparation action and at the completion checkpoint. */
const TOOL_NAME = "mstar_model_handoff";
/** Model role armed at iteration entry (spec §Iteration entry). */
const SLOW_SPEC = "@slow";
/** Record schema version; bumped only by a deliberate migration. */
const RECORD_VERSION = 1;

/** Non-pending states: a binding in one of these is never re-armed or retried. */
export type HandoffTerminalState = "handed_off" | "cancelled" | "failed" | "uncertain";

/** Durable state of one coordinator binding (`attempting` = action invoked, no outcome yet). */
export type HandoffState = "pending" | "attempting" | HandoffTerminalState;

/** Which model action the record describes. */
export type HandoffAction = "arm" | "handoff";

/**
 * Durable handoff record (primary spec §Durable state and action ordering).
 * `operationId` is a plugin-local attempt id, not host provenance. `receipt` is
 * the frozen E2 readiness receipt and is present only on the record written when
 * a target action was actually invoked.
 */
export type HandoffRecord = Readonly<{
  version: 1;
  binding: HandoffBinding;
  state: HandoffState;
  operationId: string;
  action: HandoffAction;
  baselineModelChangeId: string | null;
  observedModel: string | null;
  reason: string | null;
  receipt?: Phase1Receipt;
}>;

/** One replay decision for the current session, derived from the full ledger. */
export type SessionStateDecision =
  | { kind: "none" }
  | { kind: "pending"; record: HandoffRecord }
  | { kind: "terminal"; record: HandoffRecord; state: HandoffTerminalState }
  | { kind: "uncertain"; record: HandoffRecord; reason: string };

/** `"provider/modelId"` — the ledger's own `model_change` format. */
type ModelSpec = string;

function modelSpecOf(model: Readonly<{ provider: string; id: string }> | undefined): ModelSpec | null {
  return model === undefined ? null : `${model.provider}/${model.id}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural guard for a record read back from the ledger (`data` is `unknown`). */
function isHandoffRecord(value: unknown): value is HandoffRecord {
  if (!isPlainObject(value)) return false;
  const binding: unknown = value.binding;
  const state: unknown = value.state;
  return (
    value.version === RECORD_VERSION &&
    isPlainObject(binding) &&
    typeof binding.sessionId === "string" &&
    binding.sessionId !== "" &&
    typeof binding.workflowId === "string" &&
    (state === "pending" ||
      state === "attempting" ||
      state === "handed_off" ||
      state === "cancelled" ||
      state === "failed" ||
      state === "uncertain") &&
    (value.action === "arm" || value.action === "handoff") &&
    typeof value.operationId === "string" &&
    (value.baselineModelChangeId === null || typeof value.baselineModelChangeId === "string") &&
    (value.observedModel === null || typeof value.observedModel === "string") &&
    (value.reason === null || typeof value.reason === "string")
  );
}

/**
 * Every durable record written for **this** session, in recorded ledger order.
 * The session-ID filter is exact: a fork copies its parent's entries into a new
 * session file, and those records must not be mistaken for this session's
 * authority.
 */
export function readSessionRecords(entries: readonly SessionEntry[], sessionId: string): readonly HandoffRecord[] {
  const records: HandoffRecord[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== HANDOFF_CUSTOM_TYPE) continue;
    if (!isHandoffRecord(entry.data)) continue;
    if (entry.data.binding.sessionId !== sessionId) continue;
    records.push(entry.data);
  }
  return records;
}

function indexOfEntry(entries: readonly SessionEntry[], entryId: string | null): number {
  if (entryId === null) return -1;
  return entries.findIndex((entry) => entry.id === entryId);
}

/** Newest `model_change` entry in recorded order, or `null` when history has none. */
function lastModelChange(entries: readonly SessionEntry[]): Readonly<{ id: string; model: string }> | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.type === "model_change") return { id: entry.id, model: entry.model };
  }
  return null;
}

/**
 * The single replay rule for the current session (pure; writes nothing).
 *
 * `attempting` — a recorded attempt with no terminal outcome — is `uncertain`:
 * never replayed, never treated as success, and never a reason to restore an
 * older model. A `pending` record whose armed baseline cursor is absent from the
 * ledger is uncertainty too: the spec forbids resetting the observation window.
 */
export function decideSessionState(entries: readonly SessionEntry[], sessionId: string): SessionStateDecision {
  const latest = readSessionRecords(entries, sessionId).at(-1);
  if (latest === undefined) return { kind: "none" };
  if (latest.state === "attempting") {
    return {
      kind: "uncertain",
      record: latest,
      reason: `an interrupted ${latest.action} attempt (${latest.operationId}) has no recorded outcome`,
    };
  }
  if (latest.state === "pending") {
    if (indexOfEntry(entries, latest.baselineModelChangeId) < 0) {
      return {
        kind: "uncertain",
        record: latest,
        reason: `the armed baseline model-change entry ${String(latest.baselineModelChangeId)} is not in the ledger`,
      };
    }
    return { kind: "pending", record: latest };
  }
  return { kind: "terminal", record: latest, state: latest.state };
}

/**
 * Why a `pending` binding must be cancelled right now, or `null` when it may
 * still fire. Conservative by construction (spec §Cancellation): any unowned
 * `model_change` recorded after the armed baseline, or a live model that is not
 * the armed baseline, cancels the not-yet-executed switch. The extension's own
 * arm transition sits *at* the baseline and its own target transition happens
 * after the state left `pending`, so neither can self-cancel.
 */
export function pendingCancellationReason(
  entries: readonly SessionEntry[],
  record: HandoffRecord,
  liveModel: ModelSpec | null,
): string | null {
  const baselineIndex = indexOfEntry(entries, record.baselineModelChangeId);
  for (let index = baselineIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.type === "model_change") {
      return `an unowned model change to ${entry.model} was recorded while the handoff was pending`;
    }
  }
  if (liveModel !== record.observedModel) {
    return `the live model is ${liveModel ?? "unknown"}, not the armed baseline ${record.observedModel ?? "unknown"}`;
  }
  return null;
}

/**
 * In-memory operation gate (spec §B1). Never persisted: a refused navigation or
 * a fence that never clears is a per-process condition, not session truth.
 * `generation` is the fence asynchronous steps compare; it never moves backwards.
 */
type Gate = {
  /** Set synchronously before an invoked action, cleared only in `finally`. */
  actionInFlight: boolean;
  /** A navigation-before handler ran and its post-event has not arrived yet. */
  navigationPending: boolean;
  /** Monotonic fence; every navigation-before/post-event step advances it. */
  generation: number;
  /** One durable notice per suspension episode. */
  suspensionNotified: boolean;
};

/** Plugin-local attempt id (`operationId`), never host provenance. */
function newOperationId(action: HandoffAction): string {
  return `${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Whether the host session is a leaf/subagent (task) session rather than a
 * coordinator. A task session records `session_init`; a user *fork* carries a
 * `parentSession` header but no `session_init`, and the record's session-ID
 * filter already denies a fork the parent's authority — so the header alone is
 * deliberately not used as the marker.
 */
function isTaskSession(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getEntries().some((entry) => entry.type === "session_init");
}

/**
 * Resolve a role alias or model spec through the host facade. A resolver that
 * throws is "not resolvable" — never a silent success and never a reason to pick
 * some other model.
 */
function resolveSpec<T>(models: Readonly<{ resolve: (spec: string) => T | undefined }>, spec: string): T | undefined {
  try {
    return models.resolve(spec);
  } catch {
    return undefined;
  }
}

/** Tool result shape every path returns (the host renders it in TUI/print/JSON/RPC alike). */
type ToolOutcome = Readonly<{ ok: boolean; isError: boolean; text: string; details: Record<string, unknown> }>;

function outcome(ok: boolean, isError: boolean, text: string, details: Record<string, unknown> = {}): ToolOutcome {
  return { ok, isError, text, details };
}

/** Frozen role/report tuple accepted from the PM's completion call. */
type ToolSpecialistReceipt = Readonly<{ role: string; agentId: string; resultRef: string; reportPath: string }>;
/** Frozen per-plan Prepare evidence accepted from the PM's completion call. */
type ToolPlanEvidence = Readonly<{ planId: string; planPath: string; prepareEvidencePath: string }>;

/** Tool parameters: `{operation:"start"} | {operation:"phase1-complete"}` and their frozen fields. */
type ToolParams = {
  operation: "start" | "phase1-complete";
  workflowId: string;
  entry?: HandoffEntry;
  intent?: "new-iteration";
  authority?: "coordinator";
  coordinatorSessionPath?: string;
  mainWorktreeBranch?: string;
  reviews?: readonly ToolSpecialistReceipt[];
  plans?: readonly ToolPlanEvidence[];
};

export default function modelHandoff(pi: ExtensionAPI): void {
  const z = pi.zod;
  const gate: Gate = {
    actionInFlight: false,
    navigationPending: false,
    generation: 0,
    suspensionNotified: false,
  };

  /** Durable coordinator-visible notice; never log-only, never throws into the host. */
  const notice = (text: string): void => {
    try {
      pi.sendMessage({ customType: HANDOFF_NOTICE_CUSTOM_TYPE, content: text, display: true });
    } catch {
      // An unavailable notice channel at teardown must not break the caller.
    }
  };

  /**
   * Append one durable record. Returns `false` when the host refused the append
   * — which is *not* a storage-failure report, since this API is not a flush
   * acknowledgement — so a caller can decline to invoke an action it cannot
   * record first.
   */
  const appendRecord = (record: HandoffRecord): boolean => {
    try {
      pi.appendEntry(HANDOFF_CUSTOM_TYPE, record);
      return true;
    } catch {
      return false;
    }
  };

  /** Transition a binding to a terminal state, durably and visibly. */
  const terminalize = (
    record: HandoffRecord,
    state: HandoffTerminalState,
    reason: string,
    observedModel: ModelSpec | null,
  ): boolean => {
    const appended = appendRecord({
      ...record,
      state,
      operationId: newOperationId(record.action),
      observedModel,
      reason,
    });
    notice(
      appended
        ? `model handoff ${state} for this coordinator session: ${reason}. The session keeps ${observedModel ?? "its actual model"}; the saved preference is unchanged and later iterations still apply it.`
        : `model handoff ${state} for this coordinator session (the session record could not be appended): ${reason}. The session keeps ${observedModel ?? "its actual model"}.`,
    );
    return appended;
  };

  /**
   * Restore durable state for the session now attached to `ctx` **without**
   * switching anything: an interrupted attempt becomes `uncertain`, a pending
   * binding is restored as it is, a terminal binding stays terminal.
   */
  const reconstruct = (ctx: ExtensionContext): SessionStateDecision => {
    const decision = decideSessionState(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
    if (decision.kind === "uncertain") {
      terminalize(decision.record, "uncertain", decision.reason, modelSpecOf(ctx.models.current()));
    }
    return decision;
  };

  /**
   * Pending observation opportunity (spec §B1): cancel a waiting handoff when
   * the ledger or the live model moved away from the armed baseline. Never
   * switches a model, and a no-op while an action is in flight (the state is
   * `attempting` then, which the replay rule does not treat as pending).
   */
  const observePending = (ctx: ExtensionContext): void => {
    const entries = ctx.sessionManager.getEntries();
    const decision = decideSessionState(entries, ctx.sessionManager.getSessionId());
    if (decision.kind === "uncertain") {
      terminalize(decision.record, "uncertain", decision.reason, modelSpecOf(ctx.models.current()));
      return;
    }
    if (decision.kind !== "pending") return;
    const live = modelSpecOf(ctx.models.current());
    const reason = pendingCancellationReason(entries, decision.record, live);
    if (reason !== null) terminalize(decision.record, "cancelled", reason, live);
  };

  /** Fence check run after every asynchronous step; `null` while the sampled session is still valid. */
  const suspensionReason = (ctx: ExtensionContext, sessionId: string, generation: number): string | null => {
    if (gate.navigationPending) return "a session navigation is in progress";
    if (gate.generation !== generation) return "the session changed while the handoff was being checked";
    if (ctx.sessionManager.getSessionId() !== sessionId) return "the session id changed while the handoff was being checked";
    return null;
  };

  /** Refuse to start an action now; the suspension stays pending and becomes visible once. */
  const suspend = (reason: string): ToolOutcome => {
    if (!gate.suspensionNotified) {
      gate.suspensionNotified = true;
      notice(
        `model handoff suspended for this coordinator session: ${reason}. No model action was taken; the binding stays pending until the session settles.`,
      );
    }
    return outcome(false, true, `the handoff check was suspended: ${reason}. Nothing was switched; the binding stays pending.`, {
      code: "suspended",
      state: "pending",
      reason,
    });
  };

  /* --------------------------------------------------------------- arm --- */

  const arm = async (params: ToolParams, ctx: ExtensionContext): Promise<ToolOutcome> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const decision = reconstruct(ctx);

    if (decision.kind === "pending" || decision.kind === "uncertain") {
      return outcome(
        false,
        true,
        `this coordinator session already holds a ${decision.kind} model-handoff binding for ${decision.record.binding.workflowId}; the handoff is not re-armed.`,
        { code: "already-bound", state: decision.kind, workflowId: decision.record.binding.workflowId },
      );
    }
    if (decision.kind === "terminal" && decision.record.binding.workflowId === params.workflowId) {
      return outcome(
        false,
        true,
        `workflow ${params.workflowId} already has a ${decision.state} handoff binding in this session; a terminal binding is never re-armed.`,
        { code: "already-bound", state: decision.state, workflowId: params.workflowId },
      );
    }

    // The preference decides whether a binding exists at all: an unreadable or
    // disabled preference creates no record and no model action. Enabling the
    // preference never arms by itself (no settings-change callback exists here).
    const settings = await readHandoffSettings(ctx.cwd);
    if (!settings.ok) {
      return outcome(false, true, `the model-handoff preference could not be read: ${settings.message}`, {
        code: "settings-read-failed",
      });
    }
    if (!settings.value.modelHandoff) {
      return outcome(
        false,
        false,
        "modelHandoff is off in native settings; this session is not armed and its model is unchanged. Enabling it later does not retro-arm an in-flight iteration.",
        { code: "preference-off", handoffTarget: settings.value.handoffTarget },
      );
    }

    // E1: the explicit new-start binding is a trusted PM assertion checked
    // against host facts; the reservation is session-local and writes nothing.
    const bindingInput: HandoffBindingInput = {
      workflowId: params.workflowId,
      entry: params.entry ?? "iteration-start",
      intent: params.intent ?? "new-iteration",
      authority: params.authority ?? "coordinator",
    };
    const reservation = await reserveHandoffBinding(bindingInput, {
      sessionId,
      cwd: ctx.cwd,
      taskSession: isTaskSession(ctx),
    });
    if (!reservation.ok) {
      return outcome(
        false,
        true,
        `the new-iteration handoff binding was refused (${reservation.code}): ${reservation.message}`,
        { code: reservation.code },
      );
    }

    // Attempt-before-action: the arm attempt is durable before `@slow` is selected.
    const beforeArm = lastModelChange(ctx.sessionManager.getEntries());
    const attempt: HandoffRecord = {
      version: RECORD_VERSION,
      binding: reservation.binding,
      state: "attempting",
      operationId: newOperationId("arm"),
      action: "arm",
      baselineModelChangeId: null,
      observedModel: null,
      reason: `arming ${SLOW_SPEC} for a new iteration (entry ${bindingInput.entry})`,
    };
    if (!appendRecord(attempt)) {
      return outcome(false, true, "the arm attempt could not be recorded in this session; @slow was not selected.", {
        code: "record-failed",
        state: "attempting",
      });
    }

    const slow = resolveSpec(ctx.models, SLOW_SPEC);
    if (slow === undefined) {
      terminalize(attempt, "failed", `cannot resolve ${SLOW_SPEC} in this session's model configuration`, modelSpecOf(ctx.models.current()));
      return outcome(false, true, `cannot resolve ${SLOW_SPEC}; the session model is unchanged and no handoff is pending.`, {
        code: "slow-unresolved",
        state: "failed",
      });
    }
    const slowSpec = modelSpecOf(slow);

    let switched = false;
    try {
      switched = await pi.setModel(slow);
    } catch (error) {
      terminalize(attempt, "failed", `selecting ${slowSpec} failed: ${String(error)}`, modelSpecOf(ctx.models.current()));
      return outcome(false, true, `selecting ${SLOW_SPEC} (${slowSpec}) failed: ${String(error)}`, {
        code: "slow-selection-failed",
        state: "failed",
      });
    }
    if (!switched) {
      terminalize(
        attempt,
        "failed",
        `the host refused the ${slowSpec} selection (no configured auth for it)`,
        modelSpecOf(ctx.models.current()),
      );
      return outcome(
        false,
        true,
        `the host refused the ${SLOW_SPEC} selection (${slowSpec}); the session keeps its actual model and no handoff is pending.`,
        { code: "slow-selection-refused", state: "failed", actualModel: modelSpecOf(ctx.models.current()) },
      );
    }

    // Pending requires nonconflicting model/history evidence: the live model and
    // the newest ledger entry must both describe the armed role, and that entry
    // must be the arm's own transition unless history already said `@slow`.
    const afterArm = lastModelChange(ctx.sessionManager.getEntries());
    const liveAfterArm = modelSpecOf(ctx.models.current());
    const historyAgrees =
      afterArm !== null &&
      afterArm.model === slowSpec &&
      (beforeArm === null || afterArm.id !== beforeArm.id || beforeArm.model === slowSpec);
    if (liveAfterArm !== slowSpec || !historyAgrees) {
      terminalize(
        attempt,
        "failed",
        `conflicting model/history evidence after arming ${SLOW_SPEC}: live ${liveAfterArm ?? "unknown"}, newest ledger entry ${afterArm?.model ?? "none"}`,
        liveAfterArm,
      );
      return outcome(
        false,
        true,
        `the ${SLOW_SPEC} arm could not be confirmed (live ${liveAfterArm ?? "unknown"}, ledger ${afterArm?.model ?? "none"}); no handoff is pending.`,
        { code: "arm-evidence-conflict", state: "failed", actualModel: liveAfterArm },
      );
    }

    if (
      !appendRecord({
        ...attempt,
        state: "pending",
        baselineModelChangeId: afterArm.id,
        observedModel: slowSpec,
        reason: null,
      })
    ) {
      return outcome(false, true, `${SLOW_SPEC} was armed but the pending record could not be appended to this session.`, {
        code: "record-failed",
        state: "attempting",
        actualModel: liveAfterArm,
      });
    }
    return outcome(
      true,
      false,
      `armed ${SLOW_SPEC} (${slowSpec}) for new iteration ${reservation.binding.workflowId}; the handoff is pending and switches this session to ${settings.value.handoffTarget} only after a complete Phase 1.`,
      {
        code: "armed",
        state: "pending",
        workflowId: reservation.binding.workflowId,
        sessionId,
        baselineModelChangeId: afterArm.id,
        observedModel: slowSpec,
        handoffTarget: settings.value.handoffTarget,
      },
    );
  };

  /* -------------------------------------------------------------- fire --- */

  /**
   * Completion input: the frozen E2 payload. Shape is checked here (three
   * ordered returns, the bound plan evidence, the coordinator envelope path);
   * role order, uniqueness and current bytes stay E2's mechanical checks, so the
   * tuple is passed through unmodified rather than pre-filtered here.
   */
  const completionInputOf = (params: ToolParams, binding: HandoffBinding): Phase1CompletionInput | null => {
    const reviews = params.reviews;
    const plans = params.plans;
    if (
      reviews === undefined ||
      reviews.length !== 3 ||
      plans === undefined ||
      plans.length === 0 ||
      typeof params.coordinatorSessionPath !== "string" ||
      params.coordinatorSessionPath === "" ||
      typeof params.mainWorktreeBranch !== "string" ||
      params.mainWorktreeBranch === ""
    ) {
      return null;
    }
    return {
      workflowId: binding.workflowId,
      coordinatorSessionPath: params.coordinatorSessionPath,
      mainWorktreeBranch: params.mainWorktreeBranch,
      reviews: reviews as unknown as Phase1CompletionInput["reviews"],
      plans,
    };
  };

  const fire = async (params: ToolParams, ctx: ExtensionContext): Promise<ToolOutcome> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const generation = gate.generation;
    const decision = reconstruct(ctx);

    if (decision.kind !== "pending") {
      const described = decision.kind === "none" ? "no binding" : `${decision.kind} (${decision.record.binding.workflowId})`;
      return outcome(false, true, `no pending model handoff exists for this coordinator session: ${described}.`, {
        code: "not-pending",
      });
    }
    const record = decision.record;
    if (params.workflowId !== record.binding.workflowId) {
      return outcome(
        false,
        true,
        `the completion checkpoint names workflow ${params.workflowId}, but this session is bound to ${record.binding.workflowId}.`,
        { code: "binding-mismatch", workflowId: record.binding.workflowId },
      );
    }
    const completion = completionInputOf(params, record.binding);
    if (completion === null) {
      return outcome(
        false,
        true,
        "the completion checkpoint is incomplete: three ordered specialist returns and the bound plan evidence are required.",
        { code: "invalid-completion-input" },
      );
    }

    // Fire-time preference re-read (spec §Full Phase 1 handoff).
    const settings = await readHandoffSettings(ctx.cwd);
    const afterSettings = suspensionReason(ctx, sessionId, generation);
    if (afterSettings !== null) return suspend(afterSettings);
    if (!settings.ok) {
      return outcome(
        false,
        true,
        `the model-handoff preference could not be read at fire time: ${settings.message}. Nothing was switched; the handoff stays pending.`,
        { code: "settings-read-failed", state: "pending" },
      );
    }
    if (!settings.value.modelHandoff) {
      notice(
        `model handoff skipped for this coordinator session: modelHandoff is off in native settings. ${SLOW_SPEC} stays in place. Re-enabling it before Phase 1 completes can still fire this binding.`,
      );
      return outcome(
        false,
        false,
        "modelHandoff is off in native settings; the automatic target switch was skipped and the binding stays pending.",
        { code: "preference-off", state: "pending" },
      );
    }

    // E2 readiness checkpoint (frozen contract; read-only).
    const readiness = await inspectPhase1Readiness(record.binding, completion);
    const afterReadiness = suspensionReason(ctx, sessionId, generation);
    if (afterReadiness !== null) return suspend(afterReadiness);
    if (!readiness.ready) {
      return outcome(
        false,
        false,
        `Phase 1 is not complete for ${record.binding.workflowId}: ${readiness.codes.join(", ")}. The handoff stays pending and nothing was switched.`,
        { code: "not-ready", state: "pending", codes: readiness.codes },
      );
    }

    /* ---- Final window: no `await` from here to the public setModel call. ---- */
    const finalSuspension = suspensionReason(ctx, sessionId, generation);
    if (finalSuspension !== null) return suspend(finalSuspension);

    const live = modelSpecOf(ctx.models.current());
    const cancelReason = pendingCancellationReason(ctx.sessionManager.getEntries(), record, live);
    if (cancelReason !== null) {
      terminalize(record, "cancelled", cancelReason, live);
      return outcome(false, false, `the pending handoff was cancelled: ${cancelReason}.`, {
        code: "cancelled",
        state: "cancelled",
        actualModel: live,
      });
    }

    const target = resolveSpec(ctx.models, settings.value.handoffTarget);
    if (target === undefined) {
      terminalize(
        record,
        "failed",
        `cannot resolve ${settings.value.handoffTarget} in this session's model configuration`,
        live,
      );
      return outcome(
        false,
        true,
        `cannot resolve ${settings.value.handoffTarget}; the session keeps ${live ?? "its actual model"} and the binding is failed (no retry).`,
        { code: "target-unresolved", state: "failed", actualModel: live },
      );
    }
    const targetSpec = modelSpecOf(target);

    gate.actionInFlight = true;
    const attempt: HandoffRecord = {
      ...record,
      state: "attempting",
      operationId: newOperationId("handoff"),
      action: "handoff",
      observedModel: live,
      reason: `switching to ${targetSpec}`,
      receipt: readiness.receipt,
    };
    if (!appendRecord(attempt)) {
      gate.actionInFlight = false;
      return outcome(false, true, `the handoff attempt could not be recorded; ${targetSpec} was not selected.`, {
        code: "record-failed",
        state: "pending",
      });
    }

    let switched = false;
    let failure: string | null = null;
    try {
      switched = await pi.setModel(target);
    } catch (error) {
      failure = String(error);
    } finally {
      gate.actionInFlight = false;
    }

    if (failure !== null || !switched) {
      const actual = modelSpecOf(ctx.models.current());
      const reason =
        failure !== null ? `the handoff to ${targetSpec} threw: ${failure}` : `the host did not switch to ${targetSpec}`;
      terminalize(attempt, "failed", reason, actual);
      return outcome(false, true, `${reason}. The session keeps ${actual ?? "its actual model"}; the handoff is not retried.`, {
        code: failure !== null ? "switch-threw" : "switch-refused",
        state: "failed",
        actualModel: actual,
      });
    }

    const actual = modelSpecOf(ctx.models.current());
    const appended = appendRecord({
      ...attempt,
      state: "handed_off",
      observedModel: actual,
      reason: `Phase 1 complete for ${record.binding.workflowId}; the coordinator continues on ${targetSpec}`,
    });
    notice(
      `model handoff complete for this coordinator session: ${SLOW_SPEC} was used for Prepare and the session now runs ${actual ?? targetSpec} after a verified full Phase 1 of ${record.binding.workflowId}.${appended ? "" : " (The completion record could not be appended.)"}`,
    );
    return outcome(
      true,
      false,
      `handed off: this coordinator session now runs ${actual ?? targetSpec}; the binding is one-shot and will not fire again.`,
      {
        code: "handed_off",
        state: "handed_off",
        workflowId: record.binding.workflowId,
        actualModel: actual,
        integrationHead: readiness.integrationHead,
      },
    );
  };

  /* -------------------------------------------------------------- tool --- */

  const specialistReceipt = z
    .object({ role: z.string(), agentId: z.string(), resultRef: z.string(), reportPath: z.string() })
    .strict();
  const planEvidence = z.object({ planId: z.string(), planPath: z.string(), prepareEvidencePath: z.string() }).strict();

  pi.registerTool({
    name: TOOL_NAME,
    label: "Model handoff",
    description:
      'Morning Star coordinator model handoff. `{operation:"start"}` is the PM\'s first preparation action of a new iteration: it arms @slow for this coordinator session when the native modelHandoff preference is enabled. `{operation:"phase1-complete"}` is the completion checkpoint: it validates the frozen Phase 1 evidence and then switches only this coordinator session to the saved handoffTarget. Not a user activation command; no role mapping, goal or workflow state is written.',
    parameters: z
      .object({
        operation: z.enum(["start", "phase1-complete"]),
        workflowId: z.string(),
        entry: z.enum(["iteration-start", "iteration-loop", "skill-start"]).optional(),
        intent: z.literal("new-iteration").optional(),
        authority: z.literal("coordinator").optional(),
        coordinatorSessionPath: z.string().optional(),
        mainWorktreeBranch: z.string().optional(),
        reviews: z.array(specialistReceipt).optional(),
        plans: z.array(planEvidence).optional(),
      })
      .strict(),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const input = params as unknown as ToolParams;
        const result = input.operation === "start" ? await arm(input, ctx) : await fire(input, ctx);
        return {
          content: [{ type: "text", text: result.text }],
          details: { mstarModelHandoff: result.details, ok: result.ok },
          isError: result.isError,
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `model handoff tool failed without changing the session model: ${String(error)}` },
          ],
          details: { mstarModelHandoff: { code: "tool-error" }, ok: false },
          isError: true,
        };
      }
    },
  });

  /* ------------------------------------------------------------ events --- */

  // Pending observation opportunities: scan only, never switch.
  pi.on("input", (_event, ctx) => {
    observePending(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    observePending(ctx);
  });
  pi.on("tool_result", (_event, ctx) => {
    observePending(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    observePending(ctx);
  });

  /**
   * Navigation arriving while an action is in flight is refused immediately —
   * returning before any `await`, because an extension-handler timeout would
   * otherwise let the navigation continue. Otherwise the fence advances *before*
   * any asynchronous callback can start an action.
   */
  const beforeNavigation = (ctx: ExtensionContext): { cancel: true } | undefined => {
    if (gate.actionInFlight) {
      notice(
        "model handoff is finishing; the navigation was refused so the invoked model action is not interrupted. Retry the navigation in a moment.",
      );
      return { cancel: true };
    }
    gate.generation += 1;
    gate.navigationPending = true;
    observePending(ctx);
    return undefined;
  };

  /** Post-navigation: clear the fence only after the matching event, then replay state. */
  const afterNavigation = (ctx: ExtensionContext): void => {
    gate.navigationPending = false;
    gate.suspensionNotified = false;
    gate.generation += 1;
    reconstruct(ctx);
  };

  pi.on("session_before_switch", (_event, ctx) => beforeNavigation(ctx));
  pi.on("session_before_branch", (_event, ctx) => beforeNavigation(ctx));
  pi.on("session_before_tree", (_event, ctx) => beforeNavigation(ctx));
  pi.on("session_switch", (_event, ctx) => afterNavigation(ctx));
  pi.on("session_branch", (_event, ctx) => afterNavigation(ctx));
  pi.on("session_tree", (_event, ctx) => afterNavigation(ctx));

  // A fresh load clears per-process gates (a reload recovers a suspension whose
  // post-event never arrived) and replays the durable state.
  pi.on("session_start", (_event, ctx) => {
    gate.actionInFlight = false;
    gate.navigationPending = false;
    gate.suspensionNotified = false;
    gate.generation += 1;
    reconstruct(ctx);
  });

  // Process exit: drop in-memory gate state only. No claim is made about
  // process termination, plugin unload or a half-written session file.
  pi.on("session_shutdown", () => {
    gate.actionInFlight = false;
    gate.navigationPending = false;
    gate.suspensionNotified = false;
    gate.generation += 1;
  });
}
