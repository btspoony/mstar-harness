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

/** Three dated buckets: enough for a line, and small enough to state by hand. */
const FLOW: OverviewDTO["issueFlow"] = {
  state: "read",
  data: {
    buckets: [
      { date: "2026-10-10", capturedCumulative: 800, retiredCumulative: 300, openDifference: 500, origin: "store" },
      { date: "2026-10-18", capturedCumulative: 850, retiredCumulative: 320, openDifference: 530, origin: "register-history" },
      { date: "2026-10-25", capturedCumulative: 900, retiredCumulative: 350, openDifference: 550, origin: "store" },
    ],
    unknownCaptureDates: 2,
    unknownClosureDates: 0,
    currentOpen: 552,
    incompleteHistory: true,
  },
};

const overviewRead = (over: Partial<OverviewDTO> = {}): OverviewDTO => ({
  workflows: read<WorkflowListDTO>({ items: [workflow()], total: 1 }),
  residuals: read({ open: 26, bySeverity: { critical: 2, high: 5, medium: 9, low: 7, nit: 3 } }),
  milestones: read(milestones(5)),
  latestIteration: read(iteration()),
  issueFlow: FLOW,
  ...over,
});

const overviewCopy: OverviewCopy = {
  pageTitle: "Overview",
  workflowsHeading: "Active workflows",
  workflowsEmpty: "Active workflows",
  workflowsTruncated: (shown: number, total: number) => `showing ${shown} of ${total}`,
  plansProgress: (done, total) => `${done}/${total} plans`,
  planColumns: { plan: "Plan", title: "Title", status: "Status", progress: "Progress", done: "Completed" },
  workflowMeta: (plans, status) => `${plans} plans \u00b7 ${status}`,
  planTableCaption: "Plans under this workflow",
  planStatusAbsent: "Status not recorded",
  planProgressAbsent: "Records no progress.",
  typeLabel: "Type",
  openWorkflow: "Open workflow",
  branchBase: "Base",
  branchSource: "Source",
  branchIntegration: "Integration",
  branchTarget: "Target",
  dash: "\u2014",
  trendHeading: "Issue flow trend",
  trendRange: (from, to) => `${from} → ${to}`,
  trendChartTitle: (from, to) => `Cumulative captured and retired issues, ${from} to ${to}`,
  trendCaptured: "Captured (cumulative)",
  trendRetired: "Retired (cumulative)",
  trendLegend: (datedOpen, recordedOpen) => `${datedOpen} dated open · ${recordedOpen} recorded open`,
  trendGap: (datedOpen, undated) => `Dated history closes at ${datedOpen} open; ${undated} events undated.`,
  trendTableSummary: "Dated history (table alternative)",
  trendColumns: { date: "Date", captured: "Captured", retired: "Retired", open: "Open difference", origin: "Origin" },
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
  deliveryUnknownStep: "Iteration · no delivery step recorded",
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

  test("the workflow's header line: id, type, phase, and its own count", () => {
    expect(html).toContain("issue-project-move");
    expect(html).toContain("phase-2-execute");
    // The count line is the workflow's own plan total and status, not the page's.
    expect(html).toContain('data-ms-workflow-meta="2"');
    expect(html).toContain("2 plans \u00b7 running");
  });

  test("the branch chain is drawn when the workflow records one", () => {
    for (const anchor of ["Base", "Source", "Integration", "Target"]) expect(html).toContain(`<span>${anchor}</span>`);
    expect(html).toContain("<b>main</b>");
    // Exactly one arrow between each adjacent pair; the trend's head states its own
    // range with the same glyph, so the count is taken on the chain's own arrows.
    expect(html).toContain("data-ms-branch");
    expect((html.match(/<span aria-hidden="true">\u2192<\/span>/g) ?? []).length).toBe(3);
  });

  test("the plan table: five columns, one row per plan, the prototype's cells", () => {
    // `design-v1.html:859-866`: Plan | Title | Status | Progress | Done.
    for (const key of ["plan", "title", "status", "progress", "done"]) {
      expect(html).toContain(`data-ms-col-key="${key}"`);
    }
    // One row per plan the DTO carries — two in this fixture.
    expect((html.match(/data-ms-row-key=/g) ?? []).length).toBe(2);
    expect(html).toContain("20261025-unified-ui-shared-layer");
    // Status is a dot and its word; a plan with no status would say so instead.
    expect(html).toContain('data-ms-tone="success"');
    // Progress: the note as prose, and the absent line when there is none.
    expect(html).toContain("primitives are landing");
    expect(html).toContain("Records no progress.");
    // Done: month-day, the prototype's short form.
    expect(html).toContain("<span>10-19</span>");
  });

  test("a plan whose status the store does not record says so, never an empty cell", () => {
    // The shared absent treatment, not a blank `<td>`: a cell with nothing in it reads
    // as a rendering failure, while a sentence says the store carries no status.
    const plan = workflow().plans[0];
    const absent = overview({
      workflows: read<WorkflowListDTO>({
        items: [workflow({ plans: [{ ...plan, status: null }] })],
        total: 1,
      }),
    });
    expect(absent).toContain("Status not recorded");
    expect(absent).toContain('data-ms-row-key="20261025-unified-ui-shared-layer"');
    expect(absent).not.toMatch(/<td[^>]*>\s*<\/td>/);
  });

  test("the Open workflow link appears only when the host can honour it", () => {
    expect(html).not.toContain("Open workflow");
    const hosted = renderToStaticMarkup(
      <Overview
        model={overviewModel(overviewRead(), { projection })}
        copy={overviewCopy}
        onOpenWorkflow={() => undefined}
      />,
    );
    expect(hosted).toContain("Open workflow");
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

describe("Overview — the loading phase, and the literal severity", () => {
  test("a pending read renders no absence arm, and does not crash", () => {
    // D: the arm coercion used to hit `copy.absence["loading"]`, which is
    // undefined — a white screen in exactly the phase a first paint is in.
    const html = renderToStaticMarkup(
      <Overview
        model={overviewModel(overviewRead(), { projection, phase: "loading" })}
        copy={overviewCopy}
      />,
    );
    expect(html).toContain("data-ms-screen=\"overview\"");
    expect(html).not.toContain("data-ms-absence=");
  });

  test("a severity row's label is the literal enum, never a translation", () => {
    // `copy.severityLabels` is presentational hook only; the contract value is what
    // renders, so it stays copyable into the CLI. The label rides the status dot now
    // (the prototype's tally: dot + literal word, count right-aligned).
    const html = overview();
    expect(html).toContain('data-ms-severity="critical"');
    expect(html).toContain("<span>critical</span>");
    // A definition list still groups each severity with its count: `dl` permits a
    // `div` wrapper, so the two-column grid and the grouping coexist.
    expect(html).toContain("<dt>");
    expect(html).toContain("<dd>");
    expect(html).not.toContain("<span>Critical</span>");
  });
});

describe("Overview — the issue-flow trend, drawn from the read", () => {
  const html = overview();

  test("two step lines, one solid and one dashed, labelled by their date range", () => {
    // `design-v1.html:385-396`: captured solid in the accent, retired dashed in the
    // muted tone. Pattern, not hue, is the first difference — that is what survives
    // greyscale.
    expect(html).toContain('data-ms-flow=""');
    expect(html).toContain('data-ms-flow-chart=""');
    expect(html).toMatch(/<svg[^>]*role="img"/);
    expect(html).toContain("Cumulative captured and retired issues, 2026-10-10 to 2026-10-25");
    // One step path per series, and each path has a vertex per bucket.
    const paths = html.match(/<path[^>]*d="M[^"]*"/g) ?? [];
    expect(paths.length).toBe(2);
    for (const path of paths) expect((path.match(/V/g) ?? []).length).toBe(2);
  });

  test("the axis carries the first, middle and last date", () => {
    for (const date of ["2026-10-10", "2026-10-18", "2026-10-25"]) expect(html).toContain(date);
  });

  test("both cumulative totals and the dated-history gap reach the text, not only the figure", () => {
    // The numbers the lines encode are readable without the SVG: the legend states the
    // two open counts, and the note states what the dated history closes at.
    expect(html).toContain("550 dated open · 552 recorded open");
    expect(html).toContain("Dated history closes at 550 open; 2 events undated.");
  });

  test("the table alternative carries every bucket, with its origin", () => {
    expect(html).toContain("Dated history (table alternative)");
    expect(html).toContain("<details");
    // One row per bucket plus the header row.
    expect((html.match(/register-history/g) ?? []).length).toBe(1);
    expect((html.match(/2026-10-18/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("an unavailable member renders the shared arm, never an empty chart", () => {
    const failed = overview({ issueFlow: { state: "unavailable", reason: "no such table: issue_transitions" } });
    expect(failed).toContain('data-ms-absence="unavailable"');
    expect(failed).toContain("no such table: issue_transitions");
    expect(failed).not.toMatch(/<svg/i);
    expect(failed).not.toContain("data-ms-flow-chart");
  });

  test("a flow with fewer than two buckets is the empty arm, not a one-point line", () => {
    const thin = overview({
      issueFlow: read({
        buckets: [{ date: "2026-10-10", capturedCumulative: 800, retiredCumulative: 300, openDifference: 500, origin: "store" }],
        unknownCaptureDates: 0,
        unknownClosureDates: 0,
        currentOpen: 500,
        incompleteHistory: false,
      }),
    });
    expect(thin).toContain('data-ms-absence="empty"');
    expect(thin).not.toMatch(/<svg/i);
  });
});

describe("Overview — NEGATIVE: the surfaces D30 removed", () => {
  const html = overview();

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

describe("Focus — the loading chip", () => {
  test("a pending read renders no absence arm, and does not crash", () => {
    // The same defect Overview had: `copy.absence["loading"]` is undefined, so
    // the board threw on first paint instead of showing the binding line.
    const html = renderToStaticMarkup(
      <Focus
        model={focusModel({
          enforcement: "soft",
          selection: { kind: "active", workflowId: "w", dir: "workflows/w" },
          workflow: read(workflow()),
          iteration: null,
          phase: "loading",
        })}
        copy={focusCopy}
      />,
    );
    expect(html).toContain("data-ms-screen=\"focus\"");
    expect(html).not.toContain("data-ms-absence=");
    // The facts that do not depend on the read still render.
    expect(html).toContain('data-ms-binding="bound"');
  });
});

describe("Focus — an unknown delivery step is its own state", () => {
  test("an iteration with no proven step never renders `step 0 of 5`", () => {
    // G: `position?.step ?? 0` used to produce a measured-looking zero.
    const html = focus({ iteration: { iterationId: "iter-1", gateStep: null } });
    expect(html).not.toContain("step 0 of 5");
    expect(html).toContain("no delivery step recorded");
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
