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
import { commandEnvelopeSchema } from "../definitions.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const command = <I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> => definition;
const SESSION_ROLES = ["coordinator", "plan-pm"] as const;

function ok<T>(id: string, data: T): CommandEnvelope<T> {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused(id: string, error: unknown): CommandEnvelope<never> {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : `${id}.refused`;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message: error instanceof Error ? error.message : String(error) };
}
function usage(id: string, message: string): CommandEnvelope<never> {
  return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}

export function getSessionCommandDefinitions(): readonly CommandDefinition[] {
  const runInput = z.object({ workflow: z.string().min(1), role: z.enum(SESSION_ROLES), plan: z.string().min(1).optional(), argv: z.array(z.string()).optional(), harness: z.string().min(1).optional() });
  const recoverInput = z.object({ workflow: z.string().min(1), priorSession: z.string().min(1).optional(), unowned: z.boolean().optional(), reason: z.string().min(1).optional(), attestation: z.string().min(1).optional(), expect: z.string().min(1).optional(), operation: z.string().min(1).optional(), harness: z.string().min(1).optional() });
  return [
    command({
      id: "session.run",
      cli: { path: ["session", "run"], aliases: [], arguments: [{ key: "argv", required: true, variadic: true }], options: [
        { key: "workflow", flags: "--workflow <id>", required: true }, { key: "role", flags: "--role <role>", required: true },
        { key: "plan", flags: "--plan <id>", required: false }, { key: "harness", flags: "--harness <path>", required: false },
      ] },
      input: runInput, output: commandEnvelopeSchema, effects: ["process"],
      description: "Launch argv under a freshly minted local execution identity; this does not resume or bind a session.",
      async execute(raw, context) {
        const parsed = runInput.safeParse(raw);
        if (!parsed.success) return usage("session.run", parsed.error.message);
        const { workflow, role, plan, argv = [], harness } = parsed.data;
        if (role === undefined || (role === "plan-pm" && plan === undefined) || (role === "coordinator" && plan !== undefined) || argv.length === 0 || argv[0]!.trim() === "") {
          return usage("session.run", "session run requires --workflow, --role, a compatible --plan, and a child argv");
        }
        const root = resolveProcessHarnessDir(context.cwd, harness);
        const identity = createLocalExecutionIdentity({ workflowId: workflow, role, planId: plan ?? null });
        const env: Record<string, string> = { ...process.env as Record<string, string>, MSTAR_EXECUTION_IDENTITY: serializeExecutionValue(identity) };
        delete env.MSTAR_HOST_SESSION_ID;
        if (root !== null) env.MSTAR_HARNESS_DIR = root;
        try {
          const child = await context.effects.spawn({ argv, cwd: context.cwd, env, signal: context.signal });
          const childCode = child.signal === null
            ? child.exitCode ?? 0
            : 128 + (constants.signals[child.signal as keyof typeof constants.signals] ?? 0);
          if (childCode === 0) return ok("session.run", { exitCode: childCode, signal: child.signal, stdout: child.stdout, stderr: child.stderr });
          return {
            version: 1, command: "session.run", status: "error", code: "session.child-exit", exitCode: childCode,
            message: child.signal === null ? `child exited with status ${childCode}` : `child terminated by ${child.signal}`,
            details: { signal: child.signal, stdout: child.stdout, stderr: child.stderr },
          };
        } catch (error) {
          return refused("session.run", error);
        }
      },
    }),
    command({
      id: "session.recover",
      cli: { path: ["session", "recover"], aliases: [], arguments: [], options: [
        { key: "workflow", flags: "--workflow <id>", required: true }, { key: "priorSession", flags: "--prior-session <id>", required: false },
        { key: "unowned", flags: "--unowned", required: false }, { key: "reason", flags: "--reason <text>", required: true },
        { key: "attestation", flags: "--attestation <path>", required: true }, { key: "expect", flags: "--expect <token>", required: true },
        { key: "operation", flags: "--operation <id>", required: true }, { key: "harness", flags: "--harness <path>", required: false },
        { key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" },
      ] },
      input: recoverInput, output: commandEnvelopeSchema, effects: ["write"],
      description: "Recover a stopped workflow coordinator through active DB authority. Recovery never resumes a session.",
      async execute(raw, context: InvocationContext) {
        const parsed = recoverInput.safeParse(raw);
        if (!parsed.success) return usage("session.recover", parsed.error.message);
        const { workflow, priorSession, unowned, reason, attestation, expect, operation, harness } = parsed.data;
        if ((priorSession === undefined) === (unowned !== true) || reason === undefined || attestation === undefined || expect === undefined || operation === undefined) {
          return usage("session.recover", "session recover requires exactly one of priorSession or unowned, reason, attestation, expect and operation");
        }
        if (context.sessionId === undefined) return usage("session.recover", "active recovery requires the main conversation session identity");
        try {
          const root = resolveProcessHarnessDir(context.cwd, harness);
          if (root === null) return usage("session.recover", "no control harness resolved; supply an absolute harness");
          const identity: ExecutionIdentity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: workflow, role: "coordinator", planId: null };
          const parsedAttestation = JSON.parse(readFileSync(attestation, "utf8")) as ActivationAttestation;
          const receipt = await recoverExecutionCoordinator(executionContextFor({ harnessDir: root }, identity), {
            expected: expect as never, operationId: operation, priorSessionId: unowned ? null : priorSession!, reason,
            attestation: parsedAttestation,
          });
          return ok("session.recover", receipt);
        } catch (error) {
          return refused("session.recover", error);
        }
      },
    }),
  ];
}
