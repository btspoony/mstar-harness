/**
 * Workflow/ralph gate policy — the P-a name allowlist + P-b lease
 * attribution + P-c first-seen ask (plan `20260815-dsh-workflow-gate`
 * Tasks 2–3, W-B3). The policy is the SINGLE
 * decision point for the four-tier `workflowGate` mode semantics
 * (`off | warn | ask | hard`, default `warn`): it turns one composed
 * {@link WorkflowGateInput} (Task 1) into `allow | warn | ask | deny` + a
 * reason. The dispatch-gate listener maps the verdict to the
 * `tools/pre-execute` refusal vocabulary (`PreToolDecision`) — this module
 * NEVER throws and NEVER builds an approval path: an `ask` verdict flows
 * through dsh's own approval waterfall (fail-closed upstream, this gate
 * invents no answerer).
 *
 * Policy matrix (mode × P-a/P-b/P-c):
 *
 * | input | mode | verdict |
 * |---|---|---|
 * | uncovered InProgress plan (P-b) | `off` | allow — the gate short-circuits `off` before the policy; kept here for a total policy |
 * | uncovered InProgress plan (P-b) | `hard` | deny — reason cites the uncovered plan id, veto before any child starts |
 * | uncovered InProgress plan (P-b) | `warn`/`ask` | warn — allowed + advisory verdict + one warn (the ask channel is for first-seen NAMES, never the workspace red line) |
 * | ralph (no `meta.name`), covered/read-only | any | allow — P-a/P-c NEVER apply to ralph (no allowlist identity); P-b applies |
 * | workflow, name ∈ `workflowNames` (non-empty list), covered | any | allow — the allowlist passes under every mode |
 * | workflow, unknown (empty/absent list ⇒ EVERY name unknown), covered | `off` | allow — the gate short-circuits `off` before the policy; kept here for a total policy |
 * | workflow, unknown, covered | `warn` | warn — advisory + one warn (Task 1 behavior, now centralized) |
 * | workflow, unknown, covered | `hard` | deny — reason names the workflow name, veto before any child starts |
 * | workflow, unknown, covered, first-seen (no cached decision) | `ask` | ask — `{kind:'ask'}` through the approval waterfall |
 * | workflow, unknown, covered, cached allow | `ask` | allow — cached decision, NO re-ask |
 * | workflow, unknown, covered, cached deny | `ask` | deny — cached decision, NO re-ask |
 *
 * P-c cache lifecycle: the {@link WorkflowAskCache} is apply-scoped — created
 * per plugin `apply` (owned by the host adapter, constructed with it) and
 * closed over by the listener; there is NO module-level Map, so disposal
 * (fiber teardown / HMR reload) makes the cache unreachable with the apply
 * and a fresh apply starts with an empty cache. The cache records only
 * RESOLVED decisions (`allow` | `deny`) keyed by workflow name.
 *
 * Answer-recording seam (`WorkflowAskCache.record`): the gate CANNOT observe
 * the ask outcome directly — the tool registry's `serviceAsk` consumes the
 * approval result internally (`deepseek-harness packages/core/tools/src/
 * index.ts`, `prepareExecution`/`serviceAsk`) — so the ANSWER reaches the
 * cache through the workflow-ledger consumer's run-start observation (plan
 * `20260815-dsh-workflow-gate` Task 4 fold-in — the Task-2 Important
 * handoff): an ALLOWED ask executes the call, the durable
 * `tool-workflow/run-start` session event carries the run name, and the
 * consumer records `allow` for it (`workflow-ledger.ts`). A DENIED answer
 * produces no run → no observation → the next same-name call re-asks
 * (fail-closed — no grant evidence, never an invented allow). The explicit
 * `record()` API stays the general seam — an answerer integration or the
 * tests may drive it directly, and an unresolved first-seen re-asks per
 * call until the observation (or an explicit record) lands.
 *
 * Module boundary: no barrel. This module imports dispatch.ts TYPE-ONLY
 * (`WorkflowGateInput` — erased at runtime, no cycle); dispatch.ts imports
 * the policy/cache values from here. The P-a vocabulary
 * (`workflowNameUnknown`, `WORKFLOW_NAME_UNKNOWN_CODE`) centralized HERE from
 * Task 1's dispatch.ts.
 */
import type { Config } from './_shared.ts'
import type { WorkflowGateInput } from './dispatch.ts'

/**
 * The workflow-gate advisory/deny violation code for a name outside the P-a
 * allowlist (warn-mode advisory / hard-mode veto reason — Task 2/3 policies
 * share this vocabulary).
 */
export const WORKFLOW_NAME_UNKNOWN_CODE = 'workflow.name.unknown'

/**
 * The workflow-gate advisory/deny violation code for P-b lease attribution
 * (Task 3): the calling workspace has an `InProgress` plan without
 * `execution_lease` coverage (warn-mode advisory / hard-mode veto reason —
 * the reason cites the uncovered plan id).
 */
export const WORKFLOW_LEASE_UNCOVERED_CODE = 'workflow.lease.uncovered'

/**
 * P-a allowlist membership: a workflow name is UNKNOWN when `workflowNames`
 * is absent or empty (⇒ every name unknown — documented, the gate is NOT
 * "allow all" by omission) or the name is not listed. Ralph calls carry no
 * `meta.name` — P-a never applies to them (callers guard on
 * `input.metaName !== undefined` first).
 */
export function workflowNameUnknown(config: Config, metaName: string): boolean {
  const names = config.workflowNames
  return names === undefined || names.length === 0 || !names.includes(metaName)
}

/** One workflow name's resolved P-c decision (the cache value). */
export type WorkflowAskCacheDecision = 'allow' | 'deny'

/**
 * The P-c per-session first-seen cache: workflow name → resolved decision.
 * Apply-scoped (one instance per plugin `apply`, owned by the host adapter —
 * see the module doc for the lifecycle). Records ONLY resolved decisions; a
 * miss means first-seen (or an unanswered ask) → the policy asks again.
 */
export class WorkflowAskCache {
  private readonly decisions = new Map<string, WorkflowAskCacheDecision>()

  /** The resolved decision for `name`, or undefined when never resolved. */
  get(name: string): WorkflowAskCacheDecision | undefined {
    return this.decisions.get(name)
  }

  /**
   * Record the approval-flow outcome for `name` (the ask's ANSWER — the
   * answerer integration's seam; see the module doc). Subsequent same-name
   * calls under `ask` reuse the cached decision without re-asking.
   */
  record(name: string, decision: WorkflowAskCacheDecision): void {
    this.decisions.set(name, decision)
  }
}

/** The four-tier policy decision vocabulary (plan W-B3, Task 2). */
export type WorkflowPolicyDecision = 'allow' | 'warn' | 'ask' | 'deny'

/**
 * One policy verdict: the decision + a human-readable reason + the violation
 * code for the warn/ask/deny vocabulary (the caller emits `code` in the
 * advisory row — the gate never guesses which policy fired).
 */
export type WorkflowPolicyVerdict =
  | { decision: 'allow'; reason?: undefined; code?: undefined }
  | { decision: 'warn' | 'ask' | 'deny'; reason: string; code: string }

/**
 * The workflow/ralph gate policy — P-a name allowlist + P-c first-seen ask
 * (plan `20260815-dsh-workflow-gate` Task 2). Pure: `config` + cache +
 * composed input → verdict; the caller (dispatch gate) maps the verdict to
 * the `PreToolDecision` refusal vocabulary and owns the advisory emit/log
 * infrastructure. NEVER throws.
 *
 * P-b: `input.uncoveredPlanId` (the dispatch gate computes it from the
 * calling workspace's status.json — see dispatch.ts `writableFanOutUncovered`)
 * → hard denies (reason cites the plan id), warn/ask emit the advisory
 * verdict; `off` always allows. Preempts P-a/P-c: an orphan InProgress plan
 * is a workspace red line independent of the workflow name.
 * P-a: `metaName ∈ workflowNames` (empty/absent list ⇒ every name unknown);
 * allowlisted → allow under ANY mode. Unknown → per-mode: `warn` → advisory
 * verdict; `hard` → deny (reason names the workflow name); `ask` → first-seen
 * `{kind:'ask'}` verdict, afterwards the cached decision (allow/deny), never
 * a re-ask for a resolved name. Ralph carries no `meta.name` — P-a/P-c never
 * apply to it (P-b applies).
 */
export function workflowPolicy(config: Config, cache: WorkflowAskCache, input: WorkflowGateInput): WorkflowPolicyVerdict {
  const mode = config.workflowGate ?? 'warn'
  // The gate short-circuits `off` before the policy — kept for a total
  // policy (a caller that skips the short-circuit still cannot block).
  if (mode === 'off') return { decision: 'allow' }
  // P-b lease attribution (Task 3) — FIRST, a workspace-level red line that
  // applies to workflow AND ralph (no `meta.name` needed): the calling
  // workspace has an `InProgress` plan without `execution_lease` coverage.
  // It preempts the name-based policies — an orphan plan means NO writable
  // fan-out should start children until the plan is recovered, regardless of
  // allowlist identity (same red line as the Assignment-keyed lease gate).
  if (input.uncoveredPlanId !== undefined) {
    if (mode === 'hard') {
      return {
        decision: 'deny',
        code: WORKFLOW_LEASE_UNCOVERED_CODE,
        reason: `workflow gate (${input.tool}) vetoed: plan "${input.uncoveredPlanId}" is InProgress without execution_lease coverage (workflowGate: hard — no writable fan-out until the plan is recovered)`,
      }
    }
    // warn / ask: allowed with an advisory verdict + one warn. The ask
    // channel is for first-seen NAMES (P-c), never a substitute for the
    // workspace red line — an uncovered workspace stays advisory-only unless
    // the deployment opts into hard.
    return {
      decision: 'warn',
      code: WORKFLOW_LEASE_UNCOVERED_CODE,
      reason: `plan "${input.uncoveredPlanId}" is InProgress without execution_lease coverage (workflowGate: warn — advisory only)`,
    }
  }
  if (input.metaName === undefined) {
    // Ralph has no allowlist identity — P-a/P-c never apply (documented);
    // P-b ran above (no uncovered plan → allow).
    return { decision: 'allow' }
  }
  const name = input.metaName
  // P-a: allowlisted names pass under every mode.
  if (!workflowNameUnknown(config, name)) return { decision: 'allow' }
  switch (mode) {
    case 'warn':
      return {
        decision: 'warn',
        code: WORKFLOW_NAME_UNKNOWN_CODE,
        reason: `workflow name "${name}" is not in the workflowNames allowlist (workflowGate: warn — advisory only)`,
      }
    case 'hard':
      return {
        decision: 'deny',
        code: WORKFLOW_NAME_UNKNOWN_CODE,
        reason: `workflow gate (${input.tool}) vetoed: workflow name "${name}" is not in the workflowNames allowlist (workflowGate: hard)`,
      }
    case 'ask': {
      const cached = cache.get(name)
      if (cached === 'allow') return { decision: 'allow' }
      if (cached === 'deny') {
        return {
          decision: 'deny',
          code: WORKFLOW_NAME_UNKNOWN_CODE,
          reason: `workflow gate (${input.tool}) vetoed: workflow name "${name}" was denied earlier in this session (workflowGate: ask — cached decision)`,
        }
      }
      // First-seen (or an unanswered ask — no resolution recorded yet):
      // route through dsh's approval waterfall (fail-closed upstream).
      return {
        decision: 'ask',
        code: WORKFLOW_NAME_UNKNOWN_CODE,
        reason: `workflow name "${name}" is not in the workflowNames allowlist (workflowGate: ask — first-seen; approve to allow this session, or deny to veto; the decision is cached)`,
      }
    }
  }
}
