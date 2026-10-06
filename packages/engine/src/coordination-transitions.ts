/**
 * coordination-transitions.ts — the pure domain rules of a coordinated plan,
 * separated from every transport that stores one.
 *
 * The JSON/file route (`coordination.ts`) and the DB route
 * (`execution-coordination.ts`) both run these rules here: which seat may issue
 * an operation, which plan a session may address, which operations a row
 * advertises, whether a row may be prepared, which status a progress report may
 * move it to, and whether a row's handoff or lease permits a transition. A rule
 * reads no file, no path and no store — a seat, the workflow state and the plan
 * row are the whole input — so neither transport can drift into a second
 * role/state machine.
 *
 * The transport-specific halves stay with the transport that owns them: the
 * file route keeps its `canonicalTarget` envelope comparisons, and the DB route
 * reads session and lease authority from `execution_sessions` /
 * `execution_leases` rather than from a row's `coordination.session` block
 * (primary spec §2.3).
 *
 * NOT a public surface: the package index exports none of this.
 */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  CoordinationError,
  assertExactKeys,
  canonicalTarget,
  evidenceRefOf,
  isNonEmptyString,
  isPlainObject,
  validatePlanHandoff,
  validateRowCoordination,
  type CoordinatorBinding,
  type HandoffIntegration,
  type EvidenceRef,
  type PlanHandoff,
  type RowCoordination,
  type RowValidationRoute,
} from "./coordination-write.js";
import { unresolvedRecovery, type RecoveryProblem } from "./recovery-intent.js";
import type { ValidationResult } from "./core.js";
import { assertSafePathComponent } from "./path.js";
import { validateExecutionLease, type ExecutionLease, type IntegrationMergeLease } from "./lease.js";
import { _DEFAULT_PROJECT } from "./project.js";
import { rowPlanIds, type PlanRow } from "./status.js";
import { isStandaloneDevelopmentWorkflow, type WorkflowSnapshot } from "./workflow.js";

/* ------------------------------------------------------------------------ *
 * § Seats and the advertised operation set
 * ------------------------------------------------------------------------ */

/** The workflow-wide execution identity. */
export type CoordinationSeat = { role: "coordinator"; sessionId: string };

export const IMPLEMENTED_OPERATIONS: Record<string, true> = {
  prepare: true,
  progress: true,
  "residual-add": true,
  "residual-close": true,
  complete: true,
};

/** Row statuses a claim may start from (mirrors the pure lease transition). */
export function isClaimableStatus(status: string): boolean {
  return status === "Todo" || status === "Blocked";
}

/** Render validation violations the one way every refusal message spells them. */
export function summarize(violations: readonly { code: string; message: string }[]): string {
  return violations.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
}

/** The row's own coordination block, or `undefined` when it carries none. */
export function rowCoordinationOf(row: PlanRow): RowCoordination | undefined {
  const value = row.coordination;
  if (!isPlainObject(value)) return undefined;
  // Boundary cast: every row `coordination` block reaching here was written
  // through the coordination module and validated by `validateRowCoordination`.
  const coordination = value as RowCoordination;
  return coordination;
}

export function rowStatusOf(row: PlanRow): string {
  return isNonEmptyString(row.status) ? row.status : "";
}

/**
 * The operations one seat may run against one row right now. The advertised
 * set is derived from the same closed union the writers dispatch on, so a
 * caller is never told about an operation the route refuses (spec §B
 * "unimplemented operations must be absent, not stubbed").
 */
export function allowedOperations(
  role: CoordinationRole,
  sessionId: string,
  snapshot: WorkflowSnapshot,
  row: PlanRow,
): string[] {
  if (role !== "coordinator" || snapshot.coordination?.coordinator.session_id !== sessionId) return [];
  const status = rowStatusOf(row);
  if (status === "Done") return [];
  return ["prepare", "progress", "residual-add", "residual-close", "complete"];
}
export const PROGRESS_TRANSITIONS: Record<string, readonly string[]> = {
  Todo: ["InProgress", "Blocked"],
  InProgress: ["InProgress", "InReview", "Blocked"],
  InReview: ["InReview", "InProgress", "Blocked"],
  Blocked: ["Blocked", "InProgress"],
};

/* ------------------------------------------------------------------------ *
 * § Role and scope eligibility (spec §D/§E)
 * ------------------------------------------------------------------------ */

/**
 * The seat an operation requires (spec §D/§E): the coordinator verbs are
 * coordinator-only, and every other operation is a plan-session operation — a
 * coordinator session coordinates, it does not execute.
 */
export function assertOperationRole(seat: CoordinationSeat, kind: string): void {
  if (seat.role !== "coordinator") {
    throw new CoordinationError("coordination.invalid-input", `${kind} requires the workflow coordinator`);
  }
}

export function assertPlanAddress(_seat: CoordinationSeat, requestedPlanId: string | undefined): void {
  if (!isNonEmptyString(requestedPlanId)) {
    throw new CoordinationError("coordination.invalid-input", "planId is required to address a coordinator plan operation", {
      path: "planId",
    });
  }
}

/**
 * The row's own bound session, proven to be `sessionId`'s. Identity is not
 * ownership (§D): the caller of this rule still has to prove it holds the
 * row's lease.
 */
export function requirePlanSessionBinding(row: PlanRow, sessionId: string, planId: string): CoordinatorBinding {
  const binding = rowCoordinationOf(row)?.session;
  if (binding === undefined) {
    throw new CoordinationError("coordination.not-prepared", `plan ${planId} has no bound plan session`, {
      plan_id: planId,
    });
  }
  if (binding.session_id !== sessionId) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `plan ${planId} is bound to session ${binding.session_id}, not ${sessionId}`,
      { expected: binding.session_id, actual: sessionId },
    );
  }
  return binding;
}

/* ------------------------------------------------------------------------ *
 * § Row eligibility: the handoff gate and the execution-lease gate
 * ------------------------------------------------------------------------ */

/** Reject row mutations while a handoff owns the plan's transition. */
export function assertNoHandoffTransition(coordination: RowCoordination | undefined, planId: string): void {
  const handoff = coordination?.handoff;
  if (handoff === undefined || handoff.state === "returned") return;
  throw new CoordinationError(
    "coordination.handoff-state",
    `plan ${planId} is handed off (state ${String(handoff.state)}) \u2014 the plan session owns no transition until the coordinator returns or completes it`,
    { plan_id: planId, state: handoff.state },
  );
}

/**
 * The handoff of a plan the operation named, or a refusal when the row has none
 * or holds a different one. This runs under the transport's own read-then-write
 * exclusion: the id the caller read before the call is a precondition of the
 * mutation, never a hint — a concurrent `return` plus a fresh handoff leaves
 * the new attempt untouched (spec §B).
 */
export function requirePlanHandoff(
  coordination: RowCoordination | undefined,
  planId: string,
  namedHandoffId: string,
): PlanHandoff {
  const handoff = coordination?.handoff;
  if (handoff === undefined) {
    throw new CoordinationError("coordination.handoff-missing", `plan ${planId} has no handoff to transition`, {
      plan_id: planId,
    });
  }
  if (handoff.id !== namedHandoffId) {
    throw new CoordinationError(
      "coordination.handoff-pin",
      `plan ${planId} handoff ${handoff.id} is not the handoff this command named (${namedHandoffId}) \u2014 a replaced handoff is a different attempt`,
      { plan_id: planId, expected: namedHandoffId, actual: handoff.id },
    );
  }
  return handoff;
}

/**
 * The row's own execution lease, validated (spec §C2/§C3: a released lease is
 * deleted, `null`/tombstone objects are invalid). Fails closed — callers that
 * need a holder never proceed on an absent or malformed lease.
 */
export function requireExecutionLease(row: PlanRow, planId: string, what: string): ExecutionLease {
  const gate = validateExecutionLease(row.execution_lease);
  if (!gate.ok) {
    throw new CoordinationError(
      "coordination.execution-lease-required",
      `${what} requires ${planId} to hold an active execution lease \u2014 ${summarize(gate.violations)}`,
      { plan_id: planId, violations: gate.violations.map((entry) => entry.code) },
    );
  }
  // Boundary cast: `validateExecutionLease` just proved the shape.
  return row.execution_lease as ExecutionLease;
}

/** The row's execution lease, proven to be held by `holder` (spec §D). */
export function assertExecutionHolder(row: PlanRow, holder: string, planId: string, what: string): void {
  const lease = requireExecutionLease(row, planId, what);
  if (lease.holder !== holder) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `${what} requires ${planId}'s execution lease held by ${holder} \u2014 it is held by ${lease.holder}`,
      { plan_id: planId, expected: holder, actual: lease.holder },
    );
  }
}

/* ------------------------------------------------------------------------ *
 * § Row admission: `prepare` eligibility and the `progress` transition table
 * ------------------------------------------------------------------------ */

/**
 * §D `prepare` admission — the shared half of both transports. The seat gate,
 * the coordinator binding (a file envelope, or a DB session row) and the
 * catalog registration gate stay with the transport that owns them; what a row
 * must look like to be prepared is the same rule on either route.
 */
/** A direct prepare is revisable on every non-terminal row. */
export function assertPrepareAdmission(input: { planId: string; row: PlanRow }): void {
  if (rowStatusOf(input.row) === "Done") {
    throw new CoordinationError(
      "coordination.prepare-status",
      `plan ${input.planId} is Done and cannot be prepared`,
      { plan_id: input.planId, status: input.row.status },
    );
  }
}

/** Allowed row-status transitions for a plan session's progress report (§D). */
export const PROGRESS_TRANSITIONS: Record<string, readonly string[]> = {
  InProgress: ["InProgress", "InReview", "Blocked"],
  InReview: ["InReview", "InProgress", "Blocked"],
  Blocked: ["Blocked", "InProgress"],
};

/**
 * §D the status one progress report may move a row to. The row's status before
 * the report is the input and the return value, so a caller reports it without
 * a second read.
 */
export function requireProgressStatus(row: PlanRow, target: string, planId: string): string {
  const status = rowStatusOf(row);
  const allowed = PROGRESS_TRANSITIONS[status];
  if (allowed === undefined) {
    throw new CoordinationError(
      "coordination.progress-phase",
      `plan ${planId} is ${status || "unstatused"} \u2014 progress is reported only while executing (${Object.keys(PROGRESS_TRANSITIONS).join(", ")})`,
      { plan_id: planId, status: row.status },
    );
  }
  if (!allowed.includes(target)) {
    throw new CoordinationError(
      "coordination.progress-transition",
      `plan ${planId} cannot move ${status} \u2192 ${target} (allowed: ${allowed.join(", ")})`,
      { plan_id: planId, from: status, to: target },
    );
  }
  return status;
}

/** Release preserves claimable states and blocks in-flight work through the shared transition. */
export function releaseStatus(row: PlanRow, planId: string): string {
  const status = rowStatusOf(row);
  if (status === "Todo" || status === "Blocked") return status;
  if (status === "InProgress" || status === "InReview") return "Blocked";
  throw new CoordinationError(
    "coordination.plan-status",
    `plan ${planId} is ${status || "unstatused"} \u2014 release requires a claimable or executing row`,
    { plan_id: planId, status: row.status },
  );
}

/** Working branches a plan row reports (`metadata.working_branch` / `metadata.track_branches`). */
export function reportedBranchesOf(row: PlanRow): string[] {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const out: string[] = [];
  if (isNonEmptyString(metadata.working_branch)) out.push(metadata.working_branch);
  if (Array.isArray(metadata.track_branches)) {
    for (const branch of metadata.track_branches) if (isNonEmptyString(branch)) out.push(branch);
  }
  return out;
}

/**
 * Track branches belong to this plan only — never main/integration/another
 * plan. The forbidden set is the workflow's own branch anchors plus every OTHER
 * plan's reported branches, so the caller passes the addressed workflow's
 * branch block and its plan rows whichever transport it reads them from.
 */
export function assertTrackBranches(
  input: { planId: string; branch: unknown; plans: readonly PlanRow[] },
  branches: readonly string[],
): void {
  const forbidden = new Set<string>();
  if (isPlainObject(input.branch)) {
    for (const value of Object.values(input.branch)) if (isNonEmptyString(value)) forbidden.add(value);
  }
  for (const row of input.plans) {
    if (rowPlanIds(row).includes(input.planId)) continue;
    for (const branch of reportedBranchesOf(row)) forbidden.add(branch);
  }
  const seen = new Set<string>();
  for (const branch of branches) {
    if (seen.has(branch)) throw new CoordinationError("coordination.invalid-input", `track branch ${branch} is reported twice`, { branch });
    seen.add(branch);
    if (forbidden.has(branch)) {
      throw new CoordinationError(
        "coordination.invalid-input",
        `track branch ${branch} belongs to main/integration or another plan \u2014 a plan reports only its own L2 track branches`,
        { branch },
      );
    }
  }
}

/* ------------------------------------------------------------------------ *
 * § Row facts: which project a plan's findings belong to
 * ------------------------------------------------------------------------ */

/**
 * The project bucket of a plan row — `metadata.project_id` when the row
 * declares one, `_default` otherwise (compass ruling 2). A row-scoped rule, so
 * both transports read it here instead of deriving a second answer: the file
 * route records the row and the DB route reads the same row, and the residual
 * capture below must land in the SAME project on either route.
 *
 * One rule, two callers: `coordination.ts` still carries its private
 * `projectIdOf` copy of this derivation until that module's next touched batch
 * converges on this one.
 */
export function projectBucketOf(row: PlanRow): string {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const declared = metadata.project_id;
  if (!isNonEmptyString(declared)) return _DEFAULT_PROJECT;
  try {
    assertSafePathComponent(declared, "metadata.project_id");
  } catch (error) {
    throw new CoordinationError(
      "coordination.invalid-input",
      `metadata.project_id ${JSON.stringify(declared)} is not a safe path component: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { plan_id: declared },
    );
  }
  return declared;
}

/* ------------------------------------------------------------------------ *
 * §D/§E the handoff, integration and completion rules
 * ------------------------------------------------------------------------ */

/** A full Git object id (40- or 64-hex); abbreviations are never expanded. */
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** QC verdicts a handoff may carry (spec §D). */
export const HANDOFF_QC_DECISIONS: readonly string[] = ["Approve", "Approve with residuals"];

/** Assignment QA gates a handoff may carry (spec §D). */
export const HANDOFF_QA_GATES: readonly string[] = ["mandatory", "pm-acceptance"];

/** `coordination.integration-unresolved`: no merge of the attempt exists yet. */
export function integrationUnresolved(message: string, details: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.integration-unresolved", message, details);
}

/** `coordination.integration-diverged`: the pins no longer prove the attempt. */
export function integrationDiverged(message: string, details: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.integration-diverged", message, details);
}

/** `coordination.git-proof`: the observed Git state does not carry the proof. */
export function gitProof(message: string, details: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.git-proof", message, details);
}

/** One full Git object id as supplied by a caller. */
export function assertGitObjectId(value: unknown, what: string): string {
  if (typeof value !== "string" || !GIT_OBJECT_ID.test(value)) {
    throw new CoordinationError(
      "coordination.invalid-input",
      `${what} must be a full Git object id (40 or 64 lowercase hex), not an abbreviation`,
      { field: what },
    );
  }
  return value;
}

/**
 * Handoff evidence validated and hashed for the durable record (spec §D). The
 * plan worktree is not a caller input: it is read from the persisted scope, so
 * a conforming caller cannot be rejected for omitting or spoofing it.
 */
export type HandoffEvidenceInput = {
  source_sha: string;
  review_base: string;
  review_head: string;
  qc_decision: string;
  qc_reports: EvidenceRef[];
  qc_consolidated: EvidenceRef;
  qa_gate: string;
  qa_report: EvidenceRef;
  evidence_paths: string[];
};

/** One evidence path as supplied by the plan session (a path, never a ref). */
function evidencePath(value: unknown, what: string): string {
  if (!isNonEmptyString(value) || !isAbsolute(value)) {
    throw new CoordinationError("coordination.invalid-input", `${what} must be an absolute path`, { field: what });
  }
  return canonicalTarget(value);
}

function evidenceRef(value: unknown, what: string): EvidenceRef {
  const path = evidencePath(value, what);
  if (!existsSync(path)) {
    throw new CoordinationError("coordination.invalid-input", `${what} does not exist: ${path}`, { field: what, path });
  }
  return evidenceRefOf(path);
}

/**
 * The plan session supplies paths and revisions only — never state or holder.
 * Both transports run this rule: the file route seals the returned record into
 * its snapshot, the DB route into its coordination block, and neither may
 * invent a second evidence vocabulary.
 */
export function readHandoffEvidence(value: unknown): HandoffEvidenceInput {
  if (!isPlainObject(value)) {
    throw new CoordinationError(
      "coordination.invalid-input",
      "handoff requires an evidence object with source_sha, review_base, review_head, qc and qa",
    );
  }
  assertExactKeys(value, ["source_sha", "review_base", "review_head", "qc", "qa"], "handoff evidence");
  const source_sha = assertGitObjectId(value.source_sha, "evidence.source_sha");
  const review_base = assertGitObjectId(value.review_base, "evidence.review_base");
  const review_head = assertGitObjectId(value.review_head, "evidence.review_head");
  const qc = value.qc;
  if (!isPlainObject(qc)) throw new CoordinationError("coordination.invalid-input", "handoff evidence requires a qc object");
  assertExactKeys(qc, ["decision", "reports", "consolidated"], "handoff evidence qc");
  if (typeof qc.decision !== "string" || !HANDOFF_QC_DECISIONS.includes(qc.decision)) {
    throw new CoordinationError(
      "coordination.invalid-input",
      `handoff evidence qc.decision must be one of ${HANDOFF_QC_DECISIONS.join(", ")}`,
      { field: "evidence.qc.decision" },
    );
  }
  if (!Array.isArray(qc.reports) || qc.reports.length === 0) {
    throw new CoordinationError(
      "coordination.invalid-input",
      "handoff evidence qc.reports must list at least one QC report path",
      { field: "evidence.qc.reports" },
    );
  }
  const qc_reports = qc.reports.map((entry, index) => evidenceRef(entry, `evidence.qc.reports[${index}]`));
  const qc_consolidated = evidenceRef(qc.consolidated, "evidence.qc.consolidated");
  const qa = value.qa;
  if (!isPlainObject(qa)) throw new CoordinationError("coordination.invalid-input", "handoff evidence requires a qa object");
  assertExactKeys(qa, ["gate", "decision", "report"], "handoff evidence qa");
  if (typeof qa.gate !== "string" || !HANDOFF_QA_GATES.includes(qa.gate)) {
    throw new CoordinationError(
      "coordination.invalid-input",
      `handoff evidence qa.gate must be one of ${HANDOFF_QA_GATES.join(", ")}`,
      { field: "evidence.qa.gate" },
    );
  }
  if (qa.decision !== "pass") {
    throw new CoordinationError("coordination.invalid-input", "handoff evidence qa.decision must be pass", {
      field: "evidence.qa.decision",
    });
  }
  const qa_report = evidenceRef(qa.report, "evidence.qa.report");
  return {
    source_sha,
    review_base,
    review_head,
    qc_decision: qc.decision,
    qc_reports,
    qc_consolidated,
    qa_gate: qa.gate,
    qa_report,
    evidence_paths: [...qc_reports.map((ref) => ref.path), qc_consolidated.path, qa_report.path],
  };
}


/** The row status one coordinator transition requires (spec §D/§E). */
export function requireRowStatus(
  row: PlanRow,
  status: string,
  planId: string,
  what: string,
  options: { still?: boolean } = {},
): void {
  const current = rowStatusOf(row);
  if (current !== status) {
    throw new CoordinationError(
      "coordination.plan-status",
      `${what} requires ${planId} to ${options.still === true ? "still be" : "be"} ${status} \u2014 it is ${current || "unstatused"}`,
      { plan_id: planId, status: row.status },
    );
  }
}

/* ------------------------------------------------------------------------ *
 * §R5 the entailed bookkeeping of a transition, and the decision it cannot supply
 * ------------------------------------------------------------------------ */

/**
 * §R5/§6.1 the row status one `handoff` ENTAILS — the recording step the
 * transition applies itself, inside the same commit that seals the handoff, so
 * a harmless out-of-order call never needs a second `progress` report:
 *
 * - the row already records `InReview`: `null`, nothing is recorded, and the
 *   ordinary fully-specified sequence is exactly what it was (A01);
 * - the row records `InProgress` while its claim is recorded: `InReview`,
 *   because the handoff's own evidence — the accepted QC verdict, the reviewed
 *   range Git proves, and the passing QA decision, all re-proved by the route
 *   before the commit — IS the persisted evidence of the reviewed state, so the
 *   report is bookkeeping rather than a new decision. The claim itself is not
 *   this rule's business: the file route's row binding and the DB route's held
 *   lease are proved by the transport before any transition runs;
 * - anything else (`Todo`, `Blocked`, an absent status) is NOT bookkeeping: a
 *   claim is ownership, so the transition refuses and names the recorded state.
 *
 * Bookkeeping is applied only when it is entailed. A missing verdict, report,
 * acceptance or merge is never inferred here: the evidence gates above and the
 * coordinator verbs' own decision gates still refuse those, naming the one fact
 * the caller must obtain (R5's second half, A18).
 */
export function entailedHandoffStatus(row: PlanRow, planId: string): "InReview" | null {
  const status = rowStatusOf(row);
  if (status === "InReview") return null;
  if (status === "InProgress") return "InReview";
  throw new CoordinationError(
    "coordination.invalid-transition",
    `handoff requires plan ${planId} to have recorded InReview \u2014 it is ${status || "unstatused"}, and an unclaimed row's status ` +
      "is ownership rather than a reporting step this call may supply",
    { plan_id: planId, status: row.status },
  );
}

/**
 * §6.2/§R5 (A18) the refusal of a transition whose prerequisite is a recorded
 * DECISION — a submission the coordinator accepts, a verdict, a report, an
 * acceptance, a merge — rather than the bookkeeping this module applies itself.
 * The report names the record that is absent, the facts that are true now, the
 * ONE decision or work item that is genuinely missing and the work that remains
 * available; nothing is fabricated to let the transition proceed, and no
 * unrelated field is demanded. Both transports consume the same object: the DB
 * route reports it directly, the file route's row frame carries it into the
 * refusal sidecar it already attaches.
 */
export function missingDecision(input: {
  planId: string;
  what: string;
  component: string;
  path: string;
  currentFacts: readonly string[];
  needed: string;
  availableWork?: readonly string[];
}): CoordinationError {
  const problem: RecoveryProblem = {
    component: input.component,
    path: input.path,
    code: "coordination.invalid-transition",
    sourcesTried: [
      `the addressed plan ${input.planId} as this call reads it`,
      `the ${input.what} transition's own decision gate`,
    ],
    currentFacts: [...input.currentFacts],
    needed: input.needed,
    withheldEffect:
      `the ${input.what} transition and its whole commit: plan ${input.planId}, its coordination block and every revision are ` +
      "exactly as they were",
    availableWork: [
      ...(input.availableWork ?? [
        `read plan ${input.planId} and its recorded evidence`,
        "independent operations on other rows, plans and workflows continue",
      ]),
    ],
  };
  return new CoordinationError("coordination.invalid-transition", `${input.what}: ${problem.needed}`, {
    plan_id: input.planId,
    component: problem.component,
    path: problem.path,
    current_facts: problem.currentFacts,
    needed: problem.needed,
    withheld_effect: problem.withheldEffect,
    available_work: problem.availableWork,
    recovery: unresolvedRecovery({ target: { planId: input.planId }, unresolved: [problem] }),
  });
}

/** The handoff states one coordinated transition starts from (spec §D/§E). */
export function requireHandoffState(
  handoff: PlanHandoff,
  states: readonly string[],
  planId: string,
  what: string,
): void {
  if (!states.includes(handoff.state)) {
    // §R5 (A18) the recorded decision this transition starts from is absent:
    // an acceptance, an integration attempt or a completed attempt is a
    // decision (or the work behind it), never bookkeeping — it is asked for,
    // named on its own, and nothing is recorded in its place.
    throw missingDecision({
      planId,
      what,
      component: "plan-handoff",
      path: "handoff.state",
      currentFacts: [
        `plan ${planId} handoff ${handoff.id} records ${handoff.state}`,
        `the sealed attempt owns the plan's transition, and ${what} starts from ${states.join(" or ")}`,
      ],
      needed:
        `${what} requires ${states.join(" or ")} for plan ${planId}, and its handoff ${handoff.id} records ${handoff.state} \u2014 ` +
        "obtain the decision (or the work it needs), then retry",
      availableWork: [
        `read plan ${planId} and its sealed handoff ${handoff.id}`,
        `obtain the missing decision (${states.join(" or ")}) for plan ${planId}, then retry ${what}`,
        "independent operations on other rows, plans and workflows continue",
      ],
    });
  }
}

/** The QC verdict and QA decision a completing handoff must already carry (spec §E). */
export function assertAcceptedReviewDecision(handoff: PlanHandoff, planId: string, what: string): void {
  if (handoff.qc.decision !== "Approve" && handoff.qc.decision !== "Approve with residuals") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires an accepted QC decision for plan ${planId} \u2014 got ${handoff.qc.decision}`,
      { plan_id: planId, decision: handoff.qc.decision },
    );
  }
  if (handoff.qa.decision !== "pass") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires QA decision pass for plan ${planId} \u2014 got ${handoff.qa.decision}`,
      { plan_id: planId, decision: handoff.qa.decision },
    );
  }
}

/** The integration attempt recorded on a handoff, or a refusal (spec §E). */
export function requireIntegration(handoff: PlanHandoff, planId: string): HandoffIntegration {
  const integration = handoff.integration;
  if (integration === undefined) {
    throw integrationUnresolved(`plan ${planId} handoff ${handoff.id} has no integration attempt`, {
      plan_id: planId,
      handoff_id: handoff.id,
    });
  }
  return integration;
}

/** The integration anchors the snapshot names for a workflow (spec §E). */
export type IntegrationAnchors = { targetBranch: string; worktreePath: string };

/**
 * The recorded integration target of a workflow (spec §E). A missing anchor is
 * an unresolved integration — never guessed from the current branch.
 */
export function integrationAnchors(snapshot: WorkflowSnapshot, planId: string): IntegrationAnchors {
  const targetBranch = snapshot.branch?.integration;
  const worktreePath = snapshot.integration_worktree_path;
  if (!isNonEmptyString(targetBranch) || !isNonEmptyString(worktreePath)) {
    throw integrationUnresolved(
      `plan ${planId} has no integration target \u2014 the snapshot must name branch.integration and integration_worktree_path`,
      { plan_id: planId },
    );
  }
  return { targetBranch, worktreePath: canonicalTarget(worktreePath) };
}

/** The delivery anchors a standalone completion reads (spec §E). */
export function standaloneDeliveryAnchors(snapshot: WorkflowSnapshot, planId: string): { source: string; target: string } {
  const source = snapshot.branch?.source;
  const target = snapshot.branch?.target;
  if (!isNonEmptyString(source) || !isNonEmptyString(target)) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${planId} has no delivery anchors \u2014 the snapshot must name branch.source and branch.target`,
      { plan_id: planId },
    );
  }
  return { source, target };
}

/**
 * The workflow's merge lease, but only when it names THIS attempt (spec §E).
 * The lease is a single workflow-wide top-level claim, so a holder match alone
 * is not ownership: a lease that names another plan, or another source branch,
 * belongs to a different attempt and must never be released or re-pinned by
 * this one — the same plan can integrate more than once.
 */
export function mergeLeaseOfAttempt(
  lease: IntegrationMergeLease | null | undefined,
  planId: string,
  sourceBranch: string,
): IntegrationMergeLease | undefined {
  if (lease === null || lease === undefined) return undefined;
  if (lease.plan_id !== planId) return undefined;
  if (lease.source_branch !== sourceBranch) return undefined;
  return lease;
}

/**
 * Standalone completion refuses a workflow that carries integration state, on
 * either transport: a handoff that already names an attempt, a recorded
 * integration checkout/branch or a merge lease is iteration delivery, and
 * completing it through the standalone route would drop that evidence.
 */
export function assertNoIntegrationContamination(input: {
  snapshot: WorkflowSnapshot;
  planId: string;
  handoff: PlanHandoff;
  what: string;
  code?: CoordinationError["code"];
}): void {
  const { snapshot, planId, handoff, what } = input;
  const code = input.code ?? "coordination.invalid-transition";
  if (handoff.integration !== undefined) {
    throw new CoordinationError(code, `${what} refuses plan ${planId} because the handoff already carries an integration record`, {
      plan_id: planId,
    });
  }
  if (snapshot.integration_worktree_path !== undefined) {
    throw new CoordinationError(code, `${what} refuses plan ${planId} because the snapshot names integration_worktree_path`, {
      plan_id: planId,
    });
  }
  if (isNonEmptyString(snapshot.branch?.integration)) {
    throw new CoordinationError(code, `${what} refuses plan ${planId} because the snapshot names branch.integration`, {
      plan_id: planId,
      integration: snapshot.branch?.integration,
    });
  }
  if (snapshot.integration_merge_lease !== undefined) {
    throw new CoordinationError(code, `${what} refuses plan ${planId} because the snapshot carries an integration merge lease`, {
      plan_id: planId,
    });
  }
}

/**
 * §2.2 the DB row's stored coordination block is validated on a transport whose
 * shape is `validateRowCoordination`'s — a second validator would be a second
 * state machine — so the handoff is validated here without conflating its
 * historical submitter association with an actionable transition's live binding.
 */
export function storedCoordinationViolations(
  block: Record<string, unknown>,
  options: {
    revision: number;
    route: RowValidationRoute;
    submitterAssociated: boolean;
    activeSessionBound?: boolean;
    what: string;
  },
): ValidationResult[] {
  const { revision, route, submitterAssociated, activeSessionBound, what } = options;
  const { handoff, ...rest } = block;
  const violations = validateRowCoordination({ revision, ...rest }, what, route);
  if (handoff !== undefined) {
    violations.push(...validatePlanHandoff(handoff, `${what}.handoff`, route));
    if (!submitterAssociated) {
      violations.push({
        ok: false,
        severity: "high",
        code: "coordination.row.handoff-field",
        message: `${what}.handoff submitted_by has no matching historical plan-pm session for this plan`,
      });
    }
    if (activeSessionBound === false && !(isPlainObject(handoff) && handoff.state === "completed")) {
      violations.push({
        ok: false,
        severity: "high",
        code: "coordination.row.handoff-field",
        message: `${what}.handoff requires a bound plan session`,
      });
    }
  }
  return violations;
}
