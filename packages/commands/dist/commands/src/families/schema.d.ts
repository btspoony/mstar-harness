import { ISSUE_PAYLOAD_SCHEMAS } from "@mstar-harness/engine";
import type { PayloadFieldSchema } from "@mstar-harness/engine";
import type { CommandDefinition } from "../types.js";
export type PayloadSchemaQuery = {
    type: string;
    fields: ({
        name: string;
    } & PayloadFieldSchema)[];
};
export declare function getPayloadSchema(typeName: string): PayloadSchemaQuery;
export type CommandSchemaDescriptor = {
    id: string;
    cli: CommandDefinition["cli"];
    input: unknown;
    payloadSchemas: typeof ISSUE_PAYLOAD_SCHEMAS;
};
export declare function getCommandSchemas(definitions: readonly CommandDefinition[]): readonly CommandSchemaDescriptor[];
export declare function getSchemaCommandDefinitions(): readonly CommandDefinition<{
    type: string;
}, unknown>[];
