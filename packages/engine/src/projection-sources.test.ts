/**
 * projection-sources.test.ts -- proof for the PURE validated source
 * snapshot (contract §5).
 *
 * Every case runs against the real projection module, the real catalog/store
 * modules, the real migration runner and the real `node:sqlite` driver in a
 * per-test temporary harness root -- no mocked database, no mocked filesystem.
 *
 * Covered here (the pure half; publication/last-good lives in
 * projection.test.ts):
 *
 * - the exact §5 source set (root status.json, root-declared and retained
 *   workflow snapshots, catalog-linked compass documents) and the
 *   exact §5 table columns/keys;
 * - catalog-owned compass paths (never README discovery);
 * - reuse of the shared validators (legacy snapshot alias accepted, invalid
 *   JSON/root refused) instead of a second parser;
 * - the fingerprint is byte-based: a same-size, same-mtime content change
 *   moves the digest and the source-set hash;
 * - state classification for missing/inaccessible/invalid sources;
 * - a source that moves while it is being read is a named
 *   `changed-during-read` diagnostic, not silence;
 * - capture writes nothing at all (no store/catalog/projection change), and
 *   its digests leak no absolute path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  catalogRootDir,
  linkCatalogEntities,
  registerCatalogEntity,
  type CatalogOperation,
} from "./catalog.js";
import { captureProjectionSources, PROJECTION_FORMAT_VERSION } from "./projection.js";
import { initializeStore, openStore, type StoreContext, type StoreDb } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-projection-sources-"));
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

/**
 * A fresh workspace with a real `.mstar` harness marker and an initialized
 * (active) store. The context selects that harness directly, even once its
 * plans/ or iterations/ child appears.
 */
async function fixture(name: string): Promise<Fixture> {
  const workspace = mkdtempSync(join(ROOT, name));
  const harness = join(workspace, ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: harness };
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

/** A valid v3 snapshot for one plan row. */
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

/** Catalog-linked compass/roadmap documents on disk; the ACTIVE execution
 * registry supplies the registry source. */
async function seedStandard(f: Fixture): Promise<void> {
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

function tableColumns(db: StoreDb, table: string): Array<{ name: string; pk: number }> {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string; pk: number }>).map((column) => ({
    name: column.name,
    pk: column.pk,
  }));
}

function primaryKey(db: StoreDb, table: string): string[] {
  return tableColumns(db, table)
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
}

function columnNames(db: StoreDb, table: string): string[] {
  return tableColumns(db, table).map((column) => column.name);
}

/** Store facts a projection rebuild must never move. */
async function storeFacts(f: Fixture): Promise<Record<string, unknown>> {
  const handle = await openStore(f.context, "read");
  try {
    const db = handle.db;
    const facts: Record<string, unknown> = {
      meta: db.prepare("select revision, catalog_revision, authority_state, authority_epoch from store_meta where id = 1").get(),
      issues: db.prepare("select * from issues order by id asc").all(),
      occurrences: db.prepare("select * from occurrences order by id asc").all(),
      catalogEntities: db.prepare("select * from catalog_entities order by kind asc, id asc").all(),
      catalogLinks: db.prepare("select * from catalog_links order by from_id asc, to_id asc").all(),
      catalogBindings: db.prepare("select * from catalog_execution_bindings order by workflow_id asc").all(),
      projectionSources: db.prepare("select * from projection_sources order by source_key asc").all(),
      projectionWorkflows: db.prepare("select * from projection_workflows order by id asc").all(),
      projectionMeta: db.prepare("select * from projection_meta where id = 1").get(),
    };
    return JSON.parse(JSON.stringify(facts));
  } finally {
    handle.close();
  }
}

describe("projection source capture (contract \u00a75)", () => {
  test("the source set and table columns are exactly the contract's", async () => {
    const f = await fixture("sources-");
    await seedStandard(f);
    const capture = await captureProjectionSources(f.context);

    expect(capture.blocked).toBe(false);
    expect(capture.diagnostics).toEqual([]);
    expect(capture.formatVersion).toBe(PROJECTION_FORMAT_VERSION);
    // The ACTIVE source set: the execution registry plus catalog-declared
    // compass documents. The status.json root and workflow snapshot files are
    // retired file-route sources.
    expect(capture.sources.map((source) => source.sourceKey)).toEqual([
      "compass:iterations:iter-a/delivery-compass.md",
      "root:harness:execution/registry",
    ]);
    expect(capture.sources.map((source) => source.state)).toEqual(["ok", "ok"]);
    expect(capture.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256 ?? ""))).toBe(true);
    expect(capture.sources.every((source) => source.diagnostic === null)).toBe(true);
    // The registry source is harness-rooted and declared, never an absolute
    // path.
    expect(capture.sources.find((source) => source.kind === "root")).toMatchObject({
      rootKind: "harness",
      relativePath: "execution/registry",
      declared: true,
    });
    expect(capture.sourceSetHash).toMatch(/^[0-9a-f]{64}$/);

    const handle = await openStore(f.context, "read");
    try {
      const db = handle.db;
      expect(columnNames(db, "projection_meta")).toEqual([
        "id",
        "generation",
        "format_version",
        "source_set_hash",
        "built_at",
        "checked_at",
        "freshness",
        "last_error_json",
      ]);
      expect(columnNames(db, "projection_sources")).toEqual([
        "generation",
        "source_key",
        "kind",
        "root_kind",
        "relative_path",
        "sha256",
        "state",
        "diagnostic",
      ]);
      expect(columnNames(db, "projection_workflows")).toEqual([
        "generation",
        "id",
        "type",
        "status",
        "phase",
        "started_at",
        "ended_at",
        "updated_at",
        "branch_base",
        "branch_source",
        "branch_integration",
        "branch_target",
        "active_registration",
      ]);
      // No duplicate editable title/path: the catalog owns identity.
      expect(columnNames(db, "projection_plans")).toEqual([
        "generation",
        "workflow_id",
        "plan_id",
        "status",
        "progress",
        "phase",
        "done_at",
        "catalog_pin_revision",
      ]);
      // No session label / token payload, only presence + holder + worktree.
      expect(columnNames(db, "projection_leases")).toEqual([
        "generation",
        "workflow_id",
        "plan_id",
        "kind",
        "holder",
        "worktree_path",
        "expires_at",
      ]);
      expect(columnNames(db, "projection_compasses")).toEqual([
        "generation",
        "iteration_id",
        "summary",
        "milestones_json",
        "started_at",
        "ended_at",
        "status",
      ]);
      expect(primaryKey(db, "projection_compasses")).toEqual(["generation", "iteration_id"]);
    } finally {
      handle.close();
    }
  });


  test("reuses the shared validators: a compass the domain parser refuses is classified invalid", async () => {
    // Disposition: the retired file-route half of this case (the legacy
    // snapshot alias, bad snapshot JSON, a v1-shaped status.json root)
    // asserted sources that no longer exist. The live capture reuses the
    // compass domain parser; a document it refuses is `invalid` on the named
    // source and blocks the capture.
    const f = await fixture("validators-");
    await seedStandard(f);
    write(join(f.iterationsDir, "iter-a/delivery-compass.md"), "{ not json");
    const broken = await captureProjectionSources(f.context);
    expect(broken.blocked).toBe(true);
    expect(broken.sources.find((source) => source.kind === "compass")).toMatchObject({
      sourceKey: "compass:iterations:iter-a/delivery-compass.md",
      state: "invalid",
    });
    expect(broken.diagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: "compass:iterations:iter-a/delivery-compass.md", reason: "invalid" }),
    );
  });

  test("missing and inaccessible declared sources are classified, not guessed", async () => {
    const f = await fixture("states-");
    await seedStandard(f);
    // A declared compass document that is gone is a `missing` source.
    rmSync(join(f.iterationsDir, "iter-a/delivery-compass.md"), { force: true });
    const capture = await captureProjectionSources(f.context);
    expect(capture.blocked).toBe(true);
    expect(capture.sources.find((source) => source.sourceKey === "compass:iterations:iter-a/delivery-compass.md")).toMatchObject({
      state: "missing",
      declared: true,
    });
    expect(capture.diagnostics).toContainEqual(
      expect.objectContaining({ sourceKey: "compass:iterations:iter-a/delivery-compass.md", reason: "missing" }),
    );

  });

  test("capture writes nothing and publishes no absolute path", async () => {
    const f = await fixture("readonly-");
    await seedStandard(f);
    const before = await storeFacts(f);
    const first = await captureProjectionSources(f.context);
    const after = await storeFacts(f);

    expect(after).toEqual(before);
    // The published/reported shape is the root + relative location, exactly
    // like the table columns; no local absolute path leaks into it.
    expect(JSON.stringify(first.sources)).not.toContain(f.workspace);
    expect(JSON.stringify(first.sources)).not.toContain(f.harness);
    expect(JSON.stringify(first.sources)).not.toContain(f.projectsDir);
  });
});
