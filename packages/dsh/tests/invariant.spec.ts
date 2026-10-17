/**
 * Task 6 — invariant companion coverage. The companion is a documented no-op
 * (its package-specific reason is in src/invariant.ts): dsh 0.2.1-alpha.1
 * removed `@deepseek-ai/dsh-invariants` together with the `ctx.invariants`
 * service, so there is no registry to register into. What remains is the
 * contract the published `@mstar-harness/dsh/invariant` entry must keep: a
 * loadable plugin — `name` + `apply` returning a disposer — that requires no
 * host service, so a profile row naming it still activates.
 */
import { describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import * as invariant from '../src/invariant.ts'

describe('@mstar-harness/dsh invariant companion', () => {
  it('exposes the companion plugin contract (name/apply, no default export)', () => {
    expect(invariant.name).toBe('dsh-invariant')
    expect(typeof invariant.apply).toBe('function')
    expect('default' in invariant).toBe(false)
  })

  it('activates without any host service and returns the disposer', async () => {
    const ctx = new Context()
    try {
      const disposer = invariant.apply(ctx)

      expect(typeof disposer).toBe('function')
      disposer()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
