/**
 * Panel UI tests for the three-tab, store-backed panel.
 *
 * The suite pins the T6 contract:
 * 1. the three tabs render in the declared order (任务迭代 / 项目路线图 /
 *    事件记录) and the store REFUSES the retired `'agents'` id;
 * 2. the roadmap page renders direction + goals + milestones with their nested
 *    issues — and its FOUR absence states each with a distinct anchor;
 * 3. the events page renders ONE time-descending flow holding dispatch, settle
 *    and violation rows;
 * 4. every degraded state renders its own anchor and copy (nothing is
 *    collapsed into a generic "empty", a failed read is never data).
 *
 * The pages are pure renders of the projection, so the suite renders them with
 * a key-echoing `t` seat: assertions target ANCHORS and data attributes (the
 * stable contract), never localized copy.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'
import { projectGraph } from '../src/client/panel/graph/project-graph.ts'
import { EventLogPage } from '../src/client/panel/pages/EventLogPage.tsx'
import { RoadmapPage } from '../src/client/panel/pages/RoadmapPage.tsx'
import { PanelContent } from '../src/client/panel/PanelView.tsx'
import { TabNav } from '../src/client/panel/TabNav.tsx'
import { isPanelSection } from '../src/client/panel/panel-store.ts'

/** Key-echoing translate seat: the markup carries the KEY, so no copy is pinned. */
const t = ((key: string) => key) as unknown as TranslateNS<'mstar-panel'>

/** Render one element to static markup under the key-echoing seat. */
function html(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element)
}

/* ------------------------------- fixtures ------------------------------- */

type Member = { state: 'ok'; data: unknown } | { state: 'not-applicable' | 'unavailable'; reason: string }

const ok = (data: unknown): Member => ({ state: 'ok', data })

/** A snapshot with readable, mostly-empty workspace views. */
function snapshot(over: { roadmap?: Member; ledger?: unknown; issues?: Member; retained?: unknown } = {}): PanelSnapshot {
  return {
    at: '2026-10-22T01:00:00.000Z',
    version: '4.0.4',
    harnessDir: '/proj/.mstar',
    enforcement: { hard: true, source: 'compass' },
    workspace: {
      workflow: ok({
        id: 'wf-1',
        status: 'running',
        branch: { base: 'main', source: 'feature/x', integration: 'feature/x', target: 'main' },
        plans: [
          { planId: 'p-todo', status: 'Todo', doneAt: null },
          { planId: 'p-run', status: 'InProgress', doneAt: null },
        ],
      }),
      iteration: ok({ iterationId: 'iter-1', compass: { status: 'active' }, plans: [] }),
      roadmap: over.roadmap ?? { state: 'not-applicable', reason: 'no project resolved' },
      issues: over.issues ?? ok({ items: [], total: 0, storeRevision: 1 }),
      projects: ok({ items: [], total: 0 }),
    },
    retained: over.retained ?? {
      iterationGate: {
        iterationId: 'iter-1',
        compassPath: 'iterations/iter-1/delivery-compass.md',
        compassStatus: 'locked',
        gate: { transition: 'phase-2-execute', ok: false, violations: [{ severity: 'high', code: 'gate.x', message: 'nope' }] },
      },
      knowledge: null,
      selection: null,
      at: null,
    },
    ledger: over.ledger === undefined ? { events: [], summary: [] } : over.ledger,
  } as unknown as PanelSnapshot
}

/** A roadmap member carrying content + one milestone with one open issue. */
function fullRoadmap(): Member {
  return ok({
    projectId: 'proj-1',
    authority: { state: 'present', revision: 3, contentHash: 'h' },
    content: {
      contentMarkdown: '# roadmap',
      frontmatter: {},
      direction: 'ship the store-backed panel',
      goals: [{ ordinal: 1, parentOrdinal: null, checked: true, title: 'retire the relay', body: '' }],
      milestones: [],
      sections: [],
    },
    milestones: {
      projectId: 'proj-1',
      milestones: [{ milestoneId: 'm-1', name: 'Store reads', target: '2026-11-01', status: 'active', ordinal: 1 }],
      issues: [{ id: 'i-1', title: 'panel empty', acceptance: 'renders', disposition: 'open', revision: 1, milestoneId: 'm-1' }],
      unassignedIssues: 2,
    },
  })
}

const ISSUES = ok({
  items: [{ id: 'i-1', title: 'panel empty', severity: 'high', disposition: 'open', projectId: 'proj-1' }],
  total: 1,
  storeRevision: 2,
})

/** A ledger with a settle, a dispatch and a workflow row. */
const LEDGER = {
  summary: [],
  events: [
    { ts: 3_000, kind: 'settle', agent: 's-1', role: 'frontend-dev', planId: 'p', taskId: '1', outcome: 'ok', paired: true },
    { ts: 1_000, kind: 'dispatch', agent: 's-1', role: 'frontend-dev', planId: 'p', taskId: '1', verdict: 'ok' },
    { ts: 2_000, kind: 'workflow-run', runId: 'run-1', name: 'panel rework' },
  ],
}

/* ------------------------------- 1. tabs + store ------------------------------- */

describe('panel tabs (T6)', () => {
  it('renders the three tabs in the declared order', () => {
    const markup = html(createElement(TabNav, { active: 'tasks', onChange: () => {}, t }))
    expect(Array.from(markup.matchAll(/data-mstar-tab="([a-z]+)"/g), (m) => m[1])).toEqual(['tasks', 'roadmap', 'events'])
    // Activation state rides its own anchor.
    expect(markup).toContain('data-mstar-tab-active="true"')
  })

  it('the store refuses the retired agents section', () => {
    expect(isPanelSection('agents')).toBe(false)
    expect(isPanelSection('tasks')).toBe(true)
    expect(isPanelSection('roadmap')).toBe(true)
    expect(isPanelSection('events')).toBe(true)
  })
})

/* ------------------------------- 2. roadmap page ------------------------------- */

describe('roadmap page (T6)', () => {
  it('renders direction, goals and milestones with their nested issues', () => {
    const markup = html(createElement(RoadmapPage, { view: projectGraph(snapshot({ roadmap: fullRoadmap(), issues: ISSUES })).roadmap, t }))
    expect(markup).toContain('data-mstar-page="roadmap"')
    expect(markup).toContain('data-roadmap-state="ok"')
    expect(markup).toContain('data-roadmap-direction')
    expect(markup).toContain('ship the store-backed panel')
    expect(markup).toContain('data-roadmap-goals')
    expect(markup).toContain('data-roadmap-goal="1"')
    expect(markup).toContain('data-roadmap-goal-checked="true"')
    expect(markup).toContain('data-roadmap-milestones')
    expect(markup).toContain('data-roadmap-milestone="0"')
    expect(markup).toContain('data-roadmap-milestone-target="2026-11-01"')
    // The nested issue carries its id, severity chip and title.
    expect(markup).toContain('data-roadmap-issue="i-1"')
    expect(markup).toContain('data-roadmap-issue-severity="high"')
    // The unassigned count is its own trailing line.
    expect(markup).toContain('data-roadmap-unassigned="2"')
  })

  it('its four absence states each render a DIFFERENT anchor', () => {
    const notApplicable = html(createElement(RoadmapPage, { view: projectGraph(snapshot({ roadmap: { state: 'not-applicable', reason: 'no project resolved' } })).roadmap, t }))
    expect(notApplicable).toContain('data-roadmap-state="not-applicable"')
    expect(notApplicable).toContain('data-roadmap-not-applicable')

    const absent = html(createElement(RoadmapPage, { view: projectGraph(snapshot({ roadmap: ok(null) })).roadmap, t }))
    expect(absent).toContain('data-roadmap-state="absent"')
    expect(absent).toContain('data-roadmap-absent')

    const noMilestones = html(createElement(RoadmapPage, { view: projectGraph(snapshot({ roadmap: ok({ projectId: 'p', content: { direction: 'd', goals: [] }, milestones: { milestones: [], issues: [], unassignedIssues: 0 } }) })).roadmap, t }))
    expect(noMilestones).toContain('data-roadmap-state="no-milestones"')
    expect(noMilestones).toContain('data-roadmap-empty="no-milestones"')

    const unavailable = html(createElement(RoadmapPage, { view: projectGraph(snapshot({ roadmap: { state: 'unavailable', reason: 'store.not-active: staged' } })).roadmap, t }))
    expect(unavailable).toContain('data-roadmap-state="unavailable"')
    expect(unavailable).toContain('data-roadmap-unavailable')
    // The store's own refusal text reaches the DOM verbatim.
    expect(unavailable).toContain('data-roadmap-reason="store.not-active: staged"')

    // Four distinct states, not one "empty" branch.
    const states = new Set([notApplicable, absent, noMilestones, unavailable].map((m) => m.match(/data-roadmap-state="([a-z-]+)"/i)![1]))
    expect(states.size).toBe(4)
  })
})

/* ------------------------------- 3. events page ------------------------------- */

describe('events page (T6)', () => {
  it('renders ONE time-descending flow carrying dispatch, settle and violation rows', () => {
    const markup = html(createElement(EventLogPage, { view: projectGraph(snapshot({ ledger: LEDGER })), t }))
    expect(markup).toContain('data-mstar-page="events"')
    // One list — no per-partition scroller and no section split.
    expect(markup.match(/data-event-log-flow/g)).toHaveLength(1)
    const kinds = Array.from(markup.matchAll(/data-event-log-row-kind="([a-z]+)"/g), (m) => m[1])
    expect(kinds).toEqual(['settle', 'dispatch', 'dispatch', 'violation'])
    // The settle row is the newest; the violation carries no time (「—」).
    expect(markup).toContain('data-event-log-time="00:00:03"')
    expect(markup).toContain('data-event-log-missing="true"')
  })

  it('an unavailable ledger and an empty ledger are DIFFERENT states', () => {
    const broken = html(createElement(EventLogPage, { view: projectGraph(snapshot({ ledger: null, roadmap: ok(null) })), t }))
    expect(broken).toContain('data-event-log-ledger="unavailable"')
    expect(broken).not.toContain('data-event-log-empty')

    // A readable ledger with no rows and no violations: the "recording started" state.
    const empty = html(createElement(EventLogPage, {
      view: projectGraph(snapshot({ retained: { iterationGate: null, knowledge: null, selection: null, at: null } })),
      t,
    }))
    expect(empty).toContain('data-event-log-empty="no-events"')
    expect(empty).not.toContain('data-event-log-ledger')
  })
})

/* ------------------------------- 4. section routing ------------------------------- */

describe('section routing (T6)', () => {
  it('routes each of the three sections to its own page', () => {
    const snap = snapshot({ roadmap: fullRoadmap(), issues: ISSUES })
    expect(html(createElement(PanelContent, { section: 'roadmap', view: projectGraph(snap), t }))).toContain('data-mstar-page="roadmap"')
    expect(html(createElement(PanelContent, { section: 'events', view: projectGraph(snap), t }))).toContain('data-mstar-page="events"')
    expect(html(createElement(PanelContent, { section: 'tasks', view: projectGraph(snap), t }))).toContain('data-mstar-page="tasks"')
  })

  it('a degraded read still renders the page, with its own copy', () => {
    const degraded = snapshot({ roadmap: { state: 'unavailable', reason: 'boom' }, ledger: null })
    expect(html(createElement(PanelContent, { section: 'roadmap', view: projectGraph(degraded), t }))).toContain('data-roadmap-unavailable')
    expect(html(createElement(PanelContent, { section: 'events', view: projectGraph(degraded), t }))).toContain('data-event-log-ledger')
    // The tasks page keeps rendering its board from the workspace DTOs.
    expect(html(createElement(PanelContent, { section: 'tasks', view: projectGraph(degraded), t }))).toContain('data-mstar-page="tasks"')
  })
})
