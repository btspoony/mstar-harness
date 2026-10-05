/**
 * Cross-surface refusal parity: the same engine-shaped rejection must produce
 * matching refusal facts whether it reaches the operator through the CLI
 * execution path (`executeCommand` / family mappers) or the MCP outcome mapper
 * (`validateCommandOutcome`). Locked by plan 20261005-cli-refusal-envelope
 * (GitHub #393 QCS1-F1).
 */
import { describe, expect, test } from "bun:test";
import {
  executeCommand,
  getCommandDefinitions,
  getSddCommandDefinitions,
  sddFailed,
  refusalEnvelope,
  type CommandDefinition,
  type InvocationContext,
} from "@mstar-harness/commands";
import { SddScriptError } from "@mstar-harness/engine";
import { validateCommandOutcome } from "./outcome.js";

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

const allDefinitions = getCommandDefinitions();
const sddDefinitions = getSddCommandDefinitions();

function definitionById(id: string): CommandDefinition {
  const found =
    allDefinitions.find((d: CommandDefinition) => d.id === id) ??
    sddDefinitions.find((d: CommandDefinition) => d.id === id);
  if (found === undefined) throw new Error(`parity test: no definition for ${id}`);
  return found;
}

const workflowRegisterDefinition = definitionById("workflow.register");
const planBindDefinition = definitionById("plan.bind");
const sddEvidenceCaptureDefinition = definitionById("sdd.evidence.capture");

describe("CLI/MCP refusal parity (plan 20261005-cli-refusal-envelope, QCS1-F1)", () => {
  test("enum schema rejection: executeCommand and the factory-built MCP envelope agree on first-line facts", async () => {
    const cli = await executeCommand("workflow.register", { deliveryKind: "pr" }, context());
    const mcp = validateCommandOutcome(
      workflowRegisterDefinition,
      refusalEnvelope({
        command: "workflow.register",
        status: "usage",
        code: "command.invalid-input",
        exitCode: 2,
        message: "deliveryKind must be one of development | verification/report-only",
        rejected: { path: "--delivery-kind", expected: "development | verification/report-only", received: "pr" },
        details: { helpRoute: "mstar workflow register --help" },
      }),
    );

    expect(cli.message.split("\n")[0]).toBe(mcp.message.split("\n")[0]);
    expect(cli.message).toContain("--delivery-kind");
    expect(mcp.message).toContain("--delivery-kind");
    expect(cli.exitCode).toBe(2);
    expect(mcp.exitCode).toBe(2);
  });

  test("empty session selector: selector admission reaches the factory with help/recovery on both surfaces", async () => {
    const cli = await executeCommand("plan.bind", { sessionId: "" }, context());
    expect(cli.status).toBe("usage");
    expect(cli.details).toBeDefined();
    const mcp = validateCommandOutcome(planBindDefinition, cli);
    expect(mcp.status).toBe(cli.status);
    expect(mcp.message.split("\n")[0]).toBe(cli.message.split("\n")[0]);
    expect(mcp.details).toMatchObject(cli.details as Record<string, unknown>);
  });

  test("SDD nonstandard exit-3 refusal: family mapper and MCP mapper agree (exit preserved, verbatim message)", () => {
    const err = new SddScriptError("sdd script failed mid-run", 3);
    const cli = sddFailed("sdd.evidence.capture", err);
    const mcp = validateCommandOutcome(sddEvidenceCaptureDefinition, cli);
    expect(mcp.status).toBe(cli.status);
    expect(mcp.exitCode).toBe(cli.exitCode);
    expect(mcp.exitCode).not.toBe(1);
    expect(mcp.message.split("\n")[0]).toBe(cli.message.split("\n")[0]);
  });
});
