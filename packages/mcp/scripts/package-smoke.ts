#!/usr/bin/env bun
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  const executable = path.join(unpackedOutput, "stdio.js");
  const foreignCwd = mkdtempSync(path.join(os.tmpdir(), "mcp-foreign-cwd-"));
  const child = spawn(process.execPath, [executable], { cwd: foreignCwd, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const responses = new Map<number, (message: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = message.id;
    if (typeof id === "number") responses.get(id)?.(message);
  });
  const response = (id: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for MCP response ${id}; stderr: ${stderr}`)), 10_000);
    responses.set(id, (message) => { clearTimeout(timeout); resolve(message); });
  });

  try {
    const initialized = response(1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } } })}\n`);
    assert.ok((await initialized).result, "bundled server must initialize from a foreign cwd");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = response(2);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const result = await listed;
    assert.ok(result.result, "bundled server must serve MCP requests");
    child.stdin.end();
    console.log(`package-smoke: ${target} isolated bundle launched from foreign cwd; initialize and tools/list succeeded`);
  } finally {
    lines.close();
    child.kill();
    rmSync(foreignCwd, { recursive: true, force: true });
    rmSync(unpackedRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`package-smoke: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
