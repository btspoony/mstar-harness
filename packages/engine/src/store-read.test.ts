/**
 * store-read.test.ts -- proof for the issue-store read boundary
 * (contract §6).
 *
 * Every case runs against the real read boundary, the real issue/catalog
 * modules, the real projection refresh, the real migration runner and the real
 * `node:sqlite` driver in a per-test temporary harness root. No mock database
 * exists anywhere in this proof.
 *
 * Covered here:
 *
 * - one request = one read handle and ONE read transaction: a concurrent writer
 *   (its own connection, committing during the transaction) cannot change what
 *   the envelope's view data or revisions report;
 * - the issue views answer exactly what the issue domain's own readers answer,
 *   with stable ordering and pagination;
 * - old-generation disclosure survives current issue edits, and an issue-only
 *   read never triggers the refresh;
 * - unknown historical dates are counted and disclosed, never imputed into a
 *   bucket;
 * - every terminal disposition counts as retired (no "fixed"/"resolved"
 *   metric), with the authoritative current open count reported separately;
 * - projected workflow/iteration/roadmap DTOs join the catalog by id and
 *   disclose a missing link or pin as a badge instead of guessing;
 * - an unavailable projection is disclosed as unavailable, not as zero work;
 * - a store that cannot be served (missing, staged) fails instead of returning
 *   an empty result set.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { catalogRootDir, getCatalog, linkCatalogEntities, registerCatalogEntity, updateCatalogEntity, type CatalogOperation } from "./catalog.js";
import { getIssue, listIssues, type Disposition, type Severity } from "./issue.js";
import { refreshProjections } from "./projection.js";
import { importRoadmapAuthority, replaceRoadmapAuthority, reviewRoadmapImport } from "./roadmap-store.js";
import { initializeStore, openStore, storeDbPath, type StoreContext, type StoreDb } from "./store-db.js";
import {
  queryDashboard,
  queryIssueFlow,
  StoreReadError,
  withStoreRead,
  type IssueFlow,
  type WorkflowDTO,
} from "./store-read.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-read-"));
const STARTED_AT = "2026-09-18T01:00:00.000Z";
const RECORDED_AT = "2026-09-18T02:00:00.000Z";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.MSTAR_STORE_TEST_RUNNER;
});

type Fixture = { dir: string; harness: string; context: StoreContext };

async function workspace(name: string): Promise<Fixture> {
  const dir = mkdtempSync(join(ROOT, name));
  const harness = join(dir, ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: dir };
  const handle = await initializeStore(context);
  handle.close();
  return { dir, harness, context };
}

async function withWrite(context: StoreContext, fn: (db: StoreDb) => void): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    fn(handle.db);
  } finally {
    handle.close();
  }
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function op(operationId: string): CatalogOperation {
  return { operationId, actor: "project-manager" };
}

// ---------------------------------------------------------------------------
// Issue fixtures (direct rows: the read side is what this suite proves)
// ---------------------------------------------------------------------------

type SeedIssue = {
  id: string;
  title: string;
  projectId?: string;
  kind?: string;
  severity?: Severity;
  disposition?: Disposition;
  registeredAt?: string | null;
  closedAt?: string | null;
  /** A migrated record: the imported capture occurrence carries the import marker. */
  importedOccurrence?: boolean;
  /** A migrated closure: the imported terminal transition carries the marker. */
  importedTransition?: boolean;
};

function seedIssue(db: StoreDb, seed: SeedIssue): void {
  db.prepare(
    "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, closed_at, created_at, updated_at, revision, identity_key) " +
      "values (?, ?, ?, ?, ?, ?, 'impact', 'acceptance', ?, ?, ?, ?, 1, ?)",
  ).run(
    seed.id,
    seed.projectId ?? "proj-a",
    seed.title,
    seed.kind ?? "bug",
    seed.severity ?? "medium",
    seed.disposition ?? "open",
    seed.registeredAt ?? null,
    seed.closedAt ?? null,
    RECORDED_AT,
    RECORDED_AT,
    `identity-${seed.id}`,
  );
  if (seed.importedOccurrence === true) {
    db.prepare(
      "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at, imported) " +
        "values (?, ?, 'legacy', 'src', 'rc', 'ac', 'loc', 'obs', '[]', null, ?, 1)",
    ).run(seed.id, `occ-${seed.id}`, RECORDED_AT);
  }
  if (seed.importedTransition === true) {
    db.prepare(
      "insert into issue_transitions(issue_id, from_disposition, to_disposition, occurred_at, recorded_at, reason, evidence_json, imported, issue_revision) " +
        "values (?, 'open', ?, ?, ?, 'migrated', '{}', 1, 1)",
    ).run(seed.id, seed.disposition ?? "resolved", seed.closedAt ?? null, RECORDED_AT);
  }
}

function issueCount(db: StoreDb): number {
  return (db.prepare("select count(*) as n from issues").get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Projection fixture (root status.json + one plan workflow + catalog inputs)
// ---------------------------------------------------------------------------

function snapshotDoc(id: string, pinRevision: number): string {
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
          id: "wf-read",
          title: "Plan wf-read",
          file: "/plans/wf-read.md",
          status: "InProgress",
          coordination: { revision: 1, progress: { status: "InProgress", summary: "half way", evidence_paths: [] } },
          metadata: { catalog_pin: { entity_revision: pinRevision } },
          execution_lease: {
            holder: "session-1",
            claimed_at: STARTED_AT,
            worktree_path: "/wt/wf-read",
            working_branch: `feature/${id}`,
            session_label: "must-never-be-projected",
          },
        },
      ],
      integration_merge_lease: {
        holder: "session-2",
        claimed_at: STARTED_AT,
        plan_id: "wf-read",
        source_branch: `feature/${id}`,
        target_branch: "main",
      },
    },
    null,
    2,
  );
}

function statusDoc(id: string, dir: string): string {
  return JSON.stringify(
    {
      version: 2,
      updated_at: "2026-09-18",
      workflows: [{ id, type: "plan", started_at: STARTED_AT, dir }],
    },
    null,
    2,
  );
}

const COMPASS_DOC = [
  "---",
  "iteration_id: iter-read",
  "start_date: 2026-09-18",
  "status: active",
  "iteration_base_branch: main",
  "target_branch: main",
  "plans:",
  "  - wf-read",
  "---",
  "",
  "# iter-read Delivery Compass",
  "",
  "Reading the issue store is the whole point of this iteration.",
  "",
  "## Milestones",
  "",
  "| Milestone | Target date | Status |",
  "|-----------|-------------|--------|",
  "| Read boundary | 2026-09-20 | pending |",
  "",
].join("\n");

const ROADMAP_DOC = [
  "---",
  "project_id: proj-a",
  "title: Project A",
  "status: active",
  "created_at: 2026-09-01",
  "milestones:",
  "  - Read boundary",
  "---",
  "",
  "# proj-a Roadmap",
  "",
  "## Direction",
  "",
  "Serve the dashboard from the store, never from source JSON.",
  "",
  "## Goals",
  "",
  "- [x] Ship the read boundary",
  "- [ ] Ship the dashboard",
  "",
].join("\n");

/**
 * A workspace with a published projection generation 1: one plan workflow with
 * a catalog plan row, an iteration with a compass document, and a project with
 * a roadmap document.
 */
async function projectedWorkspace(name: string): Promise<Fixture & { generation: number; planRevision: number }> {
  const fixture = await workspace(name);
  const { context } = fixture;

  await registerCatalogEntity(
    context,
    { kind: "project", id: "proj-a", title: "Project A", rootKind: "projects", relativePath: "proj-a" },
    op("proj"),
  );
  await registerCatalogEntity(
    context,
    { kind: "plan", id: "wf-read", title: "Plan wf-read", rootKind: "plans", relativePath: "wf-read.md" },
    op("plan"),
  );
  await registerCatalogEntity(
    context,
    { kind: "iteration", id: "iter-read", title: "Iteration read", rootKind: "iterations", relativePath: "iter-read" },
    op("iter"),
  );
  await registerCatalogEntity(
    context,
    {
      kind: "document",
      id: "doc-compass",
      title: "Compass",
      rootKind: "iterations",
      relativePath: "iter-read/delivery-compass.md",
      documentKind: "compass",
    },
    op("compass"),
  );
  await registerCatalogEntity(
    context,
    {
      kind: "document",
      id: "doc-roadmap",
      title: "Roadmap",
      rootKind: "projects",
      relativePath: "proj-a/roadmap.md",
      documentKind: "roadmap",
    },
    op("roadmap"),
  );
  await linkCatalogEntities(
    context,
    { from: { kind: "plan", id: "wf-read" }, relation: "belongs-to", to: { kind: "project", id: "proj-a" } },
    op("link-plan-project"),
  );
  await linkCatalogEntities(
    context,
    { from: { kind: "plan", id: "wf-read" }, relation: "belongs-to", to: { kind: "iteration", id: "iter-read" } },
    op("link-plan-iteration"),
  );
  await linkCatalogEntities(
    context,
    { from: { kind: "iteration", id: "iter-read" }, relation: "belongs-to", to: { kind: "project", id: "proj-a" } },
    op("link-iteration-project"),
  );
  await linkCatalogEntities(
    context,
    { from: { kind: "iteration", id: "iter-read" }, relation: "documents", to: { kind: "document", id: "doc-compass" } },
    op("link-compass"),
  );
  await linkCatalogEntities(
    context,
    { from: { kind: "project", id: "proj-a" }, relation: "documents", to: { kind: "document", id: "doc-roadmap" } },
    op("link-roadmap"),
  );

  writeFile(join(catalogRootDir(context, "iterations"), "iter-read/delivery-compass.md"), COMPASS_DOC);
  writeFile(join(catalogRootDir(context, "projects"), "proj-a/roadmap.md"), ROADMAP_DOC);
  const project = await getCatalog(context, { kind: "project", id: "proj-a" });
  const review = await reviewRoadmapImport(context, "proj-a", join(catalogRootDir(context, "projects"), "proj-a/roadmap.md"));
  expect(review.expectedProjectRevision).toBe(project.entity.revision);
  await importRoadmapAuthority(context, review, op("roadmap-authority"));

  // The frozen pin must be the catalog revision this prepare actually saw:
  // a link also bumps its from-row revision, so it is read back here.
  const plan = await getCatalog(context, { kind: "plan", id: "wf-read" });
  writeFile(join(fixture.harness, "status.json"), statusDoc("wf-read", "workflows/wf-read"));
  writeFile(join(fixture.harness, "workflows/wf-read/snapshot.json"), snapshotDoc("wf-read", plan.entity.revision));

  const report = await refreshProjections(context);
  if (report.generation === null) throw new Error(`fixture: projection not published (${report.freshness})`);
  return { ...fixture, generation: report.generation, planRevision: plan.entity.revision };
}

// ---------------------------------------------------------------------------

describe("read envelope and transaction", () => {
  test("one request discloses the store, catalog and projection revisions it read at", async () => {
    const { context, generation } = await projectedWorkspace("envelope-");
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    expect(envelope.storeRevision).toBeGreaterThan(0);
    expect(envelope.catalogRevision).toBeGreaterThan(0);
    expect(envelope.projection.generation).toBe(generation);
    expect(envelope.projection.freshness).toBe("current");
    expect(envelope.projection.builtAt).not.toBeNull();
    expect(envelope.projection.diagnostics).toEqual([]);
    expect(envelope.data.items.map((item) => item.id)).toEqual(["wf-read"]);
  });

  test("a concurrent writer cannot change what the open read transaction reports", async () => {
    const { context } = await workspace("snapshot-");
    await withWrite(context, (db) => seedIssue(db, { id: "I-000001", title: "before", registeredAt: "2026-09-01" }));
    const dbPath = storeDbPath(context);
    const beforeRevision = (await (async () => {
      const handle = await openStore(context, "read");
      try {
        return (handle.db.prepare("select revision as n from store_meta where id = 1").get() as { n: number }).n;
      } finally {
        handle.close();
      }
    })());

    // The writer commits on its own connection while the read transaction is
    // open (WAL: readers do not block writers, and vice versa). Every question
    // this request answers must still describe the pre-write snapshot.
    const envelope = await withStoreRead(context, {
      view: "concurrency-probe",
      needsProjection: false,
      run: (handle) => {
        const first = issueCount(handle.db);
        const writer: StoreDb = new DatabaseSync(dbPath);
        try {
          seedIssue(writer, { id: "I-000002", title: "after", registeredAt: "2026-09-02" });
          writer.exec("update store_meta set revision = revision + 7 where id = 1");
        } finally {
          writer.close();
        }
        return { first, afterWrite: issueCount(handle.db) };
      },
    });
    expect(envelope.data.first).toBe(1);
    expect(envelope.data.afterWrite).toBe(1);
    expect(envelope.storeRevision).toBe(beforeRevision);

    const later = await withStoreRead(context, queryDashboard("issues", { issue: { disposition: "open" } }));
    expect(later.data.total).toBe(2);
    expect(later.storeRevision).toBe(beforeRevision + 7);
  });

  test("a missing store fails instead of returning empty findings", async () => {
    const dir = mkdtempSync(join(ROOT, "no-store-"));
    mkdirSync(join(dir, ".mstar"), { recursive: true });
    const context: StoreContext = { harnessDir: dir };
    await expect(withStoreRead(context, queryDashboard("issues"))).rejects.toMatchObject({ code: "store.not-initialized" });
    await expect(withStoreRead(context, queryDashboard("workflows"))).rejects.toMatchObject({ code: "store.not-initialized" });
    await expect(withStoreRead(context, queryIssueFlow())).rejects.toMatchObject({ code: "store.not-initialized" });
  });

  test("a staged store is refused, never served as read authority", async () => {
    const { context } = await workspace("staged-");
    await withWrite(context, (db) => {
      seedIssue(db, { id: "I-000001", title: "staged finding", registeredAt: "2026-09-01" });
      db.exec("update store_meta set authority_state = 'staged' where id = 1");
    });
    const failure = await withStoreRead(context, queryDashboard("issues")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StoreReadError);
    expect((failure as StoreReadError).code).toBe("store.not-active");
    expect((failure as Error).message).toContain("staged");
  });

  test("a store without the projection schema refuses with the upgrade path", async () => {
    const { context } = await workspace("pre-projection-");
    await withWrite(context, (db) => {
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
      db.prepare("delete from schema_version where version >= 3").run();
    });
    const failure = await withStoreRead(context, queryDashboard("issues")).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "projection.schema-outdated" });
    expect((failure as Error).message).toContain("mstar store upgrade");
  });

  test("request shapes outside the contract are usage refusals, not empty pages", async () => {
    const { context } = await workspace("usage-");
    expect(() => queryDashboard("nope" as never)).toThrow(/unknown dashboard view/);
    await expect(withStoreRead(context, { view: "issues" } as never)).rejects.toMatchObject({ exitCode: 2 });
    await expect(withStoreRead(context, queryDashboard("issue-detail"))).rejects.toMatchObject({ exitCode: 2 });
    await expect(withStoreRead(context, queryDashboard("workflow-detail"))).rejects.toMatchObject({ exitCode: 2 });
    await expect(withStoreRead(context, queryDashboard("roadmap"))).rejects.toMatchObject({ exitCode: 2 });
    await expect(withStoreRead(context, queryDashboard("issues", { issue: { limit: 201 } }))).rejects.toMatchObject({ exitCode: 2 });
    await expect(withStoreRead(context, queryDashboard("issues", { issue: { offset: -1 } }))).rejects.toMatchObject({ exitCode: 2 });
    await expect(withStoreRead(context, queryDashboard("issues", { issue: { kind: "toString" as never } }))).rejects.toMatchObject({
      exitCode: 2,
    });
    await expect(withStoreRead(context, queryDashboard("issues", { issue: { disposition: "fixed" as never } }))).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});

describe("issue views", () => {
  test("the issues view answers the issue domain's own reader, with stable paging and filters", async () => {
    const { context } = await workspace("issues-");
    await withWrite(context, (db) => {
      seedIssue(db, { id: "I-000001", title: "critical old", severity: "critical", registeredAt: "2026-09-01" });
      seedIssue(db, { id: "I-000002", title: "high newer", severity: "high", registeredAt: "2026-09-10" });
      seedIssue(db, { id: "I-000003", title: "high older", severity: "high", registeredAt: "2026-09-02" });
      seedIssue(db, { id: "I-000004", title: "unknown activity", severity: "high", registeredAt: null });
      seedIssue(db, { id: "I-000005", title: "retired", disposition: "resolved", registeredAt: "2026-09-03", closedAt: "2026-09-04" });
      seedIssue(db, { id: "I-000006", title: "risk item", kind: "risk", severity: "low", registeredAt: "2026-09-05" });
      db.prepare(
        "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at, imported) " +
          "values ('I-000006', 'occ-6', 'audit', 'src', 'rc', 'ac', 'src/writer.ts', 'Race in writer', '[]', '2026-09-05T00:00:00.000Z', ?, 0)",
      ).run(RECORDED_AT);
    });

    const full = await withStoreRead(context, queryDashboard("issues"));
    const domain = await listIssues(context, {});
    expect(full.data).toEqual(domain);
    // Severity rank desc, then last real activity desc with a null date last.
    expect(full.data.items.map((item) => item.id)).toEqual(["I-000001", "I-000002", "I-000003", "I-000004", "I-000006"]);

    const first = await withStoreRead(context, queryDashboard("issues", { issue: { limit: 2, offset: 0 } }));
    const second = await withStoreRead(context, queryDashboard("issues", { issue: { limit: 2, offset: 2 } }));
    const third = await withStoreRead(context, queryDashboard("issues", { issue: { limit: 2, offset: 4 } }));
    expect([...first.data.items, ...second.data.items, ...third.data.items].map((item) => item.id)).toEqual(
      full.data.items.map((item) => item.id),
    );
    expect(first.data.total).toBe(5);

    const filtered = await withStoreRead(
      context,
      queryDashboard("issues", { issue: { disposition: "open", severity: "high", kind: "bug" } }),
    );
    expect(filtered.data.items.map((item) => item.id)).toEqual(["I-000002", "I-000003", "I-000004"]);

    const searched = await withStoreRead(context, queryDashboard("issues", { issue: { query: "HIGH" } }));
    expect(searched.data.items.map((item) => item.id)).toEqual(["I-000002", "I-000003"]);

    const byEvidence = await withStoreRead(context, queryDashboard("issues", { issue: { query: "race in writer" } }));
    expect(byEvidence.data.items.map((item) => item.id)).toEqual(["I-000006"]);

    const retired = await withStoreRead(context, queryDashboard("issues", { issue: { disposition: "resolved" } }));
    expect(retired.data.items.map((item) => item.id)).toEqual(["I-000005"]);
  });

  test("issue-detail answers the issue domain's own reader", async () => {
    const { context } = await workspace("detail-");
    await withWrite(context, (db) => {
      seedIssue(db, { id: "I-000001", title: "detail", registeredAt: "2026-09-01" });
      db.prepare(
        "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at, imported) " +
          "values ('I-000001', 'occ-1', 'audit', 'src', 'rc', 'ac', 'loc', 'obs', '[\"a note\"]', '2026-09-01T00:00:00.000Z', ?, 0)",
      ).run(RECORDED_AT);
      db.prepare("insert into provenance(issue_id, kind, target, source_hash) values ('I-000001', 'capture', 'audit/x.md', 'hash')").run();
    });
    const envelope = await withStoreRead(context, queryDashboard("issue-detail", { id: "I-000001" }));
    expect(envelope.data).toEqual(await getIssue(context, "I-000001"));
    expect(envelope.data.occurrences).toHaveLength(1);
    await expect(withStoreRead(context, queryDashboard("issue-detail", { id: "I-999999" }))).rejects.toMatchObject({
      code: "issue.not-found",
    });
  });
});

describe("issue flow", () => {
  test("unknown historical dates are disclosed, never imputed into a bucket", async () => {
    const { context } = await workspace("flow-unknown-");
    await withWrite(context, (db) => {
      seedIssue(db, { id: "I-000001", title: "dated capture", registeredAt: "2026-09-01" });
      seedIssue(db, {
        id: "I-000002",
        title: "imported, no capture date",
        disposition: "resolved",
        registeredAt: null,
        closedAt: "2026-09-05",
        importedOccurrence: true,
        importedTransition: true,
      });
      seedIssue(db, { id: "I-000003", title: "closure date unknown", disposition: "resolved", registeredAt: "2026-09-10" });
    });

    const flow = await withStoreRead(context, queryIssueFlow());
    expect(flow.data.buckets.map((bucket) => bucket.date)).toEqual(["2026-09-01", "2026-09-05", "2026-09-10"]);
    expect(flow.data.unknownCaptureDates).toBe(1);
    expect(flow.data.unknownClosureDates).toBe(1);
    expect(flow.data.incompleteHistory).toBe(true);
    expect(flow.data.currentOpen).toBe(1);
    // The undated capture is counted, never placed on a "today" bucket.
    expect(flow.data.buckets.some((bucket) => bucket.date === new Date().toISOString().slice(0, 10))).toBe(false);
    expect(Object.keys(flow.data).sort()).toEqual([
      "buckets",
      "currentOpen",
      "incompleteHistory",
      "unknownCaptureDates",
      "unknownClosureDates",
    ]);
  });

  test("every terminal disposition counts as retired, never as fixed", async () => {
    const { context } = await workspace("flow-terminal-");
    await withWrite(context, (db) => {
      seedIssue(db, { id: "I-000001", title: "resolved", disposition: "resolved", registeredAt: "2026-09-01", closedAt: "2026-09-02" });
      seedIssue(db, { id: "I-000002", title: "waived", disposition: "waived", registeredAt: "2026-09-01", closedAt: "2026-09-02" });
      seedIssue(db, { id: "I-000003", title: "duplicate", disposition: "duplicate", registeredAt: "2026-09-01", closedAt: "2026-09-03" });
      seedIssue(db, {
        id: "I-000004",
        title: "superseded",
        disposition: "superseded",
        registeredAt: "2026-09-01",
        closedAt: "2026-09-03",
        importedOccurrence: true,
        importedTransition: true,
      });
      seedIssue(db, { id: "I-000005", title: "still open", registeredAt: "2026-09-04" });
    });

    const flow = await withStoreRead(context, queryIssueFlow());
    const last = flow.data.buckets[flow.data.buckets.length - 1] as IssueFlow["buckets"][number];
    expect(flow.data.buckets.map((bucket) => bucket.retiredCumulative)).toEqual([0, 2, 4, 4]);
    expect(last.retiredCumulative).toBe(4);
    expect(last.capturedCumulative).toBe(5);
    expect(last.openDifference).toBe(1);
    expect(flow.data.currentOpen).toBe(1);
    expect(flow.data.unknownClosureDates).toBe(0);
    // No per-disposition breakdown and no invented metric ever appears.
    const serialized = JSON.stringify(flow.data);
    for (const forbidden of ["resolvedCumulative", "fixed", "velocity", "severityDrift", "statusDuration"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("register-history days are distinguishable from local store days", async () => {
    const { context } = await workspace("flow-origin-");
    await withWrite(context, (db) => {
      seedIssue(db, {
        id: "I-000001",
        title: "migrated finding",
        disposition: "resolved",
        registeredAt: "2026-08-01",
        closedAt: "2026-08-02",
        importedOccurrence: true,
        importedTransition: true,
      });
      seedIssue(db, { id: "I-000002", title: "new finding", registeredAt: "2026-09-01" });
    });
    const flow = await withStoreRead(context, queryIssueFlow());
    expect(flow.data.buckets).toEqual([
      { date: "2026-08-01", capturedCumulative: 1, retiredCumulative: 0, openDifference: 1, origin: "register-history" },
      { date: "2026-08-02", capturedCumulative: 1, retiredCumulative: 1, openDifference: 0, origin: "register-history" },
      { date: "2026-09-01", capturedCumulative: 2, retiredCumulative: 1, openDifference: 1, origin: "store" },
    ]);
  });

  test("the flow is project-scoped and issue-only (no projection refresh)", async () => {
    const { context } = await workspace("flow-scope-");
    await withWrite(context, (db) => {
      seedIssue(db, { id: "I-000001", projectId: "proj-a", title: "a", registeredAt: "2026-09-01" });
      seedIssue(db, { id: "I-000002", projectId: "proj-b", title: "b", registeredAt: "2026-09-02" });
    });
    const scoped = await withStoreRead(context, queryIssueFlow("proj-b"));
    expect(scoped.data.buckets).toEqual([
      { date: "2026-09-02", capturedCumulative: 1, retiredCumulative: 0, openDifference: 1, origin: "store" },
    ]);
    expect(scoped.data.currentOpen).toBe(1);
    // The projection was never published by this read.
    const handle = await openStore(context, "read");
    try {
      expect((handle.db.prepare("select generation, freshness from projection_meta where id = 1").get() as {
        generation: number | null;
        freshness: string;
      })).toEqual({ generation: null, freshness: "unavailable" });
    } finally {
      handle.close();
    }
  });
});

describe("projection views", () => {
  test("old-generation disclosure survives current issue edits", async () => {
    const { context, generation } = await projectedWorkspace("old-generation-");
    const published = await withStoreRead(context, queryDashboard("workflows"));
    const builtAt = published.projection.builtAt;

    await withWrite(context, (db) => seedIssue(db, { id: "I-000001", title: "edited later", registeredAt: "2026-09-18" }));

    // An issue-only read never refreshes, and still discloses the generation.
    const issues = await withStoreRead(context, queryDashboard("issues"));
    expect(issues.data.total).toBe(1);
    expect(issues.projection.generation).toBe(generation);
    expect(issues.projection.builtAt).toBe(builtAt);
    expect(issues.projection.freshness).toBe("current");

    // A projection read refreshes, finds nothing moved, and still reports the
    // same generation and build time -- an issue edit is not a projection move.
    const refreshed = await withStoreRead(context, queryDashboard("workflows"));
    expect(refreshed.projection.generation).toBe(generation);
    expect(refreshed.projection.builtAt).toBe(builtAt);
    expect(refreshed.projection.freshness).toBe("current");
    expect(refreshed.data.items.map((item) => item.id)).toEqual(["wf-read"]);
  });

  test("workflows join the catalog by id and never leak a session payload", async () => {
    const { context, planRevision } = await projectedWorkspace("workflow-join-");
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    const workflow = envelope.data.items[0] as WorkflowDTO;
    expect(workflow.type).toBe("plan");
    expect(workflow.status).toBe("running");
    expect(workflow.phase).toBe("phase-2-execute");
    expect(workflow.activeRegistration).toBe(true);
    expect(workflow.catalog?.id).toBe("wf-read");
    expect(workflow.catalog?.kind).toBe("plan");
    expect(workflow.badges).toEqual([]);
    expect(workflow.plans.map((plan) => plan.planId)).toEqual(["wf-read"]);
    expect(workflow.plans[0]?.progress).toBe("half way");
    expect(workflow.plans[0]?.catalogPinRevision).toBe(planRevision);
    expect(workflow.plans[0]?.badges).toEqual([]);
    expect(workflow.plans[0]?.leases.map((lease) => lease.kind)).toEqual(["execution", "integration-merge"]);
    expect(workflow.plans[0]?.leases[0]?.worktreePath).toBe("/wt/wf-read");
    expect(JSON.stringify(envelope)).not.toContain("must-never-be-projected");
    expect(JSON.stringify(envelope)).not.toContain("session_label");

    const detail = await withStoreRead(context, queryDashboard("workflow-detail", { id: "wf-read" }));
    expect(detail.data).toEqual(workflow);
    expect((await withStoreRead(context, queryDashboard("workflow-detail", { id: "nope" }))).data).toBeNull();
  });

  test("a missing catalog link is a badge, not a guessed join", async () => {
    const { context, harness } = await workspace("workflow-unlinked-");
    writeFile(join(harness, "status.json"), statusDoc("wf-read", "workflows/wf-read"));
    writeFile(join(harness, "workflows/wf-read/snapshot.json"), snapshotDoc("wf-read", 3));
    await refreshProjections(context);

    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    const workflow = envelope.data.items[0] as WorkflowDTO;
    expect(workflow.catalog).toBeNull();
    expect(workflow.badges).toEqual(["catalog-missing"]);
    expect(workflow.plans[0]?.catalog).toBeNull();
    // The frozen pin is disclosed even when the catalog row it refers to is gone.
    expect(workflow.plans[0]?.catalogPinRevision).toBe(3);
    expect(workflow.plans[0]?.badges).toEqual(["catalog-missing"]);
  });

  test("a moved catalog revision after prepare is an explicit pin conflict", async () => {
    const { context, planRevision } = await projectedWorkspace("workflow-pin-");
    await updateCatalogEntity(context, { kind: "plan", id: "wf-read" }, { title: "Renamed plan" }, planRevision, op("rename"));
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    const workflow = envelope.data.items[0] as WorkflowDTO;
    expect(workflow.catalog?.title).toBe("Renamed plan");
    expect(workflow.catalog?.revision).toBe(planRevision + 1);
    expect(workflow.plans[0]?.catalogPinRevision).toBe(planRevision);
    expect(workflow.plans[0]?.badges).toEqual(["catalog-pin-conflict"]);
  });

  test("an iteration discloses catalog plan and document membership before any workflow starts", async () => {
    const { context } = await projectedWorkspace("iteration-");
    const envelope = await withStoreRead(context, queryDashboard("iterations"));
    const iteration = envelope.data.items[0];
    expect(envelope.data.total).toBe(1);
    expect(iteration?.iterationId).toBe("iter-read");
    expect(iteration?.catalog?.title).toBe("Iteration read");
    expect(iteration?.compass?.summary).toContain("Reading the issue store");
    expect(iteration?.compass?.milestones).toEqual([{ milestone: "Read boundary", target: "2026-09-20", status: "pending" }]);
    expect(iteration?.plans.map((plan) => plan.planId)).toEqual(["wf-read"]);
    expect(iteration?.plans[0]?.execution?.workflowId).toBe("wf-read");
    expect(iteration?.plans[0]?.execution?.progress).toBe("half way");
    expect(iteration?.documents.map((document) => document.id)).toEqual(["doc-compass"]);
    expect(iteration?.badges).toEqual([]);

    // A catalog-only iteration (no execution at all) still exists.
    await registerCatalogEntity(
      context,
      { kind: "iteration", id: "iter-planned", title: "Iteration planned", rootKind: "iterations", relativePath: "iter-planned" },
      op("iter-planned"),
    );
    await registerCatalogEntity(
      context,
      { kind: "plan", id: "plan-planned", title: "Planned plan", rootKind: "plans", relativePath: "plan-planned.md" },
      op("plan-planned"),
    );
    await linkCatalogEntities(
      context,
      { from: { kind: "plan", id: "plan-planned" }, relation: "belongs-to", to: { kind: "iteration", id: "iter-planned" } },
      op("link-planned"),
    );
    const listed = await withStoreRead(context, queryDashboard("iterations", { limit: 200 }));
    const planned = listed.data.items.find((item) => item.iterationId === "iter-planned");
    expect(planned?.compass).toBeNull();
    expect(planned?.plans.map((plan) => plan.planId)).toEqual(["plan-planned"]);
    expect(planned?.plans[0]?.catalog?.title).toBe("Planned plan");
    expect(planned?.plans[0]?.execution).toBeNull();
    expect(planned?.plans[0]?.badges).toEqual(["execution-unavailable"]);
    const ordered = listed.data.items.map((item) => item.catalog?.title);
    expect(ordered).toEqual([...ordered].sort());

    const detail = await withStoreRead(context, queryDashboard("iteration-detail", { id: "iter-read" }));
    expect(detail.data?.iterationId).toBe("iter-read");
    expect((await withStoreRead(context, queryDashboard("iteration-detail", { id: "iter-absent" }))).data).toBeNull();
  });

  test("a plan id shared by two workflows keeps each dashboard row's own execution state", async () => {
    const { context, harness } = await workspace("dup-plan-id-");
    await registerCatalogEntity(
      context,
      { kind: "plan", id: "wf-dup", title: "Plan wf-dup", rootKind: "plans", relativePath: "wf-dup.md" },
      op("dup-plan"),
    );
    await registerCatalogEntity(
      context,
      { kind: "iteration", id: "iter-dup", title: "Iteration dup", rootKind: "iterations", relativePath: "iter-dup" },
      op("dup-iter"),
    );
    await linkCatalogEntities(
      context,
      { from: { kind: "plan", id: "wf-dup" }, relation: "belongs-to", to: { kind: "iteration", id: "iter-dup" } },
      op("dup-link"),
    );

    // Same plan id under two different workflows: the plan workflow's own
    // execution row and the iteration workflow's row for the same plan.
    writeFile(
      join(harness, "status.json"),
      JSON.stringify(
        {
          version: 2,
          updated_at: "2026-09-18",
          workflows: [
            { id: "wf-dup", type: "plan", started_at: STARTED_AT, dir: "workflows/wf-dup" },
            { id: "iter-dup", type: "iteration", started_at: STARTED_AT, dir: "workflows/iter-dup" },
          ],
        },
        null,
        2,
      ),
    );
    writeFile(
      join(harness, "workflows/wf-dup/snapshot.json"),
      JSON.stringify(
        {
          schema_version: 1,
          id: "wf-dup",
          type: "plan",
          status: "running",
          started_at: STARTED_AT,
          updated_at: STARTED_AT,
          phase: "phase-2-execute",
          branch: { base: "main", source: "feature/wf-dup", target: "main" },
          plans: [
            {
              id: "wf-dup",
              title: "Plan wf-dup",
              file: "/plans/wf-dup.md",
              status: "InProgress",
              coordination: { revision: 1, progress: { status: "InProgress", summary: "plan-workflow progress", evidence_paths: [] } },
              metadata: { catalog_pin: { entity_revision: 7 } },
              execution_lease: {
                holder: "session-plan",
                claimed_at: STARTED_AT,
                worktree_path: "/wt/wf-dup",
                working_branch: "feature/wf-dup",
                session_label: "must-never-be-projected",
              },
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFile(
      join(harness, "workflows/iter-dup/snapshot.json"),
      JSON.stringify(
        {
          schema_version: 1,
          id: "iter-dup",
          type: "iteration",
          status: "running",
          started_at: STARTED_AT,
          updated_at: STARTED_AT,
          phase: "phase-3-close",
          branch: { base: "main", source: "feature/wf-dup", integration: "integrate/iter-dup", target: "main" },
          plans: [
            {
              id: "wf-dup",
              title: "Plan wf-dup",
              file: "/plans/wf-dup.md",
              status: "Blocked",
              metadata: { catalog_pin: { entity_revision: 9 } },
              execution_lease: {
                holder: "session-iter",
                claimed_at: STARTED_AT,
                worktree_path: "/wt/iter-dup",
                working_branch: "integrate/iter-dup",
              },
            },
          ],
        },
        null,
        2,
      ),
    );
    await refreshProjections(context);

    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    const planWorkflow = envelope.data.items.find((item) => item.id === "wf-dup") as WorkflowDTO;
    const iterationWorkflow = envelope.data.items.find((item) => item.id === "iter-dup") as WorkflowDTO;

    // Each workflow's plan row shows only its own workflow's lease, status and
    // pin revision -- never the other's.
    expect(planWorkflow.plans[0]?.status).toBe("InProgress");
    expect(planWorkflow.plans[0]?.progress).toBe("plan-workflow progress");
    expect(planWorkflow.plans[0]?.catalogPinRevision).toBe(7);
    expect(planWorkflow.plans[0]?.leases.map((lease) => lease.holder)).toEqual(["session-plan"]);
    expect(planWorkflow.plans[0]?.leases.map((lease) => lease.workflowId)).toEqual(["wf-dup"]);

    expect(iterationWorkflow.plans[0]?.status).toBe("Blocked");
    expect(iterationWorkflow.plans[0]?.catalogPinRevision).toBe(9);
    expect(iterationWorkflow.plans[0]?.leases.map((lease) => lease.holder)).toEqual(["session-iter"]);
    expect(iterationWorkflow.plans[0]?.leases.map((lease) => lease.workflowId)).toEqual(["iter-dup"]);
    expect(JSON.stringify(envelope)).not.toContain("must-never-be-projected");

    // The iteration view resolves the plan's execution from the iteration's
    // own row, never from the same-id plan workflow's row.
    const detail = await withStoreRead(context, queryDashboard("iteration-detail", { id: "iter-dup" }));
    expect(detail.data?.plans[0]?.execution?.workflowId).toBe("iter-dup");
    expect(detail.data?.plans[0]?.execution?.status).toBe("Blocked");
    expect(detail.data?.plans[0]?.execution?.phase).toBe("phase-3-close");
    expect(detail.data?.plans[0]?.catalogPinRevision).toBe(9);
  });

  test("roadmap reads full authoritative content without refreshing projections", async () => {
    const { context, harness, generation } = await projectedWorkspace("roadmap-");
    const before = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-a" }));
    expect(before.data?.projectId).toBe("proj-a");
    expect(before.data?.catalog.title).toBe("Project A");
    expect(before.data?.authority).toMatchObject({ state: "present", revision: 1 });
    expect(before.data?.authority.state === "present" && before.data.authority.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(before.data?.content?.contentMarkdown).toBe(ROADMAP_DOC);
    expect(before.data?.content?.direction).toContain("Serve the dashboard from the store");
    expect(before.data?.content?.goals.map(({ title, checked }) => ({ title, checked }))).toEqual([
      { title: "Ship the read boundary", checked: true },
      { title: "Ship the dashboard", checked: false },
    ]);
    expect(before.data?.content?.milestones).toEqual(["Read boundary"]);

    rmSync(join(harness, "projects/proj-a/roadmap.md"), { force: true });
    await withWrite(context, (db) => {
      db.prepare("update projection_meta set format_version = 1 where id = 1").run();
    });
    const after = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-a" }));
    expect(after.projection.generation).toBe(generation);
    expect(after.data).toEqual(before.data);
    expect((await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-absent" }))).data).toBeNull();
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-known-empty", title: "Known empty", rootKind: "projects", relativePath: "proj-known-empty" },
      op("known-empty"),
    );
    const empty = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-known-empty" }));
    expect(empty.data).toMatchObject({ authority: { state: "absent" }, content: null });
  });

  test("an unavailable projection is disclosed as unavailable, not as zero work", async () => {
    const { context, harness } = await workspace("unavailable-");
    writeFile(join(harness, "status.json"), "{ not json");
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    expect(envelope.projection.generation).toBeNull();
    expect(envelope.projection.freshness).toBe("unavailable");
    expect(envelope.projection.builtAt).toBeNull();
    expect(envelope.projection.diagnostics.map((diagnostic) => diagnostic.sourceKey)).toContain("root:harness:status.json");
    expect(envelope.data).toEqual({ items: [], total: 0 });
  });

  test("a projection view reads only committed store data, never source JSON", async () => {
    const { context, harness } = await projectedWorkspace("no-source-io-");
    // The view layer must not consult the sources: with every source made
    // unreadable after publication, a published generation still answers --
    // and the refresh that precedes it keeps the last good generation.
    rmSync(join(harness, "status.json"));
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    expect(envelope.projection.freshness).toBe("stale");
    expect(envelope.projection.generation).not.toBeNull();
    expect(envelope.data.items.map((item) => item.id)).toEqual(["wf-read"]);
    expect(envelope.projection.diagnostics.some((diagnostic) => diagnostic.reason === "missing")).toBe(true);
    // The view answers from the retained generation, whose bytes on disk are
    // already gone: no source read could have produced this data.
    expect(readFileSync(join(catalogRootDir(context, "iterations"), "iter-read/delivery-compass.md"), "utf8")).toBe(COMPASS_DOC);
  });
});
