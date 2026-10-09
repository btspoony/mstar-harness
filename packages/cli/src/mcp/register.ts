import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { admitCommandInput, getCommandSchemas, isPayloadPlaceholder } from "@mstar-harness/commands";
import { z } from "zod";
import type { CommandAdmission, CommandDefinition, CommandSchemaDescriptor, InvocationContext } from "@mstar-harness/commands";
import { createMcpEffects, type McpEffects } from "./effects.js";
import { renderCommandContract, surfaceAssignmentRecovery } from "../command-adapter.js";
import { validateCommandOutcome } from "./outcome.js";
/**
 * Resolve the invocation context for one admitted call. It receives only the
 * immutable primitive session selector admission already validated — never the
 * handler value — so a resolver cannot reach or replace what the handler will
 * observe.
 */
export type ResolveContext = (
  definition: CommandDefinition,
  sessionId: string | undefined,
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
 * `tools/list` instead of guessing at an opaque field. Payload values keep
 * their object form, never JSON-encoded strings. Canonical unconditional
 * requirements are applied after composition; conditional alternatives and
 * safe defaults remain owned by shared admission. Publication reuses the
 * descriptor's JSON conversions and validation uses the composed Zod object.
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
function mcpInputContract(definition: CommandDefinition, descriptor: CommandSchemaDescriptor) {
  const input = definition.input;
  const jsonSchema = descriptor.input as Record<string, unknown>;
  if (!(input instanceof z.ZodObject)) return { schema: input, jsonSchema };
  const properties = { ...jsonSchema.properties as Record<string, Record<string, unknown>> };
  const composed: Record<string, z.core.$ZodType> = {};
  for (const [field, payload] of Object.entries(definition.payloads ?? {})) {
    if (!isPayloadPlaceholder(input.shape[field])) continue;
    composed[field] = payload.schema.optional();
    properties[field] = descriptor.payloadSchemas[field] as Record<string, unknown>;
  }
  const extended = Object.keys(composed).length === 0 ? input : input.safeExtend(composed);
  const selector = definition.cli.options.find((option) => option.context === "sessionId");
  const requiredShape: Record<string, z.core.$ZodType> = {};
  for (const field of descriptor.required) {
    if (field === selector?.key) continue;
    const declared = extended.shape[field];
    if (declared instanceof z.ZodOptional) requiredShape[field] = declared.unwrap();
  }
  let schema = Object.keys(requiredShape).length === 0 ? extended : extended.safeExtend(requiredShape);
  if (selector !== undefined) {
    schema = schema.safeExtend({ [selector.key]: z.string().optional() });
    properties[selector.key] = { type: "string" };
  }
  if (definition.id === "judgment.review-advice") {
    schema = schema.safeExtend({ input: z.string().optional() });
    properties.input = { type: "string" };
  }
  for (const [field, value] of Object.entries(descriptor.defaults)) {
    if (properties[field] !== undefined) properties[field] = { ...properties[field], default: value };
  }
  const required = selector === undefined ? descriptor.required : descriptor.required.filter((field) => field !== selector.key);
  const requirements = descriptor.requirements.filter((entry) => entry.route === "mcp");
  return {
    schema,
    jsonSchema: {
      ...jsonSchema,
      required,
      properties,
      "x-mstar-requirements": requirements,
    },
  };
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
    const descriptor = getCommandSchemas([definition])[0]!;
    const contract = mcpInputContract(definition, descriptor);
    // The SDK owns its isError/text rejection protocol. One Standard Schema
    // issue carries the complete safe refusal, not a lossy generic Zod message.
    // Successful validation hands the admitted value to the executor: no
    // second input parse or descriptor conversion in the handler.
    const inputSchema: StandardSchemaWithJSON<unknown, Extract<CommandAdmission, { success: true }>> = {
      "~standard": {
        version: 1,
        vendor: "mstar-harness",
        jsonSchema: { input: () => contract.jsonSchema, output: () => contract.jsonSchema },
        validate(input) {
          const admitted = admitCommandInput(definition, input, descriptor, contract.schema, (data) => handlerInput(definition, data));
          return admitted.success ? { value: admitted } : { issues: [{ message: JSON.stringify(admitted.envelope) }] };
        },
      },
    };
    server.registerTool(name, {
      description: renderCommandContract(definition, "mcp", descriptor),
      inputSchema,
      outputSchema: definition.output,
    }, async (admitted, extra) => {
      // The resolver and the context consume only the primitive session
      // selector; the handler value itself never leaves the capability.
      const resolved = await resolveContext(definition, admitted.sessionId, extra.mcpReq.signal, services, connectionEffects);
      const sessionId = admitted.sessionId ?? resolved.sessionId;
      const requestContext: InvocationContext = Object.freeze({
        ...resolved,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(resolved.host === undefined ? {} : { host: resolved.host }),
        versions: Object.freeze({ ...resolved.versions }),
        signal: extra.mcpReq.signal,
        effects: connectionEffects,
      });
      const validated = await connectionEffects.withInput(admitted.stdinText, requestContext, async () => {
        const envelope = await admitted.execute(requestContext);
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
