import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginRoot = repoRoot;

test("Cursor plugin points to its packaged MCP config and bundled Node server", () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, ".cursor-plugin/plugin.json"), "utf8")) as {
    mcpServers?: unknown;
  };
  assert.equal(manifest.mcpServers, "mcp/cursor.json");

  const sourceConfig = JSON.parse(readFileSync(path.join(repoRoot, "mcp/cursor.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.deepEqual(sourceConfig.mcpServers["morning-star"], {
    command: "node",
    args: ["${CURSOR_PLUGIN_ROOT}/mcp/bundles/cursor/dist/mcp/stdio.js"],
  });

  const build = spawnSync(process.execPath, [path.join(repoRoot, "scripts/build-mcp-plugins.ts"), "--target", "cursor"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `Cursor package build failed: ${build.stderr}`);

  const packagedConfig = JSON.parse(readFileSync(path.join(pluginRoot, "mcp/cursor.json"), "utf8"));
  assert.deepEqual(packagedConfig, sourceConfig, "Cursor plugin config must match its committed manifest path");
  assert.ok(existsSync(path.join(pluginRoot, "mcp/bundles/cursor/dist/mcp/stdio.js")), "Cursor package must contain its stdio bundle");
  const buildInfo = JSON.parse(readFileSync(path.join(pluginRoot, "mcp/bundles/cursor/dist/mcp/build-info.json"), "utf8")) as { hostTarget?: string };
  assert.equal(buildInfo.hostTarget, "cursor");

  const runtimeFloor = JSON.parse(readFileSync(path.join(repoRoot, "packages/mcp/package.json"), "utf8")) as {
    engines: { node: string };
  };
  assert.equal(runtimeFloor.engines.node, ">=24.18.0");
});
