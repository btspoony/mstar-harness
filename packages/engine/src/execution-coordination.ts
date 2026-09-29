/**
 * execution-coordination.ts — the DB transport of the plan coordination
 * operations (primary spec §2.3/§3/§4.1).
 *
 * One accepted plan operation is ONE transaction. `withExecutionPlanAuthority`
 * owns that transaction, the shared role/scope gates and the sealed witness
 * every DB plan verb starts from; W2 adds the first two operations on top of it
 * — `prepare` (which seals the reviewed Assignment and selects the frozen
 * catalog input) and `progress` (which moves a bound row's status/summary) — and
 * W3 adds the two residual operations, whose issue-authority work is composed
 * into this same transaction through the handle-taking helpers of `issue.ts`.
 * W4 adds the rest here.
 *
 * Nothing here is a public surface: the package index exports no coordination
 * mutator, and `mutateExecutionPlan` is published only once its whole closed
 * operation union exists (W4).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { assertCatalogExecutionCommittedOn } from "./catalog-registration.js";
import {
  CoordinationError,
  assertExactKeys,
  canonicalTarget,
  isNonEmptyString,
  isPlainObject,
  sha256Bytes,
  validatePlanProgress,
  validatePreparedCoordination,
  type CoordinationErrorCode,
  type PreparedCoordination,
} from "./coordination-write.js";
import {
  ExecutionPinConflictError,
  assertEvidenceInsidePlanArea,
  assertFeatureCheckout,
  assertHandoffGitProof,
  assertIntegrationCheckout,
  assertPreparedFresh,
  assertRecordedResult,
  assertSealedInputsUnchanged,
  assertStandaloneSourceGitProof,
  assertViolationFree,
  assignmentIntentOf,
  catalogPinFactsOn,
  captureGitProofWitness,
  gitObjectExists,
  gitRead,
  integrationProof,
  parseAssignmentFile,
  planAreaRoots,
  proofRepository,
  revalidateGitProofWitness,
  selectCatalogPinOn,
  type AssignmentHeaders,
  type GitProofWitness,
} from "./coordination.js";
import {
  IMPLEMENTED_OPERATIONS,
  assertAcceptedReviewDecision,
  assertEvidenceDigests,
  assertExecutionHolder,
  assertHandoffEvidenceUnchanged,
  assertNoHandoffTransition,
  assertNoIntegrationContamination,
  assertOperationRole,
  assertPlanAddress,
  assertPrepareAdmission,
  assertTrackBranches,
  entailedHandoffStatus,
  gitProof,
  integrationAnchors,
  integrationDiverged,
  integrationUnresolved,
  mergeLeaseOfAttempt,
  missingDecision,
  projectBucketOf,
  readHandoffEvidence,
  requireExecutionLease,
  requireHandoffState,
  requireIntegration,
  requirePlanHandoff,
  requireProgressStatus,
  requireRowStatus,
  rowStatusOf,
  standaloneDeliveryAnchors,
  storedCoordinationViolations,
  summarize,
  type CoordinationSeat,
} from "./coordination-transitions.js";
import {
  ExecutionError,
  advancePlanOperationRevisions,
  assertExecutionToken,
  assertOperationId,
  claimIntegrationMergeLease,
  readExecutionPlan,
  readExecutionPlanWitness,
  readExecutionState,
  readExecutionSealedInput,
  readHeldExecutionLeases,
  readLiveSessionIdentities,
  readPlanOperationReplay,
  readWorkflowSessionRows,
  parseExecutionToken,
  releaseExecutionLease,
  releaseIntegrationMergeLease,
  resolvePlanRead,
  resolveTokenFreshness,
  semanticRequestHash,
  serializeExecutionValue,
  transferExecutionLease,
  withExecutionTransaction,
  writeExecutionInputPin,
  writePlanCoordinationRow,
  writePlanOperationReceipt,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionMutation,
  type ExecutionPlanView,
  type ExecutionPlanWitness,
  type ExecutionRead,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
  type ExecutionTransaction,
  type ResolvedPlanRead,
  type SessionRow,
  type TokenFreshness,
} from "./execution-store.js";
import {
  assertCaptureRequest,
  assertClosureAuthority,
  assertIssueLinkedToPlanOn,
  assertIssueStoreActive,
  assertTerminalDisposition,
  captureIssueOn,
  closeIssueOn,
  issueWriteSeat,
  linkIssueOn,
  storeRevisionOn,
  IssueError,
  type CaptureInput,
  type ComposedTransactionRevision,
} from "./issue.js";
import { canonicalizeNearestExisting, resolvePlanDir, resolveSddDir } from "./path.js";
import { resumeExecutionSession } from "./execution-session.js";
import { resolveCurrentAuthority } from "./store-read.js";
import {
  PLAN_OPERATION_SEMANTICS,
  selectSemanticFields,
  unresolvedRecovery,
  type RecoveryDetails,
  type RecoveryProblem,
  type ResolutionSource,
  type SemanticSelection,
} from "./recovery-intent.js";
import { findingsCleanupGate } from "./project.js";
import { StoreError, storeDbPath } from "./store-db.js";
import {
  consultDeliveryEvidence,
  isStandaloneDevelopmentWorkflow,
  isStandaloneReportOnlyWorkflow,
  rowValidationRoute,
  type WorkflowSnapshot,
} from "./workflow.js";
import type { PlanCoordinationOperation } from "./coordination.js";
import type { PlanHandoff, RowCoordination } from "./coordination-write.js";
import type { ExecutionLease, IntegrationMergeLease } from "./lease.js";
import type { PlanRow } from "./status.js";

/**
 * §3 the DB route's verb vocabulary: the closed coordination union minus the
 * legacy delivery-source repair. That instrument exists only to correct pre-fix
 * file snapshots registered with `branch.source === branch.target`
 * (`plan-lifecycle-standalone-completion.md`) — `phase2a-execution-contract.md`
 * §3 lists eleven operations and does not include it, so the DB authority never
 * admits it.
 *
 * One union and one role/state machine for both transports — a second verb set
 * is what the extraction exists to prevent — and the exclusion is named once,
 * as this type plus the runtime set below.
 */
export type CoordinationOperation = Exclude<PlanCoordinationOperation, { kind: "repair-delivery-source" }>;

/** The one §3 exclusion above, as the runtime half of the same single rule. */
const LEGACY_ONLY_OPERATIONS: Record<string, true> = { "repair-delivery-source": true };

/**
 * §3 one DB plan operation call: the session reference the caller claims, the
 * plan it addresses with the token it read, and the operation itself. The
 * caller identity is NOT part of this request — it comes from
 * `ExecutionContext.caller`, so a role named here authorizes nothing.
 *
 * § One resolver path an explicit supplied value is a CONSTRAINT, never a
 * prerequisite: `session`, `expected` and `planId` may be omitted, and the
 * frame resolves each from the current authority, the trusted caller's own
 * binding and the record it reads. A call that states all three resolves to
 * exactly the request it already was.
 */
export type ExecutionPlanCall = {
  session?: ExecutionSessionRef;
  /** The addressed plan's `exec-v1` token from the current read (the CAS). */
  expected?: ExecutionToken;
  /** The plan this operation transitions; omitted for a plan-pm caller, whose own binding names it. */
  planId?: string;
  operation: CoordinationOperation;
};

/**
 * §3 the sparse envelope a PUBLISHED DB mutation accepts: the operation id that
 * makes an identical retry a replay, and the two addressing facts the engine
 * can derive (`session`, `expected`). It is the `ExecutionMutation` shape with
 * its derivable half optional — a fully specified call is still a valid intent.
 */
export type ExecutionMutationIntent = {
  operationId: string;
  session?: ExecutionSessionRef;
  expected?: ExecutionToken;
};

/** §3 one DB plan-operation intent: the sparse envelope plus the plan it addresses. */
export type ExecutionPlanIntent<Operation extends CoordinationOperation = CoordinationOperation> = ExecutionMutationIntent & {
  planId?: string;
  operation: Operation;
};

/**
 * § One resolver path: the plan one DB intent addresses — the explicit
 * selection, else the plan the trusted plan-pm caller's own identity is bound
 * to. Neither is a guess (a coordinator states the plan it addresses), so when
 * both are absent the caller gets its own question instead of "the only plan"
 * or "the most recent row".
 */
function resolvePlanAddress(caller: ExecutionCaller, stated: string | undefined, kind: string): string {
  if (isNonEmptyString(stated)) return stated;
  if (caller?.role === "plan-pm" && isNonEmptyString(caller.planId)) return caller.planId;
  throw unresolvedPlanAddress(caller, kind);
}

/**
 * § One resolver path: no plan was stated and the trusted caller's own identity
 * names none. The refusal is the caller's question — the one selection that
 * would release the addressed effect — in the frozen problem shape, never a
 * guess at "the only plan" or "the most recent row".
 */
function unresolvedPlanAddress(caller: ExecutionCaller, kind: string): CoordinationError {
  const bound =
    caller?.role === "plan-pm" || caller?.role === "coordinator"
      ? `the trusted caller is a ${caller.role} session ${JSON.stringify(caller.sessionId)} of workflow ${JSON.stringify(caller.workflowId)}`
      : "the trusted caller carries no usable session identity";
  const code: CoordinationErrorCode = "coordination.invalid-input";
  const problem: RecoveryProblem = {
    component: "target",
    path: "planId",
    code,
    sourcesTried: ["planId (intent.explicit)", "the trusted caller identity (association)"],
    currentFacts: [bound, `no plan id was stated by this ${kind} intent`],
    needed: `which plan this ${kind} addresses`,
    withheldEffect:
      "the addressed plan operation - no target was guessed, so no plan row, session or CAS token was read for it",
    availableWork: [
      "address the plan explicitly (planId)",
      ...(caller?.role === "coordinator" ? ["run the operation under the addressed plan's own plan-pm session"] : []),
    ],
  };
  return new CoordinationError(code, `${problem.needed}: ${problem.currentFacts.join("; ")}`, {
    component: problem.component,
    path: problem.path,
    sources_tried: problem.sourcesTried,
    current_facts: problem.currentFacts,
    available_work: problem.availableWork,
    recovery: unresolvedRecovery({ target: {}, unresolved: [problem] }),
  });
}

/**
 * § One resolver path (S2/E02): the CURRENT authority of a sparse DB intent.
 * The route is what selects the authority — a flag never does — and a control
 * root whose authority is not the ACTIVE execution store has nothing to
 * resolve a session or a CAS token from, so a sparse intent refuses here
 * instead of falling back to the file route or to an invented binding.
 *
 * Module-scoped: `resolveSparseOwnSession` below is the exported half both DB
 * entrypoints share, so no consumer can perform the route read without the
 * own-binding read it exists for.
 */
async function assertSparseExecutionAuthority(context: ExecutionContext, what: string): Promise<void> {
  const authority = await resolveCurrentAuthority(context);
  if (authority.route === "execution") return;
  throw new ExecutionError(
    "execution.not-active",
    `the control root ${context.harnessDir} answers on the ${authority.route} route, so it holds no ACTIVE execution authority for ${what} ` +
      `to resolve its session and CAS token from. A failed or absent execution authority never falls back to the file route: migrate and ` +
      `initialize the store, or address the same intent through the file route's own verb.`,
  );
}

/**
 * § One resolver path (E02/E03, R8/A09) for a sparse DB intent: the current
 * authority route first, then the trusted caller's OWN live binding
 * reconstructed from its durable session row. The route is read first because
 * it is what selects the authority, and a caller whose own binding is missing
 * gets that identity's own question instead of another holder's record.
 *
 * Shared by the plan and workflow entry frames of the ACTIVE route, so both
 * resolve the same two facts the same way.
 */
export async function resolveSparseOwnSession(context: ExecutionContext, what: string): Promise<ExecutionSessionRef> {
  await assertSparseExecutionAuthority(context, what);
  return (await resumeExecutionSession(context)).data;
}

/**
 * § One resolver path (S2/E02) for the plan route: the plan address, then the
 * trusted caller's OWN live binding reconstructed from its durable session row
 * (E03/R8/A09 — a projection the caller had to keep is not required), then the
 * plan token that read returned. Every derived fact names a source the engine
 * actually read, and an explicitly supplied value is passed through untouched.
 */
async function resolvePlanIntent<Operation extends CoordinationOperation>(
  context: ExecutionContext,
  request: ExecutionPlanIntent<Operation>,
  operation: Operation,
): Promise<ExecutionPlanRequest<Operation>> {
  const planId = resolvePlanAddress(context.caller, request.planId, operation.kind);
  if (request.session !== undefined && request.expected !== undefined) {
    return { operationId: request.operationId, session: request.session, expected: request.expected, planId, operation };
  }
  const session = request.session ?? (await resolveSparseOwnSession(context, `a ${operation.kind} plan operation`));
  const expected = request.expected ?? (await readExecutionPlan(context, session, planId)).token;
  return { operationId: request.operationId, session, expected, planId, operation };
}

/**
 * §2.3/§3.1/§4.1 the authorization boundary of one DB plan operation.
 *
 * The operation's kind decides which seat may issue it and a plan session
 * addresses only its own plan — the SHARED pure rules, so the DB route cannot
 * drift from the file route. Inside one `BEGIN IMMEDIATE` transaction the
 * authority must be active, the trusted caller's own session row is revalidated
 * at the current epoch, the addressed plan is selected under that authority and
 * the supplied token is compared against the plan's exact CAS token. The
 * addressed plan's sealed witness is then handed to the operation's transition,
 * which commits or rolls back with everything above. The reference gate itself
 * runs inside that transaction, after the authority-state refusal: this route's
 * order is unchanged, and only `readExecutionPlan` — which owns no transaction
 * until its request is valid — gates before the store is opened.
 *
 * § One resolver path (S2/E02) an omitted `session` is the trusted caller's OWN
 * live binding reconstructed from its durable row, and an omitted `expected` is
 * the plan token this transaction reads — the two facts the caller would
 * otherwise copy out of a previous read. An explicit value is passed through
 * untouched, so a fully specified call keeps this frame's exact behavior; a
 * call that states neither still resolves *inside* the same authorization
 * boundary, and its resolved inputs stay strict.
 *
 * A forged caller/role, a sibling plan, a revoked or stale-epoch reference, a
 * stale token and a nested call all refuse with no row, revision or receipt
 * change. The transition body receives the owned transaction — the only handle
 * a DB operation may write through — and is synchronous for the same reason
 * `withExecutionTransaction` requires it: nothing awaits, launches, reads a file
 * or mutates Git between BEGIN and COMMIT (§4.1).
 */
export async function withExecutionPlanAuthority<T>(
  context: ExecutionContext,
  call: ExecutionPlanCall,
  transition: (witness: ExecutionPlanWitness, tx: ExecutionTransaction) => T,
): Promise<T> {
  const operation = call.operation;
  if (!isPlainObject(operation) || !isNonEmptyString(operation.kind)) {
    throw new CoordinationError("coordination.invalid-input", "a plan operation needs an operation with a kind");
  }
  const planId = resolvePlanAddress(context.caller, call.planId, operation.kind);
  assertPlanOperationAdmissible(context.caller, operation.kind, planId);
  const session = call.session ?? (await resolveSparseOwnSession(context, `a ${operation.kind} plan operation`));
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; a plan operation requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    const witness = readExecutionPlanWitness(tx, resolvePlanRead(context.caller, session, planId));
    assertExecutionToken(call.expected ?? witness.token, {
      kind: "plan",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [witness.workflowId, witness.planId],
      revision: witness.revision,
    });
    return transition(witness, tx);
  });
}

/* ------------------------------------------------------------------------ *
 * §3 the operation envelope and the gates every plan operation runs
 * ------------------------------------------------------------------------ */

/** §3 the `prepare` member of the closed union, unchanged. */
export type PrepareOperation = Extract<CoordinationOperation, { kind: "prepare" }>;

/** §3 the `progress` member of the closed union, unchanged. */
export type ProgressOperation = Extract<CoordinationOperation, { kind: "progress" }>;

/**
 * §3 one DB plan operation request: the §3.1 mutation envelope — operation id,
 * session reference and CAS token — plus the plan it addresses and the
 * operation itself. `Operation` narrows which member of the closed union this
 * call carries, so a verb takes exactly the operation it implements.
 */
export type ExecutionPlanRequest<Operation extends CoordinationOperation = CoordinationOperation> = ExecutionMutation & {
  planId: string;
  operation: Operation;
};

/**
 * §3 the seat/scope gate of one DB plan verb: the accepted-kind check, the
 * operation's required seat and the plan a plan session may address. One
 * implementation for the boundary and for the operation entries, so no verb can
 * be reached by a seat the shared rules refuse.
 */
function assertPlanOperationAdmissible(caller: ExecutionCaller, kind: string, planId: string): void {
  // §3 the accepted set is the closed union minus the legacy-only repair: a
  // verb the shared table carries for the FILE route is still not a DB verb.
  if (IMPLEMENTED_OPERATIONS[kind] !== true || LEGACY_ONLY_OPERATIONS[kind] === true) {
    throw new CoordinationError("coordination.unknown-operation", `${kind} is not a coordination operation`, {
      operation: kind,
    });
  }
  const seat: CoordinationSeat = { role: caller.role, sessionId: caller.sessionId, planId: caller.planId };
  assertOperationRole(seat, kind);
  assertPlanAddress(seat, planId);
}

/**
 * §3 one resolved plan operation: the validated envelope plus the address the
 * pure reference gate already authorized. Resolving the reference BEFORE the
 * store is opened preserves the precedence of `readExecutionPlan`: a malformed,
 * foreign-role or caller-mismatched reference is refused by itself, never by —
 * or after — an authority-state, store-open or file-read failure.
 */
type ResolvedPlanOperation<Operation extends CoordinationOperation> = {
  call: ExecutionPlanRequest<Operation>;
  read: ResolvedPlanRead;
};

function resolvePlanOperationRequest<Operation extends CoordinationOperation>(
  caller: ExecutionCaller,
  request: ExecutionPlanRequest<Operation>,
  kind: string,
): ResolvedPlanOperation<Operation> {
  if (!isPlainObject(request)) throw invalidPlanInput("a plan operation needs a request object");
  if (!isNonEmptyString(caller?.sessionId)) {
    throw invalidPlanInput("the execution caller needs a non-empty session identity");
  }
  const operationId = assertOperationId((request as { operationId?: unknown }).operationId);
  const planId = (request as { planId?: unknown }).planId;
  if (!isNonEmptyString(planId)) throw invalidPlanInput("a plan operation needs the non-empty plan id it addresses");
  assertPlanOperationAdmissible(caller, kind, planId);
  const read = resolvePlanRead(caller, request.session, planId);
  return { call: { ...request, operationId, planId }, read };
}

/** The caller-input refusal of this module (`coordination.invalid-input`). */
function invalidPlanInput(detail: string): CoordinationError {
  return new CoordinationError("coordination.invalid-input", detail);
}

/**
 * §4.1 the running-lifecycle admission of a plan operation, read from the
 * witness: a plan's transitions belong to a lifecycle that is still executing,
 * so a paused, failed, stopped or completed workflow refuses them — the same
 * admission the coordinator bind applies. The row, its revisions and the
 * operation ledger are untouched by the refusal.
 */
function assertRunningWorkflow(witness: ExecutionPlanWitness): void {
  const status = witness.view.workflow.status;
  if (status !== "running") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `workflow ${witness.workflowId} is ${String(status)} \u2014 a plan operation requires a running lifecycle`,
      { workflow_id: witness.workflowId, plan_id: witness.planId, status },
    );
  }
}

/**
 * §2.2 one plan view as the SHARED row rules read it: the stored row plus the
 * plan's own lease. The view serves the lease RECORD — a released row is §3.1's
 * tombstone and an existing key — so a rule that needs a HOLDER is handed the
 * lease only while it is held, exactly as the file route hands over its lease
 * object only when the key exists.
 */
function planRowOf(view: ExecutionPlanView): PlanRow {
  const lease = view.executionLease;
  return {
    ...(view.plan as unknown as Record<string, unknown>),
    execution_lease: lease !== null && lease.status === "held" ? lease : undefined,
  } as unknown as PlanRow;
}

/**
 * §D/§E the row admission every plan-owned write shares, read from the
 * store-held witness — the DB route's equivalent of the file route's
 * `assertRowBinding` plus the freshness check its locked read performs:
 *
 * 1. the prepared Assignment is re-authenticated (an Assignment edited after
 *    `prepare` invalidates the row until the coordinator re-prepares);
 * 2. the addressed row's own lease must be HELD by this session — identity is
 *    not ownership, and the store keeps released lease rows as tombstones
 *    (§3.1), so the equivalent of the file route's lease object is a held one;
 * 3. a handoff owns the plan's transition until the coordinator returns or
 *    completes it.
 */
function assertPlanOwnedWrite(witness: ExecutionPlanWitness, what: string): void {
  const planId = witness.planId;
  const coordination = witness.view.coordination ?? undefined;
  if (coordination?.prepared !== undefined) {
    assertPreparedFresh(coordination.prepared.assignment_path, coordination.prepared);
  }
  assertExecutionHolder(planRowOf(witness.view), witness.session.sessionId, planId, what);
  assertNoHandoffTransition(coordination, planId);
}

/**
 * §2/§4 the issue-authority admission of the two residual verbs: the same row
 * admission as every plan-owned write, then the issue/catalog store
 * precondition the public issue verbs enforce through `withWrite`. Both are
 * read on the transaction this call already owns.
 */
function assertResidualAdmission(witness: ExecutionPlanWitness, tx: ExecutionTransaction): void {
  assertPlanOwnedWrite(witness, "a plan-owned write");
  assertIssueStoreActive(tx.db);
}

/**
 * §3.1/§4.2 the request fingerprint of one plan operation: the operation kind,
 * the addressed plan, the caller identity the receipt is bound to and E01's
 * PUBLISHED semantic selection for that kind (`PLAN_OPERATION_SEMANTICS`) —
 * never the transport freshness (`expected` token, `session` reference,
 * `operationId`) the caller happened to present. A repeat after a lost response
 * is the same intent even when the caller re-read the row and re-presented a
 * fresh token (design R6/R7), so the fingerprint must not move with it; reusing
 * an operation id for a different business payload still refuses
 * `execution.operation-conflict` instead of replaying a foreign receipt (A13),
 * and another actor cannot replay this one.
 *
 * The selected fields are E01's own table: the fingerprint's contract is the
 * published selection, so a verb-local projection that merely re-renders the
 * request — an absent `track_branches` written as `null`, a snake_case alias —
 * is never the intent. A projection that RENDERS the request for a mutation
 * stays with that mutation.
 */
function planOperationRequestHash(
  caller: ExecutionCaller,
  read: { workflowId: string; planId: string },
  operation: CoordinationOperation,
): string {
  return semanticRequestHash({
    operation: operation.kind,
    address: { workflow_id: read.workflowId, plan_id: read.planId },
    caller,
    intent: selectSemanticFields({ planId: read.planId, operation }, PLAN_OPERATION_SEMANTICS[operation.kind]),
  });
}

/**
 * §4.1/§4.2 (A13) the plan-owned record each operation kind's effect is read
 * from, as the dot paths `selectSemanticFields` walks over ONE
 * `ExecutionPlanView`: serving a committed receipt is current success only while
 * the state that receipt recorded is still the state this transaction reads.
 *
 * The projection is the kind's OWN effect and nothing else — never the whole
 * row, its siblings or a revision — so a later accepted operation that changed
 * an unrelated field leaves the recorded effect genuinely held (A10), while the
 * effect itself being replaced is disclosed (A13). The two residual verbs write
 * no plan-owned state at all (their effect is an issue row in the issue
 * authority, whose operation-id idempotency and issue CRS decide a retry, and
 * which neither a later plan operation nor anything else on that authority
 * supersedes): their plan-owned projection is empty by construction.
 */
const PLAN_EFFECT_FIELDS: Readonly<Record<CoordinationOperation["kind"], SemanticSelection>> = {
  prepare: ["coordination.prepared", "plan.metadata.worktree_path", "plan.metadata.working_branch"],
  progress: ["coordination.progress", "plan.status", "plan.metadata.track_branches"],
  "residual-add": [],
  "residual-close": [],
  handoff: ["coordination.handoff", "plan.status"],
  accept: ["coordination.handoff", "plan.status"],
  return: ["coordination.handoff", "plan.status"],
  "integration-start": ["coordination.handoff", "plan.status"],
  "integration-accept": ["coordination.handoff", "plan.status"],
  complete: ["coordination.handoff", "plan.status"],
  reconcile: ["coordination.handoff", "plan.status"],
};

/**
 * §4.2 (A12/A13) whether the effect one recorded plan receipt committed is STILL
 * held: the recorded view and the state this transaction reads, compared on the
 * kind's own effect projection. The canonical serialization is the same one the
 * fingerprint uses, so "the same effect" is one comparison everywhere.
 */
function planEffectHeld(recorded: unknown, current: ExecutionPlanView, kind: CoordinationOperation["kind"]): boolean {
  const fields = PLAN_EFFECT_FIELDS[kind];
  return (
    serializeExecutionValue(selectSemanticFields(recorded, fields)) ===
    serializeExecutionValue(selectSemanticFields(current, fields))
  );
}

/**
 * §4.1/§4.2 (A13) the refusal of a plan receipt whose effect a later accepted
 * operation superseded: the recorded receipt is historical evidence and is never
 * served as current state, and the typed cause names both facts with the one
 * choice that remains — accept what the row holds now, or express the desired
 * effect as a NEW operation under a new operation id. Same report shape as the
 * workflow frame's superseded-effect refusal, addressed to the plan row.
 */
function supersededPlanEffectCause(input: {
  witness: ExecutionPlanWitness;
  operationId: string;
  kind: CoordinationOperation["kind"];
  recorded: unknown;
}): ExecutionError {
  const code = "execution.effect-superseded";
  const fields = PLAN_EFFECT_FIELDS[input.kind];
  const field = fields[0] ?? "coordination";
  const current = JSON.stringify(selectSemanticFields(input.witness.view, fields)) ?? "absent";
  const recorded = JSON.stringify(selectSemanticFields(input.recorded, fields)) ?? "absent";
  const problem: RecoveryProblem = {
    component: "plan-row",
    path: field,
    code,
    sourcesTried: [
      `execution_operations(epoch, ${JSON.stringify(input.operationId)}) \u2014 the recorded receipt`,
      `execution_plans(${input.witness.workflowId}, ${input.witness.planId}) as this transaction reads it`,
    ],
    currentFacts: [
      `operation id ${JSON.stringify(input.operationId)} committed the ${input.kind} effect ${recorded} on plan ` +
        `${input.witness.planId}`,
      `the row holds ${current} now, so a later accepted operation superseded that effect`,
    ],
    needed:
      `accept the current state of plan ${input.witness.planId}, or express the desired ${input.kind} effect again as a ` +
      `new operation with a NEW operation id`,
    withheldEffect: "the recorded receipt: it is historical evidence and is never restored as current state",
    availableWork: [
      `read plan ${input.witness.planId} and its current token`,
      `express the desired effect under a new operation id`,
      "independent operations on other plans and workflows continue",
    ],
  };
  return new ExecutionError(
    code,
    `operation id ${JSON.stringify(input.operationId)} committed the ${input.kind} effect ${recorded} on plan ` +
      `${input.witness.planId} of workflow ${input.witness.workflowId}, but the row holds ${current} now \u2014 a later ` +
      `accepted operation superseded that effect, and a superseded receipt is never restored. Nothing was written.`,
    {
      component: problem.component,
      path: problem.path,
      workflow_id: input.witness.workflowId,
      plan_id: input.witness.planId,
      operation_id: input.operationId,
      current_value: current,
      recorded_value: recorded,
      sources_tried: problem.sourcesTried,
      current_facts: problem.currentFacts,
      needed: problem.needed,
      available_work: problem.availableWork,
      recovery: unresolvedRecovery({
        target: { workflowId: input.witness.workflowId, planId: input.witness.planId },
        unresolved: [problem],
      }),
    },
  );
}

/**
 * §4.1 the sidecar of one plan-frame result: what this call did with the intent,
 * the record it addressed and the commit boundary the caller can rely on — the
 * same object shape a refusal carries under `error.details.recovery`, so a
 * consumer reads one contract on both paths.
 */
function planRecovery(input: {
  witness: ExecutionPlanWitness;
  kind: string;
  outcome: "applied" | "already-satisfied";
  commitState: RecoveryDetails["commitState"];
  resolvedFrom: readonly ResolutionSource[];
}): RecoveryDetails {
  return {
    outcome: input.outcome,
    target: { workflowId: input.witness.workflowId, planId: input.witness.planId },
    applied: input.outcome === "applied" ? [`${input.kind} on plan ${input.witness.planId}`] : [],
    unresolved: [],
    resolvedFrom: [...input.resolvedFrom],
    warnings: [],
    commitState: input.commitState,
  };
}

/**
 * §4.1 (R6/A09/A12) the sidecar of a served replay: the requested effect is the
 * one the recorded receipt already committed, so the call returns current
 * success without a second commit. `commitState: "committed"` describes the
 * receipt's own boundary — the effect IS committed, by the recorded operation,
 * and no revision or timestamp moved for this retry.
 */
function replayRecovery(witness: ExecutionPlanWitness, kind: string): RecoveryDetails {
  return planRecovery({
    witness,
    kind,
    outcome: "already-satisfied",
    commitState: "committed",
    resolvedFrom: [{ path: "operationId", source: "execution_operations receipt" }],
  });
}

/**
 * §4.1/§4.2 (A11) the refusal of one plan operation whose token is no longer the
 * addressed row's CAS. Unlike a workflow header — whose revision moves when any
 * child changes — a plan row's revision moves only when THAT row changes, so a
 * mismatch here is a relevant change to the very record this operation writes:
 * the requested effect is withheld, and the typed cause names the row, the
 * revisions and the current token that replaces the caller's.
 */
function stalePlanRowRefusal(
  witness: ExecutionPlanWitness,
  freshness: TokenFreshness,
  kind: string,
): ExecutionError {
  const problem: RecoveryProblem = {
    component: "plan-row",
    path: "expected",
    code: "execution.stale-token",
    sourcesTried: [
      `execution_plans(${witness.workflowId}, ${witness.planId}) as this transaction reads it`,
      "the caller's comparison token for that row",
    ],
    currentFacts: [
      `plan ${witness.planId} of workflow ${witness.workflowId} is at revision ${freshness.currentRevision} ` +
        `(status ${String(witness.view.plan.status ?? "none")})`,
      `the supplied token carries revision ${freshness.readRevision}`,
    ],
    needed:
      `re-read plan ${witness.planId} and retry the ${kind} operation with the token that read returns \u2014 the row's ` +
      `current token is ${witness.token}`,
    withheldEffect:
      `the ${kind} operation and its whole transaction: the row, its coordination block and every revision are exactly ` +
      `as they were`,
    availableWork: [
      `read plan ${witness.planId} and the workflow state`,
      `retry the ${kind} operation against the token of that read`,
      "operations on other rows and other workflows continue",
    ],
  };
  return new ExecutionError(
    "execution.stale-token",
    `the token carries revision ${freshness.readRevision}; plan ${witness.planId} of workflow ${witness.workflowId} is at ` +
      `revision ${freshness.currentRevision}. This is a relevant change to the addressed row: re-read it and retry.`,
    {
      component: problem.component,
      path: problem.path,
      workflow_id: witness.workflowId,
      plan_id: witness.planId,
      current_revision: freshness.currentRevision,
      presented_revision: freshness.readRevision,
      current_token: witness.token,
      sources_tried: problem.sourcesTried,
      current_facts: problem.currentFacts,
      available_work: problem.availableWork,
      recovery: unresolvedRecovery({
        target: { workflowId: witness.workflowId, planId: witness.planId },
        unresolved: [problem],
        resolvedFrom: [{ path: "planId", source: "intent.explicit" }],
      }),
    },
  );
}

/**
 * §2.2 one view's stored coordination block: what the view projects, minus the
 * revision that lives in the row column — and without the session binding the
 * DB authority stores in `execution_sessions`, never in the block.
 */
function storedCoordinationOf(view: ExecutionPlanView): Record<string, unknown> {
  const stored: Record<string, unknown> = { ...(view.coordination ?? {}) };
  delete stored.revision;
  return stored;
}

/**
 * §3.1/§4.1 the transaction of ONE accepted plan operation. Inside one
 * `BEGIN IMMEDIATE` transaction: the authority is active, the caller's
 * reference is revalidated against the store's own rows (which also selects the
 * addressed plan and re-reads the store-held session), the supplied token's
 * ADDRESS and generation are fenced, a committed receipt is returned for an
 * identical retry whose recorded effect the row still holds, the workflow must
 * still be running, and the supplied token's revision must be the plan's exact
 * CAS. Only then does `run` produce the operation's read, and the transaction's
 * one revision advance has already run: the advance and the receipt are the
 * frame's, so an operation cannot forget either, and an operation that composes
 * another domain's writes into this transaction reads the revision it commits
 * at from the shared counter instead of advancing it a second time.
 *
 * The caller has already passed `assertPlanOperationAdmissible` and the
 * operation-shape checks; `run` is synchronous for the same reason
 * `withExecutionTransaction` requires it — nothing awaits, launches, reads Git
 * or appends a file between BEGIN and COMMIT.
 */
function withExecutionPlanOperation<T>(
  context: ExecutionContext,
  resolved: ResolvedPlanOperation<CoordinationOperation>,
  requestHash: string,
  run: (witness: ExecutionPlanWitness, tx: ExecutionTransaction, at: string) => ExecutionRead<T>,
): Promise<ExecutionReceipt<T>> {
  const { call: request, read } = resolved;
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; a plan operation requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    const witness = readExecutionPlanWitness(tx, read);
    // §4.2 (R6/R7/A26) the supplied token's ADDRESS and generation are strict and
    // are fenced BEFORE anything is replayed or decided: a token of another
    // record, another store or a superseded epoch authorizes neither a replay nor
    // a mutation. Its REVISION is not a constraint — the commit this frame
    // records advanced the row, so an exact retry always presents a superseded
    // revision, which is exactly why revision drift stays replay freshness.
    const freshness = resolveTokenFreshness(
      request.expected,
      {
        kind: "plan",
        storeId: tx.storeId,
        epoch: tx.epoch,
        key: [witness.workflowId, witness.planId],
        revision: witness.revision,
      },
      { target: { workflowId: witness.workflowId, planId: witness.planId } },
    );
    const replay = readPlanOperationReplay<T>(tx, {
      operationId: request.operationId,
      requestHash,
      workflowId: witness.workflowId,
      planId: witness.planId,
    });
    if (replay !== null) {
      // §4.2 (R6/A13) the recorded receipt comes back with the provenance of the
      // commit it records — but only while the effect it recorded is still the
      // row's effect: nothing re-reads or re-writes the row it already applied, a
      // superseded effect is disclosed instead of restored, and the caller's
      // token revision is not re-evaluated (the commit itself advanced the row,
      // so an exact retry always presents a superseded token).
      if (!planEffectHeld(replay.data, witness.view, request.operation.kind)) {
        throw supersededPlanEffectCause({
          witness,
          operationId: request.operationId,
          kind: request.operation.kind,
          recorded: replay.data,
        });
      }
      return { ...replay, recovery: replayRecovery(witness, request.operation.kind) };
    }
    assertRunningWorkflow(witness);
    // §4.2 (R6/R7) a row revision that moved is a relevant change to the very
    // record this operation writes, so it is refused with the exact facts instead
    // of overwritten.
    if (!freshness.current) throw stalePlanRowRefusal(witness, freshness, request.operation.kind);
    const at = new Date().toISOString();
    // §3.1 the ONE revision advance of this accepted multi-domain transaction
    // runs BEFORE the body: a composed mutation (the residual verbs' issue work)
    // joins the shared advance instead of bumping the counter again, so the body
    // must be able to read the revision this transaction commits at. Nothing in a
    // body reads the counters it advances, and a refusal rolls the advance back
    // with everything else, so the order is not observable either way.
    advancePlanOperationRevisions(tx, { workflowId: witness.workflowId, now: at });
    const receipt = run(witness, tx, at);
    writePlanOperationReceipt(tx, {
      operationId: request.operationId,
      requestHash,
      workflowId: witness.workflowId,
      planId: witness.planId,
      receipt,
      now: at,
    });
    return {
      ...receipt,
      operationId: request.operationId,
      replayed: false,
      recovery: planRecovery({
        witness,
        kind: request.operation.kind,
        outcome: "applied",
        commitState: "committed",
        resolvedFrom: [{ path: "planId", source: "intent.explicit" }],
      }),
    };
  });
}

/* ------------------------------------------------------------------------ *
 * §3 `prepare` — the reviewed Assignment's seal and the frozen catalog input
 * ------------------------------------------------------------------------ */

/** The documents one `prepare` seals, read and hashed before the transaction. */
type PrepareSeal = {
  assignment: AssignmentHeaders;
  assignmentSha256: string;
  planSha256: string;
};

/**
 * The control harness root of the store this call transacts on: the directory
 * that owns `store.db`. `StoreContext.harnessDir` is the anchor the store was
 * RESOLVED from (a workspace root, or the harness directory itself), so the
 * root is read back from the store's own path rather than re-derived: the
 * database's location is what decides where its harness, its `{PLAN_DIR}` and
 * its `{SDD_DIR}` are.
 */
function controlHarnessRoot(context: ExecutionContext): string {
  return canonicalizeNearestExisting(dirname(storeDbPath(context)));
}

/**
 * §D/§4.1 the sealed input of one `prepare`, read BEFORE SQLite ownership: the
 * reviewed Assignment and the plan document it pins. The Assignment must
 * describe THIS store's harness, workflow and plan — a foreign Assignment is
 * never sealed onto a row — and both documents are hashed here so the
 * transaction can re-read the very bytes it is about to record (§4.1: a changed
 * witness refuses with no DB mutation).
 */
function readPrepareSeal(context: ExecutionContext, call: ExecutionPlanRequest<PrepareOperation>): PrepareSeal {
  const assignment = parseAssignmentFile(call.operation.assignmentPath);
  const harnessRoot = controlHarnessRoot(context);
  if (assignment.controlHarnessRoot !== harnessRoot) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `Assignment "Control harness root" ${assignment.controlHarnessRoot} does not match this store's control harness ${harnessRoot}`,
      { expected: harnessRoot, actual: assignment.controlHarnessRoot },
    );
  }
  if (assignment.workflowId !== context.caller.workflowId) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `Assignment "Workflow id" ${assignment.workflowId} is not the workflow ${context.caller.workflowId} this session belongs to`,
      { expected: context.caller.workflowId, actual: assignment.workflowId },
    );
  }
  if (assignment.planId !== call.planId) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `request planId ${call.planId} is not the Assignment's plan ${assignment.planId}`,
      { expected: assignment.planId, actual: call.planId },
    );
  }
  const planDir = canonicalizeNearestExisting(resolvePlanDir(harnessRoot));
  if (dirname(assignment.planPath) !== planDir || basename(assignment.planPath) !== `${call.planId}.md`) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `Assignment "Plan Path" ${assignment.planPath} is not ${join(planDir, `${call.planId}.md`)}`,
      { expected: join(planDir, `${call.planId}.md`), actual: assignment.planPath },
    );
  }
  const expectedSdd = canonicalizeNearestExisting(resolveSddDir(harnessRoot, call.planId));
  if (assignment.sddDir !== expectedSdd) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `Assignment "SDD dir" ${assignment.sddDir} does not match the engine's ${expectedSdd}`,
      { expected: expectedSdd, actual: assignment.sddDir },
    );
  }
  if (!existsSync(assignment.planPath)) {
    throw new CoordinationError("coordination.plan-not-found", `plan markdown not found: ${assignment.planPath}`, {
      path: assignment.planPath,
    });
  }
  return {
    assignment,
    assignmentSha256: sha256Bytes(readFileSync(assignment.assignmentPath)),
    planSha256: sha256Bytes(readFileSync(assignment.planPath)),
  };
}

/**
 * §3 `prepare` on the DB authority: the coordinator seals the reviewed
 * Assignment against the addressed plan and selects the plan's frozen catalog
 * input, in ONE transaction whose CAS is the plan's own token.
 *
 * The row admission, the Assignment seal, the plan-scope anchors and the pin
 * re-selection are the rules of §D/§2.2/§7; the operation adds no permission of
 * its own. A row that is already prepared (or bound, handed off or leased), an
 * Assignment that describes another harness/workflow/plan, a frozen input whose
 * pin disagrees with its own sealed selection, a held lease, a stale token and
 * a workflow that is no longer running each refuse with no row, input, or
 * receipt change — and an identical retry returns the recorded receipt without
 * advancing anything.
 */
export async function prepareExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<PrepareOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "prepare");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "assignmentPath"], "prepare operation");
  if (!isNonEmptyString(operation.assignmentPath) || !isAbsolute(operation.assignmentPath)) {
    throw invalidPlanInput("prepare requires an absolute assignmentPath");
  }
  const seal = readPrepareSeal(context, resolved.call);
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  const { planId, workflowId } = resolved.read;
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    const state = witness.view.plan as Record<string, unknown>;
    const plan = state as PlanRow;
    assertPrepareAdmission({
      planId: witness.planId,
      // A transport whose lease lives outside the row hands the rule the lease
      // it holds for this plan, so the refusal can still name the owner.
      row: { ...state, execution_lease: witness.view.executionLease ?? undefined },
      coordination: witness.view.coordination ?? undefined,
      sessionBound: witness.view.session !== null,
      leaseHeld: witness.view.executionLease !== null,
    });

    // §3 step 3 the registration admission the file route runs after its own
    // row admission: a root-visible workflow whose catalog registration is
    // still pending is never a valid workspace, because the row this operation
    // is about to seal would be prepared from an uncommitted registration. Read
    // on THIS transaction's handle — one connection, one transaction, the same
    // "pending" verdict as `assertCatalogExecutionCommitted` — and BEFORE the
    // frozen input and any pin or row write.
    assertCatalogExecutionCommittedOn(tx.db, controlHarnessRoot(context), witness.workflowId);

    // §2.2/§1 the frozen input is sealed, and a pin that disagrees with the
    // selection it is pinned to is a conflict: neither side is overwritten.
    const sealed = readExecutionSealedInput(tx, witness.workflowId, witness.planId);
    if (sealed.pin !== null && (sealed.pin.store_id !== tx.storeId || sealed.pin.document_hash !== sealed.inputHash)) {
      throw new ExecutionPinConflictError(
        `plan ${witness.planId}'s sealed execution input (${sealed.inputHash.slice(0, 12)}\u2026) and its recorded catalog pin ` +
          `(${sealed.pin.document_hash.slice(0, 12)}\u2026, store ${sealed.pin.store_id}) disagree \u2014 neither side is rewritten; ` +
          `resolve the frozen input explicitly`,
        { workflow_id: witness.workflowId, plan_id: witness.planId, pin: sealed.pin, input_hash: sealed.inputHash },
      );
    }
    // §7 the eligible authorized prepare re-selects the frozen catalog input:
    // the catalog identity is read on THIS transaction's own handle, so the
    // revision recorded is the one no concurrent catalog write can change
    // before commit, and the document half stays the sealed selection's hash.
    const pin = selectCatalogPinOn(
      catalogPinFactsOn(tx.db, tx.storeId, witness.workflowId, witness.planId),
      sealed.inputHash,
    );

    // §D the plan's own worktree/branch anchors, which the later plan bind
    // claims its execution lease against: recorded when the row carries none,
    // and never silently rebound when it records a different scope.
    const metadata = { ...(isPlainObject(plan.metadata) ? plan.metadata : {}) };
    const worktree = seal.assignment.worktreePath;
    const branch = seal.assignment.workingBranch;
    if (isNonEmptyString(metadata.worktree_path) && canonicalTarget(String(metadata.worktree_path)) !== worktree) {
      throw new CoordinationError(
        "coordination.scope-mismatch",
        `plan ${planId} records worktree ${String(metadata.worktree_path)}, but the Assignment pins ${worktree} \u2014 an authorized prepare never rebinds a plan's scope`,
        { plan_id: planId, expected: metadata.worktree_path, actual: worktree },
      );
    }
    if (isNonEmptyString(metadata.working_branch) && metadata.working_branch !== branch) {
      throw new CoordinationError(
        "coordination.scope-mismatch",
        `plan ${planId} records branch ${String(metadata.working_branch)}, but the Assignment pins ${branch} \u2014 an authorized prepare never rebinds a plan's scope`,
        { plan_id: planId, expected: metadata.working_branch, actual: branch },
      );
    }
    metadata.worktree_path = worktree;
    metadata.working_branch = branch;

    const prepared: PreparedCoordination = {
      assignment_path: seal.assignment.assignmentPath,
      assignment_sha256: seal.assignmentSha256,
      plan_sha256: seal.planSha256,
      qa_gate: seal.assignment.qaGate,
      findings_cleanup: seal.assignment.findingsCleanup,
      // §4.2 (A29) the same SEMANTIC projection the file route's `prepare`
      // records, from the same mapping: every transition of this row then
      // re-authenticates the reviewed Assignment by MEANING, so a reformatted
      // document leaves the row fresh while a scope/approval change still
      // invalidates it (`assertPreparedFresh`). The whole-document hash above
      // stays the seal's byte witness; it is no longer the formatting gate.
      assignment_intent: assignmentIntentOf(seal.assignment),
      prepared_by: witness.session.sessionId,
      prepared_at: at,
    };
    assertViolationFree(validatePreparedCoordination(prepared), "prepared block");
    // §7 the pin is written before the row, exactly as the sealed selection is:
    // the row writer then commits the prepared block and the plan revision that
    // is this operation's CAS.
    writeExecutionInputPin(tx, { workflowId, planId, pin });
    writeCoordinationBlock(tx, witness, {
      block: { ...storedCoordinationOf(witness.view), prepared },
      state: { ...state, metadata },
      what: `plan ${planId} coordination`,
    });
    // §4.1 the sealed documents are re-read immediately before the commit: an
    // edit between the pre-transaction read and here refuses rather than being
    // recorded as if it were the reviewed input.
    assertSealedInputsUnchanged({
      assignmentPath: seal.assignment.assignmentPath,
      assignmentSha256: seal.assignmentSha256,
      planPath: seal.assignment.planPath,
      planSha256: seal.planSha256,
      planId,
    });
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/* ------------------------------------------------------------------------ *
 * §3 `progress` — the executing row's status, summary and evidence
 * ------------------------------------------------------------------------ */

/**
 * §3 `progress` on the DB authority: the plan session that HOLDS the plan's
 * execution lease moves its own row's status, summary and reported branches,
 * against the plan token it read.
 *
 * The seat is the store's own session row (never a file envelope), the lease is
 * the one `execution_leases` holds for this plan, and the shared rules decide
 * the handoff gate, the status transition and the track-branch scope, so the DB
 * route refuses exactly what the file route refuses. The frozen assignment and
 * the frozen catalog input are witnesses here, never writers: a changed
 * Assignment refuses `coordination.assignment-stale`, and no progress copies a
 * newer catalog title, path or reference into the plan's sealed input.
 */
export async function progressExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<ProgressOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "progress");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "progress"], "progress operation");
  const progress = operation.progress;
  assertViolationFree(validatePlanProgress(progress), "progress");
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  const { planId, workflowId } = resolved.read;
  // §D the areas a plan's own evidence may live in: derived from the harness
  // root this store lives in, never from a caller-supplied path.
  const planAreas = planAreaRoots(controlHarnessRoot(context), planId);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx) => {
    const state = witness.view.plan as Record<string, unknown>;
    const plan = state as PlanRow;
    assertPlanOwnedWrite(witness, "a plan-owned write");
    requireProgressStatus(plan, progress.status, planId);
    if (progress.track_branches !== undefined) {
      assertTrackBranches(
        {
          planId,
          branch: witness.view.workflow.branch,
          plans: [plan, ...witness.siblings.map((sibling) => sibling.plan as PlanRow)],
        },
        progress.track_branches,
      );
    }
    assertEvidenceInsidePlanArea(planAreas, progress.evidence_paths);

    const metadata = { ...(isPlainObject(plan.metadata) ? plan.metadata : {}) };
    const nextMetadata =
      progress.track_branches !== undefined ? { ...metadata, track_branches: [...progress.track_branches] } : metadata;
    const nextState: Record<string, unknown> = { ...state, status: progress.status };
    if (nextMetadata !== plan.metadata) nextState.metadata = nextMetadata;
    writeCoordinationBlock(tx, witness, {
      block: {
        ...storedCoordinationOf(witness.view),
        progress: {
          status: progress.status,
          summary: progress.summary,
          evidence_paths: [...progress.evidence_paths],
          ...(progress.track_branches !== undefined ? { track_branches: [...progress.track_branches] } : {}),
        },
      },
      state: nextState,
      what: `plan ${planId} coordination`,
    });
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/* ------------------------------------------------------------------------ *
 * §3 `residual-add` / `residual-close` — the issue authority inside this
 * transaction
 * ------------------------------------------------------------------------ */

/** §3 the `residual-add` member of the closed union, unchanged. */
export type ResidualAddOperation = Extract<CoordinationOperation, { kind: "residual-add" }>;

/** §3 the `residual-close` member of the closed union, unchanged. */
export type ResidualCloseOperation = Extract<CoordinationOperation, { kind: "residual-close" }>;

/** One residual entry: the issue contract's capture input minus the project. */
type ResidualEntry = ResidualAddOperation["entries"][number];

/**
 * §3.1 the plan-revision advance of one accepted plan operation whose body does
 * not otherwise write the addressed row. The plan row's revision IS the plan
 * CAS, so an operation with domain work in another authority (the residual
 * verbs' issue work) and an operation whose requested state is already the
 * accepted state (a re-verified `integration-start`, a `reconcile` of a
 * completed attempt) both advance it exactly once, in this transaction, before
 * the receipt's read. Without it the plan CAS and the frame's store/workflow
 * advance disagree, and a caller holding the pre-operation plan token could
 * submit the next mutation with it and pass the exact-token CAS.
 *
 * Neither stored block changed — the operation's domain state and the row's
 * coordination are exactly what this transaction read — so they are written
 * back unchanged beside the advanced revision: the row writer is the one place
 * a plan revision advances, and no operation opens a second path to the
 * revision column.
 */
function advancePlanRowRevision(tx: ExecutionTransaction, witness: ExecutionPlanWitness): void {
  writePlanCoordinationRow(tx, {
    workflowId: witness.workflowId,
    planId: witness.planId,
    state: witness.view.plan as unknown as Record<string, unknown>,
    coordination: storedCoordinationOf(witness.view),
    revision: witness.revision + 1,
  });
}

/**
 * The deterministic issue operation ids of one residual mutation: one logical
 * mutation per session / plan / key, so an explicit retry converges on the same
 * issue rows instead of duplicating them. The shape is the file route's
 * (`coordination.ts`), because both routes journal into the SAME
 * `store_operations` ledger of the same store.
 */
function residualCaptureOperationId(sessionId: string, planId: string, occurrenceKey: string): string {
  return `residual-add:${sessionId}:${planId}:${occurrenceKey}`;
}

function residualLinkOperationId(sessionId: string, planId: string, occurrenceKey: string): string {
  return `residual-add-link:${sessionId}:${planId}:${occurrenceKey}`;
}

function residualCloseOperationId(sessionId: string, planId: string, issueId: string): string {
  return `residual-close:${sessionId}:${planId}:${issueId}`;
}

/** Derive plan-owned fields and report every independently invalid entry before writing. */
export function deriveResidualEntries(entries: readonly unknown[], projectId: string): CaptureInput[] {
  const derived: CaptureInput[] = [];
  const problems: Array<{ path: string; code: string; message: string }> = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!isPlainObject(entry)) {
      problems.push({ path: `entries[${index}]`, code: "coordination.invalid-input", message: "expected an issue observation object" });
      continue;
    }
    const input = { ...entry, projectId } as CaptureInput;
    try {
      assertCaptureRequest(input);
      derived.push(input);
    } catch (error) {
      if (!(error instanceof IssueError)) throw error;
      problems.push({ path: `entries[${index}]`, code: error.code, message: error.message });
    }
  }
  if (problems.length > 0) {
    throw new CoordinationError(
      "coordination.invalid-input",
      `residual-add entries are invalid: ${problems.map(({ path, message }) => `${path}: ${message}`).join("; ")}`,
      { problems },
    );
  }
  return derived;
}


/**
 * §3 `residual-add` on the DB authority: the plan session that HOLDS the plan's
 * execution lease captures each residual and links it to this plan, in the SAME
 * transaction that commits the workflow/store revisions and the operation
 * receipt.
 *
 * The issue work is composed, never re-entered: `captureIssueOn` / `linkIssueOn`
 * take this transaction's own handle, so there is no nested `BEGIN`, no second
 * connection and no session-file lookup on this route (§4.1 — the session and
 * lease rows the witness proves ARE this route's authorization). Any refusal
 * anywhere in the loop rolls back every entry, the receipt and the revision
 * advance together: an accepted operation is all-or-nothing, which the file
 * route's per-entry transactions cannot claim.
 *
 * A plan session captures into ITS plan: the link target is the addressed plan
 * id, never a caller-supplied target, and the seat/address gates require this
 * session to be the addressed plan's own plan-pm — the same condition the file
 * route's `assertPlanIterationIdentity` enforces against its envelope. The plan
 * row's state is untouched (a residual lives in the issue authority) while its
 * REVISION still advances once: the plan token is the plan's CAS, so the receipt
 * returns the token this operation spent its own on.
 */
export async function residualAddExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<ResidualAddOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "residual-add");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "entries"], "residual-add operation");
  const entries = operation.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw invalidPlanInput("residual-add requires at least one entry");
  }
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  const actor = issueWriteSeat(context.caller.role);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx) => {
    assertResidualAdmission(witness, tx);
    // Project membership is the only capture field owned by the plan. Resolve
    // and validate every entry before the first issue write; keep occurrence
    // keys caller-owned because they are the stable identity of each event.
    const projectId = projectBucketOf(witness.view.plan as unknown as PlanRow);
    const derivedEntries = deriveResidualEntries(entries, projectId);
    const { planId } = witness;
    const sessionId = witness.session.sessionId;
    // §3.1 the shared store revision this transaction commits at: the frame's
    // single advance has already run, so every composed issue helper joins it
    // instead of advancing the same counter once more.
    const composed: ComposedTransactionRevision = { committedStoreRevision: storeRevisionOn(tx.db) };
    for (const input of derivedEntries) {
      const occurrenceKey = input.occurrenceKey;
      const capture = captureIssueOn(
        tx.db,
        input,
        {
          operationId: residualCaptureOperationId(sessionId, planId, occurrenceKey),
          actor,
        },
        composed,
      );
      // Always link, never only on `created`: the plan link is the gate a later
      // residual-close is checked against, and both verbs are idempotent, so a
      // retry converges instead of leaving an unlinked issue the plan can never
      // close.
      linkIssueOn(
        tx.db,
        capture.issueId,
        { kind: "plan", target: planId },
        {
          operationId: residualLinkOperationId(sessionId, planId, occurrenceKey),
          actor,
          expectedRevision: capture.revision,
        },
        composed,
      );
    }
    advancePlanRowRevision(tx, witness);
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/**
 * §3 `residual-close` on the DB authority: the plan session that HOLDS the
 * plan's execution lease closes ONE finding linked to this plan, under the
 * issue revision the caller read, in the same transaction as the receipt and the
 * revision advance — the plan row's own CAS revision included, exactly as a
 * residual-add advances it.
 *
 * Two refusals protect the scope and the CAS: an issue that is not linked to
 * THIS plan refuses `issue.scope-refused` (a plan closes only its own findings —
 * the link is append-only, so the read cannot race an unlink), and an
 * `expectedIssueRevision` that is not the issue's current revision refuses
 * `issue.revision-conflict`. Both leave the issue, its history, the plan token
 * and the operation ledger untouched.
 */
export async function residualCloseExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<ResidualCloseOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "residual-close");
  const operation = resolved.call.operation;
  assertExactKeys(
    operation as unknown as Record<string, unknown>,
    ["kind", "issueId", "disposition", "evidence", "expectedIssueRevision"],
    "residual-close operation",
  );
  if (!isNonEmptyString(operation.issueId)) {
    throw invalidPlanInput("residual-close requires a non-empty issueId");
  }
  if (!Number.isInteger(operation.expectedIssueRevision) || operation.expectedIssueRevision < 0) {
    throw invalidPlanInput(
      `expectedIssueRevision must be a nonnegative integer \u2014 the issue revision guards the DB mutation; got ${JSON.stringify(operation.expectedIssueRevision)}`,
    );
  }
  assertTerminalDisposition(operation.disposition);
  assertClosureAuthority(operation.disposition, operation.evidence);
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  const actor = issueWriteSeat(context.caller.role);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx) => {
    assertResidualAdmission(witness, tx);
    assertIssueLinkedToPlanOn(tx.db, operation.issueId, witness.planId);
    closeIssueOn(
      tx.db,
      operation.issueId,
      operation.disposition,
      operation.evidence,
      {
        operationId: residualCloseOperationId(witness.session.sessionId, witness.planId, operation.issueId),
        actor,
        expectedRevision: operation.expectedIssueRevision,
      },
      // §3.1 the frame's single advance of the shared store revision has already
      // run: this closure joins it rather than advancing the counter again.
      { committedStoreRevision: storeRevisionOn(tx.db) },
    );
    advancePlanRowRevision(tx, witness);
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/* ------------------------------------------------------------------------ *
 * §D/§E the lifecycle transitions: handoff, accept, return, integration and
 * completion, plus the crash-recovery `reconcile`
 * ------------------------------------------------------------------------ */

type HandoffOperation = Extract<CoordinationOperation, { kind: "handoff" }>;
type AcceptOperation = Extract<CoordinationOperation, { kind: "accept" }>;
type ReturnOperation = Extract<CoordinationOperation, { kind: "return" }>;
type IntegrationStartOperation = Extract<CoordinationOperation, { kind: "integration-start" }>;
type IntegrationAcceptOperation = Extract<CoordinationOperation, { kind: "integration-accept" }>;
type CompleteOperation = Extract<CoordinationOperation, { kind: "complete" }>;
type ReconcileOperation = Extract<CoordinationOperation, { kind: "reconcile" }>;

/**
 * §D/§E one plan's own scope as the addressed ROW records it: the plan worktree
 * and branch an authorized `prepare` sealed into `metadata`. The DB route has no
 * resolved file scope — the row IS the scope — so every Git proof below is taken
 * against what this plan recorded, never against a caller-supplied path.
 */
type PlanScope = { worktreePath: string; workingBranch: string };

function planScopeOf(view: ExecutionPlanView, planId: string): PlanScope {
  const metadata = isPlainObject((view.plan as Record<string, unknown>).metadata)
    ? ((view.plan as Record<string, unknown>).metadata as Record<string, unknown>)
    : {};
  const worktree = metadata.worktree_path;
  const branch = metadata.working_branch;
  if (!isNonEmptyString(worktree) || !isAbsolute(worktree) || !isNonEmptyString(branch)) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `plan ${planId} records no plan worktree/branch scope (metadata.worktree_path must be an absolute path and ` +
        `metadata.working_branch a non-empty branch), so its Git evidence cannot be proven`,
      { plan_id: planId, worktree_path: worktree ?? null, working_branch: branch ?? null },
    );
  }
  return { worktreePath: canonicalTarget(worktree), workingBranch: branch };
}

/** The plan's recorded worktree, or `undefined` when the row records none yet. */
function planScopeOrUndefined(view: ExecutionPlanView, planId: string): string | undefined {
  const metadata = isPlainObject((view.plan as Record<string, unknown>).metadata)
    ? ((view.plan as Record<string, unknown>).metadata as Record<string, unknown>)
    : {};
  const worktree = metadata.worktree_path;
  return isNonEmptyString(worktree) && isAbsolute(worktree) ? canonicalTarget(worktree) : undefined;
}

/**
 * §E the workflow snapshot the SHARED pure rules read: the header, the plan rows
 * of the addressed workflow and the merge lease — which this authority stores in
 * `execution_plans` and `execution_integration_leases`, never in the header. One
 * reconstruction, so `isStandaloneDevelopmentWorkflow`, `rowValidationRoute`,
 * the integration anchors and the contamination gate stay the shared rules
 * instead of a DB-only second derivation.
 */
function workflowSnapshotOf(input: {
  state: ExecutionPlanView["workflow"];
  plans: readonly ExecutionPlanView[];
  integrationLease: IntegrationMergeLease | null;
}): WorkflowSnapshot {
  return {
    ...(input.state as unknown as Record<string, unknown>),
    plans: input.plans.map((plan) => plan.plan as unknown as PlanRow),
    ...(input.integrationLease === null ? {} : { integration_merge_lease: input.integrationLease }),
  } as unknown as WorkflowSnapshot;
}

/** The same snapshot for the addressed plan's own transaction witness. */
function witnessSnapshot(witness: ExecutionPlanWitness): WorkflowSnapshot {
  return workflowSnapshotOf({
    state: witness.view.workflow,
    plans: [witness.view, ...witness.siblings],
    integrationLease: witness.view.integrationLease,
  });
}

/**
 * §E the workflow snapshot of one addressed plan, read BEFORE SQLite ownership:
 * the same projection from `readExecutionState`, which is how the pre-transaction
 * Git proofs and the route decision see the plan rows and the merge lease.
 */
async function readWorkflowSnapshot(context: ExecutionContext, workflowId: string): Promise<WorkflowSnapshot> {
  const state = await readExecutionState(context);
  const workflow = state.data.workflows.find((candidate) => candidate.state.id === workflowId);
  if (workflow === undefined) {
    throw new CoordinationError("coordination.plan-not-found", `no workflow ${workflowId} is registered`, {
      workflow_id: workflowId,
    });
  }
  return workflowSnapshotOf({
    state: workflow.state,
    plans: workflow.plans,
    integrationLease: workflow.integrationLease,
  });
}

/** The addressed row's own stored coordination block, or `undefined` when it carries none. */
function coordinationOf(witness: ExecutionPlanWitness): RowCoordination | undefined {
  return (witness.view.coordination ?? undefined) as RowCoordination | undefined;
}

/**
 * §2.2/§R5 the frame one row write runs through. It is exactly the addressed
 * row's own view plus the workflow facts the shared row rules read, so a
 * completion composed by the PLAN route (`complete`/`reconcile`) and one
 * composed by the WORKFLOW route (a terminal close, E10) write through the same
 * rule home instead of a second completion implementation.
 *
 * `releasedBy` is the session the transition acts as: the holder the row's own
 * execution lease is re-asserted against and the author its release records.
 */
export type RowCompletionFrame = {
  workflowId: string;
  planId: string;
  view: ExecutionPlanView;
  state: ExecutionPlanView["workflow"];
  siblings: readonly ExecutionPlanView[];
  integrationLease: IntegrationMergeLease | null;
  /** The addressed row's revision — the value its token carries (§3.1). */
  revision: number;
  sessionBound: boolean;
  releasedBy: string;
};

/** The frame of one plan-route witness: the same facts, read from the row's own transaction. */
function rowFrameOf(witness: ExecutionPlanWitness): RowCompletionFrame {
  return {
    workflowId: witness.workflowId,
    planId: witness.planId,
    view: witness.view,
    state: witness.view.workflow,
    siblings: witness.siblings,
    integrationLease: witness.view.integrationLease,
    revision: witness.revision,
    sessionBound: witness.view.session !== null,
    releasedBy: witness.session.sessionId,
  };
}

/** The workflow snapshot one frame's shared rules read (header + rows + merge lease). */
function frameSnapshot(frame: RowCompletionFrame): WorkflowSnapshot {
  return workflowSnapshotOf({
    state: frame.state,
    plans: [frame.view, ...frame.siblings],
    integrationLease: frame.integrationLease,
  });
}

/**
 * §2.2/§D write the addressed plan's coordination block back in ONE statement
 * that also advances the plan row's revision — the plan token this operation
 * spends its own on. The block is validated by the SHARED rules first, with the
 * DB route's own session fact (the plan's session row) standing in for the
 * `coordination.session` binding this authority never stores.
 */
function writeCoordinationBlock(
  tx: ExecutionTransaction,
  witness: ExecutionPlanWitness,
  input: { block: Record<string, unknown>; state?: Record<string, unknown>; what: string },
): void {
  writeCoordinationFrame(tx, rowFrameOf(witness), input);
}

/** The same write for any frame: the shared implementation both routes call. */
function writeCoordinationFrame(
  tx: ExecutionTransaction,
  frame: RowCompletionFrame,
  input: { block: Record<string, unknown>; state?: Record<string, unknown>; what: string },
): void {
  const route = rowValidationRoute(frameSnapshot(frame), frame.view.plan as unknown as PlanRow);
  const violations = storedCoordinationViolations(input.block, {
    revision: frame.revision + 1,
    route,
    sessionBound: frame.sessionBound,
    what: input.what,
  });
  assertViolationFree(violations, input.what);
  writePlanCoordinationRow(tx, {
    workflowId: frame.workflowId,
    planId: frame.planId,
    state: input.state ?? (frame.view.plan as unknown as Record<string, unknown>),
    coordination: input.block,
    revision: frame.revision + 1,
  });
}

/**
 * §D/§E the plan's execution lease moved to another holder (spec §D `accept`,
 * and `return` moving it back). The lease must be HELD by `from`: an absent,
 * released or foreign lease is a refusal, never a silent no-op that leaves the
 * row owned by nobody or by the wrong session. Ownership is the lease's own
 * identity — the DB route moves the row, it never re-claims or steals it.
 */
function transferPlanLease(
  tx: ExecutionTransaction,
  witness: ExecutionPlanWitness,
  input: { from: string; to: { sessionId: string; role: "coordinator" | "plan-pm" }; what: string; now: string },
): void {
  const row = planRowOf(witness.view);
  assertExecutionHolder(row, input.from, witness.planId, input.what);
  transferExecutionLease(tx, {
    workflowId: witness.workflowId,
    planId: witness.planId,
    lease: requireExecutionLease(row, witness.planId, input.what),
    to: input.to,
    now: input.now,
  });
}

/**
 * §E/§4.2 the workflow's merge-lease admission for ONE attempt, in the FILE
 * route's own order (`coordination.ts` `assertMergeLease`): the HOLDER decides
 * first — a claim held by another session is that session's claim, whoever it
 * names — and only a claim THIS session holds is judged against this attempt's
 * plan and source branch. The three cases are never collapsed:
 *
 * - a LIVE foreign holder refuses `coordination.session-mismatch`: a held claim
 *   is not stealable, and neither an old `claimed_at` nor a stale heartbeat
 *   makes it expirable (§4.2 — clocks authorize nothing);
 * - a holder whose session is not active at this epoch is a STOPPED owner
 *   (§2.3's post-recovery leftover: the lease retains its prior holder and must
 *   pass explicit reconcile). Only `reconcile` acts on it, and it does so by
 *   recording the prior holder and the decision; every other verb refuses;
 * - a claim this session holds for ANOTHER plan or source branch is a foreign
 *   claim — never reused, re-pinned or released by this attempt.
 */
type MergeLeaseDecision =
  | { kind: "unclaimed" }
  | { kind: "own"; lease: IntegrationMergeLease }
  | { kind: "stopped"; lease: IntegrationMergeLease };

function decideMergeLease(
  witness: ExecutionPlanWitness,
  tx: ExecutionTransaction,
  handoff: PlanHandoff,
  what: string,
): MergeLeaseDecision {
  return decideMergeLeaseFor({
    tx,
    workflowId: witness.workflowId,
    planId: witness.planId,
    integrationLease: witness.view.integrationLease,
    sessionId: witness.session.sessionId,
    handoff,
    what,
  });
}

/** The same admission for any frame: the shared implementation both routes call. */
function decideMergeLeaseFor(input: {
  tx: ExecutionTransaction;
  workflowId: string;
  planId: string;
  integrationLease: IntegrationMergeLease | null;
  sessionId: string;
  handoff: PlanHandoff;
  what: string;
}): MergeLeaseDecision {
  const lease = input.integrationLease;
  if (lease === null) return { kind: "unclaimed" };
  if (lease.holder !== input.sessionId) {
    if (readLiveSessionIdentities(input.tx, input.workflowId).has(lease.holder)) {
      throw new CoordinationError(
        "coordination.session-mismatch",
        `plan ${input.planId} integration is held by ${lease.holder}, not ${input.sessionId}`,
        { plan_id: input.planId, holder: lease.holder, session_id: input.sessionId, operation: input.what },
      );
    }
    return { kind: "stopped", lease };
  }
  if (mergeLeaseOfAttempt(lease, input.planId, input.handoff.source_branch) === undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${input.planId} merge lease claims plan ${lease.plan_id} source ${lease.source_branch}, not this attempt ` +
        `(${input.planId} source ${input.handoff.source_branch}) \u2014 a foreign claim is never reused or released`,
      {
        plan_id: input.planId,
        holder_plan_id: lease.plan_id,
        holder_source_branch: lease.source_branch,
        source_branch: input.handoff.source_branch,
        operation: input.what,
      },
    );
  }
  return { kind: "own", lease };
}

/**
 * §E the merge-lease admission every transition except `reconcile` runs: this
 * attempt's own claim, or none. A stopped owner refuses here — the refusal names
 * `reconcile` as the transition that may act on it, so no lifecycle step takes
 * over a dead coordinator's claim by accident.
 */
function assertMergeLeaseOwn(
  witness: ExecutionPlanWitness,
  tx: ExecutionTransaction,
  handoff: PlanHandoff,
  what: string,
): void {
  assertMergeLeaseOwnForFrame(rowFrameOf(witness), tx, handoff, what);
}

/** The same admission for any frame: the shared implementation both routes call. */
function assertMergeLeaseOwnForFrame(
  frame: RowCompletionFrame,
  tx: ExecutionTransaction,
  handoff: PlanHandoff,
  what: string,
): void {
  const decision = decideMergeLeaseFor({
    tx,
    workflowId: frame.workflowId,
    planId: frame.planId,
    integrationLease: frame.integrationLease,
    sessionId: frame.releasedBy,
    handoff,
    what,
  });
  if (decision.kind === "stopped") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${frame.planId} merge lease is held by ${decision.lease.holder}, whose session is no longer active \u2014 ${what} does ` +
        `not take over a stopped owner; reconcile records the prior holder and the decision`,
      { plan_id: frame.planId, holder: decision.lease.holder, operation: what },
    );
  }
}

/**
 * §D/§E the findings cleanup gate of one prepared plan (spec §D/§E): handoff and
 * completion both demand it, so a plan returned for rework cannot complete while
 * the findings it was told to close are still open. The gate consumes the
 * authoritative open issues linked to the plan — never a legacy register — and
 * fails closed: a missing, corrupt or staged store refuses the lifecycle step
 * instead of reading as "no findings".
 *
 * It opens its own read handle, so it runs BEFORE this call takes SQLite
 * ownership (§4.1: no second connection inside the write transaction).
 */
async function assertFindingsClosed(
  context: ExecutionContext,
  planId: string,
  prepared: PreparedCoordination,
  what: string,
): Promise<void> {
  let gate;
  try {
    gate = await findingsCleanupGate({ harnessDir: context.harnessDir }, planId, {
      mode: prepared.findings_cleanup === "zero-residual" ? "zero-residual" : "allow-residual",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CoordinationError(
      "coordination.store",
      `plan ${planId} cannot ${what}: the issue store is unavailable and findings authority cannot be read \u2014 ${message}`,
      { plan_id: planId, findings_cleanup: prepared.findings_cleanup },
    );
  }
  if (!gate.ok) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${planId} cannot ${what} while findings are open (${prepared.findings_cleanup}): ${summarize(gate.violations)}`,
      { plan_id: planId, findings_cleanup: prepared.findings_cleanup },
    );
  }
}

/**
 * §D/§E the prepared Assignment of one lifecycle transition, or a refusal. The
 * block is the DURABLE fact this route reads; the Assignment's freshness is the
 * row admission's (`assertPlanOwnedWrite` for the plan's own verbs) and the QA
 * gate below is compared against the sealed `qa_gate`.
 */
function requirePrepared(coordination: RowCoordination | undefined, planId: string, what: string): PreparedCoordination {
  const prepared = coordination?.prepared;
  if (prepared === undefined) {
    throw new CoordinationError("coordination.not-prepared", `plan ${planId} is not prepared in this workflow \u2014 ${what} requires a prepared Assignment`, {
      plan_id: planId,
    });
  }
  return prepared;
}

/** §D the handoff's QA gate must be the Assignment's own (spec §D/§E). */
function assertHandoffQaGate(handoff: { qa: { gate: string } }, prepared: PreparedCoordination, planId: string, what: string): void {
  if (handoff.qa.gate !== prepared.qa_gate) {
    throw new CoordinationError(
      "coordination.assignment-stale",
      `${what} qa.gate ${handoff.qa.gate} is not the Assignment's QA gate ${prepared.qa_gate}`,
      { plan_id: planId, expected: prepared.qa_gate, actual: handoff.qa.gate },
    );
  }
}

/**
 * §3 `handoff` on the DB authority: the plan session that HOLDS the plan's
 * execution lease seals the reviewed evidence of its own plan, in one
 * transaction whose CAS is the plan's own token.
 *
 * The evidence paths, their digests and the Git proof are read BEFORE SQLite
 * ownership; the seal, the Assignment's QA gate, the findings gate, the plan's
 * session and lease and the plan revision commit inside it, and the evidence is
 * re-hashed immediately before the commit so an edit in that window refuses
 * (`coordination.evidence-stale`) instead of being sealed. The execution lease
 * stays with the plan session: handoff is not release.
 */
export async function handoffExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<HandoffOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "handoff");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "evidence"], "handoff operation");
  const evidence = readHandoffEvidence(operation.evidence);
  const { planId } = resolved.read;
  assertEvidenceInsidePlanArea(planAreaRoots(controlHarnessRoot(context), planId), evidence.evidence_paths);
  const before = await readExecutionPlan(context, request.session, planId);
  const prepared = requirePrepared(before.data.coordination ?? undefined, planId, "handoff");
  assertHandoffQaGate({ qa: { gate: evidence.qa_gate } }, prepared, planId, "handoff");
  // §R5 the entailed predecessor recording is decided BEFORE SQLite ownership
  // and re-decided inside it: the row must be able to record InReview (already
  // recorded, or InProgress under this session's own claim), and nothing is
  // recorded here — the preflight only refuses an unclaimed row early.
  entailedHandoffStatus(before.data.plan as unknown as PlanRow, planId);
  assertHandoffGitProof(planScopeOf(before.data, planId).worktreePath, evidence, "handoff", planId);
  await assertFindingsClosed(context, planId, prepared, "hand off");
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    assertPlanOwnedWrite(witness, "handoff");
    const coordination = coordinationOf(witness);
    const sealed = requirePrepared(coordination, planId, "handoff");
    assertHandoffQaGate({ qa: { gate: evidence.qa_gate } }, sealed, planId, "handoff");
    const entailed = entailedHandoffStatus(witness.view.plan as unknown as PlanRow, planId);
    // §4.1 the reviewed bytes are re-read immediately before the commit.
    assertHandoffEvidenceUnchanged(evidence, "handoff");
    const previous = coordination?.handoff;
    const record: PlanHandoff = {
      id: randomUUID(),
      attempt: previous === undefined ? 1 : previous.attempt + 1,
      state: "submitted",
      submitted_by: witness.session.sessionId,
      submitted_at: at,
      source_branch: planScopeOf(witness.view, planId).workingBranch,
      source_sha: evidence.source_sha,
      worktree_path: planScopeOf(witness.view, planId).worktreePath,
      review_base: evidence.review_base,
      review_head: evidence.review_head,
      qc: {
        decision: evidence.qc_decision,
        reports: evidence.qc_reports,
        consolidated: evidence.qc_consolidated,
      },
      qa: { gate: evidence.qa_gate, decision: "pass", report: evidence.qa_report },
    };
    writeCoordinationBlock(tx, witness, {
      block: { ...storedCoordinationOf(witness.view), handoff: record },
      // §R5 the entailed recording commits with the seal, in this one statement:
      // the row's InReview report and the handoff are one transition, one
      // revision, and a row that already recorded InReview writes no status at
      // all (A01).
      ...(entailed === null
        ? {}
        : { state: { ...(witness.view.plan as unknown as Record<string, unknown>), status: entailed } }),
      what: `plan ${planId} coordination`,
    });
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/**
 * §3 `accept` on the DB authority: the workflow's coordinator takes the
 * submitted handoff and the plan's execution lease in ONE transaction — the
 * attempt's evidence is re-hashed, the feature checkout is re-proven and the
 * lease moves to the coordinator, while the row stays InReview because the
 * integration attempt has not happened yet.
 */
export async function acceptExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<AcceptOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "accept");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "handoffId"], "accept operation");
  if (!isNonEmptyString(operation.handoffId)) throw invalidPlanInput("accept requires the non-empty handoffId it names");
  const { planId } = resolved.read;
  const before = await readExecutionPlan(context, request.session, planId);
  const named = requirePlanHandoff(before.data.coordination ?? undefined, planId, operation.handoffId);
  requireHandoffState(named, ["submitted"], planId, "accept");
  assertFeatureCheckout(planScopeOf(before.data, planId).worktreePath, named.source_sha, "accept", planId);
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    const handoff = requirePlanHandoff(coordinationOf(witness), planId, operation.handoffId);
    requireHandoffState(handoff, ["submitted"], planId, "accept");
    requireRowStatus(witness.view.plan as unknown as PlanRow, "InReview", planId, "accept", { still: true });
    assertEvidenceDigests(handoff);
    transferPlanLease(tx, witness, {
      from: handoff.submitted_by,
      to: { sessionId: witness.session.sessionId, role: "coordinator" },
      what: "accept",
      now: at,
    });
    writeCoordinationBlock(tx, witness, {
      block: {
        ...storedCoordinationOf(witness.view),
        handoff: { ...handoff, state: "accepted", accepted_by: witness.session.sessionId, accepted_at: at },
      },
      what: `plan ${planId} coordination`,
    });
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/**
 * §3 `return` on the DB authority: the coordinator sends an attempt back, and
 * the lease follows the record — a return of a `submitted` handoff only proves
 * the plan session still holds its own lease, while a return of an `accepted`
 * one moves it back, because accept is what moved it away. The row becomes
 * InProgress again: the plan is being worked on.
 */
export async function returnExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<ReturnOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "return");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "handoffId", "reason"], "return operation");
  if (!isNonEmptyString(operation.handoffId)) throw invalidPlanInput("return requires the non-empty handoffId it names");
  if (!isNonEmptyString(operation.reason)) throw invalidPlanInput("return requires the reason the attempt is sent back");
  const { planId } = resolved.read;
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    const handoff = requirePlanHandoff(coordinationOf(witness), planId, operation.handoffId);
    requireHandoffState(handoff, ["submitted", "accepted"], planId, "return");
    const plan = witness.view.plan as unknown as PlanRow;
    if (handoff.state === "accepted") {
      // The receiving holder must be the plan's ACTIVE plan-pm session: moving
      // the lease onto a session the store no longer holds would leave the row
      // owned by nobody and the lease unreadable.
      if (witness.view.session === null || witness.view.session.sessionId !== handoff.submitted_by) {
        throw new CoordinationError(
          "coordination.session-mismatch",
          `return requires plan ${planId}'s handoff submitter ${handoff.submitted_by} to be the plan's active plan-pm session \u2014 ` +
            `it is ${witness.view.session === null ? "unbound" : witness.view.session.sessionId}`,
          { plan_id: planId, expected: handoff.submitted_by, actual: witness.view.session?.sessionId ?? null },
        );
      }
      transferPlanLease(tx, witness, {
        from: witness.session.sessionId,
        to: { sessionId: handoff.submitted_by, role: "plan-pm" },
        what: "return",
        now: at,
      });
    } else {
      assertExecutionHolder(planRowOf(witness.view), handoff.submitted_by, planId, "return");
    }
    writeCoordinationBlock(tx, witness, {
      block: {
        ...storedCoordinationOf(witness.view),
        handoff: { ...handoff, state: "returned", returned_at: at, return_reason: operation.reason },
      },
      state: { ...(witness.view.plan as unknown as Record<string, unknown>), status: "InProgress" },
      what: `plan ${planId} coordination`,
    });
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/**
 * §3 `integration-start` on the DB authority: claim the workflow's merge lease,
 * record the attempt base and the source pin BEFORE any Git runs, and keep the
 * row InReview with the coordinator's execution ownership.
 *
 * The recorded base is the integration HEAD this call OBSERVED before it took
 * SQLite ownership (§4.1: Git evidence attests the observed instant; the claim's
 * exclusivity, not SQL, is what keeps one attempt at a time). A retry of an
 * already started attempt re-verifies every pin and re-pins nothing.
 */
export async function integrationStartExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<IntegrationStartOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "integration-start");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "handoffId"], "integration-start operation");
  if (!isNonEmptyString(operation.handoffId)) {
    throw invalidPlanInput("integration-start requires the non-empty handoffId it names");
  }
  const { planId } = resolved.read;
  const before = await readExecutionPlan(context, request.session, planId);
  const named = requirePlanHandoff(before.data.coordination ?? undefined, planId, operation.handoffId);
  requireHandoffState(named, ["accepted", "integrating"], planId, "integration-start");
  assertEvidenceDigests(named);
  assertFeatureCheckout(planScopeOf(before.data, planId).worktreePath, named.source_sha, "integration-start", planId);
  const anchors = integrationAnchors(before.data.workflow as unknown as WorkflowSnapshot, planId);
  const checkout = assertIntegrationCheckout(anchors, planId);
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    const handoff = requirePlanHandoff(coordinationOf(witness), planId, operation.handoffId);
    requireHandoffState(handoff, ["accepted", "integrating"], planId, "integration-start");
    assertEvidenceDigests(handoff);
    assertExecutionHolder(planRowOf(witness.view), witness.session.sessionId, planId, "integration-start");
    assertMergeLeaseOwn(witness, tx, handoff, "integration-start");
    if (handoff.state === "integrating") {
      // A started attempt is never re-pinned: the recorded base stays the one
      // the coordinator merged onto, so the row's domain state is unchanged —
      // and the accepted operation still spends its own plan revision, so the
      // token it returns is the post-advance CAS (§3.1).
      advancePlanRowRevision(tx, witness);
      const settled = readExecutionPlanWitness(tx, resolved.read);
      return { data: settled.view, token: settled.token, storeId: tx.storeId, epoch: tx.epoch };
    }
    const claim: IntegrationMergeLease = {
      holder: witness.session.sessionId,
      claimed_at: at,
      plan_id: planId,
      source_branch: handoff.source_branch,
      target_branch: anchors.targetBranch,
    };
    claimIntegrationMergeLease(tx, { workflowId: witness.workflowId, lease: claim });
    writeCoordinationBlock(tx, witness, {
      block: {
        ...storedCoordinationOf(witness.view),
        handoff: {
          ...handoff,
          state: "integrating",
          integration: {
            target_branch: anchors.targetBranch,
            worktree_path: anchors.worktreePath,
            base_sha: checkout.head,
            started_at: at,
          },
        },
      },
      what: `plan ${planId} coordination`,
    });
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/**
 * §3 `integration-accept` on the DB authority: prove the merge from the pinned
 * objects, record the observed result, and keep BOTH leases and InReview until
 * complete. Nothing is proven by the branch merely existing.
 *
 * The proof is taken against the integration checkout this call observed before
 * SQLite ownership; the recorded base, the source and the result are the pinned
 * objects, so a moved branch that no longer reaches the merge diverges instead
 * of being accepted.
 */
export async function integrationAcceptExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<IntegrationAcceptOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "integration-accept");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "handoffId"], "integration-accept operation");
  if (!isNonEmptyString(operation.handoffId)) {
    throw invalidPlanInput("integration-accept requires the non-empty handoffId it names");
  }
  const { planId } = resolved.read;
  const before = await readExecutionPlan(context, request.session, planId);
  const named = requirePlanHandoff(before.data.coordination ?? undefined, planId, operation.handoffId);
  requireHandoffState(named, ["integrating"], planId, "integration-accept");
  assertEvidenceDigests(named);
  const attempt = requireIntegration(named, planId);
  const anchors = integrationAnchors(before.data.workflow as unknown as WorkflowSnapshot, planId);
  const checkout = assertIntegrationCheckout(anchors, planId);
  const proof = integrationProof(anchors.worktreePath, checkout.head, attempt.base_sha, named.source_sha);
  if (proof.kind === "diverged") {
    throw integrationDiverged(`plan ${planId} integration cannot be proven \u2014 ${proof.reason}`, {
      plan_id: planId,
      base: attempt.base_sha,
      source: named.source_sha,
    });
  }
  if (proof.kind === "pending") {
    throw integrationUnresolved(
      `plan ${planId} integration shows no merge of ${named.source_sha} onto ${attempt.base_sha} yet \u2014 run the coordinator merge, then accept`,
      { plan_id: planId, base: attempt.base_sha, source: named.source_sha },
    );
  }
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    const handoff = requirePlanHandoff(coordinationOf(witness), planId, operation.handoffId);
    requireHandoffState(handoff, ["integrating"], planId, "integration-accept");
    requireRowStatus(witness.view.plan as unknown as PlanRow, "InReview", planId, "integration-accept", { still: true });
    assertEvidenceDigests(handoff);
    assertExecutionHolder(planRowOf(witness.view), witness.session.sessionId, planId, "integration-accept");
    assertMergeLeaseOwn(witness, tx, handoff, "integration-accept");
    const recorded = requireIntegration(handoff, planId);
    writeCoordinationBlock(tx, witness, {
      block: {
        ...storedCoordinationOf(witness.view),
        handoff: {
          ...handoff,
          state: "merged",
          integration: { ...recorded, result_sha: proof.resultSha, verified_at: at },
        },
      },
      what: `plan ${planId} coordination`,
    });
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/**
 * §E the delivery identity of one standalone completion: the handoff, the row's
 * recorded scope and the plan's execution lease all name the SAME delivery
 * source branch and worktree, and that branch is the workflow's registered
 * source. The file route compares a resolved scope; this route compares the
 * same three facts from the row, the lease table and the sealed handoff.
 */
function assertStandaloneBranchIdentity(
  view: ExecutionPlanView,
  planId: string,
  handoff: PlanHandoff,
  anchors: { source: string; target: string },
  what: string,
  requireLease = true,
): void {
  const scope = planScopeOf(view, planId);
  const metadata = isPlainObject((view.plan as Record<string, unknown>).metadata)
    ? ((view.plan as Record<string, unknown>).metadata as Record<string, unknown>)
    : {};
  if (handoff.source_branch !== anchors.source) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `${what} requires handoff.source_branch ${handoff.source_branch} to equal the registered delivery source ${anchors.source}`,
      { plan_id: planId, expected: anchors.source, actual: handoff.source_branch },
    );
  }
  if (requireLease) {
    const lease = requireExecutionLease(planRowOf(view), planId, what);
    if (scope.workingBranch !== anchors.source) {
      throw new CoordinationError(
        "coordination.scope-mismatch",
        `${what} requires the prepared working branch ${scope.workingBranch} to equal the registered delivery source ${anchors.source}`,
        { plan_id: planId, expected: anchors.source, actual: scope.workingBranch },
      );
    }
    if (lease.working_branch !== anchors.source) {
      throw new CoordinationError(
        "coordination.scope-mismatch",
        `${what} requires the execution lease working branch ${lease.working_branch} to equal the registered delivery source ${anchors.source}`,
        { plan_id: planId, expected: anchors.source, actual: lease.working_branch },
      );
    }
    if (canonicalTarget(String(lease.worktree_path)) !== scope.worktreePath) {
      throw new CoordinationError(
        "coordination.path-mismatch",
        `${what} requires the execution lease worktree ${String(lease.worktree_path)} to equal the plan scope ${scope.worktreePath}`,
        { plan_id: planId, expected: scope.worktreePath, actual: lease.worktree_path },
      );
    }
  }
  if (canonicalTarget(handoff.worktree_path) !== scope.worktreePath) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `${what} requires the handoff worktree ${handoff.worktree_path} to equal the plan scope ${scope.worktreePath}`,
      { plan_id: planId, expected: scope.worktreePath, actual: handoff.worktree_path },
    );
  }
  if (isNonEmptyString(metadata.working_branch) && metadata.working_branch !== anchors.source) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `${what} requires row metadata.working_branch to equal the registered delivery source ${anchors.source}`,
      { plan_id: planId, expected: anchors.source, actual: metadata.working_branch },
    );
  }
  if (
    isNonEmptyString(metadata.worktree_path) &&
    canonicalTarget(String(metadata.worktree_path)) !== scope.worktreePath
  ) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `${what} requires row metadata.worktree_path to equal the plan scope ${scope.worktreePath}`,
      { plan_id: planId, expected: scope.worktreePath, actual: metadata.worktree_path },
    );
  }
}

function assertReportOnlyCompletionEvidence(snapshot: WorkflowSnapshot, planId: string, what: string): void {
  const failure = consultDeliveryEvidence(snapshot).find((entry) => !entry.ok);
  if (failure !== undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires matching report-only completion evidence for ${planId}: ${failure.message}`,
      { plan_id: planId, code: failure.code },
    );
  }
}

/** §E the delivery route one workflow snapshot declares, as the shared classifiers read it. */
export type DeliveryRoute = "report-only" | "development" | "integration";

export function deliveryRouteOf(snapshot: WorkflowSnapshot): DeliveryRoute {
  if (isStandaloneReportOnlyWorkflow(snapshot)) return "report-only";
  if (isStandaloneDevelopmentWorkflow(snapshot)) return "development";
  return "integration";
}

/** §4.1 the route/policy pair a transition proved BEFORE its transaction pinned. */
export type DeliveryRoutePin = { route: DeliveryRoute; completionPolicy: string | undefined };

/** The pair one snapshot declares, as a caller pins it before taking ownership. */
export function deliveryRoutePin(snapshot: WorkflowSnapshot): DeliveryRoutePin {
  return { route: deliveryRouteOf(snapshot), completionPolicy: snapshot.completion_policy };
}

/**
 * §4.1 the delivery route and registered completion policy a transition proved
 * BEFORE SQLite ownership must still be the ones the transaction commits
 * against. The plan's CAS guards the ROW; it cannot guard the workflow header,
 * whose revision a workflow-level transition advances — so a completion that
 * pinned report-only evidence refuses when the header moved to another route or
 * re-registered another policy in the window, instead of judging the changed
 * pair against itself.
 */
function requirePinnedDeliveryRoute(
  snapshot: WorkflowSnapshot,
  pinned: DeliveryRoutePin,
  planId: string,
  what: string,
): void {
  const route = deliveryRouteOf(snapshot);
  if (route !== pinned.route) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires plan ${planId} to keep the ${pinned.route} delivery route proven before the transaction \u2014 the workflow now declares ${route}`,
      { plan_id: planId, expected: pinned.route, actual: route },
    );
  }
  if (route === "report-only" && snapshot.completion_policy !== pinned.completionPolicy) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires plan ${planId} to keep the completion policy pinned before the transaction \u2014 recorded ` +
        `${JSON.stringify(snapshot.completion_policy)}, pinned ${JSON.stringify(pinned.completionPolicy)}`,
      { plan_id: planId, expected: pinned.completionPolicy, actual: snapshot.completion_policy },
    );
  }
}

/**
 * §E the stored invariants and pinned digests of an already completed standalone
 * plan (spec §E): a COMPLETED handoff on a `Done` row with no lease and no merge
 * lease, whose recorded QC/QA bytes are still the ones its verdicts were sealed
 * against. Everything here is stored state or a file read and nothing launches a
 * process, so the reconcile transaction can re-run it at the commit boundary
 * (§4.1). Read-only: replay resurrects no ownership and rewrites no timestamp.
 *
 * The state is required HERE and not only by the caller's classification: the
 * stored handoff a replay is applied to is read again inside the transaction,
 * and a coordination block rewritten into an accepted/merged state without a
 * revision change would otherwise be replayed as if it were the completion the
 * decision was made for.
 */
function assertCompletedReplayInvariants(
  view: ExecutionPlanView,
  snapshot: WorkflowSnapshot,
  planId: string,
  handoff: PlanHandoff,
  options: { what?: string; fulfilment?: "required" | "pending" } = {},
): void {
  const what = options.what ?? "reconcile";
  requireHandoffState(handoff, ["completed"], planId, what);
  const plan = planRowOf(view);
  if (rowStatusOf(plan) !== "Done") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires ${planId} to be Done for a standalone completed replay`,
      { plan_id: planId, status: plan.status },
    );
  }
  if (plan.execution_lease !== undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires no execution lease on ${planId} for a standalone completed replay`,
      { plan_id: planId },
    );
  }
  if (snapshot.integration_merge_lease !== undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires no integration merge lease for a standalone completed replay of ${planId}`,
      { plan_id: planId },
    );
  }
  assertNoIntegrationContamination({ snapshot, planId, handoff, what });
  const route = rowValidationRoute(snapshot, plan as unknown as PlanRow);
  assertViolationFree(
    storedCoordinationViolations(
      { ...(view.coordination ?? {}) } as Record<string, unknown>,
      { revision: view.coordination?.revision ?? 0, route, sessionBound: view.session !== null, what: `plan ${planId} coordination` },
    ),
    `plan ${planId} coordination`,
  );
  assertEvidenceDigests(handoff);
  if (isStandaloneReportOnlyWorkflow(snapshot)) {
    // §R10 the ONE caller that does not require the recorded fulfilment here is
    // a CLOSE repairing that very projection: the report-only completion is
    // otherwise complete, and the close records the outstanding fulfilment in
    // the same transaction rather than being refused by the state it repairs.
    if (options.fulfilment !== "pending") assertReportOnlyCompletionEvidence(snapshot, planId, what);
    return;
  }
  const anchors = standaloneDeliveryAnchors(snapshot, planId);
  assertStandaloneBranchIdentity(view, planId, handoff, anchors, what, false);
}

/**
 * §E the preflight half of that replay: the same invariants plus the one read
 * that needs a Git process — the pinned source still being an object of a
 * readable repository. A report-only plan owns no delivery source, so its
 * replay is the invariants alone and stays process-free.
 */
function assertStandaloneCompletedReplay(
  view: ExecutionPlanView,
  snapshot: WorkflowSnapshot,
  planId: string,
  handoff: PlanHandoff,
  harnessRoot: string,
): void {
  assertCompletedReplayInvariants(view, snapshot, planId, handoff);
  if (isStandaloneReportOnlyWorkflow(snapshot)) return;
  const repository = proofRepository([handoff.worktree_path, planScopeOrUndefined(view, planId), harnessRoot]);
  if (repository !== undefined && !gitObjectExists(repository, handoff.source_sha)) {
    throw gitProof(`reconcile cannot re-verify the pinned standalone source ${handoff.source_sha} for plan ${planId}`, {
      plan_id: planId,
      source_sha: handoff.source_sha,
    });
  }
}

/**
 * §E the completion delta shared by `complete` and a proven `reconcile`: `Done`,
 * the retained branch/worktree metadata and `track_branches`, the completed
 * handoff, and the release of this plan's execution lease and of this attempt's
 * own merge lease — in the SAME transaction, because a half-applied completion
 * is exactly the state a crash must never leave.
 *
 * No registry or catalog row is deleted or rewritten here: the plan stays a
 * member of its workflow (its own terminal close is the workflow transition's,
 * W6), and completion only changes membership in the PLAN's lifecycle.
 */
function applyCompletion(input: {
  tx: ExecutionTransaction;
  witness: ExecutionPlanWitness;
  planId: string;
  handoff: PlanHandoff;
  at: string;
  resultSha: string | null;
  what: string;
}): void {
  applyCompletionFrame({
    tx: input.tx,
    frame: rowFrameOf(input.witness),
    handoff: input.handoff,
    at: input.at,
    resultSha: input.resultSha,
    what: input.what,
  });
}

/** The same delta for any frame: the shared implementation both routes call. */
function applyCompletionFrame(input: {
  tx: ExecutionTransaction;
  frame: RowCompletionFrame;
  handoff: PlanHandoff;
  at: string;
  resultSha: string | null;
  what: string;
}): void {
  const { tx, frame, handoff, at, what } = input;
  const plan = frame.view.plan as unknown as Record<string, unknown>;
  const metadata = { ...(isPlainObject(plan.metadata) ? plan.metadata : {}) };
  // The retained metadata is what authorizes cleanup afterwards: the leases
  // release, the scope record does not.
  metadata.working_branch = handoff.source_branch;
  metadata.worktree_path = handoff.worktree_path;
  const integration = handoff.integration;
  const completed: PlanHandoff = {
    ...handoff,
    state: "completed",
    completed_at: at,
    ...(input.resultSha === null || integration === undefined
      ? {}
      : { integration: { ...integration, result_sha: input.resultSha, verified_at: at } }),
  };
  writeCoordinationFrame(tx, frame, {
    block: { ...storedCoordinationOf(frame.view), handoff: completed },
    state: { ...plan, status: "Done", metadata },
    what,
  });
  releaseExecutionLease(tx, {
    workflowId: frame.workflowId,
    planId: frame.planId,
    lease: requireExecutionLease(planRowOf(frame.view), frame.planId, what),
    releasedBy: frame.releasedBy,
    reason: what,
    now: at,
  });
  // Only this attempt's own claim is released: a lease naming another plan or
  // another source branch is not this completion's to drop (spec §E).
  const claim = mergeLeaseOfAttempt(frame.integrationLease, frame.planId, handoff.source_branch);
  if (claim !== undefined) {
    releaseIntegrationMergeLease(tx, {
      workflowId: frame.workflowId,
      claim,
      releasedBy: frame.releasedBy,
      reason: what,
      now: at,
    });
  }
}

/* ------------------------------------------------------------------------ *
 * §R11/A21 the owned-claim cleanup of a failed/stopped close
 * ------------------------------------------------------------------------ */

/**
 * §R11/A21 the execution-lease half of one failed/stopped close's cleanup:
 * every HELD execution lease of ONE workflow whose holder ownership identity is
 * not active at this epoch is released as a retained tombstone that records the
 * stopped owner. Two rules are the whole rule:
 *
 * - OWNED means this workflow's own `execution_leases` rows; a claim of another
 *   workflow is not reachable here at all;
 * - a LIVE holder's claim is never released. Liveness is the holder's own
 *   session row at this epoch — the only evidence a stopped owner is decided by
 *   (§4.2: a stale heartbeat, an old `claimed_at` and a caller's assertion
 *   authorize nothing) — so no close infers another session's stop, and the
 *   terminal decision refuses on exactly the claims this leaves held.
 *
 * It reads the NARROW held-lease view on purpose: this half runs before the
 * close's whole-view witness, and a held lease whose holder stopped is precisely
 * the state that reader refuses (`assertLeaseOwnership` cannot represent it), so
 * settling it first is what makes the terminal outcome reachable instead of
 * forcing an unguarded operation.
 */
export function releaseStoppedExecutionLeases(
  tx: ExecutionTransaction,
  input: { workflowId: string; releasedBy: string; at: string },
): void {
  const holders = holderRowsByRole(tx, input.workflowId);
  for (const held of readHeldExecutionLeases(tx, input.workflowId)) {
    const holder = held.lease.holder_session_id;
    const role = held.lease.holder_role;
    // A held lease whose ownership identity is missing is the same corrupt pair
    // the whole-view reader refuses: it is refused here too, never released as a
    // claim that names nobody.
    if (!isNonEmptyString(holder) || (role !== "coordinator" && role !== "plan-pm")) {
      throw new StoreError(
        "store.corrupt",
        `execution_leases(${input.workflowId},${held.planId}).lease_json is held without the holder session identity and role ` +
          `it must agree with; the execution authority cannot be verified`,
      );
    }
    if (heldLeaseHolderIsLive(tx, holders, role, holder, held.planId)) continue;
    releaseExecutionLease(tx, {
      workflowId: input.workflowId,
      planId: held.planId,
      lease: held.lease,
      releasedBy: input.releasedBy,
      reason: `stopped-owner:${holder}`,
      now: input.at,
    });
  }
}

/**
 * §3.1 the session rows of this workflow by role, ACTIVE or NOT: a holder's stop
 * is one row's own state, so the reader that decides it must see the suspended
 * and revoked rows too — exactly what `readLiveSessionIdentities` cannot serve.
 */
function holderRowsByRole(
  tx: ExecutionTransaction,
  workflowId: string,
): Readonly<Record<"coordinator" | "plan-pm", readonly SessionRow[]>> {
  return {
    coordinator: readWorkflowSessionRows(tx, workflowId, "coordinator"),
    "plan-pm": readWorkflowSessionRows(tx, workflowId, "plan-pm"),
  };
}

/**
 * §3.1/§4.2 whether a held execution lease's OWNERSHIP IDENTITY — the holder
 * role and session id it names, plus the plan a `plan-pm` holder holds — is the
 * ACTIVE session row of this epoch. This is the whole-view reader's own lookup
 * (`assertLeaseOwnership` resolves a holder by role + session + plan
 * association), and a session id alone is not that identity: `execution_sessions`
 * is keyed by `(workflow_id, role, session_id)`, so one session id can carry an
 * ACTIVE `coordinator` row and a stopped `plan-pm` row at the same time. An
 * active row of another role, another plan or another epoch is a DIFFERENT owner:
 * it does not keep a stopped holder's lease held, and leaving that lease held
 * would make the very state this cleanup exists to settle unreadable.
 */
function heldLeaseHolderIsLive(
  tx: ExecutionTransaction,
  rowsByRole: Readonly<Record<"coordinator" | "plan-pm", readonly SessionRow[]>>,
  role: "coordinator" | "plan-pm",
  sessionId: string,
  planId: string,
): boolean {
  return rowsByRole[role].some(
    (row) =>
      row.ref.sessionId === sessionId &&
      row.state === "active" &&
      row.ref.epoch === tx.epoch &&
      (row.ref.planId === null || row.ref.planId === planId),
  );
}

/**
 * §R11/A21 the integration-claim half of the same cleanup, under the same two
 * rules: this workflow's OWN merge claim is released when its holder's session
 * is not active at this epoch, and left exactly where it is when that holder IS
 * live — the terminal decision then refuses on it, because a running holder's
 * claim needs that holder's own stop or transfer. It reports whether the claim
 * was released, which is the caller's cue that the ownership it is about to
 * judge changed.
 *
 * It is read from the caller's own witness rather than the narrow held-lease
 * view: the whole-view reader carries a merge claim whatever its holder's state,
 * so this half settles after that witness exists, in the same transaction. The
 * claim names no holder ROLE (`IntegrationMergeLease` carries a holder and the
 * plan it merges), so the identity this half decides against is the workflow's
 * active session carrying that session id — the strongest identity the record
 * itself has.
 */
export function releaseStoppedMergeClaim(
  tx: ExecutionTransaction,
  input: { workflowId: string; claim: IntegrationMergeLease; releasedBy: string; at: string },
): boolean {
  const holder = input.claim.holder;
  if (readLiveSessionIdentities(tx, input.workflowId).has(holder)) return false;
  releaseIntegrationMergeLease(tx, {
    workflowId: input.workflowId,
    claim: input.claim,
    releasedBy: input.releasedBy,
    reason: `stopped-owner:${holder}`,
    now: input.at,
  });
  return true;
}

/* ------------------------------------------------------------------------ *
 * §R5/§R10 the completion a CLOSE composes for the rows it owns
 * ------------------------------------------------------------------------ */

/**
 * §R5/§R10 one owned row's completion, derived BEFORE a close takes SQLite
 * ownership and re-verified inside it. `fulfilment` is the report-only
 * completion-policy fulfilment the close still has to RECORD (null when the
 * workflow already records it); `completesRow` is false for a row that already
 * records `Done` and only needed that recording; `gitWitness` is the sealed
 * proof the development/integration route re-reads at commit, and `resultSha`
 * is the already-proven merge result the route reuses instead of merging.
 */
export type EntailedRowCompletion = {
  planId: string;
  /** The recorded handoff the composition completes. */
  handoffId: string;
  completesRow: boolean;
  fulfilment: { policy: string; evidence: string } | null;
  gitWitness: GitProofWitness | null;
  resultSha: string | null;
};

/**
 * §1/§R10 whether a report-only workflow still OWES the fulfilment of its
 * registered completion policy: true when nothing is recorded, false when the
 * recorded fulfilment names that policy. A recorded fulfilment of a DIFFERENT
 * policy is a re-pointed completion — the exact state the post-Done freeze
 * refuses — and is refused here rather than accepted as the basis of a Done.
 */
function reportOnlyFulfilmentOutstanding(snapshot: WorkflowSnapshot, planId: string): boolean {
  const policy = snapshot.completion_policy;
  const recorded = isPlainObject(snapshot.delivery) && isPlainObject(snapshot.delivery.completion)
    ? (snapshot.delivery.completion as Record<string, unknown>)
    : undefined;
  if (recorded === undefined) return true;
  if (!isNonEmptyString(policy) || recorded.policy !== policy) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `close cannot complete report-only plan ${planId}: the recorded fulfilment names policy ${JSON.stringify(recorded.policy)} ` +
        `while the lifecycle registers ${JSON.stringify(policy ?? null)} \u2014 a re-pointed completion is never the basis of a Done`,
      { plan_id: planId, recorded: recorded.policy, registered: policy ?? null },
    );
  }
  return false;
}

/**
 * §R5/§R10 the fulfilment of a report-only completion policy, RESOLVED from the
 * facts the workflow already records: the policy it registered at registration
 * (§1) and the acceptance report its accepted decision was recorded against
 * (the handoff's own QA report reference, sealed with its digest). Nothing is
 * invented — a workflow that registered no policy, or recorded a fulfilment of
 * a DIFFERENT policy (a re-pointed completion), is refused with that fact.
 */
function entailedFulfilment(
  snapshot: WorkflowSnapshot,
  planId: string,
  handoff: PlanHandoff,
): { policy: string; evidence: string } | null {
  if (!reportOnlyFulfilmentOutstanding(snapshot, planId)) {
    // Already recorded: the fulfilment is a fact, not a recording this close owes.
    return null;
  }
  const policy = snapshot.completion_policy;
  if (!isNonEmptyString(policy)) {
    throw missingDecision({
      planId,
      what: "close",
      component: "workflow-delivery",
      path: "completion_policy",
      currentFacts: [
        `workflow ${String(snapshot.id)} declares delivery_kind verification/report-only`,
        "no completion_policy is recorded and no fulfilment is recorded",
      ],
      needed:
        `close records report-only plan ${planId}'s fulfilment of the policy the lifecycle declared at registration, and this ` +
        "workflow records no completion_policy \u2014 declare the policy the report is accepted against, then retry",
      availableWork: [
        `read plan ${planId} and its recorded accepted report`,
        "independent operations on other rows, plans and workflows continue",
      ],
    });
  }
  return { policy, evidence: handoff.qa.report.path };
}

/**
 * §R5/§R10 the completion ONE owned row's recorded evidence entails, or `null`
 * when the row records `Done` and the workflow already records everything the
 * terminal close needs. This is the pre-transaction half: every external read
 * (the report-only policy resolution, the findings gate, the development
 * source proof and the integration merge proof) happens here, and the
 * transaction re-verifies what it can (`applyEntailedCompletion`).
 *
 * A row whose handoff is genuinely absent, or which records no completion
 * decision, is refused with E09's §6.2 report — the close names the ONE
 * decision it cannot supply instead of demanding a route's fields (A18).
 */
export async function readEntailedRowCompletion(
  context: ExecutionContext,
  snapshot: WorkflowSnapshot,
  row: ExecutionPlanView,
): Promise<EntailedRowCompletion | null> {
  const planId = String(row.plan.id);
  const coordination = (row.coordination ?? undefined) as RowCoordination | undefined;
  const handoff = coordination?.handoff;
  const done = rowStatusOf(row.plan as unknown as PlanRow) === "Done";
  const route = deliveryRouteOf(snapshot);
  if (handoff === undefined) {
    // A Done row that records no coordination block is a legitimate closed
    // shape (the standalone completed-coherence rule accepts it), so a
    // development/integration close has nothing to compose and nothing to
    // repair — and a report-only close owes nothing once its fulfilment is
    // recorded. A row that still has to be completed, and a report-only row
    // whose fulfilment is outstanding, ask for that decision instead.
    const owesFulfilment = route === "report-only" && reportOnlyFulfilmentOutstanding(snapshot, planId);
    if (done && !owesFulfilment) return null;
    throw missingDecision({
      planId,
      what: "close",
      component: "plan-handoff",
      path: "handoff",
      currentFacts: [
        `plan ${planId} records no handoff`,
        `its row status is ${rowStatusOf(row.plan as unknown as PlanRow) || "unstatused"}`,
        `the lifecycle declares the ${route} delivery route`,
      ],
      needed:
        `close composes plan ${planId}'s completion from its recorded accepted report/development evidence, and this row records ` +
        "no handoff at all \u2014 obtain the reviewed evidence (the submission, the accepted QC verdict and the passing QA decision), then retry",
    });
  }
  const prepared = requirePrepared(coordination, planId, "close");
  if (route === "report-only") {
    assertNoIntegrationContamination({ snapshot, planId, handoff, what: "close" });
    assertEvidenceDigests(handoff);
    const fulfilment = entailedFulfilment(snapshot, planId, handoff);
    if (done) {
      // The row already records the completion; only the workflow's own
      // fulfilment projection is outstanding (R10). Nothing is written to the
      // row, so the completed shape and the absence of ownership are asserted
      // rather than composed.
      assertCompletedReplayInvariants(row, snapshot, planId, handoff, { what: "close", fulfilment: "pending" });
      return { planId, handoffId: handoff.id, completesRow: false, fulfilment, gitWitness: null, resultSha: null };
    }
    requireHandoffState(handoff, ["accepted"], planId, "close");
    assertAcceptedReviewDecision(handoff, planId, "close");
    assertHandoffQaGate(handoff, prepared, planId, "close");
    assertPreparedFresh(prepared.assignment_path, prepared);
    await assertFindingsClosed(context, planId, prepared, "close");
    assertExecutionHolder(planRowOf(row), context.caller.sessionId, planId, "close");
    return { planId, handoffId: handoff.id, completesRow: true, fulfilment, gitWitness: null, resultSha: null };
  }
  if (done) return null;
  if (route === "development") {
    assertNoIntegrationContamination({ snapshot, planId, handoff, what: "close" });
    assertAcceptedReviewDecision(handoff, planId, "close");
    assertHandoffQaGate(handoff, prepared, planId, "close");
    const anchors = standaloneDeliveryAnchors(snapshot, planId);
    assertStandaloneBranchIdentity(row, planId, handoff, anchors, "close");
    const worktree = planScopeOf(row, planId).worktreePath;
    assertStandaloneSourceGitProof(worktree, handoff, anchors.source, "close", planId);
    await assertFindingsClosed(context, planId, prepared, "close");
    assertExecutionHolder(planRowOf(row), context.caller.sessionId, planId, "close");
    return {
      planId,
      handoffId: handoff.id,
      completesRow: true,
      fulfilment: null,
      gitWitness: captureGitProofWitness(worktree),
      resultSha: null,
    };
  }
  // The integration route: a PROVEN merge is reused, never re-run. The attempt
  // whose merge ran is recorded `merged` by E09's seam (`integration-accept`
  // finishes the recording from the observed merge); an attempt that records no
  // result asks for that decision instead of merging here.
  requireHandoffState(handoff, ["merged"], planId, "close");
  const attempt = requireIntegration(handoff, planId);
  const anchors = integrationAnchors(snapshot, planId);
  const checkout = assertIntegrationCheckout(anchors, planId);
  const resultSha = assertRecordedResult(anchors.worktreePath, planId, attempt, handoff.source_sha, checkout.head);
  await assertFindingsClosed(context, planId, prepared, "close");
  assertExecutionHolder(planRowOf(row), context.caller.sessionId, planId, "close");
  return {
    planId,
    handoffId: handoff.id,
    completesRow: true,
    fulfilment: null,
    gitWitness: captureGitProofWitness(anchors.worktreePath, "coordination.integration-diverged"),
    resultSha,
  };
}

/**
 * §R5/§R10 the same derivation for every owned row of one ACTIVE workflow, in
 * row order: the completions a terminal `completed` close composes. A row that
 * already records `Done` yields a proof only while the report-only fulfilment
 * is still outstanding, and a workflow whose every row is Done composes
 * nothing.
 */
export async function readEntailedCompletions(
  context: ExecutionContext,
  workflow: ExecutionState["workflows"][number],
): Promise<{ completions: readonly EntailedRowCompletion[]; pinned: DeliveryRoutePin }> {
  const snapshot = workflowSnapshotOf({
    state: workflow.state,
    plans: workflow.plans,
    integrationLease: workflow.integrationLease,
  });
  const completions: EntailedRowCompletion[] = [];
  for (const row of workflow.plans) {
    const proof = await readEntailedRowCompletion(context, snapshot, row);
    if (proof !== null) completions.push(proof);
  }
  // The route/policy pair every proof was derived against, computed from the
  // SAME snapshot: the close re-checks it at the commit boundary, so the
  // derivation and the commit judge one pair (§4.1).
  return { completions, pinned: deliveryRoutePin(snapshot) };
}

/**
 * §R5/§R10 one row's composed completion, applied INSIDE the close's own
 * transaction from the proof its preflight derived: the row's reviewed status
 * (`InReview`, or the `InProgress` the handoff itself entails), the
 * coordinator's ownership of its lease, the re-proved evidence digests and the
 * re-read Git witness, then the completion delta — `Done`, the completed
 * handoff and the released ownership. Nothing here merges, closes a workflow or
 * advances a counter twice: the caller's frame owns those.
 */
export function applyEntailedCompletion(input: {
  tx: ExecutionTransaction;
  frame: RowCompletionFrame;
  snapshot: WorkflowSnapshot;
  pinned: DeliveryRoutePin;
  handoffId: string;
  proof: EntailedRowCompletion;
  at: string;
  what: string;
}): void {
  const { tx, frame, snapshot, pinned, at, what } = input;
  const planId = frame.planId;
  requirePinnedDeliveryRoute(snapshot, pinned, planId, what);
  const handoff = requirePlanHandoff(frame.view.coordination ?? undefined, planId, input.handoffId);
  if (!input.proof.completesRow) {
    // §R10 the row already records its completion: only the workflow's own
    // fulfilment projection is being repaired, so the completed shape and the
    // sealed evidence are re-asserted and NO row byte is rewritten (the
    // terminal identity the lifecycle records stays exactly as it was).
    requireHandoffState(handoff, ["completed"], planId, what);
    assertEvidenceDigests(handoff);
    return;
  }
  const row = frame.view.plan as unknown as PlanRow;
  if (rowStatusOf(row) !== "InReview") {
    // §R5 the reviewed state the completion composes is either already recorded
    // or exactly the one the sealed handoff entails (E09's own rule); anything
    // else is ownership, and it is refused rather than inferred.
    entailedHandoffStatus(row, planId);
  }
  if (input.proof.resultSha !== null) {
    // §E the integration route's merge-lease admission, in the file route's
    // holder-first order: a claim this attempt holds (or none) is admitted, a
    // foreign or stopped holder is refused — the close never takes over a
    // claim it does not own and never re-merges what is already proven.
    assertMergeLeaseOwnForFrame(frame, tx, handoff, what);
  }
  assertExecutionHolder(planRowOf(frame.view), frame.releasedBy, planId, what);
  assertEvidenceDigests(handoff);
  if (input.proof.gitWitness !== null) revalidateGitProofWitness(input.proof.gitWitness);
  applyCompletionFrame({ tx, frame, handoff, at, resultSha: input.proof.resultSha, what });
}

/**
 * §R5 the frame one OWNED ROW of a workflow-level transition completes through:
 * the row's own view plus the workflow facts, read from the workflow witness
 * inside the transaction that composes the completion.
 */
export function completionFrameFor(input: {
  workflow: ExecutionState["workflows"][number];
  planId: string;
  sessionId: string;
}): RowCompletionFrame {
  const view = input.workflow.plans.find((candidate) => candidate.plan.id === input.planId);
  const token = input.workflow.planTokens[input.planId];
  if (view === undefined || token === undefined) {
    throw new CoordinationError(
      "coordination.plan-not-found",
      `workflow ${String(input.workflow.state.id)} holds no plan ${input.planId}`,
      { workflow_id: String(input.workflow.state.id), plan_id: input.planId },
    );
  }
  return {
    workflowId: String(input.workflow.state.id),
    planId: input.planId,
    view,
    state: input.workflow.state,
    siblings: input.workflow.plans.filter((candidate) => candidate.plan.id !== input.planId),
    integrationLease: input.workflow.integrationLease,
    revision: parseExecutionToken(token).revision,
    sessionBound: view.session !== null,
    releasedBy: input.sessionId,
  };
}

/**
 * §3 `complete` on the DB authority: re-prove the pinned evidence and the
 * recorded result, then apply the completion delta as ONE transaction — `Done`,
 * the completed handoff, the released execution lease and the released merge
 * lease commit together or not at all.
 *
 * The route decides which proof is required, and it is re-checked with the
 * registered completion policy INSIDE the transaction, because the plan's CAS
 * guards the row and not the workflow header:
 *
 * - a single-row `verification/report-only` workflow completes on its accepted
 *   handoff plus the recorded policy's fulfilment evidence, needs no source,
 *   integration or merge and drops only its own execution lease;
 * - a standalone development workflow completes on its accepted handoff, its
 *   delivery anchors and a source checkout that still carries the pinned commit;
 * - every other route requires a MERGED attempt whose recorded result is the
 *   pinned two-parent merge and is still reachable from the observed integration
 *   HEAD.
 *
 * A report-only completion is never accepted for another route and vice versa,
 * and no completion of any kind is iteration integration: nothing here merges,
 * and the workflow's own terminal close is a separate transition (W6).
 *
 * §4.1/§7 the external Git read happens before SQLite ownership and the SEALED
 * Git proof it produced is re-read from the filesystem immediately before the
 * commit, so a worktree, index, object store or ref that moved in the window
 * refuses instead of committing a stale proof. A refs-only witness cannot prove
 * an unchanged index or worktree (R10).
 */

/** Test-only hook to observe the preflight→commit gap of a DB completion. */
let completeWitnessGapForTest: (() => void) | undefined;
export function setCompleteWitnessGapForTest(callback: (() => void) | undefined): void {
  completeWitnessGapForTest = callback;
}

/**
 * The same observation point for `reconcile`: its classification is a
 * pre-transaction read too, so a regression needs to move the evidence or the
 * header in that window.
 */
let reconcileWitnessGapForTest: (() => void) | undefined;
export function setReconcileWitnessGapForTest(callback: (() => void) | undefined): void {
  reconcileWitnessGapForTest = callback;
}

export async function completeExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<CompleteOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "complete");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "handoffId"], "complete operation");
  if (!isNonEmptyString(operation.handoffId)) throw invalidPlanInput("complete requires the non-empty handoffId it names");
  const { planId } = resolved.read;
  const before = await readExecutionPlan(context, request.session, planId);
  const named = requirePlanHandoff(before.data.coordination ?? undefined, planId, operation.handoffId);
  const prepared = requirePrepared(before.data.coordination ?? undefined, planId, "complete");
  const snapshot = await readWorkflowSnapshot(context, resolved.read.workflowId);
  const standalone = isStandaloneDevelopmentWorkflow(snapshot);
  const reportOnly = isStandaloneReportOnlyWorkflow(snapshot);
  // §4.1 the route/policy pair this preflight proved; the transaction below
  // re-reads the header and refuses if either moved in the window.
  const pinned = { route: deliveryRouteOf(snapshot), completionPolicy: snapshot.completion_policy };
  let resultSha: string | null = null;
  let gitWitness: GitProofWitness | undefined;
  if (reportOnly) {
    assertNoIntegrationContamination({ snapshot, planId, handoff: named, what: "complete" });
    requireHandoffState(named, ["accepted"], planId, "complete");
    assertReportOnlyCompletionEvidence(snapshot, planId, "complete");
    assertAcceptedReviewDecision(named, planId, "complete");
    assertHandoffQaGate(named, prepared, planId, "complete");
    assertPreparedFresh(prepared.assignment_path, prepared);
  } else if (standalone) {
    assertNoIntegrationContamination({ snapshot, planId, handoff: named, what: "complete" });
    assertAcceptedReviewDecision(named, planId, "complete");
    assertHandoffQaGate(named, prepared, planId, "complete");
    const anchors = standaloneDeliveryAnchors(snapshot, planId);
    assertStandaloneBranchIdentity(before.data, planId, named, anchors, "complete");
    const worktree = planScopeOf(before.data, planId).worktreePath;
    assertStandaloneSourceGitProof(worktree, named, anchors.source, "complete", planId);
    gitWitness = captureGitProofWitness(worktree);
  } else {
    requireHandoffState(named, ["merged"], planId, "complete");
    const attempt = requireIntegration(named, planId);
    const anchors = integrationAnchors(snapshot, planId);
    const checkout = assertIntegrationCheckout(anchors, planId);
    resultSha = assertRecordedResult(anchors.worktreePath, planId, attempt, named.source_sha, checkout.head);
    gitWitness = captureGitProofWitness(anchors.worktreePath, "coordination.integration-diverged");
  }
  assertEvidenceDigests(named);
  await assertFindingsClosed(context, planId, prepared, "complete");
  assertExecutionHolder(planRowOf(before.data), context.caller.sessionId, planId, "complete");
  completeWitnessGapForTest?.();
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    const handoff = requirePlanHandoff(coordinationOf(witness), planId, operation.handoffId);
    const sealed = requirePrepared(coordinationOf(witness), planId, "complete");
    requireRowStatus(witness.view.plan as unknown as PlanRow, "InReview", planId, "complete", { still: true });
    const committed = witnessSnapshot(witness);
    requirePinnedDeliveryRoute(committed, pinned, planId, "complete");
    if (isStandaloneReportOnlyWorkflow(committed)) {
      assertNoIntegrationContamination({ snapshot: committed, planId, handoff, what: "complete" });
      requireHandoffState(handoff, ["accepted"], planId, "complete");
      assertReportOnlyCompletionEvidence(committed, planId, "complete");
      assertAcceptedReviewDecision(handoff, planId, "complete");
      assertHandoffQaGate(handoff, sealed, planId, "complete");
      assertPreparedFresh(sealed.assignment_path, sealed);
      assertExecutionHolder(planRowOf(witness.view), witness.session.sessionId, planId, "complete");
    } else if (isStandaloneDevelopmentWorkflow(committed)) {
      assertNoIntegrationContamination({ snapshot: committed, planId, handoff, what: "complete" });
      assertAcceptedReviewDecision(handoff, planId, "complete");
      assertHandoffQaGate(handoff, sealed, planId, "complete");
      assertStandaloneBranchIdentity(witness.view, planId, handoff, standaloneDeliveryAnchors(committed, planId), "complete");
      assertExecutionHolder(planRowOf(witness.view), witness.session.sessionId, planId, "complete");
    } else {
      requireHandoffState(handoff, ["merged"], planId, "complete");
      assertMergeLeaseOwn(witness, tx, handoff, "complete");
      assertExecutionHolder(planRowOf(witness.view), witness.session.sessionId, planId, "complete");
    }
    assertEvidenceDigests(handoff);
    if (gitWitness !== undefined) revalidateGitProofWitness(gitWitness);
    applyCompletion({ tx, witness, planId, handoff, at, resultSha, what: "complete" });
    const settled = readExecutionPlanWitness(tx, resolved.read);
    return { data: settled.view, token: settled.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/** §E what `reconcile` decided for one crash-interrupted attempt. */
type ReconcileDecision =
  | { outcome: "already-completed" }
  | { outcome: "completed"; resultSha: string }
  | { outcome: "retry-ready" };

/**
 * §3 `reconcile` on the DB authority: classify one crash-interrupted attempt
 * from the pinned objects and apply the decision in one transaction. It never
 * merges, never re-pins and never guesses:
 *
 * - `integrating` with the base unmoved and the source unmerged is `retry-ready`:
 *   back to `accepted`, the abandoned attempt block released, the row still
 *   InReview with its execution lease;
 * - `integrating` with a proven result, and `merged` with a still-valid recorded
 *   proof, complete normally (the same one-transaction delta);
 * - `completed` with a valid recorded proof is a domain no-op: replay never
 *   resurrects ownership or rewrites timestamps; the accepted operation still
 *   advances the addressed plan's CAS and records its own receipt. A standalone
 *   replay re-runs its stored invariants, its registered policy and its pinned
 *   QC/QA digests inside the transaction, so a report edited in the window still
 *   refuses;
 * - an unfinished/dirty integration checkout is `integration-unresolved`, and a
 *   moved branch, an unexpected parent graph, several matching merges or
 *   unavailable objects are `integration-diverged`.
 *
 * Ownership (§4.2): the caller must be the coordinator that owns the attempt —
 * or the stopped owner's claim must be taken over explicitly. A holder whose
 * session is no longer active at this epoch is the ONLY case where a claim is
 * moved without the holder agreeing, and the release records the prior holder,
 * the new holder and the decision. Clock age and heartbeats authorize nothing:
 * a claim held by a live session refuses, however old it is.
 */
export async function reconcileExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<ReconcileOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "reconcile");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "handoffId"], "reconcile operation");
  if (!isNonEmptyString(operation.handoffId)) throw invalidPlanInput("reconcile requires the non-empty handoffId it names");
  const { planId } = resolved.read;
  const before = await readExecutionPlan(context, request.session, planId);
  const named = requirePlanHandoff(before.data.coordination ?? undefined, planId, operation.handoffId);
  const prepared = requirePrepared(before.data.coordination ?? undefined, planId, "reconcile");
  const snapshot = await readWorkflowSnapshot(context, resolved.read.workflowId);
  const repository = controlHarnessRoot(context);
  const reportOnly = isStandaloneReportOnlyWorkflow(snapshot);
  // §4.1 the route/policy pair this classification proved; the completed replay
  // below re-reads the header before it advances anything.
  const pinned = { route: deliveryRouteOf(snapshot), completionPolicy: snapshot.completion_policy };
  let decision: ReconcileDecision;
  if (named.state === "completed") {
    if (deliveryRouteOf(snapshot) !== "integration") {
      assertStandaloneCompletedReplay(before.data, snapshot, planId, named, repository);
    } else {
      const integration = requireIntegration(named, planId);
      const target = proofRepository([integration.worktree_path, named.worktree_path, repository]);
      if (target === undefined) {
        throw integrationDiverged(
          `plan ${planId} has no readable integration repository to re-verify ${String(integration.result_sha)}`,
          { plan_id: planId, worktree_path: integration.worktree_path },
        );
      }
      const head = gitRead(target, ["rev-parse", integration.target_branch]);
      assertRecordedResult(target, planId, integration, named.source_sha, head);
    }
    decision = { outcome: "already-completed" };
  } else if (reportOnly) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `reconcile refuses report-only handoff ${named.state} for ${planId} because integration contamination is not permitted`,
      { plan_id: planId, state: named.state },
    );
  } else if (named.state === "integrating" || named.state === "merged") {
    const attempt = requireIntegration(named, planId);
    const anchors = integrationAnchors(snapshot, planId);
    const checkout = assertIntegrationCheckout(anchors, planId);
    // Every remaining path completes the row, so the coordinator must still hold
    // the execution lease it received at accept (spec §E — nothing is replayed
    // into ownership). The merge lease is admitted INSIDE the transaction, in
    // the file route's holder-first order, because only there is the holder's
    // liveness at this epoch readable.
    assertExecutionHolder(planRowOf(before.data), context.caller.sessionId, planId, "reconcile");
    if (named.state === "merged") {
      decision = {
        outcome: "completed",
        resultSha: assertRecordedResult(anchors.worktreePath, planId, attempt, named.source_sha, checkout.head),
      };
    } else {
      const proof = integrationProof(anchors.worktreePath, checkout.head, attempt.base_sha, named.source_sha);
      if (proof.kind === "diverged") {
        throw integrationDiverged(`plan ${planId} integration cannot be reconciled \u2014 ${proof.reason}`, {
          plan_id: planId,
          base: attempt.base_sha,
          source: named.source_sha,
        });
      }
      if (proof.kind === "proven") {
        decision = { outcome: "completed", resultSha: proof.resultSha };
      } else if (checkout.head !== attempt.base_sha) {
        throw integrationDiverged(
          `plan ${planId} integration HEAD ${checkout.head} moved past the attempt base ${attempt.base_sha} without a merge of ${named.source_sha}`,
          { plan_id: planId, base: attempt.base_sha, head: checkout.head },
        );
      } else {
        decision = { outcome: "retry-ready" };
      }
    }
  } else {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${planId} handoff is ${named.state} \u2014 reconcile recovers only integrating, merged or completed attempts`,
      { plan_id: planId, state: named.state },
    );
  }
  assertEvidenceDigests(named);
  if (decision.outcome !== "already-completed") {
    await assertFindingsClosed(context, planId, prepared, "complete");
  }
  reconcileWitnessGapForTest?.();
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    const handoff = requirePlanHandoff(coordinationOf(witness), planId, operation.handoffId);
    if (decision.outcome === "already-completed") {
      // The DOMAIN replay is read-only: no lease, block or timestamp is
      // rewritten. The accepted operation itself is not a replay — this
      // authority records it and advances the addressed plan's CAS exactly once
      // (§3.1), so its receipt and the token it returns are one operation's.
      const committed = witnessSnapshot(witness);
      requirePinnedDeliveryRoute(committed, pinned, planId, "reconcile");
      if (deliveryRouteOf(committed) !== "integration") {
        // §4.1 the replay re-runs the stored invariants and the pinned QC/QA
        // digests here, not only before ownership: the row token cannot see a
        // report rewritten inside the window, and neither can the header.
        assertCompletedReplayInvariants(witness.view, committed, planId, handoff);
      }
      advancePlanRowRevision(tx, witness);
      const settled = readExecutionPlanWitness(tx, resolved.read);
      return { data: settled.view, token: settled.token, storeId: tx.storeId, epoch: tx.epoch };
    }
    requireRowStatus(witness.view.plan as unknown as PlanRow, "InReview", planId, "reconcile", { still: true });
    assertEvidenceDigests(handoff);
    assertExecutionHolder(planRowOf(witness.view), witness.session.sessionId, planId, "reconcile");
    const lease = decideMergeLease(witness, tx, handoff, "reconcile");
    if (decision.outcome === "retry-ready") {
      const returned: PlanHandoff = { ...handoff, state: "accepted" };
      delete returned.integration;
      writeCoordinationBlock(tx, witness, {
        block: { ...storedCoordinationOf(witness.view), handoff: returned },
        what: `plan ${planId} coordination`,
      });
      if (lease.kind !== "unclaimed") {
        releaseIntegrationMergeLease(tx, {
          workflowId: witness.workflowId,
          claim: lease.lease,
          releasedBy: witness.session.sessionId,
          reason: lease.kind === "stopped" ? `stopped-owner:${lease.lease.holder}` : "retry-ready",
          now: at,
        });
      }
      const settled = readExecutionPlanWitness(tx, resolved.read);
      return { data: settled.view, token: settled.token, storeId: tx.storeId, epoch: tx.epoch };
    }
    requireHandoffState(handoff, ["integrating", "merged"], planId, "reconcile");
    if (lease.kind === "stopped") {
      // §4.2 the explicit takeover: the prior holder is recorded on the release
      // that ends its claim, together with the decision and the new owner.
      releaseIntegrationMergeLease(tx, {
        workflowId: witness.workflowId,
        claim: lease.lease,
        releasedBy: witness.session.sessionId,
        reason: `stopped-owner:${lease.lease.holder}`,
        now: at,
      });
    }
    applyCompletion({ tx, witness, planId, handoff, at, resultSha: decision.resultSha, what: "reconcile" });
    const settled = readExecutionPlanWitness(tx, resolved.read);
    return { data: settled.view, token: settled.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/* ------------------------------------------------------------------------ *
 * §3 `mutateExecutionPlan` — the published coordinator/plan verb surface
 * ------------------------------------------------------------------------ */

/**
 * §3 the whole plan-operation surface of the DB authority: one entry point
 * carrying the §3.1 mutation envelope (operation id, session reference, plan
 * token) and the operation itself, whose member of the closed union selects the
 * verb.
 *
 * § One resolver path (S2/E02) the entry point accepts the SPARSE intent: a
 * caller may omit the session reference, the plan token and the addressed plan
 * id it cannot derive, and the engine resolves them here — current authority,
 * the trusted caller's own binding, the plan's own token — before any verb's
 * strict frame sees the request. An explicitly supplied value is a constraint,
 * never a prerequisite.
 *
 * It is published HERE and only here, because the union is complete: every
 * implemented member has exactly one DB transition, and the legacy-only
 * `repair-delivery-source` — absent from primary spec §3's eleven operations —
 * is refused rather than stubbed. The dispatcher adds no permission of its own:
 * each verb re-runs the shared seat/scope gate, and the frame re-runs the CAS,
 * the running-lifecycle admission and the receipt bookkeeping.
 */
export async function mutateExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanIntent,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const operation = request?.operation;
  if (!isPlainObject(operation) || !isNonEmptyString(operation.kind)) {
    throw invalidPlanInput("a plan operation needs an operation with a kind");
  }
  const resolved = await resolvePlanIntent(context, request, operation);
  const strict = resolved.operation;
  switch (strict.kind) {
    case "prepare":
      return prepareExecutionPlan(context, { ...resolved, operation: strict });
    case "progress":
      return progressExecutionPlan(context, { ...resolved, operation: strict });
    case "residual-add":
      return residualAddExecutionPlan(context, { ...resolved, operation: strict });
    case "residual-close":
      return residualCloseExecutionPlan(context, { ...resolved, operation: strict });
    case "handoff":
      return handoffExecutionPlan(context, { ...resolved, operation: strict });
    case "accept":
      return acceptExecutionPlan(context, { ...resolved, operation: strict });
    case "return":
      return returnExecutionPlan(context, { ...resolved, operation: strict });
    case "integration-start":
      return integrationStartExecutionPlan(context, { ...resolved, operation: strict });
    case "integration-accept":
      return integrationAcceptExecutionPlan(context, { ...resolved, operation: strict });
    case "complete":
      return completeExecutionPlan(context, { ...resolved, operation: strict });
    case "reconcile":
      return reconcileExecutionPlan(context, { ...resolved, operation: strict });
    default: {
      // The union is exhaustive, so this is reachable only by a caller whose
      // request is not the typed union: the legacy-only repair, an unknown verb
      // or a staged store's older vocabulary all refuse here instead of being
      // dispatched to something that is not theirs.
      const kind = "kind" in operation && typeof operation.kind === "string" ? operation.kind : String(operation);
      throw new CoordinationError("coordination.unknown-operation", `${String(kind)} is not a coordination operation`, {
        operation: kind,
      });
    }
  }
}
