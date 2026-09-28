import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MIN_BUN_VERSION, MIN_NODE_VERSION } from "@mstar-harness/engine";
import { DSH_BIN, DSH_DUMP_FLAG, DSH_HOME_ENV, DSH_PROFILE, DSH_PROFILE_FLAG, resolveDshProfileDir } from "./dsh.js";
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
  opencode: { configFile: path.join(".config", "opencode", "opencode.json"), format: "mcp" },
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
 * `npx @mstar-harness/cli mcp`. Basic TOML strings may be single- or
 * double-quoted. */
function codexMstarServerPresent(content: string): boolean {
  // A commented-out table (`# [mcp_servers.mstar] ...`) cannot launch
  // anything: strip comment lines before scanning for the table body.
  const active = content.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const table = /\[mcp_servers\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=\n\[|$)/g;
  for (const match of active.matchAll(table)) {
    if (match[1] !== "mstar") continue;
    const body = stripTomlInlineComments(match[2] ?? "");
    const command = tomlString(body, "command");
    const args = tomlStringArray(body, "args");
    const argv = [command ?? "", ...args];
    if (argv[0] !== "npx") continue;
    const cli = argv.indexOf("@mstar-harness/cli", 1);
    if (cli !== -1 && argv.slice(cli + 1).includes("mcp")) return true;
  }
  return false;
}

/** One basic TOML string value (`key = "..."` or `key = '...'`). */
function tomlString(body: string, key: string): string | null {
  const match = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(body);
  return match === null ? null : match[1] ?? match[2] ?? null;
}

/** A basic TOML array-of-strings value (`key = ["a", 'b']`). */
function tomlStringArray(body: string, key: string): string[] {
  const match = new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)\\]`).exec(body);
  if (match === null) return [];
  return [...match[1]!.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");
}

/** Drop each line's tail after the first `#` that sits outside a quoted
 * string, so inline comments cannot supply `command`/`args` values. */
function stripTomlInlineComments(body: string): string {
  return body.split("\n").map((line) => {
    let inString = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (ch === '"') inString = !inString;
      else if (ch === "#" && !inString) { cut = i; break; }
    }
    return line.slice(0, cut);
  }).join("\n");
}

/** Inspect the dsh profile's MCP configuration through dsh's OWN composer:
 * `dsh --profile web --dump-config` prints the effective row tree AFTER
 * bundle order, patch layering, `resolution.entries` interception and both
 * install anchors — surfaces the doctor cannot re-implement faithfully. A
 * mounted `@deepseek-ai/dsh-mcp-client` row in that dump is authoritative;
 * a `disabled: true` row or no row at all reads as unavailable. */
function diagnoseDshMcp(profileDir: string, runtimeFloor: string, runtimeError: string | null): McpTargetHealth {
  const runtimePrefix: Pick<McpTargetHealth, "runtimeFloor"> = { runtimeFloor };
  const withError = (errors: string[]): readonly string[] => (runtimeError === null ? errors : [...errors, runtimeError]);
  const dshHome = path.resolve(profileDir, "..", "..");
  let dump: string | null = null;
  let dumpError: string | null = null;
  try {
    const proc = spawnSync(DSH_BIN, [DSH_PROFILE_FLAG, DSH_PROFILE, DSH_DUMP_FLAG], {
      cwd: profileDir,
      env: { ...process.env, [DSH_HOME_ENV]: dshHome },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (proc.status === 0) dump = proc.stdout;
    else dumpError = (proc.stderr ?? "").trim() || `exited ${String(proc.status)}`;
  } catch (error) {
    dumpError = error instanceof Error ? error.message : String(error);
  }
  if (dump === null) {
    return {
      target: "dsh",
      status: "unavailable",
      location: profileDir,
      ...runtimePrefix,
      errors: withError([`MCP health for dsh could not read the effective configuration: \`dsh ${DSH_PROFILE_FLAG} ${DSH_PROFILE} ${DSH_DUMP_FLAG}\` failed (${dumpError ?? "dsh not found"}).`]),
      notes: [],
    };
  }
  // A dump row starts at a top-level "- " line; everything indented under it
  // (name, config, a `disabled: true` flag) belongs to that row's block. The
  // mstar row is the bridge entry under the `mstar` server name — another
  // DSH MCP server reusing the client package does not satisfy health.
  const rowBlock = dump.split(/^(?=- )/m).find((block) => block.includes("@deepseek-ai/dsh-mcp-client") && /^\s+serverName:\s*mstar\s*$/m.test(block));
  if (rowBlock === undefined) {
    return {
      target: "dsh",
      status: "unavailable",
      location: profileDir,
      ...runtimePrefix,
      errors: withError([`MCP client configuration unavailable for dsh; the composed configuration has no mstar-mcp row (checked via \`dsh ${DSH_DUMP_FLAG}\`).`]),
      notes: [],
    };
  }
  if (/^\s+disabled:\s*true\s*$/m.test(rowBlock)) {
    return {
      target: "dsh",
      status: "unavailable",
      location: profileDir,
      ...runtimePrefix,
      errors: withError(["The mstar-mcp row is composed but disabled in the dsh configuration; enable it to expose the MCP server."]),
      notes: [],
    };
  }
  if (runtimeError !== null) {
    return {
      target: "dsh",
      status: "mismatch",
      location: profileDir,
      ...runtimePrefix,
      errors: [runtimeError],
      notes: [],
    };
  }
  return {
    target: "dsh",
    status: "aligned",
    location: profileDir,
    ...runtimePrefix,
    errors: [],
    notes: [`Cordis mcp-client row launches npx @mstar-harness/cli mcp for dsh (server name "mstar"; verified through \`dsh ${DSH_DUMP_FLAG}\`).`],
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

export { resolveDshProfileDir };
