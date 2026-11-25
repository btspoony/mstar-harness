import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collaborationLocationOfRepoKey, resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, readCollaborationStage, writeCollaborationStage } from "./collaboration-store.js";
import { appendOccurrence, captureIssue, computeIdentityKey, getIssue, IssueError, moveIssue, type CaptureInput, type IssueReceipt } from "./issue.js";
import { registerCatalogEntity } from "./catalog.js";
import { addMilestone, updateMilestone } from "./milestone-store.js";
import { ensureCollaborationAuthority } from "./store-activation.js";
import { historicalStore } from "./store-migration-fixtures.js";
import { initializeStore, MIGRATIONS, openStore, upgradeStore, type StoreContext, type StoreDb } from "./store-db.js";

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
let assignedMilestoneId = "";

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
  const lane = new DatabaseSync(resolveCollaborationLocation(context).dbPath);
  try {
    return (lane.prepare("select revision from collaboration_meta where id = 1").get() as { revision: number }).revision;
  } finally {
    lane.close();
  }
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
  return db.prepare("select 1 from collaboration_operations where operation_id = ?").get(operationId);
}
/** note: One record's stable reference, the value a move carries to the destination unchanged. */
function carriedRef(issueId: string): string {
  const row = db.prepare("select issue_ref from issues where id = ?").get(issueId);
  if (row === null || typeof row !== "object") throw new Error(`${issueId} returned no row`);
  const value = (row as Record<string, unknown>).issue_ref;
  if (typeof value !== "string") throw new Error(`${issueId} carries no issue_ref`);
  return value;
}
/**
 * invariant: A destination lane is user-level, so this file's fixtures must never reach the
 * operator's `~/.mstar`: one spy serves the whole file, installed before the first lane exists.
 */
const HOME = join(root, "user-home");
let homeSpy: { mockRestore(): void } | undefined;
beforeAll(async () => {
  mkdirSync(HOME, { recursive: true });
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  writeFileSync(
    join(root, ".mstarc"),
    `[collaboration]\nmode=local\nrepo_id=fixture-${root.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(-110)}\n`,
  );
  mkdirSync(context.harnessDir, { recursive: true });
  (await initializeStore(context)).close();
  await ensureCollaborationAuthority(context);
  db = new DatabaseSync(resolveCollaborationLocation(context).dbPath) as unknown as StoreDb;
  for (const id of [projectA, projectB]) {
    await registerCatalogEntity(
      context,
      { kind: "project", id, title: id, rootKind: "projects", relativePath: `${id}/roadmap.md` },
      { operationId: `register-${id}`, actor: "issue-move.test" },
    );
  }
  movedIssue = await captureIssue(context, capture(projectA, "occ-moved"), { actor: "project-manager", operationId: "capture-moved" });
  const milestone = await addMilestone(
    context,
    { projectId: projectA, name: "Milestone A", effortSessions: null, ordinal: 0 },
    { operationId: "milestone-a", expectedStoreRevision: revision() },
  );
  db.prepare("update issues set milestone_id = ? where id = ?").run(milestone.milestoneId, movedIssue.issueId);
  assignedMilestoneId = milestone.milestoneId;
  missingTargetIssue = await captureIssue(context, capture(projectA, "occ-missing-target", { sourceIdentity: "review/missing", rootCauseKey: "root-missing", acceptanceKey: "accept-missing" }), { actor: "project-manager", operationId: "capture-missing-target" });
  collidingIssue = await captureIssue(context, capture(projectB, "occ-collide-b", { sourceIdentity: "review/collide", rootCauseKey: "root-collide", acceptanceKey: "accept-collide" }), { actor: "project-manager", operationId: "capture-collide-b" });
  collisionCandidate = await captureIssue(context, capture(projectA, "occ-collide-a", { sourceIdentity: "review/collide", rootCauseKey: "root-collide", acceptanceKey: "accept-collide" }), { actor: "project-manager", operationId: "capture-collide-a" });
  casIssue = await captureIssue(context, capture(projectA, "occ-cas", { sourceIdentity: "review/cas", rootCauseKey: "root-cas", acceptanceKey: "accept-cas" }), { actor: "project-manager", operationId: "capture-cas" });
});
afterAll(() => {
  db.close();
  homeSpy?.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe("issue project move", () => {
  test("moves the issue, recomputes its identity and clears its milestone", async () => {
    const before = revision();
    const receipt = await moveIssue(
      context,
      movedIssue.issueId,
      { projectId: projectB, reason: "finding belongs to the other project" },
      { actor: "project-manager", operationId: "move-succeeds", expectedRevision: movedIssue.revision, expectedStoreRevision: before },
    );
    expect(receipt).toEqual({
      issueId: movedIssue.issueId,
      revision: 2,
      storeRevision: before + 1,
      created: false,
      fromProject: projectA,
      toProject: projectB,
      clearedMilestoneId: assignedMilestoneId,
    });
    expect(revision()).toBe(before + 1);
    const storedReceipt = db
      .prepare("select result_json from collaboration_operations where operation_id = ?")
      .get("move-succeeds") as { result_json: string };
    expect(JSON.parse(storedReceipt.result_json)).toMatchObject({
      issueId: movedIssue.issueId,
      fromProject: projectA,
      toProject: projectB,
      clearedMilestoneId: assignedMilestoneId,
    });
    const moves = db
      .prepare(
        "select issue_id, from_project_id, to_project_id, actor, reason, occurred_at, recorded_at, issue_revision from issue_project_moves where issue_id = ? order by id",
      )
      .all(movedIssue.issueId) as Array<{
      issue_id: string;
      from_project_id: string;
      to_project_id: string;
      actor: string;
      reason: string;
      occurred_at: string;
      recorded_at: string;
      issue_revision: number;
    }>;
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      issue_id: movedIssue.issueId,
      from_project_id: projectA,
      to_project_id: projectB,
      actor: "project-manager",
      reason: "finding belongs to the other project",
      issue_revision: 2,
    });
    expect(moves[0]?.occurred_at).toBe(moves[0]?.recorded_at);
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
    expect(detail.projectMoves).toEqual([{
      fromProject: projectA,
      toProject: projectB,
      actor: "project-manager",
      reason: "finding belongs to the other project",
      occurredAt: moves[0]?.occurred_at,
      issueRevision: 2,
    }]);
  });

  test("refuses a stale store revision without writing anything", async () => {
    const before = revision();
    await expect(
      moveIssue(
        context,
        missingTargetIssue.issueId,
        { projectId: projectB, reason: "stale store view" },
        {
          actor: "project-manager",
          operationId: "move-stale-store",
          expectedRevision: missingTargetIssue.revision,
          expectedStoreRevision: before - 1,
        },
      ),
    ).rejects.toMatchObject({ code: "milestone.revision-conflict", details: { expectedStoreRevision: before - 1 } });
    expect(issueRow(missingTargetIssue.issueId).project_id).toBe(projectA);
    expect(revision()).toBe(before);
    expect(operation("move-stale-store")).toBeUndefined();
  });

  test("refuses an unregistered target project and writes nothing", async () => {
    const before = revision();
    await expect(
      moveIssue(
        context,
        missingTargetIssue.issueId,
        { projectId: "project-absent", reason: "typo" },
        {
          actor: "project-manager",
          operationId: "move-missing-project",
          expectedRevision: missingTargetIssue.revision,
          expectedStoreRevision: before,
        },
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
        { actor: "project-manager", operationId: "move-unknown-issue", expectedRevision: 1, expectedStoreRevision: before },
      ),
    ).rejects.toMatchObject({ code: "issue.not-found" });
    await expect(
      moveIssue(
        context,
        missingTargetIssue.issueId,
        { projectId: projectB, reason: "wrong seat" },
        { actor: "fullstack-dev", operationId: "move-wrong-seat", expectedRevision: missingTargetIssue.revision, expectedStoreRevision: before },
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
  });

  test("refuses an identity the target project already holds and names the other issue", async () => {
    const before = revision();
    const error = await moveIssue(
      context,
      collisionCandidate.issueId,
      { projectId: projectB, reason: "would duplicate an existing finding" },
      {
        actor: "project-manager",
        operationId: "move-collision",
        expectedRevision: collisionCandidate.revision,
        expectedStoreRevision: before,
      },
    ).then(() => undefined, (caught: unknown) => caught);
    if (!(error instanceof IssueError)) throw new Error(`expected an IssueError refusal, received ${String(error)}`);
    expect(error.code).toBe("issue.ambiguous-identity");
    expect(error.details.collidingIssueId).toBe(collidingIssue.issueId);
    expect(error.message).toContain(collidingIssue.issueId);
    // Assert the recovery text as one string: Bun's `toMatchObject` writes a
    // nested asymmetric matcher back into the received object, so repeated
    // matcher assertions against `details` would corrupt the value under test.
    const recovery = String(error.details.recovery);
    expect(recovery).toContain(`mstar issue supersede --id ${collisionCandidate.issueId}`);
    expect(recovery).toContain(`"canonicalIssueId":"${collidingIssue.issueId}"`);
    expect(recovery).not.toContain(`mstar issue duplicate --id ${collidingIssue.issueId}`);
    expect(issueRow(collisionCandidate.issueId).project_id).toBe(projectA);
    expect(issueRow(collisionCandidate.issueId).revision).toBe(collisionCandidate.revision);
    expect(issueRow(collisionCandidate.issueId).identity_key).toBe(
      computeIdentityKey(projectA, "review/collide", "root-collide", "accept-collide"),
    );
    expect(revision()).toBe(before);
    expect(operation("move-collision")).toBeUndefined();
  });

  test("requires the caller's issue revision and replays an exact operation", async () => {
    const before = revision();
    const request = { projectId: projectB, reason: "revision cas" };
    await expect(
      moveIssue(context, casIssue.issueId, request, { actor: "project-manager", operationId: "move-no-revision", expectedStoreRevision: before }),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    await expect(
      moveIssue(context, casIssue.issueId, request, { actor: "project-manager", operationId: "move-stale-revision", expectedRevision: 7, expectedStoreRevision: before }),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    expect(issueRow(casIssue.issueId).project_id).toBe(projectA);

    const operationId = "move-cas";
    const mutation = { actor: "project-manager", operationId, expectedRevision: casIssue.revision, expectedStoreRevision: before };
    const first = await moveIssue(context, casIssue.issueId, request, mutation);
    expect(first.revision).toBe(casIssue.revision + 1);
    expect(await moveIssue(context, casIssue.issueId, request, mutation)).toEqual(first);
    await expect(
      moveIssue(context, casIssue.issueId, { projectId: projectB, reason: "different request" }, mutation),
    ).rejects.toMatchObject({ code: "store.operation-conflict" });
  });

  test("treats a move to the issue's current project as a recorded no-op", async () => {
    const before = revision();
    const mutation = { actor: "project-manager", operationId: "move-noop", expectedRevision: 2, expectedStoreRevision: before };
    const receipt = await moveIssue(context, movedIssue.issueId, { projectId: projectB, reason: "already there" }, mutation);
    // The operation record is a write, so the no-op advances the store revision
    // exactly once, the same way a composed caller receives its commit.
    expect(receipt).toEqual({
      issueId: movedIssue.issueId,
      revision: 2,
      storeRevision: before + 1,
      created: false,
      fromProject: projectB,
      toProject: projectB,
      clearedMilestoneId: null,
    });
    expect(await moveIssue(context, movedIssue.issueId, { projectId: projectB, reason: "already there" }, mutation)).toEqual(receipt);
    expect(issueRow(movedIssue.issueId).revision).toBe(2);
    expect(revision()).toBe(before + 1);
    expect(operation("move-noop")).toBeDefined();
    // The project never changed, so no history row is appended: the earlier
    // real move remains the only one.
    expect(db.prepare("select count(*) as n from issue_project_moves where issue_id = ?").get(movedIssue.issueId)).toEqual({ n: 1 });
  });

  test("a schema-12 store gains the empty project-move ledger on upgrade and keeps its issues", async () => {
    const legacy: StoreContext = { harnessDir: join(root, "v12-harness") };
    mkdirSync(legacy.harnessDir, { recursive: true });
    const legacyHandle = historicalStore(legacy.harnessDir, 12);
    legacyHandle.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key) " +
        "values('I-900001', 'legacy-project', 'Legacy finding', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'legacy-identity')",
    ).run();
    legacyHandle.close();

    expect(await upgradeStore(legacy)).toEqual({ schemaVersion: MIGRATIONS.length });
    const upgraded = await openStore(legacy, "read");
    try {
      expect(upgraded.schemaVersion).toBe(MIGRATIONS.length);
      expect(upgraded.db.prepare("select count(*) as n from issue_project_moves").get()).toEqual({ n: 0 });
      expect(upgraded.db.prepare("select id, project_id from issues order by id").all()).toEqual([
        { id: "I-900001", project_id: "legacy-project" },
      ]);
    } finally {
      upgraded.close();
    }
  });

  test("clears a dropped milestone even though its status blocks assignment", async () => {
    const issue = await captureIssue(
      context,
      capture(projectA, "occ-dropped", { sourceIdentity: "review/dropped", rootCauseKey: "root-dropped", acceptanceKey: "accept-dropped" }),
      { actor: "project-manager", operationId: "capture-dropped" },
    );
    const dropped = await addMilestone(
      context,
      { projectId: projectA, name: "Dropped milestone", effortSessions: null, ordinal: 9 },
      { operationId: "milestone-dropped", expectedStoreRevision: revision() },
    );
    await updateMilestone(
      context,
      projectA,
      dropped.milestoneId,
      { status: "dropped" },
      { operationId: "milestone-dropped-status", expectedStoreRevision: revision() },
    );
    db.prepare("update issues set milestone_id = ? where id = ?").run(dropped.milestoneId, issue.issueId);
    const before = revision();
    const receipt = await moveIssue(
      context,
      issue.issueId,
      { projectId: projectB, reason: "the finding outlived its milestone" },
      { actor: "project-manager", operationId: "move-dropped-milestone", expectedRevision: issue.revision, expectedStoreRevision: before },
    );
    expect(receipt.revision).toBe(issue.revision + 1);
    expect(receipt.clearedMilestoneId).toBe(dropped.milestoneId);
    const stored = db
      .prepare("select result_json from collaboration_operations where operation_id = ?")
      .get("move-dropped-milestone") as { result_json: string };
    expect(JSON.parse(stored.result_json)).toMatchObject({
      fromProject: projectA,
      toProject: projectB,
      clearedMilestoneId: dropped.milestoneId,
    });
    expect(issueRow(issue.issueId)).toMatchObject({ project_id: projectB, milestone_id: null });
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

describe("issue move --to-authority", () => {
  /** note: One ACTIVE destination lane of its own `repoKey`, holding the project the move names. */
  async function destinationLane(projectId: string, suffix = ""): Promise<string> {
    const repoKey = `github.com/acme/issue-move-dest-${projectId}${suffix}`;
    const location = collaborationLocationOfRepoKey(repoKey, "local");
    mkdirSync(join(location.dbPath, ".."), { recursive: true, mode: 0o700 });
    await initializeCollaborationStore(location);
    await writeCollaborationStage(location, ({ db: lane }) => {
      lane.prepare("update collaboration_meta set authority_state = 'active' where id = 1").run();
      lane.prepare(
        "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) " +
          "values ('project', ?, ?, 'projects', ?, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
      ).run(projectId, projectId, `projects/${projectId}`);
    });
    return repoKey;
  }

  test("the staged route carries the record to the destination authority and publishes once", async () => {
    const issue = await captureIssue(
      context,
      capture(projectA, "occ-staged", { sourceIdentity: "review/staged", rootCauseKey: "root-staged", acceptanceKey: "accept-staged" }),
      { actor: "project-manager", operationId: "capture-staged" },
    );
    const repoKey = await destinationLane("p-authority-dest");
    const mutation = {
      actor: "project-manager",
      operationId: "move-to-authority",
      expectedRevision: issue.revision,
      expectedStoreRevision: revision(),
    };
    const receipt = await moveIssue(context, issue.issueId, { projectId: "p-authority-dest", reason: "another authority", toAuthority: repoKey }, mutation);
    expect(receipt).toMatchObject({
      operationId: "move-to-authority",
      phase: "published",
      resumedFrom: null,
      destinationAuthority: repoKey,
      destinationProject: "p-authority-dest",
      destinationIssueId: "I-000001",
    });
    expect(receipt.issueRef).toMatch(/^mstar:issue:/);
    // invariant: The source record is deleted here and the destination holds the same reference.
    expect(db.prepare("select count(*) as n from issues where id = ?").get(issue.issueId)).toEqual({ n: 0 });
    const destination = collaborationLocationOfRepoKey(repoKey, "local");
    const landed = await readCollaborationStage(destination, ({ db: lane }) =>
      lane.prepare("select id, project_id, issue_ref from issues").all(),
    );
    expect(landed).toEqual([{ id: "I-000001", project_id: "p-authority-dest", issue_ref: receipt.issueRef }]);
    // invariant: The same command replays; it neither publishes twice nor mints a second record.
    expect(await moveIssue(context, issue.issueId, { projectId: "p-authority-dest", reason: "another authority", toAuthority: repoKey }, mutation))
      .toEqual({ ...receipt, resumedFrom: "published" });
  }, 60_000);

  test("a stale store revision refuses the staged route before anything is frozen", async () => {
    const issue = await captureIssue(
      context,
      capture(projectA, "occ-staged-stale", { sourceIdentity: "review/stale", rootCauseKey: "root-stale", acceptanceKey: "accept-stale" }),
      { actor: "project-manager", operationId: "capture-staged-stale" },
    );
    const repoKey = await destinationLane("p-authority-stale");
    const before = revision();
    await expect(
      moveIssue(
        context,
        issue.issueId,
        { projectId: "p-authority-stale", reason: "stale", toAuthority: repoKey },
        { actor: "project-manager", operationId: "move-staged-stale", expectedRevision: issue.revision, expectedStoreRevision: before - 1 },
      ),
    ).rejects.toMatchObject({ code: "milestone.revision-conflict" });
    expect(issueRow(issue.issueId).project_id).toBe(projectA);
    // invariant: A stale store view never reaches the freeze, so the move leaves no row at all.
    expect(
      db.prepare("select count(*) as n from issue_moves where operation_id = 'move-staged-stale'").get(),
    ).toEqual({ n: 0 });
  }, 60_000);

  test("a source write during the move is refused with the partial outcome naming the move", async () => {
    const issue = await captureIssue(
      context,
      capture(projectA, "occ-staged-fence", { sourceIdentity: "review/fenced", rootCauseKey: "root-fenced", acceptanceKey: "accept-fenced" }),
      { actor: "project-manager", operationId: "capture-staged-fence" },
    );
    const repoKey = await destinationLane("p-authority-fence");
    const { stageMove } = await import("./cross-authority-move.js");
    await stageMove(context, {
      operationId: "move-staged-fence",
      actor: "project-manager",
      sourceIssueId: issue.issueId,
      destinationAuthority: repoKey,
      destinationProject: "p-authority-fence",
      reason: "fenced",
    });
    // invariant: The lane's trigger is the fence, and the issue-domain entry restates its abort as the
    // partial outcome naming the move, so the operator resumes that move instead of retrying a write.
    const refused = await appendOccurrence(
      context,
      issue.issueId,
      {
        sourceIdentity: "review/fenced",
        rootCauseKey: "root-fenced",
        acceptanceKey: "accept-fenced",
        occurrenceKey: "occ-during-fence",
        sourceKind: "test",
        location: "src/fenced.ts",
        observedBehavior: "observed",
        evidence: [],
        discoveredAt: "2026-11-21T00:00:05.000Z",
      },
      { actor: "project-manager", operationId: "occurrence-during-fence" },
    ).then(() => null, (error: unknown) => error as { code?: string; details?: Record<string, unknown> });
    expect(refused?.code).toBe("collaboration.operation-partial");
    expect(refused?.details).toMatchObject({ cause: "issue.move-in-progress" });
    expect(JSON.stringify(refused?.details)).toContain("move-staged-fence");
    expect(
      db.prepare("select count(*) as n from occurrences where occurrence_key = 'occ-during-fence'").get(),
    ).toEqual({ n: 0 });

    // invariant: A SECOND move of the same record refuses at the ledger's own read, naming the move
    // that already holds it: one record never has two blocking rows.
    await expect(
      moveIssue(
        context,
        issue.issueId,
        { projectId: "p-authority-fence", reason: "second attempt", toAuthority: await destinationLane("p-authority-fence", "-two") },
        { actor: "project-manager", operationId: "move-staged-fence-two", expectedRevision: issue.revision, expectedStoreRevision: revision() },
      ),
    ).rejects.toMatchObject({ code: "issue.move-in-progress", details: { operation_id: "move-staged-fence", phase: "staged" } });
  }, 60_000);

  test("the same public command resumes from every persisted phase with its own stale arguments", async () => {
    // invariant: Finding 1 through the PUBLIC route: the operator reissues the command they ran,
    // `--expect` and `--expect-store` included. Those values are spent by the first run, so a resume
    // that re-applied them would leave every interrupted move unresumable.
    for (const stop of ["staged", "verified", "switched"] as const) {
      const issue = await captureIssue(
        context,
        capture(projectA, `occ-public-${stop}`, {
          sourceIdentity: `review/public-${stop}`,
          rootCauseKey: `root-public-${stop}`,
          acceptanceKey: `accept-public-${stop}`,
        }),
        { actor: "project-manager", operationId: `capture-public-${stop}` },
      );
      const repoKey = await destinationLane(`p-authority-public-${stop}`);
      const mutation = {
        actor: "project-manager",
        operationId: `move-public-${stop}`,
        expectedRevision: issue.revision,
        expectedStoreRevision: revision(),
      };
      const { moveAcrossAuthorities } = await import("./cross-authority-move.js");
      await moveAcrossAuthorities(
        context,
        {
          operationId: mutation.operationId,
          actor: mutation.actor,
          sourceIssueId: issue.issueId,
          destinationAuthority: repoKey,
          destinationProject: `p-authority-public-${stop}`,
          reason: "public resume",
          expectedRevision: mutation.expectedRevision,
          expectedStoreRevision: mutation.expectedStoreRevision,
        },
        stop,
      );
      const resumed = await moveIssue(
        context,
        issue.issueId,
        { projectId: `p-authority-public-${stop}`, reason: "public resume", toAuthority: repoKey },
        mutation,
      );
      expect(resumed).toMatchObject({ phase: "published", resumedFrom: stop });
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issue.issueId)).toEqual({ n: 0 });
    }
  }, 180_000);

  test("a reused operation id cannot move the record to a different authority or project", async () => {
    const issue = await captureIssue(
      context,
      capture(projectA, "occ-reuse", { sourceIdentity: "review/reuse", rootCauseKey: "root-reuse", acceptanceKey: "accept-reuse" }),
      { actor: "project-manager", operationId: "capture-reuse" },
    );
    const repoKey = await destinationLane("p-authority-reuse");
    const elsewhere = await destinationLane("p-authority-reuse-other");
    const { stageMove } = await import("./cross-authority-move.js");
    await stageMove(context, {
      operationId: "move-reuse",
      actor: "project-manager",
      sourceIssueId: issue.issueId,
      destinationAuthority: repoKey,
      destinationProject: "p-authority-reuse",
      reason: "original",
    });
    // invariant: A reuse aimed elsewhere is refused before any destination action, so the frozen
    // payload is never copied into a lane the original request did not choose.
    await expect(
      moveIssue(
        context,
        issue.issueId,
        { projectId: "p-authority-reuse-other", reason: "hijacked", toAuthority: elsewhere },
        { actor: "project-manager", operationId: "move-reuse", expectedRevision: issue.revision, expectedStoreRevision: revision() },
      ),
    ).rejects.toMatchObject({
      code: "store.operation-conflict",
      details: { differing_fields: ["destinationAuthority", "destinationProject", "reason"] },
    });
    expect(issueRow(issue.issueId).project_id).toBe(projectA);
    expect(await readCollaborationStage(collaborationLocationOfRepoKey(elsewhere, "local"), ({ db: lane }) =>
      lane.prepare("select count(*) as n from issue_moves").get())).toEqual({ n: 0 });
  }, 60_000);

  test("discard requires the issue-write seat and refuses without mutating", async () => {
    // invariant: Finding 4 — `--discard` unfreezes a record, so it is an issue write and needs the
    // same seat the move needs. A leaf actor must be refused before anything is touched.
    const issue = await captureIssue(
      context,
      capture(projectA, "occ-discard-seat", { sourceIdentity: "review/discard", rootCauseKey: "root-discard", acceptanceKey: "accept-discard" }),
      { actor: "project-manager", operationId: "capture-discard-seat" },
    );
    const repoKey = await destinationLane("p-authority-discard");
    const { stageMove } = await import("./cross-authority-move.js");
    await stageMove(context, {
      operationId: "move-discard-seat",
      actor: "project-manager",
      sourceIssueId: issue.issueId,
      destinationAuthority: repoKey,
      destinationProject: "p-authority-discard",
      reason: "seat",
    });
    const before = issueRow(issue.issueId);
    const { discardMove } = await import("./cross-authority-move.js");
    // note: The ENGINE entry is not the authorization point: `discardMove` takes a resolved request.
    // The public boundary the CLI calls is `moveIssue`'s seat check, so this asserts the shared rule
    // through the exported assertion the CLI uses.
    const { assertIssueWriteSeat } = await import("./issue.js");
    expect(() => assertIssueWriteSeat("leaf-observer")).toThrow(/issue\.scope\.refused|issue\.scope-refused/);
    expect(() => assertIssueWriteSeat("")).toThrow(/actor/);
    assertIssueWriteSeat("project-manager");
    // invariant: Refused before the store was opened, so nothing was unfrozen.
    expect(issueRow(issue.issueId)).toEqual(before);
    expect(db.prepare("select phase from issue_moves where operation_id = 'move-discard-seat'").get()).toEqual({ phase: "staged" });
    // note: And a discard by the holder of the seat does release the record.
    const discarded = await discardMove(context, {
      operationId: "move-discard-seat",
      actor: "project-manager",
      sourceIssueId: issue.issueId,
      destinationAuthority: repoKey,
      destinationProject: "p-authority-discard",
      reason: "seat",
    });
    expect(discarded).toMatchObject({ phase: "discarded", resumedFrom: "staged" });
    expect(db.prepare("select phase from issue_moves where operation_id = 'move-discard-seat'").get()).toEqual({ phase: "discarded" });
  }, 60_000);

  test("a destination that already holds the reference refuses before the switch", async () => {
    // invariant: Finding 6 through the public route: the collision is detected while this lane is
    // still the member, so the record is never stranded in a switched-but-unadmitted state.
    const issue = await captureIssue(
      context,
      capture(projectA, "occ-collide", { sourceIdentity: "review/collide", rootCauseKey: "root-collide", acceptanceKey: "accept-collide" }),
      { actor: "project-manager", operationId: "capture-collide" },
    );
    const repoKey = await destinationLane("p-authority-collide");
    const location = collaborationLocationOfRepoKey(repoKey, "local");
    await writeCollaborationStage(location, ({ db: lane }) => {
      lane.prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, " +
          "identity_key, issue_ref) values ('I-000007', 'p-authority-collide', 'Occupant', 'bug', 'low', 'open', 'i', 'a', " +
          "'2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 'occupant-key', ?)",
      ).run(carriedRef(issue.issueId));
    });
    const refused = await moveIssue(
      context,
      issue.issueId,
      { projectId: "p-authority-collide", reason: "collision", toAuthority: repoKey },
      { actor: "project-manager", operationId: "move-collide", expectedRevision: issue.revision, expectedStoreRevision: revision() },
    ).then(() => null, (error: unknown) => error as { code?: string; details?: Record<string, unknown> });
    expect(refused?.code).toBe("collaboration.move-destination-occupied");
    // invariant: The source is still here, still this lane's, and still writable by its own readers.
    expect(issueRow(issue.issueId)).toMatchObject({ project_id: projectA, revision: issue.revision });
    await expect(getIssue(context, issue.issueId)).resolves.toMatchObject({ id: issue.issueId });
    expect(db.prepare("select phase from issue_moves where operation_id = 'move-collide'").get()).toEqual({ phase: "verified" });
    // invariant: The documented recovery is executable: discard the stranded attempt.
    const { discardMove } = await import("./cross-authority-move.js");
    expect(await discardMove(context, {
      operationId: "move-collide",
      actor: "project-manager",
      sourceIssueId: issue.issueId,
      destinationAuthority: repoKey,
      destinationProject: "p-authority-collide",
      reason: "collision",
    })).toMatchObject({ phase: "discarded" });
    expect(db.prepare("select count(*) as n from issue_moves where operation_id = 'move-collide' and phase = 'discarded'").get())
      .toEqual({ n: 1 });
  }, 60_000);

  test("a changed reason on replay refuses through the public route and the membership keeps the staged reason", async () => {
    // invariant: `reason` is part of the immutable request the operation id binds. A replay that
    // changes it refuses instead of rewriting the project-move history admission records.
    const issue = await captureIssue(
      context,
      capture(projectA, "occ-reason", { sourceIdentity: "review/reason", rootCauseKey: "root-reason", acceptanceKey: "accept-reason" }),
      { actor: "project-manager", operationId: "capture-reason" },
    );
    const repoKey = await destinationLane("p-authority-reason");
    const mutation = {
      actor: "project-manager",
      operationId: "move-reason-bound",
      expectedRevision: issue.revision,
      expectedStoreRevision: revision(),
    };
    const { moveAcrossAuthorities } = await import("./cross-authority-move.js");
    await moveAcrossAuthorities(
      context,
      {
        operationId: mutation.operationId,
        actor: mutation.actor,
        sourceIssueId: issue.issueId,
        destinationAuthority: repoKey,
        destinationProject: "p-authority-reason",
        reason: "the staged reason",
        expectedRevision: mutation.expectedRevision,
        expectedStoreRevision: mutation.expectedStoreRevision,
      },
      "staged",
    );
    await expect(
      moveIssue(
        context,
        issue.issueId,
        { projectId: "p-authority-reason", reason: "rewritten reason", toAuthority: repoKey },
        mutation,
      ),
    ).rejects.toMatchObject({ code: "store.operation-conflict", details: { differing_fields: ["reason"] } });
    expect(db.prepare("select reason from issue_moves where operation_id = 'move-reason-bound'").get()).toEqual({
      reason: "the staged reason",
    });
    expect(issueRow(issue.issueId).project_id).toBe(projectA);
    // invariant: The recorded request still completes, and the membership records what it was staged with.
    expect(
      await moveIssue(
        context,
        issue.issueId,
        { projectId: "p-authority-reason", reason: "the staged reason", toAuthority: repoKey },
        mutation,
      ),
    ).toMatchObject({ phase: "published" });
    expect(
      await readCollaborationStage(collaborationLocationOfRepoKey(repoKey, "local"), ({ db: lane }) =>
        lane.prepare("select to_project_id, actor, reason from issue_project_moves").all(),
      ),
    ).toEqual([{ to_project_id: "p-authority-reason", actor: "project-manager", reason: "the staged reason" }]);
  }, 60_000);
});
