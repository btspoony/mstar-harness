/** Pure coordinator intent and delivery rules shared by FILE and ACTIVE routes. */
import type { ValidationResult } from "./core.js";
import {
  CoordinationError,
  assertExactKeys,
  isNonEmptyString,
  isPlainObject,
  validateRowCoordination,
  type CoordinationErrorCode,
  type IntegrationResultInput,
  type PlanProgress,
  type RowCoordination,
  type RowValidationRoute,
} from "./coordination-write.js";
import type { PlanRow } from "./status.js";
import {
  isStandaloneDevelopmentWorkflow,
  isStandaloneReportOnlyWorkflow,
  type WorkflowSnapshot,
} from "./workflow.js";
import { _DEFAULT_PROJECT } from "./project.js";

export type CoordinationRole = "coordinator";
export type CoordinationSeat = { role: CoordinationRole; sessionId: string };

export function summarize(violations: readonly { message: string }[]): string {
  return violations.map((violation) => violation.message).join("; ");
}

export function projectBucketOf(snapshot: WorkflowSnapshot): string {
  return isNonEmptyString(snapshot.project_id) ? snapshot.project_id : _DEFAULT_PROJECT;
}

export function rowStatusOf(row: PlanRow): string {
  return typeof row.status === "string" ? row.status : "";
}

export function rowCoordinationOf(row: PlanRow): RowCoordination | undefined {
  return row.coordination as RowCoordination | undefined;
}

export const IMPLEMENTED_OPERATIONS: Readonly<Record<string, true>> = {
  prepare: true,
  progress: true,
  "residual-add": true,
  "residual-close": true,
  complete: true,
};
const OPERATION_NAMES = Object.keys(IMPLEMENTED_OPERATIONS);
const NON_COMPLETION_OPERATIONS = OPERATION_NAMES.filter((operation) => operation !== "complete");

export const PROGRESS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  Todo: ["InProgress", "Blocked"],
  InProgress: ["InProgress", "Blocked", "InReview"],
  Blocked: ["Blocked", "InProgress"],
  InReview: ["InReview", "InProgress", "Blocked"],
};

export function allowedOperations(_role: CoordinationRole, row: PlanRow): string[] {
  if (rowStatusOf(row) === "Done") return [];
  return ["InProgress", "InReview"].includes(rowStatusOf(row))
    ? [...OPERATION_NAMES]
    : [...NON_COMPLETION_OPERATIONS];
}

export function assertPlanAddress(_seat: CoordinationSeat, planId: unknown): string {
  if (!isNonEmptyString(planId)) {
    throw new CoordinationError("coordination.invalid-input", "a coordinator intent requires an explicit planId; select the row with plan show", { field: "planId" });
  }
  return planId;
}

export function requireRowStatus(row: PlanRow, expected: string, planId: string, what: string, _opts: { still?: boolean } = {}): void {
  const actual = rowStatusOf(row);
  if (actual !== expected) {
    throw new CoordinationError(
      "coordination.plan-status",
      `${what} requires plan ${planId} in ${expected}, not ${actual}; read plan show and use plan progress for its allowed transition`,
      { plan_id: planId, expected, actual },
    );
  }
}

export function requireProgressStatus(row: PlanRow, target: PlanProgress["status"], planId: string): void {
  const current = rowStatusOf(row);
  if (!PROGRESS_TRANSITIONS[current]?.includes(target)) {
    throw new CoordinationError(
      "coordination.progress-transition",
      `plan ${planId} cannot progress ${current} -> ${target}; read plan show and use its current allowed status transition`,
      { plan_id: planId, current, target, allowed: PROGRESS_TRANSITIONS[current] ?? [] },
    );
  }
}

export function assertOperationRole(seat: CoordinationSeat, kind: string): void {
  if (seat.role !== "coordinator") {
    throw new CoordinationError("coordination.session-role", `${kind} requires the workflow coordinator; use coordinator bind or recover the stopped workflow coordinator`, { role: seat.role, kind });
  }
}

export function assertPrepareAdmission(input: { planId: string; row: PlanRow }): void {
  if (rowStatusOf(input.row) === "Done") {
    throw new CoordinationError("coordination.prepare-status", `plan ${input.planId} is Done; prepare cannot revise a completed row`, { plan_id: input.planId });
  }
}

export function assertTrackBranches(
  source: { planId: string; branch: unknown; plans: readonly unknown[] },
  branches: readonly string[],
): void {
  const protectedBranches = new Set<string>(["main", "master", "develop", "dev"]);
  if (isPlainObject(source.branch)) {
    for (const key of ["base", "integration", "target"]) {
      const branch = source.branch[key];
      if (isNonEmptyString(branch)) protectedBranches.add(branch);
    }
  }
  const otherPlanBranches = new Set<string>();
  for (const candidate of source.plans) {
    if (!isPlainObject(candidate) || candidate.id === source.planId || !isPlainObject(candidate.metadata)) continue;
    if (isNonEmptyString(candidate.metadata.working_branch)) otherPlanBranches.add(candidate.metadata.working_branch);
    if (Array.isArray(candidate.metadata.track_branches)) {
      for (const branch of candidate.metadata.track_branches) {
        if (isNonEmptyString(branch)) otherPlanBranches.add(branch);
      }
    }
  }
  const seen = new Set<string>();
  for (const branch of branches) {
    if (!isNonEmptyString(branch) || protectedBranches.has(branch) || otherPlanBranches.has(branch) || seen.has(branch)) {
      throw new CoordinationError(
        "coordination.scope-mismatch",
        `plan ${source.planId} track branch ${branch} is empty, duplicated, protected or owned by another plan; report distinct owned feature branches with plan progress`,
        { plan_id: source.planId, branch },
      );
    }
    seen.add(branch);
  }
}

export function assertGitObjectId(value: unknown, what: string): string {
  if (!isNonEmptyString(value) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new CoordinationError("coordination.invalid-input", `${what} must be a full lowercase Git object id`, { field: what });
  }
  return value;
}

export type ValidatedCompletionEvidence = {
  source_sha: string | null;
  review_base: string | null;
  review_head: string | null;
  qc_decision: "Approve" | "Approve with residuals";
  qc_reports: string[];
  qc_consolidated: string;
  qa_gate: "mandatory" | "pm-acceptance";
  qa_decision: "pass";
  qa_report: string;
  evidence_paths: string[];
};

export function readCompletionEvidence(value: unknown, route: RowValidationRoute = "integration"): ValidatedCompletionEvidence {
  if (!isPlainObject(value)) throw new CoordinationError("coordination.invalid-input", "complete requires an evidence object");
  assertExactKeys(value, ["source_sha", "review_base", "review_head", "qc", "qa", "evidence_paths"], "completion evidence");
  const reportOnly = route === "standalone-report-only";
  const sourceSha = reportOnly && value.source_sha === undefined ? null : assertGitObjectId(value.source_sha, "source_sha");
  const reviewBase = reportOnly && value.review_base === undefined ? null : assertGitObjectId(value.review_base, "review_base");
  const reviewHead = reportOnly && value.review_head === undefined ? null : assertGitObjectId(value.review_head, "review_head");
  if (!isPlainObject(value.qc)) throw new CoordinationError("coordination.invalid-input", "completion evidence requires qc");
  assertExactKeys(value.qc, ["decision", "reports", "consolidated"], "completion evidence qc");
  const qc = value.qc;
  if (!["Approve", "Approve with residuals"].includes(String(qc.decision))) {
    throw new CoordinationError("coordination.invalid-input", "complete requires qc.decision Approve or Approve with residuals; fix rejected findings and publish approved QC first");
  }
  if (!Array.isArray(qc.reports) || qc.reports.length === 0 || !qc.reports.every(isNonEmptyString)) {
    throw new CoordinationError("coordination.invalid-input", "qc.reports must name at least one report");
  }
  if (!isNonEmptyString(qc.consolidated)) throw new CoordinationError("coordination.invalid-input", "qc.consolidated must name the plan QC decision report");
  if (!isPlainObject(value.qa)) throw new CoordinationError("coordination.invalid-input", "completion evidence requires a QA or PM acceptance report");
  assertExactKeys(value.qa, ["gate", "decision", "report"], "completion evidence qa");
  if (!["mandatory", "pm-acceptance"].includes(String(value.qa.gate)) || value.qa.decision !== "pass" || !isNonEmptyString(value.qa.report)) {
    throw new CoordinationError("coordination.invalid-input", "qa evidence requires gate mandatory or pm-acceptance, decision pass and the acceptance report");
  }
  const qaGate = value.qa.gate as ValidatedCompletionEvidence["qa_gate"];
  const qaReport = value.qa.report;
  const extra = value.evidence_paths === undefined ? [] : value.evidence_paths;
  if (!Array.isArray(extra) || !extra.every(isNonEmptyString)) {
    throw new CoordinationError("coordination.invalid-input", "evidence_paths must be an array of absolute evidence paths");
  }
  const paths = new Set<string>([...qc.reports, qc.consolidated, ...extra]);
  paths.add(qaReport);
  return {
    source_sha: sourceSha,
    review_base: reviewBase,
    review_head: reviewHead,
    qc_decision: qc.decision as ValidatedCompletionEvidence["qc_decision"],
    qc_reports: [...qc.reports] as string[],
    qc_consolidated: qc.consolidated,
    qa_gate: qaGate,
    qa_decision: "pass",
    qa_report: qaReport,
    evidence_paths: [...paths],
  };
}

export function assertCompletionReviewDecision(
  evidence: ValidatedCompletionEvidence,
  planId: string,
  qaGate: "mandatory" | "pm-acceptance",
): void {
  if (evidence.qa_gate !== qaGate) {
    throw new CoordinationError("coordination.invalid-transition", `plan ${planId} requires ${qaGate} acceptance evidence; provide the matching QA or PM acceptance report`, { plan_id: planId, required: qaGate });
  }
}

export function assertNoIntegrationContamination(input: {
  snapshot: WorkflowSnapshot;
  planId: string;
  integration?: IntegrationResultInput;
  what: string;
  code?: CoordinationErrorCode;
}): void {
  if (!isStandaloneDevelopmentWorkflow(input.snapshot) && !isStandaloneReportOnlyWorkflow(input.snapshot)) return;
  if (input.integration !== undefined || input.snapshot.integration_merge_lease !== undefined) {
    throw new CoordinationError(
      input.code ?? "coordination.invalid-transition",
      `standalone ${input.what} for ${input.planId} does not consume an integration lane; remove the integration input and use its own source or report-policy completion route`,
      { plan_id: input.planId, integration: input.integration, integration_merge_lease: input.snapshot.integration_merge_lease },
    );
  }
}

export function storedCoordinationViolations(
  block: Record<string, unknown>,
  input: { revision: number; route: RowValidationRoute; what: string },
): ValidationResult[] {
  return validateRowCoordination({ ...block, revision: input.revision }, input.what, input.route);
}

export function missingDecision(input: {
  planId: string;
  what: string;
  component: string;
  field: string;
  source: string;
  message: string;
}): CoordinationError {
  return new CoordinationError("coordination.invalid-input", input.message, {
    plan_id: input.planId,
    path: input.field,
    recovery: {
      outcome: "unresolved",
      target: { planId: input.planId },
      applied: [],
      unresolved: [{
        component: input.component, path: input.field, code: "coordination.invalid-input",
        sourcesTried: [input.source], currentFacts: [input.message],
        needed: input.message,
        withheldEffect: `${input.what} on plan ${input.planId}`,
        availableWork: ["supply the named facts through the documented operation, then retry", "independent plan operations remain available"],
      }],
      resolvedFrom: [], warnings: [], commitState: "none",
    },
  });
}

export function integrationDiverged(message: string, details?: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.integration-diverged", message, details);
}

export function integrationUnresolved(message: string, details?: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.integration-unresolved", message, details);
}

export function gitProof(message: string, details?: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.git-proof", message, details);
}

export type IntegrationAnchors = { targetBranch: string; worktreePath: string };

export function integrationAnchors(snapshot: WorkflowSnapshot, planId: string): IntegrationAnchors {
  const branch = snapshot.branch?.integration;
  const worktreePath = snapshot.integration_worktree_path;
  if (!isNonEmptyString(branch) || !isNonEmptyString(worktreePath)) {
    throw integrationUnresolved(`plan ${planId} requires its workflow integration branch and worktree; supply the missing anchors through workflow integration-worktree before merging`, { plan_id: planId });
  }
  return { targetBranch: branch, worktreePath };
}

export type StandaloneDeliveryAnchors = { sourceBranch: string; targetBranch: string; worktreePath: string };

export function standaloneDeliveryAnchors(snapshot: WorkflowSnapshot, planId: string): StandaloneDeliveryAnchors {
  const row = snapshot.plans.find((candidate) => candidate.id === planId);
  const worktreePath = isPlainObject(row?.metadata) ? row.metadata.worktree_path : undefined;
  const sourceBranch = snapshot.branch?.source;
  const targetBranch = snapshot.branch?.target;
  if (!isNonEmptyString(sourceBranch) || !isNonEmptyString(targetBranch) || !isNonEmptyString(worktreePath)) {
    throw new CoordinationError("coordination.invalid-transition", `standalone development plan ${planId} requires its registered source/target branch and row worktree; supply source facts through plan prepare and workflow registration`, { plan_id: planId });
  }
  return { sourceBranch, targetBranch, worktreePath };
}

