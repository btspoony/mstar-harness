import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCollaborationAuthority,
  initializeStore,
  openCollaborationStore,
  registerCatalogEntity,
  withCollaborationWrite,
} from "@mstar-harness/engine";
import { executeCommand } from "../src/index.js";
import { getMilestoneCommandDefinitions } from "../src/families/milestone.js";
import type { InvocationContext } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "commands-milestone-"));
afterAll(() => rmSync(root,{recursive:true,force:true}));
function invocation(cwd:string): InvocationContext { return { cwd,controlRoot:null,versions:{engine:null,cli:null,plugin:null,host:null,platform:null},signal:new AbortController().signal,effects:{spawnProcess:async()=>({exitCode:0,stdout:"",stderr:""})} } as InvocationContext; }
/**
 * A checkout that owns its collaboration lane: milestone authority is the
 * repository lane, so a fixture without an identity has no store at all.
 */
async function laneFixture(cwd: string, harness: string): Promise<void> {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(cwd, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=fixture-${cwd.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(-110)}\n`);
  mkdirSync(harness, { recursive: true });
  await ensureCollaborationAuthority({ harnessDir: harness });
  (await initializeStore({ harnessDir: harness })).close();
}
test("milestone commands use store revision CAS with replay", async () => {
 const cwd=join(root,"fixture"), harness=join(cwd,".mstar");
 mkdirSync(cwd,{recursive:true}); await laneFixture(cwd,harness);
 await registerCatalogEntity({harnessDir:harness},{kind:"project",id:"proj",title:"Project",rootKind:"projects",relativePath:"proj"},{operationId:"project",actor:"test"});
 const call=(id:string,input:unknown)=>executeCommand(id,input,invocation(cwd));
 const base={project:"proj",name:"First",ordinal:0,expectStore:1,operation:"add-1"};
 const added=await call("milestone.add",base); expect(added.status,JSON.stringify(added)).toBe("ok");
 const receipt=added.data as {milestoneId:string;storeRevision:number}; expect(receipt.storeRevision).toBe(2);
 const replay=await call("milestone.add",base); expect(replay.data).toEqual(added.data);
 const stale=await call("milestone.add",{...base,name:"Second",operation:"add-2"}); expect(stale.status).toBe("refused"); expect(stale.code).toBe("milestone.revision-conflict");
 const list=await call("milestone.list",{project:"proj"}); expect(list.status).toBe("ok"); expect((list.data as {data:{milestones:Array<{name:string}>}}).data.milestones.map(row=>row.name)).toEqual(["First"]);
 const bad=await call("milestone.update",{project:"proj",id:receipt.milestoneId,expectStore:2,operation:"bad"}); expect(bad.exitCode).toBe(2);
});
test("name-only update leaves target optional and false clearTarget does not select a patch", async () => {
 const cwd = join(root, "update-patch");
 const harness = join(cwd, ".mstar");
 mkdirSync(cwd, { recursive: true });
 await laneFixture(cwd, harness);
 await registerCatalogEntity(
  { harnessDir: harness },
  { kind: "project", id: "proj-update", title: "Project", rootKind: "projects", relativePath: "proj" },
  { operationId: "project-update", actor: "test" },
 );
 const added = await executeCommand("milestone.add", {
  project: "proj-update", name: "Before", ordinal: 0, expectStore: 1, operation: "add-update",
 }, invocation(cwd));
 expect(added.status).toBe("ok");
 if (added.status !== "ok") return;
 const receipt = added.data as { milestoneId: string; storeRevision: number };
 const renamed = await executeCommand("milestone.update", {
  project: "proj-update", id: receipt.milestoneId, name: "After", expectStore: receipt.storeRevision, operation: "name-only",
 }, invocation(cwd));
 expect(renamed.status).toBe("ok");
 const noPatch = await executeCommand("milestone.update", {
  project: "proj-update", id: receipt.milestoneId, clearTarget: false, expectStore: receipt.storeRevision + 1, operation: "false-clear",
 }, invocation(cwd));
 expect(noPatch.status).toBe("usage");
 const current = await executeCommand("milestone.list", {
  project: "proj-update",
 }, invocation(cwd));
 expect(current.status).toBe("ok");
 if (current.status === "ok") {
  expect(current.data).toMatchObject({
   data: { milestones: [expect.objectContaining({ name: "After", target: null })] },
  });
 }
});
test("shared admission distinguishes zero, false, and true selectors at real milestone consumers", async () => {
 const cwd=join(root,"shared-admission"), harness=join(cwd,".mstar"); mkdirSync(cwd,{recursive:true});
 await laneFixture(cwd,harness);
 await registerCatalogEntity(
  {harnessDir:harness},
  {kind:"project",id:"proj-admission",title:"Project",rootKind:"projects",relativePath:"proj"},
  {operationId:"project-admission",actor:"test"},
 );
 const added=await executeCommand("milestone.add",{
  project:"proj-admission",name:"Admission",ordinal:0,expectStore:1,operation:"add-admission",harness,
 },invocation(cwd));
 expect(added.status).toBe("ok");
 if (added.status!=="ok") return;
 const {milestoneId,storeRevision}=added.data as {milestoneId:string;storeRevision:number};
 const update=(overrides:Record<string,unknown>)=>executeCommand("milestone.update",{
  project:"proj-admission",id:milestoneId,expectStore:storeRevision,operation:"update-admission",harness,...overrides,
 },invocation(cwd));
 const noPatch=await update({clearTarget:false});
 expect(noPatch.details?.diagnostics).toContainEqual(expect.objectContaining({
  code:"alternative-required",expected:expect.stringContaining("at least one of"),
 }));
 const zero=await update({ordinal:0});
 expect(zero.status).toBe("ok");
 const exclusive=await update({target:"2026-10-08",clearTarget:true});
 expect(exclusive.details?.diagnostics).toContainEqual(expect.objectContaining({code:"exclusive"}));

/** The grouped admission diagnostics of a usage envelope, or a failed read. */
const usageDiagnostics=(envelope:{status:string;details?:Record<string,unknown>})=>{
 const diagnostics=(envelope.details as {diagnostics?:unknown}|undefined)?.diagnostics;
 if(!Array.isArray(diagnostics))throw new Error(`usage envelope carries no grouped details.diagnostics: ${JSON.stringify(envelope)}`);
 return diagnostics as Array<Record<string,unknown>>;
};
const assignment=(clear:boolean)=>executeCommand("milestone.assign",{
 project:"proj-admission",issue:"I-999999",clear,reason:"test",expectIssue:0,expectStore:storeRevision,
 operation:`assign-${clear}`,actor:"project-manager",harness,
},invocation(cwd));
// `clear=false` selects neither alternative: the selector admission refuses
// `exactly one of id | clear=true` before any engine work.
const falseSelector=await assignment(false);
expect(falseSelector).toMatchObject({status:"usage",code:"command.invalid-input",exitCode:2});
expect(usageDiagnostics(falseSelector)).toContainEqual(expect.objectContaining({
 code:"alternative-required",expected:expect.stringContaining("exactly one of"),
}));
// `clear=true` alone satisfies the selector, so admission passes and the
// instruction reaches the engine's own store boundary instead of a usage
// refusal; that real refusal is the observable proof the selector was accepted.
const trueSelector=await assignment(true);
expect(trueSelector).toMatchObject({status:"refused",code:"issue.not-found",exitCode:1});
});
test("milestone assignment authorizes by the actor seat and the revision CAS with no execution identity", async () => {
 const definition=getMilestoneCommandDefinitions().find((row)=>row.id==="milestone.assign");
 if(definition===undefined) throw new Error("milestone.assign has no command definition");
 expect(definition.cli.options.map((option)=>option.key)).not.toContain("sessionId");
 expect(definition.requirements.filter((row)=>row.name==="sessionRef")).toEqual([]);
 const cwd=join(root,"active-assignment"), harness=join(cwd,".mstar"); mkdirSync(cwd,{recursive:true});
 await laneFixture(cwd,harness);
 await registerCatalogEntity({harnessDir:harness},{kind:"project",id:"proj-active",title:"Project",rootKind:"projects",relativePath:"proj-active"},{operationId:"project-active",actor:"test"});
 await withCollaborationWrite({harnessDir:harness},(handle)=>{
  handle.db.prepare("insert into issues(id,project_id,title,kind,severity,impact,acceptance,created_at,updated_at,identity_key) values('I-000506','proj-active','Smoke issue','bug','high','impact','acceptance','now','now','I-000506')").run();
 });
 const added=await executeCommand("milestone.add",{project:"proj-active",name:"Active milestone",ordinal:0,expectStore:1,operation:"add-active",harness},invocation(cwd));
 expect(added.status,JSON.stringify(added)).toBe("ok");
 if(added.status!=="ok") return;
 const milestone=added.data as {milestoneId:string;storeRevision:number};
 // One frozen request: the replay below must re-present the revisions the first attempt was judged against.
 const request={project:"proj-active",issue:"I-000506",id:milestone.milestoneId,reason:"I-000506 acceptance",expectIssue:1,expectStore:milestone.storeRevision,operation:"assign-active",actor:"project-manager",harness};
 const assign=(overrides:Record<string,unknown>)=>executeCommand("milestone.assign",{...request,...overrides},invocation(cwd));
 const wrongActor=await assign({operation:"assign-wrong-actor",actor:"fullstack-dev"});
 expect(wrongActor).toMatchObject({status:"refused",code:"issue.scope-refused",exitCode:1});
 const staleIssue=await assign({operation:"assign-stale-issue",expectIssue:2});
 expect(staleIssue).toMatchObject({status:"refused",code:"issue.revision-conflict"});
 const staleStore=await assign({operation:"assign-stale-store",expectStore:milestone.storeRevision+1});
 expect(staleStore).toMatchObject({status:"refused",code:"milestone.revision-conflict"});
 const first=await assign({});
 expect(first.status,JSON.stringify(first)).toBe("ok");
 if(first.status!=="ok") return;
 expect(first.data).toMatchObject({issueId:"I-000506",revision:2,created:false});
 const lane=await openCollaborationStore({harnessDir:harness},"read");
 try{
  expect(lane.db.prepare("select milestone_id from issues where id='I-000506'").get()).toEqual({milestone_id:milestone.milestoneId});
 }finally{ lane.close(); }
 expect(await assign({})).toEqual(first);
});
test("collaboration command evidence: milestone list carries its project's lane observation", async () => {
 const cwd=join(root,"evidence"), harness=join(cwd,".mstar");
 mkdirSync(cwd,{recursive:true}); await laneFixture(cwd,harness);
 await registerCatalogEntity({harnessDir:harness},{kind:"project",id:"proj-evidence",title:"Project",rootKind:"projects",relativePath:"proj-evidence"},{operationId:"project-evidence",actor:"test"});
 const listed=await executeCommand("milestone.list",{project:"proj-evidence",harness},invocation(cwd));
 expect(listed.status).toBe("ok");
 if(listed.status!=="ok") return;
 const read=listed.data as { milestones: unknown[]; collaboration: { scope:{kind:string;key:string};completeness:string;asOf:string } };
 // The list is one project-scoped lane read; the envelope's evidence names the
 // same scope and instant it answered with.
 expect(read.collaboration).toMatchObject({ scope:{kind:"milestone",key:"proj-evidence"}, completeness:"complete" });
 expect(Number.isNaN(Date.parse(read.collaboration.asOf))).toBe(false);
});

