/**
 * REAL-composition tier (, mirrors dsh-private packages/AGENTS.md):
 * boots the REAL-composition app by mounting the seam rows directly with
 * `ctx.plugin` in the dsh app's row order (harness.ts `bootApp`), applying
 * the plugin Config through the shipping schemastery validation — entry
 * semantics, config validation, fiber mounting, and settlement are cordis's
 * own `ctx.plugin` path (no `@cordisjs/plugin-loader`, no bare `cordis`).
 *
 * Seam boundary: at dev time the dsh seam packages resolve from the npm registry, so this boot
 * composes the plugin + engine + the REAL registry seams; Tasks 3–5 extend
 * the same boot with the linked seam packages.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readHarnessVersion } from '@mstar-harness/engine'
import { bootApp, INVALID_STATUS_V2, VALID_STATUS_V2, seedOpenIssue, seedStore, type BootResult } from './harness.ts'
import { ENGINE_VERSION } from './engine-version.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

describe('@mstar-harness/dsh REAL-composition boot (direct ctx.plugin rows)', () => {
  it('resolves the configured harness dir and validates a fixture status.json inside the app', async () => {
    const app = booted = await bootApp()
    const { ctx, harnessDir } = app
    const statusPath = join(harnessDir, 'status.json')
    const badStatusPath = join(harnessDir, 'bad-status.json')
    await writeFile(statusPath, JSON.stringify(VALID_STATUS_V2))
    await writeFile(badStatusPath, JSON.stringify(INVALID_STATUS_V2))

    // resolveHarnessDir returns the configured dir (engine fn through the service).
    expect(ctx.dshMstar.resolveHarnessDir(process.cwd(), { harnessDir })).toBe(harnessDir)

    // Fixture status.json passes validation; the malformed doc is rejected.
    expect(ctx.dshMstar.validateStatus(statusPath).ok).toBe(true)
    const rejected = ctx.dshMstar.validateStatus(badStatusPath)
    expect(rejected.ok).toBe(false)
    expect(rejected.violations.map((v) => v.code)).toContain('status.invalid-workflows')
  })

  it('exposes the engine version through the service and the direct import surface', async () => {
    const app = booted = await bootApp()
    const { ctx, harnessDir } = app
    const badStatusPath = join(harnessDir, 'bad-status.json')
    await writeFile(badStatusPath, JSON.stringify(INVALID_STATUS_V2))
    expect(ctx.dshMstar.readHarnessVersion()).toBe(ENGINE_VERSION)
    expect(readHarnessVersion()).toBe(ENGINE_VERSION)

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

    // findingsCleanupGate with zero-residual flags the plan's own OPEN linked
    // issue (the input is the issue store `{HARNESS_DIR}/store.db`, issue
    // contract §4 — the retired project register is not a findings authority).
    await seedStore(harnessDir)
    await seedOpenIssue(harnessDir, { title: 'cleanup fixture', severity: 'low', planId: 'p1', operationId: 'op-composition' })
    const cleanup = await ctx.dshMstar.findingsCleanupGate({ harnessDir }, 'p1', { mode: 'zero-residual' })
    expect(cleanup.ok).toBe(false)
    expect(cleanup.violations.map((v) => v.code)).toContain('findings.zero-residual-open-issue')

    // A refused authority is never an empty (passing) gate.
    await expect(ctx.dshMstar.findingsCleanupGate({ harnessDir: join(harnessDir, 'absent') }, 'p1')).rejects.toMatchObject({
      code: 'store.not-initialized',
    })

    // No compass in a bare harness dir → never hard by default.
    expect(ctx.dshMstar.resolveCompassEnforcement(harnessDir)).toEqual({ hard: false, source: 'none' })
  })
})
