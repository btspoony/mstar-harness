/**
 * Phase-2 opportunity orchestration — native settings normalization and the
 * bounded reminder decision.
 *
 * Primary spec: `{SPECS_DIR}/omp-phase2-instances.md` §B (reminder event and
 * latch contract) and §C (capacity/settings); plan: the registered Phase-2 instances plan, Task 1. Two pure surfaces:
 *
 * - `decodePhase2Settings` / `readPhase2Settings` normalize the native
 *   `@mstar-harness/omp` preference pair `phase2PlanInstances` /
 *   `maxPlanInstances`. A key absent from the effective settings falls back to
 *   its schema default (`false`, `2`); a key that is present but malformed
 *   refuses with a visible reason instead of being coerced, so a bad capacity
 *   can never widen or authorize an extra primary launch.
 * - `decidePhase2Reminder` is the once-per-changed-state latch the host event
 *   adapter consults at `agent_end`. It yields at most one advisory per changed
 *   opportunity observation and is silent for every suppressed, replayed,
 *   unowned or unreadable state.
 *
 * `phase2PlanInstances` gates **extra primary launches only**: it is not an
 * input to the reminder decision, and `maxPlanInstances` keeps its saved value
 * regardless of the opt-in, so a disabled opt-in never rewrites the operator's
 * configured capacity.
 *
 * Not here, by contract: no timer or polling loop, no host async-job snapshot
 * access, no invented job-settled event, no launch transport, no journal or
 * other persistence write, and no job-to-plan inference from labels. The
 * observation `key` is computed by the caller from the canonical projection
 * (workflow/session identity, running job ids/types/statuses, engine plan
 * facts, and — only when launch mode is enabled — the transport-journal byte
 * version and latest valid capacity); this module compares and latches that
 * key and never invents one.
 */
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

/** npm package whose native settings own this feature (manifest `omp.settings`). */
const PLUGIN_NAME = "@mstar-harness/omp";

/* ------------------------------------------------------------------------- *
 * Native settings
 * ------------------------------------------------------------------------- */

export type Phase2Settings = Readonly<{
  /** Allow Phase-2 coordinators to launch extra plan-scoped primaries. Default `false`. */
  phase2PlanInstances: boolean;
  /** Maximum concurrently active plan-scoped primaries (owned pending launches included). Default `2`, minimum `1`. */
  maxPlanInstances: number;
}>;

export type Phase2SettingsResult =
  | { ok: true; value: Phase2Settings }
  | { ok: false; reason: "settings-read-failed" | "invalid-settings"; message: string };

/** Manifest defaults, applied per key and only when that key is absent. */
const DEFAULT_PHASE2_PLAN_INSTANCES = false;
const DEFAULT_MAX_PLAN_INSTANCES = 2;

/** One refusal message per malformed key, so every rejection reads the same way. */
function invalidPhase2Setting(key: string, requirement: string, value: unknown): Phase2SettingsResult {
  return {
    ok: false,
    reason: "invalid-settings",
    message: `${key} must be ${requirement}, received ${
      typeof value === "string" ? JSON.stringify(value) : String(value)
    }`,
  };
}

/**
 * Decode the effective `@mstar-harness/omp` settings record into the Phase-2
 * launch preference. Pure: `readPhase2Settings` adds only the host read.
 *
 * Strict on purpose — a present value is validated, never coerced (spec OA1):
 * `phase2PlanInstances` must be a boolean and `maxPlanInstances` must be a
 * positive safe integer. There is deliberately no upper bound: the schema
 * declares the setting configurable, so `2` is a default, not a ceiling.
 * A key's **presence is decided by own property, not by its value**: only a
 * genuinely absent key takes the schema default, so a programmatic caller
 * passing `{ maxPlanInstances: undefined }` gets a refusal rather than a silent
 * `2`. Unknown keys in the record belong to other features and are ignored.
 */
export function decodePhase2Settings(raw: Record<string, unknown>): Phase2SettingsResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalidPhase2Setting("plugin settings", "an object", raw);
  }

  // Presence is decided by own property, never by the value: a programmatic
  // caller sending `{ maxPlanInstances: undefined }` sent a key whose value is
  // malformed, so it refuses instead of silently taking the schema default. The
  // native path deserializes JSON, which cannot carry `undefined` at all — this
  // boundary exists because the decoder is exported.
  const phase2PlanInstances = Object.prototype.hasOwnProperty.call(raw, "phase2PlanInstances")
    ? raw.phase2PlanInstances
    : DEFAULT_PHASE2_PLAN_INSTANCES;
  if (typeof phase2PlanInstances !== "boolean") {
    return invalidPhase2Setting("phase2PlanInstances", "a boolean", raw.phase2PlanInstances);
  }

  const maxPlanInstances = Object.prototype.hasOwnProperty.call(raw, "maxPlanInstances")
    ? raw.maxPlanInstances
    : DEFAULT_MAX_PLAN_INSTANCES;
  if (typeof maxPlanInstances !== "number" || !Number.isSafeInteger(maxPlanInstances) || maxPlanInstances < 1) {
    return invalidPhase2Setting("maxPlanInstances", "a positive safe integer", raw.maxPlanInstances);
  }

  return { ok: true, value: { phase2PlanInstances, maxPlanInstances } };
}

/**
 * Read the effective native Phase-2 preference for a coordinator session
 * running in `cwd`, through the exported host helper (the same public uncached
 * reader the model-handoff feature uses). The helper rereads the user runtime
 * settings plus the project `plugin-overrides.json` on every call, so the
 * admission path can re-read immediately before a launch instead of trusting a
 * snapshot loaded at session entry.
 *
 * Never throws: a read failure and a malformed preference are both reported
 * through `Phase2SettingsResult`, so the caller can surface the refusal and
 * authorize nothing.
 */
export async function readPhase2Settings(cwd: string): Promise<Phase2SettingsResult> {
  let raw: Record<string, unknown>;
  try {
    raw = await getPluginSettings(PLUGIN_NAME, cwd);
  } catch (error) {
    return {
      ok: false,
      reason: "settings-read-failed",
      message: `could not read ${PLUGIN_NAME} plugin settings: ${String(error)}`,
    };
  }

  return decodePhase2Settings(raw);
}

/* ------------------------------------------------------------------------- *
 * Host request surface (types only — the journal and its behavior live in
 * `phase2-launches.ts`; these shapes are shared so that module can type its
 * reserve/record variants as spec §A)
 * ------------------------------------------------------------------------- */

export type CheckpointReason =
  | "before-wait"
  | "result-settled"
  | "dependency-changed"
  | "ownership-changed"
  | "capacity-changed";

export type Phase2Request =
  | { operation: "bind"; workflowId: string; coordinatorSessionPath: string }
  | {
    operation: "checkpoint";
    reason: CheckpointReason;
    decision: "dispatched" | "wait" | "blocked";
    note: string;
  }
  | {
    operation: "reserve-launch";
    planId: string;
    transport: "herdr" | "tmux";
    skill: { name: string; source: string };
    capability: { executable: string; version: string; target: string };
  }
  | {
    operation: "record-launch";
    intentId: string;
    observation: "starting" | "created" | "submitting" | "submitted" | "refused" | "uncertain";
    target?: string;
    evidencePath: string;
  };

/* ------------------------------------------------------------------------- *
 * Bounded reminder decision
 * ------------------------------------------------------------------------- */

/**
 * One sampled opportunity observation. `key` is the caller's canonical
 * projection of the owning workflow/session, the owner-filtered running jobs
 * (id/type/status) and the relevant engine/transport facts; labels, timestamps,
 * result text and recent-job eviction are excluded from it, so the key changes
 * only when the opportunity itself does.
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
 * engine/transport observation).
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
  // baseline (capacity freed, dependency/ownership changed). The baseline is
  // `state` itself — a key the caller recorded for a real emission
  // (`remindedKeys`) or a real checkpoint (`acknowledgedKey`). With no latched
  // key there is nothing this sample can differ from, and an idle first sample
  // is not an overlooked opportunity (spec §B conjunct).
  const hasLatchedBaseline = state.acknowledgedKey !== null || state.remindedKeys.length > 0;
  if (!observation.hasRunningJobs && !hasLatchedBaseline) return "silent";

  return "remind";
}
