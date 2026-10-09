/**
 * ACTIVE prepare control-checkout branch guard.
 *
 * The Prepare workflow amendment and the file-route coordinator-call families
 * are retired and their cases are gone. What survives from the original file is
 * the ACTIVE route's own branch guard: `prepareExecutionPlan` on a DB workflow
 * must name the workflow's real working branch, never a protected control branch
 * — refused for both delivery kinds, accepted for a feature branch, and
 * fail-closed when the control branch cannot be probed or the control checkout
 * is detached. The fixture creates a real ACTIVE execution workflow and binds
 * its coordinator through `bindExecutionSession`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCatalogEntity } from "../src/catalog.js";
import { prepareExecutionPlan } from "../src/execution-coordination.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
} from "../src/execution-store.js";
import { initializeStore, type StoreContext } from "../src/store-db.js";
import type { WorkflowSnapshot } from "../src/workflow.js";
import {
  FIXTURE_COORDINATOR_ID,
  PLAN_ID,
  WORKFLOW_ID,
  afterEachCleanup,
  git,
  makeFixture,
  type Fixture,
} from "./support/coordination-fixtures.js";

afterEach(() => afterEachCleanup());

/**
 * An ACTIVE execution workflow over the fixture harness: the fixture's live
 * file-route seeds (`status.json`, `workflows/`) are removed so the store is a
 * genuinely empty execution workspace, then `store init` activates the
 * authority, the plan is registered, the workflow is created and its
 * coordinator bound.
 */
async function dbPrepareFixture(deliveryKind: "development" | "verification/report-only" = "development") {
  const fixture: Fixture = makeFixture();
  const context: StoreContext = { harnessDir: fixture.harness };
  rmSync(join(fixture.harness, "status.json"), { force: true });
  rmSync(join(fixture.harness, "workflows"), { recursive: true, force: true });
  (await initializeStore(context)).close();
  await registerCatalogEntity(context, { kind: "plan", id: PLAN_ID, title: PLAN_ID, rootKind: "plans", relativePath: `plans/${PLAN_ID}.md` }, {
    operationId: "register-prepare-guard-plan",
    actor: "coordination-prepare.test",
  });
  const caller: ExecutionCaller = { sessionId: FIXTURE_COORDINATOR_ID, role: "coordinator", workflowId: WORKFLOW_ID };
  const domain: ExecutionContext = { harnessDir: context.harnessDir, caller };
  const snapshot: WorkflowSnapshot = {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    status: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    delivery_kind: deliveryKind,
    ...(deliveryKind === "verification/report-only" ? { completion_policy: "report" } : {}),
    plans: [{ id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "Todo" }],
  };
  const created = await createExecutionWorkflow(domain, {
    entry: { id: WORKFLOW_ID, type: "plan", started_at: "2026-01-01T00:00:00.000Z", dir: `workflows/${WORKFLOW_ID}` },
    snapshot,
    expected: (await readExecutionState(context)).token,
    operationId: "create-prepare-guard-workflow",
  });
  const bound = await bindExecutionSession(domain, {
    workflowId: WORKFLOW_ID,
    expected: created.data.workflows[0]!.workflowToken,
    operationId: "bind-prepare-guard-coordinator",
  });
  const state = await readExecutionState(context);
  return { fixture, domain, session: bound.data, token: state.data.workflows[0]!.planTokens[PLAN_ID]! };
}

describe("prepare control checkout branch guard", () => {
  for (const deliveryKind of ["development", "verification/report-only"] as const) {
    test(`refuses the control branch for ${deliveryKind}`, async () => {
      const { domain, session, token } = await dbPrepareFixture(deliveryKind);
      await expect(
        prepareExecutionPlan(domain, {
          operationId: "prepare-control-branch",
          session,
          expected: token,
          planId: PLAN_ID,
          operation: { kind: "prepare", config: { workingBranch: "main" } },
        }),
      ).rejects.toMatchObject({ code: "plan.prepare.working-branch-control" });
    });
  }

  test("continues to accept a feature branch", async () => {
    const { domain, session, token } = await dbPrepareFixture();
    await expect(
      prepareExecutionPlan(domain, {
        operationId: "prepare-feature-branch",
        session,
        expected: token,
        planId: PLAN_ID,
        operation: { kind: "prepare", config: { workingBranch: "feature/plan-a" } },
      }),
    ).resolves.toMatchObject({ data: { coordination: { prepared: { qa_gate: "mandatory" } } } });
  });

  test("fails closed when the control branch cannot be probed", async () => {
    const { domain, session, token } = await dbPrepareFixture();
    const shim = mkdtempSync(join(tmpdir(), "prepare-no-git-"));
    const fakeGit = join(shim, "git");
    writeFileSync(fakeGit, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeGit, 0o755);
    const priorPath = process.env.PATH;
    try {
      process.env.PATH = shim;
      await expect(
        prepareExecutionPlan(domain, {
          operationId: "prepare-unresolved-control-branch",
          session,
          expected: token,
          planId: PLAN_ID,
          operation: { kind: "prepare", config: { workingBranch: "feature/plan-a" } },
        }),
      ).rejects.toMatchObject({ code: "plan.prepare.control-branch-unresolved" });
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      rmSync(shim, { recursive: true, force: true });
    }
  });

  test("fails closed for a detached control checkout", async () => {
    const { fixture, domain, session, token } = await dbPrepareFixture();
    git(["checkout", "--detach", "HEAD"], fixture.root);
    await expect(
      prepareExecutionPlan(domain, {
        operationId: "prepare-detached-control-branch",
        session,
        expected: token,
        planId: PLAN_ID,
        operation: { kind: "prepare", config: { workingBranch: "feature/plan-a" } },
      }),
    ).rejects.toMatchObject({ code: "plan.prepare.control-branch-unresolved" });
  });
});
