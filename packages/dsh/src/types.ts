/**
 * `mstar-engine-status` catalog source (plan 20260808-dsh-host-adapter
 * Task 5): a durable `catalog`-form MessageSource the plugin appends to
 * every composed step at `agent/pre-step`, so the model-visible engine-status
 * row is reconstructable from the session log without re-parsing its prose
 * (model-visible ⟺ logged — dsh packages/AGENTS.md). Merge-extensible
 * `MessageSourceMap` augmentation mirroring the `@deepseek-ai/dsh-tool-skill`
 * precedent (declare module '@deepseek-ai/dsh-llm' + catalog-form source).
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

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mstar-engine-status': MstarEngineStatusSource
  }
}
