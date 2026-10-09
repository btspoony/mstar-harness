import { refusalEnvelope } from "../envelope.js";
import { ISSUE_PAYLOAD_SCHEMAS } from "@mstar-harness/engine";
import type { IssuePayloadName, PayloadFieldSchema } from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema, getCommandDefinitions } from "../definitions.js";
import type { CommandDefinition, CommandEffect, CommandEnvelope, CommandRequirement } from "../types.js";

export type PayloadSchemaQuery = { type: string; fields: ({ name: string } & PayloadFieldSchema)[] };

export function getPayloadSchema(typeName: string): PayloadSchemaQuery {
  if (!Object.hasOwn(ISSUE_PAYLOAD_SCHEMAS, typeName)) {
    throw new RangeError(`Unknown payload type: ${typeName}`);
  }
  const fields = ISSUE_PAYLOAD_SCHEMAS[typeName as IssuePayloadName] as Record<string, PayloadFieldSchema>;
  return {
    type: typeName,
    fields: Object.entries(fields).map(([name, field]) => ({ name, ...field })),
  };
}

export type CommandSchemaDescriptor = {
  id: string;
  description: string;
  effects: readonly CommandEffect[];
  cli: CommandDefinition["cli"];
  requirements: readonly CommandRequirement[];
  required: readonly string[];
  defaults: Readonly<Record<string, unknown>>;
  input: unknown;
  payloadSchemas: Readonly<Record<string, unknown>>;
  payloadFields: Readonly<Record<string, readonly ({ name: string } & PayloadFieldSchema)[]>>;
};

/**
 * Refusal for a schema discovery query. The message names the grouped valid
 * selectors so the caller can re-query without dumping nested schemas.
 */
export class CommandSchemaSelectionError extends RangeError {
  readonly selectorKeys: readonly string[];

  constructor(message: string, selectorKeys: readonly string[]) {
    super(message);
    this.name = "CommandSchemaSelectionError";
    this.selectorKeys = selectorKeys;
  }
}
export function failure(id: string, error: CommandSchemaSelectionError): CommandEnvelope<never> {
  return refusalEnvelope({
    command: id,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message: error.message,
    details: { selectors: error.selectorKeys },
  });
}

export type CommandSchemaSelector = Readonly<{
  command?: string;
  family?: string;
  type?: string;
}>;

export type CommandFamilyMember = Readonly<{ id: string; description: string }>;

export type CommandSchemaSelection =
  | Readonly<{ kind: "command"; descriptor: CommandSchemaDescriptor }>
  | Readonly<{ kind: "family"; family: string; members: readonly CommandFamilyMember[] }>
  | Readonly<{ kind: "payload"; schema: PayloadSchemaQuery }>;

/**
 * One field table per command. Requirements carry route-verified sources:
 * explicit consumer metadata is published verbatim, the CLI adapter's argv
 * collection yields a `caller` hint on the `cli` route for every argument and
 * default-less option, and the session selector is `caller` on both routes:
 * CLI accepts the flag/environment fallback, while MCP reads per-call input
 * when the selected route requires identity; legacy routes can omit it, and
 * schema — its `required` array stays the separate enforcement fact. Explicit
 * entries override derived ones per name; anything unannotated stays unknown,
 * never all-optional.
 */
/**
 * `revision` is an integer CAS from the command's read surface, not an execution token.
 */
const EXPECT_TOKEN_KINDS: Readonly<Record<string, CommandRequirement["tokenKind"]>> = {
  "workflow.register": "root",
  "iteration.register": "root",
  "workflow.evidence": "workflow",
  "workflow.phase": "workflow",
  "workflow.lifecycle": "workflow",
  "workflow.execution-policy": "workflow",
  "workflow.integration-worktree": "workflow",
  "status.workflow-close": "workflow",
  "workflow.adopt-terminal": "revision",
  "issue.reopen": "revision",
  "plan.bind": "workflow",
  "plan.prepare": "plan",
  "session.recover": "workflow",
};

function commandRequirements(definition: CommandDefinition): readonly CommandRequirement[] {
  const tokenKind = definition.cli.options.some((option) => option.key === "expect")
    ? EXPECT_TOKEN_KINDS[definition.id]
      ?? (definition.id.startsWith("plan.") ? "plan" : definition.id.startsWith("workflow.") ? "workflow" : "none")
    : undefined;
  const explicit = definition.requirements ?? [];
  const overridden = new Set(explicit.map((entry) => `${entry.route}:${entry.name}`));
  const hinted = [...definition.cli.arguments, ...definition.cli.options.filter((option) => option.defaultValue === undefined && option.context === undefined)]
    .filter((entry) => !overridden.has(`cli:${entry.key}`))
    .map((entry) => ({
      name: entry.key,
      ownership: "caller" as const,
      route: "cli" as const,
      ...(entry.key === "expect" && tokenKind !== undefined ? { tokenKind } : {}),
    }));
  const requirements: CommandRequirement[] = [
    ...explicit,
    ...hinted,
  ];
  // Route-verified session facts from the adapters: CLI collects the session
  // selector from argv (with its environment fallback); MCP reads it from the
  // per-call input, while its context resolver supplies nothing.
  const sessionOption = definition.cli.options.find((option) => option.context === "sessionId");
  if (sessionOption !== undefined) {
    if (!overridden.has(`cli:${sessionOption.key}`)) {
      requirements.push({ name: sessionOption.key, ownership: "caller", route: "cli" });
    }
    if (!overridden.has(`mcp:${sessionOption.key}`)) {
      requirements.push({ name: sessionOption.key, ownership: "caller", route: "mcp", help: "when the selected route requires session identity, it must be supplied by the caller (host per call); legacy pre-activation routes do not require it, and legacy `plan bind --resume` refuses declared identity while ignoring ambient environment identity" });
    }
  }
  return requirements;
}

function commandSchemaDescriptor(definition: CommandDefinition): CommandSchemaDescriptor {
  const jsonSchema = definition.input.toJSONSchema() as Record<string, unknown>;
  const requiredFields = [
    ...(Array.isArray(jsonSchema.required) ? jsonSchema.required.filter((field): field is string => typeof field === "string") : []),
    ...definition.cli.arguments.filter((entry) => entry.required).map((entry) => entry.key),
    ...definition.cli.options.filter((entry) => entry.required).map((entry) => entry.key),
    ...(definition.requirements ?? []).filter((entry) => entry.required && entry.condition === undefined).map((entry) => entry.name),
  ];
  const required = [...new Set(requiredFields)];
  const requirements = commandRequirements(definition);
  const input = { ...jsonSchema, required, "x-mstar-requirements": requirements };
  const properties = jsonSchema.properties !== null && typeof jsonSchema.properties === "object"
    ? Object.entries(jsonSchema.properties)
    : [];
  const schemaDefaults = properties.flatMap(([key, property]) =>
    property !== null && typeof property === "object" && Object.hasOwn(property, "default")
      ? [[key, Reflect.get(property, "default")]]
      : [],
  );
  const defaults = Object.fromEntries([
    ...schemaDefaults,
    ...definition.cli.options.flatMap((option) => option.defaultValue === undefined ? [] : [[option.key, option.defaultValue]]),
  ]);
  return {
    id: definition.id,
    description: definition.description,
    effects: definition.effects,
    cli: definition.cli,
    requirements,
    required,
    defaults,
    input,
    payloadSchemas: Object.fromEntries(
      Object.entries(definition.payloads ?? {}).map(([name, descriptor]) => [name, descriptor.schema.toJSONSchema()]),
    ),
    payloadFields: Object.fromEntries(
      Object.entries(definition.payloads ?? {}).flatMap(([name, descriptor]) => descriptor.registryName === undefined
        ? []
        : [[name, Object.entries(ISSUE_PAYLOAD_SCHEMAS[descriptor.registryName as IssuePayloadName] as Record<string, PayloadFieldSchema>)
          .map(([fieldName, field]) => ({ name: fieldName, ...field }))]]),
    ),
  };
}

export function getCommandSchemas(definitions: readonly CommandDefinition[]): readonly CommandSchemaDescriptor[] {
  return definitions.map(commandSchemaDescriptor);
}

const SELECTOR_KEYS = ["command", "family", "type"] as const;
const SELECTOR_USAGE = "supply exactly one of: command (canonical command id), family (family name), type (issue payload type)";

/**
 * Bounded schema discovery over the canonical definitions. Family queries stay
 * compact (ids and descriptions only); only an exact command id expands the
 * nested input and payload schemas. Unknown selectors are refused with the
 * grouped valid selector names.
 */
export function selectCommandSchema(
  selector: CommandSchemaSelector,
  definitions: readonly CommandDefinition[],
): CommandSchemaSelection {
  const given = SELECTOR_KEYS.filter((key) => selector[key] !== undefined);
  if (given.length !== 1) {
    throw new CommandSchemaSelectionError(
      given.length === 0 ? `no schema selector supplied; ${SELECTOR_USAGE}` : `colliding schema selectors: ${given.join(", ")}; ${SELECTOR_USAGE}`,
      given,
    );
  }
  if (selector.command !== undefined) {
    const definition = definitions.find((entry) => entry.id === selector.command);
    if (definition === undefined) {
      throw new CommandSchemaSelectionError(
        `unknown command id ${JSON.stringify(selector.command)}; available families: ${[...new Set(definitions.map((entry) => entry.cli.path[0]!))].join(", ")}; query a family for its command ids`,
        ["command"],
      );
    }
    return { kind: "command", descriptor: commandSchemaDescriptor(definition) };
  }
  if (selector.family !== undefined) {
    const members = definitions
      .filter((entry) => entry.cli.path[0] === selector.family)
      .map((entry) => ({ id: entry.id, description: entry.description }));
    if (members.length === 0) {
      throw new CommandSchemaSelectionError(
        `unknown family ${JSON.stringify(selector.family)}; available families: ${[...new Set(definitions.map((entry) => entry.cli.path[0]!))].join(", ")}`,
        ["family"],
      );
    }
    return { kind: "family", family: selector.family, members };
  }
  const typeName = selector.type!;
  try {
    return { kind: "payload", schema: getPayloadSchema(typeName) };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new CommandSchemaSelectionError(
      `unknown payload type ${JSON.stringify(typeName)}; available payload types: ${Object.keys(ISSUE_PAYLOAD_SCHEMAS).join(", ")}`,
      ["type"],
    );
  }
}

type SchemaCommandInput = { type?: string; command?: string; family?: string };

export function getSchemaCommandDefinitions(): readonly CommandDefinition<SchemaCommandInput, unknown>[] {
  const id = "schema";
  // One branch per selector, each strict: the published JSON schema is an
  // anyOf with additionalProperties:false, so exactly-one is expressed in the
  // discoverable contract itself — `{}` or two selectors match no branch and
  // are refused at the input boundary with the same grouped guidance the
  // selection error carries.
  const input = z.union(
    [
      z.strictObject({ command: z.string().min(1) }),
      z.strictObject({ family: z.string().min(1) }),
      z.strictObject({ type: z.string().min(1) }),
    ],
    { error: () => SELECTOR_USAGE },
  );
  const definition: CommandDefinition<SchemaCommandInput, unknown> = {
    id,
    cli: {
      path: ["schema"],
      aliases: [],
      arguments: [{ key: "type", required: false, variadic: false }],
      options: [
        { key: "command", flags: "--command <id>", required: false },
        { key: "family", flags: "--family <name>", required: false },
      ],
    },
    input,
    output: commandEnvelopeSchema,
    effects: ["read"],
    description: "Print bounded command contracts: one leaf command schema, a compact family list, or one issue payload schema.",
    requirements: [
      { name: "type", ownership: "caller", route: "cli", help: "positional issue payload type" },
      { name: "command", ownership: "caller", route: "cli", help: "--command <id> leaf contract" },
      { name: "family", ownership: "caller", route: "cli", help: "--family <name> compact family list" },
      { name: "type", ownership: "caller", route: "mcp", help: "issue payload type field" },
      { name: "command", ownership: "caller", route: "mcp", help: "canonical command id field" },
      { name: "family", ownership: "caller", route: "mcp", help: "family name field" },
    ],
    async execute(input) {
      try {
        const selection = selectCommandSchema(input, getCommandDefinitions());
        const data = selection.kind === "payload" ? selection.schema : selection;
        return { version: 1, command: id, status: "ok", code: "schema.ok", exitCode: 0, data };
      } catch (error) {
        if (!(error instanceof CommandSchemaSelectionError)) throw error;
        return failure(id, error);
      }
    },
  };
  return [definition];
}
