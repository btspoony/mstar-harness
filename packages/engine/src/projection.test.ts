/**
 * projection.test.ts -- P5 proof for atomic publication and last-good
 * handling (plan 20260918-state-projection Task 5; contract §5/§6).
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { catalogRootDir, linkCatalogEntities, registerCatalogEntity, type CatalogOperation } from "./catalog.js";
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
  delete process.env.MSTAR_STORE_TEST_RUNNER;
});

type Fixture = {
  workspace: string;
  harness: string;
  context: StoreContext;
  iterationsDir: string;
  projectsDir: string;
};

async function fixture(name: string): Promise<Fixture> {
  const workspace = mkdtempSync(join(ROOT, name));
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
          metadata: { catalog_pin: { entity_revision: 4 } },
          execution_lease: {
            holder: "session-1",
            claimed_at: STARTED_AT,
            worktree_path: `/wt/${id}`,
            working_branch: `feature/${id}`,
            session_label: "must-never-be-projected",
          },
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
  roadmaps: Array<Record<string, unknown>>;
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
      roadmaps: db.prepare("select * from projection_roadmaps order by project_id asc").all() as Array<
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

describe("projection publication and last-good handling", () => {
  test("the first refresh publishes generation 1 with the projected rows, and an unchanged refresh publishes nothing", async () => {
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
    expect(first.sources).toHaveLength(5);
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
    // Presence + holder + worktree only: the session label never lands here.
    expect(rows.leases).toEqual([
      expect.objectContaining({ workflow_id: "wf-a", plan_id: "plan-wf-a", kind: "execution", holder: "session-1", worktree_path: "/wt/wf-a" }),
      expect.objectContaining({ workflow_id: "wf-a", plan_id: "plan-wf-a", kind: "integration-merge", holder: "session-2" }),
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
    expect(rows.roadmaps).toEqual([
      expect.objectContaining({ generation: 1, project_id: "proj-a", direction: "Direction-A ships the first slice." }),
    ]);
    expect(JSON.parse(String(rows.roadmaps[0]?.goals_json))).toEqual([
      { text: "first goal", checked: false },
      { text: "second goal", checked: true },
    ]);
    expect(JSON.parse(String(rows.roadmaps[0]?.milestones_json))).toEqual(["M1"]);

    const second = await refreshProjections(f.context);
    expect(second).toMatchObject({ freshness: "current", published: false, generation: 1, changedKeys: [] });
    expect(second.builtAt).toBe(first.builtAt);
    expect(second.checkedAt >= first.checkedAt).toBe(true);
    expect(await projectedRows(f)).toEqual((({ meta: _health, ...tables }) => tables)(rows));
  });

  test("a same-size, same-mtime content change publishes a new generation naming the changed key", async () => {
    const f = await fixture("same-mtime-");
    await seedStandard(f);
    const first = await refreshProjections(f.context);
    const roadmapPath = join(f.projectsDir, "proj-a/roadmap.md");
    const original = readFileSync(roadmapPath, "utf8");
    const stats = statSync(roadmapPath);

    writeFileSync(roadmapPath, original.replace("Direction-A", "Direction-B"));
    utimesSync(roadmapPath, stats.atime, stats.mtime);
    const touched = statSync(roadmapPath);
    expect(touched.size).toBe(stats.size);
    expect(Math.abs(touched.mtimeMs - stats.mtimeMs)).toBeLessThan(2);

    const second = await refreshProjections(f.context);
    expect(second).toMatchObject({ freshness: "current", published: true, generation: 2 });
    expect(second.changedKeys).toEqual(["roadmap:projects:proj-a/roadmap.md"]);
    const rows = await projections(f);
    expect(rows.meta).toMatchObject({ generation: 2, source_set_hash: second.sourceSetHash });
    // Only the new generation's rows exist (the old one is retired in place).
    expect(rows.roadmaps).toHaveLength(1);
    expect(rows.roadmaps[0]).toMatchObject({ generation: 2, direction: "Direction-B ships the first slice." });
    expect(rows.sources.every((source) => source.generation === 2)).toBe(true);
    expect(second.generation).toBe((first.generation ?? 0) + 1);
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

    // A later successful refresh clears the diagnostic again. The restored
    // bytes are exactly the published generation's, so nothing is reinserted:
    // the generation is adopted and only its health is refreshed.
    write(join(f.harness, "workflows/wf-a/snapshot.json"), snapshotDoc("wf-a"));
    const recovered = await refreshProjections(f.context);
    expect(recovered).toMatchObject({
      freshness: "current",
      published: false,
      generation: first.generation,
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
    rmSync(join(f.projectsDir, "proj-a/roadmap.md"), { force: true });
    mkdirSync(join(f.projectsDir, "proj-a/roadmap.md"), { recursive: true });
    const inaccessible = await refreshProjections(f.context);
    expect(inaccessible).toMatchObject({ freshness: "stale", generation: first.generation });
    expect(inaccessible.diagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: "roadmap:projects:proj-a/roadmap.md", reason: "inaccessible" }),
    );
    expect((await projections(f)).roadmaps[0]).toMatchObject({ direction: "Direction-A ships the first slice." });
  });

  test("a source that changes while it is being read retains the last good generation with a named diagnostic", async () => {
    const f = await fixture("changed-during-read-");
    await seedStandard(f);
    const first = await refreshProjections(f.context);
    const publishedRows = await projectedRows(f);

    process.env.MSTAR_STORE_TEST_RUNNER = "1";
    process.env.MSTAR_PROJECTION_CHURN_PATH = "proj-a/roadmap.md";
    const moved = await refreshProjections(f.context);
    expect(moved).toMatchObject({ freshness: "stale", published: false, generation: first.generation, builtAt: first.builtAt });
    expect(moved.diagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: "roadmap:projects:proj-a/roadmap.md", reason: "changed-during-read" }),
    );
    expect(await projectedRows(f)).toEqual(publishedRows);
  });

  test("a source set that keeps moving is bounded: one retry, then source-changing with the last good generation", async () => {
    const f = await fixture("source-changing-");
    await seedStandard(f);
    const first = await refreshProjections(f.context);
    const publishedRows = await projectedRows(f);
    expect((await projections(f)).meta.last_error_json).toBeNull();

    process.env.MSTAR_STORE_TEST_RUNNER = "1";
    process.env.MSTAR_PROJECTION_CHURN_PATH = "status.json";
    const moved = await refreshProjections(f.context);
    expect(moved).toMatchObject({ freshness: "stale", published: false, generation: first.generation, builtAt: first.builtAt });
    expect(moved.diagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: "root:harness:status.json", reason: "source-changing" }),
    );
    // The failure is recorded as health; the generation itself is untouched.
    expect(JSON.parse(String((await projections(f)).meta.last_error_json))).toMatchObject({ code: "projection.stale" });
    expect(await projectedRows(f)).toEqual(publishedRows);
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
    expect([rows.workflows, rows.plans, rows.leases, rows.compasses, rows.roadmaps].every((table) => table.length === 0)).toBe(true);
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

  test("a competing refresh cannot publish an older capture over a newer one", async () => {
    const f = await fixture("competing-");
    await seedStandard(f);
    await refreshProjections(f.context);
    const older = await captureProjectionSources(f.context);

    // A newer writer declares another workflow and publishes a newer capture.
    write(join(f.harness, "workflows/wf-b/snapshot.json"), snapshotDoc("wf-b"));
    write(
      join(f.harness, "status.json"),
      rootDoc([{ id: "wf-a", dir: "workflows/wf-a" }, { id: "wf-b", dir: "workflows/wf-b" }]),
    );
    const newer = await refreshProjections(f.context);
    expect(newer).toMatchObject({ freshness: "current", published: true });
    expect(newer.sources.map((source) => source.sourceKey)).toContain("workflow:harness:workflows/wf-b/snapshot.json");

    // The older capture must not overwrite it.
    await expect(publishProjectionCapture(f.context, older)).rejects.toMatchObject({ code: "projection.source-stale" });
    const rows = await projections(f);
    expect(rows.meta).toMatchObject({ generation: newer.generation, source_set_hash: newer.sourceSetHash, freshness: "current" });
    expect(rows.workflows.map((workflow) => workflow.id)).toEqual(["wf-a", "wf-b"]);
    expect(rows.sources.length).toBe(newer.sources.length);

    // A capture that still matches publishes normally.
    const fresh = await captureProjectionSources(f.context);
    const republished = await publishProjectionCapture(f.context, fresh);
    expect(republished).toMatchObject({ freshness: "current", published: false, generation: newer.generation });
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
    const f = await fixture("schema-outdated-");
    await seedStandard(f);
    const handle = await openStore(f.context, "write");
    try {
      dropProjectionTables(handle.db);
      handle.db.exec("delete from schema_version where version = 3");
    } finally {
      handle.close();
    }
    // The pure capture still works (it reads no projection table) ...
    const capture = await captureProjectionSources(f.context);
    expect(capture.blocked).toBe(false);
    // ... and publication refuses with the upgrade pointer, writing nothing.
    await expect(refreshProjections(f.context)).rejects.toMatchObject({
      code: "projection.schema-outdated",
      message: expect.stringContaining("mstar store upgrade"),
    });
  });
});

function dropProjectionTables(db: StoreDb): void {
  for (const table of [
    "projection_roadmaps",
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
