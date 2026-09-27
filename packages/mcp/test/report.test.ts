import assert from "node:assert/strict";
import { test } from "bun:test";
import { executeCommand, getCommandDefinitions, type InvocationContext } from "@mstar-harness/commands";
import { Client, type JSONRPCMessage, type MessageExtraInfo, type Transport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createMcpServer } from "../src/server.js";
import { mcpToolName } from "../src/register.js";

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

const versions = Object.freeze({ engine: "synthetic-engine", cli: "synthetic-cli", plugin: null, host: null, platform: null });
const trap = async (): Promise<never> => { throw new Error("report unexpectedly invoked a command effect"); };
const effects: InvocationContext["effects"] = {
  readInput: trap,
  spawn: trap,
  startDashboard: trap,
  openBrowser: trap,
};

function context(): InvocationContext {
  return { cwd: "/foreign/cwd", controlRoot: null, versions, signal: new AbortController().signal, effects };
}

test("report matches exactly across the handler and MCP SDK with equal injected facts and no effects capability", async () => {
  const report = getCommandDefinitions().find(({ id }) => id === "report");
  assert.ok(report, "canonical report definition is registered");

  const input = {
    title: "synthetic report",
    command: "mstar status",
    expected: "works",
    actual: "fails",
    host: "synthetic-host",
    platform: "synthetic-platform",
    versionOverrides: { cli: "caller-cli", engine: "caller-engine", plugin: "caller-plugin" },
  };
  const cliResult = await executeCommand("report", input, context());
  assert.equal(cliResult.status, "ok");

  const [clientTransport, serverTransport] = transportPair();
  const client = new Client({ name: "report-effects-test", version: "1.0.0" });
  const server = createMcpServer((definition, _input, signal, _services, _effects) => ({
    cwd: "/foreign/cwd",
    controlRoot: null,
    versions,
    signal,
    effects,
  }), [report]);
  server.server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const tool = tools.tools.find(({ name }) => name === mcpToolName("report"));
    assert.ok(tool, "report tool is registered");
    assert.equal(Object.hasOwn(tool, "effects"), false, "MCP descriptor must not advertise command effects");
    assert.equal(Object.hasOwn(tool, "annotations") && Object.hasOwn(tool.annotations ?? {}, "effects"), false);

    const response = await client.callTool({
      name: mcpToolName("report"),
      arguments: input,
    });
    assert.equal(response.isError, false);
    assert.deepEqual(response.structuredContent, cliResult);
  } finally {
    await client.close();
    await server.close();
  }
});

test("report accepts secret-shaped synthetic text without invoking IO effects", async () => {
  const result = await executeCommand("report", {
    title: "token=ghp_abcdefghijklmnopqrstuvwxyz012345",
    command: "mstar status",
    host: "synthetic-host",
    platform: "synthetic-platform",
  }, context());
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const data = z.object({
    prompt: z.string(),
    redactions: z.array(z.object({ field: z.string(), count: z.number() })),
  }).parse(result.data);
  assert.ok(data.redactions.some(({ field }) => field === "title"));
  assert.doesNotMatch(data.prompt, /ghp_abcdefghijklmnopqrstuvwxyz012345/);
});
