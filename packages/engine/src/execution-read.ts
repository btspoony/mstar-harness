/**
 * execution-read.ts — the single authoritative READ adapter of the execution
 * domain (primary spec §5, task S2).
 *
 * `readExecutionAuthority` is the ONE source read adapter: a caller that needs
 * execution state addresses the exact workflow/plan it wants and receives the
 * typed DTO of that read — never a fake `WorkflowSnapshot` with a
 * `session_file` path, never a dashboard projection, and never leftover JSON.
 *
 * Selection semantics (§5, verbatim):
 *
 * - no selection            → the whole state and the **registry/root** token;
 * - `{workflowId}`          → that workflow's scope and its **workflow** token;
 * - `{planId, workflowId}`  → that plan's **view** and its **plan** token. A
 *   `planId` without its `workflowId` is refused: the plan address is
 *   `(workflow, plan)` everywhere in this authority (§3.1's plan key is
 *   `[workflowId,planId]`), so a lone plan id could only be resolved by
 *   guessing a parent — which this adapter never does.
 *
 * The root token covers registry MEMBERSHIP, not every child: the child CAS a
 * caller stores back travels in the state's `workflowToken`/`planTokens` (§5),
 * which is exactly what a scoped selection returns as its envelope token.
 *
 * Read shape. One read transaction serves the entire selection (the same
 * `readExecutionState` primitive every other state read uses — no second
 * transaction, no second authority): the metadata and epoch are re-read INSIDE
 * that transaction, so the data, the token and the store identity always
 * describe one committed snapshot. A missing store, an execution schema that
 * predates migration 4, a `legacy`/`staged` authority, a corrupt, drifted or
 * busy store and an unsupported runtime are all refusals — never an empty
 * success and never a fallback to files, projections or newest-workflow
 * guessing (§2.1/§5).
 *
 * Scope of the scoped read. The returned state carries the root register AS
 * READ — registry membership is the root's own content and the root token
 * covers it — while the materialized `workflows` hold exactly the selected
 * lifecycle. Trimming the register here would mean serving a synthesized root
 * document, which a correctness consumer must never mistake for the stored one.
 *
 * This module is deliberately small: it selects over one read; it does not
 * assemble a second graph, validate stored rows or mint tokens. Those stay in
 * `execution-store.ts`, so a stored-row rule can never drift between the two.
 */
import { CoordinationError, isNonEmptyString } from "./coordination-write.js";
import {
  readExecutionState,
  type ExecutionPlanView,
  type ExecutionRead,
  type ExecutionState,
} from "./execution-store.js";
import type { StoreContext } from "./store-db.js";

/**
 * §5 the explicit address of one authoritative read. `planId` is only valid
 * with its `workflowId`; anything else is a malformed address, not a wider
 * selection.
 */
export type ExecutionReadSelection = { workflowId?: string; planId?: string };

function invalidSelection(detail: string): CoordinationError {
  return new CoordinationError("coordination.invalid-input", detail);
}

/**
 * The one accepted shape of a read address. Pure argument checks — no store is
 * opened — so a malformed address is refused by itself, before any route,
 * authority-state or store-open verdict can mask it.
 */
export function assertExecutionSelection(selection: ExecutionReadSelection | undefined): ExecutionReadSelection {
  const candidate = selection ?? {};
  const { workflowId, planId } = candidate;
  if (workflowId !== undefined && !isNonEmptyString(workflowId)) {
    throw invalidSelection(
      `a read selection names the workflow it addresses with a non-empty id — got ${JSON.stringify(workflowId)}`,
    );
  }
  if (planId !== undefined && !isNonEmptyString(planId)) {
    throw invalidSelection(`a read selection names the plan it addresses with a non-empty id — got ${JSON.stringify(planId)}`);
  }
  if (planId !== undefined && workflowId === undefined) {
    throw invalidSelection(
      "a plan read addresses (workflowId, planId): pass the workflow that owns the plan — a lone plan id would have " +
        "to be resolved by guessing its parent, which this authority never does.",
    );
  }
  return workflowId === undefined ? {} : planId === undefined ? { workflowId } : { workflowId, planId };
}

/**
 * §5 the single source read adapter. The selection is exact (an id that is not
 * a registered lifecycle, or not a plan of the addressed workflow, refuses
 * `coordination.workflow-not-found` / `coordination.plan-not-found` — the
 * active route's own vocabulary) and it is served by ONE read transaction over
 * the committed store.
 */
export async function readExecutionAuthority(
  context: StoreContext,
  selection: ExecutionReadSelection = {},
): Promise<ExecutionRead<ExecutionState | ExecutionPlanView>> {
  const addressed = assertExecutionSelection(selection);
  const state = await readExecutionState(context);
  if (addressed.workflowId === undefined) return state;

  const workflow = state.data.workflows.find((candidate) => candidate.state.id === addressed.workflowId);
  if (workflow === undefined) {
    throw new CoordinationError(
      "coordination.workflow-not-found",
      `the execution registry holds no ACTIVE lifecycle ${JSON.stringify(addressed.workflowId)}; the read names an ` +
        `exact workflow and never falls back to the newest/only entry. Read the registry with no selection to see ` +
        `the workflows this authority actually holds.`,
      { workflow_id: addressed.workflowId },
    );
  }
  if (addressed.planId === undefined) {
    return {
      data: { root: state.data.root, workflows: [workflow] },
      token: workflow.workflowToken,
      storeId: state.storeId,
      epoch: state.epoch,
    };
  }

  const view = workflow.plans.find((candidate) => candidate.plan.id === addressed.planId);
  const token = workflow.planTokens[addressed.planId];
  if (view === undefined || token === undefined) {
    throw new CoordinationError(
      "coordination.plan-not-found",
      `workflow ${JSON.stringify(addressed.workflowId)} holds no plan ${JSON.stringify(addressed.planId)}`,
      { workflow_id: addressed.workflowId, plan_id: addressed.planId },
    );
  }
  return { data: view, token, storeId: state.storeId, epoch: state.epoch };
}
