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
  // A SNAPSHOT row's coordination keeps the revision the live snapshot schema
  // requires; the DB writer strips it before storing, because there the value
  // belongs to the dedicated `execution_plans.revision` column alone.
  const revision = Number.isInteger(legacy.revision) && (legacy.revision as number) >= 0 ? (legacy.revision as number) : 1;
  const out: Record<string, unknown> = { revision };
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
  // The block may already be the projected target shape (discovery projects the
  // whole snapshot before this writer runs): carry its contracted completion
  // verbatim rather than re-deriving it from a handoff that no longer exists.
  const handoff = legacy.handoff;
  if (isPlainObject(legacy.completion)) {
    out.completion = legacy.completion;
  } else if (isPlainObject(handoff) && handoff.state === "completed") {
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
 * the source checkout and branch. The row's own metadata is the authoritative,
 * revisable scope (the coordinator revises it through ordinary `prepare`), so it
 * wins any disagreement and the superseded lease value is dropped with its seat.
 */
function projectLegacyLeaseScope(row: Record<string, unknown>): Record<string, string> {
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
  if (worktree !== undefined && !isNonEmptyString(recordedWorktree)) scoped.worktree_path = worktree;
  if (branch !== undefined && !isNonEmptyString(recordedBranch)) scoped.working_branch = branch;
  return scoped;
}

/**
 * The raw historical inventory a stopped workspace's plan rows carry BEFORE any
 * projection: which rows were bound to the removed seat and which carried a
 * per-plan lease. The import bookkeeping (Blocked normalisation and the
 * receipt's dispositions) must read these from the RAW rows, because the
 * projected snapshot no longer carries them.
 */
export function legacySnapshotInventory(raw: unknown): ReadonlyMap<string, { droppedSession: boolean; droppedLease: boolean }> {
  const inventory = new Map<string, { droppedSession: boolean; droppedLease: boolean }>();
  const snapshot = isPlainObject(raw) ? raw : {};
  const plans = Array.isArray(snapshot.plans) ? snapshot.plans : [];
  for (const plan of plans) {
    if (!isPlainObject(plan)) continue;
    const id = typeof plan.id === "string" && plan.id !== "" ? plan.id : typeof plan.plan_id === "string" ? plan.plan_id : "";
    if (id === "") continue;
    const coordination = isPlainObject(plan.coordination) ? plan.coordination : {};
    inventory.set(id, {
      droppedSession: coordination.session !== undefined,
      droppedLease: plan.execution_lease !== undefined,
    });
  }
  return inventory;
}

/**
 * Project a stopped workspace's RAW snapshot onto the target shape BEFORE any
 * current validator sees it. Discovery and the writer both validate with the
 * live exact-key schema, and that schema refuses the members the removed
 * protocol wrote (`session`, `handoff`, the sealed assignment fields,
 * `self_amendments`) — so projecting them away here is what lets a real legacy
 * snapshot through admission instead of being skipped whole. Business facts
 * (progress, prepared configuration, completed QC/QA/source/integration
 * evidence, scope ownership) are preserved; nothing is re-added.
 */
export function projectLegacySnapshot(raw: unknown): WorkflowSnapshot {
  const snapshot: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (isPlainObject(snapshot.coordination)) {
    const coordination: Record<string, unknown> = { ...snapshot.coordination };
    delete coordination.self_amendments;
    snapshot.coordination = coordination;
  }
  const plans = Array.isArray(snapshot.plans) ? snapshot.plans : [];
  snapshot.plans = plans.map((plan) => {
    if (!isPlainObject(plan)) return plan;
    const row: Record<string, unknown> = { ...plan };
    row.coordination = projectLegacyRowCoordination(row);
    const scope = projectLegacyLeaseScope(row);
    if (Object.keys(scope).length > 0) {
      const metadata = isPlainObject(row.metadata) ? row.metadata : {};
      row.metadata = { ...metadata, ...scope };
    }
    delete row.execution_lease;
    return row;
  });
  return snapshot as unknown as WorkflowSnapshot;
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
    // The snapshot row was projected at discovery and carries the revision the
    // live snapshot schema requires; the stored DB block strips it, because
    // there that value belongs to the dedicated revision column alone.
    const projected = isPlainObject(row.coordination) ? row.coordination : {};
    // Source/cleanup ownership survives the removed lease: its recorded
    // worktree/branch move into the ordinary row metadata the target shape uses,
    // so L1 facts and cleanup ownership are never lost with the seat. The
    // projection already merged that scope into metadata at discovery.
    const state: Record<string, unknown> = { ...row, id: planId };
    // A stopped workspace's in-progress claim is not carried into the new
    // authority as live work: that is why the row imports as Blocked rather
    // than apparently being worked on.
    if (droppedLease && state.status === "InProgress") state.status = "Blocked";
    if (!isNonEmptyString(state.status) || state.status === "Todo") {
      // A migrated completion is a finished row: promote it exactly as the
      // migration normalizer does, preserving every other recorded status.
      if (isPlainObject(projected.completion)) state.status = "Done";
    }
    delete state.coordination;
    delete state.execution_lease;
    const stateGate = validatePlanRow(state);
    if (!stateGate.ok) conflict(`plan ${planId} of workflow ${id} has an invalid stored row (${stateGate.violations.map((v) => v.code).join(", ")}).`);
    // Validate the full projected block (which carries the revision the live
    // snapshot schema requires), then store the revision-free DB block whose
    // revision lives in the dedicated `execution_plans.revision` column.
    const violations = validateRowCoordination(
      projected,
      `execution_plans(${id},${planId}).coordination_json`,
      rowValidationRoute(routeSnapshot, state as never),
    );
    if (violations.length > 0) conflict(`plan ${planId} of workflow ${id} has malformed coordination data (${violations.map((v) => v.code).join(", ")}).`);
    // The DB representation boundary: the stored coordination JSON carries no
    // revision, because the dedicated column is the single revision authority.
    const stored = { ...projected };
    delete stored.revision;
    insertPlan.run(id, planId, ordinal, JSON.stringify(state), JSON.stringify(stored));
    insertInput.run(id, planId, JSON.stringify(executionInputSelection(row, planId)), executionInputHash(row, planId), pin === null ? null : JSON.stringify(pin));
  });
  const merge = snapshot.integration_merge_lease;
  if (merge !== undefined) {
    if (!isPlainObject(merge) || !isNonEmptyString(merge.holder) || !isNonEmptyString(merge.claimed_at) || !isNonEmptyString(merge.source_branch) || !isNonEmptyString(merge.target_branch)) conflict(`workflow ${id} has malformed integration lease fields; repair or remove that lease, then rerun store upgrade.`);
    if (coordinator === null || coordinator.session_id !== merge.holder) conflict(`workflow ${id} integration lease holder has no matching coordinator; repair or remove the lease, then rerun store upgrade.`);
  }
}
