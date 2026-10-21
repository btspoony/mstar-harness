import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { backupStore, captureIssue, initializeStore } from "@mstar-harness/engine";
import { getCommandDefinitions, getCommandSchemas, type CommandEnvelope } from "@mstar-harness/commands";
import { mapParserError } from "../src/command-adapter";
import { registerMcpCommand } from "../src/mcp/command";
import { registerMcpCommands, type ResolveContext } from "../src/mcp/register";
import { createMcpServer } from "../src/mcp/server";
import { createMcpEffects } from "../src/mcp/effects";
import { createContextResolver, McpControlRootError } from "../src/mcp/stdio";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/**
 * A harness and an invocation cwd that are siblings: the cwd contains no
 * harness and is not inside a git checkout, so the cwd probe cannot discover
 * the harness by walking up.
 */
async function harnessOutsideCwd(): Promise<{ harness: string; cwd: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const harness = path.join(root, "control", ".mstar");
  const cwd = path.join(root, "plain-cwd");
  mkdirSync(harness, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  (await initializeStore({ harnessDir: harness })).close();
  return { harness, cwd };
}

/**
 * Two roots that a cwd probe CAN distinguish: the pinned harness owns an
 * initialized store, while the cwd owns its own `.mstar` directory with no
 * store. A command that resolves its own root from `input.harness` therefore
 * reads the pinned store only when the launcher default was propagated; the
 * cwd probe alone reaches an uninitialized store and refuses.
 */
async function competingCwdHarness(): Promise<{ harness: string; cwd: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const harness = path.join(root, "control", ".mstar");
  const cwd = path.join(root, "workspace");
  mkdirSync(harness, { recursive: true });
  mkdirSync(path.join(cwd, ".mstar"), { recursive: true });
  (await initializeStore({ harnessDir: harness })).close();
  return { harness, cwd };
}

/**
 * Two roots that a persist verb can distinguish: each owns the SAME review key
 * (`sdd/_reviews/<key>.json`) with a different payload. The pinned root and the
 * cwd's own `.mstar` are both complete so only root selection decides which
 * document a call reads or deletes — never a missing backing directory.
 */
const PERSIST_PROBE_KEY = "root-probe";

async function competingPersistRoots(): Promise<{ pinned: string; cwd: string; cwdRoot: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const pinned = path.join(root, "control", ".mstar");
  const cwd = path.join(root, "workspace");
  const cwdRoot = path.join(cwd, ".mstar");
  for (const [harness, origin] of [[pinned, "pinned"], [cwdRoot, "cwd"]] as const) {
    mkdirSync(path.join(harness, "sdd", "_reviews"), { recursive: true });
    writeFileSync(path.join(harness, "sdd", "_reviews", `${PERSIST_PROBE_KEY}.json`), JSON.stringify({ origin }));
  }
  return { pinned, cwd, cwdRoot };
}

/**
 * Two roots whose review trees a cwd-derived write would separate: the pinned
 * workspace owns harness A, while the launch workspace owns a DIFFERENT harness
 * of its own. `audit.scaffold` publishes no `harness` field and derives
 * `{REVIEW_DIR}` from the invocation cwd, so a cwd-derived report lands under
 * the launch harness and is visible there — the pinned call must not.
 */
async function competingReviewRoots(): Promise<{
  harness: string;
  launch: string;
  launchHarness: string;
  findings: string;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const harness = path.join(root, "pinned", ".mstar");
  const launch = path.join(root, "launch");
  const launchHarness = path.join(launch, ".mstar");
  mkdirSync(harness, { recursive: true });
  mkdirSync(launchHarness, { recursive: true });
  const findings = path.join(root, "findings.json");
  writeFileSync(findings, JSON.stringify({
    findings: [{
      title: "the pinned workspace anchors an implicit harness path",
      description: "the review root is derived from the invocation cwd",
      priority: "P2",
      effort: "S",
      risk: "LOW",
      category: "bug",
    }],
  }));
  return { harness, launch, launchHarness, findings };
}

/**
 * Two workspaces that a scaffold can distinguish: the pinned workspace owns an
 * initialized harness A (`<pinned>/.mstar`), while the launch workspace owns its
 * own `.mstar` and a `.gitignore` with an author marker line. A handler that
 * defaults the scaffold root from `process.cwd()` scaffolds the launch
 * workspace and appends the canonical snippet to that `.gitignore`; the pinned
 * invocation must target the pinned workspace and leave the launch files
 * byte-identical.
 */
async function competingScaffoldWorkspaces(): Promise<{
  pinnedHarness: string;
  launch: string;
  launchHarness: string;
  launchGitignore: string;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const pinnedHarness = path.join(root, "pinned", ".mstar");
  const launch = path.join(root, "launch");
  const launchHarness = path.join(launch, ".mstar");
  mkdirSync(pinnedHarness, { recursive: true });
  mkdirSync(launchHarness, { recursive: true });
  const launchGitignore = path.join(launch, ".gitignore");
  writeFileSync(launchGitignore, "# launch workspace marker\nnode_modules/\n", "utf8");
  (await initializeStore({ harnessDir: pinnedHarness })).close();
  return { pinnedHarness, launch, launchHarness, launchGitignore };
}

/**
 * A pinned harness whose basename is NOT the default `.mstar`: the pin itself
 * (`<root>/control`) is the harness dir, and its parent `<root>` is the
 * invocation workspace. The launch workspace owns a different `.mstar` and a
 * `.gitignore`. A handler that re-discovers the root from the invocation
 * workspace creates `<root>/.mstar` and appends the canonical snippet to
 * `<root>/.gitignore`; a launch-cwd handler touches the launch workspace.
 */
async function customRootScaffoldWorkspace(): Promise<{
  pinned: string;
  workspace: string;
  workspaceGitignore: string;
  launch: string;
  launchHarness: string;
  launchGitignore: string;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const pinned = path.join(root, "control");
  const launch = path.join(root, "launch");
  const launchHarness = path.join(launch, ".mstar");
  mkdirSync(pinned, { recursive: true });
  mkdirSync(launchHarness, { recursive: true });
  const launchGitignore = path.join(launch, ".gitignore");
  writeFileSync(launchGitignore, "# launch workspace marker\nnode_modules/\n", "utf8");
  (await initializeStore({ harnessDir: pinned })).close();
  return {
    pinned,
    workspace: root,
    workspaceGitignore: path.join(root, ".gitignore"),
    launch,
    launchHarness,
    launchGitignore,
  };
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

/**
 * Two roots that an issue-bearing command can distinguish: the pinned root has
 * an ACTIVE store with one captured issue, while the cwd's own `.mstar` is an
 * uninitialized directory. A command that reaches the pinned root answers from
 * that store; a cwd-probed command refuses instead.
 */
async function competingAuthorityRoots(): Promise<{ pinned: string; cwd: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const pinned = path.join(root, "control", ".mstar");
  const cwd = path.join(root, "workspace");
  mkdirSync(pinned, { recursive: true });
  mkdirSync(path.join(cwd, ".mstar"), { recursive: true });
  (await initializeStore({ harnessDir: pinned })).close();
  await captureIssue({ harnessDir: pinned }, { ...CAPTURE_INPUT }, { operationId: "mcp-harness-root-capture", actor: "project-manager" });
  return { pinned, cwd };
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
async function callWorktreeCheck(resolver: ResolveContext): Promise<CommandEnvelope> {
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
      arguments: withAction("worktree.check", { workflow: "wf-absent", plan: "p-absent" }),
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
async function callCatalogList(resolver: ResolveContext): Promise<CommandEnvelope> {
  const definition = getCommandDefinitions().find((entry) => entry.id === "catalog.list");
  if (definition === undefined) throw new Error("missing command: catalog.list");
  const server = createMcpServer(resolver, [definition]);
  const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    const result = await client.callTool({ name: "mstar_catalog", arguments: withAction("catalog.list") });
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
 * directory. An unpinned server launched here probes a workspace its caller
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

describe("MCP harness root", () => {
  test("a read command resolves a harness outside the cwd through --harness", async () => {
    const fixture = await harnessOutsideCwd();
    const previousCwd = process.cwd();
    process.chdir(fixture.cwd);
    try {
      const envelope = await callWorktreeCheck(createContextResolver({ harnessRoot: fixture.harness }));
      // The refusal echoes the authority it actually read, which is the
      // outside-cwd harness named by the flag.
      expect(envelope).toMatchObject({ status: "refused", code: "worktree.l1.workflow-not-found" });
      expect((envelope.details as { authorityGraph?: string } | undefined)?.authorityGraph).toBe(fixture.harness);

      // Without the flag this launch declares no root, so the resolver refuses
      // instead of adopting the host's directory — and the refusal never names
      // the fixture root.
      const unpinned = await callRawTool(createContextResolver(), "sdd.workspace", { planId: "plan-unpinned" });
      const unpinnedText = rawText(unpinned);
      expect(unpinned.isError).toBe(true);
      expect(unpinnedText).toContain("mcp.control-root-unresolved");
      expect(unpinnedText).not.toContain(fixture.harness);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("the production server propagates the pinned root to a command that reads its own harness input", async () => {
    const fixture = await competingCwdHarness();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // catalog.list resolves its root from `input.harness`, not `controlRoot`:
      // the pinned fixture store is read only when the launcher default reached
      // that field. The cwd's own harness directory is never consulted.
      const pinned = await callCatalogList(createContextResolver({ harnessRoot: fixture.harness }));
      expect(pinned).toMatchObject({ status: "ok", code: "catalog.list.ok" });
      expect((pinned.data as { items: unknown[] }).items).toEqual([]);
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an unpinned connection publishes harness as required and refuses a call that omits it", async () => {
    const fixture = await competingCwdHarness();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    const definition = getCommandDefinitions().find((entry) => entry.id === "catalog.list");
    if (definition === undefined) throw new Error("missing command: catalog.list");
    try {
      const unpinned = createMcpServer(createContextResolver(), [definition]);
      const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
      try {
        await unpinned.connect(serverEnd);
        await client.connect(clientEnd);

        // The published per-action line is the discovery surface a model reads:
        // with no declared root there is no default to fill, so `harness` is a
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
        await unpinned.close();
      }

      // A pinned connection keeps the field optional: the pin IS the default.
      const pinned = createMcpServer(createContextResolver({ harnessRoot: fixture.harness }), [definition]);
      const pinnedClient = new Client({ name: "harness-root-test-client", version: "1.0.0" });
      const [pinnedClientEnd, pinnedServerEnd] = InMemoryTransport.createLinkedPair();
      try {
        await pinned.connect(pinnedServerEnd);
        await pinnedClient.connect(pinnedClientEnd);
        const { tools } = await pinnedClient.listTools();
        const catalog = tools.find((entry) => entry.name === "mstar_catalog")!;
        expect(catalog.description).toContain("- list: no required fields");
      } finally {
        await pinnedClient.close();
        await pinned.close();
      }
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a pinned harness anchors an implicit cwd-derived path on its own workspace", async () => {
    const fixture = await competingReviewRoots();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    const definition = getCommandDefinitions().find((entry) => entry.id === "audit.scaffold");
    if (definition === undefined) throw new Error("missing command: audit.scaffold");
    const server = createMcpServer(createContextResolver({ harnessRoot: fixture.harness }), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      // `audit.scaffold` publishes no `harness` field, so the pin cannot reach
      // it through admission: the workspace anchor is the only propagation. The
      // launch cwd owns a different harness, so a cwd-derived review root would
      // create its run dir there and be visible below.
      const { tools } = await client.listTools();
      const scaffold = tools.find((entry) => entry.name === "mstar_audit")!;
      expect(scaffold.inputSchema.properties).not.toHaveProperty("harness");

      const envelope = await toolEnvelope(client, "mstar_audit", withAction("audit.scaffold", { findings: fixture.findings }));
      expect(envelope).toMatchObject({ status: "ok", code: "audit.scaffold.ok" });
      const report = envelope.data as { outDir: string; file: string };
      expect(report.outDir.startsWith(`${path.join(fixture.harness, "reviews")}${path.sep}`)).toBe(true);
      expect(existsSync(report.file)).toBe(true);
      expect(existsSync(path.join(fixture.launchHarness, "reviews"))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("the persist family always uses the invocation's server root and refuses a per-call harness", async () => {
    const fixture = await competingPersistRoots();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    const previousStore = process.env.MSTAR_STORE_MODULE;
    delete process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_STORE_MODULE;
    process.chdir(fixture.cwd);
    const selected = ["persist.get", "persist.delete"].map((id) => {
      const found = getCommandDefinitions().find((entry) => entry.id === id);
      if (found === undefined) throw new Error(`missing command: ${id}`);
      return found;
    });
    const server = createMcpServer(createContextResolver({ harnessRoot: fixture.pinned }), selected);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      // The root is a server-owned fact, not a client-selectable capability:
      // the family must not publish a `harness` field at all. A tool field that
      // could relocate the store would let a client point the write/delete at
      // another harness's protected documents.
      const { tools } = await client.listTools();
      const persist = tools.find((entry) => entry.name === "mstar_persist")!;
      expect(persist.inputSchema.properties).not.toHaveProperty("harness");
      expect(persist.inputSchema.required ?? []).not.toContain("harness");

      // The connection pin (A) wins over the cwd probe (B), so the read act on
      // the pinned root's document.
      const pinned = await toolEnvelope(client, "mstar_persist", withAction("persist.get", { kind: "review", key: PERSIST_PROBE_KEY }));
      expect(pinned).toMatchObject({ status: "ok" });
      expect(persistOrigin(pinned)).toBe("pinned");

      // A client-supplied root is not a capability: `harness` is not part of
      // this family's contract, so the transport REFUSES the extra field before
      // admission rather than stripping it — the store is never reached, and
      // neither root's document changes.
      const pinnedDocument = path.join(fixture.pinned, "sdd", "_reviews", `${PERSIST_PROBE_KEY}.json`);
      const cwdDocument = path.join(fixture.cwdRoot, "sdd", "_reviews", `${PERSIST_PROBE_KEY}.json`);
      const refused = await toolEnvelope(client, "mstar_persist", withAction("persist.delete", { kind: "review", key: PERSIST_PROBE_KEY, harness: fixture.cwdRoot }));
      expect(refused).toMatchObject({ status: "usage", code: "command.invalid-input" });
      // The aggregated contract: `details.fields` is an array of every rejected
      // key, in the order the caller supplied them.
      expect(refused.details?.fields).toEqual(["harness"]);
      expect(existsSync(pinnedDocument)).toBe(true);
      expect(existsSync(cwdDocument)).toBe(true);
    } finally {
      await client.close();
      await server.close();
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
      if (previousStore === undefined) delete process.env.MSTAR_STORE_MODULE;
      else process.env.MSTAR_STORE_MODULE = previousStore;
    }
  });

  test("a blank harness on a min(1) harness command resolves to the pinned root instead of a usage refusal", async () => {
    const fixture = await competingAuthorityRoots();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    const definition = getCommandDefinitions().find((entry) => entry.id === "status.tech-debt");
    if (definition === undefined) throw new Error("missing command: status.tech-debt");
    const server = createMcpServer(createContextResolver({ harnessRoot: fixture.pinned }), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      // `status.tech-debt` declares its harness as `z.string().min(1)`, so an
      // empty string would be a usage refusal if the pin were only injected
      // after admission. Normalizing blank to the pin before validation makes
      // it read the pinned root (A), whose store holds the fixture's one issue,
      // instead of the uninitialized cwd root (B).
      const envelope = await toolEnvelope(client, "mstar_status", withAction("status.tech-debt", { harness: "" }));
      expect(envelope.code).not.toBe("command.invalid-input");
      expect(envelope).toMatchObject({ status: "ok", code: "status.ok" });
      expect((envelope.data as { total_open: number }).total_open).toBe(1);
    } finally {
      await client.close();
      await server.close();
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("harness.scaffold with no path scaffolds the pinned workspace, not the launch cwd", async () => {
    const fixture = await competingScaffoldWorkspaces();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    const definition = getCommandDefinitions().find((entry) => entry.id === "harness.scaffold");
    if (definition === undefined) throw new Error("missing command: harness.scaffold");
    const server = createMcpServer(createContextResolver({ harnessRoot: fixture.pinnedHarness }), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    const launchGitignoreBefore = readFileSync(fixture.launchGitignore);
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      // `path` is optional, so an omitted value is the implicit-root case: the
      // handler must resolve it from the invocation workspace (the pinned
      // harness's parent), never from the launch process cwd.
      const envelope = await toolEnvelope(client, "mstar_harness", withAction("harness.scaffold"));
      expect(envelope).toMatchObject({ status: "ok", code: "harness.scaffold.ok" });
      const scaffolded = envelope.data as { harnessDir: string; projectDir: string; created: string[] };
      expect(path.resolve(scaffolded.harnessDir)).toBe(path.resolve(fixture.pinnedHarness));
      expect(path.resolve(scaffolded.projectDir)).toBe(path.resolve(fixture.pinnedHarness, "projects"));
      expect(existsSync(path.join(fixture.pinnedHarness, "projects", "_default"))).toBe(true);
      expect(scaffolded.created).toContain(".mstar/AGENTS.md");

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

  test("harness.scaffold targets a pinned custom harness root verbatim, not its parent workspace", async () => {
    const fixture = await customRootScaffoldWorkspace();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    const definition = getCommandDefinitions().find((entry) => entry.id === "harness.scaffold");
    if (definition === undefined) throw new Error("missing command: harness.scaffold");
    const server = createMcpServer(createContextResolver({ harnessRoot: fixture.pinned }), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    const launchGitignoreBefore = readFileSync(fixture.launchGitignore);
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      // The pin IS the harness dir and its basename is not `.mstar`. A handler
      // that re-discovers the root from the invocation workspace (the pin's
      // parent) would scaffold `<workspace>/.mstar` and report success.
      const envelope = await toolEnvelope(client, "mstar_harness", withAction("harness.scaffold"));
      expect(envelope).toMatchObject({ status: "ok", code: "harness.scaffold.ok" });
      const scaffolded = envelope.data as { harnessDir: string; projectDir: string; created: string[]; skipped: string[] };
      expect(path.resolve(scaffolded.harnessDir)).toBe(path.resolve(fixture.pinned));
      expect(path.resolve(scaffolded.projectDir)).toBe(path.resolve(fixture.pinned, "projects"));
      expect(existsSync(path.join(fixture.pinned, "projects", "_default"))).toBe(true);
      expect(scaffolded.created).toContain("control/AGENTS.md");

      // A custom root name takes the custom-layout branch: the parent
      // workspace gets neither a harness dir nor the canonical ignore snippet.
      expect(scaffolded.skipped).toContain(
        ".gitignore (canonical harness snippet) — custom harness layout manages its own ignore rules",
      );
      expect(scaffolded.created.some((entry) => entry.startsWith(".gitignore"))).toBe(false);
      expect(existsSync(path.join(fixture.workspace, ".mstar"))).toBe(false);
      expect(existsSync(fixture.workspaceGitignore)).toBe(false);

      // The launch workspace stays byte-identical.
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

  test("a pinned harness scaffolds its own root instead of an inherited MSTAR_HARNESS_DIR", async () => {
    const fixture = await competingScaffoldWorkspaces();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    // The env rung wins over the workspace default in discovery, so a handler
    // that re-resolves the scaffold target would initialize this dir instead.
    const envHarness = path.join(fixture.launch, "env-harness");
    process.env.MSTAR_HARNESS_DIR = envHarness;
    process.chdir(fixture.launch);
    const definition = getCommandDefinitions().find((entry) => entry.id === "harness.scaffold");
    if (definition === undefined) throw new Error("missing command: harness.scaffold");
    const server = createMcpServer(createContextResolver({ harnessRoot: fixture.pinnedHarness }), [definition]);
    const client = new Client({ name: "harness-root-test-client", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    const launchGitignoreBefore = readFileSync(fixture.launchGitignore);
    try {
      await server.connect(serverEnd);
      await client.connect(clientEnd);

      const envelope = await toolEnvelope(client, "mstar_harness", withAction("harness.scaffold"));
      expect(envelope).toMatchObject({ status: "ok", code: "harness.scaffold.ok" });
      const scaffolded = envelope.data as { harnessDir: string; projectDir: string };
      expect(path.resolve(scaffolded.harnessDir)).toBe(path.resolve(fixture.pinnedHarness));
      expect(existsSync(path.join(fixture.pinnedHarness, "projects", "_default"))).toBe(true);
      // The explicit pin is not re-discovered: the env target never appears.
      expect(existsSync(envHarness)).toBe(false);
      expect(readFileSync(fixture.launchGitignore)).toEqual(launchGitignoreBefore);
      expect(existsSync(path.join(fixture.launchHarness, "projects"))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a relative --harness is a usage refusal naming the absolute requirement", async () => {
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
    expect(String(envelope?.message)).toContain("--harness");
    expect(String(envelope?.message)).toContain("absolute path");
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

      // A truly rootless call (no declared root, no per-call harness) refuses
      // with the cause and every recovery. `sdd.workspace` names no `harness`
      // input, so the refusal comes from the resolver itself.
      const rootless = await callRawTool(createContextResolver(), "sdd.workspace", { planId: "plan-rootless" });
      const text = rawText(rootless);
      expect(rootless.isError).toBe(true);
      expect(text).toContain("mcp.control-root-unresolved");
      expect(text).toContain(realpathSync(fixture.cwd));
      expect(text).toContain("--harness");
      expect(text).toContain("MSTAR_HARNESS_DIR");
      expect(text).toContain("`harness` selector");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an unpinned server resolves the MSTAR_HARNESS_DIR recovery the refusal advertises (F-4)", async () => {
    const fixture = await harnessOutsideCwd();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // A non-blank MSTAR_HARNESS_DIR is a DECLARED root: it pins the whole
      // connection without any call argument, and the invocation workspace is
      // anchored at the root's parent.
      process.env.MSTAR_HARNESS_DIR = fixture.harness;
      const envelope = await callCatalogList(createContextResolver());
      expect(envelope).toMatchObject({ status: "ok", code: "catalog.list.ok" });
      expect((envelope.data as { items: unknown[] }).items).toEqual([]);
      const definition = getCommandDefinitions().find((entry) => entry.id === "catalog.list");
      if (definition === undefined) throw new Error("missing command: catalog.list");
      const context = await createContextResolver()(definition, undefined, new AbortController().signal, [], createMcpEffects([]));
      expect(context.controlRoot).toBe(fixture.harness);
      expect(context.cwd).toBe(path.dirname(fixture.harness));
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
      const result = await callRawTool(createContextResolver(), "sdd.workspace", { planId: "plan-foreign" });
      const text = rawText(result);
      expect(result.isError).toBe(true);
      expect(text).toContain("mcp.control-root-unresolved");
      expect(text).toContain(realpathSync(fixture.cwd));
      expect(text).toContain("--harness");
      expect(text).not.toContain("store.not-initialized");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a connection pin wins over a per-call harness selector", async () => {
    const fixture = await competingCwdHarness();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    try {
      const definition = getCommandDefinitions().find((entry) => entry.id === "worktree.check");
      if (definition === undefined) throw new Error("missing command: worktree.check");
      const other = path.join(path.dirname(fixture.harness), "other-workspace", ".mstar");
      mkdirSync(other, { recursive: true });
      // The order is the fix: a caller-supplied selector is consulted only
      // when the launch declared no root. Testing it first would let a call
      // override the launcher's pin.
      const context = await createContextResolver({ harnessRoot: fixture.harness })(
        definition, undefined, new AbortController().signal, [], createMcpEffects([]), { harness: other },
      );
      expect(context.controlRoot).toBe(fixture.harness);
      expect(context.cwd).toBe(path.dirname(fixture.harness));
      expect(context.harnessPin).toBe(fixture.harness);
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("harness.scaffold still bootstraps a workspace whose cwd probe resolves to no harness", async () => {
    const fixture = await plainForeignCwd();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // A null root is harness.scaffold's premise, not a misresolution: the
      // bootstrap command alone keeps the launch cwd as its workspace so a
      // fresh workspace can establish its own harness through MCP.
      const result = await callRawTool(createContextResolver(), "harness.scaffold", {});
      expect(result.isError).toBe(false);
      const envelope = result.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "ok", code: "harness.scaffold.ok" });
      const scaffolded = envelope.data as { harnessDir: string };
      expect(path.resolve(scaffolded.harnessDir)).toBe(path.join(realpathSync(fixture.cwd), ".mstar"));
      expect(existsSync(scaffolded.harnessDir)).toBe(true);
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });
});

/**
 * Two initialized roots a status read tells apart: the pinned root holds one
 * captured issue, the other holds none. Both are complete stores, so only root
 * SELECTION decides which one answers.
 */
async function competingPinnedRoots(): Promise<{ pinned: string; other: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const pinned = path.join(root, "pinned", ".mstar");
  const other = path.join(root, "other", ".mstar");
  mkdirSync(pinned, { recursive: true });
  mkdirSync(other, { recursive: true });
  (await initializeStore({ harnessDir: pinned })).close();
  (await initializeStore({ harnessDir: other })).close();
  await captureIssue({ harnessDir: pinned }, { ...CAPTURE_INPUT }, { operationId: "mcp-harness-root-pin-vs-call", actor: "project-manager" });
  return { pinned, other };
}

/**
 * A workspace whose harness sits at the MULTI-SEGMENT relative path `x/.mstar`:
 * the selector the cwd-anchoring regression double-joined, because the resolver
 * anchored the invocation workspace at `x` and the handler then resolved
 * `x/.mstar` again against that anchor.
 */
async function relativeRootWorkspace(): Promise<{ base: string; harness: string; selector: string }> {
  const base = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(base);
  const harness = path.join(base, "x", ".mstar");
  mkdirSync(harness, { recursive: true });
  (await initializeStore({ harnessDir: harness })).close();
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
  "issue.occurrence": "root", "issue.reopen": "root", "issue.show": "root",
  "issue.supersede": "root", "issue.triage": "root", "issue.waive": "root",
  "iteration.gate": "root", "iteration.push-cadence": "none", "iteration.register": "root",
  "lint": "none", "migrate": "root", "milestone.add": "root",
  "milestone.assign": "root", "milestone.list": "root", "milestone.status": "root",
  "milestone.update": "root", "path.resolve": "none", "persist.delete": "root",
  "persist.get": "root", "persist.list": "root", "persist.write": "root",
  "plan.bind": "root", "plan.complete": "root", "plan.issue-add": "root",
  "plan.issue-close": "root", "plan.prepare": "root", "plan.progress": "root",
  "plan.show": "root", "plugin.validate": "none", "pr-review.budget": "none",
  "pr-review.post": "none", "pr-review.report-path": "root", "pr-review.seat-prompt": "none",
  "pr-review.size": "none", "pr-review.tally": "none", "pr-review.validate-report": "none",
  "pr-review.worktree-cleanup": "none", "pr-review.worktree-setup": "root", "qc.validate-report": "none",
  "report": "none", "review.seats": "none", "roadmap.export": "root",
  "roadmap.import": "root", "roadmap.replace": "root", "roadmap.show": "root",
  "roles.validate": "none", "schema": "none", "sdd.check-context": "root",
  "sdd.evidence.capture": "root", "sdd.evidence.verify": "root", "sdd.exec": "root",
  "sdd.review-package": "root", "sdd.task-brief": "root", "sdd.workspace": "root",
  "session.recover": "root", "session.run": "root", "skill.lint": "none",
  "status.archive-residuals": "root", "status.backlog-close": "root", "status.backlog-register": "root",
  "status.findings-cleanup": "root", "status.tech-debt": "root", "status.validate": "root",
  "status.workflow-close": "root", "store.activate": "root", "store.backup": "root",
  "store.execution.export": "none", "store.execution.restore": "none", "store.execution.restore-preview": "none",
  "store.init": "root", "store.migrate": "root", "store.retire": "root",
  "store.upgrade": "root", "workflow-note.append": "root", "workflow-note.coverage": "root",
  "workflow.adopt-terminal": "root", "workflow.delivery-anchors": "root", "workflow.evidence": "root",
  "workflow.execution-policy": "root", "workflow.integration-worktree": "root", "workflow.lifecycle": "root",
  "workflow.phase": "root", "workflow.register": "root", "worktree.check": "root",
  "worktree.cleanup": "root", "worktree.qc-alignment": "none",
};

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
      const rooted = await callRawTool(createContextResolver(), "sdd.workspace", { planId: "plan-class" });
      expect(rooted.isError).toBe(true);
      expect(rawText(rooted)).toContain("mcp.control-root-unresolved");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("the refusal names the launcher recoveries as universal and the per-call one as tool-dependent", async () => {
    const fixture = await plainForeignCwd();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      const refused = await callRawTool(createContextResolver(), "sdd.workspace", { planId: "plan-recovery-text" });
      const text = rawText(refused);
      expect(text).toContain("--harness");
      expect(text).toContain("MSTAR_HARNESS_DIR");
      // `sdd.workspace` publishes no `harness` field, so offering the per-call
      // selector as the recovery would offer a call this very command refuses.
      expect(text).toContain("only a command that publishes a `harness` input accepts one");
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a connection pin overwrites a per-call harness on a real tool call", async () => {
    const fixture = await competingPinnedRoots();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    try {
      // `status.tech-debt` resolves its own root from `input.harness`. The call
      // names the OTHER initialized root, which holds no issue, so a handler that
      // trusted the caller's value answers 0. The pin must win at the admitted
      // field, not only at the resolver: the one pinned issue is the answer.
      const result = await callRawTool(createContextResolver({ harnessRoot: fixture.pinned }), "status.tech-debt", { harness: fixture.other });
      expect(result.isError).toBe(false);
      const envelope = result.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "ok", code: "status.ok" });
      expect((envelope.data as { total_open: number }).total_open).toBe(1);

      // The same selector on an unpinned connection DOES root the call: the pin
      // is what overrides, never the field's presence.
      const unpinned = await callRawTool(createContextResolver(), "status.tech-debt", { harness: fixture.other });
      expect((unpinned.structuredContent as CommandEnvelope).data as { total_open: number }).toMatchObject({ total_open: 0 });
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("MSTAR_HARNESS_DIR wins over a per-call harness on one connection", async () => {
    const fixture = await competingPinnedRoots();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    process.env.MSTAR_HARNESS_DIR = fixture.pinned;
    try {
      // Both rungs are declarations; the environment one belongs to the
      // LAUNCHER, so a caller naming another root must not re-root the call —
      // this is the #557 precedence bug in its environment form, and swapping
      // the rungs keeps every other suite green.
      const result = await callRawTool(createContextResolver(), "status.tech-debt", { harness: fixture.other });
      const envelope = result.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "ok", code: "status.ok" });
      expect((envelope.data as { total_open: number }).total_open).toBe(1);
    } finally {
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a relative MSTAR_HARNESS_DIR resolves against the launch directory", async () => {
    const fixture = await relativeRootWorkspace();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.base);
    process.env.MSTAR_HARNESS_DIR = fixture.selector;
    try {
      const definition = getCommandDefinitions().find((entry) => entry.id === "schema")!;
      const context = createContextResolver()(definition, undefined, new AbortController().signal, [], createMcpEffects([])) as { controlRoot: string | null };
      // The environment form has no CLI boundary to refuse a relative value, so
      // it means "relative to the server's launch directory" — resolved once, so
      // the workspace anchor below is absolute too. (`process.cwd()` is the
      // platform realpath, so the expectation is too.)
      expect(context.controlRoot).toBe(realpathSync(fixture.harness));
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("an unpinned connection refuses a root consumer even when the launch cwd owns a harness", async () => {
    const fixture = await competingReviewRoots();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.launch);
    try {
      // `audit.scaffold` publishes no `harness` field and derives `{REVIEW_DIR}`
      // from the invocation workspace: a cwd probe would root it on the LAUNCH
      // workspace's own harness and write a review run there.
      const refused = await callRawTool(createContextResolver(), "audit.scaffold", { findings: fixture.findings });
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

  test("a relative per-call harness resolves once, against the launch directory", async () => {
    const fixture = await relativeRootWorkspace();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.base);
    try {
      const definition = getCommandDefinitions().find((entry) => entry.id === "status.tech-debt")!;
      const context = createContextResolver()(definition, undefined, new AbortController().signal, [], createMcpEffects([]), { harness: fixture.selector }) as {
        controlRoot: string | null;
        cwd: string;
      };
      // The workspace anchor is the root's parent, and the root is absolute: the
      // handler re-resolves the same selector against that anchor, so a relative
      // control root would double-join into `<base>/x/x/.mstar`. (`process.cwd()`
      // is the platform realpath, so the expectation is too.)
      expect(context.controlRoot).toBe(realpathSync(fixture.harness));
      expect(context.cwd).toBe(path.dirname(realpathSync(fixture.harness)));

      const result = await callRawTool(createContextResolver(), "status.tech-debt", { harness: fixture.selector });
      const envelope = result.structuredContent as CommandEnvelope;
      expect(envelope).toMatchObject({ status: "ok", code: "status.ok" });
      expect((envelope.data as { total_open: number }).total_open).toBe(1);
    } finally {
      process.chdir(previousCwd);
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });

  test("a union-input command publishes and admits harness as required when unpinned", async () => {
    const fixture = await competingPinnedRoots();
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
      const named = await toolEnvelope(client, "mstar_issue", withAction("issue.close", { id: "issue-absent", actor: "project-manager", expect: 1, harness: fixture.pinned }));
      expect(named.message ?? "").not.toContain("needs the call's `harness` selector");
      expect((named.details?.diagnostics as Array<{ path?: string }> | undefined ?? []).map((entry) => entry.path)).not.toContain("harness");
    } finally {
      await client.close();
      await server.close();
      if (previousHarness === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarness;
    }
  });
});

/**
 * Two REAL Git main worktrees, each owning its own `.mstar`: the engine verifies
 * the SDD process root through Git, so a control-root regression needs genuine
 * checkouts rather than bare directories.
 */
function twoGitWorkspaces(): { rootA: string; rootB: string; harnessA: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(base);
  const make = (name: string): string => {
    const repo = path.join(base, name);
    mkdirSync(path.join(repo, ".mstar"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    return repo;
  };
  const rootA = make("repo-a");
  const rootB = make("repo-b");
  return { rootA, rootB, harnessA: path.join(rootA, ".mstar") };
}

describe("MCP pinned root selectors and operation targets", () => {
  test("a pinned connection cannot re-root sdd.workspace through controlRoot", async () => {
    const fixture = twoGitWorkspaces();
    // The call names a DIFFERENT real main worktree; the pin must decide. The
    // selector is removed at the seam, so the handler falls back to the pinned
    // harness and writes there.
    const result = await callRawTool(
      createContextResolver({ harnessRoot: fixture.harnessA }),
      "sdd.workspace",
      { planId: "plan-pinned", controlRoot: fixture.rootB },
    );
    expect(result.isError).toBe(false);
    const envelope = result.structuredContent as CommandEnvelope;
    expect(envelope).toMatchObject({ status: "ok", code: "sdd.workspace.ok" });
    const sddDir = (envelope.data as { sddDir: string }).sddDir;
    expect(sddDir).toBe(path.join(realpathSync(fixture.harnessA), "sdd", "plan-pinned"));
    expect(existsSync(sddDir)).toBe(true);
    // The other root received NOTHING: no SDD tree, not even its own harness's.
    expect(existsSync(path.join(fixture.rootB, ".mstar", "sdd", "plan-pinned"))).toBe(false);
    expect(existsSync(path.join(fixture.rootB, ".mstar", "sdd"))).toBe(false);
  });

  test("a pinned connection leaves the store.execution target untouched", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
    roots.push(root);
    const pinned = path.join(root, "control", ".mstar");
    const target = path.join(root, "target", ".mstar");
    mkdirSync(pinned, { recursive: true });
    mkdirSync(target, { recursive: true });
    (await initializeStore({ harnessDir: pinned })).close();
    (await initializeStore({ harnessDir: target })).close();
    // A recovery point must live inside the root it protects.
    const backup = path.join(target, "backups", "target-backup.db");
    mkdirSync(path.dirname(backup), { recursive: true });
    await backupStore({ harnessDir: target }, { out: backup });
    const resolver = createContextResolver({ harnessRoot: pinned });

    // `harness` names the FOREIGN store, not this connection's root: all three
    // actions must reach the target instead of refusing it as the control root.
    const exportOut = path.join(root, "export.json");
    const exported = await callRawTool(resolver, "store.execution.export", { harness: target, out: exportOut });
    expect(exported.isError).toBe(false);
    expect(exported.structuredContent).toMatchObject({ status: "ok", code: "store.execution.export.ok" });
    expect(existsSync(exportOut)).toBe(true);

    const previewOut = path.join(root, "preview.json");
    const preview = await callRawTool(resolver, "store.execution.restore-preview", { harness: target, backup, out: previewOut });
    expect(preview.isError).toBe(false);
    expect(preview.structuredContent).toMatchObject({ status: "ok", code: "store.execution.restore-preview.ok" });
    expect(existsSync(previewOut)).toBe(true);

    const restored = await callRawTool(resolver, "store.execution.restore", {
      harness: target,
      preview: previewOut,
      operator: "ops-engineer",
      authorization: "test-restore-authorization",
    });
    expect(restored.isError).toBe(false);
    expect(restored.structuredContent).toMatchObject({ status: "ok", code: "store.execution.restore.ok" });

    // With NO connection root these actions are still complete: the target is
    // the whole object, so the same export succeeds on an unpinned connection
    // instead of being refused as a root consumer.
    const unpinnedOut = path.join(root, "export-unpinned.json");
    const unpinned = await callRawTool(createContextResolver(), "store.execution.export", { harness: target, out: unpinnedOut });
    expect(unpinned.isError).toBe(false);
    expect(unpinned.structuredContent).toMatchObject({ status: "ok", code: "store.execution.export.ok" });
    expect(existsSync(unpinnedOut)).toBe(true);
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
      expect(text).toContain("--harness");
      expect(text).toContain("MSTAR_HARNESS_DIR");
    } finally {
      process.chdir(previousCwd);
    }
  });
});
