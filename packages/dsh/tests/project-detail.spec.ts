/**
 * `project-detail` — the product's only hierarchy page (final round).
 *
 * The adapter owns the FEATURE state: the fixed three tabs, `Roadmap`
 * permanently the default, and each tab's body from its own project-scoped read.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { en as uiEn } from '@mstar-harness/ui'
import { ProjectDetailDestination } from '../src/client/panel/destinations.tsx'

const projection = { generation: 1, freshness: 'current', builtAt: null, checkedAt: '', diagnostics: [] }
const envelope = (data: unknown) => ({ kind: 'ok' as const, envelope: { data, projection } })

const ROADMAP = {
  projectId: 'proj-1',
  catalog: {
    kind: 'project', id: 'proj-1', title: 'Project One', description: null, rootKind: 'projects',
    relativePath: 'proj-1', documentKind: null, lifecycle: 'active', revision: 1,
    registeredAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  },
  authority: { state: 'absent' },
  content: null,
  milestones: { projectId: 'proj-1', milestones: [], issues: [], unassignedIssues: 0 },
}

const ISSUES = { items: [{ id: 'I-1', title: 'a project issue', severity: 'high', disposition: 'open', projectId: 'proj-1' }], total: 1, storeRevision: 2 }

function render(over: { issues?: unknown; feature?: string } = {}): string {
  return renderToStaticMarkup(createElement(ProjectDetailDestination, {
    state: envelope(ROADMAP),
    locale: 'en',
    onBack: () => {},
    issues: envelope(over.issues ?? ISSUES),
    iterations: envelope({ items: [], total: 0, attribution: 'absent' }),
    ...(over.feature === undefined ? {} : { initialFeature: over.feature }),
  } as never))
}

describe('project detail — three tabs, Roadmap the default, scoped issue list', () => {
  it('renders the fixed three features with Roadmap as the default', () => {
    const markup = render()
    expect(markup).toContain('data-ms-screen="project-detail"')
    expect(markup).toContain(uiEn.projectDetail.features.roadmap)
    expect(markup).toContain(uiEn.projectDetail.features.issues)
    expect(markup).toContain(uiEn.projectDetail.features.iterations)
    // Roadmap is the default feature: the project's issue list is NOT the body.
    expect(markup).not.toContain('a project issue')
  })

  it('the Issues tab renders that project’s issue list', () => {
    const markup = render({ feature: 'issues' })
    expect(markup).toContain('a project issue')
    expect(markup).toContain('data-ms-screen="issues"')
  })

  it('switching back to Roadmap renders the roadmap body again', () => {
    const markup = render({ feature: 'roadmap' })
    expect(markup).toContain('data-ms-screen="project-detail"')
    expect(markup).toContain(uiEn.projectDetail.features.roadmap)
    expect(markup).not.toContain('a project issue')
  })
})
