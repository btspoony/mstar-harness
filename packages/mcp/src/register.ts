import type { McpServer } from "@modelcontextprotocol/server";
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
  return definition.id === "judgment.review-advice" && definition.input instanceof z.ZodObject
    ? definition.input.extend({ input: z.string().optional() })
    : definition.input;
}

function handlerInput(definition: CommandDefinition, input: unknown): unknown {
  if (definition.id !== "judgment.review-advice" || input === null || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  if (record.input === undefined) return input;
  const { input: _payload, ...rest } = record;
  return { ...rest, stdin: true };
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
      const validated = await connectionEffects.withInput(input, async () => {
        const resolved = await resolveContext(definition, input, extra.mcpReq.signal, services, connectionEffects);
        const envelope = await definition.execute(invocationInput, { ...resolved, effects: connectionEffects });
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
