import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import {
  ACTIVATION_PROTOCOL_VERSION,
  createExecutionWorkflow,
  encodeExecutionSessionRef,
  executionContextFor,
  initializeExecutionAuthority,
  initializeStore,
  type ActivationAttestation,
  type ExecutionToken,
} from "@mstar-harness/engine";
import { getCommandDefinitions, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";
import { registerMcpCommands, mcpToolInputSchema, type ResolveContext } from "../src/mcp/register";
import { registerCliCommands } from "../src/command-adapter";
import { resolveContext } from "../src/mcp/stdio";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const effects = {
  async readInput() { return ""; },
  async spawn() { throw new Error("unused"); },
  async startDashboard() { throw new Error("unused"); },
  async openBrowser() { throw new Error("unused"); },
};

function context(cwd: string, overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    cwd, controlRoot: null,
    versions: { engine: null, cli: "test", plugin: null, host: null, platform: "test" },
    signal: new AbortController().signal, effects, ...overrides,
  };
}

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-identity-"));
  roots.push(root);
  return root;
}

function writeAttestation(root: string, stoppedSessions: readonly string[] = ["stopped-holder"]): string {
  const attestation: ActivationAttestation = {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-01-02T04:00:00.000Z",
    operator: { actor: "ops-engineer", authorizationRef: "test recovery fixture" },
    consumers: [{
      entryId: "coordinator-test", kind: "coordinator", entrypoint: "/opt/mstar/coordinator.js",
      runtime: "node", runtimeVersion: "24.18.0", version: "3.11.2", current: true, disposition: "reloaded",
    }],
    stoppedSessions: stoppedSessions.map((sessionId) => ({ sessionId, host: "omp", state: "stopped" })),
  };
  const file = path.join(root, `attestation-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(attestation));
  return file;
}

async function registeredMcpCall(
  commandId: string,
  payload: Record<string, unknown>,
  baseContext: InvocationContext,
  resolver: ResolveContext = () => baseContext,
): Promise<{ structuredContent: { status: string; code: string; message: string } }> {
  let registered: ((input: unknown, extra: { mcpReq: { signal: AbortSignal } }) => Promise<unknown>) | undefined;
  const server = {
    registerTool(name: string, _options: unknown, handler: typeof registered) {
      if (name === `mstar_${commandId.replace(/[.-]/g, "_")}`) registered = handler;
    },
  };
  registerMcpCommands(server as never, getCommandDefinitions(), resolver);
  if (registered === undefined) throw new Error(`MCP handler not registered: ${commandId}`);
  return await registered(payload, { mcpReq: { signal: baseContext.signal } }) as { structuredContent: { status: string; code: string; message: string } };
}

async function runCli(args: string[], baseContext: InvocationContext): Promise<Record<string, unknown>> {
  const program = new Command();
  program.name("mstar").exitOverride();
  registerCliCommands(program, getCommandDefinitions(), baseContext);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "mstar", ...args], { from: "node" });
  } finally {
    console.log = log;
    process.exitCode = 0;
  }
  return JSON.parse(lines.join("")) as Record<string, unknown>;
}


async function initializedHarness() {
  const root = fixtureRoot();
  const harness = path.join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  (await initializeStore({ harnessDir: harness })).close();
  const authority = await initializeExecutionAuthority({ harnessDir: harness });
  return { root, harness, authority };
}

const recoveryInput = (attestation: string) => ({
  workflow: "wf-missing-recovery", priorSession: "stopped-holder", reason: "restart",
  attestation, expect: "token", operation: `recover-${randomUUID()}`,
});

describe("MCP session identity", () => {
  test("per-call identity passes its format gate and reaches workflow lookup", async () => {
    const fixture = await initializedHarness();
    const attestation = writeAttestation(fixture.root);
    const result = await registeredMcpCall(
      "session.recover",
      { ...recoveryInput(attestation), harness: fixture.harness, sessionId: "main-session" },
      context(fixture.root),
    );
    expect(result.structuredContent).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
  });

  test("absent identity preserves the exact active recovery usage refusal", async () => {
    const root = fixtureRoot();
    const result = await registeredMcpCall(
      "session.recover",
      recoveryInput(writeAttestation(root)),
      context(root),
    );
    expect(result.structuredContent).toMatchObject({
      status: "usage", code: "command.invalid-input",
      message: "active recovery requires the main conversation session identity",
    });
  });
  test("stdio resolver ignores the legacy environment identity when no parameter is supplied", async () => {
    const previous = process.env.MSTAR_HOST_SESSION_ID;
    process.env.MSTAR_HOST_SESSION_ID = "ambient-session";
    try {
      const root = fixtureRoot();
      const result = await registeredMcpCall(
        "session.recover",
        recoveryInput(writeAttestation(root)),
        context(root),
        resolveContext,
      );
      expect(result.structuredContent).toMatchObject({
        status: "usage", message: "active recovery requires the main conversation session identity",
      });
    } finally {
      if (previous === undefined) delete process.env.MSTAR_HOST_SESSION_ID;
      else process.env.MSTAR_HOST_SESSION_ID = previous;
    }
  });

  test("a per-call parameter overrides any environment identity", async () => {
    const previous = process.env.MSTAR_HOST_SESSION_ID;
    process.env.MSTAR_HOST_SESSION_ID = "../ambient-session";
    try {
      const fixture = await initializedHarness();
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "main-session" },
        context(fixture.root),
        resolveContext,
      );
      expect(result.structuredContent).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env.MSTAR_HOST_SESSION_ID;
      else process.env.MSTAR_HOST_SESSION_ID = previous;
    }
  });


  test("invalid identity formats fail specifically at the shared safe-id guard", async () => {
    const fixture = await initializedHarness();
    const attestation = writeAttestation(fixture.root);
    const before = readFileSync(path.join(fixture.harness, "store.db"));
    for (const [sessionId, code] of [
      ["", "coordination.identity-missing"],
      ["../other-session", "coordination.invalid-session-id"],
      ["folder\\\\session", "coordination.invalid-session-id"],
    ]) {
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(attestation), harness: fixture.harness, sessionId },
        context(fixture.root),
      );
      expect(result.structuredContent).toMatchObject({ status: "refused", code });
    }
    expect(readFileSync(path.join(fixture.harness, "store.db"))).toEqual(before);
  });

  test("wrong session supplied per-call cannot read a recorded coordinator session", async () => {
    const fixture = await initializedHarness();
    const workflow = "wf-owned";
    const plan = "plan-owned";
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fixture.root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: fixture.root });
    const owner = { source: "local" as const, sessionId: "recorded-owner", workflowId: workflow, role: "coordinator" as const, planId: null };
    const created = await createExecutionWorkflow(executionContextFor({ harnessDir: fixture.harness }, owner), {
      entry: { id: workflow, type: "iteration", status: "running", started_at: "2026-09-30T00:00:00Z", dir: `workflows/${workflow}` } as never,
      snapshot: {
        schema_version: 1, id: workflow, type: "iteration", status: "running",
        started_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
        branch: { base: "main" },
        plans: [{ id: plan, plan_id: plan, title: "Owned plan", file: `.mstar/plans/${plan}.md`, status: "Todo", metadata: { project_id: "_default" } }],
      } as never,
      expected: fixture.authority.token,
      operationId: "create-owned-workflow",
    });
    const token = (created.data as unknown as { workflows: Array<{ workflowToken: ExecutionToken }> }).workflows[0]!.workflowToken;
    const bound = await registeredMcpCall("plan.bind", {
      execution: true, coordinator: true, workflow, harness: fixture.harness, expect: token,
      operation: "bind-recorded-owner", sessionId: owner.sessionId,
    }, context(fixture.root));
    expect(bound.structuredContent.status).toBe("ok");
    const sessionRef = encodeExecutionSessionRef({
      storeId: fixture.authority.storeId, epoch: fixture.authority.epoch,
      workflowId: workflow, role: "coordinator", sessionId: owner.sessionId, planId: null,
    });
    const payload = { sessionRef, plan, harness: fixture.harness };
    const ownerRead = await registeredMcpCall("plan.show", { ...payload, sessionId: owner.sessionId }, context(fixture.root));
    expect(ownerRead.structuredContent.status).toBe("ok");
    const before = readFileSync(path.join(fixture.harness, "store.db"));
    const wrongSession = await registeredMcpCall("plan.show", { ...payload, sessionId: "different-valid-session" }, context(fixture.root));
    const after = readFileSync(path.join(fixture.harness, "store.db"));
    expect(wrongSession.structuredContent).toMatchObject({ status: "refused", code: "coordination.session-mismatch" });
    expect(after).toEqual(before);
  });

  test("CLI parses and routes --session-id through the command adapter", async () => {
    const fixture = await initializedHarness();
    const attestation = writeAttestation(fixture.root);
    const result = await runCli([
      "session", "recover", "--workflow", "wf-missing-recovery", "--prior-session", "stopped-holder",
      "--reason", "restart", "--attestation", attestation, "--expect", "token",
      "--operation", `cli-${randomUUID()}`, "--harness", fixture.harness, "--session-id", "cli-main-session",
    ], context(fixture.root));
    expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
  });

  test("MCP schema publishes identity as an optional argument", () => {
    const recovery = getCommandDefinitions().find((definition) => definition.id === "session.recover") as CommandDefinition;
    expect(mcpToolInputSchema(recovery).safeParse({ workflow: "wf-recovery", sessionId: "main-session" }).success).toBe(true);
    expect(mcpToolInputSchema(recovery).safeParse({ workflow: "wf-recovery" }).success).toBe(true);
  });
});
