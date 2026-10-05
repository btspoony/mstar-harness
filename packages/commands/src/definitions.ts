import { refusalEnvelope, type RefusalDiagnostic } from "./envelope.js";
import { redactSecrets } from "@mstar-harness/engine/src/audit";
import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "./types.js";
import { getStatusCommandDefinitions } from "./families/status.js";
import { getCoordinationChecksCommandDefinitions } from "./families/coordination-checks.js";
import { getPersistCommandDefinitions } from "./families/persist.js";
import { getPlanCommandDefinitions } from "./families/plan.js";
import { getSessionCommandDefinitions } from "./families/session.js";
import { getWorkflowCommandDefinitions } from "./families/workflow.js";
import { getStoreCommandDefinitions } from "./families/store.js";
import { getExecutionCommandDefinitions } from "./families/execution.js";
import { getIssueCommandDefinitions } from "./families/issue.js";
import { getCatalogCommandDefinitions } from "./families/catalog.js";
import { getRoadmapCommandDefinitions } from "./families/roadmap.js";
import { getMilestoneCommandDefinitions } from "./families/milestone.js";
import { getSddCommandDefinitions } from "./families/sdd.js";
import { getValidationCommandDefinitions } from "./families/validation.js";
import { getAuditCommandDefinitions } from "./families/audit.js";
import { getPrReviewCommandDefinitions } from "./families/pr-review.js";
import { getJudgmentCommandDefinitions } from "./families/judgment.js";
import { getProcessCommandDefinitions } from "./families/process.js";

import { getDashboardCommandDefinitions } from "./families/dashboard.js";
import { getLocalCommandDefinitions } from "./families/local.js";
import { getReportCommandDefinitions } from "./families/report.js";
import { getSchemaCommandDefinitions } from "./families/schema.js";


const failureEnvelopeSchema = z.object({
  version: z.literal(1),
  command: z.string().min(1),
  status: z.enum(["refused", "error"]),
  code: z.string().min(1),
  exitCode: z.number().int().refine((code) => code !== 0),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export function usageEnvelope(id: string, message: string): CommandEnvelope<never> {
  const helpRoute = `mstar ${id.replaceAll(".", " ")} --help`;
  return refusalEnvelope({
    command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message,
    helpRoute, recovery: `Review ${helpRoute} and correct the reported input.`,
    diagnostics: [{ code: "command.invalid-input", message }],
  });
}

export const commandEnvelopeSchema = z.discriminatedUnion("status", [
  z.object({
    version: z.literal(1),
    command: z.string().min(1),
    status: z.literal("ok"),
    code: z.string().min(1),
    exitCode: z.literal(0),
    data: z.unknown(),
  }).passthrough(),
  failureEnvelopeSchema,
  z.object({
    version: z.literal(1),
    command: z.string().min(1),
    status: z.literal("usage"),
    code: z.string().min(1),
    exitCode: z.literal(2),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
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

  const syntaxKeys = [
    ...definition.cli.arguments.map(({ key }) => key),
    ...definition.cli.options.filter(({ context }) => context === undefined).map(({ key }) => key),
  ].sort();
  const contextKeys = definition.cli.options.filter(({ context }) => context !== undefined);
  if (contextKeys.some(({ context }) => context !== "sessionId")) {
    throw new CommandDefinitionError(`${definition.id}: CLI context options must name a supported invocation context`);
  }
  const allSyntaxKeys: Record<string, true> = {};
  for (const key of [...syntaxKeys, ...contextKeys.map(({ key }) => key)]) {
    if (allSyntaxKeys[key] === true) {
      throw new CommandDefinitionError(`${definition.id}: CLI syntax contains duplicate input or context keys`);
    }
    allSyntaxKeys[key] = true;
  }
  if (definition.input instanceof z.ZodObject) {
    const schemaKeys = Object.keys(definition.input.shape).sort();
    if (schemaKeys.length !== syntaxKeys.length || schemaKeys.some((key, index) => key !== syntaxKeys[index])) {
      throw new CommandDefinitionError(`${definition.id}: CLI syntax keys must match input schema keys`);
    }
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

const canonicalDefinitions: readonly CommandDefinition[] = [
  ...getStatusCommandDefinitions(),
  ...getPersistCommandDefinitions(),
  ...getCoordinationChecksCommandDefinitions(),
  ...getPlanCommandDefinitions(),
  ...getSessionCommandDefinitions(),
  ...getWorkflowCommandDefinitions(),
  ...getIssueCommandDefinitions(),
  ...getMilestoneCommandDefinitions(),
  ...getCatalogCommandDefinitions(),
  ...getRoadmapCommandDefinitions(),
  ...getStoreCommandDefinitions(),
  ...getExecutionCommandDefinitions(),
  ...getSddCommandDefinitions(),
  ...getAuditCommandDefinitions(),
  ...getValidationCommandDefinitions(),
  ...getPrReviewCommandDefinitions(),
  ...getProcessCommandDefinitions(),
  ...getJudgmentCommandDefinitions(),
  ...getDashboardCommandDefinitions(),
  ...getLocalCommandDefinitions(),
  ...getSchemaCommandDefinitions(),
  ...getReportCommandDefinitions(),
];
validateCommandDefinitions(canonicalDefinitions);

export function getCommandDefinitions(): readonly CommandDefinition[] {
  return canonicalDefinitions;
}

/**
 * One safe structured fact per schema violation, in the CLI payload decoder's
 * diagnostic shape: field path, stable issue code, message and the first array
 * index where relevant. Never carries submitted values.
 */
function inputDiagnostic(issue: z.ZodError["issues"][number]): RefusalDiagnostic {
  const path = issue.path.reduce((path: string, part: string | number | symbol) =>
    typeof part === "number" ? `${path}[${String(part)}]` : path === "" ? String(part) : `${path}.${String(part)}`,
  "");
  const index = issue.path.find((part) => typeof part === "number");
  return {
    path,
    code: issue.code,
    message: issue.message,
    ...(typeof index === "number" ? { index } : {}),
  };
}

function inputValueAtPath(input: unknown, path: readonly (string | number | symbol)[]): unknown {
  return path.reduce<unknown>((value, part) =>
    value !== null && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[part] : undefined,
  input);
}

function inputPath(issue: z.ZodError["issues"][number]): string {
  return issue.path.reduce((path: string, part: string | number | symbol) =>
    typeof part === "number" ? `${path}[${String(part)}]` : path === "" ? String(part) : `${path}.${String(part)}`,
  "");
}

function rejectionFacts(issue: z.ZodError["issues"][number], input: unknown): { path: string; expected: string; received: string } {
  const expected = issue.code === "invalid_type"
    ? issue.expected
    : issue.code === "invalid_value" && "values" in issue && Array.isArray(issue.values)
      ? issue.values.map(String).join(" | ")
      : issue.code === "too_small" && "minimum" in issue
        ? `${issue.origin} ${issue.inclusive ? ">=" : ">"} ${String(issue.minimum)}`
        : issue.code === "too_big" && "maximum" in issue
          ? `${issue.origin} ${issue.inclusive ? "<=" : "<"} ${String(issue.maximum)}`
          : issue.code === "unrecognized_keys"
            ? "recognized keys"
            : "valid value";
  const value = inputValueAtPath(input, issue.path);
  const received = value === undefined ? "undefined" : value === null ? "null" :
    typeof value === "object" ? Array.isArray(value) ? "array" : "object" :
      redactSecrets(String(value)).text.replace(/\[REDACTED [^\]\r\n]+\]/g, "[REDACTED]");
  return { path: inputPath(issue), expected, received };
}

export async function executeCommand(id: string, input: unknown, context: InvocationContext): Promise<CommandEnvelope> {
  const definition = canonicalDefinitions.find((entry) => entry.id === id);
  if (definition === undefined) {
    return { version: 1, command: id, status: "error", code: "command.unknown", exitCode: 1, message: `unknown command: ${id}` };
  }
  const rawInput = input !== null && typeof input === "object" ? input as Record<string, unknown> : {};
  const selector = definition.cli.options.find((option) => option.context === "sessionId");
  const selectorValue = selector === undefined ? undefined : rawInput[selector.key];
  if (selectorValue !== undefined && (typeof selectorValue !== "string" || selectorValue.trim() === "")) {
    return {
      version: 1,
      command: id,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: `${selector?.flags.split(/[ <]/)[0] ?? selector?.key} must be a non-empty string`,
    };
  }
  const parsed = definition.input.safeParse(input);
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.map(inputDiagnostic);
    const issue = parsed.error.issues[0];
    const facts = rejectionFacts(issue, input);
    const optionKey = issue.path.map(String).join(".");
    const option = definition.cli.options.find((entry) => entry.key === optionKey);
    const helpRoute = `mstar ${definition.cli.path.join(" ")} --help`;
    return refusalEnvelope({
      command: id, status: "usage", code: "command.invalid-input", exitCode: 2,
      message: parsed.error.issues.map((entry) => entry.message).join("; "),
      helpRoute, recovery: `Review ${helpRoute} and correct the reported input.`,
      diagnostics,
      rejected: {
        path: option?.flags.split(/[ <]/)[0] ?? facts.path,
        expected: facts.expected,
        received: facts.received,
      },
    });
  }
  const request = typeof selectorValue === "string" ? { ...context, sessionId: selectorValue } : context;
  try {
    const envelope = await definition.execute(parsed.data, request);
    if (!definition.output.safeParse(envelope).success) {
      return { version: 1, command: id, status: "error", code: "command.output-invalid", exitCode: 1, message: "handler returned an invalid envelope" };
    }
    return envelope;
  } catch (error) {
    if (request.signal.aborted) {
      return { version: 1, command: id, status: "error", code: "command.cancelled", exitCode: 1, message: "cancelled" };
    }
    return { version: 1, command: id, status: "error", code: "command.internal", exitCode: 1, message: error instanceof Error ? error.message : String(error) };
  }
}
