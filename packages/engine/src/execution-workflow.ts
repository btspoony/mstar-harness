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
 *   `delivery_kind` and `completion_policy` are not writable through this route
 *   at all; the branch anchors (`branch.base` / `branch.work` / `branch.target`)
 *   are writable ONLY through the guarded `delivery-anchors` member, which names
 *   exactly those fields, requires a reason and stays under the workflow CAS
 *   token. The candidate header is validated by the existing snapshot validator
 *   before it is stored.
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
 *   operator attestation must name that session as stopped/reloaded
 *   (`validateRecoveryAttestation` supplies the operator authorization
 *   reference; the store is already active, so no installed-consumer
 *   attestation is required);
 * - revocation and rebinding commit together with an immutable operation
 *   receipt recording the prior holder, the reason and the attestation digest;
 * - the coordinator holds no per-plan claim to adopt: the removed plan-PM
 *   seat's leases are gone, and the workflow's own integration merge claim is
 *   settled by the close/completion transitions that own it;
 * - a TERMINAL workflow is never reopened, but the ONE ownership a crash can
 *   leave on it — a held integration merge lease — is releasable through that
 *   same call: the header, registry and session rows stay frozen, and only the
 *   lease tombstone and its operation receipt are written.
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
} from "./coordination.js";
import { rowStatusOf, summarize } from "./coordination-transitions.js";
import {
  deliveryRouteOf,
  releaseStoppedMergeClaim,
  resolveSparseOwnSession,
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
  readWorkflowOperationReplayBeforeProof,
  readWorkflowSessionRows,
  recordRootMembershipLoss,
  releaseIntegrationMergeLease,
  requireWorkflowState,
  resolveTokenFreshness,
  resolveWorkflowSession,
  resolveWorkflowWrite,
  revokeSessionRow,
  semanticRequestHash,
  serializeExecutionValue,
  withExecutionTransaction,
  withRecoveryDetails,
  pruneWorkflowOperationReceipts,
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
  type HolderLiveWarning,
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
import { validateRecoveryAttestation, type ActivationAttestation } from "./store-activation.js";
import { provisionRecoveryDocument } from "./activation-provisioning.js";
import { StoreError, storeDbPath } from "./store-db.js";
import {
  WORKFLOW_LIFECYCLE_STATUSES,
  WORKFLOW_TERMINAL_STATUSES,
  consultDeliveryEvidence,
  deliveryBranchOf,
  deliveryEvidenceMembers,
  deliveryEvidenceViolations,
  isTerminalSnapshot,
  normalizeIterationCompassRef,
  validateWorkflowSnapshot,
  type WorkflowDeliveryEvidence,
  type IntegrationMergeLease,
  type WorkflowExecutionPolicy,
  type WorkflowSnapshot,
} from "./workflow.js";
import { assertBranchAlignment, isDistinctCheckout, readMainWorktree } from "./worktree.js";
import { validateWorkflowEntry, type PlanRow } from "./status.js";

/* ------------------------------------------------------------------------ *
 * §3 the closed workflow-operation union
 * ------------------------------------------------------------------------ */

/**
 * §3 the whole workflow-level verb vocabulary of the DB authority, verbatim:
 * the phase machine, the lifecycle status, the execution policy, the
 * integration checkout, the delivery evidence and the delivery anchors. Each
 * member is a real transition with one implementation below; there is no
 * header-patch member, because an arbitrary header replacement is exactly what
 * this route must not offer.
 *
 * `delivery-anchors` is deliberately NOT that arbitrary header patch: it names
 * exactly the branch anchors a plan's delivery names (`branch.base` /
 * `branch.work` / `branch.target`), it requires a non-empty reason so the
 * correction is auditable, every anchor it supplies must be a non-empty string,
 * and the anchors it writes commit under the SAME workflow CAS token as every
 * other member — so a competing writer still loses the revision race and a
 * re-read always sees a whole header. A registered workflow is REPAIRABLE rather
 * than re-registrable: without it a mistyped anchor could only be corrected by
 * abandoning the lifecycle. The deprecated `branch.source` spelling of the
 * delivery branch is a READ alias: it is never an operation member, and a
 * `work` this operation records replaces it (see `applyWorkflowOperation`).
 *
 * `compass-ref` is the same repairability for the OTHER registered pointer that
 * a live checkpoint compares: the lifecycle's reviewed delivery compass. It is
 * not a header patch either - it names one existing reviewed compass document,
 * requires a non-empty reason, stores the document's canonical harness-relative
 * pointer (never the caller's spelling), and commits under the same workflow CAS
 * token. Without it, a pointer stored in the wrong form left every later reader
 * comparing against a double-joined path with no public way back (I-000863).
 */
export type WorkflowExecutionOperation =
  | { kind: "phase"; phase: NonNullable<WorkflowSnapshot["phase"]>; compassPath: string }
  | { kind: "lifecycle"; status: WorkflowSnapshot["status"]; reason: string }
  | { kind: "execution-policy"; policy: NonNullable<WorkflowSnapshot["execution_policy"]> }
  | { kind: "integration-worktree"; path: string }
  | { kind: "delivery"; delivery: NonNullable<WorkflowSnapshot["delivery"]> }
  | { kind: "delivery-anchors"; branch: { base?: string; work?: string; target?: string }; reason: string }
  | { kind: "compass-ref"; compassPath: string; reason: string };

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
function invalidWorkflowInput(detail: string, details: Record<string, unknown> = {}): CoordinationError {
  return new CoordinationError("coordination.invalid-input", detail, details);
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
    throw invalidWorkflowInput("Invalid workflow operation: provide an operation with a kind; inspect the operation contract with mstar schema.");
  }
  const op = operation as unknown as Record<string, unknown>;
  switch (operation.kind) {
    case "phase": {
      assertExactKeys(op, ["kind", "phase", "compassPath"], "a phase operation");
      if (!isNonEmptyString(op.phase)) throw invalidWorkflowInput("Invalid phase operation: provide a non-empty phase; retry through mstar workflow phase.");
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
        throw new CoordinationError("coordination.invalid-input", "Invalid lifecycle status: provide one of the supported statuses; retry through mstar workflow lifecycle.", {
          status: op.status,
          allowed_statuses: WORKFLOW_LIFECYCLE_STATUSES,
        });
      }
      if (!isNonEmptyString(op.reason)) throw invalidWorkflowInput("Invalid lifecycle operation: provide a non-empty reason; retry through mstar workflow lifecycle.");
      return;
    }
    case "execution-policy": {
      assertExactKeys(op, ["kind", "policy"], "an execution-policy operation");
      if (!isPlainObject(op.policy)) throw invalidWorkflowInput("Invalid execution-policy operation: provide a policy object; retry through mstar workflow execution-policy.");
      return;
    }
    case "integration-worktree": {
      assertExactKeys(op, ["kind", "path"], "an integration-worktree operation");
      if (!isNonEmptyString(op.path) || !isAbsolute(op.path)) {
        throw invalidWorkflowInput("Invalid integration-worktree operation: provide an absolute checkout path; retry through mstar workflow integration-worktree.");
      }
      return;
    }
    case "delivery": {
      assertExactKeys(op, ["kind", "delivery"], "a delivery operation");
      if (!isPlainObject(op.delivery)) throw invalidWorkflowInput("Invalid delivery operation: provide a delivery evidence object; retry through mstar workflow evidence.");
      if (Object.keys(op.delivery).length === 0) {
        throw invalidWorkflowInput("Invalid delivery operation: provide at least one evidence member (compound, pr, merge, or completion); retry through mstar workflow evidence.");
      }
      return;
    }
    case "delivery-anchors": {
      assertExactKeys(op, ["kind", "branch", "reason"], "a delivery-anchors operation");
      if (!isPlainObject(op.branch)) {
        throw invalidWorkflowInput("Invalid delivery-anchors operation: provide a branch object naming the anchor(s) to record; retry through mstar workflow delivery-anchors.");
      }
      // Exact keys on the object too: `branch` is the operation's own member, and
      // an undefined key inside it would be a partial header patch by another name.
      // The deprecated `source` spelling is deliberately NOT admitted here - one
      // delivery-branch key, so the operation can never write both.
      assertExactKeys(op.branch, ["base", "work", "target"], "a delivery-anchors branch");
      const { base, work, target } = op.branch;
      if (base === undefined && work === undefined && target === undefined) {
        throw invalidWorkflowInput("Invalid delivery-anchors operation: provide at least one anchor (branch.base, branch.work or branch.target); retry through mstar workflow delivery-anchors.");
      }
      if (base !== undefined && !isNonEmptyString(base)) {
        throw invalidWorkflowInput("Invalid delivery-anchors operation: branch.base must be a non-empty string; retry through mstar workflow delivery-anchors.");
      }
      if (work !== undefined && !isNonEmptyString(work)) {
        throw invalidWorkflowInput("Invalid delivery-anchors operation: branch.work must be a non-empty string; retry through mstar workflow delivery-anchors.");
      }
      if (target !== undefined && !isNonEmptyString(target)) {
        throw invalidWorkflowInput("Invalid delivery-anchors operation: branch.target must be a non-empty string; retry through mstar workflow delivery-anchors.");
      }
      if (!isNonEmptyString(op.reason)) {
        throw invalidWorkflowInput("Invalid delivery-anchors operation: provide a non-empty reason; retry through mstar workflow delivery-anchors.");
      }
      return;
    }
    case "compass-ref": {
      assertExactKeys(op, ["kind", "compassPath", "reason"], "a compass-ref operation");
      if (!isNonEmptyString(op.compassPath)) {
        throw invalidWorkflowInput(
          "a compass-ref operation needs the reviewed delivery compass as an absolute path inside the harness root or " +
            "as a harness-relative pointer; retry through mstar workflow compass-ref",
        );
      }
      if (!isNonEmptyString(op.reason)) {
        throw invalidWorkflowInput("Invalid compass-ref operation: provide a non-empty reason; retry through mstar workflow compass-ref.");
      }
      return;
    }
    default:
      throw new CoordinationError("coordination.unknown-operation", "Unknown workflow operation kind; inspect the operation contract with mstar schema.", {
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
  if (!isPlainObject(request)) throw invalidWorkflowInput("Invalid workflow operation: provide a request object; inspect the operation contract with mstar schema.");
  if (!isNonEmptyString(caller?.sessionId)) {
    throw invalidWorkflowInput("Invalid execution caller: provide a non-empty session identity; inspect the workflow with mstar status validate.");
  }
  const operationId = assertOperationId((request as { operationId?: unknown }).operationId);
  const workflowId = (request as { workflowId?: unknown }).workflowId;
  if (!isNonEmptyString(workflowId)) {
    throw invalidWorkflowInput("Invalid workflow operation: provide the non-empty workflow id; inspect registered workflows with mstar status validate.");
  }
  assertWorkflowOperationShape(request.operation);
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
    case "delivery-anchors":
      return "operation.branch";
    case "compass-ref":
      return "operation.compassPath";
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
    case "delivery-anchors":
      return state.branch;
    case "compass-ref":
      return state.compass_ref;
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
    case "delivery-anchors":
      return operation.branch;
    // The caller's own spelling: the stored form is the document's canonical
    // harness-relative pointer, so a refusal reports both forms rather than
    // pretending the request asked for the relative one.
    case "compass-ref":
      return operation.compassPath;
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
 * under `error.details.recoveryFacts`, so one contract covers both paths.
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

/**
 * §4.2 the transport-freshness warning of one accepted intent: a token whose
 * revision moved is recorded as provenance, not refused (A10).
 */
function workflowTokenDriftWarnings(
  workflowId: string,
  freshness: { readRevision: number; currentRevision: number; current: boolean },
): ResolutionWarning[] {
  if (freshness.current) return [];
  return [
    {
      code: "execution.token-drifted",
      path: "expected",
      message:
        `the token carries revision ${freshness.readRevision} while workflow ${workflowId} is at revision ` +
        `${freshness.currentRevision}: the revision is transport freshness, so the intent was recomputed against ` +
        `the current state instead of being refused`,
    },
  ];
}

/**
 * §3.1 (R6/A09) the one shape of a served recorded receipt: the receipt itself
 * plus the `already-satisfied` sidecar. Both the before-proof read route and the
 * committing frame's own lookup return through here, so a replay looks the same
 * however it was reached.
 */
function replayedWorkflowReceipt(
  replayed: ExecutionReceipt<ExecutionState>,
  input: { workflowId: string; warnings: readonly ResolutionWarning[] },
): ExecutionReceipt<ExecutionState> {
  return {
    ...replayed,
    recovery: workflowRecovery({
      workflowId: input.workflowId,
      outcome: "already-satisfied",
      applied: [],
      commitState: "committed",
      resolvedFrom: [{ path: "operationId", source: "execution_operations receipt" }],
      warnings: [...input.warnings, { code: "execution.receipt-replayed", message: "the recorded receipt of this operation id is served; nothing was written." }],
    }),
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
   * `compass-ref`: the reviewed compass the repair names, as its canonical
   * absolute path plus the harness-relative pointer it is stored as. The pointer
   * form is decided here, before SQLite ownership, by the one registration
   * normalizer; the path fact is re-read at the commit boundary.
   */
  compassRef?: { path: string; relative: string };
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
      "The requested workflow is not active in this store. Inspect registered workflows with mstar status validate.",
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
      "Workflow transition requires a registered compass; inspect workflow state with mstar status validate.",
      { workflow_id: workflowId, compass_ref: header.compass_ref },
    );
  }
  const harnessRoot = controlHarnessRoot(context);
  const canonical = canonicalTarget(operation.compassPath);
  const expected = canonicalTarget(join(harnessRoot, registered));
  if (canonical !== expected) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      "Phase transition must use the workflow's registered compass; inspect the workflow with mstar status validate.",
      { workflow_id: workflowId, expected, actual: canonical },
    );
  }
  if (!existsSync(canonical)) {
    throw invalidWorkflowTransition("The registered compass does not exist; repair it, then retry through mstar workflow phase.", {
      workflow_id: workflowId,
      compass_path: canonical,
    });
  }
  const text = readFileSync(canonical, "utf8");
  const doc = parseCompassFrontmatterText(text, canonical);
  const validation = validateCompassFrontmatter(doc);
  if (!validation.ok) {
    throw invalidWorkflowInput("The registered compass is invalid; correct its validation findings, then retry through mstar workflow phase.", {
      compass_path: canonical,
      violations: validation.violations,
    });
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
      "The integration checkout is the control checkout; provide a dedicated worktree, then retry through mstar workflow integration-worktree.",
      { workflow_id: workflowId, path, expected: `a checkout distinct from ${mainRoot}` },
    );
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw invalidWorkflowTransition("The integration checkout does not exist; provide an existing checkout path, then retry through mstar workflow integration-worktree.", { workflow_id: workflowId, path });
  }
  // The repository a checkout belongs to is its MAIN worktree: a linked
  // worktree's own `--show-toplevel` is itself, so the main record is what
  // decides ("a checkout of the repository owning the control harness root").
  const owner = readMainWorktree(path);
  if (owner === null) {
    throw new CoordinationError(
      "coordination.not-in-git",
      "The integration checkout is not a readable Git worktree; inspect it with mstar worktree check.",
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
      "The integration checkout resolves to the control checkout; provide a distinct worktree, then retry through mstar workflow integration-worktree.",
      {
        main_root: mainRoot,
        workflow_id: workflowId,
        path,
      },
    );
  }
  const alignment = assertBranchAlignment(path, integrationBranch);
  if (!alignment.ok) {
    throw new CoordinationError(
      "coordination.integration-diverged",
      "The integration checkout is not on the registered integration branch; inspect it with mstar worktree check.",
      {
        violations: alignment.violations,
        workflow_id: workflowId,
        path,
        expected: integrationBranch,
      },
    );
  }
  return { worktree: { path, branch: integrationBranch } };
}

/**
 * §4.1 the external evidence of one `compass-ref` repair: the reviewed delivery
 * compass the operation names, proven here — before SQLite ownership — to be an
 * existing, non-empty, well-formed compass frontmatter belonging to THIS
 * lifecycle. The stored form is decided by the ONE registration normalizer, so a
 * repaired pointer can never carry a spelling that registration would have
 * refused (that is how a repository-relative pointer reached the store, I-000863).
 */
async function readCompassRefEvidence(
  context: ExecutionContext,
  workflowId: string,
  operation: Extract<WorkflowExecutionOperation, { kind: "compass-ref" }>,
): Promise<WorkflowEvidence> {
  const header = await readWorkflowHeaderBefore(context, workflowId);
  // An iteration owns the reviewed delivery compass; a plan workflow records no
  // `compass_ref` at all, so repairing one would write a field its own type never
  // reads.
  if (header.type !== "iteration") {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} records type ${JSON.stringify(header.type)}, which carries no reviewed delivery compass; ` +
        `a compass_ref is repaired only on an iteration workflow`,
      { workflow_id: workflowId, type: header.type },
    );
  }
  const harnessRoot = controlHarnessRoot(context);
  // The ONE registration normalizer decides containment, existence and the
  // stored form: a pointer this route accepts is exactly a pointer registration
  // would have accepted.
  const relative = normalizeIterationCompassRef(operation.compassPath, harnessRoot, (detail) => invalidWorkflowInput(detail));
  // Both accepted spellings resolve against the harness root — the base the
  // stored pointer is later read under — and the file itself is canonicalized
  // the same way the normalizer just did.
  const path = canonicalizeNearestExisting(
    isAbsolute(operation.compassPath) ? operation.compassPath : join(harnessRoot, operation.compassPath),
  );
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") {
    throw invalidWorkflowTransition("The named compass document is empty; name the reviewed delivery compass, then retry through mstar workflow compass-ref.", {
      workflow_id: workflowId,
      compass_path: path,
    });
  }
  let doc: Record<string, unknown>;
  try {
    doc = parseCompassFrontmatterText(text, path);
  } catch (error) {
    // The parser's own report rides in the details, so this message can name the
    // repair verb as one statically provable literal.
    throw invalidWorkflowTransition(
      "The named compass document is not a readable compass frontmatter; correct the document, then retry through mstar workflow compass-ref.",
      {
        workflow_id: workflowId,
        compass_path: path,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
  const validation = validateCompassFrontmatter(doc);
  if (!validation.ok) {
    throw invalidWorkflowInput("The named compass is invalid; correct its validation findings, then retry through mstar workflow compass-ref.", {
      compass_path: path,
      violations: validation.violations,
    });
  }
  if (doc.iteration_id !== workflowId) {
    // The ids that disagreed are details, not prose: an interpolated id would
    // leave the repair verb unprovable to the reachability lint.
    throw new CoordinationError(
      "coordination.scope-mismatch",
      "the named compass belongs to a different iteration than the addressed workflow; name this workflow's own reviewed delivery compass, then retry through mstar workflow compass-ref.",
      { workflow_id: workflowId, compass_path: path, compass_iteration_id: String(doc.iteration_id) },
    );
  }
  return { compassRef: { path, relative } };
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
    case "compass-ref":
      return readCompassRefEvidence(context, workflowId, operation);
    case "lifecycle":
      // A terminal `completed` close synthesizes NOTHING: the report-only
      // fulfilment is the outer lifecycle fact an authorized `workflow evidence`
      // call records, and a passing QA report never supplies it. The transaction
      // consults the delivery evidence the snapshot itself records.
      return {};
    default:
      // The other stored transitions (phase-less lifecycle, execution-policy,
      // delivery, delivery-anchors) read no external evidence: their inputs are
      // the store's own rows, which the transaction reads itself.
      return {};
  }
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
  // A `compass-ref` repair records a DOCUMENT: the file it names must still be
  // there at the commit boundary. Its bytes are not a witness (an edit moved the
  // record on), but a vanished or non-file target is not a pointer worth storing.
  const compassRef = evidence.compassRef;
  if (compassRef !== undefined && (!existsSync(compassRef.path) || !statSync(compassRef.path).isFile())) {
    throw invalidWorkflowTransition(
      `the named compass ${compassRef.path} disappeared after it was validated; restore the reviewed delivery compass ` +
        `and retry the workflow transition`,
      { path: compassRef.path },
    );
  }
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
  const recovery = isPlainObject(details) ? details.recoveryFacts : undefined;
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
  // probes, a compass-ref repair reads only the compass DOCUMENT it names (no
  // Git evidence), and a terminal close reads its owned rows' recorded
  // completion evidence (and the Git proof a development/integration row's
  // completion needs). The report names what THIS transition actually reads
  // instead of a generic inventory.
  const prerequisiteRead =
    input.operation.kind === "phase" || input.operation.kind === "integration-worktree"
      ? "the lifecycle's registered compass and the Git probes its checkouts answer"
      : input.operation.kind === "compass-ref"
        ? "the reviewed delivery compass document this repair names"
        : "the recorded completion evidence of the rows this transition composes (and the Git proof a completion needs)";
  const problem: RecoveryProblem = {
    component: "operation-prerequisite",
    path: workflowOperationField(input.operation),
    code: code ?? "execution.prerequisite-unavailable",
    sourcesTried: [
      `the workflow ${input.workflowId} header and rows this store owns`,
      prerequisiteRead,
    ],
    currentFacts: [
      input.stage === "read"
        ? `the ${input.operation.kind} transition reads ${prerequisiteRead} before it can decide, and this call did ` +
          `not get past that read`
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
    recoveryFacts: unresolvedRecovery({
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
    recoveryFacts: unresolvedRecovery({
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
  return new CoordinationError(code, "This transition addresses no workflow; inspect registered workflows with mstar status validate.", {
    needed: problem.needed,
    component: problem.component,
    path: problem.path,
    sources_tried: problem.sourcesTried,
    current_facts: problem.currentFacts,
    available_work: problem.availableWork,
    recoveryFacts: unresolvedRecovery({ target: {}, unresolved: [problem] }),
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
  const requestHash = workflowOperationRequestHash(context.caller, workflowId, operation);
  // §4.1/§4.2 (R6/A09) RECEIPT-FIRST for an operation whose prerequisite is
  // MUTABLE external state. A `compass-ref` repair names a document an operator
  // may later remove, empty or edit into invalid frontmatter; that document is
  // admission for a NEW write, never a condition on the replay of an ACCEPTED
  // one. The committed receipt — or the operation conflict of a changed intent
  // under the same id — is therefore decided here, before the evidence read.
  // Every other operation keeps reading its evidence first: its prerequisite is
  // the state the transition itself stands on, and moving that read ahead of the
  // store would change admission for operations this repair does not address.
  const replayed = operation.kind === "compass-ref"
    ? await readWorkflowOperationReplayBeforeProof<ExecutionState>(context, resolved.read, {
        operationId: resolved.call.operationId,
        requestHash,
      })
    : null;
  if (replayed !== null) {
    // The replay is bound to the CURRENT authority the read transaction just
    // revalidated; the token's revision remains transport freshness (A10), so a
    // receipt served against a header that moved is still the recorded receipt.
    const freshness = resolveTokenFreshness(
      resolved.call.expected,
      { kind: "workflow", storeId: replayed.storeId, epoch: replayed.epoch, key: [workflowId], revision: replayed.revision },
      { target: { workflowId } },
    );
    return replayedWorkflowReceipt(replayed.replay, {
      workflowId,
      warnings: workflowTokenDriftWarnings(workflowId, freshness),
    });
  }
  let evidence: WorkflowEvidence;
  try {
    evidence = await readWorkflowEvidence(context, resolved);
  } catch (error) {
    throw prerequisiteCause(error, { workflowId, operation, stage: "read" });
  }
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
    const warnings: readonly ResolutionWarning[] = workflowTokenDriftWarnings(workflowId, freshness);
    // §3.1 (R6/A09) an identical retry returns its recorded receipt — but only
    // while the receipt is retained and after CURRENT authority is revalidated.
    // A close that loses registry membership prunes the workflow's OTHER receipts
    // and keeps this operation's current-epoch receipt as its replay anchor: the
    // identical terminal retry replays here, and only a different operation id
    // falls through to the registry witness for actionable read-back guidance.
    // A `compass-ref` retry normally replays on the before-proof read route
    // above; this lookup also covers a receipt committed in the gap between that
    // read and this write transaction.
    const replay = readOperationReplay<ExecutionState>(tx, {
      operationId: resolved.call.operationId,
      requestHash,
      workflowId,
      planId: null,
      token: { kind: "root", key: [] },
    });
    if (replay !== null) {
      resolveWorkflowSession(tx, resolved.read);
      return replayedWorkflowReceipt(replay, { workflowId, warnings });
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
    let applied: AppliedWorkflowOperation;
    try {
      applied = applyWorkflowOperation({ tx, witness, read: resolved.read, operation, evidence, at });
    } catch (error) {
      throw workflowConflictCause(error, { workflowId, operation, state: stored.state });
    }
    // A lifecycle receipt is attributed to the session that moved it and the
    // reason it stated. A terminal close additionally carries forward the
    // holder-live warning of the recovery that created this binding: it prunes
    // that recover receipt below, so the closing receipt is where the fact
    // survives.
    const carried = operation.kind === "lifecycle" && applied.membershipLost
      ? recoveredHolderLiveWarning(tx, witness.workflowId, witness.session.sessionId)
      : undefined;
    const receipt: ExecutionRead<ExecutionState> = {
      ...applied.receipt,
      ...(operation.kind === "lifecycle" ? { actor_session_id: witness.session.sessionId, reason: operation.reason } : {}),
      ...(carried === undefined ? {} : { holder_live_warning: carried }),
    };
    writeOperationReceipt(tx, {
      operationId: resolved.call.operationId,
      requestHash,
      workflowId: witness.workflowId,
      planId: null,
      receipt,
      now: at,
      slim: true,
    });
    if (applied.membershipLost)
      pruneWorkflowOperationReceipts(tx, witness.workflowId, resolved.call.operationId);
    return {
      ...receipt,
      // The terminal projection serves the receipt this close just wrote, so the
      // returned graph is read AFTER the prune: a caller that stores the close
      // receipt sees the same attribution and warning a replay serves.
      ...(applied.membershipLost ? { data: readExecutionStateGraph(tx).data } : {}),
      operationId: resolved.call.operationId,
      replayed: false,
      recovery: workflowRecovery({
        workflowId,
        outcome: "applied",
        applied: [amendmentComponentOf(operation) ?? `${operation.kind} on workflow ${workflowId}`],
        commitState: "committed",
        resolvedFrom: [{ path: workflowOperationField(operation), source: "intent.request" }],
        warnings: [...warnings, ...applied.warnings],
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
 * §R5/§R10 a terminal `completed` close composes the ONE report-only fulfilment
 * its owned rows' recorded evidence entails (E10) BEFORE the terminal decision.
 * A row `Done` is NOT composed here: the plan's own `complete` is the single
 * place that happens, so this close never completes a row in a sibling step.
 * Everything therefore commits on ONE handle in ONE transaction: a crash leaves
 * either the whole close or none of it.
 *
 * §R11/A21 a `failed`/`stopped` close composes no row bookkeeping at all (no
 * successful-delivery precondition): it settles the workflow's own stopped
 * integration claim here, and the terminal decision then judges exactly the
 * ownership this transaction leaves behind.
 */
type AppliedWorkflowOperation = {
  receipt: ExecutionRead<ExecutionState>;
  membershipLost: boolean;
  /** Scoped advisories this transition recorded, carried by the result's `recovery.warnings`. */
  warnings: readonly ResolutionWarning[];
};
function applyWorkflowOperation(input: {
  tx: ExecutionTransaction;
  witness: ExecutionWorkflowWitness;
  read: ResolvedWorkflowWrite;
  operation: WorkflowExecutionOperation;
  evidence: WorkflowEvidence;
  at: string;
}): AppliedWorkflowOperation {
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
  // §R5 the ownership the terminal decision reads is the ownership this
  // transaction just released, so a settled claim re-reads the witness from the
  // handle the transaction owns. A `completed` close synthesizes NOTHING: the
  // report-only fulfilment is the outer lifecycle fact an authorized `workflow
  // evidence` call records, never a value this close derives from a QA report.
  const effective = settledClaim ? readExecutionWorkflowWitness(tx, read) : witness;
  const rows = effective.view.plans.map((plan) => plan.plan as unknown as PlanRow);
  const header = { ...(effective.view.state as unknown as Record<string, unknown>) };
  let membershipLost = false;
  let warnings: readonly ResolutionWarning[] = [];
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
    case "compass-ref":
      // The evidence reader decided the STORED form; this step stores exactly
      // that canonical harness-relative pointer, so a repair cannot reintroduce
      // the spelling registration refuses.
      header.compass_ref = requireCompassRefEvidence(evidence).compassRef.relative;
      break;
    case "delivery":
      header.delivery = applyDeliveryEvidence({ header, rows, workflowId, delivery: operation.delivery });
      break;
    case "delivery-anchors": {
      // §1 the members a repair may name are the ADDRESSED header's own type's:
      // `branch.work` is a delivery anchor of `type: plan` only (an iteration
      // delivers through its `integration` anchor), so storing it here would
      // leave a key no consumer of that type reads while the projection reports
      // it as a delivery branch. Only an iteration narrows the set - `base` and
      // `target` stay revisable for both types, and `integration` has no writer
      // on either (the shape gate owns that key) - so no member that is legal
      // for the addressed type is refused here.
      const allowed = header.type === "iteration" ? ["base", "target"] : ["base", "work", "target"];
      const refused = (["base", "work", "target"] as const).filter(
        (member) => isNonEmptyString(operation.branch[member]) && !allowed.includes(member),
      );
      if (refused.length > 0) {
        // One template literal, and the recovery sentence names the verb path
        // itself rather than an `mstar` invocation: the reachability lint can
        // only prove an advertised command statically when no runtime value is
        // interpolated into it, so the example uses placeholders (this message's
        // own first clause states the real workflow id).
        throw invalidWorkflowTransition(
          `workflow ${workflowId} records type ${JSON.stringify(header.type)}, whose delivery anchors are ${allowed.map((member) => `branch.${member}`).join(" | ")}: this repair names ${refused.map((member) => `branch.${member}`).join(", ")}, which that type does not carry. Retry workflow delivery-anchors --workflow <workflow-id> --branch-base <branch> --reason <why>. Every member the addressed type carries stays revisable.`,
          { workflow_id: workflowId, type: header.type, refused_members: refused, allowed_members: allowed },
        );
      }
      // The repair MERGES into the registered anchors: an anchor this operation
      // names replaces that member, and every other member the header carries is
      // preserved verbatim — an iteration workflow's `base` / `integration`
      // anchors are not this operation's to delete — while an anchor it does not
      // name keeps the value the workflow already registers. A member the stored
      // header does not carry stays absent rather than being invented. The
      // candidate header is validated and stored by the shared tail below, so a
      // malformed pair is a refusal, never a half-written header.
      const registered: Record<string, unknown> = isPlainObject(header.branch) ? { ...header.branch } : {};
      // `source` is the pre-rename spelling of `work`: a `work` this operation
      // records REPLACES it, so one row never carries both spellings of the
      // delivery branch. An unnamed `source` on a row this operation does not
      // re-point is left as registered.
      if (isNonEmptyString(operation.branch.work)) delete registered.source;
      header.branch = {
        ...registered,
        ...(isNonEmptyString(operation.branch.base) ? { base: operation.branch.base } : {}),
        ...(isNonEmptyString(operation.branch.work) ? { work: operation.branch.work } : {}),
        ...(isNonEmptyString(operation.branch.target) ? { target: operation.branch.target } : {}),
      };
      // §4d the merged anchors are the RESULT this write stores; the warning is
      // decided on them, never on a snapshot read before this transaction.
      warnings = deliveryAnchorWarnings(workflowId, header);
      break;
    }
  }
  header.updated_at = at;
  assertHeaderValid(workflowId, header);
  writeWorkflowState(tx, { workflowId, state: header });
  if (membershipLost) recordRootMembershipLoss(tx, { workflowId, now: at });
  return { receipt: readExecutionStateGraph(tx), membershipLost, warnings };
}

/**
 * §4d the advisory a delivery-anchor repair carries when the anchors it
 * just stored no longer name the PR identity the SAME header already records.
 *
 * That identity is frozen at its first `workflow evidence` record and the close
 * consultation requires `delivery.pr.head` / `delivery.pr.target` to BE the
 * registered anchors, so a header that disagrees can never reach a `completed`
 * close. The repair still applies - an anchor stays revisable for as long as the
 * lifecycle runs - and the warning names the recorded identity, the anchors it
 * stored and the ONE call that puts them back into agreement.
 *
 * Exactly one of the two comparisons can fail, and only for the anchor THIS
 * operation names: `branch.work` (resolved through `deliveryBranchOf`) when
 * `--branch-work` moved it, `branch.target` when `--branch-target` did. An
 * anchor the operation does NOT name keeps the value the recorded identity was
 * already checked against, so its comparison cannot fail here. `pr.repo` has no
 * anchor to compare with, and `branch.base` is not a PR member.
 *
 * A terminal header never reaches this code: the amend guard at the top of
 * `applyWorkflowOperation` refuses every repair on a closed lifecycle, so the
 * recovery named here is always executable.
 */
function deliveryAnchorWarnings(workflowId: string, header: Record<string, unknown>): ResolutionWarning[] {
  const delivery = isPlainObject(header.delivery) ? header.delivery : undefined;
  const pr = delivery === undefined ? undefined : delivery.pr;
  // A stored PR identity always carries both members (deliveryEvidenceViolations
  // requires non-empty strings), so the recovery below names real values.
  if (!isPlainObject(pr) || !isNonEmptyString(pr.head) || !isNonEmptyString(pr.target)) return [];
  const branch = isPlainObject(header.branch) ? header.branch : {};
  const work = deliveryBranchOf(branch) ?? null;
  const target = isNonEmptyString(branch.target) ? branch.target : null;
  if (pr.head === work && pr.target === target) return [];
  return [
    {
      code: "workflow.delivery-anchors.pr-identity",
      message:
        `the repair stored branch.work ${JSON.stringify(work)} / branch.target ${JSON.stringify(target)}, which no longer name the ` +
        `recorded PR identity (delivery.pr.head ${JSON.stringify(pr.head)}, delivery.pr.target ${JSON.stringify(pr.target)}): that ` +
        `identity is frozen at its first record, so a \`completed\` close refuses this workflow until the two agree again (\u00A74d). ` +
        `Restore agreement with \`mstar workflow delivery-anchors --workflow ${workflowId} --branch-work ${pr.head} ` +
        `--branch-target ${pr.target} --reason "<why the anchors are restored>"\`.`,
    },
  ];
}

/** The pre-transaction evidence a transition must have read (an internal invariant). */
function requireCompassEvidence(evidence: WorkflowEvidence): { compass: CompassEvidence; probes: PhaseGateOptions } {
  if (evidence.compass === undefined) {
    throw invalidWorkflowInput("The phase transition ran without its pinned compass evidence; retry through mstar workflow phase.");
  }
  return { compass: evidence.compass, probes: evidence.probes ?? {} };
}

function requireWorktreeEvidence(evidence: WorkflowEvidence): { worktree: { path: string; branch: string } } {
  if (evidence.worktree === undefined) {
    throw invalidWorkflowInput("The integration-worktree transition ran without a validated checkout; retry through mstar workflow integration-worktree.");
  }
  return { worktree: evidence.worktree };
}

function requireCompassRefEvidence(evidence: WorkflowEvidence): { compassRef: { path: string; relative: string } } {
  if (evidence.compassRef === undefined) {
    throw invalidWorkflowInput("The compass-ref transition ran without its validated compass; retry through mstar workflow compass-ref.");
  }
  return { compassRef: evidence.compassRef };
}

/** The candidate header must be a valid snapshot before it is stored. */
function assertHeaderValid(workflowId: string, header: Record<string, unknown>): void {
  const gate = validateWorkflowSnapshot({ ...header, plans: [] });
  if (!gate.ok) {
    throw invalidWorkflowTransition(
      "The workflow header this transition would store is invalid; inspect the workflow with mstar status validate.",
      {
        violations: gate.violations,
        workflow_id: workflowId,
      },
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
        "The workflow cannot complete while plan rows are not Done; inspect the rows with mstar plan show.",
        {
          not_done: notDone.map((row) => `${String(row.id)} (${rowStatusOf(row) || "no status"})`),
          workflow_id: workflowId,
        },
      );
    }
    const violations = consultDeliveryEvidence({ ...(header as unknown as WorkflowSnapshot), plans: [...rows] });
    if (violations.length > 0) {
      throw invalidWorkflowTransition(
        "The workflow cannot complete; inspect the workflow with mstar status validate.",
        {
          violations: violations.map((entry) => entry.message),
          workflow_id: workflowId,
        },
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
  // The tuple's members are a literal union; the value under test is an
  // arbitrary `string`, so the closed set widens only at this lookup.
  if (parallelism !== undefined && (typeof parallelism !== "string" || !(PLAN_PARALLELISM_VALUES as readonly string[]).includes(parallelism))) {
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
    throw invalidWorkflowInput("The delivery patch does not validate; inspect the delivery contract with mstar schema.", {
      violations: shape.map((entry) => entry.message),
    });
  }
  const stored = (isPlainObject(header.delivery) ? header.delivery : {}) as Record<string, unknown>;
  const incomingPr = isPlainObject(delivery.pr) ? delivery.pr : undefined;
  const recordedPr = isPlainObject(stored.pr) ? stored.pr : undefined;
  if (recordedPr !== undefined && incomingPr !== undefined &&
      (recordedPr.repo !== incomingPr.repo || recordedPr.head !== incomingPr.head || recordedPr.target !== incomingPr.target)) {
    throw invalidWorkflowTransition(
      "The workflow records a different PR identity; use the registered delivery identity, then inspect the workflow with mstar status validate.",
      {
        recorded_pr: recordedPr ?? null,
        incoming_pr: incomingPr ?? null,
        workflow_id: workflowId,
      },
    );
  }
  const branch = isPlainObject(header.branch) ? header.branch : {};
  // The registered delivery branch, whichever spelling the row carries: a row
  // registered before the rename must satisfy this check exactly like a new one.
  const registeredWork = deliveryBranchOf(branch);
  if (incomingPr !== undefined) {
    if (isNonEmptyString(registeredWork) && incomingPr.head !== registeredWork) {
      throw invalidWorkflowTransition(
        `workflow ${workflowId} records delivery.pr.head ${JSON.stringify(incomingPr.head)}, but the registered delivery ` +
          `branch is ${JSON.stringify(registeredWork)} (\u00A74d: the recorded PR identity must be the registered delivery)`,
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
  // §R5/A19/A21 the completion freeze protects an ACCEPTED fulfilment, not the
  // absence of one. Once the workflow is Done against a completion whose policy
  // IS the registered one, that recorded policy/reference is frozen: editing the
  // referenced document is normal, a different completed intent uses its own
  // workflow. But an imported/historical Done row that recorded NO matching
  // fulfilment (or one whose policy is not the registered policy) has no accepted
  // fact to preserve, so ordinary `workflow evidence` is exactly the supported
  // way to record the missing matching fulfilment — never QA-derived synthesis.
  if (members.includes("completion") && rows.some((row) => rowStatusOf(row) === "Done")) {
    const incoming = isPlainObject(delivery.completion) ? delivery.completion : undefined;
    const recorded = isPlainObject(stored.completion) ? stored.completion : undefined;
    const registered = isNonEmptyString(header.completion_policy) ? header.completion_policy : undefined;
    const recordedIsAccepted = recorded !== undefined && registered !== undefined && recorded.policy === registered;
    const changesAccepted =
      recordedIsAccepted &&
      (incoming === undefined || incoming.policy !== recorded.policy || incoming.evidence !== recorded.evidence);
    if (changesAccepted) {
      throw new CoordinationError(
        "coordination.completion-frozen",
        "The workflow already has accepted completion evidence; its recorded fulfilment cannot be replaced. Inspect the workflow with mstar status validate.",
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
  input: { expected?: ExecutionToken; priorSessionId: string | null; reason: string; attestation?: ActivationAttestation },
): string {
  return createHash("sha256")
    .update(
      serializeExecutionValue({
        operation: RECOVER_COORDINATOR_OPERATION,
        workflow_id: workflowId,
        expected: input.expected ?? "current",
        caller: {
          session_id: caller.sessionId,
          role: caller.role,
          workflow_id: caller.workflowId,
        },
        prior_session_id: input.priorSessionId,
        reason: input.reason,
        // An omitted attestation hashes as its absence: the generated document
        // is transaction fact, not request input, so an identical generated
        // retry keeps the same hash and replays.
        ...(input.attestation === undefined ? {} : { attestation: input.attestation }),
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
 *    one (running/paused); a terminal lifecycle is never reopened — the ONE
 *    exception is a terminal workflow that still carries a HELD integration
 *    merge lease, whose release is the whole of that call (no rebind, no
 *    revoke, no header revision) once the request names the lease's recorded
 *    holder and the attestation names it stopped/reloaded. Every other
 *    terminal request keeps the closed-lifecycle refusal;
 * 3. the named prior holder exists in this workflow's records, and `null` is
 *    only admissible when the workflow records no coordinator row at all — an
 *    unnamed holder is refused rather than guessed;
 * 4. if the workflow holds a LIVE coordinator at this epoch, that session is the
 *    only one recovery may replace: naming any other identity is refused
 *    (`coordination.duplicate-holder`), because ownership is not replaceable by
 *    another identity;
 * 5. the operator attestation is a valid RECOVERY-scope attestation (a
 *    well-formed operator authorization reference plus attested stops; the
 *    store is already active, so the barrier's installed-consumer obligation
 *    does not apply) AND it names the prior holder as stopped/reloaded. A
 *    named holder with no stop evidence is refused — the engine cannot observe
 *    a dead process, so the attested stop IS the trust boundary, and without it
 *    this transition would be the silent takeover it must never be.
 *
 * Initial recovery revokes the predecessor and binds the caller atomically.
 * A claim continuation preserves the current binding and requires the receipt
 * that created its current epoch/revision/bound_at, the revoked predecessor and
 * the exact registered held attempt with applicable renewed stop evidence.
 * Both record a fresh workflow operation; only that predecessor's claim may be
 * settled. Operator evidence does not establish observed process termination.
 *
 * The CAS is the addressed header revision. An omitted `expected` resolves to
 * the current revision's token inside the transaction — the same derivation
 * `workflow.reopen` and `workflow.adopt-terminal` apply — so only the CALLER's
 * explicit token enters the request hash and an identical retry still replays.
 */
export async function recoverExecutionCoordinator(
  context: ExecutionContext,
  input: { expected?: ExecutionToken; operationId: string; priorSessionId: string | null; reason: string; attestation?: ActivationAttestation },
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
    throw invalidWorkflowInput("Coordinator recovery requires caller session and workflow identities; inspect the workflow with mstar status validate.");
  }
  const operationId = assertOperationId(input?.operationId);
  const reason = input?.reason;
  if (!isNonEmptyString(reason)) {
    throw invalidWorkflowInput("Coordinator recovery requires a non-empty reason; the supported coordinator-recovery renewal needs that reason with its attestation, then inspect the workflow with mstar status validate.");
  }
  const priorSessionId = input?.priorSessionId;
  if (priorSessionId !== null && !isNonEmptyString(priorSessionId)) {
    throw invalidWorkflowInput(
      "Coordinator recovery requires the prior session id to name the holder it replaces, or null only when no coordinator is recorded; inspect the workflow with mstar status validate.",
    );
  }
  // The operator's authorization is a DOCUMENT here, exactly as at the
  // activation barrier, but the scope is RECOVERY: the store is already
  // active, so the installed-consumer obligation of the barrier does not
  // apply and the document only has to be a well-formed operator
  // authorization with attested stops. A credential-bearing or incomplete
  // attestation never reaches the store. A SUPPLIED document is validated
  // here; an omitted one is generated inside the transaction below from the
  // recovery's own recorded facts and runs through the same validator there.
  const supplied = input?.attestation === undefined ? undefined : validateRecoveryAttestation(input.attestation);
  // The replacement identity must be a genuinely acquired, CURRENT session: an
  // attestation that names it as stopped/reloaded means the operator is asking
  // this recovery to resurrect a stopped identity, which it never does. The
  // refusal happens BEFORE any mutation, so every session row, claim and business
  // fact is left exactly as it was; the supported retry uses a real acquired
  // replacement and an attestation whose stop list covers only the prior holder.
  if (supplied !== undefined && supplied.stoppedSessions.some((session) => session.sessionId === caller.sessionId)) {
    throw invalidWorkflowTransition(
      `the replacement coordinator ${JSON.stringify(caller.sessionId)} is named as stopped/reloaded in this attestation; a recovery ` +
          `binds a genuinely acquired CURRENT session and never resurrects a stopped one. Rerun with the replacement's own acquired session id ` +
          `and an attestation whose stop list covers only the prior holder ${JSON.stringify(priorSessionId ?? "<none>")}.`,
      { workflow_id: workflowId, session_id: caller.sessionId },
    );
  }
  const requestHash = recoverCoordinatorRequestHash(caller, workflowId, {
    expected: input.expected,
    priorSessionId,
    reason,
    attestation: supplied,
  });
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; recovering a coordinator requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    const header = requireWorkflowState(tx, workflowId);
    // The omitted expectation is the current revision's token, resolved under
    // the same lock that checks it.
    const expected = input.expected ?? executionToken("workflow", tx.storeId, tx.epoch, [workflowId], header.revision);
    // The transaction's own clock: the generated document's `attestedAt` and
    // every row stamp this recovery writes are the SAME instant.
    const now = new Date().toISOString();
    // The generated authorization document, assembled inside the same
    // transaction from this operation's own recorded facts: the caller is the
    // operator (actor), the replay id is the durable authorizationRef, and the
    // stop list names exactly the prior holder row this transaction revokes.
    // `--unowned` (priorSessionId null) revokes no prior row, so the generated
    // document intentionally carries `stoppedSessions: []` — the recovery
    // validator accepts an empty stop list. The builder never validates: the
    // existing validator stays the acceptance authority.
    const attestation = supplied ?? validateRecoveryAttestation(provisionRecoveryDocument({
      actor: caller.sessionId,
      authorizationRef: operationId,
      attestedAt: now,
      stoppedSessions: priorSessionId === null
        ? []
        : [{ sessionId: priorSessionId, host: "local", state: "stopped" }],
    }));
    const status = String(header.state.status ?? "");
    if ((WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(status)) {
      return releaseTerminalHeldLease(tx, {
        workflowId,
        callerId: caller.sessionId,
        priorSessionId,
        reason,
        attestation,
        operationId,
        requestHash,
        expected,
        status,
        revision: header.revision,
      });
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
    assertExecutionToken(expected, {
      kind: "workflow",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [workflowId],
      revision: header.revision,
    });
    const rows = readCoordinatorRows(tx, workflowId);
    const live = rows.find((row) => row.state === "active" && row.ref.epoch === tx.epoch);
    // The named predecessor IS the still-live row: the operator's attested stop
    // is the only evidence this call has, so the receipt records what the engine
    // observed, never that the process was seen dead or the authorization
    // host-verified.
    const holderWasLive = priorSessionId !== null && live !== undefined && live.ref.sessionId === priorSessionId;
    let continuation = false;
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
          "The workflow records no coordinator session to recover from; inspect the workflow with mstar status validate.",
          {
            prior_session_id: priorSessionId,
            workflow_id: workflowId,
          },
        );
      }
      // A LIVE holder is never replaced by another name: the recovery identity
      // is the holder the stop evidence was given for, or nothing. The ONE
      // exception is the recovery-continuation path below: the caller IS the
      // live coordinator, its binding was created by an immutable successful
      // recovery receipt from the named predecessor, and a held integration
      // claim still names that predecessor — so the continuation settles the
      // claim without rebinding.
      if (live !== undefined && live.ref.sessionId !== priorSessionId) {
        continuation =
          live.ref.sessionId === caller.sessionId &&
          prior.state === "revoked" &&
          hasCoordinatorRecoveryChain(tx, workflowId, live, priorSessionId);
        if (!continuation) {
          throw new CoordinationError(
            "coordination.invalid-transition",
            `workflow ${workflowId} holds the ACTIVE coordinator session ${live.ref.sessionId} at epoch ${tx.epoch}; recovery ` +
              `may replace only the holder it names (${priorSessionId}). Ownership is not replaceable by another identity, ` +
              `and a live holder resumes through its own reference. Nothing was recovered.`,
            { workflow_id: workflowId, holder: live.ref.sessionId, named: priorSessionId },
          );
        }
        // Qualification for the exact remaining claim is checked below before
        // any mutation; this path never rebinds the current coordinator.
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

    const claim = recoverableIntegrationClaim(tx, {
      workflowId,
      priorSessionId,
      callerId: caller.sessionId,
      attestedAt: attestation.attestedAt,
      at: now,
      required: continuation,
    });
    let revision: number;
    if (continuation) {
      revision = live!.revision;
    } else {
      if (priorSessionId !== null && priorSessionId !== caller.sessionId) {
        revokeSessionRow(tx, { workflowId, role: "coordinator", sessionId: priorSessionId });
      }
      revision = bindRecoveredSession(tx, {
        workflowId,
        role: "coordinator",
        sessionId: caller.sessionId,
        epoch: tx.epoch,
        now,
      });
    }
    if (claim !== null) {
      releaseStoppedMergeClaim(tx, { workflowId, claim, releasedBy: caller.sessionId, at: now });
    }
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
    const holderLiveWarning: HolderLiveWarning | undefined = holderWasLive
      ? {
          code: "recovery.holder-live",
          holder: priorSessionId,
          epoch: tx.epoch,
          observed_state: "active",
          attested_at: attestation.attestedAt,
        }
      : undefined;
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
          // Self-reported: the attested stop is the reason this recovery was
          // admissible, not proof that the holder had died.
          ...(holderLiveWarning === undefined ? {} : { holder_live_warning: holderLiveWarning }),
        },
      } as ExecutionRead<ExecutionSessionRef>,
      now,
    });
    return {
      ...receipt,
      operationId,
      replayed: false,
      ...(holderLiveWarning === undefined ? {} : { holder_live_warning: holderLiveWarning }),
    };
  });
}

/** §3.1: the operation kind a reopen request hashes its request under. */
const REOPEN_WORKFLOW_OPERATION = "reopenExecutionWorkflow";

/**
 * §3.1 the request hash of one reopen: operation kind, the addressed workflow,
 * the exact terminal CAS (or the explicit "current"), the trusted caller, the
 * reason and the operator document that authorizes it.
 */
function reopenWorkflowRequestHash(
  caller: ExecutionCaller,
  workflowId: string,
  input: { expected: ExecutionToken | undefined; reason: string; attestation: ActivationAttestation | undefined },
): string {
  return createHash("sha256")
    .update(
      serializeExecutionValue({
        operation: REOPEN_WORKFLOW_OPERATION,
        workflow_id: workflowId,
        expected: input.expected ?? "current",
        caller: {
          session_id: caller.sessionId,
          role: caller.role,
          workflow_id: caller.workflowId,
        },
        reason: input.reason,
        // An omitted document hashes as its absence: the generated document is
        // transaction fact, not request input, so an identical generated retry
        // keeps the same hash and replays.
        ...(input.attestation === undefined ? {} : { attestation: input.attestation }),
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * §4.2 `workflow.reopen`: the ONE transition that returns a `failed` or
 * `stopped` lifecycle to `running` on the SAME id.
 *
 * It is not a second create and not a rewrite of history: the header keeps its
 * identity anchors and its `started_at`, every plan row and every retained
 * operation receipt stay exactly where the close left them, and the closed
 * lifecycle simply re-enters the ACTIVE registry. Eligibility is the header's
 * own `failed`/`stopped` status — `completed` is never reopened (no override
 * flag exists) and a lifecycle that is still running/paused is not "terminal",
 * so both are named refusals. A terminal header that still carries an ACTIVE
 * registry row (the residue a crashed close leaves) is repaired through the
 * existing restatement edge in the same transaction instead of failing on a
 * duplicate membership.
 *
 * Authorization is EXPLICIT: the trusted caller is a coordinator addressing the
 * workflow, a non-empty reason is recorded, and the operator document is the
 * recovery-scope attestation (the store is already active, so the barrier's
 * installed-consumer obligation does not apply and an empty `stoppedSessions`
 * is valid — the authorization record is operator + reason, never a stop claim).
 * Reopening binds NO coordinator: the session rows stay as they are, and the
 * ordinary `bind`/`recover` routes resume ownership afterwards.
 *
 * The CAS is the terminal header revision's token — `status validate` publishes
 * that header as an identity row (id, status, revision) only, so the token is
 * derived here when the caller omits it — and it is checked BEFORE any
 * write, so a stale token leaves no footprint. An omitted `expected` resolves to
 * the current revision inside the transaction, so only the CALLER's explicit
 * token enters the request hash: an identical retry after a committed reopen
 * still replays instead of conflicting on the revision that reopen advanced.
 */
export async function reopenExecutionWorkflow(
  context: ExecutionContext,
  input: {
    workflowId: string;
    reason: string;
    /**
     * The optional explicit override. When omitted the reopen generates its
     * own recovery-scope document inside the transaction (I-000297): reopening
     * binds no coordinator and disposes no session row, so the generated
     * document's truthful stop list is empty and the authorization record is
     * operator + reason.
     */
    attestation?: ActivationAttestation;
    expected?: ExecutionToken;
    operationId: string;
  },
): Promise<ExecutionReceipt<ExecutionState>> {
  const caller = context.caller;
  if (caller?.role !== "coordinator" || caller.workflowId !== input?.workflowId || !isNonEmptyString(caller.sessionId)) {
    throw new ExecutionError(
      "execution.scope-mismatch",
      `reopening a workflow is a coordinator operation addressed by the caller's own workflow; the supplied caller is a ` +
        `${String(caller?.role)} session of ${JSON.stringify(caller?.workflowId)}.`,
    );
  }
  const workflowId = input.workflowId;
  if (!isNonEmptyString(workflowId) || !isNonEmptyString(input.reason)) {
    throw invalidWorkflowInput(
      "Reopening a workflow requires its id and a non-empty reason; inspect the closed lifecycle with mstar status validate.",
    );
  }
  const operationId = assertOperationId(input.operationId);
  // The operator's authorization is a DOCUMENT, validated projectively BEFORE
  // any store access — the same recovery-scope rule the coordinator recovery
  // applies, so a credential-bearing or incomplete attestation never reaches
  // the store. An OMITTED document is generated inside the transaction below
  // and passes the same validator there.
  const supplied = input.attestation === undefined ? undefined : validateRecoveryAttestation(input.attestation);
  const requestHash = reopenWorkflowRequestHash(caller, workflowId, {
    expected: input.expected,
    reason: input.reason,
    attestation: supplied,
  });
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; reopening a workflow requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    // `coordination.workflow-not-found` for a header this store does not hold.
    const header = requireWorkflowState(tx, workflowId);
    // §3.1 an identical retry replays its recorded receipt — and it is checked
    // BEFORE eligibility precisely because the successful reopen leaves the
    // workflow `running`: a retry must not be answered with "not terminal".
    const replay = readOperationReplay<ExecutionState>(tx, {
      operationId,
      requestHash,
      workflowId,
      planId: null,
      token: { kind: "root", key: [] },
    });
    if (replay !== null) {
      const { operationRecovery, ...recorded } = replay;
      return { ...recorded, ...(operationRecovery === undefined ? {} : { recovery: operationRecovery }) };
    }
    const status = String(header.state.status ?? "");
    if (status === "completed") {
      throw new ExecutionError(
        "workflow.reopen-completed",
        `workflow ${workflowId} is completed \u2014 a completed lifecycle is never reopened, and this route has no override. ` +
          `Register a new lifecycle for further work; the completed history stays exactly as it was recorded.`,
        { workflow_id: workflowId, status },
      );
    }
    if (status !== "failed" && status !== "stopped") {
      throw new ExecutionError(
        "workflow.reopen-not-terminal",
        `workflow ${workflowId} is ${JSON.stringify(status)}; only a failed or stopped lifecycle is reopened, and a ` +
          `running/paused one is already active. Nothing was written.`,
        { workflow_id: workflowId, status },
      );
    }
    // The CAS addresses the terminal header revision the caller read; an omitted
    // token resolves to the revision this transaction locked, so the request hash
    // ("current") stays stable across a post-success retry while every write is
    // still token-checked.
    assertExecutionToken(input.expected ?? executionToken("workflow", tx.storeId, tx.epoch, [workflowId], header.revision), {
      kind: "workflow",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [workflowId],
      revision: header.revision,
    });
    // The registry row is DERIVED from the closed header, never from request
    // JSON, and the existing entry gate validates the result.
    const entry = {
      id: workflowId,
      type: header.state.type,
      started_at: header.state.started_at,
      dir: `workflows/${workflowId}`,
    };
    const entryGate = validateWorkflowEntry(entry);
    if (!entryGate.ok) {
      // reachability: manual — the message names the runtime workflow id, so no single statically provable command can be interpolated
      throw new CoordinationError(
        "coordination.invalid-input",
        `workflow ${workflowId} cannot be restored to the ACTIVE registry: its header does not carry the entry identity ` +
          `anchors (id, type, started_at). Inspect it with mstar status validate.`,
        { workflow_id: workflowId, violations: entryGate.violations.map(({ code, message }) => ({ code, message })) },
      );
    }
    const now = new Date().toISOString();
    // The generated authorization document: this transaction's own clock, the
    // caller as operator, the replay id as the durable authorizationRef, and an
    // EMPTY stop list — reopening binds no coordinator and revokes no session
    // row, so it claims no stop. The builder never validates; the recovery
    // validator above is the acceptance authority for both branches.
    const attestation = supplied ?? validateRecoveryAttestation(provisionRecoveryDocument({
      actor: caller.sessionId,
      authorizationRef: operationId,
      attestedAt: now,
      stoppedSessions: [],
    }));
    advanceWorkflowHeaderRevision(tx, { workflowId, now });
    // Registry membership changes DIRECTION here. A residue row a crashed close
    // left is the existing restatement edge's cleanup, so it is removed through
    // that same edge; a clean closed header instead records the membership gain.
    // Either way the ROOT advances exactly once, without a second store bump.
    const residue = tx.db.prepare("select 1 as present from execution_registry where workflow_id = ?").get(workflowId);
    if (residue !== undefined) {
      recordRootMembershipLoss(tx, { workflowId, now });
    } else {
      tx.db.prepare("update execution_meta set revision = revision + 1, root_updated_at = ? where id = 1").run(now);
    }
    tx.db
      .prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)")
      .run(workflowId, JSON.stringify(entry));
    const nextState: Record<string, unknown> = { ...header.state, status: "running", updated_at: now };
    delete nextState.ended_at;
    assertHeaderValid(workflowId, nextState);
    writeWorkflowState(tx, { workflowId, state: nextState });
    // The attributed receipt: the session that reopened it, its stated reason,
    // and the operator provenance the authorization came from. The coordinator
    // binding is NOT touched and nothing here claims a stop.
    const provenance: RecoveryDetails = {
      outcome: "applied",
      target: { workflowId },
      applied: [
        `execution_workflows(${workflowId}) status ${status} \u2192 running`,
        `execution_registry(${workflowId}) restored`,
      ],
      unresolved: [],
      resolvedFrom: [
        { path: "attestation.operator", source: `${attestation.operator.actor} (${attestation.operator.authorizationRef})` },
        { path: "attestation.attestedAt", source: attestation.attestedAt },
        // The recorded stop list. A reopen binds no coordinator and revokes no
        // session row, so a generated document truthfully names none.
        { path: "attestation.stoppedSessions", source: attestation.stoppedSessions.length === 0 ? "none" : attestation.stoppedSessions.map((session) => session.sessionId).join(", ") },
      ],
      warnings: [],
      commitState: "committed",
    };
    const receipt: ExecutionRead<ExecutionState> = {
      ...readExecutionStateGraph(tx),
      actor_session_id: caller.sessionId,
      reason: input.reason,
      operationRecovery: provenance,
    };
    writeOperationReceipt(tx, {
      operationId,
      requestHash,
      workflowId,
      planId: null,
      receipt,
      now,
      slim: true,
    });
    const { operationRecovery, ...publicReceipt } = receipt;
    return {
      ...publicReceipt,
      operationId,
      replayed: false,
      ...(operationRecovery === undefined ? {} : { recovery: operationRecovery }),
    };
  });
}

/** §2.2 the coordinator rows of one workflow, including the non-active ones. */
function readCoordinatorRows(tx: ExecutionTransaction, workflowId: string): SessionRow[] {
  return readWorkflowSessionRows(tx, workflowId, "coordinator");
}

/**
 * Select only the named predecessor's actual registered attempt, with an
 * applicable operator stop instant. An initial replacement can leave a newer
 * claim intact; a continuation must have a selected claim before any writes.
 */
function recoverableIntegrationClaim(
  tx: ExecutionTransaction,
  input: { workflowId: string; priorSessionId: string | null; callerId: string; attestedAt: string; at: string; required: boolean },
): IntegrationMergeLease | null {
  const { workflowId, priorSessionId, callerId, attestedAt, at } = input;
  const workflow = readExecutionStateGraph(tx).data.workflows.find((candidate) => candidate.state.id === workflowId);
  const claim = workflow?.integrationLease ?? null;
  const row = claim === null ? undefined : workflow?.plans.find((candidate) => candidate.plan.id === claim.plan_id);
  const metadata = row?.plan.metadata;
  const snapshot = workflow === undefined ? undefined : {
    ...workflow.state,
    plans: workflow.plans.map((candidate) => candidate.plan),
  } as WorkflowSnapshot;
  const target = snapshot === undefined ? undefined :
    deliveryRouteOf(snapshot) === "integration" ? snapshot.branch?.integration : snapshot.branch?.target;
  const claimedAt = claim === null ? NaN : Date.parse(claim.claimed_at);
  const stopAt = Date.parse(attestedAt);
  const recoveryAt = Date.parse(at);
  const cause =
    claim === null ? "no held integration claim remains" :
    priorSessionId === null || priorSessionId === callerId || claim.holder !== priorSessionId ? `the claim belongs to ${claim.holder}, not the named predecessor` :
    row === undefined ? `claim plan ${claim.plan_id} is not registered in this workflow` :
    !isPlainObject(metadata) || metadata.working_branch !== claim.source_branch ? `claim source ${claim.source_branch} does not match its registered row scope` :
    !isNonEmptyString(target) || target !== claim.target_branch ? `claim target ${claim.target_branch} does not match the registered target ${String(target)}` :
    !Number.isFinite(claimedAt) || !Number.isFinite(stopAt) || !Number.isFinite(recoveryAt) ? "claim or stop time is not a finite instant" :
    claimedAt > stopAt ? "the claim was taken after the attested stop" :
    stopAt > recoveryAt ? "the attested stop is in the future" : null;
  if (cause === null) return claim;
  if (!input.required) return null;
  throw invalidWorkflowTransition(
    "The workflow cannot renew predecessor recovery; the current binding and claim are unchanged. A renewal requires a fresh operation id and complete stop evidence whose instant covers the named predecessor's claim and is not in the future. Inspect the claim and scope with mstar status validate; for an absent claim plan, inspect the backup with mstar store execution restore-preview --harness=<abs> before any restore.",
    {
      workflow_id: workflowId, session_id: callerId, prior_session_id: priorSessionId,
      claim: claim ?? null, registered_source: isPlainObject(metadata) ? metadata.working_branch ?? null : null,
      registered_target: target ?? null, attested_at: attestedAt, recovered_at: at, cause,
    },
  );
}

/**
 * §4.2 a terminal lifecycle's ONE admissible repair: the integration merge lease
 * a crash (or a foreign writer) left held is released by the same recovery call,
 * and nothing else about the closed lifecycle moves. The header keeps its bytes
 * and revision, every coordinator row stays as recorded, registry membership
 * stays removed and no binding is created — a closed lifecycle is never
 * reopened.
 *
 * The guards are the recovery guards, narrowed: the workflow token is still the
 * CAS, the request must NAME the lease's recorded holder, and the attestation
 * must name that holder as stopped/reloaded. Without stop evidence this would
 * release a claim a LIVE session still holds — the silent takeover the recovery
 * route must never perform. A terminal workflow with no held lease keeps the
 * closed-lifecycle refusal.
 */
function releaseTerminalHeldLease(
  tx: ExecutionTransaction,
  input: {
    workflowId: string;
    callerId: string;
    priorSessionId: string | null;
    reason: string;
    attestation: ActivationAttestation;
    operationId: string;
    requestHash: string;
    expected: ExecutionToken;
    status: string;
    revision: number;
  },
): ExecutionReceipt<ExecutionSessionRef> {
  const { workflowId, status } = input;
  // The receipt addresses the workflow header, not a session: no binding is
  // created or advanced here.
  const replay = readOperationReplay<ExecutionSessionRef>(tx, {
    operationId: input.operationId,
    requestHash: input.requestHash,
    workflowId,
    planId: null,
    token: { kind: "workflow", key: [workflowId] },
  });
  if (replay !== null) return replay;
  assertExecutionToken(input.expected, {
    kind: "workflow",
    storeId: tx.storeId,
    epoch: tx.epoch,
    key: [workflowId],
    revision: input.revision,
  });
  const claim = readHeldIntegrationLease(tx, workflowId);
  if (claim === null) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} is ${status} \u2014 recovery binds an ACTIVE lifecycle's coordinator, and a closed ` +
        `lifecycle is never reopened`,
      { workflow_id: workflowId, status },
    );
  }
  if (input.priorSessionId === null || input.priorSessionId !== claim.holder) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} is ${status} and its held integration merge lease belongs to ${claim.holder} \u2014 a terminal ` +
        `release must name that exact holder as the prior session, and no other identity can release its claim`,
      { workflow_id: workflowId, status, holder: claim.holder, named: input.priorSessionId },
    );
  }
  if (!input.attestation.stoppedSessions.some((session) => session.sessionId === claim.holder)) {
    throw invalidWorkflowTransition(
      `the attestation does not name the held lease's holder ${claim.holder} as stopped/reloaded \u2014 a terminal release ` +
        `requires stop evidence for that holder, so it can never release a live session's claim`,
      { workflow_id: workflowId, status, session_id: claim.holder },
    );
  }
  const now = new Date().toISOString();
  // The attested stop must cover the claim it releases: a claim taken after the
  // stop means its holder was still working then, and a future stop is no
  // evidence at all. Same trust boundary the ACTIVE claim settlement applies.
  const claimedAt = Date.parse(claim.claimed_at);
  const stopAt = Date.parse(input.attestation.attestedAt);
  const releaseAt = Date.parse(now);
  const uncovered =
    !Number.isFinite(claimedAt) || !Number.isFinite(stopAt) || !Number.isFinite(releaseAt) ? "the claim or stop time is not a finite instant" :
    claimedAt > stopAt ? "the claim was taken after the attested stop" :
    stopAt > releaseAt ? "the attested stop is in the future" : null;
  if (uncovered !== null) {
    throw invalidWorkflowTransition(
      `the attestation does not cover the held integration merge lease of ${claim.holder} \u2014 ${uncovered}; a terminal release ` +
        `needs stop evidence at or after the claim's own instant, so it can never release a claim its stopped holder did not take`,
      {
        workflow_id: workflowId,
        status,
        session_id: claim.holder,
        claimed_at: claim.claimed_at,
        attested_at: input.attestation.attestedAt,
        cause: uncovered,
      },
    );
  }
  releaseIntegrationMergeLease(tx, {
    workflowId,
    claim,
    releasedBy: input.callerId,
    reason: `terminal-release:${claim.holder}`,
    now,
  });
  // The header revision is deliberately NOT advanced: the release is a fact
  // about the lease row, and a closed lifecycle's header stays frozen.
  const receipt: ExecutionRead<ExecutionSessionRef> = {
    data: { storeId: tx.storeId, epoch: tx.epoch, workflowId, role: "coordinator", sessionId: input.callerId },
    token: executionToken("workflow", tx.storeId, tx.epoch, [workflowId], input.revision),
    storeId: tx.storeId,
    epoch: tx.epoch,
  };
  writeOperationReceipt(tx, {
    operationId: input.operationId,
    requestHash: input.requestHash,
    workflowId,
    planId: null,
    receipt: {
      ...receipt,
      recovery: {
        prior_session_id: input.priorSessionId,
        reason: input.reason,
        attested_at: input.attestation.attestedAt,
        operator: input.attestation.operator,
        stopped_sessions: input.attestation.stoppedSessions.map((session) => session.sessionId),
        terminal_release: true,
      },
    } as ExecutionRead<ExecutionSessionRef>,
    now,
  });
  return { ...receipt, operationId: input.operationId, replayed: false };
}

/**
 * The workflow's held integration lease read from its own row: a terminal
 * workflow is out of the ACTIVE registry, so no witness reader covers it. A
 * released tombstone reads as no held lease; an unreadable row refuses.
 */
function readHeldIntegrationLease(tx: ExecutionTransaction, workflowId: string): IntegrationMergeLease | null {
  const row = tx.db
    .prepare("select lease_json from execution_integration_leases where workflow_id = ?")
    .get(workflowId) as { lease_json?: unknown } | undefined;
  if (row === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(String(row.lease_json));
  } catch {
    throw new StoreError("store.corrupt", `execution_integration_leases(${workflowId}).lease_json is not valid JSON`);
  }
  if (!isPlainObject(raw)) {
    throw new StoreError("store.corrupt", `execution_integration_leases(${workflowId}).lease_json is not an object`);
  }
  if (raw.status !== undefined && raw.status !== "held" && raw.status !== "released") {
    throw new StoreError(
      "store.corrupt",
      `execution_integration_leases(${workflowId}).lease_json carries status ${JSON.stringify(raw.status)}, which is neither held nor released`,
    );
  }
  if (raw.status === "released") return null;
  if (!isNonEmptyString(raw.holder)) {
    throw new StoreError("store.corrupt", `execution_integration_leases(${workflowId}).lease_json records no holder`);
  }
  return raw as unknown as IntegrationMergeLease;
}

/**
 * The recovered bindings' provenance: every successful recovery receipt that
 * created this exact current binding (same session, epoch, revision and
 * `bound_at`), as the `recovery` blocks they recorded. Empty when the binding
 * was created by an ordinary bind rather than a recovery.
 */
function bindingRecoveryBlocks(
  tx: ExecutionTransaction,
  workflowId: string,
  current: SessionRow,
): Array<Record<string, unknown>> {
  const binding = tx.db.prepare(
    "select bound_at from execution_sessions where workflow_id = ? and role = 'coordinator' and session_id = ? and epoch = ?",
  ).get(workflowId, current.ref.sessionId, tx.epoch) as { bound_at: string } | undefined;
  if (binding === undefined) return [];
  const token = executionToken("session", tx.storeId, tx.epoch, [workflowId, "coordinator", current.ref.sessionId], current.revision);
  const receipts = tx.db.prepare(
    "select result_json from execution_operations where workflow_id = ? and plan_id is null and store_id = ? and epoch = ? and committed_at = ?",
  ).all(workflowId, tx.storeId, tx.epoch, binding.bound_at) as Array<{ result_json: string }>;
  const blocks: Array<Record<string, unknown>> = [];
  for (const receipt of receipts) {
    const raw: unknown = JSON.parse(receipt.result_json);
    if (!isPlainObject(raw) || raw.token !== token || raw.storeId !== tx.storeId || raw.epoch !== tx.epoch) continue;
    const data = raw.data;
    const recovery = raw.recovery;
    if (!isPlainObject(data) || !isPlainObject(recovery)) continue;
    if (
      data.storeId === tx.storeId && data.epoch === tx.epoch && data.workflowId === workflowId &&
      data.sessionId === current.ref.sessionId && data.role === "coordinator"
    ) blocks.push(recovery);
  }
  return blocks;
}

/** The successful receipt must have created this exact current binding from that predecessor. */
function hasCoordinatorRecoveryChain(
  tx: ExecutionTransaction,
  workflowId: string,
  current: SessionRow,
  priorSessionId: string,
): boolean {
  return bindingRecoveryBlocks(tx, workflowId, current).some((recovery) => recovery.prior_session_id === priorSessionId);
}

/**
 * The holder-live warning the close of a recovered binding carries forward: the
 * recover receipt that created the caller's current binding recorded it, and the
 * terminal close prunes that receipt, so the surviving receipt keeps the fact.
 * Absent when this binding was not created by a recovery, or the recovery it
 * came from replaced a holder that was already revoked.
 */
function recoveredHolderLiveWarning(
  tx: ExecutionTransaction,
  workflowId: string,
  sessionId: string,
): HolderLiveWarning | undefined {
  const current = readCoordinatorRows(tx, workflowId).find(
    (row) => row.ref.sessionId === sessionId && row.state === "active" && row.ref.epoch === tx.epoch,
  );
  if (current === undefined) return undefined;
  for (const recovery of bindingRecoveryBlocks(tx, workflowId, current)) {
    if (isPlainObject(recovery.holder_live_warning)) return recovery.holder_live_warning as HolderLiveWarning;
  }
  return undefined;
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