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
import { dirname, join } from 'node:path'
import { initializeStore, readDashboardView, type DashboardView } from '@mstar-harness/engine'
// Namespace import of the engine: the fault cases interpose a call-through
// wrapper on ONE exported function, so the production service still reads the
// real store for every view the case does not fault.
import * as engine from '@mstar-harness/engine'
import { readPanelSnapshot, type PanelRetainedRead } from '../src/panel/read-panel-snapshot.ts'
import type { PanelSnapshot, PanelSnapshotRead } from '../src/panel/panel-snapshot.ts'
import type { MstarEngineStatusPayload } from '../src/types.ts'

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
  if (result.kind !== 'ok') {
    throw new Error(`expected an ok snapshot, got ${result.kind === 'no-harness' ? 'no-harness' : result.reason}`)
  }
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

  it('answers the dedicated no-harness state when no harness dir resolved', async () => {
    // F3: an inactive workspace is its own state, not a store failure — the
    // panel renders locale copy here instead of a wire token.
    expect(await readPanelSnapshot({ harnessDir: null, workflowId: 'wf-1' })).toEqual({ kind: 'no-harness' })
    expect(await readPanelSnapshot({ harnessDir: '' })).toEqual({ kind: 'no-harness' })
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

/* ------------------------- retained (catalog cache) ------------------------- */

/**
 * A catalog payload carrying the three facts no dashboard DTO owns. Shaped by
 * the contract `readCatalogPayload` returns, not by a rebuilt fixture: only the
 * members the panel maps are populated.
 */
function catalogPayload(over: { selection?: unknown; knowledge?: unknown } = {}): MstarEngineStatusPayload {
  return {
    version: '4.0.4',
    harnessDir: '/proj/.mstar',
    enforcement: { hard: true, source: 'compass' },
    iteration: {
      iterationId: 'iter-1',
      compassPath: 'iterations/iter-1/delivery-compass.md',
      compassStatus: 'locked',
      gate: { transition: 'phase-2-execute', ok: true, violations: [] },
    },
    state: {
      ...(over.knowledge === undefined ? { knowledge: { docCount: 4, categories: ['testing'] } } : { knowledge: over.knowledge }),
      ...(over.selection === undefined
        ? { selection: { kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' } }
        : { selection: over.selection }),
    },
  } as unknown as MstarEngineStatusPayload
}

/** A reader answering the same payload for every target, and its build instant. */
function readerOf(payload: MstarEngineStatusPayload, builtAt: number): {
  calls: { harnessDir: string; sessionId: string; cwd: string }[]
  read: (harnessDir: string, sessionId: string, cwd: string) => Promise<PanelRetainedRead>
} {
  const calls: { harnessDir: string; sessionId: string; cwd: string }[] = []
  return {
    calls,
    read: async (harnessDir: string, sessionId: string, cwd: string) => {
      calls.push({ harnessDir, sessionId, cwd })
      return { payload, builtAt }
    },
  }
}

describe('readPanelSnapshot — retained catalog facts', () => {
  it('maps the cached payload onto the three retained members with their OWN freshness', async () => {
    const harnessDir = await activeHarness()
    // The payload was built a minute ago: the retained age must NOT be `at`.
    const builtAt = Date.now() - 60_000
    const reader = readerOf(catalogPayload(), builtAt)

    const snapshot = snapshotOf(await readPanelSnapshot({
      harnessDir,
      sessionId: 'ses_alpha',
      cwd: '/proj',
      retained: reader.read,
    }))

    expect(snapshot.retained).toEqual({
      iterationGate: catalogPayload().iteration ?? null,
      knowledge: { docCount: 4, categories: ['testing'] },
      selection: { kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' },
      at: new Date(builtAt).toISOString(),
    })
    // The store-read instant and the catalog build instant are two domains.
    expect(snapshot.retained.at).not.toBe(snapshot.at)
    expect(Date.parse(snapshot.retained.at!)).toBeLessThan(Date.parse(snapshot.at))
    // The reader was asked for THIS session's key material.
    expect(reader.calls).toEqual([{ harnessDir, sessionId: 'ses_alpha', cwd: '/proj' }])
  })

  it('leaves all three null and the snapshot ok when no catalog reader is wired', async () => {
    const harnessDir = await activeHarness()

    const snapshot = snapshotOf(await readPanelSnapshot({ harnessDir, sessionId: 'ses_alpha', cwd: '/proj' }))

    expect(snapshot.retained).toEqual({ iterationGate: null, knowledge: null, selection: null, at: null })
    expect(snapshot.workspace.projects).toMatchObject({ state: 'ok' })
  })

  it('leaves all three null and the snapshot ok when the catalog reader refuses', async () => {
    const harnessDir = await activeHarness()

    const snapshot = snapshotOf(await readPanelSnapshot({
      harnessDir,
      sessionId: 'ses_alpha',
      cwd: '/proj',
      retained: async () => {
        throw new Error('catalog build refused')
      },
    }))

    expect(snapshot.retained).toEqual({ iterationGate: null, knowledge: null, selection: null, at: null })
  })

  it('reads the catalog payload AFTER every dashboard view, never in parallel', async () => {
    const harnessDir = await activeHarness()
    const trace: string[] = []
    const real = engine.readDashboardView
    const spy = spyOn(engine, 'readDashboardView').mockImplementation(async (input) => {
      trace.push(input.view)
      return await real(input)
    })
    const reader = readerOf(catalogPayload(), Date.now())

    const snapshot = snapshotOf(await readPanelSnapshot({
      harnessDir,
      workflowId: 'wf-1',
      iterationId: 'iter-1',
      projectId: 'proj-1',
      sessionId: 'ses_alpha',
      cwd: '/proj',
      retained: async (...args) => {
        trace.push('retained')
        return await reader.read(...args)
      },
    }))
    spy.mockRestore()

    // A miss rebuilds the catalog payload, which can refresh store projections:
    // it must come after the last view, never between two of them. `projects`
    // and `iterations` lead because they RESOLVE the targets (asserted here, so
    // `iterations` is skipped) — nothing is read before them.
    expect(trace).toEqual(['projects', 'workflow-detail', 'iteration-detail', 'roadmap', 'issues', 'retained'])
    expect(snapshot.retained.iterationGate).not.toBeNull()
  })
})

describe('readPanelSnapshot — target resolution (F1)', () => {
  it('resolves the selected workflow from the durable pick when the caller asserts nothing', async () => {
    const harnessDir = await activeHarness()
    const { seedActiveWorkflow } = await import('./harness.ts')
    await seedActiveWorkflow(harnessDir, 'wf-resolved', [{ id: 'plan-1', status: 'Todo' }])

    // Exactly what the browser sends: no workflow/iteration/project id.
    const snapshot = snapshotOf(await readPanelSnapshot({
      harnessDir,
      sessionId: 'ses_resolve',
      cwd: dirname(harnessDir),
    }))

    // The store's single ACTIVE lifecycle is the answer (`selectActiveWorkflow`'s
    // own fallback) — the member is READ, never `not-applicable`.
    expect(snapshot.workspace.workflow.state).toBe('ok')
    if (snapshot.workspace.workflow.state !== 'ok') throw new Error('unreachable')
    expect(snapshot.workspace.workflow.data?.id).toBe('wf-resolved')
  })

  it('resolves the project from the catalog and scopes the roadmap to it', async () => {
    const harnessDir = await activeHarness()
    const { registerCatalogEntity } = await import('@mstar-harness/engine')
    await registerCatalogEntity(
      { harnessDir },
      { kind: 'project', id: '_default', title: 'Default', rootKind: 'harness', relativePath: 'projects/_default' },
      { operationId: 'op-seed-project', actor: 'panel.spec' },
    )

    const snapshot = snapshotOf(await readPanelSnapshot({ harnessDir, sessionId: 'ses_p', cwd: dirname(harnessDir) }))
    // The `_default` project is the fallback identity: the roadmap is scoped to
    // it instead of answering `not-applicable` for every panel session.
    expect(snapshot.workspace.roadmap.state).toBe('ok')
    if (snapshot.workspace.roadmap.state !== 'ok') throw new Error('unreachable')
    expect(snapshot.workspace.roadmap.data?.projectId).toBe('_default')
  })
})

describe('readPanelSnapshot — carrier cancellation (F5)', () => {
  it('runs no view at all when the carrier is already cancelled', async () => {
    const harnessDir = await activeHarness()
    const trace: string[] = []
    const real = engine.readDashboardView
    const spy = spyOn(engine, 'readDashboardView').mockImplementation(async (input) => {
      trace.push(input.view)
      return await real(input)
    })
    const controller = new AbortController()
    controller.abort()

    const result = await readPanelSnapshot({ harnessDir, signal: controller.signal })
    spy.mockRestore()

    // Cancelled before the first read: the store is never touched.
    expect(result).toEqual({ kind: 'unavailable', reason: 'aborted' })
    expect(trace).toEqual([])
  })

  it('stops before the NEXT view when the client gives up mid-read', async () => {
    const harnessDir = await activeHarness()
    const controller = new AbortController()
    const trace: string[] = []
    const real = engine.readDashboardView
    const spy = spyOn(engine, 'readDashboardView').mockImplementation(async (input) => {
      trace.push(input.view)
      const envelope = await real(input)
      // The caller's timeout lands while this view was in flight.
      controller.abort()
      return envelope
    })

    const result = await readPanelSnapshot({ harnessDir, signal: controller.signal })
    spy.mockRestore()

    expect(result).toEqual({ kind: 'unavailable', reason: 'aborted' })
    // One view paid for; nothing after it did (a second read here would also
    // have paid for a projection refresh nobody is waiting for).
    expect(trace).toEqual(['projects'])
  })
})

describe('readPanelSnapshot — enforcement degrades in place (F6)', () => {
  it('keeps the workspace snapshot ok when the enforcement resolver refuses', async () => {
    const harnessDir = await activeHarness()
    const spy = spyOn(engine, 'resolveRepoEnforcement').mockImplementation(() => {
      throw new Error('EACCES: the .mstarc declaration is unreadable')
    })

    const snapshot = snapshotOf(await readPanelSnapshot({ harnessDir }))
    spy.mockRestore()

    // The least important field degrades alone: the five store views still
    // answered, so the snapshot is `ok` with the warn-only flag.
    expect(snapshot.enforcement).toEqual({ hard: false, source: 'none' })
    expect(snapshot.workspace.projects).toMatchObject({ state: 'ok' })
  })
})

describe('readPanelSnapshot — issue page ceiling (F7)', () => {
  it('asks the issues view for the full page so the milestone severity join is not truncated', async () => {
    const harnessDir = await activeHarness()
    const seen: (Record<string, string | undefined> | undefined)[] = []
    const real = engine.readDashboardView
    const spy = spyOn(engine, 'readDashboardView').mockImplementation(async (input) => {
      if (input.view === 'issues') seen.push(input.params)
      return await real(input)
    })

    await readPanelSnapshot({ harnessDir, projectId: 'proj-x' })
    spy.mockRestore()

    // The engine's documented ceiling, asked for explicitly: the default 50-row
    // page would silently render every further issue as unknown severity.
    expect(seen).toEqual([{ project: 'proj-x', limit: '200' }])
  })
})
