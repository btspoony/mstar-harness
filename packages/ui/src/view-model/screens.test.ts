/**
 * The two landing-screen view models, asserted against the fact sets of IA §8.2.
 *
 * The **negative** assertions here are the load-bearing ones. `OverviewDTO` still
 * carries `issueFlow` and the session digest still carries `knowledge` — the read
 * model is unchanged (D30 rule 3) — so a transform that quietly modelled them
 * would let a screen resurrect a surface the owner removed. These tests fail if
 * that happens.
 */
import { describe, expect, test } from "bun:test";
import type { IterationDTO, OverviewDTO, RoadmapDTO, WorkflowDTO, WorkflowListDTO } from "@mstar-harness/engine";


import { flowModel, overviewModel, residualModel } from "./overview.ts";
import { focusModel } from "./focus.ts";

const projection = {
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

const workflow = (over: Partial<WorkflowDTO> = {}): WorkflowDTO => ({
  id: "issue-project-move",
  type: "plan",
  status: "running",
  phase: "phase-2-execute",
  startedAt: "2026-10-25T01:00:00.000Z",
  endedAt: null,
  updatedAt: "2026-10-25T05:00:00.000Z",
  branch: { base: "main", source: "issue-project-move", integration: "issue-project-move", target: "main" },
  activeRegistration: true,
  catalog: null,
  plans: [
    {
      workflowId: "issue-project-move",
      planId: "20261025-issue-project-move",
      status: "InProgress",
      progress: "wiring the store read",
      phase: "implement",
      doneAt: null,
      catalogPinRevision: 2,
      catalog: null,
      leases: [],
      badges: [],
    },
    {
      workflowId: "issue-project-move",
      planId: "20261018-panel-retirement",
      status: "Done",
      progress: null,
      phase: "close",
      doneAt: "2026-10-19T01:12:00.000Z",
      catalogPinRevision: null,
      catalog: null,
      leases: [],
      badges: [],
    },
  ],
  badges: [],
  ...over,
});

const iteration = (over: Partial<IterationDTO> = {}): IterationDTO =>
  ({
  iterationId: "iter-20261025-frontend-unification",
  catalog: null,
  compass: {
    iterationId: "iter-20261025-frontend-unification",
    summary: "one product, two hosts",
    milestones: [],
    startedAt: "2026-10-25T01:10:00.000Z",
    endedAt: null,
    status: "locked",
  },
  workflow: { id: "issue-project-move", status: "running", phase: "phase-2-execute", activeRegistration: true },
  plans: [],
  documents: [],
  badges: [],
  // The engine's own member (contract §3): 1..4, or null when there is no compass.
  gateStep: 2,
  ...over,
}) as IterationDTO & { gateStep: 2 };

const roadmap = (milestoneCount: number): RoadmapDTO => ({
  projectId: "engine",
  catalog: {
    kind: "project",
    id: "engine",
    title: "Engine",
    description: null,
    rootKind: "projects",
    relativePath: "engine",
    documentKind: null,
    lifecycle: "active",
    revision: 12,
    registeredAt: "2026-08-09T02:00:00.000Z",
    updatedAt: "2026-10-23T09:42:00.000Z",
  },
  authority: { state: "present", revision: 7, contentHash: "sha256:abcd" },
  content: null,
  milestones: {
    projectId: "engine",
    milestones: Array.from({ length: milestoneCount }, (_, index) => ({
      milestoneId: `m-${index}`,
      projectId: "engine",
      name: `Milestone ${index}`,
      target: "2026-11-07",
      status: "active" as const,
      ordinal: index,
      revision: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
      totalIssues: 10,
      openIssues: 4,
      resolvedIssues: 6,
      otherRetiredIssues: 0,
    })),
    issues: [],
    unassignedIssues: 3,
  },
});

const read = <T>(data: T) => ({ state: "read" as const, data });

const overviewRead = (over: Partial<OverviewDTO> = {}): OverviewDTO => ({
  workflows: read<WorkflowListDTO>({ items: [workflow()], total: 1 }),
  residuals: read({
    open: 26,
    bySeverity: { critical: 2, high: 5, medium: 9, low: 7, nit: 3 },
  }),
  milestones: read(roadmap(5).milestones),
  latestIteration: read(iteration()),
  issueFlow: read({ buckets: [], unknownCaptureDates: 0, unknownClosureDates: 0, currentOpen: 26, incompleteHistory: false }),
  ...over,
});

describe("Overview — the fact set of §8.2", () => {
  const model = overviewModel(overviewRead(), { projection });

  test("all active workflows, one compact row each", () => {
    expect(model.workflows.kind).toBe("populated");
    if (model.workflows.kind !== "populated") return;
    expect(model.workflows.value).toHaveLength(1);
    // The whole row, including the header facts and the plan table's inputs: the
    // five columns read this and nothing else, so a field the screen needs and this
    // does not carry would be filled in by the screen — which is what this pins.
    expect(model.workflows.value[0]).toEqual({
      id: "issue-project-move",
      type: "plan",
      phase: "phase-2-execute",
      status: "running",
      statusTone: "neutral",
      plansDone: 1,
      plansTotal: 2,
      branch: {
        base: "main",
        source: "issue-project-move",
        integration: "issue-project-move",
        target: "main",
      },
      plans: [
        {
          planId: "20261025-issue-project-move",
          title: null,
          status: "InProgress",
          statusTone: "neutral",
          phase: "implement",
          // The note is prose, so there is no fraction to draw and no bar invented.
          progress: null,
          progressNote: "wiring the store read",
          doneAt: null,
        },
        {
          planId: "20261018-panel-retirement",
          title: null,
          status: "Done",
          statusTone: "success",
          phase: "close",
          progress: null,
          progressNote: null,
          // The prototype prints month-day, not the timestamp: `10-19`.
          doneAt: "10-19",
        },
      ],
    });
  });

  test("a plan whose note is a fraction carries done/total; prose stays prose", () => {
    const rows = overviewModel(
      overviewRead({
        workflows: read<WorkflowListDTO>({
          items: [
            workflow({
              plans: [
                { ...workflow().plans[0], progress: "3/6" },
                { ...workflow().plans[0], planId: "p-2", progress: "reviewed source" },
                { ...workflow().plans[0], planId: "p-3", progress: "7/6" },
              ],
            }),
          ],
          total: 1,
        }),
      }),
      { projection },
    );
    if (rows.workflows.kind !== "populated") throw new Error("expected populated");
    const plans = rows.workflows.value[0]?.plans ?? [];
    expect(plans.map((plan) => plan.progress)).toEqual([{ done: 3, total: 6 }, null, null]);
    expect(plans.map((plan) => plan.progressNote)).toEqual([null, "reviewed source", "7/6"]);
  });

  test("five severity rows including zeros, with a reconciling total", () => {
    if (model.residuals.kind !== "populated") throw new Error("expected the residual panel");
    expect(model.residuals.value.rows).toHaveLength(5);
    expect(model.residuals.value.rows.map((row) => row.severity)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "nit",
    ]);
    expect(model.residuals.value.total).toBe(26);
    const sum = model.residuals.value.rows.reduce((total, row) => total + row.count, 0);
    expect(model.residuals.value.total).toBe(sum);
  });

  test("a severity the read reports as zero is still a row", () => {
    const zeros = residualModel({ critical: 0, high: 0, medium: 0, low: 0, nit: 0 });
    expect(zeros.rows.map((row) => row.count)).toEqual([0, 0, 0, 0, 0]);
    expect(zeros.total).toBe(0);
  });

  test("milestones are capped at three and carry status, target, progress and open count", () => {
    if (model.milestones.kind !== "populated") throw new Error("expected milestones");
    expect(model.milestones.value).toHaveLength(3);
    expect(model.milestones.value[0]).toEqual({
      milestoneId: "m-0",
      name: "Milestone 0",
      status: "active",
      target: "2026-11-07",
      progress: { done: 6, total: 10 },
      openIssues: 4,
    });
  });

  test("the latest iteration carries its five gate steps with one marked", () => {
    if (model.latestIteration.kind !== "populated" || model.latestIteration.value === null) {
      throw new Error("expected the iteration block");
    }
    const block = model.latestIteration.value;
    expect(block.steps).toHaveLength(5);
    expect(block.steps.filter((step) => step.position === "current")).toHaveLength(1);
    expect(block.planCount).toBe(0);
  });

  test("an iteration with no compass row marks no step", () => {
    // No compass row means no derivable step: the engine answers null, not 1.
    const noCompass = overviewModel(
      overviewRead({ latestIteration: read(iteration({ compass: null, gateStep: null } as Partial<IterationDTO>)) }),
      { projection },
    );
    if (noCompass.latestIteration.kind !== "populated" || noCompass.latestIteration.value === null) {
      throw new Error("expected the iteration block");
    }
    expect(noCompass.latestIteration.value.gateStep).toBeNull();
    expect(noCompass.latestIteration.value.steps.every((step) => step.position === "ahead")).toBe(true);
  });

  test("no project resolved is not-applicable, never an empty board", () => {
    const scoped = overviewModel(
      overviewRead({
        milestones: { state: "not-applicable", reason: "no project resolves for this read" },
        latestIteration: { state: "not-applicable", reason: "no project resolves for this read" },
      }),
      { projection },
    );
    expect(scoped.milestones).toEqual({ kind: "not-applicable", reason: "no project resolves for this read" });
    expect(scoped.latestIteration.kind).toBe("not-applicable");
  });

  test("one failed member degrades that member only", () => {
    const partial = overviewModel(
      overviewRead({ residuals: { state: "unavailable", reason: "no such table" } }),
      { projection },
    );
    expect(partial.residuals).toEqual({ kind: "unavailable", reason: "no such table" });
    expect(partial.workflows.kind).toBe("populated");
    expect(partial.milestones.kind).toBe("populated");
  });

  test("the flow series is mapped from the read, never recomputed", () => {
    // §8.1 once excluded it; the owner asked for the trend back, and the engine's
    // member never went away. Two dated buckets are the line's minimum.
    const flowed = overviewModel(
      overviewRead({
        issueFlow: read({
          buckets: [
            { date: "2026-10-10", capturedCumulative: 800, retiredCumulative: 300, openDifference: 500, origin: "store" },
            { date: "2026-10-18", capturedCumulative: 850, retiredCumulative: 320, openDifference: 530, origin: "register-history" },
            { date: "2026-10-25", capturedCumulative: 900, retiredCumulative: 350, openDifference: 550, origin: "store" },
          ],
          unknownCaptureDates: 2,
          unknownClosureDates: 0,
          currentOpen: 552,
          incompleteHistory: true,
        }),
      }),
      { projection },
    );
    expect(flowed.issueFlow.kind).toBe("populated");
    if (flowed.issueFlow.kind !== "populated") throw new Error("expected populated");
    const series = flowed.issueFlow.value;
    expect(series.points.length).toBe(3);
    // First, middle and last are the axis labels the card draws.
    expect([series.firstDate, series.middleDate, series.lastDate]).toEqual(["2026-10-10", "2026-10-18", "2026-10-25"]);
    // Every field the card reads, and only those: a series field nobody renders is a
    // promise the screen does not keep, so the shape is pinned rather than widened.
    expect(Object.keys(series).sort()).toEqual([
      "datedOpen",
      "firstDate",
      "lastDate",
      "middleDate",
      "points",
      "recordedOpen",
      "undatedEvents",
    ]);
    expect(series.datedOpen).toBe(550);
    expect(series.recordedOpen).toBe(552);
    expect(series.undatedEvents).toBe(2);
  });

  test("two buckets carry no middle label — the axis would print the first date twice", () => {
    // `floor((2 - 1) / 2)` is 0, so the prototype's own formula labels first, first,
    // last. Two labels are the truth; the axis drops the middle rather than repeat it.
    const two = overviewModel(
      overviewRead({
        issueFlow: read({
          buckets: [
            { date: "2026-10-10", capturedCumulative: 800, retiredCumulative: 300, openDifference: 500, origin: "store" },
            { date: "2026-10-25", capturedCumulative: 900, retiredCumulative: 350, openDifference: 550, origin: "store" },
          ],
          unknownCaptureDates: 0,
          unknownClosureDates: 0,
          currentOpen: 550,
          incompleteHistory: false,
        }),
      }),
      { projection },
    );
    if (two.issueFlow.kind !== "populated") throw new Error("expected populated");
    expect(two.issueFlow.value.middleDate).toBeNull();
    expect(two.issueFlow.value.lastDate).toBe("2026-10-25");
  });

  test("flowModel degrades on a one-bucket input instead of throwing", () => {
    // The exported mapper is called on its own by nothing today, but a guard that lives
    // at the call site is a guard the next caller forgets: with one bucket there is no
    // series, and saying so is its answer.
    const flow = {
      buckets: [{ date: "2026-10-10", capturedCumulative: 800, retiredCumulative: 300, openDifference: 500, origin: "store" as const }],
      unknownCaptureDates: 0,
      unknownClosureDates: 0,
      currentOpen: 500,
      incompleteHistory: false,
    };
    expect(flowModel(flow)).toBeNull();
    expect(flowModel({ ...flow, buckets: [] })).toBeNull();
    // Two buckets is the minimum, and the guard is not off by one.
    expect(flowModel({ ...flow, buckets: [flow.buckets[0], { ...flow.buckets[0], date: "2026-10-25" }] })?.points.length).toBe(2);
  });

  test("fewer than two dated buckets is the empty arm, not a one-point line", () => {
    const single = overviewModel(
      overviewRead({
        issueFlow: read({
          buckets: [{ date: "2026-10-10", capturedCumulative: 800, retiredCumulative: 300, openDifference: 500, origin: "store" }],
          unknownCaptureDates: 0,
          unknownClosureDates: 0,
          currentOpen: 500,
          incompleteHistory: false,
        }),
      }),
      { projection },
    );
    expect(single.issueFlow).toEqual({ kind: "empty" });
  });

  test("an unavailable flow member stays unavailable and never becomes an empty chart", () => {
    const failed = overviewModel(
      overviewRead({ issueFlow: { state: "unavailable", reason: "no such table: issue_transitions" } }),
      { projection },
    );
    expect(failed.issueFlow).toEqual({ kind: "unavailable", reason: "no such table: issue_transitions" });
    expect(failed.workflows.kind).toBe("populated");
  });

  test("NEGATIVE: no identity-line member and no counter is exposed (IA §8.1)", () => {
    for (const removed of [
      "version",
      "harnessDir",
      "builtAt",
      "checkedAt",
      "storeRevision",
      "catalogRevision",
      "identityLine",
    ]) {
      expect(Object.keys(model)).not.toContain(removed);
    }
  });

  test("the projection state carries the state and the reasons, no timestamps", () => {
    expect(model.projection).toEqual({ kind: "current" });
    const stale = overviewModel(overviewRead(), {
      projection: {
        ...projection,
        freshness: "stale",
        diagnostics: [{ sourceKey: "compass", reason: "unreadable", message: "compass could not be parsed" }],
      },
    });
    expect(stale.projection).toEqual({ kind: "stale", reasons: ["compass: compass could not be parsed"] });
  });

  test("a roadmap that exists with no milestones is empty, not absent", () => {
    const noMilestones = overviewModel(overviewRead({ milestones: read(roadmap(0).milestones) }), { projection });
    expect(noMilestones.milestones).toEqual({ kind: "empty" });
  });
});

describe("Focus — the fact set of §8.2", () => {
  const model = focusModel({
    enforcement: "soft",
    selection: { kind: "active", workflowId: "issue-project-move", dir: "workflows/issue-project-move" },
    workflow: read(workflow()),
    iteration: { iterationId: "iter-20261025-frontend-unification", gateStep: 2 },
  });

  test("the binding line names the bound workflow", () => {
    expect(model.binding).toEqual({
      kind: "bound",
      workflowId: "issue-project-move",
      dir: "workflows/issue-project-move",
    });
  });

  test("the board is grouped by status with counts, all five groups present", () => {
    expect(model.groups.map((group) => group.status)).toEqual([
      "Todo",
      "InProgress",
      "InReview",
      "Blocked",
      "Done",
    ]);
    expect(model.groups.map((group) => group.count)).toEqual([0, 1, 0, 0, 1]);
  });

  test("an InProgress plan carries its recorded progress note", () => {
    const inProgress = model.groups.find((group) => group.status === "InProgress");
    expect(inProgress?.plans[0]?.note).toBe("wiring the store read");
    expect(inProgress?.plans[0]?.blockedReason).toBeNull();
  });

  test("a Blocked plan carries the same recorded string as its blocked reason", () => {
    const blocked = focusModel({
      enforcement: "soft",
      selection: { kind: "active", workflowId: "w", dir: "workflows/w" },
      workflow: read(
        workflow({
          plans: [
            {
              workflowId: "w",
              planId: "p",
              status: "Blocked",
              progress: "waiting on the store migration",
              phase: "implement",
              doneAt: null,
              catalogPinRevision: null,
              catalog: null,
              leases: [],
              badges: [],
            },
          ],
        }),
      ),
      iteration: null,
    });
    const group = blocked.groups.find((entry) => entry.status === "Blocked");
    expect(group?.plans[0]?.blockedReason).toBe("waiting on the store migration");
    expect(group?.plans[0]?.note).toBeNull();
  });

  test("a plan with no recorded progress gets no invented next step", () => {
    const none = focusModel({
      enforcement: "soft",
      selection: { kind: "active", workflowId: "w", dir: "workflows/w" },
      workflow: read(workflow({ plans: [] })),
      iteration: null,
    });
    // The absent arm is the caller's to render; the model must not fabricate.
    expect(none.groups.every((group) => group.plans.length === 0)).toBe(true);
  });

  test("the delivery line is the iteration and its proven step", () => {
    expect(model.delivery).toMatchObject({
      kind: "iteration",
      iterationId: "iter-20261025-frontend-unification",
      gateStep: 2,
      position: { step: 2, of: 5 },
    });
  });

  test("standalone delivery is sayable: no iteration", () => {
    const standalone = focusModel({
      enforcement: "soft",
      selection: { kind: "active", workflowId: "w", dir: "workflows/w" },
      workflow: read(workflow()),
      iteration: null,
    });
    expect(standalone.delivery).toEqual({ kind: "no-iteration" });
  });

  test("a multi-active selection error carries its pickable ids", () => {
    const errored = focusModel({
      enforcement: "soft",
      selection: {
        kind: "error",
        code: "workflow.selection.unbound-multi-active",
        message: "2 active lifecycles are registered",
        activeWorkflowIds: ["a", "b"],
      },
      workflow: { state: "not-applicable", reason: "no active workflow" },
      iteration: null,
    });
    expect(errored.binding).toEqual({
      kind: "error",
      code: "workflow.selection.unbound-multi-active",
      message: "2 active lifecycles are registered",
      candidates: ["a", "b"],
    });
  });

  test("an unbound session resolves the workflow to not-applicable, not empty", () => {
    const unbound = focusModel({
      enforcement: "soft",
      selection: null,
      workflow: { state: "not-applicable", reason: "no active workflow" },
      iteration: null,
    });
    expect(unbound.binding).toEqual({ kind: "unbound", picker: [] });
    expect(unbound.workflow.kind).toBe("not-applicable");
  });

  // The four absence states are distinguished by what the SUBJECT is, not by
  // which string the caller happened to pass. An unbound session cannot own a
  // workflow at all, so a successful read that returned nothing is still
  // `not-applicable`; a bound session in the same read state has lost its
  // record, which is `absent`. Collapsing these two is the defect this pair
  // guards — it is exactly what `whenNull: "not-applicable"` used to do, and it
  // does not type-check because `not-applicable` is not a null meaning.
  test("unbound + a read that returned nothing is not-applicable", () => {
    const unbound = focusModel({
      enforcement: "soft",
      selection: null,
      workflow: { state: "read", data: null },
      iteration: null,
    });
    expect(unbound.workflow).toEqual({ kind: "not-applicable", reason: "no active workflow" });
  });

  test("bound + a read that returned nothing is absent, not not-applicable", () => {
    const bound = focusModel({
      enforcement: "soft",
      selection: { kind: "active", workflowId: "w", dir: "workflows/w" },
      workflow: { state: "read", data: null },
      iteration: null,
    });
    expect(bound.workflow).toEqual({ kind: "absent" });
  });

  test("a pending read stays loading for both bindings, and never borrows an absence", () => {
    for (const selection of [null, { kind: "active" as const, workflowId: "w", dir: "workflows/w" }]) {
      const pending = focusModel({
        enforcement: "soft",
        selection,
        workflow: { state: "read", data: null },
        iteration: null,
        phase: "loading",
      });
      expect(pending.workflow.kind).toBe("loading");
    }
  });

  test("the enforcement flag is the only digest fact rendered", () => {
    expect(model.enforcement).toBe("soft");
  });

  test("NEGATIVE: no knowledge rollup and no project-scoped panel (IA §8.1)", () => {
    for (const removed of ["knowledge", "digest", "residuals", "milestones", "issueFlow", "trend"]) {
      expect(Object.keys(model)).not.toContain(removed);
    }
  });
});
