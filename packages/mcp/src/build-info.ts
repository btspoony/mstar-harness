export const MCP_BUILD_INFO_FILENAME = "build-info.json";

export const SUPPORTED_MCP_PROTOCOLS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export type McpBuildInfo = {
  pluginVersion: string;
  engineVersion: string;
  mcpVersion: string;
  hostTarget: string;
  supportedProtocols: readonly string[];
};

export function createMcpBuildInfo(
  versions: Pick<McpBuildInfo, "pluginVersion" | "engineVersion" | "mcpVersion">,
  hostTarget: string,
): McpBuildInfo {
  return { ...versions, hostTarget, supportedProtocols: SUPPORTED_MCP_PROTOCOLS };
}
