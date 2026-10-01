import { ISSUE_PAYLOAD_SCHEMAS } from "@mstar-harness/engine";
import type { IssuePayloadName, PayloadFieldSchema } from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema, getCommandDefinitions } from "../definitions.js";
import type { CommandDefinition, CommandEffect, CommandRequirement } from "../types.js";

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
  input: unknown;
  payloadSchemas: Readonly<Record<string, unknown>>;
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
 * default-less option, and the session selector is `caller` on `cli` /
 * `derivable` on `mcp` (adapter fallback to the resolved context). Never
 * derived from the input schema — its `required` array stays the separate
 * enforcement fact. Explicit entries override derived ones per name; anything
 * unannotated stays unknown, never all-optional.
 */
function commandRequirements(definition: CommandDefinition): readonly CommandRequirement[] {
  const explicit = definition.requirements ?? [];
  const overridden = new Set(explicit.map((entry) => `${entry.route}:${entry.name}`));
  const hinted = [...definition.cli.arguments, ...definition.cli.options.filter((option) => option.defaultValue === undefined && option.context === undefined)]
    .filter((entry) => !overridden.has(`cli:${entry.key}`))
    .map((entry) => ({ name: entry.key, ownership: "caller" as const, route: "cli" as const }));
  const requirements: CommandRequirement[] = [...explicit, ...hinted];
  // Route-verified session facts from the adapters: the CLI action reads the
  // session selector from argv; the MCP handler falls back from the supplied
  // field to the resolved connection context.
  const sessionOption = definition.cli.options.find((option) => option.context === "sessionId");
  if (sessionOption !== undefined) {
    if (!overridden.has(`cli:${sessionOption.key}`)) {
      requirements.push({ name: sessionOption.key, ownership: "caller", route: "cli" });
    }
    if (!overridden.has(`mcp:${sessionOption.key}`)) {
      requirements.push({ name: sessionOption.key, ownership: "derivable", route: "mcp", help: "resolved from the MCP connection context when omitted" });
    }
  }
  return requirements;
}

function commandSchemaDescriptor(definition: CommandDefinition): CommandSchemaDescriptor {
  const jsonSchema = definition.input.toJSONSchema() as Record<string, unknown>;
  return {
    id: definition.id,
    description: definition.description,
    effects: definition.effects,
    cli: definition.cli,
    requirements: commandRequirements(definition),
    input: jsonSchema,
    payloadSchemas: Object.fromEntries(
      Object.entries(definition.payloads ?? {}).map(([name, descriptor]) => [name, descriptor.schema.toJSONSchema()]),
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
  const input = z.object({
    type: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    family: z.string().min(1).optional(),
  }).refine(
    (value) => SELECTOR_KEYS.filter((key) => value[key] !== undefined).length === 1,
    { message: SELECTOR_USAGE },
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
        return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: error.message };
      }
    },
  };
  return [definition];
}
