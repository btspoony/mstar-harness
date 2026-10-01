import {
  bindPlanSession,
  bindExecutionSession,
  createFsStore,
  decodeExecutionSessionRef,
  executionContextFor,
  mutateExecutionPlan,
  mutatePlanCoordination,
  readExecutionPlan,
  readPlanCoordination,
  resolveProcessHarnessDir,
  readSessionEnvelope,
  resumeExecutionSession,
  setArtifactStore,
  type BindPlanSessionInput,
  type ExecutionIdentity,
  type ExecutionToken,
  type PlanCoordinationOperation,
} from "@mstar-harness/engine";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { commandEnvelopeSchema } from "../definitions.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const progressPayloadSchema = z.record(z.string(), z.unknown());
const entryPayloadSchema = z.record(z.string(), z.unknown());
const entriesPayloadSchema = z.array(entryPayloadSchema);
const evidencePayloadSchema = z.record(z.string(), z.unknown());
const inputSchema = z.object({
  session: z.string().min(1).optional(),
  sessionRef: z.string().min(1).optional(),
  resumeRef: z.string().min(1).optional(),
  resume: z.string().min(1).optional(),
  coordinator: z.boolean().optional(),
  execution: z.boolean().optional(),
  workflow: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  assignment: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  expect: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
  operation: z.string().min(1).optional(),
  handoff: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  progress: progressPayloadSchema.optional(),
  entries: entriesPayloadSchema.optional(),
  issue: z.string().min(1).optional(),
  disposition: z.enum(["resolved", "waived", "duplicate", "superseded"]).optional(),
  evidence: evidencePayloadSchema.optional(),
  expectIssue: z.number().int().nonnegative().optional(),
});
type PlanInput = z.infer<typeof inputSchema>;

const optionKeys = Object.keys(inputSchema.shape);
const transitions = [
  ["accept", "Accept a submitted handoff and transfer execution ownership to the coordinator"],
  ["return", "Return a submitted or accepted handoff to the plan owner"],
  ["integration-start", "Record and pin an integration attempt before the operator performs Git merge"],
  ["integration-accept", "Verify the pinned Git result of a started integration attempt"],
  ["complete", "Record Done after verified delivery proof"],
  ["repair-delivery-source", "Replace a wrong registered delivery source from the accepted handoff pin"],
  ["reconcile", "Recover an interrupted integration attempt from the observed checkout"],
] as const;

export const PLAN_COORDINATOR_TRANSITIONS = transitions;
class PlanInputError extends Error {}

function ok<T>(id: string, data: T): CommandEnvelope<T> {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused(id: string, code: string, message: string): CommandEnvelope<never> {
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}
function usage(id: string, message: string): CommandEnvelope<never> {
  return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message };
}
function failure(id: string, error: unknown): CommandEnvelope<never> {
  if (error instanceof PlanInputError) return usage(id, error.message);
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : `${id}.internal-error`;
  const details = error !== null && typeof error === "object" && "details" in error
    && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  return { ...refused(id, code, message), ...(details !== undefined ? { details } : {}) };
}
function command<I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> {
  return definition;
}
function absolutePath(value: string | undefined, key: string): string {
  if (value === undefined || !path.isAbsolute(value)) throw new PlanInputError(`${key} must be an absolute path`);
  return value;
}
function expectedRevision(value: PlanInput["expect"]): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new PlanInputError("expect must be a nonnegative integer revision");
  return parsed;
}
function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PlanInputError(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function payloadFromFile(file: string | undefined, field: string): unknown {
  const absolute = absolutePath(file, field);
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new PlanInputError(error instanceof SyntaxError ? `${field} is not valid JSON` : `${field} payload file not found`);
  }
}
function fileOperation(id: string, input: PlanInput): PlanCoordinationOperation {
  switch (id) {
    case "plan.prepare":
      return { kind: "prepare", assignmentPath: absolutePath(input.assignment, "assignment") };
    case "plan.progress":
      return { kind: "progress", progress: jsonObject(input.progress ?? payloadFromFile(input.file, "file"), "progress") as never };
    case "plan.issue-add": {
      const entries = input.entries ?? payloadFromFile(input.file, "file");
      if (!Array.isArray(entries)) throw new PlanInputError("entries must be a JSON array");
      return { kind: "residual-add", entries: entries as never[] };
    }
    case "plan.issue-close":
      if (input.issue === undefined || input.disposition === undefined || input.expectIssue === undefined) {
        throw new PlanInputError("issue, disposition and expectIssue are required");
      }
      return {
        kind: "residual-close",
        issueId: input.issue,
        disposition: input.disposition,
        expectedIssueRevision: input.expectIssue,
        evidence: jsonObject(input.evidence ?? payloadFromFile(input.file, "file"), "file") as never,
      };
    case "plan.handoff":
      return { kind: "handoff", evidence: jsonObject(input.evidence ?? payloadFromFile(input.file, "file"), "file") as never };
    case "plan.accept":
    case "plan.return":
    case "plan.integration-start":
    case "plan.integration-accept":
    case "plan.complete":
    case "plan.repair-delivery-source":
    case "plan.reconcile":
      if (input.handoff === undefined) throw new PlanInputError("handoff is required");
      if (id === "plan.return") {
        if (input.reason === undefined) throw new PlanInputError("reason is required for return");
        return { kind: "return", handoffId: input.handoff, reason: input.reason };
      }
      return { kind: id.slice("plan.".length) as PlanCoordinationOperation["kind"], handoffId: input.handoff } as PlanCoordinationOperation;
    default:
      throw new PlanInputError(`unsupported plan operation ${id}`);
  }
}
function pinSessionStore(sessionPath: string): void {
  setArtifactStore(createFsStore(readSessionEnvelope(sessionPath).harness_root));
}

async function execute(id: string, input: PlanInput, context: InvocationContext): Promise<CommandEnvelope<unknown>> {
  try {
    if (id === "plan.residual-add" || id === "plan.residual-close") {
      const replacement = id.endsWith("residual-add") ? "issue-add" : "issue-close";
      return refused(
        id,
        "plan.verb-retired",
        `\`mstar plan ${replacement}\` is the replacement for \`${id.replace("plan.", "mstar plan ")}\``,
      );
    }
    if (input.session !== undefined && input.sessionRef !== undefined) {
      return usage(id, "pre-activation and active transports are disjoint");
    }
    if (id === "plan.bind") {
      const cwd = context.cwd;
      if (input.resumeRef !== undefined) {
        if (context.sessionId === undefined) return usage(id, "active resume requires runtime session identity");
        const ref = decodeExecutionSessionRef(input.resumeRef);
        const root = resolveProcessHarnessDir(cwd, input.harness);
        if (root === null) return usage(id, "no control harness resolved; supply an absolute harness");
        setArtifactStore(createFsStore(root));
        const identity: ExecutionIdentity = {
          source: context.host === undefined ? "local" : "host",
          sessionId: context.sessionId,
          workflowId: ref.workflowId,
          role: ref.role,
          planId: ref.planId,
        };
        return ok(id, await resumeExecutionSession(executionContextFor({ harnessDir: root }, identity), ref));
      }
      if (input.execution === true) {
        if (context.sessionId === undefined || input.workflow === undefined || input.expect === undefined || input.operation === undefined) {
          return usage(id, "active bind requires runtime session identity, workflow, full execution token and operation id");
        }
        const coordinator = input.coordinator === true;
        if (coordinator && input.plan !== undefined) return usage(id, "coordinator bind accepts no plan");
        if (!coordinator && input.plan === undefined) return usage(id, "active bind requires coordinator or plan");
        const role = coordinator ? "coordinator" : "plan-pm";
        const planId = coordinator ? null : input.plan!;
        const root = resolveProcessHarnessDir(cwd, input.harness);
        if (root === null) return usage(id, "no control harness resolved; supply an absolute harness");
        setArtifactStore(createFsStore(root));
        const identity: ExecutionIdentity = {
          source: context.host === undefined ? "local" : "host",
          sessionId: context.sessionId,
          workflowId: input.workflow,
          role,
          planId,
        };
        const receipt = await bindExecutionSession(executionContextFor({ harnessDir: root }, identity), {
          workflowId: input.workflow,
          planId,
          role,
          expected: input.expect as ExecutionToken,
          operationId: input.operation,
        });
        return ok(id, receipt);
      }
      let bindInput: BindPlanSessionInput;
      if (input.resume !== undefined) {
        if (context.sessionId !== undefined || input.harness !== undefined) {
          return usage(id, "--resume accepts no --session-id or --harness");
        }
        const resumePath = absolutePath(input.resume, "resume");
        pinSessionStore(resumePath);
        bindInput = { resumePath, cwd };
      } else if (input.coordinator === true) {
        if (context.sessionId === undefined || context.sessionId.trim() === "") return usage(id, "coordinator bind requires runtime session identity");
        if (input.workflow === undefined) return usage(id, "coordinator bind requires workflow");
        const root = resolveProcessHarnessDir(cwd, input.harness);
        if (root !== null) setArtifactStore(createFsStore(root));
        bindInput = {
          coordinator: true,
          workflowId: input.workflow,
          cwd,
          sessionId: context.sessionId,
          ...(input.harness !== undefined ? { harnessDir: absolutePath(input.harness, "harness") } : {}),
        };
      } else if (input.assignment !== undefined) {
        if (context.sessionId === undefined || context.sessionId.trim() === "") return usage(id, "plan-session bind requires runtime session identity");
        const root = resolveProcessHarnessDir(cwd, input.harness);
        if (root !== null) setArtifactStore(createFsStore(root));
        bindInput = {
          scope: { assignmentPath: absolutePath(input.assignment, "assignment") },
          cwd,
          sessionId: context.sessionId,
        };
      } else if (input.workflow !== undefined && input.plan !== undefined) {
        if (context.sessionId === undefined || context.sessionId.trim() === "") return usage(id, "plan-session bind requires runtime session identity");
        const root = resolveProcessHarnessDir(cwd, input.harness);
        if (root !== null) setArtifactStore(createFsStore(root));
        bindInput = {
          scope: { workflowId: input.workflow, planId: input.plan, ...(input.harness !== undefined ? { harnessDir: absolutePath(input.harness, "harness") } : {}) },
          cwd,
          sessionId: context.sessionId,
        };
      } else {
        return usage(id, "bind requires a session, coordinator workflow, assignment, or workflow and plan");
      }
      return ok(id, await bindPlanSession(bindInput));
    }
    if (id === "plan.show") {
      if (input.session !== undefined) {
        const sessionPath = absolutePath(input.session, "session");
        pinSessionStore(sessionPath);
        return ok(id, await readPlanCoordination(sessionPath, input.plan, context.cwd));
      }
      if (input.sessionRef === undefined || input.plan === undefined || context.sessionId === undefined) {
        return usage(id, "show requires a session file or sessionRef, plan selector, and runtime session identity");
      }
      const ref = decodeExecutionSessionRef(input.sessionRef);
      const root = resolveProcessHarnessDir(context.cwd, input.harness);
      if (root === null) return usage(id, "no control harness resolved; supply an absolute harness");
      setArtifactStore(createFsStore(root));
      const identity: ExecutionIdentity = {
        source: context.host === undefined ? "local" : "host",
        sessionId: context.sessionId,
        workflowId: ref.workflowId,
        role: ref.role,
        planId: ref.planId,
      };
      const result = await readExecutionPlan(executionContextFor({ harnessDir: root }, identity), ref, input.plan);
      return ok(id, result);
    }
    const operation = fileOperation(id, input);
    if (input.sessionRef !== undefined) {
      // The ACTIVE route states no transport prerequisites for the derivable
      // half: the engine's own authority boundary resolves the sparse intent —
      // it derives the plan token and plan address from the trusted caller's
      // own binding, and an ambiguous target or foreign holder is refused
      // there with grouped genuine facts. The runtime caller identity is NOT
      // derivable: the session reference is a canonical transport projection
      // (never an authenticated identity), so the caller's own session id must
      // be supplied independently by the host adapter — a ref for a session
      // this caller does not hold is never adopted as its identity. The
      // operation id is the other caller-owned required field (the engine's
      // own assertOperationId runs only after resolution).
      if (context.sessionId === undefined) return usage(id, "active operation requires runtime session identity");
      if (input.operation === undefined) return usage(id, "active operation requires an operation id");
      const operationId = input.operation;
      const ref = decodeExecutionSessionRef(input.sessionRef);
      const planId = ref.planId ?? input.plan;
      const root = resolveProcessHarnessDir(context.cwd, input.harness);
      if (root === null) return usage(id, "no control harness resolved; supply an absolute harness");
      setArtifactStore(createFsStore(root));
      const identity: ExecutionIdentity = {
        source: context.host === undefined ? "local" : "host",
        sessionId: context.sessionId,
        workflowId: ref.workflowId,
        role: ref.role,
        planId: ref.planId,
      };
      const receipt = await mutateExecutionPlan(executionContextFor({ harnessDir: root }, identity), {
        operationId,
        session: ref,
        // An omitted token is the sparse intent the engine resolves; an
        // explicit one is passed through untouched as a CAS constraint.
        ...(input.expect === undefined ? {} : { expected: input.expect as ExecutionToken }),
        planId,
        operation: operation as never,
      });
      return ok(id, receipt);
    }
    if (input.session === undefined) return usage(id, "operation requires session or active sessionRef");
    const sessionPath = absolutePath(input.session, "session");
    pinSessionStore(sessionPath);
    const result = await mutatePlanCoordination({
      sessionPath,
      ...(input.plan !== undefined ? { planId: input.plan } : {}),
      expectedRevision: expectedRevision(input.expect),
      operation,
    });
    return ok(id, result);
  } catch (error) {
    return failure(id, error);
  }
}

const writeCommands: Record<string, true> = {
  bind: true,
  prepare: true,
  progress: true,
  "issue-add": true,
  "issue-close": true,
  handoff: true,
  accept: true,
  return: true,
  "integration-start": true,
  "integration-accept": true,
  complete: true,
  "repair-delivery-source": true,
  reconcile: true,
  "residual-add": true,
  "residual-close": true,
};
const commandNames = ["bind", "show", "prepare", "progress", "issue-add", "issue-close", "handoff", ...transitions.map(([verb]) => verb), "residual-add", "residual-close"] as const;
const payloadFieldsByVerb: Partial<Record<(typeof commandNames)[number], readonly (keyof typeof inputSchema.shape)[]>> = {
  progress: ["progress"],
  "issue-add": ["entries"],
  "issue-close": ["evidence"],
  handoff: ["evidence"],
};
export function getPlanCommandDefinitions(): readonly CommandDefinition[] {
  return commandNames.map((verb) => {
    const id = `plan.${verb}`;
    return command<PlanInput, unknown>({
      id,
      cli: {
        path: ["plan", verb],
        aliases: [],
        arguments: [],
        options: [
          ...optionKeys.map((key) => ({ key, flags: `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} <value>`, required: false })),
          { key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" as const },
        ],
      },
      input: inputSchema,
      payloads: Object.fromEntries(
        (payloadFieldsByVerb[verb] ?? []).map((field) => [field, { schema: inputSchema.shape[field] }]),
      ),
      output: commandEnvelopeSchema,
      effects: writeCommands[verb] === true ? ["write"] : ["read"],
      description: transitions.find(([name]) => name === verb)?.[1] ?? `Scoped plan ${verb} operation; engine enforces ownership, state and concurrency guards.`,
      execute: (input, context) => execute(id, input, context),
    });
  });
}
