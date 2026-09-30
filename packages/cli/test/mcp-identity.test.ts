import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { getCommandDefinitions, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";
import { registerMcpCommands, mcpToolInputSchema } from "../src/mcp/register";
import { registerCliCommands } from "../src/command-adapter";

const effects = {
  async readInput() { return ""; },
  async spawn() { throw new Error("unused"); },
  async startDashboard() { throw new Error("unused"); },
  async openBrowser() { throw new Error("unused"); },
};
const context: InvocationContext = {
  cwd: process.cwd(), controlRoot: null,
  versions: { engine: null, cli: "test", plugin: null, host: null, platform: "test" },
  signal: new AbortController().signal, effects,
};

async function callRecover(payload: Record<string, unknown>) {
  let registered: ((input: unknown, extra: { mcpReq: { signal: AbortSignal } }) => Promise<unknown>) | undefined;
  const server = {
    registerTool(name: string, _options: unknown, handler: typeof registered) {
      if (name === "mstar_session_recover") registered = handler;
    },
  };
  const definitions = getCommandDefinitions();
  registerMcpCommands(server as never, definitions, () => context);
  const handler = registered;
  if (handler === undefined) throw new Error("session.recover was not registered");
  return handler(payload, { mcpReq: { signal: context.signal } }) as Promise<{ structuredContent: { status: string; message: string } }>;
}

const recoveryInput = {
  workflow: "wf-recovery", priorSession: "stopped", reason: "restart",
  attestation: "/tmp/missing-recovery-attestation.json", expect: "token", operation: "recover-1",
};

describe("MCP session identity", () => {
  test("a per-call identity passes the identity check and reaches attestation loading", async () => {
    const result = await callRecover({ ...recoveryInput, sessionId: "main-session" });
    expect(result.structuredContent.status).toBe("refused");
    expect(result.structuredContent.message).not.toContain("active recovery requires the main conversation session identity");
  });

  test("an absent identity preserves the active recovery usage refusal", async () => {
    const result = await callRecover(recoveryInput);
    expect(result.structuredContent).toMatchObject({
      status: "usage", message: "active recovery requires the main conversation session identity",
    });
  });

  test("invalid identity formats still refuse", async () => {
    for (const sessionId of ["", "../other-session", "folder\\\\session"]) {
      const result = await callRecover({ ...recoveryInput, sessionId });
      expect(result.structuredContent.status).not.toBe("ok");
      expect(result.structuredContent.message).not.toContain("active recovery requires the main conversation session identity");
    }
  });

  test("MCP schema exposes optional identity and CLI exposes --session-id", () => {
    const recovery = getCommandDefinitions().find((definition) => definition.id === "session.recover") as CommandDefinition;
    expect(mcpToolInputSchema(recovery).safeParse({ workflow: "wf-recovery", sessionId: "main-session" }).success).toBe(true);
    expect(mcpToolInputSchema(recovery).safeParse({ workflow: "wf-recovery" }).success).toBe(true);
    expect(recovery.cli.options).toContainEqual({
      key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId",
    });
    const program = new Command();
    program.exitOverride();
    registerCliCommands(program, getCommandDefinitions(), context);
    const recover = program.commands.find((candidate) => candidate.name() === "session")?.commands.find((candidate) => candidate.name() === "recover");
    expect(recover?.options.map((option) => option.long)).toContain("--session-id");
  });
});
