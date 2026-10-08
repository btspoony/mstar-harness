/**
 * execution-coordination.ts — the DB transport of the ordinary coordinator plan
 * operations (primary spec §3/§4.1; locked removal contract §Operation
 * semantics).
 *
 * One accepted plan operation is ONE transaction. `withExecutionPlanAuthority`
 * owns that transaction, the shared role/scope gates and the sealed witness
 * every DB plan verb starts from. The closed union is the five ordinary
 * coordinator operations — `prepare` (revisable execution configuration),
 * `progress`, the two residual verbs and direct `complete` — and nothing else:
 * there is no per-plan session, no handoff state machine, no integration
 * bookkeeping verb and no ownership transfer. A row is owned by the workflow's
 * coordinator; its CAS token, `BEGIN IMMEDIATE` and the operation receipt are
 * the whole write exclusion.
 *
 * Nothing here is a public surface: the package index publishes only
 * `mutateExecutionPlan`.
 */
import { dirname, isAbsolute } from "node:path";
import { assertCatalogExecutionCommittedOn } from "./catalog-registration.js";
import {
  CoordinationError,
  assertExactKeys,
  canonicalTarget,
  evidenceRefOf,
  isNonEmptyString,
  isPlainObject,
  validatePlanProgress,
  type CompletionRecord,
  type PlanPrepareConfig,
  type PreparedCoordination,
} from "./coordination-write.js";
import {
  ExecutionPinConflictError,
  assertEvidenceInsidePlanArea,
  assertFeatureCheckout,
  assertIntegrationCheckout,
  assertViolationFree,
  catalogPinFactsOn,
  captureGitProofWitness,
  gitObjectExists,
  gitRead,
  integrationProof,
  planAreaRoots,
  revalidateGitProofWitness,
  selectCatalogPinOn,
  type GitProofWitness,
} from "./coordination.js";
import {
  IMPLEMENTED_OPERATIONS,
  assertCompletionReviewDecision,
  assertNoIntegrationContamination,
  assertOperationRole,
  assertPrepareAdmission,
  assertTrackBranches,
  gitProof,
  integrationAnchors,
  integrationDiverged,
  missingDecision,
  projectBucketOf,
  readCompletionEvidence,
  requireProgressStatus,
  rowStatusOf,
  standaloneDeliveryAnchors,
  storedCoordinationViolations,
  type ValidatedCompletionEvidence,
} from "./coordination-transitions.js";
import {
  ExecutionError,
  advancePlanOperationRevisions,
  assertExecutionToken,
  assertOperationId,
  readExecutionPlan,
  readExecutionPlanWitness,
  readExecutionSealedInput,
  readExecutionState,
  readLiveSessionIdentities,
  readPlanOperationReplay,
  readPlanOperationReplayBeforeProof,
  releaseIntegrationMergeLease,
  resolvePlanRead,
  resolveTokenFreshness,
  semanticRequestHash,
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
  linkIssueScopedOn,
  storeRevisionOn,
  IssueError,
  type CaptureInput,
  type ComposedTransactionRevision,
} from "./issue.js";
import { canonicalizeNearestExisting } from "./path.js";
import { resumeExecutionSession } from "./execution-session.js";
import { resolveCurrentAuthority } from "./store-read.js";
import {
  PLAN_OPERATION_SEMANTICS,
  selectSemanticFields,
  unresolvedRecovery,
  type RecoveryDetails,
  type RecoveryProblem,
  type ResolutionSource,
} from "./recovery-intent.js";
import { storeDbPath } from "./store-db.js";
import {
  consultDeliveryEvidence,
  isStandaloneDevelopmentWorkflow,
  isStandaloneReportOnlyWorkflow,
  rowValidationRoute,
  type WorkflowSnapshot,
} from "./workflow.js";
import type { PlanCoordinationOperation } from "./coordination.js";
import type { IntegrationMergeLease } from "./lease.js";
import { normalizeSeverity, type PlanRow } from "./status.js";

/** The same closed direct-coordinator operation union is used on both routes. */
export type CoordinationOperation = PlanCoordinationOperation;

export type ExecutionPlanCall = {
  session?: ExecutionSessionRef;
  expected?: ExecutionToken;
  planId: string;
  operation: CoordinationOperation;
};

export type ExecutionMutationIntent = {
  operationId: string;
  session?: ExecutionSessionRef;
  expected?: ExecutionToken;
};

export type ExecutionPlanIntent<Operation extends CoordinationOperation = CoordinationOperation> =
  ExecutionMutationIntent & { planId: string; operation: Operation };

function resolvePlanAddress(stated: string | undefined, kind: string): string {
  if (isNonEmptyString(stated)) return stated;
  throw new CoordinationError("coordination.invalid-input", "Invalid coordination operation: provide the explicit planId it addresses; inspect plan rows with mstar plan show.", {
    operation_kind: kind,
    path: "planId",
  });
}

/**
 * The control harness root of the store this call transacts on: the directory
 * that owns `store.db`. `StoreContext.harnessDir` is the anchor the store was
 * RESOLVED from, so the root is read back from the store's own path rather than
 * re-derived — the database's location decides where its harness, its plan area
 * and its checkouts are.
 */
function controlHarnessRoot(context: ExecutionContext): string {
  return canonicalizeNearestExisting(dirname(storeDbPath(context)));
}

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
 * trusted caller's OWN live coordinator binding reconstructed from its durable
 * session row (E03/R8/A09 — a projection the caller had to keep is not
 * required), then the plan token that read returned. Every derived fact names a
 * source the engine actually read, and an explicitly supplied value is passed
 * through untouched.
 */
async function resolvePlanIntent<Operation extends CoordinationOperation>(
  context: ExecutionContext,
  request: ExecutionPlanIntent<Operation>,
  operation: Operation,
): Promise<ExecutionPlanRequest<Operation>> {
  const planId = resolvePlanAddress(request.planId, operation.kind);
  if (request.session !== undefined && request.expected !== undefined) {
    return { operationId: request.operationId, session: request.session, expected: request.expected, planId, operation };
  }
  const session = request.session ?? (await resolveSparseOwnSession(context, `a ${operation.kind} plan operation`));
  const expected = request.expected ?? (await readExecutionPlan(context, session, planId)).token;
  return { operationId: request.operationId, session, expected, planId, operation };
}

/**
 * §3/§4.1 the accepted-kind gate shared by the boundary and the operation
 * entries, so no verb can be reached by a kind the closed union does not carry.
 */
function assertPlanOperationAdmissible(kind: string): void {
  if (IMPLEMENTED_OPERATIONS[kind] !== true) {
    throw new CoordinationError("coordination.unknown-operation", "Unknown coordination operation kind; inspect the operation contract with mstar schema.", {
      operation: kind,
    });
  }
}

/**
 * §3/§4.1 the authorization boundary of one DB plan operation.
 *
 * The operation's kind decides which seat may issue it — the SHARED pure rule,
 * so the DB route cannot drift from the file route. Inside one
 * `BEGIN IMMEDIATE` transaction the authority must be active, the trusted
 * caller's own coordinator row is revalidated at the current epoch, the
 * addressed plan is selected under that authority and the supplied token is
 * compared against the plan's exact CAS token. The addressed plan's sealed
 * witness is then handed to the operation's transition, which commits or rolls
 * back with everything above.
 *
 * § One resolver path (S2/E02) an omitted `session` is the trusted caller's OWN
 * live binding reconstructed from its durable row, and an omitted `expected` is
 * the plan token this transaction reads — the two facts the caller would
 * otherwise copy out of a previous read. An explicit value is passed through
 * untouched.
 *
 * A forged caller/role, a revoked or stale-epoch reference, a stale token and a
 * nested call all refuse with no row, revision or receipt change. The
 * transition body receives the owned transaction — the only handle a DB
 * operation may write through — and is synchronous for the same reason
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
    throw new CoordinationError("coordination.invalid-input", "Invalid plan operation: provide an operation with a kind; inspect the operation contract with mstar schema.");
  }
  const planId = resolvePlanAddress(call.planId, operation.kind);
  assertPlanOperationAdmissible(operation.kind);
  assertOperationRole(context.caller, operation.kind);
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

/** §3 the `prepare` member of the closed union. */
export type PrepareOperation = Extract<CoordinationOperation, { kind: "prepare" }>;

/** §3 the `progress` member of the closed union. */
export type ProgressOperation = Extract<CoordinationOperation, { kind: "progress" }>;

/** §3 the `residual-add` member of the closed union. */
export type ResidualAddOperation = Extract<CoordinationOperation, { kind: "residual-add" }>;

/** §3 the `residual-close` member of the closed union. */
export type ResidualCloseOperation = Extract<CoordinationOperation, { kind: "residual-close" }>;

/** §3 the `complete` member of the closed union. */
export type CompleteOperation = Extract<CoordinationOperation, { kind: "complete" }>;

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
 * §3 one resolved plan operation: the validated envelope plus the address the
 * pure reference gate already authorized. Resolving the reference BEFORE the
 * store is opened preserves the precedence of `readExecutionPlan`: a malformed
 * or caller-mismatched reference is refused by itself, never by — or after — an
 * authority-state or store-open failure.
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
  if (!isPlainObject(request)) throw invalidPlanInput("Invalid plan operation: provide a request object; inspect the operation contract with mstar schema.");
  if (!isNonEmptyString(caller?.sessionId)) {
    throw invalidPlanInput("Invalid execution caller: provide a non-empty session identity; inspect the workflow with mstar status validate.");
  }
  const operationId = assertOperationId(request.operationId);
  const planId = request.planId;
  if (!isNonEmptyString(planId)) throw invalidPlanInput("Invalid plan operation: provide the non-empty plan id; inspect plan rows with mstar plan show.");
  assertPlanOperationAdmissible(kind);
  const read = resolvePlanRead(caller, request.session, planId);
  return { call: { ...request, operationId, planId }, read };
}

/** The caller-input refusal of this module (`coordination.invalid-input`). */
function invalidPlanInput(detail: string, details?: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.invalid-input", detail, details);
}

/**
 * §4.1 the running-lifecycle admission of a plan operation, read from the
 * witness: a plan's transitions belong to a lifecycle that is still executing,
 * so a paused, failed, stopped or completed workflow refuses them. The row, its
 * revisions and the operation ledger are untouched by the refusal.
 */
function assertRunningWorkflow(witness: ExecutionPlanWitness): void {
  const status = witness.view.workflow.status;
  if (status !== "running") {
    throw new CoordinationError(
      "coordination.workflow-not-running",
      "The workflow is not running; plan operations require a running lifecycle. Inspect it with mstar status validate.",
      { workflow_id: witness.workflowId, plan_id: witness.planId, status },
    );
  }
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

/** §2.2 one view's stored coordination block, minus the revision that lives in the row column. */
function storedCoordinationOf(view: ExecutionPlanView): Record<string, unknown> {
  const stored: Record<string, unknown> = { ...(view.coordination ?? {}) };
  delete stored.revision;
  return stored;
}

/**
 * §4.1 the sidecar every accepted plan operation returns, naming the transaction
 * boundary the caller can rely on.
 */
function appliedRecovery(witness: ExecutionPlanWitness, kind: string): RecoveryDetails {
  return planRecovery({
    witness,
    kind,
    outcome: "applied",
    commitState: "committed",
    resolvedFrom: [{ path: "planId", source: "intent.explicit" }],
  });
}

/**
 * §2.2/§3 write the addressed plan's coordination block back in ONE statement
 * that also carries the row's state and advances the plan row's revision — the
 * plan token this operation spends its own on. The block is validated by the
 * SHARED stored-shape rules first, so no verb can persist a shape its own
 * validator refuses.
 */
function writeCoordinationBlock(
  tx: ExecutionTransaction,
  witness: ExecutionPlanWitness,
  input: { block: Record<string, unknown>; state?: Record<string, unknown>; what: string },
): void {
  const route = rowValidationRoute(witnessSnapshot(witness), witness.view.plan as unknown as PlanRow);
  assertViolationFree(
    storedCoordinationViolations(input.block, { revision: witness.revision + 1, route, what: input.what }),
    input.what,
  );
  writePlanCoordinationRow(tx, {
    workflowId: witness.workflowId,
    planId: witness.planId,
    state: input.state ?? (witness.view.plan as unknown as Record<string, unknown>),
    coordination: input.block,
    revision: witness.revision + 1,
  });
}

/**
 * §3.1/§4.1 the transaction of ONE accepted plan operation. Inside one
 * `BEGIN IMMEDIATE` transaction: the authority is active, the caller's
 * reference is revalidated against the store's own rows (which also selects the
 * addressed plan), the supplied token's ADDRESS and generation are fenced, a
 * committed receipt is returned for an identical retry whose recorded effect
 * the row still holds, the workflow must still be running, and the supplied
 * token's revision must be the plan's exact CAS. Only then does `run` produce
 * the operation's read, and the transaction's one revision advance has already
 * run: the advance and the receipt are the frame's, so an operation cannot
 * forget either.
 *
 * The caller has already passed the accepted-kind gate and the operation-shape
 * checks; `run` is synchronous for the same reason `withExecutionTransaction`
 * requires it — nothing awaits, launches, reads Git or appends a file between
 * BEGIN and COMMIT.
 */
function withExecutionPlanOperation<T>(
  context: ExecutionContext,
  resolved: ResolvedPlanOperation<CoordinationOperation>,
  requestHash: string,
  preflight: ((witness: ExecutionPlanWitness, tx: ExecutionTransaction) => void) | undefined,
  run: (witness: ExecutionPlanWitness, tx: ExecutionTransaction, at: string) => ExecutionRead<T>,
  alreadySatisfied?: (witness: ExecutionPlanWitness, tx: ExecutionTransaction) => ExecutionRead<T> | undefined,
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
    // §4.1/§4.2 (R6/A09) a committed receipt is served BEFORE any external proof
    // or evidence hash: an identical retry returns the RECORDED receipt verbatim
    // — never re-derived, never with a rewritten timestamp — so a cleaned-up
    // checkout, a moved HEAD or an edited report cannot turn a success into a
    // failure. The caller's own semantic hash is the whole admission here; a
    // reused operation id with a different payload still refuses inside the
    // lookup.
    const replay = readPlanOperationReplay<T>(tx, {
      operationId: request.operationId,
      requestHash,
      workflowId: witness.workflowId,
      planId: witness.planId,
    });
    if (replay !== null) return replay;
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
    assertRunningWorkflow(witness);
    if (!freshness.current) throw stalePlanRowRefusal(witness, freshness, request.operation.kind);
    // §4.1 the verb's own preflight — prepare's admission and actual-checkout
    // validation, completion's captured-witness comparison — runs HERE, after the
    // witness, the receipt conflict, the freshness and the running-lifecycle
    // admission and BEFORE the equality decision and any shared revision or body
    // write. A served replay returns above and never reaches it, so a retry does
    // not re-run Git or re-hash evidence.
    preflight?.(witness, tx);
    // §4.1 an operation whose requested state the row ALREADY holds is decided
    // HERE — after admission, receipt conflict and freshness, but BEFORE the
    // shared revision advance and before the body: nothing about the plan row,
    // the workflow header or the store revision moves for it. Its accepted
    // operation still records its own receipt (that bookkeeping is what makes a
    // later identical retry a replay), and the result carries the
    // `already-satisfied` recovery rather than `applied`.
    const satisfied = alreadySatisfied?.(witness, tx);
    if (satisfied !== undefined) {
      const recovery = planRecovery({
        witness,
        kind: request.operation.kind,
        outcome: "already-satisfied",
        commitState: "none",
        resolvedFrom: [{ path: "planId", source: "intent.explicit" }],
      });
      writePlanOperationReceipt(tx, {
        operationId: request.operationId,
        requestHash,
        workflowId: witness.workflowId,
        planId: witness.planId,
        receipt: { ...satisfied, operationRecovery: recovery },
        now: new Date().toISOString(),
      });
      return { ...satisfied, operationId: request.operationId, replayed: false, recovery };
    }
    const at = new Date().toISOString();
    // §3.1 the ONE revision advance of this accepted multi-domain transaction
    // runs BEFORE the body: a composed mutation (the residual verbs' issue work)
    // joins the shared advance instead of bumping the counter again, so the body
    // must be able to read the revision this transaction commits at.
    advancePlanOperationRevisions(tx, { workflowId: witness.workflowId, now: at });
    const { operationRecovery, ...receipt } = run(witness, tx, at);
    const recovery = operationRecovery ?? appliedRecovery(witness, request.operation.kind);
    writePlanOperationReceipt(tx, {
      operationId: request.operationId,
      requestHash,
      workflowId: witness.workflowId,
      planId: witness.planId,
      receipt: { ...receipt, operationRecovery: recovery },
      now: at,
    });
    return { ...receipt, operationId: request.operationId, replayed: false, recovery };
  });
}

/* ------------------------------------------------------------------------ *
 * §3 `prepare` — ordinary revisable execution configuration
 * ------------------------------------------------------------------------ */

/** Fully defaulted ordinary configuration accepted by coordinator prepare. */
type PreparedInputs = { config: Required<Pick<PlanPrepareConfig, "qaGate" | "findingsCleanup">> & PlanPrepareConfig };

/**
 * Preparation configuration has no Assignment and no plan-body pin. Optional
 * checkout metadata is supplied by the coordinator or inherited from the row;
 * the omitted members keep the safe ordinary defaults.
 */
function readPrepareInputs(call: ExecutionPlanRequest<PrepareOperation>): PreparedInputs {
  const config = call.operation.config ?? {};
  assertExactKeys(config as Record<string, unknown>, ["worktreePath", "workingBranch", "qaGate", "findingsCleanup"], "prepare config");
  if (config.worktreePath !== undefined && (!isNonEmptyString(config.worktreePath) || !isAbsolute(config.worktreePath))) {
    throw invalidPlanInput("Invalid prepare worktreePath: provide an absolute path; retry through mstar plan prepare.");
  }
  if (config.workingBranch !== undefined && !isNonEmptyString(config.workingBranch)) {
    throw invalidPlanInput("Invalid prepare workingBranch: provide a non-empty branch name; retry through mstar plan prepare.");
  }
  if (config.qaGate !== undefined && !["mandatory", "pm-acceptance"].includes(config.qaGate)) {
    throw invalidPlanInput("Invalid prepare qaGate: choose mandatory or pm-acceptance; retry through mstar plan prepare.");
  }
  if (config.findingsCleanup !== undefined && !["zero-residual", "allow-residual"].includes(config.findingsCleanup)) {
    throw invalidPlanInput("Invalid prepare findingsCleanup: choose zero-residual or allow-residual; retry through mstar plan prepare.");
  }
  return { config: { ...config, qaGate: config.qaGate ?? "mandatory", findingsCleanup: config.findingsCleanup ?? "allow-residual" } };
}

/** Refuse assigning any plan row to the branch attached to the control checkout. */
function assertWorkingBranchIsFeature(context: ExecutionContext, workingBranch: string | undefined): void {
  if (workingBranch === undefined) return;
  const controlRoot = controlHarnessRoot(context);
  let repositoryRoot: string | undefined;
  let controlBranch: string | undefined;
  try {
    repositoryRoot = gitRead(controlRoot, ["rev-parse", "--show-toplevel"]);
    if (repositoryRoot !== undefined) controlBranch = gitRead(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    // Bounded Git probe failures are converted below to the actionable refusal.
  }
  if (repositoryRoot === undefined || controlBranch === undefined || controlBranch === "" || controlBranch === "HEAD") {
    throw new CoordinationError(
      "plan.prepare.control-branch-unresolved",
      "Cannot resolve the control checkout branch; provide a valid Git control checkout, then retry through mstar plan prepare.",
      { harness_root: controlRoot },
    );
  }
  if (workingBranch === controlBranch) {
    throw new CoordinationError(
      "plan.prepare.working-branch-control",
      "The working branch is the control checkout branch; record a feature branch, then retry through mstar plan prepare.",
      { working_branch: workingBranch, control_branch: controlBranch },
    );
  }
}

/**
 * §3 `prepare` records the ordinary revisable execution configuration — the
 * explicit scope facts, the QA gate and the findings-cleanup mode — in one
 * transaction, and selects the frozen catalog input the registration pinned. It
 * is OPTIONAL: a row with no prior record completes on the same defaults, so
 * nothing downstream requires a prepare first. A later prepare revises the
 * recorded configuration, including while the row is active; the row's status,
 * progress and completion are never reset.
 *
 * §4.1 the transaction preflight validates the EFFECTIVE scope — the row's
 * recorded worktree/branch with supplied members applied — against actual
 * filesystem and Git before equality or domain writes. Done rows refuse there.
 * An equal valid configuration is `already-satisfied`: plan/header/store
 * revisions do not advance, while its operation receipt is retained with the
 * actual transaction store/epoch so an identical retry can replay it.
 */
export async function prepareExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<PrepareOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "prepare");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "config"], "prepare operation");
  const inputs = readPrepareInputs(resolved.call);
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  return withExecutionPlanOperation<ExecutionPlanView>(
    context,
    resolved,
    requestHash,
    (witness) => {
      // §4.1 admission and actual-scope validation both run on the first attempt,
      // before any write. `validateEffectiveScope` resolves the row's recorded
      // scope, applies the supplied members and checks THAT against Git — a
      // mistaken prior value stays revisable, and a supplied value is never an
      // exemption from the check.
      assertPrepareAdmission({ planId: witness.planId, row: witness.view.plan as PlanRow });
      const effective = effectiveScope(witness.view, inputs.config);
      assertWorkingBranchIsFeature(context, effective.workingBranch);
      if (effective.worktreePath !== undefined) {
        validateSuppliedCheckout(effective.worktreePath, effective.workingBranch, witness.planId);
      }
    },
    (witness, tx, at) => writePreparedConfig(context, resolved.read, inputs, witness, tx, at),
    (witness, tx) => alreadyPrepared(witness.view, inputs, witness.token, tx),
  );
}

/**
 * §4.1 the `already-satisfied` verdict of one `prepare`: the row ALREADY records
 * exactly this configuration and its requested checkout, so the frame decides it
 * before its shared revision advance — no row, header or store revision moves,
 * and the result expresses the no-op as `already-satisfied` rather than
 * `applied`. Its envelope is the REAL transaction identity (the same store and
 * epoch the frame commits the no-op receipt in), never a fabricated one.
 * Admission (a `Done` row) and the checkout validation are the caller's
 * preflight's, and both have already run by the time this is consulted.
 */
function alreadyPrepared(
  view: ExecutionPlanView,
  inputs: PreparedInputs,
  token: ExecutionToken,
  tx: ExecutionTransaction,
): ExecutionRead<ExecutionPlanView> | undefined {
  const prior = view.coordination?.prepared;
  if (prior === undefined) return undefined;
  if (prior.qa_gate !== inputs.config.qaGate || prior.findings_cleanup !== inputs.config.findingsCleanup) {
    return undefined;
  }
  const effective = effectiveScope(view, inputs.config);
  const metadata = isPlainObject((view.plan as unknown as Record<string, unknown>).metadata)
    ? ((view.plan as unknown as Record<string, unknown>).metadata as Record<string, unknown>)
    : {};
  const recordedWorktree = isNonEmptyString(metadata.worktree_path) ? canonicalTarget(metadata.worktree_path) : undefined;
  const recordedBranch = isNonEmptyString(metadata.working_branch) ? metadata.working_branch : undefined;
  if (effective.worktreePath !== recordedWorktree || effective.workingBranch !== recordedBranch) return undefined;
  return { data: view, token, storeId: tx.storeId, epoch: tx.epoch };
}

/**
 * The scope one `prepare` actually asks for: the row's recorded worktree/branch
 * with the supplied members applied. Omitted members fall back to the row, so
 * `workingBranch`-only and `worktreePath`-only edits are validated against the
 * same pair they commit.
 */
function effectiveScope(
  view: ExecutionPlanView,
  config: PlanPrepareConfig,
): { worktreePath: string | undefined; workingBranch: string | undefined } {
  const metadata = isPlainObject((view.plan as unknown as Record<string, unknown>).metadata)
    ? ((view.plan as unknown as Record<string, unknown>).metadata as Record<string, unknown>)
    : {};
  const recordedWorktree = isNonEmptyString(metadata.worktree_path) ? canonicalTarget(metadata.worktree_path) : undefined;
  const recordedBranch = isNonEmptyString(metadata.working_branch) ? metadata.working_branch : undefined;
  return {
    worktreePath: config.worktreePath === undefined ? recordedWorktree : canonicalTarget(config.worktreePath),
    workingBranch: config.workingBranch ?? recordedBranch,
  };
}

/** The writing half of `prepare`, once the preflight admitted it. */
function writePreparedConfig(
  context: ExecutionContext,
  read: ResolvedPlanRead,
  inputs: PreparedInputs,
  witness: ExecutionPlanWitness,
  tx: ExecutionTransaction,
  at: string,
): ExecutionRead<ExecutionPlanView> {
  const { planId, workflowId } = read;
  const plan = witness.view.plan as PlanRow;
  const storedMetadata = isPlainObject(plan.metadata) ? plan.metadata : {};
  const nextWorktree = inputs.config.worktreePath === undefined
    ? (isNonEmptyString(storedMetadata.worktree_path) ? canonicalTarget(storedMetadata.worktree_path) : undefined)
    : canonicalTarget(inputs.config.worktreePath);
  const nextBranch = inputs.config.workingBranch ??
    (isNonEmptyString(storedMetadata.working_branch) ? storedMetadata.working_branch : undefined);
  assertCatalogExecutionCommittedOn(tx.db, workflowId);
  const sealed = readExecutionSealedInput(tx, workflowId, planId);
  if (sealed.pin !== null && sealed.pin.store_id !== tx.storeId) {
    throw new ExecutionPinConflictError(
      `plan ${planId}'s recorded catalog identity belongs to another store`,
      { workflow_id: workflowId, plan_id: planId, store_id: tx.storeId },
    );
  }
  const pin = selectCatalogPinOn(catalogPinFactsOn(tx.db, tx.storeId, workflowId, planId), sealed.inputHash);
  const metadata: Record<string, unknown> = { ...storedMetadata };
  if (nextWorktree !== undefined) metadata.worktree_path = nextWorktree;
  if (nextBranch !== undefined) metadata.working_branch = nextBranch;
  const prepared: PreparedCoordination = {
    qa_gate: inputs.config.qaGate,
    findings_cleanup: inputs.config.findingsCleanup,
    prepared_by: witness.session.sessionId,
    prepared_at: at,
  };
  writeExecutionInputPin(tx, { workflowId, planId, pin });
  writeCoordinationBlock(tx, witness, {
    block: { ...storedCoordinationOf(witness.view), prepared },
    state: { ...(witness.view.plan as Record<string, unknown>), metadata },
    what: `plan ${planId} coordination`,
  });
  const committed = readExecutionPlanWitness(tx, read);
  return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
}

/**
 * §4.1 validate the checkout and branch a `prepare` actually ASKS FOR, against
 * the filesystem and Git: the worktree must be a readable Git worktree, must
 * carry no unfinished Git operation and no uncommitted change, and — when a
 * branch is supplied — must be ON that branch. The stored metadata is then a
 * fact about a real checkout rather than a caller's string.
 */
function validateSuppliedCheckout(worktreePath: string, workingBranch: string | undefined, planId: string): void {
  const repository = canonicalTarget(worktreePath);
  const head = gitRead(repository, ["rev-parse", "HEAD"]);
  if (head === undefined) {
    throw new CoordinationError(
      "coordination.not-in-git",
      "Prepare requires the supplied worktreePath to be a readable Git worktree; inspect it with mstar worktree check.",
      { plan_id: planId, worktree_path: worktreePath },
    );
  }
  const dirty = gitRead(repository, ["status", "--porcelain"]);
  if (dirty === undefined) {
    throw new CoordinationError(
      "coordination.not-in-git",
      "Prepare cannot read the Git state of the supplied worktreePath; inspect it with mstar worktree check.",
      { plan_id: planId, worktree_path: worktreePath },
    );
  }
  if (dirty.length > 0) {
    throw gitProof(`prepare requires a clean supplied worktree \u2014 ${worktreePath} has uncommitted changes`, {
      plan_id: planId,
      worktree_path: worktreePath,
      head,
    });
  }
  if (workingBranch === undefined) return;
  const branch = gitRead(repository, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== workingBranch) {
    throw gitProof(
      `prepare requires the supplied worktreePath ${worktreePath} to be on the supplied workingBranch ${workingBranch} \u2014 got ` +
        `${branch || "a detached HEAD"}`,
      { plan_id: planId, expected: workingBranch, actual: branch },
    );
  }
  if (gitRead(repository, ["rev-parse", `refs/heads/${workingBranch}`]) === undefined) {
    throw gitProof(`prepare requires refs/heads/${workingBranch} to exist in ${worktreePath}`, {
      plan_id: planId,
      working_branch: workingBranch,
      worktree_path: worktreePath,
    });
  }
}

/**
 * §3 the ordinary execution configuration one plan completes on: its own
 * recorded configuration, or the safe defaults for a row that was never
 * prepared. Prepare is optional and defaults apply, so no completion requires a
 * prior prepare record.
 */
function effectivePrepareConfig(view: ExecutionPlanView): PreparedCoordination {
  return view.coordination?.prepared ?? {
    qa_gate: "mandatory",
    findings_cleanup: "allow-residual",
    prepared_by: "",
    prepared_at: "",
  };
}

/* ------------------------------------------------------------------------ *
 * §3 `progress` — the row's status, summary, evidence and track branches
 * ------------------------------------------------------------------------ */

/**
 * §3 `progress` on the DB authority: the workflow's coordinator moves the
 * addressed row's status, summary and reported branches against the plan token
 * it read. There is no plan session and no holder proof: the coordinator
 * binding and the row CAS are the whole admission. The shared rules decide the
 * status transition and the track-branch scope, so the DB route refuses exactly
 * what the file route refuses, and no progress copies a newer catalog title,
 * path or reference into the plan's sealed input.
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
  const { planId } = resolved.read;
  // §D the areas a plan's own evidence may live in: derived from the harness
  // root this store lives in, never from a caller-supplied path.
  const planAreas = planAreaRoots(controlHarnessRoot(context), planId);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, undefined, (witness, tx) => {
    const state = witness.view.plan as Record<string, unknown>;
    const plan = state as PlanRow;
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

/**
 * §3.1 the plan-revision advance of one accepted plan operation whose body does
 * not otherwise write the addressed row. The plan row's revision IS the plan
 * CAS, so an operation with domain work in another authority (the residual
 * verbs' issue work) advances it exactly once, in this transaction, before the
 * receipt's read.
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
      "Invalid residual-add entries; correct each reported problem, then retry through mstar plan issue-add.",
      { problems },
    );
  }
  return derived;
}

/**
 * §3 `residual-add` on the DB authority: the coordinator captures each residual
 * and links it to this plan, in the SAME transaction that commits the
 * workflow/store revisions and the operation receipt.
 *
 * The issue work is composed, never re-entered: `captureIssueOn` /
 * `linkIssueScopedOn` take this transaction's own handle, so there is no nested
 * `BEGIN` and no second connection. Any refusal anywhere in the loop rolls back
 * every entry, the receipt and the revision advance together. The plan row's
 * state is untouched (a residual lives in the issue authority) while its
 * REVISION still advances once.
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
    throw invalidPlanInput("Invalid residual-add request: provide at least one entry; retry through mstar plan issue-add.");
  }
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  const actor = issueWriteSeat(context.caller.role);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, undefined, (witness, tx) => {
    assertRunningWorkflow(witness);
    assertIssueStoreActive(tx.db);
    // §G2a the project bucket is the ADDRESSED ROW's own `metadata.project_id`
    // (validated as a safe path component), falling back to `_default`, never the
    // workflow header's: a residual captured on this row must keep its own
    // project provenance even when the workflow declares another one.
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
        { operationId: residualCaptureOperationId(sessionId, planId, occurrenceKey), actor },
        composed,
      );
      // Always link, never only on `created`: the plan link is the gate a later
      // residual-close is checked against, and both verbs are idempotent, so a
      // retry converges instead of leaving an unlinked issue the plan can never
      // close.
      linkIssueScopedOn(
        tx.db,
        capture.issueId,
        { kind: "plan", target: planId },
        { operationId: residualLinkOperationId(sessionId, planId, occurrenceKey), actor, expectedRevision: capture.revision },
        composed,
      );
    }
    advancePlanRowRevision(tx, witness);
    const committed = readExecutionPlanWitness(tx, resolved.read);
    return { data: committed.view, token: committed.token, storeId: tx.storeId, epoch: tx.epoch };
  });
}

/**
 * §3 `residual-close` on the DB authority: the coordinator closes ONE finding
 * linked to this plan, under the issue revision the caller read, in the same
 * transaction as the receipt and the revision advance — the plan row's own CAS
 * revision included, exactly as a residual-add advances it.
 *
 * Two refusals protect the scope and the CAS: an issue that is not linked to
 * THIS plan refuses `issue.scope-refused`, and an `expectedIssueRevision` that
 * is not the issue's current revision refuses `issue.revision-conflict`. Both
 * leave the issue, its history, the plan token and the operation ledger
 * untouched.
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
    throw invalidPlanInput("Invalid residual-close request: provide a non-empty issueId; retry through mstar plan issue-close.");
  }
  if (!Number.isInteger(operation.expectedIssueRevision) || operation.expectedIssueRevision < 0) {
    throw invalidPlanInput(
      "Invalid expectedIssueRevision: provide a nonnegative integer matching the observed issue revision; inspect the issue with mstar issue show.", {
        expected_issue_revision: operation.expectedIssueRevision,
      },
    );
  }
  assertTerminalDisposition(operation.disposition);
  assertClosureAuthority(operation.disposition, operation.evidence);
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  const actor = issueWriteSeat(context.caller.role);
  return withExecutionPlanOperation<ExecutionPlanView>(context, resolved, requestHash, undefined, (witness, tx) => {
    assertRunningWorkflow(witness);
    assertIssueStoreActive(tx.db);
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
 * §E the delivery route and completion proof rules
 * ------------------------------------------------------------------------ */

/**
 * §E the delivery route one workflow snapshot declares, as the shared
 * classifiers read it. `report-only` and `development` are the single-row
 * standalone shapes; everything else is an iteration row that delivers through
 * the workflow's own integration merge.
 */
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
 * §D/§E one plan's own scope as the addressed ROW records it: the plan worktree
 * and branch an authorized `prepare` recorded into `metadata`. The DB route has
 * no resolved file scope — the row IS the scope — so every Git proof below is
 * taken against what this plan recorded, never against a caller-supplied path.
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
        `metadata.working_branch a non-empty branch); record it with plan prepare, then retry`,
      { plan_id: planId, worktree_path: worktree ?? null, working_branch: branch ?? null },
    );
  }
  return { worktreePath: canonicalTarget(worktree), workingBranch: branch };
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
 * the same projection from `readExecutionState`, which is how the
 * pre-transaction Git proofs and the route decision see the plan rows and the
 * merge lease.
 */
async function readWorkflowSnapshot(context: ExecutionContext, workflowId: string): Promise<WorkflowSnapshot> {
  const state = await readExecutionState(context);
  const workflow = state.data.workflows.find((candidate) => candidate.state.id === workflowId);
  if (workflow === undefined) {
    throw new CoordinationError("coordination.plan-not-found", "The workflow is not registered; inspect registered workflows with mstar status validate.", {
      workflow_id: workflowId,
    });
  }
  return workflowSnapshotOf({
    state: workflow.state,
    plans: workflow.plans,
    integrationLease: workflow.integrationLease,
  });
}

/**
 * §E the report-only route's completion evidence: the workflow must RECORD the
 * fulfilment of its registered completion policy. `consultDeliveryEvidence`
 * owns the completeness rule, so this route cannot invent a second one.
 */
function assertReportOnlyCompletionEvidence(snapshot: WorkflowSnapshot, planId: string): void {
  const failure = consultDeliveryEvidence(snapshot).find((entry) => !entry.ok);
  if (failure !== undefined) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      "The transition requires matching report-only completion evidence; inspect the workflow with mstar status validate.",
      {
        message: failure.message,
        plan_id: planId,
        code: failure.code,
      },
    );
  }
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
      "The transition requires the pinned delivery route to be proven before the transaction; inspect the workflow with mstar status validate.",
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

type CompletionEvidenceRefs = {
  qc: CompletionRecord["qc"];
  qa: CompletionRecord["qa"];
};

/**
 * §E the recorded evidence of one completion, hashed from disk. It runs BEFORE
 * SQLite ownership because hashing reads files (§4.1), and the returned refs are
 * the provenance the completion record commits.
 */
function completionEvidenceRefs(evidence: ValidatedCompletionEvidence): CompletionEvidenceRefs {
  return {
    qc: {
      decision: evidence.qc_decision,
      reports: evidence.qc_reports.map(evidenceRefOf),
      consolidated: evidenceRefOf(evidence.qc_consolidated),
    },
    qa: { gate: evidence.qa_gate, decision: evidence.qa_decision, report: evidenceRefOf(evidence.qa_report) },
  };
}

/**
 * §E the completion delta of one direct coordinator completion: `Done`, the
 * retained branch/worktree metadata, the completion record and the release of
 * this attempt's own merge claim — in the SAME transaction, because a
 * half-applied completion is exactly the state a crash must never leave.
 *
 * No registry or catalog row is deleted or rewritten here: the plan stays a
 * member of its workflow (its own terminal close is the workflow transition's),
 * and completion only changes membership in the PLAN's lifecycle.
 */
function applyCompletion(input: {
  tx: ExecutionTransaction;
  witness: ExecutionPlanWitness;
  planId: string;
  record: CompletionRecord;
  scope: PlanScope | null;
  at: string;
  what: string;
}): void {
  const { tx, witness, planId, record, at, what } = input;
  const plan = witness.view.plan as unknown as Record<string, unknown>;
  const metadata = { ...(isPlainObject(plan.metadata) ? plan.metadata : {}) };
  // The retained metadata is what authorizes cleanup afterwards.
  if (input.scope !== null) {
    metadata.worktree_path = input.scope.worktreePath;
    metadata.working_branch = input.scope.workingBranch;
  }
  writeCoordinationBlock(tx, witness, {
    block: { ...storedCoordinationOf(witness.view), completion: record },
    state: { ...plan, status: "Done", metadata },
    what,
  });
  // Only this attempt's own claim is released: a merge lease naming another plan
  // or another source branch is not this completion's to drop (spec §E).
  const lease = witness.view.integrationLease;
  const claim =
    lease !== null && lease.plan_id === planId && lease.source_branch === (record.source_branch ?? "") ? lease : undefined;
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
 * §E the recorded source proof of one plan's own delivery, from the ROW's
 * recorded scope: the checkout is a clean Git worktree, its HEAD is the pinned
 * source commit, it is on the recorded/registered source branch, that branch's
 * tip is the same commit, and the reviewed range is an ancestry of it. Used by
 * BOTH the standalone development route and the iteration (integration) route,
 * so a row can never complete against a merge of a commit unrelated to its own
 * feature branch or its reviewed commit. `worktreePath` is always the row's own
 * recorded scope — never a caller-supplied path.
 */
function assertSourceReviewProof(
  worktreePath: string,
  shas: { source_sha: string | null; review_base: string | null; review_head: string | null },
  sourceBranch: string,
  planId: string,
): { source_sha: string; review_base: string; review_head: string } {
  const sourceSha = shas.source_sha;
  const reviewBase = shas.review_base;
  const reviewHead = shas.review_head;
  if (sourceSha === null || reviewBase === null || reviewHead === null) {
    throw invalidPlanInput("Complete on this route requires evidence.source_sha, review_base, and review_head; retry through mstar workflow evidence.");
  }
  assertFeatureCheckout(worktreePath, sourceSha, "complete", planId);
  if (reviewHead !== sourceSha) {
    throw gitProof(`complete requires review_head to be the pinned source ${sourceSha} \u2014 got ${reviewHead}`, {
      plan_id: planId,
      source_sha: sourceSha,
      review_head: reviewHead,
    });
  }
  const branch = gitRead(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== sourceBranch) {
    throw gitProof(
      `complete requires the plan worktree ${worktreePath} to be on ${sourceBranch} \u2014 got ${branch || "a detached HEAD"}`,
      { plan_id: planId, expected: sourceBranch, actual: branch },
    );
  }
  const refTip = gitRead(worktreePath, ["rev-parse", `refs/heads/${sourceBranch}`]);
  if (refTip !== sourceSha) {
    throw gitProof(
      `complete requires refs/heads/${sourceBranch} to resolve to the pinned source ${sourceSha} \u2014 got ${refTip || "missing"}`,
      { plan_id: planId, expected: sourceSha, actual: refTip },
    );
  }
  if (!gitObjectExists(worktreePath, reviewBase)) {
    throw gitProof(`complete review base ${reviewBase} is not a commit of ${worktreePath}`, {
      plan_id: planId,
      review_base: reviewBase,
    });
  }
  const ancestry = gitRead(worktreePath, ["merge-base", "--is-ancestor", reviewBase, reviewHead]);
  if (ancestry === undefined) {
    throw gitProof(`complete review range ${reviewBase}..${reviewHead} is not an ancestry`, {
      plan_id: planId,
      review_base: reviewBase,
      review_head: reviewHead,
    });
  }
  return { source_sha: sourceSha, review_base: reviewBase, review_head: reviewHead };
}

/**
 * §E the EXACT merge proof of one iteration completion (contract line 162): the
 * named result commit exists in the recorded integration repository, its HEAD is
 * that commit, its two parents are exactly `[base_sha, source_sha]` in that
 * order, `base_sha` and `source_sha` are objects, and the result is reachable
 * from the observed integration HEAD. `integrationProof`'s broader `proven`
 * classification — which admits the base itself when the source is already an
 * ancestor — is NOT sufficient here: the direct operation names the already
 * performed serial merge, so a no-merge result is refused rather than accepted
 * as an implicit exemption.
 */
function assertExactMergeResult(
  path: string,
  planId: string,
  result: string,
  baseSha: string,
  sourceSha: string,
  head: string,
): string {
  if (!gitObjectExists(path, result) || !gitObjectExists(path, baseSha) || !gitObjectExists(path, sourceSha)) {
    throw integrationDiverged(
      `plan ${planId} recorded result ${result} is not an object of ${path} together with its base ${baseSha} and source ${sourceSha}`,
      { plan_id: planId, result, base: baseSha, source: sourceSha, path },
    );
  }
  if (!gitObjectExists(path, head)) {
    throw integrationDiverged(`plan ${planId} integration HEAD ${head} is not an object of ${path}`, {
      plan_id: planId,
      head,
      path,
    });
  }
  const parentsLine = gitRead(path, ["rev-list", "--parents", "-n", "1", result]);
  const parents =
    parentsLine === undefined
      ? undefined
      : parentsLine
          .trim()
          .split(/\s+/)
          .slice(1);
  if (parents === undefined || parents.length !== 2 || parents[0] !== baseSha || parents[1] !== sourceSha) {
    throw integrationDiverged(
      `plan ${planId} recorded result ${result} carries parents ${JSON.stringify(parents ?? null)}, expected the exact two-parent merge [${baseSha}, ${sourceSha}] \u2014 ` +
        `a direct completion names the serial merge that was performed, so a no-merge base is refused`,
      { plan_id: planId, result, base: baseSha, source: sourceSha, parents: parents ?? null },
    );
  }
  if (gitRead(path, ["merge-base", "--is-ancestor", result, head]) === undefined) {
    throw integrationDiverged(
      `plan ${planId} recorded result ${result} is not reachable from the integration HEAD ${head}`,
      { plan_id: planId, result, head, path },
    );
  }
  return result;
}

/**
 * §E the completion admission of one row (contract §Operation semantics
 * `complete`): the reviewed state is `InReview`, or `InProgress` recorded as
 * `InReview` by THIS SAME transaction — the entailed bookkeeping the completion
 * delta already writes — so a complete coordinator never needs a separate
 * `progress` call first. `Todo`, `Blocked` and `Done` are refused, and the
 * refusal names the transition that reaches them.
 */
function requireCompletableStatus(row: PlanRow, planId: string): void {
  const status = rowStatusOf(row);
  if (status === "InReview" || status === "InProgress") return;
  throw new CoordinationError(
    "coordination.plan-status",
    `complete requires plan ${planId} in InReview or InProgress (the completion records the entailed InReview itself), not ` +
      `${status || "no status"}; move it with plan progress first`,
    { plan_id: planId, status, allowed: ["InReview", "InProgress"] },
  );
}

/**
 * §4.1 the findings-cleanup gate of one row, on the transaction the caller
 * ALREADY owns: the authoritative open issues linked to the plan are read
 * through this transaction's own handle, so an issue captured after the
 * preflight refuses the completion instead of being judged against a stale
 * list. The mode is the row's effective configuration. Only the SHARED gate's
 * decision table is reused; the read is this handle's, and it fails closed on a
 * staged or unreadable store.
 */
function assertFindingsClosedOn(tx: ExecutionTransaction, planId: string, prepared: PreparedCoordination): void {
  const meta = tx.db.prepare("select authority_state as authorityState from store_meta where id = 1").get() as
    | { authorityState?: unknown }
    | undefined;
  if (meta?.authorityState !== "active") {
    throw new CoordinationError(
      "coordination.store",
      "The plan cannot proceed: the issue store authority is unreadable; inspect the store with mstar status validate.",
      {
        authority_state: typeof meta?.authorityState === "string" ? meta.authorityState : "unreadable",
        plan_id: planId,
        findings_cleanup: prepared.findings_cleanup,
      },
    );
  }
  const rows = tx.db
    .prepare(
      "select issues.id as id, issues.severity as severity from issues " +
        "join provenance on provenance.issue_id = issues.id and provenance.kind = 'plan' and provenance.target = ? and provenance.origin = 'scoped' " +
        "where issues.disposition = 'open' order by issues.id asc",
    )
    .all(planId) as Array<{ id: string; severity: string }>;
  const mode = prepared.findings_cleanup === "zero-residual" ? "zero-residual" : "allow-residual";
  const blocking = rows.filter((row) => normalizeSeverity(row.severity) === "critical" || mode === "zero-residual");
  if (blocking.length === 0) return;
  throw new CoordinationError(
    "coordination.findings-open",
    "The plan cannot proceed while findings are open; close them with mstar plan issue-close.",
    {
      blocking: blocking.map((row) => `${row.id} (${row.severity})`),
      plan_id: planId,
      findings_cleanup: mode,
      findings: blocking.map((row) => row.id),
    },
  );
}

/** Test-only hook to observe the preflight→commit gap of a DB completion. */
let completeWitnessGapForTest: (() => void) | undefined;
export function setCompleteWitnessGapForTest(callback: (() => void) | undefined): void {
  completeWitnessGapForTest = callback;
}

/**
 * §3 `complete` on the DB authority: a single direct coordinator operation. It
 * re-proves the pinned evidence, the recorded result and the route, then applies
 * the completion delta as ONE transaction — `Done`, the completion record and
 * the released own merge claim commit together or not at all.
 *
 * §4.1 RECEIPT REPLAY runs FIRST, before any Git command or evidence hash: the
 * frame's request fingerprint (published semantic selection, which excludes
 * transport freshness) is compared against the committed operation ledger inside
 * the write transaction, and an identical retry returns the RECORDED receipt
 * verbatim — Git never re-runs, the reports are never re-hashed and
 * `completed_at` is never rewritten, so a cleaned-up checkout or a moved HEAD
 * cannot turn a success into a failure. Only a first attempt reaches the
 * preflight below; the `completeWitnessGapForTest` seam still observes that
 * preflight→commit gap.
 *
 * The route selects which proof is REQUIRED, and both the route/policy pair and
 * the actual anchors are re-derived from the transaction's own snapshot so a
 * workflow-header write in the window cannot leave completion judged against
 * obsolete anchors:
 *
 * - a single-row `verification/report-only` workflow completes on its QC/QA
 *   evidence plus the EXPLICITLY RECORDED fulfilment of its declared completion
 *   policy, needs no source, integration or merge, and rejects integration input;
 * - a single-row `development` workflow completes on its QC/QA evidence and its
 *   registered source branch: the row worktree is clean, on that branch and at
 *   the pinned source commit, with the review range an ancestry;
 * - every other route additionally requires `integration: { base_sha, result_sha }`
 *   naming the serial merge the coordinator ACTUALLY performed, proven as the
 *   exact two-parent merge of base+source reachable from the observed
 *   integration HEAD — and the row's OWN feature checkout, ref and reviewed
 *   ancestry are proven in the same operation.
 *
 * §4.1/§7 every external Git read and every evidence hash happens before SQLite
 * ownership, and the Git witnesses they produced are re-read immediately before
 * the commit; `assertFindingsClosed` is re-run through this transaction's own
 * handle so an issue opened in the window refuses instead of committing a stale
 * decision.
 */
export async function completeExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanRequest<CompleteOperation>,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const resolved = resolvePlanOperationRequest(context.caller, request, "complete");
  const operation = resolved.call.operation;
  assertExactKeys(operation as unknown as Record<string, unknown>, ["kind", "evidence", "integration"], "complete operation");
  const requestHash = planOperationRequestHash(context.caller, resolved.read, operation);
  // §4.1/§4.2 (R6/A09/A12) RECEIPT-FIRST: a committed receipt for this exact
  // semantic request is served on the READ route, before any Git command or
  // evidence hash. An identical retry therefore never re-runs Git and never
  // fails because the committed checkout, HEAD or report moved in the meantime.
  const replayed = await readPlanOperationReplayBeforeProof<ExecutionPlanView>(context, resolved.read, {
    operationId: resolved.call.operationId,
    requestHash,
  });
  if (replayed !== null) return replayed;
  // §4.1 the external half, FIRST ATTEMPT only: read the workflow snapshot and
  // capture the Git witnesses before SQLite ownership. `completeWitnessGap`
  // observes the gap between this captured proof and the commit, where the frame
  // re-validates every witness, re-derives the route/policy pair from its own
  // snapshot and re-checks the authoritative issues.
  const witnesses = await captureCompletionWitnesses(context, resolved.read, operation);
  // §4.1 the completion race seam fires HERE — after the external witnesses are
  // captured and BEFORE the committing `BEGIN IMMEDIATE` opens — so a regression can
  // land an independent workflow-header, issue-store or Git mutation in the real gap
  // the write frame then re-reads and re-validates.
  completeWitnessGapForTest?.();
  return withExecutionPlanOperation<ExecutionPlanView>(
    context,
    resolved,
    requestHash,
    () => {
      // §4.1 the commit-boundary re-check: every Git witness captured before the
      // race seam is re-read here, inside the write transaction, so a checkout,
      // ref or HEAD that moved in the gap refuses instead of committing a stale
      // proof.
      for (const captured of witnesses.git) revalidateGitProofWitness(captured);
    },
    (witness, tx, at) => completeInTransaction(witness, tx, at, resolved.read, operation, witnesses),
  );
}

/** External proof and evidence observations reused by the first-attempt commit. */
type CompletionWitnesses = {
  git: readonly GitProofWitness[];
  planAreas: readonly string[];
  evidenceRefs: CompletionEvidenceRefs;
};

/**
 * §4.1 the pre-transaction half of `complete`: the route/policy pair, the actual
 * anchors and the Git witnesses, all read before SQLite ownership. Nothing here
 * is authority on its own — the transaction re-derives the route and anchors from
 * its own snapshot and re-validates each witness immediately before the commit,
 * so a header write or a moved checkout in the window refuses rather than
 * committing a stale proof.
 */
async function captureCompletionWitnesses(
  context: ExecutionContext,
  read: ResolvedPlanRead,
  operation: CompleteOperation,
): Promise<CompletionWitnesses> {
  const before = await readExecutionPlan(context, read.planId);
  const snapshot = await readWorkflowSnapshot(context, read.workflowId);
  const route = deliveryRouteOf(snapshot);
  if (route === "integration" && operation.integration === undefined) {
    throw invalidPlanInput(
      "Complete on the integration route requires integration.base_sha and integration.result_sha for the performed serial merge; inspect the workflow with mstar status validate.",
      { plan_id: read.planId, missing: "integration" },
    );
  }
  assertNoIntegrationContamination({ snapshot, planId: read.planId, integration: operation.integration, what: "complete" });
  const row = before.data.plan as unknown as PlanRow;
  const evidence = readCompletionEvidence(operation.evidence, rowValidationRoute(snapshot, row));
  const prepared = effectivePrepareConfig(before.data);
  assertCompletionReviewDecision(evidence, read.planId, prepared.qa_gate);
  const planAreas = planAreaRoots(controlHarnessRoot(context), read.planId);
  assertEvidenceInsidePlanArea(planAreas, evidence.evidence_paths);
  const evidenceRefs = completionEvidenceRefs(evidence);
  if (route === "report-only") {
    assertReportOnlyCompletionEvidence(snapshot, read.planId);
    return { git: [], planAreas, evidenceRefs };
  }
  const scope = planScopeOf(before.data, read.planId);
  if (route === "development") {
    const anchors = standaloneDeliveryAnchors(snapshot, read.planId);
    if (scope.workingBranch !== anchors.sourceBranch) {
      throw new CoordinationError(
        "coordination.scope-mismatch",
        "Complete requires the recorded working branch to match the registered delivery source; inspect the plan with mstar plan show.",
        { plan_id: read.planId, expected: anchors.sourceBranch, actual: scope.workingBranch },
      );
    }
    assertSourceReviewProof(scope.worktreePath, evidence, anchors.sourceBranch, read.planId);
    return { git: [captureGitProofWitness(scope.worktreePath)], planAreas, evidenceRefs };
  }
  const anchors = integrationAnchors(snapshot, read.planId);
  const checkout = assertIntegrationCheckout(anchors, read.planId);
  const requested = operation.integration!;
  const proven = assertSourceReviewProof(scope.worktreePath, evidence, scope.workingBranch, read.planId);
  assertExactMergeResult(anchors.worktreePath, read.planId, requested.result_sha, requested.base_sha, proven.source_sha, checkout.head);
  return {
    planAreas,
    evidenceRefs,
    git: [
      captureGitProofWitness(scope.worktreePath),
      captureGitProofWitness(anchors.worktreePath, "coordination.integration-diverged"),
    ],
  };
}

/** The first-attempt body of `complete`: the frame has already replayed a committed receipt. */
function completeInTransaction(
  witness: ExecutionPlanWitness,
  tx: ExecutionTransaction,
  at: string,
  read: ResolvedPlanRead,
  operation: CompleteOperation,
  witnesses: CompletionWitnesses,
): ExecutionRead<ExecutionPlanView> {
  const planId = witness.planId;
  // §E admission: the reviewed state is already recorded (`InReview`) or the one
  // this same write unit entails from `InProgress` (`InProgress → InReview → Done`
  // is ONE delta, so no separate progress call is required). `Todo`, `Blocked`
  // and `Done` refuse with the transition that reaches them.
  requireCompletableStatus(witness.view.plan as unknown as PlanRow, planId);
  const snapshot = witnessSnapshot(witness);
  const route = deliveryRouteOf(snapshot);
  if (route === "integration" && operation.integration === undefined) {
    throw invalidPlanInput(
      "Complete on the integration route requires integration.base_sha and integration.result_sha for the performed serial merge; inspect the workflow with mstar status validate.",
      { plan_id: planId, missing: "integration" },
    );
  }
  assertNoIntegrationContamination({ snapshot, planId, integration: operation.integration, what: "complete" });
  const row = witness.view.plan as unknown as PlanRow;
  const evidence = readCompletionEvidence(operation.evidence, rowValidationRoute(snapshot, row));
  const prepared = effectivePrepareConfig(witness.view);
  assertCompletionReviewDecision(evidence, planId, prepared.qa_gate);
  // Revalidate aliases/existence after the proof gap, before committing captured
  // evidence. Body hashes stay outside SQLite ownership and committed replays.
  assertEvidenceInsidePlanArea(witnesses.planAreas, evidence.evidence_paths);
  const refs = witnesses.evidenceRefs;
  const scope = route === "report-only" ? null : planScopeOf(witness.view, planId);
  const record: CompletionRecord = {
    source_branch: scope === null ? null : scope.workingBranch,
    source_sha: evidence.source_sha,
    worktree_path: scope === null ? null : scope.worktreePath,
    review_base: evidence.review_base,
    review_head: evidence.review_head,
    qc: refs.qc,
    qa: refs.qa,
    completed_by: witness.session.sessionId,
    completed_at: at,
  };
  if (route === "report-only") {
    // §E no Git and no integration proof is invented here: the workflow must
    // already RECORD the fulfilment of its registered completion policy.
    assertReportOnlyCompletionEvidence(snapshot, planId);
  } else if (route === "development") {
    const anchors = standaloneDeliveryAnchors(snapshot, planId);
    if (scope!.workingBranch !== anchors.sourceBranch) {
      throw new CoordinationError(
        "coordination.scope-mismatch",
        "Complete requires the recorded working branch to match the registered delivery source; inspect the plan with mstar plan show.",
        { plan_id: planId, expected: anchors.sourceBranch, actual: scope!.workingBranch },
      );
    }
    const proven = assertSourceReviewProof(scope!.worktreePath, evidence, anchors.sourceBranch, planId);
    record.source_sha = proven.source_sha;
    record.review_base = proven.review_base;
    record.review_head = proven.review_head;
  } else {
    const anchors = integrationAnchors(snapshot, planId);
    const checkout = assertIntegrationCheckout(anchors, planId);
    const requested = operation.integration!;
    const proven = assertSourceReviewProof(scope!.worktreePath, evidence, scope!.workingBranch, planId);
    const resultSha = assertExactMergeResult(
      anchors.worktreePath,
      planId,
      requested.result_sha,
      requested.base_sha,
      proven.source_sha,
      checkout.head,
    );
    record.source_sha = proven.source_sha;
    record.review_base = proven.review_base;
    record.review_head = proven.review_head;
    record.integration = {
      target_branch: anchors.targetBranch,
      worktree_path: anchors.worktreePath,
      base_sha: requested.base_sha,
      result_sha: resultSha,
      verified_at: at,
    };
    // This completion releases only its current coordinator's matching attempt.
    // A stopped predecessor's claim is settled by ordinary coordinator recovery,
    // never inferred or discarded by completion.
    requireOwnMergeClaim(tx, witness, planId, scope!.workingBranch, anchors.targetBranch);
  }
  // §4.1 the authoritative findings gate on THIS transaction's handle: an issue
  // captured after the preflight refuses the completion instead of being judged
  // against a stale list. (The Git witnesses were already re-validated by the
  // frame's commit-boundary preflight, which runs after the race seam.)
  assertFindingsClosedOn(tx, planId, prepared);
  applyCompletion({ tx, witness, planId, record, scope, at, what: `plan ${planId} coordination` });
  const settled = readExecutionPlanWitness(tx, read);
  return { data: settled.view, token: settled.token, storeId: tx.storeId, epoch: tx.epoch };
}

/**
 * Merge-mutex admission: only the current coordinator's exact attempt is this
 * completion's to release. The recorded holder completes another active attempt;
 * applicable explicit stop evidence goes through ordinary coordinator recovery.
 */
function requireOwnMergeClaim(
  tx: ExecutionTransaction,
  witness: ExecutionPlanWitness,
  planId: string,
  sourceBranch: string,
  targetBranch: string,
): void {
  const lease = witness.view.integrationLease;
  if (lease === null) return;
  if (lease.plan_id !== planId || lease.source_branch !== sourceBranch || lease.target_branch !== targetBranch) {
    throw new CoordinationError(
      "coordination.merge-lease-foreign",
      "The merge lease is held by another plan's attempt; this operation cannot release a foreign claim. Its holder finishes it and inspects the plan with mstar plan show, then corrects recorded scope with mstar plan prepare.",
      {
        plan_id: planId,
        workflow_id: witness.workflowId,
        holder: lease.holder,
        holder_plan_id: lease.plan_id,
        holder_source_branch: lease.source_branch,
        holder_target_branch: lease.target_branch,
        source_branch: sourceBranch,
        target_branch: targetBranch,
      },
    );
  }
  if (lease.holder === witness.session.sessionId) return;
  if (readLiveSessionIdentities(tx, witness.workflowId).has(lease.holder)) {
    // §4.2 a LIVE foreign holder is not this completion's to release: the claim
    // belongs to the attempt its holder is executing, and only the holder's own
    // session (or an authorized recovery that attests its stop) may move it. A
    // completing caller can never eliminate another session's foreign ownership
    // by completing a different row.
    throw new CoordinationError(
      "coordination.identity-mismatch",
      "The merge lease is held by a live foreign coordinator; a live claim is never released. Its holder finishes that attempt and inspects the plan with mstar plan show.",
      {
        holder_plan_id: lease.plan_id,
        holder_source_branch: lease.source_branch,
        holder_target_branch: lease.target_branch,
        plan_id: planId,
        holder: lease.holder,
        session_id: witness.session.sessionId,
      },
    );
  }
  // §4.2 the claim matches this attempt but names a session this epoch does NOT
  // hold active. A merely non-active row is NOT authority to take it: the only
  // recorded linkage that authorises replacing that holder is the workflow-wide
  // recovery RENEWAL over this workflow's own history — the immutable previous
  // recovery receipt (which records `prior_session_id`/`stopped_sessions`), the
  // revoked prior session row, the exact held claim row, and a FRESH full stop
  // document in which the CURRENT binding is not the stopped session, with
  // `claimed_at <= stop <= now`. The current binding is not transferred; it is
  // re-recognised as the replacement the recorded history already produced, and
  // the recovery then settles the claim row it left behind.
  throw new CoordinationError(
    "coordination.merge-lease-stopped-owner",
    "The merge lease belongs to a stopped coordinator; this completion does not take over another holder's claim. The supported renewal covers the recorded predecessor relationship, then inspect the workflow with mstar status validate.",
    {
      authority_epoch: tx.epoch,
      plan_id: planId,
      session_id: witness.session.sessionId,
      claim_plan_id: lease.plan_id,
      claim_source_branch: lease.source_branch,
      claim_target_branch: lease.target_branch,
      claim_holder: lease.holder,
      claim_taken_at: lease.claimed_at ?? null,
      supported_route: "mstar session recover (--workflow, --prior-session, --reason, --attestation, --expect, --operation)",
    },
  );
}

/* ------------------------------------------------------------------------ *
 * §R5/§R10 the fulfilment a CLOSE records
 * ------------------------------------------------------------------------ */

/**
 * §R5/§R10 one owned row's outstanding obligation, derived BEFORE a close takes
 * SQLite ownership and re-verified inside it. `fulfilment` is the report-only
 * completion-policy fulfilment the close still has to RECORD (null when the
 * workflow already records it).
 *
 * A close composes no row completion: `complete` is the ONE row-completion
 * operation, so an owned row that is not `Done` is refused with the decision the
 * close cannot supply instead of demanding a route's fields.
 */
export type EntailedRowCompletion = {
  planId: string;
  fulfilment: { policy: string; evidence: string } | null;
};

/**
 * §R5/§R10 the close reports only what the workflow ALREADY records: whether the
 * registered report-only completion policy is still unfulfilled. It never
 * synthesizes a fulfilment — a QA pass is not the fulfilment of a registered
 * policy — so an unrecorded policy is reported as outstanding and the close's
 * own caller must refuse with the ordinary `workflow evidence` action that
 * records it. An imported/Done row is held to exactly the same rule.
 */
function reportOnlyFulfilmentOutstanding(snapshot: WorkflowSnapshot, planId: string): boolean {
  const policy = snapshot.completion_policy;
  if (!isNonEmptyString(policy)) {
    throw missingDecision({
      planId,
      what: "close",
      component: "workflow-delivery",
      field: "completion_policy",
      source: "workflow snapshot delivery_kind verification/report-only",
      message:
        `close requires report-only plan ${planId}'s lifecycle to declare the completion_policy its report is accepted against, ` +
        `and this workflow records none \u2014 declare the policy through workflow registration, then retry`,
    });
  }
  const recorded = isPlainObject(snapshot.delivery) && isPlainObject(snapshot.delivery.completion)
    ? (snapshot.delivery.completion as Record<string, unknown>)
    : undefined;
  if (recorded === undefined) {
    throw missingDecision({
      planId,
      what: "close",
      component: "workflow-delivery",
      field: "delivery.completion",
      source: "workflow snapshot delivery evidence",
      message:
        `close requires the workflow to RECORD the fulfilment of its registered completion policy ${JSON.stringify(policy)}, and ` +
        `nothing is recorded \u2014 record it through the ordinary \`mstar workflow evidence\` action (which records its explicit ` +
        `fulfilment), then retry; a QA pass alone is not the fulfilment of a policy`,
    });
  }
  if (recorded.policy !== policy) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `close cannot complete report-only plan ${planId}: the recorded fulfilment names policy ${JSON.stringify(recorded.policy)} ` +
        `while the lifecycle registers ${JSON.stringify(policy)} \u2014 a re-pointed completion is never the basis of a Done`,
      { plan_id: planId, recorded: recorded.policy, registered: policy },
    );
  }
  return false;
}

/**
 * §R5/§R10 one owned row's outstanding obligation, or `null` when the row
 * records `Done` and the workflow already records everything the terminal close
 * needs. The development and integration routes own no close-time row work:
 * their rows complete through the ordinary `complete` operation.
 */
export async function readEntailedRowCompletion(
  _context: ExecutionContext,
  snapshot: WorkflowSnapshot,
  row: ExecutionPlanView,
): Promise<EntailedRowCompletion | null> {
  const planId = String(row.plan.id);
  const status = rowStatusOf(row.plan as unknown as PlanRow);
  if (deliveryRouteOf(snapshot) === "report-only") {
    if (status !== "Done") {
      throw missingDecision({
        planId,
        what: "close",
        component: "plan-completion",
        field: "coordination.completion",
        source: "plan row coordination block",
        message:
          `close requires plan ${planId} to record Done, and this row records ${status || "no status"} \u2014 ` +
          `complete it with the ordinary plan complete operation, then retry the close`,
      });
    }
    return reportOnlyFulfilmentOutstanding(snapshot, planId) ? { planId, fulfilment: null } : null;
  }
  if (status === "Done") return null;
  throw missingDecision({
    planId,
    what: "close",
    component: "plan-completion",
    field: "coordination.completion",
    source: "plan row coordination block",
    message:
      `close requires every owned row to record Done, and plan ${planId} records ${status || "no status"} \u2014 ` +
      `complete it with the ordinary plan complete operation, then retry the close`,
  });
}

/**
 * §R5/§R10 the same derivation for every owned row of one ACTIVE workflow, in
 * row order: the fulfilments a terminal `completed` close records.
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
  return { completions, pinned: deliveryRoutePin(snapshot) };
}

/* ------------------------------------------------------------------------ *
 * §R11/A21 the owned-claim cleanup of a failed/stopped close
 * ------------------------------------------------------------------------ */

/**
 * §R11/A21 the integration-claim half of a failed/stopped close's cleanup: this
 * workflow's OWN merge claim is released when its holder's session is not active
 * at this epoch, and left exactly where it is when that holder IS live — the
 * terminal decision then refuses on it, because a running holder's claim needs
 * that holder's own recovery. It reports whether the claim was released, which
 * is the caller's cue that the ownership it is about to judge changed.
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
 * §3 `mutateExecutionPlan` — the published coordinator plan verb surface
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
 * implemented member has exactly one DB transition, and a kind outside it is
 * refused rather than stubbed. The dispatcher adds no permission of its own:
 * each verb re-runs the shared seat gate, and the frame re-runs the CAS, the
 * running-lifecycle admission and the receipt bookkeeping.
 */
export async function mutateExecutionPlan(
  context: ExecutionContext,
  request: ExecutionPlanIntent,
): Promise<ExecutionReceipt<ExecutionPlanView>> {
  const operation = request?.operation;
  if (!isPlainObject(operation) || !isNonEmptyString(operation.kind)) {
    throw invalidPlanInput("Invalid plan operation: provide an operation with a kind; inspect the operation contract with mstar schema.");
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
    case "complete":
      return completeExecutionPlan(context, { ...resolved, operation: strict });
    default:
      throw new CoordinationError(
        "coordination.unknown-operation",
        "Unknown coordination operation kind; inspect the operation contract with mstar schema.",
        { operation: String(operation.kind) },
      );
  }
}
