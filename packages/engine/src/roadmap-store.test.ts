import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { registerCatalogEntity } from "./catalog.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, writeCollaborationBinding } from "./collaboration-store.js";
import { bindRemoteAuthority, ingestRemoteObservation } from "./collaboration-remote.js";
import { completeSnapshot, createRemoteScope, positiveCheck, REMOTE_IDS, submission } from "./remote-scope.fixture.js";
import {
  importRoadmapAuthority,
  initializeStore,
  listRoadmapAuthority,
  openStore,
  readRoadmapAuthority,
  replaceRoadmapAuthority,
  reviewRoadmapImport,
  type StoreContext,
} from "./index.js";

const ROOT = mkdtempSync(join(nodeOs.tmpdir(), "tmp-roadmap-authority-"));
const HOME = join(ROOT, "home");
mkdirSync(HOME);
let homeSpy: { mockRestore(): void } | undefined;
const fixtures: string[] = [];
const content = (projectId: string, description: string): string =>
  `---\nproject_id: ${projectId}\ntitle: Synthetic roadmap\nstatus: active\ncreated_at: 2026-09-25\ncustom_field: preserved\n---\n\n## Direction\n\n${description}\n\n## Goals\n\n- [ ] Parent goal\n  - [x] Nested goal\n\n`;

/** note: A synthetic checkout whose origin names the collaboration repository. */
function checkout(name: string): StoreContext {
  const parent = mkdtempSync(join(ROOT, name));
  const repo = join(parent, "repo");
  fixtures.push(parent);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
  // note: The live selector lookup is real Git I/O; route the synthetic origin to this fixture's
  // own repository, which never publishes the selector ref.
  execFileSync("git", ["config", `url.${repo}.insteadOf`, `https://github.com/acme/${name}.git`], {
    cwd: repo,
    stdio: ["ignore", "ignore", "ignore"],
  });
  writeFileSync(join(repo, ".mstarc"), "[collaboration]\nmode=local\n");
  const harnessDir = join(repo, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { harnessDir };
}

/** note: Publish the staged lane and this checkout's binding, as real activation does. */
function activate(context: StoreContext): void {
  const location = resolveCollaborationLocation(context);
  const db = new DatabaseSync(location.dbPath);
  let storeId = "";
  let epoch = 0;
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(new Date().toISOString());
    const row = db.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as
      | { store_id?: unknown; authority_epoch?: unknown }
      | undefined;
    if (typeof row?.store_id === "string") storeId = row.store_id;
    if (typeof row?.authority_epoch === "number") epoch = row.authority_epoch;
  } finally {
    db.close();
  }
  writeCollaborationBinding(context, { repoKey: location.repoKey, mode: location.mode, storeId, epoch, binding: "active" });
}

async function freshProject(projectId: string): Promise<StoreContext> {
  const context = checkout(`roadmap-${projectId}`);
  (await initializeStore(context)).close();
  await initializeCollaborationStore(resolveCollaborationLocation(context));
  activate(context);
  await registerCatalogEntity(
    context,
    { kind: "project", id: projectId, title: "Synthetic project", rootKind: "projects", relativePath: projectId },
    { operationId: `register-${projectId}`, actor: "test" },
  );
  return context;
}

beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("roadmap-authority transactional domain", () => {
  test("distinguishes a known project without authority from valid zero-goal content", async () => {
    const context = await freshProject("project-empty");
    const before = await readRoadmapAuthority(context, "project-empty");
    const { collaboration: beforeEvidence, ...beforeRead } = before;
    expect(beforeRead).toEqual({ projectId: "project-empty", projectRevision: 1, roadmap: null });
    expect(beforeEvidence.completeness).toBe("complete");
    const emptyGoals = `---\nproject_id: project-empty\ntitle: Empty goals\nstatus: active\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nStill valid content.\n`;
    await replaceRoadmapAuthority(context, {
      projectId: "project-empty", expectedProjectRevision: 1, expectedRoadmapRevision: "absent", contentMarkdown: emptyGoals,
    }, { operationId: "op-create-empty" });
    const read = await readRoadmapAuthority(context, "project-empty");
    expect(read.roadmap?.contentMarkdown).toBe(emptyGoals);
    expect(read.roadmap?.revision).toBe(1);
    await expect(readRoadmapAuthority(context, "missing-project")).rejects.toMatchObject({ code: "roadmap.project-not-found" });
  });

  test("imports current content after review while preserving revision CAS and replay", async () => {
    const context = await freshProject("project-reviewed");
    const sourcePath = join(context.harnessDir, "candidate.md");
    const reviewedContent = content("project-reviewed", "Exact source text.");
    writeFileSync(sourcePath, reviewedContent, "utf8");
    const review = await reviewRoadmapImport(context, "project-reviewed", sourcePath);
    expect(review).toMatchObject({ version: 1, expectedProjectRevision: 1, expectedRoadmapRevision: "absent" });
    const editedContent = content("project-reviewed", "Edited after review.");
    writeFileSync(sourcePath, editedContent, "utf8");
    const beforeHandle = await openStore(context, "read");
    const beforeWorkflows = beforeHandle.db.prepare("select count(*) as workflows from execution_workflows").get();
    beforeHandle.close();
    const beforeCollab = await collaborationMeta(context);

    const receipt = await importRoadmapAuthority(context, review, { operationId: "op-import" });
    expect(receipt.revision).toBe(1);
    expect((await importRoadmapAuthority(context, review, { operationId: "op-import" }))).toEqual(receipt);
    const read = await readRoadmapAuthority(context, "project-reviewed");
    expect(read.roadmap?.contentMarkdown).toBe(editedContent);
    // note: The receipt lives in the collaboration lane's standalone ledger.
    const receiptHandle = await openStore(context, "read");
    const importOperation = receiptHandle.db.prepare("select 1 from store_operations where operation_id='op-import'").get();
    receiptHandle.close();
    expect(importOperation).toBeUndefined();
    const collabRows = await collaborationOperation(context, "op-import");
    if (collabRows === undefined) throw new Error("the import receipt is missing from the collaboration ledger");
    expect(JSON.parse(collabRows.result_json)).toMatchObject({
      outcome: "committed",
      provenance: { sourcePath: review.sourcePath },
    });
    const afterCollab = await collaborationMeta(context);
    const afterHandle = await openStore(context, "read");
    const afterWorkflows = afterHandle.db.prepare("select count(*) as workflows from execution_workflows").get();
    afterHandle.close();
    expect(beforeCollab.revision + 1).toBe(afterCollab.revision);
    expect(beforeCollab.catalogRevision).toBe(afterCollab.catalogRevision);
    expect(afterWorkflows).toEqual(beforeWorkflows);

    const replaced = content("project-reviewed", "Replacement with nested task.");
    await replaceRoadmapAuthority(context, {
      projectId: "project-reviewed", expectedProjectRevision: 1, expectedRoadmapRevision: 1, contentMarkdown: replaced,
    }, { operationId: "op-replace" });
    const staleRevision = await collaborationMeta(context);
    await expect(replaceRoadmapAuthority(context, {
      projectId: "project-reviewed", expectedProjectRevision: 1, expectedRoadmapRevision: 1, contentMarkdown: reviewedContent,
    }, { operationId: "op-stale" })).rejects.toMatchObject({ code: "roadmap.revision-conflict" });
    const afterStale = await collaborationMeta(context);
    expect(afterStale.revision).toBe(staleRevision.revision);
    expect(await collaborationOperation(context, "op-stale")).toBeUndefined();
    const stable = await readRoadmapAuthority(context, "project-reviewed");
    expect(stable.roadmap?.contentMarkdown).toBe(replaced);
  });

  test("missing and staged collaboration authority are not presented as empty roadmaps", async () => {
    const missing = checkout("roadmap-no-authority");
    await expect(readRoadmapAuthority(missing, "project-missing")).rejects.toMatchObject({ code: "collaboration.not-initialized" });
    await initializeCollaborationStore(resolveCollaborationLocation(missing));
    // invariant: A staged lane is refused at admission, never served as a zero-goal map.
    await expect(readRoadmapAuthority(missing, "project-missing")).rejects.toMatchObject({ code: "collaboration.not-active" });
  });

  test("project mismatch and operation-id domain collision publish nothing", async () => {
    const context = await freshProject("project-mismatch");
    await expect(replaceRoadmapAuthority(context, {
      projectId: "project-mismatch", expectedProjectRevision: 1, expectedRoadmapRevision: "absent", contentMarkdown: content("other-project", "Wrong identity."),
    }, { operationId: "op-mismatch" })).rejects.toMatchObject({ code: "roadmap.project-mismatch" });
    const accepted = content("project-mismatch", "Correct identity.");
    await replaceRoadmapAuthority(context, {
      projectId: "project-mismatch", expectedProjectRevision: 1, expectedRoadmapRevision: "absent", contentMarkdown: accepted,
    }, { operationId: "op-domain" });
    const dbPath = resolveCollaborationLocation(context).dbPath;
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare("update collaboration_operations set request_hash=? where key_space='standalone' and operation_id=?").run("other-domain-request", "op-domain");
      raw.prepare("update catalog_entities set revision=2 where kind='project' and id='project-mismatch'").run();
    } finally {
      raw.close();
    }
    await expect(replaceRoadmapAuthority(context, {
      projectId: "project-mismatch", expectedProjectRevision: 1, expectedRoadmapRevision: 1, contentMarkdown: accepted,
    }, { operationId: "op-stale-project" })).rejects.toMatchObject({ code: "roadmap.revision-conflict" });
    expect((await readRoadmapAuthority(context, "project-mismatch")).roadmap?.revision).toBe(1);
    await expect(replaceRoadmapAuthority(context, {
      projectId: "project-mismatch", expectedProjectRevision: 1, expectedRoadmapRevision: "absent", contentMarkdown: accepted,
    }, { operationId: "op-domain" })).rejects.toMatchObject({ code: "roadmap.operation-conflict" });
    expect(await listRoadmapAuthority(context)).toHaveLength(1);
  });
});

async function collaborationMeta(context: StoreContext): Promise<{ revision: number; catalogRevision: number }> {
  const dbPath = resolveCollaborationLocation(context).dbPath;
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select revision, catalog_revision from collaboration_meta where id = 1").get() as {
      revision: number;
      catalog_revision: number;
    };
    return { revision: row.revision, catalogRevision: row.catalog_revision };
  } finally {
    db.close();
  }
}

async function collaborationOperation(context: StoreContext, operationId: string): Promise<{ request_hash: string; result_json: string } | undefined> {
  const dbPath = resolveCollaborationLocation(context).dbPath;
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("select request_hash, result_json from collaboration_operations where key_space='standalone' and operation_id=?")
      .get(operationId) as { request_hash: string; result_json: string } | undefined;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// note: Remote selection: the roadmap authority comes from admitted evidence
// ---------------------------------------------------------------------------

describe("remote roadmap authority", () => {
  test("a remote checkout reads the observed roadmap and milestones, never a local row", async () => {
    const fixture = createRemoteScope(ROOT, "remote-roadmap");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    await ingestRemoteObservation(context, submission(commit, check, completeSnapshot(check), 0));

    const read = await readRoadmapAuthority(context, REMOTE_IDS.projectId);
    expect(read).toMatchObject({
      projectId: REMOTE_IDS.projectId,
      roadmap: { projectId: REMOTE_IDS.projectId, revision: 2 },
      collaboration: { source: "remote", completeness: "complete" },
    });
    if (read.roadmap === null) throw new Error("the observed fixture roadmap must be present");
    expect(read.content.frontmatter.project_id).toBe(REMOTE_IDS.projectId);
    expect(read.content.direction).toContain("One verified remote scope.");

    const listed = await listRoadmapAuthority(context);
    expect(listed.map((entry) => entry.projectId)).toEqual([REMOTE_IDS.projectId]);

    // invariant: A project outside the selected scope has no evidence, never an empty roadmap.
    await expect(readRoadmapAuthority(context, "proj-other")).rejects.toMatchObject({ code: "remote.scope-mismatch" });
  });
});
