import { randomUUID } from "node:crypto";
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
  readExecutionAuthority,
  resolveExecutionReadRoute,
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
import { IDENTITY_SUPPLIES } from "../identity-supplies.js";
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
    case "plan.release":
      return { kind: "release", ...(input.reason === undefined ? {} : { reason: input.reason }) };
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
        if (context.sessionId === undefined) return usage(id, `active resume requires runtime session identity (${IDENTITY_SUPPLIES}).`);
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
        if (context.sessionId === undefined || input.workflow === undefined) {
          return usage(id, `active bind requires runtime session identity and workflow (identity ${IDENTITY_SUPPLIES}).`);
        }
        if (input.expect !== undefined && typeof input.expect !== "string") return usage(id, "active bind requires a full execution token");
        const coordinator = input.coordinator === true;
        if (coordinator && input.plan !== undefined) return usage(id, "coordinator bind accepts no plan");
        if (!coordinator && input.plan === undefined) return usage(id, "active bind requires coordinator or plan");
        const role = coordinator ? "coordinator" : "plan-pm";
        const planId = coordinator ? null : input.plan!;
        const acquired = context.executionIdentity;
        if (acquired !== undefined && (
          acquired.workflowId !== input.workflow || acquired.role !== role || acquired.planId !== planId
        )) {
          return usage(id, "bind selectors do not match the acquired caller identity");
        }
        const root = resolveProcessHarnessDir(cwd, input.harness);
        if (root === null) return usage(id, "no control harness resolved; supply an absolute harness");
        setArtifactStore(createFsStore(root));
        const identity: ExecutionIdentity = acquired ?? {
          source: context.host === undefined ? "local" : "host",
          sessionId: context.sessionId,
          workflowId: input.workflow,
          role,
          planId,
        };
        const beforeBind = input.expect === undefined
          ? await readExecutionAuthority({ harnessDir: root }, {
            workflowId: input.workflow,
            ...(role === "plan-pm" ? { planId: input.plan! } : {}),
          })
          : undefined;
        const receipt = await bindExecutionSession(executionContextFor({ harnessDir: root }, identity), {
          workflowId: input.workflow,
          planId,
          role,
          expected: (input.expect ?? beforeBind!.token) as ExecutionToken,
          operationId: input.operation ?? randomUUID(),
        });
        return ok(id, receipt);
      }
      let bindInput: BindPlanSessionInput;
      if (input.resume !== undefined) {
        if ((context.sessionId !== undefined && context.sessionIdSource !== "env") || input.harness !== undefined) {
          return usage(id, "--resume accepts no --session-id or --harness");
        }
        const resumePath = absolutePath(input.resume, "resume");
        pinSessionStore(resumePath);
        bindInput = { resumePath, cwd };
      } else if (input.coordinator === true) {
        if (context.sessionId === undefined || context.sessionId.trim() === "" || context.sessionIdSource === "env") {
          const message = context.sessionIdSource === "env"
            ? "legacy pre-activation coordinator bootstrap does not accept env-provided identity; pass --session-id explicitly"
            : `coordinator bind requires runtime session identity (${IDENTITY_SUPPLIES}).`;
          return usage(id, message);
        }
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
        if (context.sessionId === undefined || context.sessionId.trim() === "") {
          return usage(id, `plan-session bind requires runtime session identity (${IDENTITY_SUPPLIES}).`);
        }
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
        return usage(id, `show requires a session file or sessionRef, plan selector, and runtime session identity (identity ${IDENTITY_SUPPLIES}).`);
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
    const sparseSelectors = context.executionIdentity !== undefined ||
      (input.workflow !== undefined && (input.coordinator === true || input.plan !== undefined));
    // `release` is ACTIVE-only and takes no pre-activation file form, so a
    // selector-less invocation still routes here: the engine's own authority
    // check then reports the truthful ACTIVE/upgrade fact instead of a dead end.
    if (input.sessionRef !== undefined || (input.session === undefined && (sparseSelectors || id === "plan.release"))) {
      if (context.sessionId === undefined) {
        return usage(id, `active operation requires an acquired runtime session identity (${IDENTITY_SUPPLIES}).`);
      }
      if (input.expect !== undefined && typeof input.expect !== "string") return usage(id, "active operation requires a full execution token");
      // Release is ACTIVE-only: a pre-activation control root has no DB claim to
      // release, so it reports the supported operator-authorized store upgrade
      // path rather than a generic unknown-operation. The engine re-reports the
      // same fact for a request that reaches it.
      if (id === "plan.release") {
        const releaseRoot = resolveProcessHarnessDir(context.cwd, input.harness);
        if (releaseRoot !== null && (await resolveExecutionReadRoute({ harnessDir: releaseRoot })) !== "execution") {
          return refused(
            id,
            "execution.not-active",
            "plan release requires an ACTIVE execution authority; this control root is pre-activation. An authorized operator may run " +
              "`mstar store safe-upgrade` with valid operator attestation to activate the store, then bind and release. This call does not authorize that route.",
          );
        }
      }
      // A numeric revision is the file route's CAS transport; the active route
      // takes only a full execution token, so the transports never mix.
      const operation = fileOperation(id, input);
      const operationId = input.operation ?? randomUUID();
      const ref = input.sessionRef === undefined ? undefined : decodeExecutionSessionRef(input.sessionRef);
      const root = resolveProcessHarnessDir(context.cwd, input.harness);
      if (root === null) return usage(id, "no control harness resolved; supply an absolute harness");
      setArtifactStore(createFsStore(root));
      const acquired = context.executionIdentity;
      const workflowId = ref?.workflowId ?? acquired?.workflowId ?? input.workflow;
      const role = ref?.role ?? acquired?.role ?? (input.coordinator === true ? "coordinator" : input.plan !== undefined ? "plan-pm" : undefined);
      // The plan the caller's own binding names (the seat), distinct from the
      // plan this operation addresses (which a coordinator states explicitly).
      const ownPlan = ref !== undefined ? ref.planId : acquired?.planId ?? input.plan ?? null;
      if (input.workflow !== undefined && input.workflow !== workflowId) {
        return usage(id, "workflow selector does not match the caller's workflow");
      }
      // A stated `--coordinator` seat is a role constraint, never a hint the
      // family may reinterpret: when the acquired/declared caller is this
      // plan's own plan session, the mismatch refuses before any address,
      // token or ownership fact is read.
      if (input.coordinator === true && role !== "coordinator") {
        return usage(id, "--coordinator does not match the caller's acquired plan session seat; a plan-session claim is released by the seat that holds it");
      }
      if (workflowId === undefined || role === undefined) {
        return usage(id, "sparse active plan operation needs a minted own-scope identity or workflow plus coordinator/plan selector; bind the caller first");
      }
      // A plan-pm call addresses its own bound plan; a coordinator call must
      // state the plan it addresses. Neither is guessed from "the only" row.
      let addressedPlan: string | undefined;
      if (role === "coordinator") {
        addressedPlan = input.plan;
      } else {
        if (ownPlan === null) {
          return usage(id, "a plan-pm sparse operation needs its own plan binding or an explicit plan selector");
        }
        if (input.plan !== undefined && input.plan !== ownPlan) {
          return usage(id, "plan selector does not match the caller's plan");
        }
        addressedPlan = ownPlan;
      }
      if (acquired !== undefined && (
        workflowId !== acquired.workflowId ||
        role !== acquired.role ||
        (role === "plan-pm" && ownPlan !== acquired.planId)
      )) {
        return usage(id, "selected workflow, role or plan does not match the acquired caller identity");
      }
      const identity: ExecutionIdentity = {
        source: acquired?.source ?? (context.host === undefined ? "local" : "host"),
        sessionId: context.sessionId,
        workflowId,
        role,
        planId: role === "coordinator" ? null : ownPlan,
      };
      const receipt = await mutateExecutionPlan(executionContextFor({ harnessDir: root }, identity), {
        operationId,
        ...(ref === undefined ? {} : { session: ref }),
        ...(input.expect === undefined ? {} : { expected: input.expect as ExecutionToken }),
        ...(addressedPlan === undefined ? {} : { planId: addressedPlan }),
        operation: operation as never,
      });
      return ok(id, receipt);
    }
    if (id === "plan.release") {
      return refused(id, "execution.not-active", "plan release is available only under ACTIVE execution authority; on a pre-activation control root, use the operator-authorized store safe-upgrade route before binding and releasing");
    }
    const operation = fileOperation(id, input);
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
  release: true,
  reconcile: true,
  "residual-add": true,
  "residual-close": true,
};
const commandNames = ["bind", "show", "prepare", "progress", "issue-add", "issue-close", "handoff", "release", ...transitions.map(([verb]) => verb), "residual-add", "residual-close"] as const;
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
      description: verb === "release" ? "Release the caller's own held execution claim; explicitly bind to reacquire." : transitions.find(([name]) => name === verb)?.[1] ?? `Scoped plan ${verb} operation; engine enforces ownership, state and concurrency guards.`,
      execute: (input, context) => execute(id, input, context),
    });
  });
}
