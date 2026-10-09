import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { bindExecutionSession, createExecutionWorkflow, readExecutionState, registerCatalogEntity, initializeStore } from "@mstar-harness/engine";
import type { ExecutionCaller, ExecutionContext, WorkflowSnapshot } from "@mstar-harness/engine";
import { afterEachCleanup, makeFixture, WORKFLOW_ID, PLAN_ID } from "../../engine/test/support/coordination-fixtures.js";
import { PHASE2_CUSTOM_TYPE, PHASE2_PHASE, default as phase2Orchestration, derivePhase2State } from "../src/extensions/phase2-orchestration";

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
  const snapshot: WorkflowSnapshot = { schema_version: 1, id: WORKFLOW_ID, type: "plan", status: "running", phase: PHASE2_PHASE, started_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", plans: [{ id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "Todo" }] };
  const created = await createExecutionWorkflow(domain, { entry: { id: WORKFLOW_ID, type: "plan", started_at: snapshot.started_at, dir: `workflows/${WORKFLOW_ID}` }, snapshot, expected: (await readExecutionState(store)).token, operationId: "create-phase2-workflow" });
  const bound = await bindExecutionSession(domain, { workflowId: WORKFLOW_ID, expected: created.data.workflows[0]!.workflowToken, operationId: "bind-phase2-coordinator" });
  mkdirSync(join(fixture.harness, "workflows", WORKFLOW_ID), { recursive: true });
  writeFileSync(join(fixture.harness, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-01-01", workflows: [] }));
  writeFileSync(join(fixture.harness, "workflows", WORKFLOW_ID, "snapshot.json"), JSON.stringify({ schema_version: 1, id: WORKFLOW_ID, status: "completed" }));
  return { fixture, domain, session: bound.data };
}

type ToolResult = { content: Array<{ text: string }>; details: { mstarPhase2?: { code?: string; applied?: boolean } }; isError?: boolean };
type ToolDefinition = { name: string; description: string; parameters: { parse(value: unknown): unknown }; execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionContext): Promise<ToolResult> };

function phase2Host(cwd: string) {
  const entries: SessionEntry[] = [];
  const tools: ToolDefinition[] = [];
  const api = {
    zod,
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: () => undefined,
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data } as unknown as SessionEntry),
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  phase2Orchestration(api);
  const tool = tools.find(({ name }) => name === "mstar_phase2");
  if (tool === undefined) throw new Error("phase2 extension did not register its consumer tool");
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => "active-coordinator", getEntries: () => entries },
    getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } }),
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;
  return {
    description: tool.description,
    entries,
    call: async (params: Record<string, unknown>) => tool.execute("test-call", tool.parameters.parse(params), undefined, undefined, ctx),
  };
}

describe("phase2 extension ACTIVE authority", () => {
  test("bind and checkpoint use the extension entry against the ACTIVE coordinator binding", async () => {
    const { fixture, session } = await activeFixture();
    const host = phase2Host(fixture.root);
    expect(host.description).toContain("ACTIVE DB coordinator binding");
    expect(host.description).not.toMatch(/pre-activation|envelope/i);

    const bound = await host.call({ operation: "bind", workflowId: WORKFLOW_ID });
    if (bound.isError === true) throw new Error(JSON.stringify(bound));
    expect(bound.details.mstarPhase2).toMatchObject({ code: "bound", applied: true, workflowId: WORKFLOW_ID, storeId: session.storeId, epoch: session.epoch });
    const state = derivePhase2State(host.entries, "active-coordinator");
    expect(state.binding?.executionBinding.session).toEqual(session);

    const checkpoint = await host.call({ operation: "checkpoint", reason: "before-wait", decision: "wait", note: "re-evaluated the scheduling checkpoint" });
    expect(checkpoint.isError).not.toBe(true);
    expect(checkpoint.details.mstarPhase2?.code).toBe("recorded");
    expect(host.entries.filter((entry) => entry.type === "custom" && entry.customType === PHASE2_CUSTOM_TYPE)).toHaveLength(2);
  });

  test("ACTIVE checkpoint refuses without this session's observation binding", async () => {
    const { fixture } = await activeFixture();
    const host = phase2Host(fixture.root);
    const result = await host.call({ operation: "checkpoint", reason: "before-wait", decision: "wait", note: "unbound coordinator" });
    expect(result.isError).toBe(true);
    expect(result.details.mstarPhase2?.code).toBe("phase2.not-bound");
    expect(host.entries).toEqual([]);
  });
});
