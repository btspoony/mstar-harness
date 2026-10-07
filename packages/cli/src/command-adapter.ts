import { spawn } from "node:child_process";
import { Command, CommanderError } from "commander";
import { refusalEnvelope } from "@mstar-harness/commands";
import {
  executeCommand,
  getCommandDefinitions,
  getCommandSchemas,
  spawnProcess,
  startDashboard,
  type CommandDefinition,
  type CommandEnvelope,
  type CommandEffects,
  type InvocationContext,
} from "@mstar-harness/commands";
import {
  assertSafeSessionId,
  decodeExecutionSessionRef,
  validateExecutionIdentity,
  type ExecutionIdentity,
} from "@mstar-harness/engine";
import { captureSddEvidenceFromFile, verifySddEvidence } from "./sdd-evidence.js";
import { detectInstalledPluginVersion } from "./plugin-version-alignment";
import type { Scope, Target } from "./types";

export function usageEnvelope(command: string, message: string, details?: Record<string, unknown>): CommandEnvelope {
  const diagnostics = Array.isArray(details?.diagnostics) ? details.diagnostics as Array<Record<string, unknown> & { path?: string; code: string; message: string; helpRoute?: string }> : [];
  const rootCommand = command === "mstar";
  const route = diagnostics.find((entry) => entry.helpRoute !== undefined)?.helpRoute ??
    (rootCommand ? "mstar --help" : `mstar ${command.replaceAll(".", " ")} --help`);
  const diagnostic = diagnostics.find((entry) => entry.usage !== undefined);
  const recoveryUsage = typeof diagnostic?.usage === "string" ? ` Correct usage: ${diagnostic.usage}.` : "";
  const rejected = diagnostics.find((entry) => entry.path !== undefined && entry.expected !== undefined && entry.received !== undefined);
  return refusalEnvelope({
    command, status: "usage", code: "command.invalid-input", exitCode: 2, message,
    helpRoute: route, recovery: `Review ${route} and correct the reported input.${recoveryUsage}`, diagnostics,
    ...(rejected === undefined ? {} : { rejected: { path: String(rejected.path), expected: String(rejected.expected), received: String(rejected.received) } }),
    ...(details === undefined ? {} : { details }),
  });
}

export function writeEnvelope(envelope: CommandEnvelope, signal?: NodeJS.Signals): void {
  const exitCode = envelope.code === "judgment.cancelled" && signal === "SIGTERM" ? 143 : envelope.exitCode;
  console.log(JSON.stringify({ ...envelope, exitCode }));
  process.exitCode = exitCode;
}

export function commandIdFromArgv(argv: readonly string[]): string {
  const tokens = argv.slice(2).filter((token) => token !== "--");
  const commandTokens = tokens.slice(0, tokens.findIndex((token) => token.startsWith("-")) < 0
    ? tokens.length
    : tokens.findIndex((token) => token.startsWith("-")));
  const definition = getCommandDefinitions()
    .filter((candidate) => candidate.cli.path.every((part, index) => commandTokens[index] === part))
    .sort((left, right) => right.cli.path.length - left.cli.path.length)[0];
  if (definition !== undefined) return definition.cli.path.join(".");
  return commandTokens.length === 0 ? "mstar" : commandTokens.join(".");
}

export function mapParserError(error: unknown, argv: readonly string[]): CommandEnvelope | null {
  if (!(error instanceof CommanderError) || error.exitCode === 0) return null;
  const command = commandIdFromArgv(argv);
  return usageEnvelope(command, error.message, { diagnostics: [parserDiagnostic(error, argv)] });
}

/**
 * Resolve parser failures to stable fields only when argv identifies the
 * rejected option from the command's own definition.
 */
function parserDiagnostic(error: CommanderError, argv: readonly string[]): Record<string, unknown> {
  const command = commandIdFromArgv(argv);
  const definition = getCommandDefinitions().find((entry) => entry.id === command);
  const field = parserField(error, argv, definition);
  const helpRoute = cliHelpRoute(argv);
  const usage = error.code === "commander.excessArguments" && definition !== undefined
    ? renderCliUsage(definition)
    : undefined;
  const option = field === undefined || definition === undefined
    ? undefined
    : definition.cli.options.find((candidate) => candidate.flags.split(/[ ,|]+/).some((flag) => flag.split(/[ =]/)[0] === field));
  const expected = option === undefined ? undefined :
    hasType(optionJsonSchema(definition!, option.key), "boolean") ? "boolean flag" : "option value";
  const rawArgs = argv.slice(2);
  const rejectedValue = field === undefined ? undefined :
    rawArgs.find((token) => option?.flags.split(/[ ,|]+/).some((flag) => flag.split(/[ =]/)[0] === token));
  return {
    ...(field === undefined ? {} : {
      path: field,
      ...(expected === undefined ? {} : { expected }),
      ...(rejectedValue === undefined ? {} : { received: rejectedValue }),
    }),
    code: error.code,
    message: error.message,
    ...(usage === undefined ? {} : { usage }),
    ...(helpRoute === undefined ? {} : { helpRoute }),
  };
}

function parserField(
  error: CommanderError,
  argv: readonly string[],
  definition?: CommandDefinition,
): string | undefined {
  const quoted = /'([^']+)'/.exec(error.message)?.[1];
  if (error.code === "commander.excessArguments" && definition !== undefined) {
    const rawArgs = argv.slice(2);
    const terminator = rawArgs.indexOf("--");
    const args = terminator === -1 ? rawArgs : rawArgs.slice(0, terminator);
    const options = definition.cli.options;
    for (let index = 0; index < args.length; index++) {
      const token = args[index]!;
      const option = options.find((candidate) => candidate.flags.split(/[ ,|]+/).some((flag) => flag.split(/[ =]/)[0] === token));
      if (option !== undefined && !hasType(optionJsonSchema(definition, option.key), "boolean") &&
        args[index + 1] !== undefined && options.some((candidate) =>
          candidate.flags.split(/[ ,|]+/).some((flag) => flag.split(/[ =]/)[0] === args[index + 1]))) {
        return token;
      }
    }
  }
  if (quoted === undefined) return undefined;
  if (error.code === "commander.missingArgument") return quoted;
  if (error.code === "commander.missingMandatoryOptionValue") return optionKey(quoted);
  if (error.code === "commander.optionMissingArgument") return optionKey(quoted);
  return undefined;
}

function renderCliUsage(definition: CommandDefinition): string {
  const options = definition.cli.options.map((option) => cliOptionFlags(definition, option)).join(" ");
  const args = definition.cli.arguments.map((argument) =>
    argument.required ? `<${argument.key}>` : `[${argument.key}]`,
  ).join(" ");
  return `Usage: mstar ${definition.cli.path.join(" ")}${options === "" ? "" : ` ${options}`}${args === "" ? "" : ` ${args}`}`;
}


function cliHelpRoute(argv: readonly string[]): string | undefined {
  const command = commandIdFromArgv(argv);
  if (command === "mstar") return "mstar --help";
  const definition = getCommandDefinitions().find((entry) => entry.id === command);
  return definition === undefined ? "mstar --help" : `mstar ${definition.cli.path.join(" ")} --help`;
}

function optionKey(flags: string): string {
  const long = flags.split(/[ ,|]+/).find((part) => part.startsWith("--")) ?? flags;
  const name = long.replace(/^--/, "").split(/[ =]/)[0] ?? long;
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function optionJsonSchema(definition: CommandDefinition, key: string): Record<string, unknown> {
  const root = definition.input.toJSONSchema() as Record<string, unknown>;
  const properties = root.properties;
  return properties !== null && typeof properties === "object"
    ? ((properties as Record<string, Record<string, unknown>>)[key] ?? {})
    : {};
}

function hasType(schema: Record<string, unknown>, type: string): boolean {
  if (schema.type === type || (type === "number" && schema.type === "integer")) return true;
  for (const key of ["anyOf", "oneOf"]) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives) && alternatives.some(
      (part) => part !== null && typeof part === "object" && hasType(part as Record<string, unknown>, type),
    )) return true;
  }
  return false;
}

function cliOptionFlags(definition: CommandDefinition, option: CommandDefinition["cli"]["options"][number]): string {
  if (!hasType(optionJsonSchema(definition, option.key), "boolean")) return option.flags;
  return option.flags.replace(/\s+(?:<[^>]+>|\[[^\]]+\])/g, "");
}

/**
 * One rendered contract per command for both publication routes, built from
 * the same descriptor table the `schema` family serves: no adapter-owned field
 * lists. Ownership groups only name verified metadata; fields without it stay
 * implicit in the route's own surface (CLI arguments/options, MCP inputSchema).
 * Payload descriptor keys are advertised as fields only when they are declared
 * input fields; kind-keyed contracts are labeled separately.
 */
export function renderCommandContract(definition: CommandDefinition, route: "cli" | "mcp"): string {
  const descriptor = getCommandSchemas([definition])[0]!;
  const lines = [definition.description, `Command id: ${descriptor.id}`, `Effects: ${descriptor.effects.join(", ")}`];
  if (route === "cli" && definition.cli.options.some((option) => option.context === "sessionId")) {
    lines.push("Session identity resolves --session-id first, then the launched session's minted MSTAR_EXECUTION_IDENTITY (the active-route caller identity, validated against the addressed workflow/role/plan), then the ambient MSTAR_HOST_SESSION_ID (empty/whitespace ignored), else unset; for active token-authorized writes it is attribution, not authorization. The legacy pre-activation coordinator bootstrap (`plan bind --coordinator`) requires an explicit --session-id and rejects the environment value. Legacy `plan bind --resume` ignores ambient environment identity and refuses a declared identity.");
  }
  if (route === "mcp") {
    // The CLI route prints this same syntax as commander's Usage line, built
    // from the same `cli` table; MCP descriptions carry it explicitly.
    const argumentTokens = descriptor.cli.arguments
      .map((argument) => argument.required
        ? ` <${argument.key}${argument.variadic ? "..." : ""}>`
        : ` [${argument.key}${argument.variadic ? "..." : ""}]`)
      .join("");
    const optionTokens = descriptor.cli.options.map((option) => ` ${option.flags}`).join("");
    lines.push(`CLI: mstar ${descriptor.cli.path.join(" ")}${argumentTokens}${optionTokens}`);
  }
  for (const [ownership, label] of [["caller", "Caller-supplied"], ["derivable", "Derived"]] as const) {
    const entries = descriptor.requirements.filter((entry) => entry.ownership === ownership && entry.route === route);
    if (entries.length === 0) continue;
    const parts = entries.map((entry) => {
      const description = [entry.help, entry.constraint === undefined ? undefined : `constraint: ${entry.constraint}`]
        .filter((value): value is string => value !== undefined)
        .join("; ");
      return description === "" ? entry.name : `${entry.name} (${description})`;
    });
    lines.push(`${label}: ${parts.join(", ")}`);
  }
  // Payload publication keeps the descriptor convention: only keys that are
  // declared input fields are advertised as fields (the handler accepts them
  // on both routes). Kind-keyed contracts (e.g. `persist.write`, whose keys are
  // `kind` values) exist only to publish per-kind domain schemas — they stay
  // neutrally labeled and make no input-field or transport claim.
  const inputSchema: unknown = descriptor.input;
  const properties = inputSchema !== null && typeof inputSchema === "object" && "properties" in inputSchema
    ? inputSchema.properties
    : undefined;
  const inputProperties = properties !== null && typeof properties === "object" ? new Set(Object.keys(properties)) : new Set<string>();
  const payloadKeys = Object.keys(descriptor.payloadSchemas);
  const payloadFields = payloadKeys.filter((key) => inputProperties.has(key));
  const payloadContracts = payloadKeys.filter((key) => !inputProperties.has(key));
  if (payloadFields.length > 0) {
    lines.push(`Payload fields: ${payloadFields.join(", ")}`);
    if (route === "cli") lines.push("Payload field values arrive as JSON strings and are decoded against the declared schema.");
  }
  if (payloadContracts.length > 0) {
    lines.push(`Payload contracts: ${payloadContracts.join(", ")} (keyed separately from input fields; resolve their shapes through the schema command)`);
  }
  return lines.join("\n");
}

function decodeCliOptions(definition: CommandDefinition, input: Record<string, unknown>): Record<string, unknown> {
  const decoded = { ...input };
  for (const option of definition.cli.options) {
    const value = decoded[option.key];
    const schema = optionJsonSchema(definition, option.key);
    if (Array.isArray(value) && option.key in (definition.payloads ?? {})) {
      // A repeated (variadic) payload option collects scalar occurrences. Each
      // occurrence stays one literal entry — except an occurrence that is
      // itself JSON: an explicit array still decodes to its members, and an
      // object (or malformed JSON) becomes a non-string element so the
      // declared schema refuses it exactly as the single-value form does.
      const flattened: unknown[] = [];
      for (const entry of value) {
        if (typeof entry === "string" && /^[[{]/.test(entry.trimStart())) {
          try {
            const parsed: unknown = JSON.parse(entry);
            if (Array.isArray(parsed)) {
              flattened.push(...parsed);
              continue;
            }
            flattened.push(parsed);
            continue;
          } catch {
            flattened.push(undefined); // indexed schema refusal, never a literal path
            continue;
          }
        }
        flattened.push(entry);
      }
      decoded[option.key] = flattened;
      continue;
    }
    if (typeof value === "string" && hasType(schema, "array")) {
      if (value.trimStart().startsWith("[") || value.trimStart().startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) {
            decoded[option.key] = parsed;
            continue;
          }
          // An object is pre-wrapped only for plain list options. A payload
          // field's document value stays verbatim — decodePayloadInputs parses
          // and validates it against the declared schema, and pre-wrapping a
          // wrong-typed document would fabricate a one-element member.
          if (parsed !== null && typeof parsed === "object" && !(option.key in (definition.payloads ?? {}))) {
            decoded[option.key] = [parsed];
          }
          continue;
        } catch {
          // Keep malformed JSON-looking input intact so the command decoder rejects it.
          continue;
        }
      }
      // A payload field's lone string value is ONE literal entry: the payload
      // document is opaque (a worktree path may contain a comma), and silently
      // comma-splitting it fabricates extra asserted paths — with --apply a
      // fragment can name an unintended eligible worktree. Only an explicit
      // JSON array introduces multiple entries. Plain list options keep the
      // comma-list convenience.
      if (option.key in (definition.payloads ?? {})) {
        decoded[option.key] = [value];
        continue;
      }
      decoded[option.key] = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      continue;
    }
    if (typeof value !== "string" || !hasType(schema, "number")) continue;
    if (!/^-?(?:\d+|\d*\.\d+)$/.test(value)) continue;
    const number = Number(value);
    if (Number.isFinite(number)) decoded[option.key] = number;
  }
  return decoded;
}
function decodePayloadInputs(
  definition: CommandDefinition,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; diagnostics: readonly Record<string, unknown>[] } {
  if (definition.payloads === undefined) return { input, diagnostics: [] };
  const decoded = { ...input };
  const diagnostics: Record<string, unknown>[] = [];
  for (const [field, descriptor] of Object.entries(definition.payloads)) {
    if (!Object.hasOwn(decoded, field)) continue;
    let value = decoded[field];
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
        decoded[field] = value;
      } catch {
        diagnostics.push({ path: field, code: "invalid_json", message: `${field} must contain valid JSON` });
        continue;
      }
    }
    const parsed = descriptor.schema.safeParse(value);
    if (parsed.success) {
      decoded[field] = parsed.data;
      continue;
    }
    for (const issue of parsed.error.issues) {
      const suffix = issue.path.reduce((path: string, part: string | number | symbol) =>
        typeof part === "number" ? `${path}[${String(part)}]` : `${path}.${String(part)}`,
      "");
      const path = `${field}${suffix}`;
      const index = issue.path.find((part) => typeof part === "number");
      diagnostics.push({
        path,
        code: issue.code,
        message: issue.message,
        ...(typeof index === "number" ? { index } : {}),
      });
    }
  }
  return { input: decoded, diagnostics };
}
function collectInput(definition: CommandDefinition, args: readonly unknown[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  definition.cli.arguments.forEach((argument, index) => {
    const value = args[index];
    if (value !== undefined) input[argument.key] = value;
  });
  const options = args[definition.cli.arguments.length];
  if (options !== null && typeof options === "object") {
    for (const [key, value] of Object.entries(options)) {
      const option = definition.cli.options.find((entry) => optionKey(entry.flags) === key);
      if (option !== undefined && value !== undefined) {
        input[option.key] = option.variadic && !Array.isArray(value) ? [value] : value;
      }
    }
  }
  return input;
}

/**
 * One malformed launcher-minted identity transport. The launcher (`session.run`,
 * the managed host gates) writes `MSTAR_EXECUTION_IDENTITY` with the engine's own
 * `serializeExecutionValue`, so a value that is not one valid §3.1 tuple is a
 * broken launch: it is refused before any command runs, never repaired, guessed
 * or silently downgraded to the ambient host identity.
 */
export class CliIdentityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CliIdentityError";
  }
}

/**
 * One parsed JSON value that is one §3.1 identity tuple. This is transport
 * shaping only — the primitives must be present in their declared form; the
 * engine's own `validateExecutionIdentity` below still owns every semantic rule
 * (non-empty ids, the safe-session-id guard), so no second identity framework is
 * created.
 */
function isMintedTuple(value: unknown): value is ExecutionIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (record.source === "host" || record.source === "local")
    && typeof record.sessionId === "string" && typeof record.workflowId === "string"
    && record.role === "coordinator";
}

/**
 * Parse and validate one `MSTAR_EXECUTION_IDENTITY` transport through the
 * engine's own identity validator (`validateExecutionIdentity` plus the shared
 * safe-session-id guard) — the same §3.1 rules every adapter applies, never a
 * second shape. The declared scope is validated as the tuple it is; the
 * identity is attribution, so this proves the tuple is well formed, not that
 * the caller owns anything.
 */
function parseMintedExecutionIdentity(serialized: string): ExecutionIdentity {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new CliIdentityError(
      "command.invalid-identity",
      "MSTAR_EXECUTION_IDENTITY is not the canonical JSON the launcher writes; a hand-set value is refused rather than guessed",
    );
  }
  if (!isMintedTuple(value)) {
    throw new CliIdentityError(
      "command.invalid-identity",
      "MSTAR_EXECUTION_IDENTITY must carry one \u00a73.1 identity tuple (source, sessionId, workflowId, role); a hand-set value is refused rather than guessed",
    );
  }
  try {
    validateExecutionIdentity(value, { workflowId: value.workflowId, role: value.role });
    assertSafeSessionId(value.sessionId, "MSTAR_EXECUTION_IDENTITY session id");
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "command.invalid-identity";
    throw new CliIdentityError(code, error instanceof Error ? error.message : String(error));
  }
  return value;
}

/**
 * Resolve one invocation's caller session identity with the launcher-minted
 * identity as a real transport. Precedence is explicit override, then the
 * launched session's minted local identity, then the ambient host environment.
 *
 * `MSTAR_EXECUTION_IDENTITY` is the channel `session.run` (and the managed host
 * gates) write, so a launched child actually carries its identity instead of
 * only the ambient host one. It is an **environment** channel, exactly like
 * `MSTAR_HOST_SESSION_ID`, so it resolves to `sessionIdSource: "env"` — the
 * legacy pre-activation forms keep their existing source semantics (resume
 * ignores an environment identity, a coordinator bootstrap rejects one) rather
 * than gaining a new declared-identity spelling. The parsed tuple rides along as
 * `executionIdentity` so the ACTIVE route can check its declared scope.
 *
 * The minted value is validated through the engine's own identity rules; a
 * malformed one refuses (throws) rather than silently falling back to another
 * channel.
 */
export function resolveCliSessionIdentity(
  sessionId: unknown,
): Pick<InvocationContext, "sessionId" | "sessionIdSource" | "executionIdentity"> {
  if (typeof sessionId === "string") return { sessionId, sessionIdSource: "flag" };
  const minted = process.env.MSTAR_EXECUTION_IDENTITY;
  if (typeof minted === "string" && minted.trim() !== "") {
    const executionIdentity = parseMintedExecutionIdentity(minted);
    return { sessionId: executionIdentity.sessionId, sessionIdSource: "env", executionIdentity };
  }
  const environmentSessionId = process.env.MSTAR_HOST_SESSION_ID;
  return typeof environmentSessionId === "string" && environmentSessionId.trim() !== ""
    ? { sessionId: environmentSessionId, sessionIdSource: "env" }
    : {};
}

/**
 * The routes whose active-token caller seat is the workflow's coordinator,
 * independent of any session reference. Each family constructs exactly
 * `{workflowId, role: "coordinator"}` from the trusted caller, so a minted
 * identity addressing that workflow in any other seat is refused here.
 * Every other active route either carries its whole scope in a session reference
 * or states its seat in the bind selectors; this set is the command-aware fact
 * the sparse routes can consume instead of treating token-only calls as
 * workflow-only.
 */
const COORDINATOR_SEAT_ROUTES: Record<string, true> = {
  "workflow.register": true,
  "workflow.evidence": true,
  "workflow.phase": true,
  "workflow.lifecycle": true,
  "workflow.execution-policy": true,
  "workflow.integration-worktree": true,
  "iteration.register": true,
  "status.workflow-close": true,
  "session.recover": true,
};

/**
 * The scope-consistency check the adapter can make without restating a family's
 * role/plan grammar: a launcher-minted identity declares the workflow, role and
 * plan it addresses, and a command that consumes that identity may only address
 * the scope it declares. The addressed scope is derived from the request the
 * same way the families do — a canonical session reference carries it, else the
 * selected command's own seat plus the explicit workflow/plan selectors do — and
 * a mismatch is refused here, before the command runs, so a minted identity never
 * silently authorizes a scope it does not declare. Identity stays attribution:
 * this proves the request is the one the launch declares, not that the caller
 * owns anything.
 */
export function mintedIdentityScopeProblem(
  identity: ExecutionIdentity | undefined,
  input: Record<string, unknown>,
  commandId: string,
): string | undefined {
  if (identity === undefined) return undefined;
  const planSparseRoute = commandId.startsWith("plan.") &&
    commandId !== "plan.bind" && commandId !== "plan.show" &&
    input.sessionRef === undefined && input.expect === undefined && input.execution !== true;
  if (planSparseRoute) {
    const workflowMismatch = typeof input.workflow === "string" && input.workflow !== identity.workflowId;
    const coordinatorMismatch = input.coordinator === true && identity.role !== "coordinator";
    if (workflowMismatch || coordinatorMismatch) {
      return `the launched identity addresses ${describeMintedScope(identity)}; this sparse plan request selects a different workflow or role`;
    }
    return undefined;
  }
  const addressed = addressedMintedScope(input, commandId, identity);
  if (addressed === undefined) return undefined;
  const mismatched = addressed.workflowId !== identity.workflowId ||
    (addressed.role !== undefined && addressed.role !== identity.role);
  if (!mismatched) return undefined;
  return `the launched identity addresses ${describeMintedScope(identity)}; this invocation addresses ${describeMintedScope(addressed)}`;
}

/** The scope one invocation addresses, derived exactly as its family would. */
function addressedMintedScope(
  input: Record<string, unknown>,
  commandId: string,
  identity?: ExecutionIdentity,
): { workflowId: string; role?: "coordinator" } | undefined {
  // A canonical session reference is itself an ACTIVE transport and carries the
  // whole addressed scope.
  for (const key of ["sessionRef", "resumeRef"]) {
    const wire = input[key];
    if (typeof wire !== "string" || wire === "") continue;
    try {
      const ref = decodeExecutionSessionRef(wire);
      return { workflowId: ref.workflowId };
    } catch {
      // A malformed reference is the family's own typed refusal; the scope gate
      // never pre-empts it or guesses a scope from a broken one.
      return undefined;
    }
  }
  // ACTIVE consumption includes sparse own-binding workflow operations. These
  // commands derive their session/token from the selected coordinator seat;
  // missing --expect must not bypass the minted identity's scope check.
  const sparseCoordinatorRoute = COORDINATOR_SEAT_ROUTES[commandId] === true &&
    commandId !== "workflow.register" && commandId !== "iteration.register" &&
    commandId !== "session.recover";
  if (input.execution !== true && typeof input.expect !== "string" && !sparseCoordinatorRoute) return undefined;
  const workflowId = typeof input.workflow === "string" && input.workflow.trim() !== ""
    ? input.workflow
    : sparseCoordinatorRoute ? identity?.workflowId : undefined;
  if (workflowId === undefined) return undefined;
  // Every plan/workflow ACTIVE route addresses the workflow's coordinator seat:
  // the removed scoped-PM seat had no other seat to state.
  return { workflowId, role: "coordinator" };
}

/** The declared tuple in the one wording both refusal sides share. */
function describeMintedScope(scope: { workflowId: string; role?: "coordinator" }): string {
  return scope.role === undefined ? `workflow ${scope.workflowId}` : `workflow ${scope.workflowId} as coordinator`;
}

function ensureCommand(program: Command, pathParts: readonly string[]): Command {
  let current = program;
  for (const part of pathParts) {
    const existing = current.commands.find((command) => command.name() === part);
    current = existing ?? current.command(part).exitOverride();
  }
  return current;
}

function configureLeaf(command: Command, definition: CommandDefinition): void {
  if (command.description() === "") command.description(renderCommandContract(definition, "cli"));
  for (const alias of definition.cli.aliases) {
    if (!alias.includes(" ")) command.alias(alias);
  }
  if (command.registeredArguments.length === 0) {
    for (const argument of definition.cli.arguments) {
      const token = argument.variadic
        ? argument.required ? `<${argument.key}...>` : `[${argument.key}...]`
        : argument.required ? `<${argument.key}>` : `[${argument.key}]`;
      command.argument(token, argument.key);
    }
  }
  const requirements = definition.cli.options.some((option) => option.key === "expect")
    ? getCommandSchemas([definition])[0]?.requirements ?? []
    : [];
  if (command.options.length === 0) {
    for (const option of definition.cli.options) {
      const flags = cliOptionFlags(definition, option);
      // The option's own help line: the declared supply disclosure when one
      // exists, else the bare key name (the previous contract).
      const tokenKinds = requirements
        .filter((entry) => entry.name === option.key || entry.name.startsWith(`${option.key} (`))
        .flatMap((entry) => entry.tokenKind === undefined ? [] : [`token kind: ${entry.tokenKind}${entry.name === option.key ? "" : ` ${entry.help ?? ""}`}`]);
      const description = [option.help ?? option.key, ...tokenKinds].join("; ");
      const appendValue = option.variadic
        ? (value: string, previous: string[] = []) => [...previous, value]
        : undefined;
      if (option.required) {
        if (appendValue) command.requiredOption(flags, description, appendValue);
        else command.requiredOption(flags, description);
      } else if (appendValue) {
        command.option(flags, description, appendValue);
      } else {
        command.option(flags, description);
      }
    }
  }
}

function cliEffects(services: Array<{ close(): Promise<void> }>): CommandEffects {
  let stdin: Promise<string> | undefined;
  return {
    readInput() {
      if (stdin === undefined) {
        const pending = Promise.withResolvers<string>();
        const chunks: Buffer[] = [];
        process.stdin.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        process.stdin.on("end", () => pending.resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", pending.reject);
        process.stdin.resume();
        stdin = pending.promise;
      }
      return stdin;
    },
    spawn: spawnProcess,
    writeStderr(message: string) {
      process.stderr.write(`${message}\n`);
    },
    async startDashboard(request) {
      const running = await startDashboard(request);
      const handle = { url: running.url, async close() { await running.close(); } };
      services.push(handle);
      return handle;
    },
    openBrowser(url: string) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      const pending = Promise.withResolvers<void>();
      const child = spawn(opener, argv, { stdio: "ignore", shell: false });
      child.once("spawn", () => pending.resolve());
      child.once("error", (error: NodeJS.ErrnoException) => {
        pending.reject(Object.assign(new Error(`no platform opener (${opener}) available: ${error.message}`), { code: "capability.browser.unavailable" }));
      });
      return pending.promise;
    },
    captureSddEvidence: captureSddEvidenceFromFile,
    verifySddEvidence,
    detectPluginVersion: ({ target, scope }) => detectInstalledPluginVersion(target as Target, scope as Scope),
  };
}

async function waitForStop(): Promise<NodeJS.Signals> {
  const pending = Promise.withResolvers<NodeJS.Signals>();
  const stop = (signal: NodeJS.Signals) => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    pending.resolve(signal);
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return pending.promise;
}

export function registerCliCommands(
  program: Command,
  definitions: readonly CommandDefinition[],
  baseContext: InvocationContext,
): void {
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  for (const definition of definitions) {
    const command = ensureCommand(program, definition.cli.path);
    configureLeaf(command, definition);
    command.exitOverride().action(async (...args: unknown[]) => {
      const controller = new AbortController();
      let received: NodeJS.Signals | undefined;
      const onSigint = () => { received = "SIGINT"; controller.abort("SIGINT"); };
      const onSigterm = () => { received = "SIGTERM"; controller.abort("SIGTERM"); };
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      const services: Array<{ close(): Promise<void> }> = [];
      try {
        const collected = decodeCliOptions(definition, collectInput(definition, args));
        const payload = decodePayloadInputs(definition, collected);
        if (payload.diagnostics.length > 0) {
          writeEnvelope(usageEnvelope(definition.id, "Invalid command payload.", { diagnostics: payload.diagnostics }));
          return;
        }
        const input = definition.decodeCliInput?.(payload.input);
        if (definition.decodeCliInput !== undefined && input === null) {
          writeEnvelope(usageEnvelope(definition.id, "Invalid command input."));
          return;
        }
        const sessionOption = definition.cli.options.find((option) => option.context === "sessionId");
        // The identity transport is consumed only where a command names it as
        // its caller context: a command with no session selector never reads
        // `context.sessionId`, and a malformed ambient minted value must not
        // break an unrelated read.
        let sessionIdentity: Pick<InvocationContext, "sessionId" | "sessionIdSource" | "executionIdentity"> = {};
        if (sessionOption !== undefined) {
          try {
            sessionIdentity = resolveCliSessionIdentity(collected[sessionOption.key]);
          } catch (error) {
            if (error instanceof CliIdentityError) {
              writeEnvelope(usageEnvelope(definition.id, error.message, { identity: { code: error.code } }));
              return;
            }
            throw error;
          }
          const minted = sessionIdentity.executionIdentity;
          const scopeProblem = mintedIdentityScopeProblem(minted, collected, definition.id);
          if (scopeProblem !== undefined && minted !== undefined) {
            writeEnvelope(usageEnvelope(definition.id, scopeProblem, {
              identity: { code: "command.identity-scope-mismatch", workflow: minted.workflowId },
            }));
            return;
          }
        }
        const envelope = await executeCommand(definition.id, input ?? payload.input, {
          ...baseContext,
          ...sessionIdentity,
          signal: controller.signal,
          effects: cliEffects(services),
        });
        writeEnvelope(envelope, received);
        if (definition.effects.includes("service") && envelope.status === "ok") await waitForStop();
      } finally {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        await Promise.all(services.map((service) => service.close()));
      }
    });
  }
}
