import { existsSync } from "node:fs";
import path from "node:path";
import {
  evaluatePhaseGate,
  evaluatePostMergeCloseFromExecutionAuthority,
  parseCompassFrontmatter,
  pushCadenceProbe,
  readRegisteredWorkflowFromExecutionAuthority,
  resolveProcessHarnessDir,
} from "@mstar-harness/engine";
import { z } from "zod";
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

function ok<T>(command: string, data: T): CommandEnvelope<T> {
  return { version: 1, command, status: "ok", code: `${command}.ok`, exitCode: 0, data };
}
function engineFailure(command: string, error: unknown, fallback: string): CommandEnvelope<never> {
  if (error instanceof z.ZodError) return refusalEnvelope({ command, status: "usage", code: "command.invalid-input", exitCode: 2, message: error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") });
  const code = errorCode(error, fallback);
  const message = messageOf(error);
  const details = error !== null && typeof error === "object" && "details" in error
    && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  return refusalEnvelope({ command, status: "refused", code: "coordination.check-refused", exitCode: 1, message, details: { ...(details ?? {}), underlyingCode: code }, recovery: "Correct the reported authority, snapshot, or compass facts, then run mstar status validate." });
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function errorCode(error: unknown, fallback: string): string {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : fallback;
}
function command<I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> { return definition; }
function harnessDir(context: InvocationContext, override?: string): string {
  const resolved = resolveProcessHarnessDir(context.cwd, override);
  if (!resolved) throw new Error(`harness dir not found from ${context.cwd} — pass harness or set MSTAR_HARNESS_DIR`);
  return resolved;
}
function assertWorkflowId(id: string): void {
  if (id === "" || id === "." || id === ".." || id.includes("/") || id.includes("\\")) throw new Error(`invalid workflow id ${JSON.stringify(id)}`);
}

export function getCoordinationChecksCommandDefinitions(): readonly CommandDefinition[] {
  const output = commandEnvelopeSchema;
  return [
    command({
      id: "migrate",
      // The retired file-route inputs stay RECOGNIZED (help text included) so
      // their use is the named retirement refusal instead of commander's
      // generic unknown-option usage.
      cli: { path: ["migrate"], aliases: [], arguments: [], options: [
        { key: "dryRun", flags: "--dry-run", required: false, help: "retired file-route input: the v1-to-v2 staging preview is gone; the refusal names the supported store upgrade" },
        { key: "path", flags: "--path <root>", required: false, help: "retired file-route input: pass the control root to `mstar store upgrade --harness <path> --operator <name>` instead" },
        { key: "json", flags: "--json", required: false, help: "retired file-route input: `mstar store upgrade` reports the imported/retained facts as JSON" },
      ] },
      input: z.object({ dryRun: z.boolean().optional(), path: z.string().optional(), json: z.boolean().optional() }),
      output, effects: [], description: "Retired command; refuses without mutation.",
      async execute() {
        return refusalEnvelope({
          command: "migrate",
          status: "refused",
          code: "migrate.verb-retired",
          exitCode: 1,
          message: "migrate: removed — the v1-to-v2 file-staging route is retired. The supported route is `mstar store upgrade --operator <name>`, which imports recognizable v1/v2 execution sources directly into the control root's store.db and leaves every legacy file untouched. This verb writes nothing.",
          recovery: "Run mstar store upgrade --operator <name> for the control root that holds the legacy files; it converts v1 sources in memory, preserves the originals, and is retryable.",
        });
      },
    }),
    command({
      id: "iteration.gate",
      cli: { path: ["iteration", "gate"], aliases: [], arguments: [], options: [{ key: "workflow", flags: "--workflow <id>", required: true }, { key: "compass", flags: "--compass <path>", required: false }, { key: "phase", flags: "--phase <n>", required: false }, { key: "harness", flags: "--harness <path>", required: false }, { key: "branch", flags: "--branch <branch>", required: false }, { key: "integration", flags: "--integration <branch>", required: false }, { key: "target", flags: "--target <branch>", required: false }] },
      input: z.object({ workflow: z.string().min(1), compass: z.string().optional(), phase: z.string().optional(), harness: z.string().optional(), branch: z.string().optional(), integration: z.string().optional(), target: z.string().optional() }), output, effects: ["read", "validate"], description: "Evaluate the iteration phase transition gate without mutation.",
      async execute(input, context) {
        const id = "iteration.gate";
        try {
          const phase6 = input.phase !== undefined && Number(input.phase) === 6;
          if (input.phase !== undefined && !phase6) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `usage: iteration gate --phase only supports 6 (got ${JSON.stringify(input.phase)})` });
          if (!phase6 && (!input.compass || input.compass.trim() === "")) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "usage: iteration gate requires --compass <path> (or --phase 6 for the post-merge close form)" });
          const root = harnessDir(context, input.harness);
          assertWorkflowId(input.workflow);
          // The ACTIVE execution authority is the only source (issue #428): a
          // control root without one refuses out of the engine read instead of
          // falling back to snapshot/status JSON.
          if (phase6) {
            // Phase-6 close facts are evaluated by the authority-specific engine
            // form; it reads the addressed workflow regardless of registration.
            const gate = await evaluatePostMergeCloseFromExecutionAuthority({ harnessDir: root }, input.workflow);
            return gate.ok
              ? ok(id, { phase: 6, gate })
              : refusalEnvelope({ command: id, status: "refused", code: gate.violations[0]?.code ?? "iteration.gate.blocked", exitCode: 1, message: "phase 6 post-merge close gate is blocked", details: { gate }, recovery: "Resolve the reported post-merge blockers, then run mstar iteration gate --workflow <workflow-id> --phase 6." });
          }
          const snapshot = await readRegisteredWorkflowFromExecutionAuthority({ harnessDir: root }, input.workflow);
          if (snapshot === null) {
            return refusalEnvelope({ command: id, status: "refused", code: "iteration.gate.workflow-not-found", exitCode: 1, message: `workflow '${input.workflow}' not found in the registered execution authority`, recovery: "Run mstar status validate to inspect registered workflow IDs, select the intended workflow, then run mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
          }
          const compassPath = path.resolve(context.cwd, input.compass!);
          if (!existsSync(compassPath)) return refusalEnvelope({ command: id, status: "refused", code: "iteration.gate.compass-not-found", exitCode: 1, message: `compass file not found: ${compassPath}`, recovery: "The compass must exist at the reported path before mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
          const gate = evaluatePhaseGate(snapshot, parseCompassFrontmatter(compassPath), {
            currentBranch: input.branch,
            specIntegrationBranch: input.integration,
            prBaseBranch: input.target,
          });
          return gate.ok
            ? ok(id, { transition: gate.transition, entry: gate.entry, exit: gate.exit })
            : refusalEnvelope({ command: id, status: "refused", code: gate.violations[0]?.code ?? "iteration.gate.blocked", exitCode: 1, message: "iteration phase gate is blocked", details: { gate }, recovery: "Resolve the reported phase blockers, then run mstar status validate and mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
        } catch (error) { return engineFailure(id, error, "iteration.gate.refused"); }
      },
    }),
    command({
      id: "iteration.push-cadence",
      cli: { path: ["iteration", "push-cadence"], aliases: [], arguments: [], options: [{ key: "ciRunning", flags: "--ci-running", required: false }, { key: "reviewWave", flags: "--review-wave", required: false }] },
      input: z.object({ ciRunning: z.boolean().optional(), reviewWave: z.boolean().optional() }), output, effects: ["validate"], description: "Probe whether CI and AI review activity permit a push.",
      async execute(input) {
        const id = "iteration.push-cadence";
        const gate = pushCadenceProbe(input.ciRunning === true, input.reviewWave === true);
        return gate.ok ? ok(id, { allowed: true, violations: [] }) : refusalEnvelope({ command: id, status: "refused", code: gate.violations[0]?.code ?? "iteration.push-cadence.blocked", exitCode: 1, message: "push blocked by active CI or review wave", details: { violations: gate.violations }, recovery: "Wait for the reported CI/review wave to settle, then run mstar iteration push-cadence." });
      },
    }),
  ];
}
