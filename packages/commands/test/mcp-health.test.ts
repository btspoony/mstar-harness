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
    case "opencode": return path.join(".config", "opencode", "opencode.json");
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

    // A commented-out mstar table cannot launch anything — comment lines are
    // stripped before the table scan.
    writeFileSync(path.join(root, ".codex", "config.toml"), "# [mcp_servers.mstar]\n# command = \"npx\"\n# args = [\"-y\", \"@mstar-harness/cli\", \"mcp\"]\n", "utf8");
    expect(diagnoseMcpTarget("codex", root, currentRuntime).status).toBe("mismatch");

    // An inline comment cannot supply the argv either: empty args plus a
    // comment mentioning the launcher stays a mismatch.
    writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.mstar]\ncommand = \"npx\" # run args = [\"@mstar-harness/cli\", \"mcp\"]\nargs = [] # from \"@mstar-harness/cli\"\n", "utf8");
    expect(diagnoseMcpTarget("codex", root, currentRuntime).status).toBe("mismatch");
  });

  test("dsh health reads the effective dump through dsh itself", () => {
    const dshHome = mkdtempSync(path.join(os.tmpdir(), "mcp-health-dsh-"));
    roots.push(dshHome);
    const profileDir = path.join(dshHome, "profiles", "web");
    mkdirSync(profileDir, { recursive: true });

    // A fake `dsh` on PATH prints a fixture dump: the doctor must trust the
    // composer's output (bundle order, patch layering, resolution.entries and
    // the install anchors are dsh's own logic, not the doctor's).
    const binDir = mkdtempSync(path.join(os.tmpdir(), "mcp-health-dsh-bin-"));
    roots.push(binDir);
    const dumpFile = path.join(dshHome, "dump.yml");
    writeFileSync(path.join(binDir, "dsh"), `#!/bin/sh\ncat "${dumpFile}"\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      // Mounted row → aligned — with the bridge resolving through a profile
      // stub package (main entry present, so createRequire finds it).
      writeFileSync(dumpFile, [
        "- id: mstar",
        "  name: '@mstar-harness/dsh'",
        "- id: mstar-mcp",
        "  name: '@deepseek-ai/dsh-mcp-client'",
        "  config:",
        "    serverName: mstar",
        "    transport: stdio",
        "    command: npx",
        "    args: ['-y', '@mstar-harness/cli', 'mcp']",
      ].join("\n"), "utf8");
      const bridgeDir = path.join(profileDir, "node_modules", "@deepseek-ai", "dsh-mcp-client");
      mkdirSync(bridgeDir, { recursive: true });
      writeFileSync(path.join(bridgeDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-mcp-client", version: "0.0.0-stub", main: "index.js" }), "utf8");
      writeFileSync(path.join(bridgeDir, "index.js"), "", "utf8");
      const mounted = diagnoseMcpTarget("dsh", profileDir, currentRuntime);
      expect(mounted.status).toBe("aligned");
      expect(mounted.notes.join(" ")).toContain("Cordis mcp-client row launches");

      // Same composed row, but the bridge no longer resolves → mismatch
      // (the dump proves composition, not that the optional entry can load).
      rmSync(bridgeDir, { recursive: true, force: true });
      const unresolved = diagnoseMcpTarget("dsh", profileDir, currentRuntime);
      expect(unresolved.status).toBe("mismatch");
      expect(unresolved.errors.join(" ")).toContain("does not resolve");

      // A disabled row composes but exposes nothing → unavailable.
      writeFileSync(dumpFile, [
        "- id: mstar-mcp",
        "  name: '@deepseek-ai/dsh-mcp-client'",
        "  disabled: true",
      ].join("\n"), "utf8");
      expect(diagnoseMcpTarget("dsh", profileDir, currentRuntime).status).toBe("unavailable");

      // No mstar-mcp row at all → unavailable.
      writeFileSync(dumpFile, "- id: mstar\n  name: '@mstar-harness/dsh'\n", "utf8");
      const noRow = diagnoseMcpTarget("dsh", profileDir, currentRuntime);
      expect(noRow.status).toBe("unavailable");
      expect(noRow.errors.join(" ")).toContain("no mstar-mcp row");

      // A DIFFERENT server reusing the bridge client (serverName not mstar)
      // does not satisfy the mstar row's health.
      writeFileSync(dumpFile, [
        "- id: mstar-mcp",
        "  name: '@deepseek-ai/dsh-mcp-client'",
        "  config:",
        "    serverName: other",
        "    transport: stdio",
        "    command: npx",
        "    args: ['-y', '@mstar-harness/cli', 'mcp']",
      ].join("\n"), "utf8");
      expect(diagnoseMcpTarget("dsh", profileDir, currentRuntime).status).toBe("unavailable");

      // Aligned row + a below-floor runtime → mismatch.
      writeFileSync(dumpFile, [
        "- id: mstar-mcp",
        "  name: '@deepseek-ai/dsh-mcp-client'",
        "  config:",
        "    serverName: mstar",
        "    transport: stdio",
        "    command: npx",
        "    args: ['-y', '@mstar-harness/cli', 'mcp']",
      ].join("\n"), "utf8");
      expect(diagnoseMcpTarget("dsh", profileDir, { kind: "node", version: "24.17.0" }).status).toBe("mismatch");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    // A dsh binary that cannot produce the dump refuses with the failure,
    // never a fabricated aligned/mismatch verdict.
    const brokenBin = mkdtempSync(path.join(os.tmpdir(), "mcp-health-dsh-broken-"));
    roots.push(brokenBin);
    writeFileSync(path.join(brokenBin, "dsh"), "#!/bin/sh\necho boom >&2\nexit 1\n", { mode: 0o755 });
    const brokenPath = process.env.PATH;
    process.env.PATH = `${brokenBin}${path.delimiter}${brokenPath ?? ""}`;
    try {
      const failed = diagnoseMcpTarget("dsh", profileDir, currentRuntime);
      expect(failed.status).toBe("unavailable");
      expect(failed.errors.join(" ")).toContain("could not read the effective configuration");
      expect(failed.errors.join(" ")).toContain("boom");
    } finally {
      if (brokenPath === undefined) delete process.env.PATH;
      else process.env.PATH = brokenPath;
    }
  });

  test("dsh bridge resolves through the hoisted sibling in the install tree", () => {
    // The bridge installed beside the dsh package
    // (`<install>/node_modules/@deepseek-ai/dsh-mcp-client`) resolves through
    // the install anchor's ancestor chain, even though the profile has no
    // local copy.
    const installTree = mkdtempSync(path.join(os.tmpdir(), "mcp-health-dsh-hoisted-"));
    roots.push(installTree);
    const anchorNodeModules = path.join(installTree, "node_modules");
    const dshPackageDir = path.join(anchorNodeModules, "@deepseek-ai", "dsh");
    const bridgeSibling = path.join(anchorNodeModules, "@deepseek-ai", "dsh-mcp-client");
    mkdirSync(path.join(dshPackageDir, "bin"), { recursive: true });
    mkdirSync(bridgeSibling, { recursive: true });
    writeFileSync(path.join(dshPackageDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0-stub", bin: { dsh: "bin/dsh" } }), "utf8");
    writeFileSync(path.join(bridgeSibling, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-mcp-client", version: "0.0.0-stub", main: "index.js" }), "utf8");
    writeFileSync(path.join(bridgeSibling, "index.js"), "", "utf8");
    const dumpFile = path.join(installTree, "dump.yml");
    writeFileSync(dumpFile, [
      "- id: mstar-mcp",
      "  name: '@deepseek-ai/dsh-mcp-client'",
      "  config:",
      "    serverName: mstar",
      "    transport: stdio",
      "    command: npx",
      "    args: ['-y', '@mstar-harness/cli', 'mcp']",
    ].join("\n"), "utf8");
    writeFileSync(path.join(dshPackageDir, "bin", "dsh"), `#!/bin/sh\ncat "${dumpFile}"\n`, { mode: 0o755 });
    const hoistedHome = mkdtempSync(path.join(os.tmpdir(), "mcp-health-dsh-hoisted-home-"));
    roots.push(hoistedHome);
    const hoistedProfile = path.join(hoistedHome, "profiles", "web");
    mkdirSync(hoistedProfile, { recursive: true });
    const hoistedPath = process.env.PATH;
    process.env.PATH = `${path.join(dshPackageDir, "bin")}${path.delimiter}${hoistedPath ?? ""}`;
    try {
      expect(diagnoseMcpTarget("dsh", hoistedProfile, currentRuntime).status).toBe("aligned");
    } finally {
      if (hoistedPath === undefined) delete process.env.PATH;
      else process.env.PATH = hoistedPath;
    }
  });

  test("codex accepts single-quoted basic TOML strings", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mcp-health-codex-sq-"));
    roots.push(root);
    mkdirSync(path.join(root, ".codex"), { recursive: true });
    writeFileSync(path.join(root, ".codex", "config.toml"), "[mcp_servers.mstar]\ncommand = 'npx'\nargs = ['-y', '@mstar-harness/cli', 'mcp']\n", "utf8");
    expect(diagnoseMcpTarget("codex", root, currentRuntime).status).toBe("aligned");
  });
});
