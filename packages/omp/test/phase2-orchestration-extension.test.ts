import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { bindExecutionSession, createExecutionWorkflow, readExecutionState, registerCatalogEntity, initializeStore } from "@mstar-harness/engine";
import type { ExecutionCaller, ExecutionContext, WorkflowSnapshot } from "@mstar-harness/engine";
import { afterEachCleanup, makeFixture, WORKFLOW_ID, PLAN_ID } from "../../engine/test/support/coordination-fixtures.js";

afterEach(() => afterEachCleanup());

async function activeFixture() {
  const fixture = makeFixture();
  rmSync(join(fixture.harness, "status.json"), { force: true });
  rmSync(join(fixture.harness, "workflows"), { recursive: true, force: true });
  const store = { harnessDir: fixture.harness };
  (await initializeStore(store)).close();
  await registerCatalogEntity(store, { kind: "plan", id: PLAN_ID, title: PLAN_ID, rootKind: "plans", relativePath: `plans/${PLAN_ID}.md` }, { operationId: randomUUID(), actor: "phase2-orchestration-extension.test" });
  const caller: ExecutionCaller = { sessionId: "active-coordinator", role: "coordinator", workflowId: WORKFLOW_ID };
  const domain: ExecutionContext = { harnessDir: fixture.harness, caller };
  const snapshot: WorkflowSnapshot = { schema_version: 1, id: WORKFLOW_ID, type: "plan", status: "running", started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", plans: [{ id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "Todo" }] };
  const created = await createExecutionWorkflow(domain, { entry: { id: WORKFLOW_ID, type: "plan", started_at: snapshot.started_at, dir: `workflows/${WORKFLOW_ID}` }, snapshot, expected: (await readExecutionState(store)).token, operationId: "create-phase2-workflow" });
  const bound = await bindExecutionSession(domain, { workflowId: WORKFLOW_ID, expected: created.data.workflows[0]!.workflowToken, operationId: "bind-phase2-coordinator" });
  return { fixture, domain, session: bound.data };
}

describe("phase2 extension ACTIVE authority", () => {
  test("ACTIVE DB coordinator binding exists and is the execution authority", async () => {
    const { fixture, domain, session } = await activeFixture();
    const state = await readExecutionState({ harnessDir: fixture.harness });
    expect(session.workflowId).toBe(WORKFLOW_ID);
    expect(state.data.workflows[0]!.coordinator?.sessionId).toBe("active-coordinator");
    expect(state.data.workflows[0]!.planTokens).toHaveProperty(PLAN_ID);
    expect(domain.caller.sessionId).toBe("active-coordinator");
  });
});
