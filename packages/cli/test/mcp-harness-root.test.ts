import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { captureIssue, initializeStore } from "@mstar-harness/engine";
import { getCommandDefinitions, type CommandEnvelope } from "@mstar-harness/commands";
import { mapParserError } from "../src/command-adapter";
import { registerMcpCommand } from "../src/mcp/command";
import { registerMcpCommands, type ResolveContext } from "../src/mcp/register";
import { createMcpServer } from "../src/mcp/server";
import { createContextResolver } from "../src/mcp/stdio";

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
      name: "mstar_worktree_check",
      arguments: { workflow: "wf-absent", plan: "p-absent" },
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
    const result = await client.callTool({ name: "mstar_catalog_list", arguments: {} });
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

/**
 * A linked-checkout cwd whose main worktree cannot be read: the `.git` file
 * points at a gitdir that does not exist, so the process-root probe refuses
 * (`coordination.not-in-git`) instead of answering a root.
 */
async function linkedForeignCwd(): Promise<{ cwd: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-harness-root-"));
  roots.push(root);
  const cwd = path.join(root, "linked");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, ".git"), `gitdir: ${path.join(root, "absent")}\n`, "utf8");
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
    return await client.callTool({ name: `mstar_${id.replace(/[.-]/g, "_")}`, arguments: args });
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

      // Without the flag the same cwd resolves no harness root at all, so the
      // resolver refuses with a named cause instead of silently using the
      // fixture harness (#533) — the refusal never names the fixture root.
      const probed = await callRawTool(createContextResolver(), "worktree.check", { workflow: "wf-absent", plan: "p-absent" });
      const probedText = rawText(probed);
      expect(probed.isError).toBe(true);
      expect(probedText).toContain("mcp.control-root-unresolved");
      expect(probedText).not.toContain(fixture.harness);
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
      // that field. The cwd has its own harness directory but no store, so a
      // cwd-probed read refuses instead.
      const pinned = await callCatalogList(createContextResolver({ harnessRoot: fixture.harness }));
      expect(pinned).toMatchObject({ status: "ok", code: "catalog.list.ok" });
      expect((pinned.data as { items: unknown[] }).items).toEqual([]);

      const probed = await callCatalogList(createContextResolver());
      expect(probed).toMatchObject({ status: "refused", code: "store.not-initialized" });
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
      const scaffold = tools.find((entry) => entry.name === "mstar_audit_scaffold")!;
      expect(scaffold.inputSchema.properties).not.toHaveProperty("harness");

      const envelope = await toolEnvelope(client, "mstar_audit_scaffold", { findings: fixture.findings });
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

  test("the persist family always uses the invocation's server root and publishes no per-call harness", async () => {
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
      const persist = tools.find((entry) => entry.name === "mstar_persist_get")!;
      expect(persist.inputSchema.properties).not.toHaveProperty("harness");
      expect(persist.inputSchema.required ?? []).not.toContain("harness");

      // The connection pin (A) wins over the cwd probe (B), so the read act on
      // the pinned root's document.
      const pinned = await toolEnvelope(client, "mstar_persist_get", { kind: "review", key: PERSIST_PROBE_KEY });
      expect(pinned).toMatchObject({ status: "ok" });
      expect(persistOrigin(pinned)).toBe("pinned");

      // A client-supplied root is not a capability: an extra `harness` field is
      // not part of the contract and the server root still decides. The delete
      // removes the pinned root's document and leaves the cwd's untouched.
      const pinnedDocument = path.join(fixture.pinned, "sdd", "_reviews", `${PERSIST_PROBE_KEY}.json`);
      const cwdDocument = path.join(fixture.cwdRoot, "sdd", "_reviews", `${PERSIST_PROBE_KEY}.json`);
      const deleted = await toolEnvelope(client, "mstar_persist_delete", { kind: "review", key: PERSIST_PROBE_KEY, harness: fixture.cwdRoot });
      expect(deleted).toMatchObject({ status: "ok", data: { deleted: true } });
      expect(existsSync(pinnedDocument)).toBe(false);
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
      const envelope = await toolEnvelope(client, "mstar_status_tech_debt", { harness: "" });
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
      const envelope = await toolEnvelope(client, "mstar_harness_scaffold", {});
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
      const envelope = await toolEnvelope(client, "mstar_harness_scaffold", {});
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

      const envelope = await toolEnvelope(client, "mstar_harness_scaffold", {});
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

      // A truly rootless call (no launch root, no per-call harness) still
      // refuses with the cause and the recovery.
      const rootless = await callRawTool(createContextResolver(), "catalog.list", {});
      const text = rawText(rootless);
      expect(rootless.isError).toBe(true);
      expect(text).toContain("mcp.control-root-unresolved");
      expect(text).toContain(realpathSync(fixture.cwd));
      expect(text).toContain("--harness");
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
      // The env pin the refusal names is real: the unpinned probe runs through
      // the engine's own resolution (resolveProcessHarnessDir →
      // resolveHarnessDir), which reads MSTAR_HARNESS_DIR before any cwd walk,
      // so a server env carrying the variable pins the root.
      process.env.MSTAR_HARNESS_DIR = fixture.harness;
      const envelope = await callCatalogList(createContextResolver());
      expect(envelope).toMatchObject({ status: "ok", code: "catalog.list.ok" });
      expect((envelope.data as { items: unknown[] }).items).toEqual([]);
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
      // The launch cwd resolves to no harness root, so the server cannot know
      // which workspace a caller belongs to (#533): the resolver must refuse
      // with the cause and the recovery instead of letting a command present
      // the launch cwd as the caller's control root.
      const result = await callRawTool(createContextResolver(), "catalog.list");
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

  test("an unpinned server over a linked checkout with an unreadable main worktree refuses with a named cause", async () => {
    const fixture = await linkedForeignCwd();
    const previousCwd = process.cwd();
    const previousHarness = process.env.MSTAR_HARNESS_DIR;
    delete process.env.MSTAR_HARNESS_DIR;
    process.chdir(fixture.cwd);
    try {
      // The probe refuses (coordination.not-in-git); the resolver surfaces
      // that cause with its recovery instead of throwing a bare engine error
      // or probing onward into an unrelated root.
      const result = await callRawTool(createContextResolver(), "catalog.list");
      const text = rawText(result);
      expect(result.isError).toBe(true);
      expect(text).toContain("mcp.control-root-unresolved");
      expect(text).toContain("linked checkout");
      expect(text).toContain("--harness");
      expect(text).not.toContain("store.not-initialized");
    } finally {
      process.chdir(previousCwd);
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
      // bootstrap command keeps the cwd fallback so a fresh workspace can
      // establish its own harness through MCP.
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
