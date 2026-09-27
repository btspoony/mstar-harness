import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpBuildInfo, MCP_BUILD_INFO_FILENAME } from "../../mcp/src/build-info.js";
import { diagnoseMcpTarget, mcpTargetPackageRoot, type McpRuntime } from "../src/host-health.js";
import type { HostTarget } from "../src/host-health.js";

const targets: readonly Exclude<HostTarget, "dsh">[] = ["opencode", "cursor", "codex", "zcode", "omp", "kimi"];
const roots: string[] = [];
const version = "3.11.2";
const currentRuntime: McpRuntime = { kind: "node", version: "24.18.0" };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(target: HostTarget): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-health-"));
  roots.push(root);
  const manifest = target === "cursor" ? ".cursor-plugin/plugin.json"
    : target === "codex" ? ".codex-plugin/plugin.json"
    : target === "kimi" ? ".kimi-plugin/plugin.json"
    : target === "zcode" ? ".zcode-plugin/plugin.json"
    : "package.json";
  const metadataDir = target === "omp" || target === "opencode"
    ? "mcp"
    : `mcp/bundles/${target}/dist/mcp`;
  mkdirSync(path.dirname(path.join(root, manifest)), { recursive: true });
  mkdirSync(path.join(root, metadataDir), { recursive: true });
  writeFileSync(path.join(root, manifest), JSON.stringify({ version }), "utf8");
  writeFileSync(path.join(root, metadataDir, "stdio.js"), "// bundled MCP server\n", "utf8");
  writeFileSync(path.join(root, metadataDir, MCP_BUILD_INFO_FILENAME), JSON.stringify(createMcpBuildInfo({
    pluginVersion: version,
    engineVersion: version,
    mcpVersion: version,
  }, target)), "utf8");
  return root;
}

describe("MCP package health", () => {
  test("packaged targets report aligned metadata and files", () => {
    for (const target of targets) {
      const result = diagnoseMcpTarget(target, fixtureRoot(target), currentRuntime);
      expect(result.status).toBe("aligned");
      expect(result.errors).toEqual([]);
      expect(result.notes.join(" ")).toContain(target);
    }
  });
  test("opencode inspects its installed npm package root instead of checkout outputs", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mcp-installed-health-"));
    roots.push(root);
    const opencodePackagesRoot = path.join(root, "opencode-packages");
    const packageRoot = mcpTargetPackageRoot("opencode", "/checkout", { opencodePackagesRoot });
    mkdirSync(path.join(packageRoot, "mcp"), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version }), "utf8");
    writeFileSync(path.join(packageRoot, "mcp", "stdio.js"), "// installed package\n", "utf8");
    writeFileSync(path.join(packageRoot, "mcp", MCP_BUILD_INFO_FILENAME), JSON.stringify(createMcpBuildInfo({
      pluginVersion: version,
      engineVersion: version,
      mcpVersion: version,
    }, "opencode")), "utf8");
    expect(diagnoseMcpTarget("opencode", packageRoot, currentRuntime).status).toBe("aligned");
  });
  test("dsh reports unavailable until a Cordis MCP launch configuration exists", () => {
    const result = diagnoseMcpTarget("dsh", "/unused", currentRuntime);
    expect(result.status).toBe("unavailable");
    expect(result.errors.join(" ")).toContain("no Cordis MCP launch configuration");
  });

  test("version, target, and metadata divergence report mismatch", () => {
    const root = fixtureRoot("cursor");
    const metadataPath = path.join(root, "mcp/bundles/cursor/dist/mcp", MCP_BUILD_INFO_FILENAME);
    writeFileSync(metadataPath, JSON.stringify(createMcpBuildInfo({
      pluginVersion: version,
      engineVersion: "3.11.1",
      mcpVersion: version,
    }, "codex")), "utf8");

    const result = diagnoseMcpTarget("cursor", root, currentRuntime);
    expect(result.status).toBe("mismatch");
    expect(result.errors.join(" ")).toContain("engineVersion");
    expect(result.errors.join(" ")).toContain("hostTarget");
  });

  test("missing packaged executable is unavailable", () => {
    const root = fixtureRoot("omp");
    rmSync(path.join(root, "mcp/stdio.js"));

    const result = diagnoseMcpTarget("omp", root, currentRuntime);
    expect(result.status).toBe("unavailable");
    expect(result.errors.join(" ")).toContain("mcp/stdio.js");
  });

  test("refuses a native runtime below its floor for every packaged target", () => {
    for (const target of targets) {
      const result = diagnoseMcpTarget(target, fixtureRoot(target), { kind: "node", version: "24.17.0" });
      expect(result.status).toBe("mismatch");
      expect(result.errors.join(" ")).toContain("Node.js runtime 24.17.0");
      expect(result.errors.join(" ")).toContain(result.runtimeFloor);
    }
    const bunResult = diagnoseMcpTarget("omp", fixtureRoot("omp"), { kind: "bun", version: "1.3.9" });
    expect(bunResult.status).toBe("mismatch");
    expect(bunResult.errors.join(" ")).toContain("Bun runtime 1.3.9");
    expect(bunResult.runtimeFloor).toBe("1.4.0");
  });
});
