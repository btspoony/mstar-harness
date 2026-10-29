/**
 * Read-service spec for `readPanelSnapshot` (`src/panel/read-panel-snapshot.ts`)
 * after the Task 4 shrink.
 *
 * The service is now the SESSION DIGEST read: `enforcement`, `knowledge`,
 * `selection` (the facts no dashboard DTO carries) plus the one envelope member
 * the per-view path does not replace (`iteration`, the delivery line's
 * no-answer fallback). Every case runs against the REAL `node:sqlite` store, so
 * an answer is proven against the authority instead of a mock.
 *
 * Load-bearing: the payload's KEY SET (nothing from the removed views survives),
 * `knowledge` carried rather than removed, and degraded ≠ empty per member.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeStore } from '@mstar-harness/engine'
import * as engine from '@mstar-harness/engine'
import { readPanelSnapshot, type PanelRetainedRead } from '../src/panel/read-panel-snapshot.ts'
import type { PanelSnapshot, PanelSnapshotRead } from '../src/panel/panel-snapshot.ts'
import type { MstarEngineStatusPayload } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A fresh workspace whose `.mstar` holds an ACTIVE store (the real initializer). */
async function activeHarness(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-panel-digest-'))
  roots.push(root)
  const harnessDir = join(root, '.mstar')
  await mkdir(harnessDir, { recursive: true })
  const handle = await initializeStore({ harnessDir })
  handle.close()
  return harnessDir
}

function snapshotOf(result: PanelSnapshotRead): PanelSnapshot {
  if (result.kind !== 'ok') {
    throw new Error(`expected an ok snapshot, got ${result.kind === 'no-harness' ? 'no-harness' : result.reason}`)
  }
  return result.snapshot
}

/** A catalog payload carrying the knowledge rollup and a session selection. */
function catalogPayload(over: { knowledge?: unknown; selection?: unknown } = {}): PanelRetainedRead {
  return {
    builtAt: Date.parse('2026-10-25T10:00:00.000Z'),
    payload: {
      state: {
        knowledge: over.knowledge === undefined ? { docCount: 3, categories: [] } : over.knowledge,
        selection: over.selection === undefined
          ? { kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' }
          : over.selection,
      },
    } as unknown as MstarEngineStatusPayload,
  }
}

/** The leaf-signal state these reads pass; the endpoint probes it in production. */
const LEAF_SIGNAL_ON = { active: true } as const

describe('readPanelSnapshot — the shrunken contract', () => {
  it('composes exactly the digest plus the delivery fallback — no view members survive', async () => {
    const harnessDir = await activeHarness()
    const snapshot = snapshotOf(await readPanelSnapshot({ harnessDir, leafSignal: LEAF_SIGNAL_ON }))
    expect(Object.keys(snapshot).sort()).toEqual(['enforcement', 'iteration', 'knowledge', 'leafSignal', 'selection'])
    // The removed members are GONE, not empty: no workspace block, no ledger, no
    // timestamps, no retained wrapper.
    for (const gone of ['workspace', 'ledger', 'at', 'version', 'harnessDir', 'retained']) {
      expect(gone in snapshot).toBe(false)
    }
    // The enforcement flag always answers, degraded in place rather than absent.
    expect(typeof snapshot.enforcement?.hard).toBe('boolean')
    // The caller-probed capability fact travels through unchanged.
    expect(snapshot.leafSignal).toEqual(LEAF_SIGNAL_ON)
  })

  it('carries `knowledge` (never rendered) instead of removing it', async () => {
    const harnessDir = await activeHarness()
    // No catalog reader wired: the member is null, not absent.
    const bare = snapshotOf(await readPanelSnapshot({ harnessDir, leafSignal: LEAF_SIGNAL_ON }))
    expect('knowledge' in bare).toBe(true)
    expect(bare.knowledge).toBeNull()

    // A catalog payload reaches the member verbatim.
    const read = snapshotOf(await readPanelSnapshot({
      harnessDir,
      leafSignal: LEAF_SIGNAL_ON,
      sessionId: 'ses-1',
      cwd: join(harnessDir, '..'),
      retained: async () => catalogPayload({ knowledge: { docCount: 7, categories: ['a'] } }),
    }))
    expect(read.knowledge).toEqual({ docCount: 7, categories: ['a'] })
    expect(read.selection).toEqual({ kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' })
  })

  it('keeps degraded distinct from empty, per member', async () => {
    const harnessDir = await activeHarness()
    // Empty: the store answered and no iteration resolves.
    const empty = snapshotOf(await readPanelSnapshot({ harnessDir, leafSignal: LEAF_SIGNAL_ON }))
    expect(empty.iteration.state).toBe('not-applicable')

    // Degraded: the store refuses the ITERATION MEMBER's read while the digest
    // itself answers — the member carries the store's own message, and an
    // asserted id means no list read is needed to reach it.
    const original = engine.readDashboardView
    const spy = spyOn(engine, 'readDashboardView').mockImplementation((async (input: never) => {
      const view = (input as { view?: string }).view
      if (view === 'iteration-detail') throw new Error('projection unavailable')
      return original(input)
    }) as never)
    try {
      const degraded = snapshotOf(await readPanelSnapshot({ harnessDir, iterationId: 'iter-x', leafSignal: LEAF_SIGNAL_ON }))
      expect(degraded.iteration.state).toBe('unavailable')
      if (degraded.iteration.state === 'unavailable') expect(degraded.iteration.reason).toContain('projection unavailable')
      // The rest of the digest is unaffected: one member degrades only itself.
      expect(typeof degraded.enforcement?.hard).toBe('boolean')
    } finally {
      spy.mockRestore()
    }
  })

  it('answers the whole read unavailable when the only read the digest needs refuses', async () => {
    const harnessDir = await activeHarness()
    const spy = spyOn(engine, 'readDashboardView').mockImplementation(async () => {
      throw new Error('store.not-active: staged')
    })
    try {
      const result = await readPanelSnapshot({ harnessDir, leafSignal: LEAF_SIGNAL_ON })
      expect(result.kind).toBe('unavailable')
      if (result.kind === 'unavailable') expect(result.reason).toContain('store.not-active')
    } finally {
      spy.mockRestore()
    }
  })

  it('answers the dedicated no-harness state when no harness dir resolved', async () => {
    expect(await readPanelSnapshot({ harnessDir: null, leafSignal: LEAF_SIGNAL_ON })).toEqual({ kind: 'no-harness' })
  })
})
