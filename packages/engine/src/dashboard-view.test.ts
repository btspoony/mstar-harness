/**
 * Dashboard view layer — the generic request half of the dashboard read
 * transport (view → validated filters → one `withStoreRead` envelope).
 *
 * This suite pins the refusals the CLI transport asserted before the layer
 * moved here, so a second transport (the dsh panel) inherits exactly one
 * validation implementation. Every case runs the layer against the real store
 * boundary; nothing is mocked.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { MAX_DASHBOARD_SEARCH_LENGTH, dashboardFailure, dashboardFilters, readDashboardView } from "./dashboard-view.js";
import { catalogRootDir, linkCatalogEntities, registerCatalogEntity } from "./catalog.js";
import { createExecutionWorkflow, readExecutionState } from "./execution-store.js";
import { captureIssue, getIssue } from "./issue.js";
import { addMilestone } from "./milestone-store.js";
import { initializeStore, openStore } from "./store-db.js";
import { queryDashboard, withStoreRead } from "./store-read.js";
import type { CatalogEntityInput, CatalogOperation } from "./catalog.js";
import type { IssueDetail } from "./issue.js";
import type { MilestoneRead } from "./milestone-store.js";
import type { StoreContext } from "./store-db.js";
import type {
  DashboardView,
  DashboardViewData,
  IterationDTO,
  IterationGateStep,
  IterationListDTO,
  OverviewDTO,
  OverviewMember,
  ReadEnvelope,
} from "./store-read.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-dashboard-view-"));
const RECORDED_AT = "2026-10-22T00:00:00.000Z";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

async function workspace(name: string): Promise<StoreContext> {
  const harness = join(mkdtempSync(join(ROOT, name)), ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: harness };
  const handle = await initializeStore(context);
  handle.close();
  return context;
}

describe("dashboardFilters refusals", () => {
  test("refuses an unknown view", () => {
    expect(() => dashboardFilters("not-a-view" as DashboardView)).toThrow(/unknown dashboard view "not-a-view"/);
  });

  test("refuses an unsupported query field per view", () => {
    expect(() => dashboardFilters("projects", { limit: "2" })).toThrow(/"limit" is not a supported projects query parameter/);
    expect(() => dashboardFilters("roadmap", { disposition: "open" })).toThrow(
      /"disposition" is not a supported roadmap query parameter/,
    );
  });

  test("refuses a limit outside 1-200 and a non-numeric limit", () => {
    expect(() => dashboardFilters("issues", { limit: "201" })).toThrow(/limit must be an integer between 1 and 200/);
    expect(() => dashboardFilters("issues", { limit: "0" })).toThrow(/limit must be an integer between 1 and 200/);
    expect(() => dashboardFilters("issues", { limit: "1.5" })).toThrow(/limit must be a nonnegative integer/);
    expect(() => dashboardFilters("issues", { offset: "-1" })).toThrow(/offset must be a nonnegative integer/);
  });

  test("accepts a search of exactly the maximum length and refuses one character more", () => {
    expect(MAX_DASHBOARD_SEARCH_LENGTH).toBe(200);
    expect(dashboardFilters("issues", { q: "x".repeat(MAX_DASHBOARD_SEARCH_LENGTH) })).toEqual({
      issue: { query: "x".repeat(MAX_DASHBOARD_SEARCH_LENGTH) },
    });
    expect(() => dashboardFilters("issues", { q: "x".repeat(MAX_DASHBOARD_SEARCH_LENGTH + 1) })).toThrow(
      /q must be at most 200 characters/,
    );
  });

  test("refuses an id that could not be a catalog id", () => {
    for (const unsafe of ["", ".", "..", "/", "\\", "a/b", "a\\b", "a\u0000b"]) {
      expect(() => dashboardFilters("issue-detail", {}, unsafe)).toThrow(/id must be a single safe id/);
    }
    // An empty query value is "not supplied" (queryValue), not an unsafe id.
    for (const unsafe of [".", "..", "/", "\\", "a/b", "a\\b", "a\u0000b"]) {
      expect(() => dashboardFilters("issues", { project: unsafe })).toThrow(/project must be a single safe id/);
    }
  });

  test("refuses the roadmap view without a project", () => {
    expect(() => dashboardFilters("roadmap")).toThrow(/the roadmap view requires a project query parameter/);
  });

  test("refuses a detail view without an id", () => {
    for (const view of ["issue-detail", "workflow-detail", "iteration-detail"] as const) {
      expect(() => dashboardFilters(view)).toThrow(new RegExp(`the ${view} route requires an id`));
    }
  });

  test("maps raw query parameters onto the engine's filter shape", () => {
    expect(dashboardFilters("issues")).toEqual({ issue: {} });
    expect(
      dashboardFilters("issues", { project: "proj-a", disposition: "open", kind: "bug", severity: "high", q: "race", limit: "10", offset: "5" }),
    ).toEqual({ issue: { projectId: "proj-a", disposition: "open", kind: "bug", severity: "high", query: "race", limit: 10, offset: 5 } });
    expect(dashboardFilters("roadmap", { project: "proj-a" })).toEqual({ projectId: "proj-a" });
    expect(dashboardFilters("iteration-detail", {}, "iter-read")).toEqual({ id: "iter-read" });
  });
});

describe("readDashboardView over a real store", () => {
  test("answers a detail view with the store read boundary's envelope", async () => {
    const context = await workspace("detail-");
    await captureIssue(
      context,
      {
        projectId: "proj-a",
        title: "detail row",
        severity: "low",
        kind: "bug",
        impact: "A second transport reads this row through the shared layer",
        acceptance: "The shared layer answers the detail envelope",
        sourceIdentity: "detail row",
        rootCauseKey: "detail row",
        acceptanceKey: "detail row",
        occurrenceKey: "detail row",
        sourceKind: "test",
        location: "dashboard-view.test.ts",
        observedBehavior: "detail row",
        evidence: ["isolated fixture"],
        discoveredAt: RECORDED_AT,
      },
      { actor: "project-manager", operationId: "capture-detail-row" },
    );

    // The declared contract: one envelope carrying the store's own DTO.
    const envelope: ReadEnvelope<DashboardViewData[DashboardView]> = await readDashboardView({
      context,
      view: "issue-detail",
      id: "I-000001",
    });
    const detail: IssueDetail = envelope.data as IssueDetail;
    expect(detail).toEqual(await getIssue(context, "I-000001"));
    expect(typeof envelope.storeRevision).toBe("number");
    expect(envelope.catalogRevision).toBe(0);
  });

  test("surfaces a store refusal through dashboardFailure", async () => {
    const harness = join(mkdtempSync(join(ROOT, "uninitialized-")), ".mstar");
    const failure = await readDashboardView({ context: { harnessDir: harness }, view: "issues" }).catch((error: unknown) => error);
    expect(dashboardFailure(failure)).toMatchObject({ code: "store.not-initialized" });
  });
});

describe("overview read-model contract", () => {
  test("overview is a registered view that refreshes the projection and reads only `project`", () => {
    const query = queryDashboard("overview");
    expect(query.view).toBe("overview");
    // It joins projected workflow/plan/compass rows with non-projected issue
    // and milestone tables, so it takes the same refresh `workflows` does.
    expect(query.needsProjection).toBe(true);
    expect(dashboardFilters("overview", { project: "proj-a" })).toEqual({ projectId: "proj-a" });
    for (const field of ["limit", "offset", "severity", "disposition", "kind", "q"]) {
      expect(() => dashboardFilters("overview", { [field]: "1" })).toThrow(
        new RegExp(`"${field}" is not a supported overview query parameter`),
      );
    }
  });

  test("an unknown view name is still refused by both halves", () => {
    expect(() => dashboardFilters("not-a-view" as DashboardView)).toThrow(/unknown dashboard view "not-a-view"/);
    expect(() => queryDashboard("not-a-view" as DashboardView)).toThrow(/unknown dashboard view "not-a-view"/);
  });

  test("the aggregated DTO is the five wrapped members the type contract fixes", () => {
    const overview = {
      workflows: { state: "read", data: { items: [], total: 0 } },
      residuals: { state: "read", data: { open: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 } } },
      milestones: { state: "not-applicable", reason: "no project resolves for this read" },
      latestIteration: { state: "read", data: null },
      issueFlow: { state: "unavailable", reason: "the store answered with an error" },
    } satisfies OverviewDTO;
    // The type contract only: the arms are named here, and the live reads below
    // are what pin the behaviour each member answers with.
    expect(Object.keys(overview)).toEqual(["workflows", "residuals", "milestones", "latestIteration", "issueFlow"]);
    expect(overview.milestones.state).toBe("not-applicable");
    const declared: DashboardViewData["overview"] = overview;
    expect(declared.issueFlow).toEqual({ state: "unavailable", reason: "the store answered with an error" });
  });

  test("a live iterations read carries the attribution disclosure and the gate step", async () => {
    const context = await workspace("overview-contract-");
    const empty = await readDashboardView({ context, view: "iterations" });
    // No `belongs-to` link from any iteration: a project's silence has no source.
    expect(empty.data as IterationListDTO).toEqual({ items: [], total: 0, attribution: "absent" });

    await registerCatalogEntity(
      context,
      { kind: "iteration", id: "iter-contract", title: "Iteration contract", rootKind: "iterations", relativePath: "iter-contract" },
      { actor: "project-manager", operationId: "register-iteration-contract" },
    );
    const detail = await readDashboardView({ context, view: "iteration-detail", id: "iter-contract" });
    // A catalog-only iteration records no compass, so the step is the absent-arm null.
    expect((detail.data as IterationDTO).gateStep).toBeNull();
    const listed = await readDashboardView({ context, view: "iterations" });
    expect((listed.data as IterationListDTO).items[0]?.gateStep).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Overview fixture: catalog rows, compass documents, projected workflows
// ---------------------------------------------------------------------------

const STARTED_AT = "2026-09-18T00:00:00.000Z";

/**
 * One iteration per store-provable gate step (spec §3): the compass status and
 * the iteration's plan execution status are the only inputs. `iter-done` is the
 * pinned interpretation of the overlapping rows — a `completed` compass answers
 * step 4 even while a plan row is not `Done` (close writes `completed`; a stale
 * plan row cannot un-close it). `iter-none` answers `null` and has no compass.
 */
const GATE_CASES: ReadonlyArray<{
  iterationId: string;
  status: string;
  startDate: string;
  endDate?: string;
  planStatus: string;
  gateStep: IterationGateStep;
}> = [
  { iterationId: "iter-open", status: "active", startDate: "2026-09-01", planStatus: "Todo", gateStep: 1 },
  { iterationId: "iter-flight", status: "locked", startDate: "2026-09-20", planStatus: "InProgress", gateStep: 2 },
  { iterationId: "iter-close", status: "locked", startDate: "2026-09-10", planStatus: "Done", gateStep: 3 },
  { iterationId: "iter-done", status: "completed", startDate: "2026-09-05", endDate: "2026-09-25", planStatus: "InProgress", gateStep: 4 },
];

function operation(operationId: string): CatalogOperation {
  return { actor: "project-manager", operationId };
}

function compassDoc(entry: { iterationId: string; status: string; startDate: string; endDate?: string }): string {
  return [
    "---",
    `iteration_id: ${entry.iterationId}`,
    `start_date: ${entry.startDate}`,
    `status: ${entry.status}`,
    ...(entry.endDate === undefined ? [] : [`end_date: ${entry.endDate}`]),
    "iteration_base_branch: main",
    "target_branch: main",
    "plans: []",
    "---",
    "",
    `# ${entry.iterationId} delivery compass`,
    "",
    "The store is the one read authority.",
    "",
  ].join("\n");
}

function readMember<T>(member: OverviewMember<T>): T {
  if (member.state !== "read") throw new Error(`expected a read member, received ${member.state}: ${member.reason}`);
  return member.data;
}

async function storeRevision(context: StoreContext): Promise<number> {
  const handle = await openStore(context, "read");
  try {
    return (handle.db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision;
  } finally {
    handle.close();
  }
}

/** One plan workflow per gate case: the plan row's workflow id is the plan id. */
async function createPlanWorkflow(context: StoreContext, planId: string, planStatus: string): Promise<void> {
  const initialized = await readExecutionState(context);
  await createExecutionWorkflow(
    { harnessDir: context.harnessDir, caller: { sessionId: "dashboard-view-fixture", role: "coordinator", workflowId: planId } },
    {
      entry: { id: planId, type: "plan", started_at: STARTED_AT, dir: `workflows/${planId}` },
      snapshot: {
        schema_version: 1,
        id: planId,
        type: "plan",
        status: "running",
        started_at: STARTED_AT,
        updated_at: STARTED_AT,
        phase: "phase-2-execute",
        branch: { base: "main", source: `feature/${planId}`, target: "main" },
        plans: [{ id: planId, title: planId, file: `plans/${planId}.md`, status: planStatus }],
        delivery_kind: "development",
      } as never,
      expected: initialized.token,
      operationId: `create-${planId}`,
    },
  );
}

/**
 * A store with one project, four compass-bearing iterations (one per gate step)
 * plus a compass-less one, one active plan workflow per iteration, a milestone
 * and issues across three of the five severities.
 */
async function scopedOverviewWorkspace(name: string): Promise<StoreContext> {
  const context = await workspace(name);
  const register = async (input: CatalogEntityInput): Promise<void> => {
    await registerCatalogEntity(context, input, operation(`register-${input.kind}-${input.id}`));
  };

  await register({ kind: "project", id: "proj-a", title: "Project A", rootKind: "projects", relativePath: "proj-a" });
  await register({ kind: "iteration", id: "iter-none", title: "Iteration without compass", rootKind: "iterations", relativePath: "iter-none" });

  for (const entry of GATE_CASES) {
    await register({ kind: "iteration", id: entry.iterationId, title: entry.iterationId, rootKind: "iterations", relativePath: entry.iterationId });
    await linkCatalogEntities(
      context,
      { from: { kind: "iteration", id: entry.iterationId }, relation: "belongs-to", to: { kind: "project", id: "proj-a" } },
      operation(`link-${entry.iterationId}-project`),
    );
    await register({
      kind: "document",
      id: `doc-${entry.iterationId}`,
      title: `${entry.iterationId} compass`,
      rootKind: "iterations",
      relativePath: `${entry.iterationId}/delivery-compass.md`,
      documentKind: "compass",
    });
    await linkCatalogEntities(
      context,
      { from: { kind: "iteration", id: entry.iterationId }, relation: "documents", to: { kind: "document", id: `doc-${entry.iterationId}` } },
      operation(`link-doc-${entry.iterationId}`),
    );
    const planId = `p-${entry.iterationId}`;
    await register({ kind: "plan", id: planId, title: planId, rootKind: "plans", relativePath: `${planId}.md` });
    await linkCatalogEntities(
      context,
      { from: { kind: "plan", id: planId }, relation: "belongs-to", to: { kind: "iteration", id: entry.iterationId } },
      operation(`link-${planId}-iteration`),
    );
    await createPlanWorkflow(context, planId, entry.planStatus);
    mkdirSync(join(catalogRootDir(context, "iterations"), entry.iterationId), { recursive: true });
    writeFileSync(
      join(catalogRootDir(context, "iterations"), entry.iterationId, "delivery-compass.md"),
      compassDoc(entry),
    );
  }

  // A locked iteration with a compass and ZERO plan links: the normal gap
  // between Phase 1 and the first plan `belongs-to` link. It proves Start, not
  // Close — `plans.every(...)` would be vacuously true here (qc1/qc3 F-002).
  await register({ kind: "iteration", id: "iter-no-plan", title: "Locked, no plans", rootKind: "iterations", relativePath: "iter-no-plan" });
  await linkCatalogEntities(
    context,
    { from: { kind: "iteration", id: "iter-no-plan" }, relation: "belongs-to", to: { kind: "project", id: "proj-a" } },
    operation("link-iter-no-plan-project"),
  );
  await register({
    kind: "document",
    id: "doc-iter-no-plan",
    title: "iter-no-plan compass",
    rootKind: "iterations",
    relativePath: "iter-no-plan/delivery-compass.md",
    documentKind: "compass",
  });
  await linkCatalogEntities(
    context,
    { from: { kind: "iteration", id: "iter-no-plan" }, relation: "documents", to: { kind: "document", id: "doc-iter-no-plan" } },
    operation("link-doc-iter-no-plan"),
  );
  mkdirSync(join(catalogRootDir(context, "iterations"), "iter-no-plan"), { recursive: true });
  writeFileSync(
    join(catalogRootDir(context, "iterations"), "iter-no-plan", "delivery-compass.md"),
    compassDoc({ iterationId: "iter-no-plan", status: "locked", startDate: "2026-08-20" }),
  );

  await addMilestone(
    context,
    { projectId: "proj-a", name: "Read boundary", target: "2026-09-30", ordinal: 0 },
    { operationId: "add-milestone-read-boundary", expectedStoreRevision: await storeRevision(context) },
  );

  for (const [id, severity] of [
    ["I-critical-1", "critical"],
    ["I-critical-2", "critical"],
    ["I-high-1", "high"],
    ["I-nit-1", "nit"],
    ["I-nit-2", "nit"],
    ["I-nit-3", "nit"],
  ] as const) {
    await captureIssue(
      context,
      {
        projectId: "proj-a",
        title: `Residual ${id}`,
        severity,
        kind: "bug",
        impact: "The overview residual count must reconcile against the issue list",
        acceptance: "Every severity literal is present, zero included",
        sourceIdentity: id,
        rootCauseKey: id,
        acceptanceKey: id,
        occurrenceKey: id,
        sourceKind: "test",
        location: "dashboard-view.test.ts",
        observedBehavior: `Residual ${id}`,
        evidence: ["isolated fixture"],
        discoveredAt: RECORDED_AT,
      },
      { actor: "project-manager", operationId: `capture-${id}` },
    );
  }
  return context;
}

let scopedContext: Promise<StoreContext> | undefined;

/** One store shared by the read-only assertions below (the fixture is expensive). */
function scopedOverview(): Promise<StoreContext> {
  return (scopedContext ??= scopedOverviewWorkspace("overview-scoped-"));
}

describe("overview read model", () => {
  test("every member answers from one store read", async () => {
    const context = await scopedOverview();
    const envelope = await readDashboardView({ context, view: "overview", params: { project: "proj-a" } });
    const overview = envelope.data as OverviewDTO;

    // Active-registered workflows with their plans: several of them, one per
    // gate-case plan workflow, all of them registry members.
    const workflows = readMember(overview.workflows);
    expect(workflows.items.map((item) => item.id).sort()).toEqual([
      "p-iter-close",
      "p-iter-done",
      "p-iter-flight",
      "p-iter-open",
    ]);
    expect(workflows.items.every((item) => item.activeRegistration)).toBe(true);
    // `total` is the reader's unpaged count: the contract's truncation disclosure.
    expect(workflows.total).toBe(4);

    // Residuals: all five severity literals, the two empty ones as 0, and
    // `open` equals their sum (D20: the total is never a second query).
    expect(overview.residuals).toEqual({
      state: "read",
      data: { open: 6, bySeverity: { critical: 2, high: 1, medium: 0, low: 0, nit: 3 } },
    });

    // Milestones: the resolved project's grouping, populated.
    const milestones: MilestoneRead = readMember(overview.milestones);
    expect(milestones.projectId).toBe("proj-a");
    expect(milestones.milestones.map((milestone) => milestone.name)).toEqual(["Read boundary"]);

    // Latest iteration: the newest compass start date inside the project, and
    // it reuses IterationDTO, so the gate step travels with it.
    const latest = readMember(overview.latestIteration);
    expect(latest?.iterationId).toBe("iter-flight");
    expect(latest?.gateStep).toBe(2);

    // Issue flow: the project-scoped series reconciles with the open total.
    expect(readMember(overview.issueFlow).currentOpen).toBe(6);

    // One envelope, one revision: every member came from the same read.
    expect(typeof envelope.storeRevision).toBe("number");
  });

  test("gateStep follows the store-provable mapping and attribution discloses its source", async () => {
    const context = await scopedOverview();
    const listed = await readDashboardView({ context, view: "iterations" });
    const list = listed.data as IterationListDTO;
    const byIteration = Object.fromEntries(list.items.map((item) => [item.iterationId, item.gateStep]));
    expect(byIteration).toEqual({
      "iter-close": 3,
      "iter-done": 4,
      "iter-flight": 2,
      // Locked compass with zero plan links: Close is not proven (qc1/qc3 F-002).
      "iter-no-plan": 2,
      "iter-none": null,
      "iter-open": 1,
    });
    expect(list.attribution).toBe("present");
  });

  test("without a project the two project-scoped members answer not-applicable only", async () => {
    const context = await workspace("overview-unscoped-");
    await registerCatalogEntity(
      context,
      { kind: "iteration", id: "iter-loose", title: "Loose iteration", rootKind: "iterations", relativePath: "iter-loose" },
      operation("register-iter-loose"),
    );

    const overview = (await readDashboardView({ context, view: "overview" })).data as OverviewDTO;
    expect(overview.milestones).toEqual({ state: "not-applicable", reason: "no project resolves for this read" });
    expect(overview.latestIteration).toEqual({ state: "not-applicable", reason: "no project resolves for this read" });
    // The store-wide members still answer; none of them is project-scoped.
    expect(readMember(overview.workflows)).toEqual({ items: [], total: 0 });
    expect(readMember(overview.residuals)).toEqual({
      open: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
    });
    expect(readMember(overview.issueFlow).currentOpen).toBe(0);

    // An iteration the store never attributed to a project: the absent arm, not empty.
    const listed = await readDashboardView({ context, view: "iterations" });
    expect((listed.data as IterationListDTO).attribution).toBe("absent");
  });

  test("a resolved project with no roadmap answers milestones with data, never not-applicable", async () => {
    const context = await workspace("overview-empty-project-");
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-empty", title: "Empty project", rootKind: "projects", relativePath: "proj-empty" },
      operation("register-proj-empty"),
    );

    const overview = (await readDashboardView({ context, view: "overview", params: { project: "proj-empty" } }))
      .data as OverviewDTO;
    expect(readMember(overview.milestones)).toEqual({
      projectId: "proj-empty",
      milestones: [],
      issues: [],
      unassignedIssues: 0,
    });
    // No iteration in the project is the empty arm of the same member, never unavailable.
    expect(overview.latestIteration).toEqual({ state: "read", data: null });
  });

  test("a compass row with no status answers the least step the store can prove", async () => {
    const context = await scopedOverview();
    // The producer cannot write this row (`validateCompassShape` admits only the
    // closed status values), so the arm is pinned by doctoring one projected
    // column AFTER a real read and reading again WITHOUT the refresh, which
    // would rebuild the row from its compass document.
    await readDashboardView({ context, view: "iterations" });
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare("update projection_compasses set status = null where iteration_id = 'iter-open'").run();
      handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally {
      handle.close();
    }

    const listed = await withStoreRead(context, { ...queryDashboard("iterations"), needsProjection: false });
    const row = (listed.data as IterationListDTO).items.find((item) => item.iterationId === "iter-open");
    expect(row?.compass?.status).toBeNull();
    // A compass that records no status proves its own existence and nothing
    // further: step 1, never a step the store cannot show.
    expect(row?.gateStep).toBe(1);
  });

  test("an unreadable projection is reported per member, not as empty work", async () => {
    const context = await workspace("overview-projection-unavailable-");
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-a", title: "Project A", rootKind: "projects", relativePath: "proj-a" },
      operation("register-proj-a"),
    );
    // A malformed registry entry makes the first projection capture unusable
    // WITHOUT throwing: the refresh retains health (`freshness: unavailable`,
    // no published generation), so every projection-dependent reader answers
    // empty rows. Those rows mean "could not read", never "no active work".
    const handle = await openStore(context, "write");
    try {
      handle.db
        .prepare(
          "insert into execution_workflows(workflow_id, creator_session_id, revision, state_json, created_at, updated_at) values ('wf-corrupt', null, 1, ?, ?, ?)",
        )
        .run(
          JSON.stringify({ schema_version: 1, id: "wf-corrupt", type: "plan", status: "running", started_at: STARTED_AT, updated_at: STARTED_AT }),
          STARTED_AT,
          STARTED_AT,
        );
      handle.db.prepare("insert into execution_registry(workflow_id, entry_json) values ('wf-corrupt', '{ malformed')").run();
    } finally {
      handle.close();
    }

    const envelope = await readDashboardView({ context, view: "overview", params: { project: "proj-a" } });
    const overview = envelope.data as OverviewDTO;
    expect(envelope.projection.freshness).toBe("unavailable");
    expect(envelope.projection.generation).toBeNull();
    expect(overview.workflows.state).toBe("unavailable");
    expect(overview.latestIteration.state).toBe("unavailable");
    // The reason is the store's own projection message, not a rewritten one.
    expect(overview.workflows.state === "unavailable" ? overview.workflows.reason : "").not.toBe("");
    // The table readers are untouched: they still answer from the same snapshot.
    for (const member of [overview.residuals, overview.milestones, overview.issueFlow] as const) {
      expect(member.state).toBe("read");
    }
    // Without a project the iteration member stays not-applicable; the workflow
    // member has no project scope and still discloses the unreadable projection.
    const unscoped = (await readDashboardView({ context, view: "overview" })).data as OverviewDTO;
    expect(unscoped.latestIteration.state).toBe("not-applicable");
    expect(unscoped.workflows.state).toBe("unavailable");
  });

  test("the workflows member keeps the unpaged total so a screen can disclose truncation", async () => {
    const context = await workspace("overview-truncated-");
    // The member reads one 50-row page; a longer store must still be disclosed,
    // which is exactly what WorkflowListDTO.total carries (qc3 F-001).
    for (let index = 0; index < 51; index += 1) {
      await createPlanWorkflow(context, `p-bulk-${String(index).padStart(2, "0")}`, "Todo");
    }

    const overview = (await readDashboardView({ context, view: "overview" })).data as OverviewDTO;
    const workflows = readMember(overview.workflows);
    expect(workflows.items).toHaveLength(50);
    expect(workflows.total).toBe(51);
  });

  test("one throwing reader degrades only its own member", async () => {
    const context = await workspace("overview-unavailable-");
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-a", title: "Project A", rootKind: "projects", relativePath: "proj-a" },
      operation("register-proj-a"),
    );
    // Remove the one table the milestone member reads; every other reader is
    // untouched, so only `milestones` may answer `unavailable`.
    const handle = await openStore(context, "write");
    try {
      handle.db.exec("drop table project_milestones");
      handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally {
      handle.close();
    }

    const overview = (await readDashboardView({ context, view: "overview", params: { project: "proj-a" } }))
      .data as OverviewDTO;
    expect(overview.milestones.state).toBe("unavailable");
    // The reason is the store's own message, not a rewritten one.
    expect(overview.milestones.state === "unavailable" ? overview.milestones.reason : "").toContain("project_milestones");
    for (const member of [overview.workflows, overview.residuals, overview.latestIteration, overview.issueFlow] as const) {
      expect(member.state).toBe("read");
    }
  });
});
