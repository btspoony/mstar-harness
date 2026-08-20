/**
 * Task 1 — probe foundation (plan `20260814-dsh-fallbacks-integration`): the
 * capability probe distinguishes mounted / unmounted / disabled fallbacks
 * (service-first, loader-entries fallback).
 *
 * Composition case (b) applies the REAL registry `dsh-llm-fallbacks` through
 * the harness real-composition boot (`bootApp` + `ctx.plugin`): its EXACT
 * service-surface assertion is the executable STOP gate for caret-range
 * drift (`^0.2.0` admits 0.2.1+ / 0.3.0 — a drifted
 * resolver fails the version/surface check HERE, not silently in
 * production).
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

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The exact service surface the plugin provides (shape STOP gate). */
const SERVICE_KEYS = ['name', 'version', 'resolveRole', 'resolveChain', 'validateFallbacksConfig', 'detectLegacyKeys', 'declareSeeds', 'getEffectiveRoles', 'revertSeededPersona'] as const

/** The resolved registry version the caret range must land on (drift STOP gate). */
const RESOLVED_VERSION = '0.2.2'

/** A live, enabled loader entry for the fallbacks row. */
const liveEntry = (): LoaderEntryView => ({ options: { name: FALLBACKS_ENTRY_NAME }, disabled: false, fiber: {} })

describe('fallbacks probe — mounted / unmounted / disabled', () => {
  it('(a) no fallbacks applied → fallbacksMounted false, service undefined', () => {
    const ctx = new Context()
    expect(fallbacksService(ctx)).toBeUndefined()
    expect(fallbacksMounted(ctx)).toBe(false)
  })

  it('(b) composition with dsh-llm-fallbacks applied → true + exact service surface', async () => {
    const app = booted = await bootApp()
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
    // Exact 9-key surface — the executable STOP gate for caret drift.
    expect(Object.keys(service!)).toEqual([...SERVICE_KEYS])
    expect(service!.name).toBe('llm-fallbacks')
    expect(typeof service!.version).toBe('string')
    expect(service!.version).toBe(RESOLVED_VERSION)
    for (const key of ['resolveRole', 'resolveChain', 'validateFallbacksConfig', 'detectLegacyKeys', 'declareSeeds', 'getEffectiveRoles', 'revertSeededPersona'] as const) {
      expect(typeof service![key]).toBe('function')
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
