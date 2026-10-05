import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { commandEnvelopeSchema, executeCommand, getCommandDefinitions } from "./definitions.js";
import {
  CommandSchemaSelectionError,
  getSchemaCommandDefinitions,
  selectCommandSchema,
} from "./families/schema.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "./types.js";

function context(): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      readInput: async () => "",
      spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      startDashboard: async () => {
        throw new Error("unused in discovery tests");
      },
      openBrowser: async () => {
        throw new Error("unused in discovery tests");
      },
    },
  };
}

function definition(id: string, cliPath: string[], overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id,
    cli: { path: cliPath, aliases: [], arguments: [], options: [] },
    input: z.object({}),
    output: commandEnvelopeSchema,
    effects: ["read"],
    description: `synthetic ${id}`,
    async execute() {
      return { version: 1, command: id, status: "ok", code: "command.ok", exitCode: 0, data: null };
    },
    ...overrides,
  };
}

async function okData(envelope: CommandEnvelope): Promise<unknown> {
  if (envelope.status !== "ok") {
    throw new Error(`expected ok envelope, got ${envelope.status}: ${"message" in envelope ? envelope.message : ""}`);
  }
  return envelope.data;
}

async function usageMessage(envelope: CommandEnvelope): Promise<string> {
  if (envelope.status !== "usage") {
    throw new Error(`expected usage envelope, got ${envelope.status}`);
  }
  expect(envelope.exitCode).toBe(2);
  return envelope.message;
}

type SchemaCommandData =
  | { kind: "command"; descriptor: { id: string; description: string; effects: readonly string[]; requirements: readonly { name: string; ownership: string; route: string; help?: string; tokenKind?: "root" | "workflow" | "plan" | "none" }[]; payloadSchemas: Record<string, unknown> } }
  | { kind: "family"; family: string; members: readonly { id: string; description: string }[] };

describe("command discovery", () => {
  test("unknown command id returns grouped valid selectors without nested schemas", () => {
    const definitions = [definition("plan.create", ["plan", "create"]), definition("schema", ["schema"])];
    let message = "";
    try {
      selectCommandSchema({ command: "nope" }, definitions);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CommandSchemaSelectionError);
      message = (error as Error).message;
    }
    expect(message).toContain("nope");
    expect(message).toContain("plan");
    expect(message).toContain("schema");
    expect(message).not.toContain("properties");
    expect(message.length).toBeLessThan(600);
  });

  test("family versus payload selector collision refuses instead of guessing", () => {
    const definitions = [definition("plan.create", ["plan", "create"])];
    try {
      selectCommandSchema({ family: "plan", type: "CaptureInput" }, definitions);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CommandSchemaSelectionError);
      const message = (error as Error).message;
      expect(message).toContain("family");
      expect(message).toContain("type");
      expect(message).toContain("exactly one");
    }
  });

  test("very large catalog yields compact family output", () => {
    const big = Array.from({ length: 400 }, (_, index) => {
      const family = `f${String(Math.floor(index / 40)).padStart(2, "0")}`;
      return definition(`${family}.cmd${index}`, [family, `cmd${index}`]);
    });
    const selection = selectCommandSchema({ family: "f03" }, big);
    if (selection.kind !== "family") throw new Error(`expected family selection, got ${selection.kind}`);
    expect(selection.family).toBe("f03");
    expect(selection.members).toHaveLength(40);
    for (const member of selection.members) {
      expect(Object.keys(member).sort()).toEqual(["description", "id"]);
    }
    const rendered = JSON.stringify(selection);
    expect(rendered).not.toContain("properties");
    expect(rendered.length).toBeLessThan(40 * 160);
  });

  test("selected leaf contract carries the full bounded descriptor", () => {
    const definitions = [definition("plan.create", ["plan", "create"])];
    const selection = selectCommandSchema({ command: "plan.create" }, definitions);
    if (selection.kind !== "command") throw new Error(`expected command selection, got ${selection.kind}`);
    expect(selection.descriptor.id).toBe("plan.create");
    expect(selection.descriptor.description).toBe("synthetic plan.create");
    expect(selection.descriptor.effects).toEqual(["read"]);
    expect(selection.descriptor.cli.path).toEqual(["plan", "create"]);
    expect(selection.descriptor.requirements).toEqual([]);
    expect(selection.descriptor.payloadSchemas).toEqual({});
  });

  test("explicit requirements override route-derived hints without weakening engine validation", () => {
    const overridden = definition("route.demo", ["route", "demo"], {
      cli: { path: ["route", "demo"], aliases: [], arguments: [{ key: "name", required: true, variadic: false }], options: [] },
      input: z.object({ name: z.string().min(1), note: z.string().optional() }),
      requirements: [{ name: "name", ownership: "derivable", route: "cli", help: "supplied by the route adapter" }],
    });
    const selection = selectCommandSchema({ command: "route.demo" }, [overridden]);
    if (selection.kind !== "command") throw new Error(`expected command selection, got ${selection.kind}`);
    expect(selection.descriptor.requirements).toEqual([
      { name: "name", ownership: "derivable", route: "cli", help: "supplied by the route adapter" },
    ]);
    const hinted = definition("route.hint", ["route", "hint"], {
      cli: { path: ["route", "hint"], aliases: [], arguments: [{ key: "name", required: true, variadic: false }], options: [] },
      input: z.object({ name: z.string().min(1) }),
    });
    const hint = selectCommandSchema({ command: "route.hint" }, [hinted]);
    if (hint.kind !== "command") throw new Error(`expected command selection, got ${hint.kind}`);
    expect(hint.descriptor.requirements).toEqual([{ name: "name", ownership: "caller", route: "cli" }]);
    expect(hint.descriptor.input).toMatchObject({ required: ["name"] });
    expect(overridden.input.safeParse({}).success).toBe(false);
    expect(overridden.input.safeParse({ name: "x" }).success).toBe(true);
  });
  test("execution token kinds are published in command requirement metadata", () => {
    const definitions = getCommandDefinitions();
    for (const [id, tokenKind] of [
      ["workflow.register", "root"],
      ["plan.bind", "plan"],
      ["plan.prepare", "plan"],
      ["session.recover", "workflow"],
    ] as const) {
      const descriptor = selectCommandSchema({ command: id }, definitions);
      if (descriptor.kind !== "command") throw new Error(`expected command descriptor for ${id}`);
      expect(descriptor.descriptor.requirements.find((entry) => entry.name === "expect")?.tokenKind).toBe(tokenKind);
    }
    const bind = selectCommandSchema({ command: "plan.bind" }, definitions);
    if (bind.kind !== "command") throw new Error("expected plan.bind command descriptor");
    expect(bind.descriptor.requirements).toContainEqual(expect.objectContaining({
      name: "expect (--coordinator)", tokenKind: "workflow",
    }));
    expect(bind.descriptor.requirements).toContainEqual(expect.objectContaining({
      name: "expect (--plan)", tokenKind: "plan",
    }));
    const recover = selectCommandSchema({ command: "session.recover" }, definitions);
    if (recover.kind !== "command") throw new Error("expected session.recover command descriptor");
    expect(recover.descriptor.requirements).toContainEqual(expect.objectContaining({
      name: "expect (--coordinator)", tokenKind: "workflow",
    }));
    expect(recover.descriptor.requirements).toContainEqual(expect.objectContaining({
      name: "expect (--plan)", tokenKind: "plan",
    }));
  });

  test("session selector publishes caller-supplied route facts", () => {
    const routed = definition("plan.note", ["plan", "note"], {
      cli: {
        path: ["plan", "note"],
        aliases: [],
        arguments: [{ key: "name", required: true, variadic: false }],
        options: [
          { key: "session", flags: "--session <id>", required: false, context: "sessionId" },
          { key: "title", flags: "--title <title>", required: false },
        ],
      },
      input: z.object({ name: z.string().min(1), title: z.string().optional() }),
    });
    const selection = selectCommandSchema({ command: "plan.note" }, [routed]);
    if (selection.kind !== "command") throw new Error(`expected command selection, got ${selection.kind}`);
    expect(selection.descriptor.requirements).toEqual([
      { name: "name", ownership: "caller", route: "cli" },
      { name: "title", ownership: "caller", route: "cli" },
      { name: "session", ownership: "caller", route: "cli" },
      { name: "session", ownership: "caller", route: "mcp", help: "when the selected route requires session identity, it must be supplied by the caller (host per call); legacy pre-activation routes do not require it, and legacy `plan bind --resume` refuses declared identity while ignoring ambient environment identity" },
    ]);
  });

  test("schema command publishes family and leaf selections through the engine", async () => {
    expect(getCommandDefinitions().some((entry) => entry.id === "schema")).toBe(true);
    const family = await executeCommand("schema", { family: "schema" }, context());
    const familyData = (await okData(family)) as Extract<SchemaCommandData, { kind: "family" }>;
    expect(familyData.kind).toBe("family");
    expect(familyData.members).toEqual([
      { id: "schema", description: getSchemaCommandDefinitions()[0]!.description },
    ]);

    const leaf = await executeCommand("schema", { command: "schema" }, context());
    const leafData = (await okData(leaf)) as Extract<SchemaCommandData, { kind: "command" }>;
    expect(leafData.kind).toBe("command");
    expect(leafData.descriptor.id).toBe("schema");
    expect(leafData.descriptor.requirements.map((entry) => `${entry.route}:${entry.name}:${entry.ownership}`)).toEqual([
      "cli:type:caller",
      "cli:command:caller",
      "cli:family:caller",
      "mcp:type:caller",
      "mcp:command:caller",
      "mcp:family:caller",
    ]);
    expect(leafData.descriptor.effects).toEqual(["read"]);
    expect(Object.keys(leafData.descriptor.payloadSchemas)).toEqual([]);
  });

  test("payload selector stays a distinct supported selector", async () => {
    const payload = await executeCommand("schema", { type: "CaptureInput" }, context());
    const payloadData = (await okData(payload)) as { type: string; fields: readonly { name: string }[] };
    expect(payloadData.type).toBe("CaptureInput");
    expect(payloadData.fields.some((field: { name: string }) => field.name === "title")).toBe(true);

    const unknownType = await executeCommand("schema", { type: "NotAPayload" }, context());
    const message = await usageMessage(unknownType);
    expect(message).toContain("CaptureInput");
  });

  test("selector collisions and empty selectors preserve root-union guidance at execution", async () => {
    for (const input of [
      { command: "schema", family: "schema" },
      {},
    ]) {
      const envelope = await executeCommand("schema", input, context());
      expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      if (envelope.status !== "usage") throw new Error("expected usage envelope");
      const firstLine = envelope.message.split("\n")[0] ?? "";
      expect(firstLine).toContain("supply exactly one");
      expect(firstLine).toContain("command");
      expect(firstLine).toContain("family");
      expect(firstLine).toContain("type");
      expect(firstLine).not.toMatch(/Rejected\s*:/);
      expect(envelope.message).not.toContain("expected valid value");
    }
  });
});
