import { createHash, randomUUID } from "node:crypto";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import type { RemoteEvent, RemoteIntent, RemoteIssue, RemoteWriteOrigin } from "./collaboration-remote.js";
import { withCollaborationWrite } from "./collaboration-store.js";
import { remoteMilestones } from "./collaboration-remote-read.js";
import type { StoreContext, StoreDb } from "./store-db.js";
import { TERMINAL_DISPOSITIONS, type Disposition } from "./issue.js";
import type { StoreReadQuery } from "./store-read.js";

export type ProjectMilestoneStatus = "planned" | "active" | "delivered" | "dropped";
export type ProjectMilestoneDTO = { milestoneId: string; projectId: string; name: string; target: string | null; status: ProjectMilestoneStatus; ordinal: number; revision: number; createdAt: string; updatedAt: string; totalIssues: number; openIssues: number; resolvedIssues: number; otherRetiredIssues: number };
export type MilestoneAdd = { projectId: string; name: string; target: string | null; ordinal: number };
export type MilestonePatch = { name?: string; target?: string | null; ordinal?: number; status?: ProjectMilestoneStatus };
export type MilestoneMutation = { operationId: string; expectedStoreRevision: number };
export type MilestoneReceipt = { projectId: string; milestoneId: string; revision: number; storeRevision: number; changed: boolean };
export type MilestoneAssignment = { projectId: string; milestoneId: string | null; reason: string };
export type MilestoneIssueDTO = { id: string; title: string; acceptance: string; disposition: Disposition; revision: number };
export type MilestoneRead = { projectId: string; milestones: ProjectMilestoneDTO[]; issues: Array<MilestoneIssueDTO & { milestoneId: string }>; unassignedIssues: number };

type MilestoneErrorCode = "milestone.schema-outdated" | "store.not-active" | "milestone.project-not-found" | "milestone.not-found" | "milestone.project-mismatch" | "milestone.invalid-input" | "milestone.revision-conflict" | "milestone.operation-conflict" | "store.operation-conflict" | "milestone.invalid-transition" | "milestone.open-issues" | "milestone.not-empty";
export class MilestoneError extends Error { readonly code: MilestoneErrorCode; constructor(code: MilestoneErrorCode, message: string) { super(`[${code}] ${message}`); this.name = "MilestoneError"; this.code = code; } }
const fail = (code: MilestoneErrorCode, message: string): never => { throw new MilestoneError(code, message); };
function guard(db: StoreDb): void {
  const row = db.prepare("select authority_state from collaboration_meta where id = 1").get() as { authority_state?: unknown } | undefined;
  if (row?.authority_state !== "active") fail("store.not-active", "Milestone access requires an active collaboration authority.");
}
/**
 * Every terminal disposition that is retired WITHOUT being resolved — the
 * `otherRetiredIssues` aggregate. Derived from the one vocabulary, so a new
 * retirement can never be silently dropped from the milestone rollup.
 */
const OTHER_RETIRED_DISPOSITION_SQL = TERMINAL_DISPOSITIONS.filter((value) => value !== "resolved")
  .map((value) => `'${value}'`)
  .join(",");
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
/** note: The status transitions one milestone update admits, shared by both transports. */
const MILESTONE_TRANSITIONS: Record<ProjectMilestoneStatus, ProjectMilestoneStatus[]> = { planned:["planned","active","dropped"], active:["active","planned","delivered","dropped"], delivered:["delivered","active"], dropped:["dropped","active"] };
function write<T>(context: StoreContext, fn: (db: StoreDb) => T): Promise<T> {
  return withCollaborationWrite(context, (handle) => fn(handle.db));
}

/**
 * note: A REMOTE milestone's id is derived from its own operation id, so a replay of the verb
 * names the same row it froze instead of minting a second identity for the same write.
 */
function milestoneIdForOperation(operationId: string): string {
  const digest = createHash("sha256").update(`milestone:${operationId}`, "utf8").digest();
  const hex = Buffer.from(digest.subarray(0, 16)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** note: The business result one remote milestone write derives from the observed document it froze against. */
type MilestoneWriteResult = Readonly<{ changed: boolean; revision: number }>;

/** note: The recorded result of one confirmed milestone write, or null when none was recorded. */
function recordedMilestoneResult(value: unknown): MilestoneWriteResult | null {
  if (value === null || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.changed !== "boolean" || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
    return null;
  }
  return { changed: body.changed, revision: body.revision as number };
}

/**
 * note: The business result of one milestone request, derived from the same observed document the
 * request froze against: a no-op update keeps its revision and reports no change, a removal reports
 * the revision it removed, an add reports the first revision. Recorded at preparation, because the
 * confirmed document no longer carries the before-state.
 */
function milestoneWriteResult(
  milestoneId: string,
): (current: Record<string, unknown>, subject: Record<string, unknown>) => MilestoneWriteResult {
  return (current, subject) => {
    const before = observedMilestones(current).find((entry) => entry.milestoneId === milestoneId);
    const after = observedMilestones(subject).find((entry) => entry.milestoneId === milestoneId);
    if (after === undefined) {
      return { changed: before !== undefined, revision: typeof before?.revision === "number" ? before.revision : 0 };
    }
    return {
      changed: before === undefined || after.revision !== before.revision,
      revision: typeof after.revision === "number" ? after.revision : 0,
    };
  };
}

/**
 * note: The confirmed business result of a remote milestone write, read from the result recorded
 * with the frozen request. A remote write owns no local collaboration revision.
 */
function confirmedMilestoneReceipt(intent: RemoteIntent, projectId: string, milestoneId: string): MilestoneReceipt {
  if (intent.confirmed === null) {
    throw new MilestoneError(
      "milestone.operation-conflict",
      `Operation ${intent.operationId} is confirmed without a recorded provider effect; nothing was read or changed.`,
    );
  }
  const result = recordedMilestoneResult(intent.result);
  if (result === null) {
    throw new MilestoneError(
      "milestone.operation-conflict",
      `Operation ${intent.operationId} is confirmed without its recorded business result, so its change and revision ` +
        `cannot be reported. Inspect it with outbox-show; nothing was read or changed.`,
    );
  }
  return {
    projectId,
    milestoneId,
    revision: result.revision,
    storeRevision: 0,
    changed: result.changed,
  };
}

/**
 * The remote branch of every milestone write: freeze the new project journal document as one
 * durable outbox intent and report it. A confirmed intent reports the recorded business result of
 * an identical replay; anything else is `remote.effect-pending`. A milestone row is never written
 * locally in `remote` mode.
 */
async function queueMilestoneWrite(
  context: StoreContext,
  projectId: string,
  operationId: string,
  milestoneId: string,
  origin: RemoteWriteOrigin,
  next: (current: Record<string, unknown>, issues: readonly RemoteIssue[]) => Record<string, unknown>,
): Promise<MilestoneReceipt> {
  // note: Dynamic on purpose — collaboration-remote.ts imports this module, so a static import
  // would close the cycle before the milestone contract initializes.
  const { prepareRemoteProjectWrite, pendingRemoteEffect } = await import("./collaboration-remote.js");
  const intent = await prepareRemoteProjectWrite(context, {
    projectId,
    operationId,
    origin,
    next,
    result: milestoneWriteResult(milestoneId),
  });
  if (intent.confirmed !== null) return confirmedMilestoneReceipt(intent, projectId, milestoneId);
  throw pendingRemoteEffect(intent);
}

/** note: The observed milestone rows of one project document, as the projection reads them. */
function observedMilestones(current: Record<string, unknown>): Array<Record<string, unknown>> {
  return current.milestones as Array<Record<string, unknown>>;
}

/**
 * note: The open issues assigned to one milestone. The snapshot's issue list is ALREADY the bound
 * project's scope, so its entries are never re-filtered by the local project key: that key and the
 * provider project id are different identifiers, and comparing them counts nothing.
 */
function openIssuesOf(issues: readonly RemoteIssue[], milestoneId: string): number {
  return issues.filter(
    (issue) =>
      issue.mstar !== null &&
      issue.mstar.fields.milestoneId === milestoneId &&
      issue.mstar.fields.disposition === "open",
  ).length;
}

/** note: Every issue assigned to one milestone — settled rows included, exactly as the local rule counts. */
function assignedIssuesOf(issues: readonly RemoteIssue[], milestoneId: string): number {
  return issues.filter((issue) => issue.mstar !== null && issue.mstar.fields.milestoneId === milestoneId).length;
}
function requestHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function mutate(db: StoreDb, projectId: string, milestoneId: string, patch: MilestonePatch | MilestoneAdd, mutation: MilestoneMutation, adding: boolean): MilestoneReceipt {
  guard(db);
  if (!mutation || typeof mutation.operationId !== "string" || !mutation.operationId.trim() || !Number.isSafeInteger(mutation.expectedStoreRevision) || mutation.expectedStoreRevision < 0) fail("milestone.invalid-input", "A non-empty operationId and non-negative expected store revision are required.");
  if (patch.name !== undefined && !validName(patch.name)) fail("milestone.invalid-input", "Name, target date, or ordinal is invalid.");
  const normalizedPatch = { ...patch, ...(patch.name === undefined ? {} : { name: patch.name.trim() }) };
  const hash = requestHash({ domain: "milestone", action: adding ? "add" : "update", projectId, milestoneId: adding ? null : milestoneId, patch: normalizedPatch, expectedStoreRevision: mutation.expectedStoreRevision });
  const prior = db.prepare("select request_hash, result_json from collaboration_operations where key_space='standalone' and operation_id=?").get(mutation.operationId) as { request_hash: string; result_json: string } | undefined;
  if (prior) { if (prior.request_hash !== hash) fail("store.operation-conflict", "operationId was reused for a different request."); return JSON.parse(prior.result_json) as MilestoneReceipt; }
  project(db, projectId);
  const store = db.prepare("select revision from collaboration_meta where id=1").get() as { revision: number };
  if (store.revision !== mutation.expectedStoreRevision) fail("milestone.revision-conflict", "Store revision changed since it was observed.");
  if (adding ? !validName(patch.name) || !validOrdinal(patch.ordinal) || !validTarget(patch.target) : (patch.name !== undefined && !validName(patch.name)) || (patch.target !== undefined && !validTarget(patch.target)) || (patch.ordinal !== undefined && !validOrdinal(patch.ordinal))) fail("milestone.invalid-input", "Name, target date, or ordinal is invalid.");
  const now = new Date().toISOString();
  let revision = 1;
  let changed = true;
  if (adding) {
    milestoneId = randomUUID();
    const add = patch as MilestoneAdd;
    db.prepare("insert into project_milestones(milestone_id,project_id,name,target,status,ordinal,revision,created_at,updated_at) values(?,?,?,?,'planned',?,1,?,?)").run(milestoneId, projectId, add.name.trim(), add.target, add.ordinal, now, now);
  } else {
    const row = db.prepare("select name,target,status,ordinal,revision from project_milestones where milestone_id=? and project_id=?").get(milestoneId, projectId) as { name:string; target:string|null; status:ProjectMilestoneStatus; ordinal:number; revision:number } | undefined;
    if (!row) throw new MilestoneError("milestone.not-found", `Milestone ${milestoneId} does not exist in project ${projectId}.`);
    const update = patch as MilestonePatch;
    const nextStatus = update.status ?? row.status;
    const statuses: ProjectMilestoneStatus[] = ["planned","active","delivered","dropped"];
    if (!statuses.includes(nextStatus)) fail("milestone.invalid-input", "Milestone status is invalid.");
    const transitions = MILESTONE_TRANSITIONS;
    if (!transitions[row.status].includes(nextStatus)) fail("milestone.invalid-transition", `Cannot transition ${row.status} to ${nextStatus}.`);
    if (nextStatus === "delivered") {
      // Contract §Gates: a complete observation that proves zero open issues
      // passes — including a milestone that links none; any open row keeps the
      // refusal. Missing/unavailable authority refuses before this point.
      const counts = db.prepare("select sum(case when disposition='open' then 1 else 0 end) as open from issues where project_id=? and milestone_id=?").get(projectId, milestoneId) as { open: number | null };
      if (counts.open) fail("milestone.open-issues", "A milestone with open issues cannot be delivered.");
    }
    const name = update.name === undefined ? row.name : update.name.trim();
    const target = update.target === undefined ? row.target : update.target;
    const ordinal = update.ordinal === undefined ? row.ordinal : update.ordinal;
    changed = name !== row.name || target !== row.target || ordinal !== row.ordinal || nextStatus !== row.status;
    revision = row.revision + (changed ? 1 : 0);
    if (changed) db.prepare("update project_milestones set name=?,target=?,ordinal=?,status=?,revision=?,updated_at=? where milestone_id=? and project_id=?").run(name,target,ordinal,nextStatus,revision,now,milestoneId,projectId);
  }
  if (changed) db.prepare("update collaboration_meta set revision=revision+1 where id=1").run();
  const current = db.prepare("select revision from collaboration_meta where id=1").get() as {revision:number};
  const receipt: MilestoneReceipt = { projectId, milestoneId, revision, storeRevision: current.revision, changed };
  db.prepare("insert into collaboration_operations(key_space,operation_id,request_hash,result_json,committed_at) values('standalone',?,?,?,?)").run(mutation.operationId,hash,JSON.stringify(receipt),now);
  return receipt;
}
export async function addMilestone(context: StoreContext, input: MilestoneAdd, mutation: MilestoneMutation): Promise<MilestoneReceipt> {
  if (resolveCollaborationLocation(context).mode === "remote") {
    if (!mutation || typeof mutation.operationId !== "string" || !mutation.operationId.trim()) fail("milestone.invalid-input", "A non-empty operationId is required.");
    if (!validName(input.name) || !validOrdinal(input.ordinal) || !validTarget(input.target)) fail("milestone.invalid-input", "Name, target date, or ordinal is invalid.");
    const at = new Date().toISOString();
    const milestoneId = milestoneIdForOperation(mutation.operationId);
    return queueMilestoneWrite(
      context,
      input.projectId,
      mutation.operationId,
      milestoneId,
      { verb: "milestone-add", request: { projectId: input.projectId, name: input.name.trim(), target: input.target, ordinal: input.ordinal, expectedStoreRevision: mutation.expectedStoreRevision } },
      (current) => ({
        ...current,
        milestones: [
          ...observedMilestones(current),
          { milestoneId, name: input.name.trim(), target: input.target, status: "planned", ordinal: input.ordinal, revision: 1, createdAt: at, updatedAt: at },
        ],
      }),
    );
  }
  return write(context, db => mutate(db,input.projectId,"",input,mutation,true));
}
export async function updateMilestone(context: StoreContext, projectId: string, milestoneId: string, patch: MilestonePatch, mutation: MilestoneMutation): Promise<MilestoneReceipt> {
  if (!patch || !Object.keys(patch).length || Object.keys(patch).some(key => !["name","target","ordinal","status"].includes(key))) return Promise.reject(new MilestoneError("milestone.invalid-input", "A non-empty milestone patch is required."));
  if (resolveCollaborationLocation(context).mode === "remote") {
    if (!mutation || typeof mutation.operationId !== "string" || !mutation.operationId.trim()) fail("milestone.invalid-input", "A non-empty operationId is required.");
    if (patch.name !== undefined && !validName(patch.name)) fail("milestone.invalid-input", "Name, target date, or ordinal is invalid.");
    if (patch.target !== undefined && !validTarget(patch.target)) fail("milestone.invalid-input", "Name, target date, or ordinal is invalid.");
    if (patch.ordinal !== undefined && !validOrdinal(patch.ordinal)) fail("milestone.invalid-input", "Name, target date, or ordinal is invalid.");
    const at = new Date().toISOString();
    return queueMilestoneWrite(
      context,
      projectId,
      mutation.operationId,
      milestoneId,
      { verb: "milestone-update", request: { projectId, milestoneId, patch, expectedStoreRevision: mutation.expectedStoreRevision } },
      (current, issues) => {
        const rows = observedMilestones(current);
        const row = rows.find((entry) => entry.milestoneId === milestoneId);
        if (row === undefined) throw new MilestoneError("milestone.not-found", `Milestone ${milestoneId} is not observed in project ${projectId}.`);
        const nextStatus = (patch.status ?? row.status) as ProjectMilestoneStatus;
        if (!Object.hasOwn(MILESTONE_TRANSITIONS, nextStatus)) fail("milestone.invalid-input", "Milestone status is invalid.");
        if (!MILESTONE_TRANSITIONS[row.status as ProjectMilestoneStatus].includes(nextStatus)) {
          fail("milestone.invalid-transition", `Cannot transition ${String(row.status)} to ${nextStatus}.`);
        }
        if (nextStatus === "delivered" && openIssuesOf(issues, milestoneId) > 0) {
          fail("milestone.open-issues", "A milestone with open issues cannot be delivered.");
        }
        const name = patch.name === undefined ? String(row.name) : patch.name.trim();
        const target = patch.target === undefined ? (row.target as string | null) : patch.target;
        const ordinal = patch.ordinal === undefined ? (row.ordinal as number) : patch.ordinal;
        const changed = name !== row.name || target !== row.target || ordinal !== row.ordinal || nextStatus !== row.status;
        return {
          ...current,
          milestones: rows.map((entry) =>
            entry.milestoneId === milestoneId
              ? { ...entry, name, target, ordinal, status: nextStatus, revision: (entry.revision as number) + (changed ? 1 : 0), updatedAt: changed ? at : entry.updatedAt }
              : entry,
          ),
        };
      },
    );
  }
  return write(context, db => mutate(db,projectId,milestoneId,patch,mutation,false));
}
/** Remove an empty milestone (idempotent via the shared operation ledger; refuses `milestone.not-empty` while issues remain). */
export async function removeMilestone(context: StoreContext, projectId: string, milestoneId: string, mutation: MilestoneMutation): Promise<MilestoneReceipt> {
  if (resolveCollaborationLocation(context).mode === "remote") {
    if (!mutation || typeof mutation.operationId !== "string" || !mutation.operationId.trim()) fail("milestone.invalid-input", "A non-empty operationId is required.");
    return queueMilestoneWrite(
      context,
      projectId,
      mutation.operationId,
      milestoneId,
      { verb: "milestone-remove", request: { projectId, milestoneId, expectedStoreRevision: mutation.expectedStoreRevision } },
      (current, issues) => {
        const rows = observedMilestones(current);
        if (!rows.some((entry) => entry.milestoneId === milestoneId)) {
          throw new MilestoneError("milestone.not-found", `Milestone ${milestoneId} is not observed in project ${projectId}.`);
        }
        const held = assignedIssuesOf(issues, milestoneId);
        if (held > 0) {
          fail("milestone.not-empty", `Milestone ${milestoneId} still holds ${held} issue(s); settled rows count too, so reassign or clear them before the removal. Nothing was enqueued.`);
        }
        return { ...current, milestones: rows.filter((entry) => entry.milestoneId !== milestoneId) };
      },
    );
  }
  return write(context, db => {
    guard(db);
    if (!mutation || typeof mutation.operationId !== "string" || !mutation.operationId.trim() || !Number.isSafeInteger(mutation.expectedStoreRevision) || mutation.expectedStoreRevision < 0) fail("milestone.invalid-input", "A non-empty operationId and non-negative expected store revision are required.");
    const hash = requestHash({ domain: "milestone", action: "remove", projectId, milestoneId, patch: null, expectedStoreRevision: mutation.expectedStoreRevision });
    const prior = db.prepare("select request_hash, result_json from collaboration_operations where key_space='standalone' and operation_id=?").get(mutation.operationId) as { request_hash: string; result_json: string } | undefined;
    if (prior) { if (prior.request_hash !== hash) fail("store.operation-conflict", "operationId was reused for a different request."); return JSON.parse(prior.result_json) as MilestoneReceipt; }
    project(db, projectId);
    // The same CAS every milestone writer takes (mutate): a removal judged
    // against a store revision that has moved is refused, never landed on a
    // newer snapshot than the one the operator reviewed.
    const store = db.prepare("select revision from collaboration_meta where id=1").get() as { revision: number };
    if (store.revision !== mutation.expectedStoreRevision) fail("milestone.revision-conflict", "Store revision changed since it was observed.");
    const row = db.prepare("select milestone_id, project_id, revision from project_milestones where milestone_id=? and project_id=?").get(milestoneId, projectId) as { milestone_id: string; project_id: string; revision: number } | undefined;
    if (!row) fail("milestone.not-found", `Milestone ${milestoneId} does not exist in project ${projectId}.`);
    // Every issue row counts, settled ones included: the FK membership is the
    // fact. The message names the retired rows so a milestone carrying only
    // resolved/waived issues is not reported as "open issues".
    const held = db.prepare("select count(*) as total, sum(case when disposition='open' then 1 else 0 end) as open from issues where project_id=? and milestone_id=?").get(projectId, milestoneId) as { total: number; open: number | null };
    if (held.total > 0) {
      const open = held.open ?? 0;
      fail("milestone.not-empty", `Milestone ${milestoneId} still holds ${held.total} issue(s): ${open} open, ${held.total - open} settled (resolved/waived/duplicate/superseded) \u2014 settled rows count too, so a milestone carrying only retired issues cannot be removed either. Reassign them to another milestone or clear their assignment with \`mstar milestone assign --project ${projectId} --issue <issue-id> --clear --reason <text> --expect-issue <revision> --expect-store ${store.revision} --operation <id> --actor <role>\`, then retry the removal.`);
    }
    const now = new Date().toISOString();
    db.prepare("delete from project_milestones where milestone_id=? and project_id=?").run(milestoneId, projectId);
    db.prepare("update collaboration_meta set revision=revision+1 where id=1").run();
    const current = db.prepare("select revision from collaboration_meta where id=1").get() as { revision: number };
    const receipt: MilestoneReceipt = { projectId, milestoneId, revision: (row as { revision: number }).revision, storeRevision: current.revision, changed: true };
    db.prepare("insert into collaboration_operations(key_space,operation_id,request_hash,result_json,committed_at) values('standalone',?,?,?,?)").run(mutation.operationId,hash,JSON.stringify(receipt),now);
    return receipt;
  });
}
export function readMilestonesOn(db: StoreDb, projectId: string, milestoneId?: string): MilestoneRead {
  guard(db); project(db,projectId);
  if (milestoneId !== undefined) {
    const owner = db.prepare("select project_id from project_milestones where milestone_id=?").get(milestoneId) as { project_id: string } | undefined;
    if (!owner) return fail("milestone.not-found", `Milestone ${milestoneId} does not exist.`);
    if (owner.project_id !== projectId) fail("milestone.project-mismatch", `Milestone ${milestoneId} does not belong to project ${projectId}.`);
  }
  const filter = milestoneId === undefined ? "" : " and m.milestone_id=?";
  const params = milestoneId === undefined ? [projectId] : [projectId,milestoneId];
  const rows = db.prepare(`select m.milestone_id,m.project_id,m.name,m.target,m.status,m.ordinal,m.revision,m.created_at,m.updated_at,count(i.id) total_issues,sum(case when i.disposition='open' then 1 else 0 end) open_issues,sum(case when i.disposition='resolved' then 1 else 0 end) resolved_issues,sum(case when i.disposition in (${OTHER_RETIRED_DISPOSITION_SQL}) then 1 else 0 end) other_retired_issues from project_milestones m left join issues i on i.milestone_id=m.milestone_id and i.project_id=m.project_id where m.project_id=?${filter} group by m.milestone_id order by m.ordinal,m.milestone_id`).all(...params) as Array<Record<string,unknown>>;
  const milestones: ProjectMilestoneDTO[] = rows.map(r => { const resolvedIssues=Number(r.resolved_issues)||0, otherRetiredIssues=Number(r.other_retired_issues)||0, openIssues=Number(r.open_issues)||0; return { milestoneId:String(r.milestone_id),projectId:String(r.project_id),name:String(r.name),target:r.target as string|null,status:r.status as ProjectMilestoneStatus,ordinal:Number(r.ordinal),revision:Number(r.revision),createdAt:String(r.created_at),updatedAt:String(r.updated_at),totalIssues:Number(r.total_issues),openIssues,resolvedIssues,otherRetiredIssues }; });
  const issues = (db.prepare(`select id,title,acceptance,disposition,revision,milestone_id from issues where project_id=? and milestone_id is not null${milestoneId === undefined ? "" : " and milestone_id=?"} order by milestone_id,id`).all(...params) as Array<Record<string,unknown>>).map(r => ({ id:String(r.id),title:String(r.title),acceptance:String(r.acceptance),disposition:r.disposition as MilestoneIssueDTO["disposition"],revision:Number(r.revision),milestoneId:String(r.milestone_id) }));
  const unassigned = db.prepare("select count(*) as count from issues where project_id=? and milestone_id is null").get(projectId) as {count:number};
  return { projectId, milestones, issues, unassignedIssues: unassigned.count };
}
export function queryMilestones(projectId: string, milestoneId?: string): StoreReadQuery<MilestoneRead> { return { view: milestoneId ? "milestone-status" : "milestones", needsProjection: false, collaboration: { scope: { kind: "milestone", key: milestoneId === undefined ? projectId : `${projectId}:${milestoneId}` }, required: true, projectIds: [projectId] }, execution: "not-requested", run: sources => { if (sources.remote !== null) return { data: remoteMilestones(sources.remote, projectId, milestoneId) }; if (sources.collaboration === null) throw new MilestoneError("store.not-active","This milestone read requires the collaboration authority, which was not opened for this request."); return { data: readMilestonesOn(sources.collaboration.db,projectId,milestoneId) }; } }; }
