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
 * Durable provenance for one engine-status catalog row. The catalog is a
 * `catalog`-form context, so it records the facts it published beside the
 * model-facing prose: a consumer presenting the row must not re-parse the
 * `<mstar_engine_status>` block, whose framing exists for the model.
 */
export interface MstarEngineStatusSource {
  readonly kind: 'mstar-engine-status'
  readonly form: 'catalog'
  /** Engine version (`@mstar-harness/engine` `readHarnessVersion`). */
  readonly engineVersion: string
  /** The `@mstar-harness/dsh` plugin package version (own manifest). */
  readonly pluginVersion: string
  /** Resolved `{HARNESS_DIR}` (null when probing found none). */
  readonly harnessDir: string | null
  /** Repo-level hard-enforcement flag from the iteration compass. */
  readonly enforcement: EnforcementFlag
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

/**
 * Durable provenance for one iteration-gate catalog row (plan
 * The gate verdict is cached at BOOT — no disk I/O on the agent-loop
 * hot path — so the row documents
 * the files it evaluated at boot, and a mid-session status/compass change
 * does not re-watermark until a config reload re-runs `apply`.
 */
export interface MstarIterationGateSource {
  readonly kind: 'mstar-iteration-gate'
  readonly form: 'catalog'
  /** Iteration id whose steering compass was evaluated at boot. */
  readonly iterationId: string
  /** Control-path `{HARNESS_DIR}/status.json` evaluated at boot. */
  readonly statusPath: string
  /** The steering `{ITERATION_DIR}/<id>/delivery-compass.md` evaluated at boot. */
  readonly compassPath: string
  /** Cached `evaluatePhaseGate` result (tool result shape). */
  readonly gate: IterationGateView
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mstar-engine-status': MstarEngineStatusSource
    'mstar-iteration-gate': MstarIterationGateSource
  }
}
