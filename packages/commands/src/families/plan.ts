import { randomUUID } from "node:crypto";
import {
  bindExecutionSession,
  createFsStore,
  decodeExecutionSessionRef,
  executionContextFor,
  mutateExecutionPlan,
  readExecutionPlan,
  readExecutionAuthority,
  resolveProcessHarnessDir,
  resumeExecutionSession,
  setArtifactStore,
  type ExecutionIdentity,
  type ExecutionToken,
  type PlanCoordinationOperation,
} from "@mstar-harness/engine";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../envelope.js";
import { IDENTITY_SUPPLIES, SESSION_REF_SUPPLIES, TOKEN_SUPPLIES } from "../identity-supplies.js";
import { payloadSchema } from "../payload-field-schema.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const progressPayloadSchema = z.record(z.string(), z.unknown());
/**
 * One `plan issue-add` entry is a plan-scoped capture: the engine derives
 * `projectId` from the addressed plan (`ResidualInput`), so the published item
 * shape is the `CaptureInput` registry without that one member. Every other
 * field, its enum values and its requiredness come from the registry — never a
 * second copy here.
 */
const entriesPayloadSchema = z.array(payloadSchema("CaptureInput").omit({ projectId: true }));
const evidencePayloadSchema = z.record(z.string(), z.unknown());
/**
 * The declared payload shape of `plan complete`: the ordinary completion
 * evidence the engine records, mirrored here so both transports publish one
 * contract. The engine re-validates the same fields (hashed `EvidenceRef`s,
 * accepted QC decisions, QA `pass`) — this schema is transport shaping, never
 * the authority.
 *
 * Every evidence member carries a PATH VALUE the engine resolves: each must be
 * an absolute path to an EXISTING file inside the plan's own area — `{PLAN_DIR}`
 * or `{SDD_DIR}/<plan-id>`. The engine refuses a relative path, a missing file
 * and any path outside those roots, naming the offending field.
 */
const EVIDENCE_PATH_DESCRIPTION =
  "Absolute path to an existing evidence file inside the plan area ({PLAN_DIR} or {SDD_DIR}/<plan-id>); " +
  "a relative path, a missing file or a path outside the plan area is refused with the offending field. Inspect the plan scope with mstar plan show.";
const completionEvidenceSchema = z.object({
  source_sha: z.string().min(1).optional(),
  review_base: z.string().min(1).optional(),
  review_head: z.string().min(1).optional(),
  evidence_paths: z.array(z.string()).optional().describe(`Additional evidence files: ${EVIDENCE_PATH_DESCRIPTION}`),
  qc: z.object({
    decision: z.enum(["Approve", "Approve with residuals"]),
    reports: z.array(z.string().min(1)).min(1).describe(`QC seat reports: ${EVIDENCE_PATH_DESCRIPTION}`),
    consolidated: z.string().min(1).describe(`The consolidated QC decision report: ${EVIDENCE_PATH_DESCRIPTION}`),
  }).passthrough(),
  qa: z.object({
    gate: z.enum(["mandatory", "pm-acceptance"]),
    decision: z.literal("pass"),
    report: z.string().min(1).describe(`The QA or PM acceptance report: ${EVIDENCE_PATH_DESCRIPTION}`),
  }).passthrough(),
}).passthrough();
const inputSchema = z.object({
  sessionRef: z.string().min(1).optional(),
  resumeRef: z.string().min(1).optional(),
  coordinator: z.boolean().optional(),
  execution: z.boolean().optional(),
  workflow: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  harness: z.string().optional(),
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
const bindInputSchema = inputSchema.omit({ plan: true }).passthrough();
type PlanInput = z.infer<typeof inputSchema>;

const optionKeys = Object.keys(inputSchema.shape);
const bindOptionKeys = optionKeys.filter((key) => key !== "plan");
class PlanInputError extends Error {}

function ok<T>(id: string, data: T): CommandEnvelope<T> {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
/**
 * Payload members whose value the engine resolves as an evidence PATH. A
 * `coordination.invalid-input` refusal also carries `field` for a Git object id
 * (`source_sha` / `review_base` / `review_head`), which is not a path, so the
 * transport's recovery branches on the member rather than on the detail's
 * presence.
 */
const EVIDENCE_PATH_FIELDS: Record<string, true> = { "qc.consolidated": true, "qa.report": true };
function isEvidencePathField(field: unknown): boolean {
  if (typeof field !== "string") return false;
  return EVIDENCE_PATH_FIELDS[field] === true ||
    field.startsWith("qc.reports[") ||
    field.startsWith("evidence_paths[") ||
    field.startsWith("progress.evidence_paths[");
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
    // Rule #341 class 3 requires a statically provable recovery per refusal
    // branch, so this stays an inline chain of literal sentences rather than a
    // helper call. `coordination.invalid-transition` covers several causes on
    // plan.complete, so each branch below keys on the detail the engine attaches
    // for that cause: `details.code` is consultDeliveryEvidence's own violation
    // code, `details.required` is the row's configured QA gate. Re-running
    // `plan complete` only helps when the payload was the problem.
    recovery: id === "plan.complete" && code === "coordination.invalid-transition" && details?.code === "PHASE6_DELIVERY_KIND_UNREGISTERED"
      ? "The workflow declares no delivery kind, and the kind is fixed at registration. Close it honestly with mstar workflow lifecycle --workflow <workflow-id> --status failed --reason <text>, then register a replacement workflow with the correct declared delivery kind."
      : id === "plan.complete" && code === "coordination.invalid-transition" && details?.code === "PHASE6_DELIVERY_EVIDENCE_INCOMPLETE"
        // A report-only completion needs the policy fulfilment RECORDED first; no
        // amount of correct QC/QA evidence substitutes for it.
        ? "Record the missing delivery evidence — for a report-only route the fulfilment of its registered completion policy — with mstar workflow evidence --workflow <workflow-id> --file <absolute-json>, then retry plan complete. Read the workflow's own state with mstar status validate."
        : id === "plan.complete" && code === "coordination.invalid-transition" && typeof details?.required === "string"
          // The submission's gate is not the row's configured gate: either the
          // evidence or the recorded configuration is what changes.
          ? "The submitted QA evidence does not match the plan's configured QA gate. Submit the matching QA or PM acceptance report, or re-record the configured gate with mstar plan prepare --qa-gate <gate>, then retry."
          : (id === "plan.complete" || id === "plan.progress") && isEvidencePathField(details?.field)
            // The refusal names which payload field carried the bad VALUE; the
            // plan's own area is what that value must sit inside. A Git object id
            // refusal carries `field` too, and a path rule never fixes it.
            ? "Correct the evidence values named by the refusal's field details: each must be an absolute path to an existing file inside the plan area. Read the plan's area with mstar plan show, then retry."
            : id === "plan.complete" && code === "coordination.scope-mismatch"
              ? details !== undefined && "expected" in details && "actual" in details
                ? "The recorded working branch does not match the workflow's registered delivery source. Correct the registered anchor with mstar workflow delivery-anchors, or re-record the row scope with mstar plan prepare."
                // No recorded scope at all: there is no anchor to compare, so the repair
                // is to record the row's worktree and branch, not to re-register one.
                : "The plan records no worktree/branch scope. Record the plan worktree and feature branch with mstar plan prepare --workflow <workflow-id> --plan <plan-id> --worktree-path <absolute-path> --working-branch <branch>, then retry."
              : id === "plan.bind"
                ? "The registered workflow and current coordinator identity must match; a first bind needs the execution route and an existing binding is resumed through its active session reference. Run mstar plan bind --execution true --coordinator true --workflow <workflow-id>, or mstar plan bind --resume-ref <session-ref>."
                : id === "plan.show"
                  ? "Select a registered workflow and plan id from the execution authority. Run mstar plan show --workflow <workflow-id> --plan <plan-id>."
                  : id === "plan.prepare"
                    ? "Correct the absolute feature-worktree path, feature branch, and Prepare gate values. Run mstar plan prepare --workflow <workflow-id> --plan <plan-id> --worktree-path <absolute-path> --working-branch <branch>."
                    : id === "plan.progress"
                      ? "The progress value must be the JSON progress object (status, summary, evidence_paths) and the plan revision must be current. Run mstar plan progress --workflow <workflow-id> --plan <plan-id> --progress <json-progress-object>."
                      : id === "plan.issue-add"
                        ? "Valid issue entries and the current revision for the addressed plan are required. Run mstar plan issue-add --workflow <workflow-id> --plan <plan-id> --entries <issues-file>."
                        : id === "plan.issue-close"
                          ? "The addressed plan issue needs its current revision and a supported disposition. Run mstar plan issue-close --workflow <workflow-id> --plan <plan-id> --issue <issue-id> --disposition <disposition>."
                          : "Delivery-route evidence and QC/QA proof for this plan are required. Run mstar plan complete --workflow <workflow-id> --plan <plan-id> --file <absolute-evidence.json>.",
  });
}
function command<I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> {
  return definition;
}
function absolutePath(value: string | undefined, key: string): string {
  if (value === undefined || !path.isAbsolute(value)) throw new PlanInputError(`${key} must be an absolute path`);
  return value;
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
async function execute(id: string, input: PlanInput, context: InvocationContext): Promise<CommandEnvelope<unknown>> {
  try {
    if (id === "plan.bind") {
      if (input.plan !== undefined) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "coordinator bind accepts no plan" });
      }
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
      return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "bind requires --execution or a --resume-ref of an active session" });
    }
    if (id === "plan.show") {
      // The coordinator reads any row of its own workflow: the addressed plan is
      // an explicit fact (`--plan`), never inferred from "the only" row, and the
      // caller's own coordinator binding is derived from its trusted identity
      // when no session reference is supplied.
      if (input.plan === undefined) {
        return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "plan show requires --plan; the coordinator states which row it reads" });
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
      input.workflow !== undefined;
    if (!activeRoute) {
      return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "operation requires the addressed workflow: bind the coordinator, pass --workflow, or launch the child with its minted identity" });
    }
    if (context.sessionId === undefined) {
      return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active operation requires an acquired runtime session identity (${IDENTITY_SUPPLIES}).` });
    }
    if (input.expect !== undefined && typeof input.expect !== "string") return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "active operation requires a full execution token" });
    if (input.plan === undefined) {
      return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active plan operation requires --plan; the coordinator states which row it addresses` });
    }
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
  if (verb === "progress") return {
    // The value is the JSON progress object, not a bare status word: the accepted
    // shape is the engine's `validatePlanProgress` contract, published as PlanProgress.
    progress: "JSON progress object with status (InProgress|InReview|Blocked), summary and evidence_paths; read the shape with mstar schema PlanProgress",
    expect: PLAN_EXPECT_HELP,
    sessionRef: `optional session transport: ${SESSION_REF_SUPPLIES}`,
  };
  if (verb === "complete") return {
    // Both transports validate this exact schema, so the rule it encodes is the
    // one a file payload and an inline --evidence value meet.
    evidence: `Completion evidence JSON object (--file <absolute-json> or inline). ${EVIDENCE_PATH_DESCRIPTION}`,
    file: `Completion evidence JSON file (absolute path); its qc.reports[], qc.consolidated, qa.report and evidence_paths[] values are evidence paths. ${EVIDENCE_PATH_DESCRIPTION}`,
    expect: PLAN_EXPECT_HELP,
    sessionRef: `optional session transport: ${SESSION_REF_SUPPLIES}`,
  };
  if (verb === "issue-add") return {
    // The item contract is the engine's CaptureInput registry, which the schema
    // command already publishes; the entry item is that type minus the
    // plan-derived projectId.
    entries: "JSON array of plan-scoped capture entries, one object per finding; read the per-entry fields with mstar schema CaptureInput (projectId is derived from the addressed plan)",
    file: "Absolute path to a JSON file holding that entries array",
    expect: PLAN_EXPECT_HELP,
    sessionRef: `optional session transport: ${SESSION_REF_SUPPLIES}`,
  };
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
          ...(verb === "bind" ? bindOptionKeys : optionKeys).map((key) => ({
            key,
            flags: `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} <value>`,
            required: false,
            ...(help[key] === undefined ? {} : { help: help[key] }),
          })),
          { key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" as const },
        ],
      },
      input: verb === "bind"
        ? bindInputSchema
        : verb === "complete"
          ? inputSchema.extend({ evidence: completionEvidenceSchema.optional() })
          : inputSchema,
      payloads: Object.fromEntries(
        (payloadByVerb[verb] ?? []).map((field) => [field, {
          schema: payloadSchemaFor(verb, field),
          ...(verb === "progress" ? { registryName: "PlanProgress" } : {}),
        }]),
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
