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
import { createHash, randomUUID } from "node:crypto";
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
  type PlanProgress,
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
  gitProof,
  handoffEvidencePayload,
  integrationAnchors,
  integrationDiverged,
  integrationUnresolved,
  mergeLeaseOfAttempt,
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
  readLiveSessionIdentities,
  readPlanOperationReplay,
  releaseExecutionLease,
  releaseIntegrationMergeLease,
  resolvePlanRead,
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
  type ExecutionToken,
  type ExecutionTransaction,
  type ResolvedPlanRead,
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
  type CaptureInput,
  type ComposedTransactionRevision,
} from "./issue.js";
import { canonicalizeNearestExisting, resolvePlanDir, resolveSddDir } from "./path.js";
import { findingsCleanupGate } from "./project.js";
import { storeDbPath } from "./store-db.js";
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
 */
export type ExecutionPlanCall = {
  session: ExecutionSessionRef;
  /** The addressed plan's `exec-v1` token from the current read (the CAS). */
  expected: ExecutionToken;
  /** The plan this operation transitions. */
  planId: string;
  operation: CoordinationOperation;
};

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
  assertPlanOperationAdmissible(context.caller, operation.kind, call.planId);
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; a plan operation requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    const witness = readExecutionPlanWitness(tx, resolvePlanRead(context.caller, call.session, call.planId));
    assertExecutionToken(call.expected, {
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
 * §3.1 request hash: operation kind, exact scope, expected token, caller
 * identity and the operation payload as supplied. Reusing an operation id for
 * any other request refuses `execution.operation-conflict` instead of replaying
 * a foreign receipt, and another actor cannot replay this one.
 */
function planOperationRequestHash(
  caller: ExecutionCaller,
  kind: string,
  read: { workflowId: string; planId: string },
  expected: ExecutionToken,
  payload: unknown,
): string {
  return createHash("sha256")
    .update(
      serializeExecutionValue({
        operation: kind,
        workflow_id: read.workflowId,
        plan_id: read.planId,
        expected,
        caller: {
          session_id: caller.sessionId,
          role: caller.role,
          workflow_id: caller.workflowId,
          plan_id: caller.planId,
        },
        payload,
      }),
      "utf8",
    )
    .digest("hex");
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
 * addressed plan and re-reads the store-held session), a committed receipt is
 * returned for an identical retry BEFORE the CAS is re-evaluated, the workflow
 * must still be running, and the supplied token must be the plan's exact CAS.
 * Only then does `run` produce the operation's read, and the transaction's one
 * revision advance has already run: the advance and the receipt are the frame's,
 * so an operation cannot forget either, and an operation that composes another
 * domain's writes into this transaction reads the revision it commits at from
 * the shared counter instead of advancing it a second time.
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
    const replay = readPlanOperationReplay<T>(tx, {
      operationId: request.operationId,
      requestHash,
      workflowId: witness.workflowId,
      planId: witness.planId,
    });
    if (replay !== null) return replay;
    assertRunningWorkflow(witness);
    assertExecutionToken(request.expected, {
      kind: "plan",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [witness.workflowId, witness.planId],
      revision: witness.revision,
    });
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
    return { ...receipt, operationId: request.operationId, replayed: false };
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
  const requestHash = planOperationRequestHash(context.caller, "prepare", resolved.read, resolved.call.expected, {
    assignment_path: operation.assignmentPath,
  });
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

/** §3.1 the canonical payload half of a progress request hash. */
function progressPayload(progress: PlanProgress): Record<string, unknown> {
  return {
    status: progress.status,
    summary: progress.summary,
    evidence_paths: [...progress.evidence_paths],
    track_branches: progress.track_branches === undefined ? null : [...progress.track_branches],
  };
}

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
  const requestHash = planOperationRequestHash(context.caller, "progress", resolved.read, resolved.call.expected, {
    progress: progressPayload(progress),
  });
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
 * §3.1 the canonical payload half of a residual-add request hash: every field
 * the capture below consumes, in the entry's own order. A payload that differs
 * in any of them is a different request, so reusing the operation id refuses
 * `execution.operation-conflict` rather than replaying a foreign receipt.
 */
function residualAddPayload(entries: readonly ResidualEntry[]): unknown[] {
  return entries.map((entry) => ({
    title: entry.title ?? null,
    kind: entry.kind ?? null,
    severity: entry.severity ?? null,
    impact: entry.impact ?? null,
    acceptance: entry.acceptance ?? null,
    owner: entry.owner ?? null,
    source_identity: entry.sourceIdentity ?? null,
    root_cause_key: entry.rootCauseKey ?? null,
    acceptance_key: entry.acceptanceKey ?? null,
    occurrence_key: entry.occurrenceKey ?? null,
    source_kind: entry.sourceKind ?? null,
    location: entry.location ?? null,
    observed_behavior: entry.observedBehavior ?? null,
    evidence: Array.isArray(entry.evidence) ? [...entry.evidence] : null,
    discovered_at: entry.discoveredAt ?? null,
  }));
}

/** §3.1 the canonical payload half of a residual-close request hash. */
function residualClosePayload(operation: ResidualCloseOperation): Record<string, unknown> {
  const evidence: Record<string, unknown> = isPlainObject(operation.evidence) ? operation.evidence : {};
  return {
    issue_id: operation.issueId ?? null,
    disposition: operation.disposition ?? null,
    expected_issue_revision: operation.expectedIssueRevision ?? null,
    evidence: {
      reason: evidence.reason ?? null,
      scope: evidence.scope ?? null,
      references: Array.isArray(evidence.references) ? [...evidence.references] : null,
      canonical_issue_id: evidence.canonicalIssueId ?? null,
      alignment_ref: evidence.alignmentRef ?? null,
    },
  };
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
  // The request hash below reads every entry field, so a malformed entry is
  // refused as this route's caller-input refusal rather than as a read of a
  // non-object (`assertExactKeys` checks the operation's keys, not its items).
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      throw invalidPlanInput("residual-add requires every entry to be an issue observation object");
    }
  }
  const requestHash = planOperationRequestHash(context.caller, "residual-add", resolved.read, resolved.call.expected, {
    entries: residualAddPayload(entries),
  });
  const actor = issueWriteSeat(context.caller.role);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx) => {
    assertResidualAdmission(witness, tx);
    // §D the project the finding belongs to is a fact of the addressed plan
    // ROW, not of the caller's request — which is why each entry's own
    // validation (the same `assertCaptureRequest` the public verb runs) happens
    // here, where that row is known, and before that entry's first write.
    const projectId = projectBucketOf(witness.view.plan as unknown as PlanRow);
    const { planId } = witness;
    const sessionId = witness.session.sessionId;
    // §3.1 the shared store revision this transaction commits at: the frame's
    // single advance has already run, so every composed issue helper joins it
    // instead of advancing the same counter once more.
    const composed: ComposedTransactionRevision = { committedStoreRevision: storeRevisionOn(tx.db) };
    for (const entry of entries) {
      const input: CaptureInput = { ...entry, projectId };
      assertCaptureRequest(input);
      const capture = captureIssueOn(
        tx.db,
        input,
        {
          operationId: residualCaptureOperationId(sessionId, planId, entry.occurrenceKey),
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
          operationId: residualLinkOperationId(sessionId, planId, entry.occurrenceKey),
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
  const requestHash = planOperationRequestHash(context.caller, "residual-close", resolved.read, resolved.call.expected, {
    residual: residualClosePayload(operation),
  });
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
  const route = rowValidationRoute(witnessSnapshot(witness), witness.view.plan as unknown as PlanRow);
  const violations = storedCoordinationViolations(input.block, {
    revision: witness.revision + 1,
    route,
    sessionBound: witness.view.session !== null,
    what: input.what,
  });
  assertViolationFree(violations, input.what);
  writePlanCoordinationRow(tx, {
    workflowId: witness.workflowId,
    planId: witness.planId,
    state: input.state ?? (witness.view.plan as unknown as Record<string, unknown>),
    coordination: input.block,
    revision: witness.revision + 1,
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
  const lease = witness.view.integrationLease;
  if (lease === null) return { kind: "unclaimed" };
  if (lease.holder !== witness.session.sessionId) {
    if (readLiveSessionIdentities(tx, witness.workflowId).has(lease.holder)) {
      throw new CoordinationError(
        "coordination.session-mismatch",
        `plan ${witness.planId} integration is held by ${lease.holder}, not ${witness.session.sessionId}`,
        { plan_id: witness.planId, holder: lease.holder, session_id: witness.session.sessionId, operation: what },
      );
    }
    return { kind: "stopped", lease };
  }
  if (mergeLeaseOfAttempt(lease, witness.planId, handoff.source_branch) === undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${witness.planId} merge lease claims plan ${lease.plan_id} source ${lease.source_branch}, not this attempt ` +
        `(${witness.planId} source ${handoff.source_branch}) \u2014 a foreign claim is never reused or released`,
      {
        plan_id: witness.planId,
        holder_plan_id: lease.plan_id,
        holder_source_branch: lease.source_branch,
        source_branch: handoff.source_branch,
        operation: what,
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
  const decision = decideMergeLease(witness, tx, handoff, what);
  if (decision.kind === "stopped") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${witness.planId} merge lease is held by ${decision.lease.holder}, whose session is no longer active \u2014 ${what} does ` +
        `not take over a stopped owner; reconcile records the prior holder and the decision`,
      { plan_id: witness.planId, holder: decision.lease.holder, operation: what },
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
  assertHandoffGitProof(planScopeOf(before.data, planId).worktreePath, evidence, "handoff", planId);
  await assertFindingsClosed(context, planId, prepared, "hand off");
  const requestHash = planOperationRequestHash(context.caller, "handoff", resolved.read, resolved.call.expected, {
    evidence: handoffEvidencePayload(evidence),
  });
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    assertPlanOwnedWrite(witness, "handoff");
    const coordination = coordinationOf(witness);
    const sealed = requirePrepared(coordination, planId, "handoff");
    assertHandoffQaGate({ qa: { gate: evidence.qa_gate } }, sealed, planId, "handoff");
    requireRowStatus(witness.view.plan as unknown as PlanRow, "InReview", planId, "handoff");
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
  const requestHash = planOperationRequestHash(context.caller, "accept", resolved.read, resolved.call.expected, {
    handoff_id: operation.handoffId,
  });
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
  const requestHash = planOperationRequestHash(context.caller, "return", resolved.read, resolved.call.expected, {
    handoff_id: operation.handoffId,
    reason: operation.reason,
  });
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
  const requestHash = planOperationRequestHash(context.caller, "integration-start", resolved.read, resolved.call.expected, {
    handoff_id: operation.handoffId,
  });
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
  const requestHash = planOperationRequestHash(context.caller, "integration-accept", resolved.read, resolved.call.expected, {
    handoff_id: operation.handoffId,
  });
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

/**
 * §E the standalone replay of an already completed plan (spec §E): a `Done` row
 * with no lease and no merge lease, whose completed handoff is coherent and
 * whose pinned source is still an object of a readable repository. Read-only:
 * replay resurrects no ownership and rewrites no timestamp.
 */
function assertStandaloneCompletedReplay(
  view: ExecutionPlanView,
  snapshot: WorkflowSnapshot,
  planId: string,
  handoff: PlanHandoff,
  harnessRoot: string,
): void {
  const plan = planRowOf(view);
  if (rowStatusOf(plan) !== "Done") {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `reconcile requires ${planId} to be Done for a standalone completed replay`,
      { plan_id: planId, status: plan.status },
    );
  }
  if (plan.execution_lease !== undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `reconcile requires no execution lease on ${planId} for a standalone completed replay`,
      { plan_id: planId },
    );
  }
  if (snapshot.integration_merge_lease !== undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `reconcile requires no integration merge lease for a standalone completed replay of ${planId}`,
      { plan_id: planId },
    );
  }
  assertNoIntegrationContamination({ snapshot, planId, handoff, what: "reconcile" });
  const route = rowValidationRoute(snapshot, plan as unknown as PlanRow);
  assertViolationFree(
    storedCoordinationViolations(
      { ...(view.coordination ?? {}) } as Record<string, unknown>,
      { revision: view.coordination?.revision ?? 0, route, sessionBound: view.session !== null, what: `plan ${planId} coordination` },
    ),
    `plan ${planId} coordination`,
  );
  if (isStandaloneReportOnlyWorkflow(snapshot)) {
    assertReportOnlyCompletionEvidence(snapshot, planId, "reconcile");
    return;
  }
  const anchors = standaloneDeliveryAnchors(snapshot, planId);
  assertStandaloneBranchIdentity(view, planId, handoff, anchors, "reconcile", false);
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
  const { tx, witness, planId, handoff, at, what } = input;
  const plan = witness.view.plan as unknown as Record<string, unknown>;
  const standalone = input.resultSha === null;
  const metadata = { ...(isPlainObject(plan.metadata) ? plan.metadata : {}) };
  if (standalone) {
    // The retained metadata is what authorizes cleanup afterwards: the leases
    // release, the scope record does not.
    metadata.working_branch = handoff.source_branch;
    metadata.worktree_path = handoff.worktree_path;
  }
  const integration = handoff.integration;
  const completed: PlanHandoff = {
    ...handoff,
    state: "completed",
    completed_at: at,
    ...(input.resultSha === null || integration === undefined
      ? {}
      : { integration: { ...integration, result_sha: input.resultSha, verified_at: at } }),
  };
  writeCoordinationBlock(tx, witness, {
    block: { ...storedCoordinationOf(witness.view), handoff: completed },
    state: { ...plan, status: "Done", metadata },
    what,
  });
  releaseExecutionLease(tx, {
    workflowId: witness.workflowId,
    planId,
    lease: requireExecutionLease(planRowOf(witness.view), planId, what),
    releasedBy: witness.session.sessionId,
    reason: what,
    now: at,
  });
  // Only this attempt's own claim is released: a lease naming another plan or
  // another source branch is not this completion's to drop (spec §E).
  const claim = mergeLeaseOfAttempt(witness.view.integrationLease, planId, handoff.source_branch);
  if (claim !== undefined) {
    releaseIntegrationMergeLease(tx, {
      workflowId: witness.workflowId,
      claim,
      releasedBy: witness.session.sessionId,
      reason: what,
      now: at,
    });
  }
}

/**
 * §3 `complete` on the DB authority: re-prove the pinned evidence and the
 * recorded result, then apply the completion delta as ONE transaction — `Done`,
 * the completed handoff, the released execution lease and the released merge
 * lease commit together or not at all.
 *
 * The route decides which proof is required. A standalone development workflow
 * completes on its accepted handoff, its delivery anchors and a source checkout
 * that still carries the pinned commit, and refuses any integration
 * contamination. Every other route requires a MERGED attempt whose recorded
 * result is the pinned two-parent merge and is still reachable from the observed
 * integration HEAD — a standalone completion is never accepted for it, and no
 * completion of either kind is iteration integration: nothing here merges, and
 * the workflow's own terminal close is a separate transition (W6).
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
  const requestHash = planOperationRequestHash(context.caller, "complete", resolved.read, resolved.call.expected, {
    handoff_id: operation.handoffId,
  });
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    const handoff = requirePlanHandoff(coordinationOf(witness), planId, operation.handoffId);
    const sealed = requirePrepared(coordinationOf(witness), planId, "complete");
    requireRowStatus(witness.view.plan as unknown as PlanRow, "InReview", planId, "complete", { still: true });
    const committed = witnessSnapshot(witness);
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
 *   advances the addressed plan's CAS and records its own receipt;
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
  let decision: ReconcileDecision;
  if (named.state === "completed") {
    if (isStandaloneDevelopmentWorkflow(snapshot) || reportOnly) {
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
  const requestHash = planOperationRequestHash(context.caller, "reconcile", resolved.read, resolved.call.expected, {
    handoff_id: operation.handoffId,
  });
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, (witness, tx, at) => {
    const handoff = requirePlanHandoff(coordinationOf(witness), planId, operation.handoffId);
    if (decision.outcome === "already-completed") {
      // The DOMAIN replay is read-only: no lease, block or timestamp is
      // rewritten. The accepted operation itself is not a replay — this
      // authority records it and advances the addressed plan's CAS exactly once
      // (§3.1), so its receipt and the token it returns are one operation's.
      const committed = witnessSnapshot(witness);
      if (isStandaloneReportOnlyWorkflow(committed)) {
        assertReportOnlyCompletionEvidence(committed, planId, "reconcile");
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
 * It is published HERE and only here, because the union is complete: every
 * implemented member has exactly one DB transition, and the legacy-only
 * `repair-delivery-source` — absent from primary spec §3's eleven operations —
 * is refused rather than stubbed. The dispatcher adds no permission of its own:
 * each verb re-runs the shared seat/scope gate, and the frame re-runs the CAS,
 * the running-lifecycle admission and the receipt bookkeeping.
 */
export async function mutateExecutionPlan(
  context: ExecutionContext,
  request: ExecutionMutation & { planId: string; operation: CoordinationOperation },
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const operation = request?.operation;
  if (!isPlainObject(operation) || !isNonEmptyString(operation.kind)) {
    throw invalidPlanInput("a plan operation needs an operation with a kind");
  }
  switch (operation.kind) {
    case "prepare":
      return prepareExecutionPlan(context, { ...request, operation });
    case "progress":
      return progressExecutionPlan(context, { ...request, operation });
    case "residual-add":
      return residualAddExecutionPlan(context, { ...request, operation });
    case "residual-close":
      return residualCloseExecutionPlan(context, { ...request, operation });
    case "handoff":
      return handoffExecutionPlan(context, { ...request, operation });
    case "accept":
      return acceptExecutionPlan(context, { ...request, operation });
    case "return":
      return returnExecutionPlan(context, { ...request, operation });
    case "integration-start":
      return integrationStartExecutionPlan(context, { ...request, operation });
    case "integration-accept":
      return integrationAcceptExecutionPlan(context, { ...request, operation });
    case "complete":
      return completeExecutionPlan(context, { ...request, operation });
    case "reconcile":
      return reconcileExecutionPlan(context, { ...request, operation });
    default: {
      // The union is exhaustive, so this is reachable only by a caller whose
      // request is not the typed union: the legacy-only repair, an unknown verb
      // or a staged store's older vocabulary all refuse here instead of being
      // dispatched to something that is not theirs.
      const kind = (operation as { kind?: unknown }).kind;
      throw new CoordinationError("coordination.unknown-operation", `${String(kind)} is not a coordination operation`, {
        operation: kind,
      });
    }
  }
}
