/**
 * The workflow/ralph gate BRANCH: P-b lease attribution over the ACTIVE workflow
 * snapshot, the four-tier policy call (P-a name allowlist / P-b lease coverage /
 * P-c first-seen ask), the durable `workflow-verdict` ledger row and the mapping
 * of the verdict onto the `tools/pre-execute` refusal vocabulary.
 *
 * Module boundary: one responsibility — one `workflow`/`ralph` call's gate
 * decision. The caller (`gateDispatch`) owns tool-name dispatch ordering; this
 * module owns everything after a workflow-tool name has been matched.
 *
 * No barrel: importers name this module by explicit relative path.
 */
import { type Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { activeRowsOf, readExecutionWorkflowSource } from './workflow-selection.ts'
import type { ExecutionWorkflowSourceRead, SessionHint } from './workflow-selection.ts'
import { asRecord } from './_shared.ts'
import type { Config, SessionHintRead } from './_shared.ts'
import type { DshHostAdapter } from './adapter.ts'
import type { WorkflowVerdict } from './agent-flow.ts'
import { workflowPolicy } from './workflow-policy.ts'
import { DEFAULT_WORKFLOW_TOOLS, DISPATCH_LOGGER } from './dispatch.ts'
import { workflowGateInputOf } from './dispatch-workflow.ts'

/**
 * P-b lease attribution for the workflow/ralph gate: the calling workspace's ACTIVE
 * workflow snapshot has any plan `InProgress` LACKING matching
 * recorded scope. Iterates ALL snapshot plan rows (no
 * Assignment header exists on the workflow/ralph branch — unlike
 * `leaseGateViolations` (dispatch-lease.ts) / `worktreeL1Violations`
 * (dispatch-worktree.ts), which are Assignment-keyed) and REUSES the named
 * plumbing it imports here: `readExecutionWorkflowSource` / `activeRowsOf`
 * (workflow-selection.ts) for the active snapshot (the v3 root `plans[]` →
 * active snapshot relocation) plus the row's own `metadata.worktree_path` /
 * `metadata.working_branch` scope — an InProgress row that records no scope
 * is an uncovered row.
 *
 * Fail-open edges (the workflow branch never bricks fan-out): no harness dir
 * → nothing to attribute; missing status.json / no active lifecycle → no
 * plans to attribute; a SELECTION failure (v1/migration-required root) or a
 * THROWING read → `unreadable` (the caller emits ONE warn — a broken status
 * read must not brick fan-out, plan Clarify; P-a/P-c still run on the name
 * axis, which has no status dependency). A PARSEABLE-but-shape-invalid
 * snapshot (`plans` missing / non-array — e.g. a hand-edited `{}` or
 * `{"plans": {}}`) is `unreadable` TOO : the caller's ONE warn
 * gives it the same loudness as the throwing read, so a corrupt-but-parseable
 * snapshot cannot silently disable the P-b red line while looking like a
 * healthy read-only workspace. Fail-open is preserved in every case — P-b
 * degrades for the call, never bricks fan-out.
 *
 * @returns the first uncovered plan id (undefined = covered / nothing to
 *   attribute) + the unreadable flag.
 */
async function writableFanOutUncovered(
  harnessDir: string | null,
  hint?: SessionHint,
): Promise<{ uncoveredPlanId?: string; unreadable: boolean; workflowId?: string; workflowDir?: string; selectedGeneration?: { storeId: string; epoch: number } }> {
  if (harnessDir === null) return { unreadable: false }
  // §5 the ONE route decision precedes every read (plan S4): while the
  // execution authority is ACTIVE the root register and the workflow
  // snapshots are retired, so the plan rows come from the DB state and the
  // retired bytes are never consulted; a route that cannot be read degrades
  // exactly like an unreadable document (one warn, fail-open), never a
  // silent pass and never a file fallback.
  let source: ExecutionWorkflowSourceRead
  try {
    source = await readExecutionWorkflowSource({ harnessDir }, hint)
  } catch {
    return { unreadable: true }
  }
  if (source.kind === 'unavailable') return { unreadable: source.code !== 'store.not-initialized' }
  if (source.kind === 'error') {
    return {
      unreadable: source.selection.kind === 'error' && source.selection.code !== 'workflow.selection.no-active',
    }
  }
  if (source.kind !== 'active') return { unreadable: true }
  const rows = activeRowsOf(source.snapshot)
  for (const row of rows) {
    if (row === undefined || row.status !== 'InProgress') continue
    const planId = typeof row.id === 'string' && row.id !== '' ? row.id
      : typeof row.plan_id === 'string' && row.plan_id !== '' ? row.plan_id
      : 'in-progress-plan'
    const metadata = asRecord(row.metadata)
    const scopeRecorded =
      typeof metadata?.worktree_path === 'string' && metadata.worktree_path !== '' &&
      typeof metadata?.working_branch === 'string' && metadata.working_branch !== ''
    if (!scopeRecorded) return { uncoveredPlanId: planId, unreadable: false, workflowId: source.workflowId, workflowDir: join(harnessDir, source.dir), selectedGeneration: { storeId: source.storeId, epoch: source.epoch } }
  }
  return { unreadable: false, workflowId: source.workflowId, workflowDir: join(harnessDir, source.dir), selectedGeneration: { storeId: source.storeId, epoch: source.epoch } }
}

/**
 * The workflow/ralph gate branch. *
 * Name guard on the FIXED tool names ({@link DEFAULT_WORKFLOW_TOOLS}).
 * Non-workflow tools return undefined — the subagent branch owns them,
 * semantics unchanged.
 *
 * Mode short-circuit: `workflowGate: 'off'` → pass-through immediately, NO
 * verdict row (also precedes malformed-args handling — a malformed call
 * under `off` stays silent).
 *
 * Every other mode composes the `WorkflowGateInput` (dispatch-workflow.ts; plus the Task 3
 * P-b lease attribution: {@link writableFanOutUncovered} over the ACTIVE
 * workflow snapshot (`workflows/<id>/snapshot.json` — the v3 status.json
 * consumer; never the root v1 `plans[]`), resolved through the contained
 * resolver path)
 * and runs the policy ({@link workflowPolicy} — the SINGLE four-tier
 * decision point: P-b lease attribution + P-a name allowlist + P-c
 * first-seen ask). EVERY policy decision records ONE durable
 * `workflow-verdict` ledger row (verdict + metaName/objective +
 * mode, via the ledger plan's record path through
 * {@link DshHostAdapter.recordWorkflowVerdict}; the record is fully
 * contained and skipped when no harness dir resolved). The verdict maps to
 * the `tools/pre-execute` refusal vocabulary:
 *
 * - `allow` → undefined (delegate via `next()`; allowlisted names and ralph
 *   pass under any mode) + an `ok` verdict row.
 * - `warn` (default) → allowed WITH an advisory verdict row — the
 *   `mstar/dispatch-gate` advisory (the existing dispatch record path) +
 *   one warn (now centralized in the policy) + an
 *   `advisory` durable verdict row.
 * - `ask` → `{kind:'ask', reason}` returned WITHOUT `next()` (terminal —
 *   the registry services it through the approval waterfall; fail-closed
 *   upstream, this gate invents no answerer). P-c: first-seen names ask;
 *   resolved names (via `WorkflowAskCache.record` — workflow-policy.ts) use the cached
 *   decision, never a re-ask. The ask itself records an `ask` verdict row
 *   (pending resolution — the approval-allow outcome is observed later by
 *   the workflow-ledger consumer's run-start hook).
 * - `deny` → `{kind:'deny', reason}` WITHOUT `next()` (short-circuits the
 *   chain — the veto lands before any child starts) + a `denied` verdict
 *   row (no child ledger rows: the veto precedes start).
 *
 * Malformed args (workflow without `meta`/`meta.name`, ralph without a
 * string `objective`) → pass-through + ONE warn (fail-open, documented —
 * never crash a compliant call; under `hard` too) and NO verdict row (no
 * policy verdict was produced). NEVER throws: every read is structural.
 * @param hintReadOf - derives the carrying session's hint (once — the caller's
 *   memoized thunk) through the adapter, plus whether that session's durable
 *   binding could be read. P-b attributes the lease coverage of the BOUND
 *   lifecycle only; an unreadable binding store pauses the durable verdict row
 *   instead of attributing it to a lifecycle the session may not own. Called
 *   only after the tool-name/mode guards — the branch returns for every other
 *   tool without paying for a hint it would not read.
 */
export async function gateWorkflow(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  exec: ToolExecution,
  hintReadOf: () => SessionHintRead,
): Promise<PreToolDecision | undefined> {
  const toolName = exec.name
  if (!(DEFAULT_WORKFLOW_TOOLS as readonly string[]).includes(toolName)) return undefined
  const mode = config.workflowGate ?? 'warn'
  if (mode === 'off') return undefined
  const input = workflowGateInputOf(exec)
  if (input === undefined) {
    // Fail-open + ONE warn (plan Global Constraint — a malformed call must
    // never crash a compliant run; the warn keeps the degraded control loud).
    ctx.logger(DISPATCH_LOGGER).warn(
      `workflow gate (${toolName}) (fail-open): malformed arguments — no ${toolName === 'ralph' ? 'objective' : 'meta'} to gate on; call allowed`,
    )
    return undefined
  }
  // P-b lease attribution : the status read through the contained
  // resolver path — `harnessDir` was already resolved from the calling
  // agent's session workspace by `preExecuteListener`, and the hint scopes
  // the read to the lifecycle THIS session is bound to (an unbound session
  // has no rows to attribute: the one-warn degrade below).
  const pb = await writableFanOutUncovered(harnessDir, hintReadOf().hint)
  if (pb.unreadable) {
    // Fail-open + ONE warn (Step 3 / Clarify — a broken store read must not
    // brick fan-out): P-b is degraded for this call only; P-a/P-c (name-based,
    // no store dependency) still run below.
    // why: the read that degraded is the ACTIVE execution store source, not the
    // retired `status.json` document, and `writableFanOutUncovered` returns
    // `unreadable: false` whenever `harnessDir` is null — so this branch always
    // carries a real root and needs no null arm.
    ctx.logger(DISPATCH_LOGGER).warn(
      `workflow gate (${toolName}) (fail-open): cannot read the ACTIVE execution store under ${harnessDir} — P-b lease attribution degraded; call allowed`,
    )
  }
  const verdict = workflowPolicy(config, adapter.workflowAskCache, {
    ...input,
    ...(pb.uncoveredPlanId !== undefined ? { uncoveredPlanId: pb.uncoveredPlanId } : {}),
  })
  // — ONE durable verdict row per gated call (the ledger plan's
  // record path, routed through the adapter so this module keeps no runtime
  // agent-flow edge; the record is fully contained — a failing ledger write
  // never reaches the gate). The fail-open paths above (malformed args /
  // unreadable status) record nothing — no policy verdict was produced;
  // `off` short-circuited above. `harnessDir === null` (no workspace) skips
  // the row — the same silent no-op as the dispatch record path.
  const recordVerdict = (v: WorkflowVerdict, code?: string): void => {
    // An unreadable binding store pauses the durable row: attributing it to
    // whichever lifecycle resolves would write one session's verdict into
    // another session's ledger. The policy decision itself already happened
    // (the caller's allow/ask/deny is unaffected).
    if (harnessDir === null) return
    const hintRead = hintReadOf()
    if (hintRead.kind === 'unavailable') return
    if (pb.workflowId === undefined || pb.workflowDir === undefined || pb.selectedGeneration === undefined) return
    adapter.recordWorkflowVerdict({
      harnessDir,
      workflowId: pb.workflowId,
      exec,
      tool: input.tool,
      ...(input.metaName !== undefined ? { workflow: input.metaName } : {}),
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      mode,
      verdict: v,
      ...(code !== undefined ? { code } : {}),
      resolvedWorkflowDir: pb.workflowDir,
      selectedGeneration: pb.selectedGeneration,
    })
  }
  switch (verdict.decision) {
    case 'allow':
      recordVerdict('ok')
      return undefined
    case 'warn':
      // Advisory + ONE warn (decision now centralized in
      // the policy). The advisory reuses the existing dispatch record path
      // (the durable verdict row wiring). The violation code
      // comes from the verdict — the gate never guesses which policy fired
      // (P-a `workflow.name.unknown` vs P-b `workflow.lease.uncovered`).
      ctx.logger(DISPATCH_LOGGER).warn(
        `workflow gate (${toolName}) (advisory): ${verdict.reason}`,
      )
      ctx.emit('mstar/dispatch-gate', {
        tool: toolName,
        role: '',
        result: {
          ok: false,
          violations: [{
            ok: false,
            severity: 'medium',
            code: verdict.code,
            message: verdict.reason,
          }],
        },
        hard: false,
      })
      recordVerdict('advisory', verdict.code)
      return undefined
    case 'ask':
      // Terminal decision — the registry services it via the approval
      // waterfall (fail-closed upstream). Returned WITHOUT `next()` so no
      // downstream listener can swallow the ask. The ask itself is a gated
      // call → its verdict row carries `ask` (pending resolution).
      recordVerdict('ask', verdict.code)
      return { kind: 'ask', reason: verdict.reason }
    case 'deny':
      recordVerdict('denied', verdict.code)
      ctx.logger(DISPATCH_LOGGER).error(`workflow gate (${toolName}) vetoed: ${verdict.reason}`)
      return { kind: 'deny', reason: verdict.reason }
  }
}
