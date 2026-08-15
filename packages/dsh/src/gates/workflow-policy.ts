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
 * | workflow, unknown, covered, first-seen (no cached decision) | `ask` | ask — `{kind:'ask'}` through the approval waterfall + the name is marked asked (W-1 — the run-start observation promotes only asked names to allow) |
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
 * Cache-key normalization (Task 5 fold-in — the Task-4 Important congruence
 * fix): every key — the gate's `metaName` (composed through
 * {@link normalizeWorkflowName} in dispatch.ts `workflowGateInputOf`), the
 * run-start observation's `runName` (workflow-ledger.ts), and the explicit
 * `record()` / `markAsked()` APIs (which normalize internally, F-302) — is
 * the ASCII-control-char-stripped, UNCAPPED name. One shared function, both
 * seams; a control-char name (`au\u0000dit`) gates and observes under the
 * same normalized key (`audit`), and the length is never capped on the
 * identity axis (the ledger ROW display field is capped separately — the
 * cache key stays the full name, matching the gate).
 *
 * Answer-recording seam (`WorkflowAskCache.record` + W-1 `markAsked`): the
 * gate CANNOT observe the ask outcome directly — the tool registry's
 * `serviceAsk` consumes the approval result internally (`deepseek-harness
 * packages/core/tools/src/index.ts`, `prepareExecution`/`serviceAsk`) — so
 * the ANSWER reaches the cache through the workflow-ledger consumer's
 * run-start observation (plan `20260815-dsh-workflow-gate` Task 4 fold-in —
 * the Task-2 Important handoff): an ALLOWED ask executes the call, the
 * durable `tool-workflow/run-start` session event carries the run name, and
 * the consumer records `allow` for it (`workflow-ledger.ts`). The policy
 * marks every name that received an `ask` verdict in this apply
 * (`markAsked`, at the single ask point), and the observation promotes ONLY
 * marked names to `allow` — a run observed WITHOUT a prior ask (a P-b
 * advisory under `ask` mode, a `warn`/`off`-mode run) is NOT an approval
 * resolution and never pre-authorizes the name (qc2 W-1). A DENIED answer
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

/** ASCII control characters (C0 + DEL) — stripped from workflow names (the log-forging surface, qc2 S-1). */
const WORKFLOW_NAME_CONTROL_CHARS = /[\u0000-\u001F\u007F]/g

/**
 * Strip ASCII control characters (newlines / tabs / CR — the log-forging
 * surface, qc2 S-1) from one workflow name. THE shared P-c cache-key
 * normalization (plan `20260815-dsh-workflow-gate` Task 5 fold-in — the
 * Task-4 Important congruence fix): the gate's `metaName` (composed in
 * dispatch.ts `workflowGateInputOf`) and the run-start observation's
 * `runName` (workflow-ledger.ts) MUST key the ask cache through the SAME
 * function — a raw-vs-stripped mismatch (e.g. `au\u0000dit` gating under
 * one key while the observation records another) would re-ask a resolved
 * name forever. Pure — NEVER throws. The ledger's other display fields
 * (`label` / `phase`) use the same strip; ID-sized fields (`runId` /
 * `childId`) are NOT routed here — they keep their skip-if-oversized
 * semantics.
 */
export function normalizeWorkflowName(value: string): string {
  return value.replace(WORKFLOW_NAME_CONTROL_CHARS, '')
}

/**
 * P-a allowlist membership: a workflow name is UNKNOWN when `workflowNames`
 * is absent or empty (⇒ every name unknown — documented, the gate is NOT
 * "allow all" by omission) or the name is not listed. Ralph calls carry no
 * `meta.name` — P-a never applies to them (callers guard on
 * `input.metaName !== undefined` first).
 *
 * Comparison boundary (qc1-S2): entries are normalized through
 * {@link normalizeWorkflowName} BEFORE the comparison — the gate's
 * `metaName` is already stripped, so an operator-pasted control-char
 * variant (trailing newline, copied config value) matches the same
 * identity instead of silently degrading to unknown. The operator's config
 * array is NEVER mutated — the normalization happens at the boundary only.
 */
export function workflowNameUnknown(config: Config, metaName: string): boolean {
  const names = config.workflowNames
  if (names === undefined || names.length === 0) return true
  return !names.some((entry) => normalizeWorkflowName(entry) === metaName)
}

/** One workflow name's resolved P-c decision (the cache value). */
export type WorkflowAskCacheDecision = 'allow' | 'deny'

/**
 * The P-c per-session first-seen cache: workflow name → resolved decision.
 * Apply-scoped (one instance per plugin `apply`, owned by the host adapter —
 * see the module doc for the lifecycle). Records ONLY resolved decisions; a
 * miss means first-seen (or an unanswered ask) → the policy asks again.
 *
 * W-1 (qc2 fix-wave): the cache ALSO tracks which names received an `ask`
 * verdict in this apply ({@link markAsked} — the gate marks EVERY ask
 * decision at the policy's single ask point). The run-start observation
 * (workflow-ledger.ts) records `allow` ONLY for names marked-asked — a run
 * that happened without an ask (P-b advisory under `ask` mode, a
 * `warn`/`off`-mode run) is NOT an approval resolution and must not
 * pre-authorize the name.
 *
 * F-302 (qc3 fix-wave): the WRITE seams ({@link record} / {@link markAsked})
 * normalize their keys internally — the "ONE shared normalization" contract
 * holds even for a caller that passes a raw spelling (today's production
 * callers already normalize before calling; this is defense-in-depth for the
 * documented answerer-integration seam). {@link get} stays a verbatim read —
 * the gate always passes the normalized `metaName`, and the raw spelling is
 * never stored (test 13 pins that).
 */
export class WorkflowAskCache {
  private readonly decisions = new Map<string, WorkflowAskCacheDecision>()
  /** Names that received an `ask` verdict in this apply (W-1 — the observation promotes ONLY asked names to allow). */
  private readonly asked = new Set<string>()
  // simplify: both collections are uncapped — growth is apply-scoped and only
  // via ask verdicts / resolved decisions (an unresolved first-seen re-asks
  // without inserting). Add a cap or TTL if long-lived sessions with high
  // distinct-name ask volume ever show up in profiling (qc3 F-303).

  /** The resolved decision for `name`, or undefined when never resolved. */
  get(name: string): WorkflowAskCacheDecision | undefined {
    return this.decisions.get(name)
  }

  /**
   * Record the approval-flow outcome for `name` (the ask's ANSWER — the
   * answerer integration's seam; see the module doc). Subsequent same-name
   * calls under `ask` reuse the cached decision without re-asking. The key
   * is normalized internally (F-302).
   */
  record(name: string, decision: WorkflowAskCacheDecision): void {
    this.decisions.set(normalizeWorkflowName(name), decision)
  }

  /**
   * Mark `name` as having received an `ask` verdict in this apply (W-1).
   * Called by the policy on EVERY ask decision, BEFORE the verdict is
   * returned — the run-start observation promotes only marked names to
   * `allow`. The key is normalized internally.
   */
  markAsked(name: string): void {
    this.asked.add(normalizeWorkflowName(name))
  }

  /** Whether `name` received an `ask` verdict in this apply (the observation's promote gate). Normalizes internally. */
  wasAsked(name: string): boolean {
    return this.asked.has(normalizeWorkflowName(name))
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
 * (plan `20260815-dsh-workflow-gate` Task 2). `config` + cache + composed
 * input → verdict; the caller (dispatch gate) maps the verdict to the
 * `PreToolDecision` refusal vocabulary and owns the advisory emit/log
 * infrastructure. The ONE cache write is contained: an `ask` verdict marks
 * the name via `WorkflowAskCache.markAsked` (W-1 — see the cache doc)
 * before returning; `markAsked` never throws. NEVER throws.
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
      // W-1 (qc2 fix-wave): mark the name asked BEFORE the ask verdict is
      // returned — the run-start observation promotes ONLY asked names to
      // `allow`, so a run that happens without an ask (P-b advisory under
      // ask mode, warn/off-mode runs) never pre-authorizes the name. A
      // denied/unanswered ask leaves the mark harmless: no run → no
      // observation → the next call re-asks (fail-closed preserved).
      cache.markAsked(name)
      return {
        decision: 'ask',
        code: WORKFLOW_NAME_UNKNOWN_CODE,
        reason: `workflow name "${name}" is not in the workflowNames allowlist (workflowGate: ask — first-seen; approve to allow this session, or deny to veto; the decision is cached)`,
      }
    }
  }
}
