import { executionInputHash, executionInputSelection, type CatalogExecutionPin } from "./coordination.js";
import { isNonEmptyString, isPlainObject } from "./coordination-write.js";
import { storedCoordinationViolations } from "./coordination-transitions.js";
import { ExecutionError, type ExecutionTransaction } from "./execution-store.js";
import { validatePlanRow, type WorkflowEntry } from "./status.js";
import { rowValidationRoute, validateWorkflowSnapshot, type WorkflowSnapshot } from "./workflow.js";

export type ImportedSessionBinding = { session_id: string; session_file: string; bound_at: string };
export type ImportedPlan = {
  id: string;
  row: Record<string, unknown>;
  session: ImportedSessionBinding | null;
  lease: Record<string, unknown> | null;
  pin: CatalogExecutionPin | null;
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

function insertSession(tx: ExecutionTransaction, workflowId: string, role: "coordinator" | "plan-pm", planId: string | null, value: ImportedSessionBinding): void {
  // §2.2 stopped-workspace import: imported sessions are HISTORICAL facts —
  // a snapshot proves past binding, never current liveness — so they import
  // suspended. Continuation goes through public `plan bind` with a fresh
  // identity (no lease row is imported, so nothing blocks the fresh claim).
  tx.db.prepare("insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) values (?, ?, ?, ?, ?, 1, 'suspended', ?)")
    .run(workflowId, role, value.session_id, planId, tx.epoch, value.bound_at);
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
  if (snapshot.coordination?.self_amendments !== undefined) {
    header.self_amendments = snapshot.coordination.self_amendments;
  }
  tx.db.prepare("insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) values (?, 1, ?, ?, ?, ?)")
    .run(id, coordinator?.session_id ?? null, JSON.stringify(header), snapshot.started_at, snapshot.updated_at);
  if (entry !== null) tx.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)").run(id, JSON.stringify(entry));
  if (coordinator !== null) insertSession(tx, id, "coordinator", null, coordinator);
  const insertPlan = tx.db.prepare("insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, ?, ?, ?)");
  const insertInput = tx.db.prepare("insert into execution_inputs(workflow_id, plan_id, revision, input_json, input_hash, catalog_pin_json) values (?, ?, 1, ?, ?, ?)");
  const routeSnapshot = { ...(snapshot as unknown as WorkflowSnapshot), plans: plans.map((plan) => ({ id: plan.id })) } as WorkflowSnapshot;
  plans.forEach(({ id: planId, row, session, lease, pin }, ordinal) => {
    const state: Record<string, unknown> = { ...row, id: planId };
    if (lease !== null && state.status === "InProgress") state.status = "Blocked";
    delete state.coordination;
    delete state.execution_lease;
    const stateGate = validatePlanRow(state);
    const block: Record<string, unknown> = isPlainObject(row.coordination) ? { ...row.coordination } : {};
    delete block.revision;
    delete block.session;
    const violations = storedCoordinationViolations(block, {
      revision: 1,
      route: rowValidationRoute(routeSnapshot, state as never),
      submitterAssociated: !isPlainObject(block.handoff) || (
        typeof block.handoff.submitted_by === "string" &&
        session !== null && session.session_id === block.handoff.submitted_by
      ),
      activeSessionBound: session !== null,
      what: `execution_plans(${id},${planId}).coordination_json`,
    });
    if (violations.length > 0) conflict(`plan ${planId} of workflow ${id} has malformed coordination data (${violations.map((v) => v.code).join(", ")}).`);
    insertPlan.run(id, planId, ordinal, JSON.stringify(state), JSON.stringify(block));
    insertInput.run(id, planId, JSON.stringify(executionInputSelection(row, planId)), executionInputHash(row, planId), pin === null ? null : JSON.stringify(pin));
    if (session !== null) insertSession(tx, id, "plan-pm", planId, session);
  });
  const merge = snapshot.integration_merge_lease;
  if (merge !== undefined) {
    if (!isPlainObject(merge) || !isNonEmptyString(merge.holder) || !isNonEmptyString(merge.claimed_at) || !isNonEmptyString(merge.source_branch) || !isNonEmptyString(merge.target_branch)) conflict(`workflow ${id} has malformed integration lease fields; repair or remove that lease, then rerun store upgrade.`);
    if (coordinator === null || coordinator.session_id !== merge.holder) conflict(`workflow ${id} integration lease holder has no matching coordinator; repair or remove the lease, then rerun store upgrade.`);
  }
}
