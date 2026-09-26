import { McpServer } from "@modelcontextprotocol/server";
import { getCommandDefinitions, type CommandDefinition } from "@mstar-harness/commands";
import { registerMcpCommands, type ResolveContext } from "./register.js";

export function createMcpServer(
  resolveContext: ResolveContext,
  definitions: readonly CommandDefinition[] = getCommandDefinitions(),
): McpServer {
  const server = new McpServer({ name: "mstar-harness", version: "3.11.2" });
  registerMcpCommands(server, definitions, resolveContext);
  return server;
}
