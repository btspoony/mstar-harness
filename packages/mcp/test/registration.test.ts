import assert from "node:assert/strict";
import { test } from "bun:test";
import { Client, type JSONRPCMessage, type MessageExtraInfo, type Transport } from "@modelcontextprotocol/client";
import { getCommandDefinitions, type CommandDefinition } from "@mstar-harness/commands";
import { z } from "zod";
import { createMcpServer } from "../src/server.js";
import { mcpToolName, registerMcpCommands } from "../src/register.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const record = Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]));
    const branches = record.oneOf;
    if (record.type === "object" && Array.isArray(branches) && branches.every((branch) => typeof branch === "object" && branch !== null && (branch as Record<string, unknown>).type === "object")) {
      delete record.type;
    }
    return record;
  }
  return value;
}

function transportPair(): readonly [Transport, Transport] {
  class MemoryTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
    peer!: MemoryTransport;

    async start(): Promise<void> {}
    async send(message: JSONRPCMessage): Promise<void> {
      queueMicrotask(() => this.peer.onmessage?.(message));
    }
    async close(): Promise<void> {
      this.onclose?.();
      this.peer.onclose?.();
    }
  }

  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

const definitions = getCommandDefinitions();
const resolveContext = () => {
  throw new Error("The registration test lists tools without executing domain commands.");
};

test("registration preserves every canonical identity and Zod schema through the SDK list response", async () => {
  const server = createMcpServer(resolveContext);
  const client = new Client({ name: "registration-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = transportPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const toolsByName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    assert.equal(listed.tools.length, 123);
    assert.equal(definitions.length, 123);
    assert.equal(toolsByName.has("mstar_init"), false);
    assert.equal(toolsByName.has("mstar_report"), true);

    for (const definition of definitions) {
      const name = mcpToolName(definition.id);
      const tool = toolsByName.get(name);
      assert.ok(tool, `Missing MCP tool for CLI command ${definition.id}`);
      const input = definition.input instanceof z.ZodObject
        ? definition.input.extend({
          ...(definition.id === "judgment.review-advice" ? { input: z.string().optional() } : {}),
          ...(definition.cli.options.some(({ context }) => context === "sessionId") ? { sessionId: z.string().optional() } : {}),
        })
        : definition.input;
      assert.deepEqual(normalize(tool.inputSchema), normalize(z.toJSONSchema(input, { io: "input" })));
      assert.deepEqual(normalize(tool.outputSchema), normalize(z.toJSONSchema(definition.output, { io: "output" })));
    }

    assert.ok(toolsByName.has("mstar_persist_write"));
    assert.ok(toolsByName.has("mstar_status_archive_residuals"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("registration rejects distinct command IDs that normalize to one MCP name", () => {
  const server = createMcpServer(resolveContext);
  const definition = definitions.find((entry) => entry.id === "persist.write");
  assert.ok(definition);
  const colliding = { ...definition, id: "persist-write" } as CommandDefinition;
  assert.throws(
    () => registerMcpCommands(server, [definition, colliding], resolveContext),
    /MCP tool name collision: mstar_persist_write/,
  );
});
