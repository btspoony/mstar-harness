import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
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
const HOST_MCP_CONFIGS: Record<Exclude<HostTarget, "dsh">, { configFile: string; format: "mcpServers" | "mcp" | "toml" }> = {
  omp: { configFile: ".omp/mcp.json", format: "mcpServers" },
  opencode: { configFile: "opencode.json", format: "mcp" },
  cursor: { configFile: ".cursor/mcp.json", format: "mcpServers" },
  codex: { configFile: ".codex/config.toml", format: "toml" },
  kimi: { configFile: ".kimi-code/mcp.json", format: "mcpServers" },
  zcode: { configFile: ".zcode/config.json", format: "mcpServers" },
};

/** True when a server entry launches `npx @mstar-harness/cli mcp`: the
 * executable itself is `npx` (argv[0] — a string command or the head of a
 * `command` array) and the argv that follows contains `@mstar-harness/cli`
 * then the `mcp` subcommand. An `npx` buried mid-argv (a different
 * executable's argument) does not launch the server and must not read as
 * aligned. */
function isNpxMstarLaunch(entry: unknown): boolean {
  const e = record(entry);
  if (e === null) return false;
  const argv = [
    ...(Array.isArray(e.command) ? e.command as string[] : typeof e.command === "string" ? [e.command] : []),
    ...(Array.isArray(e.args) ? e.args as string[] : []),
  ];
  if (argv[0] !== "npx") return false;
  const cli = argv.indexOf("@mstar-harness/cli", 1);
  return cli !== -1 && argv.slice(cli + 1).includes("mcp");
}

/** Structured check of the Codex TOML: the `[mcp_servers.mstar]` table
 * specifically (not any server) whose command/args launch
 * `npx @mstar-harness/cli mcp`. */
function codexMstarServerPresent(content: string): boolean {
  const table = /\[mcp_servers\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=\n\[|$)/g;
  for (const match of content.matchAll(table)) {
    if (match[1] !== "mstar") continue;
    const body = match[2] ?? "";
    const command = /command\s*=\s*"([^"]+)"/.exec(body)?.[1];
    const args = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const argv = [command ?? "", ...args];
    if (argv[0] !== "npx") continue;
    const cli = argv.indexOf("@mstar-harness/cli", 1);
    if (cli !== -1 && argv.slice(cli + 1).includes("mcp")) return true;
  }
  return false;
}

/** The Cordis YAML config files a dsh profile composes its rows from: the
 * profile root list plus this bundle's own patch (shipped inside the
 * installed `@mstar-harness/dsh` package). */
const DSH_CORDIS_FILES = ["cordis.yml", path.join("node_modules", "@mstar-harness", "dsh", "bundle", "cordis.patch.yml")] as const;

/** Shape of one Cordis plugin row relevant to the doctor: only the fields the
 * mstar MCP row must carry. */
type CordisRow = {
  name: unknown;
  config: {
    transport: unknown;
    serverName: unknown;
    command: unknown;
    args: unknown;
  } | null;
};

function rowOf(value: unknown): CordisRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { name?: unknown; config?: unknown };
  const config = record.config !== null && typeof record.config === "object" && !Array.isArray(record.config)
    ? record.config as CordisRow["config"] & Record<string, unknown>
    : null;
  return { name: record.name, config };
}

/** True when a parsed row list contains the mstar MCP launch row: the Cordis
 * `mcp-client` bridge targeting `npx @mstar-harness/cli mcp` under the stable
 * `mstar` server name. */
function dshMcpRow(rows: readonly unknown[]): boolean {
  return rows.some((raw) => {
    const row = rowOf(raw);
    if (row === null || row.name !== "@deepseek-ai/dsh-mcp-client" || row.config === null) return false;
    const { transport, serverName, command, args } = row.config;
    if (transport !== "stdio" || serverName !== "mstar" || command !== "npx") return false;
    return Array.isArray(args) && args.includes("@mstar-harness/cli") && args.includes("mcp");
  });
}

/** Parse one composed Cordis source: the profile root row list, or this
 * bundle's patch whose rows arrive under `- insert:` keys. */
function dshCordisRows(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = load(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const insert = entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { insert?: unknown }).insert
      : undefined;
    return Array.isArray(insert) ? insert : [entry];
  });
}

/** The `mcp-client` row that launches the host-neutral MCP server. */
function dshMcpRowPresent(cordisText: string): boolean {
  return dshMcpRow(dshCordisRows(cordisText));
}

/** Inspect the dsh profile's composed Cordis sources for the mstar MCP row and
 * the `mcp-client` bridge plugin it needs. */
function diagnoseDshMcp(profileDir: string, runtimeFloor: string, runtimeError: string | null): McpTargetHealth {
  const runtimePrefix: Pick<McpTargetHealth, "runtimeFloor"> = { runtimeFloor };
  const withError = (errors: string[]): readonly string[] => (runtimeError === null ? errors : [...errors, runtimeError]);
  const sources = DSH_CORDIS_FILES
    .map((relative) => path.join(profileDir, relative))
    .filter((file) => fs.existsSync(file));
  if (sources.length === 0) {
    return {
      target: "dsh",
      status: "unavailable",
      location: profileDir,
      ...runtimePrefix,
      errors: withError([`MCP client configuration unavailable for dsh; no Cordis config found under ${profileDir}.`]),
      notes: [],
    };
  }
  const rowSource = sources.find((file) => dshMcpRowPresent(fs.readFileSync(file, "utf8")));
  if (rowSource === undefined) {
    return {
      target: "dsh",
      status: "unavailable",
      location: sources[0]!,
      ...runtimePrefix,
      errors: withError([`MCP client configuration unavailable for dsh; no mstar mcp-client row in ${sources.map((file) => path.relative(profileDir, file)).join(", ")}.`]),
      notes: [],
    };
  }
  const bridgePackage = path.join(profileDir, "node_modules", "@deepseek-ai", "dsh-mcp-client");
  if (!fs.existsSync(bridgePackage)) {
    return {
      target: "dsh",
      status: "mismatch",
      location: rowSource,
      ...runtimePrefix,
      errors: withError([`The mstar mcp-client row is configured but the bridge plugin is not installed; run \`dsh plugin --profile web add @deepseek-ai/dsh-mcp-client\` (${bridgePackage} is missing).`]),
      notes: [],
    };
  }
  return {
    target: "dsh",
    status: "aligned",
    location: rowSource,
    ...runtimePrefix,
    errors: [],
    notes: [`Cordis mcp-client row launches npx @mstar-harness/cli mcp for dsh (server name "mstar").`],
  };
}

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
    return diagnoseDshMcp(configRoot, runtimeFloor, runtimeError);
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
    let parsed: Record<string, unknown> | null;
    let parseFailed = false;
    try {
      parsed = record(JSON.parse(content));
    } catch (error) {
      parseFailed = true;
      parsed = null;
      errors.push(`MCP config ${relativeConfig} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    }
    // `JSON.parse("null")` succeeds but is not a config object — a bare null,
    // array or scalar must read as mismatch, never fall through to aligned.
    if (!parseFailed && parsed === null) errors.push(`MCP config ${relativeConfig} is not a JSON object.`);
    if (parsed !== null) {
      const servers = format === "mcp" ? parsed.mcp : parsed.mcpServers;
      const serverRecord = record(servers);
      if (serverRecord === null) {
        errors.push(`MCP config ${relativeConfig} has no valid server entries.`);
      } else {
        const hasMstar = Object.values(serverRecord).some((entry) => isNpxMstarLaunch(entry));
        if (!hasMstar) errors.push(`MCP config ${relativeConfig} has no mstar server entry launching \`npx @mstar-harness/cli mcp\`.`);
      }
    }
  } else if (format === "toml") {
    if (!codexMstarServerPresent(content)) errors.push(`Codex config ${relativeConfig} has no \`[mcp_servers.mstar]\` entry launching \`npx @mstar-harness/cli mcp\`.`);
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
