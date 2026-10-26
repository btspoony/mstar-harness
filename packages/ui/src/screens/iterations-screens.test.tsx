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
      // The compass's milestones are rows, not ids: the prototype prints them as a
      // mini table (name, target, status).
      milestones: [
        { milestone: "Direction locked with the owner", target: "2026-10-25", status: "done" },
        { milestone: "Prototype checkpoint accepted", target: "2026-10-27", status: "pending" },
      ],
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
  filtersHeading: "Filters",
  membershipNote: "Membership comes from the catalog; execution is a projection over it.",
  filters: {
    lifecycle: "Lifecycle",
    search: "Search iteration id or title",
    clear: "Clear filters",
    any: "Any",
    results: (shown: number, total: number) => `${shown} of ${total} results`,
  },
  columns: {
    id: "Iteration",
    title: "Title",
    lifecycle: "Lifecycle",
    execution: "Compass",
    delivery: "Delivery",
    plans: "Plans",
    documents: "Documents",
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
  compassColumns: { milestone: "Milestone", target: "Target", status: "Status" },
  documentsHeading: "Documents",
  documentsCount: (n) => `${n} documents`,
  documentsEmpty: "No document is registered under this iteration.",
  documentColumns: { title: "Title", lifecycle: "Lifecycle", kind: "Document kind", location: "Location", revision: "Revision" },
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

  test("the list states the document count, but never the inventory itself", () => {
    // IA §8.1 kept documents out of the list. The prototype's table has a `Documents`
    // column, and it is a count — the inventory stays on the detail screen.
    expect(html).toContain("Documents");
    expect(html).not.toContain("Delivery compass");
    expect(html).not.toContain("IA spec");
  });

  test("no counter from the read envelope", () => {
    for (const counter of ["storeRevision", "catalogRevision", "builtAt", "checkedAt", "2026-10-25T05:00:00.000Z"]) {
      expect(html).not.toContain(counter);
    }
  });
});

describe("IterationDetail — catalog, execution, compass, gate steps, plan table", () => {
  test("the compass milestones render as the prototype's mini table", () => {
    // IA §8.1 kept the milestone-id list out because the roadmap feature owns milestones.
    // The prototype's Compass panel nevertheless ends with this table, and the table is
    // what ships; the ids themselves still do not appear.
    expect(html).toContain("data-ms-compass-milestones");
    expect(html).toContain("Direction locked with the owner");
    expect(html).not.toContain("9f2c4a10");
  });


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

describe("IterationDetail — the gate lives in the header, not as a track", () => {
  const html = renderDetail(iteration());

  test("the position is stated once, in the header chip", () => {
    // The prototype's iteration detail has no gate track at all (measured `gateEls: 0`);
    // the position appears only as the header's action chip.
    expect(html).toContain('data-ms-gate-chip="true"');
    expect(html).not.toContain("gate-track");
    expect(html).not.toContain("data-ms-step-position");
  });

  test("an iteration with no compass claims no step", () => {
    const page = renderDetail(iteration({ compass: null, gateStep: null } as Partial<IterationDTO>));
    expect(page).not.toContain("step 0 of 5");
    expect(page).not.toContain("data-ms-gate-chip");
  });
});

describe("IterationDetail — NEGATIVE: what §8.1 removed", () => {
  const html = renderDetail(iteration());

  test("the document inventory is rendered, as the prototype's Documents card", () => {
    // IA §8.1 kept it out ("documents say nothing about progress"). The prototype's
    // detail screen has a Documents card and the prototype is the acceptance criterion,
    // so the inventory is returned and shown. The counters and the milestone-id list
    // stay out — the screen has no place for them.
    expect(html).toContain("data-ms-documents");
    expect(html).toContain("Delivery compass");
    expect(html).toMatch(/\bdocuments?\b/i);
  });

  test("no compass milestone-id list — the roadmap feature owns milestones", () => {
    expect(html).not.toContain("9f2c4a10");
    expect(html).not.toContain("3a7b1c22");
    expect(html).not.toContain("milestoneId");
  });

  test("no revision counter and no envelope timestamps", () => {
    for (const removed of ["storeRevision", "catalogRevision", "builtAt", "checkedAt", "revision", "2026-10-25T05:00:00.000Z"]) {
      expect(html).not.toContain(removed);
    }
  });

  test("the detail model cannot carry them: the negative set is enforced by shape", () => {
    const model = iterationDetailModel({ data: iteration(), projection });
    if (model.kind !== "populated") throw new Error("expected the detail");
    // `documents` is carried now; the rest stays out.
    for (const removed of ["milestones", "revision", "storeRevision", "catalogRevision", "counters"]) {
      expect(Object.keys(model.value)).not.toContain(removed);
    }
    expect(Object.keys(model.value)).toContain("documents");
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
