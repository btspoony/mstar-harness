/**
 * The workflow/ralph gate INPUT: the structural reads of one `workflow`/`ralph`
 * tool call (`meta.name` for workflow, `objective` for ralph) that the policy
 * decides on.
 *
 * Module boundary: one responsibility — compose the {@link WorkflowGateInput}
 * (or undefined for malformed args) from a tool call. It runs no policy, reads
 * no status and makes no decision; the workflow branch owns those.
 *
 * No barrel: importers name this module by explicit relative path.
 */
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { asRecord } from './_shared.ts'
import { normalizeWorkflowName } from './workflow-policy.ts'

/**
 * The workflow-gate input composed from one `workflow`/`ralph` tool call
 * : the tool name + the structural reads of
 * `meta` (workflow) / `objective` (ralph) + the in-flight call.
 */
export interface WorkflowGateInput {
  /** The matched tool name (`'workflow'` | `'ralph'` — the gate name-guards on `DEFAULT_WORKFLOW_TOOLS` (dispatch.ts) first). */
  tool: 'workflow' | 'ralph'
  /** `meta.name` for workflow calls — the P-a allowlist input; absent for ralph (no meta). */
  metaName?: string
  /** `objective` for ralph calls (objective-based ledger logging, P-b); absent for workflow. */
  objective?: string
  /** The in-flight tool call — Task 3 P-b lease attribution reads the calling agent/session off it. */
  exec: ToolExecution
  /**
   * P-b lease attribution: the calling workspace's first
   * `InProgress` plan lacking a recorded row scope (computed by
   * `writableFanOutUncovered` in dispatch-workflow-branch.ts from the
   * status.json read through the contained resolver path — `preExecuteListener` already resolved the
   * harness dir from the calling agent's session workspace). Undefined → no
   * uncovered plan (allow axis). Applies to workflow AND ralph (P-b needs no
   * `meta.name`).
   */
  uncoveredPlanId?: string
}

/**
 * Compose the {@link WorkflowGateInput} from one workflow/ralph tool call's
 * arguments — structural reads, NEVER throws (plan
 *   Task 1; args shapes architect-verified:
 * workflow `{ script, meta: { name, description, whenToUse?, phases? },
 * args? }` (`tool-workflow/src/index.ts:152-161`); ralph
 * `{ objective, maxRounds?, maxHandoffChars? }`
 * (`tool-ralph/src/index.ts:76,416-419`)). Returns undefined for malformed
 * args — workflow without a non-empty string `meta.name`, ralph without a
 * string `objective` — the fail-open + one-warn path.
 *
 * `meta.name` is NORMALIZED through {@link normalizeWorkflowName} (control
 * chars stripped) BEFORE the empty check — the P-c cache-key congruence
 * fold-in: the run-start observation (workflow-ledger.ts)
 * keys the ask cache with the SAME normalized name, so a control-char name
 * (`au\u0000dit`) asks once and observes under one key instead of re-asking
 * forever. The length is NEVER capped here (the gate's identity axis is
 * uncapped — the ledger ROW display field is capped separately). A name
 * that is ONLY control characters normalizes to '' → malformed (fail-open),
 * matching the ledger's read boundary.
 */
export function workflowGateInputOf(exec: ToolExecution): WorkflowGateInput | undefined {
  const args = asRecord(exec.arguments)
  if (args === undefined) return undefined
  if (exec.name === 'ralph') {
    const objective = typeof args.objective === 'string' ? args.objective : undefined
    if (objective === undefined) return undefined
    return { tool: exec.name, objective, exec }
  }
  if (exec.name === 'workflow') {
    const meta = asRecord(args.meta)
    const metaName = typeof meta?.name === 'string' ? normalizeWorkflowName(meta.name) : undefined
    if (meta === undefined || metaName === undefined || metaName === '') return undefined
    return { tool: exec.name, metaName, exec }
  }
  return undefined
}
