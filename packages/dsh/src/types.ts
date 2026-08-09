/**
 * `mstar-engine-status` catalog source: a durable `catalog`-form
 * MessageSource the plugin appends to
 * every composed step at `agent/pre-step`, so the model-visible engine-status
 * row is reconstructable from the session log without re-parsing its prose
 * (model-visible ⟺ logged — dsh packages/AGENTS.md). Merge-extensible
 * `MessageSourceMap` augmentation mirroring the `@deepseek-ai/dsh-tool-skill`
 * precedent (declare module '@deepseek-ai/dsh-llm' + catalog-form source).
 *
 * `mstar-iteration-gate` is the sibling catalog row: the boot-cached
 * `evaluatePhaseGate` verdict (tool result shape) appended after the
 * engine-status row on the same
 * pre-step listener.
 *
 * @module @mstar-harness/dsh
 */

import type { EnforcementFlag } from '@mstar-harness/engine'

/**
 * Durable provenance for the ONE unified engine-status catalog row. The
 * catalog is a `catalog`-form context, so it records the facts it published
 * beside the model-facing prose: a consumer presenting the row must not
 * re-parse the `<mstar_engine_status>` block, whose framing exists for the
 * model.
 */
export interface MstarEngineStatusSource {
  readonly kind: 'mstar-engine-status'
  readonly form: 'catalog'
  /**
   * The unified mstar version: the `@mstar-harness/dsh` plugin package
   * version (own manifest). The single-version invariant pins the bundled
   * `@mstar-harness/engine` to the same version, so one field covers both.
   */
  readonly version: string
  /** Resolved `{HARNESS_DIR}` (null when probing found none). */
  readonly harnessDir: string | null
  /** Repo-level hard-enforcement flag from the iteration compass. */
  readonly enforcement: EnforcementFlag
  /**
   * Iteration phase-gate section: present when a steering compass +
   * `status.json` resolve (the `mstar iteration gate` tool result shape).
   */
  readonly iteration?: MstarIterationGateView
  /**
   * Workspace-state digest section: the plan registry, open residual
   * counts, branch/policy anchors, active leases, knowledge index digest
   * and the steering compass direction one-liner. Null when the workspace
   * has no harness dir or no `status.json` (the state lines are absent).
   */
  readonly state: MstarHarnessState | null
}

/** JSON projection of one engine `ValidationResult` (lossless — `fix` omitted when absent). */
export interface IterationGateViolationView {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'nit'
  code: string
  message: string
  fix?: string
}

/** JSON projection of one engine gate (`GateResult`). */
export interface IterationGateListView {
  ok: boolean
  violations: IterationGateViolationView[]
}

/**
 * JSON projection of the engine `PhaseGateResult` (snake_case to match the
 * model-facing tool vocabulary of the CLI's `mstar iteration gate` — the
 * tool result shape reused verbatim by the pre-step catalog row).
 */
export interface IterationGateView {
  transition: 'phase-2-execute' | 'phase-3-close' | 'phase-4-pr-delivery'
  all_plans_done: boolean
  ok: boolean
  entry: IterationGateListView
  exit: IterationGateListView
  violations: IterationGateViolationView[]
}

/** The iteration phase-gate section of the unified engine-status row. */
export interface MstarIterationGateView {
  /** Iteration id whose steering compass was evaluated. */
  readonly iterationId: string
  /** Control-path `{HARNESS_DIR}/status.json` evaluated. */
  readonly statusPath: string
  /** The steering `{ITERATION_DIR}/<id>/delivery-compass.md` evaluated. */
  readonly compassPath: string
  /** Cached `evaluatePhaseGate` result (tool result shape). */
  readonly gate: IterationGateView
}

/** One registered plan row of the harness-state digest (id + status). */
export interface HarnessPlanView {
  readonly id: string
  readonly status: string
}

/** Open residual finding counts by severity (non-zero severities only). */
export interface HarnessResidualView {
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'nit'
  readonly count: number
}

/** One active plan execution lease of the harness-state digest. */
export interface HarnessLeaseView {
  readonly planId: string
  readonly holder: string
  readonly worktreePath: string | null
}

/**
 * The workspace-state digest section of the unified engine-status row: the
 * plan registry, open residual counts, branch/policy anchors, active
 * leases, knowledge index digest and the steering compass direction
 * one-liner. All fields come from the same per-workspace cached build as
 * the rest of the row (one status.json / compass / knowledge-index read
 * per cache refresh — the TTL-bounded staleness tradeoff documented on
 * `buildCatalogSources`).
 */
export interface MstarHarnessState {
  /** Registered plan rows (`plan_id`/`id` + `status`), status.json order. */
  readonly plans: readonly HarnessPlanView[]
  /** Open `residual_findings` counts by severity (non-zero only). */
  readonly residuals: readonly HarnessResidualView[]
  /** `metadata.iteration_base_branch` (compass frontmatter fallback), null when absent. */
  readonly iterationBaseBranch: string | null
  /** `metadata.target_branch` (compass frontmatter fallback), null when absent. */
  readonly targetBranch: string | null
  /** `metadata.spec_integration_branch`, null when absent. */
  readonly specIntegrationBranch: string | null
  /** `metadata.push_policy`, null when absent. */
  readonly pushPolicy: string | null
  /** `metadata.worktree_mode`, null when absent. */
  readonly worktreeMode: string | null
  /** `metadata.control_worktree_path`, null when absent. */
  readonly controlWorktreePath: string | null
  /** Active plan execution leases (holder + worktree). */
  readonly leases: readonly HarnessLeaseView[]
  /** Knowledge index digest (docs count + categories), null when no index. */
  readonly knowledge: { readonly docCount: number; readonly categories: readonly string[] } | null
  /** Steering compass direction one-liner (problem statement digest), null when unavailable. */
  readonly direction: string | null
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mstar-engine-status': MstarEngineStatusSource
  }
}
