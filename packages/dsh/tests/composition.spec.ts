/**
 * REAL-composition tier (plan Task 2, mirrors dsh-private packages/AGENTS.md):
 * boots a test-only `cordis.yml` through the actual `@cordisjs/plugin-loader`
 * (the exact versions dsh-private vendors), mounting `@mstar-harness/dsh`
 * with only the module-import seam replaced by a modules map — entry parsing,
 * config validation, fiber mounting, and settlement are the shipping code.
 *
 * Seam limitation: at dev time the dsh seam packages are peer-stubs (no
 * runtime implementations), so this boot composes the plugin + engine only;
 * Tasks 3–5 extend the same boot with real seam packages when available.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readHarnessVersion } from '@mstar-harness/engine'
import { bootApp, INVALID_STATUS, VALID_STATUS, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

describe('@mstar-harness/dsh through a real Loader composition (cordis.yml)', () => {
  it('resolves the configured harness dir and validates a fixture status.json inside the app', async () => {
    const app = booted = await bootApp()
    const { ctx, harnessDir } = app
    const statusPath = join(harnessDir, 'status.json')
    const badStatusPath = join(harnessDir, 'bad-status.json')
    await writeFile(statusPath, JSON.stringify(VALID_STATUS))
    await writeFile(badStatusPath, JSON.stringify(INVALID_STATUS))

    // resolveHarnessDir returns the configured dir (engine fn through the service).
    expect(ctx.dshMstar.resolveHarnessDir(process.cwd(), { harnessDir })).toBe(harnessDir)

    // Fixture status.json passes validation; the malformed doc is rejected.
    expect(ctx.dshMstar.validateStatus(statusPath).ok).toBe(true)
    const rejected = ctx.dshMstar.validateStatus(badStatusPath)
    expect(rejected.ok).toBe(false)
    expect(rejected.violations.map((v) => v.code)).toContain('status.invalid-plans')
  })

  it('exposes the engine version 2.0.4 through the service and the direct import surface', async () => {
    const app = booted = await bootApp()
    const { ctx, harnessDir } = app
    const badStatusPath = join(harnessDir, 'bad-status.json')
    await writeFile(badStatusPath, JSON.stringify(INVALID_STATUS))
    expect(ctx.dshMstar.readHarnessVersion()).toBe('2.0.4')
    expect(readHarnessVersion()).toBe('2.0.4')

    // Enforcement overlay: hard + violations → hardBlocked; warn-only otherwise.
    const verdict = ctx.dshMstar.validateStatus(badStatusPath)
    const hard = ctx.dshMstar.applyEnforcement(verdict, { hard: true })
    expect(hard.hardBlocked).toBe(true)
    expect(ctx.dshMstar.applyEnforcement(verdict, { hard: false }).hardBlocked).toBe(false)
  })

  it('exposes the Task 3 gate surface (residual validation, cleanup gate, compass flag)', async () => {
    const app = booted = await bootApp()
    const { ctx, harnessDir } = app

    // validateResidual rejects a malformed entry.
    const badResidual = ctx.dshMstar.validateResidual({ id: '', severity: 'warning' })
    expect(badResidual.ok).toBe(false)
    expect(badResidual.violations.map((v) => v.code)).toContain('status.residual.invalid-id')

    // findingsCleanupGate with zero-residual flags an open nit.
    const doc = {
      ...VALID_STATUS,
      plans: [{ id: 'p1', title: 't', file: 'plans/p1.md', status: 'InProgress' }],
      residual_findings: {
        p1: [{ id: 'R1', title: 't', severity: 'nit', source: 'qc', scope: 'plan', decision: 'defer', target: 'n', tracking: null }],
      },
    }
    const cleanup = ctx.dshMstar.findingsCleanupGate(doc, 'p1', { mode: 'zero-residual' })
    expect(cleanup.ok).toBe(false)
    expect(cleanup.violations.map((v) => v.code)).toContain('findings.zero-residual-nit')

    // No compass in a bare harness dir → never hard by default.
    expect(ctx.dshMstar.resolveCompassEnforcement(harnessDir)).toEqual({ hard: false, source: 'none' })
  })
})
