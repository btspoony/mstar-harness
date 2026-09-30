import { spawn } from "node:child_process";
import { Command, CommanderError } from "commander";
import {
  executeCommand,
  getCommandDefinitions,
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
  return usageEnvelope(commandIdFromArgv(argv), error.message);
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

function decodeCliOptions(definition: CommandDefinition, input: Record<string, unknown>): Record<string, unknown> {
  const decoded = { ...input };
  for (const option of definition.cli.options) {
    const value = decoded[option.key];
    const schema = optionJsonSchema(definition, option.key);
    if (typeof value === "string" && hasType(schema, "array")) {
      if (value.trimStart().startsWith("[") || value.trimStart().startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) {
            decoded[option.key] = parsed;
            continue;
          }
          if (parsed !== null && typeof parsed === "object") {
            decoded[option.key] = [parsed];
            continue;
          }
        } catch {
          // Keep malformed JSON-looking input intact so the command decoder rejects it.
          continue;
        }
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

function ensureCommand(program: Command, pathParts: readonly string[]): Command {
  let current = program;
  for (const part of pathParts) {
    const existing = current.commands.find((command) => command.name() === part);
    current = existing ?? current.command(part).exitOverride();
  }
  return current;
}

function configureLeaf(command: Command, definition: CommandDefinition): void {
  if (command.description() === "") command.description(definition.description);
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
        const sessionId = sessionOption === undefined ? undefined : collected[sessionOption.key];
        const envelope = await executeCommand(definition.id, input ?? payload.input, {
          ...baseContext,
          ...(typeof sessionId === "string" ? { sessionId } : {}),
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
