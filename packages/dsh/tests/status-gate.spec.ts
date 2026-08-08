/**
 * Task 3 — status hard gate: `fs/write-intent` + `fs/edit-intent` on
 * `{HARNESS_DIR}/status.json` (plan 20260808-dsh-package-core).
 *
 * Harness approach: the real dsh seam packages are dev-time peer-stubs (no
 * runtime), so the waterfalls are simulated with a minimal typed harness —
 * the same `ctx.waterfall('fs/write-intent', target, exec, () => undefined)`
 * dispatch the real `@deepseek-ai/dsh-tool-fs` write/edit tools perform
 * (tool-fs README, dsh-private 9451be2). The gate reads the CURRENT on-disk
 * document at intent time (the waterfall carries no incoming content), so
 * seeds are written before each dispatch.
 *
 * Contract notes (full detail in task-3-report.md):
 * - Veto = throw in the listener (the fs intent slot has no deny shape);
 *   the throw rejects the waterfall → the tool call fails.
 * - Warn mode (default): log + advisory emit + `next()` delegation (allow).
 * - The dsh `agent/status` event is lifecycle-only (idle ⇄ running, no-op
 *   invariant) — the advisory emit lands on the plugin-owned
 *   `mstar/status-gate` event instead.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { join } from 'node:path'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { bootApp, INVALID_STATUS, VALID_STATUS, seedHarness, type BootResult } from './harness.ts'
import { StatusGateError, type StatusGateAdvisory } from '../src/index.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** FsTarget for `{HARNESS_DIR}/status.json` (local-backend shape). */
const statusTarget = (harnessDir: string): FsTarget => ({
  targetKey: join(harnessDir, 'status.json') as FsTarget['targetKey'],
  displayPath: join(harnessDir, 'status.json'),
})

/** FsTarget for a non-harness file. */
const otherTarget = (harnessDir: string): FsTarget => ({
  targetKey: join(harnessDir, 'other.json') as FsTarget['targetKey'],
  displayPath: join(harnessDir, 'other.json'),
})

/** Collect advisory emits on the app context. */
function captureAdvisories(ctx: BootResult['ctx']): StatusGateAdvisory[] {
  const advisories: StatusGateAdvisory[] = []
  ctx.on('mstar/status-gate', (payload) => { advisories.push(payload) })
  return advisories
}

describe('status gate — warn (default) mode', () => {
  it('invalid status.json write-intent → advisory emit, intent resolves undefined (write proceeds)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined() // no veto, no guard → unconditional write proceeds
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.operation).toBe('write')
    expect(advisories[0]!.target).toBe(join(app.harnessDir, 'status.json'))
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.result.hardBlocked).toBe(false)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('status.invalid-plans')
  })

  it('invalid status.json edit-intent → advisory emit with operation edit, edit proceeds', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/edit-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.operation).toBe('edit')
  })

  it('hostile non-JSON document → advisory with status.invalid-json, write proceeds', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': 'not json {{{' })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('status.invalid-json')
  })

  it('clean document → silent pass (no advisory, no veto)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(VALID_STATUS) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('missing status.json (first create) → pass without validation', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })
})

describe('status gate — hard mode (Config enforcement: hard)', () => {
  it('invalid status.json write-intent → typed veto rejecting the waterfall', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })
    const advisories = captureAdvisories(app.ctx)

    const attempt = app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    await expect(attempt).rejects.toBeInstanceOf(StatusGateError)
    await expect(attempt).rejects.toMatchObject({
      code: 'STATUS_GATE_HARD_BLOCK',
      operation: 'write',
      name: 'StatusGateError',
    })
    const error = await attempt.catch((e: unknown) => e) as StatusGateError
    expect(error.result.hardBlocked).toBe(true) // GateResult.hardBlocked honored
    expect(error.result.violations.map((v) => v.code)).toContain('status.invalid-plans')
    expect(advisories).toHaveLength(0) // veto is the signal; advisory is warn-mode only
  })

  it('invalid status.json edit-intent → typed veto', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })

    await expect(
      app.ctx.waterfall('fs/edit-intent', statusTarget(app.harnessDir), {}, () => undefined),
    ).rejects.toMatchObject({ code: 'STATUS_GATE_HARD_BLOCK', operation: 'edit' })
  })

  it('hostile inputs veto with their violation codes', async () => {
    const cases: Array<{ name: string; content: string; code: string }> = [
      { name: 'non-JSON', content: 'not json {{{', code: 'status.invalid-json' },
      { name: 'wrong schema version', content: JSON.stringify({ ...VALID_STATUS, version: 2 }), code: 'status.unsupported-version' },
      {
        name: 'dual residual write (root + metadata)',
        content: JSON.stringify({ ...VALID_STATUS, metadata: { residual_findings: { p1: [] } } }),
        code: 'status.dual-write-residuals',
      },
    ]
    for (const fixture of cases) {
      const app = booted = await bootApp({ enforcement: 'hard' })
      await seedHarness(app.harnessDir, { 'status.json': fixture.content })

      const error = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)
        .catch((e: unknown) => e)

      expect(error, fixture.name).toBeInstanceOf(StatusGateError)
      expect((error as StatusGateError).result.violations.map((v) => v.code), fixture.name).toContain(fixture.code)
      await booted?.dispose()
      booted = undefined
    }
  })

  it('hard via compass frontmatter (no Config override) → veto', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(INVALID_STATUS),
      'iterations/v2.1.0/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })

    await expect(
      app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined),
    ).rejects.toMatchObject({ code: 'STATUS_GATE_HARD_BLOCK' })
  })

  it('clean document under hard → passes (no violations → hardBlocked false)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(VALID_STATUS) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('non-status targets are not gated (gate scope is the harness status file only)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', otherTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })
})

describe('status gate — findingsCleanupGate when configured', () => {
  /** Schema-valid doc whose plan declares zero-residual and carries an open nit. */
  const CLEANUP_DOC = {
    ...VALID_STATUS,
    plans: [{ id: 'p1', title: 't', file: 'plans/p1.md', status: 'InProgress', metadata: { findings_cleanup: 'zero-residual' } }],
    residual_findings: {
      p1: [{ id: 'R1', title: 't', severity: 'nit', source: 'qc', scope: 'plan', decision: 'defer', owner: 'qa', target: 'n', tracking: null }],
    },
  }

  it('zero-residual mode configured → open nit vetoes under hard', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(CLEANUP_DOC) })

    const error = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StatusGateError)
    expect((error as StatusGateError).result.violations.map((v) => v.code)).toContain('findings.zero-residual-nit')
  })

  it('zero-residual mode configured → advisory under warn', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(CLEANUP_DOC) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('findings.zero-residual-nit')
  })

  it('no findings_cleanup mode declared → cleanup gate not configured, doc passes', async () => {
    const unconfigured = {
      ...CLEANUP_DOC,
      plans: [{ id: 'p1', title: 't', file: 'plans/p1.md', status: 'InProgress' }],
    }
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(unconfigured) })

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
  })
})

describe('status gate — single-slot waterfall composition', () => {
  it('hard veto short-circuits later deciders; allow delegates to them (fs-policy style)', async () => {
    // Hard: the veto is terminal — a later decider (fs-policy's observed-state
    // slot) must never run.
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })
    let secondRan = false
    app.ctx.on('fs/write-intent', () => {
      secondRan = true
      return Promise.resolve({ kind: 'createIfAbsent' } as const)
    })

    await expect(
      app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined),
    ).rejects.toMatchObject({ code: 'STATUS_GATE_HARD_BLOCK' })
    expect(secondRan).toBe(false)

    // Warn: the gate calls next() — the later decider owns the intent decision
    // (fs-policy's observed-state CAS is preserved for status.json).
    await booted?.dispose()
    booted = undefined
    const warn = booted = await bootApp()
    await seedHarness(warn.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })
    secondRan = false
    warn.ctx.on('fs/write-intent', () => {
      secondRan = true
      return Promise.resolve({ kind: 'createIfAbsent' } as const)
    })

    const intent = await warn.ctx.waterfall('fs/write-intent', statusTarget(warn.harnessDir), {}, () => undefined)
    expect(intent).toEqual({ kind: 'createIfAbsent' })
    expect(secondRan).toBe(true)

    // Non-status targets always delegate.
    secondRan = false
    const other = await warn.ctx.waterfall('fs/write-intent', otherTarget(warn.harnessDir), {}, () => undefined)
    expect(other).toEqual({ kind: 'createIfAbsent' })
    expect(secondRan).toBe(true)
  })
})
