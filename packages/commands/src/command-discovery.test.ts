import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { initializeExecutionAuthority, initializeStore } from "@mstar-harness/engine";
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
  | { kind: "command"; descriptor: { id: string; description: string; effects: readonly string[]; requirements: readonly { name: string; ownership: string; route: string; help?: string; tokenKind?: "root" | "workflow" | "plan" | "revision" | "none" }[]; payloadSchemas: Record<string, unknown> } }
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
  test("workflow register schema publishes the selected-document title constraint", () => {
    const selection = selectCommandSchema({ command: "workflow.register" }, getCommandDefinitions());
    if (selection.kind !== "command") throw new Error("expected workflow.register command descriptor");
    expect(selection.descriptor.requirements).toContainEqual(expect.objectContaining({
      name: "planTitle",
      ownership: "caller",
      route: "cli",
      constraint: "the selected plan document is the registration authority; the supplied title must match its H1",
    }));
  });
  test("issue reopen publishes required CAS/payload facts and optional generated replay-id behavior", () => {
    const selection = selectCommandSchema({ command: "issue.reopen" }, getCommandDefinitions());
    if (selection.kind !== "command") throw new Error("expected issue.reopen command descriptor");
    expect(selection.descriptor.cli.path).toEqual(["issue", "reopen"]);
    expect(selection.descriptor.cli.options.filter((option) => option.required).map((option) => option.key))
      .toEqual(expect.arrayContaining(["id", "actor", "expect"]));
    expect(selection.descriptor.cli.options.find((option) => option.key === "operationId"))
      .toMatchObject({ required: false, help: expect.stringContaining("fresh id") });
    expect(selection.descriptor.defaults).not.toHaveProperty("operationId");
    expect(selection.descriptor.requirements).toContainEqual(expect.objectContaining({
      name: "operationId",
      route: "mcp",
      required: false,
      constraint: expect.stringContaining("fresh id"),
    }));
    expect(selection.descriptor.requirements).toContainEqual(expect.objectContaining({
      name: "expect",
      tokenKind: "revision",
    }));
    expect(selection.descriptor.cli.options.find((option) => option.key === "expect")?.help)
      .toContain("mstar issue show --id <id>");
    expect(selection.descriptor.payloadSchemas).toMatchObject({
      payload: { properties: { reason: { type: "string" } } },
    });
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

test("workflow.evidence publishes its engine-typed FILE contract and valid partial members", () => {
  const evidence = getCommandDefinitions().find((entry) => entry.id === "workflow.evidence");
  if (evidence === undefined) throw new Error("missing workflow.evidence definition");
  const delivery = evidence.payloads?.delivery;
  expect(delivery?.help).toContain("pathname, never inline JSON");
  expect(delivery?.help).toContain("reason is required for skipped");
  expect(delivery?.help).toContain("registered completion_policy");
  const schema = delivery?.schema;
  expect(schema?.safeParse({}).success).toBe(false);
  expect(schema?.safeParse({ completion: { policy: "accepted policy", evidence: "acceptance.md" } }).success).toBe(true);
  expect(schema?.safeParse({ compound: { outcome: "updated" } }).success).toBe(true);
  expect(schema?.safeParse({ pr: { repo: "org/repo", head: "feature", target: "main" } }).success).toBe(true);
  expect(schema?.safeParse({ compound: { outcome: "unknown" } }).success).toBe(false);
  expect(schema?.safeParse({ merge: { provider: "gh", evidence: " " } }).success).toBe(false);
  expect(schema?.safeParse({ unknown: { value: "x" } }).success).toBe(false);

  const fileOption = evidence.cli.options.find((option) => option.key === "file");
  expect(fileOption?.flags).toBe("--file <path>");
  expect(fileOption?.help).toContain("Path-only wire");
  expect(evidence.requirements).toContainEqual(expect.objectContaining({
    name: "file", route: "mcp", required: true, condition: { field: "declareKind", present: false },
  }));
});

test("workflow.recover-coordinator is FILE-only and returns usage with the supported ACTIVE recovery pointer", async () => {
  const recovery = getCommandDefinitions().find((entry) => entry.id === "workflow.recover-coordinator");
  if (recovery === undefined) throw new Error("missing workflow.recover-coordinator definition");
  const keys = recovery.cli.options.map((option) => option.key);
  // The FILE transports only: no second ACTIVE recovery alias.
  for (const key of ["session", "operationId", "reason", "authorizationRef", "stopped", "attestation"]) {
    expect(keys).toContain(key);
  }
  for (const removed of ["workflow", "expect", "operation", "priorSession", "unowned"]) {
    expect(keys).not.toContain(removed);
  }
  // The published pointer names the supported ACTIVE verb and its inputs.
  expect(recovery.description).toContain("mstar session recover");

  // A real ACTIVE execution authority rejects the FILE transport as usage and
  // names the supported session recovery.
  const root = mkdtempSync(join(tmpdir(), "mstar-recover-active-"));
  try {
    const harness = join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const store = await initializeStore({ harnessDir: harness });
    store.close();
    await initializeExecutionAuthority({ harnessDir: harness });
    const sessionPath = join(root, "coordinator.json");
    writeFileSync(sessionPath, JSON.stringify({
      schema_version: 1,
      role: "coordinator",
      session_id: "prior",
      workflow_id: "wf-active",
      harness_root: harness,
    }));
    const envelope = await executeCommand("workflow.recover-coordinator", {
      session: sessionPath,
      operationId: "recover-1",
      reason: "active authority",
      authorizationRef: "auth-1",
      stopped: ["prior"],
      harness,
    }, {
      cwd: root,
      controlRoot: null,
      sessionId: "caller-session",
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: {
        async readInput() { return ""; },
        async spawn() { throw new Error("recovery must not spawn a process"); },
        async startDashboard() { throw new Error("dashboard is unavailable in this test"); },
        async openBrowser() { throw new Error("browser is unavailable in this test"); },
      },
    });
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error("expected the ACTIVE recovery usage refusal");
    expect(String(envelope.message)).toContain("mstar session recover");
    for (const flag of ["--workflow", "--prior-session", "--unowned", "--reason", "--attestation", "--expect", "--operation"]) {
      expect(String(envelope.message)).toContain(flag);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("canonical registry publishes bounded minima, safe defaults, and conditional requirements for named families", () => {
  const schemas = Object.fromEntries(getCommandSchemas(getCommandDefinitions()).map((descriptor) => [descriptor.id, descriptor]));

  const ledger = schemas["workflow-note.append"];
  expect(ledger?.cli.path).toEqual(["workflow-note", "append"]);
  expect(ledger?.required).toEqual(expect.arrayContaining(["workflow", "sessionRef", "id", "text", "sessionId"]));
  expect(ledger?.requirements).toContainEqual(expect.objectContaining({ name: "sessionRef", route: "mcp", required: true }));

  const recovery = schemas["session.recover"];
  expect(recovery?.required).toEqual(expect.arrayContaining(["workflow", "reason", "attestation", "expect", "operation", "sessionId"]));
  expect(recovery?.required).not.toContain("unowned");
  expect(recovery?.requirements).toContainEqual(expect.objectContaining({
    name: "unowned", route: "mcp", required: false, constraint: expect.stringContaining("false does not select"),
  }));

  const milestone = schemas["milestone.update"];
  expect(milestone?.required).toEqual(expect.arrayContaining(["project", "id", "expectStore", "operation"]));
  expect(milestone?.required).not.toEqual(expect.arrayContaining(["target", "clearTarget"]));
  expect(milestone?.requirements).toContainEqual(expect.objectContaining({
    name: "clearTarget", route: "mcp", required: false, constraint: expect.stringContaining("false does not select"),
  }));

  const promote = schemas["audit.promote"];
  expect(promote?.required).toEqual(expect.arrayContaining(["path", "deliveryKind"]));
  expect(promote?.requirements).toContainEqual(expect.objectContaining({
    name: "branchSource", route: "mcp", required: true, condition: { field: "deliveryKind", equals: "development" },
  }));

  const reportPath = schemas["pr-review.report-path"];
  expect(reportPath?.required).toEqual(expect.arrayContaining(["target", "reportsDir"]));
  expect(reportPath?.requirements).toContainEqual(expect.objectContaining({
    name: "slug", route: "mcp", required: true, condition: { field: "stage", present: true },
  }));
  expect(schemas["pr-review.seat-prompt"]?.defaults).toMatchObject({
    security: false, skillRoot: "skills/mstar-audit", recon: [], tier: "default", collectFolded: false,
  });
  expect(schemas.dashboard?.defaults).toMatchObject({ port: 0, open: false });
});
