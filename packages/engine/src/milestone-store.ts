import { createHash, randomUUID } from "node:crypto";
import { openStore, type StoreContext, type StoreDb } from "./store-db.js";
import type { StoreReadQuery } from "./store-read.js";

export type ProjectMilestoneStatus = "planned" | "active" | "delivered" | "dropped";
export type ProjectMilestoneDTO = { milestoneId: string; projectId: string; name: string; target: string | null; status: ProjectMilestoneStatus; ordinal: number; revision: number; createdAt: string; updatedAt: string; totalIssues: number; openIssues: number; doneIssues: number; resolvedIssues: number; otherRetiredIssues: number };
export type MilestoneAdd = { projectId: string; name: string; target: string | null; ordinal: number };
export type MilestonePatch = { name?: string; target?: string | null; ordinal?: number; status?: ProjectMilestoneStatus };
export type MilestoneMutation = { operationId: string; expectedStoreRevision: number };
export type MilestoneReceipt = { projectId: string; milestoneId: string; revision: number; storeRevision: number; changed: boolean };
export type MilestoneIssueDTO = { id: string; title: string; acceptance: string; disposition: "open" | "resolved" | "waived" | "duplicate" | "superseded"; revision: number };
export type MilestoneRead = { projectId: string; milestones: ProjectMilestoneDTO[]; issues: Array<MilestoneIssueDTO & { milestoneId: string }>; unassignedIssues: number };

type MilestoneErrorCode = "milestone.schema-outdated" | "milestone.store-not-active" | "milestone.project-not-found" | "milestone.not-found" | "milestone.invalid-input" | "milestone.revision-conflict" | "milestone.operation-conflict" | "milestone.invalid-transition" | "milestone.open-issues" | "milestone.empty";
export class MilestoneError extends Error { readonly code: MilestoneErrorCode; constructor(code: MilestoneErrorCode, message: string) { super(`[${code}] ${message}`); this.name = "MilestoneError"; this.code = code; } }
const fail = (code: MilestoneErrorCode, message: string): never => { throw new MilestoneError(code, message); };
function guard(db: StoreDb): void {
  const schema = db.prepare("select max(version) as version from schema_version").get() as { version?: number } | undefined;
  if (!Number.isInteger(schema?.version) || (schema?.version ?? 0) < 7) fail("milestone.schema-outdated", 'Milestones require store schema 7; run "mstar store upgrade" first.');
  const active = db.prepare("select authority_state from store_meta where id=1").get() as { authority_state?: string } | undefined;
  if (active?.authority_state !== "active") fail("milestone.store-not-active", "Milestone access requires an active store.");
}
function project(db: StoreDb, projectId: string): void {
  if (!db.prepare("select 1 from catalog_entities where kind='project' and id=?").get(projectId)) fail("milestone.project-not-found", `Project ${projectId} does not exist.`);
}
function validTarget(target: unknown): target is string | null {
  if (target === null) return true;
  if (typeof target !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return false;
  const date = new Date(`${target}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === target;
}
function validName(name: unknown): name is string { return typeof name === "string" && name.trim().length > 0; }
function validOrdinal(ordinal: unknown): ordinal is number { return typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal >= 0; }
function write<T>(context: StoreContext, fn: (db: StoreDb) => T): Promise<T> {
  return openStore(context, "write").then(handle => { try { handle.db.exec("begin immediate"); try { const result = fn(handle.db); handle.db.exec("commit"); return result; } catch (error) { try { handle.db.exec("rollback"); } catch {} throw error; } } finally { handle.close(); } });
}
function requestHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function mutate(db: StoreDb, projectId: string, milestoneId: string, patch: MilestonePatch | MilestoneAdd, mutation: MilestoneMutation, adding: boolean): MilestoneReceipt {
  guard(db);
  if (!mutation || typeof mutation.operationId !== "string" || !mutation.operationId.trim() || !Number.isSafeInteger(mutation.expectedStoreRevision) || mutation.expectedStoreRevision < 0) fail("milestone.invalid-input", "A non-empty operationId and non-negative expected store revision are required.");
  const hash = requestHash({ domain: "milestone", action: adding ? "add" : "update", projectId, milestoneId: adding ? null : milestoneId, patch, expectedStoreRevision: mutation.expectedStoreRevision });
  const prior = db.prepare("select request_hash, result_json from store_operations where operation_id=?").get(mutation.operationId) as { request_hash: string; result_json: string } | undefined;
  if (prior) { if (prior.request_hash !== hash) fail("milestone.operation-conflict", "operationId was reused for a different request."); return JSON.parse(prior.result_json) as MilestoneReceipt; }
  project(db, projectId);
  const store = db.prepare("select revision from store_meta where id=1").get() as { revision: number };
  if (store.revision !== mutation.expectedStoreRevision) fail("milestone.revision-conflict", "Store revision changed since it was observed.");
  if (adding ? !validName(patch.name) || !validOrdinal(patch.ordinal) || !validTarget(patch.target) : (patch.name !== undefined && !validName(patch.name)) || (patch.target !== undefined && !validTarget(patch.target)) || (patch.ordinal !== undefined && !validOrdinal(patch.ordinal))) fail("milestone.invalid-input", "Name, target date, or ordinal is invalid.");
  const now = new Date().toISOString();
  let revision = 1;
  let changed = true;
  if (adding) {
    milestoneId = randomUUID();
    db.prepare("insert into project_milestones(milestone_id,project_id,name,target,status,ordinal,revision,created_at,updated_at) values(?,?,?,?,'planned',?,1,?,?)").run(milestoneId, projectId, patch.name.trim(), patch.target, patch.ordinal, now, now);
  } else {
    const row = db.prepare("select name,target,status,ordinal,revision from project_milestones where milestone_id=? and project_id=?").get(milestoneId, projectId) as { name:string; target:string|null; status:ProjectMilestoneStatus; ordinal:number; revision:number } | undefined;
    if (!row) fail("milestone.not-found", `Milestone ${milestoneId} does not exist in project ${projectId}.`);
    const nextStatus = patch.status ?? row.status;
    const statuses: ProjectMilestoneStatus[] = ["planned","active","delivered","dropped"];
    if (!statuses.includes(nextStatus)) fail("milestone.invalid-input", "Milestone status is invalid.");
    const transitions: Record<ProjectMilestoneStatus, ProjectMilestoneStatus[]> = { planned:["planned","active","dropped"], active:["active","planned","delivered","dropped"], delivered:["delivered","active"], dropped:["dropped","active"] };
    if (!transitions[row.status].includes(nextStatus)) fail("milestone.invalid-transition", `Cannot transition ${row.status} to ${nextStatus}.`);
    if (nextStatus === "delivered") {
      const counts = db.prepare("select count(*) as total, sum(case when disposition='open' then 1 else 0 end) as open from issues where project_id=? and milestone_id=?").get(projectId, milestoneId) as { total:number; open:number|null };
      if (!counts.total) fail("milestone.empty", "An empty milestone cannot be delivered.");
      if (counts.open) fail("milestone.open-issues", "A milestone with open issues cannot be delivered.");
    }
    const name = patch.name === undefined ? row.name : patch.name.trim();
    const target = patch.target === undefined ? row.target : patch.target;
    const ordinal = patch.ordinal === undefined ? row.ordinal : patch.ordinal;
    changed = name !== row.name || target !== row.target || ordinal !== row.ordinal || nextStatus !== row.status;
    revision = row.revision + (changed ? 1 : 0);
    if (changed) db.prepare("update project_milestones set name=?,target=?,ordinal=?,status=?,revision=?,updated_at=? where milestone_id=? and project_id=?").run(name,target,ordinal,nextStatus,revision,now,milestoneId,projectId);
  }
  if (changed) db.prepare("update store_meta set revision=revision+1 where id=1").run();
  const current = db.prepare("select revision from store_meta where id=1").get() as {revision:number};
  const receipt: MilestoneReceipt = { projectId, milestoneId, revision, storeRevision: current.revision, changed };
  db.prepare("insert into store_operations(operation_id,request_hash,result_json,committed_at) values(?,?,?,?)").run(mutation.operationId,hash,JSON.stringify(receipt),now);
  return receipt;
}
export function addMilestone(context: StoreContext, input: MilestoneAdd, mutation: MilestoneMutation): Promise<MilestoneReceipt> { return write(context, db => mutate(db,input.projectId,"",input,mutation,true)); }
export function updateMilestone(context: StoreContext, projectId: string, milestoneId: string, patch: MilestonePatch, mutation: MilestoneMutation): Promise<MilestoneReceipt> {
  if (!patch || !Object.keys(patch).length || Object.keys(patch).some(key => !["name","target","ordinal","status"].includes(key))) return Promise.reject(new MilestoneError("milestone.invalid-input", "A non-empty milestone patch is required."));
  return write(context, db => mutate(db,projectId,milestoneId,patch,mutation,false));
}
export function readMilestonesOn(db: StoreDb, projectId: string, milestoneId?: string): MilestoneRead {
  guard(db); project(db,projectId);
  const filter = milestoneId === undefined ? "" : " and m.milestone_id=?";
  const params = milestoneId === undefined ? [projectId] : [projectId,milestoneId];
  const rows = db.prepare(`select m.milestone_id,m.project_id,m.name,m.target,m.status,m.ordinal,m.revision,m.created_at,m.updated_at,count(i.id) total_issues,sum(case when i.disposition='open' then 1 else 0 end) open_issues,sum(case when i.disposition='resolved' then 1 else 0 end) resolved_issues,sum(case when i.disposition in ('waived','duplicate','superseded') then 1 else 0 end) other_retired_issues from project_milestones m left join issues i on i.milestone_id=m.milestone_id and i.project_id=m.project_id where m.project_id=?${filter} group by m.milestone_id order by m.ordinal,m.milestone_id`).all(...params) as Array<Record<string,unknown>>;
  const milestones: ProjectMilestoneDTO[] = rows.map(r => { const resolvedIssues=Number(r.resolved_issues)||0, otherRetiredIssues=Number(r.other_retired_issues)||0, openIssues=Number(r.open_issues)||0; return { milestoneId:String(r.milestone_id),projectId:String(r.project_id),name:String(r.name),target:r.target as string|null,status:r.status as ProjectMilestoneStatus,ordinal:Number(r.ordinal),revision:Number(r.revision),createdAt:String(r.created_at),updatedAt:String(r.updated_at),totalIssues:Number(r.total_issues),openIssues,doneIssues:resolvedIssues+otherRetiredIssues,resolvedIssues,otherRetiredIssues }; });
  const issues = (db.prepare(`select id,title,acceptance,disposition,revision,milestone_id from issues where project_id=? and milestone_id is not null${milestoneId === undefined ? "" : " and milestone_id=?"} order by milestone_id,id`).all(...params) as Array<Record<string,unknown>>).map(r => ({ id:String(r.id),title:String(r.title),acceptance:String(r.acceptance),disposition:r.disposition as MilestoneIssueDTO["disposition"],revision:Number(r.revision),milestoneId:String(r.milestone_id) }));
  const unassigned = db.prepare("select count(*) as count from issues where project_id=? and milestone_id is null").get(projectId) as {count:number};
  return { projectId, milestones, issues, unassignedIssues: unassigned.count };
}
export function queryMilestones(projectId: string, milestoneId?: string): StoreReadQuery<MilestoneRead> { return { view: milestoneId ? "milestone-status" : "milestones", needsProjection: false, run: handle => readMilestonesOn(handle.db,projectId,milestoneId) }; }
