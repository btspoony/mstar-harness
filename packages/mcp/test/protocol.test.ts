import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "bun:test";
import { Client, type JSONRPCMessage, type MessageExtraInfo, type Transport } from "@modelcontextprotocol/client";
import { getCommandDefinitions, getJudgmentCommandDefinitions, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";
import { z } from "zod";
import { createMcpEffects, type McpEffects } from "../src/effects.js";
import { mcpToolName } from "../src/register.js";
import { createMcpServer } from "../src/server.js";

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

function context(input: unknown, signal: AbortSignal, services: Array<{ close(): Promise<void> }>): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal,
    effects: createMcpEffects(services),
  };
}

test("judgment consumes request-local stdin data rather than MCP protocol framing", async () => {
  const payload = "{\"kind\":\"review-pack\"}";
  let consumed = "";
  const [definition] = getJudgmentCommandDefinitions(async ({ readInput }) => {
    consumed = await readInput();
    return { schema: "review-pack", contractRevision: "fixture-r1", status: "recorded", advice: null };
  });
  assert.ok(definition);
  const effects = createMcpEffects([]);
  const signal = new AbortController().signal;
  const invocation = { ...context({ input: payload }, signal, []), effects };
  const result = await effects.withInput({ input: payload }, invocation, () =>
    definition.execute({ pilot: "synthetic", stdin: true }, invocation));
  assert.equal(consumed, payload);
  assert.equal(result.status, "ok");
  assert.ok(result.data && typeof result.data === "object" && "status" in result.data);
  assert.equal(result.data.status, "recorded");
});

test("MCP closes sibling services when a service close rejects during transport EOF", async () => {
  const closed = Promise.withResolvers<void>();
  const siblingClosed = Promise.withResolvers<void>();
  const definition = getCommandDefinitions().find(({ id }) => id === "dashboard");
  assert.ok(definition);
  const resolveContext = (_definition: CommandDefinition, input: unknown, signal: AbortSignal, services: Array<{ close(): Promise<void> }>, effects: McpEffects) => {
    services.push({ async close() { throw new Error("expected service close failure"); } });
    services.push({ async close() { siblingClosed.resolve(); } });
    const invocation = { ...context(input, signal, services), controlRoot: "/tmp" };
    effects.startDashboard = async () => {
      const http = createServer((_request, response) => { response.end("alive"); });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      assert.ok(address && typeof address === "object");
      const handle = {
        url: `http://127.0.0.1:${address.port}`,
        async close() {
          await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
          closed.resolve();
        },
      };
      services.push(handle);
      return handle;
    };
    return invocation;
  };
  const server = createMcpServer(resolveContext, [definition]);
  const client = new Client({ name: "dashboard-lifetime-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = transportPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: mcpToolName(definition.id), arguments: { port: 0 } });
  const structured = result.structuredContent;
  assert.ok(structured && typeof structured === "object" && "data" in structured, JSON.stringify(result));
  const data = structured.data;
  assert.ok(data && typeof data === "object" && "url" in data && typeof data.url === "string" && "lifetime" in data);
  assert.equal(data.lifetime, "connection");
  assert.equal(await (await fetch(data.url)).text(), "alive");
  await client.close();
  await closed.promise;
  await siblingClosed.promise;
  await assert.rejects(fetch(data.url));
  await server.close();
});

test("MCP server serves initialize-era protocol clients", async () => {
  const definition: CommandDefinition = {
    id: "fixture.legacy",
    cli: { path: ["fixture", "legacy"], aliases: [], arguments: [], options: [] },
    input: z.object({}),
    output: z.any(),
    effects: [],
    description: "legacy fixture tool",
    async execute() { return { version: 1, command: "fixture.legacy", status: "ok", code: "fixture.ok", exitCode: 0, data: {} }; },
  };
  const server = createMcpServer((_definition, input, signal, services) => context(input, signal, services), [definition]);
  const [clientTransport, serverTransport] = transportPair();
  const initialize = Promise.withResolvers<JSONRPCMessage>();
  const listed = Promise.withResolvers<JSONRPCMessage>();
  clientTransport.onmessage = (message) => {
    if ("id" in message && message.id === 1) initialize.resolve(message);
    if ("id" in message && message.id === 2) listed.resolve(message);
  };
  await server.connect(serverTransport);
  await clientTransport.start();
  await clientTransport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "initialize-era-test", version: "1.0.0" } } });
  const initialized = await initialize.promise;
  assert.ok("result" in initialized);
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await clientTransport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = await listed.promise;
  assert.ok("result" in tools, JSON.stringify(tools));
  assert.deepEqual((tools.result as { tools: unknown[] }).tools.map((tool) => (tool as { name: string }).name), ["mstar_fixture_legacy"]);
  await clientTransport.close();
  await server.close();
});
