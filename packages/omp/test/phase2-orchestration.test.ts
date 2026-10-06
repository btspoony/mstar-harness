/**
 * Bounded Phase-2 reminder decision — scoped contract checks for
 * `packages/omp/src/phase2-orchestration.ts`.
 *
 * The decision cases are pure. They pin the once-per-changed-state latch, the
 * owner/phase and unavailable-snapshot inertness, native-delivery suppression,
 * and blocker/user-steering precedence — decision outcomes only, not the claim
 * that a host event adapter calls the decision (that wiring is the extension's
 * separately reviewed surface, and no static assertion here can substitute for
 * it). The changed-idle path is exercised through the real latch lifecycle — a
 * running observation that is reminded, then a changed idle one — never by
 * seeding a latch state that lifecycle could not produce.
 *
 * The plan-PM launcher settings (`phase2PlanInstances` / `maxPlanInstances`) and
 * their native reader were removed with the removed launch journal; this module
 * now owns the reminder decision alone.
 */
import { describe, expect, test } from "bun:test";
import {
  decidePhase2Reminder,
  type Phase2Observation,
  type ReminderContext,
  type ReminderState,
} from "../src/phase2-orchestration";

/* --- decision fixtures: observations, latch states, a bound coordinator context --- */

const RUNNING_STATE_A: Phase2Observation = {
  key: "state-a",
  hasRunningJobs: true,
  nativeDeliveryPending: false,
  recentTerminalIds: [],
};

const IDLE_STATE_B: Phase2Observation = { ...RUNNING_STATE_A, key: "state-b", hasRunningJobs: false };

const FRESH_LATCH: ReminderState = { acknowledgedKey: null, remindedKeys: [], blocked: false };

/** Latch after one real emission: the caller records the key before sending (spec §B). */
const AFTER_REMINDING_A: ReminderState = { acknowledgedKey: null, remindedKeys: ["state-a"], blocked: false };

const BOUND_PHASE2: ReminderContext = {
  boundPhase2: true,
  pendingMessages: false,
  userTurn: false,
  snapshotAvailable: true,
};

/** Decision under the bound Phase-2 context, with one fact overridden per case. */
function evaluate(
  state: ReminderState,
  observation: Phase2Observation,
  overrides: Partial<ReminderContext> = {},
): "silent" | "remind" {
  return decidePhase2Reminder(state, observation, { ...BOUND_PHASE2, ...overrides });
}

describe("bounded reminder decision", () => {
  test("owner and phase scope stays inert", () => {
    // Not the bound Phase-2 coordinator of the active iteration: leaf, other
    // workflow and Phase 1/3-6 sessions all arrive as `false`.
    expect(evaluate(FRESH_LATCH, RUNNING_STATE_A, { boundPhase2: false })).toBe("silent");
    // A null (unavailable) native snapshot is not "no jobs".
    expect(evaluate(FRESH_LATCH, RUNNING_STATE_A, { snapshotAvailable: false })).toBe("silent");
    // Unavailable wins over a would-be eligible observation even once a latch exists.
    expect(
      evaluate(
        { acknowledgedKey: "state-a", remindedKeys: ["state-a"], blocked: false },
        IDLE_STATE_B,
        { snapshotAvailable: false },
      ),
    ).toBe("silent");
  });

  test("unavailable snapshot stays silent instead of reporting idle", () => {
    expect(evaluate(FRESH_LATCH, { ...IDLE_STATE_B, key: "state-idle" }, { snapshotAvailable: false })).toBe(
      "silent",
    );
    expect(evaluate(AFTER_REMINDING_A, IDLE_STATE_B, { snapshotAvailable: false })).toBe("silent");
  });

  test("first idle sample with no latch stays silent by design", () => {
    // Spec §B requires "running work or a changed engine/transport
    // observation". With no latched key there is nothing this sample can differ
    // from, so an idle, unchanged Phase-2 entry is not an overlooked
    // opportunity. This is designed semantics, not a defect — and it is why the
    // caller's real latch (an emission or a checkpoint) is the baseline.
    expect(evaluate(FRESH_LATCH, IDLE_STATE_B)).toBe("silent");
  });

  test("one reminder per changed observation state", () => {
    // Real lifecycle step 1: a running observation gets its single advisory,
    // and the caller records that key before sending.
    expect(evaluate(FRESH_LATCH, RUNNING_STATE_A)).toBe("remind");
    // Same opportunity state again: an unchanged state never re-fires.
    expect(evaluate(AFTER_REMINDING_A, RUNNING_STATE_A)).toBe("silent");
    // Real lifecycle step 2: the opportunity then changes to an idle one
    // (freed capacity, dependency/ownership change) with nothing running. The
    // latch established by that real emission is enough to let it through.
    expect(evaluate(AFTER_REMINDING_A, IDLE_STATE_B)).toBe("remind");
    // And once reminded, that changed state is latched too.
    expect(evaluate({ acknowledgedKey: null, remindedKeys: ["state-a", "state-b"], blocked: false }, IDLE_STATE_B))
      .toBe("silent");
  });

  test("acknowledged opportunity state stays silent", () => {
    // `acknowledgedKey` is written by a real `checkpoint` (PM ran the shared
    // scheduling checkpoint against that sampled state), so the same state is
    // not re-advertised. This asserts acknowledgement suppression only; the
    // change-detection baseline is proven by the real lifecycle case above.
    expect(evaluate({ acknowledgedKey: "state-a", remindedKeys: [], blocked: false }, RUNNING_STATE_A)).toBe(
      "silent",
    );
    // A real checkpoint latches the state it acknowledged, not the future: a
    // later changed state is still eligible.
    expect(evaluate({ acknowledgedKey: "state-a", remindedKeys: [], blocked: false }, IDLE_STATE_B)).toBe("remind");
  });

  test("replayed observation never repeats", () => {
    // Both keys were recorded by real decisions/checkpoints earlier in the session.
    const replayed: ReminderState = { acknowledgedKey: null, remindedKeys: ["state-a", "state-b"], blocked: false };
    expect(evaluate(replayed, RUNNING_STATE_A)).toBe("silent");
    expect(evaluate(replayed, IDLE_STATE_B)).toBe("silent");
    // A -> B -> A after a session rebuild: the replayed A key is still latched.
    expect(evaluate(replayed, RUNNING_STATE_A)).toBe("silent");
    // Only a genuinely new state is eligible again.
    expect(evaluate(replayed, { ...RUNNING_STATE_A, key: "state-c" })).toBe("remind");
  });

  test("native delivery suppresses reminder", () => {
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, nativeDeliveryPending: true })).toBe("silent");
    // A settled job the host delivery already owns: no plugin notice, no reproduced text.
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, key: "state-settled", recentTerminalIds: ["job-9"] })).toBe(
      "silent",
    );
  });

  test("blocker and user steering win", () => {
    // A real blocker outranks a brand-new eligible state.
    expect(evaluate({ ...FRESH_LATCH, blocked: true }, { ...RUNNING_STATE_A, key: "state-new" })).toBe("silent");
    // Explicit user steering: the user's own turn is the continuation.
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, key: "state-new" }, { userTurn: true })).toBe("silent");
    // A queued message already continues the session.
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, key: "state-new" }, { pendingMessages: true })).toBe("silent");
  });

  test("uncomputable observation key stays silent", () => {
    // An empty key means the caller could not build the canonical projection;
    // it is never latched as if it were a real observation.
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, key: "" })).toBe("silent");
  });
});

describe("observation projection digest", () => {
  test("the key is stable, sorted and sensitive to each real fact", async () => {
    const { phase2ObservationKey } = await import("../src/extensions/phase2-orchestration");
    const base = {
      workflowId: "wf-a",
      hostSessionId: "host-a",
      running: [
        { id: "job-1", type: "task", status: "running" },
        { id: "job-2", type: "task", status: "running" },
      ],
      planFacts: ["plan:p-1:Todo:0", "plan:p-2:InProgress:3"],
    };
    const key = phase2ObservationKey(base);
    // Order of the sampled rows is not a fact: the projection sorts before hashing.
    expect(phase2ObservationKey({ ...base, running: [...base.running].reverse(), planFacts: [...base.planFacts].reverse() })).toBe(key);
    // A changed job status, a changed plan revision and another session each change the key.
    expect(phase2ObservationKey({ ...base, running: [{ ...base.running[0]!, status: "done" }, base.running[1]!] })).not.toBe(key);
    expect(phase2ObservationKey({ ...base, planFacts: ["plan:p-1:Todo:1", "plan:p-2:InProgress:3"] })).not.toBe(key);
    expect(phase2ObservationKey({ ...base, hostSessionId: "host-b" })).not.toBe(key);
  });
});
