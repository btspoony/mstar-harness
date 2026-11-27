import { checkPlanboard, PLANBOARD_FINDING_CODES, resolveProcessHarnessDir } from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema, refusalEnvelope } from "../envelope.js";
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
        "Read {HARNESS_DIR}/planboard.md and report its pointers and their drift: malformed, stale, missing, overdue and unverified, each with its line. Writes nothing and exits 0 for every finding.",
      async execute(input, context): Promise<CommandEnvelope> {
        // see packages/commands/src/families/planboard.ts - // invariant: The board belongs to the control harness. An unresolved root
        // is refused instead of reading `./planboard.md` — a file in whatever
        // directory the caller happened to run in is not this project's board.
        const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness) ?? context.controlRoot;
        if (harnessDir === null || harnessDir === undefined) {
          return refusalEnvelope({
            command: "planboard.check",
            status: "refused",
            code: "planboard.harness-unresolved",
            exitCode: 1,
            message: `No control harness resolved from ${context.cwd}, so there is no board to read.`,
            details: { cwd: context.cwd, harness: input.harness ?? null },
            recovery:
              "Name the harness: `mstar planboard check --harness=<dir>`, or run `mstar path resolve` to print that path. Running from inside the repository that owns the control checkout resolves the same root without the flag.",
          });
        }
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
            // see packages/commands/src/families/planboard.ts - // why: The pointers are the board's content; findings are its drift.
            // A report that dropped the clean lines would leave the caller with
            // no planning order to read, so both travel together.
            captured: result.captured,
            candidates: result.candidates,
            codes: PLANBOARD_FINDING_CODES,
            findings: result.findings,
          },
        };
      },
    },
  ];
}
