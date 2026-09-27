import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnoseMcpTarget, mcpTargetPackageRoot, type McpRuntime } from "../src/host-health.js";
import type { HostTarget } from "../src/host-health.js";

const configuredTargets: readonly HostTarget[] = ["opencode", "cursor", "codex", "zcode", "omp", "kimi"];
const roots: string[] = [];
const currentRuntime: McpRuntime = { version: "24.18.0" };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configPath(root: string, target: HostTarget): string {
  const pathFromRoot = target === "opencode" || target === "omp"
    ? "mcp.json"
    : `.${target}-plugin/mcp.json`;
  return path.join(root, pathFromRoot);
}

function writeConfig(root: string, target: HostTarget, command = "npx", args = ["@mstar-harness/cli", "mcp"]): void {
  const file = configPath(root, target);
  mkdirSync(path.dirname(file), { recursive: true });
  const config = target === "opencode"
    ? { mcp: { "morning-star": { type: "local", command: [command, ...args] } } }
    : { mcpServers: { "morning-star": { command, args } } };
  writeFileSync(file, `// Requires a published CLI release with the mcp subcommand.\n${JSON.stringify(config)}`, "utf8");
}

function fixtureRoot(target: HostTarget): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-health-"));
  roots.push(root);
  writeConfig(root, target);
  return root;
}

describe("MCP host config health", () => {
  test("all six JSON host configurations launch the CLI subcommand", () => {
    for (const target of configuredTargets) {
      const result = diagnoseMcpTarget(target, fixtureRoot(target), currentRuntime);
      expect(result.status).toBe("aligned");
      expect(result.errors).toEqual([]);
      expect(result.notes.join(" ")).toContain(target);
    }
  });

  test("OpenCode checks the installed package config and DSH reports its YAML follow-up", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mcp-installed-health-"));
    roots.push(root);
    const opencodePackagesRoot = path.join(root, "opencode-packages");
    const dshHome = path.join(root, "dsh-home");
    const opencodePackageRoot = mcpTargetPackageRoot("opencode", "/checkout", { opencodePackagesRoot });
    const dshPackageRoot = mcpTargetPackageRoot("dsh", "/checkout", { dshHome });

    writeConfig(opencodePackageRoot, "opencode");
    expect(diagnoseMcpTarget("opencode", opencodePackageRoot, currentRuntime).status).toBe("aligned");
    expect(dshPackageRoot).toBe(path.join(dshHome, "profiles", "web", "node_modules", "@mstar-harness", "dsh"));
    const dsh = diagnoseMcpTarget("dsh", dshPackageRoot, currentRuntime);
    expect(dsh.status).toBe("unavailable");
    expect(dsh.errors.join(" ")).toContain("Cordis YAML plugin row");
  });

  test("incorrect command or arguments report a config mismatch", () => {
    const root = fixtureRoot("codex");
    writeConfig(root, "codex", "node", ["obsolete-server.js"]);

    const result = diagnoseMcpTarget("codex", root, currentRuntime);
    expect(result.status).toBe("mismatch");
    expect(result.errors.join(" ")).toContain("command \"npx\"");
  });

  test("missing host config is unavailable", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mcp-missing-health-"));
    roots.push(root);

    const result = diagnoseMcpTarget("omp", root, currentRuntime);
    expect(result.status).toBe("unavailable");
    expect(result.errors.join(" ")).toContain("mcp.json");
  });

  test("reports when the host's Node runtime is below its floor", () => {
    const result = diagnoseMcpTarget("omp", fixtureRoot("omp"), { version: "24.17.0" });
    expect(result.status).toBe("mismatch");
    expect(result.errors.join(" ")).toContain("Node.js runtime 24.17.0");
    expect(result.errors.join(" ")).toContain(result.runtimeFloor);
  });
});
