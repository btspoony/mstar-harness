import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importRoadmapAuthority,
  initializeStore,
  listRoadmapAuthority,
  openStore,
  readRoadmapAuthority,
  replaceRoadmapAuthority,
  reviewRoadmapImport,
  upgradeStore,
  type StoreContext,
} from "./index.js";
import { RoadmapError } from "./roadmap-store.js";

const fixtures: string[] = [];
const content = (projectId: string, description: string): string =>
  `---\nproject_id: ${projectId}\ntitle: Synthetic roadmap\nstatus: active\ncreated_at: 2026-09-25\ncustom_field: preserved\n---\n\n## Direction\n\n${description}\n\n## Goals\n\n- [ ] Parent goal\n  - [x] Nested goal\n\n`;

async function freshProject(projectId: string): Promise<StoreContext> {
  const harnessDir = mkdtempSync(join(tmpdir(), "roadmap-authority-"));
  fixtures.push(harnessDir);
  const initialized = await initializeStore({ harnessDir });
  initialized.db.prepare(
    "insert into catalog_entities(kind,id,title,root_kind,relative_path,revision,registered_at,updated_at) values('project',?,'Synthetic project','projects',?,1,?,?)",
  ).run(projectId, projectId, new Date().toISOString(), new Date().toISOString());
  initialized.close();
  return { harnessDir };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("roadmap-authority transactional domain", () => {
  test("distinguishes a known project without authority from valid zero-goal content", async () => {
    const context = await freshProject("project-empty");
    const before = await readRoadmapAuthority(context, "project-empty");
    expect(before).toEqual({ projectId: "project-empty", projectRevision: 1, roadmap: null });
    const emptyGoals = `---\nproject_id: project-empty\ntitle: Empty goals\nstatus: active\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nStill valid content.\n`;
    await replaceRoadmapAuthority(context, {
      projectId: "project-empty", expectedProjectRevision: 1, expectedRoadmapRevision: "absent", contentMarkdown: emptyGoals,
    }, { operationId: "op-create-empty" });
    const read = await readRoadmapAuthority(context, "project-empty");
    expect(read.roadmap?.contentMarkdown).toBe(emptyGoals);
    expect(read.roadmap?.revision).toBe(1);
    await expect(readRoadmapAuthority(context, "missing-project")).rejects.toMatchObject({ code: "roadmap.project-not-found" });
  });

  test("reviewed imports preserve exact content, revisions, replay receipts, and reject stale or drifted requests atomically", async () => {
    const context = await freshProject("project-reviewed");
    const sourcePath = join(context.harnessDir, "candidate.md");
    const initial = content("project-reviewed", "Exact source text.");
    writeFileSync(sourcePath, initial, "utf8");
    const review = await reviewRoadmapImport(context, "project-reviewed", sourcePath);
    expect(review).toMatchObject({ version: 1, expectedProjectRevision: 1, expectedRoadmapRevision: "absent" });
    const beforeHandle = await openStore(context, "read");
    const beforeState = beforeHandle.db.prepare("select revision, catalog_revision from store_meta where id=1").get();
    const beforeCounts = beforeHandle.db.prepare("select (select count(*) from issues) as issues, (select count(*) from execution_workflows) as workflows").get();
    beforeHandle.close();

    const receipt = await importRoadmapAuthority(context, review, { operationId: "op-import" });
    expect(receipt.revision).toBe(1);
    expect((await importRoadmapAuthority(context, review, { operationId: "op-import" }))).toEqual(receipt);
    const read = await readRoadmapAuthority(context, "project-reviewed");
    expect(read.roadmap?.contentMarkdown).toBe(initial);
    const receiptHandle = await openStore(context, "read");
    const importOperation = receiptHandle.db.prepare("select result_json from store_operations where operation_id='op-import'").get() as { result_json: string };
    receiptHandle.close();
    expect(JSON.parse(importOperation.result_json)).toMatchObject({
      outcome: "committed",
      provenance: { sourcePath: review.sourcePath, sourceHash: review.sourceHash },
    });
    expect(read.roadmap?.contentHash).toBe(review.sourceHash);
    const derivedHandle = await openStore(context, "read");
    const afterState = derivedHandle.db.prepare("select revision, catalog_revision from store_meta where id=1").get();
    const afterCounts = derivedHandle.db.prepare("select (select count(*) from issues) as issues, (select count(*) from execution_workflows) as workflows").get();
    derivedHandle.close();
    expect((beforeState as { revision: number }).revision + 1).toBe((afterState as { revision: number }).revision);
    expect((beforeState as { catalog_revision: number }).catalog_revision).toBe((afterState as { catalog_revision: number }).catalog_revision);
    expect(afterCounts).toEqual(beforeCounts);

    const replaced = content("project-reviewed", "Replacement with nested task.");
    const replacement = await replaceRoadmapAuthority(context, {
      projectId: "project-reviewed", expectedProjectRevision: 1, expectedRoadmapRevision: 1, contentMarkdown: replaced,
    }, { operationId: "op-replace" });
    const beforeStale = await openStore(context, "read");
    const staleRevision = beforeStale.db.prepare("select revision from store_meta where id=1").get() as { revision: number };
    beforeStale.close();
    await expect(replaceRoadmapAuthority(context, {
      projectId: "project-reviewed", expectedProjectRevision: 1, expectedRoadmapRevision: 1, contentMarkdown: initial,
    }, { operationId: "op-stale" })).rejects.toMatchObject({ code: "roadmap.revision-conflict" });
    const afterStale = await openStore(context, "read");
    const afterStaleRevision = afterStale.db.prepare("select revision from store_meta where id=1").get() as { revision: number };
    const staleReceipt = afterStale.db.prepare("select operation_id from store_operations where operation_id='op-stale'").get();
    afterStale.close();
    expect(afterStaleRevision.revision).toBe(staleRevision.revision);
    expect(staleReceipt).toBeUndefined();
    const stable = await readRoadmapAuthority(context, "project-reviewed");
    expect(stable.roadmap?.contentMarkdown).toBe(replaced);

    const beforeDrift = await openStore(context, "read");
    const driftRevision = beforeDrift.db.prepare("select revision from store_meta where id=1").get() as { revision: number };
    beforeDrift.close();
    writeFileSync(sourcePath, content("project-reviewed", "Drifted source."), "utf8");
    await expect(importRoadmapAuthority(context, review, { operationId: "op-import" })).resolves.toEqual(receipt);
    await expect(importRoadmapAuthority(context, review, { operationId: "op-drift" })).rejects.toMatchObject({ code: "roadmap.source-drift" });
    const afterDrift = await openStore(context, "read");
    const afterDriftRevision = afterDrift.db.prepare("select revision from store_meta where id=1").get() as { revision: number };
    const driftReceipt = afterDrift.db.prepare("select operation_id from store_operations where operation_id='op-drift'").get();
    afterDrift.close();
    expect(afterDriftRevision.revision).toBe(driftRevision.revision);
    expect(driftReceipt).toBeUndefined();
    expect((await readRoadmapAuthority(context, "project-reviewed")).roadmap?.revision).toBe(2);
    await expect(importRoadmapAuthority(context, review, { operationId: "op-conflict" })).rejects.toBeInstanceOf(RoadmapError);
  });

  test("migration is explicit, removes only disposable roadmap projection, and missing stores refuse", async () => {
    const context = await freshProject("project-migration");
    const handle = await openStore(context, "write");
    handle.db.exec("begin immediate; create table prior_fixture(value text); insert into prior_fixture values('preserved');");
    handle.db.exec("delete from schema_version where version=6; drop table project_roadmaps; create table projection_roadmaps(generation integer, project_id text, direction text, goals_json text, milestones_json text, primary key(generation,project_id));");
    handle.db.prepare("delete from schema_version where version>5").run();
    handle.db.exec("commit");
    handle.close();
    await expect(readRoadmapAuthority(context, "project-migration")).rejects.toMatchObject({ code: "roadmap.schema-outdated" });
    await upgradeStore(context);
    const upgraded = await openStore(context, "read");
    expect(upgraded.db.prepare("select value from prior_fixture").get()).toEqual({ value: "preserved" });
    expect(upgraded.db.prepare("select name from sqlite_master where type='table' and name='project_roadmaps'").get()).toBeDefined();
    expect(upgraded.db.prepare("select name from sqlite_master where type='table' and name='projection_roadmaps'").get()).toBeUndefined();
    upgraded.close();
    const missing: StoreContext = { harnessDir: join(context.harnessDir, "missing") };
    await expect(readRoadmapAuthority(missing, "project-migration")).rejects.toMatchObject({ code: "store.not-initialized" });
  });
  test("staged stores are not presented as empty roadmaps", async () => {
    const context = await freshProject("project-staged");
    const handle = await openStore(context, "write");
    handle.db.prepare("update store_meta set authority_state='staged' where id=1").run();
    handle.close();
    await expect(readRoadmapAuthority(context, "project-staged")).rejects.toMatchObject({ code: "roadmap.store-not-active" });
  });


  test("project mismatch and operation-id domain collision publish nothing", async () => {
    const context = await freshProject("project-mismatch");
    await expect(replaceRoadmapAuthority(context, {
      projectId: "project-mismatch", expectedProjectRevision: 1, expectedRoadmapRevision: "absent", contentMarkdown: content("other-project", "Wrong identity."),
    }, { operationId: "op-mismatch" })).rejects.toMatchObject({ code: "roadmap.project-mismatch" });
    const accepted = content("project-mismatch", "Correct identity.");
    const receipt = await replaceRoadmapAuthority(context, {
      projectId: "project-mismatch", expectedProjectRevision: 1, expectedRoadmapRevision: "absent", contentMarkdown: accepted,
    }, { operationId: "op-domain" });
    const handle = await openStore(context, "write");
    handle.db.prepare("update store_operations set request_hash=? where operation_id=?").run("other-domain-request", "op-domain");
    handle.close();
    const updatedCatalog = await openStore(context, "write");
    updatedCatalog.db.prepare("update catalog_entities set revision=2 where kind='project' and id='project-mismatch'").run();
    updatedCatalog.close();
    await expect(replaceRoadmapAuthority(context, {
      projectId: "project-mismatch", expectedProjectRevision: 1, expectedRoadmapRevision: 1, contentMarkdown: accepted,
    }, { operationId: "op-stale-project" })).rejects.toMatchObject({ code: "roadmap.revision-conflict" });
    expect((await readRoadmapAuthority(context, "project-mismatch")).roadmap?.revision).toBe(1);
    await expect(replaceRoadmapAuthority(context, {
      projectId: "project-mismatch", expectedProjectRevision: 1, expectedRoadmapRevision: "absent", contentMarkdown: accepted,
    }, { operationId: "op-domain" })).rejects.toMatchObject({ code: "roadmap.operation-conflict" });
    expect((await readRoadmapAuthority(context, "project-mismatch")).roadmap?.contentHash).toBe(receipt.contentHash);
    expect(await listRoadmapAuthority(context)).toHaveLength(1);
  });
});
