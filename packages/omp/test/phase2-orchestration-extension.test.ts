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

type ToolResult = { content: Array<{ text: string }>; details: Record<string, unknown> & { mstarPhase2?: { code?: string; applied?: boolean } }; isError?: boolean };
type ToolDefinition = { name: string; description: string; parameters: { parse(value: unknown): unknown }; execute(id: string, params: unknown, signal: unknown, update: unknown, ctx: ExtensionContext): Promise<ToolResult> };

function phase2Host(cwd: string, sessionId = "active-coordinator") {
  const entries: SessionEntry[] = [];
  const tools: ToolDefinition[] = [];
  const messages: unknown[] = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let snapshot: unknown = { running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } };
  const api = {
    zod,
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data } as unknown as SessionEntry),
    sendMessage: (message: unknown) => messages.push(message),
  } as unknown as ExtensionAPI;
  phase2Orchestration(api);
  const tool = tools.find(({ name }) => name === "mstar_phase2");
  if (tool === undefined) throw new Error("phase2 extension did not register its consumer tool");
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
    getAsyncJobSnapshot: () => snapshot,
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;
  return {
    description: tool.description,
    entries,
    messages,
    setSnapshot: (value: unknown) => { snapshot = value; },
    emit: async (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx),
    call: async (params: Record<string, unknown>) => tool.execute("test-call", tool.parameters.parse(params), undefined, undefined, ctx),
  };
}

function jobSnapshot(running: readonly Readonly<{ id: string; type: string; status: string }>[], recent: readonly Readonly<{ id: string; status: string }>[], pendingJobIds: readonly string[] = []) {
  return { running, recent, delivery: { queued: pendingJobIds.length, delivering: false, pendingJobIds } };
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

  test("foreign coordinators cannot bind the ACTIVE observation", async () => {
    const { fixture } = await activeFixture();
    const host = phase2Host(fixture.root, "foreign-coordinator");
    const result = await host.call({ operation: "bind", workflowId: WORKFLOW_ID });
    expect(result.isError).toBe(true);
    expect(result.details.mstarPhase2?.code).toBe("phase2.coordinator-mismatch");
    expect(host.entries).toEqual([]);
  });

  test("ACTIVE coordinator receives bounded reminders once per changed running observation", async () => {
    const { fixture } = await activeFixture();
    const host = phase2Host(fixture.root);
    await host.call({ operation: "bind", workflowId: WORKFLOW_ID });
    host.setSnapshot(jobSnapshot([{ id: "job-1", type: "task", status: "running" }], []));
    await host.emit("agent_end");
    await host.emit("agent_end");
    expect(host.messages).toHaveLength(1);
    host.setSnapshot(jobSnapshot([{ id: "job-2", type: "task", status: "running" }], []));
    await host.emit("agent_end");
    expect(host.messages).toHaveLength(2);
    expect(host.entries.filter((entry) => entry.type === "custom" && entry.customType === PHASE2_CUSTOM_TYPE)).toHaveLength(3);
  });

  test("native completion delivery suppresses a duplicate ACTIVE reminder", async () => {
    const { fixture } = await activeFixture();
    const host = phase2Host(fixture.root);
    await host.call({ operation: "bind", workflowId: WORKFLOW_ID });
    host.setSnapshot(jobSnapshot([{ id: "job-1", type: "task", status: "running" }], []));
    await host.emit("agent_end");
    host.setSnapshot(jobSnapshot([], [{ id: "job-1", status: "completed" }], ["job-1"]));
    await host.emit("agent_end");
    expect(host.messages).toHaveLength(1);
  });

  test("export-history returns this session's canonical digest without changing ACTIVE binding state", async () => {
    const { fixture } = await activeFixture();
    const host = phase2Host(fixture.root);
    await host.call({ operation: "bind", workflowId: WORKFLOW_ID });
    const before = host.entries.length;
    const result = await host.call({ operation: "export-history", workflowId: WORKFLOW_ID });
    expect(result.details.mstarPhase2).toMatchObject({ code: "exported", workflowId: WORKFLOW_ID, hostSessionId: "active-coordinator" });
    expect(result.details.mstarPhase2?.exportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.details.mstarPhase2?.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ workflowId: WORKFLOW_ID, hostSessionId: "active-coordinator" });
    expect(host.entries).toHaveLength(before);
  });
});

