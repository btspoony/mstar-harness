import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { getCommandDefinitions, getCommandSchemas, type CommandDefinition, type CommandEnvelope, type InvocationContext } from "@mstar-harness/commands";
import { registerMcpCommands, type ResolveContext } from "../src/mcp/register";
import { inputFields } from "../src/schema-branches";
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
 * and drops output schemas, so the after figure is 32,749 characters of
 * description + input schema (~9.1k tokens; the payload schemas published for
 * `plan.issue-add` and `workflow.execution-policy` are sanctioned contract
 * detail, not per-command republishing): 33,000 keeps a small but real margin
 * while a regression that starts republishing per-command contracts inside
 * family descriptions — or that lets per-action tools creep back — reddens
 * here. A published discovery example must carry every field the tool
 * REQUIRES (`"action":"schema"`), so the margin absorbs that cost too.
 */
const PUBLISHED_SURFACE_BUDGET_CHARS = 33_000;

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

/**
 * The `mstar_schema {...}` calls a published text hands the caller, as runnable
 * arguments. A multi-action family publishes the id SHAPE (`<family>.<action>`)
 * and spells one real member in its `(e.g. "<id>")`, so that example is
 * substituted — the shape sentence is documentation, the named member is the
 * call.
 */
function schemaExamples(text: string): Array<Record<string, unknown>> {
  const named = /\(e\.g\. "([^"]+)"\)/.exec(text)?.[1];
  return [...text.matchAll(/mstar_schema (\{[^}]*\})/g)].map((match) => {
    const example = JSON.parse(match[1]!) as Record<string, unknown>;
    const command = example.command;
    return typeof command === "string" && command.includes("<") && named !== undefined
      ? { ...example, command: named }
      : example;
  });
}

describe("folded MCP command families", () => {
  test("one published tool per family, carrying the family's real action list", async () => {
    const families = new Map<string, string[]>();
    for (const definition of definitions) {
      const family = familyOf(definition);
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
    expect(folded.length).toBe(new Set(definitions.map((definition) => familyOf(definition))).size);
    for (const family of folded) {
      const properties = family.descriptorView.properties as Record<string, unknown>;
      const memberInputs = family.definitions.map((definition) => getCommandSchemas([definition])[0]!.input as Readonly<Record<string, unknown>>);
      for (const input of memberInputs) {
        for (const key of Object.keys((input.properties ?? {}) as Record<string, unknown>)) {
          // A field whose declarations conflict is withheld from the family
          // schema and named per action instead: discoverability moves to the
          // description, it never disappears.
          if (properties[key] === undefined) expect(family.description).toContain(key);
        }
      }
    }
  });

  /**
   * A key two members declare differently is published ONCE, and which
   * declaration wins is a merge detail — so this pins the CALLER contract over a
   * real collision instead (`issue.id` is a bare string on `add` and
   * `minLength(1)` on `show`): the folded index advertises the key, and
   * admission still validates the SELECTED member's own schema, so a value the
   * later action refuses is a refusal naming that field, never a wrong result.
   */
  test("a key two actions declare differently is published once and admitted per action", async () => {
    const members = [definitions.find((definition) => definition.id === "issue.add")!, definitions.find((definition) => definition.id === "issue.show")!];
    await withClient(async (client) => {
      const published = (await client.listTools()).tools.find((tool) => tool.name === "mstar_issue");
      if (published === undefined) throw new Error("unpublished family tool: mstar_issue");
      expect((published.inputSchema.properties ?? {}).id).toMatchObject({ type: "string" });
      const refused = envelope(await call(client, "mstar_issue", { action: "show", id: "" }));
      expect(refused).toMatchObject({ status: "usage", code: "command.invalid-input" });
      const paths = (refused.details?.diagnostics ?? []).map((entry) => (entry as { path?: string }).path);
      expect(paths).toContain("id");
    }, {}, members);
  });

  /**
   * The published field index is built by the SAME union traversal the rendered
   * contract uses (`src/schema-branches.ts`). No current definition publishes a
   * `oneOf` input, so the traversal is pinned here: a member whose input splits
   * on `oneOf` must still publish every alternative's fields, or a caller is
   * told a field does not exist while admission accepts it.
   */
  test("a member input that splits on oneOf publishes its alternative fields", () => {
    const definition = { ...definitions[0]!, id: "fixture.one-of" } as CommandDefinition;
    const input = {
      oneOf: [
        { properties: { mode: { type: "string" } } },
        { properties: { target: { type: "string" } } },
      ],
    };
    const [folded] = foldFamilyTools([{ definition, input }]);
    const properties = folded!.descriptorView.properties as Record<string, unknown>;
    expect(properties.mode).toEqual({ type: "string" });
    expect(properties.target).toEqual({ type: "string" });
    // The action's own accepted set carries them too: the transport refuses a
    // supplied key outside it, so a missing branch would refuse a real field.
    expect([...folded!.acceptedFields.get("one-of")!].sort()).toEqual(["mode", "target"]);
  });

  /**
   * One derivation of family identity. Publication groups by the definition's
   * authored `cli.path[0]` — the segment `mstar_schema --family` accepts — while
   * the action still comes from the id. The two must agree over the corpus: an
   * id whose prefix drifted from its authored path would publish
   * `mstar_<prefix>` whose recovery names a family the discovery route refuses
   * as unknown. This is a fact to surface, not to paper over.
   */
  test("every command's id prefix is its authored family segment", () => {
    const mismatched = definitions
      .filter((definition) => definition.id.split(".", 1)[0] !== definition.cli.path[0])
      .map((definition) => `${definition.id} (cli.path[0] = ${String(definition.cli.path[0])})`);
    expect(mismatched).toEqual([]);
  });

  test("each family's field-detail pointer names the id shape and a real example", () => {
    const ids = new Set(definitions.map((definition) => definition.id));
    const folded = foldFamilyTools(definitions.map((definition) => ({
      definition,
      input: getCommandSchemas([definition])[0]!.input as Readonly<Record<string, unknown>>,
    })));
    for (const family of folded) {
      // The pointer carries the mandatory selector: `mstar_schema` refuses a
      // call without one, so an action-less example is a next step that fails.
      expect(family.description).toContain('mstar_schema {"action":"schema","command"');
      // A multi-action family must spell the derivation, not only one example.
      if (family.actions.length > 1) {
        expect(family.description).toContain('{"action":"schema","command":"<family>.<action>"}');
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

  /**
   * Publication refuses duplicate tool names, duplicate actions and an `action`
   * shadow — but NOT a shape collision: a key two members declare differently
   * is withheld from the family schema (never published with one action's
   * declaration) and named per action in the description. The caller contract
   * that carries this is the per-action admission test above and the
   * published-shape test below.
   */
  test("a field whose declarations conflict is withheld and named per action", () => {
    const folded = foldFamilyTools(definitions.map((definition) => ({
      definition,
      input: getCommandSchemas([definition])[0]!.input as Readonly<Record<string, unknown>>,
    })));
    const issue = folded.find((family) => family.family === "issue")!;
    const properties = issue.descriptorView.properties as Record<string, unknown>;
    // `add` enumerates the lifecycle values (including `open`) while every
    // closure action publishes a single value: neither declaration may speak
    // for the whole tool, so the field is not published at all.
    expect(properties.disposition).toBeUndefined();
    // `payload` is an untyped placeholder on `add` and a typed object on
    // `close`: publishing either shape advertises a request the other refuses.
    expect(properties.payload).toBeUndefined();
    expect(issue.description).toContain("Varies by action: disposition, payload");
    // A strictness-only difference stays published: the field is still in the
    // index, and the loop below proves no advertised value is refused.
    expect(properties.id).toBeDefined();
    for (const family of folded) {
      const shapes = family.descriptorView.properties as Record<string, unknown>;
      for (const [key, shape] of Object.entries(shapes)) {
        if (key === "action") continue;
        for (const definition of family.definitions) {
          const own = inputFields(getCommandSchemas([definition])[0]!.input).get(key);
          if (own === undefined) continue;
          // A published declaration must not name a value its sibling refuses:
          // same JSON type, and no enumerated value outside the sibling's enum.
          expect((shape as { type?: unknown }).type).toEqual((own as { type?: unknown }).type);
          const declared = (own as { enum?: readonly unknown[] }).enum;
          for (const value of (shape as { enum?: readonly unknown[] }).enum ?? []) {
            if (declared !== undefined) expect(declared).toContainEqual(value);
          }
        }
      }
    }
  });

  test("every family states its purpose, so the tool list stays readable", () => {
    const missing = [...new Set(definitions.map((definition) => familyOf(definition)))].filter((family) => FAMILY_PURPOSE[family] === undefined);
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

  /**
   * A refusal is a response the caller may forward or a session may record, so
   * a caller-supplied selector value never travels with it — the same rule
   * the selector refusal states for a session id. Only its shape is
   * reported; the legal action list and the family name carry the recovery.
   */
  test("an unknown action never echoes the supplied value", async () => {
    await withClient(async (client) => {
      // Join-built canary: a real secret-shaped runtime value with no
      // secret-shaped literal in source for scanners to flag.
      const secret = ["sk", "live-fold-action"].join("-");
      const refusal = envelope(await call(client, "mstar_host", { action: secret }));
      expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input" });
      const diagnostics = (refusal.details?.diagnostics ?? []) as Array<{ path?: string; received?: string }>;
      expect(diagnostics).toContainEqual(expect.objectContaining({ path: "action", received: "supplied" }));
      expect(JSON.stringify(refusal)).not.toContain(secret);
      // Same rule for a plain unknown value: the message names the tool and the
      // legal actions, never the caller's string.
      const plain = envelope(await call(client, "mstar_host", { action: "detect-signals" }));
      expect(JSON.stringify(plain)).not.toContain("detect-signals");
    });
  });

  /**
   * Every `mstar_schema` example a published text hands the caller must be a
   * call the tool ACCEPTS: `mstar_schema` refuses a call with no selector, so an
   * action-less example sends the caller into a second refusal. The sources are
   * the family pointer in `tools/list` and both recovery texts.
   */
  test("every published mstar_schema example is a call the tool accepts", async () => {
    await withClient(async (client, tools) => {
      const family = tools.find((entry) => entry.name === "mstar_issue");
      if (family === undefined) throw new Error("unpublished family tool: mstar_issue");
      const texts = [
        family.description ?? "",
        String(envelope(await call(client, "mstar_issue", { action: "no-such-action" })).details?.recovery ?? ""),
        String(envelope(await call(client, "mstar_issue", { action: "add", bogus: 1 })).details?.recovery ?? ""),
      ];
      let driven = 0;
      for (const text of texts) {
        for (const example of schemaExamples(text)) {
          const accepted = envelope(await call(client, "mstar_schema", example));
          expect(accepted.status).toBe("ok");
          driven++;
        }
      }
      expect(driven).toBeGreaterThanOrEqual(3);
    });
  });

  /**
   * The `schema` action selects one of three alternative objects, so its ROOT
   * requires nothing while no call without a selector is accepted. A
   * `tools/list`-driven caller must learn the exactly-one rule from the compact
   * per-action line: "no required fields" would advertise `{"action":"schema"}`
   * and that call is refused. The JSON schema cannot say "exactly one" without
   * a per-selector branch, so the description carries the rule.
   */
  test("the schema selector is published as exactly one requirement", async () => {
    await withClient(async (client, tools) => {
      const tool = tools.find((entry) => entry.name === "mstar_schema");
      if (tool === undefined) throw new Error("unpublished family tool: mstar_schema");
      expect(tool.description).toContain("- schema: exactly one of command, family, type");
      expect(tool.description).not.toContain("no required fields");
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      for (const selector of ["command", "family", "type"]) expect(properties[selector]).toBeDefined();
      // The selector-less call is still refused, and the refusal names them all.
      const refused = envelope(await call(client, "mstar_schema", { action: "schema" }));
      expect(refused).toMatchObject({ status: "usage", code: "command.invalid-input" });
      for (const selector of ["command", "family", "type"]) expect(refused.message).toContain(selector);
      // Following the published requirement succeeds.
      const accepted = envelope(await call(client, "mstar_schema", { action: "schema", family: "host" }));
      expect(accepted).toMatchObject({ status: "ok", data: { kind: "family", family: "host" } });
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
        expect(refusal.details?.selectors).toEqual([{ key: "sessionId", acceptingActions: [...entry.accepting] }]);
        for (const accepting of entry.accepting) expect(refusal.message).toContain(accepting);
        expect(refusal.details?.recovery).toContain("drop");
        expect(JSON.stringify(refusal)).not.toContain(value);
      }
    });
  });

  /**
   * One call, one refusal: a selector the selected action does not declare, a
   * key it does not accept and its own missing required field all come back
   * together. Refusing the selector on its own would cost a second round-trip
   * for input the transport already holds.
   */
  test("a refused selector, a rejected field and a missing field share one refusal", async () => {
    await withClient(async (client) => {
      const value = "selector-value-that-must-not-be-echoed";
      const refused = envelope(await call(client, "mstar_iteration", { action: "gate", sessionId: value, bogus: 1 }));
      expect(refused).toMatchObject({ command: "iteration.gate", status: "usage", code: "command.invalid-input", exitCode: 2 });
      const paths = (refused.details?.diagnostics ?? []).map((entry) => (entry as { path?: string }).path);
      // The refused selector, the rejected key, then the action's own admission
      // problem — the refused selector is never re-offered to admission.
      expect(paths).toEqual(["sessionId", "bogus", "workflow"]);
      expect(refused.details?.selectors).toEqual([{ key: "sessionId", acceptingActions: ["register"] }]);
      expect(refused.details?.fields).toEqual(["bogus"]);
      for (const text of [refused.message, String(refused.details?.recovery)]) {
        expect(text).toContain("bogus");
        expect(text).toContain("register");
      }
      expect(JSON.stringify(refused)).not.toContain(value);
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
      // The refusal aggregates this key with the action's own missing field.
      expect(sibling.message).toContain("skill");
      expect(sibling.message).toContain("signals");
      expect(sibling.details?.fields).toEqual(["skill"]);
      expect(sibling.details?.acceptedFields).toEqual(["signals"]);
      // The discovery fact the family schema cannot publish: who does take it.
      expect(sibling.details?.acceptingActions).toEqual(["skill-root"]);
      expect(sibling.details?.recovery).toContain("mstar_schema");
      expect(sibling.details?.helpRoute).toBe("mstar schema --family host");

      // A key NO action declares takes the same arm, with nobody to name.
      const unknown = envelope(await call(client, "mstar_host", { action: "detect", signals: "question", bogus: 1 }));
      expect(unknown).toMatchObject({ command: "host.detect", status: "usage" });
      expect(unknown.details?.fields).toEqual(["bogus"]);
      expect(unknown.details?.acceptingActions).toBeUndefined();
      expect(unknown.details?.recovery).toContain("drop");
      expect(unknown.details?.recovery).toContain('"host.detect"');

      // The field list is CAPPED; `mstar_schema` is the full answer past it.
      const capped = envelope(await call(client, "mstar_issue", { action: "add", bogus: 1 }));
      expect(capped.details?.fields).toEqual(["bogus"]);
      const cappedDiagnostic = (capped.details?.diagnostics ?? [])
        .find((entry) => (entry as { path?: string }).path === "bogus") as { expected?: string } | undefined;
      expect(cappedDiagnostic?.expected).toContain(", ...");
      expect((capped.details?.acceptedFields ?? []).length).toBeGreaterThan(12);
    });
  });

  /**
   * Report-all is the CLI contract (`packages/cli/AGENTS.md`): every rejected
   * key AND the selected action's own missing/invalid fields come back in ONE
   * response, so a typo plus a missing field costs one retry, not one per field.
   */
  test("every rejected field and the action's own admission problems share one refusal", async () => {
    await withClient(async (client) => {
      const refused = envelope(await call(client, "mstar_host", { action: "detect", bogus: 1, extra: 2 }));
      expect(refused).toMatchObject({ command: "host.detect", status: "usage", code: "command.invalid-input", exitCode: 2 });
      const paths = (refused.details?.diagnostics ?? []).map((entry) => (entry as { path?: string }).path);
      expect(paths).toEqual(["bogus", "extra", "signals"]);
      expect(refused.details?.fields).toEqual(["bogus", "extra"]);
      expect(refused.message).toContain("bogus");
      expect(refused.message).toContain("extra");
      expect(refused.message).toContain("signals");

      // A rejected key is caller-controlled text: a credential-shaped one never
      // travels with the refusal, and the sanitizer strips it from the path too.
      const secret = ["sk", "live-fold-field"].join("-");
      const redacted = envelope(await call(client, "mstar_host", { action: "detect", [secret]: 1 }));
      expect(redacted).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(JSON.stringify(redacted)).not.toContain(secret);
      expect(JSON.stringify(redacted)).toContain("[REDACTED]");
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
