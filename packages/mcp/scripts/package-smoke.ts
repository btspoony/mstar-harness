#!/usr/bin/env bun
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExecutionWorkflow,
  executionContextFor,
  initializeExecutionAuthority,
  initializeStore,
} from "@mstar-harness/engine";
import { z } from "zod";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const targets = ["omp", "opencode", "dsh", "cursor", "codex", "kimi", "zcode"] as const;
type Target = (typeof targets)[number];



function packageRoot(target: Target): string {
  return target === "omp" || target === "opencode" || target === "dsh"
    ? path.join(repoRoot, "packages", target)
    : path.join(repoRoot, "packages", "mcp", "dist", "plugins", target);
}

function parseTarget(argv: string[]): Target {
  if (argv.length !== 2 || argv[0] !== "--target" || !targets.includes(argv[1] as Target)) {
    throw new Error(`usage: bun packages/mcp/scripts/package-smoke.ts --target <${targets.join("|")}>`);
  }
  return argv[1] as Target;
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const build = spawnSync(process.execPath, [path.join(repoRoot, "scripts/build-mcp-plugins.ts"), "--target", target], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `package build failed: ${build.stderr}`);
  const root = packageRoot(target);
  const outputDir = target === "omp" || target === "opencode" || target === "dsh"
    ? path.join(root, "mcp")
    : path.join(root, "dist/mcp");
  const packagedBundle = path.join(outputDir, "stdio.js");
  const infoPath = path.join(outputDir, "build-info.json");
  const info = JSON.parse(readFileSync(infoPath, "utf8")) as { hostTarget?: string };
  assert.equal(info.hostTarget, target, "build metadata must identify its target");

  const unpackedRoot = mkdtempSync(path.join(os.tmpdir(), "mcp-unpacked-package-"));
  const unpackedOutput = path.join(unpackedRoot, "dist/mcp");
  mkdirSync(unpackedOutput, { recursive: true });
  cpSync(packagedBundle, path.join(unpackedOutput, "stdio.js"));
  cpSync(infoPath, path.join(unpackedOutput, "build-info.json"));
  let command = process.execPath;
  let args = [path.join(unpackedOutput, "stdio.js")];
  let childEnv: NodeJS.ProcessEnv = process.env;
  let fixtureRoot: string | undefined;
  let workflowToken = "";
  const workflowId = `${target}-package-smoke`;
  const planId = `${target}-package-smoke-plan`;
  if (target === "cursor" || target === "codex" || target === "kimi" || target === "zcode") {
    const configPath = target === "cursor"
      ? path.join(root, "mcp/cursor.json")
      : target === "codex" ? path.join(root, "mcp.json")
        : path.join(root, "mcp", `${target}.json`);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string }>;
    };
    const serverConfig = config.mcpServers["morning-star"];
    assert.ok(serverConfig, `${target} MCP config must declare morning-star`);
    const unpackedConfigDir = path.join(unpackedRoot, "mcp");
    mkdirSync(unpackedConfigDir, { recursive: true });
    if (target === "cursor") {
      cpSync(configPath, path.join(unpackedConfigDir, "cursor.json"));
      args = serverConfig.args.map((argument) => argument.replaceAll("${CURSOR_PLUGIN_ROOT}", unpackedRoot));
      command = serverConfig.command;
    } else if (target === "codex") {
      cpSync(path.join(root, "plugin.json"), path.join(unpackedRoot, "plugin.json"));
      cpSync(configPath, path.join(unpackedRoot, "mcp.json"));
      args = serverConfig.args.map((argument) => argument.replaceAll("${PLUGIN_ROOT}", unpackedRoot));
      command = serverConfig.command;
    } else if (target === "kimi") {
      assert.equal(serverConfig.cwd, "./", "Kimi must start the server from inside the plugin root");
      cpSync(configPath, path.join(unpackedConfigDir, "kimi.json"));
      cpSync(path.join(root, "mcp/kimi-launcher.mjs"), path.join(unpackedConfigDir, "kimi-launcher.mjs"));
      command = path.resolve(unpackedRoot, serverConfig.command);
      args = serverConfig.args;
    } else {
      cpSync(configPath, path.join(unpackedConfigDir, "zcode.json"));
      args = serverConfig.args.map((argument) => argument.replaceAll("${ZCODE_PLUGIN_ROOT}", unpackedRoot));
      command = serverConfig.command;
    }
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), `${target}-mcp-fixture-`));
    const harnessDir = path.join(fixtureRoot, ".mstar");
    const statusPath = path.join(fixtureRoot, "status-fixture.json");
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(statusPath, JSON.stringify({ version: 2, updated_at: "1970-01-01", workflows: [] }));
    const storeContext = { harnessDir: fixtureRoot };
    const previousHarnessDir = process.env.MSTAR_HARNESS_DIR;
    process.env.MSTAR_HARNESS_DIR = harnessDir;
    try {
      (await initializeStore(storeContext)).close();
      const initializedAuthority = await initializeExecutionAuthority(storeContext);
      const created = await createExecutionWorkflow(executionContextFor(storeContext, {
        source: "local",
        sessionId: `${target}-smoke-session`,
        workflowId,
        role: "coordinator",
        planId: null,
      }), {
        entry: { id: workflowId, type: "iteration", status: "running", started_at: "2026-09-27T00:00:00Z", dir: `workflows/${workflowId}` } as never,
        snapshot: {
          schema_version: 1,
          id: workflowId,
          type: "iteration",
          status: "running",
          started_at: "2026-09-27T00:00:00Z",
          updated_at: "2026-09-27T00:00:00Z",
          branch: { base: "main" },
          plans: [{ id: planId, plan_id: planId, title: `${target} package smoke fixture`, file: `.mstar/plans/${planId}.md`, status: "Todo", metadata: { project_id: "_default" } }],
        } as never,
        expected: initializedAuthority.token,
        operationId: `create-${target}-package-smoke`,
      });
      workflowToken = z.object({
        workflows: z.array(z.object({ workflowToken: z.string() })).min(1),
      }).parse(created.data).workflows[0]!.workflowToken;
    } finally {
      if (previousHarnessDir === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = previousHarnessDir;
    }
    childEnv = { ...process.env, MSTAR_HARNESS_DIR: harnessDir };
  }
  const foreignCwd = mkdtempSync(path.join(os.tmpdir(), "mcp-foreign-cwd-"));
  const child = spawn(command, args, { cwd: foreignCwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const responses = new Map<number, (message: unknown) => void>();
  lines.on("line", (line) => {
    const parsed = z.object({ id: z.number() }).passthrough().safeParse(JSON.parse(line));
    if (parsed.success) responses.get(parsed.data.id)?.(parsed.data);
  });
  const response = (id: number) => new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for MCP response ${id}; stderr: ${stderr}`)), 10_000);
    responses.set(id, (message) => { clearTimeout(timeout); resolve(message); });
  });
  const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
    const pending = response(id);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    const message = z.object({
      result: z.object({
        structuredContent: z.record(z.string(), z.unknown()),
        isError: z.boolean().optional(),
      }),
    }).parse(await pending);
    return { envelope: message.result.structuredContent, isError: message.result.isError === true };
  };

  try {
    const initialized = response(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } } })}\n`);
    const initializedResult = z.object({ result: z.unknown() }).parse(await initialized).result;
    assert.ok(initializedResult, "bundled server must initialize from a foreign cwd");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = response(2);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const result = await listed;
    const toolList = z.object({
      result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
    }).parse(result).result.tools;
    assert.ok(toolList.some((tool) => tool.name === "mstar_status_validate"), "generated read command must be listed");
    if (target === "cursor" || target === "codex" || target === "kimi" || target === "zcode") {
      assert.ok(fixtureRoot, `${target} smoke requires its isolated fixture root`);
      const pathRead = await callTool(3, "mstar_status_validate", {
        path: path.join(fixtureRoot, "status-fixture.json"),
      });
      assert.equal(pathRead.envelope.status, "ok", JSON.stringify(pathRead.envelope));
      assert.equal(pathRead.isError, false);

      const bindArgs = {
        execution: true,
        coordinator: true,
        workflow: workflowId,
        harness: path.join(fixtureRoot, ".mstar"),
        expect: workflowToken,
        operation: "bind-main-session",
        sessionId: `${target}-smoke-session`,
      };
      const mutation = await callTool(4, "mstar_plan_bind", bindArgs);
      assert.equal(mutation.envelope.status, "ok", JSON.stringify(mutation.envelope));
      assert.equal(mutation.isError, false);

      const refusal = await callTool(5, "mstar_plan_bind", { ...bindArgs, operation: "bind-child-session", sessionId: "child-agent-session" });
      assert.equal(refusal.envelope.status, "refused", JSON.stringify(refusal.envelope));
      assert.equal(refusal.envelope.code, "execution.stale-token", JSON.stringify(refusal.envelope));
      assert.equal(refusal.isError, true, "shared-handler refusal must be reported as an MCP tool error");
    }
    child.stdin.end();
    if (target === "zcode") {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`ZCode MCP process did not stop after transport close; stderr: ${stderr}`)), 10_000);
        child.once("close", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      assert.equal(exitCode, 0, `ZCode MCP process should exit cleanly after transport close; stderr: ${stderr}`);
    }
    console.log(target === "cursor" || target === "codex" || target === "kimi" || target === "zcode"
      ? `package-smoke: ${target} package config launched from foreign cwd; generated status.validate and plan.bind success/refusal verified${target === "zcode" ? " and transport-close teardown completed" : ""}`
      : `package-smoke: ${target} isolated bundle launched from foreign cwd; initialize and tools/list succeeded`);
  } finally {
    lines.close();
    child.kill();
    rmSync(foreignCwd, { recursive: true, force: true });
    rmSync(unpackedRoot, { recursive: true, force: true });
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`package-smoke: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
