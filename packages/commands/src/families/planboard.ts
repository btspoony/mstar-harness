import { checkPlanboard, PLANBOARD_FINDING_CODES, resolveProcessHarnessDir } from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope } from "../types.js";

const schema = z.object({ harness: z.string().optional() });
type Input = z.infer<typeof schema>;

/**
 * `mstar planboard check` is the one verb. It reports and does nothing else:
 * findings never change the exit code (a stale line is the normal state of a
 * board between iterations), and only a malformed invocation keeps the CLI's
 * usage exit, which the adapter already owns.
 */
export function getPlanboardCommandDefinitions(): readonly CommandDefinition<Input>[] {
  return [
    {
      id: "planboard.check",
      cli: { path: ["planboard", "check"], aliases: [], arguments: [], options: [{ key: "harness", flags: "--harness <abs>", required: false }] },
      input: schema,
      output: commandEnvelopeSchema,
      effects: ["read"],
      description:
        "Report drift on {HARNESS_DIR}/planboard.md: malformed, stale, missing, overdue and unverified, each with its line. Writes nothing and exits 0 for every finding.",
      async execute(input, context): Promise<CommandEnvelope> {
        const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness) ?? context.controlRoot ?? context.cwd;
        const result = await checkPlanboard({ harnessDir });
        return {
          version: 1,
          command: "planboard.check",
          status: "ok",
          code: "planboard.ok",
          exitCode: 0,
          data: {
            path: result.path,
            reviewAfter: result.reviewAfter,
            codes: PLANBOARD_FINDING_CODES,
            findings: result.findings,
          },
        };
      },
    },
  ];
}
