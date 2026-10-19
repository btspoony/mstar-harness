import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import {
  ACTIVATION_PROTOCOL_VERSION,
  createExecutionWorkflow,
  encodeExecutionSessionRef,
  executionContextFor,
  initializeStore,
  readExecutionAuthority,
  type ActivationAttestation,
  type ExecutionToken,
} from "@mstar-harness/engine";
import { getCommandDefinitions, type CommandEnvelope, type InvocationContext } from "@mstar-harness/commands";
import { registerMcpCommands, type ResolveContext } from "../src/mcp/register";
import { registerCliCommands } from "../src/command-adapter";
import { createMcpServer } from "../src/mcp/server";
import { createContextResolver, resolveContext } from "../src/mcp/stdio";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type EngineManifest = { engines?: { node?: string } };
// Repo manifest read at runtime: no test pins the runtime floor, and
// package.json stays the sole version authority.
const CLI_ROOT = path.resolve(import.meta.dir, "..");
const declaredNodeFloor = (
  (JSON.parse(readFileSync(path.join(CLI_ROOT, "..", "engine", "package.json"), "utf8")) as EngineManifest)
    .engines?.node ?? ""
).replace(/^>=\s*/, "").trim();
/** Injected current runtime: at/above the declared floor. */
const AT_OR_ABOVE_RUNTIME = `${Number.parseInt(declaredNodeFloor.split(".")[0]!, 10) + 1}.0.0`;

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
      // Runtime version derived from the engine manifest floor; the plugin
      // version is synthetic, not a release number.
      runtime: "node", runtimeVersion: AT_OR_ABOVE_RUNTIME, version: "0.0.0-synthetic",
      current: true, disposition: "reloaded",
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
  /**
   * `server` drives the production assembly (`createMcpServer` wrapping the
   * resolver). `register` binds the resolver straight to `registerMcpCommands`,
   * which bypasses that wrapper and is therefore only a unit seam.
   */
  assembly: "register" | "server" = "register",
): Promise<CommandEnvelope> {
  const definition = getCommandDefinitions().find((entry) => entry.id === commandId);
  if (definition === undefined) throw new Error(`missing command: ${commandId}`);
  const server = assembly === "server"
    ? createMcpServer(resolver, [definition])
    : new McpServer({ name: "identity-test-server", version: "1.0.0" });
  const client = new Client({ name: "identity-test-client", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  try {
    if (assembly === "register") registerMcpCommands(server, [definition], resolver);
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === `mstar_${commandId.replace(/[.-]/g, "_")}`);
    const published = (tool?.inputSchema.properties ?? {}) as Record<string, unknown>;
    if (resolver.identityLocked === true) {
      // A locked connection publishes no session selector: the identity is
      // the connection's, never model-choosable.
      expect(published.sessionId).toBeUndefined();
      expect(tool?.inputSchema.required ?? []).not.toContain("sessionId");
    } else {
      expect(published).toMatchObject({ sessionId: { type: "string" } });
      expect(tool?.inputSchema.required ?? []).not.toContain("sessionId");
    }
    const result = await client.callTool({ name: `mstar_${commandId.replace(/[.-]/g, "_")}`, arguments: payload });
    if (result.structuredContent !== undefined) return result.structuredContent as CommandEnvelope;
    const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const start = text.indexOf('{"version":1,');
    if (start < 0) throw new Error(`SDK refusal lost its safe command facts: ${text}`);
    return JSON.parse(text.slice(start)) as CommandEnvelope;
  } finally {
    await client.close();
    await server.close();
  }
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
  const authority = await readExecutionAuthority({ harnessDir: harness });
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
    expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
  });

  test("absent identity preserves active recovery usage and help", async () => {
    const root = fixtureRoot();
    const result = await registeredMcpCall(
      "session.recover",
      recoveryInput(writeAttestation(root)),
      context(root),
    );
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input" });
    expect(result.details?.helpRoute).toBe("mstar session recover --help");
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
      expect(result).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(result.details?.helpRoute).toBe("mstar session recover --help");
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
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env.MSTAR_HOST_SESSION_ID;
      else process.env.MSTAR_HOST_SESSION_ID = previous;
    }
  });

  /**
   * The declared channel is the only environment identity the stdio resolver
   * may read, and only when the launcher names it. Each case restores the
   * variable it touched so the default "ignore ambient identity" cases stay
   * independent of the host's environment.
   */
  const DECLARED_IDENTITY = "MSTAR_TEST_DECLARED_IDENTITY";
  test("a declared environment channel supplies the default session identity", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "declared-mcp-session";
    try {
      const fixture = await initializedHarness();
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness },
        context(fixture.root),
        createContextResolver({ identityEnv: DECLARED_IDENTITY }),
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  /**
   * The declared default has to survive the production assembly, not only a
   * direct `registerMcpCommands` binding: `createMcpServer` wraps the resolver
   * in its own request-context function, so this is the path the real
   * `mstar mcp` process installs and the only one that proves a required
   * session selector is satisfied by `--identity-env`.
   */
  test("the production server admits a required sessionId from the declared channel", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "declared-mcp-session";
    try {
      const fixture = await initializedHarness();
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness },
        context(fixture.root),
        createContextResolver({ identityEnv: DECLARED_IDENTITY }),
        "server",
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  test("without --identity-env the same environment variable is still ignored", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "declared-mcp-session";
    try {
      const fixture = await initializedHarness();
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness },
        context(fixture.root),
        resolveContext,
      );
      expect(result).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(result.details?.helpRoute).toBe("mstar session recover --help");
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  /**
   * A locked connection (a declared channel) strips a caller-supplied
   * selector BEFORE admission, so the declared identity governs every call.
   * The declared value here is malformed on purpose: it makes the outcome
   * prove WHOSE identity carried the call. The stripped caller id
   * ("main-session", valid) never reaches the engine — the declared value
   * reaches the shared safe-id guard and refuses specifically.
   */
  test("a locked connection strips a per-call sessionId — the declared identity governs even a malformed one", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "../declared-session";
    try {
      const fixture = await initializedHarness();
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "main-session" },
        context(fixture.root),
        createContextResolver({ identityEnv: DECLARED_IDENTITY }),
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.invalid-session-id" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  /**
   * SEC-01 regression on the production MCP path (the assembly the real
   * `mstar mcp` process installs): a cross-identity override attempt through
   * the declared-connection tools is refused — the caller-supplied DIFFERENT
   * valid session id is stripped before admission while the declared
   * (malformed) value reaches the identity guard, so a caller can never run
   * the call under its own id. The generic unbound connection keeps the
   * per-call selector (the cases above).
   */
  test("the production server strips a cross-identity sessionId on a locked connection", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "../declared-session";
    try {
      const fixture = await initializedHarness();
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "main-session" },
        context(fixture.root),
        createContextResolver({ identityEnv: DECLARED_IDENTITY }),
        "server",
      );
      // The declared identity reached the guard — never the caller's valid id.
      expect(result).toMatchObject({ status: "refused", code: "coordination.invalid-session-id" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  test("a malformed declared identity fails loudly at the shared safe-id guard", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "../declared-session";
    try {
      const fixture = await initializedHarness();
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness },
        context(fixture.root),
        createContextResolver({ identityEnv: DECLARED_IDENTITY }),
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.invalid-session-id" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  test("a blank declared identity means no identity at all", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "  \t";
    try {
      const root = fixtureRoot();
      const result = await registeredMcpCall(
        "session.recover",
        recoveryInput(writeAttestation(root)),
        context(root),
        createContextResolver({ identityEnv: DECLARED_IDENTITY }),
      );
      expect(result).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(result.details?.helpRoute).toBe("mstar session recover --help");
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });


  test("invalid identity formats fail specifically at the shared safe-id guard", async () => {
    const fixture = await initializedHarness();
    const attestation = writeAttestation(fixture.root);
    const before = readFileSync(path.join(fixture.harness, "store.db"));
    for (const [sessionId, code] of [
      ["", "command.invalid-input"],
      ["../other-session", "coordination.invalid-session-id"],
      ["folder\\\\session", "coordination.invalid-session-id"],
    ]) {
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(attestation), harness: fixture.harness, sessionId },
        context(fixture.root),
      );
      expect(result).toMatchObject({ status: sessionId === "" ? "usage" : "refused", code });
      if (sessionId === "") {
        expect(result.details?.diagnostics).toContainEqual(expect.objectContaining({ path: "sessionId", expected: "non-empty string", received: '""' }));
      }
    }
    expect(readFileSync(path.join(fixture.harness, "store.db"))).toEqual(before);
  });

  test("wrong session supplied per-call cannot read a recorded coordinator session", async () => {
    const fixture = await initializedHarness();
    const workflow = "wf-owned";
    const plan = "plan-owned";
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fixture.root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: fixture.root });
    const owner = { source: "local" as const, sessionId: "recorded-owner", workflowId: workflow, role: "coordinator" as const };
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
    expect(bound.status).toBe("ok");
    const sessionRef = encodeExecutionSessionRef({
      storeId: fixture.authority.storeId, epoch: fixture.authority.epoch,
      workflowId: workflow, role: "coordinator", sessionId: owner.sessionId,
    });
    const payload = { sessionRef, plan, harness: fixture.harness };
    const ownerRead = await registeredMcpCall("plan.show", { ...payload, sessionId: owner.sessionId }, context(fixture.root));
    expect(ownerRead.status).toBe("ok");
    const before = readFileSync(path.join(fixture.harness, "store.db"));
    const wrongSession = await registeredMcpCall("plan.show", { ...payload, sessionId: "different-valid-session" }, context(fixture.root));
    const after = readFileSync(path.join(fixture.harness, "store.db"));
    expect(wrongSession).toMatchObject({ status: "refused", code: "coordination.identity-mismatch" });
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

});
