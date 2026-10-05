import { resolve } from "node:path";
import { z } from "zod";
type JudgmentInvocation = Readonly<{
  cwd: string;
  workspace: string;
  input: Readonly<{ kind: "file"; path: string }> | Readonly<{ kind: "stdin" }>;
  pilotPath: string | null;
}>;
type JudgmentCliResult = Readonly<{
  schema: string;
  contractRevision: string;
  status: "disabled" | "recorded" | "unavailable" | "invalid" | "cancelled";
  advice: null;
  code?: string;
}>;
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const id = "judgment.review-advice";
const inputSchema = z.object({
  file: z.string().optional(),
  stdin: z.boolean().optional(),
  pilot: z.string().min(1),
  workspace: z.string().optional(),
  json: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;
export type JudgmentProvider = (request: Readonly<{
  invocation: JudgmentInvocation;
  signal: AbortSignal;
  readInput(): Promise<string>;
}>) => Promise<JudgmentCliResult>;

async function lazyJudgmentProvider({ invocation, signal, readInput }: Parameters<JudgmentProvider>[0]): Promise<JudgmentCliResult> {
  // Runtime selection keeps judgment out of the eagerly loaded command graph.
  const judgmentPackage = "@mstar-harness/judgment";
  const judgment = await import(judgmentPackage);
  return judgment.runReviewAdvice(invocation, signal, null, {
    readStdin: async () => new TextEncoder().encode(await readInput()),
    isStdinTTY: () => false,
  });
}


function error(code: string, message: string, boundary?: string): CommandEnvelope<never> {
  return {
    version: 1,
    command: id,
    status: "error",
    code,
    exitCode: 1,
    message,
    ...(boundary === undefined ? {} : { details: { boundary } }),
  };
}

async function execute(input: Input, context: InvocationContext, provider: JudgmentProvider): Promise<CommandEnvelope> {
  const hasFile = input.file !== undefined;
  const hasStdin = input.stdin === true;
  if (hasFile === hasStdin) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "exactly one of file or stdin is required" });

  const invocation: JudgmentInvocation = Object.freeze({
    cwd: context.cwd,
    workspace: resolve(context.cwd, input.workspace ?? "."),
    input: hasStdin ? Object.freeze({ kind: "stdin" }) : Object.freeze({ kind: "file", path: input.file! }),
    pilotPath: input.pilot,
  });

  let result: JudgmentCliResult;
  try {
    result = await provider(Object.freeze({ invocation, signal: context.signal, readInput: () => context.effects.readInput() }));
  } catch (cause) {
    return error("judgment.provider-failed", "Judgment provider invocation failed", cause instanceof Error ? cause.message : String(cause));
  }

  if (result.status === "invalid") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "Judgment input was rejected" });
  if (result.status === "cancelled") {
    return { version: 1, command: id, status: "error", code: "judgment.cancelled", exitCode: 130, message: "Judgment review was cancelled", details: { boundary: result.code ?? "review-cancelled" } };
  }
  if (result.status === "unavailable") return error("judgment.provider-failed", "Judgment provider is unavailable", result.code ?? "provider-unavailable");
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data: result };
}

export function getJudgmentCommandDefinitions(provider: JudgmentProvider = lazyJudgmentProvider): readonly CommandDefinition[] {
  const definition: CommandDefinition<Input, unknown> = {
    id,
    cli: {
      path: ["judgment", "review-advice"],
      aliases: [],
      arguments: [],
      options: [
        { key: "file", flags: "--file <path>", required: false },
        { key: "stdin", flags: "--stdin", required: false },
        { key: "pilot", flags: "--pilot <path>", required: true },
        { key: "workspace", flags: "--workspace <path>", required: false },
        { key: "json", flags: "--json", required: false },
      ],
    },
    input: inputSchema,
    output: commandEnvelopeSchema,
    effects: ["read", "stdin", "service"],
    description: "The historical judgment submit command is not in the current registry; use judgment review-advice --file <pack.json> --pilot <pilot.json> (or --stdin) for explicitly enabled, bounded advice.",
    async execute(raw, context) {
      return execute(raw as Input, context, provider);
    },
  };
  return [definition];
}
