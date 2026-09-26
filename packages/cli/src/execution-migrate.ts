import { Command } from "commander";
import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import { getExecutionCommandDefinitions, type CommandDefinition, type InvocationContext } from "@mstar-harness/commands";

const definitions = getExecutionCommandDefinitions();
const optionKeysByVerb: Record<string, readonly string[]> = {
  preview: ["harness", "operation", "operator", "inventory", "out", "coverageOut"],
  apply: ["harness", "operation", "operator", "inventory", "manifest", "coverage", "backup"],
  activate: ["harness", "operation", "operator", "inventory", "manifest", "coverage", "attestation"],
  retire: ["harness", "operation", "operator", "inventory", "manifest"],
  abort: ["harness", "operation", "operator", "manifest", "reason"],
  "restore-preview": ["harness", "backup", "out"],
  restore: ["harness", "preview", "acceptLossDigest", "operator", "authorization", "out"],
  export: ["harness", "out"],
};

function context(): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: resolveProcessHarnessDir(process.cwd()),
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("dashboard effect is unavailable for execution commands"); },
      async openBrowser() { throw new Error("browser effect is unavailable for execution commands"); },
    },
  };
}

function attach(command: Command, definition: CommandDefinition): void {
  const operation = definition.cli.path[2]!;
  for (const option of definition.cli.options) if (optionKeysByVerb[operation]!.includes(option.key)) command.option(option.flags);
  command.option("--json", "Machine-readable envelope on stdout");
  command.exitOverride().action(async (options: Input) => {
    const { json, ...input } = options;
    const result = await definition.execute(input, context());
    const operation = definition.id.slice("store.execution.".length);
    if (json === true) {
      console.log(JSON.stringify(result.status === "ok"
        ? { ok: true, route: "execution", operation, data: result.data }
        : { ok: false, route: "execution", operation, code: result.code, message: result.message }));
    } else if (result.status === "ok") {
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.error(`store execution ${operation}: ${result.message}`);
    }
    if (result.status !== "ok") process.exitCode = result.exitCode;
  });
}

export function registerExecutionMigrationCommands(target: Command): void {
  const store = target.commands.find((command) => command.name() === "store");
  if (store === undefined) throw new Error("registerExecutionMigrationCommands: the `store` command group must be registered first");
  const execution = store.command("execution").description("Execution migration and recovery operations").exitOverride();
  for (const definition of definitions) {
    const verb = definition.cli.path[2]!;
    attach(execution.command(verb).description(definition.description), definition);
  }
}

export function executionMigrationUsageFailurePayload(argv: readonly string[], message: string): string | null {
  if (argv[2] !== "store" || argv[3] !== "execution") return null;
  const operation = argv.slice(4).find((token) => !token.startsWith("-")) ?? "store execution";
  return JSON.stringify({ ok: false, route: "execution", operation, code: "usage", message });
}
