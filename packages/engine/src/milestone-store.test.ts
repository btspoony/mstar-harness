import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, type StoreContext, type StoreDb } from "./store-db.js";
import { addMilestone, MilestoneError, readMilestonesOn, updateMilestone } from "./milestone-store.js";

const root = mkdtempSync(join(tmpdir(), "milestone-store-"));
const context: StoreContext = { harnessDir: root };
let db: StoreDb;
const projectId = "milestone-test-project";
function issue(id: string, disposition: string, milestoneId: string | null): void {
  db.prepare("insert into issues(id,project_id,title,kind,severity,impact,acceptance,created_at,updated_at,identity_key,milestone_id,disposition) values(?,?,'Issue','bug','high','impact','acceptance','now','now',?,?,?)").run(id,projectId,id,milestoneId,disposition);
}
beforeAll(async () => {
  const handle = await initializeStore(context); db = handle.db;
  db.prepare("insert into catalog_entities(kind,id,title,root_kind,relative_path,registered_at,updated_at) values('project',?,?,'projects',?,'now','now')").run(projectId,"Test project",`${projectId}/roadmap.md`);
});
afterAll(() => { db.close(); rmSync(root,{recursive:true,force:true}); });

describe("milestone store", () => {
  test("validates name, calendar date and ordinal, and requires a catalog project", async () => {
    for (const [name,target,ordinal] of [[" ",null,0],["Valid","2026-02-30",0],["Valid",null,-1]] as const) {
      await expect(addMilestone(context,{projectId,name,target,ordinal},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"milestone.invalid-input"});
    }
    await expect(addMilestone(context,{projectId:"missing",name:"Valid",target:null,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"milestone.project-not-found"});
  });
  test("adds and updates with replay, conflict, delivery guards and single revision advances", async () => {
    const before=(db.prepare("select revision from store_meta where id=1").get() as {revision:number}).revision;
    const operationId=crypto.randomUUID();
    const input={projectId,name:"Release",target:"2026-10-01",ordinal:2};
    const added=await addMilestone(context,input,{operationId,expectedStoreRevision:before});
    expect(added).toMatchObject({revision:1,storeRevision:before+1,changed:true});
    expect(() => db.prepare("update project_milestones set project_id='missing' where milestone_id=?").run(added.milestoneId)).toThrow(/milestone.identity-immutable/);
    const noOp=await updateMilestone(context,projectId,added.milestoneId,{name:"Release"},{operationId:crypto.randomUUID(),expectedStoreRevision:added.storeRevision});
    expect(noOp).toMatchObject({revision:1,storeRevision:added.storeRevision,changed:false});
    expect(await addMilestone(context,input,{operationId,expectedStoreRevision:before})).toEqual(added);
    await expect(addMilestone(context,{...input,name:"Other"},{operationId,expectedStoreRevision:before})).rejects.toMatchObject({code:"milestone.operation-conflict"});
    let revision=added.storeRevision;
    const activated=await updateMilestone(context,projectId,added.milestoneId,{status:"active"},{operationId:crypto.randomUUID(),expectedStoreRevision:revision});
    expect(activated).toMatchObject({revision:2,storeRevision:revision+1,changed:true}); revision=activated.storeRevision;
    await expect(updateMilestone(context,projectId,added.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:revision})).rejects.toMatchObject({code:"milestone.empty"});
    issue("I-MILESTONE-1","open",added.milestoneId);
    revision=(db.prepare("select revision from store_meta where id=1").get() as {revision:number}).revision;
    await expect(updateMilestone(context,projectId,added.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:revision})).rejects.toMatchObject({code:"milestone.open-issues"});
    const stale=revision;
    const first=await updateMilestone(context,projectId,added.milestoneId,{ordinal:3},{operationId:crypto.randomUUID(),expectedStoreRevision:stale});
    await expect(updateMilestone(context,projectId,added.milestoneId,{ordinal:4},{operationId:crypto.randomUUID(),expectedStoreRevision:stale})).rejects.toMatchObject({code:"milestone.revision-conflict"});
    db.prepare("update issues set disposition='resolved' where id='I-MILESTONE-1'").run();
    revision=(db.prepare("select revision from store_meta where id=1").get() as {revision:number}).revision;
    const delivered=await updateMilestone(context,projectId,added.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:revision});
    expect(delivered).toMatchObject({revision:4,storeRevision:revision+1});
    await expect(updateMilestone(context,projectId,added.milestoneId,{status:"planned"},{operationId:crypto.randomUUID(),expectedStoreRevision:delivered.storeRevision})).rejects.toMatchObject({code:"milestone.invalid-transition"});
    const reopened=await updateMilestone(context,projectId,added.milestoneId,{status:"active"},{operationId:crypto.randomUUID(),expectedStoreRevision:delivered.storeRevision});
    expect(reopened.revision).toBe(5);
    expect(first.changed).toBe(true);
  });
  test("rollup retains empty milestones, separates retired counts and counts unassigned issues", async () => {
    const revision=(db.prepare("select revision from store_meta where id=1").get() as {revision:number}).revision;
    const full=await addMilestone(context,{projectId,name:"Full",target:null,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:revision});
    const empty=await addMilestone(context,{projectId,name:"Empty",target:null,ordinal:1},{operationId:crypto.randomUUID(),expectedStoreRevision:full.storeRevision});
    issue("I-MILESTONE-2","resolved",full.milestoneId); issue("I-MILESTONE-3","waived",full.milestoneId); issue("I-MILESTONE-4","duplicate",full.milestoneId); issue("I-MILESTONE-5","superseded",full.milestoneId); issue("I-MILESTONE-6","open",null);
    const result=readMilestonesOn(db,projectId);
    expect(result.milestones).toEqual(expect.arrayContaining([expect.objectContaining({milestoneId:full.milestoneId,totalIssues:4,openIssues:0,resolvedIssues:1,otherRetiredIssues:3,doneIssues:4}),expect.objectContaining({milestoneId:empty.milestoneId,totalIssues:0,openIssues:0,doneIssues:0})]));
    expect(result.issues.filter(item=>item.milestoneId===full.milestoneId)).toHaveLength(4); expect(result.unassignedIssues).toBe(1);
    expect(readMilestonesOn(db,projectId,empty.milestoneId).milestones).toHaveLength(1);
    await expect(updateMilestone(context,projectId,full.milestoneId,{name:"x"},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toBeInstanceOf(MilestoneError);
  });
});
