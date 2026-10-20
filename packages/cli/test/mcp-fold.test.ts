import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { getCommandDefinitions, getCommandSchemas, type CommandDefinition, type CommandEnvelope, type InvocationContext } from "@mstar-harness/commands";
import { registerMcpCommands, type ResolveContext } from "../src/mcp/register";
import { FAMILY_PURPOSE, actionOf, familyOf, familyToolName, foldFamilyTools } from "../src/mcp/fold";

/**
 * The design budget for the whole published surface: every folded tool's
 * description plus its input JSON schema, read back from `tools/list`.
 *
 * This is a ceiling, not a repository fact. `tools/list` is paid on every
 * request of every session. On the same probe the per-command surface this
 * replaces measured 173,340 characters of description + input schema (189,881
 * for the payload-composed input view), and it also published 154,471
 * characters of output schemas — 327,811 characters in total, over 90k tokens.
 * The fold publishes the descriptor field index instead of payload composition
 * and drops output schemas, so the after figure is 31,209 characters of
 * description + input schema (~8.7k tokens): 32,000 keeps a small but real
 * margin while a regression that starts republishing per-command contracts
 * inside family descriptions — or that lets per-action tools creep back —
 * reddens here.
 */
const PUBLISHED_SURFACE_BUDGET_CHARS = 32_000;

type PublishedTool = Readonly<{
  name: string;
  description?: string;
  inputSchema: Readonly<{
    required?: readonly string[];
    properties?: Readonly<Record<string, unknown>>;
    "x-mstar-requirements"?: readonly Readonly<{ name: string }>[];
  }>;
}>;

const definitions = getCommandDefinitions();

function actionEnum(tool: PublishedTool): readonly string[] {
  const action = (tool.inputSchema.properties ?? {}).action as { enum?: readonly string[] } | undefined;
  return action?.enum ?? [];
}

function envelope(result: CallToolResult): CommandEnvelope {
  if (result.structuredContent !== undefined) return result.structuredContent as CommandEnvelope;
  const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const start = text.indexOf('{"version":1,');
  if (start < 0) throw new Error(`SDK result lost recoverable command facts: ${text}`);
  return JSON.parse(text.slice(start)) as CommandEnvelope;
}

function baseContext(cwd: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("unused"); },
      async startDashboard() { throw new Error("unused"); },
      async openBrowser() { throw new Error("unused"); },
    },
    versions: { engine: null, cli: "test", plugin: null, host: null, platform: "test" },
  };
}

/** Register the real definitions and run `run` against a real MCP client. */
async function withClient(
  run: (client: Client, tools: readonly PublishedTool[]) => Promise<void>,
  options: { identityLocked?: boolean; defaultSessionId?: string } = {},
  selected: readonly CommandDefinition[] = definitions,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "mstar-mcp-fold-"));
  const server = new McpServer({ name: "fold-test-server", version: "1.0.0" });
  const client = new Client({ name: "fold-test-client", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const resolver: ResolveContext = Object.assign(() => baseContext(cwd), {
    identityLocked: options.identityLocked === true,
    ...(options.defaultSessionId === undefined ? {} : { defaultSessionId: options.defaultSessionId }),
  });
  try {
    registerMcpCommands(server, selected, resolver);
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    const { tools } = await client.listTools();
    await run(client, tools as unknown as readonly PublishedTool[]);
  } finally {
    await client.close();
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return client.callTool({ name, arguments: args });
}

describe("folded MCP command families", () => {
  test("one published tool per family, carrying the family's real action list", async () => {
    const families = new Map<string, string[]>();
    for (const definition of definitions) {
      const family = familyOf(definition.id);
      families.set(family, [...(families.get(family) ?? []), actionOf(definition.id)]);
    }
    await withClient(async (_client, tools) => {
      expect(tools.length).toBe(families.size);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(families.size);
      for (const [family, actions] of families) {
        const tool = tools.find((entry) => entry.name === familyToolName(family));
        if (tool === undefined) throw new Error(`unpublished family tool: ${family}`);
        expect(actionEnum(tool)).toEqual(actions);
        expect(tool.inputSchema.required).toEqual(["action"]);
        // The selector is a transport concern: it is listed, never required.
        expect(tool.inputSchema.required).not.toContain("sessionId");
      }
    });
  });

  test("the folded property set is the union of the members' published fields", () => {
    const members = definitions.map((definition) => ({ definition, input: getCommandSchemas([definition])[0]!.input as Readonly<Record<string, unknown>> }));
    const folded = foldFamilyTools(members);
    expect(folded.length).toBe(new Set(definitions.map((definition) => familyOf(definition.id))).size);
    for (const family of folded) {
      const properties = family.descriptorView.properties as Record<string, unknown>;
      const memberInputs = family.definitions.map((definition) => getCommandSchemas([definition])[0]!.input as Readonly<Record<string, unknown>>);
      for (const input of memberInputs) {
        for (const key of Object.keys((input.properties ?? {}) as Record<string, unknown>)) {
          expect(properties[key]).toBeDefined();
        }
      }
      // First declaration wins on a shared key, byte-for-byte.
      const shared = Object.keys((memberInputs[0]!.properties ?? {}) as Record<string, unknown>)
        .find((key) => memberInputs.slice(1).some((input) => key in ((input.properties ?? {}) as Record<string, unknown>)));
      if (shared !== undefined) {
        const first = (memberInputs[0]!.properties as Record<string, unknown>)[shared];
        expect(properties[shared]).toEqual(first);
      }
    }
  });

  test("each family's field-detail pointer names the id shape and a real example", () => {
    const ids = new Set(definitions.map((definition) => definition.id));
    const folded = foldFamilyTools(definitions.map((definition) => ({
      definition,
      input: getCommandSchemas([definition])[0]!.input as Readonly<Record<string, unknown>>,
    })));
    for (const family of folded) {
      expect(family.description).toContain('mstar_schema {"command"');
      // A multi-action family must spell the derivation, not only one example.
      if (family.actions.length > 1) {
        expect(family.description).toContain('{"command":"<family>.<action>"}');
      }
      const named = [...family.description.matchAll(/"command":"([^"]+)"/g)]
        .map((match) => match[1]!)
        .filter((id) => !id.includes("<"));
      const example = /\(e\.g\. "([^"]+)"\)/.exec(family.description)?.[1];
      if (example !== undefined) named.push(example);
      expect(named.length).toBeGreaterThan(0);
      for (const id of named) expect(ids.has(id)).toBe(true);
    }
  });

  test("a payload-carrying action points its payload shape at mstar_schema", () => {
    const folded = foldFamilyTools(definitions.map((definition) => ({
      definition,
      input: getCommandSchemas([definition])[0]!.input as Readonly<Record<string, unknown>>,
    })));
    const issue = folded.find((family) => family.family === "issue");
    expect(issue?.description).toMatch(/- add: actor; payload via mstar_schema/);
    // A family with no payload contract carries no payload pointer.
    const status = folded.find((family) => family.family === "status");
    expect(status?.description).not.toContain("payload via mstar_schema");
  });

  test("a member field that shadows the family selector is refused at publication", () => {
    const definition = { ...definitions[0]!, id: "fixture.action-owned" } as CommandDefinition;
    expect(() => foldFamilyTools([{ definition, input: { properties: { action: { type: "string" } } } }]))
      .toThrow(/family selector/);
  });

  test("every family states its purpose, so the tool list stays readable", () => {
    const missing = [...new Set(definitions.map((definition) => familyOf(definition.id)))].filter((family) => FAMILY_PURPOSE[family] === undefined);
    expect(missing).toEqual([]);
  });

  test("two actions on one tool reach two different command ids with their own required fields", async () => {
    await withClient(async (client) => {
      const detected = envelope(await call(client, "mstar_host", { action: "detect" }));
      expect(detected).toMatchObject({ command: "host.detect", status: "usage", code: "command.invalid-input" });
      expect(detected.details?.diagnostics).toContainEqual(expect.objectContaining({ path: "signals" }));

      const resolved = envelope(await call(client, "mstar_host", { action: "detect", signals: "question" }));
      expect(resolved).toMatchObject({ command: "host.detect", status: "ok", data: { host: "opencode" } });

      // Aggregated refusal: ONE response names every missing field of the
      // SELECTED action, not just the first, and never the other action's.
      const missing = envelope(await call(client, "mstar_host", { action: "skill-root" }));
      expect(missing).toMatchObject({ command: "host.skill-root", status: "usage", code: "command.invalid-input" });
      expect((missing.details?.diagnostics ?? []).map((entry) => (entry as { path?: string }).path)).toEqual(["host", "skill"]);

      const root = envelope(await call(client, "mstar_host", { action: "skill-root", host: "opencode", skill: "mstar-harness-core" }));
      expect(root).toMatchObject({ command: "host.skill-root", status: "ok" });
    });
  });

  test("an unknown or missing action refuses with the real action list and a recovery", async () => {
    await withClient(async (client) => {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "mstar_host");
      const actions = (tool?.inputSchema.properties as { action?: { enum?: readonly string[] } } | undefined)?.action?.enum ?? [];
      expect(actions).toEqual(["detect", "skill-root"]);
      for (const args of [{ action: "detect-signals" }, {}]) {
        const refusal = envelope(await call(client, "mstar_host", args));
        expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
        expect(refusal.details?.actions).toEqual(actions);
        for (const action of actions) expect(refusal.message).toContain(action);
        expect(refusal.details?.recovery).toContain("mstar_schema");
        expect(refusal.details?.helpRoute).toBe("mstar schema --family host");
      }
    });
  });

  test("the session selector follows the identity lock on the folded tools", async () => {
    await withClient(async (_client, tools) => {
      const session = tools.find((entry) => entry.name === "mstar_session");
      expect((session?.inputSchema.properties ?? {}).sessionId).toMatchObject({ type: "string" });
      expect((session?.inputSchema["x-mstar-requirements"] ?? []).map((entry) => entry.name)).toContain("sessionId");
    });
    await withClient(async (_client, tools) => {
      const session = tools.find((entry) => entry.name === "mstar_session");
      expect((session?.inputSchema.properties ?? {}).sessionId).toBeUndefined();
      expect((session?.inputSchema["x-mstar-requirements"] ?? []).map((entry) => entry.name)).not.toContain("sessionId");
      expect(session?.description).not.toContain("--session-id");
    }, { identityLocked: true, defaultSessionId: "locked-identity" });
  });

  /**
   * A family publishes its session selector ONCE for the whole tool, so the
   * published schema says every action accepts it. Only the listed actions
   * declare it; on the others the action's Zod object strips the value and the
   * call silently runs under the connection identity. The transport refuses
   * before admission instead, names the accepting actions, and never echoes
   * the supplied identity.
   */
  test("a session selector the selected action does not read refuses before admission", async () => {
    const cases = [
      { tool: "mstar_status", id: "status.tech-debt", action: "tech-debt", accepting: ["workflow-close"] },
      { tool: "mstar_milestone", id: "milestone.list", action: "list", accepting: ["assign"] },
      { tool: "mstar_iteration", id: "iteration.gate", action: "gate", accepting: ["register"] },
      { tool: "mstar_session", id: "session.run", action: "run", accepting: ["recover"] },
      { tool: "mstar_workflow_note", id: "workflow-note.coverage", action: "coverage", accepting: ["append"] },
    ] as const;
    await withClient(async (client, tools) => {
      const value = "selector-value-that-must-not-be-echoed";
      for (const entry of cases) {
        const published = tools.find((tool) => tool.name === entry.tool);
        expect((published?.inputSchema.properties ?? {}).sessionId).toMatchObject({ type: "string" });
        const refusal = envelope(await call(client, entry.tool, { action: entry.action, sessionId: value }));
        expect(refusal).toMatchObject({ command: entry.id, status: "usage", code: "command.invalid-input", exitCode: 2 });
        expect(refusal.details?.acceptingActions).toEqual(entry.accepting);
        expect(refusal.details?.selector).toBe("sessionId");
        for (const accepting of entry.accepting) expect(refusal.message).toContain(accepting);
        expect(refusal.details?.recovery).toContain("drop");
        expect(JSON.stringify(refusal)).not.toContain(value);
      }
    });
  });

  test("an action that does declare the selector still runs, and a uniform family never refuses it", async () => {
    await withClient(async (client) => {
      // The one status action that declares `sessionId`: the call reaches its
      // own definition instead of the selector refusal above.
      const accepted = envelope(await call(client, "mstar_status", { action: "workflow-close", sessionId: "accepted-session" }));
      expect(accepted.command).toBe("status.workflow-close");
      expect(accepted.message).not.toContain("does not declare");

      // Every `mstar_plan` action declares the selector, so the guard is silent.
      const uniform = envelope(await call(client, "mstar_plan", { action: "show", sessionId: "uniform-session" }));
      expect(uniform.command).toBe("plan.show");
      expect(uniform.message).not.toContain("does not declare");
    });
  });

  /**
   * A family publishes the UNION of its members' fields, while admission
   * validates only the SELECTED action's own schema — strip mode, no diagnostic.
   * A stripped FILTER is the worst case: an unfiltered page returned to a caller
   * that asked for a filter reads as a filtered page, a wrong result rather than
   * lost input. The transport therefore refuses a top-level key the selected
   * action does not accept, and names the fields it does accept.
   */
  test("a field the selected action does not accept refuses before admission", async () => {
    await withClient(async (client) => {
      // A sibling action's field: `skill` belongs to `host.skill-root`.
      const sibling = envelope(await call(client, "mstar_host", { action: "detect", skill: "mstar-harness-core" }));
      expect(sibling).toMatchObject({ command: "host.detect", status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(sibling.message).toContain('"skill"');
      expect(sibling.message).toContain("signals");
      expect(sibling.details?.field).toBe("skill");
      expect(sibling.details?.acceptedFields).toEqual(["signals"]);
      // The discovery fact the family schema cannot publish: who does take it.
      expect(sibling.details?.acceptingActions).toEqual(["skill-root"]);
      expect(sibling.details?.recovery).toContain("mstar_schema");
      expect(sibling.details?.helpRoute).toBe("mstar schema --family host");

      // A key NO action declares takes the same arm, with nobody to name.
      const unknown = envelope(await call(client, "mstar_host", { action: "detect", signals: "question", bogus: 1 }));
      expect(unknown).toMatchObject({ command: "host.detect", status: "usage" });
      expect(unknown.details?.field).toBe("bogus");
      expect(unknown.details?.acceptingActions).toBeUndefined();
      expect(unknown.details?.recovery).toContain("drop");
      expect(unknown.details?.recovery).toContain('"host.detect"');

      // The field list is CAPPED; `mstar_schema` is the full answer past it.
      const capped = envelope(await call(client, "mstar_issue", { action: "add", bogus: 1 }));
      expect(capped.details?.field).toBe("bogus");
      expect(capped.message).toContain(", …");
      expect((capped.details?.acceptedFields ?? []).length).toBeGreaterThan(12);
    });
  });

  /**
   * The other half of the same rule: a key the action DOES accept is admission's
   * business. `payload` nested contents are never inspected by the field index,
   * so a malformed payload must surface admission's own diagnostics for the
   * payload's fields — never a top-level `payload` refusal invented here.
   */
  test("an accepted payload key stays admission's business, not the field index's", async () => {
    await withClient(async (client) => {
      const refused = envelope(await call(client, "mstar_issue", { action: "add", payload: {} }));
      expect(refused).toMatchObject({ command: "issue.add", status: "usage", code: "command.invalid-input" });
      const paths = (refused.details?.diagnostics ?? []).map((entry) => (entry as { path?: string }).path);
      expect(paths).not.toContain("payload");
      expect(paths.length).toBeGreaterThan(0);
    });
  });

  test("the whole published surface stays inside the design budget", async () => {
    await withClient(async (_client, tools) => {
      const surface = tools.reduce((total, tool) =>
        total + JSON.stringify(tool.inputSchema).length + (tool.description ?? "").length, 0);
      expect(surface).toBeLessThanOrEqual(PUBLISHED_SURFACE_BUDGET_CHARS);
    });
  });
});
