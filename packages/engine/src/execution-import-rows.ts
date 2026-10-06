import { executionInputHash, executionInputSelection, type CatalogExecutionPin } from "./coordination.js";
import { isNonEmptyString, isPlainObject, validateRowCoordination } from "./coordination-write.js";
import { ExecutionError, type ExecutionTransaction } from "./execution-store.js";
import { validatePlanRow, type WorkflowEntry } from "./status.js";
import { rowValidationRoute, validateWorkflowSnapshot, type WorkflowSnapshot } from "./workflow.js";

export type ImportedSessionBinding = { session_id: string; session_file: string; bound_at: string };
export type ImportedPlan = {
  id: string;
  row: Record<string, unknown>;
  pin: CatalogExecutionPin | null;
  /** A legacy per-plan session binding the stopped workspace still records. */
  droppedSession: boolean;
  /** A legacy per-plan execution lease the stopped workspace still records. */
  droppedLease: boolean;
};
export type ImportedWorkflow = {
  entry: WorkflowEntry | null;
  id: string;
  snapshot: WorkflowSnapshot;
  coordinator: ImportedSessionBinding | null;
  plans: ImportedPlan[];
};

function conflict(message: string): never {
  throw new ExecutionError("execution.migration-conflict", message);
}

/**
 * §2.2 stopped-workspace import: an imported session is a HISTORICAL fact — a
 * snapshot proves a past binding, never current liveness — so it imports
 * suspended. The workflow coordinator is the only session identity the engine
 * still has; a legacy plan-PM row is dropped by the importer instead of being
 * resurrected as a seat that no longer exists.
 */
function insertCoordinatorSession(tx: ExecutionTransaction, workflowId: string, value: ImportedSessionBinding): void {
  tx.db
    .prepare(
      "insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) " +
        "values (?, 'coordinator', ?, ?, 1, 'suspended', ?)",
    )
    .run(workflowId, value.session_id, tx.epoch, value.bound_at);
}

/**
 * Project one stopped workspace's legacy row-coordination block onto the
 * coordinator-only shape the store now writes.
 *
 * A stopped workspace's block may carry the removed plan-PM seat's own
 * projections: a per-plan `session` binding, a sealed `handoff` (whose QC/QA
 * verdict and recorded integration result are the business evidence of a
 * finished attempt) and an `assignment`-sealed `prepared`. Those are MAPPED, not
 * rejected — the row's real completion evidence is exactly what this import
 * preserves — and the members the seat owned are dropped. A `returned` handoff
 * is not a completion, so it projects nothing.
 */
function projectLegacyRowCoordination(row: Record<string, unknown>): Record<string, unknown> {
  const legacy = isPlainObject(row.coordination) ? row.coordination : {};
  // The block's `revision` belongs to the dedicated `execution_plans.revision`
  // column, never to the stored JSON (the DB representation invariant the whole
  // reader set relies on), so the projection carries no revision.
  const out: Record<string, unknown> = {};
  const prepared = legacy.prepared;
  if (isPlainObject(prepared)) {
    const qaGate = prepared.qa_gate;
    const findings = prepared.findings_cleanup;
    if (
      isNonEmptyString(prepared.prepared_by) &&
      isNonEmptyString(prepared.prepared_at) &&
      (qaGate === "mandatory" || qaGate === "pm-acceptance") &&
      (findings === "zero-residual" || findings === "allow-residual")
    ) {
      out.prepared = { qa_gate: qaGate, findings_cleanup: findings, prepared_by: prepared.prepared_by, prepared_at: prepared.prepared_at };
    }
  }
  if (isPlainObject(legacy.progress)) out.progress = legacy.progress;
  const handoff = legacy.handoff;
  if (isPlainObject(handoff) && handoff.state === "completed") {
    const qc = handoff.qc;
    const qa = handoff.qa;
    const integration = handoff.integration;
    const mapped: Record<string, unknown> = {
      source_branch: isNonEmptyString(handoff.source_branch) ? handoff.source_branch : null,
      source_sha: isNonEmptyString(handoff.source_sha) ? handoff.source_sha : null,
      worktree_path: isNonEmptyString(handoff.worktree_path) ? handoff.worktree_path : null,
      review_base: isNonEmptyString(handoff.review_base) ? handoff.review_base : null,
      review_head: isNonEmptyString(handoff.review_head) ? handoff.review_head : null,
      qc: isPlainObject(qc) ? qc : { decision: "", reports: [], consolidated: { path: "", sha256: "" } },
      qa: isPlainObject(qa) ? qa : { gate: "", decision: "", report: { path: "", sha256: "" } },
      completed_by: isNonEmptyString(handoff.accepted_by) ? handoff.accepted_by : "",
      completed_at: isNonEmptyString(handoff.completed_at) ? handoff.completed_at : "",
    };
    if (isPlainObject(integration)) {
      mapped.integration = {
        target_branch: isNonEmptyString(integration.target_branch) ? integration.target_branch : "",
        worktree_path: isNonEmptyString(integration.worktree_path) ? integration.worktree_path : "",
        base_sha: isNonEmptyString(integration.base_sha) ? integration.base_sha : "",
        result_sha: isNonEmptyString(integration.result_sha) ? integration.result_sha : "",
        verified_at: isNonEmptyString(integration.verified_at) ? integration.verified_at : "",
      };
    }
    out.completion = mapped;
  }
  return out;
}

/**
 * Map the source/cleanup ownership a removed per-plan lease carried onto the
 * ordinary row metadata, so dropping the lease never drops the only record of
 * the source checkout and branch. Existing metadata wins; only the members the
 * lease alone recorded are filled in, and the caller resolves a genuine
 * conflict by naming it rather than silently keeping one.
 */
function projectLegacyLeaseScope(row: Record<string, unknown>, workflowId: string, planId: string): Record<string, string> {
  const lease = row.execution_lease;
  if (!isPlainObject(lease)) return {};
  const worktree = isNonEmptyString(lease.worktree_path)
    ? lease.worktree_path
    : isNonEmptyString(lease.plan_worktree_path)
      ? lease.plan_worktree_path
      : undefined;
  const branch = isNonEmptyString(lease.working_branch)
    ? lease.working_branch
    : isNonEmptyString(lease.plan_branch)
      ? lease.plan_branch
      : undefined;
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const scoped: Record<string, string> = {};
  const recordedWorktree = metadata.worktree_path;
  const recordedBranch = metadata.working_branch;
  if (worktree !== undefined) {
    if (isNonEmptyString(recordedWorktree) && recordedWorktree !== worktree) {
      conflict(`plan ${planId} of workflow ${workflowId} records worktree ${recordedWorktree} in metadata and ${worktree} on its removed execution lease; resolve which checkout owns this plan, then rerun store upgrade.`);
    }
    scoped.worktree_path = worktree;
  } else if (isNonEmptyString(recordedWorktree)) {
    scoped.worktree_path = recordedWorktree;
  }
  if (branch !== undefined) {
    if (isNonEmptyString(recordedBranch) && recordedBranch !== branch) {
      conflict(`plan ${planId} of workflow ${workflowId} records branch ${recordedBranch} in metadata and ${branch} on its removed execution lease; resolve which branch owns this plan, then rerun store upgrade.`);
    }
    scoped.working_branch = branch;
  } else if (isNonEmptyString(recordedBranch)) {
    scoped.working_branch = recordedBranch;
  }
  return scoped;
}

/** Reused transaction row mapping for file-imported workflow state. */
export function writeImportedExecutionWorkflow(tx: ExecutionTransaction, source: ImportedWorkflow): void {
  const { id, entry, snapshot, coordinator, plans } = source;
  const snapshotGate = validateWorkflowSnapshot(snapshot);
  if (!snapshotGate.ok) conflict(`workflow ${id} snapshot is invalid (${snapshotGate.violations.map((v) => v.code).join(", ")}).`);
  const header: Record<string, unknown> = { ...(snapshot as unknown as Record<string, unknown>) };
  delete header.plans;
  delete header.coordination;
  delete header.integration_merge_lease;
  if (snapshot.coordination?.identity_recoveries !== undefined) {
    header.identity_recoveries = snapshot.coordination.identity_recoveries;
  }
  delete header.self_amendments;
  tx.db.prepare("insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) values (?, 1, ?, ?, ?, ?)")
    .run(id, coordinator?.session_id ?? null, JSON.stringify(header), snapshot.started_at, snapshot.updated_at);
  if (entry !== null) tx.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)").run(id, JSON.stringify(entry));
  if (coordinator !== null) insertCoordinatorSession(tx, id, coordinator);
  const insertPlan = tx.db.prepare("insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, ?, ?, ?)");
  const insertInput = tx.db.prepare("insert into execution_inputs(workflow_id, plan_id, revision, input_json, input_hash, catalog_pin_json) values (?, ?, 1, ?, ?, ?)");
  const routeSnapshot = { ...(snapshot as unknown as WorkflowSnapshot), plans: plans.map((plan) => ({ id: plan.id })) } as WorkflowSnapshot;
  plans.forEach(({ id: planId, row, pin, droppedLease }, ordinal) => {
    const block = projectLegacyRowCoordination(row);
    // Source/cleanup ownership survives the removed lease: its recorded
    // worktree/branch move into the ordinary row metadata the target shape uses,
    // so L1 facts and cleanup ownership are never lost with the seat.
    const scope = projectLegacyLeaseScope(row, id, planId);
    const state: Record<string, unknown> = { ...row, id: planId };
    if (Object.keys(scope).length > 0) {
      const metadata = isPlainObject(row.metadata) ? { ...row.metadata } : {};
      state.metadata = { ...metadata, ...scope };
    }
    // A stopped workspace's in-progress claim is not carried into the new
    // authority as live work: that is why the row imports as Blocked rather
    // than apparently being worked on.
    if (droppedLease && state.status === "InProgress") state.status = "Blocked";
    if (!isNonEmptyString(state.status) || state.status === "Todo") {
      const projected = isPlainObject(block.completion) ? "Done" : undefined;
      if (projected !== undefined) state.status = projected;
    }
    delete state.coordination;
    delete state.execution_lease;
    const stateGate = validatePlanRow(state);
    if (!stateGate.ok) conflict(`plan ${planId} of workflow ${id} has an invalid stored row (${stateGate.violations.map((v) => v.code).join(", ")}).`);
    const violations = validateRowCoordination(
      { revision: 1, ...block },
      `execution_plans(${id},${planId}).coordination_json`,
      rowValidationRoute(routeSnapshot, state as never),
    );
    if (violations.length > 0) conflict(`plan ${planId} of workflow ${id} has malformed coordination data (${violations.map((v) => v.code).join(", ")}).`);
    insertPlan.run(id, planId, ordinal, JSON.stringify(state), JSON.stringify(block));
    insertInput.run(id, planId, JSON.stringify(executionInputSelection(row, planId)), executionInputHash(row, planId), pin === null ? null : JSON.stringify(pin));
  });
  const merge = snapshot.integration_merge_lease;
  if (merge !== undefined) {
    if (!isPlainObject(merge) || !isNonEmptyString(merge.holder) || !isNonEmptyString(merge.claimed_at) || !isNonEmptyString(merge.source_branch) || !isNonEmptyString(merge.target_branch)) conflict(`workflow ${id} has malformed integration lease fields; repair or remove that lease, then rerun store upgrade.`);
    if (coordinator === null || coordinator.session_id !== merge.holder) conflict(`workflow ${id} integration lease holder has no matching coordinator; repair or remove the lease, then rerun store upgrade.`);
  }
}
