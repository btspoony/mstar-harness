/**
 * Phase-2 opportunity orchestration — the bounded reminder decision.
 *
 * One pure surface: `decidePhase2Reminder` is the once-per-changed-state latch
 * the host event adapter consults at `agent_end`. It yields at most one advisory
 * per changed opportunity observation and is silent for every suppressed,
 * replayed, unowned or unreadable state.
 *
 * Not here, by contract: no timer or polling loop, no host async-job snapshot
 * access, no invented job-settled event, no plan-launch transport, no capacity
 * setting, no journal or other persistence write, and no job-to-plan inference
 * from labels. The observation `key` is computed by the caller from the
 * canonical projection (workflow/session identity, running job ids/types/statuses
 * and engine plan facts); this module compares and latches that key and never
 * invents one.
 */

/* ------------------------------------------------------------------------- *
 * Host request surface (types only — bind/checkpoint/export live in the
 * extension; these shapes are declared here so the extension and its tests
 * share one contract)
 * ------------------------------------------------------------------------- */

export type CheckpointReason =
  | "before-wait"
  | "result-settled"
  | "dependency-changed"
  | "ownership-changed"
  | "capacity-changed";

export type Phase2Request =
  | { operation: "bind"; workflowId: string }
  | { operation: "export-history"; workflowId: string }
  | {
    operation: "checkpoint";
    reason: CheckpointReason;
    decision: "dispatched" | "wait" | "blocked";
    note: string;
  };

/* ------------------------------------------------------------------------- *
 * Bounded reminder decision
 * ------------------------------------------------------------------------- */

/**
 * One sampled opportunity observation. `key` is the caller's canonical
 * projection of the owning workflow/session, the owner-filtered running jobs
 * (id/type/status) and the relevant engine facts; labels, timestamps, result
 * text and recent-job eviction are excluded from it, so the key changes only
 * when the opportunity itself does.
 *
 * `recentTerminalIds` holds terminal job ids **newly observed in `recent`**
 * since the previous sample — the completion the host's own delivery already
 * owns. A non-empty list suppresses the plugin advisory for that observation
 * instead of reproducing completion text.
 */
export type Phase2Observation = Readonly<{
  key: string;
  hasRunningJobs: boolean;
  nativeDeliveryPending: boolean;
  recentTerminalIds: readonly string[];
}>;

/**
 * Latched reminder decision state of one bound coordinator session, rebuilt
 * from the session entry ledger on reconstruction (never a second status
 * register).
 */
export type ReminderState = Readonly<{
  /** Key of the observation the coordinator already ran the scheduling checkpoint against. */
  acknowledgedKey: string | null;
  /** Keys already reminded about — the once-per-changed-state latch. */
  remindedKeys: readonly string[];
  /**
   * A real blocker or a `blocked` PM checkpoint: no advisory continuation
   * until it clears. A new explicit user turn or a later PM checkpoint clears
   * it in the recorded state — this decision is pure and never rewrites state.
   */
  blocked: boolean;
}>;

export type ReminderContext = Readonly<{
  /** This session is the bound coordinator of an active Phase-2 workflow. */
  boundPhase2: boolean;
  /** A message is already queued for the session, so it continues without an advisory. */
  pendingMessages: boolean;
  /** Explicit user steering: the user's turn is the continuation. */
  userTurn: boolean;
  /** The native async-job snapshot read succeeded (null means unavailable, never "no jobs"). */
  snapshotAvailable: boolean;
}>;

/**
 * Decide whether this `agent_end` may emit the single bounded advisory.
 *
 * "silent" whenever the observation is unavailable, unowned, suppressed,
 * replayed, blocked, or carries no opportunity; "remind" only for a changed
 * (or still-running) opportunity the coordinator has not been told about yet.
 * Pure: it neither persists nor invents state.
 *
 * **Caller contract (T3).** This latch is the only baseline a change can be
 * detected against. `remindedKeys` is recorded by the caller for each emission
 * (before sending, per spec §B) and `acknowledgedKey` by a real `checkpoint`
 * operation; replaying those entries on reconstruction is what lets a later
 * *idle* change be recognized. An adapter that records no latch can see an
 * idle-only change never — that is the caller's obligation, not a hidden
 * default here, and the reason the first idle sample with an empty latch is
 * silent by design (spec §B: emission requires running work or a changed
 * engine observation).
 */
export function decidePhase2Reminder(
  state: ReminderState,
  observation: Phase2Observation,
  context: ReminderContext,
): "silent" | "remind" {
  // Wrong session or phase (including leaf/scoped/foreign sessions): inert.
  if (!context.boundPhase2) return "silent";
  // Null snapshot means the native read was unavailable — never "no jobs".
  if (!context.snapshotAvailable) return "silent";
  // A valid projection is never empty; an uncomputable observation must not be guessed into a key.
  if (observation.key === "") return "silent";
  // Real blocker or blocked PM checkpoint outranks every opportunity.
  if (state.blocked) return "silent";
  // Explicit user steering; the session is already continuing on the user's message.
  if (context.userTurn) return "silent";
  // A queued message continues the session without an extra turn.
  if (context.pendingMessages) return "silent";
  // Native completion delivery is authoritative — never duplicate it.
  if (observation.nativeDeliveryPending) return "silent";
  // A freshly settled job is covered by that same delivery.
  if (observation.recentTerminalIds.length > 0) return "silent";
  // Unchanged state: already acknowledged, or already reminded (replays included).
  if (observation.key === state.acknowledgedKey) return "silent";
  if (state.remindedKeys.includes(observation.key)) return "silent";

  // An opportunity is running work, or a real change against the latched
  // baseline. The baseline is `state` itself — a key the caller recorded for a
  // real emission (`remindedKeys`) or a real checkpoint (`acknowledgedKey`).
  // With no latched key there is nothing this sample can differ from, and an
  // idle first sample is not an overlooked opportunity (spec §B conjunct).
  const hasLatchedBaseline = state.acknowledgedKey !== null || state.remindedKeys.length > 0;
  if (!observation.hasRunningJobs && !hasLatchedBaseline) return "silent";

  return "remind";
}
