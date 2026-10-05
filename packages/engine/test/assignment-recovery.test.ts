import { createFsStore, setArtifactStore } from "../src/store.js";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { mutatePlanCoordination, readPlanCoordination } from "../src/coordination.js";
import {
  PLAN_ID,
  afterEachCleanup,
  bindPlan,
  makeFixture,
  type Fixture,
  FIXTURE_COORDINATOR_ID,
  preparePlan,
  writeText,
} from "./support/coordination-fixtures.js";

afterEach(() => {
  afterEachCleanup();
});
async function recoverAssignment(
  fixture: Fixture,
  decision: "re-review" | "restore",
  expectedRevision: number,
) {
  return mutatePlanCoordination({
    sessionPath: fixture.coordinatorSession,
    planId: PLAN_ID,
    expectedRevision,
    operation: { kind: "recover-assignment", decision },
  });
}

test("bind after acknowledged re-review succeeds", async () => {
  const fixture = makeFixture();
  await preparePlan(fixture, PLAN_ID);
  const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
  const reviewedBytes = readFileSync(fixture.assignmentPath, "utf8");
  writeText(fixture.assignmentPath, reviewedBytes.replace("**QA gate**: mandatory", "**QA gate**: pm-acceptance"));
  await expect(bindPlan(fixture, PLAN_ID)).rejects.toMatchObject({ code: "coordination.assignment-stale" });

  const recovered = await recoverAssignment(fixture, "re-review", view.revision);
  expect(recovered.outcome).toBe("assignment-recovered");
  expect(recovered.view?.prepared?.recovery_history).toEqual([
    expect.objectContaining({ actor: FIXTURE_COORDINATOR_ID, decision: "re-review" }),
  ]);
  expect((await bindPlan(fixture, PLAN_ID)).outcome).toBe("claimed");
});

test("bind after restore of prepared bytes succeeds and a later edit refuses again", async () => {
  const fixture = makeFixture();
  await preparePlan(fixture, PLAN_ID);
  const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
  const reviewedBytes = readFileSync(fixture.assignmentPath, "utf8");
  writeText(fixture.assignmentPath, reviewedBytes.replace("**QA gate**: mandatory", "**QA gate**: pm-acceptance"));
  await expect(bindPlan(fixture, PLAN_ID)).rejects.toMatchObject({ code: "coordination.assignment-stale" });

  const recovered = await recoverAssignment(fixture, "restore", view.revision);
  expect(recovered.outcome).toBe("assignment-recovered");
  expect(recovered.view?.prepared?.recovery_history).toEqual([
    expect.objectContaining({ actor: FIXTURE_COORDINATOR_ID, decision: "restore" }),
  ]);
  expect(readFileSync(fixture.assignmentPath, "utf8")).toBe(reviewedBytes);
  expect((await bindPlan(fixture, PLAN_ID)).outcome).toBe("claimed");

  writeText(fixture.assignmentPath, reviewedBytes.replace("**QA gate**: mandatory", "**QA gate**: pm-acceptance"));
  await expect(bindPlan(fixture, PLAN_ID)).rejects.toMatchObject({ code: "coordination.assignment-stale" });
});

test("restore refusal discloses restored Assignment bytes when snapshot commit fails", async () => {
  const fixture = makeFixture();
  await preparePlan(fixture, PLAN_ID);
  const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
  const reviewedBytes = readFileSync(fixture.assignmentPath, "utf8");
  writeText(fixture.assignmentPath, reviewedBytes.replace("**QA gate**: mandatory", "**QA gate**: pm-acceptance"));
  const backing = createFsStore(fixture.harness);
  const originalPut = backing.put.bind(backing);
  backing.put = async (doc) => {
    if (doc.kind === "snapshot") throw new Error("injected snapshot commit failure");
    await originalPut(doc);
  };
  setArtifactStore(backing);
  try {
    await expect(recoverAssignment(fixture, "restore", view.revision)).rejects.toMatchObject({
      message: expect.stringContaining("injected snapshot commit failure"),
      details: {
        recovery: expect.objectContaining({
          outcome: "partial",
          applied: ["prepared Assignment bytes restored"],
          commitState: "partial",
        }),
      },
    });
  } finally {
    backing.put = originalPut;
    setArtifactStore(backing);
  }
  expect(readFileSync(fixture.assignmentPath, "utf8")).toBe(reviewedBytes);
});
test("file restore repairs malformed and retargeted assignment headers", async () => {
  const fixture = makeFixture();
  await preparePlan(fixture, PLAN_ID);
  const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
  const reviewedBytes = readFileSync(fixture.assignmentPath, "utf8");
  writeText(fixture.assignmentPath, "not a valid assignment");
  await expect(recoverAssignment(fixture, "restore", view.revision)).resolves.toMatchObject({
    outcome: "assignment-recovered",
  });
  expect(readFileSync(fixture.assignmentPath, "utf8")).toBe(reviewedBytes);
});

test("file restore remains addressable after assignment plan and workflow headers are retargeted", async () => {
  const fixture = makeFixture();
  await preparePlan(fixture, PLAN_ID);
  const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
  const reviewedBytes = readFileSync(fixture.assignmentPath, "utf8");
  const retargeted = reviewedBytes.replace(/(\*\*Plan id\*\*: )[^\n]+/, "$1other-plan")
    .replace(/(\*\*Workflow id\*\*: )[^\n]+/, "$1other-workflow");
  expect(retargeted).not.toBe(reviewedBytes);
  writeText(fixture.assignmentPath, retargeted);
  await expect(recoverAssignment(fixture, "restore", view.revision)).resolves.toMatchObject({
    outcome: "assignment-recovered",
  });
  expect(readFileSync(fixture.assignmentPath, "utf8")).toBe(reviewedBytes);
});

test("missing file re-review gives an explicit restore action and restore recreates the file", async () => {
  const fixture = makeFixture();
  await preparePlan(fixture, PLAN_ID);
  const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
  unlinkSync(fixture.assignmentPath);
  await expect(recoverAssignment(fixture, "re-review", view.revision)).rejects.toMatchObject({
    code: "coordination.assignment-stale",
    message: expect.stringContaining("restore"),
  });
  await expect(recoverAssignment(fixture, "restore", view.revision)).resolves.toMatchObject({
    outcome: "assignment-recovered",
  });
  expect(readFileSync(fixture.assignmentPath, "utf8")).toContain(`**Plan id**: ${PLAN_ID}`);
});

test("file recovery refuses a row owned by a foreign execution lease", async () => {
  const fixture = makeFixture();
  await preparePlan(fixture, PLAN_ID);
  const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
  await bindPlan(fixture, PLAN_ID);
  writeText(fixture.assignmentPath, "not a valid assignment");
  await expect(recoverAssignment(fixture, "restore", view.revision)).rejects.toMatchObject({
    code: "coordination.duplicate-holder",
  });
});
