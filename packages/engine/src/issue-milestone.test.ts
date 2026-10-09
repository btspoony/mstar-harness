import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withStoreRead, queryDashboard } from "./store-read.js";
import { assignIssueMilestone, closeIssue, getIssue, IssueError, listIssues, captureIssue } from "./issue.js";
import { addMilestone, updateMilestone } from "./milestone-store.js";
import { initializeStore, upgradeStore, MIGRATIONS, migrationChecksum, SCHEMA_VERSION_TABLE_SQL, storeDbPath, type StoreContext, type StoreDb } from "./store-db.js";
import { bindExecutionSession, createExecutionWorkflow, readExecutionState } from "./execution-store.js";
import { encodeExecutionSessionRef } from "./execution-session.js";
import type { WorkflowSnapshot } from "./workflow.js";
import type { WorkflowEntry } from "./status.js";

const root = mkdtempSync(join(tmpdir(), "issue-milestone-"));
const harness = join(root, ".mstar");
const context: StoreContext = { harnessDir: harness };
const projectId = "milestone-assignment-project";
let db: StoreDb;
let sessionRef: string;
let issueNumber = 0;
function makeIssue(id: string, project = projectId): void {
  db.prepare("insert into issues(id,project_id,title,kind,severity,impact,acceptance,created_at,updated_at,identity_key) values(?,?,'Issue','bug','high','impact','acceptance','now','now',?)").run(id, project, id);
}
function revision(): number { return (db.prepare("select revision from store_meta where id=1").get() as { revision: number }).revision; }
function issueRevision(id: string): number { return (db.prepare("select revision from issues where id=?").get(id) as { revision: number }).revision; }
function mutation(id: string, expectedRevision: number, expectedStoreRevision = revision(), actor = "project-manager", ref = sessionRef) {
  return { operationId: id, actor, sessionRef: ref, expectedRevision, expectedStoreRevision };
}
let milestoneId = "";
let otherMilestoneId = "";
beforeAll(async () => {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  mkdirSync(harness, { recursive: true });
  const handle = await initializeStore(context); db = handle.db;
  const initialized = await readExecutionState(context);
  const workflowId = "milestone-live-workflow";
  const caller = { sessionId: "milestone-coordinator", workflowId, role: "coordinator" as const };
  const snapshot = {
    schema_version: 1, id: workflowId, type: "plan", status: "running",
    started_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
    branch: { base: "main", source: "feature/milestone", target: "main", integration: "integration/milestone" },
    plans: [],
  } as unknown as WorkflowSnapshot;
  const created = await createExecutionWorkflow({ harnessDir: harness, caller }, {
    entry: { id: workflowId, type: "plan", started_at: "2026-09-29T00:00:00Z", dir: `workflows/${workflowId}` } as WorkflowEntry,
    snapshot,
    expected: initialized.token,
    operationId: "milestone-workflow-register",
  });
  const workflow = created.data.workflows[0];
  if (!workflow) throw new Error("milestone fixture workflow registration failed");
  const bound = await bindExecutionSession({ harnessDir: harness, caller }, {
    workflowId, expected: workflow.workflowToken, operationId: "milestone-session-bind",
  });
  sessionRef = encodeExecutionSessionRef(bound.data);
  writeFileSync(join(root, "old-session-envelope.json"), JSON.stringify({ version: 1, role: "coordinator", workflow_id: workflowId, session_id: "milestone-coordinator" }));
  for (const id of [projectId, "other-project"]) db.prepare("insert into catalog_entities(kind,id,title,root_kind,relative_path,registered_at,updated_at) values('project',?,?,'projects',?,'now','now')").run(id, id, `${id}/roadmap.md`);
  makeIssue("milestone-assignment-issue");
  makeIssue("milestone-membership-issue");
});
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe("issue milestone association", () => {
  test("summary and detail expose nullable milestone membership", async () => {
    expect((await listIssues(context, { projectId })).items[0]?.milestoneId).toBeNull();
    expect((await getIssue(context, "milestone-assignment-issue")).milestoneId).toBeNull();
  });
  test("successful assignment uses an engine-issued live session and advances both revisions once", async () => {
    const made = await addMilestone(context, { projectId, name: `Milestone ${++issueNumber}`, target: null, ordinal: issueNumber }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    milestoneId = made.milestoneId;
    const before = revision();
    const receipt = await assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId, reason: "roadmap" }, mutation("milestone-assign", 1));
    expect(receipt).toMatchObject({ issueId: "milestone-assignment-issue", revision: 2, storeRevision: before + 1, created: false });
    expect((await getIssue(context, receipt.issueId)).milestoneId).toBe(milestoneId);
    expect((await listIssues(context, { projectId })).items.find((issue) => issue.id === receipt.issueId)?.milestoneId).toBe(milestoneId);
  });
  test("wrong actor or session refuses without mutation", async () => {
    const before = revision();
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId: null, reason: "clear" }, mutation("milestone-wrong-actor", 2, before, "qa-engineer"))).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId: null, reason: "clear" }, mutation("milestone-stale-envelope", 2, before, "project-manager", join(root, "old-session-envelope.json")))).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId: null, reason: "clear" }, mutation("milestone-stale-envelope-recovery", 2, before, "project-manager", join(root, "old-session-envelope.json")))).rejects.toThrow("--session-ref");
    expect(revision()).toBe(before);
    expect(issueRevision("milestone-assignment-issue")).toBe(2);
  });
  test("issue and store CAS refuse stale writes; exact replay preserves the original receipt", async () => {
    const before = revision();
    const req = { projectId, milestoneId: null, reason: "clear" };
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", req, mutation("milestone-stale-issue", 1, before))).rejects.toMatchObject({ code: "issue.revision-conflict" });
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", req, mutation("milestone-stale-store", 2, before - 1))).rejects.toMatchObject({ code: "milestone.revision-conflict" });
    const request = mutation("milestone-clear-replay", 2, before);
    const first = await assignIssueMilestone(context, "milestone-assignment-issue", req, request);
    expect(await assignIssueMilestone(context, "milestone-assignment-issue", req, request)).toEqual(first);
    expect(first).toMatchObject({ revision: 3, storeRevision: before + 1 });
    expect(revision()).toBe(before + 1);
  });
  test("rejects milestone from another project", async () => {
    const other = await addMilestone(context, { projectId: "other-project", name: "Other project milestone", target: null, ordinal: 0 }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId: other.milestoneId, reason: "wrong project" }, mutation("milestone-cross-project", 3))).rejects.toMatchObject({ code: "milestone.project-mismatch" });
  });
  test("invalid input and absent milestones use distinct refusal codes", async () => {
    const req = { projectId, milestoneId: null as string | null, reason: "valid" };
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { ...req, projectId: " " }, mutation("milestone-invalid-project", 3))).rejects.toMatchObject({ code: "milestone.invalid-input" });
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { ...req, reason: " " }, mutation("milestone-invalid-reason", 3))).rejects.toMatchObject({ code: "milestone.invalid-input" });
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { ...req, milestoneId: " " }, mutation("milestone-invalid-id", 3))).rejects.toMatchObject({ code: "milestone.invalid-input" });
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { ...req, milestoneId: "missing-milestone" }, mutation("milestone-not-found", 3))).rejects.toMatchObject({ code: "milestone.not-found" });
  });
  test("supports explicit move and clear", async () => {
    const another = await addMilestone(context, { projectId, name: `Move target ${++issueNumber}`, target: null, ordinal: issueNumber }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    otherMilestoneId = another.milestoneId;
    const moved = await assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId: otherMilestoneId, reason: "reassign" }, mutation("milestone-move", 3));
    expect(moved.revision).toBe(4);
    expect((await getIssue(context, moved.issueId)).milestoneId).toBe(otherMilestoneId);
    const cleared = await assignIssueMilestone(context, moved.issueId, { projectId, milestoneId: null, reason: "unassign" }, mutation("milestone-clear", 4));
    expect(cleared.revision).toBe(5);
    expect((await getIssue(context, moved.issueId)).milestoneId).toBeNull();
  });
  test("delivered and dropped milestones refuse assignments", async () => {
    const delivered = await addMilestone(context, { projectId, name: "Terminal delivered", target: null, ordinal: ++issueNumber }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    makeIssue("milestone-terminal-closed");
    const seated = await assignIssueMilestone(context, "milestone-terminal-closed", { projectId, milestoneId: delivered.milestoneId, reason: "prepare delivery" }, mutation("milestone-terminal-prepare", 1));
    await closeIssue(context, seated.issueId, "resolved", { reason: "done", references: ["test"], alignmentRef: "PM acceptance" }, { actor: "project-manager", operationId: "milestone-terminal-close", expectedRevision: seated.revision });
    await updateMilestone(context, projectId, delivered.milestoneId, { status: "active" }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    await updateMilestone(context, projectId, delivered.milestoneId, { status: "delivered" }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId: delivered.milestoneId, reason: "delivered" }, mutation("milestone-terminal-delivered", issueRevision("milestone-assignment-issue")))).rejects.toMatchObject({ code: "milestone.terminal" });
    const dropped = await addMilestone(context, { projectId, name: "Terminal dropped", target: null, ordinal: ++issueNumber }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    await updateMilestone(context, projectId, dropped.milestoneId, { status: "dropped" }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId: dropped.milestoneId, reason: "dropped" }, mutation("milestone-terminal-dropped", issueRevision("milestone-assignment-issue")))).rejects.toMatchObject({ code: "milestone.terminal" });
    const source = await addMilestone(context, { projectId, name: "Terminal source", target: null, ordinal: ++issueNumber }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    makeIssue("milestone-terminal-source-issue");
    const sourceAssigned = await assignIssueMilestone(context, "milestone-terminal-source-issue", { projectId, milestoneId: source.milestoneId, reason: "source guard" }, mutation("milestone-terminal-source-assign", 1));
    await updateMilestone(context, projectId, source.milestoneId, { status: "dropped" }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    await expect(assignIssueMilestone(context, sourceAssigned.issueId, { projectId, milestoneId: null, reason: "clear terminal source" }, mutation("milestone-terminal-source-clear", sourceAssigned.revision))).rejects.toMatchObject({ code: "milestone.terminal" });
  });
  test("failed assignment rolls back issue and store revisions", async () => {
    const before = revision();
    const issueBefore = issueRevision("milestone-assignment-issue");
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { projectId: "missing", milestoneId: null, reason: "fail" }, mutation("milestone-rollback", issueBefore, before))).rejects.toBeInstanceOf(IssueError);
    expect(revision()).toBe(before);
    expect(issueRevision("milestone-assignment-issue")).toBe(issueBefore);
  });
  test("capture and close paths preserve existing milestone membership", async () => {
    const made = await addMilestone(context, { projectId, name: `Membership ${++issueNumber}`, target: null, ordinal: issueNumber }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    const assigned = await assignIssueMilestone(context, "milestone-membership-issue", { projectId, milestoneId: made.milestoneId, reason: "associate" }, mutation("milestone-membership-assign", 1));
    const capture = await captureIssue(context, { projectId, title: "Captured", kind: "bug", severity: "low", impact: "impact", acceptance: "acceptance", sourceIdentity: "milestone", rootCauseKey: "capture", acceptanceKey: "capture", occurrenceKey: "milestone-capture", sourceKind: "test", location: "test", observedBehavior: "observed", evidence: [], discoveredAt: "2026-09-29T00:00:00Z" }, { actor: "project-manager", operationId: "milestone-capture-op" });
    expect((await getIssue(context, assigned.issueId)).milestoneId).toBe(made.milestoneId);
    const closed = await closeIssue(context, assigned.issueId, "resolved", { reason: "done", references: ["test"], alignmentRef: "PM acceptance" }, { actor: "project-manager", operationId: "milestone-close", expectedRevision: assigned.revision });
    expect(capture.created).toBe(true);
    expect(closed.revision).toBe(assigned.revision + 1);
    expect((await getIssue(context, assigned.issueId)).milestoneId).toBe(made.milestoneId);
  });
});

test("schema-4 stores list issues while provenance detail requires explicit upgrade", async () => {
  const oldHarness = join(mkdtempSync(join(tmpdir(), "issue-schema-4-")), ".mstar");
  mkdirSync(oldHarness, { recursive: true });
  const raw = new DatabaseSync(storeDbPath({ harnessDir: oldHarness }));
  raw.exec(SCHEMA_VERSION_TABLE_SQL);
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 4)) {
    raw.exec(migration.sql);
    raw.prepare("insert into schema_version(version,name,checksum,applied_at) values(?,?,?,?)")
      .run(migration.version, migration.name, migrationChecksum(migration), "2026-09-29T00:00:00Z");
  }
  raw.prepare("update store_meta set authority_state='active' where id=1").run();
  raw.prepare("insert into issues(id,project_id,title,kind,severity,impact,acceptance,created_at,updated_at,identity_key) values('old-issue','old-project','Old issue','bug','high','impact','acceptance','now','now','old-issue')").run();
  raw.close();
  const oldContext: StoreContext = { harnessDir: oldHarness };
  expect((await listIssues(oldContext, { projectId: "old-project" })).items[0]?.milestoneId).toBeNull();
  await expect(getIssue(oldContext, "old-issue")).rejects.toMatchObject({ code: "issue.schema-outdated" });
  expect(await withStoreRead(oldContext, queryDashboard("issues"))).toMatchObject({ data: { total: 1 } });
  await expect(
    withStoreRead(oldContext, queryDashboard("issue-detail", { id: "old-issue" })),
  ).rejects.toMatchObject({ code: "issue.schema-outdated" });
  await upgradeStore(oldContext);
  expect((await getIssue(oldContext, "old-issue")).milestoneId).toBeNull();
  expect(
    await withStoreRead(oldContext, queryDashboard("issue-detail", { id: "old-issue" })),
  ).toMatchObject({ data: { id: "old-issue", milestoneId: null } });
  rmSync(oldHarness, { recursive: true, force: true });
});
