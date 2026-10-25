/**
 * Every list opens its own record type (plan dsh-panel-unification, final round).
 *
 * The lists' `onOpen` props were already on the shared screens; this suite pins
 * that the shell's `onOpen` wiring reaches Workflows and Iterations, and that an
 * open record replaces the list body.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkflowDTO } from '@mstar-harness/engine'
import { PanelShell } from '../src/client/panel/panel-shell.tsx'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'

const projection = { generation: 1, freshness: 'current', builtAt: null, checkedAt: '', diagnostics: [] }
const envelope = (data: unknown) => ({ kind: 'ok' as const, envelope: { data, projection } })

const SNAPSHOT = {
  enforcement: { hard: false, source: 'compass' },
  knowledge: null,
  selection: null,
  iteration: { state: 'not-applicable', reason: 'standalone' },
} as unknown as PanelSnapshot

const WORKFLOW = {
  id: 'wf-open',
  type: 'plan',
  status: 'running',
  phase: null,
  branch: { base: 'main', source: 's', integration: null, target: 'main' },
  plans: [],
}

function render(destination: string, detail: unknown): string {
  return renderToStaticMarkup(createElement(PanelShell, {
    snapshot: SNAPSHOT,
    workflow: { state: 'read', data: WORKFLOW as never },
    destination,
    locale: 'en',
    navLabel: 'Morning Star Workflow',
    onSelect: () => {},
    select: null,
    reads: {
      workflows: envelope({ items: [], total: 0 }),
      iterations: envelope({ items: [], total: 0, attribution: 'present' }),
    } as never,
    detail,
    onOpen: () => {},
    onBack: () => {},
  } as never))
}

describe('list → detail — the remaining lists open their record', () => {
  it('the workflow detail opens over the workflows list', () => {
    const open = render('workflows', {
      view: 'workflow-detail',
      id: 'wf-1',
      state: envelope({
        id: 'wf-1', type: 'plan', status: 'running', phase: null,
        branch: { base: 'main', source: 's', integration: null, target: 'main' },
        startedAt: null, updatedAt: null, plans: [], catalog: null, badges: [],
      } satisfies Partial<WorkflowDTO>),
    })
    expect(open).toContain('data-ms-screen="workflow-detail"')
    expect(open).not.toContain('data-ms-screen="workflows"')
  })

  it('the iteration detail opens over the iterations list', () => {
    const open = render('iterations', {
      view: 'iteration-detail',
      id: 'iter-1',
      state: envelope({ iterationId: 'iter-1', catalog: null, compass: null, workflow: null, plans: [], documents: [], gateStep: 2, badges: [] }),
    })
    expect(open).toContain('data-ms-screen="iteration-detail"')
    expect(open).not.toContain('data-ms-screen="iterations"')
  })
})
