/**
 * `Iterations` and `IterationDetail`.
 *
 * Two things this file holds:
 *
 *  1. the gate display is four labels plus a **never-marked fifth** (D29): step 5
 *     is merge, no store row records a merge, and a violation count has no source
 *     a dashboard view may read;
 *  2. the removed iteration surfaces stay removed — the document inventory and its
 *     count, the compass milestone-id list, and every revision counter.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IterationDTO, IterationListDTO } from "@mstar-harness/engine";

import { iterationDetailModel, iterationListModel } from "../view-model/iterations.ts";

import { Iterations, type IterationsCopy } from "./Iterations.tsx";
import { IterationDetail as IterationDetailScreen, type IterationDetailCopy } from "./IterationDetail.tsx";

const projection = {
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

const catalogEntry = (over: Record<string, unknown> = {}): NonNullable<IterationDTO["catalog"]> =>
  ({
    kind: "iteration" as const,
    id: "iter-20261025-frontend-unification",
    title: "Frontend unification",
    description: null,
    rootKind: "iterations",
    relativePath: "iter-20261025-frontend-unification",
    documentKind: "other" as const,
    lifecycle: "active",
    revision: 5,
    registeredAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T05:00:00.000Z",
    ...over,
  }) as NonNullable<IterationDTO["catalog"]>;

const iteration = (over: Partial<IterationDTO> = {}): IterationDTO =>
  ({
    iterationId: "iter-20261025-frontend-unification",
    catalog: catalogEntry(),
    compass: {
      iterationId: "iter-20261025-frontend-unification",
      summary: "one product, two hosts",
      // A milestone-id list the detail must NOT render (the roadmap feature owns it).
      milestones: ["9f2c4a10", "3a7b1c22"],
      startedAt: "2026-10-25T01:10:00.000Z",
      endedAt: null,
      status: "locked",
    },
    workflow: { id: "issue-project-move", status: "running", phase: "phase-2-execute", activeRegistration: true },
    plans: [
      {
        planId: "20261025-unified-ui-shared-layer",
        catalog: catalogEntry({ kind: "plan", id: "20261025-unified-ui-shared-layer", title: "Shared layer" }),
        execution: { workflowId: "issue-project-move", status: "InProgress", progress: "screens are landing", phase: "implement", doneAt: null },
        catalogPinRevision: 2,
        badges: [],
      },
      {
        planId: "20261018-panel-retirement",
        catalog: null,
        execution: { workflowId: "issue-project-move", status: "Done", progress: null, phase: "close", doneAt: "2026-10-19T01:12:00.000Z" },
        catalogPinRevision: null,
        badges: [],
      },
    ],
    // An inventory the detail must NOT render, with a count it must not print.
    documents: [
      catalogEntry({ kind: "document", id: "doc-1", title: "Delivery compass", documentKind: "compass" }),
      catalogEntry({ kind: "document", id: "doc-2", title: "IA spec", documentKind: "spec" }),
    ],
    badges: [],
    gateStep: 2,
    ...over,
  }) as IterationDTO;

const iterationsCopy: IterationsCopy = {
  pageTitle: "Iterations",
  tableCaption: "Iterations",
  columns: {
    id: "Iteration",
    title: "Title",
    lifecycle: "Lifecycle",
    execution: "Compass",
    delivery: "Delivery",
    plans: "Plans",
    started: "Started",
  },
  gateStep: (step, of) => `step ${step} of ${of}`,
  noCompass: "no compass",
  notStarted: "not started",
  plansProgress: (done, total) => `${done}/${total} plans`,
  empty: { labelWord: "empty", heading: "No iterations", body: "this project has none", hint: "start one" },
  absent: { labelWord: "absent", heading: "Iterations", body: "not attributed", pointer: "see the project" },
  unavailable: { labelWord: "unavailable", heading: "Iterations", body: "the read failed" },
  attribution: (arm) => (arm === "present" ? "attributed to projects" : "not attributed"),
};

const renderList = (
  items: IterationDTO[],
  total: number,
  attribution: IterationListDTO["attribution"] = "present",
  generation: number | null = 7,
): string =>
  renderToStaticMarkup(
    <Iterations
      model={iterationListModel({
        data: { items, total, attribution } ,
        projection: { ...projection, generation },
      })}
      copy={iterationsCopy}
    />,
  );

const detailCopy: IterationDetailCopy = {
  breadcrumb: { label: "Breadcrumb", current: "Iterations" },
  compassHeading: "Compass",
  planTableHeading: "Plans",
  catalogHeading: "Catalog",
  executionHeading: "Execution",
  fields: {
    id: "Iteration",
    title: "Title",
    lifecycle: "Lifecycle",
    root: "Root",
    compassStatus: "Compass status",
    startedAt: "Started",
    endedAt: "Ended",
    workflow: "Workflow",
    noWorkflow: "none",
    noCompass: "no compass",
    noSummary: "no summary recorded",
    notStarted: "not started",
  },
  gateStep: (step, of) => `step ${step} of ${of}`,
  gateStepLabels: {
    start: "Start",
    execute: "Execute",
    close: "Close",
    "pr-delivery": "PR delivery",
    "merge-ready": "Merge ready",
  },
  gateNoCompass: "Delivery",
  planColumns: { planId: "Plan", title: "Title", status: "Status", progress: "Progress", doneAt: "Done" },
  planProgressAbsent: "records no progress",
  unavailable: { labelWord: "unavailable", heading: "Iteration", body: "the read failed" },
  absent: { labelWord: "absent", heading: "Iteration", body: "no compass recorded", pointer: "back to the list" },
};

const renderDetail = (record: IterationDTO | null, generation: number | null = 7): string =>
  renderToStaticMarkup(
    <IterationDetailScreen
      model={iterationDetailModel({ data: record, projection: { ...projection, generation } })}
      copy={detailCopy}
    />,
  );

describe("Iterations list — the facts of §8.2", () => {
  const html = renderList([iteration()], 1);

  test("id, title, lifecycle, compass status and the delivery position", () => {
    for (const expected of ["iter-20261025-frontend-unification", "Frontend unification", "active", "locked"]) {
      expect(html).toContain(expected);
    }
    expect(html).toContain("step 2 of 5");
    expect(html).toContain("1/2 plans");
    expect(html).toContain("2026-10-25 01:10");
  });

  test("an iteration with no compass says so instead of claiming a step", () => {
    const html = renderList([iteration({ compass: null, gateStep: null } as Partial<IterationDTO>)], 1);
    expect(html).toContain("no compass");
    expect(html).toContain('data-ms-iteration-step="none"');
    expect(html).not.toContain("step 0 of 5");
  });

  test("the attribution arm is stated beside the rows", () => {
    expect(renderList([iteration()], 1, "present")).toContain('data-ms-attribution="present"');
    expect(renderList([iteration()], 1, "absent")).toContain('data-ms-attribution="absent"');
  });
});

describe("Iterations list — attribution decides between absent and empty", () => {
  test("an attributing project with no rows is empty", () => {
    const html = renderList([], 0, "present");
    expect(html).toContain('data-ms-absence="empty"');
    expect(html).toContain("this project has none");
  });

  test("a store that attributes no iteration is absent, not empty", () => {
    const html = renderList([], 0, "absent");
    expect(html).toContain('data-ms-absence="absent"');
    expect(html).toContain("not attributed");
    expect(html).not.toContain('data-ms-absence="empty"');
  });

  test("no valid projection is unavailable, carrying the store's message", () => {
    const html = renderList([], 0, "present", null);
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).toContain("no valid generation");
  });
});

describe("Iterations list — NEGATIVE: the removed surfaces", () => {
  const html = renderList([iteration()], 1);

  test("no document inventory and no document count", () => {
    expect(html).not.toContain("Delivery compass");
    expect(html).not.toContain("IA spec");
    expect(html).not.toContain("doc-1");
    expect(html).not.toMatch(/\bdocuments?\b/i);
    expect(html).not.toContain(">2<");
  });

  test("no compass milestone-id list", () => {
    expect(html).not.toContain("9f2c4a10");
    expect(html).not.toContain("3a7b1c22");
  });

  test("no counter from the read envelope", () => {
    for (const counter of ["storeRevision", "catalogRevision", "builtAt", "checkedAt", "2026-10-25T05:00:00.000Z"]) {
      expect(html).not.toContain(counter);
    }
  });
});

describe("IterationDetail — catalog, execution, compass, gate steps, plan table", () => {
  const html = renderDetail(iteration());

  test("catalog identity, execution and the dates", () => {
    for (const expected of ["Frontend unification", "active", "issue-project-move", "2026-10-25 01:10"]) {
      expect(html).toContain(expected);
    }
  });

  test("the compass status and its summary", () => {
    expect(html).toContain("locked");
    expect(html).toContain('data-ms-compass-summary=""');
    expect(html).toContain("one product, two hosts");
  });

  test("an iteration that records no compass summary says so", () => {
    const bare = renderDetail(
      iteration({
        compass: { ...iteration().compass!, summary: null, milestones: [] },
      } as Partial<IterationDTO>),
    );
    expect(bare).toContain("no summary recorded");
    expect(bare).not.toContain('data-ms-compass-summary=""');
  });

  test("the plan table carries each plan's recorded progress or its absent line", () => {
    expect(html).toContain('data-ms-row-key="20261025-unified-ui-shared-layer"');
    expect(html).toContain('data-ms-table="detail"');
    expect(html).toContain("screens are landing");
    expect(html).toContain('data-ms-plan-progress-absent=""');
    expect(html).toContain("records no progress");
  });
});

describe("IterationDetail — the gate display is four labels plus a never-marked fifth", () => {
  const html = renderDetail(iteration());

  test("all five steps render, each with its own label", () => {
    expect(html.match(/data-ms-step="/g)?.length).toBe(5);
    for (const label of ["Start", "Execute", "Close", "PR delivery", "Merge ready"]) {
      expect(html).toContain(label);
    }
  });

  test("exactly one step is marked, and it is the store's step", () => {
    expect(html.match(/data-ms-step-position="current"/g)?.length).toBe(1);
    expect(html).toContain('data-ms-step="execute" data-ms-step-position="current"');
    expect(html).toContain("step 2 of 5");
  });

  test("the step's state rides a class and a glyph, so it is not colour alone", () => {
    // The prototype draws the track as a 3px rule per step and colours it by state class;
    // the class and the glyph are the only non-colour channels, and neither is visible
    // when an iteration records no compass (every step is `ahead`).
    const page = renderDetail(iteration({ gateStep: 2 }));
    expect(page).toContain('class="gate-step is-done"');
    expect(page).toContain('class="gate-step is-current"');
    expect(page).toMatch(/class="gate-step is-done"[^>]*>\s*<span class="glyph"[^>]*>✓/);
    expect(page).toMatch(/class="gate-step is-current"[^>]*>\s*<span class="glyph"[^>]*>●/);
    // and a step ahead of the store's carries neither the class nor a glyph
    expect(page).toMatch(/class="gate-step"[^>]*data-ms-step="merge-ready"[^>]*>\s*<span class="glyph"[^>]*><\/span>/);
  });

  test("step 5 is NEVER marked, at any store value", () => {
    for (const gateStep of [1, 2, 3, 4] as const) {
      const page = renderDetail(iteration({ gateStep } ));
      const marked = page.match(/<li[^>]*data-ms-step="([^"]+)"[^>]*data-ms-step-position="current"/);
      expect(marked?.[1]).toBe(["start", "execute", "close", "pr-delivery"][gateStep - 1] as string);
      expect(marked?.[1]).not.toBe("merge-ready");
      // And the fifth step is always "ahead", never reached.
      expect(page).toContain('data-ms-step="merge-ready" data-ms-step-position="ahead"');
    }
  });

  test("no violation count is rendered (D29: it has no source a view may read)", () => {
    expect(html.toLowerCase()).not.toContain("violation");
    expect(html).not.toMatch(/\b\d+ violations?\b/);
  });

  test("an iteration with no compass marks nothing and never claims step 1", () => {
    const page = renderDetail(iteration({ compass: null, gateStep: null } as Partial<IterationDTO>));
    expect(page.match(/data-ms-step-position="current"/g)).toBeNull();
    expect(page).toContain("Delivery");
    expect(page).not.toContain("step 0 of 5");
    expect(page).not.toContain("step 1 of 5");
  });
});

describe("IterationDetail — NEGATIVE: what §8.1 removed", () => {
  const html = renderDetail(iteration());

  test("no document inventory, no document count", () => {
    expect(html).not.toContain("Delivery compass");
    expect(html).not.toContain("IA spec");
    expect(html).not.toContain("doc-1");
    expect(html).not.toMatch(/\bdocuments?\b/i);
  });

  test("no compass milestone-id list — the roadmap feature owns milestones", () => {
    expect(html).not.toContain("9f2c4a10");
    expect(html).not.toContain("3a7b1c22");
    expect(html).not.toContain("milestones");
  });

  test("no revision counter and no envelope timestamps", () => {
    for (const removed of ["storeRevision", "catalogRevision", "builtAt", "checkedAt", "revision", "2026-10-25T05:00:00.000Z"]) {
      expect(html).not.toContain(removed);
    }
  });

  test("the detail model cannot carry them: the negative set is enforced by shape", () => {
    const model = iterationDetailModel({ data: iteration(), projection });
    if (model.kind !== "populated") throw new Error("expected the detail");
    for (const removed of ["documents", "milestones", "revision", "storeRevision", "catalogRevision", "counters"]) {
      expect(Object.keys(model.value)).not.toContain(removed);
    }
  });
});

describe("IterationDetail — the record read", () => {
  test("a missing record is absent, not unavailable: the iteration declares no compass", () => {
    const html = renderDetail(null);
    expect(html).toContain('data-ms-absence="absent"');
  });

  test("no projection generation is unavailable even with a record", () => {
    const html = renderDetail(iteration(), null);
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).toContain("could not be read");
  });
});
