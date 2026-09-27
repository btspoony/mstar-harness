import type { McpServer } from "@modelcontextprotocol/server";
import { executeCommand } from "@mstar-harness/commands";
import { z } from "zod";
import type { CommandDefinition, InvocationContext } from "@mstar-harness/commands";
import { createMcpEffects, type McpEffects } from "./effects.js";
import { validateCommandOutcome } from "./outcome.js";
export type ResolveContext = (
  definition: CommandDefinition,
  input: unknown,
  signal: AbortSignal,
  services: Array<{ close(): Promise<void> }>,
  effects: McpEffects,
) => InvocationContext | Promise<InvocationContext>;

export function mcpToolName(commandId: string): string {
  return `mstar_${commandId.replace(/[.-]/g, "_")}`;
}

function inputSchema(definition: CommandDefinition) {
  if (!(definition.input instanceof z.ZodObject)) return definition.input;
  const sessionId = definition.cli.options.some((option) => option.context === "sessionId");
  return definition.id === "judgment.review-advice"
    ? definition.input.extend({ input: z.string().optional(), ...(sessionId ? { sessionId: z.string().optional() } : {}) })
    : sessionId ? definition.input.extend({ sessionId: z.string().optional() }) : definition.input;
}

function handlerInput(definition: CommandDefinition, input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  const contextKeys = definition.cli.options.filter((option) => option.context === "sessionId").map((option) => option.key);
  const normalized = { ...record };
  for (const key of contextKeys) delete normalized[key];
  if (definition.id === "judgment.review-advice" && normalized.input !== undefined) {
    delete normalized.input;
    normalized.stdin = true;
  }
  return normalized;
}

export function registerMcpCommands(
  server: McpServer,
  definitions: readonly CommandDefinition[],
  resolveContext: ResolveContext,
  services: Array<{ close(): Promise<void> }> = [],
): void {
  const connectionEffects = createMcpEffects(services);
  const tools = definitions.map((definition) => ({ definition, name: mcpToolName(definition.id) }));
  const names = new Set<string>();

  for (const { definition, name } of tools) {
    if (names.has(name)) {
      throw new Error(`MCP tool name collision: ${name} (from command ${definition.id})`);
    }
    names.add(name);
  }

  for (const { definition, name } of tools) {
    server.registerTool(name, {
      description: definition.description,
      inputSchema: inputSchema(definition),
      outputSchema: definition.output,
    }, async (input, extra) => {
      const invocationInput = handlerInput(definition, input);
      const resolved = await resolveContext(definition, input, extra.mcpReq.signal, services, connectionEffects);
      const record = input !== null && typeof input === "object" ? input as Record<string, unknown> : {};
      const selector = definition.cli.options.find((option) => option.context === "sessionId");
      const sessionId = selector === undefined ? resolved.sessionId : record[selector.key] as string | undefined ?? resolved.sessionId;
      const host = definition.id !== "report" && definition.input instanceof z.ZodObject
        && Object.hasOwn(definition.input.shape, "host") && typeof record.host === "string"
        ? record.host
        : resolved.host;
      const requestContext: InvocationContext = Object.freeze({
        ...resolved,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(host === undefined ? {} : { host }),
        versions: Object.freeze({ ...resolved.versions }),
        signal: extra.mcpReq.signal,
        effects: connectionEffects,
      });
      const validated = await connectionEffects.withInput(input, requestContext, async () => {
        const envelope = await executeCommand(definition.id, invocationInput, requestContext);
        return validateCommandOutcome(definition, envelope);
      });
      return {
        content: [{ type: "text", text: JSON.stringify(validated) }],
        structuredContent: validated,
        isError: validated.status !== "ok",
      };
    });
  }
}
