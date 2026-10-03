import { spawn } from "node:child_process";
import { Command, CommanderError } from "commander";
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
import { captureSddEvidenceFromFile, verifySddEvidence } from "./sdd-evidence.js";

export function usageEnvelope(command: string, message: string, details?: Record<string, unknown>): CommandEnvelope {
  return { version: 1, command, status: "usage", code: "command.invalid-input", exitCode: 2, message, ...(details === undefined ? {} : { details }) };
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
  return usageEnvelope(commandIdFromArgv(argv), error.message, { diagnostics: [parserDiagnostic(error, argv)] });
}

/**
 * Deterministic field identity for Commander missing argument/option errors and
 * the leaf help route when argv resolves to a known command; any other parser
 * failure keeps the honest diagnostic (stable code + original message) without
 * a guessed field.
 */
function parserDiagnostic(error: CommanderError, argv: readonly string[]): Record<string, unknown> {
  const field = parserField(error);
  const helpRoute = cliHelpRoute(argv);
  return {
    ...(field === undefined ? {} : { path: field }),
    code: error.code,
    message: error.message,
    ...(helpRoute === undefined ? {} : { helpRoute }),
  };
}

function parserField(error: CommanderError): string | undefined {
  const quoted = /'([^']+)'/.exec(error.message)?.[1];
  if (quoted === undefined) return undefined;
  if (error.code === "commander.missingArgument") return quoted;
  if (error.code === "commander.missingMandatoryOptionValue") return optionKey(quoted);
  if (error.code === "commander.optionMissingArgument") return optionKey(quoted);
  return undefined;
}

function cliHelpRoute(argv: readonly string[]): string | undefined {
  const definition = getCommandDefinitions().find((entry) => entry.id === commandIdFromArgv(argv));
  return definition === undefined ? undefined : `mstar ${definition.cli.path.join(" ")} --help`;
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
    lines.push("Session identity resolves --session-id first, then MSTAR_HOST_SESSION_ID (empty/whitespace ignored), else unset; for active token-authorized writes it is attribution, not authorization. The legacy pre-activation coordinator bootstrap (`plan bind --coordinator`) requires an explicit --session-id and rejects the environment value. Legacy `plan bind --resume` ignores ambient environment identity and refuses a declared identity.");
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
    const parts = entries.map((entry) => (entry.help === undefined ? entry.name : `${entry.name} (${entry.help})`));
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

export function resolveCliSessionIdentity(sessionId: unknown): Pick<InvocationContext, "sessionId" | "sessionIdSource"> {
  if (typeof sessionId === "string") return { sessionId, sessionIdSource: "flag" };
  const environmentSessionId = process.env.MSTAR_HOST_SESSION_ID;
  return typeof environmentSessionId === "string" && environmentSessionId.trim() !== ""
    ? { sessionId: environmentSessionId, sessionIdSource: "env" }
    : {};
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
  if (command.options.length === 0) {
    for (const option of definition.cli.options) {
      const flags = cliOptionFlags(definition, option);
      const appendValue = option.variadic
        ? (value: string, previous: string[] = []) => [...previous, value]
        : undefined;
      if (option.required) {
        if (appendValue) command.requiredOption(flags, option.key, appendValue);
        else command.requiredOption(flags, option.key);
      } else if (appendValue) {
        command.option(flags, option.key, appendValue);
      } else {
        command.option(flags, option.key);
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
        const sessionIdentity = resolveCliSessionIdentity(
          sessionOption === undefined ? undefined : collected[sessionOption.key],
        );
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
