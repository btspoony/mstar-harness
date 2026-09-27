import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginRoot = repoRoot;

test("Codex package emits portable root manifests and the bundled Node server", () => {
  const pluginConfig = JSON.parse(readFileSync(path.join(repoRoot, "mcp/codex-plugin.json"), "utf8"));
  assert.equal(pluginConfig.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(pluginConfig.name, "morning-star-harness");

  const mcpConfig = JSON.parse(readFileSync(path.join(repoRoot, "mcp/codex.json"), "utf8"));
  assert.equal(mcpConfig.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(mcpConfig.mcpServers["morning-star"], {
    type: "stdio",
    command: "node",
    args: ["${PLUGIN_ROOT}/mcp/bundles/codex/dist/mcp/stdio.js"],
  });
  const compatibilityManifest = JSON.parse(readFileSync(path.join(repoRoot, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(compatibilityManifest.mcpServers, "./mcp/codex.json");


  const build = spawnSync(process.execPath, [path.join(repoRoot, "scripts/build-mcp-plugins.ts"), "--target", "codex"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `Codex package build failed: ${build.stderr}`);

  assert.deepEqual(JSON.parse(readFileSync(path.join(pluginRoot, "mcp/codex.json"), "utf8")), mcpConfig);
  assert.ok(existsSync(path.join(pluginRoot, "mcp/bundles/codex/dist/mcp/stdio.js")), "Codex package must contain its stdio bundle");
  const buildInfo = JSON.parse(readFileSync(path.join(pluginRoot, "mcp/bundles/codex/dist/mcp/build-info.json"), "utf8")) as { hostTarget?: string };
  assert.equal(buildInfo.hostTarget, "codex");

  const runtime = JSON.parse(readFileSync(path.join(repoRoot, "packages/mcp/package.json"), "utf8")) as { engines: { node: string } };
  assert.equal(runtime.engines.node, ">=24.18.0");
});
