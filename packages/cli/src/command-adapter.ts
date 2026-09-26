import { spawn } from "node:child_process";
import { Command, CommanderError } from "commander";
import {
  executeCommand,
  spawnProcess,
  startDashboard,
  type CommandDefinition,
  type CommandEnvelope,
  type CommandEffects,
  type InvocationContext,
} from "@mstar-harness/commands";
import { captureSddEvidenceFromFile, verifySddEvidence } from "./sdd-evidence.js";

export function usageEnvelope(command: string, message: string): CommandEnvelope {
  return { version: 1, command, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}

export function writeEnvelope(envelope: CommandEnvelope, signal?: NodeJS.Signals): void {
  const exitCode = envelope.code === "judgment.cancelled" && signal === "SIGTERM" ? 143 : envelope.exitCode;
  console.log(JSON.stringify({ ...envelope, exitCode }));
  process.exitCode = exitCode;
}

export function commandIdFromArgv(argv: readonly string[]): string {
  const tokens = argv.slice(2).filter((token) => token !== "--" && !token.startsWith("-"));
  return tokens.length === 0 ? "mstar" : tokens.join(".");
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
      if (option.required) command.requiredOption(option.flags, option.key);
      else command.option(option.flags, option.key);
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
        const envelope = await executeCommand(definition.id, collectInput(definition, args), {
          ...baseContext,
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
