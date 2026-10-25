/**
 * `Overview` and `Focus`: the facts each must show, and — the load-bearing half —
 * the facts each must not.
 *
 * The negative assertions are why this file exists. Both screens sit downstream of
 * the D30 contraction, and `OverviewDTO` still carries `issueFlow` while the
 * session digest still carries `knowledge`; a render path that quietly reached
 * for either would resurrect a removed surface with no test noticing. These
 * assertions fail if it happens.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IterationDTO, WorkflowDTO, WorkflowListDTO } from "@mstar-harness/engine";

import type { OverviewDTO } from "@mstar-harness/engine";
import { overviewModel } from "../view-model/overview.ts";
import { focusModel } from "../view-model/focus.ts";
import { Overview, type OverviewCopy } from "./Overview.tsx";
import { Focus, type FocusCopy } from "./Focus.tsx";

const projection = {
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

// A function declaration, not an arrow: in a `.tsx` file `<T>(` parses as a JSX
// element rather than a generic.
function read<T>(data: T) {
  return { state: "read" as const, data };
}

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
      planId: "20261025-unified-ui-shared-layer",
      status: "InProgress",
      progress: "primitives are landing",
      phase: "implement",
      doneAt: null,
      catalogPinRevision: null,
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
    workflow: null,
    plans: [],
    documents: [],
    badges: [],
    gateStep: 2,
    ...over,
  }) as IterationDTO;

const milestones = (count: number) => ({
  projectId: "engine",
  milestones: Array.from({ length: count }, (_, index) => ({
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
});

const overviewRead = (over: Partial<OverviewDTO> = {}): OverviewDTO => ({
  workflows: read<WorkflowListDTO>({ items: [workflow()], total: 1 }),
  residuals: read({ open: 26, bySeverity: { critical: 2, high: 5, medium: 9, low: 7, nit: 3 } }),
  milestones: read(milestones(5)),
  latestIteration: read(iteration()),
  // §8.1 removes the trend from the UI, but the DTO member is the engine's
  // contract and stays; the fixture fills it so the type is honest.
  issueFlow: read({
    buckets: [],
    unknownCaptureDates: 0,
    unknownClosureDates: 0,
    incompleteHistory: false,
    currentOpen: 26,
  }),
  ...over,
});

const overviewCopy: OverviewCopy = {
  pageTitle: "Overview",
  workflowsHeading: "Active workflows",
  workflowsEmpty: "Active workflows",
  plansProgress: (done, total) => `${done}/${total} plans`,
  residualsHeading: "Open residuals",
  residualsTotal: (open) => `${open} open`,
  iterationHeading: "Delivery",
  iterationNoIteration: "Iteration",
  gateStep: (step, of) => `step ${step} of ${of}`,
  milestonesHeading: "Milestones",
  milestonesSummary: (count, open) => `${count} milestones · ${open} open`,
  milestoneProgress: (done, total) => `${done}/${total}`,
  milestoneOpen: (open) => `${open} open`,
  projection: { current: "current", stale: "stale", unavailable: "unavailable" },
  absence: {
    "not-applicable": { labelWord: "n/a", body: "no project resolves" },
    absent: { labelWord: "absent", body: "not declared", pointer: "see the project" },
    empty: { labelWord: "empty", body: "nothing here", hint: "create one" },
    unavailable: { labelWord: "unavailable", body: "the read failed" },
  },
  severityLabels: { critical: "Critical", high: "High", medium: "Medium", low: "Low", nit: "Nit" },
};

const overview = (over: Partial<OverviewDTO> = {}, compact?: boolean): string =>
  renderToStaticMarkup(
    <Overview model={overviewModel(overviewRead(over), { projection })} copy={overviewCopy} compact={compact} />,
  );

const focusCopy: FocusCopy = {
  pageTitle: "Focus",
  bindingBound: (id) => `bound to ${id}`,
  bindingTerminal: (id) => `${id} is terminal`,
  bindingUnbound: "no workflow is bound",
  pickerLabel: "Pick a workflow",
  boardHeading: "Plans",
  boardEmpty: "Plans",
  groupHeading: (status, count) => `${status} · ${count}`,
  plansProgress: (done, total) => `${done}/${total}`,
  progressLabel: "Next",
  blockedLabel: "Blocked",
  progressAbsent: "records no progress",
  deliveryHeading: "Delivery",
  deliveryLine: (id, step, of) => `${id} · step ${step} of ${of}`,
  deliveryNoIteration: "No iteration",
  enforcementLabel: (flag) => `enforcement ${flag}`,
  absence: {
    "not-applicable": { labelWord: "n/a", body: "no active workflow" },
    absent: { labelWord: "absent", body: "the record is gone", pointer: "re-bind" },
    empty: { labelWord: "empty", body: "nothing here", hint: "create one" },
    unavailable: { labelWord: "unavailable", body: "the read failed" },
  },
};

const focus = (input: {
  selection?: Parameters<typeof focusModel>[0]["selection"];
  workflow?: Parameters<typeof focusModel>[0]["workflow"];
  iteration?: Parameters<typeof focusModel>[0]["iteration"];
}): string =>
  renderToStaticMarkup(
    <Focus
      model={focusModel({
        enforcement: "soft",
        // `??` would turn an explicit `null` back into the default and make the
        // unbound / standalone cases untestable; "absent from the input" is what
        // the default is for.
        selection: "selection" in input ? input.selection ?? null : { kind: "active", workflowId: "w", dir: "workflows/w" },
        workflow: input.workflow ?? read(workflow()),
        iteration: "iteration" in input ? input.iteration ?? null : { iterationId: "iter-1", gateStep: 2 },
      })}
      copy={focusCopy}
    />,
  );

describe("Overview — what it shows, in the IA §3.1 order", () => {
  const html = overview();

  test("all active workflows with their plan progress", () => {
    expect(html).toContain("issue-project-move");
    expect(html).toContain("1/2 plans");
    expect(html).toContain("phase-2-execute");
  });

  test("five severity rows, zeros included, with a reconciling total", () => {
    for (const severity of ["critical", "high", "medium", "low", "nit"]) {
      expect(html).toContain(`data-ms-severity="${severity}"`);
    }
    expect(html).toContain("26 open");
  });

  test("a severity the read reports as zero is still rendered as 0, never dropped", () => {
    const zeroed = overview({
      residuals: read({ open: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 } }),
    });
    expect(zeroed.match(/data-ms-severity=/g)?.length).toBe(5);
    expect(zeroed).toContain("0 open");
  });

  test("the latest iteration renders five gate steps with exactly one marked", () => {
    expect(html.match(/data-ms-step-position="current"/g)?.length).toBe(1);
    expect(html.match(/data-ms-step="/g)?.length).toBe(5);
    expect(html).toContain("step 2 of 5");
  });

  test("step 5 is never the marked step, at any store value", () => {
    for (const gateStep of [1, 2, 3, 4] as const) {
      // `gateStep` (contract §3) arrives with the engine plan's branch; until then
      // the member comes from the package's contract mirror and is cast here.
      const page = overview({ latestIteration: read(iteration({ gateStep } )) });
      const marked = page.match(/<li data-ms-step="([^"]+)" data-ms-step-position="current"/);
      expect(marked).not.toBeNull();
      expect(marked?.[1]).not.toBe("merge-ready");
    }
  });

  test("milestones are capped at three and carry progress", () => {
    expect(html.match(/data-ms-milestone-|Milestone \d/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain("Milestone 4");
    expect(html).toContain("6/10");
  });

  test("the projection state closes the page", () => {
    expect(html).toContain('data-ms-projection="current"');
    expect(html.trimEnd().endsWith("</article>")).toBe(true);
    expect(html.lastIndexOf("current")).toBeGreaterThan(html.lastIndexOf("Milestone 0"));
  });

  test("a stale projection states its reason", () => {
    const stale = renderToStaticMarkup(
      <Overview
        model={overviewModel(overviewRead(), {
          projection: {
            ...projection,
            freshness: "stale",
            diagnostics: [{ sourceKey: "compass", reason: "unreadable", message: "compass could not be parsed" }],
          },
        })}
        copy={overviewCopy}
      />,
    );
    expect(stale).toContain('data-ms-projection="stale"');
    expect(stale).toContain("compass: compass could not be parsed");
  });
});

describe("Overview — NEGATIVE: the surfaces D30 removed", () => {
  const html = overview();

  test("no trend chart and no series caption", () => {
    expect(html).not.toContain("data-ms-trend");
    expect(html).not.toContain("sparkline");
    expect(html).not.toMatch(/<svg/i);
  });

  test("no identity line: no version, no harness path", () => {
    expect(html).not.toContain("4.0.9");
    expect(html).not.toContain(".mstar");
    expect(html).not.toContain("harnessDir");
  });

  test("no counter from the read envelope", () => {
    for (const counter of ["storeRevision", "catalogRevision", "builtAt", "checkedAt", "2026-10-25T05:00:00.000Z"]) {
      expect(html).not.toContain(counter);
    }
  });

  test("nothing session-scoped leaked in (no binding, no picker, no enforcement)", () => {
    expect(html).not.toContain("data-ms-binding");
    expect(html).not.toContain("data-ms-picker");
    expect(html).not.toContain("data-ms-enforcement");
  });
});

describe("Overview — the four absence arms, and the short-container order", () => {
  test("each reachable arm reaches a distinct structure and label word", () => {
    const pages = {
      "not-applicable": overview({
        milestones: { state: "not-applicable", reason: "no project resolves for this read" },
      }),
      empty: overview({ workflows: read<WorkflowListDTO>({ items: [], total: 0 }) }),
      unavailable: overview({ residuals: { state: "unavailable", reason: "no such table" } }),
    };
    expect(pages["not-applicable"]).toContain('data-ms-absence="not-applicable"');
    expect(pages["not-applicable"]).toContain("no project resolves for this read");
    expect(pages.empty).toContain('data-ms-absence="empty"');
    expect(pages.unavailable).toContain('data-ms-absence="unavailable"');
    expect(pages.unavailable).toContain("no such table");
    expect(new Set(Object.values(pages)).size).toBe(3);
  });

  // A fact worth stating rather than faking: `absent` is NOT reachable on
  // `Overview`. Each of its five members either exists (a resolved array, an
  // iteration or null) or fails, and "the project declares no such concept" is
  // carried by `not-applicable` at this scope. `Focus` is where a resolved
  // subject can still declare nothing (a bound session whose record is gone),
  // and that arm is asserted in its own block below.
  test("absent is unreachable on Overview, and the component still types it", () => {
    const page = overview({ milestones: read(milestones(0)), latestIteration: read(null) });
    expect(page).not.toContain('data-ms-absence="absent"');
    expect(page).toContain('data-ms-absence="empty"');
  });

  test("a degraded member leaves its neighbours rendered (per-member, not per-page)", () => {
    const page = overview({ residuals: { state: "unavailable", reason: "read failed" } });
    expect(page).toContain('data-ms-absence="unavailable"');
    expect(page).toContain("issue-project-move"); // workflows still there
    expect(page).toContain("step 2 of 5"); // delivery still there
  });

  test("the short-container order: milestones collapse to one summary line first", () => {
    const compact = overview({}, true);
    expect(compact).toContain('data-ms-milestone-summary=""');
    expect(compact).toContain("3 milestones");
    // Nothing else is dropped: the panels IA §3.1 says are never dropped stay.
    expect(compact).toContain("issue-project-move");
    expect(compact).toContain('data-ms-severity="critical"');
    expect(compact).toContain("step 2 of 5");
    expect(compact).toContain('data-ms-projection="current"');
  });
});

describe("Focus — what it shows, in the IA §3.2 order", () => {
  const html = focus({});

  test("the binding line names the bound workflow", () => {
    expect(html).toContain('data-ms-binding="bound"');
    expect(html).toContain("bound to w");
  });

  test("the bound workflow's identity and branch chain", () => {
    expect(html).toContain('data-ms-workflow=""');
    expect(html).toContain('data-ms-branch-chain=""');
    expect(html).toContain("main → issue-project-move");
  });

  test("the plan board is grouped by status, five groups, counts included", () => {
    for (const status of ["Todo", "InProgress", "InReview", "Blocked", "Done"]) {
      expect(html).toContain(`data-ms-group="${status}"`);
    }
    expect(html).toContain("InProgress · 1");
    expect(html).toContain("Todo · 0");
  });

  test("the in-progress plan carries its recorded progress", () => {
    expect(html).toContain('data-ms-progress-note=""');
    expect(html).toContain("primitives are landing");
  });

  test("a blocked plan carries the recorded blocked reason instead", () => {
    const blocked = focus({
      workflow: read(
        workflow({
          plans: [
            {
              workflowId: "w",
              planId: "p-blocked",
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
    });
    expect(blocked).toContain('data-ms-blocked-reason=""');
    expect(blocked).toContain("waiting on the store migration");
    expect(blocked).not.toContain('data-ms-progress-note=""');
  });

  test("a plan that records nothing renders its absent line, never a 0 and never a step", () => {
    const bare = focus({
      workflow: read(
        workflow({
          plans: [
            {
              workflowId: "w",
              planId: "p-bare",
              status: "InProgress",
              progress: null,
              phase: null,
              doneAt: null,
              catalogPinRevision: null,
              catalog: null,
              leases: [],
              badges: [],
            },
          ],
        }),
      ),
    });
    expect(bare).toContain('data-ms-progress-absent=""');
    expect(bare).toContain("records no progress");
    expect(bare).not.toContain("first uncompleted");
  });

  test("the delivery line names the iteration and its step", () => {
    expect(html).toContain('data-ms-delivery="iteration"');
    expect(html).toContain("iter-1 · step 2 of 5");
  });

  test("a standalone delivery is sayable", () => {
    const standalone = focus({ iteration: null });
    expect(standalone).toContain('data-ms-delivery="no-iteration"');
    expect(standalone).toContain("No iteration");
  });

  test("the enforcement flag is the last line", () => {
    expect(html).toContain('data-ms-enforcement="soft"');
    expect(html).toContain("enforcement soft");
  });
});

describe("Focus — NEGATIVE: the surfaces D30 removed", () => {
  const html = focus({});

  test("no project-scoped panel", () => {
    expect(html).not.toContain('data-ms-severity="critical"');
    expect(html).not.toContain("data-ms-milestone");
    expect(html).not.toContain("data-ms-projection");
    expect(html).not.toContain("data-ms-trend");
  });

  test("no knowledge rollup and no inventory count", () => {
    expect(html).not.toContain("knowledge");
    expect(html).not.toContain("document count");
    expect(html).not.toMatch(/\bdocuments?\b/i);
  });

  test("no history: no event log, no occurrence rows, no transition list", () => {
    expect(html).not.toContain("data-ms-occurrences");
    expect(html).not.toContain("data-ms-transitions");
    expect(html).not.toContain("data-ms-lease");
  });
});

describe("Focus — the four absence arms and the binding states", () => {
  test("unbound renders the picker arm, not a fabricated board", () => {
    const page = focus({ selection: null, workflow: { state: "not-applicable", reason: "no active workflow" } });
    expect(page).toContain('data-ms-binding="unbound"');
    expect(page).toContain('data-ms-absence="not-applicable"');
    expect(page).not.toContain('data-ms-group="InProgress"');
  });

  test("bound but the record is gone is absent, and the board says so", () => {
    const page = focus({ workflow: read(null) });
    expect(page).toContain('data-ms-binding="bound"');
    expect(page).toContain('data-ms-absence="absent"');
  });

  test("an unreadable read is unavailable, and the binding line survives", () => {
    const page = focus({ workflow: { state: "unavailable", reason: "projection has no generation" } });
    expect(page).toContain('data-ms-binding="bound"');
    expect(page).toContain('data-ms-absence="unavailable"');
    expect(page).toContain("projection has no generation");
    // The session facts that do not depend on the read still render.
    expect(page).toContain('data-ms-enforcement="soft"');
  });

  test("a terminal binding and a selection error each have their own line", () => {
    const terminal = focus({ selection: { kind: "terminal", workflowId: "w", dir: "workflows/w" } });
    expect(terminal).toContain('data-ms-binding="terminal"');
    const errored = focus({
      selection: {
        kind: "error",
        code: "workflow.selection.unbound-multi-active",
        message: "2 active lifecycles are registered",
        activeWorkflowIds: ["a", "b"],
      },
    });
    expect(errored).toContain('data-ms-binding="error"');
    expect(errored).toContain("2 active lifecycles are registered");
    expect(errored).toContain('data-ms-picker=""');
  });
});
