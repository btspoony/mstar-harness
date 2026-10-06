/**
 * Engine coordinator plan coordination — the three completion routes and the
 * consumer-visible seam regressions.
 *
 * There is ONE coordinator per workflow and no ownership-transfer protocol: the
 * coordinator prepares a row (ordinary revisable config), reports its progress
 * states and completes it directly with the QC/QA evidence its declared delivery
 * route requires. `complete` proves what actually happened:
 *
 * - an iteration row names the already-performed serial merge
 *   (`integration: {base_sha, result_sha}`) and the engine verifies the real
 *   two-parent merge of the pinned source reachable from the integration
 *   branch HEAD;
 * - a standalone development row verifies its own clean source checkout at the
 *   evidence's `source_sha` and never invents an integration;
 * - a report-only row consumes its already-recorded completion-policy
 *   fulfilment and verifies no Git at all (integration input refused).
 *
 * `gitRead` subprocess failure classification (§D2) belongs to the same proof
 * machinery: a Git read that never answers is unavailable evidence, not a
 * repository answer. Each case drives the real engine against a temporary Git
 * repository in its own control root; no case reads or writes this checkout's
 * control store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  CoordinationError,
  mutatePlanCoordination,
  readPlanCoordination,
  replaceCoordinatedArtifact,
  setCompleteStandaloneMutateGapForTest,
} from "../src/coordination.js";
import type { CompletionEvidence } from "../src/coordination-write.js";
import { closeWorkflow, recordWorkflowDelivery } from "../src/workflow.js";
import {
  WORKFLOW_ID, PLAN_ID, PEER_PLAN_ID, PROJECT_ID,
  type GitFixture,
  git, writeText, writeJson, readJson, makeFixture, sleep, errorCodeOf, failureOf, failureCode,
  ensureCoordinator, prepareCall, progressCall, completeCall,
  headOf, snapshotOf, planRowOf, updatePlanRow,
  completionOf, preparedOf, metadataOf, recordField, arrayField, sha256OfFile,
  acceptedFixture, acceptedStandaloneFixture, reportOnlyGitFixture, standaloneGitFixture,
  sealStoreForReaders, afterEachCleanup, finding,
  completionEvidenceOf,
} from "./support/coordination-fixtures.js";

afterEach(() => {
  afterEachCleanup();
});

/** The thrown error of a call that must fail, as a `CoordinationError`. */
async function refusalError(run: () => Promise<unknown>): Promise<CoordinationError> {
  const failure = await failureOf(run);
  if (failure instanceof CoordinationError) return failure;
  throw failure;
}

/** The coordinator merge: a real two-parent merge of the pinned source. */
function mergeFeature(fixture: GitFixture): string {
  git(
    ["-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-ff", fixture.planSha, "-m", "Merge plan-a"],
    fixture.integrationPath,
  );
  return headOf(fixture.integrationPath);
}

/** A distinct real commit on the integration branch the row does not name as its base. */
function otherBaseCheckout(fixture: GitFixture): string {
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "other base"], fixture.integrationPath);
  return fixture.integrationPath;
}

/**
 * A REAL two-parent merge on the integration branch whose second parent is an
 * UNRELATED branch commit rather than this plan's source: a wrong-source merge
 * that a parent-COUNT-only validator would wrongly accept.
 */
function mergeUnrelated(fixture: GitFixture): string {
  git(["checkout", "-q", "-b", "unrelated-work"], fixture.integrationPath);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "unrelated work"], fixture.integrationPath);
  const unrelated = headOf(fixture.integrationPath);
  git(["checkout", "-q", "-"], fixture.integrationPath);
  git(["merge", "-q", "--no-ff", unrelated, "-m", "Merge unrelated work"], fixture.integrationPath);
  return headOf(fixture.integrationPath);
}

/* ------------------------------------------------------------------------ *
 * Route 1 — iteration: verify the real serial integration
 * ------------------------------------------------------------------------ */

describe("iteration-completion", () => {
  test("complete verifies the actual serial merge, records it and releases the merge claim", async () => {
    const fixture = await acceptedFixture();
    const coordinatorSessionId = readJson(fixture.coordinatorSession).session_id;
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.allowed_operations).toContain("complete");
    expect(view.allowed_operations).not.toContain("handoff");

    // The operator performs the real merge; nothing in the engine merges.
    const baseSha = headOf(fixture.integrationPath);
    const mergeSha = mergeFeature(fixture);
    expect(baseSha).toBe(fixture.baseSha);

    const evidence = completionEvidenceOf(fixture, fixture.planSha);
    const completed = await completeCall(fixture, PLAN_ID, evidence, { base_sha: baseSha, result_sha: mergeSha });
    expect(completed.outcome).toBe("completed");

    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("Done");
    const completion = completionOf(row);
    expect(completion.source_branch).toBe("feature/plan-a");
    expect(completion.source_sha).toBe(fixture.planSha);
    expect(completion.worktree_path).toBe(fixture.worktreePath);
    expect(completion.completed_by).toBe(coordinatorSessionId);
    expect(typeof completion.completed_at).toBe("string");
    // The merge result the row names is the verified one, with its own anchors.
    const integration = recordField(completion, "integration");
    expect(integration.base_sha).toBe(baseSha);
    expect(integration.result_sha).toBe(mergeSha);
    expect(integration.target_branch).toBe("integration/plan-a");
    expect(integration.worktree_path).toBe(fixture.integrationPath);
    // The workflow-wide serial merge claim is released with the same write.
    expect(snapshotOf(fixture).integration_merge_lease).toBeUndefined();
    // The row keeps its own scope as ordinary metadata.
    expect(metadataOf(row).working_branch).toBe("feature/plan-a");
    expect(metadataOf(row).worktree_path).toBe(fixture.worktreePath);

    // Evidence paths and review decisions are pinned with their digests.
    const qc = recordField(completion, "qc");
    expect(qc.decision).toBe("Approve");
    const reports = arrayField(qc, "reports").map((entry) => {
      if (entry === null || typeof entry !== "object") throw new Error("qc report ref is not an object");
      return entry as Record<string, unknown>;
    });
    expect(reports.map((report) => report.path)).toEqual([
      join(fixture.sddDir, "review", "qc1.md"),
      join(fixture.sddDir, "review", "qc2.md"),
    ]);
    expect(reports.map((report) => report.sha256)).toEqual([
      sha256OfFile(join(fixture.sddDir, "review", "qc1.md")),
      sha256OfFile(join(fixture.sddDir, "review", "qc2.md")),
    ]);

    // Replay returns the recorded result and never rewrites the timestamp.
    const doneSnapshot = readJson(fixture.snapshotPath);
    const replayed = await completeCall(fixture, PLAN_ID, evidence, { base_sha: baseSha, result_sha: mergeSha });
    expect(replayed.outcome).toBe("already-satisfied");
    expect(readJson(fixture.snapshotPath)).toEqual(doneSnapshot);
    expect(completionOf(planRowOf(fixture, PLAN_ID)).completed_at).toBe(completion.completed_at);
  }, 30000);

  test("an iteration row refuses complete without the merge result it must verify", async () => {
    const fixture = await acceptedFixture();
    const evidence = completionEvidenceOf(fixture, fixture.planSha);
    const before = readJson(fixture.snapshotPath);

    // No `integration` input at all.
    expect(await errorCodeOf(() => completeCall(fixture, PLAN_ID, evidence))).toBe("coordination.invalid-input");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");

    // An integration pair that is not the two-parent merge of this source is
    // refused; the base commit is not a merge at all.
    const mergeSha = mergeFeature(fixture);
    expect(
      await errorCodeOf(() => completeCall(fixture, PLAN_ID, evidence, { base_sha: fixture.baseSha, result_sha: fixture.baseSha })),
    ).toBe("coordination.integration-diverged");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(planRowOf(fixture, PLAN_ID).coordination).not.toHaveProperty("completion");
    // The real merge is accepted.
    const completed = await completeCall(fixture, PLAN_ID, completionEvidenceOf(fixture, fixture.planSha), {
      base_sha: fixture.baseSha,
      result_sha: mergeSha,
    });
    expect(completed.outcome).toBe("completed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Done");
  }, 30000);

  test("a source checkout that moved after the proof never completes with stale Git evidence", async () => {
    const fixture = await acceptedFixture();
    const mergeSha = mergeFeature(fixture);
    const before = readJson(fixture.snapshotPath);
    const evidence = completionEvidenceOf(fixture, fixture.planSha);

    // Advance the source checkout after the evidence was captured: the recorded
    // `source_sha` no longer names the live HEAD, so the proof fails.
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "advance"], fixture.worktreePath);
    expect(
      await errorCodeOf(() => completeCall(fixture, PLAN_ID, evidence, { base_sha: fixture.baseSha, result_sha: mergeSha })),
    ).toBe("coordination.git-proof");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
  }, 30000);

  test("an unrelated merge, a wrong base and a non-ancestor review head are all refused (PR241-G2)", async () => {
    // A REAL two-parent merge of an UNRELATED branch commit: the result has two
    // parents, so only a validator that checks the SECOND parent against the
    // pinned source can refuse it.
    const wrongParents = await acceptedFixture();
    const wrongSourceMerge = mergeUnrelated(wrongParents);
    const beforeUnrelated = readJson(wrongParents.snapshotPath);
    expect(
      await errorCodeOf(() =>
        completeCall(wrongParents, PLAN_ID, completionEvidenceOf(wrongParents, wrongParents.planSha), {
          base_sha: wrongParents.baseSha,
          result_sha: wrongSourceMerge,
        }),
      ),
    ).toBe("coordination.integration-diverged");
    expect(readJson(wrongParents.snapshotPath)).toEqual(beforeUnrelated);
    expect(planRowOf(wrongParents, PLAN_ID).status).toBe("InReview");

    // A real two-parent merge whose base is NOT the recorded base: the parents
    // do not match `[base_sha, source_sha]`.
    const wrongBase = await acceptedFixture();
    const otherBase = headOf(otherBaseCheckout(wrongBase));
    const mergeSha = mergeFeature(wrongBase);
    const beforeWrongBase = readJson(wrongBase.snapshotPath);
    expect(
      await errorCodeOf(() =>
        completeCall(wrongBase, PLAN_ID, completionEvidenceOf(wrongBase, wrongBase.planSha), {
          base_sha: otherBase,
          result_sha: mergeSha,
        }),
      ),
    ).toBe("coordination.integration-diverged");
    expect(readJson(wrongBase.snapshotPath)).toEqual(beforeWrongBase);

    // A valid merge whose recorded review head is a REAL existing commit that is
    // not the pinned source. The side commit is created on an INDEPENDENT branch
    // in a separate checkout, and the plan's own source checkout is returned to
    // the pinned source, so ONLY review identity is wrong.
    const badHead = await acceptedFixture();
    const mergeId = mergeFeature(badHead);
    const sidePath = join(badHead.root, "wt-side");
    git(["worktree", "add", "-q", "-b", "side-branch", sidePath], badHead.root);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "side commit"], sidePath);
    const sideCommit = headOf(sidePath);
    expect(headOf(badHead.worktreePath)).toBe(badHead.planSha);
    const evidence = completionEvidenceOf(badHead, badHead.planSha);
    const beforeHead = readJson(badHead.snapshotPath);
    expect(
      await errorCodeOf(() =>
        completeCall(
          badHead,
          PLAN_ID,
          { ...evidence, review_head: sideCommit },
          { base_sha: badHead.baseSha, result_sha: mergeId },
        ),
      ),
    ).toBe("coordination.git-proof");
    expect(readJson(badHead.snapshotPath)).toEqual(beforeHead);
    expect(planRowOf(badHead, PLAN_ID).status).toBe("InReview");
    // Correcting ONLY the review head completes the same valid merge.
    const corrected = await completeCall(badHead, PLAN_ID, evidence, { base_sha: badHead.baseSha, result_sha: mergeId });
    expect(corrected.outcome).toBe("completed");
    expect(planRowOf(badHead, PLAN_ID).status).toBe("Done");
  }, 30000);

  test("an integration ref moved between the proof and the commit refuses with no completion (commit boundary)", async () => {
    const fixture = await acceptedFixture();
    const mergeSha = mergeFeature(fixture);
    const evidence = completionEvidenceOf(fixture, fixture.planSha);
    const before = readJson(fixture.snapshotPath);
    let seamRan = false;
    // The seam runs after the preflight witnesses and before the commit: force the
    // integration ref away from the proven result in that window.
    setCompleteStandaloneMutateGapForTest(() => {
      seamRan = true;
      git(["reset", "-q", "--hard", fixture.baseSha], fixture.integrationPath);
    });
    try {
      const code = await errorCodeOf(() =>
        completeCall(fixture, PLAN_ID, evidence, { base_sha: fixture.baseSha, result_sha: mergeSha }),
      );
      expect(seamRan).toBe(true);
      expect(code).toBe("coordination.integration-diverged");
      expect(readJson(fixture.snapshotPath)).toEqual(before);
      expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
      expect(planRowOf(fixture, PLAN_ID).coordination).not.toHaveProperty("completion");
    } finally {
      setCompleteStandaloneMutateGapForTest(undefined);
    }
  }, 30000);

  test("a result forced unreachable from the recorded integration branch is refused (T1-E-008)", async () => {
    const fixture = await acceptedFixture();
    const mergeSha = mergeFeature(fixture);
    // The merge exists as an object but the integration branch is force-moved
    // below it, so no commit on the live HEAD reaches the recorded result.
    git(["reset", "-q", "--hard", fixture.baseSha], fixture.integrationPath);
    expect(headOf(fixture.integrationPath)).toBe(fixture.baseSha);
    const before = readJson(fixture.snapshotPath);
    expect(
      await errorCodeOf(() =>
        completeCall(fixture, PLAN_ID, completionEvidenceOf(fixture, fixture.planSha), {
          base_sha: fixture.baseSha,
          result_sha: mergeSha,
        }),
      ),
    ).toBe("coordination.integration-diverged");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
  }, 30000);
});

/* ------------------------------------------------------------------------ *
 * Route 2 — standalone development: verify the source checkout only
 * ------------------------------------------------------------------------ */

describe("standalone-development-completion", () => {
  test("complete verifies the clean source checkout and never invents an integration", async () => {
    const fixture = await acceptedStandaloneFixture();
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.allowed_operations).toContain("complete");
    expect(view.allowed_operations).not.toContain("handoff");

    const completed = await completeCall(fixture, PLAN_ID, completionEvidenceOf(fixture, fixture.planSha));
    expect(completed.outcome).toBe("completed");
    // The standalone workflow stays active after its row is Done.
    expect(snapshotOf(fixture).status).toBe("running");
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("Done");
    const completion = completionOf(row);
    expect(completion.source_sha).toBe(fixture.planSha);
    expect(completion.integration).toBeUndefined();
    expect(metadataOf(row).working_branch).toBe("feature/plan-a");
    expect(metadataOf(row).worktree_path).toBe(fixture.worktreePath);

    const doneSnapshot = readJson(fixture.snapshotPath);
    const replayed = await completeCall(fixture, PLAN_ID, completionEvidenceOf(fixture, fixture.planSha));
    expect(replayed.outcome).toBe("already-satisfied");
    expect(readJson(fixture.snapshotPath)).toEqual(doneSnapshot);
  }, 30000);

  test("a standalone row refuses an integration input instead of synthesizing one", async () => {
    const fixture = await acceptedStandaloneFixture();
    const before = readJson(fixture.snapshotPath);
    const evidence = completionEvidenceOf(fixture, fixture.planSha);
    expect(
      await errorCodeOf(() => completeCall(fixture, PLAN_ID, evidence, { base_sha: fixture.baseSha, result_sha: fixture.baseSha })),
    ).toBe("coordination.invalid-transition");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
  }, 30000);

  test("a dirty source checkout, a missing anchor and a mid-flight move all refuse without writes", async () => {
    // A dirty checkout is not a completable source.
    const dirty = await acceptedStandaloneFixture();
    writeText(join(dirty.worktreePath, "scratch.txt"), "wip\n");
    const dirtyBefore = readJson(dirty.snapshotPath);
    expect(await errorCodeOf(() => completeCall(dirty, PLAN_ID, completionEvidenceOf(dirty, dirty.planSha)))).toBe(
      "coordination.git-proof",
    );
    expect(readJson(dirty.snapshotPath)).toEqual(dirtyBefore);
    expect(planRowOf(dirty, PLAN_ID).status).toBe("InReview");

    // An integration worktree recorded on a standalone workflow is contamination.
    const contaminated = await acceptedStandaloneFixture();
    writeJson(contaminated.snapshotPath, {
      ...snapshotOf(contaminated),
      integration_worktree_path: join(contaminated.root, "extra-integration"),
    });
    const contaminatedBefore = readJson(contaminated.snapshotPath);
    expect(
      await errorCodeOf(() => completeCall(contaminated, PLAN_ID, completionEvidenceOf(contaminated, contaminated.planSha))),
    ).toBe("coordination.invalid-transition");
    expect(readJson(contaminated.snapshotPath)).toEqual(contaminatedBefore);

    // The source checkout moves between the proof and the commit boundary.
    const moved = await acceptedStandaloneFixture();
    const movedBefore = readJson(moved.snapshotPath);
    setCompleteStandaloneMutateGapForTest(() => {
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "advance"], moved.worktreePath);
    });
    try {
      expect(await errorCodeOf(() => completeCall(moved, PLAN_ID, completionEvidenceOf(moved, moved.planSha)))).toBe(
        "coordination.git-proof",
      );
      expect(readJson(moved.snapshotPath)).toEqual(movedBefore);
      expect(planRowOf(moved, PLAN_ID).status).toBe("InReview");
    } finally {
      setCompleteStandaloneMutateGapForTest(undefined);
    }
  }, 30000);

  test("a non-scalar QC decision, an array QA gate and an unknown nested QC key refuse on the file route, and the corrected evidence completes", async () => {
    const fixture = await standaloneGitFixture();
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "start", evidence_paths: [] });
    const good = completionEvidenceOf(fixture, fixture.planSha);
    const before = readJson(fixture.snapshotPath);

    // Each deliberately malformed payload crosses an explicit unknown boundary into
    // the published `CompletionEvidence` type; the production type is not widened.
    const malformed = (override: Record<string, unknown>): CompletionEvidence =>
      override as unknown as CompletionEvidence;

    // `["Approve"]` is a non-scalar the strict enum must refuse.
    const decisionRefusal = await refusalError(() =>
      completeCall(fixture, PLAN_ID, malformed({ ...good, qc: { ...good.qc, decision: ["Approve"] } })),
    );
    expect(failureCode(decisionRefusal)).toBe("coordination.invalid-input");
    expect(decisionRefusal.message).toContain("qc.decision");
    expect(decisionRefusal.message).toContain("plan complete");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
    // An array QA gate is refused the same way.
    const gateRefusal = await refusalError(() =>
      completeCall(fixture, PLAN_ID, malformed({ ...good, qa: { ...good.qa, gate: ["mandatory"] } })),
    );
    expect(failureCode(gateRefusal)).toBe("coordination.invalid-input");
    expect(gateRefusal.message).toContain("qa");
    expect(gateRefusal.message).toContain("gate");
    expect(gateRefusal.message).toContain("plan complete");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
    // An unknown nested QC member is refused by the exact-key rule.
    const keyRefusal = await refusalError(() =>
      completeCall(fixture, PLAN_ID, malformed({ ...good, qc: { ...good.qc, unexpected: "x" } })),
    );
    expect(failureCode(keyRefusal)).toBe("coordination.forbidden-field");
    expect(keyRefusal.details).toMatchObject({ what: "completion evidence qc", unexpected: ["unexpected"] });
    expect(readJson(fixture.snapshotPath)).toEqual(before);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");

    // Correcting only the input completes through the same ordinary call.
    const completed = await completeCall(fixture, PLAN_ID, good);
    expect(completed.outcome).toBe("completed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Done");
  }, 30000);

  test("complete from InProgress without any prepare uses the effective defaults and keeps ordinary progress", async () => {
    // No ceremonial prepare: the ordinary source facts live on the row metadata,
    // and the effective defaults are QA mandatory + findings allow-residual.
    const fixture = await standaloneGitFixture();
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "start", evidence_paths: [] });
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");
    // An allowed MEDIUM residual (not critical/blocker) is permitted under the
    // effective allow-residual default: a clean-store-only pass cannot prove that.
    await mutatePlanCoordination({
      sessionPath: fixture.coordinatorSession,
      planId: PLAN_ID,
      operation: { kind: "residual-add", entries: [finding("r-medium", { severity: "medium" })] as never },
    });
    const completed = await completeCall(fixture, PLAN_ID, completionEvidenceOf(fixture, fixture.planSha));
    expect(completed.outcome).toBe("completed");
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("Done");
    // Read the recorded projection directly (no strict helper that throws on absence).
    const coordination = row.coordination as { prepared?: unknown; progress?: unknown; completion?: { qa?: { gate?: unknown } } };
    const qa = recordField(completionOf(row), "qa");
    expect(qa.gate).toBe("mandatory");
    expect(coordination.progress).toMatchObject({ status: "InProgress", summary: "start" });
    // No prepared block was ever written.
    expect(coordination.prepared).toBeUndefined();
  }, 30000);

  test("an incompatible QA gate in the evidence refuses without mutation, then the corrected gate completes", async () => {
    const fixture = await standaloneGitFixture();
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "start", evidence_paths: [] });
    const good = completionEvidenceOf(fixture, fixture.planSha);
    const before = readJson(fixture.snapshotPath);
    // QA evidence naming pm-acceptance while the effective config is mandatory.
    expect(
      await errorCodeOf(() => completeCall(fixture, PLAN_ID, { ...good, qa: { ...good.qa, gate: "pm-acceptance" } })),
    ).toBe("coordination.invalid-transition");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");
    const completed = await completeCall(fixture, PLAN_ID, good);
    expect(completed.outcome).toBe("completed");
  }, 30000);

  test("Todo and Blocked rows refuse complete; the same row after InProgress completes", async () => {
    const fixture = await standaloneGitFixture();
    await ensureCoordinator(fixture);
    const evidence = () => completionEvidenceOf(fixture, fixture.planSha);

    // From Todo: refused, no write.
    const beforeTodo = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => completeCall(fixture, PLAN_ID, evidence()))).toBe("coordination.plan-status");
    expect(readJson(fixture.snapshotPath)).toEqual(beforeTodo);

    // From Blocked: refused as well.
    await progressCall(fixture, PLAN_ID, { status: "Blocked", summary: "blocked", evidence_paths: [] });
    const beforeBlocked = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => completeCall(fixture, PLAN_ID, evidence()))).toBe("coordination.plan-status");
    expect(readJson(fixture.snapshotPath)).toEqual(beforeBlocked);

    // InProgress completes.
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "resume", evidence_paths: [] });
    const completed = await completeCall(fixture, PLAN_ID, evidence());
    expect(completed.outcome).toBe("completed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Done");
  }, 30000);

  test("a replay after the Git facts moved still serves the recorded receipt unchanged", async () => {
    const fixture = await acceptedStandaloneFixture();
    const evidence = completionEvidenceOf(fixture, fixture.planSha);
    const completed = await completeCall(fixture, PLAN_ID, evidence);
    expect(completed.outcome).toBe("completed");
    const recorded = completionOf(planRowOf(fixture, PLAN_ID));
    const doneSnapshot = readJson(fixture.snapshotPath);

    // The source checkout moves after the commit: a replay is answered from the
    // recorded receipt (already-satisfied, no Git), not by re-running proof.
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "post-done"], fixture.worktreePath);
    const replay = await completeCall(fixture, PLAN_ID, evidence);
    expect(replay.outcome).toBe("already-satisfied");
    expect(readJson(fixture.snapshotPath)).toEqual(doneSnapshot);
    expect(completionOf(planRowOf(fixture, PLAN_ID)).completed_at).toBe(recorded.completed_at);
  }, 30000);

  test("delivery evidence is captured before Done and completes the close with a full registered tail (A19)", async () => {
    const fixture = await acceptedStandaloneFixture();
    // §R5/A19 external evidence arrives when it arrives: capturing the delivery
    // tail while the row is still InReview is legal and is NOT a completion.
    const captured = await recordWorkflowDelivery(WORKFLOW_ID, fixture.workflowDir, {
      sessionPath: fixture.coordinatorSession,
      evidence: { compound: { outcome: "created" } },
      at: "2026-09-15T01:00:00Z",
    });
    expect(captured.written).toBe(true);
    expect(snapshotOf(fixture).delivery).toEqual({ compound: { outcome: "created" } });
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");

    await completeCall(fixture, PLAN_ID, completionEvidenceOf(fixture, fixture.planSha));
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Done");
    await recordWorkflowDelivery(WORKFLOW_ID, fixture.workflowDir, {
      sessionPath: fixture.coordinatorSession,
      evidence: {
        compound: { outcome: "created" },
        pr: { repo: "btspoony/mstar-harness", head: "feature/plan-a", target: "main" },
        merge: { provider: "github", evidence: "PR #999 verified merged" },
      },
      at: "2026-09-15T02:00:00Z",
    });
    const closed = await closeWorkflow(WORKFLOW_ID, fixture.workflowDir, {
      sessionPath: fixture.coordinatorSession,
      endedAt: "2026-09-15T03:00:00Z",
    });
    expect(closed.status).toBe("completed");
    expect(closed.delivery?.merge?.provider).toBe("github");
  }, 30000);
});

/* ------------------------------------------------------------------------ *
 * Route 3 — standalone report-only: policy fulfilment only, no Git
 * ------------------------------------------------------------------------ */

describe("report-only-completion", () => {
  /** The report-only state each case starts from: prepared, InReview. */
  async function reportOnlyFixture(): Promise<GitFixture> {
    const fixture = await reportOnlyGitFixture();
    await prepareCall(fixture, PLAN_ID);
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "acceptance report ready for review", evidence_paths: [] });
    await progressCall(fixture, PLAN_ID, { status: "InReview", summary: "acceptance report submitted for QC and QA", evidence_paths: [] });
    return fixture;
  }

  test("complete consumes the recorded policy fulfilment without any Git proof", async () => {
    const fixture = await reportOnlyFixture();
    const evidence = completionEvidenceOf(fixture, fixture.planSha);
    const completed = await completeCall(fixture, PLAN_ID, evidence);
    expect(completed.outcome).toBe("completed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Done");
    const completion = completionOf(planRowOf(fixture, PLAN_ID));
    // Git fields are recorded as provenance only; no integration is invented.
    expect(completion.source_sha).toBe(fixture.planSha);
    expect(completion.integration).toBeUndefined();
    expect(snapshotOf(fixture).integration_merge_lease).toBeUndefined();

    const doneSnapshot = readJson(fixture.snapshotPath);
    const replayed = await completeCall(fixture, PLAN_ID, evidence);
    expect(replayed.outcome).toBe("already-satisfied");
    expect(readJson(fixture.snapshotPath)).toEqual(doneSnapshot);
  }, 30000);

  test("a passing QA report alone is not the fulfilment, and an unrelated policy refuses", async () => {
    // The registered fulfilment names another policy: the QA pass does not
    // silently supply the registered one.
    const mismatched = await reportOnlyFixture();
    const snapshot = snapshotOf(mismatched);
    snapshot.delivery = { completion: { policy: "another policy", evidence: "report.md" } };
    writeJson(mismatched.snapshotPath, snapshot);
    const before = readJson(mismatched.snapshotPath);
    expect(await errorCodeOf(() => completeCall(mismatched, PLAN_ID, completionEvidenceOf(mismatched, mismatched.planSha)))).toBe(
      "coordination.invalid-transition",
    );
    expect(readJson(mismatched.snapshotPath)).toEqual(before);
    expect(planRowOf(mismatched, PLAN_ID).status).toBe("InReview");

    // A missing registration refuses too.
    const unregistered = await reportOnlyFixture();
    const stripped = { ...snapshotOf(unregistered) };
    delete stripped.completion_policy;
    writeJson(unregistered.snapshotPath, stripped);
    const unregisteredBefore = readJson(unregistered.snapshotPath);
    expect(
      await errorCodeOf(() => completeCall(unregistered, PLAN_ID, completionEvidenceOf(unregistered, unregistered.planSha))),
    ).toBe("coordination.invalid-transition");
    expect(readJson(unregistered.snapshotPath)).toEqual(unregisteredBefore);
  }, 30000);

  test("a report-only completion succeeds in a child whose PATH has no git at all", async () => {
    const fixture = await reportOnlyFixture();
    // No source Git fields at all: only the QC/QA evidence, so the route has nothing
    // to verify in Git and must record null provenance.
    const full = completionEvidenceOf(fixture, fixture.planSha);
    const evidence: CompletionEvidence = { qc: full.qc, qa: full.qa };
    // An isolated PATH dir with nothing in it: any Git work by the route would fail
    // as unavailable, so success here proves the route consults no Git.
    const binDir = join(fixture.root, "bin-empty-report-only");
    mkdirSync(binDir);
    const evidencePath = join(fixture.root, "ro-evidence.json");
    writeJson(evidencePath, evidence);
    const snapshotPath = join(fixture.harness, "workflows", WORKFLOW_ID, "snapshot.json");
    const scriptPath = join(fixture.root, "child-ro.ts");
    writeText(scriptPath, [
      `import { readFileSync } from "node:fs";`,
      `import { bindPlanSession, mutatePlanCoordination, readPlanCoordination } from ${JSON.stringify(join(import.meta.dir, "..", "src", "coordination.ts"))};`,
      `import { createFsStore, setArtifactStore } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))};`,
      `const [root, harness, planId, sessionPath, evidencePath, snapshotPath] = process.argv.slice(2);`,
      `setArtifactStore(createFsStore(harness));`,
      `const resumed = await bindPlanSession({ resumePath: sessionPath, cwd: root });`,
      `if (resumed.outcome !== "resumed") throw new Error("bad resume: " + String(resumed.outcome));`,
      `const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));`,
      `const view = await readPlanCoordination(sessionPath, planId, root);`,
      `const completed = await mutatePlanCoordination({ sessionPath, planId, expectedRevision: view.revision, operation: { kind: "complete", evidence } });`,
      `const snapshotAfterFirst = readFileSync(snapshotPath, "utf8");`,
      `// Replay the IDENTICAL request in the SAME no-Git child.`,
      `const replay = await mutatePlanCoordination({ sessionPath, planId, expectedRevision: view.revision, operation: { kind: "complete", evidence } });`,
      `const snapshotAfterReplay = readFileSync(snapshotPath, "utf8");`,
      `console.log(JSON.stringify({ outcome: completed.outcome, replay: replay.outcome, completedAt: completed.view.row.coordination.completion.completed_at, replayAt: replay.view.row.coordination.completion.completed_at, snapshotAfterFirst, snapshotAfterReplay }));`,
      ``,
    ].join("\n"));
    await sealStoreForReaders(fixture);
    const child = Bun.spawn(
      [process.execPath, scriptPath, fixture.root, fixture.harness, PLAN_ID, fixture.coordinatorSession, evidencePath, snapshotPath],
      { cwd: fixture.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: binDir } },
    );
    const exitCode = await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, `child stderr: ${stderr}`).toBe(0);
    const report = JSON.parse(stdout) as {
      outcome: string; replay: string; completedAt: string; replayAt: string; snapshotAfterFirst: string; snapshotAfterReplay: string;
    };
    expect(report.outcome).toBe("completed");
    // The replay, in the same no-Git child, is already-satisfied with an unchanged timestamp.
    expect(report.replay).toBe("already-satisfied");
    expect(report.replayAt).toBe(report.completedAt);
    // The WHOLE committed snapshot is byte-identical across the replay.
    expect(report.snapshotAfterReplay).toBe(report.snapshotAfterFirst);
    // The parent reads the committed row: Done with all-null provenance, no integration.
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("Done");
    const completion = completionOf(row);
    expect(completion).toMatchObject({ source_branch: null, source_sha: null, worktree_path: null, review_base: null, review_head: null });
    expect(completion.integration).toBeUndefined();
  }, 90000);

  test("a report-only row refuses an integration input and integration contamination", async () => {
    const integration = await reportOnlyFixture();
    const before = readJson(integration.snapshotPath);
    expect(
      await errorCodeOf(() =>
        completeCall(integration, PLAN_ID, completionEvidenceOf(integration, integration.planSha), {
          base_sha: integration.baseSha,
          result_sha: integration.baseSha,
        }),
      ),
    ).toBe("coordination.invalid-transition");
    expect(readJson(integration.snapshotPath)).toEqual(before);

    const contaminated = await reportOnlyFixture();
    writeJson(contaminated.snapshotPath, {
      ...snapshotOf(contaminated),
      integration_worktree_path: join(contaminated.root, "extra-integration"),
    });
    const contaminatedBefore = readJson(contaminated.snapshotPath);
    expect(
      await errorCodeOf(() => completeCall(contaminated, PLAN_ID, completionEvidenceOf(contaminated, contaminated.planSha))),
    ).toBe("coordination.invalid-transition");
    expect(readJson(contaminated.snapshotPath)).toEqual(contaminatedBefore);
  }, 30000);

  test("a report-only row refuses integration contamination while keeping the policy, and completes without source Git fields", async () => {
    // The registered policy and its recorded fulfilment both stand; only the
    // completion record is removed: the refusal is the missing fulfilment, not
    // a Git requirement.
    const noFulfilment = await reportOnlyFixture();
    const withoutCompletion = { ...snapshotOf(noFulfilment) };
    delete (withoutCompletion.delivery as Record<string, unknown>).completion;
    writeJson(noFulfilment.snapshotPath, withoutCompletion);
    const beforeFulfilment = readJson(noFulfilment.snapshotPath);
    expect(
      await errorCodeOf(() => completeCall(noFulfilment, PLAN_ID, completionEvidenceOf(noFulfilment, noFulfilment.planSha))),
    ).toBe("coordination.invalid-transition");
    expect(readJson(noFulfilment.snapshotPath)).toEqual(beforeFulfilment);

    // No source Git fields in the evidence at all: the report-only route records
    // them as optional provenance and never requires a checkout.
    const provenanceOnly = await reportOnlyFixture();
    const evidence = completionEvidenceOf(provenanceOnly, provenanceOnly.planSha);
    const withoutGit = { qc: evidence.qc, qa: evidence.qa };
    const completed = await completeCall(provenanceOnly, PLAN_ID, withoutGit);
    expect(completed.outcome).toBe("completed");
    const completion = completionOf(planRowOf(provenanceOnly, PLAN_ID));
    expect(completion.source_sha).toBeNull();
    expect(completion.integration).toBeUndefined();
  }, 30000);
});

/* ------------------------------------------------------------------------ *
 * Consumer-visible seam regressions (coordinator-only)
 * ------------------------------------------------------------------------ */

describe("seam-regressions", () => {
  test("prepare on a Done row refuses with the row's own status and mutates nothing", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "prepare", config: { workingBranch: "feature/plan-a" } },
    });
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "Done" }));
    const before = readJson(fixture.snapshotPath);
    const doneView = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    expect(await errorCodeOf(() =>
      mutatePlanCoordination({ sessionPath, planId: PLAN_ID, expectedRevision: doneView.revision, operation: { kind: "prepare" } }),
    )).toBe("coordination.prepare-status");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });

  test("prepare config stays revisable while the row is active", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    const first = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      operation: { kind: "prepare", config: { worktreePath: fixture.worktreePath, workingBranch: "feature/plan-a", qaGate: "mandatory" } },
    });
    expect(first.outcome).toBe("prepared");
    expect(preparedOf(planRowOf(fixture, PLAN_ID)).qa_gate).toBe("mandatory");
    expect(metadataOf(planRowOf(fixture, PLAN_ID)).working_branch).toBe("feature/plan-a");

    // An equal config is already satisfied and writes nothing.
    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    const snapshotBefore = readJson(fixture.snapshotPath);
    const equal = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "prepare", config: { worktreePath: fixture.worktreePath, workingBranch: "feature/plan-a", qaGate: "mandatory" } },
    });
    expect(equal.outcome).toBe("already-satisfied");
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);

    // A mistaken config naming a branch the ACTUAL checkout is not on refuses and
    // leaves the WHOLE snapshot and the row's progress untouched.
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "source execution started", evidence_paths: [] });
    const activeView = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    const progressBefore = activeView.row.coordination?.progress;
    const refusedBefore = readJson(fixture.snapshotPath);
    const branchRefusal = await refusalError(() =>
      mutatePlanCoordination({
        sessionPath,
        planId: PLAN_ID,
        expectedRevision: activeView.revision,
        operation: { kind: "prepare", config: { workingBranch: "feature/plan-a-v2" } },
      }),
    );
    expect(failureCode(branchRefusal)).toBe("coordination.invalid-input");
    // The actual branch cause and the ordinary correction are both named.
    expect(branchRefusal.details).toMatchObject({ working_branch: "feature/plan-a-v2", actual: "feature/plan-a" });
    expect(branchRefusal.message).toContain("revise it with plan prepare");
    expect(readJson(fixture.snapshotPath)).toEqual(refusedBefore);
    expect(metadataOf(planRowOf(fixture, PLAN_ID)).working_branch).toBe("feature/plan-a");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");

    // The real correction: switch the disposable feature checkout onto the new
    // branch, then prepare that ACTUAL scope.
    git(["checkout", "-q", "-b", "feature/plan-a-v2"], fixture.worktreePath);
    const switchedView = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    const revised = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: switchedView.revision,
      operation: { kind: "prepare", config: { workingBranch: "feature/plan-a-v2" } },
    });
    expect(revised.outcome).toBe("prepared");
    expect(metadataOf(planRowOf(fixture, PLAN_ID)).working_branch).toBe("feature/plan-a-v2");
    // The revision moved; the row's status and previously recorded progress are
    // retained by a config revision.
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");
    const afterRevision = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    // The FULL recorded progress block is retained, not just its status.
    expect(afterRevision.row.coordination?.progress).toEqual(progressBefore);
  });

  test("progress is transition-guarded and evidence-scoped", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");
    const outside = join(fixture.root, "outside.txt");
    writeText(outside, "not mine\n");

    // Todo → InProgress is the coordinator's first start report.
    const started = await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "start", evidence_paths: [evidence] });
    expect(started.outcome).toBe("progressed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");

    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    // Evidence outside the plan's own plan/SDD area is refused.
    expect(await errorCodeOf(() =>
      mutatePlanCoordination({
        sessionPath,
        planId: PLAN_ID,
        expectedRevision: view.revision,
        operation: { kind: "progress", progress: { status: "InProgress", summary: "x", evidence_paths: [outside] } },
      }),
    )).toBe("coordination.path-mismatch");
    // Missing evidence is refused.
    expect(await errorCodeOf(() =>
      mutatePlanCoordination({
        sessionPath,
        planId: PLAN_ID,
        expectedRevision: view.revision,
        operation: { kind: "progress", progress: { status: "InProgress", summary: "x", evidence_paths: [join(fixture.sddDir, "gone.txt")] } },
      }),
    )).toBe("coordination.invalid-input");

    // A protected snapshot branch is not an owned plan track.
    expect(await errorCodeOf(() =>
      mutatePlanCoordination({
        sessionPath,
        planId: PLAN_ID,
        expectedRevision: view.revision,
        operation: { kind: "progress", progress: { status: "InProgress", summary: "x", evidence_paths: [evidence], track_branches: ["main"] } },
      }),
    )).toBe("coordination.scope-mismatch");

    const blocked = await progressCall(fixture, PLAN_ID, { status: "Blocked", summary: "waiting", evidence_paths: [evidence] });
    expect(blocked.outcome).toBe("progressed");
    const blockedView = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    expect(await errorCodeOf(() =>
      mutatePlanCoordination({
        sessionPath,
        planId: PLAN_ID,
        expectedRevision: blockedView.revision,
        operation: { kind: "progress", progress: { status: "InReview", summary: "resume out of order", evidence_paths: [evidence] } },
      }),
    )).toBe("coordination.progress-transition");
  });

  test("one coordinator controls two rows and addresses each explicitly", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    for (const [planId, branch] of [[PLAN_ID, "feature/plan-a"], [PEER_PLAN_ID, "feature/plan-b"]] as const) {
      const prepared = await prepareCall(fixture, planId, {
        worktreePath: planId === PLAN_ID ? fixture.worktreePath : fixture.peerWorktreePath,
        workingBranch: branch,
      });
      expect(prepared.outcome).toBe("prepared");
      const progressed = await progressCall(fixture, planId, { status: "InProgress", summary: "start", evidence_paths: [] });
      expect(progressed.outcome).toBe("progressed");
    }
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");
    expect(planRowOf(fixture, PEER_PLAN_ID).status).toBe("InProgress");
    expect(metadataOf(planRowOf(fixture, PEER_PLAN_ID)).working_branch).toBe("feature/plan-b");

    // Both rows report the same coordinator as the actor; neither has a session.
    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    expect(view.session.role).toBe("coordinator");
    expect(view.row.coordination).not.toHaveProperty("session");
  });

  test("a foreign or malformed coordinator session is refused on read and mutation", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    const before = readJson(fixture.snapshotPath);

    const stray = join(fixture.root, "stray.json");
    writeJson(stray, { hello: "world" });
    expect(await errorCodeOf(() => readPlanCoordination(stray, PLAN_ID, fixture.root))).toBe("coordination.forbidden-field");

    const foreign = join(fixture.workflowDir, "sessions", "coordinator-foreign.json");
    writeJson(foreign, {
      schema_version: 1,
      role: "coordinator",
      session_id: "foreign",
      workflow_id: WORKFLOW_ID,
      harness_root: fixture.harness,
    });
    expect(await errorCodeOf(() => readPlanCoordination(foreign, PLAN_ID, fixture.root))).not.toBe(undefined);
    expect(await errorCodeOf(() =>
      mutatePlanCoordination({ sessionPath: foreign, planId: PLAN_ID, operation: { kind: "prepare" } }),
    )).not.toBe(undefined);
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });

  test("outer close refuses an unfinished row with a complete delivery tail, then a direct complete allows the close", async () => {
    const fixture = await acceptedStandaloneFixture();
    // Record the FULL registered development delivery tail (compound + PR +
    // verified merge) while the row is still InReview: a complete tail does NOT
    // synthesize completion, so the close must still refuse the unfinished row.
    await recordWorkflowDelivery(WORKFLOW_ID, fixture.workflowDir, {
      sessionPath: fixture.coordinatorSession,
      evidence: {
        compound: { outcome: "created" },
        pr: { repo: "btspoony/mstar-harness", head: "feature/plan-a", target: "main" },
        merge: { provider: "github", evidence: "PR #999 verified merged" },
      },
      at: "2026-09-15T01:00:00Z",
    });
    const before = snapshotOf(fixture);
    await expect(
      closeWorkflow(WORKFLOW_ID, fixture.workflowDir, { sessionPath: fixture.coordinatorSession, endedAt: "2026-09-15T02:00:00Z" }),
    ).rejects.toThrow(/every plan row must be Done/);
    // The refused close left the whole snapshot unchanged: no synthesized completion.
    expect(snapshotOf(fixture)).toEqual(before);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(planRowOf(fixture, PLAN_ID).coordination).not.toHaveProperty("completion");

    // The lawful sequence: direct complete, then the close.
    await completeCall(fixture, PLAN_ID, completionEvidenceOf(fixture, fixture.planSha));
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Done");
    const closed = await closeWorkflow(WORKFLOW_ID, fixture.workflowDir, { sessionPath: fixture.coordinatorSession, endedAt: "2026-09-15T03:00:00Z" });
    expect(closed.status).toBe("completed");
  }, 30000);

  test("the retired register surface is refused and a status root replacement is judged", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);

    // The residuals register kind is retired: the issue store is the authority.
    expect(await errorCodeOf(() =>
      replaceCoordinatedArtifact({
        harnessRoot,
        ref: { kind: "residuals", key: PROJECT_ID } as never,
        payload: { entries: { [PLAN_ID]: [] } },
      }),
    )).toBe("coordination.store");
    expect(existsSync(fixture.registerPath)).toBe(false);

    // An existing uncoordinated workflow in the root is judged, not rejected.
    const statusPath = join(harnessRoot, "status.json");
    await replaceCoordinatedArtifact({
      harnessRoot,
      ref: { kind: "status", key: "root" } as const,
      payload: readJson(statusPath),
    });
    expect(readJson(statusPath).workflows).toEqual([expect.objectContaining({ id: WORKFLOW_ID })]);
  });

  test("a foreign merge claim is never reused and is preserved on refusal", async () => {
    const fixture = await acceptedFixture();
    const mergeSha = mergeFeature(fixture);
    const ownLease = {
      holder: readJson(fixture.coordinatorSession).session_id,
      claimed_at: "2026-09-15T00:00:00Z",
      plan_id: PLAN_ID,
      source_branch: "feature/plan-a",
      target_branch: "integration/plan-a",
    };
    const writeLease = (overrides: Record<string, unknown>): void => {
      writeJson(fixture.snapshotPath, { ...snapshotOf(fixture), integration_merge_lease: { ...ownLease, ...overrides } });
    };

    // A lease naming another plan is not this attempt's claim: the completion is
    // refused and the foreign claim survives intact.
    writeLease({ plan_id: PEER_PLAN_ID, source_branch: "feature/plan-b" });
    const foreignSnapshot = readJson(fixture.snapshotPath);
    expect(
      await errorCodeOf(() =>
        completeCall(fixture, PLAN_ID, completionEvidenceOf(fixture, fixture.planSha), {
          base_sha: fixture.baseSha,
          result_sha: mergeSha,
        }),
      ),
    ).toBe("coordination.merge-lease-foreign");
    expect(readJson(fixture.snapshotPath)).toEqual(foreignSnapshot);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");

    // The attempt's own claim is completable, and completing releases it.
    writeLease({});
    const done = await completeCall(fixture, PLAN_ID, completionEvidenceOf(fixture, fixture.planSha), {
      base_sha: fixture.baseSha,
      result_sha: mergeSha,
    });
    expect(done.outcome).toBe("completed");
    expect(snapshotOf(fixture).integration_merge_lease).toBeUndefined();
  }, 30000);
});

/* ------------------------------------------------------------------------ *
 * `gitRead` subprocess failure classification (spec §D2)
 * ------------------------------------------------------------------------ */

describe("gitRead subprocess failure classification", () => {
  /** How long a case child may run before the test kills and reaps it. */
  const CHILD_DEADLINE_MS = 60_000;

  /** What the child prints: the public operation's outcome or error shape. */
  type ChildCompletionReport = { outcome?: string; name?: string; code?: string; message?: string; cause?: string };

  function writeExecutable(path: string, lines: string[]): void {
    writeText(path, `${lines.join("\n")}\n`);
    chmodSync(path, 0o755);
  }

  /**
   * The fixture `git`: records every invocation, delegates to the real Git
   * binary, and handles only the proof's target read (`git -C <worktree>
   * rev-parse HEAD`) with the given body — so the child really resolves `git`
   * through its isolated PATH while the scope probes still answer like the
   * environment they model.
   */
  function writeFixtureGit(binDir: string, recordPath: string, worktreePath: string, targetBody: string[]): void {
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("fixture delegation shim needs a real git on the runner PATH");
    writeExecutable(join(binDir, "git"), [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(recordPath)}`,
      `if [ "$1" = "-C" ] && [ "$2" = ${JSON.stringify(worktreePath)} ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then`,
      ...targetBody.map((line) => `  ${line}`),
      "fi",
      `exec ${JSON.stringify(realGit)} "$@"`,
    ]);
  }

  /**
   * Complete the prepared standalone row in one child process with `PATH`
   * pointing only at `binDir`. The child reports the surfaced error shape
   * (code, cause, message) as one JSON line.
   */
  async function completeInChildWithBinDir(
    fixture: GitFixture,
    evidence: CompletionEvidence,
    binDir: string,
  ): Promise<{ report: ChildCompletionReport; stderr: string; elapsedMs: number }> {
    const evidencePath = join(fixture.root, "evidence.json");
    writeJson(evidencePath, evidence);
    const scriptPath = join(fixture.root, "child-complete.ts");
    writeText(scriptPath, [
      `import { readFileSync } from "node:fs";`,
      `import { bindPlanSession, mutatePlanCoordination, readPlanCoordination } from ${JSON.stringify(join(import.meta.dir, "..", "src", "coordination.ts"))};`,
      `import { createFsStore, setArtifactStore } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))};`,
      `const [root, harness, planId, sessionPath, evidencePath] = process.argv.slice(2);`,
      `setArtifactStore(createFsStore(harness));`,
      `const resumed = await bindPlanSession({ resumePath: sessionPath, cwd: root });`,
      `if (resumed.outcome !== "resumed") throw new Error("bad resume: " + String(resumed.outcome));`,
      `const view = await readPlanCoordination(sessionPath, planId, root);`,
      `const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));`,
      `try {`,
      `  const completed = await mutatePlanCoordination({`,
      `    sessionPath,`,
      `    planId,`,
      `    expectedRevision: view.revision,`,
      `    operation: { kind: "complete", evidence },`,
      `  });`,
      `  console.log(JSON.stringify({ outcome: completed.outcome }));`,
      `} catch (error) {`,
      `  const code = (error as { code?: unknown } | null)?.code;`,
      `  const cause = ((error as { details?: unknown } | null)?.details as { cause?: unknown } | undefined)?.cause;`,
      `  console.log(JSON.stringify({`,
      `    name: error instanceof Error ? error.name : typeof error,`,
      `    code: typeof code === "string" ? code : undefined,`,
      `    message: error instanceof Error ? error.message : String(error),`,
      `    cause: typeof cause === "string" ? cause : undefined,`,
      `  }));`,
      `}`,
      ``,
    ].join("\n"));

    await sealStoreForReaders(fixture);
    const startedAt = Date.now();
    const child = Bun.spawn([process.execPath, scriptPath, fixture.root, fixture.harness, PLAN_ID, fixture.coordinatorSession, evidencePath], {
      cwd: fixture.root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: binDir },
    });
    const exitedInTime = await Promise.race([child.exited.then(() => true), sleep(CHILD_DEADLINE_MS).then(() => false)]);
    if (!exitedInTime) child.kill();
    const exitCode = await child.exited;
    const elapsedMs = Date.now() - startedAt;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, `child stderr: ${stderr}\nchild stdout: ${stdout}`).toBe(0);
    return { report: JSON.parse(stdout) as ChildCompletionReport, stderr, elapsedMs };
  }

  test("a non-zero git exit stays a repository fact (not-in-git), not git-unavailable", async () => {
    const fixture = await acceptedStandaloneFixture();
    const evidence = completionEvidenceOf(fixture, fixture.planSha);
    const binDir = join(fixture.root, "bin-nonzero");
    const recordPath = join(fixture.root, "shim-invocations.log");
    mkdirSync(binDir);
    writeFixtureGit(binDir, recordPath, fixture.worktreePath, ["exit 3"]);

    const { report } = await completeInChildWithBinDir(fixture, evidence, binDir);

    // The isolated PATH really was in effect, and the proof's own read reached
    // the fixture git.
    const shims = readFileSync(recordPath, "utf8");
    expect(shims).toContain("-C " + fixture.worktreePath + " rev-parse HEAD");
    // `git` answered the proof's read with a numeric status, so `gitRead`
    // resolves `undefined` and the proof keeps its repository-answer code rather
    // than the environment code.
    expect(report.code).toBe("coordination.git-proof");
    expect(report.code).not.toBe("coordination.git-unavailable");
    expect(report.message).toContain(fixture.worktreePath);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
  }, 90_000);

  test("a git read that outlives the production timeout is refused as git-unavailable", async () => {
    const fixture = await acceptedStandaloneFixture();
    const evidence = completionEvidenceOf(fixture, fixture.planSha);
    const binDir = join(fixture.root, "bin-hanging");
    const recordPath = join(fixture.root, "shim-invocations.log");
    mkdirSync(binDir);
    const hangScript = join(fixture.root, "hang-forever.js");
    writeText(hangScript, "setInterval(() => {}, 600000);\n");
    writeFixtureGit(binDir, recordPath, fixture.worktreePath, [
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(hangScript)}`,
    ]);

    const { report, elapsedMs } = await completeInChildWithBinDir(fixture, evidence, binDir);

    const shims = readFileSync(recordPath, "utf8");
    expect(shims).toContain("-C " + fixture.worktreePath + " rev-parse HEAD");
    // The refusal came from the production timeout firing, not an instant failure.
    expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
    expect(elapsedMs).toBeLessThan(CHILD_DEADLINE_MS);
    expect(report.code).toBe("coordination.git-unavailable");
    expect(report.cause).toContain("git did not answer within 10000ms");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
  }, 90_000);

  test("a missing git executable is refused as git-unavailable at the proof", async () => {
    const fixture = await acceptedStandaloneFixture();
    const evidence = completionEvidenceOf(fixture, fixture.planSha);
    const binDir = join(fixture.root, "bin-empty");
    mkdirSync(binDir);

    const { report } = await completeInChildWithBinDir(fixture, evidence, binDir);

    expect(report.code).toBe("coordination.git-unavailable");
    expect(report.code).not.toBe("coordination.git-proof");
    expect(report.cause).toContain("ENOENT");
    expect(report.message).toContain(fixture.worktreePath);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
  }, 90_000);
});
