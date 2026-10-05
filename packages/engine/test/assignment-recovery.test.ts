import { createFsStore, setArtifactStore } from "../src/store.js";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
