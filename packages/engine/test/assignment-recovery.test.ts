/**
 * Recovery behavior on the removed-seat model.
 *
 * The original suite drove the plan-PM seat's sealed-Assignment admission gate:
 * editing an Assignment file made `bindPlan` refuse
 * `coordination.assignment-stale`, and the deleted `recover-assignment`
 * operation (`re-review` / `restore`) cleared the seal so a later bind could
 * claim the row. PR #405 deleted the seat, the seal, the operation and the
 * fixture helpers (`preparePlan` / `bindPlan`) the suite imported, so the file
 * no longer loaded at all.
 *
 * What the landed surface still owns is the recovery SIDECAR contract: every
 * coordinator call reports one `RecoveryDetails` object — under
 * `result.recovery` on success, under `error.details.recoveryFacts` on refusal — with
 * the same seven fields (outcome, target, applied, unresolved, resolvedFrom,
 * warnings, commitState). There is no sealed Assignment to go stale: the
 * Assignment file is prose beside the row that no coordinator operation reads,
 * so editing it changes nothing, and an unchanged `prepare` config is answered
 * `already-satisfied` without a write. These cases pin that contract.
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readPlanCoordination } from "../src/coordination.js";
import { CoordinationError } from "../src/coordination-write.js";
import {
  PLAN_ID,
  WORKFLOW_ID,
  afterEachCleanup,
  assignmentText,
  coordinatorCall,
  ensureCoordinator,
  failureCode,
  failureOf,
  makeFixture,
  prepareCall,
  progressCall,
  type Fixture,
  FIXTURE_COORDINATOR_ID,
  writeText,
} from "./support/coordination-fixtures.js";

afterEach(() => {
  afterEachCleanup();
});

/**
 * The fixture plan's own addressable source config. Six cases below must name
 * the same checkout/branch pair, so the pair lives here.
 */
function configOf(fixture: Fixture): { worktreePath: string; workingBranch: string } {
  return { worktreePath: fixture.worktreePath, workingBranch: "feature/plan-a" };
}

test("editing or deleting the Assignment file is inert: an unchanged prepare is already satisfied and writes nothing", async () => {
  const fixture = makeFixture();
  await ensureCoordinator(fixture);

  const first = await prepareCall(fixture, PLAN_ID, configOf(fixture));
  expect(first.outcome).toBe("prepared");
  expect(first.view?.prepared?.prepared_by).toBe(FIXTURE_COORDINATOR_ID);
  expect(first.recovery).toMatchObject({ outcome: "applied", commitState: "committed" });
  expect(first.recovery?.target).toMatchObject({ workflowId: WORKFLOW_ID, planId: PLAN_ID });

  // The exact edit the removed suite used to trip the seal: the Assignment's
  // QA-gate line. Nothing reads it, so the row's own preparation is untouched.
  const assignmentPath = join(fixture.sddDir, "assignment.md");
  const reviewedBytes = assignmentText({
    harness: fixture.harness,
    planId: PLAN_ID,
    planPath: fixture.planPath,
    worktreePath: fixture.worktreePath,
    sddDir: fixture.sddDir,
    branch: "feature/plan-a",
    note: "Assignment prose written after preparation.",
  });
  writeText(assignmentPath, reviewedBytes.replace("**QA gate**: mandatory", "**QA gate**: pm-acceptance"));
  const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

  const replayed = await prepareCall(fixture, PLAN_ID, configOf(fixture));
  expect(replayed.outcome).toBe("already-satisfied");
  expect(replayed.recovery).toMatchObject({ outcome: "already-satisfied", applied: [], commitState: "none" });
  expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);

  // Deleting the file is not a fact either: a missing Assignment is not a stale
  // seal, so the same call stays satisfied and still writes nothing.
  unlinkSync(assignmentPath);
  const afterDelete = await prepareCall(fixture, PLAN_ID, configOf(fixture));
  expect(afterDelete.outcome).toBe("already-satisfied");
  expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);

  // The ordinary landed flow continues from the untouched row.
  const progressed = await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "after the prose edit", evidence_paths: [] });
  expect(progressed.outcome).toBe("progressed");
});

test("a live refusal reports the same sidecar as unresolved, and an active row still takes a real config revision", async () => {
  const fixture = makeFixture();
  await ensureCoordinator(fixture);
  await prepareCall(fixture, PLAN_ID, configOf(fixture));

  // The surviving refusal family is the row's own state machine. Its refusal
  // carries the SAME sidecar object, now `unresolved`, naming the component and
  // path that blocked it — and it commits nothing. Todo cannot jump to InReview.
  const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");
  const refusal = await failureOf(() =>
    coordinatorCall(fixture, PLAN_ID, { kind: "progress", progress: { status: "InReview", summary: "skips InProgress", evidence_paths: [] } }),
  );
  if (!(refusal instanceof CoordinationError)) throw refusal;
  expect(refusal.code).toBe("coordination.progress-transition");
  expect(refusal.details.recoveryFacts).toMatchObject({
    outcome: "unresolved",
    target: { workflowId: WORKFLOW_ID, planId: PLAN_ID },
    applied: [],
    commitState: "none",
    unresolved: [expect.objectContaining({ component: "plan-row", code: "coordination.progress-transition" })],
  });
  expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);

  await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "start", evidence_paths: [] });
  // `qaGate` was a sealed Assignment field on the removed model, clearable only
  // by `recover-assignment`; on the landed model it is ordinary revisable
  // configuration, so a genuine change commits straight through an active row.
  const revised = await prepareCall(fixture, PLAN_ID, { ...configOf(fixture), qaGate: "pm-acceptance" });
  expect(revised.outcome).toBe("prepared");
  expect(revised.view?.prepared?.qa_gate).toBe("pm-acceptance");
  expect(revised.recovery).toMatchObject({ outcome: "applied", commitState: "committed" });

  // The transition the refusal above blocked is reachable once the row is
  // active, and the landed row then admits every operation including `complete`.
  const reviewed = await progressCall(fixture, PLAN_ID, { status: "InReview", summary: "reviewing", evidence_paths: [] });
  expect(reviewed.outcome).toBe("progressed");
  expect(reviewed.view?.allowed_operations).toEqual(["prepare", "progress", "residual-add", "residual-close", "complete"]);
});

test("the removed seat's recovery vocabulary is gone from the surface, never aliased", async () => {
  const fixture = makeFixture();
  await ensureCoordinator(fixture);
  await prepareCall(fixture, PLAN_ID, configOf(fixture));

  // Both decisions of the deleted `recover-assignment` operation are unknown
  // operations now: a caller still driving the old flow is told so explicitly,
  // with the operation named and no recovery sidecar to mistake for applied work.
  for (const decision of ["re-review", "restore"] as const) {
    const refusal = await failureOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "recover-assignment", decision }));
    expect(failureCode(refusal)).toBe("coordination.unknown-operation");
    expect(refusal.message).toContain("recover-assignment");
    if (!(refusal instanceof CoordinationError)) throw refusal;
    expect(refusal.details.recoveryFacts).toBeUndefined();
  }

  // The landed operation set is exactly the coordinator verbs: no seat recovery,
  // and the sealed-Assignment `recovery_history` the old suite asserted is gone
  // rather than left behind as an empty record.
  const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
  expect(view.allowed_operations).toEqual(["prepare", "progress", "residual-add", "residual-close"]);
  expect(view.prepared).toBeDefined();
  expect(view.prepared).not.toHaveProperty("recovery_history");
});
