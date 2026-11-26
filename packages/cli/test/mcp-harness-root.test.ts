import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as nodeOs from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { captureIssue, ensureCollaborationAuthority, initializeStore, openCollaborationStore } from "@mstar-harness/engine";
import { getCommandDefinitions, getCommandSchemas, type CommandEnvelope } from "@mstar-harness/commands";
import { mapParserError } from "../src/command-adapter";
import { registerMcpCommand } from "../src/mcp/command";
import { registerMcpCommands, type ResolveContext } from "../src/mcp/register";
import { createMcpServer } from "../src/mcp/server";
import { createMcpEffects } from "../src/mcp/effects";
import { createContextResolver, McpControlRootError } from "../src/mcp/stdio";
import { DESIGN_LEVEL1, SKILL_GOOD } from "./support/cli-content-fixtures";

const roots: string[] = [];

/** why: `MSTAR_HARNESS_DIR` is retired: nothing in the resolver or the engine reads
 * it. It is still captured and restored so a caller-inherited ambient value
 * (a test asserting the variable is ignored) cannot leak between cases, and
 * `process.cwd()` is restored for the same reason.
 */
const AMBIENT_CWD = process.cwd();
const AMBIENT_HARNESS_DIR = process.env.MSTAR_HARNESS_DIR;
/** note: The user-level collaboration lane is resolved through HOME; isolate it. */
const LANE_HOME = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-home-"));
const AMBIENT_HOME = process.env.HOME;
process.env.HOME = LANE_HOME;
// note: In-process resolution uses the OS homedir, not $HOME: isolate it too.
let laneHomeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  laneHomeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => LANE_HOME);
});
let repoSequence = 0;

afterEach(() => {
  if (process.cwd() !== AMBIENT_CWD) process.chdir(AMBIENT_CWD);
  if (AMBIENT_HARNESS_DIR === undefined) delete process.env.MSTAR_HARNESS_DIR;
  else process.env.MSTAR_HARNESS_DIR = AMBIENT_HARNESS_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  laneHomeSpy?.mockRestore();
  if (AMBIENT_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = AMBIENT_HOME;
  rmSync(LANE_HOME, { recursive: true, force: true });
});

/** why: A real Git main worktree: the resolver admits a `harness` selector only when
 * it is the fixed `.mstar` under the checkout `git worktree list` names first,
 * so every harness fixture below is a genuine repository. The path is
 * realpath'd so the returned paths compare verbatim against engine output on
 * symlinked tmpdirs. The checkout also declares its collaboration identity:
 * issue/catalog authority lives in the lane, which is scoped by the repository.
 */
function gitMainWorktree(parent: string, name: string): string {
  const repo = path.join(parent, name);
  mkdirSync(path.join(repo, ".mstar"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: repo });
  writeFileSync(path.join(repo, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=fixture-${repoSequence++}\n`);
  return realpathSync(repo);
}

/**
 * why: Both authorities, exactly as `store init` leaves them: the collaboration
 * lane owns issue/catalog authority, the execution store owns execution/host.
 */
async function initializeHarness(harness: string): Promise<void> {
  await ensureCollaborationAuthority({ harnessDir: harness });
  (await initializeStore({ harnessDir: harness })).close();
}

/** why: An initialized harness inside a real Git main worktree and an invocation
 * cwd that is a sibling of the checkout: the cwd contains no harness and is
 * not inside a git checkout, so nothing but the call's own `harness` selector
 * can reach the fixture store.
 */
async function harnessOutsideCwd(): Promise<{ harness: string; cwd: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const harness = path.join(gitMainWorktree(root, "control"), ".mstar");
  const cwd = path.join(root, "plain-cwd");
  mkdirSync(cwd, { recursive: true });
  await initializeHarness(harness);
  return { harness, cwd };
}

/** why: Two roots a call selector CAN distinguish: the named harness owns an
 * initialized store inside its Git checkout, while the sibling invocation cwd
 * owns only a bare `.mstar` directory. A command that resolves its root from
 * `input.harness` answers from the named store; resolving from the cwd probe
 * would find the bare directory and refuse.
 */
async function competingCwdHarness(): Promise<{ harness: string; cwd: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const harness = path.join(gitMainWorktree(root, "control"), ".mstar");
  const cwd = path.join(root, "workspace");
  mkdirSync(path.join(cwd, ".mstar"), { recursive: true });
  await initializeHarness(harness);
  return { harness, cwd };
}

/** why: Two roots a persist verb could distinguish: each owns the SAME review key
 * (`sdd/_reviews/<key>.json`) with a different payload. The published `harness`
 * selector chooses one per call, so a write through one never touches the other.
 */
const PERSIST_PROBE_KEY = "root-probe";

function originOf(envelope: { data?: Record<string, unknown> }): string {
  const payload = envelope.data?.payload;
  if (typeof payload !== "object" || payload === null || !("origin" in payload) || typeof payload.origin !== "string") {
    throw new Error("expected a persisted document with a string origin");
  }
  return payload.origin;
}

async function competingPersistRoots(): Promise<{ harnessA: string; harnessB: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const harnessA = path.join(gitMainWorktree(root, "control-a"), ".mstar");
  const harnessB = path.join(gitMainWorktree(root, "control-b"), ".mstar");
  for (const [harness, origin] of [[harnessA, "a"], [harnessB, "b"]] as const) {
    mkdirSync(path.join(harness, "sdd", "_reviews"), { recursive: true });
    writeFileSync(path.join(harness, "sdd", "_reviews", `${PERSIST_PROBE_KEY}.json`), JSON.stringify({ origin }));
  }
  return { harnessA, harnessB };
}

/** why: A launch workspace that is a usable Git checkout with an EMPTY `.mstar`:
 * exactly the directory a probe would adopt, so a root-needing call launched
 * over it must refuse rather than answer about it.
 */
function launchCheckoutWithHarness(): { launch: string; launchHarness: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const launch = gitMainWorktree(root, "launch");
  return { launch, launchHarness: path.join(launch, ".mstar") };
}

/** why: A scaffold fixture: the target workspace a call names and a launch
 * directory whose `.mstar` and `.gitignore` must stay byte-identical when the
 * scaffold lands on the named target.
 */
function scaffoldWorkspaces(): {
  target: string;
  launch: string;
  launchHarness: string;
  launchGitignore: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const target = path.join(root, "target");
  mkdirSync(target, { recursive: true });
  const launch = path.join(root, "launch");
  const launchHarness = path.join(launch, ".mstar");
  mkdirSync(launchHarness, { recursive: true });
  const launchGitignore = path.join(launch, ".gitignore");
  writeFileSync(launchGitignore, "# launch workspace marker\nnode_modules/\n", "utf8");
  return { target, launch, launchHarness, launchGitignore };
}


/** The fixture's own discriminator, read from a successful persist envelope. */
function persistOrigin(envelope: CommandEnvelope): unknown {
  return (envelope.data as { payload?: { origin?: string } } | null | undefined)?.payload?.origin;
}

const CAPTURE_INPUT = {
  projectId: "_default",
  title: "Finding from the harness-root fixture",
  kind: "bug",
  severity: "high",
  impact: "the pinned root is not observable",
  acceptance: "the command reads the pinned root",
  sourceIdentity: "mcp-harness-root/fixture",
  rootCauseKey: "mcp-harness-root-fixture",
  acceptanceKey: "mcp-harness-root-fixture-acceptance",
  occurrenceKey: "mcp-harness-root-fixture-occurrence",
  sourceKind: "qc",
  location: "packages/cli/test/mcp-harness-root.test.ts",
  observedBehavior: "observed by the harness-root fixture",
  evidence: ["fixture evidence"],
  discoveredAt: "2026-10-18T00:00:00Z",
} as const;

/** why: Two roots that an issue-bearing command can distinguish: the named root has
 * an ACTIVE store with one captured issue inside its Git checkout, while the
 * invocation cwd's own `.mstar` is an uninitialized directory. A command that
 * reaches the named root answers from that store; a cwd-probed command
 * refuses instead.
 */
async function competingAuthorityRoots(): Promise<{ named: string; cwd: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const named = path.join(gitMainWorktree(root, "control"), ".mstar");
  const cwd = path.join(root, "workspace");
  mkdirSync(path.join(cwd, ".mstar"), { recursive: true });
  await initializeHarness(named);
  await captureIssue({ harnessDir: named }, { ...CAPTURE_INPUT }, { operationId: "mcp-harness-root-capture", actor: "project-manager" });
  return { named, cwd };
}

/** The folded tool one command id publishes under, and the `action` selecting it. */
function folded(id: string): { name: string; action: string } {
  const dot = id.indexOf(".");
  return {
    name: `mstar_${(dot === -1 ? id : id.slice(0, dot)).replace(/[.-]/g, "_")}`,
    action: dot === -1 ? id : id.slice(dot + 1),
  };
}

/** Add the folded `action` selector to one command's payload. */
function withAction(id: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { action: folded(id).action, ...args };
}

/** Read one tool result back as the command envelope it carries. */
async function toolEnvelope(client: Client, name: string, args: Record<string, unknown>): Promise<CommandEnvelope> {
  const result = await client.callTool({ name, arguments: args });
  if (result.structuredContent !== undefined) return result.structuredContent as CommandEnvelope;
  const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const start = text.indexOf('{"version":1,');
  if (start < 0) throw new Error(`no command envelope in the tool result: ${text}`);
  return JSON.parse(text.slice(start)) as CommandEnvelope;
}

/** Drive one real command call through the production registration path. */
async function callWorktreeCheck(resolver: ResolveContext, args: Record<string, unknown> = {}): Promise<CommandEnvelope> {
  const definition = getCommandDefinitions().find((entry) => entry.id === "worktree.check");
  if (definition === undefined) throw new Error("missing command: worktree.check");
  const server = new McpServer({ name: "harness-root-test-server", version: "1.0.0" });
  const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  try {
    registerMcpCommands(server, [definition], resolver);
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    const result = await client.callTool({
      name: "mstar_worktree",
      arguments: withAction("worktree.check", { workflow: "wf-absent", plan: "p-absent", ...args }),
    });
    if (result.structuredContent !== undefined) return result.structuredContent as CommandEnvelope;
    const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const start = text.indexOf('{"version":1,');
    if (start < 0) throw new Error(`no command envelope in the tool result: ${text}`);
    return JSON.parse(text.slice(start)) as CommandEnvelope;
  } finally {
    await client.close();
    await server.close();
  }
}

/** Drive one real command call through the production server assembly. */
async function callCatalogList(resolver: ResolveContext, args: Record<string, unknown> = {}): Promise<CommandEnvelope> {
  const definition = getCommandDefinitions().find((entry) => entry.id === "catalog.list");
  if (definition === undefined) throw new Error("missing command: catalog.list");
  const server = createMcpServer(resolver, [definition]);
  const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    const result = await client.callTool({ name: "mstar_catalog", arguments: withAction("catalog.list", args) });
    if (result.structuredContent !== undefined) return result.structuredContent as CommandEnvelope;
    const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const start = text.indexOf('{"version":1,');
    if (start < 0) throw new Error(`no command envelope in the tool result: ${text}`);
    return JSON.parse(text.slice(start)) as CommandEnvelope;
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * A foreign launch cwd: not inside any git checkout, owning no harness
 * directory. A shared server launched here probes a workspace its caller
 * never named (#533).
 */
async function plainForeignCwd(): Promise<{ cwd: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const cwd = path.join(root, "foreign-cwd");
  mkdirSync(cwd, { recursive: true });
  return { cwd };
}

/** Drive one real command call and return the raw MCP tool result. */
async function callRawTool(resolver: ResolveContext, id: string, args: Record<string, unknown> = {}) {
  const definition = getCommandDefinitions().find((entry) => entry.id === id);
  if (definition === undefined) throw new Error(`missing command: ${id}`);
  const server = createMcpServer(resolver, [definition]);
  const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    return await client.callTool({ name: folded(id).name, arguments: withAction(id, args) });
  } finally {
    await client.close();
    await server.close();
  }
}

/** The flat text of one raw tool result. */
function rawText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

/**
 * The command envelope one raw tool result carries. An ADMISSION refusal is
 * reported by the SDK's schema hook, which supplies text but no
 * `structuredContent`, so the envelope is read back from the text.
 */
function rawEnvelope(result: { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }): CommandEnvelope {
  if (result.structuredContent !== undefined) return result.structuredContent as CommandEnvelope;
  const text = rawText(result);
  const start = text.indexOf('{"version":1,');
  if (start < 0) throw new Error(`no command envelope in the tool result: ${text}`);
  return JSON.parse(text.slice(start)) as CommandEnvelope;
}

describe("MCP harness root", () => {
  test("a read command resolves a harness outside the cwd through the call's own selector", async () => {
    const fixture = await harnessOutsideCwd();
    const previousCwd = process.cwd();
    process.chdir(fixture.cwd);
    try {
      const envelope = await callWorktreeCheck(createContextResolver(), { harness: fixture.harness });
      // why: The refusal echoes the authority it actually read, which is the
      // outside-cwd harness the call named.
      expect(envelope).toMatchObject({ status: "refused", code: "worktree.l1.workflow-not-found" });
      expect((envelope.details as { authorityGraph?: string } | undefined)?.authorityGraph).toBe(fixture.harness);

      // why: A call that names no root is refused with the named cause instead of
      // adopting the host's directory — and the refusal never names the
      // fixture root. `status.validate` reads the root and publishes no root
      // SELECTOR, so the refusal is the resolver's own (a command that
      // declares one is refused at admission instead, naming the field).
      const unnamed = await callRawTool(createContextResolver(), "status.validate", {});
      const unnamedText = rawText(unnamed);
      expect(unnamed.isError).toBe(true);
      expect(unnamedText).toContain("mcp.control-root-unresolved");
      expect(unnamedText).not.toContain(fixture.harness);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("the production server reads the root the call's harness selector names", async () => {
    const fixture = await competingCwdHarness();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // why: catalog.list resolves its root from `input.harness`, not `controlRoot`:
      // the named fixture store is read only when the selector reached that
      // field. The cwd's own harness directory is never consulted.
      const named = await callCatalogList(createContextResolver(), { harness: fixture.harness });
      expect(named).toMatchObject({ status: "ok", code: "catalog.list.ok" });
      expect((named.data as { items: unknown[] }).items).toEqual([]);
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a shared connection publishes harness as required and refuses a call that omits it", async () => {
    const fixture = await competingCwdHarness();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    const definition = getCommandDefinitions().find((entry) => entry.id === "catalog.list");
    if (definition === undefined) throw new Error("missing command: catalog.list");
    try {
      const server = createMcpServer(createContextResolver(), [definition]);
      const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverEnd);
        await client.connect(clientEnd);

        // why: The published per-action line is the discovery surface a model reads:
        // the connection carries no root to fill, so `harness` is a
        // requirement of the action that names the field.
        const { tools } = await client.listTools();
        const catalog = tools.find((entry) => entry.name === "mstar_catalog")!;
        expect(catalog.description).toContain("- list: harness");

        // A model that omits it is refused BEFORE execution, and the refusal
        // names the missing field instead of failing on an unrelated store.
        const omitted = await toolEnvelope(client, "mstar_catalog", withAction("catalog.list"));
        expect(omitted).toMatchObject({ status: "usage", code: "command.invalid-input" });
        expect(omitted.message).toContain("harness");

        // The same call with a named root executes against that root.
        const named = await toolEnvelope(client, "mstar_catalog", withAction("catalog.list", { harness: fixture.harness }));
        expect(named).toMatchObject({ status: "ok", code: "catalog.list.ok" });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("the required root selector is the DECLARED field, not a field literally named harness", async () => {
    const fixture = await competingCwdHarness();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    const definition = getCommandDefinitions().find((entry) => entry.id === "sdd.workspace");
    if (definition === undefined) throw new Error("missing command: sdd.workspace");
    try {
      const server = createMcpServer(createContextResolver(), [definition]);
      const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverEnd);
        await client.connect(clientEnd);

        // why: `sdd.workspace` resolves its root from `controlRoot`, which the
        // contract declares in `rootInputs`. The connection carries no root,
        // so the resolver refuses a call that omits it — advertising it as
        // optional would publish a call this connection cannot answer.
        const { tools } = await client.listTools();
        const sdd = tools.find((entry) => entry.name === "mstar_sdd")!;
        expect(sdd.description).toContain("- workspace: controlRoot");
        expect(sdd.inputSchema.required ?? []).not.toContain("controlRoot");

        // A model that omits it is refused BEFORE execution, and the refusal
        // names the declared selector — not `harness`, which this command does
        // not publish at all.
        const omitted = await toolEnvelope(client, "mstar_sdd", withAction("sdd.workspace", { planId: "plan-required" }));
        expect(omitted).toMatchObject({ status: "usage", code: "command.invalid-input" });
        expect(omitted.details?.diagnostics).toContainEqual(expect.objectContaining({ path: "controlRoot" }));
        expect(JSON.stringify(omitted)).not.toContain('"harness"');

        // why: The named control root is the fixed `.mstar`, and the call answers
        // with the SDD tree under it.
        const named = await toolEnvelope(client, "mstar_sdd", withAction("sdd.workspace", { planId: "plan-required", controlRoot: fixture.harness }));
        expect(named).toMatchObject({ status: "ok", code: "sdd.workspace.ok" });
        const sddDir = (named.data as { sddDir: string }).sddDir;
        expect(sddDir).toBe(path.join(fixture.harness, "sdd", "plan-required"));
        expect(existsSync(sddDir)).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a state-dependent command takes a validated per-call root and still refuses rootless", async () => {
    const fixture = await competingPersistRoots();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    const previousStore = process.env.MSTAR_STORE_MODULE;
    delete process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_STORE_MODULE;
    const selected = ["persist.get", "persist.delete"].map((id) => {
      const found = getCommandDefinitions().find((entry) => entry.id === id);
      if (found === undefined) throw new Error(`missing command: ${id}`);
      return found;
    });
    const server = createMcpServer(createContextResolver(), selected);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      // why: persist publishes `harness` so a shared server can reach the
      // store; the selector is validated against the fixed root.
      const { tools } = await client.listTools();
      const persist = tools.find((entry) => entry.name === "mstar_persist")!;
      expect(persist.inputSchema.properties).toHaveProperty("harness");

      // why: a shared connection carries no root, so the published selector is
      // required and admission refuses the call before the store is reached.
      const rootless = await callRawTool(createContextResolver(), "persist.get", { kind: "review", key: PERSIST_PROBE_KEY });
      expect(rootless.isError).toBe(true);
      expect(rawText(rootless)).toContain("Rejected --harness");

      // why: each validated selector reads its own harness; the store follows
      // the call, so a delete through B never touches A's document.
      const documentA = path.join(fixture.harnessA, "sdd", "_reviews", `${PERSIST_PROBE_KEY}.json`);
      const documentB = path.join(fixture.harnessB, "sdd", "_reviews", `${PERSIST_PROBE_KEY}.json`);
      const readA = await toolEnvelope(client, "mstar_persist", withAction("persist.get", { kind: "review", key: PERSIST_PROBE_KEY, harness: fixture.harnessA }));
      expect(originOf(readA)).toBe("a");
      const readB = await callRawTool(createContextResolver(), "persist.get", { kind: "review", key: PERSIST_PROBE_KEY, harness: fixture.harnessB });
      expect(originOf(JSON.parse(rawText(readB)))).toBe("b");
      const deletedB = await callRawTool(createContextResolver(), "persist.delete", { kind: "review", key: PERSIST_PROBE_KEY, harness: fixture.harnessB });
      expect(JSON.parse(rawText(deletedB))).toMatchObject({ status: "ok" });
      expect(existsSync(documentA)).toBe(true);
      expect(existsSync(documentB)).toBe(false);
    } finally {
      await client.close();
      await server.close();
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
      if (previousStore === undefined) delete process.env.MSTAR_STORE_MODULE;
      else process.env.MSTAR_STORE_MODULE = previousStore;
    }
  });

  test("a blank harness is no declaration: the call is refused as missing the selector", async () => {
    const fixture = await competingAuthorityRoots();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    const definition = getCommandDefinitions().find((entry) => entry.id === "status.tech-debt");
    if (definition === undefined) throw new Error("missing command: status.tech-debt");
    const server = createMcpServer(createContextResolver(), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      // why: A blank value names nothing, so the required-selector admission
      // reports it as missing rather than resolving a root from it.
      const refused = await client.callTool({ name: "mstar_status", arguments: withAction("status.tech-debt", { harness: "" }) });
      expect(refused.isError).toBe(true);
      expect((refused.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n")).toContain("mcp.control-root-unresolved");

      // why: The real selector is the whole fact: the same call naming the store's
      // root answers with its one captured issue.
      const named = await toolEnvelope(client, "mstar_status", withAction("status.tech-debt", { harness: fixture.named }));
      expect(named).toMatchObject({ status: "ok", code: "status.ok" });
      expect((named.data as { total_open: number }).total_open).toBe(1);
    } finally {
      await client.close();
      await server.close();
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("harness.scaffold targets the path the call names, never the launch cwd", async () => {
    const fixture = scaffoldWorkspaces();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    const definition = getCommandDefinitions().find((entry) => entry.id === "harness.scaffold");
    if (definition === undefined) throw new Error("missing command: harness.scaffold");
    const server = createMcpServer(createContextResolver(), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    const launchGitignoreBefore = readFileSync(fixture.launchGitignore);
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      // why: The call's `path` names the workspace to bootstrap: the fixed
      // `<path>/.mstar` is scaffolded there, never under the launch directory.
      const envelope = await toolEnvelope(client, "mstar_harness", withAction("harness.scaffold", { path: fixture.target }));
      expect(envelope).toMatchObject({ status: "ok", code: "harness.scaffold.ok" });
      const scaffolded = envelope.data as { harnessDir: string; projectDir: string; created: string[] };
      const targetHarness = path.join(fixture.target, ".mstar");
      expect(path.resolve(scaffolded.harnessDir)).toBe(path.resolve(targetHarness));
      expect(path.resolve(scaffolded.projectDir)).toBe(path.resolve(targetHarness, "projects"));
      expect(existsSync(path.join(targetHarness, "projects", "_default"))).toBe(true);
      expect(scaffolded.created).toContain(".agents/AGENTS.md");

      // The launch workspace is untouched: no scaffold content lands in its
      // own `.mstar`, and its `.gitignore` keeps its bytes (a cwd-derived
      // scaffold would append the canonical snippet here).
      expect(readFileSync(fixture.launchGitignore)).toEqual(launchGitignoreBefore);
      expect(existsSync(path.join(fixture.launchHarness, "projects"))).toBe(false);
      expect(existsSync(path.join(fixture.launchHarness, "AGENTS.md"))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an inherited MSTAR_HARNESS_DIR does not move the scaffold target", async () => {
    const fixture = scaffoldWorkspaces();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    // why: The retired variable is no longer a root candidate anywhere: an ambient
    // value that names another directory must not redirect the scaffold.
    const envHarness = path.join(fixture.launch, "env-harness");
    process.env.MSTAR_HARNESS_DIR = envHarness;
    process.chdir(fixture.launch);
    const definition = getCommandDefinitions().find((entry) => entry.id === "harness.scaffold");
    if (definition === undefined) throw new Error("missing command: harness.scaffold");
    const server = createMcpServer(createContextResolver(), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      const envelope = await toolEnvelope(client, "mstar_harness", withAction("harness.scaffold", { path: fixture.target }));
      expect(envelope).toMatchObject({ status: "ok", code: "harness.scaffold.ok" });
      const scaffolded = envelope.data as { harnessDir: string };
      expect(path.resolve(scaffolded.harnessDir)).toBe(path.resolve(fixture.target, ".mstar"));
      expect(existsSync(path.join(fixture.target, ".mstar", "projects", "_default"))).toBe(true);
      // why: The inherited value is ignored: the directory it named never appears.
      expect(existsSync(envHarness)).toBe(false);
      expect(existsSync(path.join(fixture.launchHarness, "projects"))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("the retired `mstar mcp --harness` flag is refused by name as an unknown option", async () => {
    const program = new Command();
    program.name("mstar").exitOverride();
    registerMcpCommand(program);
    const argv = ["node", "mstar", "mcp", "--harness", "relative/.mstar"];
    let caught: unknown;
    try {
      await program.parseAsync(argv, { from: "node" });
    } catch (error) {
      caught = error;
    }
    const envelope = mapParserError(caught, argv);
    expect(envelope).toMatchObject({ command: "mcp", status: "usage", exitCode: 2 });
    // why: The launch pin is gone, not merely restricted: the flag is refused as
    // unrecognized, and only `mstar mcp --workspace` survives as a launcher
    // declaration.
    expect(String(envelope?.message)).toContain("unknown option '--harness'");
  });

  test("a rootless server proceeds when the admitted call names its own harness (F-3)", async () => {
    const fixture = await harnessOutsideCwd();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // catalog.list resolves its own root from the `harness` input field, so
      // an explicit call names the workspace: the resolver must NOT refuse a
      // call that supplies the very fact the refusal says is missing — the
      // handler validates the named root and answers from it.
      const named = await callRawTool(createContextResolver(), "catalog.list", { harness: fixture.harness });
      expect(named.isError).toBe(false);
      const envelope = named.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "ok", code: "catalog.list.ok" });

      // The call-named root is also the invocation workspace anchor: cwd is
      // that root's parent, never the launch cwd the process sits in.
      const namedDefinition = getCommandDefinitions().find((entry) => entry.id === "catalog.list");
      if (namedDefinition === undefined) throw new Error("missing command: catalog.list");
      const namedContext = await createContextResolver()(
        namedDefinition, undefined, new AbortController().signal, [], createMcpEffects([]), { harness: fixture.harness },
      );
      expect(namedContext.controlRoot).toBe(fixture.harness);
      expect(namedContext.cwd).toBe(path.dirname(fixture.harness));

      // why: A truly rootless call (no declared root, no per-call root selector)
      // refuses with the cause and its recoveries. `status.validate` reads the
      // control root and publishes no root selector, so the refusal comes
      // from the resolver itself.
      const rootless = await callRawTool(createContextResolver(), "status.validate", {});
      const text = rawText(rootless);
      expect(rootless.isError).toBe(true);
      expect(text).toContain("mcp.control-root-unresolved");
      expect(text).toContain(realpathSync(fixture.cwd));
      expect(text).toContain("publishes no root selector");
      expect(text).toContain("mstar <command>");
      // why: The retired launch pins are not recoveries anymore.
      expect(text).not.toContain("--harness");
      expect(text).not.toContain("MSTAR_HARNESS_DIR");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an unpinned server over a foreign cwd refuses with a named cause instead of a foreign store verdict", async () => {
    const fixture = await plainForeignCwd();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // The launch cwd is the HOST's directory and is never a root candidate:
      // the resolver refuses with the cause and the recoveries instead of
      // letting a command present it as the caller's control root.
      const result = await callRawTool(createContextResolver(), "status.validate", {});
      const text = rawText(result);
      expect(result.isError).toBe(true);
      expect(text).toContain("mcp.control-root-unresolved");
      expect(text).toContain(realpathSync(fixture.cwd));
      expect(text).toContain("publishes no root selector");
      expect(text).not.toContain("store.not-initialized");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("the call's own selector is the connection's root, and it anchors the invocation workspace", async () => {
    const fixture = await competingCwdHarness();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    try {
      const definition = getCommandDefinitions().find((entry) => entry.id === "worktree.check");
      if (definition === undefined) throw new Error("missing command: worktree.check");
      // why: The root the ADMITTED call named becomes the context's control root,
      // and the invocation cwd is anchored at that root's parent.
      const context = await createContextResolver()(
        definition, undefined, new AbortController().signal, [], createMcpEffects([]), { harness: fixture.harness },
      );
      expect(context.controlRoot).toBe(fixture.harness);
      expect(context.cwd).toBe(path.dirname(fixture.harness));
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an unpinned no-argument harness.scaffold is refused and writes nothing into the launch directory", async () => {
    const fixture = await plainForeignCwd();
    // A directory a scaffold would visibly change: it owns a .gitignore the
    // canonical snippet would be appended to, and a file of its own.
    const launchGitignore = path.join(fixture.cwd, ".gitignore");
    writeFileSync(launchGitignore, "# launch workspace marker\nnode_modules/\n", "utf8");
    writeFileSync(path.join(fixture.cwd, "keep.txt"), "untouched\n", "utf8");
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // A null root is harness.scaffold's premise, but the launch directory is
      // the HOST's checkout, not a directory the caller named: the bootstrap
      // exception makes the null root admissible, never that directory.
      const result = await callRawTool(createContextResolver(), "harness.scaffold", {});
      expect(result.isError).toBe(true);
      const envelope = result.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(envelope.details?.diagnostics).toContainEqual(expect.objectContaining({ path: "path", code: "required" }));
      const text = rawText(result);
      expect(text).toContain("LAUNCH directory");
      expect(text).toContain("--workspace");

      // The refusal's one required filesystem effect: it created no .mstar.
      // Nothing else is asserted about the directory's contents.
      expect(existsSync(path.join(fixture.cwd, ".mstar"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("harness.scaffold still bootstraps the workspace the launcher DECLARED", async () => {
    const fixture = await plainForeignCwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    try {
      // `--workspace` names the directory, so the bootstrap keeps working for a
      // mounting host: the exception is about the UNNAMED directory, not about
      // disabling the fresh-workspace channel.
      const result = await callRawTool(createContextResolver({ workspace: fixture.cwd }), "harness.scaffold", {});
      expect(result.isError).toBe(false);
      const envelope = result.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "ok", code: "harness.scaffold.ok" });
      const scaffolded = envelope.data as { harnessDir: string };
      expect(realpathSync(scaffolded.harnessDir)).toBe(path.join(realpathSync(fixture.cwd), ".mstar"));
      expect(existsSync(scaffolded.harnessDir)).toBe(true);
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });
});

/**
 * why: The rows a write would create in a collaboration lane, read without trusting
 * file bytes: SQLite sidecars and WAL contents are invisible here, a committed
 * or pending write is not. The authority's own `creation:` receipt is bootstrap
 * evidence, not a write a consumer could make, so it is excluded.
 */
async function storeRowCounts(harnessDir: string): Promise<{ issues: number; operations: number }> {
  const handle = await openCollaborationStore({ harnessDir }, "read");
  try {
    const count = (query: string): number => {
      const row: unknown = handle.db.prepare(query).get();
      if (row === null || typeof row !== "object" || !("n" in row) || typeof row.n !== "number") {
        throw new Error(`count query returned no numeric n: ${query}`);
      }
      return row.n;
    };
    return {
      issues: count("select count(*) as n from issues"),
      operations: count("select count(*) as n from collaboration_operations where operation_id not like 'creation:%'"),
    };
  } finally {
    handle.close();
  }
}

/** why: Two initialized roots a status read tells apart: the named root holds one
 * captured issue, the other holds none. Both are complete stores inside real
 * Git main worktrees, so only root SELECTION decides which one answers.
 */
async function twoInitializedHarnesses(): Promise<{ named: string; other: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const named = path.join(gitMainWorktree(root, "named"), ".mstar");
  const other = path.join(gitMainWorktree(root, "other"), ".mstar");
  await initializeHarness(named);
  await initializeHarness(other);
  await captureIssue({ harnessDir: named }, { ...CAPTURE_INPUT }, { operationId: "mcp-harness-root-selector", actor: "project-manager" });
  return { named, other };
}

/** why: An initialized harness at `x/.mstar` inside a real Git main worktree rooted
 * at `<base>/x`: the relative selector `x/.mstar` from `<base>` used to be
 * double-joined, and the current contract refuses it as non-absolute.
 */
async function relativeRootWorkspace(): Promise<{ base: string; harness: string; selector: string }> {
  const base = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(base);
  const harness = path.join(gitMainWorktree(base, "x"), ".mstar");
  await initializeHarness(harness);
  await captureIssue({ harnessDir: harness }, { ...CAPTURE_INPUT }, { operationId: "mcp-harness-root-relative", actor: "project-manager" });
  return { base, harness, selector: path.join("x", ".mstar") };
}

/**
 * The complete control-root admission class of the published catalog, as an
 * unpinned connection decides it: `none` runs with a null control root because
 * the command's contract reads none, `root` refuses with
 * `mcp.control-root-unresolved`.
 *
 * This snapshot is the drift guard. Neither failure mode is loud on its own — an
 * unclassified root-free command is simply refused (the discovery and validation
 * surface disappears from a shared connection), and an unclassified root
 * CONSUMER would be silently given a null root and resolve its implicit paths
 * from the host's launch directory. A command added anywhere therefore fails the
 * classification test below until its author decides, in the same change, which
 * class it belongs to and records it here.
 */
const CONTROL_ROOT_CLASS: Readonly<Record<string, "root" | "none">> = {
  "audit.scaffold": "root", "audit.secret-scan": "none", "audit.supply-chain": "none",
  "catalog.discover": "root", "catalog.export": "root", "catalog.import": "root",
  "catalog.link": "root", "catalog.list": "root", "catalog.purge-registration": "root",
  "catalog.reconcile": "root", "catalog.register": "root", "catalog.show": "root",
  "catalog.update": "root", "compound.validate": "root", "dashboard": "root",
  "design-md.validate": "none", "dispatch.validate": "none", "doctor": "none",
  "harness.scaffold": "none", "host.detect": "none", "host.skill-root": "none",
  "issue.add": "root", "issue.close": "root", "issue.duplicate": "root",
  "issue.export": "root", "issue.link": "root", "issue.list": "root",
  "issue.move": "root",
  "issue.occurrence": "root", "issue.reopen": "root", "issue.show": "root",
  "issue.supersede": "root", "issue.triage": "root", "issue.waive": "root",
  "issue-sync.apply": "root", "issue-sync.ingest": "root",
  "issue-sync.pending": "root",
  "iteration.gate": "root", "iteration.push-cadence": "none", "iteration.register": "root",
  "lint": "none", "migrate": "root", "milestone.add": "root",
  "milestone.assign": "root", "milestone.list": "root", "milestone.status": "root",
  "milestone.update": "root", "path.resolve": "none", "path.check": "none", "persist.delete": "root",
  "project.bind": "root", "project.show": "root",
  "persist.get": "root", "persist.list": "root", "persist.write": "root",
  "plan.bind": "root", "plan.complete": "root", "plan.issue-add": "root",
  "plan.issue-close": "root", "plan.prepare": "root", "plan.progress": "root",
  "plan.show": "root", "plugin.validate": "none", "pr.merge-gate": "none", "pr-review.budget": "none",
  "pr-review.post": "none", "pr-review.report-path": "root", "pr-review.seat-prompt": "none",
  "pr-review.size": "none", "pr-review.tally": "none", "pr-review.validate-report": "none",
  "pr-review.worktree-cleanup": "none", "pr-review.worktree-setup": "root", "qc.validate-report": "none",
  "report": "none", "review.seats": "none", "roadmap.export": "root",
  "roadmap.import": "root", "roadmap.replace": "root", "roadmap.show": "root",
  "roles.validate": "none", "schema": "none", "sdd.check-context": "root",
  "sdd.exec": "root",
  "sdd.review-package": "root", "sdd.task-brief": "root", "sdd.workspace": "root",
  "session.recover": "root", "session.run": "root", "skill.lint": "none",
  "status.archive-residuals": "root", "status.backlog-close": "root", "status.backlog-register": "root",
  "status.findings-cleanup": "root", "status.tech-debt": "root", "status.validate": "root",
  "status.workflow-close": "root", "store.activate": "root", "store.backup": "root",
  "store.execution.export": "none", "store.execution.restore": "none", "store.execution.restore-preview": "none",
  "store.collaboration.activate": "none", "store.collaboration.apply": "none",
  // why: adopt is the replacement clone's binding verb — an unbound checkout
  // has no control root yet, so it must admit on an unpinned connection.
  "store.collaboration.plan": "none", "store.collaboration.restore": "none", "store.collaboration.adopt": "none",
  // note: The remote verbs take their own absolute --harness operation target and are not
  // admitted root-free, so an unpinned shared connection classifies them as root.
  "store.collaboration.remote.status": "root", "store.collaboration.remote.bind": "root",
  "store.collaboration.remote.observe": "root", "store.collaboration.remote.adopt-issue": "root",
  "store.collaboration.remote.outbox-pending": "root", "store.collaboration.remote.outbox-show": "root",
  "store.collaboration.remote.outbox-dispatch": "root", "store.collaboration.remote.outbox-receipt": "root",
  "store.collaboration.remote.outbox-reconcile": "root", "store.collaboration.remote.outbox-resolve": "root",
  "store.collaboration.remote.outbox-abandon": "root",
  "store.init": "root", "store.migrate": "root", "store.retire": "root",
  "store.upgrade": "root", "workflow-note.append": "root", "workflow-note.coverage": "root",
  "workflow.adopt-terminal": "root", "workflow.compass-ref": "root", "workflow.delivery-anchors": "root", "workflow.evidence": "root",
  "workflow.execution-policy": "root", "workflow.integration-worktree": "root", "workflow.lifecycle": "root",
  "workflow.phase": "root", "workflow.register": "root", "workflow.reopen": "root", "worktree.check": "root",
  "worktree.cleanup": "root", "worktree.qc-alignment": "none",
};

/**
 * The SECOND axis of the root-free classification, pinned to the same catalog:
 * does the command's contract default a path from the invocation directory,
 * accept a path input that would resolve against it, or take that checkout
 * itself as its subject?
 *
 * A null root is only half of an admitted answer: it also leaves the invocation
 * `cwd` at this server's LAUNCH directory, which is the HOST's checkout. An
 * entry here therefore refuses per call (cause + recoveries) instead of reading,
 * or writing, a directory the caller never named; its `args` are the minimal
 * call that reaches that refusal and its `subject` is what the refusal must
 * name. A caller-supplied RELATIVE path is one of those inputs: it is explicit
 * about the file but not about the directory it lives in. `null` means no path
 * the command reads resolves against the invocation directory, so a null root
 * is a complete answer.
 *
 * This is the drift guard for that half: an id added or removed without a
 * decision here fails the keys assertion, and every entry is then exercised
 * through a real tool call. The classification is hand-made for the same reason
 * the root class is — only the handler knows whether it reads a path.
 */
const LAUNCH_CWD_DEFAULT: Readonly<Record<string, null | { readonly args: Record<string, unknown>; readonly subject: string }>> = {
  "audit.secret-scan": { args: {}, subject: "the repository to scan" },
  "audit.supply-chain": { args: {}, subject: "the repository to check" },
  "design-md.validate": { args: { dir: "design" }, subject: "the design directory" },
  "dispatch.validate": { args: { assignmentFile: "assignment.md" }, subject: "the assignment file" },
  "doctor": { args: { target: "omp" }, subject: "the project root this diagnosis reads" },
  "harness.scaffold": { args: {}, subject: "the scaffold root" },
  "host.detect": null,
  "host.skill-root": null,
  "iteration.push-cadence": null,
  "lint": { args: { target: "app.ts" }, subject: "the lint target" },
  "path.resolve": { args: {}, subject: "the start directory" },
  "path.check": { args: {}, subject: "the path to check" },
  "plugin.validate": { args: {}, subject: "the plugin package" },
  "pr-review.budget": null,
  "pr-review.post": { args: { pr: "1", bodyFile: path.join(os.tmpdir(), "mstar-mcp-root-unread-review.md") }, subject: "the repository this review is posted to" },
  "pr.merge-gate": { args: { pr: "1" }, subject: "the pull request whose review threads are read" },
  // The worktree and skill root are named ABSOLUTELY here so the relative
  // diffFile is the one input left offending: each of the three seat paths has
  // its own assertion (the omitted pair is covered by its own test).
  "pr-review.seat-prompt": {
    args: {
      stage: "1", domain: "cli", seat: "seat-1",
      worktree: path.join(os.tmpdir(), "mstar-mcp-root-unread-worktree"),
      skillRoot: path.join(os.tmpdir(), "mstar-mcp-root-unread-skills"),
      diffFile: "diff.patch",
    },
    subject: "the review diff file",
  },
  "pr-review.size": { args: { base: "HEAD", head: "HEAD" }, subject: "the repository this size classifies" },
  "pr-review.tally": { args: { findings: "findings.json" }, subject: "the findings file" },
  "pr-review.validate-report": { args: { reportFile: "review.md" }, subject: "the report file" },
  "pr-review.worktree-cleanup": { args: { worktreePath: "worktrees/review", branch: "review/x" }, subject: "the review worktree to remove" },
  "qc.validate-report": { args: { reportFile: "review.md" }, subject: "the report file" },
  "report": null,
  "review.seats": { args: { assignmentFile: "assignment.md" }, subject: "the assignment file" },
  "roles.validate": { args: {}, subject: "the role corpus directory" },
  "schema": null,
  "skill.lint": { args: { skillDir: "skills/mstar-harness-core" }, subject: "the skill directory" },
  "store.execution.export": null,
  "store.execution.restore": null,
  "store.execution.restore-preview": null,
  // why: Every collaboration verb takes an ABSOLUTE operation target and manifest
  // path, so no path it reads resolves against the invocation directory.
  "store.collaboration.activate": null,
  "store.collaboration.apply": null,
  "store.collaboration.plan": null,
  "store.collaboration.restore": null,
  // note: adopt names its target explicitly (--harness <abs>): no launch-cwd default.
  "store.collaboration.adopt": null,
  "worktree.qc-alignment": { args: { files: ["qc1.md", "qc2.md"] }, subject: "the assignment file" },
};

/** An Assignment both `dispatch.validate` and `review.seats` accept. */
const LAUNCH_ASSIGNMENT = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
execution_mode: sdd
working_branch: feature/fixture
task_budget: S - one focused implementer round
---

## Assignment
`;

/** Two byte-identical QC assignments, so `worktree.qc-alignment` aligns them. */
const LAUNCH_QC_ASSIGNMENT = `---
execute_as: qc-specialist
task_category: logic
plan_id: plan-fireplace
review_range: "merge-base: main + tip: HEAD"
diff_basis: "merge-base: main + tip: HEAD"
---
`;

/**
 * A launch directory and a DIFFERENT declared workspace, each LOOKING like a
 * working checkout: a Git repository with one commit, every file the root-free
 * validators read (a clean lintable source file, an Assignment, aligned QC
 * assignments, a valid DESIGN.md, a valid SKILL.md), and a review body. Every
 * root-free member that reads a relative path from the invocation directory
 * answers confidently in either one — which is exactly the silent wrong answer
 * the refusal exists to prevent. The two are SIBLINGS, so a resolution that
 * fell back to the process directory names the launch copy, and a
 * declared-workspace assertion on the path can tell the two apart.
 */
async function launchDirectoryCheckout(): Promise<{ launch: string; workspace: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const launch = path.join(root, "launch");
  const workspace = path.join(root, "workspace");
  for (const checkout of [launch, workspace]) {
    mkdirSync(path.join(checkout, "skills", "mstar-harness-core"), { recursive: true });
    mkdirSync(path.join(checkout, "design"), { recursive: true });
    writeFileSync(path.join(checkout, "tracked.txt"), "no credentials here\n", "utf8");
    writeFileSync(path.join(checkout, "review.md"), "## Review\n", "utf8");
    writeFileSync(path.join(checkout, "app.ts"), "export const tracked = true;\n", "utf8");
    writeFileSync(path.join(checkout, "assignment.md"), LAUNCH_ASSIGNMENT, "utf8");
    writeFileSync(path.join(checkout, "qc1.md"), LAUNCH_QC_ASSIGNMENT, "utf8");
    writeFileSync(path.join(checkout, "qc2.md"), LAUNCH_QC_ASSIGNMENT, "utf8");
    writeFileSync(path.join(checkout, "design", "DESIGN.md"), DESIGN_LEVEL1, "utf8");
    writeFileSync(path.join(checkout, "skills", "mstar-harness-core", "SKILL.md"), SKILL_GOOD, "utf8");
    const git = (args: string[]): void => {
      execFileSync("git", args, { cwd: checkout, stdio: ["ignore", "ignore", "ignore"] });
    };
    git(["init", "--quiet"]);
    git(["add", "-A"]);
    git(["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "--quiet", "-m", "fixture checkout"]);
  }
  return { launch, workspace };
}

/**
 * A workspace that declares itself: its own `package.json` stops the project
 * root walk-up AT the workspace, so a project-scoped command that reads this
 * process's directory instead answers about a different checkout.
 */
function declaredWorkspace(): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-workspace-"));
  roots.push(workspace);
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "caller-workspace", version: "1.0.0" }), "utf8");
  return workspace;
}

/** A declared workspace that is also a conformant Agent Plugins package. */
function declaredPluginWorkspace(): string {
  const workspace = declaredWorkspace();
  writeFileSync(path.join(workspace, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "caller-workspace",
    version: "1.0.0",
  }), "utf8");
  return workspace;
}

/**
 * A nested workspace inside a monorepo: the declared workspace is a MEMBER, so
 * the project root a relative input resolves from is the monorepo root one
 * level up — the single answer both path-reading families must agree on.
 */
function nestedWorkspaceCheckout(): { root: string; workspace: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-monorepo-"));
  roots.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "mono", workspaces: ["packages/*"] }), "utf8");
  const workspace = path.join(root, "packages", "app");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "@mono/app" }), "utf8");
  return { root, workspace };
}

/** The class an unpinned resolver actually gives one definition (throws for `root`). */
function admitOnUnpinnedConnection(id: string): "root" | "none" {
  const definition = getCommandDefinitions().find((entry) => entry.id === id);
  if (definition === undefined) throw new Error(`missing command: ${id}`);
  try {
    const context = createContextResolver()(definition, undefined, new AbortController().signal, [], createMcpEffects([])) as
      | { controlRoot: string | null }
      | Promise<{ controlRoot: string | null }>;
    if (context instanceof Promise) throw new Error(`${id}: the default resolver must resolve synchronously`);
    return context.controlRoot === null ? "none" : "root";
  } catch (error) {
    if (error instanceof McpControlRootError) return "root";
    throw error;
  }
}

describe("MCP control-root admission class", () => {
  test("every published command is classified, and the resolver decides exactly that class", () => {
    const definitions = getCommandDefinitions();
    expect(definitions.map((entry) => entry.id).sort()).toEqual(Object.keys(CONTROL_ROOT_CLASS).sort());
    for (const definition of definitions) {
      expect([definition.id, admitOnUnpinnedConnection(definition.id)]).toEqual([definition.id, CONTROL_ROOT_CLASS[definition.id]!]);
    }
  });

  test("a root-free command declares no ROOT selector of its own", () => {
    for (const [id, admitted] of Object.entries(CONTROL_ROOT_CLASS)) {
      if (admitted !== "none") continue;
      const definition = getCommandDefinitions().find((entry) => entry.id === id)!;
      const descriptor = getCommandSchemas([definition])[0]!;
      const properties = descriptor.input !== null && typeof descriptor.input === "object"
        ? (descriptor.input as { properties?: Record<string, unknown> }).properties ?? {}
        : {};
      // The class exists because a null root is a complete answer. A command
      // that named a ROOT selector would contradict that; a `harness` that only
      // names an operation target (`store.execution.*`) does not, because the
      // command executes against the target itself.
      const rootInputs = definition.rootInputs
        ?? (Object.hasOwn(properties, "harness") || definition.cli.options.some((option) => option.key === "harness") ? ["harness"] : []);
      expect([id, rootInputs]).toEqual([id, []]);
    }
  });

  test("a root-free command declares whether it takes a path from the invocation directory", () => {
    const rootFree = Object.entries(CONTROL_ROOT_CLASS)
      .filter(([, admitted]) => admitted === "none")
      .map(([id]) => id)
      .sort();
    expect(Object.keys(LAUNCH_CWD_DEFAULT).sort()).toEqual(rootFree);
  });

  test("a root-free command that reads a path from the invocation directory refuses on an unpinned connection", async () => {
    const fixture = await launchDirectoryCheckout();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    try {
      for (const [id, claimed] of Object.entries(LAUNCH_CWD_DEFAULT)) {
        if (claimed === null) continue;
        const result = await callRawTool(createContextResolver(), id, claimed.args);
        const envelope = result.structuredContent as CommandEnvelope;
        // Every failure names the entry: one broken member must not read as an
        // unexplained suite failure.
        if (envelope === undefined) throw new Error(`${id}: the tool result carries no envelope: ${rawText(result)}`);
        expect([id, result.isError]).toEqual([id, true]);
        expect([id, envelope.status, envelope.code]).toEqual([id, "usage", "command.invalid-input"]);
        const text = rawText(result);
        expect([id, text.includes("LAUNCH directory")]).toEqual([id, true]);
        expect([id, text.includes(claimed.subject)]).toEqual([id, true]);
        // The recovery is the launcher declaration, not a guess about the host.
        expect([id, text.includes("--workspace")]).toEqual([id, true]);
        // Nothing was answered ABOUT the directory it refused: the launch
        // directory is not even echoed back.
        expect([id, text.includes(fixture.launch)]).toEqual([id, false]);
      }
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("tally reports a relative findings path together with the run facts it also faults", async () => {
    const fixture = await launchDirectoryCheckout();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    try {
      // The findings payload is RELATIVE and the coverage facts that settle the
      // run are missing: the launch-directory fault must join the family's one
      // collection phase, so this single response reports both.
      const result = await callRawTool(createContextResolver(), "pr-review.tally", { findings: "findings.json" });
      expect(result.isError).toBe(true);
      const envelope = rawEnvelope(result);
      expect([envelope.status, envelope.code]).toEqual(["usage", "command.invalid-input"]);
      const diagnostics = (envelope.details?.diagnostics ?? []) as Array<{ path?: string; code?: string }>;
      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "findings", code: "invalid_type" }),
        expect.objectContaining({ path: "requiredDomains", code: "required" }),
        expect.objectContaining({ path: "diffBasis", code: "required" }),
      ]));
      // The launcher cause and its recovery survive the aggregation, and the
      // refused directory is neither read nor echoed back.
      const text = rawText(result);
      expect(text).toContain("LAUNCH directory");
      expect(text).toContain("--workspace");
      expect(text).not.toContain(fixture.launch);
      expect(text).not.toContain("findings file not found");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an array path input names EVERY relative member in one refusal, and only the relative ones", async () => {
    const fixture = await launchDirectoryCheckout();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    try {
      type Diagnostic = { path?: string; code?: string; expected?: string; received?: string };
      const diagnosticsOf = (result: Awaited<ReturnType<typeof callRawTool>>): Diagnostic[] =>
        (rawEnvelope(result).details?.diagnostics ?? []) as Diagnostic[];

      // Two relative members: both are refused TOGETHER, each under its own
      // index. A regression that reports only `files[0]` leaves the caller
      // learning the second one on a later attempt.
      const both = await callRawTool(createContextResolver(), "worktree.qc-alignment", { files: ["qc1.md", "qc2.md"] });
      expect(both.isError).toBe(true);
      expect(rawEnvelope(both)).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(diagnosticsOf(both).map((entry) => entry.path)).toEqual(["files[0]", "files[1]"]);
      expect(diagnosticsOf(both).map((entry) => [entry.code, entry.expected, entry.received])).toEqual([
        ["invalid_type", "absolute path", "relative path"],
        ["invalid_type", "absolute path", "relative path"],
      ]);
      const bothText = rawText(both);
      expect(bothText).toContain("the assignment file #1");
      expect(bothText).toContain("the assignment file #2");
      expect(bothText).not.toContain(fixture.launch);

      // Absolute first, relative second: the absolute member is accepted, so
      // exactly one diagnostic remains, and its index still points at the
      // member that actually offends.
      const mixed = await callRawTool(createContextResolver(), "worktree.qc-alignment", {
        files: [path.join(fixture.launch, "qc1.md"), "qc2.md"],
      });
      expect(mixed.isError).toBe(true);
      expect(diagnosticsOf(mixed).map((entry) => entry.path)).toEqual(["files[1]"]);
      const mixedText = rawText(mixed);
      expect(mixedText).toContain("the assignment file #2");
      expect(mixedText).not.toContain("the assignment file #1");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a validator's relative path resolves under the DECLARED workspace, and an absolute one needs no declaration", async () => {
    const fixture = await launchDirectoryCheckout();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    // The launch checkout is where the unpinned refusal above stood: resolution
    // must not come from this process directory.
    process.chdir(fixture.launch);
    try {
      // The same relative target the class loop refuses, now under the workspace
      // the launcher named (round 9's rule, kept). The launch checkout holds the
      // SAME clean app.ts, so a resolution that fell back to `process.cwd()`
      // would answer with the launch copy's path.
      const declared = await callRawTool(createContextResolver({ workspace: fixture.workspace }), "lint", { target: "app.ts" });
      expect(rawEnvelope(declared)).toMatchObject({ status: "ok", code: "lint.ok" });
      const linted = (rawEnvelope(declared).data as { results: Array<{ file: string }> }).results;
      expect(linted[0]?.file).toBe(path.join(fixture.workspace, "app.ts"));

      // The other family path inputs take the same workspace route and still
      // answer on their clean fixtures (the aligned pair proves the indexed
      // array spelling too).
      for (const [id, args] of [
        ["design-md.validate", { dir: "design" }],
        ["skill.lint", { skillDir: "skills/mstar-harness-core" }],
        ["dispatch.validate", { assignmentFile: "assignment.md" }],
        ["worktree.qc-alignment", { files: ["qc1.md", "qc2.md"] }],
      ] as const) {
        const answered = await callRawTool(createContextResolver({ workspace: fixture.workspace }), id, args);
        expect([id, rawEnvelope(answered).status]).toEqual([id, "ok"]);
        expect([id, rawText(answered).includes("LAUNCH directory")]).toEqual([id, false]);
      }

      // An absolute path was always legal on the unnamed connection: the caller
      // named the directory itself.
      const absolute = await callRawTool(createContextResolver(), "lint", { target: path.join(fixture.workspace, "app.ts") });
      expect(rawEnvelope(absolute)).toMatchObject({ status: "ok", code: "lint.ok" });
      expect((rawEnvelope(absolute).data as { results: Array<{ file: string }> }).results[0]?.file).toBe(path.join(fixture.workspace, "app.ts"));
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("doctor keeps its host-side scope: only the project half needs a workspace", async () => {
    const fixture = await plainForeignCwd();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // The refusal is scoped to what actually reads the invocation directory,
      // so the tool keeps a reachable path on the same connection: the host
      // installation diagnosis never consults a workspace.
      const hosted = await callRawTool(createContextResolver(), "doctor", { target: "omp", scope: "global" });
      expect(rawText(hosted)).not.toContain("LAUNCH directory");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("the declaration is what lifts the refusal: the same call then reads the named directory", async () => {
    const fixture = await launchDirectoryCheckout();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    try {
      // `--workspace` names the directory every call runs from, so the default
      // is no longer the host's: the same no-argument scan that refused above
      // answers about the DECLARED checkout instead.
      const declared = createContextResolver({ workspace: fixture.workspace });
      const scanned = await callRawTool(declared, "audit.secret-scan", {});
      expect(scanned.isError).toBe(false);
      expect((scanned.structuredContent as CommandEnvelope).data).toMatchObject({ findings: [] });
      expect(((scanned.structuredContent as CommandEnvelope).data as { filesScanned: number }).filesScanned).toBeGreaterThan(0);
      expect(rawText(scanned)).not.toContain("LAUNCH directory");
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("the declared workspace anchors the project-root commands, not this process's checkout", async () => {
    const workspace = declaredPluginWorkspace();
    // The launch process runs from this suite's own checkout, which is exactly
    // the directory a process-global project-root resolution would answer
    // about: the declared workspace must win for BOTH project-root readers.
    const resolver = createContextResolver({ workspace });

    const doctor = await callRawTool(resolver, "doctor", { target: "opencode", scope: "project", generation: "v2" });
    const doctorEnvelope = doctor.structuredContent as CommandEnvelope;
    // The project-scoped diagnosis reads the project around the invocation;
    // with a declared workspace that is the caller's own config.
    expect(doctorEnvelope.details?.location).toBe(path.join(workspace, "opencode.json"));
    expect(rawText(doctor)).toContain(path.join(workspace, "opencode.json"));

    const validated = await callRawTool(resolver, "plugin.validate", {});
    const pluginEnvelope = validated.structuredContent as CommandEnvelope;
    expect([pluginEnvelope.status, pluginEnvelope.code]).toEqual(["ok", "plugin.validate.ok"]);
    expect((pluginEnvelope.data as { root: string }).root).toBe(workspace);
    expect(rawText(validated)).toContain(workspace);
  });

  test("the same relative input reaches the declared workspace's project root", async () => {
    const { root, workspace } = nestedWorkspaceCheckout();
    // why: The declared workspace is the MEMBER: the validator must resolve its
    // relative input from the MONOREPO root one level up, not from the raw
    // workspace join. The fixture file sits at the monorepo root; a raw
    // workspace join would answer about the member and find nothing.
    const resolver = createContextResolver({ workspace });
    writeFileSync(path.join(root, "app.ts"), "export const parity = true;\n", "utf8");

    const linted = rawEnvelope(await callRawTool(resolver, "lint", { target: "app.ts" }));
    // The lint family publishes `{ results: [{ file }] }`; name the shape once.
    const lintData = linted.data as { results: Array<{ file: string }> };
    expect([linted.status, lintData.results[0]?.file]).toEqual(["ok", path.join(root, "app.ts")]);
  });

  test("a relative reportFile is refused on an unnamed workspace instead of validating the host checkout", async () => {
    const fixture = await launchDirectoryCheckout();
    // The launch checkout really contains `review.md`, so resolving the
    // relative path there would answer with a convincing verdict about a file
    // the caller never named.
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    try {
      for (const id of ["pr-review.validate-report", "qc.validate-report"]) {
        const relative = await callRawTool(createContextResolver(), id, { reportFile: "review.md" });
        expect([id, relative.isError]).toEqual([id, true]);
        const envelope = rawEnvelope(relative);
        expect([id, envelope.status, envelope.code]).toEqual([id, "usage", "command.invalid-input"]);
        expect(envelope.details?.diagnostics).toContainEqual(expect.objectContaining({ path: "reportFile", code: "invalid_type" }));
        const text = rawText(relative);
        expect([id, text.includes("LAUNCH directory")]).toEqual([id, true]);
        expect([id, text.includes(fixture.launch)]).toEqual([id, false]);
      }

      // The same file, named absolutely, IS answered: the caller named the
      // directory it belongs to.
      const named = await callRawTool(createContextResolver(), "pr-review.validate-report", { reportFile: path.join(fixture.launch, "review.md") });
      expect(rawEnvelope(named).status).not.toBe("usage");
      expect(rawText(named)).not.toContain("LAUNCH directory");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("one refusal names every unnamed path a call would resolve from the launch directory", async () => {
    const fixture = await launchDirectoryCheckout();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    try {
      // Both seat paths are omitted: one attempt must report both, or the
      // caller learns them one retry at a time.
      const refused = await callRawTool(createContextResolver(), "pr-review.seat-prompt", {
        stage: "1", domain: "cli", seat: "seat-1",
      });
      expect(refused.isError).toBe(true);
      const envelope = rawEnvelope(refused);
      expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input" });
      const paths = (envelope.details?.diagnostics as Array<{ path?: string }>).map((entry) => entry.path);
      expect(paths).toEqual(["worktree", "skillRoot"]);
      const text = rawText(refused);
      expect(text).toContain("the review worktree");
      expect(text).toContain("the audit skill root");
      expect(text).not.toContain(fixture.launch);
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });


  test("an unpinned no-argument roles.validate does not answer for the host checkout", async () => {
    const fixture = await launchDirectoryCheckout();
    // A corpus OUTSIDE the launch directory, so the second half proves the
    // refusal is about the UNNAMED directory rather than the command becoming
    // unreachable.
    const corpus = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-corpus-"));
    roots.push(corpus);
    const rolesDir = path.join(corpus, "skills", "mstar-roles");
    mkdirSync(rolesDir, { recursive: true });
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    try {
      const refused = await callRawTool(createContextResolver(), "roles.validate", {});
      expect(refused.isError).toBe(true);
      const envelope = refused.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(envelope.details?.diagnostics).toContainEqual(expect.objectContaining({ path: "rolesDir", code: "required" }));
      const text = rawText(refused);
      expect(text).not.toContain(fixture.launch);
      // Not a verdict: the envelope carries no sibling count harvested from the
      // host's corpus.
      expect(envelope.data).toBeUndefined();

      const named = await callRawTool(createContextResolver(), "roles.validate", { rolesDir });
      const namedEnvelope = named.structuredContent as CommandEnvelope;
      // The named corpus is answered (its own mapping violations), and the
      // answer talks about that directory, never about the launch directory.
      expect(namedEnvelope.status).not.toBe("usage");
      expect(rawText(named)).toContain(corpus);
      expect(rawText(named)).not.toContain(fixture.launch);

      // `skillsDir` is OPTIONAL because omitting it derives the parent of the
      // roles dir the caller named — but a relative value names no directory at
      // all, so only that input is refused.
      const relativeSkills = await callRawTool(createContextResolver(), "roles.validate", { rolesDir, skillsDir: "skills" });
      expect(relativeSkills.isError).toBe(true);
      const relativeEnvelope = relativeSkills.structuredContent as CommandEnvelope;
      expect(relativeEnvelope).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(relativeEnvelope.details?.diagnostics).toEqual([
        expect.objectContaining({ path: "skillsDir", code: "invalid_type", expected: "absolute path", received: "relative path" }),
      ]);
      expect(relativeEnvelope.data).toBeUndefined();
      const relativeText = rawText(relativeSkills);
      expect(relativeText).toContain("the skills root");
      expect(relativeText).not.toContain(corpus);

      // The same field, named absolutely, is accepted: the refusal above was
      // the launch-directory rule, not `skillsDir` being required.
      const absoluteSkills = await callRawTool(createContextResolver(), "roles.validate", {
        rolesDir,
        skillsDir: path.join(corpus, "skills"),
      });
      expect((absoluteSkills.structuredContent as CommandEnvelope).status).not.toBe("usage");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an unpinned connection runs a root-free tool instead of refusing it, and still refuses a root consumer", async () => {
    const fixture = await plainForeignCwd();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // `schema` is the discovery tool every refusal points a caller at, and it
      // reads no control root: it must answer on the same unpinned connection
      // that refused the call, or the advertised recovery is itself refused.
      const discovery = await callRawTool(createContextResolver(), "schema", { command: "lint" });
      expect(discovery.isError).toBe(false);
      expect(discovery.structuredContent).toMatchObject({ status: "ok", code: "schema.ok" });

      // The class is an admission rule, not a bypass: a command that reads the
      // root keeps its named refusal.
      const rooted = await callRawTool(createContextResolver(), "status.validate", {});
      expect(rooted.isError).toBe(true);
      expect(rawText(rooted)).toContain("mcp.control-root-unresolved");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("the refusal names the per-call harness selector and `mstar path resolve` as the recovery", async () => {
    const fixture = await plainForeignCwd();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      const refused = await callRawTool(createContextResolver(), "status.validate", {});
      const text = rawText(refused);
      expect(text).toContain("publishes no root selector");
      expect(text).toContain("mstar <command>");
      // why: The retired launch pins are not recoveries anymore: there is no
      // connection-level root to declare.
      expect(text).not.toContain("--harness");
      expect(text).not.toContain("MSTAR_HARNESS_DIR");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("two calls on one connection reach their own roots", async () => {
    const fixture = await twoInitializedHarnesses();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    try {
      // why: `status.tech-debt` resolves its own root from `input.harness`. One
      // shared connection, two named roots: the first store carries the
      // captured issue, the second carries none.
      const named = await callRawTool(createContextResolver(), "status.tech-debt", { harness: fixture.named });
      expect((named.structuredContent as CommandEnvelope).data as { total_open: number }).toMatchObject({ total_open: 1 });
      const other = await callRawTool(createContextResolver(), "status.tech-debt", { harness: fixture.other });
      expect((other.structuredContent as CommandEnvelope).data as { total_open: number }).toMatchObject({ total_open: 0 });
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an inherited MSTAR_HARNESS_DIR does not re-root a call", async () => {
    const fixture = await twoInitializedHarnesses();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    // why: The retired variable is no longer a root candidate: an ambient value
    // that names the OTHER root must not redirect the call's selector.
    process.env.MSTAR_HARNESS_DIR = fixture.other;
    try {
      const result = await callRawTool(createContextResolver(), "status.tech-debt", { harness: fixture.named });
      const envelope = result.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "ok", code: "status.ok" });
      expect((envelope.data as { total_open: number }).total_open).toBe(1);
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an absolute harness B from a host launched in A touches only B", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
    roots.push(root);
    const launch = gitMainWorktree(root, "A");
    const launchHarness = path.join(launch, ".mstar");
    await initializeHarness(launchHarness);
    const harnessB = path.join(gitMainWorktree(root, "B"), ".mstar");
    await initializeHarness(harnessB);
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(launch);
    try {
      // why: A write rooted at B by the call's own selector, from a server whose
      // launch directory owns A's harness: the capture lands in B and leaves
      // A's store rows untouched.
      //
      // The assertion reads A's ROWS rather than its file bytes: SQLite leaves
      // `-wal`/`-shm` beside a store after a read, and it keeps an unflushed
      // write in the WAL, so a byte snapshot is both noisy (a read looks like a
      // diff) and incomplete (a WAL-only write looks like no diff). Row counts
      // are exactly what "the capture did not reach A" means, and the baseline
      // reads A's LIVE collaboration lane — the store the issue writer actually
      // commits to — before the call, so a capture that lands in B cannot pass
      // by leaking a row or a receipt into A's lane.
      const before = await storeRowCounts(launchHarness);
      expect(before).toEqual({ issues: 0, operations: 0 });
      const added = await callRawTool(createContextResolver(), "issue.add", {
        harness: harnessB,
        payload: { ...CAPTURE_INPUT },
        actor: "project-manager",
      });
      expect(added.isError).toBe(false);
      expect(rawEnvelope(added)).toMatchObject({ status: "ok", code: "issue.add.ok" });
      expect(await storeRowCounts(launchHarness)).toEqual(before);

      const inB = await callRawTool(createContextResolver(), "status.tech-debt", { harness: harnessB });
      expect(((inB.structuredContent as CommandEnvelope).data as { total_open: number }).total_open).toBe(1);
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a read-only store open leaves the store's rows untouched", async () => {
    // The root-touching tests now assert ROW counts rather than file bytes,
    // because a read leaves SQLite sidecars behind and a pending write can live
    // only in the WAL. This pins that contract: reading is invisible to it.
    const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
    roots.push(root);
    const harness = path.join(gitMainWorktree(root, "read-only-control"), ".mstar");
    await initializeHarness(harness);
    const before = await storeRowCounts(harness);
    const handle = await openCollaborationStore({ harnessDir: harness }, "read");
    handle.close();
    expect(await storeRowCounts(harness)).toEqual(before);
  });

  test("an unpinned connection refuses a root consumer even when the launch cwd owns a harness", async () => {
    const fixture = launchCheckoutWithHarness();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    try {
      // `audit.scaffold` publishes no `harness` field and derives `{REVIEW_DIR}`
      // from the invocation workspace: a cwd probe would root it on the LAUNCH
      // workspace's own harness and write a review run there.
      const refused = await callRawTool(createContextResolver(), "audit.scaffold", { findings: "findings.json" });
      expect(refused.isError).toBe(true);
      expect(rawText(refused)).toContain("mcp.control-root-unresolved");
      expect(readdirSync(fixture.launchHarness)).toEqual([]);
      expect(existsSync(path.join(fixture.launchHarness, "store.db"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a relative per-call harness is a named refusal, never a launch-directory resolution", async () => {
    const fixture = await relativeRootWorkspace();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.base);
    try {
      const definition = getCommandDefinitions().find((entry) => entry.id === "status.tech-debt")!;
      let caught: unknown;
      try {
        createContextResolver()(definition, undefined, new AbortController().signal, [], createMcpEffects([]), { harness: fixture.selector });
      } catch (error) {
        caught = error;
      }
      // The selector is a path fact like `--harness`: the invocation workspace
      // is anchored on its parent, so a relative value would be re-resolved
      // against its own parent and double-join.
      expect(caught).toBeInstanceOf(McpControlRootError);
      const message = (caught as Error).message;
      expect(message).toContain("mcp.control-root-unresolved");
      expect(message).toContain(`status.tech-debt's "harness" selector must be an absolute path; got ${JSON.stringify(fixture.selector)}`);
      expect(message).toContain("mstar path resolve");

      // The same selector through a real tool call is refused the same way,
      // instead of answering from the root it would have named before.
      const refused = await callRawTool(createContextResolver(), "status.tech-debt", { harness: fixture.selector });
      expect(refused.isError).toBe(true);
      const text = rawText(refused);
      expect(text).toContain("mcp.control-root-unresolved");
      expect(text).toContain("must be an absolute path");
      expect(text).not.toContain("status.ok");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a union-input command publishes and admits harness as required when unpinned", async () => {
    const fixture = await twoInitializedHarnesses();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    const definition = getCommandDefinitions().find((entry) => entry.id === "issue.close");
    if (definition === undefined) throw new Error("missing command: issue.close");
    const server = createMcpServer(createContextResolver(), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      // The union branches keep `harness` optional so their conditional
      // alternatives survive, so the unpinned requirement is published in the
      // per-action line and enforced at admission instead of by the schema.
      const { tools } = await client.listTools();
      const issue = tools.find((entry) => entry.name === "mstar_issue")!;
      expect(issue.description).toContain("- close: id, actor, expect, harness");

      const omitted = await toolEnvelope(client, "mstar_issue", withAction("issue.close", { id: "issue-absent", actor: "project-manager", expect: 1 }));
      expect(omitted).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(omitted.message).toContain("harness");
      expect((omitted.details?.diagnostics as Array<{ path?: string }>).map((entry) => entry.path)).toContain("harness");

      // Naming the root reaches the command's own verdict: the harness
      // requirement is satisfied, and no harness diagnostic is reported.
      const named = await toolEnvelope(client, "mstar_issue", withAction("issue.close", { id: "issue-absent", actor: "project-manager", expect: 1, harness: fixture.named }));
      expect(named.message ?? "").not.toContain("needs the call's `harness` selector");
      expect((named.details?.diagnostics as Array<{ path?: string }> | undefined ?? []).map((entry) => entry.path)).not.toContain("harness");
    } finally {
      await client.close();
      await server.close();
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an unpinned union call reports the missing harness with the undeclared key and the fields admission refused", async () => {
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    const definition = getCommandDefinitions().find((entry) => entry.id === "issue.close");
    if (definition === undefined) throw new Error("missing command: issue.close");
    const server = createMcpServer(createContextResolver(), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);
      // The call names no harness, carries a key the action does not declare
      // AND none of the fields it requires: all three groups must arrive in ONE
      // refusal. The root requirement is the one fact only this refusal can
      // teach, so an early refusal on the undeclared key would cost the caller a
      // second attempt to learn it.
      const refused = await toolEnvelope(client, "mstar_issue", withAction("issue.close", { bogus: 1 }));
      expect(refused).toMatchObject({ status: "usage", code: "command.invalid-input" });
      // The refusal's message is the shared diagnostic summary once more than
      // one field is refused, so the root requirement is still the FIRST cause
      // in it; the harness recovery stays the envelope's recovery.
      expect(refused.message.split("\n")[1]).toContain("harness");
      expect(refused.message).toContain("bogus");
      expect(refused.details?.recovery).toContain("mstar path resolve");
      const paths = (refused.details?.diagnostics as Array<{ path?: string }>).map((entry) => entry.path);
      expect(paths[0]).toBe("harness");
      expect((refused.details?.diagnostics as Array<{ path?: string; code?: string; message?: string }>)[0]).toMatchObject({ path: "harness", code: "required" });
      expect((refused.details?.diagnostics as Array<{ message?: string }>)[0]?.message).toContain("carries no root");
      // The undeclared key is still a field refusal, not an admission failure.
      expect((refused.details?.diagnostics as Array<{ path?: string; code?: string }>)[1]).toMatchObject({ path: "bogus", code: "not_allowed" });
      expect(refused.details?.fields).toEqual(["bogus"]);
      // Admission's own facts follow in the same response.
      expect(paths).toContain("id");
      expect(paths).toContain("actor");
      expect(paths).toContain("payload");
    } finally {
      await client.close();
      await server.close();
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });
});

/** why: Two REAL Git main worktrees, each owning its own `.mstar`, plus a LINKED
 * worktree of the first: the engine verifies the process root through Git, so
 * a selector regression needs genuine checkouts rather than bare directories.
 */
function twoGitWorkspaces(): { rootA: string; rootB: string; harnessA: string; harnessB: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(base);
  const make = (name: string): string => {
    const repo = path.join(base, name);
    mkdirSync(path.join(repo, ".mstar"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    // note: The checkout declares its collaboration identity: issue/catalog authority
    // lives in the lane, which is scoped by the repository.
    writeFileSync(path.join(repo, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=fixture-${repoSequence++}\n`);
    return realpathSync(repo);
  };
  const rootA = make("repo-a");
  const rootB = make("repo-b");
  return { rootA, rootB, harnessA: path.join(rootA, ".mstar"), harnessB: path.join(rootB, ".mstar") };
}

describe("MCP per-call root selectors and operation targets", () => {
  test("sdd.workspace resolves from the controlRoot the call names", async () => {
    const fixture = twoGitWorkspaces();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    try {
      // why: The selector the call names IS its root, and it must reach the
      // resolver as the call root. Forwarding only a `harness` selector
      // refused this call with `mcp.control-root-unresolved` although it named
      // a real root.
      const result = await callRawTool(
        createContextResolver(),
        "sdd.workspace",
        { planId: "plan-named-root", controlRoot: fixture.harnessB },
      );
      expect(result.isError).toBe(false);
      const envelope = result.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "ok", code: "sdd.workspace.ok" });
      const sddDir = (envelope.data as { sddDir: string }).sddDir;
      expect(sddDir).toBe(path.join(fixture.harnessB, "sdd", "plan-named-root"));
      expect(existsSync(sddDir)).toBe(true);
      // The workspace the call did NOT name received nothing.
      expect(existsSync(path.join(fixture.rootA, ".mstar", "sdd"))).toBe(false);
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a linked worktree's .mstar is refused, naming the main worktree path", async () => {
    const fixture = twoGitWorkspaces();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    // why: A genuine Git worktree of A: its own `.mstar` is not A's control root.
    const linked = path.join(path.dirname(fixture.rootA), "linked-a");
    execFileSync("git", ["worktree", "add", "--detach", "-q", linked, "HEAD"], { cwd: fixture.rootA });
    mkdirSync(path.join(linked, ".mstar"), { recursive: true });
    const linkedHarness = path.join(realpathSync(linked), ".mstar");
    try {
      const result = await callRawTool(
        createContextResolver(),
        "sdd.workspace",
        { planId: "plan-linked", controlRoot: linkedHarness },
      );
      expect(result.isError).toBe(true);
      const text = rawText(result);
      expect(text).toContain("mcp.control-root-unresolved");
      // why: The refusal names the MAIN worktree the selector must resolve instead.
      expect(text).toContain(fixture.rootA);
      expect(existsSync(path.join(linkedHarness, "sdd"))).toBe(false);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: fixture.rootA });
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a non-.mstar control root is refused as not the fixed control root", async () => {
    const fixture = twoGitWorkspaces();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    try {
      // why: The fixed contract is `<main worktree>/.mstar`: the worktree root
      // itself is not a selector.
      const result = await callRawTool(
        createContextResolver(),
        "sdd.workspace",
        { planId: "plan-worktree-root", controlRoot: fixture.rootB },
      );
      expect(result.isError).toBe(true);
      const text = rawText(result);
      expect(text).toContain("mcp.control-root-unresolved");
      expect(text).toContain(".mstar");
      expect(existsSync(path.join(fixture.harnessB, "sdd"))).toBe(false);
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an unpinned connection refuses to resolve paths from the host checkout by default", async () => {
    const fixture = twoGitWorkspaces();
    await initializeHarness(fixture.harnessA);
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.rootA);
    try {
      // With no control root the invocation workspace is the host's launch
      // directory: answering "here is the harness" would describe an unrelated
      // project. The start directory is a required input instead.
      const omitted = await callRawTool(createContextResolver(), "path.resolve", {});
      expect(omitted.isError).toBe(true);
      const refused = omitted.structuredContent as CommandEnvelope;
      expect(refused).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(refused.details?.diagnostics).toContainEqual(expect.objectContaining({ path: "path", code: "required" }));
      const text = rawText(omitted);
      expect(text).toContain("--workspace");
      expect(text).not.toContain(fixture.harnessA);

      // A caller-named start directory is still a complete answer.
      const named = await callRawTool(createContextResolver(), "path.resolve", { path: fixture.rootA });
      expect(named.isError).toBe(false);
      const resolved = (named.structuredContent as CommandEnvelope).data as { harnessDir: string };
      expect(realpathSync(resolved.harnessDir)).toBe(realpathSync(fixture.harnessA));
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an unpinned connection refuses pr-review.worktree-setup instead of running it in the host checkout", async () => {
    const fixture = twoGitWorkspaces();
    const previousCwd = process.cwd();
    process.chdir(fixture.rootA);
    try {
      // The host checkout IS a usable Git repository, which is exactly the trap:
      // the command exposes no workspace field, so a null-root call would review
      // the host's own repository. It must refuse with the named cause instead.
      const result = await callRawTool(createContextResolver(), "pr-review.worktree-setup", { workingTree: true });
      expect(result.isError).toBe(true);
      const text = rawText(result);
      expect(text).toContain("mcp.control-root-unresolved");
      expect(text).toContain("publishes no root selector");
      expect(text).not.toContain("--harness");
    } finally {
      process.chdir(previousCwd);
    }
  });
});
