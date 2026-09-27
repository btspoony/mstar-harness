import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createExecutionWorkflow,
  executionContextFor,
  initializeExecutionAuthority,
  initializeStore,
} from "@mstar-harness/engine";
import { Client, type JSONRPCMessage, type MessageExtraInfo, type Transport } from "@modelcontextprotocol/client";
import type { InvocationContext } from "@mstar-harness/commands";
import { createMcpServer } from "../src/server.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class MemoryTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  peer!: MemoryTransport;
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> { queueMicrotask(() => this.peer.onmessage?.(message)); }
  async close(): Promise<void> { this.onclose?.(); this.peer.onclose?.(); }
}

function transportPair(): readonly [MemoryTransport, MemoryTransport] {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-invocation-"));
  roots.push(root);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-q", "-b", "main"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const harness = path.join(root, ".mstar");
  const workflow = "wf-mcp";
  const plan = "plan-mcp";
  mkdirSync(harness, { recursive: true });
  return { root, harness, workflow, plan };
}

function context(cwd: string, signal: AbortSignal, effects: InvocationContext["effects"]): InvocationContext {
  return {
    cwd,
    controlRoot: path.join(cwd, ".mstar"),
    sessionId: undefined,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal,
    effects,
  };
}

type ToolResponse = { structuredContent?: unknown };

function resultEnvelope(response: ToolResponse): Record<string, unknown> {
  assert.ok(response.structuredContent && typeof response.structuredContent === "object");
  return response.structuredContent as Record<string, unknown>;
}

test("generated MCP calls preserve request-local session admission and host context", async () => {
  const data = fixture();
  const storeContext = { harnessDir: data.root };
  (await initializeStore(storeContext)).close();
  const initialized = await initializeExecutionAuthority(storeContext);
  const created = await createExecutionWorkflow(executionContextFor(storeContext, {
    source: "local",
    sessionId: "main-session",
    workflowId: data.workflow,
    role: "coordinator",
    planId: null,
  }), {
    entry: { id: data.workflow, type: "iteration", status: "running", started_at: "2026-09-26T00:00:00Z", dir: `workflows/${data.workflow}` } as never,
    snapshot: {
      schema_version: 1,
      id: data.workflow,
      type: "iteration",
      status: "running",
      started_at: "2026-09-26T00:00:00Z",
      updated_at: "2026-09-26T00:00:00Z",
      branch: { base: "main" },
      plans: [{ id: data.plan, plan_id: data.plan, title: "MCP fixture", file: `.mstar/plans/${data.plan}.md`, status: "Todo", metadata: { project_id: "_default" } }],
    } as never,
    expected: initialized.token,
    operationId: "create-fixture",
  });
  const workflowToken = (created.data as unknown as { workflows: Array<{ workflowToken: string }> }).workflows[0]!.workflowToken;

  const server = createMcpServer((_definition, _input, signal, _services, effects) => context(data.root, signal, effects));
  const client = new Client({ name: "invocation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = transportPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const bound = resultEnvelope(await client.callTool({
      name: "mstar_plan_bind",
      arguments: {
        execution: true,
        coordinator: true,
        workflow: data.workflow,
        harness: data.harness,
        expect: workflowToken,
        operation: "bind-main-session",
        sessionId: "main-session",
      },
    }));
    assert.equal(bound.status, "ok", JSON.stringify(bound));

    const wrongSession = resultEnvelope(await client.callTool({
      name: "mstar_plan_bind",
      arguments: {
        execution: true,
        coordinator: true,
        workflow: data.workflow,
        harness: data.harness,
        expect: workflowToken,
        operation: "bind-child-session",
        sessionId: "child-agent-session",
      },
    }));
    assert.equal(wrongSession.status, "refused");
    assert.equal(wrongSession.code, "execution.stale-token");

    const selectedHost = resultEnvelope(await client.callTool({
      name: "mstar_host_skill_root",
      arguments: { host: "opencode", skill: "mstar-roles" },
    }));
    assert.equal(selectedHost.status, "ok", JSON.stringify(selectedHost));
    assert.deepEqual(selectedHost.data, { root: "harness-skills/mstar-roles" });
  } finally {
    await client.close();
    await server.close();
  }
});
