import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const targets = ["omp", "opencode", "dsh", "cursor", "codex", "kimi", "zcode"] as const;

test("seven packaged targets contain the same self-contained server and target metadata", () => {
  const buildScript = path.join(repoRoot, "scripts/build-mcp-plugins.ts");
  const versions = {
    pluginVersion: JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version,
    engineVersion: JSON.parse(readFileSync(path.join(repoRoot, "packages/engine/package.json"), "utf8")).version,
    mcpVersion: JSON.parse(readFileSync(path.join(repoRoot, "packages/mcp/package.json"), "utf8")).version,
  };
  const bundles: string[] = [];

  for (const target of targets) {
    const build = spawnSync(process.execPath, [buildScript, "--target", target], {
      cwd: os.tmpdir(),
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${target} package build failed: ${build.stderr}`);

    const root = target === "omp" || target === "opencode" || target === "dsh"
      ? path.join(repoRoot, "packages", target)
      : path.join(repoRoot, "packages/mcp/dist/plugins", target);
    const outputDir = target === "omp" || target === "opencode" || target === "dsh"
      ? path.join(root, "mcp")
      : path.join(root, "dist/mcp");
    const bundle = readFileSync(path.join(outputDir, "stdio.js"), "utf8");
    const info = JSON.parse(readFileSync(path.join(outputDir, "build-info.json"), "utf8")) as Record<string, unknown>;

    assert.ok(bundle.length > 0, `${target} executable is present`);
    assert.doesNotMatch(bundle, /(?:from\s*|require\s*\()\s*["']@mstar-harness\//, `${target} must not load workspace packages at runtime`);
    assert.doesNotMatch(bundle, /(?:from\s*|require\s*\()\s*["'](?:mstar|@mstar-harness\/cli)["']/, `${target} must not invoke a global CLI package`);
    assert.deepEqual(
      { pluginVersion: info.pluginVersion, engineVersion: info.engineVersion, mcpVersion: info.mcpVersion },
      versions,
    );
    assert.equal(info.hostTarget, target);
    assert.deepEqual(info.supportedProtocols, ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
    bundles.push(bundle);
  }

  assert.ok(bundles.every((bundle) => bundle === bundles[0]), "each target ships the identical executable bytes");
});
