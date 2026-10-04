import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  WORKFLOW_DELIVERY_KINDS, WORKFLOW_LIFECYCLE_STATUSES, StoreError, amendPrepareWorkflow,
  commitExecutionRegistration, createFsStore, decodeExecutionSessionRef, declareWorkflowDeliveryKind,
  executionContextFor, mutateExecutionWorkflow, normalizeIterationCompassRef, readCatalogRevisions, readSessionEnvelope,
  recoverPrepareCoordinator, recordWorkflowDelivery, registerShippedCatalogExecution,
  resolveExecutionReadRoute, resolvePlanDir, resolveProcessHarnessDir, resolveWorkflowDir, setArtifactStore, showPrepareWorkflow,
  type CatalogExecutionWorkflow, type ExecutionIdentity, type WorkflowExecutionOperation,
} from "@mstar-harness/engine";
import { commandEnvelopeSchema } from "../definitions.js";
import { IDENTITY_SUPPLIES } from "../identity-supplies.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const command = <I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> => definition;
const transitions = [
  { name: "phase", effect: "write" as const }, { name: "lifecycle", effect: "write" as const },
  { name: "execution-policy", effect: "write" as const }, { name: "integration-worktree", effect: "write" as const },
];
function ok<T>(id: string, data: T): CommandEnvelope<T> { return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data }; }
function usage(id: string, message: string): CommandEnvelope<never> { return { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message }; }
const IDENTITY_RECOVERY =
  "launch `mstar session run --workflow <id> --role coordinator -- <argv>` for a minted identity, or pass an explicit acquired `--session-id`; a launch does not bind, so first establish the binding with `mstar plan bind --execution --workflow <id> --coordinator`";

/**
 * The ACTIVE registration refusal: `expect` and `operation` are required (the
 * store's root token and the caller's replay id). Session identity is NOT —
 * it is creator attribution; an unset identity registers a NULL creator that
 * the first coordinator bind adopts.
 */
function activeRegistrationRefusal(id: string, missing: readonly string[]): CommandEnvelope<never> {
  const recovery = [
    "For workflow.register and iteration.register, expect is the store's root execution token from mstar status validate; for workflow.evidence, use the addressed workflow's token from its workflows[] entry in mstar status validate; for other workflow-scoped writes, use that addressed scope's own token.",
    "operation is your own replay id.",
    "Session identity is optional at registration: supply it when the transport has one " +
      `(${IDENTITY_SUPPLIES}); an unset identity registers a NULL creator that the first coordinator bind adopts.`,
    ...(missing.includes("sessionRef") ? ["sessionRef is the active session reference returned by the plan bind receipt; pass it as --session-ref on the CLI or sessionRef in MCP input."] : []),
  ].join(" ");
  return usage(id, `Active registration is missing ${missing.join(", ")}. ${recovery}`);
}

class WorkflowInputError extends Error {}
function refused(id: string, error: unknown): CommandEnvelope<never> {
  if (error instanceof WorkflowInputError) return usage(id, error.message);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  const details = error !== null && typeof error === "object" && "details" in error
    && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message: error instanceof Error ? error.message : String(error), ...(details === undefined ? {} : { details }) };
}
function object(value: unknown, field: string): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new WorkflowInputError(`${field} must be a JSON object`);
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new WorkflowInputError(`${field} must be an object`);
  return parsed as Record<string, unknown>;
}
function absolute(value: string | undefined, field: string): string {
  if (value === undefined || !path.isAbsolute(value)) throw new WorkflowInputError(`${field} must be an absolute path`);
  return value;
}

async function assertLegacyRoute(harnessDir: string, operation: string): Promise<void> {
  if (await resolveExecutionReadRoute({ harnessDir }) === "execution") {
    throw new StoreError(
      "execution.consumer-not-ready",
      `state: active. Upgrade outcome: not required; ${operation}: the pre-activation form is retired. ` +
        `Nothing was written; use the active DB form with the current execution token under an independently acquired identity.`,
    );
}
}
function schema() {
  return z.object({
    workflow: z.string().min(1).optional(), harness: z.string().min(1).optional(), planId: z.string().min(1).optional(),
    planTitle: z.string().min(1).optional(), planFile: z.string().min(1).optional(), deliveryKind: z.string().min(1).optional(),
    project: z.string().min(1).optional(), branchSource: z.string().min(1).optional(), branchTarget: z.string().min(1).optional(),
    completionPolicy: z.string().min(1).optional(), startedAt: z.string().min(1).optional(), expect: z.string().min(1).optional(),
    operation: z.string().min(1).optional(), file: z.string().min(1).optional(), declareKind: z.string().min(1).optional(),
    at: z.string().min(1).optional(), session: z.string().min(1).optional(), sessionRef: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(), priorSession: z.string().min(1).optional(), reason: z.string().min(1).optional(),
    stopped: z.array(z.string()).optional(),
    operationId: z.string().min(1).optional(), authorizationRef: z.string().min(1).optional(), input: z.unknown().optional(),
    phase: z.string().min(1).optional(), status: z.string().min(1).optional(), path: z.string().min(1).optional(),
    compass: z.string().min(1).optional(), policy: z.unknown().optional(), json: z.boolean().optional(),
    row: z.array(z.unknown()).optional(), branchBase: z.string().min(1).optional(), branchIntegration: z.string().min(1).optional(),
    branchTargetIteration: z.string().min(1).optional(), compassRef: z.string().min(1).optional(),
  });
}

function makeDefinition(
  id: string,
  description: string,
  effect: "read" | "write",
  keys: readonly string[],
  execute: (input: z.infer<ReturnType<typeof schema>>, context: InvocationContext) => Promise<CommandEnvelope<unknown>>,
  contextOptions: readonly { key: string; context: "sessionId" }[] = [],
): CommandDefinition {
  const input = schema().pick(Object.fromEntries(keys.map((key) => [key, true])) as never);
  const optionNames = [...keys, ...contextOptions.map(({ key }) => key)];
  return {
    id,
    cli: {
      path: id.split("."),
      aliases: [],
      arguments: [],
      options: optionNames.map((key) => {
        const field = input.shape[key as keyof typeof input.shape];
        const variadic = key === "stopped" || field instanceof z.ZodArray || (field instanceof z.ZodOptional && field.unwrap() instanceof z.ZodArray);
        return {
          key,
          flags: `--${key.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)} <value${variadic ? "..." : ""}>`,
          required: false,
          ...(variadic ? { variadic: true } : {}),
          ...(contextOptions.find((option) => option.key === key) ?? {}),
        };
      }),
    },
    input,
    payloads: Object.fromEntries(keys.flatMap((key): [string, { schema: z.ZodType }][] => {
      if (key === "row") return [[key, { schema: z.array(z.unknown()) }]];
      if (key === "input" || key === "policy") return [[key, { schema: z.record(z.string(), z.unknown()) }]];
      return [];
    })),
    output: commandEnvelopeSchema,
    effects: [effect],
    description,
    async execute(raw, context) { const parsed = input.safeParse(raw); if (!parsed.success) return usage(id, parsed.error.message); return execute(parsed.data, context); },
  };
}

export function getWorkflowCommandDefinitions(): readonly CommandDefinition[] {
  const commonRegister = ["workflow", "planId", "planTitle", "planFile", "deliveryKind", "project", "branchSource", "branchTarget", "completionPolicy", "startedAt", "harness", "expect", "operation", "json"] as const;
  const defs: CommandDefinition[] = [
    makeDefinition("workflow.register", "Register a standalone plan workflow using create-only catalog registration and active DB CAS when selected.", "write", commonRegister, async (input, context) => {
      try {
        const required = [input.workflow, input.planId, input.planTitle, input.planFile, input.deliveryKind];
        if (required.some((value) => value === undefined || value.trim() === "")) return usage("workflow.register", "workflow, planId, planTitle, planFile and deliveryKind are required");
        if (!(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(input.deliveryKind!)) return usage("workflow.register", `deliveryKind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}`);
        const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness);
        if (harnessDir === null) return usage("workflow.register", "harness dir not found; supply harness");
        const workflow: CatalogExecutionWorkflow = { kind: "plan", workflowId: input.workflow!, options: { harnessDir, plan: { id: input.planId!, title: input.planTitle!, file: input.planFile! }, deliveryKind: input.deliveryKind as never, ...(input.project === undefined ? {} : { project: input.project }), ...(input.branchSource === undefined ? {} : { branchSource: input.branchSource }), ...(input.branchTarget === undefined ? {} : { branchTarget: input.branchTarget }), ...(input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }), ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }) } };
        setArtifactStore(createFsStore(harnessDir));
        if (input.expect !== undefined || input.operation !== undefined) {
          if (input.expect === undefined || input.operation === undefined) {
            return activeRegistrationRefusal("workflow.register", [
              ...(input.expect === undefined ? ["expect"] : []),
              ...(input.operation === undefined ? ["operation"] : []),
            ]);
          }
          const identity: ExecutionIdentity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId ?? "", workflowId: input.workflow!, role: "coordinator", planId: null };
          const { catalogRevision } = await readCatalogRevisions({ harnessDir });
          const canonicalPlanAbs = path.isAbsolute(input.planFile!) ? path.resolve(input.planFile!) : path.join(harnessDir, input.planFile!);
          const plansRelative = path.relative(resolvePlanDir(harnessDir), canonicalPlanAbs);
          const relativePath = plansRelative === ".." || plansRelative.startsWith(`..${path.sep}`) || path.isAbsolute(plansRelative) ? input.planFile! : plansRelative;
          // Creator attribution is optional: an unset session id registers a
          // NULL creator that the first coordinator bind adopts.
          return ok("workflow.register", await commitExecutionRegistration(executionContextFor({ harnessDir }, identity, { allowUnsetSessionId: true }), { operationId: input.operation, actor: "mcp:workflow-register", expectedCatalogRevision: catalogRevision, workflow, delta: { entities: [{ kind: "plan", id: input.planId!, title: input.planTitle!, rootKind: "plans", relativePath }], binding: { catalogKind: "plan", catalogId: input.planId! } }, expected: input.expect as never }));
        }
        await assertLegacyRoute(harnessDir, "workflow register");
        return ok("workflow.register", await registerShippedCatalogExecution({ harnessDir }, { operationId: randomUUID(), actor: "mcp:workflow-register", workflow }));
      } catch (error) { return refused("workflow.register", error); }
    }, [{ key: "sessionId", context: "sessionId" }]),
    makeDefinition("workflow.evidence", "Record delivery evidence or one-time kind declaration; legacy file writes and active DB transitions stay disjoint.", "write", ["workflow", "file", "declareKind", "branchSource", "branchTarget", "completionPolicy", "session", "sessionRef", "expect", "operation", "at", "harness"], async (input, context) => {
      try {
        if (input.workflow === undefined) return usage("workflow.evidence", "workflow is required");
        if ((input.file === undefined) === (input.declareKind === undefined)) return usage("workflow.evidence", "provide exactly one of file or declareKind");
        if (input.declareKind !== undefined && !(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(input.declareKind)) {
          return usage("workflow.evidence", `--declare-kind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}`);
        }
        const root = resolveProcessHarnessDir(context.cwd, input.harness);
        if (root === null) return usage("workflow.evidence", "harness dir not found; supply harness");
        setArtifactStore(createFsStore(root));
        const workflowDir = path.join(resolveWorkflowDir(root, { harnessDir: root }), input.workflow);
        if (input.declareKind !== undefined) {
          if (input.sessionRef !== undefined || input.expect !== undefined || input.operation !== undefined) return usage("workflow.evidence", "declareKind is pre-activation only");
          await assertLegacyRoute(root, "workflow evidence --declare-kind");
          const result = await declareWorkflowDeliveryKind(input.workflow, workflowDir, { deliveryKind: input.declareKind as never, ...(input.branchSource === undefined ? {} : { branchSource: input.branchSource }), ...(input.branchTarget === undefined ? {} : { branchTarget: input.branchTarget }), ...(input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }), ...(input.session === undefined ? {} : { sessionPath: absolute(input.session, "session") }), ...(input.at === undefined ? {} : { at: input.at }) });
          return ok("workflow.evidence", result);
        }
        const evidence = JSON.parse(readFileSync(absolute(input.file, "file"), "utf8")) as Record<string, unknown>;
        const active = (await resolveExecutionReadRoute({ harnessDir: root })) === "execution";
        if (input.sessionRef !== undefined || input.expect !== undefined || input.operation !== undefined || active) {
          if (context.sessionId === undefined) return usage("workflow.evidence", `active evidence requires an acquired coordinator identity: ${IDENTITY_RECOVERY} (${IDENTITY_SUPPLIES}).`);
          if (input.at !== undefined || input.session !== undefined) return usage("workflow.evidence", "active evidence cannot use legacy session or at fields");
          if (input.expect !== undefined && typeof input.expect !== "string") return usage("workflow.evidence", "active evidence requires a full workflow execution token");
          const ref = input.sessionRef === undefined ? undefined : decodeExecutionSessionRef(input.sessionRef);
          const acquired = context.executionIdentity;
          if (ref !== undefined && (ref.workflowId !== input.workflow || ref.role !== "coordinator" || ref.planId !== null)) {
            return usage("workflow.evidence", "sessionRef must address the selected workflow's coordinator seat");
          }
          if (acquired !== undefined && (acquired.workflowId !== input.workflow || acquired.role !== "coordinator" || acquired.planId !== null)) {
            return usage("workflow.evidence", "acquired identity must address the selected workflow's coordinator seat");
          }
          const identity: ExecutionIdentity = acquired ?? { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: input.workflow, role: "coordinator", planId: null };
          return ok("workflow.evidence", await mutateExecutionWorkflow(executionContextFor({ harnessDir: root }, identity), {
            workflowId: input.workflow,
            ...(ref === undefined ? {} : { session: ref }),
            ...(input.expect === undefined ? {} : { expected: input.expect as never }),
            operationId: input.operation ?? randomUUID(),
            operation: { kind: "delivery", delivery: evidence },
          }));
        }
        await assertLegacyRoute(root, "workflow evidence");
        return ok("workflow.evidence", await recordWorkflowDelivery(input.workflow, workflowDir, { evidence, ...(input.session === undefined ? {} : { sessionPath: absolute(input.session, "session") }), ...(input.at === undefined ? {} : { at: input.at }) }));
      } catch (error) { return refused("workflow.evidence", error); }
    }, [{ key: "sessionId", context: "sessionId" }]),
    makeDefinition("workflow.show-prepare", "Read the pre-activation Prepare workflow view from its coordinator session envelope.", "read", ["session"], async (input, context) => {
      try { if (input.session === undefined) return usage("workflow.show-prepare", "session is required"); return ok("workflow.show-prepare", await showPrepareWorkflow({ sessionPath: absolute(input.session, "session"), cwd: context.cwd })); } catch (error) { return refused("workflow.show-prepare", error); }
    }),
    makeDefinition("workflow.amend-prepare", "Append approved Prepare rows under the current coordinator and row state.", "write", ["session", "input"], async (input, context) => {
      try {
        if (input.session === undefined || input.input === undefined) return usage("workflow.amend-prepare", "session and input patch are required");
        const sessionPath = absolute(input.session, "session");
        const envelope = readSessionEnvelope(sessionPath);
        await assertLegacyRoute(envelope.harness_root, "workflow amend-prepare");
        return ok("workflow.amend-prepare", await amendPrepareWorkflow({ sessionPath, cwd: context.cwd, patch: object(input.input, "input") as never }));
      } catch (error) { return refused("workflow.amend-prepare", error); }
    }),
    makeDefinition("workflow.recover-coordinator", "Recover a pre-activation Prepare coordinator binding; this does not resume or transfer a lease.", "write", ["session", "operationId", "reason", "authorizationRef", "stopped"], async (input, context) => {
      try {
        if (input.session === undefined || input.operationId === undefined || input.reason === undefined || input.authorizationRef === undefined || input.stopped === undefined) return usage("workflow.recover-coordinator", "session, operationId, reason, authorizationRef and stopped are required");
        if (context.sessionId === undefined || context.sessionId.trim() === "") {
          return usage(
            "workflow.recover-coordinator",
            `recovery requires the main conversation session identity (${IDENTITY_SUPPLIES}).`,
          );
        }
        const priorSessionPath = absolute(input.session, "session");
        const prior = readSessionEnvelope(priorSessionPath);
        setArtifactStore(createFsStore(prior.harness_root));
        return ok("workflow.recover-coordinator", await recoverPrepareCoordinator({
          cwd: context.cwd,
          harnessDir: prior.harness_root,
          identity: { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: prior.workflow_id, role: "coordinator", planId: null },
          priorSessionPath,
          priorSessionId: prior.session_id,
          operationId: input.operationId,
          reason: input.reason,
          authorizationRef: input.authorizationRef,
          stoppedSessionIds: input.stopped,
        }));
      } catch (error) { return refused("workflow.recover-coordinator", error); }
    }, [{ key: "sessionId", context: "sessionId" }]),
  ];
  for (const transition of transitions) {
    const id = `workflow.${transition.name}`;
    defs.push(makeDefinition(id, `Apply the existing active workflow ${transition.name} transition under coordinator scope.`, transition.effect, ["workflow", "sessionRef", "expect", "operation", "harness", "phase", "compass", "status", "reason", "file", "path"], async (input, context) => {
      try {
        if (context.sessionId === undefined) return usage(id, `active workflow transition requires an acquired coordinator identity: ${IDENTITY_RECOVERY} (${IDENTITY_SUPPLIES}).`);
        const ref = input.sessionRef === undefined ? undefined : decodeExecutionSessionRef(input.sessionRef);
        const acquired = context.executionIdentity;
        const workflowId = input.workflow ?? acquired?.workflowId ?? ref?.workflowId;
        if (workflowId === undefined) return usage(id, "workflow selector or minted workflow identity is required");
        if (ref !== undefined && (ref.workflowId !== workflowId || ref.role !== "coordinator" || ref.planId !== null)) {
          return usage(id, "sessionRef must address the selected workflow's coordinator seat");
        }
        if (acquired !== undefined && (acquired.workflowId !== workflowId || acquired.role !== "coordinator" || acquired.planId !== null)) {
          return usage(id, "acquired caller identity does not address the selected coordinator workflow");
        }
        const root = resolveProcessHarnessDir(context.cwd, input.harness);
        if (root === null) return usage(id, "no control harness resolved; supply an absolute harness");
        const operation: WorkflowExecutionOperation = transition.name === "phase"
          ? input.phase === undefined || input.compass === undefined || !path.isAbsolute(input.compass) ? (() => { throw new Error("phase requires phase and absolute compass") })() : { kind: "phase", phase: input.phase, compassPath: input.compass }
          : transition.name === "lifecycle"
            ? input.status === undefined || input.reason === undefined || !(WORKFLOW_LIFECYCLE_STATUSES as readonly string[]).includes(input.status) ? (() => { throw new Error("lifecycle requires a supported status and reason") })() : { kind: "lifecycle", status: input.status as never, reason: input.reason }
            : transition.name === "execution-policy"
              ? { kind: "execution-policy", policy: JSON.parse(readFileSync(absolute(input.file, "file"), "utf8")) }
              : { kind: "integration-worktree", path: absolute(input.path, "path") };
        const identity: ExecutionIdentity = acquired ?? { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId, role: "coordinator", planId: null };
        setArtifactStore(createFsStore(root));
        return ok(id, await mutateExecutionWorkflow(executionContextFor({ harnessDir: root }, identity), {
          workflowId,
          ...(ref === undefined ? {} : { session: ref }),
          ...(input.expect === undefined ? {} : { expected: input.expect as never }),
          operationId: input.operation ?? randomUUID(),
          operation,
        }));
      } catch (error) { return refused(id, error); }
    }, [{ key: "sessionId", context: "sessionId" }]));
  }
  defs.push(makeDefinition("iteration.register", "Register a create-only iteration workflow with its branch anchors and Todo rows.", "write", ["workflow", "compassRef", "branchBase", "branchIntegration", "branchTargetIteration", "row", "project", "startedAt", "harness", "expect", "operation"], async (input, context) => {
    try {
      if (input.workflow === undefined || input.workflow.trim() === "" || input.compassRef === undefined || input.compassRef.trim() === "" || input.branchBase === undefined || input.branchBase.trim() === "" || input.branchIntegration === undefined || input.branchIntegration.trim() === "" || input.branchTargetIteration === undefined || input.branchTargetIteration.trim() === "" || input.row === undefined || input.row.length === 0) {
        return usage("iteration.register", "workflow, compassRef, all branch anchors and rows are required");
      }
      const rows = input.row.map((value) => {
        if (typeof value !== "string") return value;
        try { return JSON.parse(value); } catch { return undefined; }
      });
      if (rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
        return usage("iteration.register", "each row must be a JSON object");
      }
      const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness);
      if (harnessDir === null) return usage("iteration.register", "harness dir not found; supply harness");
      // Normalize BEFORE the registration workflow/catalog plan is composed:
      // the catalog identity is derived from this same value, so the caller's
      // absolute-in-root spelling must reach every consumer in the stored
      // (harness-relative) contract form — otherwise the producer's own
      // normalization would disagree with the catalog plan and the post-write
      // identity check would refuse an otherwise-successful registration
      // (Greptile #301 issue 1).
      const compassRef = normalizeIterationCompassRef(input.compassRef, harnessDir, (detail) => new WorkflowInputError(detail));
      const workflow: CatalogExecutionWorkflow = { kind: "iteration", workflowId: input.workflow, options: { harnessDir, compassRef, branch: { base: input.branchBase, integration: input.branchIntegration, target: input.branchTargetIteration }, rows: rows as never[], ...(input.project === undefined ? {} : { project: input.project }), ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }) } };
      setArtifactStore(createFsStore(harnessDir));
      if (input.expect !== undefined || input.operation !== undefined) {
        if (input.expect === undefined || input.operation === undefined) {
          return activeRegistrationRefusal("iteration.register", [
            ...(input.expect === undefined ? ["expect"] : []),
            ...(input.operation === undefined ? ["operation"] : []),
          ]);
        }
        const identity: ExecutionIdentity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId ?? "", workflowId: input.workflow, role: "coordinator", planId: null };
        const { catalogRevision } = await readCatalogRevisions({ harnessDir });
        // Creator attribution is optional: an unset session id registers a
        // NULL creator that the first coordinator bind adopts.
        return ok("iteration.register", await commitExecutionRegistration(executionContextFor({ harnessDir }, identity, { allowUnsetSessionId: true }), { operationId: input.operation, actor: "mcp:iteration-register", expectedCatalogRevision: catalogRevision, workflow, delta: { entities: [{ kind: "iteration", id: input.workflow, title: input.workflow, rootKind: "iterations", relativePath: input.workflow }], binding: { catalogKind: "iteration", catalogId: input.workflow } }, expected: input.expect as never }));
      }
      await assertLegacyRoute(harnessDir, "iteration register");
      return ok("iteration.register", await registerShippedCatalogExecution({ harnessDir }, { operationId: randomUUID(), actor: "mcp:iteration-register", workflow }));
    } catch (error) { return refused("iteration.register", error); }
  }, [{ key: "sessionId", context: "sessionId" }]));
  return defs;
}
