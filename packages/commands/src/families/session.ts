import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { z } from "zod";
import {
  createFsStore,
  createLocalExecutionIdentity,
  executionContextFor,
  recoverExecutionCoordinator,
  resolveProcessHarnessDir,
  serializeExecutionValue,
  setArtifactStore,
  type ActivationAttestation,
  type ExecutionIdentity,
} from "@mstar-harness/engine";
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../definitions.js";
import { TOKEN_SUPPLIES } from "../identity-supplies.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const command = <I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> => definition;
const SESSION_ROLES = ["coordinator"] as const;
/** Recovery compares the addressed workflow's own CAS token. */
const SESSION_RECOVER_EXPECT_HELP = `required CAS token: ${TOKEN_SUPPLIES.workflow}`;

function ok<T>(id: string, data: T): CommandEnvelope<T> {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function engineRefusal(id: string, error: unknown): CommandEnvelope<never> {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : `${id}.refused`;
  return refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message: error instanceof Error ? error.message : String(error) , recovery: "Inspect the workflow and session details, restore the recorded coordinator prerequisites, then retry the session operation."});
}

export function getSessionCommandDefinitions(): readonly CommandDefinition[] {
  const runInput = z.object({ workflow: z.string().min(1), role: z.enum(SESSION_ROLES), argv: z.array(z.string()).optional(), harness: z.string().min(1).optional() });
  const recoverInput = z.object({ workflow: z.string().min(1), priorSession: z.string().min(1).optional(), unowned: z.boolean().optional(), reason: z.string().min(1).optional(), attestation: z.string().min(1).optional(), expect: z.string().min(1).optional(), operation: z.string().min(1).optional(), harness: z.string().min(1).optional() });
  return [
    command({
      id: "session.run",
      cli: { path: ["session", "run"], aliases: [], arguments: [{ key: "argv", required: true, variadic: true }], options: [
        { key: "workflow", flags: "--workflow <id>", required: true }, { key: "role", flags: "--role <role>", required: true },
        { key: "harness", flags: "--harness <path>", required: false },
      ] },
      input: runInput, output: commandEnvelopeSchema, effects: ["process"],
      description: "Launch argv under a freshly minted local execution identity; this is a launch, not a binding \u2014 it writes no session row or lease, and the child binds through the public `plan bind --execution --workflow <id> --coordinator` route, whose creator/ownerless/foreign-holder conditions still apply.",
      async execute(raw, context) {
        const { workflow, role, argv = [], harness } = raw as z.infer<typeof runInput>;
        if (role !== "coordinator" || argv.length === 0 || argv[0]!.trim() === "") {
          return refusalEnvelope({ command: "session.run", status: "usage", code: "command.invalid-input", exitCode: 2, message: "session run requires --workflow, --role coordinator, and a child argv" });
        }
        const root = resolveProcessHarnessDir(context.cwd, harness);
        const identity = createLocalExecutionIdentity({ workflowId: workflow, role });
        const env: Record<string, string> = { ...process.env as Record<string, string>, MSTAR_EXECUTION_IDENTITY: serializeExecutionValue(identity) };
        delete env.MSTAR_HOST_SESSION_ID;
        if (root !== null) env.MSTAR_HARNESS_DIR = root;
        // The receipt is a launch fact, never an ownership claim: the minted
        // identity is attribution the CLI now consumes, and no session row or
        // lease was written. Binding is a separate public step whose real
        // conditions (creator first-bind, ownerless adoption, foreign/live
        // holder refusal) are the engine's, not this launcher's.
        const binding = {
          written: false,
          route: `mstar plan bind --execution --workflow ${workflow} --coordinator`,
          conditions: "the workflow's creating identity binds first; a workflow with no coordinator record may be adopted; a live or foreign holder is refused and never replaced by a launch",
        };
        try {
          const child = await context.effects.spawn({ argv, cwd: context.cwd, env, signal: context.signal });
          const childCode = child.signal === null
            ? child.exitCode ?? 0
            : 128 + (constants.signals[child.signal as keyof typeof constants.signals] ?? 0);
          const launched = { identity, binding, exitCode: childCode, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
          if (childCode === 0) return ok("session.run", launched);
          return {
            version: 1, command: "session.run", status: "error", code: "session.child-exit", exitCode: childCode,
            message: child.signal === null ? `child exited with status ${childCode}` : `child terminated by ${child.signal}`,
            details: launched,
          };
        } catch (error) {
          return engineRefusal("session.run", error);
        }
      },
    }),
    command({
      id: "session.recover",
      cli: { path: ["session", "recover"], aliases: [], arguments: [], options: [
        { key: "workflow", flags: "--workflow <id>", required: true }, { key: "priorSession", flags: "--prior-session <id>", required: false },
        { key: "unowned", flags: "--unowned", required: false }, { key: "reason", flags: "--reason <text>", required: true },
        { key: "attestation", flags: "--attestation <path>", required: true }, { key: "expect", flags: "--expect <token>", required: true, help: SESSION_RECOVER_EXPECT_HELP },
        { key: "operation", flags: "--operation <id>", required: true }, { key: "harness", flags: "--harness <path>", required: false },
        { key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" },
      ] },
      input: recoverInput, output: commandEnvelopeSchema, effects: ["write"],
      description: "Recover a stopped workflow coordinator through active DB authority. Recovery never resumes a session.",
      async execute(raw, context: InvocationContext) {
        const parsed = recoverInput.safeParse(raw);
        if (!parsed.success) return refusalEnvelope({ command: "session.recover", status: "usage", code: "command.invalid-input", exitCode: 2, message: parsed.error.message });
        const { workflow, priorSession, unowned, reason, attestation, expect, operation, harness } = parsed.data;
        if ((priorSession === undefined) === (unowned !== true) || reason === undefined || attestation === undefined || expect === undefined || operation === undefined) {
          return refusalEnvelope({ command: "session.recover", status: "usage", code: "command.invalid-input", exitCode: 2, message: "session recover requires exactly one priorSession or unowned, plus reason, attestation, expect and operation" });
        }
        if (context.sessionId === undefined) return refusalEnvelope({ command: "session.recover", status: "usage", code: "command.invalid-input", exitCode: 2, message: "active recovery requires the main conversation session identity" });
        try {
          const root = resolveProcessHarnessDir(context.cwd, harness);
          if (root === null) return refusalEnvelope({ command: "session.recover", status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
          const identity: ExecutionIdentity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: workflow, role: "coordinator" };
          const parsedAttestation = JSON.parse(readFileSync(attestation, "utf8")) as ActivationAttestation;
          const contextForCaller = executionContextFor({ harnessDir: root }, identity);
          const receipt = await recoverExecutionCoordinator(contextForCaller, {
            expected: expect as never, operationId: operation, priorSessionId: unowned ? null : priorSession!, reason,
            attestation: parsedAttestation,
          });
          return ok("session.recover", receipt);
        } catch (error) {
          return engineRefusal("session.recover", error);
        }
      },
    }),
  ];
}
