import { McpServer } from "@modelcontextprotocol/server";
import cliManifest from "../../package.json" with { type: "json" };
import {
  getCommandDefinitions,
  isCoordinatorSeatCommand,
  refusalEnvelope,
  type CommandDefinition,
  type CommandEnvelope,
  type InvocationContext,
} from "@mstar-harness/commands";
import { registerMcpCommands, type ResolveContext } from "./register.js";
import type { McpSeat } from "./stdio.js";

/** The named leaf-seat refusal: actual cause plus the supported recovery. */
function leafSeatRefusal(command: string): CommandEnvelope<never> {
  return refusalEnvelope({
    command,
    status: "refused",
    code: `${command}.leaf-seat`,
    exitCode: 1,
    message:
      "known leaf sessions cannot hold a workflow coordinator seat: they cannot bind or complete a plan, recover a session, " +
      "or write workflow delivery, lifecycle, adoption or ledger state",
    recovery:
      'This connection was launched with --seat leaf (the calling session header carries origin "subagent" or delegationDepth > 0). ' +
      "Coordinator-seat operations belong to the non-leaf coordinating session: run the operation there, or continue with the commands this seat may use (issue.add / issue.close / plan.prepare / plan.progress and every read).",
  });
}

/**
 * Apply the connection's seat to the definition list. A `leaf` seat keeps every
 * definition but replaces the coordinator-seat arm's execution with a named
 * refusal, so the tool stays discoverable and every call fails closed BEFORE
 * any engine round-trip or credential adoption — the shared admission still
 * validates the published input first, and nothing mutates.
 *
 * The refused set is NOT listed here: `isCoordinatorSeatCommand` derives it from
 * the command layer, the same authority the dsh host's `tools/pre-execute`
 * boundary reads (`coordinatorSeatCommandFor`), so the two layers cannot
 * refuse different commands.
 */
function seatDefinitions(
  definitions: readonly CommandDefinition[],
  seat: McpSeat | undefined,
): readonly CommandDefinition[] {
  if (seat !== "leaf") return definitions;
  return definitions.map((definition) =>
    isCoordinatorSeatCommand(definition.id)
      ? { ...definition, execute: async () => leafSeatRefusal(definition.id) }
      : definition,
  );
}

export function createMcpServer(
  resolveContext: ResolveContext,
  definitions: readonly CommandDefinition[] = getCommandDefinitions(),
  onToolsRegistered?: (names: readonly string[]) => void,
  seat?: McpSeat,
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
  registerMcpCommands(server, seatDefinitions(definitions, seat), createRequestContext, services, onToolsRegistered);
  return server;
}
