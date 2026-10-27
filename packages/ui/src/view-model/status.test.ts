/**
 * The shared status vocabulary: bucketing, the gate steps and the tone mapping.
 *
 * These are the rules that keep two hosts saying the same thing, so they are
 * asserted directly rather than through a screen.
 */
import { describe, expect, test } from "bun:test";

import {
  GATE_STEPS,
  PLAN_STATUSES,
  bucketPlans,
  compassStatusTone,
  dispositionTone,
  gateStepPosition,
  gateSteps,
  lifecycleTone,
  milestoneStatusTone,
  planProgress,
  planStatusTone,
  severityTone,
} from "./status.ts";
import { workflowStatusTone } from "./workflows.ts";

describe("plan bucketing", () => {
  test("every bucket is present in board order, including empty ones", () => {
    const buckets = bucketPlans([{ planId: "p1", status: "InProgress" }]);
    expect(buckets.map((bucket) => bucket.status)).toEqual([...PLAN_STATUSES]);
    expect(buckets.map((bucket) => bucket.count)).toEqual([0, 1, 0, 0, 0]);
  });

  test("Blocked is its own bucket, never folded into InProgress", () => {
    const buckets = bucketPlans([
      { planId: "a", status: "InProgress" },
      { planId: "b", status: "Blocked" },
    ]);
    expect(buckets.find((bucket) => bucket.status === "InProgress")?.count).toBe(1);
    expect(buckets.find((bucket) => bucket.status === "Blocked")?.count).toBe(1);
  });

  test("an unknown or absent status stays on the board instead of vanishing", () => {
    const buckets = bucketPlans([
      { planId: "a", status: null },
      { planId: "b", status: "SomeFutureWord" },
    ]);
    const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(total).toBe(2);
    expect(buckets[0]?.count).toBe(2);
  });

  test("bucketing preserves input order inside a bucket", () => {
    const buckets = bucketPlans([
      { planId: "first", status: "Done" },
      { planId: "second", status: "Done" },
    ]);
    expect(buckets.find((bucket) => bucket.status === "Done")?.plans.map((plan) => plan.planId)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("the five gate steps", () => {
  test("the vocabulary names all five, in delivery order", () => {
    expect(GATE_STEPS.map((step) => step.id)).toEqual([
      "start",
      "execute",
      "close",
      "pr-delivery",
      "merge-ready",
    ]);
  });

  test("the proven step is current, earlier steps are reached, later are ahead", () => {
    expect(gateSteps(2).map((step) => step.position)).toEqual(["reached", "current", "ahead", "ahead", "ahead"]);
  });

  test("step 5 is never current — the store proves no merge", () => {
    for (const proven of [null, 1, 2, 3, 4]) {
      const last = gateSteps(proven)[4];
      expect(last?.position).not.toBe("current");
    }
  });

  test("no proven step marks nothing and never claims step 1", () => {
    expect(gateSteps(null).every((step) => step.position === "ahead")).toBe(true);
  });

  test("the position line is `step N of 5`, or null — never 0 of 5", () => {
    expect(gateStepPosition(3)).toEqual({ step: 3, of: 5 });
    expect(gateStepPosition(null)).toBeNull();
  });
});

describe("tone mapping keeps the label as the signal", () => {
  test("severity: critical/high are danger, the rest neutral", () => {
    expect(severityTone("critical")).toBe("danger");
    expect(severityTone("medium")).toBe("neutral");
  });

  test("disposition: green is resolved only", () => {
    expect(dispositionTone("resolved")).toBe("success");
    expect(dispositionTone("waived")).toBe("purple");
    expect(dispositionTone("duplicate")).toBe("purple");
    expect(dispositionTone("superseded")).toBe("purple");
    expect(dispositionTone("open")).toBe("neutral");
  });

  test("plan status: done is success, blocked is warning", () => {
    expect(planStatusTone("Done")).toBe("success");
    expect(planStatusTone("Blocked")).toBe("warning");
  });

  test("catalog lifecycle is a vocabulary of its own", () => {
    expect(lifecycleTone("superseded")).toBe("purple");
    expect(lifecycleTone("active")).toBe("neutral");
    expect(compassStatusTone("completed")).toBe("success");
  });
});

describe("progress", () => {
  test("a zero total yields no progress rather than 0/0", () => {
    expect(planProgress(0, 0)).toBeNull();
    expect(planProgress(2, 6)).toEqual({ done: 2, total: 6 });
    expect(planProgress(null, 6)).toBeNull();
  });
});

/**
 * The status tones, held against the prototype's own colour table.
 *
 * Every expectation below was read from the tracked
 * `design-system/prototype.html`'s `.tone-<name> .dot { background: … }` rules. The table is
 * written out here rather than parsed at run time on purpose: a change to either side has to
 * argue with these assertions, while `check:tones` holds the same diff against the prototype.
 */
describe("Status tones — the prototype's colour table", () => {
  test("a live workflow's dot is accent, not the grey a stopped one has", () => {
    // `.tone-running` is `var(--ms-accent)`.
    expect(workflowStatusTone("running")).toBe("accent");
    expect(workflowStatusTone("stopped")).toBe("neutral");
  });

  test("a completed workflow is purple, as `.tone-completed` is", () => {
    expect(workflowStatusTone("completed")).toBe("purple");
  });

  test("every other workflow state keeps its prototype tone", () => {
    expect(workflowStatusTone("paused")).toBe("warning");
    expect(workflowStatusTone("failed")).toBe("danger");
  });

  test("a milestone's four states are accent, neutral, success and purple", () => {
    // `.tone-active` accent, `.tone-todo` neutral, `.tone-done` success.
    expect(milestoneStatusTone("active")).toBe("accent");
    expect(milestoneStatusTone("planned")).toBe("neutral");
    expect(milestoneStatusTone("delivered")).toBe("success");
    expect(milestoneStatusTone("dropped")).toBe("purple");
  });
});
