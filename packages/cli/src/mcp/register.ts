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
 *
 * `defaultSessionId` is the identity a launcher declared for every call (the
 * stdio server's `--identity-env` channel). It is read at admission so a
 * required session selector is satisfied by that declared default; the per-call
 * selector still wins, and an invalid default reaches the same safe-id guard as
 * any other identity because the resolver never repairs it.
 *
 * `defaultHarness` is the root a launcher pinned for every call (the stdio
 * server's `--harness` channel). Commands that resolve their own root from an
 * `input.harness` field never read `controlRoot`, so admission fills that
 * field from this default when the call left it unset or blank; an explicit
 * non-blank per-call value still wins.
 */
export type ResolveContext = {
  (
    definition: CommandDefinition,
    sessionId: string | undefined,
    signal: AbortSignal,
    services: Array<{ close(): Promise<void> }>,
    effects: McpEffects,
  ): InvocationContext | Promise<InvocationContext>;
  readonly defaultSessionId?: string;
  readonly defaultHarness?: string;
};

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

/**
 * A launcher-pinned root is only a default for a field the tool publishes: an
 * unset `input.harness` is filled from `defaultHarness` when the tool's declared
 * input schema advertises `harness`, and an explicit per-call value is never
 * overridden. A blank or whitespace-only value is not an override: the engine's
 * own root resolution treats it as absent, so treating it as explicit here
 * would silently fall back to the cwd probe. A tool that names no such field
 * receives nothing.
 */
function declaresHarness(contract: { jsonSchema: Record<string, unknown> }): boolean {
  const properties = contract.jsonSchema.properties;
  return properties !== null && typeof properties === "object" && Object.hasOwn(properties, "harness");
}

function handlerInput(definition: CommandDefinition, input: unknown, defaultHarness: string | undefined): unknown {
  if (input === null || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  const contextKeys = definition.cli.options.filter((option) => option.context === "sessionId").map((option) => option.key);
  const normalized = { ...record };
  for (const key of contextKeys) delete normalized[key];
  const explicit = typeof normalized.harness === "string" && normalized.harness.trim() !== "";
  if (defaultHarness !== undefined && !explicit) normalized.harness = defaultHarness;
  return normalized;
}

/**
 * Normalize a blank `harness` BEFORE the tool schema runs. `handlerInput` fills
 * an absent value after admission has already parsed the input, so a `min(1)`
 * harness schema would refuse `""` as a usage error while a bare optional-string
 * schema would accept it — the same call judged differently by two families
 * that resolve the same root. Writing the pinned default over a blank value at
 * the earliest seam makes both uniform, and an explicit non-blank value is
 * untouched. The caller's object is never mutated: a shallow copy carries the
 * normalized field.
 */
function normalizedBlankHarness(input: unknown, defaultHarness: string | undefined): unknown {
  if (defaultHarness === undefined || input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (typeof record.harness !== "string" || record.harness.trim() !== "") return input;
  return { ...record, harness: defaultHarness };
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
    const harnessDefault = declaresHarness(contract);
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
          const defaultSessionId = resolveContext.defaultSessionId;
          const defaultHarness = harnessDefault ? resolveContext.defaultHarness : undefined;
          const admitted = admitCommandInput(
            definition,
            normalizedBlankHarness(input, defaultHarness),
            descriptor,
            contract.schema,
            (data) => handlerInput(definition, data, defaultHarness),
            defaultSessionId === undefined ? undefined : { sessionId: defaultSessionId },
          );
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
