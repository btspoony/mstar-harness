/**
 * Projection tests for the store-backed panel: `projectGraph(snapshot)` maps
 * one `PanelSnapshot` onto the zone view model.
 *
 * The suite pins the T5 contract's bullets, one named case each:
 * 1. the agents zone is GONE (runtime key + type-level member assertion);
 * 2. the roadmap zone keeps its three READ states apart — and its two `ok`
 *    sub-states (no roadmap row / a roadmap with zero milestones);
 * 3. the roadmap renders direction + goals + milestones with nested issues;
 * 4. the event flow is ONE time-descending list carrying dispatch, settle and
 *    violation rows;
 * 5. a missing ledger degrades the events zone ALONE (the task board still
 *    renders from the workspace DTOs);
 * 6. a refused roadmap read keeps the other zones intact;
 * 7. the projection is total: a null snapshot and garbage members degrade,
 *    never throw.
 */

import { describe, expect, it } from 'bun:test'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'
import { projectGraph, type ZoneView } from '../src/client/panel/graph/project-graph.ts'
import { parsePanelSnapshotRead } from '../src/client/panel/panel-snapshot-client.ts'

/* ------------------------------- fixtures ------------------------------- */

type Member = { state: 'ok'; data: unknown } | { state: 'not-applicable' | 'unavailable'; reason: string }

/** One guarded workspace member. */
function ok(data: unknown): Member {
  return { state: 'ok', data }
}

const NOT_APPLICABLE = (reason: string): Member => ({ state: 'not-applicable', reason })
const UNAVAILABLE = (reason: string): Member => ({ state: 'unavailable', reason })

const NO_PROJECT = NOT_APPLICABLE('no project resolved')

/** A full snapshot with every workspace member defaulted to a readable answer. */
function snapshot(over: {
  workflow?: Member
  iteration?: Member
  roadmap?: Member
  issues?: Member
  projects?: Member
  retained?: unknown
  ledger?: unknown
} = {}): PanelSnapshot {
  return {
    at: '2026-10-22T01:00:00.000Z',
    version: '4.0.4',
    harnessDir: '/proj/.mstar',
    enforcement: { hard: true, source: 'compass' },
    workspace: {
      workflow: over.workflow ?? ok({
        id: 'wf-1',
        status: 'running',
        branch: { base: 'main', source: 'feature/x', integration: 'feature/x', target: 'main' },
        plans: [
          { planId: 'p-todo', status: 'Todo', doneAt: null },
          { planId: 'p-run', status: 'InProgress', doneAt: null },
          { planId: 'p-done-old', status: 'Done', doneAt: '2026-01-01' },
          { planId: 'p-done-new', status: 'Done', doneAt: '2026-09-30' },
          { planId: 'p-blocked', status: 'Blocked', doneAt: null },
          { planId: 'p-weird', status: 'Paused', doneAt: null },
        ],
      }),
      iteration: over.iteration ?? ok({ iterationId: 'iter-1', compass: { status: 'active' }, plans: [] }),
      roadmap: over.roadmap ?? NO_PROJECT,
      issues: over.issues ?? ok({ items: [], total: 0, storeRevision: 1 }),
      projects: over.projects ?? ok({ items: [], total: 0 }),
    },
    retained: over.retained ?? {
      iterationGate: {
        iterationId: 'iter-1',
        compassPath: 'iterations/iter-1/delivery-compass.md',
        compassStatus: 'locked',
        gate: { transition: 'phase-2-execute', ok: false, violations: [] },
      },
      knowledge: null,
      selection: null,
    },
    ledger: over.ledger === undefined ? { events: [], summary: [] } : over.ledger,
  } as unknown as PanelSnapshot
}

/** A roadmap DTO (the engine's `RoadmapDTO`, structurally). */
function roadmapDto(over: { direction?: string | null; goals?: unknown[]; milestones?: unknown[]; issues?: unknown[] } = {}) {
  return ok({
    projectId: 'proj-1',
    authority: { state: 'present', revision: 3, contentHash: 'h' },
    content: {
      contentMarkdown: '# roadmap',
      frontmatter: {},
      direction: over.direction === undefined ? 'ship the store-backed panel' : over.direction,
      goals: over.goals ?? [
        { ordinal: 1, parentOrdinal: null, checked: true, title: 'retire the relay', body: '' },
        { ordinal: 2, parentOrdinal: 1, checked: false, title: 'three tabs', body: '' },
      ],
      milestones: [],
      sections: [],
    },
    milestones: {
      projectId: 'proj-1',
      milestones: over.milestones ?? [
        {
          milestoneId: 'm-1', projectId: 'proj-1', name: 'Store reads', target: '2026-11-01', status: 'active',
          ordinal: 1, revision: 1, createdAt: '', updatedAt: '',
          totalIssues: 2, openIssues: 1, resolvedIssues: 1, otherRetiredIssues: 0,
        },
      ],
      issues: over.issues ?? [
        { id: 'i-1', title: 'panel empty', acceptance: 'renders', disposition: 'open', revision: 1, milestoneId: 'm-1' },
        { id: 'i-2', title: 'already fixed', acceptance: 'renders', disposition: 'resolved', revision: 1, milestoneId: 'm-1' },
      ],
      unassignedIssues: 2,
    },
  })
}

/** The issues view the roadmap joins severity from. */
const ISSUES = ok({
  items: [
    { id: 'i-1', title: 'panel empty', severity: 'high', disposition: 'open', projectId: 'proj-1' },
    { id: 'i-2', title: 'already fixed', severity: 'low', disposition: 'resolved', projectId: 'proj-1' },
    { id: 'i-3', title: 'other bug', severity: 'high', disposition: 'open', projectId: 'proj-1' },
  ],
  total: 3,
  storeRevision: 4,
})

/* ------------------------------- 1. agents gone ------------------------------- */

describe('projectGraph — the agents zone is retired (T5)', () => {
  it('1. ZoneView carries no agents member, at runtime and at the type level', () => {
    const view = projectGraph(snapshot())
    expect(Object.hasOwn(view, 'agents')).toBe(false)
    // Type-level assertion: if `agents` ever returns to ZoneView this line stops compiling.
    const hasAgents: 'agents' extends keyof ZoneView ? true : false = false
    expect(hasAgents).toBe(false)
  })
})

/* ------------------------------- 2. roadmap read states ------------------------------- */

describe('projectGraph — roadmap zone: four distinct absence states (T5)', () => {
  it('2a. no project resolved → not-applicable with its reason, and NOT "no roadmap"', () => {
    const view = projectGraph(snapshot({ roadmap: NOT_APPLICABLE('no project resolved') }))
    expect(view.roadmap.state).toBe('not-applicable')
    expect(view.roadmap.reason).toBe('no project resolved')
    expect(view.roadmap.present).toBe(false)
    expect(view.project.roadmapSource.kind).toBe('absent')
  })

  it('2b. project resolved, no roadmap row → ok with data null', () => {
    const view = projectGraph(snapshot({ roadmap: ok(null) }))
    expect(view.roadmap.state).toBe('ok')
    expect(view.roadmap.present).toBe(false)
    expect(view.roadmap.direction).toBeNull()
    expect(view.roadmap.milestones).toEqual([])
  })

  it('2c. a roadmap with zero milestones is a DIFFERENT state from "no roadmap"', () => {
    const view = projectGraph(snapshot({
      roadmap: roadmapDto({ goals: [], milestones: [] }),
      issues: ISSUES,
    }))
    expect(view.roadmap.state).toBe('ok')
    expect(view.roadmap.present).toBe(true)
    expect(view.roadmap.milestones).toEqual([])
    expect(view.roadmap.direction).toBe('ship the store-backed panel')
  })

  it('2d. a refused read → unavailable carrying the store reason', () => {
    const view = projectGraph(snapshot({ roadmap: UNAVAILABLE('store.not-active: store is staged') }))
    expect(view.roadmap.state).toBe('unavailable')
    expect(view.roadmap.reason).toBe('store.not-active: store is staged')
    expect(view.project.roadmapSource.kind).toBe('unavailable')
    expect(view.project.roadmapSource.diagnostic).toBe('store.not-active: store is staged')
  })
})

/* ------------------------------- 3. roadmap content ------------------------------- */

describe('projectGraph — roadmap content (T5)', () => {
  it('3. renders direction, goals (with nesting) and milestones with their OPEN issues', () => {
    const view = projectGraph(snapshot({ roadmap: roadmapDto(), issues: ISSUES }))

    expect(view.roadmap.direction).toBe('ship the store-backed panel')
    expect(view.roadmap.goals).toEqual([
      { ordinal: 1, parentOrdinal: null, checked: true, title: 'retire the relay' },
      { ordinal: 2, parentOrdinal: 1, checked: false, title: 'three tabs' },
    ])
    expect(view.roadmap.milestones).toHaveLength(1)
    expect(view.roadmap.milestones[0]).toEqual({
      name: 'Store reads',
      target: '2026-11-01',
      status: 'active',
      // Only OPEN membership; severity joined from the issues view by id.
      issues: [{ id: 'i-1', title: 'panel empty', severity: 'high' }],
    })
    expect(view.roadmap.unassignedIssues).toBe(2)
    // The rollup mirrors the milestone names.
    expect(view.project.milestones).toEqual(['Store reads'])
    // Open residuals are counted from the issues view (zero counts omitted).
    expect(view.project.openResiduals).toEqual([{ severity: 'high', count: 2 }])
  })
})

/** The retained block with one gate violation (the merged flow's third kind). */
const RETAINED_WITH_VIOLATION = {
  iterationGate: {
    iterationId: 'iter-1',
    compassPath: 'iterations/iter-1/delivery-compass.md',
    compassStatus: 'locked',
    gate: {
      transition: 'phase-2-execute',
      ok: false,
      violations: [{ severity: 'high', code: 'gate.x', message: 'nope' }],
    },
  },
  knowledge: null,
  selection: null,
}

/* ------------------------------- 4. merged event flow ------------------------------- */

describe('projectGraph — one merged event flow (T5)', () => {
  it('4. dispatch + settle + violation rows share ONE time-descending list', () => {
    const view = projectGraph(snapshot({
      retained: RETAINED_WITH_VIOLATION,
      ledger: {
        summary: [],
        events: [
          { ts: 3_000, kind: 'settle', agent: 's-1', role: 'frontend-dev', planId: 'p', taskId: '1', outcome: 'ok', durationMs: 12, paired: true },
          { ts: 1_000, kind: 'dispatch', agent: 's-1', role: 'frontend-dev', planId: 'p', taskId: '1', taskCategory: 'visual', verdict: 'ok' },
          { ts: 2_000, kind: 'workflow-run', runId: 'run-1', name: 'panel rework' },
        ],
      },
    }))
    expect(view.events.map((e) => [e.kind, e.ts])).toEqual([
      ['settle', 3_000],
      ['dispatch', 2_000],
      ['dispatch', 1_000],
      ['violation', 0],
    ])
    // The badge is merged; the ledger kind stays verbatim for the row detail.
    expect(view.events.map((e) => e.ledgerKind)).toEqual(['settle', 'workflow-run', 'dispatch', ''])
    // The violation row carries the gate's own evidence and NO invented time.
    expect(view.events[3]).toMatchObject({ severity: 'high', code: 'gate.x', message: 'nope' })
    // The dispatch paired with the settle is marked settled.
    expect(view.events[2]!.settled).toBe(true)
    expect(view.events[3]!.ts).toBe(0)
  })
})

/* ------------------------------- 5/6. per-zone degradation ------------------------------- */

describe('projectGraph — per-zone degradation (T5)', () => {
  it('5. a missing ledger degrades ONLY the events zone', () => {
    const view = projectGraph(snapshot({ ledger: null }))
    expect(view.degraded.ledger).toBe(true)
    expect(view.events).toEqual([])
    // The task board still rendered from the workspace DTOs.
    expect(view.degraded.plans).toBe(false)
    expect(view.tasks.total).toBe(6)
    expect(view.tasks.columns.find((c) => c.id === 'InProgress')!.count).toBe(1)
  })

  it('5b. an empty (but present) ledger is DATA, not degradation', () => {
    const view = projectGraph(snapshot({ ledger: { events: [], summary: [] } }))
    expect(view.degraded.ledger).toBe(false)
    expect(view.events).toEqual([])
  })

  it('6. a refused roadmap read keeps the iteration and task zones intact', () => {
    const view = projectGraph(snapshot({ roadmap: UNAVAILABLE('boom') }))
    expect(view.roadmap.state).toBe('unavailable')
    expect(view.iteration.active).toBe(true)
    expect(view.iteration.currentStep).toBe(2)
    expect(view.tasks.total).toBe(6)
  })
})

/* ------------------------------- 7. totality ------------------------------- */

describe('projectGraph — total function (T5)', () => {
  it('7. a null snapshot degrades every zone without throwing', () => {
    const view = projectGraph(null)
    expect(view.iteration.active).toBe(false)
    expect(view.iteration.steps).toHaveLength(5)
    expect(view.tasks.total).toBe(0)
    expect(view.tasks.columns).toHaveLength(5)
    expect(view.roadmap.state).toBe('unavailable')
    expect(view.events).toEqual([])
    expect(view.degraded.ledger).toBe(true)
    expect(view.degraded.plans).toBe(true)
  })

  it('7b. garbage members and ledger rows degrade field by field', () => {
    const view = projectGraph({
      at: 'x',
      workspace: {
        workflow: { state: 'ok', data: { plans: [null, {}, { planId: 7, status: 9 }] } },
        iteration: { state: 'ok', data: null },
        roadmap: { state: 'ok', data: { content: 'not-an-object', milestones: 'nope' } },
        issues: { state: 'ok', data: { items: [null, { id: 'i', severity: 5, disposition: 'open' }] } },
        projects: { state: 'ok', data: {} },
      },
      retained: { iterationGate: { gate: { transition: 'phase-9-nope' } } },
      ledger: { events: [null, {}, { ts: 'x', kind: 'settle' }] },
    } as unknown as PanelSnapshot)
    expect(view.iteration.active).toBe(false)
    expect(view.tasks.total).toBe(3)
    expect(view.roadmap.state).toBe('ok')
    expect(view.roadmap.milestones).toEqual([])
    // A settle row with no identity still renders (degraded fields, never dropped).
    expect(view.events).toHaveLength(1)
    expect(view.events[0]!.kind).toBe('settle')
  })
})

/* --------------------- the wire envelope the projection needs --------------------- */

/**
 * QC round 2: the projection reads its members through their declared types with
 * no optional chaining on the members themselves, so the WIRE PARSE BOUNDARY must
 * refuse an `ok` answer that omits them. Otherwise `{kind:'ok', snapshot:{at:'x'}}`
 * reaches `projectGraph` and the whole panel throws.
 */
describe('projectGraph — the parse boundary owns the envelope', () => {
  /** A complete, well-formed `ok` answer — the control. */
  function completeSnapshot(): PanelSnapshot {
    return snapshot({})
  }

  it('a member-less ok answer parses to unavailable, never a half-parsed snapshot', () => {
    const parsed = parsePanelSnapshotRead({ kind: 'ok', snapshot: { at: '2026-10-22T00:00:00.000Z' } })
    expect(parsed.kind).toBe('unavailable')
    expect(parsed.kind === 'unavailable' ? parsed.reason : null).toBe('malformed-answer')
    // …so the panel renders the degraded branch: the projection gets null, not junk.
    expect(() => projectGraph(parsed.kind === 'ok' ? parsed.snapshot : null)).not.toThrow()
  })

  it('every mandatory member is enforced — dropping any ONE parses to unavailable', () => {
    const full = completeSnapshot()
    const variants: Record<string, unknown> = {
      'no workspace': { ...full, workspace: undefined },
      'workspace not an object': { ...full, workspace: 'nope' },
      'one workspace member missing': { ...full, workspace: { ...full.workspace, issues: undefined } },
      'one workspace member is not a read': { ...full, workspace: { ...full.workspace, projects: { state: 'boom' } } },
      'no retained': { ...full, retained: undefined },
      'retained not an object': { ...full, retained: 'nope' },
      'no ledger key': { ...full, ledger: undefined },
      'ledger without its events array': { ...full, ledger: { events: 'nope' } },
      'no timestamp': { ...full, at: '' },
    }
    for (const [name, shape] of Object.entries(variants)) {
      const parsed = parsePanelSnapshotRead({ kind: 'ok', snapshot: shape })
      expect({ name, kind: parsed.kind }).toEqual({ name, kind: 'unavailable' })
    }
    // The control is ACCEPTED, so the cases above fail for the reason they name.
    expect(parsePanelSnapshotRead({ kind: 'ok', snapshot: full }).kind).toBe('ok')
  })

  it('a null ledger is legal — an advisory read that did not answer is not malformed', () => {
    const parsed = parsePanelSnapshotRead({ kind: 'ok', snapshot: { ...completeSnapshot(), ledger: null } })
    expect(parsed.kind).toBe('ok')
  })
})
