import { McpServer } from "@modelcontextprotocol/server";
import cliManifest from "../../package.json" with { type: "json" };
import { getCommandDefinitions, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";
import { registerMcpCommands, type ResolveContext } from "./register.js";

export function createMcpServer(
  resolveContext: ResolveContext,
  definitions: readonly CommandDefinition[] = getCommandDefinitions(),
): McpServer {
  const server = new McpServer({ name: "mstar-harness", version: cliManifest.version });
  const services: Array<{ close(): Promise<void> }> = [];
  const closeServices = async () => {
    const running = services.splice(0);
    const results = await Promise.allSettled(running.map(({ close }) => Promise.resolve().then(close)));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`MCP service ${index + 1} close failed`, result.reason);
      }
    });
  };
  server.server.onclose = () => { void closeServices(); };
  const createRequestContext: ResolveContext = async (definition, input, signal, requestServices, effects) => {
    const context = await resolveContext(definition, input, signal, requestServices, effects);
    const requestContext: InvocationContext = Object.freeze({
      ...context,
      versions: Object.freeze({ ...context.versions }),
      signal,
      effects,
    });
    return requestContext;
  };
  registerMcpCommands(server, definitions, createRequestContext, services);
  return server;
}
