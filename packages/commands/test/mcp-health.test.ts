import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnoseMcpTarget, type McpRuntime } from "../src/host-health.js";
import type { HostTarget } from "../src/host-health.js";

const targets: readonly HostTarget[] = ["opencode", "cursor", "codex", "zcode", "omp", "kimi", "dsh"];
const roots: string[] = [];
const currentRuntime: McpRuntime = { kind: "node", version: "24.18.0" };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configRelativePath(target: HostTarget): string {
  switch (target) {
    case "omp": return ".omp/mcp.json";
    case "opencode": return "opencode.json";
    case "dsh": return "cordis.yml";
    case "cursor": return ".cursor/mcp.json";
    case "codex": return ".codex/config.toml";
    case "kimi": return ".kimi-code/mcp.json";
    case "zcode": return ".zcode/config.json";
  }
}

function mstarEntry(target: HostTarget): unknown {
  if (target === "opencode") {
    return { type: "local", command: ["npx", "-y", "@mstar-harness/cli", "mcp"] };
  }
  return { command: "npx", args: ["-y", "@mstar-harness/cli", "mcp"] };
}

function writeMstarConfig(root: string, target: HostTarget): void {
  const rel = configRelativePath(target);
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  if (target === "codex") {
    writeFileSync(abs, `[mcp_servers.mstar]\ncommand = "npx"\nargs = ["-y", "@mstar-harness/cli", "mcp"]\n`, "utf8");
  } else if (target === "dsh") {
    writeFileSync(abs, `plugins:\n  - id: mstar\n    name: "@mstar-harness/cli"\n    config:\n      transport: stdio\n      command: npx\n      args: ["-y", "@mstar-harness/cli", "mcp"]\n`, "utf8");
  } else if (target === "opencode") {
    writeFileSync(abs, JSON.stringify({ mcp: { mstar: mstarEntry(target) } }), "utf8");
  } else {
    writeFileSync(abs, JSON.stringify({ mcpServers: { mstar: mstarEntry(target) } }), "utf8");
  }
}

describe("MCP doctor health", () => {
  test("hosts with valid mstar config report aligned", () => {
    for (const target of targets) {
      if (target === "dsh") continue; // dsh needs Cordis, tested separately
      const root = mkdtempSync(path.join(os.tmpdir(), "mcp-health-"));
      roots.push(root);
      writeMstarConfig(root, target);
      const result = diagnoseMcpTarget(target, root, currentRuntime);
      expect(result.status).toBe("aligned");
      expect(result.errors).toEqual([]);
    }
  });

  test("dsh reports unavailable without Cordis config", () => {
    const result = diagnoseMcpTarget("dsh", "/unused", currentRuntime);
    expect(result.status).toBe("unavailable");
  });

  test("missing config file reports unavailable", () => {
    for (const target of targets) {
      if (target === "dsh") continue;
      const root = mkdtempSync(path.join(os.tmpdir(), "mcp-health-missing-"));
      roots.push(root);
      const result = diagnoseMcpTarget(target, root, currentRuntime);
      expect(result.status).toBe("unavailable");
    }
  });

  test("refuses runtime below floor", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mcp-health-floor-"));
    roots.push(root);
    writeMstarConfig(root, "omp");
    const result = diagnoseMcpTarget("omp", root, { kind: "node", version: "24.17.0" });
    expect(result.status).toBe("mismatch");
    expect(result.errors.join(" ")).toContain("Node.js runtime 24.17.0");
  });
});
