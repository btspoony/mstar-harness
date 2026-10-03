/**
 * Engine scoped-plan coordination — lifecycle families: plan/coordinator handoff
 * transitions, integration and reconciliation, standalone and report-only
 * completion, legacy delivery-source repair, the merged-state seam regressions,
 * and the `gitRead` subprocess failure classification, together with its
 * PATH-shim fixture cluster (the handoff-ready fixture, the executable and
 * fixture-Git writers, the child-process handoff driver and its deadline).
 *
 * Spec sources (each moved case keeps the section it cites):
 * - Spec §B/§D — a plan session may hand off; the coordinator verbs (`accept`,
 *   `return`, `integration-start`, `integration-accept`, `complete`,
 *   `reconcile`) are neither advertised to a plan session nor reachable from
 *   one, and the handoff id a caller read is a precondition of the mutation.
 * - Spec §D2 — integration anchors: the merge proof is pinned to the live
 *   HEAD, and a `gitRead` that never answers is unavailable evidence
 *   (`coordination.git-unavailable`), not a repository answer.
 * - Spec §D — a standalone (no integration anchors) plan completes from its own
 *   accepted handoff, and a report-only delivery records policy evidence in
 *   place of merge proof.
 * - Spec §C legacy repair — `legacy-delivery-source-repair` touches only
 *   `branch.source`, the row revision and `updated_at`, preserving PR/merge
 *   evidence, and refuses mutation-free on every unsupported shape.
 *
 * Fixture discipline: the temp root is `realpathSync`-ed before any path is
 * derived from it, because the engine compares `realpathSync` worktree roots
 * (git) with lexically-resolved harness paths; every plan id is a safe path
 * component (`assertSafePathComponent`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  mutatePlanCoordination,
  readPlanCoordination,
  replaceCoordinatedArtifact,
  setCompleteStandaloneMutateGapForTest,
} from "../src/coordination.js";
import { claimLease } from "../src/lease.js";
import { closeWorkflow, recordWorkflowDelivery } from "../src/workflow.js";
import {
  WORKFLOW_ID, PLAN_ID, PEER_PLAN_ID, PROJECT_ID,
  type Fixture, type GitFixture, type HandoffEvidence,
  git, writeText, writeJson, readJson, makeFixture, sleep, errorCodeOf,
  ensureCoordinator, preparePlan, bindPlan, headOf,
  gitFixture, snapshotOf, planRowOf, updatePlanRow, claimExecutionLease, handoffFields, leaseHolder,
  handoffEvidenceOf, recordField, handoffCall, coordinatorCall,
  acceptedFixture, acceptedStandaloneFixture, wrongSourceAcceptedFixture,
  storeBacked, sealStoreForReaders, afterEachCleanup, finding, linkedOpenIssues,
} from "./support/coordination-fixtures.js";

afterEach(() => {
  afterEachCleanup();
});

describe("handoff-transitions", () => {
  test("handoff seals the evidence, accept moves the lease to the coordinator, return restores it", { timeout: 60_000 }, async () => {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));

    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    const planSessionId = readJson(fixture.planSession).session_id;
    const coordinatorSessionId = readJson(fixture.coordinatorSession).session_id;

    // A dirty plan worktree is not a handoff-able state.
    writeText(join(fixture.worktreePath, "scratch.txt"), "wip\n");
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.git-proof");
    rmSync(join(fixture.worktreePath, "scratch.txt"), { force: true });

    // An abbreviated revision is never silently expanded into a pin.
    expect(await errorCodeOf(() => handoffCall(fixture, { ...evidence, source_sha: fixture.planSha.slice(0, 7) }))).toBe(
      "coordination.invalid-input",
    );

    // Evidence must live inside this plan's own plan/SDD area.
    const stray = join(fixture.root, "stray-qc.md");
    writeText(stray, "# qc\n");
    expect(
      await errorCodeOf(() => handoffCall(fixture, { ...evidence, qc: { ...evidence.qc, reports: [stray] } })),
    ).toBe("coordination.path-mismatch");

    // A QA gate the Assignment never pinned is a stale handoff.
    expect(
      await errorCodeOf(() => handoffCall(fixture, { ...evidence, qa: { ...evidence.qa, gate: "pm-acceptance" } })),
    ).toBe("coordination.assignment-stale");

    const handed = await handoffCall(fixture, evidence);
    expect(handed.outcome).toBe("handed-off");
    const handedRow = planRowOf(fixture, PLAN_ID);
    expect(handedRow.status).toBe("InReview");
    expect(leaseHolder(handedRow)).toBe(planSessionId);
    const handoff = handoffFields(handedRow);
    expect(handoff.state).toBe("submitted");
    expect(handoff.attempt).toBe(1);
    expect(handoff.submitted_by).toBe(planSessionId);
    expect(typeof handoff.submitted_at).toBe("string");
    expect(handoff.source_branch).toBe("feature/plan-a");
    expect(handoff.source_sha).toBe(fixture.planSha);
    expect(handoff.review_base).toBe(fixture.baseSha);
    expect(handoff.review_head).toBe(fixture.planSha);
    expect(handoff.worktree_path).toBe(fixture.worktreePath);

    // Evidence references retain their paths; their recorded digests are provenance only.
    const qc = recordField(handoff, "qc");
    expect(qc.decision).toBe("Approve");
    const reports = qc.reports;
    if (!Array.isArray(reports)) throw new Error("qc.reports is not an array");
    expect(reports).toHaveLength(2);
    expect(reports.map((report) => (report as Record<string, unknown>).path)).toEqual([
      join(fixture.sddDir, "review", "qc1.md"),
      join(fixture.sddDir, "review", "qc2.md"),
    ]);
    const consolidated = recordField(qc, "consolidated");
    expect(consolidated.path).toBe(join(fixture.sddDir, "review", "qc.md"));
    const qa = recordField(handoff, "qa");
    expect(qa.gate).toBe("mandatory");
    expect(qa.decision).toBe("pass");
    expect(recordField(qa, "report").path).toBe(join(fixture.sddDir, "qa.md"));

    // The plan session is done until the row comes back; the coordinator can act.
    const planView = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(planView.allowed_operations).toEqual([]);
    const coordinatorView = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect([...coordinatorView.allowed_operations].sort()).toEqual(["accept", "return"]);
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.invalid-transition");

    const accepted = await coordinatorCall(fixture, PLAN_ID, { kind: "accept" });
    expect(accepted.outcome).toBe("accepted");
    const acceptedRow = planRowOf(fixture, PLAN_ID);
    expect(acceptedRow.status).toBe("InReview");
    expect(leaseHolder(acceptedRow)).toBe(coordinatorSessionId);
    const acceptedHandoff = handoffFields(acceptedRow);
    expect(acceptedHandoff.id).toBe(handoff.id);
    expect(acceptedHandoff.state).toBe("accepted");
    expect(acceptedHandoff.accepted_by).toBe(coordinatorSessionId);
    expect(typeof acceptedHandoff.accepted_at).toBe("string");

    // A reviewed prepare cannot replace the seal consumed by an accepted
    // handoff, even when the coordinator supplies changed Assignment bytes.
    const assignmentBytes = readFileSync(fixture.assignmentPath, "utf8");
    const acceptedSnapshot = readJson(fixture.snapshotPath);
    const sealedView = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    writeText(fixture.assignmentPath, assignmentBytes.replace("**QA gate**: mandatory", "**QA gate**: pm-acceptance"));
    try {
      expect(
        await errorCodeOf(() =>
          mutatePlanCoordination({
            sessionPath: fixture.coordinatorSession,
            planId: PLAN_ID,
            expectedRevision: sealedView.revision,
            operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
          }),
        ),
      ).toBe("coordination.prepare-already-prepared");
      // The refused prepare never replaces the consumed seal.
      expect(readJson(fixture.snapshotPath)).toEqual(acceptedSnapshot);
    } finally {
      writeText(fixture.assignmentPath, assignmentBytes);
    }

    // A return needs a reason, and it puts the row back with its own session.
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "return" }))).toBe(
      "coordination.invalid-input",
    );
    const returned = await coordinatorCall(fixture, PLAN_ID, { kind: "return", reason: "review range is stale" });
    expect(returned.outcome).toBe("returned");
    const returnedRow = planRowOf(fixture, PLAN_ID);
    expect(returnedRow.status).toBe("InProgress");
    expect(leaseHolder(returnedRow)).toBe(planSessionId);
    const returnedHandoff = handoffFields(returnedRow);
    expect(returnedHandoff.state).toBe("returned");
    expect(returnedHandoff.return_reason).toBe("review range is stale");
    expect(typeof returnedHandoff.returned_at).toBe("string");

    // Rework is a new commit and a new attempt, never a rewritten record.
    writeText(join(fixture.worktreePath, "slice.txt"), "slice B v2\n");
    git(["add", "-A"], fixture.worktreePath);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: rework"], fixture.worktreePath);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    const second = await handoffCall(fixture, handoffEvidenceOf(fixture, headOf(fixture.worktreePath)));
    expect(second.outcome).toBe("handed-off");
    const secondHandoff = handoffFields(planRowOf(fixture, PLAN_ID));
    expect(secondHandoff.state).toBe("submitted");
    expect(secondHandoff.attempt).toBe(2);
    expect(secondHandoff.id).not.toBe(returnedHandoff.id);
    expect(secondHandoff.source_sha).toBe(headOf(fixture.worktreePath));
  });
});


/** The coordinator merge: a real two-parent merge of the pinned source. */
function mergeFeature(fixture: GitFixture): string {
  git(
    ["-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-ff", fixture.planSha, "-m", "Merge plan-a"],
    fixture.integrationPath,
  );
  return headOf(fixture.integrationPath);
}






function snapshotWithoutRepairDelta(snapshot: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  delete copy.updated_at;
  const branch = copy.branch as Record<string, unknown> | undefined;
  if (branch !== undefined) delete branch.source;
  const plans = copy.plans as Array<Record<string, unknown>>;
  const coordination = plans[0]?.coordination as Record<string, unknown> | undefined;
  if (coordination !== undefined) delete coordination.revision;
  return copy;
}


/** A row with the fields the completion delta owns stripped out. */
function retainedRow(fixture: GitFixture): Record<string, unknown> {
  const row = { ...planRowOf(fixture, PLAN_ID) };
  delete row.status;
  delete row.coordination;
  delete row.execution_lease;
  return row;
}

describe("git-reconciliation", () => {
  test("integration start pins the base, accept proves the merge, complete releases both leases", async () => {
    const fixture = await acceptedFixture();
    const coordinatorSessionId = readJson(fixture.coordinatorSession).session_id;

    // An integration checkout that is dirty or on the wrong branch is never
    // merged into: the recorded target is re-checked, not assumed.
    writeText(join(fixture.integrationPath, "scratch.txt"), "wip\n");
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.integration-unresolved",
    );
    rmSync(join(fixture.integrationPath, "scratch.txt"), { force: true });
    git(["checkout", "-q", "-b", "stray-branch"], fixture.integrationPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.integration-diverged",
    );
    git(["checkout", "-q", "integration/plan-a"], fixture.integrationPath);
    expect(headOf(fixture.integrationPath)).toBe(fixture.baseSha);

    const started = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    expect(started.outcome).toBe("integrating");
    const startedRow = planRowOf(fixture, PLAN_ID);
    expect(startedRow.status).toBe("InReview");
    expect(leaseHolder(startedRow)).toBe(coordinatorSessionId);
    const attempt = recordField(handoffFields(startedRow), "integration");
    expect(attempt.target_branch).toBe("integration/plan-a");
    expect(attempt.worktree_path).toBe(fixture.integrationPath);
    expect(attempt.base_sha).toBe(fixture.baseSha);
    expect(attempt.result_sha).toBeUndefined();
    expect(typeof attempt.started_at).toBe("string");
    const lease = recordField(snapshotOf(fixture), "integration_merge_lease");
    expect(lease.holder).toBe(coordinatorSessionId);
    expect(lease.plan_id).toBe(PLAN_ID);
    expect(lease.source_branch).toBe("feature/plan-a");
    expect(lease.target_branch).toBe("integration/plan-a");

    // Retrying a started attempt re-verifies and never re-pins the base.
    const pinned = readJson(fixture.snapshotPath);
    const retry = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    expect(retry.outcome).toBe("already-integrating");
    expect(readJson(fixture.snapshotPath)).toEqual(pinned);

    // Nothing is proven by intent: an unmerged branch is not accepted.
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" }))).toBe(
      "coordination.integration-unresolved",
    );

    const mergeSha = mergeFeature(fixture);
    const accepted = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" });
    expect(accepted.outcome).toBe("merged");
    const mergedRow = planRowOf(fixture, PLAN_ID);
    expect(mergedRow.status).toBe("InReview");
    expect(leaseHolder(mergedRow)).toBe(coordinatorSessionId);
    expect(recordField(snapshotOf(fixture), "integration_merge_lease").holder).toBe(coordinatorSessionId);
    const mergedHandoff = handoffFields(mergedRow);
    expect(mergedHandoff.state).toBe("merged");
    expect(recordField(mergedHandoff, "integration").result_sha).toBe(mergeSha);

    // Complete is the one delta that releases both leases and sets Done.
    updatePlanRow(fixture, PLAN_ID, (row) => {
      const metadata = { ...(row.metadata as Record<string, unknown>), fixture_marker: "preserved" };
      delete metadata.working_branch;
      delete metadata.worktree_path;
      return { ...row, metadata };
    });
    const retainedBefore = retainedRow(fixture);
    const completed = await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    expect(completed.outcome).toBe("completed");
    const doneRow = planRowOf(fixture, PLAN_ID);
    expect(doneRow.status).toBe("Done");
    expect(doneRow.execution_lease).toBeUndefined();
    expect(snapshotOf(fixture).integration_merge_lease).toBeUndefined();
    const doneHandoff = handoffFields(doneRow);
    expect(doneHandoff.state).toBe("completed");
    expect(recordField(doneHandoff, "integration").result_sha).toBe(mergeSha);
    expect(doneRow.metadata).toMatchObject({
      working_branch: doneHandoff.source_branch,
      worktree_path: doneHandoff.worktree_path,
    });
    expect(typeof doneHandoff.completed_at).toBe("string");
    // Existing metadata survives alongside the newly retained cleanup scope.
    expect(retainedRow(fixture)).toEqual({
      ...retainedBefore,
      metadata: {
        ...(retainedBefore.metadata as Record<string, unknown>),
        working_branch: doneHandoff.source_branch,
        worktree_path: doneHandoff.worktree_path,
      },
    });

    // Replay is read-only: nothing is re-acquired, nothing is rewritten.
    const doneSnapshot = readJson(fixture.snapshotPath);
    const replayed = await coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" });
    expect(replayed.outcome).toBe("already-completed");
    expect(readJson(fixture.snapshotPath)).toEqual(doneSnapshot);
  }, 30000);

  test("reconcile classifies an interrupted attempt and never merges", async () => {
    // Started, nothing merged, base unmoved: the attempt is abandoned, not repaired.
    const retry = await acceptedFixture();
    await coordinatorCall(retry, PLAN_ID, { kind: "integration-start" });
    const retried = await coordinatorCall(retry, PLAN_ID, { kind: "reconcile" });
    expect(retried.outcome).toBe("retry-ready");
    const retryRow = planRowOf(retry, PLAN_ID);
    expect(retryRow.status).toBe("InReview");
    expect(leaseHolder(retryRow)).toBe(readJson(retry.coordinatorSession).session_id);
    const retryHandoff = handoffFields(retryRow);
    expect(retryHandoff.state).toBe("accepted");
    expect(retryHandoff.integration).toBeUndefined();
    expect(snapshotOf(retry).integration_merge_lease).toBeUndefined();
    expect(await errorCodeOf(() => coordinatorCall(retry, PLAN_ID, { kind: "complete" }))).toBe("coordination.invalid-transition");

    // A restarted attempt that does merge reconciles to the same completion
    // delta, in one write.
    const restarted = await coordinatorCall(retry, PLAN_ID, { kind: "integration-start" });
    expect(restarted.outcome).toBe("integrating");
    const provenSha = mergeFeature(retry);
    const reconciled = await coordinatorCall(retry, PLAN_ID, { kind: "reconcile" });
    expect(reconciled.outcome).toBe("completed");
    const provenRow = planRowOf(retry, PLAN_ID);
    expect(provenRow.status).toBe("Done");
    expect(provenRow.execution_lease).toBeUndefined();
    expect(snapshotOf(retry).integration_merge_lease).toBeUndefined();
    expect(recordField(handoffFields(provenRow), "integration").result_sha).toBe(provenSha);
    expect(provenRow.metadata).toMatchObject({
      working_branch: handoffFields(provenRow).source_branch,
      worktree_path: handoffFields(provenRow).worktree_path,
    });

    // A base that moved without a merge of the pinned source is divergence.
    const diverged = await acceptedFixture();
    await coordinatorCall(diverged, PLAN_ID, { kind: "integration-start" });
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "unrelated"], diverged.integrationPath);
    expect(await errorCodeOf(() => coordinatorCall(diverged, PLAN_ID, { kind: "reconcile" }))).toBe(
      "coordination.integration-diverged",
    );

    // A crash between accept and complete re-proves the *recorded* result.
    const merged = await acceptedFixture();
    await coordinatorCall(merged, PLAN_ID, { kind: "integration-start" });
    const recordedSha = mergeFeature(merged);
    await coordinatorCall(merged, PLAN_ID, { kind: "integration-accept" });
    const afterAccept = await coordinatorCall(merged, PLAN_ID, { kind: "reconcile" });
    expect(afterAccept.outcome).toBe("completed");
    const mergedDoneRow = planRowOf(merged, PLAN_ID);
    expect(mergedDoneRow.status).toBe("Done");
    expect(recordField(handoffFields(mergedDoneRow), "integration").result_sha).toBe(recordedSha);
  }, 30000);

  test("the merge lease is exclusive, the anchors are recorded, and the evidence stays sealed", async () => {
    // A foreign holder owns the merge lease: no takeover, no queueing.
    const leased = await acceptedFixture();
    writeJson(leased.snapshotPath, {
      ...snapshotOf(leased),
      integration_merge_lease: {
        holder: "coordinator-of-another-workflow",
        claimed_at: "2026-09-15T00:00:00Z",
        plan_id: PLAN_ID,
        source_branch: "feature/plan-a",
        target_branch: "integration/plan-a",
      },
    });
    expect(await errorCodeOf(() => coordinatorCall(leased, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.session-mismatch",
    );

    // Without a recorded integration target the call is unresolved, never
    // guessed from the current branch.
    const unanchored = await acceptedFixture();
    const stripped = { ...snapshotOf(unanchored) };
    delete stripped.integration_worktree_path;
    writeJson(unanchored.snapshotPath, stripped);
    expect(await errorCodeOf(() => coordinatorCall(unanchored, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.integration-unresolved",
    );

    // Evidence paths and field values remain valid after handoff even when a
    // report's bytes change; the recorded Git result is still verified.
    const retained = await acceptedFixture();
    await coordinatorCall(retained, PLAN_ID, { kind: "integration-start" });
    const resultSha = mergeFeature(retained);
    writeText(join(retained.sddDir, "review", "qc1.md"), "# rewritten after handoff\n");
    const accepted = await coordinatorCall(retained, PLAN_ID, { kind: "integration-accept" });
    // The accept records the merged attempt against the pinned Git result and
    // keeps both leases and InReview until `complete`.
    expect(accepted.outcome).toBe("merged");
    expect(recordField(handoffFields(planRowOf(retained, PLAN_ID)), "integration").result_sha).toBe(resultSha);
    expect(planRowOf(retained, PLAN_ID).status).toBe("InReview");
    expect(snapshotOf(retained).integration_merge_lease).toBeDefined();
  }, 30000);

  test("a force-moved integration HEAD voids an already-integrated proof (T1-E-008)", async () => {
    const fixture = await acceptedFixture();

    // The source reaches the integration branch *before* the attempt is pinned,
    // so the recorded base already carries it: the source is its ancestor and
    // the attempt would otherwise prove itself from the pinned objects alone.
    const pinnedBase = mergeFeature(fixture);
    const started = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    expect(started.outcome).toBe("integrating");
    expect(recordField(handoffFields(planRowOf(fixture, PLAN_ID)), "integration").base_sha).toBe(pinnedBase);

    // The integration branch is force-moved below the pinned base. That commit
    // is still an object of the repository, but no longer reachable from the
    // current HEAD, so no merge in this checkout belongs to the attempt.
    git(["reset", "-q", "--hard", fixture.baseSha], fixture.integrationPath);
    expect(headOf(fixture.integrationPath)).toBe(fixture.baseSha);

    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" }))).toBe(
      "coordination.integration-diverged",
    );
    // The refusal is non-advancing: no result is recorded and the attempt stays
    // open, so the leases and InReview are kept rather than half-released.
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    const refused = handoffFields(planRowOf(fixture, PLAN_ID));
    expect(refused.state).toBe("integrating");
    expect(recordField(refused, "integration").result_sha).toBeUndefined();
  }, 30000);

  test("a merged attempt is never completed on a proof the live HEAD stopped reaching (PR241-G2)", async () => {
    const fixture = await acceptedFixture();
    await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    const mergeSha = mergeFeature(fixture);
    const accepted = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" });
    expect(accepted.outcome).toBe("merged");
    expect(recordField(handoffFields(planRowOf(fixture, PLAN_ID)), "integration").result_sha).toBe(mergeSha);

    // The recorded merge is still an object of the repository, but the
    // integration branch is force-moved below it. `complete` must re-prove the
    // recorded result against the HEAD it reads in its own locked precheck —
    // a final write that only re-reads the recorded bytes would accept it.
    git(["reset", "-q", "--hard", fixture.baseSha], fixture.integrationPath);
    expect(headOf(fixture.integrationPath)).toBe(fixture.baseSha);

    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.integration-diverged",
    );
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(handoffFields(planRowOf(fixture, PLAN_ID)).state).toBe("merged");

    // The replay path carries the same gate: reconcile re-reads the branch HEAD
    // instead of completing from the recorded bytes alone.
    const mergedSnapshot = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" }))).toBe(
      "coordination.integration-diverged",
    );
    expect(readJson(fixture.snapshotPath)).toEqual(mergedSnapshot);
  }, 30000);
});

/**
 * S1 regression — the findings cleanup gate is evaluated **under the project
 * register write lock** (spec §C3, snapshot → register). Handoff is authorized
 * by that read, so an unlocked gate can be invalidated by a residual write that
 * lands between the read and the row commit it authorizes.
 *
 * The wall clock is the subject of this case: the finding has to land inside
 * the window in which the handoff is in flight, which no fake clock can express
 * (the interleave is between two real lock acquisitions). The holder keeps the
 * register lock for a short bounded window and writes the finding before
 * releasing it — the locked gate waits and observes it, while an unlocked gate
 * has already read `absent` and let the handoff through.
 */
describe("standalone-development-completion", () => {
  test("complete succeeds without integration fields and keeps the workflow running", async () => {
    const fixture = await acceptedStandaloneFixture();
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.allowed_operations).toContain("complete");
    expect(view.allowed_operations).not.toContain("integration-start");

    const completed = await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    expect(completed.outcome).toBe("completed");
    expect(snapshotOf(fixture).status).toBe("running");
    const doneRow = planRowOf(fixture, PLAN_ID);
    expect(doneRow.status).toBe("Done");
    expect(doneRow.execution_lease).toBeUndefined();
    const doneHandoff = handoffFields(doneRow);
    expect(doneHandoff.state).toBe("completed");
    expect(doneHandoff.integration).toBeUndefined();
    expect(typeof doneHandoff.completed_at).toBe("string");
    expect((doneRow.metadata as Record<string, unknown>).working_branch).toBe("feature/plan-a");
    expect((doneRow.metadata as Record<string, unknown>).worktree_path).toBe(fixture.worktreePath);

    const doneSnapshot = readJson(fixture.snapshotPath);
    const replayed = await coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" });
    expect(replayed.outcome).toBe("already-completed");
    expect(readJson(fixture.snapshotPath)).toEqual(doneSnapshot);
  }, 30000);

  test("report-only completion accepts matching policy evidence without integration or merge proof", async () => {
    const fixture = await acceptedStandaloneFixture();
    const snapshot = snapshotOf(fixture) as Record<string, unknown>;
    snapshot.delivery_kind = "verification/report-only";
    snapshot.completion_policy = "acceptance report";
    delete snapshot.branch;
    delete snapshot.integration_worktree_path;
    delete snapshot.integration_merge_lease;
    snapshot.delivery = { completion: { policy: "acceptance report", evidence: "report.md" } };
    writeJson(fixture.snapshotPath, snapshot);

    const completed = await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    expect(completed.outcome).toBe("completed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Done");
    expect(planRowOf(fixture, PLAN_ID).execution_lease).toBeUndefined();
    expect(handoffFields(planRowOf(fixture, PLAN_ID)).integration).toBeUndefined();
    const doneSnapshot = readJson(fixture.snapshotPath);
    expect((await coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" })).outcome).toBe("already-completed");
    expect(readJson(fixture.snapshotPath)).toEqual(doneSnapshot);
  }, 30000);

  test("delivery evidence is captured before Done and completes the close with a full registered tail (A19)", async () => {
    const fixture = await acceptedStandaloneFixture();
    // §R5/A19 external evidence arrives when it arrives: capturing the delivery
    // tail while the row is still InReview is legal and is NOT a completion (the
    // retired `PHASE6_PLAN_ROW_NOT_DONE` write-time pin is gone — the semantic
    // boundary is the close, which consults the complete registered tail).
    const captured = await recordWorkflowDelivery(WORKFLOW_ID, fixture.workflowDir, {
      sessionPath: fixture.coordinatorSession,
      evidence: { compound: { outcome: "created" } },
      at: "2026-09-15T01:00:00Z",
    });
    expect(captured.written).toBe(true);
    expect(snapshotOf(fixture).delivery).toEqual({ compound: { outcome: "created" } });
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");

    await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
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

  test("integration contamination, missing anchors and dirty checkout refuse without protected-document changes", async () => {
    const contaminated = await acceptedStandaloneFixture();
    writeJson(contaminated.snapshotPath, {
      ...snapshotOf(contaminated),
      integration_worktree_path: join(contaminated.root, "extra-integration"),
    });
    const contaminatedBefore = readJson(contaminated.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(contaminated, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readJson(contaminated.snapshotPath)).toEqual(contaminatedBefore);

    const unanchored = await acceptedStandaloneFixture();
    writeJson(unanchored.snapshotPath, {
      ...snapshotOf(unanchored),
      branch: { target: "main" },
    });
    const unanchoredBefore = readJson(unanchored.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(unanchored, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readJson(unanchored.snapshotPath)).toEqual(unanchoredBefore);

    const dirty = await acceptedStandaloneFixture();
    writeText(join(dirty.worktreePath, "scratch.txt"), "wip\n");
    const dirtyBefore = readJson(dirty.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(dirty, PLAN_ID, { kind: "complete" }))).toBe("coordination.git-proof");
    expect(readJson(dirty.snapshotPath)).toEqual(dirtyBefore);
  }, 30000);

  test("a standalone source checkout moved after precheck never completes with stale git evidence", async () => {
    const fixture = await acceptedStandaloneFixture();
    const before = readJson(fixture.snapshotPath);
    setCompleteStandaloneMutateGapForTest(() => {
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "advance"], fixture.worktreePath);
    });
    try {
      expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe("coordination.git-proof");
      expect(readJson(fixture.snapshotPath)).toEqual(before);
      expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    } finally {
      setCompleteStandaloneMutateGapForTest(undefined);
    }
  }, 30000);

  test("reconcile refuses malformed standalone completed handoff missing acceptance seals", async () => {
    const fixture = await acceptedStandaloneFixture();
    await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    const row = planRowOf(fixture, PLAN_ID);
    const handoff = { ...handoffFields(row) };
    delete handoff.accepted_at;
    updatePlanRow(fixture, PLAN_ID, (current) => ({
      ...current,
      coordination: { ...(current.coordination as Record<string, unknown>), handoff },
    }));
    const before = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" }))).toBe(
      "coordination.store",
    );
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  }, 30000);

  test("iteration accepted handoff still refuses complete without integration (no standalone fallback)", async () => {
    const fixture = await acceptedFixture();
    const before = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readJson(fixture.snapshotPath)).toEqual(before);

    const unanchored = await acceptedFixture();
    const stripped = { ...snapshotOf(unanchored) };
    delete stripped.integration_worktree_path;
    writeJson(unanchored.snapshotPath, stripped);
    expect(await errorCodeOf(() => coordinatorCall(unanchored, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.integration-unresolved",
    );
  }, 30000);
});


describe("legacy-delivery-source-repair", () => {
  test("repairs only branch.source, row revision and updated_at while preserving PR/merge evidence", async () => {
    const fixture = await wrongSourceAcceptedFixture(true);
    const before = readJson(fixture.snapshotPath);
    const beforeView = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const repaired = await coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" });
    expect(repaired.outcome).toBe("delivery-source-repaired");
    const after = snapshotOf(fixture);
    expect(after.branch).toEqual({ source: "feature/plan-a", target: "main" });
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(handoffFields(planRowOf(fixture, PLAN_ID)).state).toBe("accepted");
    expect(after.delivery).toEqual(before.delivery);
    expect(snapshotWithoutRepairDelta(after)).toEqual(snapshotWithoutRepairDelta(before));
    expect(beforeView.revision + 1).toBe((await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root)).revision);
    expect(typeof after.updated_at).toBe("string");
    expect(after.updated_at).not.toBe(before.updated_at);
  }, 30000);

  test("repairs identity on a fixture without PR/merge evidence", async () => {
    const fixture = await wrongSourceAcceptedFixture(false);
    const before = readJson(fixture.snapshotPath);
    const repaired = await coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" });
    expect(repaired.outcome).toBe("delivery-source-repaired");
    expect(snapshotOf(fixture).branch).toEqual({ source: "feature/plan-a", target: "main" });
    expect(snapshotWithoutRepairDelta(snapshotOf(fixture))).toEqual(snapshotWithoutRepairDelta(before));
  }, 30000);

  test("fresh-token second application refuses already-aligned without writes", async () => {
    const fixture = await wrongSourceAcceptedFixture(false);
    await coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" });
    const aligned = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.already-aligned",
    );
    expect(readJson(fixture.snapshotPath)).toEqual(aligned);
  }, 30000);

  test("terminal, paused, unsupported, non-legacy and PR-conflict refusals are mutation-free", async () => {
    const terminal = await wrongSourceAcceptedFixture(false);
    const terminalSnap = snapshotOf(terminal);
    terminalSnap.status = "failed";
    terminalSnap.ended_at = "2026-09-15T01:00:00Z";
    terminalSnap.plans = (terminalSnap.plans as Array<Record<string, unknown>>).map((row) => {
      const { execution_lease, ...rest } = row;
      return rest;
    });
    writeJson(terminal.snapshotPath, terminalSnap);
    const terminalBefore = readJson(terminal.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(terminal, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.terminal",
    );
    expect(readJson(terminal.snapshotPath)).toEqual(terminalBefore);

    const paused = await wrongSourceAcceptedFixture(false);
    writeJson(paused.snapshotPath, { ...snapshotOf(paused), status: "paused" });
    const pausedBefore = readJson(paused.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(paused, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readJson(paused.snapshotPath)).toEqual(pausedBefore);

    const iteration = await acceptedFixture();
    const iterationBefore = readJson(iteration.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(iteration, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.unsupported-workflow",
    );
    expect(readJson(iteration.snapshotPath)).toEqual(iterationBefore);

    const alignedShape = await acceptedStandaloneFixture();
    const alignedBefore = readJson(alignedShape.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(alignedShape, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.already-aligned",
    );
    expect(readJson(alignedShape.snapshotPath)).toEqual(alignedBefore);

    const prConflict = await wrongSourceAcceptedFixture(true);
    const conflictSnap = snapshotOf(prConflict);
    conflictSnap.delivery = {
      ...(conflictSnap.delivery as Record<string, unknown>),
      pr: { repo: "btspoony/mstar-harness", head: "main", target: "main" },
    };
    writeJson(prConflict.snapshotPath, conflictSnap);
    const conflictBefore = readJson(prConflict.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(prConflict, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.pr-conflict",
    );
    expect(readJson(prConflict.snapshotPath)).toEqual(conflictBefore);
  }, 30000);

  test("dirty checkout and missing accepted handoff refuse without protected-document changes", async () => {
    const dirty = await wrongSourceAcceptedFixture(false);
    writeText(join(dirty.worktreePath, "scratch.txt"), "wip\n");
    const dirtyBefore = readJson(dirty.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(dirty, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.git-proof",
    );
    expect(readJson(dirty.snapshotPath)).toEqual(dirtyBefore);

    const noHandoff = await wrongSourceAcceptedFixture(false);
    const staleHandoffId = String(handoffFields(planRowOf(noHandoff, PLAN_ID)).id);
    updatePlanRow(noHandoff, PLAN_ID, (row) => {
      const coordination = { ...(row.coordination as Record<string, unknown>) };
      delete coordination.handoff;
      return { ...row, coordination };
    });
    const noHandoffBefore = readJson(noHandoff.snapshotPath);
    expect(
      await errorCodeOf(() =>
        coordinatorCall(noHandoff, PLAN_ID, { kind: "repair-delivery-source" }, staleHandoffId),
      ),
    ).toBe("coordination.delivery-source-repair.no-accepted-handoff");
    expect(readJson(noHandoff.snapshotPath)).toEqual(noHandoffBefore);
  }, 30000);

  test("terminal and paused admission precede missing-handoff refusal", async () => {
    const terminal = await wrongSourceAcceptedFixture(false);
    const terminalSnap = snapshotOf(terminal);
    terminalSnap.status = "failed";
    terminalSnap.ended_at = "2026-09-15T01:00:00Z";
    terminalSnap.plans = (terminalSnap.plans as Array<Record<string, unknown>>).map((row) => {
      const { execution_lease, ...rest } = row;
      const coordination = { ...(row.coordination as Record<string, unknown>) };
      delete coordination.handoff;
      return { ...rest, coordination };
    });
    writeJson(terminal.snapshotPath, terminalSnap);
    const terminalBefore = readJson(terminal.snapshotPath);
    expect(
      await errorCodeOf(() =>
        coordinatorCall(terminal, PLAN_ID, { kind: "repair-delivery-source" }, "missing-handoff"),
      ),
    ).toBe("coordination.delivery-source-repair.terminal");
    expect(readJson(terminal.snapshotPath)).toEqual(terminalBefore);

    const paused = await wrongSourceAcceptedFixture(false);
    const pausedSnap = snapshotOf(paused);
    pausedSnap.status = "paused";
    pausedSnap.plans = (pausedSnap.plans as Array<Record<string, unknown>>).map((row) => {
      const coordination = { ...(row.coordination as Record<string, unknown>) };
      delete coordination.handoff;
      return { ...row, coordination };
    });
    writeJson(paused.snapshotPath, pausedSnap);
    const pausedBefore = readJson(paused.snapshotPath);
    expect(
      await errorCodeOf(() =>
        coordinatorCall(paused, PLAN_ID, { kind: "repair-delivery-source" }, "missing-handoff"),
      ),
    ).toBe("coordination.invalid-transition");
    expect(readJson(paused.snapshotPath)).toEqual(pausedBefore);
  }, 30000);

  test("integration contamination refuses not-legacy-shape for repair", async () => {
    const fixture = await wrongSourceAcceptedFixture(false);
    writeJson(fixture.snapshotPath, {
      ...snapshotOf(fixture),
      integration_worktree_path: join(fixture.root, "extra-integration"),
    });
    const before = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.not-legacy-shape",
    );
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  }, 30000);
});

describe("seam-regressions", () => {
  /** A prepared plan whose bound session holds the row's execution lease. */
  async function claimedPlan(): Promise<GitFixture> {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    return fixture;
  }

  /** Drop the execution lease from a row the way a released owner leaves it. */
  function dropLease(fixture: Fixture, planId: string): void {
    updatePlanRow(fixture, planId, (row) => {
      const { execution_lease, ...rest } = row;
      return rest;
    });
  }

  test("prepare refuses a row that still carries an execution lease (T1-D-005)", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    updatePlanRow(fixture, PLAN_ID, (row) => {
      const claimed = claimLease(row as never, "session-held", {
        worktree_path: fixture.worktreePath,
        working_branch: "feature/plan-a",
      });
      if (!claimed.ok) throw new Error("claim failed");
      return claimed.row;
    });

    expect(await errorCodeOf(() => preparePlan(fixture, PLAN_ID))).toBe("coordination.duplicate-holder");
    // The row is still unprepared: the refusal never sealed a second owner.
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.coordination).toBeUndefined();
    expect(leaseHolder(row)).toBe("session-held");
  });

  test("a plan-owned write needs the row lease, while show and resume stay readable (T1-D-007)", async () => {
    const fixture = await claimedPlan();
    dropLease(fixture, PLAN_ID);

    // Reads stay available: a completed row carries no lease yet must report.
    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(Array.isArray(view.allowed_operations)).toBe(true);

    const snapshotBefore = readJson(fixture.snapshotPath);
    const code = await errorCodeOf(() =>
      mutatePlanCoordination({
        sessionPath: fixture.planSession,
        planId: PLAN_ID,
        expectedRevision: view.revision,
        operation: {
          kind: "residual-add",
          entries: [finding("r-lease")] as never,
        },
      }),
    );
    expect(["coordination.invalid-transition", "coordination.session-mismatch", "coordination.execution-lease-required"]).toContain(code);
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    expect(existsSync(fixture.registerPath)).toBe(false);
  });

  test("accept refuses instead of no-op'ing when the row lease is gone (T1-E-006)", async () => {
    const fixture = await claimedPlan();
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    expect((await handoffCall(fixture, handoffEvidenceOf(fixture, fixture.planSha))).outcome).toBe("handed-off");
    dropLease(fixture, PLAN_ID);

    const snapshotBefore = readJson(fixture.snapshotPath);
    const code = await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "accept" }));
    expect(["coordination.invalid-transition", "coordination.session-mismatch", "coordination.execution-lease-required"]).toContain(code);
    // The state never advances: still InReview, handoff still merely submitted.
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("InReview");
    expect(handoffFields(row).state).toBe("submitted");
  });

  test("return of a submitted handoff leaves the plan session holding its own lease (T1-D-004)", async () => {
    const fixture = await claimedPlan();
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    const planSessionId = readJson(fixture.planSession).session_id;
    expect((await handoffCall(fixture, handoffEvidenceOf(fixture, fixture.planSha))).outcome).toBe("handed-off");

    // A handoff that was never accepted goes back to the session that sealed it.
    expect((await coordinatorCall(fixture, PLAN_ID, { kind: "return", reason: "rework" })).outcome).toBe("returned");
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("InProgress");
    expect(leaseHolder(row)).toBe(planSessionId);
    expect(handoffFields(row).state).toBe("returned");
  });

  test("a coordinated row addressed only by its legacy plan_id is protected (T1-OWN-003)", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);
    await preparePlan(fixture, PLAN_ID);
    updatePlanRow(fixture, PLAN_ID, (row) => {
      const { id, ...rest } = row;
      return { ...rest, plan_id: id };
    });

    // The register kind is retired (issue authority): the replacement surface
    // refuses before any ownership scan, and no register is created.
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: { kind: "residuals", key: PROJECT_ID } as never,
          payload: { entries: { [PLAN_ID]: [] } },
        }),
      ),
    ).toBe("coordination.store");
    expect(existsSync(fixture.registerPath)).toBe(false);
  });

  test("issue authority: a register on disk is never a runtime authority for the scoped mutation (T1-C3-009)", async () => {
    const fixture = makeFixture();
    await storeBacked(fixture, [PLAN_ID]);
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);

    // A legacy register (even a valid or malformed one) no longer backs the
    // mutation: residual-add goes to the issue store only and the register
    // document stays untouched. The residuals file may legitimately not exist;
    // a deliberate sentinel proves the mutation left it exactly as it found it.
    const sentinel = { entries: { [PLAN_ID]: [] } };
    writeJson(fixture.registerPath, sentinel);
    await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-x")] as never },
    });
    expect(readJson(fixture.registerPath)).toEqual(sentinel);
    expect((await linkedOpenIssues(fixture, PLAN_ID)).map((issue) => issue.id)).toEqual(["I-000001"]);
  });

  test("a replacement that retains an existing uncoordinated workflow is judged, not rejected (T1-C4-011)", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);
    const statusPath = join(harnessRoot, "status.json");
    await replaceCoordinatedArtifact({
      harnessRoot,
      ref: { kind: "status", key: "root" } as const,
      payload: readJson(statusPath),
    });
    expect(readJson(statusPath).workflows).toEqual([expect.objectContaining({ id: WORKFLOW_ID })]);
  });

  test("handoff evidence must not carry a top-level worktree_path (T1-D-012)", async () => {
    const fixture = await claimedPlan();
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);

    // The worktree is derived from the scope; a caller-supplied one is refused.
    expect(
      await errorCodeOf(() => handoffCall(fixture, { ...evidence, worktree_path: fixture.worktreePath } as never)),
    ).toBe("coordination.forbidden-field");
    const handed = await handoffCall(fixture, evidence);
    expect(handed.outcome).toBe("handed-off");
    expect(handoffFields(planRowOf(fixture, PLAN_ID)).worktree_path).toBe(fixture.worktreePath);
  });

  test("a foreign merge lease is never reused or released (QC2-S2)", async () => {
    // A plan that has merged while holding the workflow's single merge lease for
    // its own attempt.
    const fixture = await acceptedFixture();
    await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    const mergeSha = mergeFeature(fixture);
    await coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" });
    const ownLease = recordField(snapshotOf(fixture), "integration_merge_lease");
    expect(ownLease.plan_id).toBe(PLAN_ID);
    const writeLease = (overrides: Record<string, unknown>): void => {
      writeJson(fixture.snapshotPath, {
        ...snapshotOf(fixture),
        integration_merge_lease: { ...ownLease, ...overrides },
      });
    };

    // The slot is workflow-wide, so a holder match is not ownership: a lease
    // naming another plan is refused, and the foreign claim survives intact.
    writeLease({ plan_id: PEER_PLAN_ID, source_branch: "feature/plan-b" });
    const foreignSnapshot = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readJson(fixture.snapshotPath)).toEqual(foreignSnapshot);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");

    // One plan can integrate more than once, so a lease for another source
    // branch of this same plan is not this attempt's claim either.
    writeLease({ source_branch: "feature/plan-a-old" });
    const staleLeaseSnapshot = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readJson(fixture.snapshotPath)).toEqual(staleLeaseSnapshot);
    expect(recordField(snapshotOf(fixture), "integration_merge_lease").source_branch).toBe("feature/plan-a-old");

    // The attempt's own lease is still completable, and completing releases it.
    writeLease({});
    const done = await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    expect(done.outcome).toBe("completed");
    expect(recordField(handoffFields(planRowOf(fixture, PLAN_ID)), "integration").result_sha).toBe(mergeSha);
    expect(snapshotOf(fixture).integration_merge_lease).toBeUndefined();
  }, 30000);

  test("a replaced handoff is never transitioned by a command that named the old one (QC1-F-001)", async () => {
    const fixture = await acceptedFixture();
    const replaced = handoffFields(planRowOf(fixture, PLAN_ID)).id;
    expect((await coordinatorCall(fixture, PLAN_ID, { kind: "return", reason: "rework requested" })).outcome).toBe("returned");
    writeText(join(fixture.worktreePath, "slice.txt"), "slice B v2\n");
    git(["add", "-A"], fixture.worktreePath);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: rework"], fixture.worktreePath);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    await handoffCall(fixture, handoffEvidenceOf(fixture, headOf(fixture.worktreePath)));
    const live = handoffFields(planRowOf(fixture, PLAN_ID));
    expect(live.id).not.toBe(replaced);
    expect(live.attempt).toBe(2);

    // The id the caller read is a precondition of the mutation, not a hint: a
    // coordinator that read the replaced attempt can no longer act on whatever
    // is live when its command finally reaches the lock.
    const snapshotBefore = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "accept" }, replaced))).toBe(
      "coordination.handoff-pin",
    );
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("InReview");
    expect(handoffFields(row).id).toBe(live.id);
    expect(handoffFields(row).state).toBe("submitted");

    // The named live attempt is the one the command may act on.
    expect((await coordinatorCall(fixture, PLAN_ID, { kind: "accept" })).outcome).toBe("accepted");
  }, 30000);

  test("a git that answers with a failure still reports a repository fact, not an environment fault (QC3-001)", async () => {
    const fixture = await acceptedFixture();
    rmSync(fixture.worktreePath, { recursive: true, force: true });
    // git exits non-zero here: the repository was reachable and said "no such
    // worktree", so the refusal stays a Git-fact refusal (`not-in-git`) — the
    // new environment code must not swallow it.
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.not-in-git",
    );
  }, 30000);
});

/**
 * R2 — `gitRead` subprocess failure classification (spec §D2). A Git read that
 * never answers is unavailable evidence, not a repository answer: only a
 * numeric non-zero exit resolves to `undefined`; a read outliving the 10,000 ms
 * production timeout must surface the distinct public
 * `coordination.git-unavailable` code through an existing public operation.
 *
 * Each case prepares a valid handoff (real Git available) and then submits the
 * public handoff operation from its own child Bun process whose `PATH` holds
 * only that case's fixture directory, so the engine's real `execFileSync`
 * classifies a real subprocess outcome while the runner's PATH never changes.
 * Scope resolution consults Git before the handoff proof runs, so the fixture
 * `git` answers the scope probes by delegating to the real Git binary and
 * fails only the read `gitRead` itself makes — the documented production
 * scenario (a stalled filesystem, a contended lock). The hanging shim
 * exec-replaces into the runner's own Bun binary, so the killed child is the
 * shim itself and the fixture's cleanup reaps it.
 */
describe("gitRead subprocess failure classification", () => {
  /** How long a case child may run before the test kills and reaps it. */
  const CHILD_DEADLINE_MS = 60_000;

  /** What the child prints: the public operation's outcome or error shape. */
  type ChildHandoffReport = { outcome?: string; name?: string; code?: string; message?: string; cause?: string };

  /** A prepared, leased InReview plan with valid handoff evidence on disk. */
  async function handoffReadyFixture(): Promise<GitFixture> {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    return fixture;
  }

  function writeExecutable(path: string, lines: string[]): void {
    writeText(path, `${lines.join("\n")}\n`);
    chmodSync(path, 0o755);
  }

  /**
   * The fixture `git`: records every invocation, delegates to the real Git
   * binary, and handles only the target read (`git -C <worktree> rev-parse
   * HEAD`, the first read of the handoff proof) with the given body — so the
   * child really resolves `git` through its isolated PATH while the scope
   * probes still answer like the environment they model.
   */
  function writeFixtureGit(
    binDir: string,
    recordPath: string,
    worktreePath: string,
    targetBody: string[],
  ): void {
    // Resolve the real Git binary at fixture-write time (`command -v git`
    // equivalent) — hosts with Git outside /usr/bin keep the delegation
    // working, and a Git-less runner fails here loudly instead of inside
    // the child.
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
   * Resume the prepared plan session in one child process and submit the
   * public handoff with `PATH` pointing only at `binDir`. The child reports
   * the surfaced error shape (code, cause, message) as one JSON line.
   */
  async function handoffInChildWithBinDir(
    fixture: GitFixture,
    evidence: HandoffEvidence,
    binDir: string,
  ): Promise<{ report: ChildHandoffReport; stderr: string; elapsedMs: number }> {
    const evidencePath = join(fixture.root, "handoff-evidence.json");
    writeJson(evidencePath, evidence);
    const scriptPath = join(fixture.root, "child-handoff.ts");
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
      `  const handed = await mutatePlanCoordination({`,
      `    sessionPath,`,
      `    planId,`,
      `    expectedRevision: view.revision,`,
      `    operation: { kind: "handoff", evidence },`,
      `  });`,
      `  console.log(JSON.stringify({ outcome: handed.outcome }));`,
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
    const child = Bun.spawn(
      [process.execPath, scriptPath, fixture.root, fixture.harness, PLAN_ID, fixture.planSession, evidencePath],
      {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
        // The child resolves `git` through this PATH alone; the runner's own
        // PATH is never modified. (A minimal hand-built env makes the child
        // Bun process die of SIGTERM at startup on macOS, so the runner env
        // is carried and only PATH is re-pointed.)
        env: { ...process.env, PATH: binDir },
      },
    );
    const exitedInTime = await Promise.race([
      child.exited.then(() => true),
      sleep(CHILD_DEADLINE_MS).then(() => false),
    ]);
    if (!exitedInTime) child.kill();
    const exitCode = await child.exited;
    const elapsedMs = Date.now() - startedAt;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, `child stderr: ${stderr}\nchild stdout: ${stdout}`).toBe(0);
    return { report: JSON.parse(stdout) as ChildHandoffReport, stderr, elapsedMs };
  }

  test("a non-zero git exit stays a repository fact (not-in-git), not git-unavailable", async () => {
    const fixture = await handoffReadyFixture();
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    const binDir = join(fixture.root, "bin-nonzero");
    const recordPath = join(fixture.root, "shim-invocations.log");
    mkdirSync(binDir);
    writeFixtureGit(binDir, recordPath, fixture.worktreePath, ["exit 3"]);

    const { report } = await handoffInChildWithBinDir(fixture, evidence, binDir);

    // The isolated PATH really was in effect: the scope probes went through
    // the fixture git, and the target read reached the handoff proof.
    const shims = readFileSync(recordPath, "utf8");
    expect(shims).toContain("worktree list");
    expect(shims).toContain("-C " + fixture.worktreePath + " rev-parse HEAD");
    // `git` answered the proof's read with a numeric status, so `gitRead`
    // resolves `undefined` and the feature-checkout proof keeps its existing
    // repository-answer code rather than the environment code.
    expect(report.code).toBe("coordination.not-in-git");
    expect(report.code).not.toBe("coordination.git-unavailable");
    expect(report.message).toContain(fixture.worktreePath);
    // The refusal is non-advancing: the InReview row and its lease are intact.
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(leaseHolder(planRowOf(fixture, PLAN_ID))).toBe(readJson(fixture.planSession).session_id);
  }, 90_000);

  test("a git read that outlives the production timeout is refused as git-unavailable", async () => {
    const fixture = await handoffReadyFixture();
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    const binDir = join(fixture.root, "bin-hanging");
    const recordPath = join(fixture.root, "shim-invocations.log");
    mkdirSync(binDir);
    // The target read exec-replaces into the runner's own Bun binary: no
    // /usr/bin/env, no PATH-resolved sleep, no recursive git, and the process
    // the production timeout kills is the direct child itself.
    const hangScript = join(fixture.root, "hang-forever.js");
    writeText(hangScript, "setInterval(() => {}, 600000);\n");
    writeFixtureGit(binDir, recordPath, fixture.worktreePath, [
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(hangScript)}`,
    ]);

    const { report, elapsedMs } = await handoffInChildWithBinDir(fixture, evidence, binDir);

    // The shim really ran, and hung on the handoff proof's read.
    const shims = readFileSync(recordPath, "utf8");
    expect(shims).toContain("worktree list");
    expect(shims).toContain("-C " + fixture.worktreePath + " rev-parse HEAD");
    // The refusal came from the production timeout firing, not an instant
    // failure, and stays inside the child deadline with cleanup margin.
    expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
    expect(elapsedMs).toBeLessThan(CHILD_DEADLINE_MS);
    expect(report.code).toBe("coordination.git-unavailable");
    // The cause is the timed-out read — the distinct unavailable-Git cause.
    expect(report.cause).toContain("git did not answer within 10000ms");
    // The refusal is non-advancing: the InReview row and its lease are intact.
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(leaseHolder(planRowOf(fixture, PLAN_ID))).toBe(readJson(fixture.planSession).session_id);
  }, 90_000);

  test("a missing git executable is refused as git-unavailable at the handoff proof", async () => {
    const fixture = await handoffReadyFixture();
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    // An isolated PATH dir with nothing in it: the child's spawn of `git`
    // fails for real (ENOENT) — no shim, no mock, no production helper.
    const binDir = join(fixture.root, "bin-empty");
    mkdirSync(binDir);

    const { report } = await handoffInChildWithBinDir(fixture, evidence, binDir);

    // The refusal carries the spawn failure, not a repository answer: the
    // proof's read never ran, so nothing can claim a branch fact.
    expect(report.code).toBe("coordination.git-unavailable");
    expect(report.code).not.toBe("coordination.not-in-git");
    expect(report.cause).toContain("ENOENT");
    // The failed read is the handoff proof's own read at the pinned worktree,
    // proving the failure surfaced at the public handoff operation.
    expect(report.message).toContain(fixture.worktreePath);
    expect(report.message).toContain("git rev-parse HEAD");
    // The refusal is non-advancing: the InReview row and its lease are intact.
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(leaseHolder(planRowOf(fixture, PLAN_ID))).toBe(readJson(fixture.planSession).session_id);
  }, 90_000);
});
