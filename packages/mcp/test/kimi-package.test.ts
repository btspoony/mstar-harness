import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginRoot = path.join(repoRoot, "packages/mcp/dist/plugins/kimi");

// Supported loader pin: kimi-code 0.41.0, MoonshotAI/kimi-code docs/en/customization/plugins.md
// at @moonshot-ai/kimi-code@0.41.0, "MCP Servers in Plugins". MCP accepts plugin-root ./ paths
// for command/cwd; KIMI_PLUGIN_ROOT is documented for hooks, not MCP.
test("Kimi package emits a plugin-local launcher and server config", () => {
  const config = JSON.parse(readFileSync(path.join(repoRoot, "mcp/kimi.json"), "utf8"));
  assert.deepEqual(config.mcpServers["morning-star"], {
    command: "./mcp/kimi-launcher.mjs",
    args: [],
    cwd: "./",
  });

  const manifest = JSON.parse(readFileSync(path.join(repoRoot, ".kimi-plugin/plugin.json"), "utf8"));
  assert.deepEqual(manifest.mcpServers, config.mcpServers);
  assert.equal(manifest.commands, "./commands/");

  const build = spawnSync(process.execPath, [path.join(repoRoot, "scripts/build-mcp-plugins.ts"), "--target", "kimi"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `Kimi package build failed: ${build.stderr}`);

  assert.deepEqual(JSON.parse(readFileSync(path.join(pluginRoot, "mcp/kimi.json"), "utf8")), config);
  assert.ok(existsSync(path.join(pluginRoot, "mcp/kimi-launcher.mjs")), "Kimi package must include its module-relative launcher");
  assert.ok(existsSync(path.join(pluginRoot, "dist/mcp/stdio.js")), "Kimi package must contain its stdio bundle");
  const buildInfo = JSON.parse(readFileSync(path.join(pluginRoot, "dist/mcp/build-info.json"), "utf8")) as { hostTarget?: string };
  assert.equal(buildInfo.hostTarget, "kimi");

  const runtime = JSON.parse(readFileSync(path.join(repoRoot, "packages/mcp/package.json"), "utf8")) as { engines: { node: string } };
  assert.equal(runtime.engines.node, ">=24.18.0");
});
