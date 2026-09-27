import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginRoot = path.join(repoRoot, "packages/mcp/dist/plugins/zcode");

// Supported loader pin: ZCode 3.10.2, official https://zcode.net.cn/en/docs/plugin
// and https://zcode.net.cn/en/docs/mcp-services (docs sitemap last-modified 2026-09-03).
// The MCP config documents ${ZCODE_PLUGIN_ROOT} as a plugin-root variable, not merely a hook variable.
test("ZCode package emits the plugin-root MCP config used by its plugin manifest", () => {
  const config = JSON.parse(readFileSync(path.join(repoRoot, "mcp/zcode.json"), "utf8"));
  assert.deepEqual(config.mcpServers["morning-star"], {
    type: "stdio",
    command: "node",
    args: ["${ZCODE_PLUGIN_ROOT}/dist/mcp/stdio.js"],
  });

  const manifest = JSON.parse(readFileSync(path.join(repoRoot, ".zcode-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.mcpServers, "./mcp/zcode.json");

  const build = spawnSync(process.execPath, [path.join(repoRoot, "scripts/build-mcp-plugins.ts"), "--target", "zcode"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `ZCode package build failed: ${build.stderr}`);

  assert.deepEqual(JSON.parse(readFileSync(path.join(pluginRoot, "mcp/zcode.json"), "utf8")), config);
  assert.ok(existsSync(path.join(pluginRoot, "dist/mcp/stdio.js")), "ZCode package must contain its stdio bundle");
  const buildInfo = JSON.parse(readFileSync(path.join(pluginRoot, "dist/mcp/build-info.json"), "utf8")) as { hostTarget?: string };
  assert.equal(buildInfo.hostTarget, "zcode");

  const runtime = JSON.parse(readFileSync(path.join(repoRoot, "packages/mcp/package.json"), "utf8")) as { engines: { node: string } };
  assert.equal(runtime.engines.node, ">=24.18.0");
});
