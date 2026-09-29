import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

const root = mkdtempSync(path.join(os.tmpdir(), "recovery-transport-smoke-"));
const cli = path.resolve("packages/cli/dist/mstar-harness.js");
const node = process.execPath;
const env = { ...process.env, MSTAR_HARNESS_DIR: root, MSTAR_CLI_PROJECT_ROOT: root, MSTAR_HOST_SESSION_ID: "smoke-session" };
const sessionRef = `exec-session-v1:${Buffer.from(JSON.stringify({ epoch: 1, planId: null, role: "coordinator", sessionId: "smoke-session", storeId: "smoke-store", workflowId: "smoke-workflow" }) + "\n").toString("base64url")}`;
type Envelope = { status: string; code: string; command?: string; message?: string; data?: unknown };
type Scenario = { name: string; id: string; argv: string[]; input: Record<string, unknown> };

const scenarios: Scenario[] = [
  { name: "sparse amendment", id: "workflow.amend-prepare", argv: ["workflow", "amend-prepare", "--session", path.join(root, "missing-session.json"), "--expect-snapshot", "missing-snapshot-token", "--expect-compass", "missing-compass-token", "--input", "{}"], input: { session: path.join(root, "missing-session.json"), expectSnapshot: "missing-snapshot-token", expectCompass: "missing-compass-token", input: "{}" } },
  { name: "report-close", id: "status.workflow-close", argv: ["status", "workflow-close", "--workflow", "smoke-workflow", "--harness", root], input: { workflow: "smoke-workflow", harness: root } },
  { name: "failed lifecycle", id: "workflow.lifecycle", argv: ["workflow", "lifecycle", "--workflow", "smoke-workflow", "--session-ref", sessionRef, "--expect", "stale-token", "--operation", "failed-smoke", "--status", "failed", "--reason", "smoke failure", "--harness", root, "--session-id", "smoke-session"], input: { workflow: "smoke-workflow", sessionRef, expect: "stale-token", operation: "failed-smoke", status: "failed", reason: "smoke failure", harness: root } },
  { name: "stopped lifecycle", id: "workflow.lifecycle", argv: ["workflow", "lifecycle", "--workflow", "smoke-workflow", "--session-ref", sessionRef, "--expect", "stale-token", "--operation", "stopped-smoke", "--status", "stopped", "--reason", "smoke stop", "--harness", root, "--session-id", "smoke-session"], input: { workflow: "smoke-workflow", sessionRef, expect: "stale-token", operation: "stopped-smoke", status: "stopped", reason: "smoke stop", harness: root } },
  { name: "issue add payload", id: "issue.add", argv: ["issue", "add", "--operation-id", "issue-smoke", "--actor", "project-manager", "--payload", "{}", "--harness", root], input: { operationId: "issue-smoke", actor: "project-manager", payload: {}, harness: root } },
  { name: "persist snapshot payload", id: "persist.write", argv: ["persist", "write", "snapshot", "--key", "snapshot", "--input", "{}"], input: { kind: "snapshot", key: "snapshot", input: "{}" } },
  { name: "judgment review-advice payload", id: "judgment.review-advice", argv: ["judgment", "review-advice", "--file", path.join(root, "missing-pack.json"), "--pilot", path.join(root, "missing-pilot.json")], input: { file: path.join(root, "missing-pack.json"), pilot: path.join(root, "missing-pilot.json") } },
  { name: "catalog register payload", id: "catalog.register", argv: ["catalog", "register", "--kind", "plan", "--file", path.join(root, "missing-plan.md"), "--harness", root], input: { kind: "plan", file: path.join(root, "missing-plan.md"), harness: root } },
  { name: "roadmap replace payload", id: "roadmap.replace", argv: ["roadmap", "replace", "--project", "smoke-project", "--file", path.join(root, "missing-roadmap.md"), "--operation", "roadmap-smoke", "--harness", root], input: { project: "smoke-project", file: path.join(root, "missing-roadmap.md"), operation: "roadmap-smoke", harness: root } },
  { name: "dashboard service", id: "dashboard", argv: ["dashboard", "--port", "0"], input: { port: 0 } },
  { name: "SDD context", id: "sdd.check-context", argv: ["sdd", "check-context", "--context", path.join(root, "missing-context.json"), "--kind", "artifact"], input: { context: path.join(root, "missing-context.json"), kind: "artifact" } },
  { name: "store maintenance", id: "store.backup", argv: ["store", "backup", "--harness", root], input: { harness: root } },
  { name: "local path", id: "path.resolve", argv: ["path", "resolve", root], input: { path: root } },
  { name: "report input", id: "report", argv: ["report", "--arguments", "[]"], input: { arguments: "[]" } },
];

async function cliCall(scenario: Scenario): Promise<Envelope> {
  const value = scenario.id === "dashboard"
    ? await cliServiceCall(scenario)
    : runCliOnce(scenario);
  if (value === null || typeof value !== "object" || typeof (value as Envelope).status !== "string" || typeof (value as Envelope).code !== "string") {
    throw new Error(`${scenario.name}: malformed CLI outcome: ${JSON.stringify(value)}`);
  }
  return value as Envelope;
}

function runCliOnce(scenario: Scenario): unknown {
  const result = spawnSync(node, [cli, ...scenario.argv], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`${scenario.name}: CLI timed out or was signalled: ${result.stderr}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${scenario.name}: CLI did not return a JSON envelope (exit ${result.status}): ${result.stdout}\n${result.stderr}`); }
}

function cliServiceCall(scenario: Scenario): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const child = spawn(node, [cli, ...scenario.argv], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${scenario.name}: CLI service did not return an envelope`)); }, 15_000);
  lines.once("line", (line) => {
    clearTimeout(timer);
    try { resolve(JSON.parse(line) as unknown); }
    catch (error) { reject(error); }
    child.kill("SIGTERM");
    lines.close();
  });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.stderr.on("data", () => {});
  return promise;
}


class McpPeer {
  private nextId = 1;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();

  constructor() {
    this.child = spawn(node, [cli, "mcp"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { return; }
      if (typeof message.id === "number") this.pending.get(message.id)?.(message);
    });
    this.child.stderr.on("data", () => {});
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 10_000);
      this.pending.set(id, (value) => { clearTimeout(timer); this.pending.delete(id); resolve(value); });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async start(): Promise<Set<string>> {
    const initialized = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "recovery-transport-smoke", version: "1" },
    });
    if (initialized.error !== undefined) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)}`);
    this.notify("notifications/initialized");
    const listed = await this.request("tools/list", {});
    if (listed.error !== undefined) throw new Error(`MCP tools/list failed: ${JSON.stringify(listed.error)}`);
    const result = listed.result as { tools?: Array<{ name?: unknown }> } | undefined;
    const names = new Set((result?.tools ?? []).flatMap((tool) => typeof tool.name === "string" ? [tool.name] : []));
    return names;
  }

  async call(scenario: Scenario): Promise<Envelope> {
    const response = await this.request("tools/call", {
      name: `mstar_${scenario.id.replace(/[.-]/g, "_")}`,
      arguments: scenario.input,
    });
    if (response.error !== undefined) throw new Error(`${scenario.name}: MCP tools/call protocol error ${JSON.stringify(response.error)}`);
    const result = response.result as { structuredContent?: unknown; isError?: unknown } | undefined;
    const envelope = result?.structuredContent;
    if (envelope === null || typeof envelope !== "object" || typeof (envelope as Envelope).status !== "string" || typeof (envelope as Envelope).code !== "string") {
      throw new Error(`${scenario.name}: MCP returned no structured command envelope: ${JSON.stringify(result)}`);
    }
    return envelope as Envelope;
  }

  async close(): Promise<void> {
    try { await this.request("shutdown", {}); } catch {}
    this.notify("exit");
    this.child.stdin.end();
    this.lines.close();
    const { promise, resolve } = Promise.withResolvers<void>();
    if (this.child.exitCode !== null) resolve();
    else this.child.once("exit", () => resolve());
    setTimeout(() => { this.child.kill("SIGTERM"); resolve(); }, 2_000).unref();
    await promise;
  }
}

try {
  const cliResults = await Promise.all(scenarios.map(async (scenario) => ({ scenario, result: await cliCall(scenario) })));
  const peer = new McpPeer();
  try {
    const tools = await peer.start();
    for (const { scenario } of cliResults) {
      const name = `mstar_${scenario.id.replace(/[.-]/g, "_")}`;
      if (!tools.has(name)) throw new Error(`MCP registry missing ${name}`);
    }
    const mcpResults: Array<{ name: string; result: Envelope }> = [];
    for (const { scenario } of cliResults) mcpResults.push({ name: scenario.name, result: await peer.call(scenario) });
    for (let index = 0; index < cliResults.length; index++) {
      const { scenario, result: cliResult } = cliResults[index]!;
      const mcpResult = mcpResults[index]!.result;
      if (cliResult.status !== mcpResult.status || cliResult.code !== mcpResult.code) {
        throw new Error(`${scenario.name}: CLI/MCP outcome mismatch: CLI ${cliResult.status}/${cliResult.code}, MCP ${mcpResult.status}/${mcpResult.code}`);
      }
      console.log(`${scenario.name}: ${cliResult.status}/${cliResult.code} — CLI/MCP parity`);
    }
  } finally {
    await peer.close();
  }
  console.log(`PASS: ${scenarios.length} CLI/MCP scenarios; MCP tools listed; isolated root ${root}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
