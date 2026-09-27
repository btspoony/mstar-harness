import fs from "node:fs";
import path from "node:path";
import { MIN_NODE_VERSION } from "@mstar-harness/engine";
import { resolveDshProfileDir } from "./dsh.js";
import { resolveOpencodePluginPackageRoot } from "./plugin-version-alignment.js";
import { compareSemver } from "./version-compare.js";
import type { HostTarget } from "./plugin-version-alignment.js";

type McpConfig = "servers" | "opencode" | "deferred";

const MCP_CONFIG_PATHS: Record<HostTarget, { path: string; kind: McpConfig }> = {
  omp: { path: "mcp.json", kind: "servers" },
  opencode: { path: "mcp.json", kind: "opencode" },
  dsh: { path: "bundle/cordis.patch.yml", kind: "deferred" },
  cursor: { path: ".cursor-plugin/mcp.json", kind: "servers" },
  codex: { path: ".codex-plugin/mcp.json", kind: "servers" },
  kimi: { path: ".kimi-plugin/mcp.json", kind: "servers" },
  zcode: { path: ".zcode-plugin/mcp.json", kind: "servers" },
};

export type McpHealthStatus = "unavailable" | "mismatch" | "aligned";
export type McpRuntime = Readonly<{ version: string }>;
export type McpTargetHealth = Readonly<{
  target: HostTarget;
  status: McpHealthStatus;
  location: string;
  runtimeFloor: string;
  errors: readonly string[];
  notes: readonly string[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Inspect the host's npx MCP launch configuration without starting a process or touching the artifact store. */
export function diagnoseMcpTarget(
  target: HostTarget,
  packageRoot: string,
  runtime: McpRuntime = { version: process.versions.node },
): McpTargetHealth {
  const config = MCP_CONFIG_PATHS[target];
  const configPath = path.join(packageRoot, config.path);
  const runtimeFloor = MIN_NODE_VERSION;
  const runtimeError = compareSemver(runtime.version, runtimeFloor) < 0
    ? `Node.js runtime ${runtime.version} is below the required ${runtimeFloor} floor.`
    : null;

  if (config.kind === "deferred") {
    return {
      target,
      status: "unavailable",
      location: configPath,
      runtimeFloor,
      errors: ["DSH MCP launch configuration is deferred; DSH uses a Cordis YAML plugin row."],
      notes: [],
    };
  }
  if (!fs.existsSync(configPath)) {
    return {
      target,
      status: "unavailable",
      location: configPath,
      runtimeFloor,
      errors: [
        `MCP configuration unavailable for ${target}; missing ${config.path}.`,
        ...(runtimeError === null ? [] : [runtimeError]),
      ],
      notes: [],
    };
  }

  const document = readJson(configPath);
  const server = config.kind === "opencode"
    ? record(document?.mcp)?.["morning-star"]
    : record(document?.mcpServers)?.["morning-star"];
  const entry = record(server);
  const errors: string[] = [];
  if (document === null || entry === null) {
    errors.push("MCP configuration is not valid object data or has no morning-star server.");
  } else if (config.kind === "opencode") {
    const command = entry.command;
    if (entry.type !== "local" || !Array.isArray(command) || command.join("\0") !== "npx\0@mstar-harness/cli\0mcp") {
      errors.push("MCP server must launch the CLI with command [\"npx\", \"@mstar-harness/cli\", \"mcp\"].");
    }
  } else {
    const args = entry.args;
    if (entry.command !== "npx" || !Array.isArray(args) || args.join("\0") !== "@mstar-harness/cli\0mcp") {
      errors.push("MCP server must use command \"npx\" and args [\"@mstar-harness/cli\", \"mcp\"].");
    }
  }
  if (runtimeError !== null) errors.push(runtimeError);

  return {
    target,
    status: errors.length === 0 ? "aligned" : "mismatch",
    location: configPath,
    runtimeFloor,
    errors,
    notes: errors.length === 0 ? [`MCP CLI launch configuration aligned for ${target}.`] : [],
  };
}

/** Resolve the installed npm package for cache-based hosts, not ignored checkout build outputs. */
export function mcpTargetPackageRoot(
  target: HostTarget,
  repositoryRoot: string,
  options: { opencodePackagesRoot?: string; dshHome?: string } = {},
): string {
  if (target === "opencode") return resolveOpencodePluginPackageRoot(options.opencodePackagesRoot);
  if (target === "dsh") return path.join(resolveDshProfileDir(options.dshHome), "node_modules", "@mstar-harness", "dsh");
  return target === "omp" ? path.join(repositoryRoot, "packages", "omp") : repositoryRoot;
}
