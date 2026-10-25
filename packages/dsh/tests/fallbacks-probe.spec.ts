/**
 * Task 1 — probe foundation  the
 * capability probe distinguishes mounted / unmounted / disabled fallbacks
 * (service-first, loader-entries fallback).
 *
 * Composition case (b) applies the REAL registry `dsh-llm-fallbacks` through
 * the harness real-composition boot (`bootApp` + `ctx.plugin`): its consumed
 * service-surface assertion is the executable STOP gate for caret-range
 * drift — a resolver that drops or reshapes a member mstar reads fails HERE,
 * not silently in production.
 *
 * The gate is the local mirror `FallbacksServiceView`, never the installed
 * package version: a version equality reddens on every routine bump while
 * proving nothing about the members mstar calls. Pin-vs-installed drift has
 * its own home — `dshFallbacksVersion()` and the install/doctor drift rows in
 * `@mstar-harness/commands`.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import * as fallbacks from 'dsh-llm-fallbacks'
import { bootApp, FakeLoaderRegistry, type BootResult } from './harness.ts'
import {
  FALLBACKS_ENTRY_NAME,
  fallbacksMounted,
  fallbacksService,
  type LoaderEntryView,
} from '../src/gates/fallbacks-probe.ts'
import type { FallbacksServiceView } from '../src/gates/fallbacks-structural.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})


/** A live, enabled loader entry for the fallbacks row. */
const liveEntry = (): LoaderEntryView => ({ options: { name: FALLBACKS_ENTRY_NAME }, disabled: false, fiber: {} })

/**
 * Every member of the consumed surface ({@link FallbacksServiceView}) with its
 * runtime shape. The `satisfies` clause makes a mirror member added or
 * renamed without a matching row a compile error under `typecheck:tests`;
 * an ADDITIVE upstream member stays green on purpose (the view mirrors what
 * mstar consumes, not everything the plugin exposes).
 */
const SERVICE_SURFACE = {
  name: 'string',
  version: 'string',
  resolveRole: 'function',
  resolveChain: 'function',
  validateFallbacksConfig: 'function',
  detectLegacyKeys: 'function',
  declareSeeds: 'function',
  getEffectiveRoles: 'function',
  revertSeededPersona: 'function',
} as const satisfies Record<keyof FallbacksServiceView, 'string' | 'function'>

describe('fallbacks probe — mounted / unmounted / disabled', () => {
  it('(a) no fallbacks applied → fallbacksMounted false, service undefined', () => {
    const ctx = new Context()
    expect(fallbacksService(ctx)).toBeUndefined()
    expect(fallbacksMounted(ctx)).toBe(false)
  })

  it('(b) composition with dsh-llm-fallbacks applied → true + consumed service surface', async () => {
    // The plugin registers `llm-fallbacks` inside `ctx.inject(["settings"], …)` —
    // without a settings seam the plugin applies but never registers the
    // service (mounted stays false). Fake settings is the existing boot seam.
    const app = booted = await bootApp({ settingsService: 'fake' })
    // The real registry plugin applied as a row on the booted composition
    // (static import — the specifier is known at author time). The module
    // namespace's `provide` is declared `readonly` (metadata read by
    // loaders), which the cordis registry's mutable array type rejects —
    // same entry-shape cast the harness boot applies to seam rows.
    const fallbacksPlugin = fallbacks as unknown as Parameters<Context['plugin']>[0]
    await app.ctx.plugin(fallbacksPlugin)

    expect(fallbacksMounted(app.ctx)).toBe(true)
    const service = fallbacksService(app.ctx)
    expect(service).toBeDefined()
    expect(service!.name).toBe('llm-fallbacks')
    for (const [member, shape] of Object.entries(SERVICE_SURFACE)) {
      // Named per entry: a drifted member reports WHICH member, not just `false`.
      const actual = typeof (service as unknown as Record<string, unknown>)[member]
      expect(`${member}:${actual}`).toBe(`${member}:${shape}`)
    }
  })

  it('(c) loader entry present but disabled → false', () => {
    const ctx = new Context()
    const loader = new FakeLoaderRegistry(ctx)
    // A disabled entry is skipped even when a fiber is live.
    loader.entriesList = [{ options: { name: FALLBACKS_ENTRY_NAME }, disabled: true, fiber: {} }]

    expect(fallbacksService(ctx)).toBeUndefined()
    expect(fallbacksMounted(ctx)).toBe(false)
  })

  it('(d) entry + live fiber but no service (simulated older version) → true via loader fallback', () => {
    const ctx = new Context()
    const loader = new FakeLoaderRegistry(ctx)
    // A group entry with the matching name is skipped (nested groups are not
    // plugin rows); the enabled live entry decides the capability.
    loader.entriesList = [
      { options: { name: FALLBACKS_ENTRY_NAME, group: true }, disabled: false, fiber: {} },
      liveEntry(),
    ]

    expect(fallbacksService(ctx)).toBeUndefined()
    expect(fallbacksMounted(ctx)).toBe(true)
  })
})
