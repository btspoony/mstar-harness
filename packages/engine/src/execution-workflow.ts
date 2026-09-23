/**
 * execution-workflow.ts — the DB transport of the WORKFLOW-LEVEL lifecycle
 * transitions and the explicit coordinator recovery bootstrap
 * (primary spec §2.3/§3/§4.1/§4.2).
 *
 * W1–W4 built the plan-operation half of the execution authority: one accepted
 * plan operation is one transaction. This module adds the workflow's own half —
 * the phase, lifecycle, execution-policy, integration-checkout and delivery
 * transitions of one lifecycle — and the ONE transition that can repair a
 * coordinator identity: the named recovery bootstrap.
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
 * probes) happens BEFORE SQLite ownership and is reduced to pinned witnesses;
 * the transaction re-reads exactly those bytes immediately before the commit,
 * so a compass edited or a checkout switched in that window refuses
 * `coordination.evidence-stale` instead of committing a stale proof.
 *
 * The recovery bootstrap is deliberately NOT a silent lease steal and NOT a
 * second `bind`:
 *
 * - the trusted caller must be a coordinator of the addressed workflow, and the
 *   store must currently hold NO active coordinator at this epoch — a live
 *   owner is never replaced by recovery;
 * - the exact workflow token is the CAS, the prior holder must be NAMED, and
 *   the operator attestation must name that session as stopped/reloaded (the
 *   existing `validateActivationAttestation` document rule supplies the
 *   operator authorization reference and the current-coordinator consumer);
 * - revocation and rebinding commit together with an immutable operation
 *   receipt recording the prior holder, the reason and the attestation digest;
 * - only the ownership that revoking the NAMED holder orphaned is adopted by
 *   the recovery session, with its `owner_epoch` UNCHANGED, which is what makes
 *   a workflow whose coordinator stopped readable again (the whole-view reader
 *   refuses a held lease whose holder row is not active — the state recovery
 *   exists to repair). A lease held by any other session keeps its ownership:
 *   a live holder is never touched, and §2.3's rule that outstanding leases
 *   retain their owner epoch and still need an explicit `reconcile` (or a
 *   recovery that names THEIR holder) before reuse covers the rest. A lease
 *   from an earlier epoch stays exactly where it is: recovery never revives
 *   old-epoch ownership, and `reconcile` remains the transition that must move
 *   an interrupted attempt.
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
  sha256Bytes,
} from "./coordination-write.js";
import {
  gitRead,
  pinGitRefWitness,
  revalidateGitRefWitness,
  type GitRefWitness,
} from "./coordination.js";
import { rowStatusOf, summarize } from "./coordination-transitions.js";
import {
  ExecutionError,
  advanceWorkflowHeaderRevision,
  assertExecutionToken,
  assertOperationId,
  bindRecoveredSession,
  executionToken,
  readExecutionState,
  readExecutionStateGraph,
  readExecutionWorkflowWitness,
  readHeldExecutionLeases,
  readOperationReplay,
  readWorkflowSessionRows,
  recordRootMembershipLoss,
  requireWorkflowState,
  resolveWorkflowSession,
  resolveWorkflowWrite,
  revokeSessionRow,
  serializeExecutionValue,
  transferExecutionLease,
  withExecutionTransaction,
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
import { validateActivationAttestation, type ActivationAttestation } from "./store-activation.js";
import { StoreError, storeDbPath } from "./store-db.js";
import {
  WORKFLOW_LIFECYCLE_STATUSES,
  WORKFLOW_TERMINAL_STATUSES,
  consultDeliveryEvidence,
  deliveryEvidenceMembers,
  deliveryEvidenceViolations,
  isTerminalSnapshot,
  stableJson,
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
 * §3.1 the canonical payload half of a workflow-operation request hash: the
 * operation's own fields, never the envelope (kind, scope, token and caller are
 * hashed beside it by `workflowOperationRequestHash`).
 */
function workflowOperationPayload(operation: WorkflowExecutionOperation): Record<string, unknown> {
  switch (operation.kind) {
    case "phase":
      return { phase: operation.phase, compass_path: operation.compassPath };
    case "lifecycle":
      return { status: operation.status, reason: operation.reason };
    case "execution-policy":
      return { policy: operation.policy };
    case "integration-worktree":
      return { path: operation.path };
    case "delivery":
      return { delivery: operation.delivery };
  }
}

/** §3.1 request hash: operation kind, exact scope, expected token, caller identity and payload. */
function workflowOperationRequestHash(
  caller: ExecutionCaller,
  kind: string,
  workflowId: string,
  expected: ExecutionToken,
  payload: unknown,
): string {
  return createHash("sha256")
    .update(
      serializeExecutionValue({
        operation: kind,
        workflow_id: workflowId,
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

/** The canonical compass a `phase` transition read, with the bytes it read. */
type CompassEvidence = { path: string; sha256: string; doc: CompassDoc };

/**
 * §4.1 everything the external half of one workflow transition observed before
 * SQLite ownership. Each group is read only by the transition that needs it and
 * revalidated inside the transaction.
 */
type WorkflowEvidence = {
  /** `phase`: the canonical compass, and the §3.5 probes the DB authority holds. */
  compass?: CompassEvidence;
  probes?: PhaseGateOptions;
  /** The checkout the Git probes were taken against (must still be the registered one). */
  checkout?: { path: string; branch: string | null };
  /** The Git ref state the probes read, re-read immediately before the commit. */
  gitWitness?: GitRefWitness;
  /** `integration-worktree`: the canonical candidate path and the branch it was on. */
  worktree?: { path: string; branch: string };
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
  const evidence: WorkflowEvidence = { compass: { path: canonical, sha256: sha256Bytes(text), doc }, probes };
  if (integrationPath !== null) {
    const branch = gitRead(integrationPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== undefined && branch !== "") probes.currentBranch = branch;
    evidence.checkout = { path: integrationPath, branch: branch === undefined || branch === "" ? null : branch };
    // The probe's fact is the BRANCH the checkout is on, which is what `HEAD`
    // records — pinning that file makes a switch in the commit window a refusal.
    evidence.gitWitness = pinGitRefWitness(integrationPath, ["HEAD"]);
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
  return {
    worktree: { path, branch: integrationBranch },
    gitWitness: pinGitRefWitness(path, ["HEAD"]),
  };
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
    default:
      // The stored transitions (lifecycle, execution-policy, delivery) read no
      // external evidence: their inputs are the store's own rows, which the
      // transaction reads itself.
      return {};
  }
}

/** §4.1 the commit-window half of the pinned evidence: the same bytes, or a refusal. */
function revalidateWorkflowEvidence(evidence: WorkflowEvidence): void {
  if (evidence.compass !== undefined) {
    const current = existsSync(evidence.compass.path) ? sha256Bytes(readFileSync(evidence.compass.path)) : null;
    if (current !== evidence.compass.sha256) {
      throw new CoordinationError(
        "coordination.evidence-stale",
        `the compass ${evidence.compass.path} changed after the phase gate was read (${evidence.compass.sha256} -> ` +
          `${current ?? "absent"}) \u2014 no phase commits on a stale gate input`,
        { path: evidence.compass.path, expected: evidence.compass.sha256, actual: current },
      );
    }
  }
  if (evidence.gitWitness !== undefined) {
    revalidateGitRefWitness(evidence.gitWitness, (message, details) =>
      new CoordinationError("coordination.evidence-stale", message, details),
    );
  }
  if (evidence.worktree !== undefined && (!existsSync(evidence.worktree.path) || !statSync(evidence.worktree.path).isDirectory())) {
    throw new CoordinationError(
      "coordination.evidence-stale",
      `the integration checkout ${evidence.worktree.path} disappeared after it was validated \u2014 nothing records a checkout ` +
        `that is no longer there`,
      { path: evidence.worktree.path },
    );
  }
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
 * §3 the workflow-level transition surface of the DB authority: one coordinator
 * call carrying the §3.1 mutation envelope (operation id, coordinator session
 * reference, exact workflow token) and the operation itself, whose member of the
 * closed union selects the transition.
 *
 * The frame is the plan frame's sibling and enforces the same rules in the same
 * order: an active authority, the caller's own live coordinator binding, the
 * exact CAS token, ONE revision advance for the accepted operation and a
 * committed receipt that makes an identical retry a replay. It adds nothing a
 * caller can turn into permission: no gate verdict is read from the request, no
 * header field outside the operation's own member is writable, and identity
 * anchors are refused by the shape gate before the store is opened.
 */
export async function mutateExecutionWorkflow(
  context: ExecutionContext,
  request: ExecutionMutation & { workflowId: string; operation: WorkflowExecutionOperation },
): Promise<ExecutionReceipt<ExecutionState>> {
  const resolved = resolveWorkflowOperationRequest(context.caller, request);
  const operation = resolved.call.operation;
  const evidence = await readWorkflowEvidence(context, resolved);
  const requestHash = workflowOperationRequestHash(
    context.caller,
    operation.kind,
    resolved.read.workflowId,
    resolved.call.expected,
    workflowOperationPayload(operation),
  );
  workflowWitnessGapForTest?.();
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; a workflow transition requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    // §3.1 an identical retry returns its recorded receipt — but only after the
    // CURRENT authority is revalidated, so a revoked or epoch-invalidated
    // coordinator never replays a receipt it may no longer own. The receipt
    // addresses the whole graph, so its token is the ROOT token.
    const replay = readOperationReplay<ExecutionState>(tx, {
      operationId: resolved.call.operationId,
      requestHash,
      workflowId: resolved.read.workflowId,
      planId: null,
      token: { kind: "root", key: [] },
    });
    if (replay !== null) {
      resolveWorkflowSession(tx, resolved.read);
      return replay;
    }
    const witness = readExecutionWorkflowWitness(tx, resolved.read);
    assertExecutionToken(resolved.call.expected, {
      kind: "workflow",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [witness.workflowId],
      revision: witness.revision,
    });
    revalidateWorkflowEvidence(evidence);
    const at = new Date().toISOString();
    // §3.1 the ONE revision advance of this accepted multi-domain transaction:
    // header changes advance the addressed workflow once and the store once; a
    // registry membership loss adds the ROOT advance without a second store
    // bump, so the accepted operation advances the store revision exactly once.
    advanceWorkflowHeaderRevision(tx, { workflowId: witness.workflowId, now: at });
    const receipt = applyWorkflowOperation({ tx, witness, operation, evidence, at });
    writeOperationReceipt(tx, {
      operationId: resolved.call.operationId,
      requestHash,
      workflowId: witness.workflowId,
      planId: null,
      receipt,
      now: at,
    });
    return { ...receipt, operationId: resolved.call.operationId, replayed: false };
  });
}

/**
 * §3 the one accepted workflow transition, applied inside the frame's
 * transaction: the candidate header is built from the operation's own member
 * only, validated by the existing snapshot validator, and stored; a terminal
 * lifecycle additionally loses its registry membership in the SAME transaction,
 * so a close that refuses leaves both the routing and the terminal state
 * exactly where they were.
 */
function applyWorkflowOperation(input: {
  tx: ExecutionTransaction;
  witness: ExecutionWorkflowWitness;
  operation: WorkflowExecutionOperation;
  evidence: WorkflowEvidence;
  at: string;
}): ExecutionRead<ExecutionState> {
  const { tx, witness, operation, evidence, at } = input;
  const workflowId = witness.workflowId;
  const current = witness.view.state as unknown as WorkflowSnapshot;
  if (isTerminalSnapshot(current)) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} is ${current.status} \u2014 a closed lifecycle is never amended, and its history stays exactly as ` +
        `it was recorded`,
      { workflow_id: workflowId, status: current.status },
    );
  }
  const rows = witness.view.plans.map((plan) => plan.plan as unknown as PlanRow);
  const header = { ...(witness.view.state as unknown as Record<string, unknown>) };
  let membershipLost = false;
  switch (operation.kind) {
    case "phase":
      applyPhaseTransition({ header, rows, workflowId, operation, evidence });
      break;
    case "lifecycle":
      membershipLost = applyLifecycleTransition({ header, rows, witness, workflowId, operation, at });
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
 * with the compass bytes revalidated immediately before it — so a phase that
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
        "coordination.evidence-stale",
        `the integration checkout of workflow ${workflowId} changed after its branch was probed (${String(checkout.path)} -> ` +
          `${String(registeredPath)}) \u2014 the \u00A73.5 branch probe belongs to the registered checkout`,
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
 * terminal status needs the lifecycle to own no execution or integration lease
 * (the snapshot validator's terminal invariant, read from the rows that own
 * them), and the loss of registry membership commits with the terminal state.
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
  if (header.status === status) return false;
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
      `workflow ${workflowId} cannot become ${status} while it still owns ${dangling.join(", ")} \u2014 a terminal lifecycle ` +
        `carries no dangling lease, and this route never deletes one: release it through the existing completion or ` +
        `reconcile transition first`,
      { workflow_id: workflowId, status },
    );
  }
  header.status = status;
  header.ended_at = at;
  return true;
}

/** The outstanding ownership a terminal lifecycle may not carry, as named facts. */
function danglingOwnership(witness: ExecutionWorkflowWitness): string[] {
  const dangling: string[] = [];
  for (const plan of witness.view.plans) {
    if (plan.executionLease !== null && plan.executionLease.status === "held") {
      dangling.push(`the execution lease of plan ${String(plan.plan.id)} (holder ${plan.executionLease.holder_session_id})`);
    }
  }
  if (witness.view.integrationLease !== null) {
    dangling.push(`the integration merge lease (holder ${witness.view.integrationLease.holder})`);
  }
  return dangling;
}

/**
 * §3 the `execution-policy` transition: the closed policy object the snapshot
 * schema defines. `plan_parallelism` is the ONE key the approved concurrency
 * contract names values for (`coordination.ts`'s Prepare-amendment rule — the
 * same closed set, `serial | parallel`); `worktree_mode` / `push_policy` stay
 * the accepted-but-opaque keys the snapshot validator declares them to be, and
 * an unknown key is refused instead of stored.
 *
 * The operation REPLACES the block: the union member is the whole policy, so a
 * key the payload omits is removed rather than retained. There is no partial
 * policy patch here, because a header patch is exactly what this route must not
 * offer.
 */
function applyExecutionPolicy(workflowId: string, policy: WorkflowExecutionPolicy): WorkflowExecutionPolicy {
  const declared = policy as unknown as Record<string, unknown>;
  assertExactKeys(declared, ["plan_parallelism", "worktree_mode", "push_policy"], `workflow ${workflowId} execution_policy`);
  const parallelism = declared.plan_parallelism;
  if (parallelism !== undefined && (typeof parallelism !== "string" || !PLAN_PARALLELISM_VALUES.includes(parallelism))) {
    throw invalidWorkflowInput(
      `workflow ${workflowId} execution_policy.plan_parallelism must be one of ${PLAN_PARALLELISM_VALUES.join(" | ")} \u2014 ` +
        `got ${JSON.stringify(parallelism ?? null)}`,
    );
  }
  return { ...policy };
}

/**
 * The only `plan_parallelism` values the approved concurrency contract names.
 *
 * simplify: this two-value set is mirrored from `coordination.ts`
 * (`PLAN_PARALLELISM_VALUES`, the Prepare-amendment rule) because that module is
 * not this task's to edit; the upgrade path is to export the set from a shared
 * module once the file route is retired. The mirror is small, closed and named
 * here so a drift would be found by reading the one comment.
 */
const PLAN_PARALLELISM_VALUES: readonly string[] = ["serial", "parallel"];

/**
 * §3 the `delivery` transition: the same evidence rules the file route's
 * `recordWorkflowDelivery` enforces — the declared kind decides which members
 * exist (one shared member map), the structural validator decides their shape,
 * §4d keeps a recorded PR identity immutable and requires the recorded identity
 * to BE the registered delivery, and the delivery tail (§4c/§4d/§4f) is
 * recorded only once every owned row is `Done`. The ONE member that runs the
 * other way — the report-only `completion` fulfilment, recorded BEFORE the row
 * is marked `Done` (contract §1) — is frozen once an owned row is Done, so a
 * later re-point of that evidence is refused instead of silently becoming the
 * basis of a `Done` it never authorized. An identical re-record stays a no-op.
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
  const recordedPr = isPlainObject(stored.pr) ? stored.pr : undefined;
  const incomingPr = isPlainObject(delivery.pr) ? delivery.pr : undefined;
  if (recordedPr !== undefined && incomingPr !== undefined && stableJson(recordedPr) !== stableJson(incomingPr)) {
    throw invalidWorkflowTransition(
      `workflow ${workflowId} records PR identity ${JSON.stringify(recordedPr)} once at submission (\u00A74d) \u2014 ` +
        `${JSON.stringify(incomingPr)} is a different delivery, not an evidence update`,
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
  const tail = members.filter((member) => member !== "completion");
  if (tail.length > 0) {
    const notDone = rows.filter((row) => rowStatusOf(row) !== "Done");
    if (notDone.length > 0) {
      throw invalidWorkflowTransition(
        `workflow ${workflowId} cannot record the delivery tail (${tail.join(", ")}) while ` +
          `${notDone.map((row) => `${String(row.id)} (${rowStatusOf(row) || "no status"})`).join(", ")} ` +
          `${notDone.length === 1 ? "is" : "are"} not Done (contract \u00A73: row Done \u2192 compound disposition \u2192 PR identity \u2192 verified-merge record)`,
        { workflow_id: workflowId },
      );
    }
  }
  // The mirror rule for the ONE member recorded BEFORE the row is Done
  // (contract §1: a report-only row "completes from an accepted handoff plus a
  // recorded fulfilment of that policy — the fulfilment is recorded before the
  // row is marked `Done`"). Once an owned row is Done the recorded fulfilment
  // is FROZEN: it is the basis that row's `Done` was authorized against, so a
  // different evidence reference is a re-pointed completion, not an evidence
  // update (\u00A74d freezes the PR identity the same way). The identical
  // re-record stays a no-op instead of a refusal — the file route's
  // `recordWorkflowDelivery` returns before its own gate for exactly this
  // reason — so a retried recording is idempotent on BOTH transports, and the
  // same stable code refuses the same state there.
  if (members.includes("completion")) {
    const done = rows.filter((row) => rowStatusOf(row) === "Done").map((row) => String(row.id));
    if (done.length > 0) {
      const incoming = isPlainObject(delivery.completion) ? delivery.completion : null;
      const recorded = isPlainObject(stored.completion) ? stored.completion : null;
      if (stableJson(recorded) !== stableJson(incoming)) {
        throw invalidWorkflowTransition(
          `workflow ${workflowId} cannot record the completion fulfilment: ${done.join(", ")} ` +
            `${done.length === 1 ? "is" : "are"} Done, and the registered completion policy's fulfilment is recorded BEFORE ` +
            `the row is marked Done (contract \u00A71) \u2014 the recorded evidence is the basis that row was completed on, so a ` +
            `different reference is a re-pointed completion, never an evidence update`,
          { workflow_id: workflowId },
        );
      }
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
          plan_id: caller.planId,
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
 * 1. the trusted caller is a COORDINATOR of the workflow it addresses (`planId`
 *    null): the recovery identity is never taken from request JSON;
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
 * non-active row), the leases whose holder row this revocation orphaned — only
 * the NAMED holder's own ownership — are adopted by the recovery session with
 * their `owner_epoch` unchanged, the workflow header revision advances once and
 * an immutable operation receipt records the prior holder, the reason and the
 * attestation. A lease held by any other session keeps its ownership and stays
 * outstanding, and leases from an earlier epoch are left exactly as they are —
 * recovery never revives old-epoch ownership or takes foreign ownership, and
 * `reconcile` remains the transition that must move an interrupted attempt.
 */
export async function recoverExecutionCoordinator(
  context: ExecutionContext,
  input: { expected: ExecutionToken; operationId: string; priorSessionId: string | null; reason: string; attestation: ActivationAttestation },
): Promise<ExecutionReceipt<ExecutionSessionRef>> {
  const caller = context.caller;
  if (caller?.role !== "coordinator" || caller.planId !== null) {
    throw new ExecutionError(
      "execution.scope-mismatch",
      `recovering a coordinator identity is a coordinator operation; the supplied caller is a ${String(caller?.role)} session` +
        `${caller?.planId === null || caller?.planId === undefined ? "" : ` for plan ${String(caller.planId)}`}. The caller ` +
        `identity is never taken from request JSON.`,
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
      planId: null,
      epoch: tx.epoch,
      now,
    });
    adoptLeasesOrphanedByRevocation(tx, {
      workflowId,
      revokedSessionId: priorSessionId,
      recoveredSessionId: caller.sessionId,
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
        planId: null,
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

/**
 * §2.3/§4.2 the lease half of the recovery: recovery replaces exactly ONE
 * NAMED holder, so the ownership it may adopt is the ownership THAT holder's
 * revocation orphaned — a HELD lease of this workflow, in the CURRENT epoch,
 * whose holder session is the revoked holder and is not active any more. The
 * whole-view reader refuses exactly that pair, so the recovery session takes it
 * over, keeping `owner_epoch` and recording `transferred_from`; that is what
 * makes a workflow whose coordinator stopped readable again.
 *
 * The boundary is the named holder rather than "any lease nobody is active on".
 * A lease held by another session — an unrelated plan-pm row that stopped, or
 * any holder this recovery neither names nor attests — keeps its ownership and
 * stays outstanding: §2.3 is explicit that outstanding leases retain their
 * `owner_epoch` and must still pass explicit `reconcile` (or a recovery that
 * names THEIR holder) before reuse, so silently moving that ownership to the
 * new coordinator would be exactly the takeover this transition must not
 * perform. A recovery that names no holder revokes nothing and adopts nothing.
 *
 * A lease already held by the recovery session is left alone, a lease held by a
 * LIVE session is never touched (a live holder resumes through its own
 * reference), and a lease from an earlier epoch stays exactly where it is:
 * recovery repairs what its revocation orphaned, it neither revives nor steals
 * ownership. A held lease whose own holder identity is missing is a corrupt
 * record the view reader also refuses, so it is refused here rather than
 * adopted.
 */
function adoptLeasesOrphanedByRevocation(
  tx: ExecutionTransaction,
  input: { workflowId: string; revokedSessionId: string | null; recoveredSessionId: string; now: string },
): void {
  const { workflowId, revokedSessionId, recoveredSessionId, now } = input;
  const rowsByRole: Record<"coordinator" | "plan-pm", SessionRow[]> = {
    coordinator: readCoordinatorRows(tx, workflowId),
    "plan-pm": readWorkflowSessionRows(tx, workflowId, "plan-pm"),
  };
  const activeHolder = (role: "coordinator" | "plan-pm", sessionId: string, planId: string): boolean =>
    rowsByRole[role].some(
      (row) =>
        row.ref.sessionId === sessionId &&
        row.state === "active" &&
        row.ref.epoch === tx.epoch &&
        (row.ref.planId === null || row.ref.planId === planId),
    );
  for (const held of readHeldExecutionLeases(tx, workflowId)) {
    if (held.ownerEpoch !== tx.epoch) continue;
    const role = held.lease.holder_role;
    const holder = held.lease.holder_session_id;
    // A held lease whose ownership identity is missing is the same corrupt pair
    // the view reader refuses; recovery refuses it too instead of adopting a
    // claim nobody is named on.
    if ((role !== "coordinator" && role !== "plan-pm") || !isNonEmptyString(holder)) {
      throw new StoreError(
        "store.corrupt",
        `execution_leases(${workflowId},${held.planId}).lease_json is held in epoch ${held.ownerEpoch} without the holder ` +
          `session identity and role it must agree with; the execution authority cannot be verified`,
      );
    }
    if (holder === recoveredSessionId) continue;
    if (activeHolder(role, holder, held.planId)) continue;
    // The boundary: only the revoked holder's own ownership was orphaned by
    // this recovery, and only that ownership is adopter-able here.
    if (revokedSessionId === null || holder !== revokedSessionId) continue;
    transferExecutionLease(tx, {
      workflowId,
      planId: held.planId,
      lease: held.lease,
      to: { sessionId: recoveredSessionId, role: "coordinator" },
      now,
    });
  }
}
