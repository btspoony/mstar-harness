import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "./types.js";
export declare const commandEnvelopeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    version: z.ZodLiteral<1>;
    command: z.ZodString;
    status: z.ZodLiteral<"ok">;
    code: z.ZodString;
    exitCode: z.ZodLiteral<0>;
    data: z.ZodUnknown;
}, z.core.$strip>, z.ZodObject<{
    version: z.ZodLiteral<1>;
    command: z.ZodString;
    status: z.ZodEnum<{
        refused: "refused";
        error: "error";
    }>;
    code: z.ZodString;
    exitCode: z.ZodNumber;
    message: z.ZodString;
    details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>, z.ZodObject<{
    version: z.ZodLiteral<1>;
    command: z.ZodString;
    status: z.ZodLiteral<"usage">;
    code: z.ZodString;
    exitCode: z.ZodLiteral<2>;
    message: z.ZodString;
    details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>], "status">;
export declare class CommandDefinitionError extends Error {
    constructor(message: string);
}
export declare function validateCommandDefinitions(definitions: readonly CommandDefinition[]): void;
export declare function getCommandDefinitions(): readonly CommandDefinition[];
export declare function executeCommand(id: string, input: unknown, context: InvocationContext): Promise<CommandEnvelope>;
