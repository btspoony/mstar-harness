/**
 * `project-detail` — the product's only hierarchy page (final round).
 *
 * The adapter owns the FEATURE state: the fixed three tabs, `Roadmap`
 * permanently the default, and each tab's body from its own project-scoped read.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const emptyEnvelope = () => ({ kind: 'ok' as const, envelope: { data: null, projection: { generation: 1, freshness: 'current', builtAt: null, checkedAt: '', diagnostics: [] } } })

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

describe('project detail — one absence authority, an empty arm, and a per-project default', () => {
  const projectionOf = (generation: number | null) => ({ generation, freshness: generation === null ? 'unavailable' : 'current', builtAt: null, checkedAt: '', diagnostics: [] })
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

  it('an unknown project answers `absent` (the shared roadmap arm), not an error', () => {
    // Red: the pre-fix adapter answered "unavailable / no project record".
    const markup = renderState({ kind: 'ok', envelope: { data: null, projection: projectionOf(1) } })
    expect(markup).toContain('data-ms-absence="absent"')
    expect(markup).not.toContain('no project record')
  })

  it('a project read with no published generation agrees with the shared arm', () => {
    // `roadmapFeatureArm` resolves through `resolveRecord` without requiring a
    // projection, so a null project row is `absent` (the project declared no
    // roadmap) whether or not a generation was published. The dashboard maps
    // the same envelope through the same arm; this pins that they agree.
    const markup = renderState({ kind: 'ok', envelope: { data: null, projection: projectionOf(null) } })
    expect(markup).toContain('data-ms-absence="absent"')
    expect(markup).not.toContain('data-ms-absence="unavailable"')
  })

  it('a successful-but-empty feature read draws an explicit empty arm', () => {
    // Red: `ReadState` returned null for an `ok` read, so the slot drew nothing.
    const markup = renderState(envelope(ROADMAP), { issues: envelope(null), feature: 'issues' })
    expect(markup).toContain('data-ms-absence="empty"')
  })

  it('the page is keyed by project, so a second project starts at the Roadmap default', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src/client/panel/destinations.tsx'), 'utf8')
    expect(source).toContain('<ProjectDetailDestination\n          key={id}')
  })
})

describe('project identity — the catalog row is the identity, not a guess', () => {
  it('a project with a catalog row but an absent roadmap shows the catalog title and path', () => {
    // The roadmap authority is absent; the ENVELOPE still carries the catalog row.
    const markup = renderToStaticMarkup(createElement(ProjectDetailDestination, {
      id: 'proj-1',
      state: envelope({ ...ROADMAP, catalog: { ...ROADMAP.catalog, title: 'Real Project Title', lifecycle: 'archived', relativePath: 'projects/real' } }),
      locale: 'en',
      onBack: () => {},
      issues: envelope(ISSUES),
      iterations: envelope({ items: [], total: 0, attribution: 'absent' }),
    } as never))
    expect(markup).toContain('Real Project Title')
    expect(markup).toContain('projects/real')
    // Not the guessed metadata the pre-fix page printed.
    expect(markup).not.toContain('projects/proj-1')
    // The roadmap BODY's own arm is unchanged: the project declares no roadmap.
    expect(markup).toContain('data-ms-absence="absent"')
  })

  it('a project with no catalog row still renders its tabs and claims nothing it does not know', () => {
    const markup = renderToStaticMarkup(createElement(ProjectDetailDestination, {
      id: 'proj-1',
      state: emptyEnvelope(),
      locale: 'en',
      onBack: () => {},
      issues: envelope({ items: [], total: 0, storeRevision: 1 }),
      iterations: envelope({ items: [], total: 0, attribution: 'absent' }),
    } as never))
    // The page renders (three features) instead of an error or a blank landmark.
    expect(markup).toContain('data-ms-screen="project-detail"')
    expect(markup).toContain(uiEn.projectDetail.features.roadmap)
    // The fallback does not claim a lifecycle or a made-up path.
    expect(markup).not.toContain('active')
    expect(markup).not.toContain('projects/proj-1')
  })
})
