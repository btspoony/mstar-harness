import type { McpServer } from "@modelcontextprotocol/server";
import { executeCommand, getCommandSchemas } from "@mstar-harness/commands";
import { z } from "zod";
import type { CommandDefinition, InvocationContext } from "@mstar-harness/commands";
import { createMcpEffects, type McpEffects } from "./effects.js";
import { renderCommandContract, surfaceAssignmentRecovery } from "../command-adapter.js";
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
 * A descriptor is composed only when its key is a declared field the family
 * left as a permissive `z.unknown()` placeholder: that placeholder gains the
 * domain-owned shape. A field the input schema already shapes stays that
 * schema (it is the family's own transport contract — the workflow `--file`
 * path, which must stay a pathname), and a key that names no input field at
 * all is never injected, because a tool field the handler does not read is a
 * capability `tools/list` must not advertise. Descriptor keys are not required
 * to be payload field names — `persist.write` keys its per-kind contracts by
 * `kind` value — so they are published by the `schema` family alone.
 */
export function mcpToolInputSchema(definition: CommandDefinition) {
  const input = definition.input;
  if (!(input instanceof z.ZodObject)) return input;
  const sessionId = definition.cli.options.some((option) => option.context === "sessionId");
  const composed = Object.fromEntries(
    Object.entries(definition.payloads ?? {}).flatMap(([field, descriptor]) => {
      const declared = input.shape[field];
      const placeholder = declared instanceof z.ZodUnknown
        || (declared instanceof z.ZodOptional && declared.unwrap() instanceof z.ZodUnknown);
      if (!placeholder) return [];
      return [[field, descriptor.schema.optional()] as const];
    }),
  );
  const requiredInputs = getCommandSchemas([definition])[0]?.required ?? [];
  const requiredShape = Object.fromEntries(requiredInputs.flatMap((field) => {
    const declared = extended.shape[field];
    if (declared === undefined || !(declared instanceof z.ZodOptional)) return [];
    return [[field, declared.unwrap()] as const];
  }));
  const required = Object.keys(requiredShape).length > 0 ? extended.extend(requiredShape) : extended;
  if (definition.id === "judgment.review-advice") return required.extend({ input: z.string().optional() });
  return sessionId ? required.extend({ sessionId: z.string().optional() }) : required;
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
  onToolsRegistered?: (names: readonly string[]) => void,
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
  onToolsRegistered?.([...names]);

  for (const { definition, name } of tools) {
    server.registerTool(name, {
      description: renderCommandContract(definition, "mcp"),
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
        return validateCommandOutcome(definition, surfaceAssignmentRecovery(definition.id, envelope));
      });
      return {
        content: [{ type: "text", text: JSON.stringify(validated) }],
        structuredContent: validated,
        isError: validated.status !== "ok",
      };
    });
  }
}
