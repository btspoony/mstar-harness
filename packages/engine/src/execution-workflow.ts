/**
 * execution-workflow.ts — the DB transport of WORKFLOW-LEVEL lifecycle
 * transitions and coordinator recovery (primary spec §2.3/§3/§4.1/§4.2).
 *
 * W1–W4 built the plan-operation half of the execution authority: one accepted
 * plan operation is one transaction. This module adds the workflow's own half —
 * the phase, lifecycle, execution-policy, integration-checkout and delivery
 * transitions of one lifecycle — plus the named recovery route for the
 * workflow's coordinator identity. Plan-scoped operations live in the plan
 * transport; this module owns no plan-scoped identity of its own.
 *
 * Everything load-bearing is REUSED, never re-expressed:
 *
 * - the phase transition runs the existing `evaluatePhaseGate` over the
 *   lifecycle's own registered compass and its committed plan rows, so a phase
 *   the gate does not currently produce is refused (a skipped phase is not a
 *   transition this route can perform) and no caller-supplied gate verdict is
 *   ever read;
 * - the lifecycle transition runs the existing terminal rules: every owned row
 *   `Done`, the existing `consultDeliveryEvidence` consultation for a
 *   `completed` close (the SAME function the file route's close and the
 *   read-only Phase-6 gate consult), and the existing terminal invariant that a
 *   terminal lifecycle owns no execution or integration lease;
 * - the delivery transition runs the existing structural validator and the
 *   contract §4d/§4c ordering and immutability rules of `recordWorkflowDelivery`
 *   (one member map, one shape rule — exported by `workflow.ts`, not copied);
 * - the integration-checkout transition runs the existing worktree/branch
 *   validators (`readMainWorktree` / `probeCheckoutRoot` / `isDistinctCheckout`
 *   / `assertBranchAlignment`) with the same rule `readIntegrationWorktreePath`
 *   applies at Prepare: an existing checkout of THIS repository, distinct from
 *   the main/control checkout, on the registered integration branch;
 * - identity is never rekeyed: `id`, `type`, `started_at`, `project`,
 *   `delivery_kind`, `completion_policy` and the branch anchors are not
 *   writable through this route at all, and the candidate header is validated
 *   by the existing snapshot validator before it is stored.
 *
 * §4.1 discipline: every external read (the canonical compass bytes, the Git
 * probes) happens BEFORE SQLite ownership, so a transition never decides
 * against evidence it did not read; the transaction re-checks the facts it
 * still stands on (the registered checkout is a path fact) rather than
 * re-reading document bytes.
 *
 * Coordinator recovery is deliberately NOT a silent lease steal and NOT a
 * second `bind`:
 *
 * - the trusted caller must be a coordinator of the addressed workflow, and a
 *   different active coordinator is never replaced; the only live identity it
 *   may replace is the exact named holder covered by stop evidence;
 * - the workflow token is the CAS, the prior holder must be NAMED, and the
 *   operator attestation must name that session as stopped/reloaded (the
 *   existing `validateActivationAttestation` document rule supplies the
 *   operator authorization reference and the current-coordinator consumer);
 * - revocation and rebinding commit together with an immutable operation
 *   receipt recording the prior holder, the reason and the attestation digest;
 * - the coordinator holds no per-plan claim to adopt: the removed plan-PM
 *   seat's leases are gone, and the workflow's own integration merge claim is
 *   settled by the close/completion transitions that own it.
 *
 * Plan-PM recovery is GONE with the seat it recovered. A plan row is ordinary
 * coordinator data addressed by `planId`; there is no second plan-scoped
 * identity to revoke and no per-plan claim to transfer.
 *
 * Nothing here is a public arbitrary writer: the package index publishes exactly
 * `mutateExecutionWorkflow` and `recoverExecutionCoordinator`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  CoordinationError,
  assertExactKeys,
  canonicalTarget,
  isNonEmptyString,
  isPlainObject,
  type CoordinationErrorCode,
} from "./coordination-write.js";
import {
  PLAN_PARALLELISM_VALUES,
  gitRead,
  prepareAmendmentComponent,
  revalidateGitProofWitness,
} from "./coordination.js";
import { rowStatusOf, summarize } from "./coordination-transitions.js";
import {
  applyEntailedCompletion,
  completionFrameFor,
  readEntailedCompletions,
  releaseStoppedMergeClaim,
  resolveSparseOwnSession,
  type DeliveryRoutePin,
  type EntailedRowCompletion,
  type ExecutionMutationIntent,
} from "./execution-coordination.js";
import {
  ExecutionError,
  advanceWorkflowHeaderRevision,
  assertAuthorityGeneration,
  assertExecutionToken,
  assertOperationId,
  bindRecoveredSession,
  executionToken,
  readExecutionState,
  readExecutionStateGraph,
  readExecutionWorkflowWitness,
  readOperationReplay,
  recordRootMembershipLoss,
  requireWorkflowState,
  resolveTokenFreshness,
  resolveWorkflowSession,
  resolveWorkflowWrite,
  semanticRequestHash,
  serializeExecutionValue,
  withExecutionTransaction,
  withRecoveryDetails,
  writeOperationReceipt,
  writeWorkflowState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionMutation,
  type ExecutionReceipt,
  type ExecutionRead,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
  type ExecutionTransaction,
  type ExecutionWorkflowWitness,
  type ResolvedWorkflowWrite,
  type SessionRow,
} from "./execution-store.js";
import {
  evaluatePhaseGate,
  parseCompassFrontmatterText,
  validateCompassFrontmatter,
  type CompassDoc,
  type PhaseGateOptions,
} from "./iteration.js";
import { canonicalizeNearestExisting } from "./path.js";
import { readExecutionAuthority } from "./execution-read.js";
import {
  WORKFLOW_OPERATION_SEMANTICS,
  selectSemanticFields,
  unresolvedRecovery,
  type RecoveryDetails,
  type RecoveryProblem,
  type ResolutionSource,
  type ResolutionWarning,
} from "./recovery-intent.js";
import { validateActivationAttestation, type ActivationAttestation } from "./store-activation.js";
import { StoreError, storeDbPath } from "./store-db.js";
import {
  WORKFLOW_LIFECYCLE_STATUSES,
  WORKFLOW_TERMINAL_STATUSES,
  consultDeliveryEvidence,
  deliveryEvidenceMembers,
  deliveryEvidenceViolations,
  isTerminalSnapshot,
  validateWorkflowSnapshot,
  type WorkflowDeliveryEvidence,
  type WorkflowExecutionPolicy,
  type WorkflowSnapshot,
} from "./workflow.js";
import { assertBranchAlignment, isDistinctCheckout, readMainWorktree } from "./worktree.js";
import type { PlanRow } from "./status.js";

/* ------------------------------------------------------------------------ *
 * §3 the closed workflow-operation union
 * ------------------------------------------------------------------------ */

/**
 * §3 the whole workflow-level verb vocabulary of the DB authority, verbatim:
 * the phase machine, the lifecycle status, the execution policy, the
 * integration checkout and the delivery evidence. Each member is a real
 * transition with one implementation below; there is no header-patch member,
 * because an arbitrary header replacement is exactly what this route must not
 * offer.
 */
export type WorkflowExecutionOperation =
  | { kind: "phase"; phase: NonNullable<WorkflowSnapshot["phase"]>; compassPath: string }
  | { kind: "lifecycle"; status: WorkflowSnapshot["status"]; reason: string }
  | { kind: "execution-policy"; policy: NonNullable<WorkflowSnapshot["execution_policy"]> }
  | { kind: "integration-worktree"; path: string }
  | { kind: "delivery"; delivery: NonNullable<WorkflowSnapshot["delivery"]> };

/** §3 one DB workflow-operation request: the §3.1 envelope plus what it addresses. */
export type WorkflowOperationRequest<Operation extends WorkflowExecutionOperation = WorkflowExecutionOperation> =
  ExecutionMutation & { workflowId: string; operation: Operation };

/**
 * §3 one DB workflow-operation INTENT: the same request with the facts the
 * engine can derive left out (§ One resolver path, S2/E02). `operationId` and
 * the operation are always the caller's own intent; the coordinator session,
 * the workflow token and the addressed workflow id are optional, and an
 * explicitly supplied value is a CONSTRAINT rather than a prerequisite.
 */
export type ExecutionWorkflowIntent<Operation extends WorkflowExecutionOperation = WorkflowExecutionOperation> =
  ExecutionMutationIntent & { workflowId?: string; operation: Operation };

/** §3 one resolved workflow operation: the validated envelope plus the authorized address. */
type ResolvedWorkflowOperation<Operation extends WorkflowExecutionOperation> = {
  call: WorkflowOperationRequest<Operation>;
  read: ResolvedWorkflowWrite;
};

/** The caller-input refusal of this module (`coordination.invalid-input`). */
function invalidWorkflowInput(detail: string): CoordinationError {
  return new CoordinationError("coordination.invalid-input", detail);
}

/** The one carrier of lifecycle-ordering refusals (`coordination.invalid-transition`). */
function invalidWorkflowTransition(detail: string, details: Record<string, unknown> = {}): CoordinationError {
  return new CoordinationError("coordination.invalid-transition", detail, details);
}

/**
 * §3 the shape gate of one workflow operation: exact keys per member, each
 * value checked as the member declares it. An unknown key is an arbitrary
 * header-patch attempt, so it is refused rather than ignored.
 */
function assertWorkflowOperationShape(operation: unknown): asserts operation is WorkflowExecutionOperation {
  if (!isPlainObject(operation) || !isNonEmptyString(operation.kind)) {
    throw invalidWorkflowInput("a workflow operation needs an operation with a kind");
  }
  const op = operation as unknown as Record<string, unknown>;
  switch (operation.kind) {
    case "phase": {
      assertExactKeys(op, ["kind", "phase", "compassPath"], "a phase operation");
      if (!isNonEmptyString(op.phase)) throw invalidWorkflowInput("a phase operation needs the non-empty phase it requests");
      if (!isNonEmptyString(op.compassPath) || !isAbsolute(op.compassPath)) {
        throw invalidWorkflowInput(
          "a phase operation needs the absolute compassPath of the lifecycle's registered compass \u2014 the gate is evaluated " +
            "against the canonical compass, never against a caller-supplied verdict",
        );
      }
      return;
    }
    case "lifecycle": {
      assertExactKeys(op, ["kind", "status", "reason"], "a lifecycle operation");
      if (typeof op.status !== "string" || !(WORKFLOW_LIFECYCLE_STATUSES as readonly string[]).includes(op.status)) {
        throw invalidWorkflowInput(
          `a lifecycle operation needs status one of ${WORKFLOW_LIFECYCLE_STATUSES.join(" | ")} \u2014 got ${JSON.stringify(op.status)}`,
        );
      }
      if (!isNonEmptyString(op.reason)) throw invalidWorkflowInput("a lifecycle operation needs the non-empty reason it is recorded with");
      return;
    }
    case "execution-policy": {
      assertExactKeys(op, ["kind", "policy"], "an execution-policy operation");
      if (!isPlainObject(op.policy)) throw invalidWorkflowInput("an execution-policy operation needs a policy object");
      return;
    }
    case "integration-worktree": {
      assertExactKeys(op, ["kind", "path"], "an integration-worktree operation");
      if (!isNonEmptyString(op.path) || !isAbsolute(op.path)) {
        throw invalidWorkflowInput("an integration-worktree operation needs the absolute path of the integration checkout");
      }
      return;
    }
    case "delivery": {
      assertExactKeys(op, ["kind", "delivery"], "a delivery operation");
      if (!isPlainObject(op.delivery)) throw invalidWorkflowInput("a delivery operation needs a delivery evidence object");
      if (Object.keys(op.delivery).length === 0) {
        throw invalidWorkflowInput(
          "a delivery operation needs at least one evidence member (compound | pr | merge | completion) \u2014 an empty patch changes nothing",
        );
      }
      return;
    }
    default:
      throw new CoordinationError("coordination.unknown-operation", `${String(op.kind)} is not a workflow operation`, {
        operation: op.kind,
      });
  }
}

/**
 * §3 one resolved workflow operation: the validated envelope plus the address
 * the pure seat/reference gate already authorized. The reference gate runs
 * BEFORE the store is opened, so a malformed, plan-scoped or caller-mismatched
 * request is refused by itself, never by — or after — a store-open failure.
 */
function resolveWorkflowOperationRequest<Operation extends WorkflowExecutionOperation>(
  caller: ExecutionCaller,
  request: WorkflowOperationRequest<Operation>,
): ResolvedWorkflowOperation<Operation> {
  if (!isPlainObject(request)) throw invalidWorkflowInput("a workflow operation needs a request object");
  if (!isNonEmptyString(caller?.sessionId)) {
    throw invalidWorkflowInput("the execution caller needs a non-empty session identity");
  }
  const operationId = assertOperationId((request as { operationId?: unknown }).operationId);
  const workflowId = (request as { workflowId?: unknown }).workflowId;
  if (!isNonEmptyString(workflowId)) {
    throw invalidWorkflowInput("a workflow operation needs the non-empty workflow id it addresses");
  }
  assertWorkflowOperationShape((request as { operation?: unknown }).operation);
  const read = resolveWorkflowWrite(caller, request.session, workflowId);
  return { call: { ...request, operationId, workflowId }, read };
}

/**
 * §4.2 the field path one workflow operation addresses, as the intent names it:
 * the ONE field the operation writes, and therefore the field whose current
 * value decides whether its effect is already held (R6/R7/A09/A12) or
 * genuinely conflicts (A11).
 */
function workflowOperationField(operation: WorkflowExecutionOperation): string {
  switch (operation.kind) {
    case "phase":
      return "operation.phase";
    case "lifecycle":
      return "operation.status";
    case "execution-policy":
      return "operation.policy";
    case "integration-worktree":
      return "operation.path";
    case "delivery":
      return "operation.delivery";
  }
}

/** The stored value the addressed field carries right now, as one comparable canonical value. */
function storedOperationValue(state: Record<string, unknown>, operation: WorkflowExecutionOperation): unknown {
  switch (operation.kind) {
    case "phase":
      return state.phase;
    case "lifecycle":
      return state.status;
    case "execution-policy":
      return state.execution_policy;
    case "integration-worktree":
      return state.integration_worktree_path;
    case "delivery":
      return state.delivery;
  }
}

/** The value this operation would store for its own field, in its stored form. */
function requestedOperationValue(operation: WorkflowExecutionOperation): unknown {
  switch (operation.kind) {
    case "phase":
      return operation.phase;
    case "lifecycle":
      return operation.status;
    case "execution-policy":
      return operation.policy;
    // The transition records the checkout's CANONICAL path, so a repeat of the
    // same checkout is the same effect however the caller spelled the path.
    case "integration-worktree":
      return canonicalTarget(operation.path);
    case "delivery":
      return operation.delivery;
  }
}

/**
 * §3.1/§4.2 the request fingerprint of one workflow operation: the operation
 * kind, the addressed workflow, the caller identity the receipt is bound to and
 * E01's semantic selection for that kind — never the transport freshness
 * (`expected` token, `session` reference, `operationId`) the caller happened to
 * present. A repeat after a lost response is the same intent even when the
 * caller re-read the state and re-presented a fresh token (design R6/R7), so the
 * fingerprint must not move with it; a different business payload still moves it
 * and stays an operation conflict (A13).
 */
function workflowOperationRequestHash(
  caller: ExecutionCaller,
  workflowId: string,
  operation: WorkflowExecutionOperation,
): string {
  return semanticRequestHash({
    operation: operation.kind,
    address: { workflow_id: workflowId },
    caller,
    intent: selectSemanticFields({ workflowId, operation }, WORKFLOW_OPERATION_SEMANTICS[operation.kind]),
  });
}

/**
 * §4.1 the sidecar of one workflow-frame result: what this call did with the
 * intent, the workflow it addressed, the facts it reconciled and the commit
 * boundary the caller can rely on. It is the same object shape a refusal carries
 * under `error.details.recovery`, so one contract covers both paths.
 */
function workflowRecovery(input: {
  workflowId: string;
  outcome: RecoveryDetails["outcome"];
  applied: readonly string[];
  commitState: RecoveryDetails["commitState"];
  resolvedFrom?: readonly ResolutionSource[];
  warnings?: readonly ResolutionWarning[];
}): RecoveryDetails {
  return {
    outcome: input.outcome,
    target: { workflowId: input.workflowId },
    applied: [...input.applied],
    unresolved: [],
    resolvedFrom: [...(input.resolvedFrom ?? [])],
    warnings: [...(input.warnings ?? [])],
    commitState: input.commitState,
  };
}

/** One comparable value, as the typed causes quote it. */
function describeValue(value: unknown): string {
  if (value === undefined) return "absent";
  try {
    return serializeExecutionValue(value);
  } catch {
    return JSON.stringify(value) ?? String(value);
  }
}

/* ------------------------------------------------------------------------ *
 * §2.1/§4.3 the control harness root this call transacts on
 * ------------------------------------------------------------------------ */

/**
 * The control harness root of the store this call transacts on: the directory
 * that owns `store.db`. `StoreContext.harnessDir` is the anchor the store was
 * RESOLVED from, so the root is read back from the store's own path rather than
 * re-derived — the database's location decides where its harness, its compasses
 * and its checkouts are.
 */
function controlHarnessRoot(context: ExecutionContext): string {
  return canonicalizeNearestExisting(dirname(storeDbPath(context)));
}

/* ------------------------------------------------------------------------ *
 * §4.1 the pre-transaction evidence and its pinned witnesses
 * ------------------------------------------------------------------------ */

/** The canonical compass a `phase` transition read, with the doc it parsed. */
type CompassEvidence = { path: string; doc: CompassDoc };

/**
 * §4.1 everything the external half of one workflow transition observed before
 * SQLite ownership. Each group is read only by the transition that needs it.
 */
type WorkflowEvidence = {
  /** `phase`: the canonical compass, and the §3.5 probes the DB authority holds. */
  compass?: CompassEvidence;
  probes?: PhaseGateOptions;
  /** The checkout the Git probes were taken against (must still be the registered one). */
  checkout?: { path: string; branch: string | null };
  /** `integration-worktree`: the canonical candidate path and the branch it was on. */
  worktree?: { path: string; branch: string };
  /**
   * §R5/§R10 (E10) the row completions a terminal `completed` close composes,
   * derived before SQLite ownership from each owned row's recorded evidence.
   * Empty for a close that has nothing to compose, and absent for every other
   * transition.
   */
  completions?: readonly EntailedRowCompletion[];
  /** The delivery route/policy pair those completions were proved against (§4.1). */
  pinned?: DeliveryRoutePin;
};

/**
 * §E one workflow's stored header, read before the transaction for the anchors a
 * transition's external reads need. The header is the snapshot minus the plan
 * collection its own table owns, so the projection is the same one
 * `readExecutionState` serves.
 */
async function readWorkflowHeaderBefore(context: ExecutionContext, workflowId: string): Promise<WorkflowSnapshot> {
  const state = await readExecutionState(context);
  const workflow = state.data.workflows.find((candidate) => candidate.state.id === workflowId);
  if (workflow === undefined) {
    throw new CoordinationError(
      "coordination.workflow-not-found",
      `workflow ${workflowId} is not an active lifecycle of this store`,
      { workflow_id: workflowId },
    );
  }
  return workflow.state as unknown as WorkflowSnapshot;
}

/**
 * §4.1/§3.5 the external evidence of one `phase` transition: the lifecycle's OWN
 * registered compass (never an arbitrary file), validated by the existing
 * compass-frontmatter rule, plus the one Git probe this authority can honestly
 * take — the branch actually checked out at the lifecycle's registered
 * integration checkout. A lifecycle that registers no integration checkout
 * yields no `currentBranch`, which the existing gate reports as
 * `EXIT_BRANCH_UNVERIFIABLE`: the phase that needs it stays unreachable rather
 * than being guessed.
 *
 * `prBaseBranch` is the recorded PR identity's target (§4d) — the DB authority
 * holds no operator PR probe, and the engine never inspects the provider; the
 * recorded identity is also exactly what the close will consult.
 */
async function readPhaseEvidence(
  context: ExecutionContext,
  workflowId: string,
  operation: Extract<WorkflowExecutionOperation, { kind: "phase" }>,
): Promise<WorkflowEvidence> {
  const header = await readWorkflowHeaderBefore(context, workflowId);
  const registered = header.compass_ref;
  if (!isNonEmptyString(registered)) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} registers no compass_ref \u2014 a phase transition is decided by the iteration compass gate, and a ` +
        `lifecycle without a registered compass has no gate to evaluate`,
      { workflow_id: workflowId },
    );
  }
  const harnessRoot = controlHarnessRoot(context);
  const canonical = canonicalTarget(operation.compassPath);
  const expected = canonicalTarget(join(harnessRoot, registered));
  if (canonical !== expected) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `the phase transition of workflow ${workflowId} reads the lifecycle's registered compass ${expected}, not ${canonical}`,
      { workflow_id: workflowId, expected, actual: canonical },
    );
  }
  if (!existsSync(canonical)) {
    throw invalidWorkflowTransition(`the registered compass ${canonical} of workflow ${workflowId} does not exist`, {
      workflow_id: workflowId,
      compass_path: canonical,
    });
  }
  const text = readFileSync(canonical, "utf8");
  const doc = parseCompassFrontmatterText(text, canonical);
  const validation = validateCompassFrontmatter(doc);
  if (!validation.ok) {
    throw invalidWorkflowInput(`the compass ${canonical} does not validate (${summarize(validation.violations)})`);
  }

  const probes: PhaseGateOptions = {};
  const integrationBranch = header.branch?.integration;
  if (isNonEmptyString(integrationBranch)) probes.specIntegrationBranch = integrationBranch;
  const prTarget = header.delivery?.pr?.target;
  if (isNonEmptyString(prTarget)) probes.prBaseBranch = prTarget;

  const integrationPath = isNonEmptyString(header.integration_worktree_path)
    ? canonicalTarget(header.integration_worktree_path)
    : null;
  const evidence: WorkflowEvidence = { compass: { path: canonical, doc }, probes };
  if (integrationPath !== null) {
    const branch = gitRead(integrationPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== undefined && branch !== "") probes.currentBranch = branch;
    evidence.checkout = { path: integrationPath, branch: branch === undefined || branch === "" ? null : branch };
  }
  return evidence;
}

/**
 * §4.1 the external evidence of one `integration-worktree` transition: the same
 * rule `readIntegrationWorktreePath` applies to a Prepare amendment — an
 * existing checkout, distinct from the main/control checkout, belonging to the
 * repository that owns the control harness root, on the lifecycle's registered
 * integration branch — plus the `HEAD` witness the commit window re-reads.
 */
async function readIntegrationWorktreeEvidence(
  context: ExecutionContext,
  workflowId: string,
  operation: Extract<WorkflowExecutionOperation, { kind: "integration-worktree" }>,
): Promise<WorkflowEvidence> {
  const header = await readWorkflowHeaderBefore(context, workflowId);
  const integrationBranch = header.branch?.integration;
  if (!isNonEmptyString(integrationBranch)) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} records no branch.integration \u2014 an integration checkout cannot be verified against a branch ` +
        `the lifecycle does not register`,
      { workflow_id: workflowId },
    );
  }
  const path = canonicalTarget(operation.path);
  const control = controlHarnessRoot(context);
  const main = readMainWorktree(control);
  if (main === null) {
    throw new CoordinationError(
      "coordination.not-in-git",
      `the control harness root ${control} has no readable Git main worktree, so the integration checkout ${path} cannot be ` +
        `proven to belong to this repository`,
      { harness_root: control, path },
    );
  }
  const mainRoot = canonicalTarget(main.root);
  if (path === mainRoot || path === canonicalTarget(control)) {
    throw invalidWorkflowTransition(
      `the integration checkout ${path} is the main/control checkout \u2014 a dedicated integration worktree is required`,
      { workflow_id: workflowId, path, expected: `a checkout distinct from ${mainRoot}` },
    );
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw invalidWorkflowTransition(`the integration checkout ${path} does not exist`, { workflow_id: workflowId, path });
  }
  // The repository a checkout belongs to is its MAIN worktree: a linked
  // worktree's own `--show-toplevel` is itself, so the main record is what
  // decides ("a checkout of the repository owning the control harness root").
  const owner = readMainWorktree(path);
  if (owner === null) {
    throw new CoordinationError(
      "coordination.not-in-git",
      `the integration checkout ${path} is not a readable Git worktree`,
      { workflow_id: workflowId, path },
    );
  }
  const root = canonicalTarget(owner.root);
  if (root !== mainRoot) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `the integration checkout ${path} belongs to ${root}, not to the repository owning the control harness root ` +
        `(${mainRoot})`,
      { workflow_id: workflowId, path, expected: mainRoot, actual: root },
    );
  }
  if (!isDistinctCheckout(mainRoot, path)) {
    throw invalidWorkflowTransition(
      `the integration checkout ${path} is not a distinct Git checkout (it resolves to the same checkout as ${mainRoot})`,
      { workflow_id: workflowId, path },
    );
  }
  const alignment = assertBranchAlignment(path, integrationBranch);
  if (!alignment.ok) {
    throw new CoordinationError(
      "coordination.integration-diverged",
      `the integration checkout ${path} is not on the registered integration branch (${summarize(alignment.violations)})`,
      { workflow_id: workflowId, path, expected: integrationBranch },
    );
  }
  return { worktree: { path, branch: integrationBranch } };
}

/** §4.1 the external evidence of one workflow operation, read before SQLite ownership. */
async function readWorkflowEvidence(
  context: ExecutionContext,
  resolved: ResolvedWorkflowOperation<WorkflowExecutionOperation>,
): Promise<WorkflowEvidence> {
  const operation = resolved.call.operation;
  const workflowId = resolved.read.workflowId;
  switch (operation.kind) {
    case "phase":
      return readPhaseEvidence(context, workflowId, operation);
    case "integration-worktree":
      return readIntegrationWorktreeEvidence(context, workflowId, operation);
    case "lifecycle":
      // §R5/§R10 a terminal `completed` close composes the fulfilment and the
      // row completions its owned rows' recorded evidence entails. Every
      // external read that composition needs (the report-only policy
      // resolution, the development source proof, the integration merge proof
      // and the findings gate) happens HERE, before SQLite ownership; the
      // transaction re-verifies the pinned route, the digests and the Git
      // witness at the commit boundary.
      return operation.status === "completed"
        ? readCloseEvidence(context, workflowId)
        : {};
    default:
      // The other stored transitions (phase-less lifecycle, execution-policy,
      // delivery) read no external evidence: their inputs are the store's own
      // rows, which the transaction reads itself.
      return {};
  }
}

/**
 * §R5/§R10 the evidence of one terminal `completed` close. A workflow that is
 * no longer a registered active lifecycle — an exact retry whose receipt the
 * transaction below still serves — deliberately yields NO pending completion:
 * the close's own registry absence is not this preflight's to report, and the
 * transaction is the authority on why the address no longer resolves.
 */
async function readCloseEvidence(context: ExecutionContext, workflowId: string): Promise<WorkflowEvidence> {
  let state;
  try {
    state = await readExecutionState(context);
  } catch {
    // The transaction's own reads report the store's actual state (staged,
    // corrupt or unavailable); swallowing it here keeps a completed retry
    // reaching its recorded receipt instead of failing on a preflight read.
    return {};
  }
  const workflow = state.data.workflows.find((candidate) => candidate.state.id === workflowId);
  if (workflow === undefined) return {};
  const derived = await readEntailedCompletions(context, workflow);
  return { completions: derived.completions, pinned: derived.pinned };
}

/**
 * §4.1 the commit-window half of the pinned evidence: the current Git facts of
 * the checkout this transition adopted, re-read immediately before the commit.
 * The byte witnesses (a compass digest, a pinned ref digest) are gone — an edit
 * to a document or a ref file is a record that has moved on, not a refusal. What
 * is NOT a byte witness and must still hold is the branch fact: the checkout the
 * transition is about to record has to be on the registered integration branch
 * at the commit boundary, re-read through the same `assertBranchAlignment`
 * validator the preflight used (a misaligned checkout is an invalid delivery
 * fact, not digest drift). The candidate path must also still exist as a
 * directory, because nothing records a checkout that is no longer there.
 */
function revalidateWorkflowEvidence(evidence: WorkflowEvidence): void {
  const checkout = evidence.worktree ?? evidence.checkout;
  if (checkout !== undefined && checkout.branch !== null) {
    const { path, branch } = checkout;
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new CoordinationError(
        "coordination.integration-unresolved",
        `the integration checkout ${path} disappeared after it was validated; restore the checkout at the registered path ` +
          `and retry the workflow transition`,
        { path },
      );
    }
    const alignment = assertBranchAlignment(path, branch);
    if (!alignment.ok) {
      throw new CoordinationError(
        "coordination.integration-diverged",
        `the integration checkout ${path} is no longer on the registered integration branch (${summarize(alignment.violations)}) ` +
          `\u2014 the branch fact is re-read at the commit boundary`,
        { path, expected: branch },
      );
    }
  }
  for (const proof of evidence.completions ?? []) {
    if (proof.gitWitness !== undefined) revalidateGitProofWitness(proof.gitWitness);
  }
}

/* ------------------------------------------------------------------------ *
 * §4.1 the typed causes of a withheld workflow effect
 * ------------------------------------------------------------------------ */

/**
 * §4.1 the stable code of a refusal this frame is about to report: the domain
 * classes carry theirs (`CoordinationError`, `ExecutionError`, `StoreError`), and
 * anything else is reported as an unclassified cause rather than guessed.
 */
function refusalCodeOf(error: unknown): string | undefined {
  if (error instanceof CoordinationError || error instanceof ExecutionError || error instanceof StoreError) {
    return error.code;
  }
  return undefined;
}

/**
 * §R5/§6.2 the report a refusal declared for ITSELF, when it carries one. A
 * transition that names the ONE decision it cannot supply (the §6.2 shape both
 * transports emit) is not relabelled by the frames around it: they add their own
 * boundary facts and leave the report intact.
 */
function declaredRecoveryOf(error: unknown): RecoveryDetails | undefined {
  if (!(error instanceof Error) || !("details" in error)) return undefined;
  const details: unknown = error.details;
  const recovery = isPlainObject(details) ? details.recovery : undefined;
  if (!isPlainObject(recovery)) return undefined;
  // Boundary cast: the sidecar is written by this engine's own recovery helpers
  // (`unresolvedRecovery` / `withRecoveryDetails`), and the guard above proves it
  // is the object shape they emit.
  return recovery as unknown as RecoveryDetails;
}

/**
 * §4.1/§4.2 (A25) the typed cause of a transition whose external prerequisite is
 * unavailable: the refusal the evidence produced, unchanged, with the recovery
 * sidecar that states the stage it failed at, the known commit boundary (none —
 * the evidence is read before the store is written, and an in-transaction
 * mismatch rolls the whole transaction back) and what remains possible without
 * it. The cause is reported, never invented: no field is added to the refusal
 * and no substitute fact is fabricated.
 */
function prerequisiteCause(
  error: unknown,
  input: { workflowId: string; operation: WorkflowExecutionOperation; stage: "read" | "revalidate" },
): unknown {
  const code = refusalCodeOf(error);
  // An ADDRESS verdict ("this store holds no such active lifecycle") is not an
  // unavailable prerequisite: it is reported by its own precise refusal, never
  // relabelled as a capability the transition could not read.
  if (code === "coordination.workflow-not-found") return error;
  const message = error instanceof Error ? error.message : String(error);
  // §R5/§6.2 a refusal that DECLARED its own report — the ONE decision a
  // transition cannot supply, in the §6.2 shape both transports emit — keeps it:
  // the frame adds only its own read stage and the known commit boundary,
  // instead of replacing the decision the caller must obtain with a generic
  // prerequisite problem (the same rule the file route's row frame applies).
  const declared = declaredRecoveryOf(error);
  if (declared !== undefined) {
    return withRecoveryDetails(error, { workflow_id: input.workflowId, stage: input.stage, commit_state: "none" });
  }
  // The evidence a transition reads depends on the transition: a phase /
  // integration-worktree transition reads the registered compass and its Git
  // probes, while a terminal close reads its owned rows' recorded completion
  // evidence (and the Git proof a development/integration row's completion
  // needs). The report names what THIS transition actually reads instead of a
  // generic inventory.
  const readsCompassFacts = input.operation.kind === "phase" || input.operation.kind === "integration-worktree";
  const problem: RecoveryProblem = {
    component: "operation-prerequisite",
    path: workflowOperationField(input.operation),
    code: code ?? "execution.prerequisite-unavailable",
    sourcesTried: [
      `the workflow ${input.workflowId} header and rows this store owns`,
      readsCompassFacts
        ? "the lifecycle's registered compass and the Git probes its checkouts answer"
        : "the recorded completion evidence of the rows this transition composes",
    ],
    currentFacts: [
      input.stage === "read"
        ? readsCompassFacts
          ? `the ${input.operation.kind} transition reads external evidence (the lifecycle's registered compass and its ` +
            `checkout probes) before it can decide, and this call did not get past that read`
          : `the ${input.operation.kind} transition reads its owned rows' recorded completion evidence (and the Git proof a ` +
            `completion needs) before it can decide, and this call did not get past that read`
        : `the ${input.operation.kind} transition re-read its external evidence in the commit window, and it no longer ` +
          `matches what the transition decided against`,
      `the refusal reports: ${message}`,
    ],
    needed: message,
    withheldEffect: "the whole transition: nothing was written, no revision advanced and no receipt was recorded",
    availableWork: [
      `read workflow ${input.workflowId}, its plan rows and its current phase`,
      "transitions whose inputs are stored rows only (lifecycle, execution-policy, delivery) remain available",
      "retry once the named prerequisite is readable again",
    ],
  };
  return withRecoveryDetails(error, {
    component: problem.component,
    path: problem.path,
    workflow_id: input.workflowId,
    stage: input.stage,
    sources_tried: problem.sourcesTried,
    current_facts: problem.currentFacts,
    needed: problem.needed,
    available_work: problem.availableWork,
    commit_state: "none",
    recovery: unresolvedRecovery({
      target: { workflowId: input.workflowId },
      unresolved: [problem],
    }),
  });
}

/**
 * §4.1/§4.2 (A11) the typed cause of a transition the current state refuses: the
 * refusal the transition produced — code, message and its own details untouched —
 * plus the exact conflicting field, the value it holds now, the value the request
 * asks for, the ONE decision the caller must make and what still works. This is
 * the grouped decision of a relevant conflict, not a bare refusal.
 */
function workflowConflictCause(
  error: unknown,
  input: { workflowId: string; operation: WorkflowExecutionOperation; state: Record<string, unknown> },
): unknown {
  const code = refusalCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const field = workflowOperationField(input.operation);
  const stored = describeValue(storedOperationValue(input.state, input.operation));
  const requested = describeValue(requestedOperationValue(input.operation));
  const problem: RecoveryProblem = {
    component: "workflow-header",
    path: field,
    code: code ?? "coordination.invalid-transition",
    sourcesTried: [
      `workflow ${input.workflowId} as this transaction reads it`,
      `the ${input.operation.kind} transition's own rules for ${field}`,
    ],
    currentFacts: [`${field} holds ${stored}`, `the request asks for ${requested}`, `the refusal reports: ${message}`],
    needed: message,
    withheldEffect:
      `the ${input.operation.kind} transition: ${field} was not overwritten, no revision advanced and no receipt ` +
      `was recorded`,
    availableWork: [
      `read the current state of workflow ${input.workflowId}`,
      `retry the ${input.operation.kind} transition once the conflicting fact is resolved`,
      "independent operations on other workflows and plans continue",
    ],
  };
  return withRecoveryDetails(error, {
    component: problem.component,
    path: problem.path,
    workflow_id: input.workflowId,
    current_value: stored,
    requested_value: requested,
    sources_tried: problem.sourcesTried,
    current_facts: problem.currentFacts,
    needed: problem.needed,
    available_work: problem.availableWork,
    recovery: unresolvedRecovery({
      target: { workflowId: input.workflowId },
      unresolved: [problem],
    }),
  });
}

/* ------------------------------------------------------------------------ *
 * §3 `mutateExecutionWorkflow` — the published workflow verb surface
 * ------------------------------------------------------------------------ */

/** Test-only hook to observe the preflight→commit gap of a workflow transition. */
let workflowWitnessGapForTest: (() => void) | undefined;
export function setWorkflowWitnessGapForTest(callback: (() => void) | undefined): void {
  workflowWitnessGapForTest = callback;
}

/**
 * §4.1/E08 the SHARED amendment-component identity of one transition: the
 * `execution-policy` and `integration-worktree` transitions are the two
 * components of the compound Prepare amendment this route performs, so their
 * `recovery.applied` entry is the SAME identity the file route's
 * `amendPrepareWorkflow` emits for the same component value (`execution-policy
 * parallel`, `integration-worktree <checkout>`). A transport therefore consumes
 * one component vocabulary without caring which authority committed the effect.
 *
 * `undefined` for the transitions the file route does not carry (phase,
 * lifecycle, delivery): those keep the lifecycle-scoped entry below, because
 * they are not amendment components and have no counterpart to be identical to.
 */
function amendmentComponentOf(operation: WorkflowExecutionOperation): string | undefined {
  if (operation.kind === "integration-worktree") {
    return prepareAmendmentComponent("integration-worktree", canonicalTarget(operation.path));
  }
  if (operation.kind === "execution-policy") {
    const parallelism = isPlainObject(operation.policy) ? operation.policy.plan_parallelism : undefined;
    return typeof parallelism === "string" && parallelism !== ""
      ? prepareAmendmentComponent("execution-policy", parallelism)
      : undefined;
  }
  return undefined;
}

/**
 * § One resolver path: no workflow was stated and the trusted caller's own
 * identity names none. The refusal is the caller's question — the one
 * selection that would release the addressed transition — in the frozen
 * problem shape, never a guess at the only or most recent workflow.
 */
function unresolvedWorkflowAddress(caller: ExecutionCaller): CoordinationError {
  const bound = isNonEmptyString(caller?.sessionId)
    ? `the trusted caller is a ${String(caller.role)} session ${JSON.stringify(caller.sessionId)}`
    : "the trusted caller carries no usable session identity";
  const code: CoordinationErrorCode = "coordination.invalid-input";
  const problem: RecoveryProblem = {
    component: "target",
    path: "workflowId",
    code,
    sourcesTried: ["workflowId (intent.explicit)", "the trusted caller identity (association)"],
    currentFacts: [bound, "no workflow id was stated by this transition intent"],
    needed: "which workflow this transition addresses",
    withheldEffect:
      "the addressed workflow transition - no target was guessed, so no workflow row, session or CAS token was read for it",
    availableWork: ["address the workflow explicitly (workflowId)", "coordinate the lifecycle this transition belongs to"],
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
 * § One resolver path (S2/E02) for the workflow route: the addressed workflow
 * (the explicit id, else the trusted coordinator's OWN workflow), the current
 * authority route that selects the DB, the caller's OWN live coordinator
 * binding reconstructed from its durable session row (E03/R8/A09) and the
 * workflow token the authority read returned. An explicitly supplied value is
 * passed through untouched, so a fully specified call keeps the strict frame's
 * exact behavior; a caller that omits all three still resolves to the same
 * strict request shape, and its resolved inputs stay strict.
 */
async function resolveWorkflowIntent<Operation extends WorkflowExecutionOperation>(
  context: ExecutionContext,
  request: ExecutionWorkflowIntent<Operation>,
): Promise<WorkflowOperationRequest<Operation>> {
  const workflowId = isNonEmptyString(request.workflowId) ? request.workflowId : context.caller?.workflowId;
  if (!isNonEmptyString(workflowId)) throw unresolvedWorkflowAddress(context.caller);
  if (request.session !== undefined && request.expected !== undefined) {
    return { operationId: request.operationId, session: request.session, expected: request.expected, workflowId, operation: request.operation };
  }
  const session = request.session ?? (await resolveSparseOwnSession(context, "a workflow transition"));
  const expected = request.expected ?? (await readExecutionAuthority(context, { workflowId })).token;
  return { operationId: request.operationId, session, expected, workflowId, operation: request.operation };
}

/**
 * §3 the workflow-level transition surface of the DB authority: one coordinator
 * call carrying the §3.1 mutation envelope (operation id, coordinator session
 * reference, workflow token) and the operation itself, whose member of the closed
 * union selects the transition.
 *
 * § One resolver path (S2/E02) the entry point accepts the SPARSE intent: the
 * coordinator session reference, the workflow token and even the addressed
 * workflow id may be omitted and are resolved here before the strict frame
 * below — the caller states only the intent it owns. A `workflowId` the token
 * cannot be derived for (a terminal or unregistered lifecycle, whose history
 * the ACTIVE read does not serve) is refused instead of invented: present the
 * token the recorded operation returned.
 *
 * The frame is the plan frame's sibling and enforces the same rules: an active
 * authority, the caller's own live coordinator binding, the authority generation
 * the caller's reference and token were read under, ONE revision advance for an
 * accepted operation and a committed receipt that makes an identical retry a
 * replay. The supplied token's ADDRESS and generation are strict; its REVISION is
 * transport freshness, so the frame recomputes the intent against the state it
 * reads now: the SAME operation id replays its recorded receipt, a DISTINCT
 * operation id acts on the current state (R6/A09/A12), a relevant conflict is
 * refused with the exact field (A11), and a superseded authority
 * generation is re-resolved before anything is replayed (A26). It adds nothing a
 * caller can turn into permission: no gate verdict is read from the request, no
 * header field outside the operation's own member is writable, and identity
 * anchors are refused by the shape gate before the store is opened.
 *
 * §R11/A21 an explicit `failed`/`stopped` intent additionally settles the
 * lifecycle's OWN claims whose holder session has stopped, inside this
 * transaction and BEFORE the whole-view witness — the state a stopped holder
 * leaves is exactly what that reader refuses, so settling it first is what makes
 * the terminal outcome reachable. A live holder's claim is never released.
 */
export async function mutateExecutionWorkflow(
  context: ExecutionContext,
  request: ExecutionWorkflowIntent,
): Promise<ExecutionReceipt<ExecutionState>> {
  // The shape gate runs BEFORE the sparse resolver: `operation` is the
  // caller's own intent and needs no store fact, while the resolver may open
  // the authority to derive the omitted session/token — a malformed payload
  // must be an input-shape refusal, never a store-side diagnostic. A null or
  // non-object request takes the same typed path (assertWorkflowOperationShape
  // reads through the optional chain), never a raw TypeError.
  assertWorkflowOperationShape(request == null ? request : (request as { operation?: unknown }).operation);
  const strictRequest = await resolveWorkflowIntent(context, request);
  const resolved = resolveWorkflowOperationRequest(context.caller, strictRequest);
  const operation = resolved.call.operation;
  const workflowId = resolved.read.workflowId;
  let evidence: WorkflowEvidence;
  try {
    evidence = await readWorkflowEvidence(context, resolved);
  } catch (error) {
    throw prerequisiteCause(error, { workflowId, operation, stage: "read" });
  }
  const requestHash = workflowOperationRequestHash(context.caller, workflowId, operation);
  workflowWitnessGapForTest?.();
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; a workflow transition requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    // §2.1/§4.1 (A26) the generation fences run FIRST: a reference or token from
    // a superseded epoch is re-resolved, never answered from a receipt recorded
    // under a generation that no longer exists.
    assertAuthorityGeneration(tx, {
      referenceStoreId: resolved.read.referenceStoreId,
      referenceEpoch: resolved.read.referenceEpoch,
      target: { workflowId },
    });
    const stored = requireWorkflowState(tx, workflowId);
    const freshness = resolveTokenFreshness(
      resolved.call.expected,
      { kind: "workflow", storeId: tx.storeId, epoch: tx.epoch, key: [workflowId], revision: stored.revision },
      { target: { workflowId } },
    );
    // §4.2 the supplied token's ADDRESS and generation are fenced above; its
    // revision is transport freshness. A token whose revision moved is recorded
    // as provenance, not refused (A10): the intent below is recomputed against
    // the state this transaction reads.
    const warnings: readonly ResolutionWarning[] = freshness.current
      ? []
      : [
          {
            code: "execution.token-drifted",
            path: "expected",
            message:
              `the token carries revision ${freshness.readRevision} while workflow ${workflowId} is at revision ` +
              `${freshness.currentRevision}: the revision is transport freshness, so the intent was recomputed against ` +
              `the current state instead of being refused`,
          },
        ];
    // §3.1 (R6/A09) an identical retry returns its recorded receipt — but only
    // after the CURRENT authority is revalidated (a revoked or epoch-invalidated
    // coordinator never replays a receipt it may no longer own). The receipt
    // addresses the whole graph, so its token is the ROOT token. Looking the
    // receipt up before the registry witness is what lets a terminal close's own
    // retry answer, instead of "workflow not found".
    const replay = readOperationReplay<ExecutionState>(tx, {
      operationId: resolved.call.operationId,
      requestHash,
      workflowId,
      planId: null,
      token: { kind: "root", key: [] },
    });
    if (replay !== null) {
      resolveWorkflowSession(tx, resolved.read);
      return {
        ...replay,
        recovery: workflowRecovery({
          workflowId,
          outcome: "already-satisfied",
          applied: [],
          commitState: "committed",
          resolvedFrom: [{ path: "operationId", source: "execution_operations receipt" }],
          warnings: [...warnings, { code: "execution.receipt-replayed", message: "the recorded receipt of this operation id is served; nothing was written." }],
        }),
      };
    }
    // `at` is the ONE timestamp of this accepted operation: the header, the
    // settled claim and the receipt all carry the same instant.
    const at = new Date().toISOString();
    const witness = readExecutionWorkflowWitness(tx, resolved.read);
    // §4.2 retry semantics are two cases and only two: the SAME operation id
    // replays its recorded receipt above, and any OTHER operation id is a fresh
    // operation acting on the state this transaction reads. A header that
    // already holds the requested value is simply re-applied by that fresh
    // operation — there is no effect-held comparison that could refuse it.
    try {
      revalidateWorkflowEvidence(evidence);
    } catch (error) {
      throw prerequisiteCause(error, { workflowId, operation, stage: "revalidate" });
    }
    // §3.1 the ONE revision advance of this accepted multi-domain transaction:
    // header changes advance the addressed workflow once and the store once; a
    // registry membership loss adds the ROOT advance without a second store
    // bump, so the accepted operation advances the store revision exactly once.
    advanceWorkflowHeaderRevision(tx, { workflowId: witness.workflowId, now: at });
    let receipt: ExecutionRead<ExecutionState>;
    try {
      receipt = applyWorkflowOperation({ tx, witness, read: resolved.read, operation, evidence, at });
    } catch (error) {
      throw workflowConflictCause(error, { workflowId, operation, state: stored.state });
    }
    writeOperationReceipt(tx, {
      operationId: resolved.call.operationId,
      requestHash,
      workflowId: witness.workflowId,
      planId: null,
      receipt,
      now: at,
    });
    return {
      ...receipt,
      operationId: resolved.call.operationId,
      replayed: false,
      recovery: workflowRecovery({
        workflowId,
        outcome: "applied",
        applied: [amendmentComponentOf(operation) ?? `${operation.kind} on workflow ${workflowId}`],
        commitState: "committed",
        resolvedFrom: [{ path: workflowOperationField(operation), source: "intent.request" }],
        warnings,
      }),
    };
  });
}

/**
 * §3 the one accepted workflow transition, applied inside the frame's
 * transaction: the candidate header is built from the operation's own member
 * only, validated by the existing snapshot validator, and stored; a terminal
 * lifecycle additionally loses its registry membership in the SAME transaction,
 * so a close that refuses leaves both the routing and the terminal state
 * exactly where they were.
 *
 * §R5/§R10 a terminal `completed` close composes the bookkeeping its owned rows'
 * recorded evidence entails (E10) — the report-only fulfilment, the row `Done`
 * delta and the ownership release — BEFORE the terminal decision, through the
 * same completion rules the plan route's `complete` applies. Everything
 * therefore commits on ONE handle in ONE transaction: a crash leaves either the
 * whole close or none of it, and the terminal decision judges the rows this
 * transaction just completed.
 *
 * §R11/A21 a `failed`/`stopped` close composes no row bookkeeping at all (no
 * successful-delivery precondition): it settles the workflow's own stopped
 * integration claim here, and the terminal decision then judges exactly the
 * ownership this transaction leaves behind.
 */
function applyWorkflowOperation(input: {
  tx: ExecutionTransaction;
  witness: ExecutionWorkflowWitness;
  read: ResolvedWorkflowWrite;
  operation: WorkflowExecutionOperation;
  evidence: WorkflowEvidence;
  at: string;
}): ExecutionRead<ExecutionState> {
  const { tx, witness, read, operation, evidence, at } = input;
  const workflowId = witness.workflowId;
  const current = witness.view.state as unknown as WorkflowSnapshot;
  // §R10/A20 a RESTATEMENT of the status a terminal lifecycle already records is
  // its own membership repair: the outcome and its `ended_at` stay exactly as
  // they were recorded, and only the outstanding ACTIVE registry row is cleaned
  // up in this transaction. Every other request against a closed lifecycle is
  // refused — a terminal outcome is never rewritten.
  const residueRepair = isTerminalSnapshot(current) && operation.kind === "lifecycle" && operation.status === current.status;
  if (isTerminalSnapshot(current) && !residueRepair) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} is ${current.status} \u2014 a closed lifecycle is never amended, and its history stays exactly as ` +
        `it was recorded`,
      { workflow_id: workflowId, status: current.status },
    );
  }
  const composed =
    !residueRepair && operation.kind === "lifecycle" && operation.status === "completed"
      ? composeEntailedCompletions({ tx, witness, read, evidence, at })
      : { completions: [] as readonly EntailedRowCompletion[], fulfilment: null };
  // §R11/A21 the failed/stopped close settles the workflow's OWN merge claim:
  // it goes when its holder's session is not active at this epoch, and stays
  // when that holder is live. It reads the claim from the witness this
  // transaction already holds (the whole-view reader carries a merge claim
  // whatever its holder's state), so a settled claim re-reads the witness below.
  const claim = operation.kind === "lifecycle" && (operation.status === "failed" || operation.status === "stopped")
    ? witness.view.integrationLease
    : null;
  const settledClaim =
    claim !== null && releaseStoppedMergeClaim(tx, { workflowId, claim, releasedBy: witness.session.sessionId, at });
  // §R5 the rows the terminal decision reads are the ones this transaction just
  // completed, and the ownership it reads is the ownership this transaction just
  // released: both are re-read from the handle the transaction owns.
  const effective = composed.completions.length === 0 && !settledClaim ? witness : readExecutionWorkflowWitness(tx, read);
  const rows = effective.view.plans.map((plan) => plan.plan as unknown as PlanRow);
  const header = { ...(effective.view.state as unknown as Record<string, unknown>) };
  if (composed.fulfilment !== null) {
    // The report-only fulfilment is the ONE member recorded BEFORE the row is
    // marked `Done` (contract §1): the composition records it first, in the same
    // atomic state the completion commits — never a second caller step and never
    // a re-point of a fulfilment the row's `Done` was already authorized against
    // (`entailedFulfilment` refuses that).
    const stored = isPlainObject(header.delivery) ? (header.delivery as Record<string, unknown>) : {};
    header.delivery = { ...stored, completion: composed.fulfilment };
  }
  let membershipLost = false;
  switch (operation.kind) {
    case "phase":
      applyPhaseTransition({ header, rows, workflowId, operation, evidence });
      break;
    case "lifecycle":
      membershipLost = applyLifecycleTransition({ header, rows, witness: effective, workflowId, operation, at });
      break;
    case "execution-policy":
      header.execution_policy = applyExecutionPolicy(workflowId, operation.policy);
      break;
    case "integration-worktree":
      header.integration_worktree_path = requireWorktreeEvidence(evidence).worktree.path;
      break;
    case "delivery":
      header.delivery = applyDeliveryEvidence({ header, rows, workflowId, delivery: operation.delivery });
      break;
  }
  header.updated_at = at;
  assertHeaderValid(workflowId, header);
  writeWorkflowState(tx, { workflowId, state: header });
  if (membershipLost) recordRootMembershipLoss(tx, { workflowId, now: at });
  return readExecutionStateGraph(tx);
}

/**
 * §R5/§R10 the row completions and the report-only fulfilment one terminal
 * `completed` close composes, applied inside the close's own transaction. Each
 * proof is matched to the row the transaction reads RIGHT NOW: a row that
 * already records `Done` in that read composes nothing (a sibling operation in
 * the window is never rewritten), and a row the preflight proved is completed
 * here through the same rules `complete` applies.
 */
function composeEntailedCompletions(input: {
  tx: ExecutionTransaction;
  witness: ExecutionWorkflowWitness;
  read: ResolvedWorkflowWrite;
  evidence: WorkflowEvidence;
  at: string;
}): { completions: readonly EntailedRowCompletion[]; fulfilment: { policy: string; evidence: string } | null } {
  const { tx, witness, read, evidence, at } = input;
  const proofs = evidence.completions ?? [];
  const pinned = evidence.pinned;
  if (proofs.length === 0 || pinned === undefined) return { completions: [], fulfilment: null };
  let fulfilment: { policy: string; evidence: string } | null = null;
  const applied: EntailedRowCompletion[] = [];
  for (const proof of proofs) {
    // Each proof is matched to the row this transaction reads RIGHT NOW, and the
    // ownership facts are read with it: a row another step of THIS transaction
    // just completed is skipped, and a release composed for an earlier row is
    // already visible to the next one instead of being re-derived from a stale
    // sibling view.
    const current = readExecutionWorkflowWitness(tx, read);
    const row = current.view.plans.find((candidate) => candidate.plan.id === proof.planId);
    if (row === undefined) continue;
    if (proof.completesRow && rowStatusOf(row.plan as unknown as PlanRow) === "Done") continue;
    const snapshot = {
      ...(current.view.state as unknown as Record<string, unknown>),
      plans: current.view.plans.map((plan) => plan.plan as unknown as PlanRow),
      ...(current.view.integrationLease === null ? {} : { integration_merge_lease: current.view.integrationLease }),
    } as unknown as WorkflowSnapshot;
    applyEntailedCompletion({
      tx,
      frame: completionFrameFor({
        workflow: current.view,
        planId: proof.planId,
        sessionId: witness.session.sessionId,
      }),
      snapshot,
      pinned,
      proof,
      at,
      what: "close",
    });
    if (proof.fulfilment !== null) fulfilment = proof.fulfilment;
    applied.push(proof);
  }
  return { completions: applied, fulfilment };
}

/** The pre-transaction evidence a transition must have read (an internal invariant). */
function requireCompassEvidence(evidence: WorkflowEvidence): { compass: CompassEvidence; probes: PhaseGateOptions } {
  if (evidence.compass === undefined) {
    throw invalidWorkflowInput("the phase transition ran without its pinned compass evidence");
  }
  return { compass: evidence.compass, probes: evidence.probes ?? {} };
}

function requireWorktreeEvidence(evidence: WorkflowEvidence): { worktree: { path: string; branch: string } } {
  if (evidence.worktree === undefined) {
    throw invalidWorkflowInput("the integration-worktree transition ran without its validated checkout");
  }
  return { worktree: evidence.worktree };
}

/** The candidate header must be a valid snapshot before it is stored. */
function assertHeaderValid(workflowId: string, header: Record<string, unknown>): void {
  const gate = validateWorkflowSnapshot({ ...header, plans: [] });
  if (!gate.ok) {
    throw invalidWorkflowTransition(
      `the workflow ${workflowId} header this transition would store does not validate (${summarize(gate.violations)})`,
      { workflow_id: workflowId },
    );
  }
}

/**
 * §3 the `phase` transition: the requested phase must be the transition the
 * lifecycle's own compass and its committed plan rows produce RIGHT NOW. The
 * gate is evaluated inside the transaction over the rows the commit will see,
 * with current checkout branch facts revalidated immediately before it — so a phase that
 * was skipped (the gate still says `phase-2-execute`) is refused, and no
 * caller-supplied verdict can enter the decision.
 */
function applyPhaseTransition(input: {
  header: Record<string, unknown>;
  rows: readonly PlanRow[];
  workflowId: string;
  operation: Extract<WorkflowExecutionOperation, { kind: "phase" }>;
  evidence: WorkflowEvidence;
}): void {
  const { header, rows, workflowId, operation, evidence } = input;
  const { compass, probes } = requireCompassEvidence(evidence);
  const checkout = evidence.checkout;
  if (checkout !== undefined) {
    const registeredPath = isNonEmptyString(header.integration_worktree_path)
      ? canonicalTarget(header.integration_worktree_path)
      : null;
    if (registeredPath !== checkout.path) {
      throw new CoordinationError(
        "coordination.path-mismatch",
        `the integration checkout of workflow ${workflowId} changed after its branch was probed (${String(checkout.path)} -> ` +
          `${String(registeredPath)}); retry the phase transition against the current registered checkout`,
        { workflow_id: workflowId, expected: registeredPath, actual: checkout.path },
      );
    }
  }
  const gate = evaluatePhaseGate(
    { ...(header as unknown as WorkflowSnapshot), plans: [...rows] },
    compass.doc,
    probes,
  );
  if (gate.transition !== operation.phase) {
    // `gate.violations` carries the blocking items only once every plan is
    // Done; before that the entry checklist is what the gate is still reading,
    // and the refusal names it so the caller sees the evidence, not just the verdict.
    const blocking = gate.violations.length > 0 ? gate.violations : gate.entry.violations;
    throw invalidWorkflowTransition(
      `workflow ${workflowId} cannot move to ${operation.phase}: the registered compass and the accepted plan rows give ` +
        `${gate.transition}${blocking.length === 0 ? "" : ` (${summarize(blocking)})`}. A phase the gate does not produce ` +
        `is a skipped phase, and this route never jumps it`,
      { workflow_id: workflowId, requested: operation.phase, gate: gate.transition },
    );
  }
  header.phase = operation.phase;
}

/**
 * §3/§7 the `lifecycle` transition. A non-terminal status (running ⇄ paused) is
 * a header fact and touches NO lease — the leases stay exactly where they are,
 * released only by the explicit completion/reconcile transitions. A terminal
 * status additionally runs the existing rules: `completed` needs every owned row
 * `Done` and the existing delivery-evidence consultation to be clean, every
 * terminal status needs the lifecycle to own no lease a LIVE holder still holds
 * (the snapshot validator's terminal invariant, read from the rows that own
 * them), and the loss of registry membership commits with the terminal state.
 *
 * §R11/A21 `failed`/`stopped` demands NO successful-delivery evidence, and the
 * workflow's own integration merge claim is settled before this decision runs
 * when its holder has stopped (`releaseStoppedMergeClaim`), so what is left
 * dangling here is exactly a live holder's claim — which this route refuses on
 * rather than releasing a claim that is another session's.
 *
 * A restatement of the status the lifecycle is already in is ACCEPTED as an
 * ordinary operation (it changes only `updated_at`): the state machine has no
 * "already there" branch, and the committed receipt is what makes the retry
 * idempotent.
 *
 * Returns true when this transition removed the workflow from the ACTIVE
 * registry.
 */
function applyLifecycleTransition(input: {
  header: Record<string, unknown>;
  rows: readonly PlanRow[];
  witness: ExecutionWorkflowWitness;
  workflowId: string;
  operation: Extract<WorkflowExecutionOperation, { kind: "lifecycle" }>;
  at: string;
}): boolean {
  const { header, rows, witness, workflowId, operation, at } = input;
  const status = operation.status;
  if (header.status === status) {
    // §R10/A20 a RESTATEMENT of the status a terminal lifecycle already records
    // is its own cleanup: the recorded outcome and its `ended_at` stay exactly
    // as they were, and losing the outstanding ACTIVE registry row is the whole
    // effect — the residue a crash or a foreign writer left behind. A running
    // restatement remains the ordinary no-op it was.
    return (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(status);
  }
  if (!(WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(status)) {
    header.status = status;
    delete header.ended_at;
    return false;
  }
  if (status === "completed") {
    const notDone = rows.filter((row) => rowStatusOf(row) !== "Done");
    if (notDone.length > 0) {
      throw invalidWorkflowTransition(
        `workflow ${workflowId} cannot complete: every owned plan row must be Done \u2014 ${notDone
          .map((row) => `${String(row.id)} (${rowStatusOf(row) || "no status"})`)
          .join(", ")}`,
        { workflow_id: workflowId },
      );
    }
    const violations = consultDeliveryEvidence({ ...(header as unknown as WorkflowSnapshot), plans: [...rows] });
    if (violations.length > 0) {
      throw invalidWorkflowTransition(
        `workflow ${workflowId} cannot complete: ${summarize(violations)}`,
        { workflow_id: workflowId },
      );
    }
  }
  const dangling = danglingOwnership(witness);
  if (dangling.length > 0) {
    throw invalidWorkflowTransition(
      status === "completed"
        ? `workflow ${workflowId} cannot become ${status} while it still owns ${dangling.join(", ")} \u2014 a terminal lifecycle ` +
          `carries no dangling lease, and this route never deletes one: release it through the ordinary completion that ` +
          `owns the claim first`
        : `workflow ${workflowId} cannot become ${status} while it still owns ${dangling.join(", ")} \u2014 this close settles only a ` +
          `claim whose holder has stopped, and a LIVE holder's claim needs that holder's own stop or the ordinary completion ` +
          `that releases it`,
      { workflow_id: workflowId, status },
    );
  }
  header.status = status;
  header.ended_at = at;
  return true;
}

/**
 * The outstanding ownership a terminal lifecycle may not carry, as named facts.
 * A failed/stopped close reaches it only after its own stopped merge claim was
 * settled (`releaseStoppedMergeClaim`), so what remains here is a claim a live
 * holder still holds. The removed per-plan write lease is gone with the plan-PM
 * seat, so the workflow's integration merge claim is the whole remaining
 * ownership this close may not leave dangling.
 */
function danglingOwnership(witness: ExecutionWorkflowWitness): string[] {
  const dangling: string[] = [];
  if (witness.view.integrationLease !== null) {
    dangling.push(`the integration merge lease (holder ${witness.view.integrationLease.holder})`);
  }
  return dangling;
}

/**
 * §3 the `execution-policy` transition: the closed policy object the snapshot
 * schema defines. `plan_parallelism` is the ONE key the approved concurrency
 * contract names values for — the SAME closed set `coordination.ts` exports
 * (`PLAN_PARALLELISM_VALUES`) and the file route's Prepare amendment applies, so
 * the two authority routes share one rule instead of two lists that can drift
 * (E08); `worktree_mode` / `push_policy` stay the accepted-but-opaque keys the
 * snapshot validator declares them to be, and an unknown key is refused instead
 * of stored.
 *
 * The operation REPLACES the block: the union member is the whole policy, so a
 * key the payload omits is removed rather than retained. There is no partial
 * policy patch here, because a header patch is exactly what this route must not
 * offer.
 */
export function workflowExecutionPolicyViolations(value: unknown, workflowId = "workflow"): string[] {
  if (!isPlainObject(value)) return ["execution_policy must be an object"];
  const unknown = Object.keys(value).filter((key) => !["plan_parallelism", "worktree_mode", "push_policy"].includes(key));
  const violations = unknown.length === 0 ? [] : [`workflow ${workflowId} execution_policy has unknown key(s) ${unknown.join(", ")}`];
  const parallelism = value.plan_parallelism;
  if (parallelism !== undefined && (typeof parallelism !== "string" || !PLAN_PARALLELISM_VALUES.includes(parallelism))) {
    violations.push(`workflow ${workflowId} execution_policy.plan_parallelism must be one of ${PLAN_PARALLELISM_VALUES.join(" | ")}`);
  }
  return violations;
}

function applyExecutionPolicy(workflowId: string, policy: WorkflowExecutionPolicy): WorkflowExecutionPolicy {
  // The unknown-key refusal is the closed-vocabulary guard (`forbidden-field`,
  // the same class the operation's own exact-keys gate raises), while a KNOWN
  // key carrying a malformed value is an input-shape refusal.
  if (isPlainObject(policy)) {
    const unknown = Object.keys(policy).filter((key) => !["plan_parallelism", "worktree_mode", "push_policy"].includes(key));
    if (unknown.length > 0) {
      throw new CoordinationError(
        "coordination.forbidden-field",
        `workflow ${workflowId} execution_policy accepts only plan_parallelism, worktree_mode, push_policy ` +
          `\u2014 unexpected key(s): ${unknown.join(", ")}`,
        { unexpected: unknown, allowed: ["plan_parallelism", "worktree_mode", "push_policy"] },
      );
    }
  }
  const violations = workflowExecutionPolicyViolations(policy, workflowId);
  if (violations.length > 0) throw invalidWorkflowInput(violations.join("; "));
  return { ...policy };
}

/**
 * §3 the `delivery` transition: the same evidence rules the file route's
 * `recordWorkflowDelivery` enforces — the declared kind decides which members
 * exist (one shared member map), the structural validator decides their shape,
 * and §4d requires an incoming identity to BE the registered delivery by field
 * value. Re-recording a delivery (the PR identity, the report-only `completion`
 * fulfilment, the compound disposition, the merge record) is a revisable
 * mutation under a new operation id; a tampered replay of the SAME operation id
 * is refused by the request-hash conflict. An identical re-record is a no-op.
 */
function applyDeliveryEvidence(input: {
  header: Record<string, unknown>;
  rows: readonly PlanRow[];
  workflowId: string;
  delivery: WorkflowDeliveryEvidence;
}): WorkflowDeliveryEvidence {
  const { header, rows, workflowId, delivery } = input;
  const kind = header.delivery_kind;
  if (header.type !== "plan" || (kind !== "development" && kind !== "verification/report-only")) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} cannot record delivery evidence: only a type: plan lifecycle with a registered delivery_kind ` +
        `carries one (got type ${JSON.stringify(header.type)} / delivery_kind ${JSON.stringify(kind ?? null)}) \u2014 the kind is ` +
        `declared at registration and never inferred (contract \u00A71)`,
      { workflow_id: workflowId },
    );
  }
  const members = Object.keys(delivery);
  const allowed = deliveryEvidenceMembers(kind);
  const unused = members.filter((member) => !allowed.includes(member));
  if (unused.length > 0) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} cannot record member(s) ${unused.join(", ")}: the declared delivery_kind '${kind}' uses ` +
        `${allowed.join(" | ")}`,
      { workflow_id: workflowId },
    );
  }
  const shape = deliveryEvidenceViolations(delivery, "the delivery patch");
  if (shape.length > 0) {
    throw invalidWorkflowInput(`the delivery patch does not validate (${summarize(shape)})`);
  }
  const stored = (isPlainObject(header.delivery) ? header.delivery : {}) as Record<string, unknown>;
  const incomingPr = isPlainObject(delivery.pr) ? delivery.pr : undefined;
  const recordedPr = isPlainObject(stored.pr) ? stored.pr : undefined;
  if (recordedPr !== undefined && incomingPr !== undefined &&
      (recordedPr.repo !== incomingPr.repo || recordedPr.head !== incomingPr.head || recordedPr.target !== incomingPr.target)) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} records a different PR identity; use the registered delivery identity or a separate workflow`,
      { workflow_id: workflowId },
    );
  }
  const branch = isPlainObject(header.branch) ? header.branch : {};
  if (incomingPr !== undefined) {
    if (isNonEmptyString(branch.source) && incomingPr.head !== branch.source) {
      throw invalidWorkflowTransition(
        `workflow ${workflowId} records delivery.pr.head ${JSON.stringify(incomingPr.head)}, but the registered delivery ` +
          `source is ${JSON.stringify(branch.source)} (\u00A74d: the recorded PR identity must be the registered delivery)`,
        { workflow_id: workflowId },
      );
    }
    if (isNonEmptyString(branch.target) && incomingPr.target !== branch.target) {
      throw invalidWorkflowTransition(
        `workflow ${workflowId} records delivery.pr.target ${JSON.stringify(incomingPr.target)}, but the registered delivery ` +
          `target is ${JSON.stringify(branch.target)} (\u00A74d)`,
        { workflow_id: workflowId },
      );
    }
  }
  // §R5/A19 the delivery tail (compound | pr | merge) is EXTERNAL evidence that
  // arrives when it arrives: the engine captures it whenever it is observed and
  // never makes the row's `Done` projection an ordering prerequisite, because
  // the close composes that projection itself from the same evidence (E10). The
  // semantic boundary is the CLOSE, which still requires the declared kind's
  // complete evidence (`consultDeliveryEvidence`) against rows it has completed —
  // so the ordering is bookkeeping rather than a caller ceremony.
  //
  // Completion freezes its accepted policy/reference, not the document body.
  if (members.includes("completion") && rows.some((row) => rowStatusOf(row) === "Done")) {
    const incoming = isPlainObject(delivery.completion) ? delivery.completion : undefined;
    const recorded = isPlainObject(stored.completion) ? stored.completion : undefined;
    if (recorded === undefined || incoming === undefined ||
        recorded.policy !== incoming.policy || recorded.evidence !== incoming.evidence) {
      throw new CoordinationError(
        "coordination.completion-frozen",
        `workflow ${workflowId} is Done against its recorded completion policy/reference; edit the referenced document normally; a different completed intent uses its own workflow`,
        { workflow_id: workflowId },
      );
    }
  }
  return { ...stored, ...delivery } as WorkflowDeliveryEvidence;
}

/* ------------------------------------------------------------------------ *
 * §2.3/§4.2 `recoverExecutionCoordinator` — the explicit recovery bootstrap
 * ------------------------------------------------------------------------ */

/** §3.1: the operation kind a recovery request hashes its request under. */
const RECOVER_COORDINATOR_OPERATION = "recoverExecutionCoordinator";

/**
 * §3.1 the request hash of one recovery: operation kind, the addressed
 * workflow, the exact token, the trusted caller, the named prior holder, the
 * reason and the attestation that authorizes it.
 */
function recoverCoordinatorRequestHash(
  caller: ExecutionCaller,
  workflowId: string,
  input: { expected: ExecutionToken; priorSessionId: string | null; reason: string; attestation: ActivationAttestation },
): string {
  return createHash("sha256")
    .update(
      serializeExecutionValue({
        operation: RECOVER_COORDINATOR_OPERATION,
        workflow_id: workflowId,
        expected: input.expected,
        caller: {
          session_id: caller.sessionId,
          role: caller.role,
          workflow_id: caller.workflowId,
        },
        prior_session_id: input.priorSessionId,
        reason: input.reason,
        attestation: input.attestation,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * §2.3/§4.2 the explicit coordinator recovery bootstrap: the ONE transition that
 * replaces a crashed, imported or revoked coordinator identity, and the only
 * lawful way back for a revoked/suspended/epoch-invalidated binding (a normal
 * bind never replaces a recorded owner).
 *
 * Requirements, in order — every one of them is refused before a byte is
 * written:
 *
 * 1. the trusted caller is the workflow's COORDINATOR: the recovery identity is
 *    never taken from request JSON;
 * 2. the exact workflow token is the CAS, and the lifecycle is still an active
 *    one (running/paused); a terminal lifecycle is never reopened;
 * 3. the named prior holder exists in this workflow's records, and `null` is
 *    only admissible when the workflow records no coordinator row at all — an
 *    unnamed holder is refused rather than guessed;
 * 4. if the workflow holds a LIVE coordinator at this epoch, that session is the
 *    only one recovery may replace: naming any other identity is refused
 *    (`coordination.duplicate-holder`), because ownership is not replaceable by
 *    another identity;
 * 5. the operator attestation is a valid `ActivationAttestation` (the existing
 *    document rule: an authorization reference, at least one installed consumer
 *    and exactly one current coordinator) AND it names the prior holder as
 *    stopped/reloaded. A named holder with no stop evidence is refused — the
 *    engine cannot observe a dead process, so the attested stop IS the trust
 *    boundary, and without it this transition would be the silent takeover it
 *    must never be.
 *
 * The atomic effect: the prior session row is revoked, the caller's own row is
 * rebound active at the current epoch (fresh, or reactivated from its own
 * non-active row), the workflow header revision advances once and an immutable
 * operation receipt records the prior holder, the reason and the attestation.
 * The coordinator holds no per-plan claim to adopt: the removed plan-PM seat's
 * leases are gone with its table, and the workflow's own integration merge
 * claim is settled by the close/completion transitions that own it.
 */
export async function recoverExecutionCoordinator(
  context: ExecutionContext,
  input: { expected: ExecutionToken; operationId: string; priorSessionId: string | null; reason: string; attestation: ActivationAttestation },
): Promise<ExecutionReceipt<ExecutionSessionRef>> {
  const caller = context.caller;
  if (caller?.role !== "coordinator") {
    throw new ExecutionError(
      "execution.scope-mismatch",
      `recovering a coordinator identity is a coordinator operation; the supplied caller is a ${String(caller?.role)} session. ` +
        `The caller identity is never taken from request JSON.`,
    );
  }
  const workflowId = caller.workflowId;
  if (!isNonEmptyString(workflowId) || !isNonEmptyString(caller.sessionId)) {
    throw invalidWorkflowInput("recovering a coordinator needs a caller with a non-empty session and workflow identity");
  }
  const operationId = assertOperationId(input?.operationId);
  const reason = input?.reason;
  if (!isNonEmptyString(reason)) {
    throw invalidWorkflowInput("recovering a coordinator needs the non-empty reason it is recorded with");
  }
  const priorSessionId = input?.priorSessionId;
  if (priorSessionId !== null && !isNonEmptyString(priorSessionId)) {
    throw invalidWorkflowInput(
      "recovering a coordinator needs priorSessionId: the session identity it replaces, or null only when the workflow records no coordinator at all",
    );
  }
  // The operator's authorization is a DOCUMENT here, exactly as at the
  // activation barrier: the existing validator project the declared shape, so a
  // credential-bearing or incomplete attestation never reaches the store.
  const attestation = validateActivationAttestation(input?.attestation);
  const requestHash = recoverCoordinatorRequestHash(caller, workflowId, {
    expected: input.expected,
    priorSessionId,
    reason,
    attestation,
  });
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; recovering a coordinator requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    const sessionKey = [workflowId, "coordinator", caller.sessionId] as const;
    const replay = readOperationReplay<ExecutionSessionRef>(tx, {
      operationId,
      requestHash,
      workflowId,
      planId: null,
      token: { kind: "session", key: sessionKey },
    });
    if (replay !== null) {
      // §3.1 a replay revalidates current authority: the recovery that is
      // replayed must still be the binding this workflow holds.
      requireLiveCoordinator(tx, workflowId, caller.sessionId);
      return replay;
    }
    const header = requireWorkflowState(tx, workflowId);
    assertExecutionToken(input.expected, {
      kind: "workflow",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [workflowId],
      revision: header.revision,
    });
    const status = String(header.state.status ?? "");
    if ((WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(status)) {
      throw invalidWorkflowTransition(
        `workflow ${workflowId} is ${String(status)} \u2014 recovery binds an ACTIVE lifecycle's coordinator, and a closed ` +
          `lifecycle is never reopened`,
        { workflow_id: workflowId, status },
      );
    }
    const rows = readCoordinatorRows(tx, workflowId);
    const live = rows.find((row) => row.state === "active" && row.ref.epoch === tx.epoch);
    if (priorSessionId === null) {
      if (rows.length > 0) {
        throw invalidWorkflowTransition(
          `workflow ${workflowId} records coordinator session(s) ${rows.map((row) => `${row.ref.sessionId} (${row.state})`).join(", ")} \u2014 ` +
            `recovery must NAME the holder it replaces instead of claiming there is none`,
          { workflow_id: workflowId },
        );
      }
    } else {
      const prior = rows.find((row) => row.ref.sessionId === priorSessionId);
      if (prior === undefined) {
        throw new CoordinationError(
          "coordination.session-not-found",
          `workflow ${workflowId} records no coordinator session ${priorSessionId} to recover from`,
          { workflow_id: workflowId },
        );
      }
      // A LIVE holder is never replaced by another name: the recovery identity
      // is the holder the stop evidence was given for, or nothing.
      if (live !== undefined && live.ref.sessionId !== priorSessionId) {
        throw new CoordinationError(
          "coordination.duplicate-holder",
          `workflow ${workflowId} holds the ACTIVE coordinator session ${live.ref.sessionId} at epoch ${tx.epoch}; recovery ` +
            `may replace only the holder it names (${priorSessionId}). Ownership is not replaceable by another identity, ` +
            `and a live holder resumes through its own reference. Nothing was recovered.`,
          { workflow_id: workflowId, holder: live.ref.sessionId, named: priorSessionId },
        );
      }
      // The stop evidence is the trust boundary: the engine cannot observe a
      // dead process, so a named holder that nobody attested stopped is
      // refused — that is exactly the silent takeover this transition must not
      // perform.
      if (!attestation.stoppedSessions.some((session) => session.sessionId === priorSessionId)) {
        throw invalidWorkflowTransition(
          `the attestation does not name the prior coordinator ${priorSessionId} as stopped/reloaded \u2014 recovery requires ` +
            `stop evidence for the holder it replaces, so it can never take over a session nobody observed to be gone`,
          { workflow_id: workflowId, session_id: priorSessionId },
        );
      }
    }

    const now = new Date().toISOString();
    if (priorSessionId !== null && priorSessionId !== caller.sessionId) {
      revokeSessionRow(tx, { workflowId, role: "coordinator", sessionId: priorSessionId });
    }
    const revision = bindRecoveredSession(tx, {
      workflowId,
      role: "coordinator",
      sessionId: caller.sessionId,
      epoch: tx.epoch,
      now,
    });
    advanceWorkflowHeaderRevision(tx, { workflowId, now });
    const receipt: ExecutionRead<ExecutionSessionRef> = {
      data: {
        storeId: tx.storeId,
        epoch: tx.epoch,
        workflowId,
        role: "coordinator",
        sessionId: caller.sessionId,
      },
      token: executionToken("session", tx.storeId, tx.epoch, sessionKey, revision),
      storeId: tx.storeId,
      epoch: tx.epoch,
    };
    // The immutable recovery receipt: the session the store now holds, plus the
    // provenance of the replacement (prior holder, reason, attestation), which
    // only a committed operation row can carry.
    writeOperationReceipt(tx, {
      operationId,
      requestHash,
      workflowId,
      planId: null,
      receipt: {
        ...receipt,
        recovery: {
          prior_session_id: priorSessionId,
          reason,
          attested_at: attestation.attestedAt,
          operator: attestation.operator,
          stopped_sessions: attestation.stoppedSessions.map((session) => session.sessionId),
        },
      } as ExecutionRead<ExecutionSessionRef>,
      now,
    });
    return { ...receipt, operationId, replayed: false };
  });
}

/** §2.2 the coordinator rows of one workflow, including the non-active ones. */
function readCoordinatorRows(tx: ExecutionTransaction, workflowId: string): SessionRow[] {
  return readWorkflowSessionRows(tx, workflowId, "coordinator");
}

/** §2.3 a replay's authority revalidation: the caller must still hold its binding. */
function requireLiveCoordinator(tx: ExecutionTransaction, workflowId: string, sessionId: string): void {
  const live = readCoordinatorRows(tx, workflowId).find(
    (row) => row.ref.sessionId === sessionId && row.state === "active" && row.ref.epoch === tx.epoch,
  );
  if (live === undefined) {
    throw new ExecutionError(
      "execution.session-unavailable",
      `workflow ${workflowId} holds no ACTIVE coordinator session ${sessionId} in epoch ${tx.epoch}; the recovery this call ` +
        `replays is no longer the binding the store records`,
    );
  }
}

/** §2.2 the coordinator rows of one workflow, including the non-active ones. */