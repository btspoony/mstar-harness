import { z } from "zod";
import type { CommandDefinition } from "./types.js";

const failureEnvelopeSchema = z.object({
  version: z.literal(1),
  command: z.string().min(1),
  status: z.enum(["refused", "error"]),
  code: z.string().min(1),
  exitCode: z.number().int().refine((code) => code !== 0),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const commandEnvelopeSchema = z.discriminatedUnion("status", [
  z.object({
    version: z.literal(1),
    command: z.string().min(1),
    status: z.literal("ok"),
    code: z.string().min(1),
    exitCode: z.literal(0),
    data: z.unknown(),
  }),
  failureEnvelopeSchema,
  z.object({
    version: z.literal(1),
    command: z.string().min(1),
    status: z.literal("usage"),
    code: z.string().min(1),
    exitCode: z.literal(2),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export class CommandDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandDefinitionError";
  }
}

function validateOne(definition: CommandDefinition): void {
  if (!definition.id || definition.id.trim() !== definition.id) {
    throw new CommandDefinitionError("Command id must be a non-empty trimmed string");
  }
  if (definition.cli.path.length === 0 || definition.cli.path.some((part) => part.trim() === "")) {
    throw new CommandDefinitionError(`${definition.id}: CLI path must contain non-empty segments`);
  }
  if (definition.cli.arguments.some((argument) => argument.key.trim() === "")) {
    throw new CommandDefinitionError(`${definition.id}: CLI argument keys must be non-empty`);
  }
  if (definition.cli.options.some((option) => option.key.trim() === "" || option.flags.trim() === "")) {
    throw new CommandDefinitionError(`${definition.id}: CLI options require keys and flags`);
  }

  const shape = definition.input.shape;
  const schemaKeys = Object.keys(shape).sort();
  const syntaxKeys = [
    ...definition.cli.arguments.map(({ key }) => key),
    ...definition.cli.options.map(({ key }) => key),
  ].sort();
  if (new Set(syntaxKeys).size !== syntaxKeys.length) {
    throw new CommandDefinitionError(`${definition.id}: CLI syntax contains duplicate input keys`);
  }
  if (schemaKeys.length !== syntaxKeys.length || schemaKeys.some((key, index) => key !== syntaxKeys[index])) {
    throw new CommandDefinitionError(`${definition.id}: CLI syntax keys must match input schema keys`);
  }
  if (!definition.output.safeParse({
    version: 1,
    command: definition.id,
    status: "ok",
    code: "command.ok",
    exitCode: 0,
    data: null,
  }).success) {
    throw new CommandDefinitionError(`${definition.id}: output schema must accept a valid success envelope`);
  }
}

export function validateCommandDefinitions(definitions: readonly CommandDefinition[]): void {
  const ids = new Set<string>();
  const cliSpellings = new Set<string>();
  const toolNames = new Set<string>();

  for (const definition of definitions) {
    validateOne(definition);
    if (ids.has(definition.id)) throw new CommandDefinitionError(`Duplicate command id: ${definition.id}`);
    ids.add(definition.id);

    const spellings = [definition.cli.path.join("."), ...definition.cli.aliases];
    for (const spelling of spellings) {
      if (cliSpellings.has(spelling)) throw new CommandDefinitionError(`Duplicate CLI spelling: ${spelling}`);
      cliSpellings.add(spelling);
    }

    const toolName = `mstar_${definition.id.replace(/[.-]/g, "_")}`;
    if (toolNames.has(toolName)) throw new CommandDefinitionError(`Duplicate MCP tool name: ${toolName}`);
    toolNames.add(toolName);
  }
}

const canonicalDefinitions: readonly CommandDefinition[] = [];
validateCommandDefinitions(canonicalDefinitions);

export function getCommandDefinitions(): readonly CommandDefinition[] {
  return canonicalDefinitions;
}
