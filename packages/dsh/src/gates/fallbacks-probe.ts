/**
 * Capability probes for the OPTIONAL `dsh-llm-fallbacks` plugin (plan
 * `20260814-dsh-fallbacks-integration` Task 1 — probe foundation).
 *
 * The fallbacks plugin is an optional SEPARATE install (two-command
 * contract) and a dev-time-only dependency of this package: src carries
 * ZERO imports of it (runtime and type) — the consumed service surface is
 * the local structural mirror in `fallbacks-structural.ts`, so `dist/`
 * carries zero runtime AND zero type references to `dsh-llm-fallbacks`.
 * When the dev dependency is installed, the package's
 * `declare module '@deepseek-ai/cordis'` augmentation types
 * `ctx.get('llm-fallbacks')` for importers — under `typecheck:tests` the
 * uncast return in {@link fallbacksService} is the compile-time real →
 * view assignability gate (the published build never loads the
 * augmentation; the untyped string overload applies there).
 *
 * Two views:
 * - {@link fallbacksService} — the named cordis service while the plugin is
 *   applied. Registration is per-apply, so the service is `undefined` during
 *   HMR/fiber-swap windows even when the loader entry lives (the entry is
 *   declarative and outlives a fiber swap).
 * - {@link fallbacksMounted} — capability view, service-first with a
 *   loader-entries fallback: the loader entry is present, enabled, and has a
 *   live fiber. Point-in-time read (no cache) — loader mounts entries
 *   concurrently (plugin-inventory philosophy).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FallbacksServiceView } from './fallbacks-structural.ts'

/** Loader entry name of the `dsh-llm-fallbacks` plugin row. */
export const FALLBACKS_ENTRY_NAME = 'dsh-llm-fallbacks'

/**
 * Minimal structural view of one cordis loader `Entry` the probe reads
 * (`@deepseek-ai/cordis-plugin-loader` `Entry`/`EntryOptions` contract — the
 * plugin carries no loader dependency; this is the consumed surface, same
 * pattern as the optional `jobs` seam in agent-flow.ts).
 */
export interface LoaderEntryView {
  options: {
    name: string
    group?: boolean | null
    /**
     * Deployment row config (`EntryOptions.config` — "Config passed to the
     * plugin", the same value the plugin's `apply()` receives; architect-
     * verified field 2026-08-15). ABSENT when the user never configured the
     * row — the adoption advisory treats that as an unreadable config.
     */
    config?: unknown
  }
  disabled: boolean
  fiber: unknown
}

/** Minimal structural view of the cordis `loader` service (`ctx.loader.entries()`). */
interface LoaderView {
  entries(): Iterable<LoaderEntryView>
}

/** Service view: the named `llm-fallbacks` cordis service while applied. */
export function fallbacksService(ctx: Context): FallbacksServiceView | undefined {
  // Uncast on purpose: with the dev dependency installed, the package's
  // cordis augmentation types this `get` as the REAL `FallbacksService` —
  // the return is then a compile-time real → view assignability gate under
  // `typecheck:tests`. Without it (published build) the untyped string
  // overload returns `any`.
  return ctx.get('llm-fallbacks')
}

/**
 * The fallbacks loader row when present and enabled (group rows skipped).
 * Unlike {@link fallbacksMounted}, NO live-fiber requirement: the entry is
 * declarative and `options.config` is set at entry creation, so the adoption
 * advisory (plan `20260815-dsh-fallbacks-personas` Task 4) can read the
 * deployment's row config even during HMR/fiber-swap windows — the advisory
 * caller gates on `fallbacksMounted` first.
 */
export function fallbacksEntry(ctx: Context): LoaderEntryView | undefined {
  // `ctx.get('loader')` is the untyped string overload — narrowed onto the
  // consumed structural surface (no loader-plugin dependency).
  const loader = ctx.get('loader') as LoaderView | undefined
  if (loader === undefined) return undefined
  for (const entry of loader.entries()) {
    if (entry.options.name !== FALLBACKS_ENTRY_NAME) continue
    if (entry.options.group) continue
    if (entry.disabled) continue
    return entry
  }
  return undefined
}

/**
 * Capability view: `true` when the fallbacks capability is mounted — the
 * service is applied, or (service absent: HMR/fiber-swap window, older
 * version, not yet applied) the loader entry is present, enabled, and its
 * fiber is live.
 */
export function fallbacksMounted(ctx: Context): boolean {
  if (fallbacksService(ctx) !== undefined) return true
  const entry = fallbacksEntry(ctx)
  if (entry === undefined) return false
  return entry.fiber !== undefined
}
