import type { McpServer } from "@modelcontextprotocol/server";
import type { CommandDefinition, InvocationContext } from "@mstar-harness/commands";
import { type McpEffects } from "./effects.js";
export type ResolveContext = (definition: CommandDefinition, input: unknown, signal: AbortSignal, services: Array<{
    close(): Promise<void>;
}>, effects: McpEffects) => InvocationContext | Promise<InvocationContext>;
export declare function mcpToolName(commandId: string): string;
export declare function registerMcpCommands(server: McpServer, definitions: readonly CommandDefinition[], resolveContext: ResolveContext, services?: Array<{
    close(): Promise<void>;
}>): void;
