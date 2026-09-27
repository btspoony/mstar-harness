export declare const MCP_BUILD_INFO_FILENAME = "build-info.json";
export declare const SUPPORTED_MCP_PROTOCOLS: readonly ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export type McpBuildInfo = {
    pluginVersion: string;
    engineVersion: string;
    mcpVersion: string;
    hostTarget: string;
    supportedProtocols: readonly string[];
};
export declare function createMcpBuildInfo(versions: Pick<McpBuildInfo, "pluginVersion" | "engineVersion" | "mcpVersion">, hostTarget: string): McpBuildInfo;
