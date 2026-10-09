import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { initializeStore, readExecutionState, registerCatalogEntity, createExecutionWorkflow, bindExecutionSession } from "@mstar-harness/engine";
import type { ExecutionCaller, ExecutionContext, WorkflowSnapshot } from "@mstar-harness/engine";
import { afterEachCleanup, makeFixture, WORKFLOW_ID, PLAN_ID } from "../../engine/test/support/coordination-fixtures.js";
import { executionBindingOf } from "../src/coordinator-identity";
import { inspectPhase1Readiness, reserveHandoffBinding } from "../src/model-handoff-readiness";
import type { HandoffBinding, Phase1CompletionInput } from "../src/model-handoff-readiness";
import mstarGates from "../src/hooks/pre/mstar-gates";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

afterEach(() => afterEachCleanup());

async function activeFixture() {
  const fixture = makeFixture();
  rmSync(fixture.harness, { recursive: true, force: true });
  mkdirSync(join(fixture.harness, "workflows"), { recursive: true });
  mkdirSync(join(fixture.harness, "projects"), { recursive: true });
  const store = { harnessDir: fixture.harness };
  (await initializeStore(store)).close();
  await registerCatalogEntity(store, { kind: "plan", id: PLAN_ID, title: PLAN_ID, rootKind: "plans", relativePath: `plans/${PLAN_ID}.md` }, { operationId: "register-prerequisite-plan", actor: "prerequisite-handoff.test" });
  const caller: ExecutionCaller = { sessionId: "active-coordinator", role: "coordinator", workflowId: WORKFLOW_ID };
  const domain: ExecutionContext = { harnessDir: fixture.harness, caller };
  const snapshot: WorkflowSnapshot = { schema_version: 1, id: WORKFLOW_ID, type: "plan", status: "running", started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", plans: [{ id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "Todo" }] };
  const created = await createExecutionWorkflow(domain, { entry: { id: WORKFLOW_ID, type: "plan", started_at: snapshot.started_at, dir: `workflows/${WORKFLOW_ID}` }, snapshot, expected: (await readExecutionState(store)).token, operationId: "create-prerequisite-workflow" });
  const bound = await bindExecutionSession(domain, { workflowId: WORKFLOW_ID, expected: created.data.workflows[0]!.workflowToken, operationId: "bind-prerequisite-coordinator" });
  writeFileSync(join(fixture.harness, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-01-01", workflows: [] }));
  mkdirSync(join(fixture.harness, "workflows", WORKFLOW_ID), { recursive: true });
  writeFileSync(join(fixture.harness, "workflows", WORKFLOW_ID, "snapshot.json"), JSON.stringify({ schema_version: 1, id: WORKFLOW_ID, status: "running" }));
  return { fixture, session: bound.data, executionBinding: executionBindingOf(fixture.harness, bound.data) };
}

const handoffInput = { workflowId: WORKFLOW_ID, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" } as const;

describe("ACTIVE prerequisite handoff and write gates", () => {
  test("an ACTIVE graph refuses file-binding reservation without an adopted DB binding", async () => {
    const { fixture } = await activeFixture();

    const result = await reserveHandoffBinding(handoffInput, { sessionId: "active-coordinator", cwd: fixture.root, taskSession: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("execution.consumer-not-ready");
      expect(result.message).toContain("ACTIVE coordinator DB binding");
    }
  });

  test("a foreign host session cannot adopt the ACTIVE coordinator binding", async () => {
    const { fixture, executionBinding } = await activeFixture();
    const result = await reserveHandoffBinding(handoffInput, {
      sessionId: "different-host-session",
      cwd: fixture.root,
      taskSession: false,
      executionBinding,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not-coordinator");
  });

  test("ACTIVE readiness decisions come from the DB workflow, not retired file documents", async () => {
    const { fixture, executionBinding } = await activeFixture();
    const binding: HandoffBinding = {
      sessionId: "active-coordinator",
      workflowId: WORKFLOW_ID,
      controlRoot: fixture.root,
      harnessRoot: fixture.harness,
      compassPath: join(fixture.harness, "iterations", WORKFLOW_ID, "delivery-compass.md"),
      executionBinding,
    };
    const input: Phase1CompletionInput = { workflowId: WORKFLOW_ID, mainWorktreeBranch: "main", reviews: [], plans: [] };
    const readiness = await inspectPhase1Readiness(binding, input);
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) expect(readiness.codes).toContain("binding-invalid");
  });

  test("ACTIVE coordination-document writes are refused while ordinary writes pass", async () => {
    const { fixture } = await activeFixture();
    let handler: ((event: { toolName: string; input: unknown }) => Promise<unknown>) | undefined;
    mstarGates({
      on: (_event, callback) => { handler = callback as typeof handler; },
      logger: { warn: () => undefined, error: () => undefined },
    } as unknown as ExtensionAPI);
    if (handler === undefined) throw new Error("mstar-gates did not register its tool_call entry");

    expect(await handler({ toolName: "write", input: { path: join(fixture.root, "notes.md"), content: "note" } })).toBeUndefined();
    for (const path of [join(fixture.harness, "status.json"), join(fixture.harness, "workflows", WORKFLOW_ID, "snapshot.json")]) {
      const result = await handler({ toolName: "write", input: { path, content: JSON.stringify({ version: 2, workflows: [] }) } });
      if (result === undefined) throw new Error(`ACTIVE write was not classified: ${path}`);
      expect(result).toMatchObject({ block: true });
      if (typeof result !== "object" || result === null || !("reason" in result) || typeof result.reason !== "string") {
        throw new Error("the ACTIVE document refusal omitted its reason");
      }
      expect(result.reason).toContain("execution.direct-write-refused");
    }
  });
});
