/**
 * The leaf seat keeps a writable route (PR #558 review, findings 1 and 2). The
 * dsh scoped mount launches a leaf session's MCP connection with `--seat leaf`;
 * the server then refuses the coordinator-seat commands with a named cause and
 * recovery while every other command stays reachable — the writable subset the
 * removed native `issue.add` / `issue.close` / `plan.prepare` /
 * `plan.progress` tools used to carry.
 *
 * The refused set is the ONE derivation `@mstar-harness/commands`
 * (`coordinator-seat.ts`) exports, which the dsh host's `tools/pre-execute`
 * boundary consumes too. The parity test below is what fails if the two layers
 * ever disagree: it asserts the CLI's published tool-name rule resolves the
 * shared set to exactly the same command ids the server filters on.
 *
 * These regressions drive the production composition
 * (`createMcpServer` + `createContextResolver`): an allowed command runs
 * end-to-end on the leaf connection, and every coordinator-seat command is
 * refused BEFORE any engine round-trip. A non-leaf connection is unaffected.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  coordinatorSeatCommandFor,
  getCommandDefinitions,
  isCoordinatorSeatCommand,
  type CommandDefinition,
  type CommandEnvelope,
} from "@mstar-harness/commands";
import { familyOf, familyToolName } from "../src/mcp/fold";
import { createMcpServer } from "../src/mcp/server";
import { createContextResolver, type McpStdioOptions } from "../src/mcp/stdio";

const SELECTED = [
  "plan.bind",
  "plan.complete",
  "plan.prepare",
  "session.run",
  "workflow.evidence",
  "workflow.delivery-anchors",
  "workflow.adopt-terminal",
  "workflow-note.append",
  "schema",
].map((id): CommandDefinition => {
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
  test("the published tool name resolves the shared set to the ids the server filters on", () => {
    // Parity with the dsh host boundary: that guard sees only the published
    // `mcp__<server>__mstar_<family>` name plus the `action`, so the set must
    // answer through the fold's own name rule for every command in the corpus
    // — not for the members whose family happens to share the id prefix.
    let seat = 0;
    for (const definition of getCommandDefinitions()) {
      const tool = familyToolName(familyOf(definition));
      const action = definition.id.slice(definition.id.indexOf(".") + 1);
      const expected = isCoordinatorSeatCommand(definition.id) ? definition.id : undefined;
      expect({ command: definition.id, resolved: coordinatorSeatCommandFor(tool, action) })
        .toEqual({ command: definition.id, resolved: expected });
      if (expected !== undefined) seat += 1;
    }
    // The derivation is not vacuous: a corpus that lost the workflow family
    // must fail here rather than pass an empty parity assertion.
    expect(seat).toBeGreaterThan(0);
  });

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
        expect(envelope.message).toContain("known leaf sessions cannot hold a workflow coordinator seat");
        // The recovery names the supported route (the coordinating session),
        // never a hidden escape.
        expect(String(envelope.details?.recovery)).toContain("non-leaf coordinating session");
        expect(String(envelope.details?.recovery)).toContain("plan.prepare / plan.progress");
      } finally {
        fixture.dispose();
      }
    },
  );

  test.each([
    ["mstar_workflow", "evidence", { workflow: "wf-a", file: "/dev/null" }],
    ["mstar_workflow", "delivery-anchors", { workflow: "wf-a", branchWork: "feature/x", reason: "typo" }],
    ["mstar_workflow", "adopt-terminal", { workflow: "wf-a", reason: "stranded" }],
  ] as const)(
    "%s action %s is refused on the leaf connection before any engine round-trip",
    async (tool, action, args) => {
      const fixture = harnessFixture();
      try {
        const envelope = await envelopeOf(
          { harnessRoot: fixture.harness, seat: "leaf" },
          tool,
          { action, ...args },
        );
        expect(envelope).toMatchObject({
          command: `workflow.${action}`,
          status: "refused",
          code: `workflow.${action}.leaf-seat`,
          exitCode: 1,
        });
      } finally {
        fixture.dispose();
      }
    },
  );

  test("the leaf keeps its plan-row write route", async () => {
    const fixture = harnessFixture();
    try {
      // `plan.prepare` needs an existing binding and mints no coordinator
      // identity of its own, so the leaf must keep it: the server's refusal is
      // never reached and the command answers with its own input facts.
      const envelope = await envelopeOf(
        { harnessRoot: fixture.harness, seat: "leaf" },
        "mstar_plan",
        { action: "prepare", workflow: "wf-a", plan: "p" },
      );
      expect(envelope.command).toBe("plan.prepare");
      expect(envelope.code).not.toBe("plan.prepare.leaf-seat");
    } finally {
      fixture.dispose();
    }
  });

  test("the leaf cannot launch a child under a minted coordinator identity, and no child is spawned", async () => {
    const fixture = harnessFixture();
    const marker = path.join(path.dirname(fixture.harness), "spawned-by-leaf");
    try {
      // The launch mints a coordinator identity and hands it to a CHILD that
      // never passes this seat check, so the seat is established for the child:
      // the refusal must land before the spawn effect, and `touch` would have
      // created the marker had any child run.
      const envelope = await envelopeOf(
        { harnessRoot: fixture.harness, seat: "leaf" },
        "mstar_session",
        { action: "run", workflow: "wf-a", role: "coordinator", argv: ["touch", marker] },
      );
      expect(envelope).toMatchObject({
        command: "session.run",
        status: "refused",
        code: "session.run.leaf-seat",
        exitCode: 1,
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  test("a non-leaf launcher still runs the child under the minted identity", async () => {
    const fixture = harnessFixture();
    const marker = path.join(path.dirname(fixture.harness), "spawned-by-launcher");
    try {
      const envelope = await envelopeOf(
        { harnessRoot: fixture.harness },
        "mstar_session",
        { action: "run", workflow: "wf-a", role: "coordinator", argv: ["touch", marker] },
      );
      expect(envelope).toMatchObject({ command: "session.run", status: "ok", exitCode: 0 });
      expect(existsSync(marker)).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

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
