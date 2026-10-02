import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CommandDefinitionError,
  commandEnvelopeSchema,
  getCommandDefinitions,
  getCommandSchemas,
  getPayloadSchema,
  validateCommandDefinitions,
} from "../src/index.js";
import type { CommandDefinition } from "../src/types.js";

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
