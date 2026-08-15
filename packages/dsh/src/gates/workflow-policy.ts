/**
 * Workflow/ralph gate policy — the P-a name allowlist + P-c first-seen ask
 * (plan `20260815-dsh-workflow-gate` Task 2, W-B3). The policy is the SINGLE
 * decision point for the four-tier `workflowGate` mode semantics
 * (`off | warn | ask | hard`, default `warn`): it turns one composed
 * {@link WorkflowGateInput} (Task 1) into `allow | warn | ask | deny` + a
 * reason. The dispatch-gate listener maps the verdict to the
 * `tools/pre-execute` refusal vocabulary (`PreToolDecision`) — this module
 * NEVER throws and NEVER builds an approval path: an `ask` verdict flows
 * through dsh's own approval waterfall (fail-closed upstream, this gate
 * invents no answerer).
 *
 * Policy matrix (mode × P-a/P-c):
 *
 * | input | mode | verdict |
 * |---|---|---|
 * | ralph (no `meta.name`) | any | allow — P-a/P-c NEVER apply to ralph (no allowlist identity; P-b arrives in Task 3) |
 * | workflow, name ∈ `workflowNames` (non-empty list) | any | allow — the allowlist passes under every mode |
 * | workflow, unknown (empty/absent list ⇒ EVERY name unknown) | `off` | allow — the gate short-circuits `off` before the policy; kept here for a total policy |
 * | workflow, unknown | `warn` | warn — advisory + one warn (Task 1 behavior, now centralized) |
 * | workflow, unknown | `hard` | deny — reason names the workflow name, veto before any child starts |
 * | workflow, unknown, first-seen (no cached decision) | `ask` | ask — `{kind:'ask'}` through the approval waterfall |
 * | workflow, unknown, cached allow | `ask` | allow — cached decision, NO re-ask |
 * | workflow, unknown, cached deny | `ask` | deny — cached decision, NO re-ask |
 *
 * P-c cache lifecycle: the {@link WorkflowAskCache} is apply-scoped — created
 * per plugin `apply` (owned by the host adapter, constructed with it) and
 * closed over by the listener; there is NO module-level Map, so disposal
 * (fiber teardown / HMR reload) makes the cache unreachable with the apply
 * and a fresh apply starts with an empty cache. The cache records only
 * RESOLVED decisions (`allow` | `deny`) keyed by workflow name.
 *
 * Answer-recording seam (`WorkflowAskCache.record`): the gate CANNOT observe
 * the ask outcome — the tool registry's `serviceAsk` consumes the approval
 * result internally (`deepseek-harness packages/core/tools/src/index.ts`,
 * `prepareExecution`/`serviceAsk`) — so the ANSWER reaches the cache through
 * the explicit `record()` API (the approval owner / answerer integration
 * calls it; the tests drive it to simulate the answerer). An ask whose
 * answer is never recorded leaves no cache entry: the next same-name call
 * asks again (fail-closed — no grant evidence, never an invented allow).
 * simplify: no approval-outcome observer yet; a deployment wiring a
 * persistent answerer must call `record(name, decision)` (or a future
 * session-event observer) for cross-call caching — until then an unanswered
 * first-seen re-asks per call.
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

/** One policy verdict: the decision + a human-readable reason. */
export type WorkflowPolicyVerdict =
  | { decision: 'allow'; reason?: undefined }
  | { decision: 'warn' | 'ask' | 'deny'; reason: string }

/**
 * The workflow/ralph gate policy — P-a name allowlist + P-c first-seen ask
 * (plan `20260815-dsh-workflow-gate` Task 2). Pure: `config` + cache +
 * composed input → verdict; the caller (dispatch gate) maps the verdict to
 * the `PreToolDecision` refusal vocabulary and owns the advisory emit/log
 * infrastructure. NEVER throws.
 *
 * P-a: `metaName ∈ workflowNames` (empty/absent list ⇒ every name unknown);
 * allowlisted → allow under ANY mode. Unknown → per-mode: `warn` → advisory
 * verdict; `hard` → deny (reason names the workflow name); `ask` → first-seen
 * `{kind:'ask'}` verdict, afterwards the cached decision (allow/deny), never
 * a re-ask for a resolved name. Ralph carries no `meta.name` — P-a/P-c never
 * apply to it (allow; P-b is Task 3).
 */
export function workflowPolicy(config: Config, cache: WorkflowAskCache, input: WorkflowGateInput): WorkflowPolicyVerdict {
  const mode = config.workflowGate ?? 'warn'
  if (input.metaName === undefined) {
    // Ralph has no allowlist identity — P-a/P-c never apply (documented;
    // P-b lease attribution for ralph lands in Task 3).
    return { decision: 'allow' }
  }
  const name = input.metaName
  // P-a: allowlisted names pass under every mode.
  if (!workflowNameUnknown(config, name)) return { decision: 'allow' }
  switch (mode) {
    // The gate short-circuits `off` before the policy — kept for a total
    // policy (a caller that skips the short-circuit still cannot block).
    case 'off':
      return { decision: 'allow' }
    case 'warn':
      return {
        decision: 'warn',
        reason: `workflow name "${name}" is not in the workflowNames allowlist (workflowGate: warn — advisory only)`,
      }
    case 'hard':
      return {
        decision: 'deny',
        reason: `workflow gate (${input.tool}) vetoed: workflow name "${name}" is not in the workflowNames allowlist (workflowGate: hard)`,
      }
    case 'ask': {
      const cached = cache.get(name)
      if (cached === 'allow') return { decision: 'allow' }
      if (cached === 'deny') {
        return {
          decision: 'deny',
          reason: `workflow gate (${input.tool}) vetoed: workflow name "${name}" was denied earlier in this session (workflowGate: ask — cached decision)`,
        }
      }
      // First-seen (or an unanswered ask — no resolution recorded yet):
      // route through dsh's approval waterfall (fail-closed upstream).
      return {
        decision: 'ask',
        reason: `workflow name "${name}" is not in the workflowNames allowlist (workflowGate: ask — first-seen; approve to allow this session, or deny to veto; the decision is cached)`,
      }
    }
  }
}
