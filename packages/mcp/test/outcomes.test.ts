import assert from "node:assert/strict";
import { test } from "bun:test";
import { z } from "zod";
import { commandEnvelopeSchema, type CommandDefinition } from "@mstar-harness/commands";
import { validateCommandOutcome } from "../src/outcome.js";

const definition = {
  id: "fixture.command",
  cli: { path: ["fixture"], aliases: [], arguments: [], options: [] },
  input: z.object({}),
  output: commandEnvelopeSchema,
  effects: [],
  description: "fixture",
  async execute() { return { version: 1, command: "fixture.command", status: "ok", code: "fixture.ok", exitCode: 0, data: { accepted: true } }; },
} satisfies CommandDefinition;

test("application validates successful envelopes and preserves valid refusals", () => {
  const success = { version: 1, command: "fixture.command", status: "ok", code: "fixture.ok", exitCode: 0, data: { accepted: true } };
  assert.deepEqual(validateCommandOutcome(definition, success), success);
  const refused = { version: 1, command: "fixture.command", status: "refused", code: "fixture.denied", exitCode: 17, message: "not allowed" };
  assert.deepEqual(validateCommandOutcome(definition, refused), refused);
});

test("application rejects malformed error, wrong-command and success-schema envelopes", () => {
  assert.throws(() => validateCommandOutcome(definition, {
    version: 1, command: "fixture.command", status: "error", code: "child.failed", exitCode: 0, message: "bad status exit",
  }), /invalid failure envelope/);
  assert.throws(() => validateCommandOutcome(definition, {
    version: 1, command: "different.command", status: "refused", code: "fixture.denied", exitCode: 1, message: "wrong identity",
  }), /command identity mismatch/);

  const strict = { ...definition, output: z.union([
    z.object({ version: z.literal(1), command: z.literal("fixture.command"), status: z.literal("ok"), code: z.string(), exitCode: z.literal(0), data: z.object({ accepted: z.boolean() }) }),
    z.object({ version: z.literal(1), command: z.literal("fixture.command"), status: z.enum(["refused", "error"]), code: z.string(), exitCode: z.number().int().refine((code) => code !== 0), message: z.string() }),
    z.object({ version: z.literal(1), command: z.literal("fixture.command"), status: z.literal("usage"), code: z.string(), exitCode: z.literal(2), message: z.string() }),
  ]) } as CommandDefinition;
  assert.throws(() => validateCommandOutcome(strict, {
    version: 1, command: "fixture.command", status: "ok", code: "fixture.ok", exitCode: 0, data: { accepted: "not boolean" },
  }), /invalid success envelope/);
});
