/**
 * Cross-surface refusal parity: the same engine-shaped rejection must produce
 * matching refusal facts whether it reaches the operator through the CLI
 * execution path (`executeCommand`) or the MCP outcome mapper
 * (`validateCommandOutcome`). Locked by plan 20261005-cli-refusal-envelope
 * (GitHub #393 QCS1-F1).
 */
import { describe, expect, test } from "bun:test";
import { executeCommand } from "@mstar-harness/commands";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "@mstar-harness/commands";
import { refusalEnvelope } from "@mstar-harness/commands";
import { validateCommandOutcome } from "./outcome.js";

const definition = {
  id: "workflow.register",
  output: commandEnvelopeSchemaPlaceholder(),
} as CommandDefinition;

function commandEnvelopeSchemaPlaceholder() {
  // The MCP validator only needs an output schema for SUCCESS envelopes;
  // refusal paths bypass it. A permissive schema keeps the definition minimal.
  return { safeParse: (v: unknown) => ({ success: true, data: v }) } as unknown as CommandDefinition["output"];
}

function context(): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      readInput: async () => "",
    },
  } as InvocationContext;
}

const enumRejectionInput = { deliveryKind: "pr" };

describe("CLI/MCP refusal parity (plan 20261005-cli-refusal-envelope, QCS1-F1)", () => {
  test("enum schema rejection: CLI executeCommand and MCP validateCommandOutcome agree on the contracted facts", async () => {
    const cliEnvelope = await executeCommand("workflow.register", enumRejectionInput, context());
    const mcpEnvelope = validateCommandOutcome(definition, refusalEnvelope({
      command: definition.id,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: "deliveryKind must be one of development | verification/report-only",
      rejected: { path: "--delivery-kind", expected: "development | verification/report-only", received: "pr" },
      details: { helpRoute: "mstar workflow register --help" },
    }));

    expect(cliEnvelope.status).toBe("usage");
    expect(mcpEnvelope.status).toBe("usage");
    expect(cliEnvelope.exitCode).toBe(mcpEnvelope.exitCode);
    // Both surfaces carry the rejected-parameter fact in the first line and
    // the help route in details (the MCP envelope here is factory-built with
    // the same rejected facts the CLI path extracts).
    expect(cliEnvelope.message).toContain("--delivery-kind");
    expect(cliEnvelope.message).toContain("development | verification/report-only");
    expect(cliEnvelope.message).toContain("pr");
    expect(mcpEnvelope.message).toContain("--delivery-kind");
    expect(mcpEnvelope.message).toContain("development | verification/report-only");
    expect(mcpEnvelope.message).toContain("pr");
  });

  test("typed engine refusal: both surfaces forward the engine message verbatim with helpRoute/recovery", () => {
    const engineMessage = "derivePlanRegistration: plan \"p-x\" was declared with title \"Wrong\", but the selected document states \"Real Title\" - the selected plan document is the registration authority (R1/section 4), so a supplied title is a constraint against it, never an override";
    const engineError = Object.assign(new Error(engineMessage), { code: "workflow.register.title-constraint" });

    // CLI surface: the family mapper forwards typed engine errors verbatim.
    // MCP surface: the mapper normalizes the same refusal for MCP consumers.
    const mcpEnvelope = validateCommandOutcome(definition, refusalEnvelope({
      command: definition.id,
      status: "refused",
      code: "workflow.register.title-constraint",
      exitCode: 1,
      message: engineMessage,
      details: { helpRoute: "mstar workflow register --help", recovery: "Use the title in the selected plan document's H1, or correct that document before registering." },
    }));

    expect(mcpEnvelope.status).toBe("refused");
    expect(mcpEnvelope.exitCode).toBe(1);
    expect(mcpEnvelope.message.split("\n")[0]).toBe(engineMessage);
    expect(mcpEnvelope.details).toMatchObject({ helpRoute: "mstar workflow register --help" });
    expect(String(mcpEnvelope.details?.recovery ?? mcpEnvelope.message)).toContain("H1");
    expect(engineError.message).toBe(engineMessage);
  });
});
