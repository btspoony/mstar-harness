import { Command } from "commander";
import { resolve } from "node:path";
import {
  CONTRACT_REVISION,
  connectEvaluatorChannel,
  resolveJudgmentConfig,
  runReviewAdvice,
  type EvaluatorChannel,
  type JudgmentCliResult,
  type JudgmentInvocation,
} from "@mstar-harness/judgment";

const SCHEMA = "mstar.judgment-cli/v1" as const;
const COMMAND_POSITION = 2;

export function judgmentUsageFailurePayload(argv: readonly string[], message: string): string | null {
  if (argv[COMMAND_POSITION] !== "judgment") return null;
  const operation = argv[COMMAND_POSITION + 1] === "review-advice" ? "review-advice" : "judgment";
  return JSON.stringify({
    schema: SCHEMA,
    contractRevision: CONTRACT_REVISION,
    status: "invalid",
    advice: null,
    code: "jev.usage",
    message,
    details: { operation },
  });
}

export function judgmentExitCode(result: JudgmentCliResult, signal?: NodeJS.Signals): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (result.status === "disabled" || result.status === "recorded") return 0;
  return result.status === "cancelled" ? 130 : 1;
}

type ReviewAdviceOptions = { file?: string; stdin?: boolean; pilot: string; workspace?: string };

export function registerJudgmentCommands(program: Command): void {
  const judgment = program.command("judgment").description("Synthetic-only judgment services");
  const reviewAdvice = judgment
    .command("review-advice")
    .description("Submit an explicitly enabled review pack for bounded, non-authoritative advice")
    .option("--file <path>", "Review decision pack JSON file (inside the workspace)")
    .option("--stdin", "Read review decision pack JSON from stdin")
    .requiredOption("--pilot <path>", "Explicit synthetic-only pilot JSON (inside the workspace)")
    .option("--workspace <path>", "Workspace boundary (default: current directory)")
    .exitOverride()
    .action(async (options: ReviewAdviceOptions) => {
      if ((options.file === undefined) === (options.stdin !== true)) {
        const message = "exactly one of --file or --stdin is required";
        console.log(judgmentUsageFailurePayload(process.argv, message));
        process.exitCode = 2;
        return;
      }

      const cwd = process.cwd();
      const workspace = resolve(cwd, options.workspace ?? ".");
      const invocation: JudgmentInvocation = Object.freeze({
        cwd,
        workspace,
        input: options.stdin === true ? Object.freeze({ kind: "stdin" }) : Object.freeze({ kind: "file", path: options.file! }),
        pilotPath: options.pilot,
      });
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

      let result: JudgmentCliResult;
      try {
        const config = resolveJudgmentConfig(cwd, workspace);
        let channel: EvaluatorChannel | null = null;
        if (config.state === "enabled") {
          try { channel = await connectEvaluatorChannel(invocation, controller.signal); }
          catch { /* The runtime reports a stable unavailable channel status. */ }
        }
        result = await runReviewAdvice(invocation, controller.signal, channel);
      } catch {
        result = Object.freeze({
          schema: SCHEMA,
          contractRevision: CONTRACT_REVISION,
          status: "unavailable",
          advice: null,
          code: "jev.cli-failed",
        });
      } finally {
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
      }
      console.log(JSON.stringify(result));
      process.exitCode = judgmentExitCode(result, receivedSignal);
    });
}
