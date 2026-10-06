import { randomUUID } from "node:crypto";
import {
  bindExecutionSession,
  bindPlanSession,
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
  StoreError,
  type BindPlanSessionInput,
  type ExecutionIdentity,
  type ExecutionToken,
  type PlanCoordinationOperation,
} from "@mstar-harness/engine";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../definitions.js";
import { IDENTITY_SUPPLIES, SESSION_REF_SUPPLIES, TOKEN_SUPPLIES } from "../identity-supplies.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const progressPayloadSchema = z.record(z.string(), z.unknown());
const entryPayloadSchema = z.record(z.string(), z.unknown());
const entriesPayloadSchema = z.array(entryPayloadSchema);
const evidencePayloadSchema = z.record(z.string(), z.unknown());
/**
 * The declared payload shape of `plan complete`: the ordinary completion
 * evidence the engine records, mirrored here so both transports publish one
 * contract. The engine re-validates the same fields (hashed `EvidenceRef`s,
 * accepted QC decisions, QA `pass`) — this schema is transport shaping, never
 * the authority.
 */
const completionEvidenceSchema = z.object({
  source_sha: z.string().min(1).optional(),
  review_base: z.string().min(1).optional(),
  review_head: z.string().min(1).optional(),
  qc: z.object({
    decision: z.enum(["Approve", "Approve with residuals"]),
    reports: z.array(z.string().min(1)),
    consolidated: z.string().min(1),
  }),
  qa: z.object({
    gate: z.enum(["mandatory", "pm-acceptance"]),
    decision: z.literal("pass"),
    report: z.string().min(1),
  }),
});
const inputSchema = z.object({
  session: z.string().min(1).optional(),
  sessionRef: z.string().min(1).optional(),
  resumeRef: z.string().min(1).optional(),
  resume: z.string().min(1).optional(),
  coordinator: z.boolean().optional(),
  execution: z.boolean().optional(),
  workflow: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  expect: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
  operation: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  workingBranch: z.string().min(1).optional(),
  qaGate: z.enum(["mandatory", "pm-acceptance"]).optional(),
  findingsCleanup: z.enum(["zero-residual", "allow-residual"]).optional(),
  progress: progressPayloadSchema.optional(),
  entries: entriesPayloadSchema.optional(),
  issue: z.string().min(1).optional(),
  disposition: z.enum(["resolved", "waived", "duplicate", "superseded"]).optional(),
  evidence: evidencePayloadSchema.optional(),
  integrationBaseSha: z.string().min(1).optional(),
  integrationResultSha: z.string().min(1).optional(),
  expectIssue: z.number().int().nonnegative().optional(),
});
type PlanInput = z.infer<typeof inputSchema>;

const optionKeys = Object.keys(inputSchema.shape);
class PlanInputError extends Error {}

function ok<T>(id: string, data: T): CommandEnvelope<T> {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function failure(id: string, error: unknown): CommandEnvelope<never> {
  if (error instanceof PlanInputError) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: error.message });
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : `${id}.internal-error`;
  const details = error !== null && typeof error === "object" && "details" in error
    && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  return refusalEnvelope({
    command: id, status: "refused", code, exitCode: 1, message,
    ...(details === undefined ? {} : { details }),
  });
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
/**
 * The ordinary revisable execution configuration of `plan prepare`. Each member
 * is optional and falls back to the row's recorded metadata; the engine applies
 * its own defaults (`mandatory`, `allow-residual`) and validates the actual
 * supplied checkout/branch rather than comparing against a prior sealed value.
 */
function prepareConfig(input: PlanInput): PlanCoordinationOperation {
  const config: { worktreePath?: string; workingBranch?: string; qaGate?: "mandatory" | "pm-acceptance"; findingsCleanup?: "zero-residual" | "allow-residual" } = {};
  if (input.worktreePath !== undefined) config.worktreePath = input.worktreePath;
  if (input.workingBranch !== undefined) config.workingBranch = input.workingBranch;
  if (input.qaGate !== undefined) config.qaGate = input.qaGate;
  if (input.findingsCleanup !== undefined) config.findingsCleanup = input.findingsCleanup;
  return Object.keys(config).length === 0 ? { kind: "prepare" } : { kind: "prepare", config };
}
/**
 * The direct completion the coordinator records after QC/QA and the real Git
 * integration: the evidence payload (JSON file or inline), plus the optional
 * already-performed serial merge pair an iteration row names. Both are the
 * engine's own `CompletionEvidence` / `IntegrationResultInput`; a partial pair
 * is a caller-input refusal rather than a silently half-stated merge.
 */
function completeOperation(input: PlanInput): PlanCoordinationOperation {
  const evidence = jsonObject(input.evidence ?? payloadFromFile(input.file, "file"), "evidence");
  if ((input.integrationBaseSha === undefined) !== (input.integrationResultSha === undefined)) {
    throw new PlanInputError("integrationBaseSha and integrationResultSha must be supplied together");
  }
  return input.integrationBaseSha === undefined
    ? { kind: "complete", evidence: evidence as never }
    : { kind: "complete", evidence: evidence as never, integration: { base_sha: input.integrationBaseSha, result_sha: input.integrationResultSha! } };
}
function fileOperation(id: string, input: PlanInput): PlanCoordinationOperation {
  switch (id) {
    case "plan.prepare":
      return prepareConfig(input);
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
    case "plan.complete":
      return completeOperation(input);
    default:
      throw new PlanInputError(`unsupported plan operation ${id}`);
  }
}
function pinSessionStore(sessionPath: string): void {
  setArtifactStore(createFsStore(readSessionEnvelope(sessionPath).harness_root));
}

async function execute(id: string, input: PlanInput, context: InvocationContext): Promise<CommandEnvelope<unknown>> {
  try {
    if (input.session !== undefined && input.sessionRef !== undefined) {
      return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "pre-activation and active transports are disjoint" });
    }
    if (id === "plan.bind") {
      const cwd = context.cwd;
      if (input.resumeRef !== undefined) {
        if (context.sessionId === undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active resume requires runtime session identity (${IDENTITY_SUPPLIES}).` });
        const ref = decodeExecutionSessionRef(input.resumeRef);
        const root = resolveProcessHarnessDir(cwd, input.harness);
        if (root === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
        setArtifactStore(createFsStore(root));
        const identity: ExecutionIdentity = {
          source: context.host === undefined ? "local" : "host",
          sessionId: context.sessionId,
          workflowId: ref.workflowId,
          role: "coordinator",
        };
        return ok(id, await resumeExecutionSession(executionContextFor({ harnessDir: root }, identity), ref));
      }
      if (input.execution === true) {
        // The ACTIVE bind carries the workflow's coordinator seat only: every
        // per-plan bind arm existed for the removed scoped-PM seat.
        if (context.sessionId === undefined || input.workflow === undefined) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active bind requires runtime session identity and workflow (identity ${IDENTITY_SUPPLIES}).` });
        }
        if (input.coordinator !== true) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "active bind requires --coordinator; the coordinator seat is the only active bind" });
        }
        if (input.plan !== undefined) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "coordinator bind accepts no plan" });
        }
        if (input.expect !== undefined && typeof input.expect !== "string") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "active bind requires a full execution token" });
        const acquired = context.executionIdentity;
        if (acquired !== undefined && (
          acquired.workflowId !== input.workflow || acquired.role !== "coordinator"
        )) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "bind selectors do not match the acquired caller identity" });
        }
        const root = resolveProcessHarnessDir(cwd, input.harness);
        if (root === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
        setArtifactStore(createFsStore(root));
        const identity: ExecutionIdentity = acquired ?? {
          source: context.host === undefined ? "local" : "host",
          sessionId: context.sessionId,
          workflowId: input.workflow,
          role: "coordinator",
        };
        const beforeBind = input.expect === undefined
          ? await readExecutionAuthority({ harnessDir: root }, { workflowId: input.workflow })
          : undefined;
        const receipt = await bindExecutionSession(executionContextFor({ harnessDir: root }, identity), {
          workflowId: input.workflow,
          expected: (input.expect ?? beforeBind!.token) as ExecutionToken,
          operationId: input.operation ?? randomUUID(),
        });
        return ok(id, receipt);
      }
      let bindInput: BindPlanSessionInput;
      if (input.resume !== undefined) {
        if ((context.sessionId !== undefined && context.sessionIdSource !== "env") || input.harness !== undefined) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "--resume accepts no --session-id or --harness" });
        }
        const resumePath = absolutePath(input.resume, "resume");
        pinSessionStore(resumePath);
        bindInput = { resumePath, cwd };
      } else if (input.coordinator === true) {
        if (context.sessionId === undefined || context.sessionId.trim() === "" || context.sessionIdSource === "env") {
          const message = context.sessionIdSource === "env"
            ? "legacy pre-activation coordinator bootstrap does not accept env-provided identity; pass --session-id explicitly"
            : `coordinator bind requires runtime session identity (${IDENTITY_SUPPLIES}).`;
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: message });
        }
        if (input.workflow === undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "coordinator bind requires workflow" });
        const root = resolveProcessHarnessDir(cwd, input.harness);
        if (root !== null) setArtifactStore(createFsStore(root));
        bindInput = {
          coordinator: true,
          workflowId: input.workflow,
          cwd,
          sessionId: context.sessionId,
          ...(input.harness !== undefined ? { harnessDir: absolutePath(input.harness, "harness") } : {}),
        };
      } else {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "bind requires a resume path or the coordinator workflow" });
      }
      const legacyWorkflowBind = "coordinator" in bindInput && bindInput.coordinator === true && "workflowId" in bindInput;
      const root = resolveProcessHarnessDir(cwd, input.harness);
      if (legacyWorkflowBind && root !== null && await resolveExecutionReadRoute({ harnessDir: root }) === "execution") {
        throw new StoreError(
          "execution.consumer-not-ready",
          "This workflow is registered in the active DB execution authority; the legacy snapshot-file bind route is unavailable. " +
            "Re-run with `--execution` (`mstar plan bind --execution --workflow <id> --coordinator`) and the runtime session identity.",
        );
      }
      return ok(id, await bindPlanSession(bindInput));
    }
    if (id === "plan.show") {
      // The coordinator reads any row of its own workflow: the addressed plan is
      // an explicit fact (`--plan`), never inferred from "the only" row, and the
      // caller's own coordinator binding is derived from its trusted identity
      // when no session reference is supplied.
      if (input.plan === undefined) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "plan show requires --plan; the coordinator states which row it reads" });
      }
      if (input.session !== undefined) {
        const sessionPath = absolutePath(input.session, "session");
        pinSessionStore(sessionPath);
        return ok(id, await readPlanCoordination(sessionPath, input.plan, context.cwd));
      }
      if (context.sessionId === undefined) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active plan show requires runtime session identity (${IDENTITY_SUPPLIES}).` });
      }
      const root = resolveProcessHarnessDir(context.cwd, input.harness);
      if (root === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
      setArtifactStore(createFsStore(root));
      const ref = input.sessionRef === undefined ? undefined : decodeExecutionSessionRef(input.sessionRef);
      const workflowId = ref?.workflowId ?? input.workflow ?? context.executionIdentity?.workflowId;
      if (workflowId === undefined) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "plan show needs the addressed workflow: bind the coordinator, pass --workflow, or launch the child with its minted identity" });
      }
      if (input.workflow !== undefined && ref !== undefined && input.workflow !== ref.workflowId) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow selector does not match the supplied session reference" });
      }
      const identity: ExecutionIdentity = {
        source: context.host === undefined ? "local" : "host",
        sessionId: context.sessionId,
        workflowId,
        role: "coordinator",
      };
      const contextForCaller = executionContextFor({ harnessDir: root }, identity);
      const result = ref === undefined
        ? await readExecutionPlan(contextForCaller, input.plan)
        : await readExecutionPlan(contextForCaller, ref, input.plan);
      return ok(id, result);
    }
    // A coordinator intent reaches the ACTIVE operation by ANY of the three
    // supported transports: an explicit `--workflow` (with `--plan`, the same
    // default `show` applies), a minted launch identity, or a session
    // reference. No extra `--coordinator` ceremony is required — the
    // coordinator is the only remaining seat.
    const activeRoute = input.sessionRef !== undefined ||
      context.executionIdentity !== undefined ||
      (input.session === undefined && input.workflow !== undefined);
    if (activeRoute) {
      if (context.sessionId === undefined) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active operation requires an acquired runtime session identity (${IDENTITY_SUPPLIES}).` });
      }
      if (input.expect !== undefined && typeof input.expect !== "string") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "active operation requires a full execution token" });
      if (input.plan === undefined) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active plan operation requires --plan; the coordinator states which row it addresses` });
      }
      // A numeric revision is the file route's CAS transport; the active route
      // takes only a full execution token, so the transports never mix.
      const operation = fileOperation(id, input);
      const operationId = input.operation ?? randomUUID();
      const ref = input.sessionRef === undefined ? undefined : decodeExecutionSessionRef(input.sessionRef);
      const root = resolveProcessHarnessDir(context.cwd, input.harness);
      if (root === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
      setArtifactStore(createFsStore(root));
      const acquired = context.executionIdentity;
      const workflowId = ref?.workflowId ?? acquired?.workflowId ?? input.workflow;
      if (workflowId === undefined) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "active plan operation needs the addressed workflow: bind the coordinator, pass --workflow, or launch the child with its minted identity" });
      }
      if (input.workflow !== undefined && input.workflow !== workflowId) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow selector does not match the caller's workflow" });
      }
      if (acquired !== undefined && (workflowId !== acquired.workflowId || acquired.role !== "coordinator")) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "selected workflow does not match the acquired coordinator identity" });
      }
      const identity: ExecutionIdentity = {
        source: acquired?.source ?? (context.host === undefined ? "local" : "host"),
        sessionId: context.sessionId,
        workflowId,
        role: "coordinator",
      };
      const receipt = await mutateExecutionPlan(executionContextFor({ harnessDir: root }, identity), {
        operationId,
        ...(ref === undefined ? {} : { session: ref }),
        ...(input.expect === undefined ? {} : { expected: input.expect as ExecutionToken }),
        planId: input.plan,
        operation: operation as never,
      });
      return ok(id, receipt);
    }
    const operation = fileOperation(id, input);
    if (input.session === undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "operation requires session or active sessionRef" });
    if (input.plan === undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "operation requires --plan; every plan operation addresses its row explicitly" });
    const sessionPath = absolutePath(input.session, "session");
    pinSessionStore(sessionPath);
    const result = await mutatePlanCoordination({
      sessionPath,
      planId: input.plan,
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
  complete: true,
};
const commandNames = ["bind", "show", "prepare", "progress", "issue-add", "issue-close", "complete"] as const;
type PlanVerb = (typeof commandNames)[number];
/**
 * The declared payload per verb. The descriptors are what both transports
 * validate against — CLI inline values and MCP tool inputs — so the published
 * contract and the enforced one stay one schema.
 */
const payloadByVerb: Partial<Record<PlanVerb, readonly (keyof typeof inputSchema.shape)[]>> = {
  progress: ["progress"],
  "issue-add": ["entries"],
  "issue-close": ["evidence"],
  complete: ["evidence"],
};
const payloadSchemaFor = (verb: PlanVerb, field: keyof typeof inputSchema.shape) =>
  verb === "complete" ? completionEvidenceSchema : inputSchema.shape[field];
/**
 * Per-verb supply disclosure for the shared `--expect` / `--session-ref`
 * options, stated only where the ACTIVE route consumes them: bind expects the
 * bound workflow's token, every other plan mutation the addressed plan's token,
 * and `show` only carries the optional session reference. The optional
 * reference names the coordinator's own active session; supplying it is a
 * transport convenience, never a prerequisite — the engine derives the live
 * coordinator binding from the trusted caller.
 */
const PLAN_EXPECT_HELP = `CAS expectation: ${TOKEN_SUPPLIES.plan}`;
const PLAN_BIND_EXPECT_HELP = `CAS expectation for the bound workflow: coordinator bind takes ${TOKEN_SUPPLIES.workflow}; read at bind time when omitted`;
function optionHelpFor(verb: (typeof commandNames)[number]): Partial<Record<string, string>> {
  if (verb === "bind") return { expect: PLAN_BIND_EXPECT_HELP, sessionRef: `optional session transport: ${SESSION_REF_SUPPLIES}` };
  if (verb === "show") return { sessionRef: `optional session transport: ${SESSION_REF_SUPPLIES}` };
  return { expect: PLAN_EXPECT_HELP, sessionRef: `optional session transport: ${SESSION_REF_SUPPLIES}` };
}
export function getPlanCommandDefinitions(): readonly CommandDefinition[] {
  return commandNames.map((verb) => {
    const id = `plan.${verb}`;
    const help = optionHelpFor(verb);
    return command<PlanInput, unknown>({
      id,
      cli: {
        path: ["plan", verb],
        aliases: [],
        arguments: [],
        options: [
          ...optionKeys.map((key) => ({
            key,
            flags: `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} <value>`,
            required: false,
            ...(help[key] === undefined ? {} : { help: help[key] }),
          })),
          { key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" as const },
        ],
      },
      input: inputSchema,
      payloads: Object.fromEntries(
        (payloadByVerb[verb] ?? []).map((field) => [field, { schema: payloadSchemaFor(verb, field) }]),
      ),
      output: commandEnvelopeSchema,
      effects: writeCommands[verb] === true ? ["write"] : ["read"],
      description: verb === "complete"
        ? "Record Done after verified delivery proof"
        : verb === "prepare"
          ? "Prepare ordinary revisable plan execution configuration: source worktree/branch, QA gate and findings cleanup for one plan row."
          : `Coordinator plan ${verb} operation; the engine enforces workflow/plan addressing, state and concurrency guards.`,
      execute: (input, context) => execute(id, input, context),
    });
  });
}
/** The payload shape the `plan complete` MCP tool publishes (one contract, both transports). */
export const PLAN_COMPLETION_EVIDENCE_SCHEMA = completionEvidenceSchema;
