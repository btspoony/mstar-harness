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
import { getCommandSchemas, getSchemaCommandDefinitions } from "./families/schema.js";


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
  return refusalEnvelope({
    command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message,
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
const commandSchemasById = new Map(getCommandSchemas(canonicalDefinitions).map((descriptor) => [descriptor.id, descriptor] as const));

export function getCommandDefinitions(): readonly CommandDefinition[] {
  return canonicalDefinitions;
}

/**
 * One safe structured fact per schema violation, in the CLI payload decoder's
 * diagnostic shape: field path, stable issue code, message and the first array
 * index where relevant. Never carries submitted values.
 */
function redactInputScalar(value: string): string {
  return redactSecrets(value).text
    .replace(/\[REDACTED [^\]\r\n]+\]/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9-]+\b/g, "[REDACTED]");
}

/**
 * Every scalar submitted anywhere in the input. An issue message can quote a
 * value that is NOT the one at the issue path — an `unrecognized_keys` issue
 * names the unknown key, a refinement quotes its own input — so sanitizing only
 * the value at the path leaves those copies in the emitted message. Object keys
 * are collected too: a strict object reports the offending key by name.
 */
function submittedScalars(input: unknown): string[] {
  const scalars: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      scalars.push(String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        scalars.push(key);
        visit(item);
      }
    }
  };
  visit(input);
  return scalars;
}

/**
 * A schema issue message with every submitted secret-shaped scalar replaced by
 * its redacted form. Benign scalars (numbers, ordinary words) redact to
 * themselves, so the message keeps its diagnostic value while a custom token
 * the pattern-based redactor does not recognize is never echoed to the caller.
 */
function issueMessageSanitizer(input: unknown): (message: string) => string {
  const replacements: Record<string, string> = {};
  for (const scalar of submittedScalars(input)) {
    const redacted = redactInputScalar(scalar);
    if (redacted !== scalar && replacements[scalar] === undefined) replacements[scalar] = redacted;
  }
  const scalars = Object.keys(replacements);
  const pattern = scalars.length === 0 ? undefined : new RegExp(scalars.map((scalar) =>
    scalar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|"), "g");
  return (message) => {
    const text = redactSecrets(message).text;
    return pattern === undefined ? text : text.replace(pattern, (scalar) => replacements[scalar] ?? scalar);
  };
}

function inputDiagnostic(
  issue: z.ZodError["issues"][number],
  sanitize: (message: string) => string,
  input: unknown,
): RefusalDiagnostic {
  const path = inputPath(issue);
  const index = issue.path.find((part) => typeof part === "number");
  const facts = rejectionFacts(issue, input);
  return {
    path,
    code: issue.code,
    message: sanitize(issue.message),
    expected: facts.expected,
    received: facts.received,
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
      redactInputScalar(String(value));
  return { path: inputPath(issue), expected, received };
}

export async function executeCommand(id: string, input: unknown, context: InvocationContext): Promise<CommandEnvelope> {
  const definition = canonicalDefinitions.find((entry) => entry.id === id);
  if (definition === undefined) {
    return { version: 1, command: id, status: "error", code: "command.unknown", exitCode: 1, message: `unknown command: ${id}` };
  }
  const isInputObject = input !== null && typeof input === "object" && !Array.isArray(input);
  const rawInput = isInputObject ? input as Record<string, unknown> : {};
  const contract = commandSchemasById.get(definition.id)!;
  let effectiveInput: unknown = input;
  if (isInputObject) {
    let effectiveObject = rawInput;
    for (const [key, value] of Object.entries(contract.defaults)) {
      if (effectiveObject[key] === undefined) {
        if (effectiveObject === rawInput) effectiveObject = { ...rawInput };
        effectiveObject[key] = value;
      }
    }
    effectiveInput = effectiveObject;
  }
  const effectiveRecord = isInputObject ? effectiveInput as Record<string, unknown> : {};
  const parsed = definition.input.safeParse(effectiveInput);
  const issues = parsed.success ? [] : parsed.error.issues;
  const sanitize = issueMessageSanitizer(effectiveInput);
  const diagnostics = issues.map((issue) => inputDiagnostic(issue, sanitize, effectiveInput));
  const selector = definition.cli.options.find((option) => option.context === "sessionId");
  const selectorValue = selector === undefined ? undefined : effectiveRecord[selector.key];
  const selectorInvalid = selectorValue !== undefined && (typeof selectorValue !== "string" || selectorValue.trim() === "");
  const selectorDiagnostic = selectorInvalid && selector !== undefined && !diagnostics.some((entry) => entry.path === selector.key)
    ? [{
        path: selector.key,
        code: "invalid_session_id",
        message: `${selector.flags.split(/[ <]/)[0]} must be a non-empty string`,
        expected: "non-empty string",
        received: typeof selectorValue === "string" ? JSON.stringify(selectorValue) : typeof selectorValue,
      }]
    : [];
  const conditionalRequired = contract.requirements.filter((entry) => {
    if (!entry.required || entry.condition === undefined) return false;
    const trigger = effectiveRecord[entry.condition.field];
    return entry.condition.equals !== undefined
      ? trigger === entry.condition.equals
      : entry.condition.present === false ? trigger === undefined : trigger !== undefined;
  });
  const required = [...new Set([...contract.required, ...conditionalRequired.map((entry) => entry.name)])];
  const missing = required.filter((key) => effectiveRecord[key] === undefined && !diagnostics.some((entry) => entry.path === key));
  const requiredDiagnostics = missing.map((key) => ({
    path: key,
    code: "required",
    message: `${key} is required`,
    expected: "present",
    received: "undefined",
  }));
  const allDiagnostics = [...diagnostics, ...requiredDiagnostics, ...selectorDiagnostic];
  if (!parsed.success || missing.length > 0 || selectorInvalid) {
    const issue = issues[0];
    const facts = issue === undefined ? undefined : rejectionFacts(issue, effectiveInput);
    const optionKey = issue?.path.map(String).join(".");
    const option = definition.cli.options.find((entry) => entry.key === optionKey);
    const rejected = facts !== undefined && facts.path !== "" ? {
      path: option?.flags.split(/[ <]/)[0] ?? facts.path,
      expected: facts.expected,
      received: facts.received,
    } : selectorDiagnostic[0] !== undefined ? {
      path: selector?.flags.split(/[ <]/)[0] ?? selectorDiagnostic[0].path,
      expected: selectorDiagnostic[0].expected,
      received: selectorDiagnostic[0].received,
    } : missing.length === 1 ? { path: missing[0]!, expected: "present", received: "undefined" } : undefined;
    const message = allDiagnostics.map((entry) => entry.message).join("; ");
    return refusalEnvelope({
      command: id, status: "usage", code: "command.invalid-input", exitCode: 2,
      message: sanitize(message),
      diagnostics: allDiagnostics,
      details: {
        required,
        defaults: contract.defaults,
        requirements: contract.requirements,
        conditionalRequirements: contract.requirements.filter((entry) => entry.condition !== undefined),
      },
      ...(rejected === undefined ? {} : { rejected }),
    });
  }
  const request = typeof selectorValue === "string" ? { ...context, sessionId: selectorValue } : context;
  try {
    const envelope = await definition.execute(parsed.data, request);
    if (!definition.output.safeParse(envelope).success) {
      return { version: 1, command: id, status: "error", code: "command.output-invalid", exitCode: 1, message: "handler returned an invalid envelope" };
    }
    if (envelope.status === "usage" || envelope.status === "refused") {
      return {
        ...envelope,
        details: {
          ...envelope.details,
          required,
          defaults: contract.defaults,
          requirements: contract.requirements,
          conditionalRequirements: contract.requirements.filter((entry) => entry.condition !== undefined),
        },
      };
    }
    return envelope;
  } catch (error) {
    if (request.signal.aborted) {
      return { version: 1, command: id, status: "error", code: "command.cancelled", exitCode: 1, message: "cancelled" };
    }
    return { version: 1, command: id, status: "error", code: "command.internal", exitCode: 1, message: error instanceof Error ? error.message : String(error) };
  }
}
