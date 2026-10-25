/**
 * The PR review's plugin findings, each with the behaviour it changed.
 *
 * Red proof for the two P1s is the mapper itself: before the fix the seat asked
 * the engine for `project-detail` (a view that does not exist) and reused the
 * delivery read (gated on a bound workflow) for the Iterations destination.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { destinationReadView, detailReadTarget } from '../src/client/panel/panel-shell.tsx'
import { parsePanelSnapshotRead } from '../src/client/panel/panel-snapshot-client.ts'
import { readDashboardView } from '@mstar-harness/engine'

const PKG_DIR = join(import.meta.dir, '..')

describe('P1 — a project opens the read that exists', () => {
  it('the engine has no project-detail view (the pre-fix request)', async () => {
    // The old mapping asked for this; the engine refuses it, so every project
    // opened an error instead of its three features.
    const refused = await readDashboardView({
      context: { harnessDir: join(PKG_DIR, '..', '..', '.does-not-exist') },
      view: 'project-detail' as never,
    }).catch((error: unknown) => error)
    expect(String(refused)).toContain('unknown dashboard view')
  })

  it('a project open reads its roadmap, scoped to the project', () => {
    expect(detailReadTarget('project-detail', 'proj-1')).toEqual({ view: 'roadmap', params: { project: 'proj-1' } })
    // Every other detail is its own view with its id.
    expect(detailReadTarget('workflow-detail', 'wf-1')).toEqual({ view: 'workflow-detail', id: 'wf-1' })
    expect(detailReadTarget('issue-detail', 'I-1')).toEqual({ view: 'issue-detail', id: 'I-1' })
  })
})

describe('P1 — the Iterations destination answers without a binding', () => {
  it('reads its own list, not the workflow-gated delivery read', () => {
    expect(destinationReadView('iterations')).toBe('iterations')
    expect(destinationReadView('overview')).toBe('overview')
    expect(destinationReadView('projects')).toBe('projects')
    // Only the session landing asks for nothing.
    expect(destinationReadView('focus')).toBeNull()
  })
})

describe('P2 — a failed enforcement read is a member, not a fatal payload', () => {
  it('accepts a digest whose enforcement member is null', () => {
    const digest = {
      kind: 'ok',
      snapshot: {
        enforcement: null,
        knowledge: null,
        selection: { kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' },
        iteration: { state: 'not-applicable', reason: 'standalone' },
      },
    }
    const read = parsePanelSnapshotRead(digest)
    expect(read.kind).toBe('ok')
    if (read.kind === 'ok') expect(read.snapshot.enforcement).toBeNull()
    // A malformed enforcement OBJECT is still refused.
    expect(parsePanelSnapshotRead({ kind: 'ok', snapshot: { ...digest.snapshot, enforcement: { hard: 'yes' } } }).kind).toBe('unavailable')
  })
})

describe('P2 — the pane declares its container', () => {
  it('the shell wrapper is the `pane` container the shared CSS keys off', () => {
    const css = readFileSync(join(PKG_DIR, 'src/client/panel/panel.module.css'), 'utf8')
    expect(css).toContain('container-type: inline-size')
    expect(css).toContain('container-name: pane')
  })
})

describe('P2 — an unreadable workflow is not a missing one', () => {
  const projection = (generation: number | null) => ({ generation, freshness: generation === null ? 'unavailable' : 'current', builtAt: null, checkedAt: '', diagnostics: [] })

  function renderDetail(state: unknown): string {
    const { createElement } = require('react') as typeof import('react')
    const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
    const { PanelShell } = require('../src/client/panel/panel-shell.tsx') as typeof import('../src/client/panel/panel-shell.tsx')
    return renderToStaticMarkup(createElement(PanelShell, {
      snapshot: {
        enforcement: { hard: false, source: 'compass' },
        knowledge: null,
        selection: null,
        iteration: { state: 'not-applicable', reason: 'standalone' },
      },
      workflow: { state: 'read', data: { id: 'wf-1', type: 'plan', status: 'running', phase: null, branch: { base: null, source: null, integration: null, target: null }, plans: [] } },
      destination: 'workflows',
      locale: 'en',
      navLabel: 'Morning Star Workflow',
      onSelect: () => {},
      select: null,
      detail: { view: 'workflow-detail', id: 'wf-1', state },
      onBack: () => {},
    } as never))
  }

  it('a null record with a published generation is ABSENT; with no generation it is UNAVAILABLE', () => {
    const absent = renderDetail({ kind: 'ok', envelope: { data: null, projection: projection(1) } })
    expect(absent).toContain('data-ms-absence="absent"')
    const unavailable = renderDetail({ kind: 'ok', envelope: { data: null, projection: projection(null) } })
    expect(unavailable).toContain('data-ms-absence="unavailable"')
    expect(unavailable).not.toContain('data-ms-absence="absent"')
  })
})
