import fs from "node:fs";
import path from "node:path";
import { MIN_BUN_VERSION, MIN_NODE_VERSION } from "@mstar-harness/engine";
import { compareSemver } from "./version-compare.js";
import type { HostTarget } from "./plugin-version-alignment.js";

type RuntimeKind = "node" | "bun";

type McpPackageLayout = {
  buildInfo: string;
  executable: string;
  versionManifest: string;
};

const MCP_PACKAGE_LAYOUTS: Record<HostTarget, McpPackageLayout> = {
  omp: { buildInfo: "mcp/build-info.json", executable: "mcp/stdio.js", versionManifest: "package.json" },
  opencode: { buildInfo: "mcp/build-info.json", executable: "mcp/stdio.js", versionManifest: "package.json" },
  dsh: { buildInfo: "mcp/build-info.json", executable: "mcp/stdio.js", versionManifest: "package.json" },
  cursor: { buildInfo: "mcp/bundles/cursor/dist/mcp/build-info.json", executable: "mcp/bundles/cursor/dist/mcp/stdio.js", versionManifest: ".cursor-plugin/plugin.json" },
  codex: { buildInfo: "mcp/bundles/codex/dist/mcp/build-info.json", executable: "mcp/bundles/codex/dist/mcp/stdio.js", versionManifest: ".codex-plugin/plugin.json" },
  kimi: { buildInfo: "mcp/bundles/kimi/dist/mcp/build-info.json", executable: "mcp/bundles/kimi/dist/mcp/stdio.js", versionManifest: ".kimi-plugin/plugin.json" },
  zcode: { buildInfo: "mcp/bundles/zcode/dist/mcp/build-info.json", executable: "mcp/bundles/zcode/dist/mcp/stdio.js", versionManifest: ".zcode-plugin/plugin.json" },
};

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

/** Inspect one target's packaged MCP server without starting a process or touching the artifact store. */
export function diagnoseMcpTarget(
  target: HostTarget,
  packageRoot: string,
  runtime: McpRuntime = actualRuntime(),
): McpTargetHealth {
  const layout = MCP_PACKAGE_LAYOUTS[target];
  const buildInfoPath = path.join(packageRoot, layout.buildInfo);
  const executablePath = path.join(packageRoot, layout.executable);
  const manifestPath = path.join(packageRoot, layout.versionManifest);
  const missing = [buildInfoPath, executablePath, manifestPath].filter((file) => !fs.existsSync(file));
  const runtimeFloor = runtime.kind === "bun" ? MIN_BUN_VERSION : MIN_NODE_VERSION;
  const runtimeError = compareSemver(runtime.version, runtimeFloor) < 0
    ? `${runtime.kind === "bun" ? "Bun" : "Node.js"} runtime ${runtime.version} is below the required ${runtimeFloor} floor.`
    : null;

  if (missing.length > 0) {
    return {
      target,
      status: "unavailable",
      location: buildInfoPath,
      runtimeFloor,
      errors: [
        `MCP package unavailable for ${target}; missing ${missing.map((file) => path.relative(packageRoot, file)).join(", ")}.`,
        ...(runtimeError === null ? [] : [runtimeError]),
      ],
      notes: [],
    };
  }

  const manifest = readJson(manifestPath);
  const buildInfo = readJson(buildInfoPath);
  const version = manifest?.version;
  const protocols = buildInfo?.supportedProtocols;
  const mismatch: string[] = [];
  if (manifest === null || buildInfo === null) {
    mismatch.push("package manifest or MCP build metadata is not valid JSON object data.");
  } else {
    if (typeof version !== "string" || version === "") mismatch.push("package manifest has no version.");
    for (const key of ["pluginVersion", "engineVersion", "mcpVersion"] as const) {
      if (typeof buildInfo[key] !== "string" || buildInfo[key] !== version) {
        mismatch.push(`${key} does not match packaged version ${String(version ?? "unknown")}.`);
      }
    }
    if (buildInfo.hostTarget !== target) mismatch.push(`hostTarget does not match ${target}.`);
    if (!Array.isArray(protocols) || protocols.length === 0 || protocols.some((item) => typeof item !== "string" || item.length === 0)) {
      mismatch.push("supportedProtocols is missing or invalid.");
    }
  }
  if (runtimeError !== null) mismatch.push(runtimeError);

  return {
    target,
    status: mismatch.length === 0 ? "aligned" : "mismatch",
    location: buildInfoPath,
    runtimeFloor,
    errors: mismatch,
    notes: mismatch.length === 0 ? [`MCP package metadata and files aligned for ${target} (${String(version)}).`] : [],
  };
}

/** Resolve a target's build/package root inside a checkout containing the seven-host plugin artifacts. */
export function mcpTargetPackageRoot(target: HostTarget, repositoryRoot: string): string {
  return target === "omp" || target === "opencode" || target === "dsh"
    ? path.join(repositoryRoot, "packages", target)
    : repositoryRoot;
}
