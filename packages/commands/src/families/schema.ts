import { ISSUE_PAYLOAD_SCHEMAS } from "@mstar-harness/engine";
import type { IssuePayloadName, PayloadFieldSchema } from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../definitions.js";
import type { CommandDefinition } from "../types.js";

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
  cli: CommandDefinition["cli"];
  input: unknown;
  payloadSchemas: Readonly<Record<string, unknown>>;
};

export function getCommandSchemas(definitions: readonly CommandDefinition[]): readonly CommandSchemaDescriptor[] {
  return definitions.map((definition) => ({
    id: definition.id,
    cli: definition.cli,
    input: definition.input.toJSONSchema(),
    payloadSchemas: Object.fromEntries(
      Object.entries(definition.payloads ?? {}).map(([name, descriptor]) => [name, descriptor.schema.toJSONSchema()]),
    ),
  }));
}


export function getSchemaCommandDefinitions(): readonly CommandDefinition<{ type: string }, unknown>[] {
  const id = "schema";
  const definition: CommandDefinition<{ type: string }, unknown> = {
    id,
    cli: { path: ["schema"], aliases: [], arguments: [{ key: "type", required: true, variadic: false }], options: [] },
    input: z.object({ type: z.string().min(1) }),
    output: commandEnvelopeSchema,
    effects: ["read"],
    description: "Print the runtime field schema for one JSON payload type.",
    async execute(input) {
      if (!Object.hasOwn(ISSUE_PAYLOAD_SCHEMAS, input.type)) {
        return {
          version: 1,
          command: id,
          status: "usage",
          code: "command.invalid-input",
          exitCode: 2,
          message: `unknown payload type ${JSON.stringify(input.type)}; available: ${Object.keys(ISSUE_PAYLOAD_SCHEMAS).join(", ")}`,
        };
      }
      return { version: 1, command: id, status: "ok", code: "schema.ok", exitCode: 0, data: getPayloadSchema(input.type) };
    },
  };
  return [definition];
}
