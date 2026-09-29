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

/**
 * The MCP-facing input shape: the command's own input plus the domain-owned
 * payload contracts, so a caller can construct a declared payload from
 * `tools/list` instead of guessing at an opaque field. Payload fields are
 * optional here and the value keeps its object form — a caller sends the
 * document, never a JSON-encoded string (MCP has no `--file` transport). The
 * handler decodes and validates through the same descriptor, so the published
 * schema and the enforced contract are one schema.
 *
 * A field the input schema already declares as a shape is left to that schema
 * (it is the family's own transport contract — the workflow `--file` path,
 * which must stay a pathname); a permissive `z.unknown()` placeholder gains the
 * domain-owned shape instead.
 */
export function mcpToolInputSchema(definition: CommandDefinition) {
  const input = definition.input;
  if (!(input instanceof z.ZodObject)) return input;
  const sessionId = definition.cli.options.some((option) => option.context === "sessionId");
  const composed = Object.fromEntries(
    Object.entries(definition.payloads ?? {}).flatMap(([field, descriptor]) => {
      const declared = input.shape[field];
      // Replace only a permissive placeholder (`z.unknown`): a shaped field is
      // the family's own transport contract (the workflow `--file` path), which
      // the payload descriptor must not overwrite with a document object.
      const placeholder = declared instanceof z.ZodUnknown
        || (declared instanceof z.ZodOptional && declared.unwrap() instanceof z.ZodUnknown);
      if (declared !== undefined && !placeholder) return [];
      return [[field, descriptor.schema.optional()] as const];
    }),
  );
  const extended = Object.keys(composed).length > 0 ? input.extend(composed) : input;
  if (definition.id === "judgment.review-advice") return extended.extend({ input: z.string().optional() });
  return sessionId ? extended.extend({ sessionId: z.string().optional() }) : extended;
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
      inputSchema: mcpToolInputSchema(definition),
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
