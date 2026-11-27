/** see packages/dsh/tests/project-detail.spec.ts - `project-detail` — the product's only hierarchy page (final round). The milestone rollup is the page's default body, read from the project-scoped `milestones` view (collaboration data only, so it answers without an execution store); the adapter owns the list-FEATURE state: the fixed two tabs, `Issues` the default, and each tab's body from its own project-scoped read. */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { en as uiEn } from '@mstar-harness/ui'
import { ProjectDetailDestination } from '../src/client/panel/destinations.tsx'

const projection = { generation: 1, freshness: 'current', builtAt: null, checkedAt: '', diagnostics: [] }
const envelope = (data: unknown) => ({ kind: 'ok' as const, envelope: { data, projection } })

/** see packages/engine/src/store-read.ts - the project-detail read answers the milestone grouping. */
const MILESTONES = { projectId: 'proj-1', milestones: [], issues: [], unassignedIssues: 0 }

const PROJECTS = {
  items: [
    {
      project: { id: 'proj-1', title: 'Project One', description: null, lifecycle: 'active' },
      openIssues: 1,
    },
  ],
  total: 1,
}

const ISSUES = { items: [{ id: 'I-1', title: 'a project issue', severity: 'high', disposition: 'open', projectId: 'proj-1' }], total: 1, storeRevision: 2 }

function render(over: { issues?: unknown; feature?: string; projects?: unknown } = {}): string {
  return renderToStaticMarkup(createElement(ProjectDetailDestination, {
    id: 'proj-1',
    state: envelope(MILESTONES),
    locale: 'en',
    onBack: () => {},
    issues: envelope(over.issues ?? ISSUES),
    iterations: envelope({ items: [], total: 0, attribution: 'absent' }),
    ...(over.projects === undefined ? {} : { projects: envelope(over.projects) }),
    ...(over.feature === undefined ? {} : { initialFeature: over.feature }),
  } as never))
}

describe('project detail — the milestone body, two tabs, Issues the default', () => {
  it('renders the milestone body and the fixed two features', () => {
    const markup = render()
    expect(markup).toContain('data-ms-screen="project-detail"')
    expect(markup).toContain(uiEn.projectDetail.milestones.milestonesHeading)
    expect(markup).toContain(uiEn.projectDetail.features.issues)
    expect(markup).toContain(uiEn.projectDetail.features.iterations)
    // see packages/dsh/tests/project-detail.spec.ts - // No tab, route or label named roadmap survives.
    expect(markup).not.toContain('Roadmap')
    // see packages/dsh/tests/project-detail.spec.ts - // Issues is the default feature: the project's issue list IS the body under it.
    expect(markup).toContain('a project issue')
  })

  it('the Iterations tab renders that project’s iteration list', () => {
    const markup = render({ feature: 'iterations' })
    expect(markup).toContain('data-ms-screen="project-detail"')
    expect(markup).toContain('data-ms-feature="iterations"')
  })

  it('the milestone body stays mounted whichever feature is selected', () => {
    const markup = render({ feature: 'iterations' })
    expect(markup).toContain(uiEn.projectDetail.milestones.milestonesHeading)
  })
})

describe('project detail — one absence authority and the degraded member arms', () => {
  const renderState = (state: unknown, over: { issues?: unknown; feature?: string } = {}) =>
    renderToStaticMarkup(createElement(ProjectDetailDestination, {
      id: 'proj-1',
      state,
      locale: 'en',
      onBack: () => {},
      issues: over.issues ?? envelope(ISSUES),
      iterations: envelope({ items: [], total: 0, attribution: 'absent' }),
      ...(over.feature === undefined ? {} : { initialFeature: over.feature }),
    } as never))

  it('an empty milestone set answers the empty arm, never an absent one', () => {
    const markup = renderState(envelope(MILESTONES))
    expect(markup).toContain('data-ms-absence="empty"')
    expect(markup).not.toContain('data-ms-absence="absent"')
  })

  it('a degraded read keeps its own arm and reason', () => {
    // see packages/dsh/src/client/panel/destinations.tsx - the read's refusal is the page's refusal.
    const degraded = { kind: 'unavailable' as const, reason: 'the milestone read could not be completed' }
    const markup = renderState(degraded)
    expect(markup).toContain('the milestone read could not be completed')
    expect(markup).not.toContain('data-ms-absence="empty"')
  })

  it('a null payload is an unavailable milestone read, not an empty board', () => {
    const markup = renderState(envelope(null))
    expect(markup).toContain('data-ms-absence="unavailable"')
  })

  it('a successful-but-empty feature read draws an explicit empty arm', () => {
    // Red: `ReadState` returned null for an `ok` read, so the slot drew nothing.
    const markup = renderState(envelope(MILESTONES), { issues: envelope(null), feature: 'issues' })
    expect(markup).toContain('data-ms-absence="empty"')
  })

  it('the page is keyed by project, so a second project starts at the default feature', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/client/panel/destinations.tsx'), 'utf8')
    expect(source).toContain('<ProjectDetailDestination\n          key={id}')
  })
})

describe('project identity — the projects list row is the identity, not a guess', () => {
  it('a project the list carries shows the list row’s title and lifecycle', () => {
    const markup = render({ projects: PROJECTS })
    expect(markup).toContain('Project One')
    expect(markup).toContain('active')
  })

  it('a project with no list row still renders its tabs and claims nothing it does not know', () => {
    const markup = render()
    // see packages/dsh/tests/project-detail.spec.ts - // The page renders (milestone body + two features) instead of an error or a blank landmark.
    expect(markup).toContain('data-ms-screen="project-detail"')
    expect(markup).toContain(uiEn.projectDetail.features.issues)
    // see packages/dsh/tests/project-detail.spec.ts - // The fallback does not claim a lifecycle.
    expect(markup).not.toContain('active')
  })
})
