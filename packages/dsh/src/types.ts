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

/** One registered plan row of the harness-state digest (id + status + completion date). */
export interface HarnessPlanView {
  readonly id: string
  readonly status: string
  /**
   * The `status.json` plan row `done_at` (trimmed string). ALWAYS-present
   * nullable scalar: a missing/empty `done_at` projects to `null` (lossless
   * JSON — never an `undefined` property; the omit pattern is reserved for
   * optional fields like `verdict?`).
   */
  readonly doneAt: string | null
}

/** One open residual finding of the harness-state digest (`planId` = the owning `residual_findings` root key). */
export interface ResidualFindingView {
  readonly planId: string
  /** The finding's `id` (e.g. `R1`); '' when the source entry carries none. */
  readonly id: string
  /** The finding's `severity` (one of the residual severity enum when known). */
  readonly severity: string
  /** The finding's `title`; '' when the source entry carries none. */
  readonly title: string
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
  /**
   * Open residual findings detail (planId + R# + severity + title), severity
   * ordered (critical→nit) and capped at 10. Null when the
   * `residual_findings` root key is missing/unreadable (advisory — same null
   * pattern as `knowledge`); `[]` when the key exists but has no open
   * entries. Independent of the `residuals` rollup (which stays
   * backward-compatible).
   */
  readonly residualFindings: readonly ResidualFindingView[] | null
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
  /**
   * Actual subagent flow evidence (the agent-flow ledger read — spec
   * §2.1.3/§2.2): the latest dispatch/settle events (≤50) plus a role ×
   * outcome summary over the same window. Null when the ledger file is
   * missing or unreadable (advisory degrade — the agent-flow line is absent
   * from the model text). Rendered text stays ~1 compact line (only when
   * `events.length > 0`); the event detail lives in this structured source
   * only. Same TTL as the rest of the state section (the catalog cache
   * refreshes the ledger read at most once per `catalogTtlMs`).
   */
  readonly agentFlow: AgentFlowView | null
}

/**
 * One agent-flow ledger event in the catalog view. Optional dispatch/settle
 * fields are OMITTED (never `undefined`-valued properties — `Session.append`
 * rejects non-lossless JSON) using the `iterationViolationView` omit pattern.
 */
export interface AgentFlowEventView {
  readonly ts: number
  readonly kind: 'dispatch' | 'settle'
  /** The session's stable id; null when the event carried none. */
  readonly agent: string | null
  /** Assignment `Execute as` ('' for settle rows — settles carry no role). */
  readonly role: string
  readonly planId: string | null
  readonly taskId: string | null
  readonly taskCategory: string | null
  /** Dispatch gate verdict (dispatch events only). */
  readonly verdict?: 'ok' | 'advisory' | 'denied'
  /** resolveDispatchHard result (dispatch events only). */
  readonly hard?: boolean
  /** Settle outcome (settle events only). */
  readonly outcome?: 'ok' | 'error' | 'denied'
  /** Settle duration in ms (settle events only, when recorded). */
  readonly durationMs?: number | null
}

/** One role × outcome count of the agent-flow summary (count desc). */
export interface AgentFlowSummaryRow {
  readonly role: string
  readonly outcome: string
  readonly count: number
}

/** The catalog's agent-flow evidence: latest events first (≤ limit) + summary. */
export interface AgentFlowView {
  readonly events: readonly AgentFlowEventView[]
  readonly summary: readonly AgentFlowSummaryRow[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mstar-engine-status': MstarEngineStatusSource
  }
}
