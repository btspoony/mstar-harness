import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, mintIssueRef, writeCollaborationBinding } from "./collaboration-store.js";
import { bindRemoteAuthority, ingestRemoteObservation, prepareRemoteProjectWrite } from "./collaboration-remote.js";
import {
  completeSnapshot,
  confirmFrozenIntent,
  createRemoteScope,
  positiveCheck,
  REMOTE_IDS,
  submission,
} from "./remote-scope.fixture.js";
import { addMilestone, MilestoneError, readMilestonesOn, updateMilestone } from "./milestone-store.js";
import { queryMilestones } from "./milestone-store.js";
import { withStoreRead } from "./store-read.js";
import type { StoreContext, StoreDb } from "./store-db.js";

const root = mkdtempSync(join(nodeOs.tmpdir(), "tmp-milestone-store-"));
const HOME = join(root, "home");
mkdirSync(HOME);
let homeSpy: { mockRestore(): void } | undefined;
let db: StoreDb;
const otherProjectId = "milestone-other-project";
const projectId = "milestone-test-project";

/** note: A synthetic checkout whose origin names the collaboration repository. */
function checkout(name: string): StoreContext {
  const repo = join(root, name);
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
  return { harnessDir: join(repo, ".mstar") };
}

/** invariant: The private staged record flipped to active, plus the checkout binding the
 * real activation writes: an ACTIVE authority is never usable unbound. */
function activateLocation(context: StoreContext): string {
  const location = resolveCollaborationLocation(context);
  const handle = new DatabaseSync(location.dbPath);
  let authority: { storeId: string; epoch: number } | null = null;
  try {
    handle.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(new Date().toISOString());
    const row = handle.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as { store_id?: unknown; authority_epoch?: unknown } | undefined;
    if (typeof row?.store_id === "string" && typeof row.authority_epoch === "number") authority = { storeId: row.store_id, epoch: row.authority_epoch };
  } finally {
    handle.close();
  }
  if (authority === null) throw new Error("fixture: the staged collaboration lane records no store identity");
  writeCollaborationBinding(context, { repoKey: location.repoKey, mode: location.mode, storeId: authority.storeId, epoch: authority.epoch, binding: "active" });
  return location.dbPath;
}

const context = checkout("milestone-store");
function issue(id: string, disposition: string, milestoneId: string | null): void {
  db.prepare("insert into issues(id,project_id,title,kind,severity,impact,acceptance,created_at,updated_at,identity_key,milestone_id,disposition,issue_ref) values(?,?,'Issue','bug','high','impact','acceptance','now','now',?,?,?,?)").run(id,projectId,id,milestoneId,disposition,mintIssueRef());
}
beforeAll(async () => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
  mkdirSync(context.harnessDir!, { recursive: true });
  await initializeCollaborationStore(resolveCollaborationLocation(context));
  db = new DatabaseSync(activateLocation(context));
  db.prepare("insert into catalog_entities(kind,id,title,root_kind,relative_path,registered_at,updated_at) values('project',?,?,'projects',?,'now','now')").run(projectId,"Test project",`${projectId}/roadmap.md`);
  db.prepare("insert into catalog_entities(kind,id,title,root_kind,relative_path,registered_at,updated_at) values('project',?,?,'projects',?,'now','now')").run(otherProjectId,"Other project",`${otherProjectId}/roadmap.md`);
});
afterAll(() => { db.close(); homeSpy?.mockRestore(); rmSync(root,{recursive:true,force:true}); });

function revision(): number {
  const row = db.prepare("select revision from collaboration_meta where id=1").get() as { revision: number };
  return row.revision;
}

describe("milestone store", () => {
  test("validates name, effort sessions and ordinal, and requires a catalog project", async () => {
    for (const [name,effortSessions,ordinal] of [[" ",null,0],["Valid",0,0],["Valid",1.5,0],["Valid","soon",0],["Valid",null,-1]] as const) {
      await expect(addMilestone(context,{projectId,name,effortSessions,ordinal},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"milestone.invalid-input"});
    }
    await expect(addMilestone(context,{projectId,name:"Valid",effortSessions:0,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"milestone.invalid-input",message:"[milestone.invalid-input] Name, effort sessions, or ordinal is invalid."});
    await expect(addMilestone(context,{projectId:"missing",name:"Valid",effortSessions:null,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"milestone.project-not-found"});
    await expect(addMilestone(context,{projectId,name:42 as unknown as string,effortSessions:null,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({name:"MilestoneError",code:"milestone.invalid-input"});
  });
  test("adds and updates with replay, conflict, delivery guards and single revision advances", async () => {
    const before=revision();
    const operationId=crypto.randomUUID();
    const input={projectId,name:"Release",effortSessions:3,ordinal:2};
    const added=await addMilestone(context,input,{operationId,expectedStoreRevision:before});
    expect(added).toMatchObject({revision:1,storeRevision:before+1,changed:true});
    expect(readMilestonesOn(db,projectId,added.milestoneId).milestones[0]).toMatchObject({effortSessions:3});
    expect(() => db.prepare("update project_milestones set project_id='missing' where milestone_id=?").run(added.milestoneId)).toThrow(/milestone.identity-immutable/);
    const noOp=await updateMilestone(context,projectId,added.milestoneId,{name:"Release"},{operationId:crypto.randomUUID(),expectedStoreRevision:added.storeRevision});
    expect(noOp).toMatchObject({revision:1,storeRevision:added.storeRevision,changed:false});
    expect(await addMilestone(context,{...input,name:" Release "},{operationId,expectedStoreRevision:before})).toEqual(added);
    await expect(addMilestone(context,{...input,name:"Other"},{operationId,expectedStoreRevision:before})).rejects.toMatchObject({code:"store.operation-conflict"});
    let current=added.storeRevision;
    const activated=await updateMilestone(context,projectId,added.milestoneId,{status:"active"},{operationId:crypto.randomUUID(),expectedStoreRevision:current});
    expect(activated).toMatchObject({revision:2,storeRevision:current+1,changed:true}); current=activated.storeRevision;
    issue("I-MILESTONE-1","open",added.milestoneId);
    current=revision();
    await expect(updateMilestone(context,projectId,added.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:current})).rejects.toMatchObject({code:"milestone.open-issues"});
    const stale=current;
    const concurrent = await Promise.allSettled([
      updateMilestone(context,projectId,added.milestoneId,{ordinal:3},{operationId:crypto.randomUUID(),expectedStoreRevision:stale}),
      updateMilestone(context,projectId,added.milestoneId,{ordinal:4},{operationId:crypto.randomUUID(),expectedStoreRevision:stale}),
    ]);
    expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(result => result.status === "rejected")).toMatchObject([{reason:{code:"milestone.revision-conflict"}}]);
    expect(concurrent.find(result => result.status === "fulfilled")).toMatchObject({status:"fulfilled",value:{changed:true}});
    db.prepare("update issues set disposition='resolved' where id='I-MILESTONE-1'").run();
    current=revision();
    const delivered=await updateMilestone(context,projectId,added.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:current});
    expect(delivered).toMatchObject({revision:4,storeRevision:current+1});
    await expect(updateMilestone(context,projectId,added.milestoneId,{status:"planned"},{operationId:crypto.randomUUID(),expectedStoreRevision:delivered.storeRevision})).rejects.toMatchObject({code:"milestone.invalid-transition"});
    const reopened=await updateMilestone(context,projectId,added.milestoneId,{status:"active"},{operationId:crypto.randomUUID(),expectedStoreRevision:delivered.storeRevision});
    expect(reopened.revision).toBe(5);
    const cleared=await updateMilestone(context,projectId,added.milestoneId,{effortSessions:null},{operationId:crypto.randomUUID(),expectedStoreRevision:reopened.storeRevision});
    expect(cleared).toMatchObject({changed:true});
    expect(readMilestonesOn(db,projectId,added.milestoneId).milestones[0]).toMatchObject({effortSessions:null});
    expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  test("rollup retains empty milestones, separates retired counts and counts unassigned issues", async () => {
    const current=revision();
    const full=await addMilestone(context,{projectId,name:"Full",effortSessions:null,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:current});
    const empty=await addMilestone(context,{projectId,name:"Empty",effortSessions:null,ordinal:1},{operationId:crypto.randomUUID(),expectedStoreRevision:full.storeRevision});
    issue("I-MILESTONE-2","resolved",full.milestoneId); issue("I-MILESTONE-3","waived",full.milestoneId); issue("I-MILESTONE-4","duplicate",full.milestoneId); issue("I-MILESTONE-5","superseded",full.milestoneId); issue("I-MILESTONE-6","open",null);
    const result=readMilestonesOn(db,projectId);
    const releaseRow = db.prepare("select milestone_id from project_milestones where project_id=? and name='Release'").get(projectId) as {milestone_id:string};
    expect(result.milestones.map(milestone => [milestone.milestoneId,milestone.totalIssues,milestone.openIssues,milestone.resolvedIssues,milestone.otherRetiredIssues])).toEqual([[full.milestoneId,4,0,1,3],[empty.milestoneId,0,0,0,0],[releaseRow.milestone_id,1,0,1,0]]);
    expect(readMilestonesOn(db,projectId,empty.milestoneId).milestones).toHaveLength(1);
    await expect(updateMilestone(context,projectId,full.milestoneId,{name:"x"},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toBeInstanceOf(MilestoneError);
  });
  test("retiring a subject as obsolete counts as other-retired, never as resolved", async () => {
    const current=revision();
    const retired=await addMilestone(context,{projectId,name:"Retirement",effortSessions:null,ordinal:2},{operationId:crypto.randomUUID(),expectedStoreRevision:current});
    issue("I-MILESTONE-7","resolved",retired.milestoneId);
    issue("I-MILESTONE-8","obsolete",retired.milestoneId);
    issue("I-MILESTONE-9","open",retired.milestoneId);
    const rollup=readMilestonesOn(db,projectId,retired.milestoneId).milestones[0]!;
    expect(rollup).toMatchObject({totalIssues:3,openIssues:1,resolvedIssues:1,otherRetiredIssues:1});
    // The disposition is not rewritten by the aggregate: the row still says obsolete.
    expect(readMilestonesOn(db,projectId,retired.milestoneId).issues.map(row => [row.id,row.disposition]).sort()).toEqual([
      ["I-MILESTONE-7","resolved"],["I-MILESTONE-8","obsolete"],["I-MILESTONE-9","open"],
    ]);
  });
  test("a staged collaboration store refuses the milestone path", async () => {
    const staged = checkout("milestone-store-staged");
    mkdirSync(staged.harnessDir!, { recursive: true });
    await initializeCollaborationStore(resolveCollaborationLocation(staged));
    const stagedDb = new DatabaseSync(resolveCollaborationLocation(staged).dbPath);
    try {
      // invariant: The opener refuses a staged lane before the domain guard is reached.
      await expect(addMilestone(staged,{projectId,name:"Staged",effortSessions:null,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"collaboration.not-active"});
      // invariant: A handle that reaches the domain guard still refuses the staged row.
      expect(() => readMilestonesOn(stagedDb,projectId)).toThrow(expect.objectContaining({code:"store.not-active"}));
    } finally {
      stagedDb.close();
    }
  });
  test("milestone status rejects missing and cross-project IDs", async () => {
    const current=revision();
    const own=await addMilestone(context,{projectId,name:"Own",effortSessions:null,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:current});
    const foreign=await addMilestone(context,{projectId:otherProjectId,name:"Foreign",effortSessions:null,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:own.storeRevision});
    expect(readMilestonesOn(db,projectId,own.milestoneId).milestones).toHaveLength(1);
    expect(() => readMilestonesOn(db,projectId,"missing-milestone")).toThrow(expect.objectContaining({code:"milestone.not-found"}));
    expect(() => readMilestonesOn(db,projectId,foreign.milestoneId)).toThrow(expect.objectContaining({code:"milestone.project-mismatch"}));
  });
  test("milestone store: delivery counts its open issues inside its own mutation, never from a prior read", async () => {
    const current=revision();
    const scheduled=await addMilestone(context,{projectId,name:"Delivery counts",effortSessions:null,ordinal:9},{operationId:crypto.randomUUID(),expectedStoreRevision:current});
    const activated=await updateMilestone(context,projectId,scheduled.milestoneId,{status:"active"},{operationId:crypto.randomUUID(),expectedStoreRevision:scheduled.storeRevision});
    // note: A rollup read is not the delivery decision: it reports zero open issues...
    expect(readMilestonesOn(db,projectId,scheduled.milestoneId).milestones[0]).toMatchObject({openIssues:0});
    // note: ...and a row written after that read, without moving the store revision,
    // is still counted by the delivery's own collaboration transaction.
    issue("I-MILESTONE-DELIVERY","open",scheduled.milestoneId);
    await expect(updateMilestone(context,projectId,scheduled.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:activated.storeRevision})).rejects.toMatchObject({code:"milestone.open-issues"});
    db.prepare("update issues set disposition='resolved' where id='I-MILESTONE-DELIVERY'").run();
    const delivered=await updateMilestone(context,projectId,scheduled.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:activated.storeRevision});
    expect(delivered).toMatchObject({changed:true,storeRevision:activated.storeRevision+1});
  });
  test("milestone store: an empty milestone delivers on a complete observation, and an unavailable one refuses", async () => {
    const before=revision();
    const empty=await addMilestone(context,{projectId,name:"Empty delivery",effortSessions:null,ordinal:10},{operationId:crypto.randomUUID(),expectedStoreRevision:before});
    const activated=await updateMilestone(context,projectId,empty.milestoneId,{status:"active"},{operationId:crypto.randomUUID(),expectedStoreRevision:empty.storeRevision});
    // why: A complete observation proves zero linked issues, so delivery passes; the
    // rollup keeps reporting an empty milestone, not a missing one.
    expect(readMilestonesOn(db,projectId,empty.milestoneId).milestones[0]).toMatchObject({totalIssues:0,openIssues:0});
    const delivered=await updateMilestone(context,projectId,empty.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:activated.storeRevision});
    expect(delivered).toMatchObject({changed:true,storeRevision:activated.storeRevision+1});
    expect(readMilestonesOn(db,projectId,empty.milestoneId).milestones[0]).toMatchObject({status:"delivered",totalIssues:0,openIssues:0,resolvedIssues:0,otherRetiredIssues:0});

    // invariant: An unavailable observation is not an empty one: the same delivery refuses.
    const staged=checkout("milestone-store-delivery-staged");
    mkdirSync(staged.harnessDir!,{recursive:true});
    await initializeCollaborationStore(resolveCollaborationLocation(staged));
    await expect(updateMilestone(staged,projectId,empty.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"collaboration.not-active"});
    const missing=checkout("milestone-store-delivery-missing");
    mkdirSync(missing.harnessDir!,{recursive:true});
    await expect(updateMilestone(missing,projectId,empty.milestoneId,{status:"delivered"},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"collaboration.not-initialized"});
  });
});

// ---------------------------------------------------------------------------
// note: Remote selection: milestone status is read from admitted evidence
// ---------------------------------------------------------------------------

describe("remote milestones", () => {
  test("a confirmed intent without a recorded result names a runnable outbox-show command", async () => {
    const fixture = createRemoteScope(root, "remote-milestones-recovery");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    await ingestRemoteObservation(context, submission(commit, check, completeSnapshot(check), 0));

    // note: The observed base the verb must be planned against: the cache's own revision.
    const db = new DatabaseSync(resolveCollaborationLocation(context).dbPath);
    let revision = 0;
    try {
      const row = db
        .prepare("select revision from remote_observations where project_key = ?")
        .get(REMOTE_IDS.projectId) as { revision?: unknown } | undefined;
      revision = typeof row?.revision === "number" ? row.revision : 0;
    } finally {
      db.close();
    }

    // why: An earlier release froze this write's intent without recording a business result, and
    // the provider confirmed it. The replay must name the exact intent an operator can inspect.
    const operationId = crypto.randomUUID();
    const patch = { name: "Renamed delivery" };
    const origin = {
      verb: "milestone-update",
      request: { projectId: REMOTE_IDS.projectId, milestoneId: "milestone-1", patch, expectedStoreRevision: revision },
    };
    await prepareRemoteProjectWrite(context, {
      projectId: REMOTE_IDS.projectId,
      operationId,
      origin,
      next: (current) => current,
    });
    await confirmFrozenIntent(context, operationId);

    const refused = await updateMilestone(context, REMOTE_IDS.projectId, "milestone-1", patch, {
      operationId,
      expectedStoreRevision: revision,
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "milestone.operation-conflict" });
    expect(refused).toBeInstanceOf(Error);
    const message = (refused as Error).message;
    expect(message).toContain("outbox-show");
    expect(message).toContain(`--operation ${operationId}`);
    expect(message).toContain("--harness");
  });

  test("a remote checkout groups MStar subjects under the observed milestones", async () => {
    const fixture = createRemoteScope(root, "remote-milestones");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    await ingestRemoteObservation(context, submission(commit, check, completeSnapshot(check), 0));

    const envelope = await withStoreRead(context, queryMilestones(REMOTE_IDS.projectId));
    expect(envelope.data.milestones).toEqual([
      expect.objectContaining({
        milestoneId: "milestone-1",
        name: "First delivery",
        totalIssues: 1,
        openIssues: 1,
        resolvedIssues: 0,
      }),
    ]);
    expect(envelope.data.issues).toEqual([
      expect.objectContaining({ id: REMOTE_IDS.issueRef, disposition: "open", milestoneId: "milestone-1" }),
    ]);
    expect(envelope.data.unassignedIssues).toBe(0);
    expect(envelope.collaboration).toMatchObject({ source: "remote", completeness: "complete" });
  });

  test("remote milestone writes validate effort sessions before enqueueing", async () => {
    const fixture = createRemoteScope(root, "remote-milestone-effort");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    await ingestRemoteObservation(context, submission(commit, check, completeSnapshot(check), 0));
    const invalid = ["soon", 0, 1.5] as unknown as (number | null)[];
    for (const effortSessions of invalid) {
      await expect(addMilestone(context,{projectId:REMOTE_IDS.projectId,name:"Valid",effortSessions,ordinal:0},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"milestone.invalid-input",message:"[milestone.invalid-input] Name, effort sessions, or ordinal is invalid."});
      await expect(updateMilestone(context,REMOTE_IDS.projectId,"milestone-1",{effortSessions},{operationId:crypto.randomUUID(),expectedStoreRevision:0})).rejects.toMatchObject({code:"milestone.invalid-input",message:"[milestone.invalid-input] Name, effort sessions, or ordinal is invalid."});
    }

    await expect(
      withStoreRead(context, queryMilestones(REMOTE_IDS.projectId, "milestone-absent")),
    ).rejects.toMatchObject({ code: "milestone.not-found" });
  });
});
