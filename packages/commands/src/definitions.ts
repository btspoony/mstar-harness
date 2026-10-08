import { refusalEnvelope } from "./envelope.js";
import { decodeInputDiagnostics } from "./input-diagnostics.js";
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
import { getCommandSchemas, getSchemaCommandDefinitions, type CommandSchemaDescriptor } from "./families/schema.js";


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
 * A successfully admitted request, bound to the definition that admitted it.
 *
 * The capability (not the caller) owns the binding: `definition`, its
 * `contract`, the identity the definition's own selector resolved and the data
 * parsed from the caller's input are fixed when admission runs, and `execute`
 * runs that same definition's `execute` against that data. There is no public
 * function that accepts a caller-assembled definition/contract/admission
 * triple, and no post-admission mutator, so a success-shaped object or an
 * admission for a different schema cannot select a handler, an identity or a
 * different handler value: the only way to obtain an executable capability is
 * `admitCommandInput`.
 */
export type AdmittedCommand = Readonly<{
  /** The effective input admission parsed, after canonical defaults. */
  readonly input: unknown;
  /** The handler value, derived from the admission parse bound to the admitted definition's input schema. */
  readonly data: unknown;
  readonly required: readonly string[];
  readonly sessionId?: string;
  /** Execute the admitted request once against the bound definition. */
  execute(context: InvocationContext): Promise<CommandEnvelope>;
}>;

export type CommandAdmission =
  | ({ readonly success: true } & AdmittedCommand)
  | { readonly success: false; readonly envelope: CommandEnvelope<never> };

type AdmittedBindings = Readonly<{
  definition: CommandDefinition;
  contract: CommandSchemaDescriptor;
  input: unknown;
  data: unknown;
  required: readonly string[];
  sessionId?: string;
}>;

/** Execute one admission-produced capability, retaining the definition's own execution outcome. */
async function runAdmitted(bindings: AdmittedBindings, context: InvocationContext): Promise<CommandEnvelope> {
  const { definition, contract, data, required, sessionId } = bindings;
  const id = definition.id;
  // Overlay the admitted selector on a fresh frozen context: the caller's
  // object is never mutated, and the top-level context stays frozen.
  const request = sessionId === undefined ? context : Object.freeze({ ...context, sessionId });
  try {
    const envelope = await definition.execute(data, request);
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

/**
 * The one capability factory. The returned object's `execute` closes over the
 * bindings it was created from, so its behaviour is admission's, not the
 * caller's: nothing outside this module can produce an object the library
 * treats as an admitted request.
 */
function admittedCommand(bindings: AdmittedBindings): AdmittedCommand {
  return Object.freeze({
    input: bindings.input,
    data: bindings.data,
    required: bindings.required,
    ...(bindings.sessionId === undefined ? {} : { sessionId: bindings.sessionId }),
    execute(context: InvocationContext): Promise<CommandEnvelope> {
      return runAdmitted(bindings, context);
    },
  });
}

/**
 * Shared admission, including transport-composed schemas, without executing
 * effects.
 *
 * `shape` is the transport's handler-value projection (the MCP route removes
 * its context selectors and maps the judgment document to stdin). It runs once,
 * at admission, on the schema-validated value, and only its result is handed to
 * the definition — so the executed value is always derived from the one parse
 * this admission performed, never replaced afterwards. It cannot change the
 * definition, the contract or the resolved identity.
 */
export function admitCommandInput(
  definition: CommandDefinition,
  input: unknown,
  contract: CommandSchemaDescriptor,
  schema: z.ZodType = definition.input,
  shape: (data: unknown) => unknown = (data) => data,
): CommandAdmission {
  const isInputObject = input !== null && typeof input === "object" && !Array.isArray(input);
  const rawInput = isInputObject ? input as Record<string, unknown> : {};
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
  const parsed = schema.safeParse(effectiveInput);
  const diagnostics = parsed.success ? [] : decodeInputDiagnostics(parsed.error, effectiveInput);
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
  const allDiagnostics = diagnostics;
  allDiagnostics.push(...requiredDiagnostics, ...selectorDiagnostic);
  if (!parsed.success || missing.length > 0 || selectorInvalid) {
    const first = allDiagnostics[0];
    const facts = first?.path === undefined || first.expected === undefined || first.received === undefined
      ? undefined
      : { path: first.path, expected: first.expected, received: first.received };
    const option = definition.cli.options.find((entry) => entry.key === facts?.path);
    const rejected = facts !== undefined && facts.path !== "" ? {
      path: option?.flags.split(/[ <]/)[0] ?? facts.path,
      expected: facts.expected,
      received: facts.received,
    } : selectorDiagnostic[0] !== undefined ? {
      path: selector?.flags.split(/[ <]/)[0] ?? selectorDiagnostic[0].path,
      expected: selectorDiagnostic[0].expected,
      received: selectorDiagnostic[0].received,
    } : missing.length === 1 ? { path: missing[0]!, expected: "present", received: "undefined" } : undefined;
    return { success: false, envelope: refusalEnvelope({
      command: definition.id, status: "usage", code: "command.invalid-input", exitCode: 2,
      message: allDiagnostics.length === 1 ? allDiagnostics[0]!.message : "Invalid command input",
      diagnostics: allDiagnostics,
      details: {
        required,
        defaults: contract.defaults,
        requirements: contract.requirements,
        conditionalRequirements: contract.requirements.filter((entry) => entry.condition !== undefined),
      },
      ...(rejected === undefined ? {} : { rejected }),
    }) };
  }
  return {
    success: true,
    ...admittedCommand({
      definition, contract, input: effectiveInput, data: shape(parsed.data), required,
      ...(typeof selectorValue === "string" ? { sessionId: selectorValue } : {}),
    }),
  };
}

export async function executeCommand(id: string, input: unknown, context: InvocationContext): Promise<CommandEnvelope> {
  const definition = canonicalDefinitions.find((entry) => entry.id === id);
  if (definition === undefined) {
    return { version: 1, command: id, status: "error", code: "command.unknown", exitCode: 1, message: `unknown command: ${id}` };
  }
  const contract = commandSchemasById.get(definition.id)!;
  const admitted = admitCommandInput(definition, input, contract);
  if (!admitted.success) return admitted.envelope;
  return admitted.execute(context);
}