import { McpServer } from "@modelcontextprotocol/server";
import { getCommandDefinitions, type CommandDefinition } from "@mstar-harness/commands";
import { registerMcpCommands, type ResolveContext } from "./register.js";

export function createMcpServer(
  resolveContext: ResolveContext,
  definitions: readonly CommandDefinition[] = getCommandDefinitions(),
): McpServer {
  const server = new McpServer({ name: "mstar-harness", version: "3.11.2" });
  const services: Array<{ close(): Promise<void> }> = [];
  const closeServices = async () => {
    const running = services.splice(0);
    await Promise.all(running.map(({ close }) => close()));
  };
  server.server.onclose = () => { void closeServices(); };
  registerMcpCommands(server, definitions, resolveContext, services);
  return server;
}
