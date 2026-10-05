import { describe, expect, test } from "bun:test";
import { commandEnvelopeSchema, refusalEnvelope, type CommandDefinition } from "@mstar-harness/commands";
import { validateCommandOutcome } from "./outcome.js";

const definition = {
  id: "workflow.register",
  output: commandEnvelopeSchema,
} as CommandDefinition;

describe("MCP command outcome refusal contract", () => {
  test("usage rejection preserves first-line rejected-input facts", () => {
    const envelope = refusalEnvelope({
      command: definition.id,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: "invalid enum value",
      rejected: { path: "--delivery-kind", expected: "pr | verification", received: "unknown" },
    });

    expect(validateCommandOutcome(definition, envelope)).toMatchObject({
      status: "usage",
      message: "Rejected --delivery-kind: expected pr | verification; received unknown",
      details: { helpRoute: "mstar workflow register --help", recovery: expect.any(String) },
    });
  });

  test("typed refusal preserves engine message and recovery route", () => {
    const engineMessage = "Workflow is owned by the active authority.";
    const envelope = refusalEnvelope({
      command: definition.id,
      status: "refused",
      code: "execution.consumer-not-ready",
      exitCode: 1,
      message: engineMessage,
      helpRoute: "mstar workflow register --help",
      recovery: "Re-run with --execution.",
    });

    expect(validateCommandOutcome(definition, envelope)).toMatchObject({
      status: "refused",
      message: `${engineMessage}\nHelp: mstar workflow register --help\nRecovery: Re-run with --execution.`,
      details: { helpRoute: "mstar workflow register --help", recovery: "Re-run with --execution." },
    });
  });

  test("success envelope shape remains unchanged", () => {
    const envelope = { version: 1, command: definition.id, status: "ok", code: "ok", exitCode: 0, data: { registered: true } };
    expect(validateCommandOutcome(definition, envelope)).toEqual(envelope);
  });
});
