#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpBuildInfo } from "../packages/mcp/src/build-info.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MCP_PLUGIN_TARGETS = ["omp", "opencode", "dsh", "cursor", "codex", "kimi", "zcode"] as const;
export type McpPluginTarget = (typeof MCP_PLUGIN_TARGETS)[number];

function parseTarget(argv: string[]): McpPluginTarget {
  if (argv.length !== 2 || argv[0] !== "--target" || !MCP_PLUGIN_TARGETS.includes(argv[1] as McpPluginTarget)) {
    throw new Error(`usage: bun scripts/build-mcp-plugins.ts --target <${MCP_PLUGIN_TARGETS.join("|")}>`);
  }
  return argv[1] as McpPluginTarget;
}

function packageRoot(target: McpPluginTarget): string {
  return target === "omp" || target === "opencode" || target === "dsh"
    ? path.join(repoRoot, "packages", target)
    : path.join(repoRoot, "packages", "mcp", "dist", "plugins", target);
}

function readVersion(file: string): string {
  const metadata = JSON.parse(readFileSync(path.join(repoRoot, file), "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string") throw new Error(`missing version in ${file}`);
  return metadata.version;
}

export async function buildMcpPlugin(target: McpPluginTarget): Promise<string> {
  const root = packageRoot(target);
  const outputDir = target === "omp" || target === "opencode" || target === "dsh"
    ? path.join(root, "mcp")
    : path.join(root, "dist", "mcp");
  const sourceExecutable = path.join(repoRoot, "packages/mcp/dist/stdio.js");
  if (!existsSync(sourceExecutable)) throw new Error(`missing M4 server bundle: ${sourceExecutable}`);

  mkdirSync(outputDir, { recursive: true });
  cpSync(sourceExecutable, path.join(outputDir, "stdio.js"));
  const buildInfo = createMcpBuildInfo(
    {
      pluginVersion: readVersion("package.json"),
      engineVersion: readVersion("packages/engine/package.json"),
      mcpVersion: readVersion("packages/mcp/package.json"),
    },
    target,
  );
  await Bun.write(path.join(outputDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);

  const sourceConfigDir = path.join(repoRoot, "mcp");
  if (target === "codex") {
    cpSync(path.join(sourceConfigDir, "codex-plugin.json"), path.join(root, "plugin.json"));
    cpSync(path.join(sourceConfigDir, "codex.json"), path.join(root, "mcp.json"));
  } else if (target !== "omp" && target !== "opencode" && target !== "dsh" && existsSync(sourceConfigDir)) {
    const configDir = path.join(root, "mcp");
    mkdirSync(configDir, { recursive: true });
    for (const filename of readdirSync(sourceConfigDir)) {
      if (filename.startsWith(`${target}-`) || filename === `${target}.json`) {
        cpSync(path.join(sourceConfigDir, filename), path.join(configDir, filename));
      }
    }
  }
  console.log(`build-mcp-plugins: ${target} -> ${path.relative(repoRoot, outputDir)}`);
  return root;
}

async function main(): Promise<void> {
  await buildMcpPlugin(parseTarget(process.argv.slice(2)));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`build-mcp-plugins: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

