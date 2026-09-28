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

  test("malformed and non-launching configs are mismatches, never aligned", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mcp-health-invalid-"));
    roots.push(root);
    mkdirSync(path.join(root, ".cursor"), { recursive: true });
    const cursorConfig = path.join(root, ".cursor", "mcp.json");

    // Bare `null` parses as JSON but is not a config object.
    writeFileSync(cursorConfig, "null", "utf8");
    expect(diagnoseMcpTarget("cursor", root, currentRuntime).status).toBe("mismatch");

    // A syntax error reports the parse failure.
    writeFileSync(cursorConfig, "{not json", "utf8");
    const broken = diagnoseMcpTarget("cursor", root, currentRuntime);
    expect(broken.status).toBe("mismatch");
    expect(broken.errors.join(" ")).toContain("not valid JSON");

    // `npx` buried mid-argv under another executable is not an mstar launch.
    writeFileSync(cursorConfig, JSON.stringify({ mcpServers: { mstar: { command: "node", args: ["npx", "@mstar-harness/cli", "mcp"] } } }), "utf8");
    expect(diagnoseMcpTarget("cursor", root, currentRuntime).status).toBe("mismatch");

    // A foreign codex table (not `[mcp_servers.mstar]`) launching the server does not count.
    mkdirSync(path.join(root, ".codex"), { recursive: true });
    writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.other]\ncommand = \"npx\"\nargs = [\"-y\", \"@mstar-harness/cli\", \"mcp\"]\n", "utf8");
    expect(diagnoseMcpTarget("codex", root, currentRuntime).status).toBe("mismatch");
  });

  test("dsh reads the Cordis sources under its profile", () => {
    const dshHome = mkdtempSync(path.join(os.tmpdir(), "mcp-health-dsh-"));
    roots.push(dshHome);
    const profileDir = path.join(dshHome, "profiles", "web");
    mkdirSync(path.join(profileDir, "node_modules", "@deepseek-ai", "dsh-mcp-client"), { recursive: true });
    const bundlePatch = path.join(profileDir, "node_modules", "@mstar-harness", "dsh", "bundle", "cordis.patch.yml");
    mkdirSync(path.dirname(bundlePatch), { recursive: true });
    writeFileSync(bundlePatch, [
      "- insert:",
      "    - id: mstar-mcp",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: mstar",
      "        transport: stdio",
        "        command: npx",
      "        args: ['-y', '@mstar-harness/cli', 'mcp']",
    ].join("\n"), "utf8");
    const patched = diagnoseMcpTarget("dsh", profileDir, currentRuntime);
    expect(patched.status).toBe("aligned");
    expect(patched.notes.join(" ")).toContain("mcp-client");

    // A comment mentioning the row is not a row: comment-only sources stay unavailable.
    const bareHome = mkdtempSync(path.join(os.tmpdir(), "mcp-health-dsh-bare-"));
    roots.push(bareHome);
    const bareProfile = path.join(bareHome, "profiles", "web");
    mkdirSync(path.join(bareProfile, "node_modules", "@mstar-harness", "dsh", "bundle"), { recursive: true });
    writeFileSync(path.join(bareProfile, "node_modules", "@mstar-harness", "dsh", "bundle", "cordis.patch.yml"), "# mcp-client @mstar-harness/cli mcp mentioned in prose\n[]\n", "utf8");
    expect(diagnoseMcpTarget("dsh", bareProfile, currentRuntime).status).toBe("unavailable");

    // A configured row without the bridge plugin installed is a mismatch.
    const bare = diagnoseMcpTarget("dsh", profileDir, currentRuntime);
    rmSync(path.join(profileDir, "node_modules", "@deepseek-ai", "dsh-mcp-client"), { recursive: true, force: true });
    expect(diagnoseMcpTarget("dsh", profileDir, currentRuntime).status).toBe("mismatch");
    expect(bare.status).toBe("aligned");
  });
});
