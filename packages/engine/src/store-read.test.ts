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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { catalogRootDir, getCatalog, linkCatalogEntities, registerCatalogEntity, updateCatalogEntity, type CatalogOperation } from "./catalog.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, mintIssueRef, readCollaborationAuthority, writeCollaborationBinding } from "./collaboration-store.js";
import { bindRemoteAuthority, ingestRemoteObservation, prepareRemoteAdoption } from "./collaboration-remote.js";
import { closeIssue, getIssue, listIssues, showIssue, type Disposition, type Severity } from "./issue.js";
import { queryMilestones, type MilestoneRead } from "./milestone-store.js";
import { assertPlanFindingsCurrent, findingsCleanupGate, observePlanFindings, readProjectBinding } from "./project.js";
import { executionInputHash } from "./coordination.js";
import { captureProjectionSources, refreshProjections } from "./projection.js";
import { importRoadmapAuthority, readRoadmapAuthority, reviewRoadmapImport } from "./roadmap-store.js";
import { createExecutionWorkflow, readExecutionState, type ExecutionCaller } from "./execution-store.js";
import { initializeStore, openStore, storeDbPath, type StoreContext, type StoreDb } from "./store-db.js";
import {
  completeSnapshot,
  createRemoteScope,
  FIXTURE_AT,
  negativeCheck,
  partialSnapshot,
  positiveCheck,
  REMOTE_IDS,
  submission,
} from "./remote-scope.fixture.js";
import {
  queryDashboard,
  queryIssueFlow,
  queryOpenIssueRollup,
  withStoreRead,
  type IssueFlow,
  type WorkflowDTO,
} from "./store-read.js";

const ROOT = mkdtempSync(join(nodeOs.tmpdir(), "mstar-store-read-"));
/** invariant: The user-level collaboration root this suite owns: the real `$HOME` is
 * never read or written, and every rerun starts on an empty lane. */
const HOME = join(ROOT, "home");
mkdirSync(HOME, { recursive: true });
let homeSpy: { mockRestore(): void } | undefined;
const STARTED_AT = "2026-09-18T01:00:00.000Z";
const RECORDED_AT = "2026-09-18T02:00:00.000Z";

beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

type Fixture = { dir: string; harness: string; context: StoreContext };

/**
 * invariant: The private staged collaboration record flipped to active, plus the checkout
 * binding the real activation writes: an ACTIVE authority is never usable from
 * an unbound checkout, and this plan ships no public activator.
 */
function activateCollaboration(context: StoreContext): void {
  const location = resolveCollaborationLocation(context);
  const db = new DatabaseSync(location.dbPath);
  let authority: { storeId: string; epoch: number } | null = null;
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
      new Date().toISOString(),
    );
    const row = db.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as
      | { store_id?: unknown; authority_epoch?: unknown }
      | undefined;
    if (typeof row?.store_id === "string" && typeof row.authority_epoch === "number") {
      authority = { storeId: row.store_id, epoch: row.authority_epoch };
    }
  } finally {
    db.close();
  }
  if (authority === null) throw new Error("fixture: the staged collaboration lane records no store identity");
  writeCollaborationBinding(context, {
    repoKey: location.repoKey,
    mode: location.mode,
    storeId: authority.storeId,
    epoch: authority.epoch,
    binding: "active",
  });
}

/**
 * One initialized workspace on BOTH lanes: the execution authority
 * (`initializeStore` activates it, issue #428 retired the pre-activation file
 * route) and the active collaboration authority in a synthetic checkout whose
 * origin names the collaboration repository.
 */
async function workspace(name: string): Promise<Fixture> {
  const dir = mkdtempSync(join(ROOT, name));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name.replace(/[^a-z0-9._-]/gi, "-")}.git`], {
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // note: The live selector lookup is real Git I/O; route the synthetic origin to this fixture's
  // own repository, which never publishes the selector ref.
  execFileSync(
    "git",
    ["config", `url.${dir}.insteadOf`, `https://github.com/acme/${name.replace(/[^a-z0-9._-]/gi, "-")}.git`],
    { cwd: dir, stdio: ["ignore", "ignore", "ignore"] },
  );
  writeFileSync(join(dir, ".mstarc"), "[collaboration]\nmode=local\n");
  const harness = join(dir, ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: harness };
  const handle = await initializeStore(context);
  handle.close();
  await initializeCollaborationStore(resolveCollaborationLocation(context));
  activateCollaboration(context);
  return { dir, harness, context };
}

/** note: One direct collaboration write (the lane's own database, no second owner). */
async function withWrite(context: StoreContext, fn: (db: StoreDb) => void): Promise<void> {
  const db = new DatabaseSync(resolveCollaborationLocation(context).dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

/** note: One direct execution write (projection/execution fixtures only). */
async function withExecutionWrite(context: StoreContext, fn: (db: StoreDb) => void): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    fn(handle.db);
  } finally {
    handle.close();
  }
}

/**
 * why: A second writer connection for the concurrency probes: it WAITS on the
 * bounded budget instead of surfacing a transient lock, so the probe measures
 * snapshot isolation rather than SQLite contention.
 */
function concurrentWriter(dbPath: string): StoreDb {
  const db = new DatabaseSync(dbPath);
  db.exec("pragma busy_timeout = 5000");
  return db;
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
  acceptance?: string;
  /** The migration-7 association column; `null` is the unassigned default. */
  milestoneId?: string | null;
  registeredAt?: string | null;
  closedAt?: string | null;
  /** A migrated record: the imported capture occurrence carries the import marker. */
  importedOccurrence?: boolean;
  /** A migrated closure: the imported terminal transition carries the marker. */
  importedTransition?: boolean;
};

function seedIssue(db: StoreDb, seed: SeedIssue): void {
  db.prepare(
    "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, closed_at, created_at, updated_at, revision, identity_key, milestone_id, issue_ref) " +
      "values (?, ?, ?, ?, ?, ?, 'impact', ?, ?, ?, ?, ?, 1, ?, ?, ?)",
  ).run(
    seed.id,
    seed.projectId ?? "proj-a",
    seed.title,
    seed.kind ?? "bug",
    seed.severity ?? "medium",
    seed.disposition ?? "open",
    seed.acceptance ?? "acceptance",
    seed.registeredAt ?? null,
    seed.closedAt ?? null,
    RECORDED_AT,
    RECORDED_AT,
    `identity-${seed.id}`,
    seed.milestoneId ?? null,
    mintIssueRef(),
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
  // The pre-activation file route is retired (issue #428): the projection's
  // execution-ROW source is the ACTIVE execution graph, built here through the
  // real producer rather than by writing status.json / snapshot.json.
  // `initializeStore` already activated the execution authority (issue #428),
  // so the creation token is read back rather than re-initialized.
  const initialized = await readExecutionState(context);
  const catalogAuthority = await readCollaborationAuthority(context);
  const caller: ExecutionCaller = { sessionId: "store-read-coordinator", role: "coordinator", workflowId: "wf-read" };
  await createExecutionWorkflow({ harnessDir: fixture.harness, caller }, {
    entry: { id: "wf-read", type: "plan", started_at: STARTED_AT, dir: "workflows/wf-read" },
    snapshot: {
      schema_version: 1, id: "wf-read", type: "plan", status: "running", started_at: STARTED_AT,
      updated_at: STARTED_AT, phase: "phase-2-execute",
      branch: { base: "main", source: "feature/wf-read", target: "main" },
      plans: [{
        id: "wf-read", title: "Plan wf-read", file: "plans/wf-read.md", status: "InProgress",
        metadata: {
          // note: The complete frozen selection a `prepare` records: creation verifies
          // it against the COLLABORATION catalog before its write transaction.
          catalog_pin: {
            store_id: catalogAuthority.storeId,
            entity_revision: plan.entity.revision,
            document_hash: executionInputHash({ id: "wf-read", plan_id: "wf-read", title: "Plan wf-read", file: "plans/wf-read.md", status: "InProgress" }, "wf-read"),
            relation_hash: "0".repeat(64),
          },
          worktree_path: "/wt/wf-read", working_branch: "feature/wf-read",
        },
      }],
      delivery_kind: "development",
    } as never,
    expected: initialized.token,
    operationId: "store-read-create",
  });
  const executionHandle = await openStore(context, "write");
  try {
    executionHandle.db.prepare("update execution_plans set coordination_json = ? where workflow_id = ? and plan_id = ?")
      .run(JSON.stringify({ progress: { status: "InProgress", summary: "half way", evidence_paths: [] } }), "wf-read", "wf-read");
    executionHandle.db.prepare(
      "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, 1, ?)",
    ).run("wf-read", JSON.stringify({
      holder: "session-2", claimed_at: STARTED_AT, plan_id: "wf-read",
      source_branch: "feature/wf-read", target_branch: "main",
    }));
    executionHandle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
  } finally { executionHandle.close(); }

  const report = await refreshProjections(context);
  if (report.generation === null) throw new Error(`fixture: projection not published (${report.freshness})`);
  return { ...fixture, generation: report.generation, planRevision: plan.entity.revision };
}

/** A project's milestone row, inserted directly: the read side is what this suite proves. */
function seedMilestone(
  db: StoreDb,
  seed: { id: string; name: string; projectId?: string; target?: string | null; status?: string; ordinal?: number },
): void {
  db.prepare(
    "insert into project_milestones(milestone_id, project_id, name, target, status, ordinal, revision, created_at, updated_at) " +
      "values (?, ?, ?, ?, ?, ?, 1, ?, ?)",
  ).run(
    seed.id,
    seed.projectId ?? "proj-a",
    seed.name,
    seed.target ?? null,
    seed.status ?? "planned",
    seed.ordinal ?? 0,
    RECORDED_AT,
    RECORDED_AT,
  );
}

async function registerProject(context: StoreContext, id: string): Promise<void> {
  await registerCatalogEntity(
    context,
    { kind: "project", id, title: id, rootKind: "projects", relativePath: id },
    op(`proj-${id}`),
  );
}

function milestoneRows(read: MilestoneRead): unknown[] {
  return read.milestones.map((milestone) => [
    milestone.milestoneId,
    milestone.projectId,
    milestone.name,
    milestone.ordinal,
    milestone.totalIssues,
    milestone.openIssues,
    milestone.resolvedIssues,
    milestone.otherRetiredIssues,
  ]);
}

// ---------------------------------------------------------------------------

describe("milestone views", () => {
  test("milestones query groups each project's milestones without cross-project bleed or row multiplication", async () => {
    const { context } = await workspace("milestone-scope-");
    await registerProject(context, "proj-a");
    await registerProject(context, "proj-b");
    await withWrite(context, (db) => {
      seedMilestone(db, { id: "M-A1", name: "A first", ordinal: 0 });
      seedMilestone(db, { id: "M-A2", name: "A second", ordinal: 1, target: "2026-10-01", status: "active" });
      seedMilestone(db, { id: "M-B1", name: "B only", projectId: "proj-b", ordinal: 0 });
      // Three issues on one milestone: the join must multiply neither the
      // milestone rows nor the counts.
      seedIssue(db, { id: "I-A1", title: "a1", milestoneId: "M-A1", disposition: "open" });
      seedIssue(db, { id: "I-A2", title: "a2", milestoneId: "M-A1", disposition: "resolved", acceptance: "a2 done" });
      seedIssue(db, { id: "I-A3", title: "a3", milestoneId: "M-A1", disposition: "waived" });
      seedIssue(db, { id: "I-A4", title: "a4" });
      seedIssue(db, { id: "I-B1", title: "b1", projectId: "proj-b", milestoneId: "M-B1", disposition: "resolved" });
    });

    const envelope = await withStoreRead(context, queryMilestones("proj-a"));
    expect(envelope.data.projectId).toBe("proj-a");
    expect(milestoneRows(envelope.data)).toEqual([
      ["M-A1", "proj-a", "A first", 0, 3, 1, 1, 1],
      ["M-A2", "proj-a", "A second", 1, 0, 0, 0, 0],
    ]);
    expect(envelope.data.issues.map((issue) => [issue.id, issue.milestoneId, issue.disposition])).toEqual([
      ["I-A1", "M-A1", "open"],
      ["I-A2", "M-A1", "resolved"],
      ["I-A3", "M-A1", "waived"],
    ]);
    expect(envelope.data.issues.find((issue) => issue.id === "I-A2")?.acceptance).toBe("a2 done");
    expect(envelope.data.unassignedIssues).toBe(1);
    expect(JSON.stringify(envelope.data)).not.toContain("M-B1");

    // The other project's grouping is its own, and an absent project refuses
    // instead of answering an empty one.
    const other = await withStoreRead(context, queryMilestones("proj-b"));
    expect(milestoneRows(other.data)).toEqual([["M-B1", "proj-b", "B only", 0, 1, 0, 1, 0]]);
    expect(other.data.unassignedIssues).toBe(0);
    await expect(withStoreRead(context, queryMilestones("proj-absent"))).rejects.toMatchObject({ code: "milestone.project-not-found" });
  });

  test("a milestone status query filters one milestone and refuses without its project or id", async () => {
    const { context } = await workspace("milestone-status-");
    await registerProject(context, "proj-b");
    await registerProject(context, "proj-a");
    await withWrite(context, (db) => {
      seedMilestone(db, { id: "M-1", name: "One", ordinal: 0 });
      seedMilestone(db, { id: "M-2", name: "Two", ordinal: 1 });
      seedIssue(db, { id: "I-1", title: "first", milestoneId: "M-1" });
      seedIssue(db, { id: "I-2", title: "second", milestoneId: "M-2" });
      seedMilestone(db, { id: "M-B1", name: "Foreign", projectId: "proj-b" });
      seedIssue(db, { id: "I-3", title: "unassigned" });
    });

    const one = await withStoreRead(context, queryMilestones("proj-a", "M-1"));
    expect(milestoneRows(one.data)).toEqual([["M-1", "proj-a", "One", 0, 1, 1, 0, 0]]);
    expect(one.data.issues.map((issue) => issue.id)).toEqual(["I-1"]);
    // The unassigned count is the project's, not the filtered milestone's.
    expect(one.data.unassignedIssues).toBe(1);

    // Unknown and cross-project IDs refuse instead of answering an empty or foreign result.
    await expect(withStoreRead(context, queryMilestones("proj-a", "M-missing"))).rejects.toMatchObject({ code: "milestone.not-found" });
    await expect(withStoreRead(context, queryMilestones("proj-a", "M-B1"))).rejects.toMatchObject({ code: "milestone.project-mismatch" });
    // The standalone query is a real view request: it refuses to run outside
    // the boundary's single read transaction.
    await expect(withStoreRead(context, { view: "milestones", needsProjection: false } as never)).rejects.toMatchObject({ exitCode: 2 });
  });

  test("milestone reads neither refresh nor consume the projection, and disclose its health", async () => {
    const { context, harness } = await workspace("milestone-freshness-");
    await registerProject(context, "proj-a");
    await withWrite(context, (db) => {
      seedMilestone(db, { id: "M-1", name: "One" });
      seedIssue(db, { id: "I-1", title: "first", milestoneId: "M-1" });
    });
    writeFile(join(harness, "status.json"), "{ not json");
    const unavailable = await withStoreRead(context, queryMilestones("proj-a"));
    expect(unavailable.projection.observed).toBe(false);
    expect(unavailable.projection.generation).toBeNull();
    expect(unavailable.projection.freshness).toBe("unavailable");
    expect(unavailable.data.milestones).toHaveLength(1);
    expect(unavailable.data.milestones[0]?.totalIssues).toBe(1);

    // A project with no milestones at all is a successful empty result.
    await registerProject(context, "proj-empty");
    const empty = await withStoreRead(context, queryMilestones("proj-empty"));
    expect(empty.data).toEqual({ projectId: "proj-empty", milestones: [], issues: [], unassignedIssues: 0 });
    expect(empty.projection.freshness).toBe("unavailable");
  });

  test("milestone assignment and disposition updates are visible without a projection refresh", async () => {
    const { context, harness, generation } = await projectedWorkspace("milestone-live-");
    await withWrite(context, (db) => {
      seedMilestone(db, { id: "M-1", name: "Live", ordinal: 0 });
      seedIssue(db, { id: "I-1", title: "unassigned yet" });
    });
    const before = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-a" }));
    // invariant: A pure collaboration view never opens the execution database, so it
    // discloses NO projection observation instead of a health verdict.
    expect(before.projection.observed).toBe(false);
    expect(before.projection.generation).toBeNull();
    const beforeRevision = before.storeRevision;
    if (beforeRevision === null) throw new Error("fixture: a complete collaboration read reports its revision");
    expect(before.data?.milestones.milestones[0]?.totalIssues).toBe(0);
    expect(before.data?.milestones.unassignedIssues).toBe(1);

    await withWrite(context, (db) => {
      db.prepare("update issues set milestone_id = 'M-1', revision = revision + 1 where id = 'I-1'").run();
      db.prepare("update collaboration_meta set revision = revision + 1 where id = 1").run();
    });
    const assigned = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-a" }));
    expect(assigned.data?.milestones.milestones[0]).toMatchObject({ totalIssues: 1, openIssues: 1 });
    expect(assigned.data?.milestones.unassignedIssues).toBe(0);
    expect(assigned.storeRevision).toBe(beforeRevision + 1);

    await withWrite(context, (db) => {
      db.prepare("update issues set disposition = 'resolved', closed_at = ?, revision = revision + 1 where id = 'I-1'").run(RECORDED_AT);
      db.prepare("update collaboration_meta set revision = revision + 1 where id = 1").run();
    });
    const resolved = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-a" }));
    const resolvedData = resolved.data;
    if (resolvedData === null) throw new Error("fixture: the roadmap view must answer for proj-a");
    expect(resolvedData.milestones.milestones[0]).toMatchObject({ totalIssues: 1, openIssues: 0, resolvedIssues: 1 });

    // The same membership answers through the standalone view at the same
    // revision: a milestone-only read answers from committed rows, and the
    // source I/O that changed after publication does not move them.
    const standalone = await withStoreRead(context, queryMilestones("proj-a"));
    expect(standalone.storeRevision).toBe(resolved.storeRevision);
    expect(standalone.data).toEqual(resolvedData.milestones);
    // A milestone-only read needs no projection refresh, so a later
    // projection-consuming read adopts the unchanged published generation and
    // the milestone grouping is answered from the committed rows either way
    // (issue #428: the retired file route's status.json is no longer a
    // projection source).
    const refreshed = await withStoreRead(context, queryDashboard("workflows"));
    expect(refreshed.projection.freshness).toBe("current");
    expect(refreshed.projection.generation).toBeGreaterThanOrEqual(generation);
    const roadmap = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-a" }));
    expect(roadmap.data?.milestones).toEqual(standalone.data);
  });

  test("a concurrent assignment cannot change the milestone counts or revisions one read reports", async () => {
    const { context } = await workspace("milestone-snapshot-");
    await registerProject(context, "proj-a");
    await withWrite(context, (db) => {
      seedMilestone(db, { id: "M-1", name: "Snapshot" });
      seedIssue(db, { id: "I-1", title: "counted", milestoneId: "M-1" });
    });
    const dbPath = resolveCollaborationLocation(context).dbPath;
    const beforeRevision = (await withStoreRead(context, queryMilestones("proj-a"))).storeRevision;
    if (beforeRevision === null) throw new Error("fixture: a complete collaboration read reports its revision");
    const base = queryMilestones("proj-a");

    const envelope = await withStoreRead(context, {
      view: base.view,
      needsProjection: base.needsProjection,
      collaboration: base.collaboration,
      execution: base.execution,
      run: (sources) => {
        const first = base.run(sources).data;
        const second = base.run(sources).data;
        return { data: { first, second } };
      },
    });
    expect(envelope.storeRevision).toBe(beforeRevision);
    expect(envelope.data.first.milestones[0]?.totalIssues).toBe(1);
    expect(envelope.data.second.milestones[0]?.totalIssues).toBe(1);
    expect(envelope.data.first.issues.map((issue) => issue.id)).toEqual(["I-1"]);
    expect(envelope.data.first).toEqual(envelope.data.second);

    // note: A later commit on its own connection is visible only to later reads, and
    // the revision moves independently of the answered snapshot.
    const writer: StoreDb = concurrentWriter(dbPath);
    try {
      seedIssue(writer, { id: "I-2", title: "late", milestoneId: "M-1" });
      writer.exec("update collaboration_meta set revision = revision + 3 where id = 1");
    } finally {
      writer.close();
    }

    const later = await withStoreRead(context, queryMilestones("proj-a"));
    expect(later.data.milestones[0]?.totalIssues).toBe(2);
    expect(later.storeRevision).toBe(beforeRevision + 3);
  });

  test("the roadmap view carries the milestone grouping even with absent Markdown, and answers null for an unknown project", async () => {
    const { context, harness } = await projectedWorkspace("milestone-roadmap-");
    await withWrite(context, (db) => {
      seedMilestone(db, { id: "M-1", name: "Read boundary", ordinal: 0, target: "2026-10-01", status: "active" });
      seedMilestone(db, { id: "M-2", name: "Dashboard", ordinal: 1 });
      seedIssue(db, { id: "I-1", title: "read store", milestoneId: "M-1", acceptance: "read proof" });
      seedIssue(db, { id: "I-2", title: "render", milestoneId: "M-2" });
      seedIssue(db, { id: "I-3", title: "loose" });
    });
    const present = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-a" }));
    expect(present.data?.content?.contentMarkdown).toBe(ROADMAP_DOC);
    expect(present.data?.milestones.milestones.map((milestone) => [milestone.name, milestone.target, milestone.status, milestone.ordinal])).toEqual([
      ["Read boundary", "2026-10-01", "active", 0],
      ["Dashboard", null, "planned", 1],
    ]);
    expect(present.data?.milestones.issues.map((issue) => [issue.id, issue.milestoneId])).toEqual([
      ["I-1", "M-1"],
      ["I-2", "M-2"],
    ]);
    expect(present.data?.milestones.unassignedIssues).toBe(1);

    // invariant: The stored source text is gone, yet the milestone grouping is still
    // answered: it is collaboration data, not Markdown-derived, and the view
    // never reads the disposable execution projection at all.
    rmSync(join(harness, "projects/proj-a/roadmap.md"), { force: true });
    const absent = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-a" }));
    expect(absent.data).toEqual(present.data);
    // why: `checkedAt` is when THIS read observed, so it is the only member that
    // moves; nothing else about the unobserved projection may change.
    const { checkedAt: _checkedAt, ...absentProjection } = absent.projection;
    const { checkedAt: _presentCheckedAt, ...presentProjection } = present.projection;
    expect(absentProjection).toEqual(presentProjection);
    expect(absent.projection.observed).toBe(false);

    // A registered project with no roadmap authority and no milestones still
    // answers empty content AND empty milestone data -- never null.
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-known-empty", title: "Known empty", rootKind: "projects", relativePath: "proj-known-empty" },
      op("known-empty"),
    );
    const noContent = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-known-empty" }));
    expect(noContent.data).toEqual({
      projectId: "proj-known-empty",
      catalog: expect.anything(),
      authority: { state: "absent" },
      content: null,
      milestones: { projectId: "proj-known-empty", milestones: [], issues: [], unassignedIssues: 0 },
    });
    expect((await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-absent" }))).data).toBeNull();
  });

  test("a milestone-only read of a project without roadmap authority keeps the absent-content roadmap contract", async () => {
    const { context } = await workspace("milestone-absent-");
    await registerProject(context, "proj-solo");
    await withWrite(context, (db) => {
      seedMilestone(db, { id: "M-S1", name: "Solo milestone", projectId: "proj-solo", ordinal: 0 });
      seedIssue(db, { id: "I-S1", title: "solo issue", projectId: "proj-solo", milestoneId: "M-S1", disposition: "duplicate", acceptance: "dup" });
      seedIssue(db, { id: "I-S2", title: "loose", projectId: "proj-solo" });
    });
    const envelope = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-solo" }));
    expect(envelope.data?.authority).toEqual({ state: "absent" });
    expect(envelope.data?.content).toBeNull();
    expect(envelope.data?.milestones.milestones[0]).toMatchObject({ name: "Solo milestone", totalIssues: 1, otherRetiredIssues: 1 });
    expect(envelope.data?.milestones.issues[0]).toMatchObject({ id: "I-S1", disposition: "duplicate", acceptance: "dup" });
    expect(envelope.data?.milestones.unassignedIssues).toBe(1);
    expect(envelope.data?.milestones.projectId).toBe("proj-solo");
    // A milestone belongs to exactly one project: the other project's view
    // cannot observe it even by id.
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-other", title: "Other", rootKind: "projects", relativePath: "proj-other" },
      op("proj-other"),
    );
    const other = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-other" }));
    expect(other.data?.milestones).toEqual({ projectId: "proj-other", milestones: [], issues: [], unassignedIssues: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("read envelope and transaction", () => {
  test("one request discloses the store, catalog and projection revisions it read at", async () => {
    const { context } = await projectedWorkspace("envelope-");
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    expect(envelope.storeRevision).toBeGreaterThan(0);
    expect(envelope.catalogRevision).toBeGreaterThan(0);
    // A projection view refreshes before it reads, so this request publishes
    // the current generation itself. The disclosure must name exactly the
    // generation the store holds now, not the fixture's earlier count.
    const handle = await openStore(context, "read");
    try {
      const published = handle.db.prepare("select generation from projection_meta where id = 1").get() as {
        generation: number | null;
      };
      expect(envelope.projection.generation).toBe(published.generation);
    } finally {
      handle.close();
    }
    expect(envelope.projection.freshness).toBe("current");
    expect(envelope.projection.builtAt).not.toBeNull();
    expect(envelope.projection.diagnostics).toEqual([]);
    expect(envelope.data.items.map((item) => item.id)).toEqual(["wf-read"]);
  });

  test("a concurrent writer cannot change what the open read transaction reports", async () => {
    const { context } = await workspace("snapshot-");
    await withWrite(context, (db) => seedIssue(db, { id: "I-000001", title: "before", registeredAt: "2026-09-01" }));
    const dbPath = resolveCollaborationLocation(context).dbPath;
    const beforeRevision = (await withStoreRead(context, queryDashboard("issues"))).storeRevision;
    if (beforeRevision === null) throw new Error("fixture: a complete collaboration read reports its revision");

    // note: Two questions inside one request answer from the same snapshot.
    const envelope = await withStoreRead(context, {
      view: "concurrency-probe",
      needsProjection: false,
      collaboration: { scope: { kind: "query", key: "concurrency-probe" }, required: true },
      execution: "not-requested",
      run: ({ collaboration }) => {
        if (collaboration === null) throw new Error("fixture: the probe declares a required collaboration source");
        const first = issueCount(collaboration.db);
        const second = issueCount(collaboration.db);
        return { data: { first, second } };
      },
    });
    expect(envelope.data.first).toBe(1);
    expect(envelope.data.second).toBe(1);
    expect(envelope.storeRevision).toBe(beforeRevision);

    // note: A writer on its own connection moves the lane for LATER reads only.
    const writer: StoreDb = concurrentWriter(dbPath);
    try {
      seedIssue(writer, { id: "I-000002", title: "after", registeredAt: "2026-09-02" });
      writer.exec("update collaboration_meta set revision = revision + 7 where id = 1");
    } finally {
      writer.close();
    }

    const later = await withStoreRead(context, queryDashboard("issues", { issue: { disposition: "open" } }));
    expect(later.data.total).toBe(2);
    expect(later.storeRevision).toBe(beforeRevision + 7);
  });

  test("a missing store fails instead of returning empty findings", async () => {
    const dir = mkdtempSync(join(ROOT, "no-store-"));
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/no-store.git"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execFileSync("git", ["config", `url.${dir}.insteadOf`, "https://github.com/acme/no-store.git"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    writeFileSync(join(dir, ".mstarc"), "[collaboration]\nmode=local\n");
    mkdirSync(join(dir, ".mstar"), { recursive: true });
    const context: StoreContext = { harnessDir: join(dir, ".mstar") };
    // why: The issue/catalog views need collaboration; the projection views need
    // execution. Each names its own missing lane instead of an empty result.
    await expect(withStoreRead(context, queryDashboard("issues"))).rejects.toMatchObject({ code: "collaboration.not-initialized" });
    await expect(withStoreRead(context, queryIssueFlow())).rejects.toMatchObject({ code: "collaboration.not-initialized" });
    await expect(withStoreRead(context, queryDashboard("workflows"))).rejects.toMatchObject({ code: "store.not-initialized" });
  });

  test("a staged store is refused, never served as read authority", async () => {
    const { context } = await workspace("staged-");
    await withWrite(context, (db) => {
      seedIssue(db, { id: "I-000001", title: "staged finding", registeredAt: "2026-09-01" });
      db.exec("update collaboration_meta set authority_state = 'staged' where id = 1");
    });
    // invariant: A staged collaboration lane is never read authority: the refusal names
    // the lane, not the execution store it does not own.
    await expect(withStoreRead(context, queryDashboard("issues"))).rejects.toMatchObject({ code: "collaboration.not-active" });
  });

  test("a store without the projection schema refuses with the upgrade path", async () => {
    const { context } = await workspace("pre-projection-");
    await withExecutionWrite(context, (db) => {
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
    });
    // invariant: Only the execution-reading view discloses projection health, so only it
    // refuses on the missing schema.
    const failure = await withStoreRead(context, queryDashboard("workflows")).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "projection.schema-outdated" });
    expect((failure as Error).message).toContain("mstar store upgrade --operator <name>");
    // note: A pure collaboration view is answered from its own lane.
    expect(await withStoreRead(context, queryDashboard("issues"))).toMatchObject({ data: { total: 0 } });
  });

  test("request shapes outside the contract are usage refusals, not empty pages", async () => {
    const { context } = await workspace("usage-");
    expect(() => queryDashboard("nope" as never)).toThrow(/unknown dashboard view/);
    await expect(withStoreRead(context, { view: "issues" } as never)).rejects.toMatchObject({ exitCode: 2 });
    // invariant: A missing required filter is refused while the request is built, before
    // any database is opened.
    expect(() => queryDashboard("issue-detail")).toThrow();
    expect(() => queryDashboard("workflow-detail")).toThrow();
    expect(() => queryDashboard("roadmap")).toThrow();
    expect(() => queryDashboard("issues", { issue: { limit: 201 } })).toThrow();
    expect(() => queryDashboard("issues", { issue: { offset: -1 } })).toThrow();
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
    // why: The domain reader attaches the observation of its own read; the dashboard
    // DTO keeps the page shape and the envelope carries that observation.
    const { collaboration: domainEvidence, ...domainPage } = domain;
    expect(full.data).toEqual(domainPage);
    expect(domainEvidence.completeness).toBe("complete");
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
      db.prepare("insert into provenance(issue_id, kind, target, source_hash, origin) values ('I-000001', 'capture', 'audit/x.md', 'hash', 'unscoped')").run();
    });
    const envelope = await withStoreRead(context, queryDashboard("issue-detail", { id: "I-000001" }));
    const direct = await getIssue(context, "I-000001");
    const { collaboration: detailEvidence, ...directDetail } = direct;
    expect(envelope.data).toEqual(directDetail);
    expect(detailEvidence.completeness).toBe("complete");
    if (!("occurrences" in envelope.data)) throw new Error("a local issue detail must carry its occurrence history");
    expect(envelope.data.occurrences).toHaveLength(1);
    await expect(withStoreRead(context, queryDashboard("issue-detail", { id: "I-999999" }))).rejects.toMatchObject({
      code: "issue.not-found",
    });
  });
});

describe("collaboration rollup snapshot", () => {
  /**
   * invariant: Twelve open issues across two projects, one retired row and a lane move: the
   * counts, the grouping and the preview must all name one snapshot.
   */
  async function seededRollup(name: string): Promise<StoreContext> {
    const { context } = await workspace(name);
    await registerProject(context, "proj-a");
    await registerProject(context, "proj-b");
    await withWrite(context, (db) => {
      for (let index = 1; index <= 12; index += 1) {
        seedIssue(db, {
          id: `I-${String(index).padStart(2, "0")}`,
          title: `open ${index}`,
          projectId: index % 3 === 0 ? "proj-b" : "proj-a",
          severity: index % 4 === 0 ? "critical" : index % 2 === 0 ? "low" : "nit",
          registeredAt: `2026-09-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
        });
      }
      seedIssue(db, { id: "I-RETIRED", title: "retired", disposition: "resolved", severity: "critical" });
      db.prepare("update collaboration_meta set revision = revision + 7 where id = 1").run();
    });
    return context;
  }

  test("collaboration rollup snapshot: totals, grouping and the ten-row preview name one snapshot", async () => {
    const context = await seededRollup("rollup-snapshot-");
    const before = await withStoreRead(context, queryOpenIssueRollup());
    if (before.storeRevision === null) throw new Error("fixture: a complete collaboration read reports its revision");
    expect(before.data.totalOpen).toBe(12);
    expect(before.data.bySeverity).toEqual({ critical: 3, high: 0, medium: 0, low: 3, nit: 6 });
    expect(before.data.byProject).toEqual({ "proj-a": 8, "proj-b": 4 });
    // invariant: The preview is the panel's bounded page in the authority's own order, and
    // it is never the count source: 12 open rows still preview 10.
    expect(before.data.recent.map((issue) => issue.id)).toEqual([
      "I-12", "I-08", "I-04", "I-10", "I-06", "I-02", "I-11", "I-09", "I-07", "I-05",
    ]);
    expect(before.data.recent.every((issue) => issue.disposition === "open")).toBe(true);
    // note: One snapshot: every aggregate over the same rows agrees with the total and
    // with the revision the envelope reports.
    expect(Object.values(before.data.bySeverity).reduce((sum, count) => sum + count, 0)).toBe(before.data.totalOpen);
    expect(Object.values(before.data.byProject).reduce((sum, count) => sum + count, 0)).toBe(before.data.totalOpen);
    expect(before.storeRevision).toBeGreaterThan(7);

    // why: A later commit is visible only to later reads, and the lane revision moves
    // together with every aggregate instead of a page joined across generations.
    const writer = concurrentWriter(resolveCollaborationLocation(context).dbPath);
    try {
      seedIssue(writer, { id: "I-13", title: "late critical", severity: "critical", registeredAt: "2026-10-01T00:00:00.000Z" });
      seedIssue(writer, { id: "I-14", title: "late nit", severity: "nit", registeredAt: "2026-10-02T00:00:00.000Z" });
      writer.exec("update collaboration_meta set revision = revision + 2 where id = 1");
    } finally {
      writer.close();
    }
    const after = await withStoreRead(context, queryOpenIssueRollup());
    expect(after.data.totalOpen).toBe(14);
    expect(after.data.bySeverity.critical).toBe(4);
    expect(after.data.bySeverity.nit).toBe(7);
    expect(after.data.byProject).toEqual({ "proj-a": 10, "proj-b": 4 });
    expect(after.data.recent).toHaveLength(10);
    expect(after.storeRevision).toBe(before.storeRevision + 2);
  });

  test("collaboration rollup snapshot: a project scope keeps its own counts, and a legitimate zero is empty", async () => {
    const context = await seededRollup("rollup-scope-");
    const whole = await withStoreRead(context, queryOpenIssueRollup());
    const scoped = await withStoreRead(context, queryOpenIssueRollup("proj-b"));
    expect(scoped.data.totalOpen).toBe(4);
    expect(scoped.data.byProject).toEqual({ "proj-b": 4 });
    expect(scoped.data.recent.map((issue) => issue.projectId)).toEqual(["proj-b", "proj-b", "proj-b", "proj-b"]);
    expect(scoped.storeRevision).toBe(whole.storeRevision);
    // invariant: The proof names the actual selection: one summary proof can never stand
    // for both the repository rollup and a project filter.
    expect(whole.collaboration?.scope).toEqual({ kind: "repository", key: "open-issues:repository" });
    expect(scoped.collaboration?.scope).toEqual({ kind: "project", key: "proj-b" });
    expect(scoped.collaboration?.scope).not.toEqual(whole.collaboration?.scope);

    await registerProject(context, "proj-empty");
    const zero = await withStoreRead(context, queryOpenIssueRollup("proj-empty"));
    expect(zero.data).toEqual({
      totalOpen: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
      byProject: {},
      recent: [],
    });
    // note: A blank project id is a request shape the contract does not define.
    expect(() => queryOpenIssueRollup(" ")).toThrow();
  });

  test("collaboration rollup snapshot: a missing or staged lane refuses instead of totalling zero", async () => {
    const { context: staged } = await workspace("rollup-staged-");
    await withWrite(staged, (db) => db.exec("update collaboration_meta set authority_state = 'staged' where id = 1"));
    await expect(withStoreRead(staged, queryOpenIssueRollup())).rejects.toMatchObject({ code: "collaboration.not-active" });

    const dir = mkdtempSync(join(ROOT, "rollup-missing-"));
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/rollup-missing.git"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execFileSync("git", ["config", `url.${dir}.insteadOf`, "https://github.com/acme/rollup-missing.git"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    writeFileSync(join(dir, ".mstarc"), "[collaboration]\nmode=local\n");
    mkdirSync(join(dir, ".mstar"), { recursive: true });
    await expect(withStoreRead({ harnessDir: join(dir, ".mstar") }, queryOpenIssueRollup())).rejects.toMatchObject({
      code: "collaboration.not-initialized",
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
      // A removed subject retires like any other terminal disposition: it leaves
      // `open` and joins the retired count without being reported as a fix.
      seedIssue(db, { id: "I-000006", title: "obsolete", disposition: "obsolete", registeredAt: "2026-09-01", closedAt: "2026-09-04" });
      seedIssue(db, { id: "I-000005", title: "still open", registeredAt: "2026-09-04" });
    });

    const flow = await withStoreRead(context, queryIssueFlow());
    const last = flow.data.buckets[flow.data.buckets.length - 1] as IssueFlow["buckets"][number];
    expect(flow.data.buckets.map((bucket) => bucket.retiredCumulative)).toEqual([0, 2, 4, 5]);
    expect(last.retiredCumulative).toBe(5);
    expect(last.capturedCumulative).toBe(6);
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
    const { context } = await projectedWorkspace("old-generation-");
    const published = await withStoreRead(context, queryDashboard("workflows"));
    // The projection view refreshes before reading, so the generation this
    // request discloses IS the store's current publication.
    const generation = published.projection.generation;
    expect(generation).not.toBeNull();

    await withWrite(context, (db) => seedIssue(db, { id: "I-000001", title: "edited later", registeredAt: "2026-09-18" }));

    // invariant: An issue-only read never refreshes and never opens the execution lane,
    // so it discloses no projection observation at all.
    const issues = await withStoreRead(context, queryDashboard("issues"));
    expect(issues.data.total).toBe(1);
    expect(issues.projection.observed).toBe(false);
    expect(issues.projection.generation).toBeNull();
    expect(issues.storeRevision).not.toBeNull();

    // A projection read refreshes and ADOPTS the current generation when the
    // source fingerprint is unchanged (no rewrite), so it discloses the store's
    // actual published generation while the data itself is unchanged.
    const refreshed = await withStoreRead(context, queryDashboard("workflows"));
    expect(refreshed.projection.freshness).toBe("current");
    expect(refreshed.data.items.map((item) => item.id)).toEqual(["wf-read"]);
    const handle = await openStore(context, "read");
    try {
      const published = handle.db.prepare("select generation from projection_meta where id = 1").get() as {
        generation: number | null;
      };
      expect(refreshed.projection.generation).toBe(published.generation);
    } finally {
      handle.close();
    }
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
    expect(workflow.plans[0]?.leases.map((lease) => lease.kind)).toEqual(["integration-merge"]);

    const detail = await withStoreRead(context, queryDashboard("workflow-detail", { id: "wf-read" }));
    expect(detail.data).toEqual(workflow);
    expect((await withStoreRead(context, queryDashboard("workflow-detail", { id: "nope" }))).data).toBeNull();
  });

  test("a missing catalog link is a badge, not a guessed join", async () => {
    const { context, harness } = await workspace("workflow-unlinked-");
    // The workflow is registered through the ACTIVE producer with NO catalog
    // entity for the plan: the join by id finds nothing and must disclose a
    // badge instead of guessing.
    const created = await readExecutionState(context);
    const catalogAuthority = await readCollaborationAuthority(context);
    // Creation BINDS existing catalog identities (it never fabricates one), so
    // the plan entity is registered while the workflow/plan LINK is absent --
    // the join by id then finds nothing and must disclose a badge.
    await registerCatalogEntity(
      context,
      { kind: "plan", id: "wf-read", title: "Plan wf-read", rootKind: "plans", relativePath: "wf-read.md" },
      op("unlinked-plan"),
    );
    const caller: ExecutionCaller = { sessionId: "unlinked-coordinator", role: "coordinator", workflowId: "wf-read" };
    await createExecutionWorkflow({ harnessDir: harness, caller }, {
      entry: { id: "wf-read", type: "plan", started_at: STARTED_AT, dir: "workflows/wf-read" },
      snapshot: {
        schema_version: 1, id: "wf-read", type: "plan", status: "running", started_at: STARTED_AT,
        updated_at: STARTED_AT, phase: "phase-2-execute",
        branch: { base: "main", source: "feature/wf-read", target: "main" },
        plans: [{
          id: "wf-read", title: "Plan wf-read", file: "plans/wf-read.md", status: "InProgress",
          metadata: {
            catalog_pin: {
              store_id: catalogAuthority.storeId,
              entity_revision: 1,
              document_hash: executionInputHash({ id: "wf-read", plan_id: "wf-read" }, "wf-read"),
              relation_hash: "0".repeat(64),
            },
          },
        }],
        delivery_kind: "development",
      } as never,
      expected: created.token,
      operationId: "unlinked-create",
    });
    // The catalog row the workflow's plan bound at creation is gone: the join
    // by id finds nothing and must disclose a badge, never fabricate a row.
    await withWrite(context, (db) => {
      db.prepare("delete from catalog_links where from_id = ? or to_id = ?").run("wf-read", "wf-read");
      db.prepare("delete from catalog_entities where kind = 'plan' and id = ?").run("wf-read");
      db.prepare("update collaboration_meta set catalog_revision = catalog_revision + 1 where id = 1").run();
    });
    await refreshProjections(context);

    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    const workflow = envelope.data.items[0] as WorkflowDTO;
    expect(workflow.catalog).toBeNull();
    expect(workflow.badges).toEqual(["catalog-missing"]);
    expect(workflow.plans[0]?.catalog).toBeNull();
    // The frozen pin is disclosed even when the catalog row it refers to is gone.
    expect(workflow.plans[0]?.catalogPinRevision).toBe(1);
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
    // execution row and the iteration workflow's row for the same plan. The
    // pre-activation file route is retired (issue #428), so the graph is built
    // through the ACTIVE producer.
    const seeded = await readExecutionState(context);
    const catalogAuthority = await readCollaborationAuthority(context);
    const dupPlan = await getCatalog(context, { kind: "plan", id: "wf-dup" });
    const pinFor = (revision: number) => ({
      store_id: catalogAuthority.storeId,
      entity_revision: revision,
      document_hash: executionInputHash({ id: "wf-dup", plan_id: "wf-dup", title: "Plan wf-dup" }, "wf-dup"),
      relation_hash: "0".repeat(64),
    });
    await createExecutionWorkflow(
      { harnessDir: harness, caller: { sessionId: "dup-plan-coordinator", role: "coordinator" as const, workflowId: "wf-dup" } },
      {
        entry: { id: "wf-dup", type: "plan", started_at: STARTED_AT, dir: "workflows/wf-dup" },
        snapshot: {
          schema_version: 1, id: "wf-dup", type: "plan", status: "running", started_at: STARTED_AT,
          updated_at: STARTED_AT, phase: "phase-2-execute",
          branch: { base: "main", source: "feature/wf-dup", target: "main" },
          plans: [{
            id: "wf-dup", title: "Plan wf-dup", file: "plans/wf-dup.md", status: "InProgress",
            metadata: { catalog_pin: pinFor(7), worktree_path: "/wt/wf-dup", working_branch: "feature/wf-dup" },
          }],
          delivery_kind: "development",
        } as never,
        expected: seeded.token,
        operationId: "dup-plan-create",
      },
    );
    const afterPlan = await readExecutionState(context);
    await createExecutionWorkflow(
      { harnessDir: harness, caller: { sessionId: "dup-iter-coordinator", role: "coordinator" as const, workflowId: "iter-dup" } },
      {
        entry: { id: "iter-dup", type: "iteration", started_at: STARTED_AT, dir: "workflows/iter-dup" },
        snapshot: {
          schema_version: 1, id: "iter-dup", type: "iteration", status: "running", started_at: STARTED_AT,
          updated_at: STARTED_AT, phase: "phase-3-close",
          branch: { base: "main", source: "feature/wf-dup", integration: "integrate/iter-dup", target: "main" },
          plans: [{
            id: "wf-dup", title: "Plan wf-dup", file: "plans/wf-dup.md", status: "Blocked",
            metadata: { catalog_pin: pinFor(9), worktree_path: "/wt/iter-dup", working_branch: "integrate/iter-dup" },
          }],
        } as never,
        expected: afterPlan.token,
        operationId: "dup-iter-create",
      },
    );
    const dupHandle = await openStore(context, "write");
    try {
      dupHandle.db.prepare("update execution_plans set coordination_json = ? where workflow_id = ? and plan_id = ?")
        .run(JSON.stringify({ progress: { status: "InProgress", summary: "plan-workflow progress", evidence_paths: [] } }), "wf-dup", "wf-dup");
      dupHandle.db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    } finally { dupHandle.close(); }
    const dupPlanCatalog = await getCatalog(context, { kind: "plan", id: "wf-dup" });
    expect(dupPlan.entity.revision).toBe(dupPlanCatalog.entity.revision);
    await refreshProjections(context);

    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    const planWorkflow = envelope.data.items.find((item) => item.id === "wf-dup") as WorkflowDTO;
    const iterationWorkflow = envelope.data.items.find((item) => item.id === "iter-dup") as WorkflowDTO;

    // Each workflow keeps its own row state and pin revision.
    expect(planWorkflow.plans[0]?.status).toBe("InProgress");
    expect(planWorkflow.plans[0]?.progress).toBe("plan-workflow progress");
    expect(planWorkflow.plans[0]?.catalogPinRevision).toBe(7);
    expect(planWorkflow.plans[0]?.leases).toEqual([]);

    expect(iterationWorkflow.plans[0]?.status).toBe("Blocked");
    expect(iterationWorkflow.plans[0]?.catalogPinRevision).toBe(9);
    expect(iterationWorkflow.plans[0]?.leases).toEqual([]);

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
    expect(before.data?.content?.contentMarkdown).toBe(ROADMAP_DOC);
    expect(before.data?.content?.direction).toContain("Serve the dashboard from the store");
    expect(before.data?.content?.goals.map(({ title, checked }) => ({ title, checked }))).toEqual([
      { title: "Ship the read boundary", checked: true },
      { title: "Ship the dashboard", checked: false },
    ]);
    expect(before.data?.content?.milestones).toEqual(["Read boundary"]);

    rmSync(join(harness, "projects/proj-a/roadmap.md"), { force: true });
    const after = await withStoreRead(context, queryDashboard("roadmap", { projectId: "proj-a" }));
    expect(after.data).toEqual(before.data);
    expect(after.projection.observed).toBe(false);
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
    const { context } = await workspace("unavailable-");
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare("insert into execution_workflows(workflow_id, creator_session_id, revision, state_json, created_at, updated_at) values ('wf-corrupt', null, 1, ?, ?, ?)")
        .run(JSON.stringify({ schema_version: 1, id: "wf-corrupt", type: "plan", status: "running", started_at: STARTED_AT, updated_at: STARTED_AT }), STARTED_AT, STARTED_AT);
      handle.db.prepare("insert into execution_registry(workflow_id, entry_json) values ('wf-corrupt', '{ malformed')").run();
    } finally { handle.close(); }
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    expect(envelope.projection.generation).toBeNull();
    expect(envelope.projection.freshness).toBe("unavailable");
    expect(envelope.projection.builtAt).toBeNull();
    expect(envelope.projection.diagnostics.map((diagnostic) => diagnostic.sourceKey)).toContain("root:harness:execution/registry");
    expect(envelope.data).toEqual({ items: [], total: 0 });
  });

  test("a projection view reads only committed store data, never source JSON", async () => {
    const { context } = await projectedWorkspace("no-source-io-");
    // The view layer must not consult sources: corrupt the ACTIVE registry
    // after publication and retain the already-committed generation.
    await withExecutionWrite(context, (db) => {
      db.prepare("update execution_registry set entry_json = '{ malformed' where workflow_id = 'wf-read'").run();
      db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
    });
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    expect(envelope.projection.freshness).toBe("stale");
    expect(envelope.projection.generation).not.toBeNull();
    expect(envelope.data.items.map((item) => item.id)).toEqual(["wf-read"]);
    expect(envelope.projection.diagnostics.some((diagnostic) => diagnostic.reason === "invalid")).toBe(true);
    // The view answers from the retained generation, whose bytes on disk are
    // already gone: no source read could have produced this data.
  });
});

describe("projects view", () => {
  test("mixed catalog and issue-only projects sort by displayed title then id", async () => {
    const { context } = await workspace("mixed-project-order-");
    await registerCatalogEntity(context, { kind: "project", id: "registered-first", title: "Alpha", rootKind: "projects", relativePath: "first" }, op("register-first"));
    await registerCatalogEntity(context, { kind: "project", id: "a-tie", title: "middle", rootKind: "projects", relativePath: "tie" }, op("register-tie"));
    await registerCatalogEntity(context, { kind: "project", id: "registered-last", title: "zulu", rootKind: "projects", relativePath: "last" }, op("register-last"));
    await withWrite(context, (db) => {
      seedIssue(db, { id: "middle-issue", title: "Middle", projectId: "middle" });
    });
    const projects = (await withStoreRead(context, queryDashboard("projects"))).data;
    expect(projects.items.map(({ project }) => project.id)).toEqual(["registered-first", "a-tie", "middle", "registered-last"]);
  });

  test("issue-only projects reconcile with Issues without inventing catalog metadata", async () => {
    const { context } = await workspace("implicit-projects-");
    await withWrite(context, (db) => {
      seedIssue(db, { id: "implicit-one", title: "One", projectId: "default" });
      seedIssue(db, { id: "implicit-two", title: "Two", projectId: "default" });
      seedIssue(db, { id: "closed-only", title: "Closed", projectId: "other", disposition: "resolved" });
    });
    const projects = (await withStoreRead(context, queryDashboard("projects"))).data;
    const issues = (await withStoreRead(context, queryDashboard("issues", { issue: { projectId: "default", disposition: "open" } }))).data;
    expect(projects.total).toBe(2);
    expect(projects.items.find(({ project }) => project.id === "default")).toEqual({
      project: { id: "default", title: "default", description: null, lifecycle: null },
      openIssues: issues.total,
    });
    expect(issues.total).toBe(2);
    expect(projects.items.find(({ project }) => project.id === "other")?.openIssues).toBe(0);
    await registerCatalogEntity(context, { kind: "project", id: "default", title: "Registered default", rootKind: "projects", relativePath: "default" }, op("register-default"));
    const registered = (await withStoreRead(context, queryDashboard("projects"))).data;
    expect(registered.total).toBe(projects.total);
    expect(registered.items.find(({ project }) => project.id === "default")?.project.title).toBe("Registered default");
  });

  test("projects returns every project in deterministic title/id order with identity and open issue counts", async () => {
    const { context } = await workspace("projects-");
    await registerCatalogEntity(context, { kind: "project", id: "z-project", title: "Same", rootKind: "projects", relativePath: "z" }, op("project-z"));
    await registerCatalogEntity(context, { kind: "project", id: "a-project", title: "Same", rootKind: "projects", relativePath: "a" }, op("project-a"));
    for (let i = 0; i < 53; i++) {
      await registerCatalogEntity(context, {
        kind: "project", id: `project-${String(i).padStart(2, "0")}`, title: `Project ${String(i).padStart(2, "0")}`,
        rootKind: "projects", relativePath: `project-${i}`,
      }, op(`project-${i}`));
    }
    await registerCatalogEntity(context, { kind: "plan", id: "plan-only", title: "Plan", rootKind: "plans", relativePath: "plan" }, op("plan-only"));
    await registerCatalogEntity(context, { kind: "iteration", id: "iteration-only", title: "Iteration", rootKind: "plans", relativePath: "iteration" }, op("iteration-only"));
    await registerCatalogEntity(context, { kind: "document", id: "document-only", title: "Document", rootKind: "projects", relativePath: "document", documentKind: "spec" }, op("document-only"));
    await withWrite(context, (db) => {
      seedIssue(db, { id: "project-issue-open", title: "Open", projectId: "a-project" });
      seedIssue(db, { id: "project-issue-open-2", title: "Open 2", projectId: "a-project" });
      seedIssue(db, { id: "project-issue-closed", title: "Resolved", projectId: "a-project", disposition: "resolved" });
    });
    const first = await withStoreRead(context, queryDashboard("projects", { limit: 1, offset: 3 }));
    const second = await withStoreRead(context, queryDashboard("projects"));
    expect(first.data.items).toHaveLength(55);
    expect(first.data.total).toBe(55);
    expect(first.data.items.map(({ project }) => project.id)).toEqual(second.data.items.map(({ project }) => project.id));
    expect(first.data.items.filter(({ project }) => project.title === "Same").map(({ project }) => project.id)).toEqual(["a-project", "z-project"]);
    expect(first.data.items.find(({ project }) => project.id === "a-project")).toEqual({
      project: expect.objectContaining({
        kind: "project", id: "a-project", title: "Same", description: null, rootKind: "projects",
        relativePath: "a", documentKind: null, lifecycle: "active", revision: expect.any(Number),
        registeredAt: expect.any(String), updatedAt: expect.any(String),
      }),
      openIssues: 2,
    });
    expect(first.data.items.find(({ project }) => project.id === "z-project")?.openIssues).toBe(0);
    expect(first.data.items.some(({ project }) => ["plan-only", "iteration-only", "document-only"].includes(project.id))).toBe(false);
  });

  test("projects empty catalog returns an empty successful list", async () => {
    const { context } = await workspace("projects-empty-");
    expect((await withStoreRead(context, queryDashboard("projects"))).data).toEqual({ items: [], total: 0 });
  });
});

describe("collaboration creation catalog authority", () => {
  test("direct creation seals a full catalog pin through the collaboration catalog", async () => {
    const { context, planRevision } = await projectedWorkspace("creation-pin-");
    const state = await readExecutionState(context);
    const flow = state.data.workflows.find((workflow) => workflow.state.id === "wf-read");
    expect(flow?.plans[0]?.frozenInput).toMatchObject({ entity_revision: planRevision });
  });
});


  test("iteration views refuse when the collaboration catalog is unavailable", async () => {
    const { context } = await projectedWorkspace("iteration-refusal-");
    rmSync(resolveCollaborationLocation(context).dbPath, { force: true });
    // invariant: Membership, attribution and the subject itself are catalog facts: the
    // read refuses instead of answering an empty page or an absent record.
    await expect(withStoreRead(context, queryDashboard("iterations"))).rejects.toMatchObject({
      code: "collaboration.not-initialized",
    });
    await expect(withStoreRead(context, queryDashboard("iteration-detail", { id: "iter-read" }))).rejects.toMatchObject({
      code: "collaboration.not-initialized",
    });
  });

  test("a pinned creation replays its receipt after the collaboration catalog becomes unavailable", async () => {
    const { context, harness } = await workspace("creation-replay-");
    await registerProject(context, "proj-a");
    await registerCatalogEntity(
      context,
      { kind: "plan", id: "p-replay", title: "Replay plan", rootKind: "plans", relativePath: "plans/p-replay.md" },
      op("replay-plan"),
    );
    const authority = await readCollaborationAuthority(context);
    const plan = await getCatalog(context, { kind: "plan", id: "p-replay" });
    const state = await readExecutionState(context);
    const row = { id: "p-replay", title: "Replay plan", file: "plans/p-replay.md", status: "InProgress" };
    const snapshot = {
      schema_version: 1,
      id: "wf-replay",
      type: "plan",
      status: "running",
      started_at: STARTED_AT,
      updated_at: STARTED_AT,
      phase: "phase-2-execute",
      plans: [
        {
          ...row,
          metadata: {
            catalog_pin: {
              store_id: authority.storeId,
              entity_revision: plan.entity.revision,
              document_hash: executionInputHash(row, "p-replay"),
              relation_hash: "0".repeat(64),
            },
          },
        },
      ],
      delivery_kind: "development",
    } as never;
    const caller: ExecutionCaller = { sessionId: "replay-coordinator", role: "coordinator", workflowId: "wf-replay" };
    const input = {
      entry: { id: "wf-replay", type: "plan" as const, started_at: STARTED_AT, dir: "workflows/wf-replay" },
      snapshot,
      expected: state.token,
      operationId: "replay-pinned",
    };
    const first = await createExecutionWorkflow({ harnessDir: harness, caller }, input);
    rmSync(resolveCollaborationLocation(context).dbPath, { force: true });
    // note: The lost-response retry answers from its committed execution receipt; it
    // no longer depends on a fresh collaboration preflight.
    const replay = await createExecutionWorkflow({ harnessDir: harness, caller }, input);
    expect(replay.replayed).toBe(true);
    expect(replay.storeId).toBe(first.storeId);
    expect(replay.token).toEqual(first.token);
  });

  test("a failed required execution open leaves the collaboration lane usable", async () => {
    const { context } = await workspace("mixed-open-failure-");
    // invariant: A damaged execution metadata record: the execution lane refuses with its own
    // code while the collaboration lane's state stays intact and inspectable.
    const damaged = new DatabaseSync(storeDbPath(context));
    try {
      damaged.prepare("delete from execution_meta where id = 1").run();
    } finally {
      damaged.close();
    }
    const probe = {
      view: "mixed-open-probe",
      needsProjection: false,
      collaboration: { scope: { kind: "query" as const, key: "mixed-open-probe" }, required: true },
      execution: "required" as const,
      run: () => ({ data: 0 }),
    };
    // invariant: The collaboration handle opens first; the required execution open then
    // fails. Repeating the failed read must not accumulate handles, so the lane
    // stays readable afterwards.
    for (const attempt of [1, 2, 3]) {
      const failure = await withStoreRead(context, probe).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as { code?: unknown }).code)).toStartWith("store.");
      expect(attempt).toBeGreaterThan(0);
    }
    await withWrite(context, (db) => seedIssue(db, { id: "I-1", title: "still usable", registeredAt: "2026-09-01" }));
    const issues = await withStoreRead(context, queryDashboard("issues"));
    expect(issues.data.total).toBe(1);
  });

describe("collaboration read boundary", () => {
  test("a pure collaboration view never opens the execution lane", async () => {
    const { context } = await workspace("boundary-pure-");
    await withWrite(context, (db) => seedIssue(db, { id: "I-1", title: "only collaboration", registeredAt: "2026-09-01" }));
    // invariant: Remove the execution lane entirely: a collaboration-only view must still
    // answer, while an execution view names the lane it could not open.
    rmSync(storeDbPath(context), { force: true });
    const issues = await withStoreRead(context, queryDashboard("issues"));
    expect(issues.data.total).toBe(1);
    expect(issues.execution).toBeNull();
    expect(issues.projection.observed).toBe(false);
    expect(issues.storeRevision).not.toBeNull();
    expect(issues.collaboration).toMatchObject({ completeness: "complete" });
    await expect(withStoreRead(context, queryDashboard("workflows"))).rejects.toMatchObject({ code: "store.not-initialized" });
  });

  test("an optional unavailable source is disclosed, never mapped to legacy or zero", async () => {
    const { context } = await projectedWorkspace("boundary-optional-");
    rmSync(resolveCollaborationLocation(context).dbPath, { force: true });
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    // note: The execution rows still answer, the catalog association is disclosed as
    // unavailable, and no collaboration counter is claimed as zero.
    expect(envelope.data.items.map((item) => item.id)).toEqual(["wf-read"]);
    expect(envelope.data.items[0]?.catalog).toBeNull();
    expect(envelope.storeRevision).toBeNull();
    expect(envelope.catalogRevision).toBeNull();
    expect(envelope.collaboration).toMatchObject({ completeness: "unavailable" });
    expect(envelope.execution).toMatchObject({ asOf: expect.any(String) });
    expect(envelope.projection.observed).toBe(true);
  });

  test("a known content gap keeps the source's own code as a partial observation", async () => {
    const { context } = await workspace("boundary-gap-");
    const envelope = await withStoreRead(context, {
      view: "gap-probe",
      needsProjection: false,
      collaboration: { scope: { kind: "project", key: "proj-a" }, required: true },
      execution: "not-requested",
      run: () => ({ data: { rows: 0 }, collaborationGap: "catalog.discovery.missing-plan" }),
    });
    expect(envelope.collaboration).toMatchObject({
      completeness: "partial",
      code: "catalog.discovery.missing-plan",
      scope: { kind: "project", key: "proj-a" },
    });
    // note: A partial snapshot still reports the revision it read at.
    expect(envelope.storeRevision).not.toBeNull();
  });
});

describe("collaboration projection sources", () => {
  test("capture carries the collaboration catalog revision independently of the execution revision", async () => {
    const { context, planRevision } = await projectedWorkspace("projection-sources-split-");
    const capture = await captureProjectionSources(context);
    expect(capture.blocked).toBe(false);
    expect(capture.catalogRevision).toBeGreaterThan(0);
    expect(capture.executionRevision).toBeGreaterThan(0);

    // note: Move the catalog: only the collaboration revision may follow it.
    await updateCatalogEntity(context, { kind: "plan", id: "wf-read" }, { title: "Renamed" }, planRevision, op("rename-source"));
    const moved = await captureProjectionSources(context);
    expect(moved.catalogRevision).toBe((capture.catalogRevision ?? 0) + 1);
    expect(moved.executionRevision).toBe(capture.executionRevision);
  });

  test("a missing collaboration catalog blocks publication instead of publishing empty rows", async () => {
    const { context, generation } = await projectedWorkspace("projection-sources-missing-");
    rmSync(resolveCollaborationLocation(context).dbPath, { force: true });
    const report = await refreshProjections(context);
    expect(report.published).toBe(false);
    expect(report.generation).toBe(generation);
    expect(report.diagnostics.some((diagnostic) => diagnostic.sourceKey === "catalog")).toBe(true);
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    expect(envelope.projection.freshness).toBe("stale");
    expect(envelope.data.items.map((item) => item.id)).toEqual(["wf-read"]);
  });

  test("a corrupt collaboration catalog is not read as no rows", async () => {
    const { context, generation } = await projectedWorkspace("projection-sources-corrupt-");
    writeFileSync(resolveCollaborationLocation(context).dbPath, "not a database");
    const report = await refreshProjections(context);
    expect(report.published).toBe(false);
    expect(report.generation).toBe(generation);
    expect(report.diagnostics.some((diagnostic) => diagnostic.sourceKey === "catalog")).toBe(true);
    const envelope = await withStoreRead(context, queryDashboard("workflows"));
    expect(envelope.collaboration).toMatchObject({ completeness: "unavailable" });
    expect(envelope.data.items.map((item) => item.id)).toEqual(["wf-read"]);
  });
});

// ---------------------------------------------------------------------------
// Remote read boundary: admitted evidence only, never a local-row zero
// ---------------------------------------------------------------------------

describe("remote read boundary", () => {
  async function boundScope(name: string) {
    const fixture = createRemoteScope(ROOT, name);
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    await ingestRemoteObservation(context, submission(commit, check, completeSnapshot(check), 0));
    return { fixture, context, commit, check };
  }

  function cacheState(dbPath: string) {
    const db = new DatabaseSync(dbPath);
    try {
      const count = (table: string): number => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
      return {
        issues: count("issues"),
        catalog: count("catalog_entities"),
        bindings: count("remote_bindings"),
        observations: count("remote_observations"),
        identities: count("remote_issue_identities"),
      };
    } finally {
      db.close();
    }
  }

  test("complete evidence serves findings and keeps an unmarked native issue visible, never counted", async () => {
    const { context, commit } = await boundScope("remote-read-complete");
    const page = await withStoreRead(context, queryDashboard("issues"));
    expect(page.data.total).toBe(1);
    expect(page.data.items).toEqual([
      expect.objectContaining({
        id: REMOTE_IDS.issueRef,
        issueRef: REMOTE_IDS.issueRef,
        severity: "high",
        disposition: "open",
        nativeStatus: "Todo",
      }),
    ]);
    expect(page.data.providerIssues).toEqual([
      expect.objectContaining({
        kind: "provider-only",
        issueRef: null,
        title: "Unmarked native issue",
        nativeStatus: "Done",
        projectId: REMOTE_IDS.projectId,
      }),
    ]);
    expect(page.collaboration).toMatchObject({
      source: "remote",
      completeness: "complete",
      selectorCommit: commit,
      generation: 3,
      providerScopes: [
        expect.objectContaining({ projectId: REMOTE_IDS.projectId, completeness: "complete", asOf: expect.any(String) }),
      ],
    });

    // invariant: The stable IssueRef resolves; the unmarked issue is visible ONLY by exact provider id + project.
    const detail = await withStoreRead(context, queryDashboard("issue-detail", { id: REMOTE_IDS.issueRef }));
    expect(detail.data).toMatchObject({
      id: REMOTE_IDS.issueRef,
      issueRef: REMOTE_IDS.issueRef,
      nativeStatus: "Todo",
      providerIdentity: expect.objectContaining({ issueId: REMOTE_IDS.markedIssueId }),
    });
    const native = await withStoreRead(
      context,
      queryDashboard("issue-detail", { id: REMOTE_IDS.providerOnlyIssueId, projectId: REMOTE_IDS.projectId }),
    );
    expect(native.data).toMatchObject({ kind: "provider-only", issueRef: null, nativeStatus: "Done", projectId: REMOTE_IDS.projectId });
    await expect(
      withStoreRead(context, queryDashboard("issue-detail", { id: REMOTE_IDS.providerOnlyIssueId })),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });

    const listed = await listIssues(context, {});
    expect(listed.total).toBe(1);
    expect(listed.providerIssues).toHaveLength(1);
    expect(await showIssue(context, REMOTE_IDS.issueRef)).toMatchObject({ id: REMOTE_IDS.issueRef });
    expect(await showIssue(context, REMOTE_IDS.providerOnlyIssueId, REMOTE_IDS.projectId)).toMatchObject({
      kind: "provider-only",
      nativeStatus: "Done",
    });
    // invariant: A native `Done` never closes anything: remote writes are not this cache's.
    await expect(
      closeIssue(
        context,
        REMOTE_IDS.issueRef,
        "resolved",
        { reason: "native done", references: ["native-status"], alignmentRef: "fixture" },
        { operationId: randomUUID(), actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "collaboration.mode-unavailable" });
  });

  test("a partial, negative or stale scope refuses required views instead of answering zero", async () => {
    const { context, commit, check } = await boundScope("remote-read-partial");
    await ingestRemoteObservation(context, submission(commit, check, partialSnapshot(check), 1));
    await expect(withStoreRead(context, queryDashboard("issues"))).rejects.toMatchObject({
      code: "collaboration.observation-incomplete",
    });
    await expect(withStoreRead(context, queryOpenIssueRollup())).rejects.toMatchObject({
      code: "collaboration.observation-incomplete",
    });
    await expect(withStoreRead(context, queryMilestones(REMOTE_IDS.projectId))).rejects.toMatchObject({
      code: "collaboration.observation-incomplete",
    });

    // note: A negative check persists its invalidation and returns the named refusal.
    const denied = negativeCheck({ checkedAt: new Date().toISOString() });
    await expect(ingestRemoteObservation(context, submission(commit, denied, null, 2))).rejects.toMatchObject({
      code: "remote.denied",
    });
    await expect(withStoreRead(context, queryDashboard("issue-flow"))).rejects.toMatchObject({ code: "remote.unavailable" });
  });

  test("findings count MStar subjects only, and plan completion re-samples the same remote scope", async () => {
    const { context, commit, check } = await boundScope("remote-read-findings");
    const observation = await observePlanFindings(context, "20261122-remote-authority");
    expect(observation.source).toBe("remote");
    expect(observation.open).toEqual([{ id: REMOTE_IDS.issueRef, severity: "high" }]);
    const gate = await findingsCleanupGate(context, "20261122-remote-authority", { mode: "zero-residual" });
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((violation) => violation.message).join(" ")).toContain(REMOTE_IDS.issueRef);
    expect(gate.violations.map((violation) => violation.message).join(" ")).not.toContain(REMOTE_IDS.providerOnlyIssueId);

    await expect(assertPlanFindingsCurrent(context, observation)).resolves.toBeUndefined();

    // note: A partial refresh refuses the findings read, never "no findings".
    await ingestRemoteObservation(context, submission(commit, check, partialSnapshot(check), 1));
    await expect(observePlanFindings(context, "20261122-remote-authority")).rejects.toMatchObject({
      code: "collaboration.observation-incomplete",
    });

    // note: A complete replacement moves the aggregate revision, so the pre-commit
    // re-sample of a completion record refuses as stale.
    const refreshed = positiveCheck();
    await ingestRemoteObservation(context, submission(commit, refreshed, completeSnapshot(refreshed), 2));
    await expect(assertPlanFindingsCurrent(context, observation)).rejects.toMatchObject({
      code: "collaboration.observation-stale",
    });
  });

  test("project, milestone, roadmap and flow reads use admitted snapshot evidence", async () => {
    const { context } = await boundScope("remote-read-views");
    const projects = await withStoreRead(context, queryDashboard("projects"));
    expect(projects.data).toEqual({
      items: [
        {
          project: { id: REMOTE_IDS.projectId, title: "Fixture project", description: null, lifecycle: "active" },
          openIssues: 1,
        },
      ],
      total: 1,
    });

    const milestones = await withStoreRead(context, queryMilestones(REMOTE_IDS.projectId));
    expect(milestones.data.milestones).toEqual([
      expect.objectContaining({ milestoneId: "milestone-1", totalIssues: 1, openIssues: 1, resolvedIssues: 0 }),
    ]);
    expect(milestones.data.issues).toEqual([expect.objectContaining({ id: REMOTE_IDS.issueRef, milestoneId: "milestone-1" })]);

    const binding = await readProjectBinding(context, REMOTE_IDS.projectId);
    expect(binding).toMatchObject({
      kind: "bound",
      binding: {
        provider: "linear",
        workspace: REMOTE_IDS.workspaceId,
        team: REMOTE_IDS.teamId,
        remoteProject: REMOTE_IDS.providerProjectId,
      },
    });

    const roadmap = await withStoreRead(context, queryDashboard("roadmap", { projectId: REMOTE_IDS.projectId }));
    expect(roadmap.data).toMatchObject({
      projectId: REMOTE_IDS.projectId,
      catalog: { id: REMOTE_IDS.projectId, source: "remote", relativePath: null },
      authority: { state: "present", revision: 2 },
    });
    const authority = await readRoadmapAuthority(context, REMOTE_IDS.projectId);
    expect(authority.roadmap).toMatchObject({ projectId: REMOTE_IDS.projectId, revision: 2 });

    const flow = await withStoreRead(context, queryDashboard("issue-flow"));
    expect(flow.data.currentOpen).toBe(1);
    expect(flow.collaboration).toMatchObject({ source: "remote", completeness: "complete" });
  });

  test("adoption validates the exact unmarked issue and refuses outbox-unavailable without mutation", async () => {
    const { context } = await boundScope("remote-read-adopt");
    const dbPath = resolveCollaborationLocation(context).dbPath;
    const before = cacheState(dbPath);
    const capture = {
      kind: "bug",
      severity: "high",
      impact: "i",
      acceptance: "a",
      sourceIdentity: "review:adoption",
      rootCauseKey: "remote.adoption",
      acceptanceKey: "remote.adoption.stored",
      occurrenceKey: "adoption-occurrence",
      sourceKind: "review",
      location: "packages/engine/src/collaboration-remote.ts",
      observedBehavior: "The cache refused an adoption intent.",
      evidence: ["fixture"],
      discoveredAt: FIXTURE_AT,
    };
    const adoption = { version: 1, kind: "new", capture };

    await expect(
      prepareRemoteAdoption(context, {
        projectId: REMOTE_IDS.projectId,
        issueId: REMOTE_IDS.providerOnlyIssueId,
        operationId: randomUUID(),
        adoption,
      }),
    ).rejects.toMatchObject({ code: "remote.outbox-unavailable" });

    // invariant: An already marked issue refuses; a title is never accepted from the caller.
    await expect(
      prepareRemoteAdoption(context, {
        projectId: REMOTE_IDS.projectId,
        issueId: REMOTE_IDS.markedIssueId,
        operationId: randomUUID(),
        adoption,
      }),
    ).rejects.toMatchObject({ code: "remote.scope-mismatch" });
    await expect(
      prepareRemoteAdoption(context, {
        projectId: REMOTE_IDS.projectId,
        issueId: REMOTE_IDS.providerOnlyIssueId,
        operationId: randomUUID(),
        adoption: { ...adoption, capture: { ...capture, title: "forged title" } },
      }),
    ).rejects.toMatchObject({ code: "remote.input-invalid" });

    // invariant: No cache-only adoption exists: the local tables and every remote row are unchanged.
    expect(cacheState(dbPath)).toEqual(before);
  });
});
