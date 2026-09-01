/**
 * Local structural mirrors of the consumed `dsh-llm-fallbacks` surface
 * (plan `20260831-dsh-alpha2-optional-fallbacks` Task 2). dsh natively
 * covers subagent customization, so the fallbacks
 * plugin is an OPTIONAL capability activated by the unchanged two-command
 * install contract — and a dev-time-only dependency of this package (type
 * mirroring here + the real-package test harness). The published package
 * carries ZERO runtime AND ZERO type references to `dsh-llm-fallbacks`.
 *
 * Shapes mirror `dsh-llm-fallbacks` `dist/index.d.ts`
 * (`FallbacksService`) and `dist/seeds.d.ts` (`SeedDeclaration`,
 * `SeedSkipReason`, `SeedConflict`, `SeedDeclareOutcome`, `EffectiveRole`,
 * `EffectiveRolesReadback`). Drift gates keeping the mirrors in sync:
 *
 * - Runtime: the probe spec's exact-keys `SERVICE_KEYS` 9-tuple +
 *   `RESOLVED_VERSION` pin (`tests/fallbacks-probe.spec.ts`) fails on a
 *   drifted resolver.
 * - Compile-time: `typecheck:tests` compiles this module's consumers WITH
 *   the real package's `declare module '@deepseek-ai/cordis'` augmentation
 *   active (the tests import the package), so `fallbacksService`'s uncast
 *   `ctx.get('llm-fallbacks')` return is a real → view assignability check.
 *   The published build program never loads the augmentation — the untyped
 *   string overload applies there.
 *
 * Only the members mstar consumes carry faithful signatures
 * (`detectLegacyKeys`, `declareSeeds`, `getEffectiveRoles`); the remaining
 * service members are presence-typed function slots — the probe spec's
 * `typeof === 'function'` assertions are their executable gate.
 *
 * Module boundary: no barrel — consumers import this module by explicit
 * relative path; the entry does not re-export it.
 */

/** Mirror of upstream `SeedSkipReason` (dist/seeds.d.ts) — per-id skip reason, never coercion. */
export type SeedSkipReason = 'invalid-id' | 'reserved-id' | 'duplicate-in-batch'

/** Mirror of upstream `SeedDeclaration` (dist/seeds.d.ts) — one companion seed. */
export interface SeedDeclarationView {
  id: string
  persona: string
}

/** Mirror of upstream `SeedConflict` (dist/seeds.d.ts) — loud, non-destructive. */
export interface SeedConflictView {
  id: string
  /** Existing row persona differs from the seed default — operator override retained, never overwritten. */
  kind: 'persona-source'
}

/** Mirror of upstream `SeedDeclareOutcome` (dist/seeds.d.ts) — one `declareSeeds` result. */
export interface SeedDeclareOutcomeView {
  applied: string[]
  skipped: Array<{
    id: string
    reason: SeedSkipReason
  }>
  conflicts: SeedConflictView[]
}

/** Mirror of upstream `EffectiveRole` (dist/seeds.d.ts) — readback entry with seed annotations. */
export interface EffectiveRoleView {
  /** The config row id (raw declared form). */
  id: string
  /** Effective row persona. */
  persona: string
  /** Passthrough — never touched by seeds. */
  chain?: string[]
  /** Passthrough — never touched by seeds (mirrors upstream `FallbackStrategy`). */
  fallback?: 'inherit-root' | 'none'
  /** Id is in the live declaration set (trimmed row-id match). */
  seeded: boolean
  /** `seeded` && row persona !== current seed default. */
  personaOverridden: boolean
  /** Present iff seeded. */
  seedPersona?: string
}

/** Mirror of upstream `EffectiveRolesReadback` (dist/seeds.d.ts) — effective taxonomy with seed annotations. */
export interface EffectiveRolesReadbackView {
  roles: EffectiveRoleView[]
}

/**
 * Mirror of upstream `FallbacksService` (dist/index.d.ts) — the named
 * cordis service `ctx.get('llm-fallbacks')` exposes while the plugin is
 * applied. The 9 members are declared in the upstream order; the probe
 * spec's `SERVICE_KEYS` tuple asserts exactly this set and order at runtime.
 */
export interface FallbacksServiceView {
  /** Matches the plugin `name`. */
  name: 'llm-fallbacks'
  /** Package.json version string (module-load snapshot). */
  version: string
  /** Presence-typed (unconsumed): role resolution. */
  resolveRole: (...args: never[]) => unknown
  /** Presence-typed (unconsumed): chain resolution. */
  resolveChain: (...args: never[]) => unknown
  /** Presence-typed (unconsumed): config validation. */
  validateFallbacksConfig: (...args: never[]) => unknown
  /** Legacy config-key detector (consumed by the adoption advisory). */
  detectLegacyKeys(source: Record<string, unknown>): string[]
  /** (a) Declare the companion's FULL current seed set (replacement semantics). */
  declareSeeds(seeds: readonly SeedDeclarationView[]): Promise<SeedDeclareOutcomeView>
  /** (b) Sync readback — effective taxonomy with seed annotations. */
  getEffectiveRoles(): EffectiveRolesReadbackView
  /** Presence-typed (unconsumed): revert one id to the current seed default. */
  revertSeededPersona: (...args: never[]) => unknown
}
