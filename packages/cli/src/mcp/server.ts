import { McpServer } from "@modelcontextprotocol/server";
import cliManifest from "../../package.json" with { type: "json" };
import { getCommandDefinitions, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";
import { registerMcpCommands, type ResolveContext } from "./register.js";

export function createMcpServer(
  resolveContext: ResolveContext,
  definitions: readonly CommandDefinition[] = getCommandDefinitions(),
  onToolsRegistered?: (names: readonly string[]) => void,
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
  const createRequestContext: ResolveContext = async (definition, sessionId, signal, requestServices, effects, call) => {
    const context = await resolveContext(definition, sessionId, signal, requestServices, effects, call);
    const requestContext: InvocationContext = Object.freeze({
      ...context,
      versions: Object.freeze({ ...context.versions }),
      signal,
      effects,
    });
    return requestContext;
  };
  // Admission reads the declared defaults from the resolver this function
  // receives, so the wrapper must expose them too: registration sees only the
  // wrapper. Forward the live getters instead of construction snapshots so a
  // declared channel and a pinned root stay authoritative for the whole
  // connection.
  Object.defineProperty(createRequestContext, "defaultSessionId", {
    get: () => resolveContext.defaultSessionId,
    enumerable: true,
  });
  Object.defineProperty(createRequestContext, "defaultHarness", {
    get: () => resolveContext.defaultHarness,
    enumerable: true,
  });
  Object.defineProperty(createRequestContext, "identityLocked", {
    get: () => resolveContext.identityLocked === true,
    enumerable: true,
  });
  registerMcpCommands(server, definitions, createRequestContext, services, onToolsRegistered);
  return server;
}
