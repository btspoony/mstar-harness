/**
 * Task 3 — status hard gate: `fs/write-intent` + `fs/edit-intent` on
 * `{HARNESS_DIR}/status.json` (plan 20260808-dsh-package-core).
 *
 * Harness approach: the dsh seam packages resolve from the npm registry, and the waterfalls
 * are simulated with a minimal typed harness — the same
 * `ctx.waterfall('fs/write-intent', target, exec, () => undefined)`
 * dispatch the real `@deepseek-ai/dsh-tool-fs` write/edit tools perform
 * (tool-fs README, dsh-private 9451be2). The gate reads the CURRENT on-disk
 * document at intent time (the waterfall carries no incoming content), so
 * seeds are written before each dispatch.
 *
 * Contract notes (full detail in task-3-report.md + qc-fix-report.md):
 * - The gate NEVER throws (qc3 F-1 / qc2 W-001): the intent waterfall carries
 *   no incoming content, so hard mode allows an ALREADY-invalid document as a
 *   repair escape (error-level log + repair advisory, `hard: true, repair:
 *   true`) — a veto there would deadlock the repairing write. Unexpected
 *   internal errors degrade to allow in BOTH modes with a `degraded: true`
 *   advisory (error-containment envelope).
 * - Warn mode (default): log + advisory emit + `next()` delegation (allow).
 * - The dsh `agent/status` event is lifecycle-only (idle ⇄ running, no-op
 *   invariant) — the advisory emit lands on the plugin-owned
 *   `mstar/status-gate` event instead.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { harnessDocKindOfTarget } from '../src/gates/status.ts'
import {
  bootApp,
  INVALID_STATUS,
  INVALID_STATUS_V2,
  VALID_STATUS,
  VALID_STATUS_V2,
  seedHarness,
  v2RootWithWorkflow,
  v2SnapshotWithPlans,
  v2Register,
  v2ResidualEntry,
  type BootResult,
} from './harness.ts'
import type { StatusGateAdvisory } from '../src/index.ts'

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

/** FsTarget for `{HARNESS_DIR}/workflows/wf-1/snapshot.json` (the v3 snapshot target). */
const snapshotTarget = (harnessDir: string, workflowId = 'wf-1'): FsTarget => ({
  targetKey: join(harnessDir, 'workflows', workflowId, 'snapshot.json') as FsTarget['targetKey'],
  displayPath: join(harnessDir, 'workflows', workflowId, 'snapshot.json'),
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
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS_V2) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined() // no veto, no guard → unconditional write proceeds
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.operation).toBe('write')
    expect(advisories[0]!.target).toBe(join(app.harnessDir, 'status.json'))
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.result.hardBlocked).toBe(false)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('status.invalid-workflows')
  })

  it('invalid status.json edit-intent → advisory emit with operation edit, edit proceeds', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS_V2) })
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
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(VALID_STATUS_V2) })
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
  it('invalid status.json write-intent → repair-escape advisory (hard+repair), waterfall resolves (write proceeds)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS_V2) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    // Repair escape (qc2 W-001): the document is ALREADY invalid, so this
    // write may be the repair — hard mode allows it with a loud advisory.
    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true) // the resolved hard flag is live again (qc2 S-005)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.degraded).toBeUndefined()
    expect(advisories[0]!.result.hardBlocked).toBe(true) // GateResult.hardBlocked still honored
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('status.invalid-workflows')
  })

  it('invalid status.json edit-intent → repair-escape advisory (operation edit)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS_V2) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/edit-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.operation).toBe('edit')
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
  })

  it('hostile inputs surface their violation codes in the repair advisory', async () => {
    const cases: Array<{ name: string; content: string; code: string }> = [
      { name: 'non-JSON', content: 'not json {{{', code: 'status.invalid-json' },
      { name: 'v2 root without workflows', content: JSON.stringify({ ...VALID_STATUS_V2, workflows: undefined }), code: 'status.missing-workflows' },
      { name: 'v2 root with non-array workflows', content: JSON.stringify(INVALID_STATUS_V2), code: 'status.invalid-workflows' },
      // v1-shaped (root plans[]) fails closed with the migrate hint even when
      // the version field claims 2 (the v1-disguise hole, engine W-C).
      { name: 'v1-shaped doc with version 2', content: JSON.stringify({ ...VALID_STATUS, version: 2 }), code: 'status.migration-required' },
      {
        name: 'v1 residual_findings home',
        content: JSON.stringify({ ...VALID_STATUS, residual_findings: { p1: [] } }),
        code: 'status.migration-required',
      },
    ]
    for (const fixture of cases) {
      const app = booted = await bootApp({ enforcement: 'hard' })
      await seedHarness(app.harnessDir, { 'status.json': fixture.content })
      const advisories = captureAdvisories(app.ctx)

      const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

      expect(intent, fixture.name).toBeUndefined()
      expect(advisories, fixture.name).toHaveLength(1)
      expect(advisories[0]!.hard, fixture.name).toBe(true)
      expect(advisories[0]!.repair, fixture.name).toBe(true)
      expect(advisories[0]!.result.violations.map((v) => v.code), fixture.name).toContain(fixture.code)
      await booted?.dispose()
      booted = undefined
    }
  })

  it('hard via compass frontmatter (no Config override) → repair-escape advisory with hard=true', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(INVALID_STATUS_V2),
      'iterations/v2.1.0/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
  })

  it('clean document under hard → passes silently (no violations → no advisory)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(VALID_STATUS_V2) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('non-status targets are not gated (gate scope is the harness status file only)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS_V2) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', otherTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })
})

describe('status gate — error-containment envelope (qc3 F-1)', () => {
  /** FsTarget violating the FsTarget contract (non-string displayPath). */
  const brokenTarget = (harnessDir: string): FsTarget => ({
    targetKey: join(harnessDir, 'status.json') as FsTarget['targetKey'],
    displayPath: Symbol('contract-violation') as unknown as string,
  })

  it('unexpected error inside the gate → degrade to allow with a degraded advisory (warn mode)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(VALID_STATUS_V2) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', brokenTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined() // never an untyped throw from the gate
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.degraded).toBe(true)
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.repair).toBeUndefined()
    expect(advisories[0]!.result.ok).toBe(true)
  })

  it('unexpected error inside the gate → degrade to allow in hard mode too (never hardens a soft workflow)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(VALID_STATUS_V2) })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', brokenTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.degraded).toBe(true)
    expect(advisories[0]!.result.ok).toBe(true)
  })

  it('a throwing advisory consumer is contained by the envelope (emit failure cannot block the write)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(VALID_STATUS_V2) })
    app.ctx.on('mstar/status-gate', () => { throw new Error('consumer boom') })

    const intent = await app.ctx.waterfall('fs/write-intent', brokenTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined() // the emit failure degrades to a log, never a throw
  })
})

describe('status gate — findingsCleanupGate when configured', () => {
  /**
   * Seed the v3 cleanup fixture: a v2 tree whose snapshot plan row declares
   * zero-residual AND a project register holding an open nit for that plan
   * (the v1 `residual_findings` home is gone — residuals live in
   * `projects/<id>/residuals.json`, entries keyed by plan id; the snapshot
   * write gate runs the cleanup extension against them).
   */
  async function seedCleanupSnapshot(harnessDir: string, mode = 'zero-residual'): Promise<void> {
    const configured = { id: 'p1', title: 't', file: 'plans/p1.md', status: 'InProgress', metadata: { findings_cleanup: mode } }
    await seedHarness(harnessDir, {
      'status.json': v2RootWithWorkflow(),
      'workflows/wf-1/snapshot.json': v2SnapshotWithPlans('wf-1', [configured]),
      'projects/_default/residuals.json': v2Register({ p1: [v2ResidualEntry('R1', { severity: 'nit' })] }),
    })
  }

  it('zero-residual mode configured → open nit surfaces as a repair-escape advisory under hard', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedCleanupSnapshot(app.harnessDir)
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', snapshotTarget(app.harnessDir), {}, () => undefined)

    // The snapshot already violates the cleanup gate; the write may BE the
    // cleanup — hard mode allows it as a repair escape (content-blind seam).
    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('findings.zero-residual-nit')
  })

  it('zero-residual mode configured → advisory under warn', async () => {
    const app = booted = await bootApp()
    await seedCleanupSnapshot(app.harnessDir)
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', snapshotTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('findings.zero-residual-nit')
  })

  it('no findings_cleanup mode declared → cleanup gate not configured, doc passes', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    // A snapshot plan row WITHOUT `metadata.findings_cleanup`: the cleanup
    // extension is not configured — the open register nit is not a gate
    // violation (the mode is the opt-in).
    await seedHarness(app.harnessDir, {
      'status.json': v2RootWithWorkflow(),
      'workflows/wf-1/snapshot.json': v2SnapshotWithPlans('wf-1', [{ id: 'p1', title: 't', file: 'plans/p1.md', status: 'InProgress' }]),
      'projects/_default/residuals.json': v2Register({ p1: [v2ResidualEntry('R1', { severity: 'nit' })] }),
    })
    const advisories = captureAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', snapshotTarget(app.harnessDir), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })
})

describe('status gate — single-slot waterfall composition', () => {
  it('repair escape and warn allow both delegate to later deciders (fs-policy style)', async () => {
    // Hard + already-invalid doc: the repair escape must NOT terminate the
    // chain — the write proceeds, so a later decider (fs-policy's observed-
    // state slot) still owns the intent decision.
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS_V2) })
    let secondRan = false
    app.ctx.on('fs/write-intent', () => {
      secondRan = true
      return Promise.resolve({ kind: 'createIfAbsent' } as const)
    })

    const repairIntent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)
    expect(repairIntent).toEqual({ kind: 'createIfAbsent' })
    expect(secondRan).toBe(true)

    // Warn: the gate calls next() — the later decider owns the intent decision
    // (fs-policy's observed-state CAS is preserved for status.json).
    await booted?.dispose()
    booted = undefined
    const warn = booted = await bootApp()
    await seedHarness(warn.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS_V2) })
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

describe('harnessDocKindOfTarget — custom workflow_dir/project_dir (Phase-5 F1)', () => {
  it('classifies snapshot/register under `.mstarc`-declared custom dirs; default names are not canonical there', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-status-custom-'))
    try {
      const harness = join(root, '.mstar')
      mkdirSync(join(harness, 'cw-wf', 'wf-1'), { recursive: true })
      mkdirSync(join(harness, 'cw-pj', '_default'), { recursive: true })
      writeFileSync(join(harness, '.mstarc'), '[config]\nworkflow_dir=cw-wf\nproject_dir=cw-pj\n', 'utf8')

      expect(harnessDocKindOfTarget(harness, join(harness, 'cw-wf', 'wf-1', 'snapshot.json'))).toBe('snapshot')
      expect(harnessDocKindOfTarget(harness, join(harness, 'cw-pj', '_default', 'residuals.json'))).toBe('register')
      // The default-named locations are NOT the canonical homes under the
      // custom layout (the gate must not classify what the runtime never
      // writes).
      expect(harnessDocKindOfTarget(harness, join(harness, 'workflows', 'wf-1', 'snapshot.json'))).toBeNull()
      expect(harnessDocKindOfTarget(harness, join(harness, 'projects', '_default', 'residuals.json'))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('default layout (no `.mstarc`) keeps the canonical names', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-status-default-'))
    try {
      const harness = join(root, '.mstar')
      mkdirSync(join(harness, 'workflows', 'wf-1'), { recursive: true })
      mkdirSync(join(harness, 'projects', '_default'), { recursive: true })
      expect(harnessDocKindOfTarget(harness, join(harness, 'workflows', 'wf-1', 'snapshot.json'))).toBe('snapshot')
      expect(harnessDocKindOfTarget(harness, join(harness, 'projects', '_default', 'residuals.json'))).toBe('register')
      expect(harnessDocKindOfTarget(harness, join(harness, 'workflows', 'snapshot.json'))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
