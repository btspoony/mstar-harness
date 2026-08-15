import { describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import { ENGINE_VERSION } from './engine-version.ts'

describe('@mstar-harness/dsh function-plugin contract', () => {
  it('exposes named exports name/inject/Config/apply with no default export', () => {
    expect(plugin.name).toBe('dsh')
    expect(Array.isArray(plugin.inject)).toBe(true)
    expect(plugin.Config).toBeDefined()
    expect(typeof plugin.apply).toBe('function')
    expect('default' in plugin).toBe(false)
  })

  it('apply provides the ctx.dshMstar engine service on a real registrant context', async () => {
    const ctx = new Context()
    try {
      plugin.apply(ctx, {})
      expect(ctx.dshMstar).toBeDefined()
      // The service is engine-backed: the single-version invariant holds.
      expect(ctx.dshMstar.readHarnessVersion()).toBe(ENGINE_VERSION)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
