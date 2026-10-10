import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
} from "../src/execution-store.js";
import { initializeStore, type StoreContext } from "../src/store-db.js";

const root = mkdtempSync(join(tmpdir(), "mstar-active-ownership-projection-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const workflowId = "wf-active-ownership";
const ts = "2026-09-18T00:00:00.000Z";
function caller(sessionId: string): ExecutionCaller {
  return { sessionId, role: "coordinator", workflowId };
}
function executionContext(harnessDir: string, identity: ExecutionCaller): ExecutionContext {
  return { harnessDir, caller: identity };
}

describe("ACTIVE execution ownership projection", () => {
  test("the durable coordinator binding owns the workflow and rejects a foreign holder", async () => {
    const harnessDir = mkdtempSync(join(root, "coordinator-"));
    mkdirSync(harnessDir, { recursive: true });
    const context: StoreContext = { harnessDir };
    const store = await initializeStore(context);
    store.close();
    const state = await readExecutionState(context);
    const owner = caller("session-original");
    const created = await createExecutionWorkflow(executionContext(harnessDir, owner), {
      entry: { id: workflowId, type: "plan", started_at: ts, dir: `workflows/${workflowId}` } as never,
      snapshot: {
        schema_version: 1,
        id: workflowId,
        type: "plan",
        status: "running",
        started_at: ts,
        updated_at: ts,
        phase: "phase-1-prepare",
        project: "harness",
        compass_ref: "iterations/iter-20260918-fixture/delivery-compass.md",
        delivery_kind: "development",
        branch: { base: "main", source: "feature/fixture", target: "main", integration: "integration/wf-active-ownership" },
        integration_worktree_path: join(harnessDir, "integration"),
        execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
        plans: [{ id: "fixture-plan", title: "Fixture plan", file: "plans/fixture-plan.md", status: "Todo" }],
      } as never,
      expected: state.token,
      operationId: "create-active-ownership",
    });
    const workflow = created.data.workflows.find((item) => item.state.id === workflowId);
    if (workflow === undefined) throw new Error("fixture: ACTIVE workflow was not created");
    const bound = await bindExecutionSession(executionContext(harnessDir, owner), {
      workflowId,
      expected: workflow.workflowToken,
      operationId: "bind-active-owner",
    });
    expect(bound.data.sessionId).toBe("session-original");
    await expect(bindExecutionSession(executionContext(harnessDir, caller("session-other")), {
      workflowId,
      operationId: "bind-foreign-owner",
    })).rejects.toMatchObject({ code: "execution.session-unavailable", details: { holder: "session-original" } });
  });
});
