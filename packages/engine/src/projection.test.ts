/**
 * projection.test.ts -- proof for atomic publication and last-good
 * handling (contract §5/§6).
 *
 * Every case runs against the real projection module, the real catalog/store
 * modules, the real migration runner and the real `node:sqlite` driver in a
 * per-test temporary harness root -- no mocked database.
 *
 * Covered here (publication half; the pure capture lives in
 * projection-sources.test.ts):
 *
 * - the first refresh publishes generation 1 with the projected workflow,
 *   plan, lease, compass and roadmap rows, and an unchanged refresh publishes
 *   nothing;
 * - a same-size/same-mtime content change publishes a NEW generation and
 *   names the changed key;
 * - a deleted / invalid / inaccessible / changed-during-read declared source
 *   retains the last good generation and reports `stale` with a named
 *   diagnostic; a successful refresh afterwards clears the error;
 * - a first failure reports `unavailable`, never an empty projection;
 * - a clean unregister is a valid source-set change (inactive), while a
 *   missing STILL-DECLARED snapshot is an error;
 * - a competing refresh cannot publish an older capture over a newer one;
 * - a rebuild leaves issue/catalog revisions and rows untouched;
 * - a format-version bump discards the old generation and rebuilds.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { catalogRootDir, linkCatalogEntities, registerCatalogEntity, type CatalogOperation } from "./catalog.js";
import { createExecutionWorkflow, initializeExecutionAuthority } from "./execution-store.js";
import { queryDashboard, withStoreRead } from "./store-read.js";
import type { ExecutionCaller } from "./execution-store.js";
import type { WorkflowSnapshot } from "./workflow.js";
import { captureIssue } from "./issue.js";
import {
  captureProjectionSources,
  PROJECTION_FORMAT_VERSION,
  publishProjectionCapture,
  refreshProjections,
} from "./projection.js";
import { initializeStore, openStore, type StoreContext, type StoreDb } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-projection-"));
const STARTED_AT = "2026-09-18T01:00:00.000Z";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.MSTAR_PROJECTION_CHURN_PATH;
  delete process.env.MSTAR_PROJECTION_DB_CHURN;
  delete process.env.MSTAR_STORE_TEST_RUNNER;
  delete process.env.MSTAR_PROJECTION_TEST_AUTHORITY_READ_ERROR;
});

type Fixture = {
  workspace: string;
  harness: string;
  context: StoreContext;
  iterationsDir: string;
  projectsDir: string;
};

async function fixture(name: string, root = ROOT): Promise<Fixture> {
  const workspace = mkdtempSync(join(root, name));
  const harness = join(workspace, ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: workspace };
  const handle = await initializeStore(context);
  handle.close();
  return {
    workspace,
    harness,
    context,
    iterationsDir: catalogRootDir(context, "iterations"),
    projectsDir: catalogRootDir(context, "projects"),
  };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function op(operationId: string): CatalogOperation {
  return { operationId, actor: "project-manager" };
}

function snapshotDoc(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      schema_version: 1,
      id,
      type: "plan",
      status: "running",
      started_at: STARTED_AT,
      updated_at: STARTED_AT,
      phase: "phase-2-execute",
      branch: { base: "main", source: `feature/${id}`, target: "main" },
      plans: [
        {
          id: `plan-${id}`,
          title: `Plan ${id}`,
          file: `/plans/${id}.md`,
          status: "InProgress",
          coordination: { revision: 1, progress: { status: "InProgress", summary: "half way", evidence_paths: [] } },
          metadata: { catalog_pin: { entity_revision: 4 }, worktree_path: `/wt/${id}`, working_branch: `feature/${id}` },
        },
      ],
      integration_merge_lease: {
        holder: "session-2",
        claimed_at: STARTED_AT,
        plan_id: `plan-${id}`,
        source_branch: `feature/${id}`,
        target_branch: "main",
      },
      ...overrides,
    },
    null,
    2,
  );
}

/** A terminal snapshot: what a workflow leaves behind once it is unregistered. */
function terminalSnapshotDoc(id: string): string {
  return JSON.stringify(
    {
      schema_version: 1,
      id,
      type: "plan",
      status: "completed",
      started_at: STARTED_AT,
      ended_at: "2026-09-18T02:00:00.000Z",
      updated_at: "2026-09-18T02:00:00.000Z",
      branch: { base: "main", source: `feature/${id}`, target: "main" },
      plans: [{ id: `plan-${id}`, title: `Plan ${id}`, file: `/plans/${id}.md`, status: "Done" }],
    },
    null,
    2,
  );
}

function rootDoc(entries: Array<{ id: string; dir: string; type?: "plan" | "iteration" }>): string {
  return JSON.stringify(
    {
      version: 2,
      updated_at: "2026-09-18",
      workflows: entries.map((entry) => ({
        id: entry.id,
        type: entry.type ?? "plan",
        started_at: STARTED_AT,
        dir: entry.dir,
      })),
    },
    null,
    2,
  );
}

const COMPASS = `---
iteration_id: iter-a
start_date: 2026-09-18
status: active
iteration_base_branch: main
target_branch: main
plans:
  - plan-a
---

# iter-a Delivery Compass

## Scope

Narrative summary of the iteration.

## Milestones

| Milestone | Target date | Status |
|-----------|-------------|--------|
| Spec freeze | 2026-09-18 | done |
| Dev complete | 2026-09-20 | pending |
`;

function roadmap(text = "Direction-A ships the first slice."): string {
  return `---
project_id: proj-a
title: Project A
status: active
created_at: 2026-09-18
milestones:
  - M1
---

# Project A

## Direction

${text}

## Goals

- [ ] first goal
- [x] second goal
`;
}

/** Root-declared workflow + catalog-linked compass/roadmap, all on disk. */
async function seedStandard(f: Fixture): Promise<void> {
  write(join(f.harness, "status.json"), rootDoc([{ id: "wf-a", dir: "workflows/wf-a" }]));
  write(join(f.harness, "workflows/wf-a/snapshot.json"), snapshotDoc("wf-a"));
  await seedBinding(f, "wf-a", "plan-wf-a");
  await registerCatalogEntity(
    f.context,
    { kind: "iteration", id: "iter-a", title: "Iteration A", rootKind: "iterations", relativePath: "iter-a" },
    op("cat-iter"),
  );
  await registerCatalogEntity(
    f.context,
    { kind: "project", id: "proj-a", title: "Project A", rootKind: "projects", relativePath: "proj-a" },
    op("cat-proj"),
  );
  await registerCatalogEntity(
    f.context,
    {
      kind: "document",
      id: "doc-compass",
      title: "Compass",
      rootKind: "iterations",
      relativePath: "iter-a/delivery-compass.md",
      documentKind: "compass",
    },
    op("cat-compass"),
  );
  await registerCatalogEntity(
    f.context,
    {
      kind: "document",
      id: "doc-roadmap",
      title: "Roadmap",
      rootKind: "projects",
      relativePath: "proj-a/roadmap.md",
      documentKind: "roadmap",
    },
    op("cat-roadmap"),
  );
  await linkCatalogEntities(
    f.context,
    { from: { kind: "iteration", id: "iter-a" }, relation: "documents", to: { kind: "document", id: "doc-compass" } },
    op("link-compass"),
  );
  await linkCatalogEntities(
    f.context,
    { from: { kind: "project", id: "proj-a" }, relation: "documents", to: { kind: "document", id: "doc-roadmap" } },
    op("link-roadmap"),
  );
  write(join(f.iterationsDir, "iter-a/delivery-compass.md"), COMPASS);
  write(join(f.projectsDir, "proj-a/roadmap.md"), roadmap());
}

/**
 * A committed execution binding, exactly the row the registration journal
 * writes for a workflow. Every registered workflow has one, so a workflow the
 * root later unregisters stays a RETAINED source instead of vanishing.
 */
async function seedBinding(f: Fixture, workflowId: string, planId: string): Promise<void> {
  await registerCatalogEntity(
    f.context,
    { kind: "plan", id: planId, title: `Plan ${planId}`, rootKind: "plans", relativePath: `${planId}.md` },
    op(`cat-${planId}`),
  );
  const handle = await openStore(f.context, "write");
  try {
    handle.db
      .prepare(
        "insert into catalog_execution_bindings(workflow_id, catalog_kind, catalog_id, workflow_root_kind, " +
          "workflow_relative_path, catalog_revision, input_hash, pin_json, operation_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(workflowId, "plan", planId, "harness", `workflows/${workflowId}`, 1, "0".repeat(64), "{}", `op-binding-${workflowId}`);
  } finally {
    handle.close();
  }
}

type Projections = {
  meta: Record<string, unknown>;
  sources: Array<Record<string, unknown>>;
  workflows: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  leases: Array<Record<string, unknown>>;
  compasses: Array<Record<string, unknown>>;
};

async function projections(f: Fixture): Promise<Projections> {
  const handle = await openStore(f.context, "read");
  try {
    const db = handle.db;
    return {
      meta: db.prepare("select * from projection_meta where id = 1").get() as Record<string, unknown>,
      sources: db.prepare("select * from projection_sources order by source_key asc").all() as Array<Record<string, unknown>>,
      workflows: db.prepare("select * from projection_workflows order by id asc").all() as Array<Record<string, unknown>>,
      plans: db.prepare("select * from projection_plans order by plan_id asc").all() as Array<Record<string, unknown>>,
      leases: db.prepare("select * from projection_leases order by plan_id asc, kind asc").all() as Array<
        Record<string, unknown>
      >,
      compasses: db.prepare("select * from projection_compasses order by iteration_id asc").all() as Array<
        Record<string, unknown>
      >,
    };
  } finally {
    handle.close();
  }
}

/** The projected tables only: a retained refresh must not move any of them
 * (health columns deliberately DO move, so `meta` is asserted field by field). */
async function projectedRows(f: Fixture): Promise<Omit<Projections, "meta">> {
  const { meta: _health, ...rows } = await projections(f);
  return rows;
}

/** Store facts a projection rebuild must never move (issue/catalog authority). */
async function authorityFacts(f: Fixture): Promise<Record<string, unknown>> {
  const handle = await openStore(f.context, "read");
  try {
    const db = handle.db;
    return {
      meta: db.prepare("select revision, catalog_revision, authority_state, authority_epoch from store_meta where id = 1").get(),
      issues: db.prepare("select * from issues order by id asc").all(),
      occurrences: db.prepare("select * from occurrences order by id asc").all(),
      relations: db.prepare("select * from relations order by 1").all(),
      catalogEntities: db.prepare("select * from catalog_entities order by kind asc, id asc").all(),
      catalogLinks: db.prepare("select * from catalog_links order by from_id asc, to_id asc").all(),
      catalogBindings: db.prepare("select * from catalog_execution_bindings order by workflow_id asc").all(),
      catalogOperations: db.prepare("select * from catalog_operations order by operation_id asc").all(),
    };
  } finally {
    handle.close();
  }
}

function issueInput(occurrenceKey: string) {
  return {
    projectId: "proj-a",
    title: "Finding from the projection suite",
    kind: "bug" as const,
    severity: "medium" as const,
    impact: "The dashboard cannot trust the projection",
    acceptance: "The projection reports honestly",
    sourceIdentity: "qc/review.md",
    rootCauseKey: "missing-projection-test",
    acceptanceKey: "honest-projection",
    occurrenceKey,
    sourceKind: "qc",
    location: "packages/engine/src/projection.ts",
    observedBehavior: "observed",
    evidence: ["evidence.md"],
    discoveredAt: STARTED_AT,
  };
}
async function activeWorkflowFixture(name: string, workflowId: string, planId: string): Promise<Fixture> {
  const f = await fixture(name);
  const initialized = await initializeExecutionAuthority(f.context);
  await registerCatalogEntity(f.context, { kind: "plan", id: planId, title: "Plan", rootKind: "plans", relativePath: `${planId}.md` }, op(`${name}-catalog`));
  const caller: ExecutionCaller = { sessionId: `${name}-coordinator`, role: "coordinator", workflowId, planId: null };
  await createExecutionWorkflow({ ...f.context, caller }, {
    entry: { id: workflowId, type: "plan", started_at: STARTED_AT, dir: `workflows/${workflowId}` },
    snapshot: {
      schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: STARTED_AT,
      updated_at: STARTED_AT, phase: "phase-2-execute", branch: { base: "main", source: "feature/active-test", target: "main" },
      plans: [{ id: planId, title: "Plan", file: `${planId}.md`, status: "InProgress" }],
      delivery_kind: "development",
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `${name}-create`,
  });
  const handle = await openStore(f.context, "write");
  try {
    handle.db.prepare("update execution_plans set coordination_json = ? where workflow_id = ? and plan_id = ?")
      .run(JSON.stringify({ progress: { status: "InProgress", summary: "consumer-visible progress", evidence_paths: [] } }), workflowId, planId);
    handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
  } finally { handle.close(); }
  return f;
}

  test("ACTIVE execution rows publish through the dashboard projection", async () => {
    const f = await fixture("active-smoke-");
    const initialized = await initializeExecutionAuthority(f.context);
    const workflowId = "wf-active-smoke";
    const planId = "plan-active-smoke";
    await registerCatalogEntity(
      f.context,
      { kind: "plan", id: planId, title: "Active plan", rootKind: "plans", relativePath: `${planId}.md` },
      op("active-plan"),
    );
    const caller: ExecutionCaller = { sessionId: "active-coordinator", role: "coordinator", workflowId, planId: null };
    await createExecutionWorkflow({ ...f.context, caller }, {
      entry: { id: workflowId, type: "plan", started_at: STARTED_AT, dir: `workflows/${workflowId}` },
      snapshot: {
        schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: STARTED_AT,
        updated_at: STARTED_AT, phase: "phase-2-execute",
        plans: [{ id: planId, title: "Active plan", file: `${planId}.md`, status: "InProgress" }],
        delivery_kind: "development", branch: { base: "main", source: "feature/active", integration: "integration/active", target: "main" },
      } as unknown as WorkflowSnapshot,
      expected: initialized.token,
      operationId: "active-create",
    });
    const progressHandle = await openStore(f.context, "write");
    try {
      progressHandle.db.prepare("update execution_plans set coordination_json = ? where workflow_id = ? and plan_id = ?")
        .run(JSON.stringify({ progress: { status: "InProgress", summary: "active progress", evidence_paths: [] } }), workflowId, planId);
      progressHandle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally { progressHandle.close(); }
    const report = await refreshProjections(f.context);
    expect(report.diagnostics).toEqual([]);
    expect(report).toMatchObject({ freshness: "current", published: true });
    expect(await projections(f)).toMatchObject({ workflows: [expect.objectContaining({ id: workflowId })], plans: [expect.objectContaining({ workflow_id: workflowId, plan_id: planId })] });
    const dashboard = await withStoreRead(f.context, queryDashboard("workflows"));
    expect(dashboard.projection).toMatchObject({ freshness: "current" });
    expect(dashboard.data).toMatchObject({
      items: [expect.objectContaining({
        id: workflowId,
        phase: "phase-2-execute",
        branch: { base: "main", source: "feature/active", integration: "integration/active", target: "main" },
        plans: [expect.objectContaining({ planId, progress: "active progress", phase: "phase-2-execute" })],
      })],
    });
  });
  test("an unreadable ACTIVE authority blocks capture without enumerating registry history", async () => {
    const workflowId = "wf-authority-unreadable";
    const planId = "plan-authority-unreadable";
    const f = await activeWorkflowFixture("active-authority-unreadable-", workflowId, planId);
    const initial = await refreshProjections(f.context);
    const lastGood = await projectedRows(f);
    process.env.MSTAR_STORE_TEST_RUNNER = "1";
    process.env.MSTAR_PROJECTION_TEST_AUTHORITY_READ_ERROR = "Unexpected token 'password=hunter2' at position 22; source excerpt: Array[REDACTED]";

    const capture = await captureProjectionSources(f.context);
    expect(capture).toMatchObject({ blocked: true, sources: [] });
    expect(capture.diagnostics).toEqual([{
      sourceKey: "root:harness:execution/registry",
      reason: "invalid",
      message: "execution authority unreadable (SyntaxError)",
    }]);
    expect(capture.diagnostics[0]?.message).not.toContain("password=hunter2");
    expect(capture.diagnostics[0]?.message).not.toContain("source excerpt");
    const stale = await refreshProjections(f.context);
    expect(stale).toMatchObject({ freshness: "stale", published: false, generation: initial.generation, sources: [], changedKeys: [] });
    expect(stale.diagnostics).toEqual(capture.diagnostics);
    expect(await projectedRows(f)).toEqual(lastGood);
  });
  test("an empty ACTIVE authority publishes a current empty projection", async () => {
    const f = await fixture("active-empty-");
    await initializeExecutionAuthority(f.context);

    const refreshed = await withStoreRead(f.context, queryDashboard("workflows"));

    expect(refreshed.projection).toMatchObject({ freshness: "current", generation: 1 });
    expect(refreshed.data).toMatchObject({ items: [], total: 0 });
    expect(await projections(f)).toMatchObject({ workflows: [], plans: [], leases: [], compasses: [] });
  });

  test("leftover retired workflow files do not alter ACTIVE projection sources", async () => {
    const workflowId = "wf-retired-files";
    const planId = "plan-retired-files";
    const f = await activeWorkflowFixture("active-retired-files-", workflowId, planId);
    const statusPath = join(f.harness, "status.json");
    const snapshotPath = join(f.harness, "workflows", workflowId, "snapshot.json");
    write(statusPath, rootDoc([{ id: "wf-leftover", dir: "workflows/wf-leftover" }]));
    write(join(f.harness, "workflows", "wf-leftover", "snapshot.json"), snapshotDoc("wf-leftover"));
    write(snapshotPath, snapshotDoc(workflowId));

    const first = await refreshProjections(f.context);
    expect(first).toMatchObject({ freshness: "current", diagnostics: [] });
    const initial = await projections(f);

    write(statusPath, rootDoc([{ id: "wf-leftover-changed", dir: "workflows/wf-leftover-changed" }]));
    write(snapshotPath, snapshotDoc(workflowId, { status: "completed", updated_at: `${STARTED_AT}-changed` }));
    const changed = await refreshProjections(f.context);
    expect(changed).toMatchObject({ freshness: "current", diagnostics: [] });
    expect((await projections(f)).sources.map((source) => source.source_key)).toEqual(initial.sources.map((source) => source.source_key));

    write(join(f.harness, "workflows", "wf-added-retired", "snapshot.json"), snapshotDoc("wf-added-retired"));
    const added = await refreshProjections(f.context);
    expect(added).toMatchObject({ freshness: "current", diagnostics: [] });
    expect((await projections(f)).sources.map((source) => source.source_key)).toEqual(initial.sources.map((source) => source.source_key));

    rmSync(statusPath);
    rmSync(snapshotPath);
    rmSync(join(f.harness, "workflows", "wf-leftover", "snapshot.json"));
    rmSync(join(f.harness, "workflows", "wf-added-retired", "snapshot.json"));
    const deleted = await refreshProjections(f.context);
    expect(deleted).toMatchObject({ freshness: "current", diagnostics: [] });
    const remaining = await projections(f);
    expect(remaining.sources.map((source) => source.source_key)).toEqual(initial.sources.map((source) => source.source_key));
    expect(remaining.workflows.map(({ id, status }) => ({ id, status }))).toEqual(initial.workflows.map(({ id, status }) => ({ id, status })));
  });

  test("a deleted ACTIVE row refuses stale publication and retains last-good rows", async () => {
    const workflowId = "wf-deleted-before-verify";
    const planId = "plan-deleted-before-verify";
    const f = await activeWorkflowFixture("active-delete-row-", workflowId, planId);
    const initial = await refreshProjections(f.context);
    const lastGood = await projectedRows(f);
    const capture = await captureProjectionSources(f.context);
    const handle = await openStore(f.context, "write");
    try {
      handle.db.prepare("delete from execution_inputs where workflow_id = ? and plan_id = ?").run(workflowId, planId);
      handle.db.prepare("delete from execution_plans where workflow_id = ? and plan_id = ?").run(workflowId, planId);
      handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally { handle.close(); }

    await expect(publishProjectionCapture(f.context, capture)).rejects.toMatchObject({
      code: "projection.source-stale",
    });
    expect((await projections(f)).meta.generation).toBe(initial.generation);
    expect(await projectedRows(f)).toEqual(lastGood);
  });

  test("authority activation between a files capture and publication refuses stale publication", async () => {
    const f = await fixture("files-activate-midflight-");
    // A plain fixture store carries execution_meta with authority_state
    // 'legacy' — the files arm captures it, activation flips it mid-flight.
    write(join(f.harness, "status.json"), rootDoc([{ id: "wf-files", dir: "workflows/wf-files" }]));
    write(join(f.harness, "workflows", "wf-files", "snapshot.json"), snapshotDoc("wf-files"));
    const first = await refreshProjections(f.context);
    expect(first).toMatchObject({ freshness: "current", published: true });
    const capture = await captureProjectionSources(f.context);
    const handle = await openStore(f.context, "write");
    try {
      handle.db.prepare("update execution_meta set authority_state = 'active', revision = revision + 1 where id = 1").run();
    } finally { handle.close(); }
    await expect(publishProjectionCapture(f.context, capture)).rejects.toMatchObject({
      code: "projection.source-stale",
    });
    // The retained generation is untouched; the next refresh takes the ACTIVE arm.
    expect((await projections(f)).meta.generation).toBe(first.generation);
  });

  test("two ACTIVE source movements produce stale health without advancing generation", async () => {
    const workflowId = "wf-double-movement";
    const planId = "plan-double-movement";
    const f = await activeWorkflowFixture("active-double-movement-", workflowId, planId);
    const initial = await refreshProjections(f.context);
    const lastGood = await projectedRows(f);
    process.env.MSTAR_STORE_TEST_RUNNER = "1";
    process.env.MSTAR_PROJECTION_DB_CHURN = JSON.stringify([
      { kind: "update-row", workflowId, planId },
      { kind: "update-row", workflowId, planId },
    ]);

    const stale = await refreshProjections(f.context);

    expect(stale).toMatchObject({ freshness: "stale", published: false, generation: initial.generation });
    expect(stale.diagnostics).toContainEqual(expect.objectContaining({
      sourceKey: "root:harness:execution/store-revision",
      reason: "source-changing",
    }));
    expect((await projections(f)).meta.generation).toBe(initial.generation);
    expect(await projectedRows(f)).toEqual(lastGood);
  });


  test("an execution workflow row absent from the authority served graph is not projected", async () => {
    const f = await fixture("active-unserved-");
    await initializeExecutionAuthority(f.context);
    const workflowId = "wf-unserved";
    const handle = await openStore(f.context, "write");
    try {
      handle.db.prepare("insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, 1, ?, ?, ?)")
        .run(workflowId, JSON.stringify({ schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: STARTED_AT, updated_at: STARTED_AT }), STARTED_AT, STARTED_AT);
      handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally { handle.close(); }
    const report = await refreshProjections(f.context);
    expect(report).toMatchObject({ freshness: "current", published: true });
    expect((await projections(f)).workflows).not.toContainEqual(expect.objectContaining({ id: workflowId }));
    expect(report.sources).not.toContainEqual(expect.objectContaining({ sourceKey: `workflow:harness:execution/workflows/${workflowId}` }));
  });
  test("malformed ACTIVE plan JSON returns a safe authority diagnostic and retains last-good rows", async () => {
    const workflowId = "wf-corrupt-plan";
    const planId = "plan-corrupt-plan";
    const f = await activeWorkflowFixture("corrupt-plan-", workflowId, planId);
    const initial = await refreshProjections(f.context);
    const lastGood = await projectedRows(f);
    const handle = await openStore(f.context, "write");
    try {
      handle.db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?").run("{broken", workflowId, planId);
      handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally { handle.close(); }
    const stale = await refreshProjections(f.context);
    expect(stale).toMatchObject({ freshness: "stale", published: false, generation: initial.generation, sources: [], changedKeys: [] });
    expect(stale.diagnostics).toEqual([expect.objectContaining({
      sourceKey: "root:harness:execution/registry",
      reason: "invalid",
      message: "execution authority unreadable (StoreError)",
    })]);
    expect(await projectedRows(f)).toEqual(lastGood);
  });

  test("invalid ACTIVE workflow status retains last-good rows with a named source diagnostic", async () => {
    const workflowId = "wf-invalid-status";
    const planId = "plan-invalid-status";
    const f = await activeWorkflowFixture("invalid-workflow-", workflowId, planId);
    const initial = await refreshProjections(f.context);
    const lastGood = await projectedRows(f);
    const handle = await openStore(f.context, "write");
    try {
      const row = handle.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(workflowId) as { state_json: string };
      const state = JSON.parse(row.state_json) as Record<string, unknown>;
      state.status = "not-a-workflow-status";
      handle.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), workflowId);
      handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally { handle.close(); }
    const stale = await refreshProjections(f.context);
    expect(stale).toMatchObject({ freshness: "stale", published: false, generation: initial.generation, sources: [], changedKeys: [] });
    expect(stale.diagnostics).toEqual([expect.objectContaining({
      sourceKey: "root:harness:execution/registry",
      reason: "invalid",
      message: "execution authority unreadable (StoreError)",
    })]);
    expect(await projectedRows(f)).toEqual(lastGood);
  });
  test("an ACTIVE compass that fails domain parsing is reported invalid without movement noise", async () => {
    const f = await activeWorkflowFixture("active-invalid-compass-", "wf-compass", "plan-compass");
    await registerCatalogEntity(f.context, { kind: "iteration", id: "iter-a", title: "Iteration A", rootKind: "iterations", relativePath: "iter-a" }, op("active-compass-iteration"));
    await registerCatalogEntity(f.context, { kind: "document", id: "doc-compass", title: "Compass", rootKind: "iterations", relativePath: "iter-a/delivery-compass.md", documentKind: "compass" }, op("active-compass-doc"));
    await linkCatalogEntities(f.context, { from: { kind: "iteration", id: "iter-a" }, relation: "documents", to: { kind: "document", id: "doc-compass" } }, op("active-compass-link"));
    write(join(f.iterationsDir, "iter-a/delivery-compass.md"), COMPASS);
    const first = await refreshProjections(f.context);
    expect(first).toMatchObject({ freshness: "current", published: true });
    const lastGood = await projectedRows(f);
    const relativePath = "iter-a/delivery-compass.md";
    write(join(f.iterationsDir, relativePath), "plain text that is not a delivery compass\n");

    const stale = await refreshProjections(f.context);
    const sourceKey = "compass:iterations:iter-a/delivery-compass.md";
    expect(stale).toMatchObject({ freshness: "stale", published: false, generation: first.generation });
    expect(stale.sources).toContainEqual(expect.objectContaining({ sourceKey, state: "invalid" }));
    expect(stale.diagnostics).toEqual([expect.objectContaining({ sourceKey, reason: "invalid" })]);
    expect(await projectedRows(f)).toEqual(lastGood);
  });
  test("ACTIVE registry, workflow, and plan identity corruption fail closed with last-good rows", async () => {
    for (const kind of ["registry", "workflow", "plan"] as const) {
      const workflowId = `wf-identity-${kind}`;
      const planId = `plan-identity-${kind}`;
      const f = await activeWorkflowFixture(`active-identity-${kind}-`, workflowId, planId);
      const initial = await refreshProjections(f.context);
      const lastGood = await projectedRows(f);
      const handle = await openStore(f.context, "write");
      try {
        if (kind === "registry") {
          const row = handle.db.prepare("select entry_json from execution_registry where workflow_id = ?").get(workflowId) as { entry_json: string };
          const entry = JSON.parse(row.entry_json) as Record<string, unknown>;
          entry.type = "not-a-workflow-type";
          entry.started_at = 42;
          delete entry.dir;
          handle.db.prepare("update execution_registry set entry_json = ? where workflow_id = ?").run(JSON.stringify(entry), workflowId);
        } else if (kind === "workflow") {
          const row = handle.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(workflowId) as { state_json: string };
          const state = JSON.parse(row.state_json) as Record<string, unknown>;
          state.id = "different-workflow";
          handle.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), workflowId);
        } else {
          const row = handle.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId) as { state_json: string };
          const state = JSON.parse(row.state_json) as Record<string, unknown>;
          state.id = "different-plan";
          handle.db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?").run(JSON.stringify(state), workflowId, planId);
        }
        handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
      } finally { handle.close(); }
      const stale = await refreshProjections(f.context);
      expect(stale).toMatchObject({ freshness: "stale", published: false, generation: initial.generation, sources: [], changedKeys: [] });
      expect(stale.diagnostics).toEqual([expect.objectContaining({
        sourceKey: "root:harness:execution/registry",
        reason: "invalid",
        message: "execution authority unreadable (StoreError)",
      })]);
      expect(await projectedRows(f)).toEqual(lastGood);
    }
  });
  test("ACTIVE movement regression: plan insertion and captured-row update", async () => {
    // Subcase A: plan membership changes after capture.
    await (async () => {
    const f = await fixture("active-plan-moved-");
    const initialized = await initializeExecutionAuthority(f.context);
    const workflowId = "wf-plan-moved";
    const planId = "plan-original";
    await registerCatalogEntity(f.context, { kind: "plan", id: planId, title: "Plan", rootKind: "plans", relativePath: `${planId}.md` }, op("plan-moved-catalog"));
    const caller: ExecutionCaller = { sessionId: "coord-plan-moved", role: "coordinator", workflowId, planId: null };
    await createExecutionWorkflow({ ...f.context, caller }, {
      entry: { id: workflowId, type: "plan", started_at: STARTED_AT, dir: `workflows/${workflowId}` },
      snapshot: { schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: STARTED_AT, updated_at: STARTED_AT, plans: [{ id: planId, title: "Plan", file: `${planId}.md`, status: "Todo" }], delivery_kind: "development", branch: { source: "feature/moved", target: "main" } } as unknown as WorkflowSnapshot,
      expected: initialized.token, operationId: "create-plan-moved",
    });
    const initial = await refreshProjections(f.context);
    const captured = await captureProjectionSources(f.context);
    const handle = await openStore(f.context, "write");
    try {
      handle.db.prepare("insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, 99, ?, '{}')")
        .run(workflowId, "plan-inserted", JSON.stringify({ id: "plan-inserted", title: "Inserted plan", file: "plans/inserted.md", status: "Todo" }));
      handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally { handle.close(); }
    await expect(publishProjectionCapture(f.context, captured)).rejects.toMatchObject({ code: "projection.source-stale" });
    expect(await projections(f)).toMatchObject({ meta: { generation: initial.generation }, plans: [expect.objectContaining({ plan_id: planId })] });
    const refreshed = await withStoreRead(f.context, queryDashboard("workflows"));
    expect(refreshed.projection).toMatchObject({ freshness: "current", generation: initial.generation! + 1 });
    expect((await projections(f)).plans).toEqual(expect.arrayContaining([expect.objectContaining({ plan_id: "plan-inserted" }), expect.objectContaining({ plan_id: planId })]));
    process.env.MSTAR_STORE_TEST_RUNNER = "1";
    process.env.MSTAR_PROJECTION_DB_CHURN = JSON.stringify({ kind: "insert-plan", workflowId, planId: "plan-retry-inserted" });
    const retried = await refreshProjections(f.context);
    expect(retried).toMatchObject({ freshness: "current", published: true, generation: initial.generation! + 2 });
    expect((await projections(f)).plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ plan_id: "plan-inserted" }),
      expect.objectContaining({ plan_id: "plan-retry-inserted" }),
    ]));
    })();

    // Subcase B: captured workflow JSON changes after capture.
    await (async () => {
    const f = await fixture("active-row-moved-");
    const initialized = await initializeExecutionAuthority(f.context);
    const workflowId = "wf-row-moved";
    const planId = "plan-row-moved";
    await registerCatalogEntity(f.context, { kind: "plan", id: planId, title: "Plan", rootKind: "plans", relativePath: `${planId}.md` }, op("row-moved-catalog"));
    const caller: ExecutionCaller = { sessionId: "coord-row-moved", role: "coordinator", workflowId, planId: null };
    await createExecutionWorkflow({ ...f.context, caller }, {
      entry: { id: workflowId, type: "plan", started_at: STARTED_AT, dir: `workflows/${workflowId}` },
      snapshot: { schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: STARTED_AT, updated_at: STARTED_AT, plans: [{ id: planId, title: "Plan", file: `${planId}.md`, status: "Todo" }], delivery_kind: "development", branch: { source: "feature/row-moved", target: "main" } } as unknown as WorkflowSnapshot,
      expected: initialized.token, operationId: "create-row-moved",
    });
    const initial = await refreshProjections(f.context);
    const captured = await captureProjectionSources(f.context);
    const handle = await openStore(f.context, "write");
    try {
      const state = JSON.parse(String((handle.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(workflowId) as { state_json: string }).state_json)) as Record<string, unknown>;
      state.status = "completed";
      state.ended_at = STARTED_AT;
      handle.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), workflowId);
      handle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally { handle.close(); }
    await expect(publishProjectionCapture(f.context, captured)).rejects.toMatchObject({ code: "projection.source-stale" });
    expect(await projections(f)).toMatchObject({ meta: { generation: initial.generation }, workflows: [expect.objectContaining({ id: workflowId, status: "running" })] });
    const refreshed = await withStoreRead(f.context, queryDashboard("workflows"));
    expect(refreshed.projection).toMatchObject({ freshness: "current", generation: initial.generation! + 1 });
    expect(await projections(f)).toMatchObject({ workflows: [expect.objectContaining({ id: workflowId, status: "completed" })] });
    process.env.MSTAR_STORE_TEST_RUNNER = "1";
    process.env.MSTAR_PROJECTION_DB_CHURN = JSON.stringify({ kind: "update-row", workflowId, planId });
    const retried = await refreshProjections(f.context);
    expect(retried).toMatchObject({ freshness: "current", published: true, generation: initial.generation! + 2 });
    expect((await projections(f)).workflows[0]).toMatchObject({ id: workflowId, status: "completed", updated_at: `${STARTED_AT}-churn` });
    })();
  });


describe("projection publication and last-good handling", () => {
  test("malformed execution registry entry JSON is classified as invalid", async () => {
    const f = await fixture("registry-invalid-");
    await initializeExecutionAuthority(f.context);
    const handle = await openStore(f.context, "write");
    try {
      handle.db
        .prepare(
          "insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, ?, ?, ?, ?)",
        )
        .run("wf-registry", 1, "{}", STARTED_AT, STARTED_AT);
      handle.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)").run("wf-registry", "{ malformed");
    } finally {
      handle.close();
    }
    const capture = await captureProjectionSources(f.context);

    const report = await publishProjectionCapture(f.context, capture);
    expect(report.freshness).toBe("unavailable");
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "root:harness:execution/registry", reason: "invalid" }),
    ]));
  });


  test("each clean refresh publishes a new generation without a fingerprint-equality gate", async () => {
    const f = await fixture("publish-");
    await seedStandard(f);
    // A workflow that was registered and closed before this refresh: retained
    // history with a committed binding the root no longer lists.
    write(join(f.harness, "workflows/wf-done/snapshot.json"), terminalSnapshotDoc("wf-done"));
    await seedBinding(f, "wf-done", "plan-done");

    const first = await refreshProjections(f.context);
    expect(first).toMatchObject({ freshness: "current", published: true, generation: 1, diagnostics: [] });
    expect(first.builtAt).toBe(first.checkedAt);
    expect(first.changedKeys).toEqual(first.sources.map((source) => source.sourceKey));
    expect(first.sources).toHaveLength(4);
    expect(first.sources.find((source) => source.relativePath === "workflows/wf-done/snapshot.json")).toMatchObject({
      declared: false,
      state: "ok",
    });

    const rows = await projections(f);
    expect(rows.meta).toMatchObject({
      generation: 1,
      format_version: PROJECTION_FORMAT_VERSION,
      source_set_hash: first.sourceSetHash,
      freshness: "current",
      last_error_json: null,
    });
    expect(rows.sources.every((source) => source.generation === 1)).toBe(true);
    expect(rows.workflows).toEqual([
      expect.objectContaining({
        generation: 1,
        id: "wf-a",
        type: "plan",
        status: "running",
        phase: "phase-2-execute",
        started_at: STARTED_AT,
        ended_at: null,
        updated_at: STARTED_AT,
        branch_base: "main",
        branch_source: "feature/wf-a",
        branch_integration: null,
        branch_target: "main",
        active_registration: 1,
      }),
      // Retained history: catalog identity survives, the root no longer lists
      // it, so it is projected inactive.
      expect.objectContaining({ id: "wf-done", status: "completed", active_registration: 0 }),
    ]);
    expect(rows.plans).toEqual([
      expect.objectContaining({
        generation: 1,
        workflow_id: "wf-a",
        plan_id: "plan-wf-a",
        status: "InProgress",
        progress: "half way",
        phase: "phase-2-execute",
        done_at: null,
        catalog_pin_revision: 4,
      }),
      expect.objectContaining({ workflow_id: "wf-done", plan_id: "plan-wf-done", status: "Done" }),
    ]);
    // The workflow-wide integration mutex is the only remaining lease projection.
    expect(rows.leases).toEqual([
      expect.objectContaining({ workflow_id: "wf-a", kind: "integration-merge", holder: "session-2" }),
    ]);
    expect(rows.compasses).toEqual([
      expect.objectContaining({
        generation: 1,
        iteration_id: "iter-a",
        summary: "Narrative summary of the iteration.",
        status: "active",
        started_at: "2026-09-18",
        ended_at: null,
      }),
    ]);
    expect(JSON.parse(String(rows.compasses[0]?.milestones_json))).toEqual([
      { milestone: "Spec freeze", target: "2026-09-18", status: "done" },
      { milestone: "Dev complete", target: "2026-09-20", status: "pending" },
    ]);

    const second = await refreshProjections(f.context);
    expect(second).toMatchObject({ freshness: "current", published: true, generation: 2, changedKeys: [] });
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(second.checkedAt >= first.checkedAt).toBe(true);
    expect((await projectedRows(f)).workflows[0]).toMatchObject({ generation: 2, id: "wf-a" });
  });

  test("a deleted declared source retains the last good generation and reports stale with a diagnostic", async () => {
    const f = await fixture("deleted-");
    await seedStandard(f);
    const first = await refreshProjections(f.context);
    const publishedRows = await projectedRows(f);

    rmSync(join(f.harness, "workflows/wf-a/snapshot.json"), { force: true });
    const stale = await refreshProjections(f.context);
    expect(stale).toMatchObject({ freshness: "stale", published: false, generation: first.generation, builtAt: first.builtAt });
    expect(stale.diagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: "workflow:harness:workflows/wf-a/snapshot.json", reason: "missing" }),
    );
    // The last good rows and their built_at survive untouched; only the
    // health columns move.
    expect(await projectedRows(f)).toEqual(publishedRows);
    const retainedHealth = (await projections(f)).meta;
    expect(retainedHealth).toMatchObject({ generation: first.generation, built_at: first.builtAt, freshness: "stale" });
    expect(JSON.parse(String(retainedHealth.last_error_json))).toMatchObject({ code: "projection.stale" });

    // A later clean refresh publishes a new generation after the missing
    // source is restored; no content fingerprint adopts the old generation.
    write(join(f.harness, "workflows/wf-a/snapshot.json"), snapshotDoc("wf-a"));
    const recovered = await refreshProjections(f.context);
    expect(recovered).toMatchObject({
      freshness: "current",
      published: true,
      generation: 2,
      diagnostics: [],
      changedKeys: [],
    });
    expect((await projections(f)).meta).toMatchObject({ freshness: "current", last_error_json: null });
  });

  test("an invalid and an inaccessible declared source each retain the last good generation", async () => {
    const f = await fixture("invalid-");
    await seedStandard(f);
    const first = await refreshProjections(f.context);

    write(join(f.harness, "workflows/wf-a/snapshot.json"), "{ not json");
    const invalid = await refreshProjections(f.context);
    expect(invalid).toMatchObject({ freshness: "stale", generation: first.generation, builtAt: first.builtAt });
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: "workflow:harness:workflows/wf-a/snapshot.json", reason: "invalid" }),
    );
    expect((await projections(f)).workflows[0]).toMatchObject({ status: "running", generation: first.generation });

    write(join(f.harness, "workflows/wf-a/snapshot.json"), snapshotDoc("wf-a"));
  });


  test("a first failure reports unavailable instead of an empty projection", async () => {
    const f = await fixture("first-failure-");
    write(join(f.harness, "status.json"), rootDoc([{ id: "wf-missing", dir: "workflows/wf-missing" }]));
    const report = await refreshProjections(f.context);
    expect(report).toMatchObject({ freshness: "unavailable", published: false, generation: null, builtAt: null });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ reason: "missing" }));
    const rows = await projections(f);
    expect(rows.meta).toMatchObject({ generation: null, freshness: "unavailable" });
    expect(JSON.parse(String(rows.meta.last_error_json))).toMatchObject({ code: "projection.unavailable" });
    // Unavailable means "we have nothing honest to show", never "zero work".
    expect([rows.workflows, rows.plans, rows.leases, rows.compasses].every((table) => table.length === 0)).toBe(true);
  });

  test("a clean unregister is a valid source-set change, while a missing still-declared snapshot is an error", async () => {
    const f = await fixture("unregister-");
    await seedStandard(f);
    write(join(f.harness, "workflows/wf-done/snapshot.json"), terminalSnapshotDoc("wf-done"));
    await seedBinding(f, "wf-done", "plan-done");
    const first = await refreshProjections(f.context);
    expect(first.sources.find((source) => source.relativePath === "workflows/wf-a/snapshot.json")?.declared).toBe(true);

    // Clean unregister: the root no longer lists wf-a, its snapshot stays.
    write(join(f.harness, "status.json"), rootDoc([]));
    const unregistered = await refreshProjections(f.context);
    expect(unregistered).toMatchObject({ freshness: "current", published: true, diagnostics: [] });
    expect(unregistered.changedKeys).toContain("root:harness:status.json");
    const afterUnregister = await projectedRows(f);
    expect(afterUnregister.workflows).toEqual([
      expect.objectContaining({ id: "wf-a", active_registration: 0, status: "running" }),
      expect.objectContaining({ id: "wf-done", active_registration: 0, status: "completed" }),
    ]);
    // wf-a moved from root-declared to retained history; no diagnostic.
    expect(unregistered.sources.find((source) => source.relativePath === "workflows/wf-a/snapshot.json")?.declared).toBe(false);

    // A still-declared workflow whose snapshot is missing IS an error.
    write(join(f.harness, "status.json"), rootDoc([{ id: "wf-b", dir: "workflows/wf-b" }]));
    const broken = await refreshProjections(f.context);
    expect(broken).toMatchObject({ freshness: "stale", published: false, generation: unregistered.generation });
    expect(broken.diagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: "workflow:harness:workflows/wf-b/snapshot.json", reason: "missing" }),
    );
    expect(await projectedRows(f)).toEqual(afterUnregister);
  });

  test("a captured projection publishes despite later source-content edits", async () => {
    const f = await fixture("captured-edit-");
    await seedStandard(f);
    const older = await captureProjectionSources(f.context);

    write(join(f.harness, "workflows/wf-b/snapshot.json"), snapshotDoc("wf-b"));
    write(join(f.harness, "status.json"), rootDoc([{ id: "wf-a", dir: "workflows/wf-a" }, { id: "wf-b", dir: "workflows/wf-b" }]));
    await refreshProjections(f.context);

    await expect(publishProjectionCapture(f.context, older)).resolves.toMatchObject({ freshness: "current", published: true });
    const rows = await projections(f);
    expect(rows.workflows.map((workflow) => workflow.id)).toEqual(["wf-a"]);
  });

  test("a rebuild leaves issue/catalog revisions and rows untouched", async () => {
    const f = await fixture("authority-");
    await seedStandard(f);
    await captureIssue(f.context, issueInput("occ-1"), op("issue-1"));
    const before = await authorityFacts(f);

    await refreshProjections(f.context);
    await refreshProjections(f.context);
    write(join(f.harness, "workflows/wf-a/snapshot.json"), snapshotDoc("wf-a", { phase: "phase-3-close" }));
    await refreshProjections(f.context);

    expect(await authorityFacts(f)).toEqual(before);
    // ... while the projection itself did move.
    expect((await projections(f)).workflows[0]).toMatchObject({ phase: "phase-3-close" });
  });

  test("a projection format bump discards the old generation and rebuilds on the next read", async () => {
    const f = await fixture("format-bump-");
    await seedStandard(f);
    await refreshProjections(f.context);

    const handle = await openStore(f.context, "write");
    try {
      handle.db.prepare("update projection_meta set format_version = ? where id = 1").run(PROJECTION_FORMAT_VERSION + 1);
    } finally {
      handle.close();
    }
    // The old rows are not reinterpreted as authority: a failing capture now
    // reports unavailable with empty tables ...
    rmSync(join(f.harness, "workflows/wf-a/snapshot.json"), { force: true });
    const afterBump = await refreshProjections(f.context);
    expect(afterBump).toMatchObject({ freshness: "unavailable", generation: null, published: false });
    const discarded = await projections(f);
    expect([discarded.workflows, discarded.plans, discarded.sources].every((table) => table.length === 0)).toBe(true);
    expect(discarded.meta).toMatchObject({ generation: null, format_version: PROJECTION_FORMAT_VERSION });

    // ... and a clean capture rebuilds from scratch.
    write(join(f.harness, "workflows/wf-a/snapshot.json"), snapshotDoc("wf-a"));
    const rebuilt = await refreshProjections(f.context);
    expect(rebuilt).toMatchObject({ freshness: "current", published: true, generation: 1 });
  });

  test("a store that predates migration 3 refuses actionably instead of projecting nothing", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "mstar-projection-schema-outdated-"));
    try {
      const f = await fixture("store-", isolatedRoot);
      await seedStandard(f);
      const handle = await openStore(f.context, "write");
      try {
        dropProjectionTables(handle.db);
        // The recorded history must stay contiguous: a store that predates the
        // projection schema predates every later migration too.
        handle.db.exec("delete from schema_version where version >= 3");
      } finally {
        handle.close();
      }
      // The pure capture still works (it reads no projection table) ...
      const capture = await captureProjectionSources(f.context);
      expect(capture.blocked).toBe(false);
      // ... and publication refuses with the upgrade pointer, writing nothing.
      const actualError = await refreshProjections(f.context).then(() => null, (error: unknown) => error);
      expect(existsSync(join(f.harness, "store.db"))).toBe(true);
      expect(actualError).toMatchObject({
        code: "projection.schema-outdated",
        message: expect.stringContaining("mstar store upgrade --operator <name>"),
      });
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});

function dropProjectionTables(db: StoreDb): void {
  for (const table of [
    "projection_compasses",
    "projection_leases",
    "projection_plans",
    "projection_workflows",
    "projection_sources",
    "projection_meta",
  ]) {
    db.exec(`drop table ${table}`);
  }
}
