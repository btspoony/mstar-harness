import { Command } from "commander";
import { readFileSync } from "node:fs";
import { getJudgmentCommandDefinitions } from "@mstar-harness/commands";
import type { CommandDefinition, InvocationContext } from "@mstar-harness/commands";

const COMMAND_POSITION = 2;
const definitions = getJudgmentCommandDefinitions();
const definition = definitions[0]!;

export function judgmentUsageFailurePayload(argv: readonly string[], message: string): string | null {
  if (argv[COMMAND_POSITION] !== "judgment") return null;
  return JSON.stringify({
    version: 1,
    command: definition.id,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message,
  });
}

type ReviewAdviceOptions = { file?: string; stdin?: boolean; pilot?: string; workspace?: string; json?: boolean };

function invocationContext(signal: AbortSignal): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal,
    effects: {
      async readInput() { return readFileSync(0, "utf8"); },
      async spawn() { throw new Error("Judgment command does not support process spawning"); },
      async startDashboard() { throw new Error("Judgment command does not support dashboard effects"); },
      async openBrowser() { throw new Error("Judgment command does not support browser effects"); },
    },
  };
}

export function registerJudgmentCommands(
  program: Command,
  commandDefinitions: readonly CommandDefinition[] = definitions,
): void {
  const judgment = program.command("judgment").description("Synthetic-only judgment services");
  judgment
    .command("review-advice")
    .description(definition.description)
    .option("--file <path>", "Review decision pack JSON file (inside the workspace)")
    .option("--stdin", "Read review decision pack JSON from stdin")
    .requiredOption("--pilot <path>", "Explicit synthetic-only pilot JSON (inside the workspace)")
    .option("--workspace <path>", "Workspace boundary (default: current directory)")
    .option("--json", "Write the structured JSON result envelope")
    .exitOverride()
    .action(async (options: ReviewAdviceOptions) => {
      const controller = new AbortController();
      let receivedSignal: NodeJS.Signals | undefined;
      const onSignal = (signal: NodeJS.Signals) => {
        receivedSignal = signal;
        controller.abort("review-cancelled");
      };
      const onInterrupt = () => onSignal("SIGINT");
      const onTerminate = () => onSignal("SIGTERM");
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onTerminate);

      try {
        const command = commandDefinitions.find(({ id }) => id === definition.id);
        if (command === undefined) throw new Error(`Missing command definition: ${definition.id}`);
        const input = {
          ...(options.file === undefined ? {} : { file: options.file }),
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
          ...(options.pilot === undefined ? {} : { pilot: options.pilot }),
          ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
          ...(options.json === undefined ? {} : { json: options.json }),
        };
        let envelope = await command.execute(input, invocationContext(controller.signal));
        if (envelope.status === "error" && envelope.code === "judgment.cancelled" && receivedSignal === "SIGTERM") {
          envelope = { ...envelope, exitCode: 143 };
        }
        console.log(JSON.stringify(envelope));
        process.exitCode = envelope.exitCode;
      } catch (cause) {
        console.log(JSON.stringify({
          version: 1,
          command: definition.id,
          status: "error",
          code: "judgment.cli-failed",
          exitCode: 1,
          message: cause instanceof Error ? cause.message : String(cause),
          details: { boundary: receivedSignal ?? "cli-adapter" },
        }));
        process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 1;
      } finally {
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
      }
    });
}
