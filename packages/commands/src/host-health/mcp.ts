import fs from "node:fs";
import path from "node:path";
import { MIN_BUN_VERSION, MIN_NODE_VERSION } from "@mstar-harness/engine";
import { resolveDshProfileDir } from "./dsh.js";
import { resolveOpencodePluginPackageRoot } from "./plugin-version-alignment.js";
import { compareSemver } from "./version-compare.js";
import type { HostTarget } from "./plugin-version-alignment.js";

type RuntimeKind = "node" | "bun";

export type McpHealthStatus = "unavailable" | "mismatch" | "aligned";
export type McpRuntime = Readonly<{ kind: RuntimeKind; version: string }>;
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
    return record(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function actualRuntime(): McpRuntime {
  return process.versions.bun === undefined
    ? { kind: "node", version: process.versions.node }
    : { kind: "bun", version: process.versions.bun };
}

/**
 * Each host's MCP config file path (relative to the host's config root).
 * The doctor checks that the config exists and contains a valid mstar entry
 * referencing `npx @mstar-harness/cli mcp`.
 */
const HOST_MCP_CONFIGS: Record<HostTarget, { configFile: string; format: "mcpServers" | "mcp" | "cordis" | "toml" }> = {
  omp: { configFile: ".omp/mcp.json", format: "mcpServers" },
  opencode: { configFile: "opencode.json", format: "mcp" },
  dsh: { configFile: "cordis.yml", format: "cordis" },
  cursor: { configFile: ".cursor/mcp.json", format: "mcpServers" },
  codex: { configFile: ".codex/config.toml", format: "toml" },
  kimi: { configFile: ".kimi-code/mcp.json", format: "mcpServers" },
  zcode: { configFile: ".zcode/config.json", format: "mcpServers" },
};

/** Inspect one target's MCP configuration without starting a process. */
export function diagnoseMcpTarget(
  target: HostTarget,
  configRoot: string,
  runtime: McpRuntime = actualRuntime(),
): McpTargetHealth {
  const runtimeFloor = runtime.kind === "bun" ? MIN_BUN_VERSION : MIN_NODE_VERSION;
  const runtimeError = compareSemver(runtime.version, runtimeFloor) < 0
    ? `${runtime.kind === "bun" ? "Bun" : "Node.js"} runtime ${runtime.version} is below the required ${runtimeFloor} floor.`
    : null;

  if (target === "dsh") {
    return {
      target,
      status: "unavailable",
      location: resolveDshProfileDir(),
      runtimeFloor,
      errors: [
        "MCP client configuration unavailable for dsh; no Cordis MCP launch configuration is installed.",
        ...(runtimeError === null ? [] : [runtimeError]),
      ],
      notes: [],
    };
  }

  const { configFile: relativeConfig, format } = HOST_MCP_CONFIGS[target];
  const configPath = path.join(configRoot, relativeConfig);

  if (!fs.existsSync(configPath)) {
    return {
      target,
      status: "unavailable",
      location: configPath,
      runtimeFloor,
      errors: [
        `MCP configuration not found for ${target}; expected ${relativeConfig}.`,
        ...(runtimeError === null ? [] : [runtimeError]),
      ],
      notes: [],
    };
  }

  const content = fs.readFileSync(configPath, "utf8");
  const errors: string[] = [];

  if (format === "mcpServers" || format === "mcp") {
    const parsed = record(JSON.parse(content));
    if (parsed === null) {
      errors.push(`MCP config ${relativeConfig} is not valid JSON.`);
    } else {
      const servers = format === "mcp" ? parsed.mcp : parsed.mcpServers;
      const serverRecord = record(servers);
      if (serverRecord === null) {
        errors.push(`MCP config ${relativeConfig} has no valid server entries.`);
      } else {
        const hasMstar = Object.values(serverRecord).some((entry) => {
          const e = record(entry);
          if (e === null) return false;
          const segments = [
            ...(Array.isArray(e.command) ? e.command as string[] : [String(e.command ?? "")]),
            ...(Array.isArray(e.args) ? e.args as string[] : []),
          ];
          return segments.includes("@mstar-harness/cli") && segments.includes("mcp");
        });
        if (!hasMstar) errors.push(`MCP config ${relativeConfig} has no mstar server entry.`);
      }
    }
  } else if (format === "toml") {
    if (!content.includes("mcp")) errors.push(`Codex config ${relativeConfig} has no mcp_servers entry.`);
  } else if (format === "cordis") {
    if (!content.includes("mcp")) errors.push(`DSH config ${relativeConfig} has no MCP plugin entry.`);
  }

  if (runtimeError !== null) errors.push(runtimeError);

  return {
    target,
    status: errors.length === 0 ? "aligned" : errors.some((e) => e.includes("not found") || e.includes("unavailable")) ? "unavailable" : "mismatch",
    location: configPath,
    runtimeFloor,
    errors,
    notes: errors.length === 0 ? [`MCP config aligned for ${target}.`] : [],
  };
}

export function mcpTargetPackageRoot(target: HostTarget, checkout: string, options: { opencodePackagesRoot?: string } = {}): string {
  if (target === "opencode") {
    const opencodePackagesRoot = options.opencodePackagesRoot ?? path.join(checkout, "node_modules", "@mstar-harness");
    return path.join(opencodePackagesRoot, "opencode");
  }
  return checkout;
}

export { resolveDshProfileDir };
