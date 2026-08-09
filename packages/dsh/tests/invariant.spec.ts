/**
 * Task 6 — invariant companion coverage (dsh packages/AGENTS.md: "Every
 * package owns `./invariant`"; the installer is a documented no-op whose
 * package-specific reason is written in src/invariant.ts — the companion's
 * contract is the registration itself: reserve the manifest name and return
 * the disposer).
 *
 * The real invariants registry service is a dev-time peer stub (no runtime),
 * so the seam is provided by a minimal Service stand-in — the same
 * self-registration mechanism the real service uses (`Service(ctx,
 * 'invariants')`).
 */
import { describe, expect, it } from 'bun:test'
import { Context, Service } from 'cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import * as invariant from '../src/invariant.ts'

/** Minimal stand-in for the invariants registry service (peer stub — no runtime). */
class FakeInvariants extends Service {
  readonly registrations: Array<{ packageName: string; installer: InvariantInstaller }> = []
  /** Plain field, not `#`-private: cordis proxies service instances and private fields are unreachable through the proxy. */
  disposed = false

  constructor(ctx: Context) {
    super(ctx, 'invariants')
  }

  register(packageName: string, installer: InvariantInstaller): () => void {
    this.registrations.push({ packageName, installer })
    return () => { this.disposed = true }
  }
}

describe('@mstar-harness/dsh invariant companion', () => {
  it('exposes the companion plugin contract (name/inject/apply, no default export)', () => {
    expect(invariant.name).toBe('dsh-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(typeof invariant.apply).toBe('function')
    expect('default' in invariant).toBe(false)
  })

  it('reserves package ownership with the documented no-op installer and returns the disposer', async () => {
    const ctx = new Context()
    try {
      const registry = new FakeInvariants(ctx)

      const disposer = await invariant.apply(ctx)

      expect(registry.registrations).toHaveLength(1)
      expect(registry.registrations[0]!.packageName).toBe('@mstar-harness/dsh')
      // The installer is the documented no-op — the package's contributions
      // (gate listeners, service) are asserted by the composition and
      // HMR-safety suites, not by an invariant over mutable state.
      const installer = registry.registrations[0]!.installer
      expect(installer(ctx, () => { throw new Error('installer must not fail') })).toBeUndefined()

      disposer()
      expect(registry.disposed).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
