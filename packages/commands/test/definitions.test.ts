import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CommandDefinitionError,
  admitCommandInput,
  commandEnvelopeSchema,
  executeCommand,
  getCommandSchemas,
  getPayloadSchema,
  validateCommandDefinitions,
} from "../src/index.js";
import type { CommandEnvelope, InvocationContext } from "../src/index.js";
import { CommandSchemaSelectionError, failure as schemaFailure } from "../src/families/schema.js";
import type { CommandDefinition } from "../src/types.js";

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
        throw new Error("unused in definition tests");
      },
      openBrowser: async () => {
        throw new Error("unused in definition tests");
      },
    },
  };
}

function definition(id: string, cliPath: string[]): CommandDefinition<{ name: string }, { greeting: string }> {
  return {
    id,
    cli: { path: cliPath, aliases: [], arguments: [{ key: "name", required: true, variadic: false }], options: [] },
    input: z.object({ name: z.string().min(1) }),
    output: commandEnvelopeSchema,
    effects: ["read"],
    description: "Greet a user",
    async execute(input) {
      return { version: 1, command: id, status: "ok", code: "command.ok", exitCode: 0, data: { greeting: `Hello ${input.name}` } };
    },
  };
}

describe("command definitions", () => {
  test("schema selector refusal preserves code and verbatim message", () => {
    const result = schemaFailure("schema", new CommandSchemaSelectionError("engine schema selection refusal", ["command", "family"]));
    expect(result.status).toBe("usage");
    expect(result.code).toBe("command.invalid-input");
    expect(result.message.split("\n", 1)[0]).toBe("engine schema selection refusal");
    expect(result.details).toHaveProperty("helpRoute");
  });


  test("rejects MCP name collisions after command ID normalization", () => {
    expect(() => validateCommandDefinitions([
      definition("plan.issue-add", ["plan", "issue-add"]),
      definition("plan-issue.add", ["plan-issue", "add"]),
    ])).toThrow("Duplicate MCP tool name: mstar_plan_issue_add");
  });

  test("rejects CLI syntax whose keys diverge from its input schema", () => {
    const valid = definition("greet", ["greet"]);
    const invalid = { ...valid, cli: { ...valid.cli, arguments: [{ ...valid.cli.arguments[0]!, key: "person" }] } };
    expect(() => validateCommandDefinitions([invalid])).toThrow(CommandDefinitionError);
  });

  test("input schemas reject malformed caller input", () => {
    const input = definition("greet", ["greet"]).input;
    expect(input.safeParse({ name: "Ada" }).success).toBe(true);
    expect(input.safeParse({ name: "" }).success).toBe(false);
    expect(input.safeParse({ name: 42 }).success).toBe(false);
  });

  test("keeps payload schema query shape and reuses the engine registry for command schemas", () => {
    const payload = getPayloadSchema("CaptureInput");
    expect(payload.type).toBe("CaptureInput");
    expect(payload.fields.find((field) => field.name === "projectId")).toMatchObject({ required: true, type: "string" });
    expect(() => getPayloadSchema("NotAPayload")).toThrow("Unknown payload type");
    const commandSchemas = getCommandSchemas([definition("greet", ["greet"])]);
    expect(commandSchemas).toHaveLength(1);
    expect(commandSchemas[0]!.input).toMatchObject({ type: "object", properties: { name: { type: "string" } } });
    expect(commandSchemas[0]!.payloadSchemas).toEqual({});
  });
});

/**
 * The public admitted-execution boundary. These exercise the observable
 * contract a non-MCP consumer gets: the only executable a caller can obtain
 * comes out of `admitCommandInput`, it is bound to the definition and schema
 * that admitted it, and it neither invokes another definition's handler nor
 * lets the caller replace the parsed value or the resolved identity.
 */
describe("admitted execution capability", () => {
  function tracked(id: string, calls: { count: number }, minName = 1): CommandDefinition<{ name: string; sessionId?: string }, { id: string; sessionId: string; keys: string[] }> {
    return {
      id,
      cli: {
        path: [id], aliases: [], arguments: [{ key: "name", required: true, variadic: false }],
        options: [{ key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" }],
      },
      input: z.object({ name: z.string().min(minName), sessionId: z.string().optional() }),
      output: commandEnvelopeSchema,
      effects: ["read"],
      description: `${id} handler`,
      async execute(input, invocation) {
        calls.count += 1;
        return {
          version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0,
          data: { id, sessionId: invocation.sessionId ?? "none", keys: Object.keys(input).sort() },
        };
      },
    };
  }

  function admit(
    definition: CommandDefinition,
    input: unknown,
  ) {
    return admitCommandInput(definition, input, getCommandSchemas([definition])[0]!);
  }

  test("runs the admitted definition once with the schema-parsed value and the admitted selector", async () => {
    const alphaCalls = { count: 0 };
    const alpha = tracked("fixture.alpha", alphaCalls);
    const admitted = admit(alpha, { name: "Ada", sessionId: "seat-1", extra: "dropped" });
    if (!admitted.success) throw new Error("expected admission to succeed");
    // Admission alone must not run a handler.
    expect(alphaCalls.count).toBe(0);

    const callerContext = context();
    const envelope = await admitted.execute(callerContext);
    expect(alphaCalls.count).toBe(1);
    expect(envelope).toMatchObject({
      status: "ok", command: "fixture.alpha", data: { id: "fixture.alpha", sessionId: "seat-1", keys: ["name", "sessionId"] },
    });
    // The admitted selector rides along without mutating the caller's context.
    expect(callerContext.sessionId).toBeUndefined();
  });

  test("an admission for another definition cannot run the definition a caller names, and a success shape is not an admission", async () => {
    const alphaCalls = { count: 0 };
    const betaCalls = { count: 0 };
    const alpha = tracked("fixture.alpha", alphaCalls);
    const beta = tracked("fixture.beta", betaCalls, 4);

    // The same raw input admits under one definition and is refused by the
    // other: admission is the definition's own schema, not a shared shape.
    const admittedAlpha = admit(alpha, { name: "Ada" });
    const admittedBeta = admit(beta, { name: "Ada" });
    expect(admittedAlpha.success).toBe(true);
    expect(admittedBeta).toMatchObject({ success: false, envelope: { status: "usage", code: "command.invalid-input" } });

    if (!admittedAlpha.success) throw new Error("expected admission to succeed");
    await admittedAlpha.execute(context());
    expect(alphaCalls.count).toBe(1);
    expect(betaCalls.count).toBe(0);

    // The canonical entry point re-admits the raw input: a success-shaped object
    // carrying a data/definition/required triple is just unrecognized input to
    // the addressed definition, and never selects a handler.
    const forged = await executeCommand("schema", {
      success: true, command: "fixture.beta", data: { id: "fixture.beta" }, required: [],
    }, context());
    expect(forged).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(alphaCalls.count).toBe(1);
    expect(betaCalls.count).toBe(0);
  });

  test("a genuine admission keeps its validated value private to execution and refuses the former public alias", async () => {
    const observed: Array<{ name: string; total: number }> = [];
    const fixture: CommandDefinition<{ name: string; payload?: { numbers: number[] } }, { greeting: string; total: number }> = {
      id: "fixture.private-data",
      cli: { path: ["fixture", "private-data"], aliases: [], arguments: [{ key: "name", required: true, variadic: false }], options: [] },
      input: z.object({
        name: z.string().min(1),
        payload: z.object({ numbers: z.array(z.number().int().min(0)).min(1) }).optional(),
      }),
      output: commandEnvelopeSchema,
      effects: ["read"],
      description: "private handler data fixture",
      async execute(input) {
        const total = input.payload!.numbers.reduce((sum, number) => sum + number, 0);
        observed.push({ name: input.name, total });
        return {
          version: 1, command: "fixture.private-data", status: "ok", code: "fixture.private-data.ok", exitCode: 0,
          data: { greeting: `Hello ${input.name}`, total },
        };
      },
    };
    const original = { name: "Ada", payload: { numbers: [2, 3] } };
    const admitted = admit(fixture, original);
    if (!admitted.success) throw new Error("expected admission to succeed");
    // The formerly published handler value is gone from the capability's type
    // and from its runtime shape. Reproduce the removed consumer's access by
    // reading the admitted object's own properties as an untyped view — the
    // same `input`/`data` read that used to return the live handler value.
    const capability: Record<string, unknown> = { ...admitted };
    const legacyInput = capability.input;
    if (legacyInput !== null && typeof legacyInput === "object" && "name" in legacyInput) legacyInput.name = "";
    const legacyData = capability.data;
    if (legacyData !== null && typeof legacyData === "object") {
      if ("name" in legacyData) legacyData.name = "";
      if ("payload" in legacyData) {
        const payload = legacyData.payload;
        if (payload !== null && typeof payload === "object" && "numbers" in payload && Array.isArray(payload.numbers)) payload.numbers.push(-5);
      }
    }

    // Real domain output: the handler computed the greeting and the total from
    // the value admission validated, unaffected by the alias attempt.
    const envelope = await admitted.execute(context());
    expect(envelope).toMatchObject({ status: "ok", data: { greeting: "Hello Ada", total: 5 } });
    expect(observed).toEqual([{ name: "Ada", total: 5 }]);
    // A second invocation observes the same admitted value.
    expect(await admitted.execute(context())).toMatchObject({ data: { greeting: "Hello Ada", total: 5 } });
  });

  test("a transport projection runs inside admission and cannot be replaced afterwards", async () => {
    const observed: unknown[] = [];
    const fixture: CommandDefinition<{ name: string; sessionId?: string; payload?: { numbers: number[] } }, { keys: string[]; total: number }> = {
      id: "fixture.projected",
      cli: {
        path: ["fixture", "projected"], aliases: [], arguments: [{ key: "name", required: true, variadic: false }],
        options: [{ key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" }],
      },
      input: z.object({
        name: z.string().min(1), sessionId: z.string().optional(),
        payload: z.object({ numbers: z.array(z.number().int().min(0)).min(1) }).optional(),
      }),
      output: commandEnvelopeSchema,
      effects: ["read"],
      description: "projection fixture",
      async execute(input) {
        observed.push(input);
        return {
          version: 1, command: "fixture.projected", status: "ok", code: "fixture.projected.ok", exitCode: 0,
          data: { keys: Object.keys(input).sort(), total: input.payload!.numbers.reduce((sum, number) => sum + number, 0) },
        };
      },
    };
    const original = {
      name: "Ada", sessionId: "seat-1",
      payload: { numbers: [2, 3] },
    };
    // The MCP route's projection: strip the context selector the resolver owns.
    const admitted = admitCommandInput(fixture, original, getCommandSchemas([fixture])[0]!, undefined,
      (data) => {
        const record = { ...(data as Record<string, unknown>) };
        delete record.sessionId;
        return record;
      });
    if (!admitted.success) throw new Error("expected admission to succeed");
    // The strip happened inside admission, and the admitted selector rode along.
    expect(admitted.sessionId).toBe("seat-1");

    // The projected value was formerly republished as `admitted.data` (and the
    // pre-projection object as `admitted.input`). A consumer written against
    // that shape mutates it in place; execution must keep the value admission
    // itself produced, so the observable total stays the validated 5.
    const capability: Record<string, unknown> = { ...admitted };
    const legacyProjected = capability.data;
    if (legacyProjected !== null && typeof legacyProjected === "object") {
      if ("name" in legacyProjected) legacyProjected.name = "";
      if ("payload" in legacyProjected) {
        const payload = legacyProjected.payload;
        if (payload !== null && typeof payload === "object" && "numbers" in payload && Array.isArray(payload.numbers)) {
          payload.numbers.length = 0;
          payload.numbers.push(-5);
        }
      }
    }
    original.name = "";
    original.payload.numbers.length = 0;
    const envelope = await admitted.execute(context());
    expect(envelope).toMatchObject({ status: "ok", data: { keys: ["name", "payload"], total: 5 } });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({ name: "Ada", payload: { numbers: [2, 3] } });
  });

  test("retains the definition's output validation, cancellation and thrown-error outcomes", async () => {
    const fixture: CommandDefinition<{ name: string }, unknown> = {
      id: "fixture.outcomes",
      cli: { path: ["fixture", "outcomes"], aliases: [], arguments: [{ key: "name", required: true, variadic: false }], options: [] },
      input: z.object({ name: z.string().min(1) }),
      output: commandEnvelopeSchema,
      effects: ["read"],
      description: "outcome fixture",
      async execute(input, invocation) {
        if (invocation.signal.aborted) throw new Error("cancelled before work");
        if (input.name === "boom") throw new Error("handler exploded");
        if (input.name === "invalid-output") {
          return { version: 1, command: "fixture.outcomes", status: "ok", code: "ok", exitCode: 7, data: null } as unknown as CommandEnvelope;
        }
        return { version: 1, command: "fixture.outcomes", status: "ok", code: "fixture.outcomes.ok", exitCode: 0, data: { name: input.name } };
      },
    };
    const run = async (name: string): Promise<CommandEnvelope> => {
      const admitted = admit(fixture, { name });
      if (!admitted.success) throw new Error("expected admission to succeed");
      return admitted.execute(context());
    };

    expect(await run("Ada")).toMatchObject({ status: "ok", data: { name: "Ada" } });
    expect(await run("invalid-output")).toMatchObject({ status: "error", code: "command.output-invalid", exitCode: 1 });
    expect(await run("boom")).toMatchObject({ status: "error", code: "command.internal", message: "handler exploded" });

    const cancelled = new AbortController();
    const admitted = admit(fixture, { name: "Ada" });
    if (!admitted.success) throw new Error("expected admission to succeed");
    cancelled.abort();
    expect(await admitted.execute({ ...context(), signal: cancelled.signal })).toMatchObject({
      status: "error", code: "command.cancelled", exitCode: 1,
    });
  });
});