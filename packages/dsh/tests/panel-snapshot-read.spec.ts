/**
 * Read-service spec for `readPanelSnapshot` (`src/panel/read-panel-snapshot.ts`).
 *
 * The service is the panel's ONLY store-read entry: it composes the engine's
 * dashboard views sequentially into one `PanelSnapshot` and never throws on a
 * store fault. Every case here runs against the REAL `node:sqlite` store (the
 * engine's own initializer), so an answer is proven against the authority
 * instead of a mock; the two fault cases interpose on the engine's view layer
 * to make ONE view fail while the rest still read for real.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeStore, readDashboardView, type DashboardView } from '@mstar-harness/engine'
// Namespace import of the engine: the fault cases interpose a call-through
// wrapper on ONE exported function, so the production service still reads the
// real store for every view the case does not fault.
import * as engine from '@mstar-harness/engine'
import { readPanelSnapshot } from '../src/panel/read-panel-snapshot.ts'
import type { PanelSnapshot, PanelSnapshotRead } from '../src/panel/panel-snapshot.ts'

/** Temp roots created by the case; removed after it. */
const roots: string[] = []

/** The plugin's own manifest version — derived, never pinned. */
const PLUGIN_VERSION = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }).version

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A fresh workspace whose `.mstar` holds an ACTIVE store (the real initializer). */
async function activeHarness(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-panel-snapshot-'))
  roots.push(root)
  const harnessDir = join(root, '.mstar')
  await mkdir(harnessDir, { recursive: true })
  const handle = await initializeStore({ harnessDir })
  handle.close()
  return harnessDir
}

/** The snapshot of an `ok` read; fails the case when the read degraded. */
function snapshotOf(result: PanelSnapshotRead): PanelSnapshot {
  if (result.kind !== 'ok') throw new Error(`expected an ok snapshot, got unavailable: ${result.reason}`)
  return result.snapshot
}

/** The engine's own message for one refused view (the expected verbatim reason). */
async function engineRefusal(harnessDir: string, view: DashboardView): Promise<string> {
  try {
    await readDashboardView({ context: { harnessDir }, view })
  } catch (error) {
    return (error as Error).message
  }
  throw new Error(`the ${view} view did not refuse — the fixture is wrong`)
}

describe('readPanelSnapshot — composition', () => {
  it('composes all five workspace views from the store into one ok snapshot', async () => {
    const harnessDir = await activeHarness()
    const snapshot = snapshotOf(await readPanelSnapshot({
      harnessDir,
      workflowId: 'wf-absent',
      iterationId: 'iteration-absent',
      projectId: 'project-absent',
    }))

    expect(snapshot.harnessDir).toBe(harnessDir)
    expect(snapshot.version).toBe(PLUGIN_VERSION)
    // The temp workspace declares no enforcement anywhere: the engine's own
    // warn-only verdict, not a fabricated `hard`.
    expect(snapshot.enforcement).toEqual({ hard: false, source: 'none' })
    // An id the authority does not know is "nothing here", not a failure — the
    // three detail/roadmap views answer `ok` + `null`.
    expect(snapshot.workspace.workflow).toEqual({ state: 'ok', data: null })
    expect(snapshot.workspace.iteration).toEqual({ state: 'ok', data: null })
    expect(snapshot.workspace.roadmap).toEqual({ state: 'ok', data: null })
    expect(snapshot.workspace.issues).toMatchObject({ state: 'ok' })
    expect(snapshot.workspace.projects).toMatchObject({ state: 'ok' })
    // A resolved workflow whose ledger recorded nothing yet answers an EMPTY
    // window (a real state the panel renders), not a degraded null.
    expect(snapshot.ledger).toEqual({ events: [], summary: [] })
    expect(Number.isNaN(Date.parse(snapshot.at))).toBe(false)
  })

  it('reads the views one at a time — never two store reads in flight', async () => {
    const harnessDir = await activeHarness()
    const real = engine.readDashboardView
    let inFlight = 0
    let peak = 0
    let calls = 0
    const spy = spyOn(engine, 'readDashboardView').mockImplementation(async (input) => {
      inFlight += 1
      calls += 1
      peak = Math.max(peak, inFlight)
      try {
        // A yield wide enough that an overlapping Promise.all would be seen.
        await new Promise((resolve) => setTimeout(resolve, 1))
        return await real(input)
      } finally {
        inFlight -= 1
      }
    })

    const snapshot = snapshotOf(await readPanelSnapshot({
      harnessDir,
      workflowId: 'wf-1',
      iterationId: 'iteration-1',
      projectId: 'project-1',
    }))
    spy.mockRestore()

    expect(peak).toBe(1)
    expect(calls).toBe(5)
    expect(snapshot.workspace.projects).toMatchObject({ state: 'ok' })
  })

  it('stamps `at` once, after the last view has been read', async () => {
    const harnessDir = await activeHarness()
    const real = engine.readDashboardView
    let lastReadFinished = ''
    const spy = spyOn(engine, 'readDashboardView').mockImplementation(async (input) => {
      const envelope = await real(input)
      lastReadFinished = new Date().toISOString()
      return envelope
    })

    const snapshot = snapshotOf(await readPanelSnapshot({ harnessDir }))
    spy.mockRestore()

    expect(lastReadFinished).not.toBe('')
    expect(Date.parse(snapshot.at)).toBeGreaterThanOrEqual(Date.parse(lastReadFinished))
  })
})

describe('readPanelSnapshot — the three roadmap states', () => {
  it('answers not-applicable when no project id resolved, without asking the store for that view', async () => {
    const harnessDir = await activeHarness()
    const spy = spyOn(engine, 'readDashboardView')

    const snapshot = snapshotOf(await readPanelSnapshot({ harnessDir }))
    const views = spy.mock.calls.map((call) => (call[0] as { view: DashboardView }).view)
    spy.mockRestore()

    expect(snapshot.workspace.roadmap.state).toBe('not-applicable')
    expect(snapshot.workspace.roadmap).toMatchObject({ reason: expect.any(String) })
    expect(views).not.toContain('roadmap')
  })

  it('answers ok + null data for a resolved project the authority has no roadmap row for', async () => {
    const harnessDir = await activeHarness()
    const snapshot = snapshotOf(await readPanelSnapshot({ harnessDir, projectId: 'project-unknown' }))

    expect(snapshot.workspace.roadmap).toEqual({ state: 'ok', data: null })
  })

  it('answers unavailable with the store message verbatim when the roadmap read fails', async () => {
    const harnessDir = await activeHarness()
    const real = engine.readDashboardView
    // A real read-boundary refusal, produced by the engine for this workspace;
    // the fault case replays it for the roadmap view only.
    const absentHarness = join(harnessDir, '..', 'no-store')
    const reason = await engineRefusal(absentHarness, 'issues')
    const spy = spyOn(engine, 'readDashboardView').mockImplementation(async (input) => {
      if (input.view === 'roadmap') throw new Error(reason)
      return await real(input)
    })

    const snapshot = snapshotOf(await readPanelSnapshot({ harnessDir, projectId: 'project-1' }))
    spy.mockRestore()

    expect(snapshot.workspace.roadmap).toEqual({ state: 'unavailable', reason })
    // The other members still answered from the same healthy store.
    expect(snapshot.workspace.issues).toMatchObject({ state: 'ok' })
    expect(snapshot.workspace.projects).toMatchObject({ state: 'ok' })
  })
})

describe('readPanelSnapshot — degradation', () => {
  it('degrades only the refusing member: the snapshot stays ok', async () => {
    const harnessDir = await activeHarness()
    const real = engine.readDashboardView
    const spy = spyOn(engine, 'readDashboardView').mockImplementation(async (input) => {
      if (input.view === 'workflow-detail') throw new Error('[store.busy] the store is locked by a migration')
      return await real(input)
    })

    const result = await readPanelSnapshot({ harnessDir, workflowId: 'wf-1' })
    spy.mockRestore()

    expect(result.kind).toBe('ok')
    const snapshot = snapshotOf(result)
    expect(snapshot.workspace.workflow).toEqual({
      state: 'unavailable',
      reason: '[store.busy] the store is locked by a migration',
    })
    expect(snapshot.workspace.iteration.state).toBe('not-applicable')
    expect(snapshot.workspace.issues).toMatchObject({ state: 'ok' })
    expect(snapshot.workspace.projects).toMatchObject({ state: 'ok' })
  })

  it('answers the whole snapshot unavailable when no harness dir resolved', async () => {
    expect(await readPanelSnapshot({ harnessDir: null, workflowId: 'wf-1' })).toEqual({
      kind: 'unavailable',
      reason: 'no-harness-dir',
    })
  })

  it('answers the whole snapshot unavailable when a store refusal fails every view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-panel-snapshot-'))
    roots.push(root)
    // No store was ever initialized in this workspace: every attempted view
    // meets the same read-boundary refusal.
    const harnessDir = join(root, '.mstar')
    const reason = await engineRefusal(harnessDir, 'issues')

    expect(await readPanelSnapshot({ harnessDir })).toEqual({ kind: 'unavailable', reason })
  })
})
