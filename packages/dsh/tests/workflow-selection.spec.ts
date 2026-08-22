/**
 * Plan `20260822-gate-fixes` Task 3 (f12) — terminalStatusCache eviction
 * on file deletion.
 *
 * The terminal-mtime fallback (`resolveReadWorkflow`) walks every workflow
 * dir per catalog refresh; the module-level `terminalStatusCache` holds a
 * snapshot path → `{ mtimeMs, terminal }` verdict with a 64-entry cap.
 * The qc3 S-2 fix-wave capped the cache but never EVICTED a key whose
 * target file was deleted: the `resolveReadWorkflow` loop short-circuits on
 * `!existsSync(snapshotPath)` and never reaches `terminalStatusOf`, so the
 * stale entry kept holding the cap while the dead workflow stayed
 * invisible. This spec pins the eviction contract:
 *
 * - after a cached terminal snapshot is deleted, the next read re-probes
 *   (the deleted workflow id is never selected) AND the cache key is gone;
 * - deleting the whole workflow dir is equivalent to deleting the snapshot
 *   file (both hit the `existsSync` short-circuit).
 */
import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveReadWorkflow, _terminalStatusCacheHas } from '../src/gates/workflow-selection.ts'
import { seedHarness, v2Root, v2Snapshot } from './harness.ts'

describe('workflow selection — terminalStatusCache eviction on deletion (f12)', () => {
  it('deleting the workflow dir evicts the cached key; the next read re-probes and selects nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-wfsel-evict-dir-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([]),
      'workflows/wf-new/snapshot.json': v2Snapshot('wf-new', { status: 'completed', ended_at: '2026-08-19', plans: [{ id: 'plan-new', status: 'Done' }] }),
    })
    const snapshotPath = join(harnessDir, 'workflows/wf-new/snapshot.json')

    // First read populates the cache (terminal verdict cached by mtime).
    expect(resolveReadWorkflow(harnessDir)).toEqual({ kind: 'terminal', workflowId: 'wf-new', dir: 'workflows/wf-new' })

    // Delete the whole workflow dir.
    await rm(join(harnessDir, 'workflows/wf-new'), { recursive: true, force: true })

    // The next read re-probes: no terminal snapshot remains — the deleted
    // workflow must NOT be selected, and the dead cache key must be gone.
    expect(resolveReadWorkflow(harnessDir)).toEqual({
      kind: 'error',
      code: 'workflow.selection.no-snapshot',
      message: expect.stringContaining('no terminal workflow snapshot'),
    })
    expect(_terminalStatusCacheHas(snapshotPath)).toBe(false)
  })

  it('deleting just the snapshot.json evicts the cached key; a remaining terminal is still selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-wfsel-evict-file-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([]),
      'workflows/wf-old/snapshot.json': v2Snapshot('wf-old', { status: 'completed', ended_at: '2026-08-18', plans: [{ id: 'plan-old', status: 'Done' }] }),
      'workflows/wf-new/snapshot.json': v2Snapshot('wf-new', { status: 'completed', ended_at: '2026-08-19', plans: [{ id: 'plan-new', status: 'Done' }] }),
    })
    // Deterministic mtimes: wf-old older, wf-new newer (selection by file mtime).
    const oldPath = join(harnessDir, 'workflows/wf-old/snapshot.json')
    const newPath = join(harnessDir, 'workflows/wf-new/snapshot.json')
    const base = Date.now() / 1000
    await utimes(oldPath, base - 200, base - 200)
    await utimes(newPath, base - 100, base - 100)

    // First read caches both verdicts and selects the newest terminal.
    expect(resolveReadWorkflow(harnessDir)).toEqual({ kind: 'terminal', workflowId: 'wf-new', dir: 'workflows/wf-new' })
    expect(_terminalStatusCacheHas(newPath)).toBe(true)

    // Delete only the newest snapshot file (dir remains).
    await rm(newPath, { force: true })

    // The next read must not select the deleted workflow; it falls back to
    // the surviving terminal, and the dead key is evicted from the cache.
    expect(resolveReadWorkflow(harnessDir)).toEqual({ kind: 'terminal', workflowId: 'wf-old', dir: 'workflows/wf-old' })
    expect(_terminalStatusCacheHas(newPath)).toBe(false)
  })
})
