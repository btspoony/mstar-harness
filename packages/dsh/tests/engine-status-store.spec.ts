/**
 * engine-status store spec — emissions + the D4 session binding, now backed by
 * the control-root `store.db` instead of a shared `snapshots/engine-status.json`
 * envelope.
 *
 * Retired with the envelope (and therefore NOT re-pinned here): the atomic
 * temp+rename replace, the writer-unique temp cleanup, the `sv`/`rv` envelope
 * refusal cases, the 50-entry per-session mirror, the 30-day age rule, the
 * 16 MB ceiling and its bucket shedding, the memoized file parse, and both
 * lockdir contention cases. Each of those described containment of ONE shared
 * file; the store keeps one newest row per session and the binding row, so
 * there is no bucket, no ceiling and no memo left to test.
 *
 * What IS pinned is the caller-visible contract: newest-emission upsert, the
 * session+cwd addressing that prevents a cross-session or cross-workspace
 * answer, binding round-trip with max-merged floor and preserved omitted
 * preference, cwd anchoring, hostile session ids as ordinary SQL values, the
 * truthful pre-activation refusal carrying the public recovery, and the
 * selected-generation refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeStore, readDshStatusEmission, type DshSelectedGeneration } from '@mstar-harness/engine'
import {
  readEngineStatusSnapshot,
  readWorkflowSessionBinding,
  updateWorkflowSessionBinding,
  writeEngineStatusSnapshot,
} from '../src/engine-status-store.ts'
import { seedStore } from './harness.ts'

let root = ''
let harnessDir = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-status-store-'))
  harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('engine-status store — newest emission per session', () => {
  it('writes this session newest emission row and serves it back with its identity', async () => {
    await seedStore(harnessDir)
    expect(writeEngineStatusSnapshot(harnessDir, {
      sessionId: 'ses_alpha',
      cwd: '/proj/alpha',
      turn: 4,
      payload: { version: '9.9.9', marker: 11 },
    })).toEqual({ kind: 'written' })

    const read = readEngineStatusSnapshot(harnessDir, 'ses_alpha', '/proj/alpha')
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') throw new Error('unreachable')
    expect(read.entry).toMatchObject({ rv: 1, cwd: '/proj/alpha', turn: 4, payload: { version: '9.9.9', marker: 11 } })
    expect(Number.isFinite(Date.parse(read.entry.at))).toBe(true)
  })

  it('keeps ONE row per session: the next emission replaces the previous turn', async () => {
    await seedStore(harnessDir)
    for (const turn of [1, 2, 3]) {
      expect(writeEngineStatusSnapshot(harnessDir, {
        sessionId: 'ses_alpha', cwd: '/proj/alpha', turn, payload: { marker: turn },
      })).toEqual({ kind: 'written' })
    }
    expect(readDshStatusEmission({ harnessDir }, 'ses_alpha', '/proj/alpha')?.turn).toBe(3)
    const read = readEngineStatusSnapshot(harnessDir, 'ses_alpha', '/proj/alpha')
    expect(read.kind === 'ok' && read.entry.payload).toEqual({ marker: 3 })
  })

  it('keeps sessions and workspaces independent — no cross-session or cross-cwd answer', async () => {
    await seedStore(harnessDir)
    writeEngineStatusSnapshot(harnessDir, { sessionId: 'ses_alpha', cwd: '/proj/alpha', turn: 11, payload: { marker: 11 } })
    writeEngineStatusSnapshot(harnessDir, { sessionId: 'ses_beta', cwd: '/proj/beta', turn: 22, payload: { marker: 22 } })

    const alpha = readEngineStatusSnapshot(harnessDir, 'ses_alpha', '/proj/alpha')
    const beta = readEngineStatusSnapshot(harnessDir, 'ses_beta', '/proj/beta')
    expect(alpha.kind === 'ok' && alpha.entry.turn).toBe(11)
    expect(beta.kind === 'ok' && beta.entry.turn).toBe(22)
    // Another workspace's row is not addressable by this pair.
    expect(readEngineStatusSnapshot(harnessDir, 'ses_beta', '/proj/alpha')).toEqual({ kind: 'unavailable', reason: 'no-session-entry' })
    expect(readEngineStatusSnapshot(harnessDir, 'ses_gamma', '/proj/alpha')).toEqual({ kind: 'unavailable', reason: 'no-session-entry' })
  })

  it('keys an id naming an Object.prototype member like any other session', async () => {
    await seedStore(harnessDir)
    for (const sessionId of ['__proto__', 'constructor', 'toString']) {
      expect(writeEngineStatusSnapshot(harnessDir, {
        sessionId, cwd: '/proj/hostile', turn: 5, payload: { sessionId },
      })).toEqual({ kind: 'written' })
      const read = readEngineStatusSnapshot(harnessDir, sessionId, '/proj/hostile')
      expect(read.kind === 'ok' && read.entry.payload).toEqual({ sessionId })
    }
    // A hostile id still has no row of its own when nothing was written for it.
    expect(readEngineStatusSnapshot(harnessDir, 'hasOwnProperty', '/proj/hostile')).toEqual({
      kind: 'unavailable',
      reason: 'no-session-entry',
    })
  })

  it('degrades without writing on an unusable emission identity', async () => {
    await seedStore(harnessDir)
    expect(writeEngineStatusSnapshot(harnessDir, { sessionId: '', cwd: '/proj/a', turn: 1, payload: {} }))
      .toEqual({ kind: 'degraded', reason: 'no-session-id' })
    expect(writeEngineStatusSnapshot(harnessDir, { sessionId: 's', cwd: '', turn: 1, payload: {} }))
      .toEqual({ kind: 'degraded', reason: 'no-session-cwd' })
    expect(writeEngineStatusSnapshot(harnessDir, { sessionId: 's', cwd: '/proj/a', turn: Number.NaN, payload: {} }))
      .toEqual({ kind: 'degraded', reason: 'invalid-turn' })
    expect(writeEngineStatusSnapshot(harnessDir, { sessionId: 's', cwd: '/proj/a', turn: 1, payload: [] as unknown as object }))
      .toEqual({ kind: 'degraded', reason: 'payload-not-object' })
    expect(writeEngineStatusSnapshot(null, { sessionId: 's', cwd: '/proj/a', turn: 1, payload: {} }))
      .toEqual({ kind: 'degraded', reason: 'no-harness-dir' })
    expect(readDshStatusEmission({ harnessDir }, 's', '/proj/a')).toBeUndefined()
  })
})

describe('engine-status store — pre-activation refusal with public recovery', () => {
  it('answers the explicit store cause naming the supported recovery, and writes nothing', async () => {
    // No store at all: authority-dependent persistence is unavailable — never a
    // file fallback and never a fabricated successful write.
    expect(existsSync(join(harnessDir, 'store.db'))).toBe(false)
    const read = readWorkflowSessionBinding(harnessDir, 's', '/proj/a')
    expect(read.kind).toBe('unavailable')
    if (read.kind !== 'unavailable') throw new Error('unreachable')
    expect(read.reason).toContain('mstar store init')
    expect(read.reason).toContain('mstar store upgrade')

    const written = updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', { excludedBeforeSeq: 1 })
    expect(written.kind).toBe('degraded')
    if (written.kind !== 'degraded') throw new Error('unreachable')
    expect(written.reason).toContain('mstar store init')
    expect(readEngineStatusSnapshot(harnessDir, 's', '/proj/a')).toEqual({ kind: 'unavailable', reason: 'absent' })
    expect(writeEngineStatusSnapshot(harnessDir, { sessionId: 's', cwd: '/proj/a', turn: 1, payload: {} }).kind).toBe('degraded')
  })
})

describe('engine-status store — workflow session bindings (D4 control state)', () => {
  it('round-trips a pick with its floor and preserves the stored preference on an omitted update', async () => {
    await seedStore(harnessDir)
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/a')).toEqual({ kind: 'ok' })

    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', {
      selectedWorkflowId: 'wf-a', excludedBeforeSeq: 2,
    })).toEqual({ kind: 'written' })
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/a')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj/a', selectedWorkflowId: 'wf-a', executionBinding: null, excludedBeforeSeq: 2 },
    })

    // A floor-only observation keeps the pick and merges the floor by max.
    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', { excludedBeforeSeq: 9 })).toEqual({ kind: 'written' })
    // An older observation never walks the exclusion window back.
    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', { excludedBeforeSeq: 3 })).toEqual({ kind: 'written' })
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/a')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj/a', selectedWorkflowId: 'wf-a', executionBinding: null, excludedBeforeSeq: 9 },
    })
  })

  it('anchors one workspace per session id while keeping parallel sessions independent', async () => {
    await seedStore(harnessDir)
    updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 1 })
    updateWorkflowSessionBinding(harnessDir, 't', '/proj/a', { selectedWorkflowId: 'wf-c', excludedBeforeSeq: 3 })
    // Two sessions in ONE workspace are independent records.
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/a')).toMatchObject({ binding: { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 1 } })
    expect(readWorkflowSessionBinding(harnessDir, 't', '/proj/a')).toMatchObject({ binding: { selectedWorkflowId: 'wf-c', excludedBeforeSeq: 3 } })
    // A session id is anchored to the ONE workspace its record was written for:
    // another cwd neither reads nor writes a second record of the same session.
    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/b', { selectedWorkflowId: 'wf-b', excludedBeforeSeq: 2 }))
      .toEqual({ kind: 'degraded', reason: 'cwd-mismatch' })
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/b')).toEqual({ kind: 'unavailable', reason: 'cwd-mismatch' })
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/a')).toMatchObject({ binding: { selectedWorkflowId: 'wf-a' } })
  })

  it('refuses a record whose stored cwd is not this session cwd, and a malformed update', async () => {
    await seedStore(harnessDir)
    updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 1 })
    // The same session id under another workspace is not the record's owner.
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/b')).toEqual({ kind: 'unavailable', reason: 'cwd-mismatch' })
    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/b', { selectedWorkflowId: 'wf-b', excludedBeforeSeq: 1 }))
      .toEqual({ kind: 'degraded', reason: 'cwd-mismatch' })
    // Stored bytes for /proj/a are untouched by the refused write.
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/a')).toMatchObject({ binding: { selectedWorkflowId: 'wf-a' } })

    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', { excludedBeforeSeq: -1 }))
      .toEqual({ kind: 'degraded', reason: 'invalid-excluded-before-seq' })
    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', { selectedWorkflowId: '', excludedBeforeSeq: 1 }))
      .toEqual({ kind: 'degraded', reason: 'invalid-selected-workflow-id' })
    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', {
      executionBinding: { version: 2 } as never, excludedBeforeSeq: 1,
    })).toEqual({ kind: 'degraded', reason: 'invalid-execution-binding' })
    expect(updateWorkflowSessionBinding('', 's', '/proj/a', { excludedBeforeSeq: 1 }).kind).toBe('degraded')
    expect(updateWorkflowSessionBinding(harnessDir, '', '/proj/a', { excludedBeforeSeq: 1 }).kind).toBe('degraded')
    expect(updateWorkflowSessionBinding(harnessDir, 's', '', { excludedBeforeSeq: 1 }).kind).toBe('degraded')
  })

  it('adopts and clears an execution authority witness separately from the pick', async () => {
    await seedStore(harnessDir)
    const witness = {
      version: 1 as const,
      harnessRoot: harnessDir,
      session: {
        storeId: '00000000-0000-4000-8000-000000000000',
        epoch: 1,
        workflowId: 'wf-a',
        role: 'coordinator' as const,
        sessionId: 's',
      },
    }
    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', {
      selectedWorkflowId: 'wf-a', executionBinding: witness, excludedBeforeSeq: 1,
    })).toEqual({ kind: 'written' })
    const adopted = readWorkflowSessionBinding(harnessDir, 's', '/proj/a')
    expect(adopted.kind === 'ok' && adopted.binding?.executionBinding?.session.sessionId).toBe('s')

    // Clearing the witness keeps the pick and the floor.
    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', { executionBinding: null, excludedBeforeSeq: 1 }))
      .toEqual({ kind: 'written' })
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/a')).toEqual({
      kind: 'ok',
      binding: { cwd: '/proj/a', selectedWorkflowId: 'wf-a', executionBinding: null, excludedBeforeSeq: 1 },
    })
  })

  it('refuses a write whose selected generation is no longer the current authority', async () => {
    const store = await seedStoreHandle(harnessDir)
    const stale: DshSelectedGeneration = { storeId: store.storeId, epoch: store.epoch + 41 }
    const written = updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', {
      selectedWorkflowId: 'wf-a', excludedBeforeSeq: 1, selectedGeneration: stale,
    })
    expect(written.kind).toBe('degraded')
    if (written.kind !== 'degraded') throw new Error('unreachable')
    expect(written.reason).toContain('store.stale-epoch')
    // Nothing landed: the refusal is a refusal, not a partial write.
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/a')).toEqual({ kind: 'ok' })

    // The current generation commits.
    expect(updateWorkflowSessionBinding(harnessDir, 's', '/proj/a', {
      selectedWorkflowId: 'wf-a', excludedBeforeSeq: 1,
      selectedGeneration: { storeId: store.storeId, epoch: store.epoch },
    })).toEqual({ kind: 'written' })
    expect(readWorkflowSessionBinding(harnessDir, 's', '/proj/a')).toMatchObject({ binding: { selectedWorkflowId: 'wf-a' } })
  })
})

/** One ACTIVE store handle (identity/epoch read for the generation cases). */
async function seedStoreHandle(dir: string): Promise<{ storeId: string; epoch: number }> {
  const handle = await initializeStore({ harnessDir: dir })
  try {
    return { storeId: handle.storeId, epoch: handle.epoch }
  } finally {
    handle.close()
  }
}
