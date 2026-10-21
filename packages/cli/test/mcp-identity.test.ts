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
import { actionOf, familyOf, familyToolName } from "../src/mcp/fold";
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

/**
 * The folded tool one command id publishes under, and the `action` that selects
 * it. The tool name derives from the definition's authored family segment
 * (`familyOf(definition)`), never from the id prefix, so the lookup goes
 * through the definition the id names.
 */
function foldedTool(commandId: string): { name: string; action: string } {
  const definition = getCommandDefinitions().find((entry) => entry.id === commandId);
  if (definition === undefined) throw new Error(`unknown command id ${JSON.stringify(commandId)}`);
  return { name: familyToolName(familyOf(definition)), action: actionOf(commandId) };
}

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

/**
 * A resolver whose launch EXPLICITLY opted in to caller-declared identity
 * (`--trust-caller-session-id`): the only deployment shape that publishes the
 * per-call session selector. Production defaults to off.
 */
function trustingContext(base: InvocationContext): ResolveContext {
  const resolver: ResolveContext = () => base;
  Object.defineProperty(resolver, "callerIdentity", { value: true, enumerable: true });
  return resolver;
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
    const tool = tools.find((entry) => entry.name === foldedTool(commandId).name);
    const published = (tool?.inputSchema.properties ?? {}) as Record<string, unknown>;
    // Only an opted-in launcher publishes the per-call selector; the default
    // connection has no caller identity and does not advertise one.
    if (resolver.callerIdentity === true) expect(published).toMatchObject({ sessionId: { type: "string" } });
    else expect(published).not.toHaveProperty("sessionId");
    expect(tool?.inputSchema.required ?? []).not.toContain("sessionId");
    const result = await client.callTool({ name: foldedTool(commandId).name, arguments: { action: foldedTool(commandId).action, ...payload } });
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

type PublishedTool = Readonly<{
  description?: string;
  inputSchema: Readonly<{
    properties?: Readonly<Record<string, unknown>>;
    required?: readonly string[];
    "x-mstar-requirements"?: readonly Readonly<{ name: string }>[];
  }>;
}>;

/**
 * The `tools/list` entry the REGISTERED server publishes for one command. The
 * published contract is a launch-time fact, so reading it needs neither a call
 * nor an engine fixture: this is the surface a model reads before it decides
 * which parameters exist.
 */
async function publishedMcpTool(commandId: string, resolver: ResolveContext): Promise<PublishedTool> {
  const definition = getCommandDefinitions().find((entry) => entry.id === commandId);
  if (definition === undefined) throw new Error(`missing command: ${commandId}`);
  const server = new McpServer({ name: "metadata-test-server", version: "1.0.0" });
  const client = new Client({ name: "metadata-test-client", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  try {
    registerMcpCommands(server, [definition], resolver);
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === foldedTool(commandId).name);
    if (tool === undefined) throw new Error(`unlisted tool: ${foldedTool(commandId).name}`);
    return tool as unknown as PublishedTool;
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
    const base = context(fixture.root);
    const result = await registeredMcpCall(
      "session.recover",
      { ...recoveryInput(attestation), harness: fixture.harness, sessionId: "main-session" },
      base,
      trustingContext(base),
    );
    expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
  });

  test("absent identity preserves active recovery usage and help", async () => {
    // The connection DECLARES a root, so this call cannot be refused for a
    // missing `harness`: the refusal asserted below is the identity one, not the
    // unpinned-connection requirement wearing the same usage code.
    const root = fixtureRoot();
    const harness = path.join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const result = await registeredMcpCall(
      "session.recover",
      recoveryInput(writeAttestation(root)),
      context(root),
      createContextResolver({ harnessRoot: harness }),
    );
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input" });
    expect(result.details?.helpRoute).toBe("mstar session recover --help");
    expect((result.details?.diagnostics as Array<{ path?: string }> | undefined) ?? []).not.toContainEqual(
      expect.objectContaining({ path: "harness" }),
    );
  });
  test("stdio resolver ignores the legacy environment identity when no parameter is supplied", async () => {
    const previous = process.env.MSTAR_HOST_SESSION_ID;
    process.env.MSTAR_HOST_SESSION_ID = "ambient-session";
    try {
      // The call NAMES its root, so the asserted usage refusal is provably the
      // identity one: without it the unpinned harness requirement would answer
      // with the same code and the same help route.
      const fixture = await initializedHarness();
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness },
        context(fixture.root),
        resolveContext,
      );
      expect(result).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(result.details?.helpRoute).toBe("mstar session recover --help");
      expect((result.details?.diagnostics as Array<{ path?: string }> | undefined) ?? []).not.toContainEqual(
        expect.objectContaining({ path: "harness" }),
      );
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
        createContextResolver({ trustCallerSessionId: true }),
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env.MSTAR_HOST_SESSION_ID;
      else process.env.MSTAR_HOST_SESSION_ID = previous;
    }
  });

  test("the default connection publishes no identity and refuses a caller-declared session id", async () => {
    const previous = process.env.MSTAR_HOST_SESSION_ID;
    process.env.MSTAR_HOST_SESSION_ID = "ambient-session";
    try {
      const fixture = await initializedHarness();
      const resolver = createContextResolver({ harnessRoot: fixture.harness });
      // The shipped connection has no identity channel: the per-call selector is
      // not published and no requirement advertises it. Neither ambient variable
      // supplies an identity, and no retired launcher property is left behind.
      const tool = await publishedMcpTool("session.recover", resolver);
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("sessionId");
      expect((tool.inputSchema["x-mstar-requirements"] ?? []).map((entry) => entry.name)).not.toContain("sessionId");

      // A call that puts one on the wire is refused by name, with the cause and
      // the routes that really work; the claimed value is never echoed.
      const claimed = "ambient-session";
      const refused = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), sessionId: claimed },
        context(fixture.root),
        resolver,
      );
      expect(refused).toMatchObject({ status: "refused", code: "mcp.caller-identity-unavailable" });
      expect(refused.message).toContain("--trust-caller-session-id");
      const recovery = String(refused.details?.recovery ?? (refused as { recovery?: string }).recovery ?? "");
      expect(recovery).toContain("mstar session recover");
      expect(JSON.stringify(refused)).not.toContain(claimed);

      // The operation a native tool DOES cover names it, with the identity
      // source a caller can rely on.
      const bindRefused = await registeredMcpCall(
        "plan.bind",
        { workflow: "wf-claimed", sessionId: claimed },
        context(fixture.root),
        resolver,
      );
      expect(bindRefused).toMatchObject({ status: "refused", code: "mcp.caller-identity-unavailable" });
      const bindRecovery = String(bindRefused.details?.recovery ?? (bindRefused as { recovery?: string }).recovery ?? "");
      expect(bindRecovery).toContain("mstar_plan_bind");
      expect(bindRecovery).toContain("exec.agent.id");
      expect(JSON.stringify(bindRefused)).not.toContain(claimed);
    } finally {
      if (previous === undefined) delete process.env.MSTAR_HOST_SESSION_ID;
      else process.env.MSTAR_HOST_SESSION_ID = previous;
    }
  });

  test("a claimed identity, a rejected field and the missing inputs arrive in ONE refusal", async () => {
    const fixture = await initializedHarness();
    const claimed = "live-coordinator-session";
    const refused = await registeredMcpCall(
      "session.recover",
      // Three different problems in one call: an identity claim this connection
      // cannot admit, a key no action accepts, and the action's own missing
      // required inputs. The caller must see all of them at once instead of
      // spending an attempt per problem.
      { sessionId: claimed, unknownKey: "typo" },
      context(fixture.root),
      createContextResolver({ harnessRoot: fixture.harness }),
    );
    // The identity frame is kept: the security fact is why the call cannot run.
    expect(refused).toMatchObject({ status: "refused", code: "mcp.caller-identity-unavailable" });
    const diagnostics = ((refused.details?.diagnostics ?? []) as Array<{ path?: string; code?: string }>);
    const paths = diagnostics.map((entry) => entry.path);
    expect(paths).toContain("sessionId");
    expect(paths).toContain("unknownKey");
    // Admission's own verdict for the fields the action requires.
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: "workflow" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: "attestation" }));
    // The identity cause and recovery still travel with the aggregated refusal.
    expect(refused.message).toContain("--trust-caller-session-id");
    expect(String(refused.details?.recovery ?? "")).toContain("mstar session recover");
    // The claimed value is never echoed, and the identity is recorded as its
    // own group rather than being reported as a typo.
    expect(JSON.stringify(refused)).not.toContain(claimed);
    expect(refused.details?.identity).toMatchObject({ selectors: ["sessionId"], trust: "off" });
  });

  test("plan.progress with a claimed coordinator id refuses before the execution ledger", async () => {
    const fixture = await initializedHarness();
    const before = readFileSync(path.join(fixture.harness, "store.db"));
    const claimed = "live-coordinator-session";
    const refused = await registeredMcpCall(
      "plan.progress",
      { workflow: "wf-claimed", plan: "plan-claimed", progress: { status: "InProgress", summary: "claimed write" }, sessionId: claimed },
      context(fixture.root),
      createContextResolver({ harnessRoot: fixture.harness }),
    );
    expect(refused).toMatchObject({ status: "refused", code: "mcp.caller-identity-unavailable" });
    // The refusal names the CLI route and the known native gap honestly.
    const recovery = String(refused.details?.recovery ?? (refused as { recovery?: string }).recovery ?? "");
    expect(recovery).toContain("mstar plan progress");
    expect(recovery).toContain("No dsh native tool covers plan prepare/progress/complete yet");
    expect(JSON.stringify(refused)).not.toContain(claimed);
    // Nothing reached the engine: not a single byte of the store changed, so no
    // execution-ledger row exists for the claimed id.
    expect(readFileSync(path.join(fixture.harness, "store.db"))).toEqual(before);
  });

  test("the explicit opt-in is the only connection that publishes the selector", async () => {
    const fixture = await initializedHarness();
    const trusted = await publishedMcpTool("session.recover", createContextResolver({ harnessRoot: fixture.harness, trustCallerSessionId: true }));
    expect(trusted.inputSchema.properties).toMatchObject({ sessionId: { type: "string" } });
    expect((trusted.inputSchema["x-mstar-requirements"] ?? []).map((entry) => entry.name)).toContain("sessionId");
    // The same launch without the opt-in publishes nothing, and the flag maps
    // to the resolver fact registration reads.
    const shipped = createContextResolver({ harnessRoot: fixture.harness });
    expect(shipped.callerIdentity).toBe(false);
    expect(createContextResolver({ harnessRoot: fixture.harness, trustCallerSessionId: true }).callerIdentity).toBe(true);
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
      const base = context(fixture.root);
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(attestation), harness: fixture.harness, sessionId },
        base,
        trustingContext(base),
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
    const base = context(fixture.root);
    const trusted = trustingContext(base);
    const bound = await registeredMcpCall("plan.bind", {
      execution: true, coordinator: true, workflow, harness: fixture.harness, expect: token,
      operation: "bind-recorded-owner", sessionId: owner.sessionId,
    }, base, trusted);
    expect(bound.status).toBe("ok");
    const sessionRef = encodeExecutionSessionRef({
      storeId: fixture.authority.storeId, epoch: fixture.authority.epoch,
      workflowId: workflow, role: "coordinator", sessionId: owner.sessionId,
    });
    const payload = { sessionRef, plan, harness: fixture.harness };
    const ownerRead = await registeredMcpCall("plan.show", { ...payload, sessionId: owner.sessionId }, base, trusted);
    expect(ownerRead.status).toBe("ok");
    const before = readFileSync(path.join(fixture.harness, "store.db"));
    const wrongSession = await registeredMcpCall("plan.show", { ...payload, sessionId: "different-valid-session" }, base, trusted);
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
