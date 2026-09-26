import { ISSUE_PAYLOAD_SCHEMAS } from "@mstar-harness/engine";
import type { IssuePayloadName, PayloadFieldSchema } from "@mstar-harness/engine";
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
  payloadSchemas: typeof ISSUE_PAYLOAD_SCHEMAS;
};

export function getCommandSchemas(definitions: readonly CommandDefinition[]): readonly CommandSchemaDescriptor[] {
  return definitions.map((definition) => ({
    id: definition.id,
    cli: definition.cli,
    input: definition.input.toJSONSchema(),
    payloadSchemas: ISSUE_PAYLOAD_SCHEMAS,
  }));
}
