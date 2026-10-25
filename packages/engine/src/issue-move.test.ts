import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOccurrence, captureIssue, computeIdentityKey, getIssue, IssueError, moveIssue, type CaptureInput, type IssueReceipt } from "./issue.js";
import { addMilestone } from "./milestone-store.js";
import { initializeStore, type StoreContext, type StoreDb } from "./store-db.js";

const root = mkdtempSync(join(tmpdir(), "issue-move-"));
const context: StoreContext = { harnessDir: join(root, ".mstar") };
const projectA = "move-project-a";
const projectB = "move-project-b";
const triple = { sourceIdentity: "review/move", rootCauseKey: "root-move", acceptanceKey: "accept-move" };
let db: StoreDb;
let movedIssue: IssueReceipt;
let missingTargetIssue: IssueReceipt;
let collidingIssue: IssueReceipt;
let collisionCandidate: IssueReceipt;
let casIssue: IssueReceipt;

function capture(projectId: string, occurrenceKey: string, keys = triple): CaptureInput {
  return {
    projectId,
    title: "Finding",
    kind: "bug",
    severity: "high",
    impact: "impact",
    acceptance: "acceptance",
    ...keys,
    occurrenceKey,
    sourceKind: "test",
    location: "src/example.ts",
    observedBehavior: "fails",
    evidence: ["repro"],
    discoveredAt: "2026-10-25T00:00:00Z",
  };
}
function revision(): number {
  return (db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision;
}
function issueRow(id: string): { project_id: string; identity_key: string; milestone_id: string | null; revision: number } {
  return db.prepare("select project_id, identity_key, milestone_id, revision from issues where id = ?").get(id) as {
    project_id: string;
    identity_key: string;
    milestone_id: string | null;
    revision: number;
  };
}
function operation(operationId: string): unknown {
  return db.prepare("select 1 from store_operations where operation_id = ?").get(operationId);
}

beforeAll(async () => {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  mkdirSync(context.harnessDir, { recursive: true });
  db = (await initializeStore(context)).db;
  for (const id of [projectA, projectB]) {
    db.prepare(
      "insert into catalog_entities(kind,id,title,root_kind,relative_path,registered_at,updated_at) values('project',?,?,'projects',?,'now','now')",
    ).run(id, id, `${id}/roadmap.md`);
  }
  movedIssue = await captureIssue(context, capture(projectA, "occ-moved"), { actor: "project-manager", operationId: "capture-moved" });
  const milestone = await addMilestone(
    context,
    { projectId: projectA, name: "Milestone A", target: null, ordinal: 0 },
    { operationId: "milestone-a", expectedStoreRevision: revision() },
  );
  db.prepare("update issues set milestone_id = ? where id = ?").run(milestone.milestoneId, movedIssue.issueId);
  missingTargetIssue = await captureIssue(context, capture(projectA, "occ-missing-target", { sourceIdentity: "review/missing", rootCauseKey: "root-missing", acceptanceKey: "accept-missing" }), { actor: "project-manager", operationId: "capture-missing-target" });
  collidingIssue = await captureIssue(context, capture(projectB, "occ-collide-b", { sourceIdentity: "review/collide", rootCauseKey: "root-collide", acceptanceKey: "accept-collide" }), { actor: "project-manager", operationId: "capture-collide-b" });
  collisionCandidate = await captureIssue(context, capture(projectA, "occ-collide-a", { sourceIdentity: "review/collide", rootCauseKey: "root-collide", acceptanceKey: "accept-collide" }), { actor: "project-manager", operationId: "capture-collide-a" });
  casIssue = await captureIssue(context, capture(projectA, "occ-cas", { sourceIdentity: "review/cas", rootCauseKey: "root-cas", acceptanceKey: "accept-cas" }), { actor: "project-manager", operationId: "capture-cas" });
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("issue project move", () => {
  test("moves the issue, recomputes its identity and clears its milestone", async () => {
    const before = revision();
    const receipt = await moveIssue(
      context,
      movedIssue.issueId,
      { projectId: projectB, reason: "finding belongs to the other project" },
      { actor: "project-manager", operationId: "move-succeeds", expectedRevision: movedIssue.revision },
    );
    expect(receipt).toEqual({ issueId: movedIssue.issueId, revision: 2, storeRevision: before + 1, created: false });
    expect(revision()).toBe(before + 1);
    expect(issueRow(movedIssue.issueId)).toEqual({
      project_id: projectB,
      identity_key: computeIdentityKey(projectB, triple.sourceIdentity, triple.rootCauseKey, triple.acceptanceKey),
      milestone_id: null,
      revision: 2,
    });
    const detail = await getIssue(context, movedIssue.issueId);
    expect(detail.projectId).toBe(projectB);
    expect(detail.milestoneId).toBeNull();
    expect(detail.identityKey).toBe(computeIdentityKey(projectB, triple.sourceIdentity, triple.rootCauseKey, triple.acceptanceKey));
  });

  test("refuses an unregistered target project and writes nothing", async () => {
    const before = revision();
    await expect(
      moveIssue(
        context,
        missingTargetIssue.issueId,
        { projectId: "project-absent", reason: "typo" },
        { actor: "project-manager", operationId: "move-missing-project", expectedRevision: missingTargetIssue.revision },
      ),
    ).rejects.toMatchObject({ code: "issue.not-found", details: { projectId: "project-absent" } });
    expect(issueRow(missingTargetIssue.issueId).project_id).toBe(projectA);
    expect(issueRow(missingTargetIssue.issueId).revision).toBe(missingTargetIssue.revision);
    expect(revision()).toBe(before);
    expect(operation("move-missing-project")).toBeUndefined();
    await expect(
      moveIssue(
        context,
        "I-999999",
        { projectId: projectB, reason: "unknown issue" },
        { actor: "project-manager", operationId: "move-unknown-issue", expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "issue.not-found" });
    await expect(
      moveIssue(
        context,
        missingTargetIssue.issueId,
        { projectId: projectB, reason: "wrong seat" },
        { actor: "qa-engineer", operationId: "move-wrong-seat", expectedRevision: missingTargetIssue.revision },
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
  });

  test("refuses an identity the target project already holds and names the other issue", async () => {
    const before = revision();
    const error = await moveIssue(
      context,
      collisionCandidate.issueId,
      { projectId: projectB, reason: "would duplicate an existing finding" },
      { actor: "project-manager", operationId: "move-collision", expectedRevision: collisionCandidate.revision },
    ).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueError);
    expect(error).toMatchObject({ code: "issue.ambiguous-identity", details: { collidingIssueId: collidingIssue.issueId } });
    expect(error instanceof Error ? error.message : "").toContain(collidingIssue.issueId);
    expect(issueRow(collisionCandidate.issueId).project_id).toBe(projectA);
    expect(issueRow(collisionCandidate.issueId).revision).toBe(collisionCandidate.revision);
    expect(issueRow(collisionCandidate.issueId).identity_key).toBe(
      computeIdentityKey(projectA, "review/collide", "root-collide", "accept-collide"),
    );
    expect(revision()).toBe(before);
    expect(operation("move-collision")).toBeUndefined();
  });

  test("requires the caller's issue revision and replays an exact operation", async () => {
    const request = { projectId: projectB, reason: "revision cas" };
    await expect(
      moveIssue(context, casIssue.issueId, request, { actor: "project-manager", operationId: "move-no-revision" }),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    await expect(
      moveIssue(context, casIssue.issueId, request, { actor: "project-manager", operationId: "move-stale-revision", expectedRevision: 7 }),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    expect(issueRow(casIssue.issueId).project_id).toBe(projectA);

    const operationId = "move-cas";
    const mutation = { actor: "project-manager", operationId, expectedRevision: casIssue.revision };
    const first = await moveIssue(context, casIssue.issueId, request, mutation);
    expect(first.revision).toBe(casIssue.revision + 1);
    expect(await moveIssue(context, casIssue.issueId, request, mutation)).toEqual(first);
    await expect(
      moveIssue(context, casIssue.issueId, { projectId: projectB, reason: "different request" }, mutation),
    ).rejects.toMatchObject({ code: "store.operation-conflict" });
  });

  test("treats a move to the issue's current project as a recorded no-op", async () => {
    const before = revision();
    const mutation = { actor: "project-manager", operationId: "move-noop", expectedRevision: 2 };
    const receipt = await moveIssue(context, movedIssue.issueId, { projectId: projectB, reason: "already there" }, mutation);
    expect(receipt).toEqual({ issueId: movedIssue.issueId, revision: 2, storeRevision: before, created: false });
    expect(await moveIssue(context, movedIssue.issueId, { projectId: projectB, reason: "already there" }, mutation)).toEqual(receipt);
    expect(issueRow(movedIssue.issueId).revision).toBe(2);
    expect(revision()).toBe(before);
    expect(operation("move-noop")).toBeDefined();
  });

  test("accepts a recurrence under the identity the move installed", async () => {
    const receipt = await appendOccurrence(
      context,
      movedIssue.issueId,
      { ...triple, occurrenceKey: "occ-moved-followup", sourceKind: "test", location: "src/example.ts", observedBehavior: "again", evidence: [], discoveredAt: "2026-10-25T00:00:01Z" },
      { actor: "project-manager", operationId: "occurrence-after-move" },
    );
    expect(receipt).toMatchObject({ issueId: movedIssue.issueId, revision: 3 });
    expect(issueRow(movedIssue.issueId).identity_key).toBe(
      computeIdentityKey(projectB, triple.sourceIdentity, triple.rootCauseKey, triple.acceptanceKey),
    );
  });

  test("the pre-move identity no longer resolves to the moved issue", async () => {
    const oldIdentity = computeIdentityKey(projectA, triple.sourceIdentity, triple.rootCauseKey, triple.acceptanceKey);
    expect(db.prepare("select id from issues where identity_key = ?").get(oldIdentity)).toBeUndefined();
    const recaptured = await captureIssue(context, capture(projectA, "occ-original-project"), {
      actor: "project-manager",
      operationId: "capture-original-project",
    });
    expect(recaptured.created).toBe(true);
    expect(recaptured.issueId).not.toBe(movedIssue.issueId);
  });
});
