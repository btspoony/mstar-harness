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

/** The folded tool one command id publishes under, and the `action` that selects it. */
function foldedTool(commandId: string): { name: string; action: string } {
  return { name: familyToolName(familyOf(commandId)), action: actionOf(commandId) };
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

/** The stderr text a factory call writes, captured so a warning is assertable. */
function stderrWhile(run: () => void): string {
  const chunks: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
    return true;
  }) as unknown as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = write;
  }
  return chunks.join("");
}

/**
 * A resolver created as one launch would create it, plus the stderr its
 * factory wrote: the launch-time warning is part of the declared channel's
 * observable behavior, not an implementation detail.
 */
function resolverCapturingStderr(identityEnv: string): { resolver: ResolveContext; stderr: string } {
  let resolver!: ResolveContext;
  const stderr = stderrWhile(() => { resolver = createContextResolver({ identityEnv }); });
  return { resolver, stderr };
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
    if (resolver.identityLocked === true) {
      // A locked connection publishes no session selector: the identity is
      // the connection's, never model-choosable.
      expect(published.sessionId).toBeUndefined();
      expect(tool?.inputSchema.required ?? []).not.toContain("sessionId");
    } else {
      expect(published).toMatchObject({ sessionId: { type: "string" } });
      expect(tool?.inputSchema.required ?? []).not.toContain("sessionId");
    }
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
   * The lock requires a USABLE identity, not merely a non-blank value. A
   * locked connection publishes no selector and strips the caller's, so a
   * declared value the safe-id rule refuses would leave every
   * identity-consuming call refused at that same guard — a connection nobody
   * can use and cannot rebind. Such a value therefore resolves no identity:
   * the connection stays generic exactly like an unset/blank declaration, the
   * per-call selector remains the identity channel, and the launch line names
   * the rule and the recovery without echoing the rejected value.
   */
  test("an UNSAFE declared value stays unlocked, publishes the selector, and honors the per-call id", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "../declared-session";
    try {
      const fixture = await initializedHarness();
      const { resolver, stderr } = resolverCapturingStderr(DECLARED_IDENTITY);
      expect(resolver.identityLocked).toBe(false);
      expect(resolver.defaultSessionId).toBeUndefined();
      expect(stderr).toContain("[mcp.identity-env-unsafe]");
      expect(stderr).toContain(`--identity-env ${DECLARED_IDENTITY}`);
      // The line states the rule (so the launcher can correct the value) and
      // never repeats the rejected value.
      expect(stderr).toContain("[A-Za-z0-9._-]+");
      expect(stderr).toContain("at most 128 characters");
      expect(stderr).not.toContain("../declared-session");
      // Both supported escapes are named: correct the variable, or drop the
      // flag — either way the identity is a launch fact, so relaunch.
      expect(stderr).toContain(`correct ${DECLARED_IDENTITY}`);
      expect(stderr).toContain("drop --identity-env");
      expect(stderr).toContain("relaunch");
      // The helper asserts the selector is published for an unlocked resolver.
      // A valid caller id then reaching workflow lookup proves the call ran
      // under IT: had the unsafe value locked and been stripped in, the shared
      // guard would have refused the call instead.
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "main-session" },
        context(fixture.root),
        resolver,
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  /**
   * The unsafe-value verdict has to survive the PRODUCTION assembly (the one
   * `mstar mcp` installs, where `createMcpServer` wraps the resolver): an
   * unsafe declared value must not lock that path either, and the caller's
   * valid id must reach the invocation. The old contract proved the opposite
   * — a locked, unstrippable connection refused at the shared guard.
   */
  test("the production server keeps an unsafe declared value unlocked and honors the per-call id", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "../declared-session";
    try {
      const fixture = await initializedHarness();
      const { resolver, stderr } = resolverCapturingStderr(DECLARED_IDENTITY);
      expect(resolver.identityLocked).toBe(false);
      expect(resolver.defaultSessionId).toBeUndefined();
      expect(stderr).toContain("[mcp.identity-env-unsafe]");
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "main-session" },
        context(fixture.root),
        resolver,
        "server",
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  /**
   * The engine rule has two refusal branches — the path-component shape and
   * the 128-character ceiling — and both must resolve no identity here: a
   * value the rule refuses is not a lock. The over-long case is asserted
   * explicitly so a shape-only reimplementation of the rule in this module
   * (a plain `[A-Za-z0-9._-]+` match, which 129 `a`s do satisfy) would fail.
   */
  test("an over-long declared value resolves no identity and is never echoed", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    const overLong = "a".repeat(129);
    process.env[DECLARED_IDENTITY] = overLong;
    try {
      const fixture = await initializedHarness();
      const { resolver, stderr } = resolverCapturingStderr(DECLARED_IDENTITY);
      expect(resolver.identityLocked).toBe(false);
      expect(resolver.defaultSessionId).toBeUndefined();
      expect(stderr).toContain("[mcp.identity-env-unsafe]");
      expect(stderr).not.toContain(overLong);
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "main-session" },
        context(fixture.root),
        resolver,
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
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
        // A blank channel warns at launch; the dedicated blank regression
        // asserts that line, this one only needs the resolver.
        resolverCapturingStderr(DECLARED_IDENTITY).resolver,
      );
      expect(result).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(result.details?.helpRoute).toBe("mstar session recover --help");
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });


  /**
   * A declared channel that resolves NO id cannot lock the connection: a
   * locked connection with no identity publishes no selector and strips the
   * caller's, so every identity-consuming call would be unreachable. The
   * connection must stay generic — the per-call selector is then the identity
   * channel — and the launch must warn once with the cause and the recovery.
   */
  test("a declared channel with an UNSET variable stays unlocked and warns with the recovery", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    delete process.env[DECLARED_IDENTITY];
    try {
      const fixture = await initializedHarness();
      const { resolver, stderr } = resolverCapturingStderr(DECLARED_IDENTITY);
      expect(resolver.identityLocked).toBe(false);
      expect(resolver.defaultSessionId).toBeUndefined();
      expect(stderr).toContain("[mcp.identity-env-unresolved]");
      expect(stderr).toContain(`--identity-env ${DECLARED_IDENTITY}`);
      // The selector is published (the helper asserts it on an unlocked
      // resolver) and a caller-supplied id reaches the invocation context:
      // the valid id passes the format gate, so only the workflow lookup can
      // refuse.
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "main-session" },
        context(fixture.root),
        resolver,
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  test("a blank declared value counts as unset: unlocked, selector published, warning names the variable", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "  \t";
    try {
      const fixture = await initializedHarness();
      const { resolver, stderr } = resolverCapturingStderr(DECLARED_IDENTITY);
      expect(resolver.identityLocked).toBe(false);
      expect(resolver.defaultSessionId).toBeUndefined();
      expect(stderr).toContain(`--identity-env ${DECLARED_IDENTITY}`);
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "main-session" },
        context(fixture.root),
        resolver,
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  test("a declared channel that resolves an id still locks and strips the per-call selector", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "declared-mcp-session";
    try {
      const fixture = await initializedHarness();
      const resolver = createContextResolver({ identityEnv: DECLARED_IDENTITY });
      expect(resolver.identityLocked).toBe(true);
      expect(resolver.defaultSessionId).toBe("declared-mcp-session");
      // The caller's id is malformed on purpose: if it survived admission, the
      // shared safe-id guard would refuse `coordination.invalid-session-id`.
      // Reaching workflow lookup proves the strip kept the declared identity.
      const result = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "../caller-session" },
        context(fixture.root),
        resolver,
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  /**
   * The declared identity is a LAUNCH fact. A connection whose variable is
   * removed after startup keeps its lock and its identity; one created before
   * the variable appears never gains a lock. Either drift would leave the
   * published tool surface (selector or no selector) disagreeing with the
   * identity the resolver actually hands the invocation.
   */
  test("the declared identity is resolved once at launch and never repartitions mid-life", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "declared-mcp-session";
    try {
      const fixture = await initializedHarness();
      const locked = createContextResolver({ identityEnv: DECLARED_IDENTITY });
      delete process.env[DECLARED_IDENTITY];
      expect(locked.identityLocked).toBe(true);
      expect(locked.defaultSessionId).toBe("declared-mcp-session");
      const lockedResult = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "../caller-session" },
        context(fixture.root),
        locked,
      );
      expect(lockedResult).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });

      const { resolver: generic } = resolverCapturingStderr(DECLARED_IDENTITY);
      process.env[DECLARED_IDENTITY] = "appeared-after-launch";
      expect(generic.identityLocked).toBe(false);
      expect(generic.defaultSessionId).toBeUndefined();
      const genericResult = await registeredMcpCall(
        "session.recover",
        { ...recoveryInput(writeAttestation(fixture.root)), harness: fixture.harness, sessionId: "main-session" },
        context(fixture.root),
        generic,
      );
      expect(genericResult).toMatchObject({ status: "refused", code: "coordination.workflow-not-found" });
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

  /**
   * The lock governs PUBLICATION, not only admission: a locked connection's
   * identity is the connection's, so neither the `CLI:` usage token, the
   * `x-mstar-requirements` entries nor a "Caller-supplied" description line
   * may name the selector. Otherwise the tool tells a model to pass a
   * parameter it does not publish and silently strips.
   */
  test("a locked connection publishes no session selector in the tool metadata", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    process.env[DECLARED_IDENTITY] = "declared-mcp-session";
    try {
      const tool = await publishedMcpTool("session.recover", createContextResolver({ identityEnv: DECLARED_IDENTITY }));
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("sessionId");
      expect(tool.inputSchema.required ?? []).not.toContain("sessionId");
      expect((tool.inputSchema["x-mstar-requirements"] ?? []).map((entry) => entry.name)).not.toContain("sessionId");
      // The rest of the contract is intact: the fix filters the selector, not
      // the family's action list or the required fields of each action.
      expect(tool.description).toContain("recover");
      expect(tool.description).not.toContain("sessionId");
      expect(tool.description).not.toContain("--session-id");
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
  });

  /**
   * The filter is LOCK-scoped, not global: a generic unbound connection keeps
   * the selector property, its requirement entry and the usage token, because
   * there the per-call selector is the documented identity channel.
   */
  test("a generic connection still publishes the session selector in the tool metadata", async () => {
    const previous = process.env[DECLARED_IDENTITY];
    delete process.env[DECLARED_IDENTITY];
    try {
      const tool = await publishedMcpTool("session.recover", resolverCapturingStderr(DECLARED_IDENTITY).resolver);
      expect(tool.inputSchema.properties).toMatchObject({ sessionId: { type: "string" } });
      expect((tool.inputSchema["x-mstar-requirements"] ?? []).map((entry) => entry.name)).toContain("sessionId");
    } finally {
      if (previous === undefined) delete process.env[DECLARED_IDENTITY];
      else process.env[DECLARED_IDENTITY] = previous;
    }
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
