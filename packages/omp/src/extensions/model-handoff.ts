/**
 * omp coordinator-session half of the Morning Star model handoff.
 *
 * Native omp settings own the preference. This extension records one session-
 * local ledger, arms `@slow` at the direction-lock entry, validates Phase 1
 * readiness against ACTIVE execution authority facts, then performs at most one
 * model switch. It never writes workflow lifecycle or engine state.
 *
 * Authority comes from the host session and canonical control-root facts, not
 * caller-declared role, identity or paths. The operation observes session
 * history conservatively: unowned model changes cancel a pending action,
 * uncertainty is never replayed, and an invoked action is never retried.
 *
 * Navigation fencing is in-memory and synchronous at the event boundary;
 * notices disclose observed state without asserting a guessed status.
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  WORKFLOW_TERMINAL_STATUSES,
  canonicalizeNearestExisting,
  readExecutionAuthority,
  readMainWorktree,
  resolveHarnessDir,
} from "@mstar-harness/engine";
import type { ExecutionPlanView, ExecutionRead, ExecutionSessionRef, ExecutionState } from "@mstar-harness/engine";
import { inspectPhase1Readiness, reserveHandoffBinding } from "../model-handoff-readiness";
import {
  COORDINATOR_TOOL_NAME,
  SHELL_TOOL_NAMES,
  bindCoordinatorIdentity,
  classifyCoordinatorShellCall,
  executionBindingOf,
  recoverCoordinatorIdentity,
  showCoordinatorRecovery,
  type CoordinatorIdentityFacts,
} from "../coordinator-identity";
import type {
  HandoffBinding,
  HandoffBindingInput,
  HandoffEntry,
  Phase1CompletionInput,
  Phase1Receipt,
} from "../model-handoff-readiness";
import { readHandoffSettings } from "../model-handoff-settings";
import { HANDOFF_NOTICE_CUSTOM_TYPE, fallbackNotice, formatNotice, neutralNotice } from "../notices";
import type { NoticeTitle } from "../notices";

/** Ledger `customType` of the durable handoff record (the only writer). */
export const HANDOFF_CUSTOM_TYPE = "mstar:model-handoff";
/**
 * `customType` of the coordinator-visible notice. The literal is declared once
 * in the shared notice module; this is its re-export.
 */
export { HANDOFF_NOTICE_CUSTOM_TYPE } from "../notices";
/**
 * Tool the PM calls once the direction is locked and at the completion checkpoint.
 */
const TOOL_NAME = "mstar_model_handoff";
/** Model role armed at iteration entry (spec §Iteration entry). */
const SLOW_SPEC = "@slow";
/** Record schema version; bumped only by a deliberate migration. */
const RECORD_VERSION = 1;
/** Host session id passed to plan/assignment binds through the child shell. */
const SESSION_ID_ENV = "MSTAR_HOST_SESSION_ID";
/** Single-quote a value for a POSIX shell — the one quoting that never expands. */
const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Route families read from the host's own `InputEvent`. The two iteration
 * commands are the two arming entry forms. Anything else (natural language,
 * skill loading, RPC/extension input) carries no route and is labelled
 * `skill-start` for E1's frozen `entry` field. The route can only *refuse* or
 * *label* — it never authorizes: authorization is the host/engine derivation
 * below.
 */
const ITERATION_START_RE = /^\/iteration-start(?:[\s]|$)/;
const ITERATION_LOOP_RE = /^\/iteration-loop(?:[\s]|$)/;

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

/** Index of the newest `model_change` entry in recorded order, or `-1` when history has none. */
function lastModelChangeIndex(entries: readonly SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.type === "model_change") return index;
  }
  return -1;
}

/** Every `model_change` entry recorded after `cursor` (the arm's own window). */
function modelChangesAfter(
  entries: readonly SessionEntry[],
  cursor: number,
): readonly Readonly<{ id: string; model: string }>[] {
  const changes = [];
  for (let index = cursor + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.type === "model_change") changes.push({ id: entry.id, model: entry.model });
  }
  return changes;
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

/* ------------------------------------------------------ host entry route --- */

type RouteKind = HandoffEntry;

type RouteObservation = Readonly<{ kind: RouteKind; text: string }>;

/** Route family of one host-observed input, or `null` when it carries no route. */
function routeOf(text: string): RouteKind | null {
  const trimmed = text.trim();
  if (ITERATION_START_RE.test(trimmed)) return "iteration-start";
  if (ITERATION_LOOP_RE.test(trimmed)) return "iteration-loop";
  return null;
}

/* --------------------------------------------------- start authority ------ */

type AuthorityRefusalCode = "task-session" | "coordinator-elsewhere" | "register-invalid";

type AuthorityDecision =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: AuthorityRefusalCode; message: string }>;

export function deriveActiveStartAuthority(args: {
  sessionId: string;
  taskSession: boolean;
  /** The addressed workflow's DB view, or `null` when the authority holds none. */
  workflow: Readonly<{ id: string; status: string; type: string }> | null;
  coordinator: ExecutionSessionRef | null;
  /** Every workflow the authority holds, for the one-session/one-iteration rule. */
  registry: readonly Readonly<{ id: string; status: string; coordinator: ExecutionSessionRef | null }>[];
}): AuthorityDecision {
  const { sessionId, taskSession, workflow, coordinator, registry } = args;
  if (sessionId === "") {
    return { ok: false, code: "task-session", message: "the host session has no id" };
  }
  if (taskSession) {
    return {
      ok: false,
      code: "task-session",
      message: "this session is a leaf/subagent (task) session, not the iteration coordinator",
    };
  }
  if (workflow === null) {
    return {
      ok: false,
      code: "register-invalid",
      message: "the execution authority holds no ACTIVE lifecycle for the named workflow; a new start addresses the DB's own workflow view and never reserves an unregistered id",
    };
  }
  if (workflow.status !== "running" || workflow.type !== "iteration") {
    return {
      ok: false,
      code: "register-invalid",
      message: `workflow ${workflow.id} is ${workflow.status} (type ${workflow.type}), not a running iteration`,
    };
  }
  if (coordinator === null || coordinator.sessionId !== sessionId) {
    return {
      ok: false,
      code: "coordinator-elsewhere",
      message: `workflow ${workflow.id} is bound to coordinator session ${coordinator?.sessionId ?? "(none)"}, not to this session ${sessionId}. Bind this session to it first (\`${COORDINATOR_TOOL_NAME}\` {operation:"bind", workflowId})`,
    };
  }
  for (const other of registry) {
    if (other.id === workflow.id) continue;
    if (other.coordinator?.sessionId !== sessionId) continue;
    if ((WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(other.status)) continue;
    return {
      ok: false,
      code: "coordinator-elsewhere",
      message: `this session is the coordinator of the ${other.status} workflow ${other.id}; one session coordinates one iteration`,
    };
  }
  return { ok: true };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Resolve the canonical ACTIVE control-harness root from the host cwd, never
 * from a caller-supplied path or a cached value.
 */
function resolveControlRoot(cwd: string): string | null {
  try {
    const main = readMainWorktree(cwd);
    if (main === null || !isNonEmpty(main.root)) return null;
    const resolved = resolveHarnessDir(main.root);
    if (resolved === null) return null;
    return canonicalizeNearestExisting(resolved);
  } catch {
    return null;
  }
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
  /** One arm at a time in this instance; cleared only in `finally`. */
  armInFlight: boolean;
};

/** Plugin-local attempt id (`operationId`), never host provenance. */
function newOperationId(action: HandoffAction): string {
  return `${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Tool result shape every path returns (the host renders it in TUI/print/JSON/RPC alike). */
type ToolOutcome = Readonly<{ ok: boolean; isError: boolean; text: string; details: Record<string, unknown> }>;

/**
 * Test seams for awaited readiness/settings steps. These hold reads open to
 * exercise the observable concurrency boundaries.
 */
export const handoffSeams = {
  inspectReadiness: inspectPhase1Readiness,
  decisionPreferenceRead: readHandoffSettings,
};

function outcome(ok: boolean, isError: boolean, text: string, details: Record<string, unknown> = {}): ToolOutcome {
  return { ok, isError, text, details };
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

/** Frozen role/report tuple accepted from the PM's completion call. */
type ToolSpecialistReceipt = Readonly<{ role: string; agentId: string; resultRef: string; reportPath: string }>;
/** Frozen per-plan Prepare evidence accepted from the PM's completion call. */
type ToolPlanEvidence = Readonly<{ planId: string; planPath: string; prepareEvidencePath: string }>;

/**
 * Tool parameters. The start operation takes **only** the explicitly named
 * workflow id: authority, intent and the entry route are host-derived, so there
 * is no field a caller could use to declare them.
 */
type ToolParams = {
  operation: "start" | "phase1-complete";
  workflowId: string;
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
    armInFlight: false,
  };
  /** The last host-observed entry route of this session (in-memory, not durable). */
  let lastRoute: RouteObservation | null = null;

  /**
   * Durable coordinator-visible notice; never log-only, never throws into the
   * The shared Morning Star title shape is rendered through `formatNotice`;
   * ACTIVE lifecycle status is read by the coordinator's public read surface.
   */
  const notice = (title: NoticeTitle): void => {
    try {
      pi.sendMessage({ customType: HANDOFF_NOTICE_CUSTOM_TYPE, content: formatNotice(title), display: true });
    } catch {
      // An unavailable notice channel at teardown must not break the caller.
    }
  };


  const preferenceOff = (pending: boolean): ToolOutcome => {
    notice(neutralNotice({
      subject: "Model handoff preference off",
      detail: "modelHandoff is off in native settings; no model action was taken.",
    }));
    return outcome(true, false, "modelHandoff is off in native settings; this session is not armed and its model is unchanged. Enabling it later does not retro-arm an in-flight iteration.", {
      code: "preference-off",
      ...(pending ? { state: "pending" } : {}),
    });
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

  const sessionIdOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
  const liveSpecOf = (ctx: ExtensionContext): ModelSpec | null => modelSpecOf(ctx.models.current());

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
    const detail = appended
      ? `model handoff ${state} for this coordinator session: ${reason}. The session keeps ${observedModel ?? "its actual model"}; the saved preference is unchanged and later iterations still apply it.`
      : `model handoff ${state} for this coordinator session (the session record could not be appended): ${reason}. The session keeps ${observedModel ?? "its actual model"}.`;
    notice(fallbackNotice({ subject: `Model handoff ${state}`, detail }));
    return appended;
  };

  /** The latest durable record is an attempt this instance is still running. */
  const attemptIsRunning = (decision: SessionStateDecision): boolean =>
    gate.actionInFlight && decision.kind === "uncertain" && decision.record.state === "attempting";

  /**
   * Restore durable state for the session now attached to `ctx` **without**
   * switching anything: an interrupted attempt becomes `uncertain`, a pending
   * binding is restored as it is, a terminal binding stays terminal. An attempt
   * this instance is still running is never mislabelled uncertain — only a
   * genuine resume (a fresh instance with no action in flight) reaches that
   * transition.
   */
  const reconstruct = (ctx: ExtensionContext): SessionStateDecision => {
    const decision = decideSessionState(ctx.sessionManager.getEntries(), sessionIdOf(ctx));
    if (decision.kind === "uncertain" && !attemptIsRunning(decision)) {
      terminalize(decision.record, "uncertain", decision.reason, liveSpecOf(ctx));
    }
    return decision;
  };

  /**
   * Pending observation opportunity (spec §B1): cancel a waiting handoff when
   * the ledger or the live model moved away from the armed baseline. Never
   * switches a model, and a no-op while this instance's own action is in flight
   * (that action is already invoked; there is nothing left to cancel).
   */
  const observePending = (ctx: ExtensionContext): void => {
    if (gate.actionInFlight) return;
    const entries = ctx.sessionManager.getEntries();
    const decision = decideSessionState(entries, sessionIdOf(ctx));
    if (decision.kind === "uncertain") {
      terminalize(decision.record, "uncertain", decision.reason, liveSpecOf(ctx));
      return;
    }
    if (decision.kind !== "pending") return;
    const live = liveSpecOf(ctx);
    const reason = pendingCancellationReason(entries, decision.record, live);
    if (reason !== null) terminalize(decision.record, "cancelled", reason, live);
  };

  /** Fence check run after every asynchronous step; `null` while the sampled session is still valid. */
  const suspensionReason = (ctx: ExtensionContext, sessionId: string, generation: number): string | null => {
    if (gate.navigationPending) return "a session navigation is in progress";
    if (gate.generation !== generation) return "the session changed while the handoff was being checked";
    if (sessionIdOf(ctx) !== sessionId) return "the session id changed while the handoff was being checked";
    return null;
  };

  /** Refuse to start an action now; the suspension stays pending and becomes visible once. */
  const suspend = (reason: string, state: "pending" | "none"): ToolOutcome => {
    if (!gate.suspensionNotified) {
      gate.suspensionNotified = true;
      // Deliberately snapshot-free: a suspension is this seat's condition, not
      // workflow status evidence.
      notice(
        fallbackNotice({
          subject: "Model handoff suspended",
          detail: `${reason}. No model action was taken; ${
            state === "pending" ? "the binding stays pending until the session settles" : "no binding was created"
          }.`,
        }),
      );
    }
    return outcome(
      false,
      true,
      `the handoff check was suspended: ${reason}. Nothing was switched; ${
        state === "pending" ? "the binding stays pending" : "no binding was created"
      }.`,
      { code: "suspended", state, reason },
    );
  };

  /** Refused start: durable notice plus a visible tool result; no binding is written. */
  const refuseStart = (code: string, message: string): ToolOutcome => {
    // Deliberately snapshot-free: a refusal reports this seat's derivation, not
    // workflow status.
    notice(
      fallbackNotice({
        subject: `Model handoff start refused (${code})`,
        detail: `${message}. No model action was taken.`,
      }),
    );
    return outcome(false, true, `the new-iteration handoff start was refused (${code}): ${message}`, { code });
  };

  /* --------------------------------------------------------------- arm --- */

  const armOnce = async (params: ToolParams, ctx: ExtensionContext): Promise<ToolOutcome> => {
    const sessionId = sessionIdOf(ctx);
    const generation = gate.generation;
    const decision = reconstruct(ctx);

    if (attemptIsRunning(decision)) {
      return outcome(
        false,
        true,
        "a model action from a previous handoff invocation is still running in this session; nothing was changed.",
        { code: "in-flight", state: "attempting" },
      );
    }

    const settings = await readHandoffSettings(ctx.cwd);
    const afterSettings = suspensionReason(ctx, sessionId, generation);
    if (afterSettings !== null) return suspend(afterSettings, decision.kind === "pending" ? "pending" : "none");
    if (!settings.ok) {
      return outcome(false, true, `the model-handoff preference could not be read: ${settings.message}`, {
        code: "settings-read-failed",
      });
    }
    if (!settings.value.modelHandoff) return preferenceOff(decision.kind === "pending");
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

    const taskSession = ctx.sessionManager.getEntries().some((entry) => entry.type === "session_init");
    const bindingInput: HandoffBindingInput = {
      workflowId: params.workflowId,
      entry: lastRoute !== null ? lastRoute.kind : "skill-start",
      intent: "new-iteration",
      authority: "coordinator",
    };
    const harnessRoot = resolveControlRoot(ctx.cwd);
    if (harnessRoot === null) return refuseStart("register-invalid", "the control harness root cannot be resolved");
    if (taskSession) return refuseStart("task-session", "this session is a leaf/subagent (task) session, not the iteration coordinator");
    let addressed: ExecutionRead<ExecutionState | ExecutionPlanView>;
    try {
      addressed = await readExecutionAuthority({ harnessDir: harnessRoot }, { workflowId: params.workflowId });
    } catch (error) {
      return refuseStart("register-invalid", `the execution authority of ${harnessRoot} cannot serve workflow ${params.workflowId}: ${String(error)}`);
    }
    const workflow = "workflows" in addressed.data ? addressed.data.workflows[0] : undefined;
    let registry: readonly Readonly<{ id: string; status: string; coordinator: ExecutionSessionRef | null }>[] = [];
    try {
      const all = await readExecutionAuthority({ harnessDir: harnessRoot });
      if ("workflows" in all.data) {
        registry = all.data.workflows.map((entry) => ({
          id: entry.state.id,
          status: entry.state.status,
          coordinator: entry.coordinator,
        }));
      }
    } catch {
      registry = [];
    }
    const coordinator = workflow?.coordinator ?? null;
    const authority = deriveActiveStartAuthority({
      sessionId,
      taskSession,
      workflow:
        workflow === undefined
          ? null
          : { id: workflow.state.id, status: workflow.state.status, type: workflow.state.type },
      coordinator,
      registry,
    });
    if (!authority.ok) return refuseStart(authority.code, authority.message);
    if (workflow === undefined || coordinator === null) {
      return refuseStart("coordinator-elsewhere", `workflow ${params.workflowId} holds no coordinator seat to adopt`);
    }
    const reservation = await reserveHandoffBinding(bindingInput, {
      sessionId,
      cwd: ctx.cwd,
      taskSession,
      executionBinding: executionBindingOf(harnessRoot, coordinator),
    });
    if (!reservation.ok) {
      return outcome(false, true, `the new-iteration handoff binding was refused (${reservation.code}): ${reservation.message}`, {
        code: reservation.code,
      });
    }
    const binding = reservation.binding;

    // Durable re-check after every await: a concurrent arm (this instance or
    // another one over the same session) must be visible here as a binding.
    // A *terminal* record for a different workflow is not an active binding —
    // the saved preference still arms `@slow` for a later iteration in this
    // reused coordinator session.
    const concurrent = decideSessionState(ctx.sessionManager.getEntries(), sessionId);
    if (concurrent.kind === "pending" || concurrent.kind === "uncertain") {
      return outcome(
        false,
        true,
        `this session already holds a ${concurrent.kind} model-handoff binding; the second start was refused without a model action.`,
        { code: "already-bound", state: concurrent.kind, workflowId: concurrent.record.binding.workflowId },
      );
    }
    if (concurrent.kind === "terminal" && concurrent.record.binding.workflowId === params.workflowId) {
      return outcome(
        false,
        true,
        `workflow ${params.workflowId} already has a ${concurrent.state} handoff binding in this session; a terminal binding is never re-armed.`,
        { code: "already-bound", state: concurrent.state, workflowId: params.workflowId },
      );
    }

    // The arm invocation is guarded exactly like the target invocation: a
    // navigation that arrives first keeps the arm from starting at all (no
    // attempt record, no reservation effect), and a navigation that arrives while
    // the arm is in flight is refused by the navigation handler.
    const beforeArmGate = suspensionReason(ctx, sessionId, generation);
    if (beforeArmGate !== null) return suspend(beforeArmGate, "none");

    // Attempt-before-action: the arm attempt is durable before `@slow` is selected.
    const beforeArm = lastModelChangeIndex(ctx.sessionManager.getEntries());
    const attempt: HandoffRecord = {
      version: RECORD_VERSION,
      binding,
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
      terminalize(attempt, "failed", `cannot resolve ${SLOW_SPEC} in this session's model configuration`, liveSpecOf(ctx));
      return outcome(false, true, `cannot resolve ${SLOW_SPEC}; the session model is unchanged and no handoff is pending.`, {
        code: "slow-unresolved",
        state: "failed",
      });
    }
    const slowSpec = modelSpecOf(slow);

    let switched = false;
    let armFailure: string | null = null;
    gate.actionInFlight = true;
    try {
      switched = await pi.setModel(slow);
    } catch (error) {
      armFailure = String(error);
    } finally {
      gate.actionInFlight = false;
    }

    if (armFailure !== null) {
      terminalize(attempt, "failed", `selecting ${slowSpec} failed: ${armFailure}`, liveSpecOf(ctx));
      return outcome(false, true, `selecting ${SLOW_SPEC} (${slowSpec}) failed: ${armFailure}`, {
        code: "slow-selection-failed",
        state: "failed",
      });
    }
    if (!switched) {
      terminalize(
        attempt,
        "failed",
        `the host refused the ${slowSpec} selection (no configured auth for it)`,
        liveSpecOf(ctx),
      );
      return outcome(
        false,
        true,
        `the host refused the ${SLOW_SPEC} selection (${slowSpec}); the session keeps its actual model and no handoff is pending.`,
        { code: "slow-selection-refused", state: "failed", actualModel: liveSpecOf(ctx) },
      );
    }

    // Pending requires nonconflicting model/history evidence: the live model must
    // be `@slow` *and* every transition recorded after the pre-arm cursor must
    // describe `@slow`. A change away and back inside that window is a conflict
    // even though the current value looks right.
    const afterEntries = ctx.sessionManager.getEntries();
    const window = modelChangesAfter(afterEntries, beforeArm);
    const liveAfterArm = liveSpecOf(ctx);
    const agreed = window.every((change) => change.model === slowSpec);
    const windowModels = window.map((change) => change.model);
    if (liveAfterArm !== slowSpec || window.length === 0 || !agreed) {
      terminalize(
        attempt,
        "failed",
        `conflicting model/history evidence after arming ${SLOW_SPEC}: live ${liveAfterArm ?? "unknown"}, transitions recorded after the pre-arm cursor ${windowModels.length === 0 ? "(none)" : windowModels.join(", ")}`,
        liveAfterArm,
      );
      return outcome(
        false,
        true,
        `the ${SLOW_SPEC} arm could not be confirmed (live ${liveAfterArm ?? "unknown"}, arm-window transitions ${windowModels.length === 0 ? "none" : windowModels.join(", ")}); no handoff is pending.`,
        { code: "arm-evidence-conflict", state: "failed", actualModel: liveAfterArm },
      );
    }

    const baseline = window.at(-1)!.id;
    if (
      !appendRecord({
        ...attempt,
        state: "pending",
        baselineModelChangeId: baseline,
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
      `armed ${SLOW_SPEC} (${slowSpec}) for new iteration ${binding.workflowId}; the handoff is pending and switches this session to ${settings.value.handoffTarget} only after a complete Phase 1.`,
      {
        code: "armed",
        state: "pending",
        workflowId: binding.workflowId,
        entry: bindingInput.entry,
        sessionId,
        baselineModelChangeId: baseline,
        observedModel: slowSpec,
        handoffTarget: settings.value.handoffTarget,
      },
    );
  };

  const arm = async (params: ToolParams, ctx: ExtensionContext): Promise<ToolOutcome> => {
    if (gate.armInFlight) {
      return outcome(false, true, "another model-handoff arm is already in progress in this session.", {
        code: "arm-in-flight",
      });
    }
    gate.armInFlight = true;
    try {
      return await armOnce(params, ctx);
    } finally {
      gate.armInFlight = false;
    }
  };

  /* -------------------------------------------------------------- fire --- */

  /** ACTIVE completion witnesses; E2 verifies role order and artifact bytes. */
  const completionInputOf = (params: ToolParams, binding: HandoffBinding): Phase1CompletionInput | null => {
    const reviews = params.reviews;
    const plans = params.plans;
    if (
      reviews === undefined ||
      reviews.length < 1 ||
      reviews.length > 3 ||
      plans === undefined ||
      plans.length === 0 ||
      typeof params.mainWorktreeBranch !== "string" ||
      params.mainWorktreeBranch === ""
    ) {
      return null;
    }
    return {
      workflowId: binding.workflowId,
      mainWorktreeBranch: params.mainWorktreeBranch,
      reviews: reviews as unknown as Phase1CompletionInput["reviews"],
      plans,
    };
  };

  const fire = async (params: ToolParams, ctx: ExtensionContext): Promise<ToolOutcome> => {
    const sessionId = sessionIdOf(ctx);
    const generation = gate.generation;
    let decision = reconstruct(ctx);

    if (attemptIsRunning(decision)) {
      return outcome(
        false,
        true,
        "a model action from a previous handoff invocation is still running in this session; nothing was changed and no attempt was recorded.",
        { code: "in-flight", state: "attempting" },
      );
    }
    if (decision.kind === "none" || decision.kind === "pending") {
      const settings = await handoffSeams.decisionPreferenceRead(ctx.cwd);
      const afterSettings = suspensionReason(ctx, sessionId, generation);
      if (afterSettings !== null) return suspend(afterSettings, decision.kind);
      if (decision.kind === "pending") {
        const liveDecision = reconstruct(ctx);
        if (liveDecision.kind !== "pending" || liveDecision.record.operationId !== decision.record.operationId) {
          return outcome(false, true, "the pending model handoff changed while settings were read.", { code: "not-pending" });
        }
      }
      if (!settings.ok) {
        return outcome(false, true, `the model-handoff preference could not be read: ${settings.message}`, {
          code: "settings-read-failed",
          ...(decision.kind === "pending" ? { state: "pending" } : {}),
        });
      }
      if (!settings.value.modelHandoff) {
        // The preference-off no-op is only honest for the state it was decided
        // on. The unbound snapshot therefore needs the same consistency re-read
        // the bound arm does: a binding armed while settings were read is
        // reported as `not-pending`, never as a neutral success.
        if (decision.kind === "pending") return preferenceOff(true);
        if (reconstruct(ctx).kind !== "none") {
          return outcome(false, true, "the model handoff changed while settings were read.", { code: "not-pending" });
        }
        return preferenceOff(false);
      }
    }
    if (decision.kind !== "pending") {
      const described = decision.kind === "none" ? "no binding" : `${decision.kind} (${decision.record.binding.workflowId})`;
      return outcome(false, true, `no pending model handoff exists for this coordinator session: ${described}.`, {
        code: "not-pending",
      });
    }
    let record = decision.record;

    /** After every await: refuse to fire if the ledger left `pending`. */
    const stillPending = (): ToolOutcome | null => {
      const liveDecision = reconstruct(ctx);
      if (liveDecision.kind === "pending" && liveDecision.record.operationId === record.operationId) {
        record = liveDecision.record;
        return null;
      }
      if (liveDecision.kind === "terminal" && liveDecision.state === "cancelled") {
        return outcome(false, false, `the pending handoff was cancelled: ${liveDecision.record.reason}.`, {
          code: "cancelled",
          state: "cancelled",
          actualModel: liveSpecOf(ctx),
        });
      }
      const described =
        liveDecision.kind === "none" ? "no binding" : `${liveDecision.kind} (${liveDecision.record.binding.workflowId})`;
      return outcome(false, true, `no pending model handoff exists for this coordinator session: ${described}.`, {
        code: "not-pending",
      });
    };
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
        "the completion checkpoint is incomplete: selected ordered specialist returns (including the final writing-specialist return) and the bound plan evidence are required.",
        { code: "invalid-completion-input" },
      );
    }

    // Fire-time preference re-read (spec §Full Phase 1 handoff).
    const settings = await readHandoffSettings(ctx.cwd);
    const afterSettings = suspensionReason(ctx, sessionId, generation);
    if (afterSettings !== null) return suspend(afterSettings, "pending");
    const afterSettingsLedger = stillPending();
    if (afterSettingsLedger !== null) return afterSettingsLedger;
    if (!settings.ok) {
      return outcome(
        false,
        true,
        `the model-handoff preference could not be read at fire time: ${settings.message}. Nothing was switched; the handoff stays pending.`,
        { code: "settings-read-failed", state: "pending" },
      );
    }
    if (!settings.value.modelHandoff) return preferenceOff(true);

    // E2 readiness checkpoint (frozen contract; read-only).
    const readiness = await handoffSeams.inspectReadiness(record.binding, completion);
    const afterReadiness = suspensionReason(ctx, sessionId, generation);
    if (afterReadiness !== null) return suspend(afterReadiness, "pending");
    const afterReadinessLedger = stillPending();
    if (afterReadinessLedger !== null) return afterReadinessLedger;

    // Re-read the preference *after* the asynchronous checkpoint: the value that
    // decides the destination and the enablement is never a cached one.
    const refreshed = await readHandoffSettings(ctx.cwd);
    const afterRefresh = suspensionReason(ctx, sessionId, generation);
    if (afterRefresh !== null) return suspend(afterRefresh, "pending");
    const afterRefreshLedger = stillPending();
    if (afterRefreshLedger !== null) return afterRefreshLedger;
    if (!refreshed.ok) {
      return outcome(
        false,
        true,
        `the model-handoff preference could not be read after the readiness checkpoint: ${refreshed.message}. Nothing was switched; the handoff stays pending.`,
        { code: "settings-read-failed", state: "pending" },
      );
    }
    if (!refreshed.value.modelHandoff) return preferenceOff(true);
    const handoffTarget = refreshed.value.handoffTarget;

    if (!readiness.ready) {
      // The checkpoint's typed §5 refinements are forwarded verbatim: they carry
      // public ids, codes, canonical plan pointers and the next supported
      // operation — never an envelope path, credential or session payload.
      const primary = readiness.diagnostics[0];
      const refined = primary === undefined ? "" : ` (${primary.detail})`;
      return outcome(
        false,
        false,
        `Phase 1 is not complete for ${record.binding.workflowId}: ${readiness.codes.join(", ")}${refined}. The handoff stays pending and nothing was switched.${primary === undefined ? "" : ` Next: ${primary.next}.`}`,
        {
          code: "not-ready",
          state: "pending",
          codes: readiness.codes,
          diagnostics: readiness.diagnostics,
        },
      );
    }

    /* ---- Final window: no `await` from here to the public setModel call. ---- */
    const finalSuspension = suspensionReason(ctx, sessionId, generation);
    if (finalSuspension !== null) return suspend(finalSuspension, "pending");
    const finalLedger = stillPending();
    if (finalLedger !== null) return finalLedger;

    const live = liveSpecOf(ctx);
    const cancelReason = pendingCancellationReason(ctx.sessionManager.getEntries(), record, live);
    if (cancelReason !== null) {
      terminalize(record, "cancelled", cancelReason, live);
      return outcome(false, false, `the pending handoff was cancelled: ${cancelReason}.`, {
        code: "cancelled",
        state: "cancelled",
        actualModel: live,
      });
    }

    const target = resolveSpec(ctx.models, handoffTarget);
    if (target === undefined) {
      terminalize(record, "failed", `cannot resolve ${handoffTarget} in this session's model configuration`, live);
      return outcome(
        false,
        true,
        `cannot resolve ${handoffTarget}; the session keeps ${live ?? "its actual model"} and the binding is failed (no retry).`,
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
      const actual = liveSpecOf(ctx);
      const reason =
        failure !== null ? `the handoff to ${targetSpec} threw: ${failure}` : `the host did not switch to ${targetSpec}`;
      terminalize(attempt, "failed", reason, actual);
      return outcome(false, true, `${reason}. The session keeps ${actual ?? "its actual model"}; the handoff is not retried.`, {
        code: failure !== null ? "switch-threw" : "switch-refused",
        state: "failed",
        actualModel: actual,
      });
    }

    const actual = liveSpecOf(ctx);
    const appended = appendRecord({
      ...attempt,
      state: "handed_off",
      observedModel: actual,
      reason: `Phase 1 complete for ${record.binding.workflowId}; the coordinator continues on ${targetSpec}`,
    });
    const completedDetail = `model handoff complete for this coordinator session: ${SLOW_SPEC} was used for Prepare and the session now runs ${actual ?? targetSpec} after a verified full Phase 1 of ${record.binding.workflowId}.${appended ? "" : " (The completion record could not be appended.)"}`;
    notice(fallbackNotice({ subject: "Model handoff complete", detail: completedDetail }));
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
      "Morning Star coordinator model handoff. `{operation:\"start\"}` is the PM's direction-lock call: when the native modelHandoff preference is enabled, the host derives the ACTIVE DB coordinator authority and arms this session on @slow. `{operation:\"phase1-complete\"}` validates the frozen Phase 1 evidence against ACTIVE execution facts and then switches only this coordinator session to the saved handoffTarget. No caller-supplied authority, identity, root or path is accepted; no workflow lifecycle or other session is written.",
    parameters: z
      .object({
        operation: z.enum(["start", "phase1-complete"]),
        workflowId: z.string(),
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

  /* ------------------------------------------------- coordinator identity --- */

  /**
   * The host-derived facts one `mstar_coordinator` call reads. The native
   * session id, cwd and control root come from the host context; leaf is the
   * same host ledger fact the start classifier uses. Nothing here is
   * model-supplied.
   */
  const coordinatorFacts = (ctx: ExtensionContext): CoordinatorIdentityFacts => ({
    sessionId: sessionIdOf(ctx),
    cwd: ctx.cwd,
    harnessRoot: resolveControlRoot(ctx.cwd),
    leaf: ctx.sessionManager.getEntries().some((entry) => entry.type === "session_init"),
  });

  /** OPTIONAL coordinator operation fields advertised to the ACTIVE tool. */
  const coordinatorAdmissionFields = {
    workflowId: z.unknown().optional().describe("string: the explicitly named workflow this call addresses."),
    expected: z
      .unknown()
      .optional()
      .describe("string: the ACTIVE workflow CAS token. Omitted, the engine resolves the workflow's current token itself, so an identical bind retry is the recorded replay."),
    operationId: z
      .unknown()
      .optional()
      .describe("string: ACTIVE idempotency key; omitted, the adapter mints one."),
    reason: z
      .unknown()
      .optional()
      .describe("string: the non-empty audited reason for ACTIVE recovery."),
    attestation: z
      .unknown()
      .optional()
      .describe("object: the operator's activation-attestation document; the engine validates its contents."),
  } as const;

  pi.registerTool({
    name: COORDINATOR_TOOL_NAME,
    label: "Coordinator identity",
    description:
      'Morning Star coordinator identity entry. The host derives the control root and native session id. `{operation:"bind", workflowId}` binds this session under ACTIVE DB authority, resolving omitted CAS inputs inside the engine. `{operation:"show-recovery", workflowId}` reads current workflow and coordinator facts. `{operation:"recover"}` replaces the explicitly named prior coordinator (or `null` only when none is recorded), with the operator attestation validated by the engine. No operation accepts a caller-selected identity, root or credential path.',
    parameters: z
      .union([
        z
          .object({
            operation: z.literal("recover"),
            priorSessionId: z
              .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.unknown())])
              .describe("string|null: the ACTIVE recovery's recorded coordinator session, or null only when none is recorded."),
            ...coordinatorAdmissionFields,
          })
          .passthrough(),
        z
          .object({
            operation: z.enum(["bind", "show-recovery", "recover"]),
            ...coordinatorAdmissionFields,
          })
          .passthrough(),
      ])
      .describe("ACTIVE coordinator operation: bind | show-recovery | recover"),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const facts = coordinatorFacts(ctx);
      const result =
        params.operation === "bind"
          ? await bindCoordinatorIdentity(params, facts)
          : params.operation === "show-recovery"
            ? await showCoordinatorRecovery(params, facts)
            : await recoverCoordinatorIdentity(params, facts);
      return {
        content: [{ type: "text", text: result.text }],
        details: { mstarCoordinator: result.details, ok: result.ok },
        isError: result.isError,
      };
    },
  });
  /* ------------------------------------------------------------ events --- */

  // The host's own input event is the only source of the entry route: it is
  // observed here and can only refuse (`/iteration-drive …`) or label the frozen
  // E1 `entry` field. It never authorizes anything.
  pi.on("input", (event, ctx) => {
    const text = typeof event.text === "string" ? event.text : "";
    const kind = routeOf(text);
    if (kind !== null) lastRoute = { kind, text: text.trim() };
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
      // Deliberately snapshot-free: this reports the in-flight action, never a
      // workflow status.
      notice(
        fallbackNotice({
          subject: "Model handoff",
          detail:
            "the navigation was refused so the invoked model action is not interrupted. Retry the navigation in a moment.",
        }),
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

  /* --------------------------------------------------- session identity --- */

  /**
   * A managed coordinator bind attempted through the shell is blocked in favor
   * of the dedicated host-owned `mstar_coordinator` tool. Other bash calls carry
   * the host identity to plan/assignment binds as a command prefix: omp 18.3.0
   * refuses an `env` field without a service name, so the validated input shape
   * must remain untouched. The export guard makes host re-fires idempotent and
   * respects a caller-supplied identity value.
   */
  pi.on("tool_call", (event, ctx) => {
    const refusal = classifyCoordinatorShellCall({ toolName: event.toolName, input: event.input });
    if (refusal !== undefined || !(SHELL_TOOL_NAMES as readonly string[]).includes(event.toolName)) return refusal;

    const sessionId = sessionIdOf(ctx);
    if (sessionId === "") return undefined;
    const input: Record<string, unknown> = isPlainObject(event.input) ? event.input : {};
    if (typeof input.command !== "string") return undefined;
    if (input.command.includes(`export ${SESSION_ID_ENV}=`)) return undefined;

    const prefix = `export ${SESSION_ID_ENV}=${shellSingleQuote(sessionId)}; `;
    return { input: { ...input, command: prefix + input.command } };
  });
}
