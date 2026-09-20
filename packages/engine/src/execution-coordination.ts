/**
 * execution-coordination.ts — the DB transport of the plan coordination
 * operations (primary spec §2.3/§3/§4.1).
 *
 * One accepted plan operation is ONE transaction. `withExecutionPlanAuthority`
 * owns that transaction, the shared role/scope gates and the sealed witness
 * every DB plan verb starts from; W2 adds the first two operations on top of it
 * — `prepare` (which seals the reviewed Assignment and selects the frozen
 * catalog input) and `progress` (which moves a bound row's status/summary) —
 * and W3–W4 add the rest here.
 *
 * Nothing here is a public surface: the package index exports no coordination
 * mutator, and `mutateExecutionPlan` is published only once its whole closed
 * operation union exists (W4).
 */
import { createHash } from "node:crypto";
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
  validateRowCoordination,
  type PlanProgress,
  type PreparedCoordination,
} from "./coordination-write.js";
import {
  ExecutionPinConflictError,
  assertEvidenceInsidePlanArea,
  assertPreparedFresh,
  assertSealedInputsUnchanged,
  assertViolationFree,
  catalogPinFactsOn,
  parseAssignmentFile,
  planAreaRoots,
  selectCatalogPinOn,
  type AssignmentHeaders,
} from "./coordination.js";
import {
  IMPLEMENTED_OPERATIONS,
  assertExecutionHolder,
  assertNoHandoffTransition,
  assertOperationRole,
  assertPlanAddress,
  assertPrepareAdmission,
  assertTrackBranches,
  requireProgressStatus,
  type CoordinationSeat,
} from "./coordination-transitions.js";
import {
  ExecutionError,
  advancePlanOperationRevisions,
  assertExecutionToken,
  assertOperationId,
  readExecutionPlanWitness,
  readExecutionSealedInput,
  readPlanOperationReplay,
  resolvePlanRead,
  serializeExecutionValue,
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
import { canonicalizeNearestExisting, resolvePlanDir, resolveSddDir } from "./path.js";
import { storeDbPath } from "./store-db.js";
import type { PlanCoordinationOperation } from "./coordination.js";
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
 * Only then does `run` produce the operation's read; the revision advance and
 * the receipt are the frame's, so an operation cannot forget either.
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
    const receipt = run(witness, tx, at);
    advancePlanOperationRevisions(tx, { workflowId: witness.workflowId, now: at });
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
    const nextCoordination: Record<string, unknown> = { ...storedCoordinationOf(witness.view), prepared };
    assertViolationFree(
      validateRowCoordination({ revision: witness.revision + 1, ...nextCoordination }),
      `plan ${planId} coordination`,
    );
    writeExecutionInputPin(tx, { workflowId, planId, pin });
    writePlanCoordinationRow(tx, {
      workflowId,
      planId,
      state: { ...state, metadata },
      coordination: nextCoordination,
      revision: witness.revision + 1,
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
    const coordination = witness.view.coordination ?? undefined;
    // §4.1 the prepared Assignment is re-authenticated first, exactly where the
    // file route's locked read re-authenticates it: an Assignment edited after
    // preparation invalidates the row until the coordinator re-prepares.
    if (coordination?.prepared !== undefined) {
      assertPreparedFresh(coordination.prepared.assignment_path, coordination.prepared);
    }
    // §D/§E a plan-owned write needs the row's execution lease, and identity is
    // not ownership: the store keeps released lease rows as tombstones (§3.1),
    // so the equivalent of the file route's lease object is a HELD one.
    const lease = witness.view.executionLease;
    assertExecutionHolder(
      { ...state, execution_lease: lease !== null && lease.status === "held" ? lease : undefined },
      witness.session.sessionId,
      planId,
      "a plan-owned write",
    );
    assertNoHandoffTransition(coordination, planId);
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
    const nextCoordination: Record<string, unknown> = {
      ...storedCoordinationOf(witness.view),
      progress: {
        status: progress.status,
        summary: progress.summary,
        evidence_paths: [...progress.evidence_paths],
        ...(progress.track_branches !== undefined ? { track_branches: [...progress.track_branches] } : {}),
      },
    };
    assertViolationFree(
      validateRowCoordination({ revision: witness.revision + 1, ...nextCoordination }),
      `plan ${planId} coordination`,
    );
    const nextState: Record<string, unknown> = { ...state, status: progress.status };
    if (nextMetadata !== plan.metadata) nextState.metadata = nextMetadata;
    writePlanCoordinationRow(tx, {
      workflowId,
      planId,
      state: nextState,
      coordination: nextCoordination,
      revision: witness.revision + 1,
    });
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}
