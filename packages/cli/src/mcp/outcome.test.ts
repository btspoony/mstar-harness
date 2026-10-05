import { commandEnvelopeSchema, executeCommand, getCommandDefinitions, getSddCommandDefinitions, refusalEnvelope, sddFailed, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";
import { SddScriptError } from "@mstar-harness/engine";
import { validateCommandOutcome } from "./outcome.js";

function context(cwd = "/tmp"): InvocationContext {
  return {
    cwd, controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      readInput: async () => "",
      spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      startDashboard: async () => ({ url: "", close: async () => {} }),
      openBrowser: async () => {},
    },
  };
}

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

  test("a non-standard refusal exit is not collapsed to 1 on the MCP surface", () => {
    const envelope = refusalEnvelope({
      command: definition.id,
      status: "refused",
      code: "sdd.task-brief.refused",
      exitCode: 3,
      message: "task 3 not found in the plan document",
    });
    const outcome = validateCommandOutcome(definition, envelope);
    expect(outcome).toMatchObject({ status: "refused", code: "sdd.task-brief.refused", exitCode: 3 });
    expect(outcome.message.split("\n")[0]).toBe("task 3 not found in the plan document");
    expect(outcome.details).toMatchObject({ helpRoute: "mstar workflow register --help" });
  });

  test("a first-line rejected-input fact survives the MCP round trip", () => {
    const envelope = refusalEnvelope({
      command: definition.id,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: "invalid value",
      rejected: { path: "--session-id", expected: "non-empty string", received: '""' },
    });
    const outcome = validateCommandOutcome(definition, envelope);
    expect(outcome.message.split("\n")[0]).toBe('Rejected --session-id: expected non-empty string; received ""');
    expect(outcome).toMatchObject({ status: "usage", exitCode: 2 });
  });
  test("SDD exit-3 refusal reaches the MCP consumer with matching metadata (QCS1-F1)", () => {
    const err = new SddScriptError("sdd script failed mid-run", 3);
    const cli = sddFailed("sdd.evidence.capture", err);
    const sddDefinition = getSddCommandDefinitions().find((entry) => entry.id === "sdd.evidence.capture");
    if (sddDefinition === undefined) throw new Error("missing sdd.evidence.capture definition");
    const mcp = validateCommandOutcome(sddDefinition, cli);

    expect(mcp.status).toBe(cli.status);
    expect(mcp.code).toBe(cli.code);
    expect(mcp.exitCode).toBe(3);
    expect(mcp.message.split("\n")[0]).toBe(cli.message.split("\n")[0]);
    expect(mcp.details).toEqual(cli.details);
  });

  test("status.validate missing-harness refusal reaches the MCP consumer with matching metadata (QCS1-F1)", async () => {
    const cli = await executeCommand("status.validate", {}, context("/tmp/parity-no-such-harness"));
    const statusDefinition = getCommandDefinitions().find((entry) => entry.id === "status.validate");
    if (statusDefinition === undefined) throw new Error("missing status.validate definition");
    const mcp = validateCommandOutcome(statusDefinition, cli);

    expect(mcp.status).toBe("refused");
    expect(mcp.code).toBe(cli.code);
    expect(mcp.exitCode).toBe(cli.exitCode);
    expect(mcp.message.split("\n")[0]).toBe(cli.message.split("\n")[0]);
    expect(mcp.details).toEqual(cli.details);
    expect((mcp.details as Record<string, unknown>).helpRoute).toBeDefined();
  });
});
