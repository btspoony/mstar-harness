import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer, type Transport } from "@modelcontextprotocol/server";
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
import { commandEnvelopeSchema, getCommandDefinitions, type CommandDefinition, type CommandEnvelope, type InvocationContext } from "@mstar-harness/commands";
import { registerMcpCommands, type ResolveContext } from "../src/mcp/register";
import { z } from "zod";
import { actionOf, familyOf, familyToolName } from "../src/mcp/fold";
import { registerCliCommands } from "../src/command-adapter";
import { createMcpServer } from "../src/mcp/server";
import { createContextResolver, resolveContext, serveMcpStdioOver } from "../src/mcp/stdio";

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
    // Every connection publishes the per-call selector wherever the command
    // declares it; it stays OPTIONAL, so `required` never lists it.
    const published = (tool?.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(published).toMatchObject({ sessionId: { type: "string" } });
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
    "x-mstar-selectors"?: readonly Readonly<{ key: string; actions: readonly string[] }>[];
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
        createContextResolver({ harnessRoot: fixture.harness }),
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env.MSTAR_HOST_SESSION_ID;
      else process.env.MSTAR_HOST_SESSION_ID = previous;
    }
  });

  test("a default connection publishes the selector and admits a caller-declared session id", async () => {
    const fixture = await initializedHarness();
    // No identity option anywhere: this is the connection `mstar mcp` starts
    // with, and the one the dsh bundle row and omp's `mcp.json` launch.
    const resolver = createContextResolver({ harnessRoot: fixture.harness });
    const tool = await publishedMcpTool("session.recover", resolver);
    expect(tool.inputSchema.properties ?? {}).toMatchObject({ sessionId: { type: "string" } });
    expect((tool.inputSchema["x-mstar-requirements"] ?? []).map((entry) => entry.name)).toContain("sessionId");
    // The wire carries the per-action fact a host-side injector reads: this
    // action is one that declares the selector.
    expect(tool.inputSchema["x-mstar-selectors"]).toEqual([{ key: "sessionId", actions: ["recover"] }]);

    // The supplied value passes admission and reaches the engine's own workflow
    // lookup, which is the point: the selector selected a coordinator binding.
    const admitted = await registeredMcpCall(
      "session.recover",
      { ...recoveryInput(writeAttestation(fixture.root)), sessionId: "caller-session" },
      context(fixture.root),
      resolver,
    );
    expect(admitted).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });

    // `plan.bind` — the action that also has a native tool — takes the same
    // value on the same connection; what it refuses is its own missing input,
    // never the selector.
    const bind = await registeredMcpCall(
      "plan.bind",
      { workflow: "wf-claimed", sessionId: "caller-session" },
      context(fixture.root),
      resolver,
    );
    expect(bind).toMatchObject({ status: "usage", code: "command.invalid-input" });
    expect(bind.details?.selectors).toBeUndefined();
    expect((bind.details?.diagnostics ?? []) as Array<{ path?: string }>).not.toContainEqual(
      expect.objectContaining({ path: "sessionId" }),
    );
  });

  test("an admitted session id is not reported when other input is refused", async () => {
    const fixture = await initializedHarness();
    const refused = await registeredMcpCall(
      "session.recover",
      // A rejected key and the action's own missing required inputs, carrying a
      // legitimate per-call identity: the refusal reports the real problems and
      // says nothing about the selector this action does declare.
      { sessionId: "live-coordinator-session", unknownKey: "typo" },
      context(fixture.root),
      createContextResolver({ harnessRoot: fixture.harness }),
    );
    expect(refused).toMatchObject({ status: "usage", code: "command.invalid-input" });
    const paths = ((refused.details?.diagnostics ?? []) as Array<{ path?: string }>).map((entry) => entry.path);
    expect(paths).toContain("unknownKey");
    // Admission's own verdict for the fields the action requires.
    expect(paths).toContain("workflow");
    expect(paths).toContain("attestation");
    expect(paths).not.toContain("sessionId");
    expect(refused.details?.selectors).toBeUndefined();
    expect(refused.message).not.toContain("does not declare");
  });

  test("plan.progress with a caller-declared session reaches the execution ledger", async () => {
    const fixture = await initializedHarness();
    const before = readFileSync(path.join(fixture.harness, "store.db"));
    const result = await registeredMcpCall(
      "plan.progress",
      { workflow: "wf-claimed", plan: "plan-claimed", progress: { status: "InProgress", summary: "claimed write" }, sessionId: "live-coordinator-session" },
      context(fixture.root),
      createContextResolver({ harnessRoot: fixture.harness }),
    );
    // The selector is admitted, so the refusal is the ENGINE's verdict on an
    // unresolved workflow — not an input refusal that never ran.
    expect(result.status).toBe("refused");
    expect(result.code).toMatch(/^coordination\./);
    // Nothing was written: no ledger row exists for the unnamed workflow.
    expect(readFileSync(path.join(fixture.harness, "store.db"))).toEqual(before);
  });

  /**
   * The production entry `mstar mcp` actually runs (`serveMcpStdioOver`: real
   * command catalog, tool correction, `createMcpServer` wrapping the resolver),
   * with no identity configuration of any kind. A `sessionId` on the wire must
   * pass the whole assembly and reach the engine's own coordinator lookup — the
   * `coordination.*` verdict is that lookup answering, which no input refusal
   * could produce.
   */
  test("the production stdio assembly admits a sessionId and reaches the engine", async () => {
    const fixture = await initializedHarness();
    let serverOnMessage: Transport["onmessage"];
    let clientOnMessage: Transport["onmessage"];
    const serverTransport: Transport = {
      start: async () => {}, close: async () => {},
      async send(message) { clientOnMessage?.(message); },
      get onmessage() { return serverOnMessage; },
      set onmessage(handler) { serverOnMessage = handler; },
    };
    const clientTransport: Transport = {
      start: async () => {}, close: async () => {},
      async send(message) { serverOnMessage?.(message); },
      get onmessage() { return clientOnMessage; },
      set onmessage(handler) { clientOnMessage = handler; },
    };
    // The only option is the root pin: an identity option does not exist.
    const handle = serveMcpStdioOver(serverTransport, { harnessRoot: fixture.harness });
    try {
      let nextId = 0;
      const handlers = new Map<string | number, (message: Record<string, unknown>) => void>();
      clientTransport.onmessage = (message) => {
        if ("id" in message && message.id !== null && !("method" in message)) {
          handlers.get(message.id as string | number)?.(message as Record<string, unknown>);
        }
      };
      const request = async (method: string, params: Record<string, unknown> = {}) => {
        const id = ++nextId;
        const response = new Promise<Record<string, unknown>>((resolve) => handlers.set(id, resolve));
        await clientTransport.send({ jsonrpc: "2.0", id, method, params });
        const result = await response;
        handlers.delete(id);
        return result;
      };
      await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "identity-probe", version: "1" } });
      await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const response = await request("tools/call", {
        name: "mstar_plan",
        arguments: {
          action: "progress", workflow: "wf-production-probe", plan: "plan-production-probe",
          progress: { status: "InProgress", summary: "production assembly probe" },
          sessionId: "calling-session",
        },
      });
      const result = response.result as { structuredContent?: CommandEnvelope; content?: Array<{ text?: string }> } | undefined;
      const text = (result?.content ?? []).map((block) => block.text ?? "").join("\n");
      const envelope = result?.structuredContent
        ?? JSON.parse(text.slice(text.indexOf('{"version":1,'))) as CommandEnvelope;
      // The engine answered about the caller's own binding: not a usage refusal.
      expect(envelope.status).toBe("refused");
      expect(envelope.code).toMatch(/^coordination\./);
      expect(envelope.details?.selectors).toBeUndefined();
      expect(JSON.stringify(envelope)).not.toContain("does not declare");
    } finally {
      await handle.close();
    }
  });

  /**
   * The whole point of publishing the selector: a connection built with NO
   * launcher option admits a caller-declared `sessionId`, and the value is what
   * reaches the request context the handler runs on. A command whose output IS
   * that context makes the claim observable end to end.
   */
  test("a default resolver admits sessionId and the request context carries it", async () => {
    const identityEcho: CommandDefinition = {
      id: "fixture.identity",
      description: "Echo the admitted session identity.",
      effects: ["validate"],
      cli: {
        path: ["fixture", "identity"], aliases: [], arguments: [],
        options: [
          { key: "harness", flags: "--harness <path>", required: false },
          { key: "sessionId", flags: "--session-id <id>", required: false, context: "sessionId" },
        ],
      },
      input: z.object({ harness: z.string().optional() }).strict(),
      output: commandEnvelopeSchema,
      async execute(_input, invocation) {
        return { version: 1, command: "fixture.identity", status: "ok", code: "fixture.identity.ok", exitCode: 0, data: { sessionId: invocation.sessionId ?? null } };
      },
    };
    const root = fixtureRoot();
    const server = new McpServer({ name: "default-resolver-server", version: "1.0.0" });
    const client = new Client({ name: "default-resolver-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      // Literally the zero-option factory: no root pin, no identity option. The
      // call names its own root, so admission's unpinned-root rule is satisfied.
      registerMcpCommands(server, [identityEcho], createContextResolver());
      await server.connect(serverEnd);
      await client.connect(clientEnd);
      const result = await client.callTool({
        name: "mstar_fixture",
        arguments: { action: "identity", harness: root, sessionId: "calling-session" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "ok", data: { sessionId: "calling-session" } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("invalid identity formats fail specifically at the shared safe-id guard", async () => {
    const fixture = await initializedHarness();
    const attestation = writeAttestation(fixture.root);
    const before = readFileSync(path.join(fixture.harness, "store.db"));
    const resolver = createContextResolver({ harnessRoot: fixture.harness });
    for (const [sessionId, code] of [
      ["", "command.invalid-input"],
      ["../other-session", "coordination.invalid-session-id"],
      ["folder\\\\session", "coordination.invalid-session-id"],
    ]) {
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(attestation), sessionId },
        context(fixture.root),
        resolver,
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
    const trusted = createContextResolver({ harnessRoot: fixture.harness });
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
