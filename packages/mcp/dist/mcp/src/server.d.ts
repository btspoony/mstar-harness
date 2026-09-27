import { McpServer } from "@modelcontextprotocol/server";
import { type CommandDefinition } from "@mstar-harness/commands";
import { type ResolveContext } from "./register.js";
export declare function createMcpServer(resolveContext: ResolveContext, definitions?: readonly CommandDefinition[]): McpServer;
