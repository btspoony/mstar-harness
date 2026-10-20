/**
 * The leaf seat keeps a writable route (PR #558 review, finding B). The dsh
 * scoped mount launches a leaf session's MCP connection with `--seat leaf`;
 * the server then refuses the coordinator-seat commands (`plan.bind`,
 * `plan.complete`) with a named cause and recovery while every other command
 * stays reachable — the writable subset the removed native `issue.add` /
 * `issue.close` / `plan.prepare` / `plan.progress` tools used to carry.
 *
 * These regressions drive the production composition
 * (`createMcpServer` + `createContextResolver`): an allowed command runs
 * end-to-end on the leaf connection, and both coordinator-seat commands are
 * refused BEFORE any engine round-trip. A non-leaf connection is unaffected.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { getCommandDefinitions, type CommandDefinition, type CommandEnvelope } from "@mstar-harness/commands";
import { createMcpServer } from "../src/mcp/server";
import { createContextResolver, type McpStdioOptions } from "../src/mcp/stdio";

const SELECTED = ["plan.bind", "plan.complete", "schema"].map((id): CommandDefinition => {
  const found = getCommandDefinitions().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
});

async function envelopeOf(options: McpStdioOptions, tool: string, args: Record<string, unknown>): Promise<CommandEnvelope> {
  const server = createMcpServer(createContextResolver(options), SELECTED, undefined, options.seat);
  const client = new Client({ name: "leaf-seat-consumer", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.structuredContent !== undefined) return result.structuredContent as CommandEnvelope;
    const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const start = text.indexOf('{"version":1,');
    if (start < 0) throw new Error(`no command envelope in the tool result: ${text}`);
    return JSON.parse(text.slice(start)) as CommandEnvelope;
  } finally {
    await client.close();
    await server.close();
  }
}

function harnessFixture(): { harness: string; dispose: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "mstar-leaf-seat-"));
  const harness = path.join(root, ".mstar");
  return { harness, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("MCP leaf seat", () => {
  test("an allowed command runs end-to-end on the leaf connection", async () => {
    const fixture = harnessFixture();
    try {
      const envelope = await envelopeOf(
        { harnessRoot: fixture.harness, seat: "leaf" },
        "mstar_schema",
        { action: "schema", command: "plan.bind" },
      );
      expect(envelope).toMatchObject({ status: "ok", code: "schema.ok" });
      expect((envelope.data as { kind: string }).kind).toBe("command");
    } finally {
      fixture.dispose();
    }
  });

  test.each(["bind", "complete"] as const)(
    "plan.%s is refused fail-closed with the cause and the recovery",
    async (action) => {
      const fixture = harnessFixture();
      try {
        const envelope = await envelopeOf(
          { harnessRoot: fixture.harness, seat: "leaf" },
          "mstar_plan",
          { action },
        );
        expect(envelope).toMatchObject({
          command: `plan.${action}`,
          status: "refused",
          code: `plan.${action}.leaf-seat`,
          exitCode: 1,
        });
        expect(envelope.message).toContain("known leaf sessions cannot bind or complete a plan");
        // The recovery names the supported route (the coordinating session),
        // never a hidden escape.
        expect(String(envelope.details?.recovery)).toContain("non-leaf coordinating session");
        expect(String(envelope.details?.recovery)).toContain("plan.prepare / plan.progress");
      } finally {
        fixture.dispose();
      }
    },
  );

  test("a non-leaf connection is not restricted by the leaf guard", async () => {
    const fixture = harnessFixture();
    try {
      // Same command, no seat declared: the call reaches the shared command
      // (which refuses its own missing input facts), never the leaf refusal.
      const envelope = await envelopeOf({ harnessRoot: fixture.harness }, "mstar_plan", { action: "bind" });
      expect(envelope.command).toBe("plan.bind");
      expect(envelope.code).not.toBe("plan.bind.leaf-seat");
    } finally {
      fixture.dispose();
    }
  });
});
