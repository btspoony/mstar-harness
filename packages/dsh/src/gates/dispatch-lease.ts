/**
 * The dispatch LEASE re-verify: before any writable implement dispatch, reread
 * the ACTIVE workflow snapshot and confirm the Assignment dispatches into the
 * plan row's OWN recorded scope (`worktree_path` / `working_branch`).
 *
 * Module boundary: one responsibility — the ADDITIVE dsh-only lease checks
 * (`lease.dispatch.*` codes). It emits violations for the caller to fold into
 * one verdict; it never decides allow/deny, logs, or emits an advisory.
 *
 * No barrel: importers name this module by explicit relative path.
 */
import { assignmentHeaderRegion, executionModeToN, parseAssignmentBranchForms, parseAssignmentFields } from '@mstar-harness/engine'
import type { AssignmentSourceResult, ValidationResult } from '@mstar-harness/engine'
import { resolve } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { asRecord } from './_shared.ts'
import { activeRowsOf, readExecutionWorkflowSource } from './workflow-selection.ts'
import type { ExecutionWorkflowSourceRead, SessionHint } from './workflow-selection.ts'
import { assignmentHeaderValue, firstToken, isNaValue, planIdOf } from './dispatch-assignment.ts'

/**
 * One lease-gate violation line (dsh-side codes live in the `lease.dispatch.*`
 * namespace; the engine emits `lease.verify.*` / `lease.execution-lease.*`).
 */
function leaseViolation(code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity: 'high', code, message, fix }
}

/**
 * Lease gate — ADDITIVE beyond the opencode parity field set:
 * opencode's `validateDispatchAssignment` does NOT run lease checks at
 * dispatch, so every violation emitted here is dsh-only and clearly scoped:
 * the check fires ONLY for WRITABLE dispatches whose Assignment declares
 * `Execution mode: sdd` (engine `executionModeToN` semantics — sdd maps to
 * N=3; the function's violation path is intentionally unused so
 * `dispatch.execution-mode.*` codes stay out of the parity field set) OR
 * whose plan row is `InProgress`.
 *
 * Contract (status-and-residuals.md § Pre-dispatch re-verify; v3
 * relocation —): before any
 * writable implement dispatch, reread the ACTIVE workflow snapshot
 * (`workflows/<id>/snapshot.json` — the v1 root `plans[]` home is gone; the
 * root v2 `status.json` supplies the active `workflows[]`) and confirm the
 * session dispatches into the row's own recorded scope — `worktree_path` and
 * `working_branch` must match the Assignment; mismatch or an unrecorded scope
 * → STOP.
 *
 * Degrade-allow cases (no false positives): no harness dir, unresolvable plan
 * id, and non-SDD assignments whose plan row is absent or not InProgress.
 * Unverifiable states (unreadable/missing root status.json, a
 * selection failure — v1/migration-required root, no active workflow — an
 * unreadable/missing snapshot, plan row not registered) are violations ONLY
 * for sdd dispatches (the lease state cannot be confirmed — the status gate
 * already guards the next write); unreadable docs never harden a soft
 * workflow. A missing status.json is NOT a silent fail-open for sdd: the
 * row's recorded scope, and a missing root/snapshot cannot confirm it —
 * `lease.dispatch.unverifiable` fires (advisory in warn, deny under hard).
 * @param hint - the carrying session's selection hint: it decides WHICH
 *   active lifecycle's snapshot the lease is re-verified against, so a
 *   session that is not bound to the lifecycle holding the plan row stops
 *   with `lease.dispatch.plan-not-found` instead of verifying a lease it
 *   does not own.
 * @param source - the dispatch's ONE source resolution, exactly as the
 *   calling gate resolved it BEFORE its first asynchronous step. Passed,
 *   never re-resolved: the lease consumes the same document (or the same
 *   terminal refusal) the core validated, so a source file swapped
 *   mid-dispatch cannot split the lease verification from the decision.
 */
export async function leaseGateViolations(
  harnessDir: string | null,
  exec: ToolExecution,
  writable: boolean | undefined,
  prompt: string,
  assignmentSource: AssignmentSourceResult,
  hint?: SessionHint,
  activeSource?: ExecutionWorkflowSourceRead,
): Promise<ValidationResult[]> {
  if (harnessDir === null || writable === false) return []
  // compass D14 — the lease consumes the dispatch's ONE resolution: the
  // caller hands its already-resolved `AssignmentSourceResult`; this gate
  // NEVER reads the source itself, so a pointer and the inline form answer
  // the same row-scope questions from the SAME document the core validated.
  // A pointer the resolver refuses is the core's terminal refusal — the
  // lease adds nothing.
  if (!assignmentSource.ok) return []
  const text = assignmentSource.text
  const header = assignmentHeaderRegion(text)
  // `execution_mode` is the engine parsed field — the front matter scalar
  // key is the single declaration contract (the local label scan is gone).
  const sdd = executionModeToN(parseAssignmentFields(text).executionMode ?? '').n === 3
  const planId = planIdOf(header)
  if (planId === undefined || planId === '') return []
  let source: ExecutionWorkflowSourceRead
  try {
    // The Assignment names its plan row: that row belongs to exactly one ACTIVE
    // lifecycle, so it identifies the lifecycle even when several are active and
    // the cwd cannot discriminate (parallel worktrees under one control root).
    const selectionHint = { ...hint, planId }
    source = activeSource ?? await readExecutionWorkflowSource({ harnessDir }, selectionHint)
  } catch {
    return [leaseViolation('lease.dispatch.unverifiable', 'the ACTIVE execution workflow could not be read; STOP before writable dispatch', 'restore the ACTIVE store authority, then rerun the dispatch')]
  }
  if (source.kind !== 'active') {
    if (!sdd && source.kind === 'error' && source.selection.kind === 'error' && source.selection.code === 'workflow.selection.no-active') return []
    return [leaseViolation(
      'lease.dispatch.unverifiable',
      source.kind === 'unavailable' ? source.message : 'the ACTIVE workflow could not be selected',
      'initialize or upgrade the ACTIVE store, then register the workflow and prepare the plan before dispatch',
    )]
  }
  const row = activeRowsOf(source.snapshot).find((candidate) => candidate?.id === planId || candidate?.plan_id === planId)
  if (row === undefined) return sdd ? [leaseViolation('lease.dispatch.plan-not-found', `plan ${planId} is not registered in ACTIVE workflow ${source.workflowId}`, 'register the plan row in the workflow and run `mstar plan prepare` before writable dispatch')] : []
  if (!sdd && row.status !== 'InProgress') return []
  const metadata = asRecord(row.metadata)
  const rowWorktreePath = typeof metadata?.worktree_path === 'string' ? metadata.worktree_path : ''
  const rowWorkingBranch = typeof metadata?.working_branch === 'string' ? metadata.working_branch : ''
  const violations: ValidationResult[] = []
  if (rowWorktreePath === '' || rowWorkingBranch === '') {
    violations.push(leaseViolation('lease.dispatch.unverifiable', `plan ${planId} has no recorded worktree/branch scope in ACTIVE workflow ${source.workflowId}`, 'record the row scope through `mstar plan prepare --worktree-path <abs> --working-branch <name>` before writable dispatch'))
  } else {
    const worktree = assignmentHeaderValue(header, 'Worktree path')
    const wt = worktree === undefined ? undefined : firstToken(worktree)
    if (isNaValue(wt) || resolve(wt) !== resolve(rowWorktreePath)) violations.push(leaseViolation('lease.dispatch.worktree-mismatch', 'Assignment Worktree path does not match the ACTIVE plan row scope', 'set the absolute Worktree path to the row metadata worktree_path'))
    const forms = parseAssignmentBranchForms(header)
    const branch = forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch
    if (branch !== undefined && branch !== rowWorkingBranch) violations.push(leaseViolation('lease.dispatch.branch-mismatch', 'Assignment Working branch does not match the ACTIVE plan row scope', 'set Working branch to the row metadata working_branch'))
  }
  return violations
}
