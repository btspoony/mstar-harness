import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { join } from "node:path";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore } from "./collaboration-store.js";
import { assignIssueMilestone, closeIssue, getIssue, IssueError, listIssues, captureIssue } from "./issue.js";
import { addMilestone, removeMilestone, readMilestonesOn as readMilestonesOnDb, updateMilestone } from "./milestone-store.js";
import type { StoreContext, StoreDb } from "./store-db.js";

const root = mkdtempSync(join(nodeOs.tmpdir(), "tmp-issue-milestone-"));
const HOME = join(root, "home");
mkdirSync(HOME);
let homeSpy: { mockRestore(): void } | undefined;
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/issue-milestone.git"], { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
writeFileSync(join(repo, ".mstarc"), "[collaboration]\nmode=local\n");
const harness = join(repo, ".mstar");
const context: StoreContext = { harnessDir: harness };
const projectId = "milestone-assignment-project";
let db: StoreDb;
let issueNumber = 0;
function makeIssue(id: string, project = projectId): void {
  db.prepare("insert into issues(id,project_id,title,kind,severity,impact,acceptance,created_at,updated_at,identity_key) values(?,?,'Issue','bug','high','impact','acceptance','now','now',?)").run(id, project, id);
}
function revision(): number {
  const row = db.prepare("select revision from collaboration_meta where id=1").get() as { revision: number };
  return row.revision;
}
function issueRevision(id: string): number {
  const row = db.prepare("select revision from issues where id=?").get(id) as { revision: number };
  return row.revision;
}
function mutation(id: string, expectedRevision: number, expectedStoreRevision = revision(), actor = "project-manager") {
  return { operationId: id, actor, expectedRevision, expectedStoreRevision };
}
let milestoneId = "";
let otherMilestoneId = "";
beforeAll(async () => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
  mkdirSync(harness, { recursive: true });
  await initializeCollaborationStore(resolveCollaborationLocation(context));
  const dbPath = resolveCollaborationLocation(context).dbPath;
  const seeded = new DatabaseSync(dbPath);
  seeded.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(new Date().toISOString());
  seeded.close();
  db = new DatabaseSync(dbPath);
  for (const id of [projectId, "other-project"]) db.prepare("insert into catalog_entities(kind,id,title,root_kind,relative_path,registered_at,updated_at) values('project',?,?,'projects',?,'now','now')").run(id, id, `${id}/roadmap.md`);
  makeIssue("milestone-assignment-issue");
  makeIssue("milestone-membership-issue");
});
afterAll(() => { db.close(); homeSpy?.mockRestore(); rmSync(root, { recursive: true, force: true }); });

describe("issue milestone association", () => {
  test("summary and detail expose nullable milestone membership", async () => {
    expect((await listIssues(context, { projectId })).items[0]?.milestoneId).toBeNull();
    expect((await getIssue(context, "milestone-assignment-issue")).milestoneId).toBeNull();
  });
  test("successful assignment authorizes by the project-manager seat and advances both revisions once", async () => {
    const made = await addMilestone(context, { projectId, name: `Milestone ${++issueNumber}`, target: null, ordinal: issueNumber }, { operationId: crypto.randomUUID(), expectedStoreRevision: revision() });
    milestoneId = made.milestoneId;
    const before = revision();
    const receipt = await assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId, reason: "roadmap" }, mutation("milestone-assign", 1));
    expect(receipt).toMatchObject({ issueId: "milestone-assignment-issue", revision: 2, storeRevision: before + 1, created: false });
    expect((await getIssue(context, receipt.issueId)).milestoneId).toBe(milestoneId);
    expect((await listIssues(context, { projectId })).items.find((issue) => issue.id === receipt.issueId)?.milestoneId).toBe(milestoneId);
  });
  test("a non-project-manager actor is refused before payload validation and mutates nothing", async () => {
    const before = revision();
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { projectId, milestoneId: null, reason: "clear" }, mutation("milestone-wrong-actor", 2, before, "fullstack-dev"))).rejects.toMatchObject({ code: "issue.scope-refused" });
    // The seat refusal precedes every payload check a blank request would fail.
    await expect(assignIssueMilestone(context, "milestone-assignment-issue", { projectId: " ", milestoneId: " ", reason: " " }, mutation("milestone-seat-precedence", 2, before, "fullstack-dev"))).rejects.toMatchObject({ code: "issue.scope-refused" });
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

describe("removeMilestone", () => {
  test("removes an empty milestone and refuses a milestone that still holds issues", async () => {
    const empty = await addMilestone(context, { projectId, name: "Removable", target: null, ordinal: 90 }, { operationId: "remove-empty-add", expectedStoreRevision: revision() });
    // The replay identity covers the caller's revision expectation, so the
    // retry re-presents the revision its first attempt was judged against.
    const removalRevision = revision();
    const receipt = await removeMilestone(context, projectId, empty.milestoneId, { operationId: "remove-empty", expectedStoreRevision: removalRevision });
    expect(receipt).toMatchObject({ projectId, milestoneId: empty.milestoneId, changed: true });
    // Idempotent replay through the shared operation ledger.
    expect(await removeMilestone(context, projectId, empty.milestoneId, { operationId: "remove-empty", expectedStoreRevision: removalRevision })).toEqual(receipt);

    const held = await addMilestone(context, { projectId, name: "Holding", target: null, ordinal: 91 }, { operationId: "remove-held-add", expectedStoreRevision: revision() });
    await assignIssueMilestone(
      context,
      "milestone-assignment-issue",
      { projectId, milestoneId: held.milestoneId, reason: "fixture" },
      mutation("remove-held-assign", issueRevision("milestone-assignment-issue")),
    );
    // The one hard stop, with its recovery named: reassign or clear first.
    await expect(
      removeMilestone(context, projectId, held.milestoneId, { operationId: "remove-held", expectedStoreRevision: revision() }),
    ).rejects.toMatchObject({ code: "milestone.not-empty" });

    // A milestone carrying only RETIRED issues is still not empty: the refusal
    // counts every row and says so instead of reporting "open issues".
    const assigned = await getIssue(context, "milestone-assignment-issue");
    await closeIssue(
      context,
      "milestone-assignment-issue",
      "resolved",
      { reason: "settled for the removal fixture", references: ["issue-milestone.test.ts"], alignmentRef: "PM acceptance" },
      { actor: "project-manager", operationId: "remove-held-close", expectedRevision: assigned.revision },
    );
    const retiredRefusal = await removeMilestone(context, projectId, held.milestoneId, {
      operationId: "remove-held-retired",
      expectedStoreRevision: revision(),
    }).catch((error: unknown) => error);
    expect(retiredRefusal).toMatchObject({ code: "milestone.not-empty" });
    expect((retiredRefusal as Error).message).toContain("settled");
    expect((retiredRefusal as Error).message).toContain("mstar milestone assign");
  });

  test("a stale expectedStoreRevision removal is refused and removes nothing", async () => {
    const milestone = await addMilestone(context, { projectId, name: "Stale guard", target: null, ordinal: 92 }, { operationId: "remove-stale-add", expectedStoreRevision: revision() });
    const current = revision();
    await expect(
      removeMilestone(context, projectId, milestone.milestoneId, { operationId: "remove-stale", expectedStoreRevision: current - 1 }),
    ).rejects.toMatchObject({ code: "milestone.revision-conflict" });
    // Nothing moved: the milestone and the store revision survive the refusal.
    expect(readMilestonesOnDb(db, projectId).milestones.some((entry) => entry.milestoneId === milestone.milestoneId)).toBe(true);
    expect(revision()).toBe(current);
  });
});
