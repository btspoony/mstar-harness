/**
 * `Workflows` and `WorkflowDetail`.
 *
 * Two things this file exists to hold:
 *
 *  1. the truncation disclosure is computed from the store's `total`, never from
 *     the page length — a regression the engine just spent a round fixing;
 *  2. the removed workflow surfaces stay removed: leases, terminal-adoption audit
 *     rows and catalog-pin badges are still on the DTO, and §8.1 removes only the
 *     drawing. A test that fails when one is re-added is the guard.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDTO, WorkflowListDTO } from "@mstar-harness/engine";

import { workflowDetailModel, workflowListModel } from "../view-model/workflows.ts";
import { Workflows, type WorkflowsCopy } from "./Workflows.tsx";
import { WorkflowDetail as WorkflowDetailScreen, type WorkflowDetailCopy } from "./WorkflowDetail.tsx";

const projection = {
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

const catalogEntry = (over: Record<string, unknown> = {}): NonNullable<WorkflowDTO["catalog"]> => ({
  kind: "plan" as const,
  id: "20261025-unified-ui-shared-layer",
  title: "Unified UI shared layer",
  description: null,
  rootKind: "plans",
  relativePath: "20261025-unified-ui-shared-layer.md",
  documentKind: "plan",
  lifecycle: "active" as const,
  revision: 3,
  registeredAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  ...over,
}) as NonNullable<WorkflowDTO["catalog"]>;

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
  catalog: catalogEntry(),
  plans: [
    {
      workflowId: "issue-project-move",
      planId: "20261025-unified-ui-shared-layer",
      status: "InProgress",
      progress: "primitives are landing",
      phase: "implement",
      doneAt: null,
      catalogPinRevision: 2,
      catalog: catalogEntry(),
      leases: [
        {
          workflowId: "issue-project-move",
          planId: "20261025-unified-ui-shared-layer",
          kind: "execution",
          holder: "frontend-dev",
          worktreePath: "/tmp/wt-secret",
          expiresAt: "2026-10-26T00:00:00.000Z",
        },
      ],
      badges: ["catalog-pin-missing"],
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
  badges: ["catalog-missing"],
  ...over,
});

const workflowsCopy: WorkflowsCopy = {
  pageTitle: "Workflows",
  tableCaption: "Workflows",
  columns: { id: "ID", title: "Title", status: "Status", root: "Root", updated: "Updated", plans: "Plans" },
  plansProgress: (done, total) => `${done}/${total} plans`,
  filtersHeading: "Filters",
  filters: {
    status: "Status",
    type: "Type",
    search: "Search workflow id or title",
    clear: "Clear filters",
    any: "Any",
    results: (shown, total) => `${shown} of ${total} results`,
  },
  truncated: (shown, total) => `showing ${shown} of ${total}`,
  noCatalogTitle: "no catalog row",
  noRoot: "—",
  executionUnavailable: "execution unavailable",
  empty: { labelWord: "empty", heading: "No workflows", body: "nothing is registered", hint: "start one" },
  unavailable: { labelWord: "unavailable", heading: "Workflows", body: "the read failed" },
  absent: { labelWord: "n/a", heading: "Workflows", body: "not declared", pointer: "see the project" },
};

const renderList = (
  items: WorkflowDTO[],
  total: number,
  generation: number | null = 7,
): string =>
  renderToStaticMarkup(
    <Workflows
      model={workflowListModel({ data: { items, total } as WorkflowListDTO, projection: { ...projection, generation } })}
      copy={workflowsCopy}
    />,
  );

const detailCopy: WorkflowDetailCopy = {
  chainBase: "Base",
  chainSource: "Source",
  chainIntegration: "Integration",
  chainTarget: "Target",
  breadcrumb: { label: "Breadcrumb", current: "Workflows" },
  executionHeading: "Execution",
  planTableHeading: "Plans",
  catalogHeading: "Catalog",
  fields: {
    id: "ID",
    type: "Type",
    status: "Status",
    phase: "Phase",
    startedAt: "Started",
    endedAt: "Ended",
    updatedAt: "Updated",
    branchBase: "Branch base",
    branchSource: "Branch source",
    branchIntegration: "Branch integration",
    branchTarget: "Branch target",
    root: "Root",
    title: "Title",
    lifecycle: "Lifecycle",
    documentKind: "Document kind",
    notStarted: "not started",
    noCatalog: "no catalog row",
  },
  planColumns: { planId: "Plan", title: "Title", status: "Status", progress: "Progress", doneAt: "Done" },
  planProgressAbsent: "records no progress",
  executionUnavailableLead: "Execution unavailable",
  absence: {
    "not-applicable": { labelWord: "n/a", heading: "Workflow", body: "no project resolves" },
    absent: { labelWord: "not declared", heading: "Workflow", body: "no such workflow here", pointer: "see the list" },
    empty: { labelWord: "empty", heading: "Workflow", body: "nothing recorded yet", hint: "start one" },
    unavailable: { labelWord: "unavailable", heading: "Workflow", body: "the read failed" },
  },
};

const renderDetail = (record: WorkflowDTO | null, generation: number | null = 7): string =>
  renderToStaticMarkup(
    <WorkflowDetailScreen
      model={workflowDetailModel({ data: record, projection: { ...projection, generation } })}
      copy={detailCopy}
    />,
  );

describe("Workflows list — the facts of §8.2", () => {
  const html = renderList([workflow()], 1);

  test("id, catalog title, status · phase, root-register fact and projected updated", () => {
    expect(html).toContain("issue-project-move");
    expect(html).toContain("Unified UI shared layer");
    expect(html).toContain("running");
    expect(html).toContain("phase-2-execute");
    expect(html).toContain("plans:20261025-unified-ui-shared-layer.md");
    expect(html).toContain("2026-10-25 05:00");
    expect(html).toContain("1/2 plans");
  });

  test("a row with no catalog entry says so instead of inventing a title", () => {
    const orphan = renderList([workflow({ catalog: null })], 1);
    expect(orphan).toContain("no catalog row");
    expect(orphan).not.toContain("Unified UI shared layer");
  });
});

describe("Workflows list — the truncation disclosure comes from `total`", () => {
  test("a truncated page discloses the store's total, not its own length", () => {
    const html = renderList([workflow()], 50);
    expect(html).toContain('data-ms-truncated="50"');
    expect(html).toContain("showing 1 of 50");
    // The engine just restored `total`; a page that echoed its own length here
    // would read "showing 1 of 1" and hide the truncation entirely.
    expect(html).not.toContain("showing 1 of 1");
  });

  test("a complete page discloses nothing", () => {
    const html = renderList([workflow()], 1);
    expect(html).not.toContain("data-ms-truncated");
    expect(html).not.toContain("showing");
  });

  test("more rows than total is not called truncation", () => {
    // Defensive: the disclosure compares numbers, it does not count rows.
    const model = workflowListModel({
      data: { items: [workflow()], total: 1 } as WorkflowListDTO,
      projection,
    });
    expect(model.truncated).toBe(false);
    expect(model.total).toBe(1);
    expect(model.shown).toBe(1);
  });
});

describe("Workflows list — the state machine", () => {
  test("no valid projection is unavailable, and the store's message is carried", () => {
    const html = renderList([], 0, null);
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).toContain("no valid generation");
  });

  test("an empty store is empty, with its own copy", () => {
    const html = renderList([], 0);
    expect(html).toContain('data-ms-absence="empty"');
    expect(html).toContain("nothing is registered");
  });
});

describe("Workflows list — the join bookkeeping it now surfaces, and the rest it does not", () => {
  const html = renderList([workflow()], 1);

  test("the catalog-pin badges are rendered, as the prototype's Join badges column", () => {
    // IA §8.1 used to keep these out of the view. The prototype shows them as a column
    // (`Join badges`), and that column is the acceptance criterion for this interface —
    // so the badges travel with the row and the word is always spelled out, never a
    // colour-only chip. Leases and adoption rows stay out; they are not rows a reader
    // acts on.
    for (const badge of ["catalog-missing", "catalog-pin-missing", "catalog-pin-conflict"]) {
      expect(renderList([workflow({ badges: [badge] })], 1)).toContain(badge);
    }
  });

  test("no lease field reaches the row", () => {
    expect(html).not.toContain("/tmp/wt-secret");
    expect(html).not.toContain("frontend-dev");
    expect(html).not.toContain("execution");
  });

  test("leases and adoption rows stay out of the row: the negative set is shape-enforced", () => {
    const model = workflowListModel({ data: { items: [workflow()], total: 1 } as WorkflowListDTO, projection });
    if (model.rows.kind !== "populated") throw new Error("expected rows");
    // `badges` is now carried — the Join badges column needs it. The rest stays out:
    // leases are checkout bookkeeping and adoption rows are history, neither of which a
    // list row acts on.
    for (const removed of ["leases", "terminalUnregistered", "terminalAdoptions", "plans"]) {
      expect(Object.keys(model.rows.value[0] ?? {})).not.toContain(removed);
    }
    expect(Object.keys(model.rows.value[0] ?? {})).toContain("badges");
  });

  test("execution-unavailable survives as a reason, not as a chip", () => {
    const degraded = renderList([workflow({ badges: ["execution-unavailable"] })], 1);
    expect(degraded).toContain("execution project");
    expect(degraded).toContain('role="status"');
  });
});

describe("WorkflowDetail — execution, anchors, catalog and the plan table", () => {
  const html = renderDetail(workflow());

  test("the execution facts and all three dates", () => {
    for (const expected of ["plan", "running", "phase-2-execute", "2026-10-25 01:00", "2026-10-25 05:00"]) {
      expect(html).toContain(expected);
    }
  });

  test("the four branch anchors are rendered as a chain and as fields", () => {
    expect(html).toContain('data-ms-branch-chain=""');
    // The chain is segmented: an anchor per label, an arrow between them.
    expect((html.match(/class="branch-anchor"/g) ?? []).length).toBe(4);
    expect((html.match(/class="branch-arrow"/g) ?? []).length).toBe(3);
    expect(html).toContain('<span class="branch-anchor"><span>Base</span> <b>main</b></span>');
    for (const label of ["Branch base", "Branch source", "Branch integration", "Branch target"]) {
      expect(html).toContain(label);
    }
  });

  test("the catalog identity is one cell with the root-register fact", () => {
    expect(html).toContain("plans:20261025-unified-ui-shared-layer.md");
    expect(html).toContain("active");
  });

  test("the plan table carries planId, title, status · phase, progress and done date", () => {
    // The plan table is `DataTable variant="detail"`, so rows carry the shared
    // table's row hook rather than a private one.
    expect(html).toContain('data-ms-row-key="20261025-unified-ui-shared-layer"');
    expect(html).toContain('data-ms-table="detail"');
    expect(html).toContain('data-ms-plan-progress=""');
    expect(html).toContain("primitives are landing");
    expect(html).toContain("2026-10-19T01:12:00.000Z");
  });

  test("the progress column is the RECORDED note, and says so when there is none", () => {
    // The second plan records no progress: it gets its own absent line, never a
    // derived step and never the banned "first uncompleted step" phrasing.
    expect(html).toContain('data-ms-plan-progress-absent=""');
    expect(html).toContain("records no progress");
    expect(html.toLowerCase()).not.toContain("first uncompleted");
    expect(html.toLowerCase()).not.toContain("next step");
  });
});

describe("WorkflowDetail — NEGATIVE: leases, adoption audit, pin badges", () => {
  const html = renderDetail(workflow());

  test("no lease kind, holder, worktree or expiry", () => {
    expect(html).not.toContain("/tmp/wt-secret");
    expect(html).not.toContain("worktreePath");
    expect(html).not.toContain("2026-10-26T00:00:00.000Z");
    expect(html).not.toContain("holder");
  });

  test("no terminal-adoption audit row", () => {
    for (const removed of ["lifecycle_adopted_at", "adopt_reason", "actor_session_id", "operation_id", "terminalAdoptions"]) {
      expect(html).not.toContain(removed);
    }
  });

  test("no catalog-pin badge", () => {
    for (const badge of ["catalog-missing", "catalog-pin-missing", "catalog-pin-conflict"]) {
      expect(html).not.toContain(badge);
    }
    expect(html).not.toContain("catalogPinRevision");
  });

  test("execution-unavailable is stated as the reason where it applies", () => {
    const degraded = renderDetail(workflow({ badges: ["execution-unavailable"] }));
    expect(degraded).toContain("Execution unavailable");
    expect(degraded).toContain("execution project");
  });

  test("the detail model cannot carry them: the negative set is enforced by shape", () => {
    const model = workflowDetailModel({ data: workflow(), projection });
    if (model.kind !== "populated") throw new Error("expected the detail");
    for (const removed of ["leases", "terminalUnregistered", "terminalAdoptions", "badges", "pin"]) {
      expect(Object.keys(model.value)).not.toContain(removed);
    }
    expect(Object.keys(model.value.workflow)).not.toContain("leases");
  });
});

describe("WorkflowDetail — the record read: null is absent, a failed read is unavailable", () => {
  test("a null record is the absent arm — with absent copy, not unavailable copy", () => {
    const html = renderDetail(null);
    expect(html).toContain('data-ms-absence="absent"');
    expect(html).not.toContain('data-ms-absence="unavailable"');
    // The attribute being right while the copy is wrong is exactly how this
    // regression stayed green: assert the words a reader sees.
    expect(html).toContain('data-ms-label-word="">not declared<');
    expect(html).toContain("no such workflow here");
    expect(html).toContain("see the list");
    expect(html).not.toContain('data-ms-label-word="">unavailable<');
    expect(html).not.toContain("the read failed");
  });

  test("a failed read is unavailable and states the reason", () => {
    const html = renderDetail(workflow(), null);
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).toContain("could not be read");
  });
});
