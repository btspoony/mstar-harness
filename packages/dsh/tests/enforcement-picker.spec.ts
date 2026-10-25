/**
 * Task 6: the two preserved host behaviours — the enforcement line (one literal
 * flag, or its own `unavailable` arm) and the workflow picker's mount point
 * inside `Focus`.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PanelShell } from '../src/client/panel/panel-shell.tsx'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'

const PKG_DIR = `${import.meta.dir}/..`

const SNAPSHOT = {
  enforcement: { hard: true, source: 'compass' },
  knowledge: { docCount: 41, categories: ['specs'] },
  selection: { kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' },
  iteration: { state: 'not-applicable', reason: 'standalone' },
} as unknown as PanelSnapshot

const WORKFLOW = {
  id: 'wf-1',
  type: 'plan',
  status: 'running',
  phase: 'phase-2-execute',
  branch: { base: 'main', source: 'feature/x', integration: null, target: 'main' },
  plans: [{ planId: 'p-1', status: 'InProgress', progress: 'writing the bridge' }],
}

function render(over: {
  snapshot?: PanelSnapshot
  scheme?: 'light' | 'dark'
  enforcementLine?: boolean
  select?: ((workflowId: string) => void) | null
} = {}): string {
  return renderToStaticMarkup(
    createElement(PanelShell, {
      snapshot: over.snapshot ?? SNAPSHOT,
      workflow: { state: 'read', data: WORKFLOW as never },
      destination: 'focus',
      locale: 'en',
      ...(over.scheme === undefined ? {} : { scheme: over.scheme }),
      navLabel: 'Morning Star Workflow',
      onSelect: () => {},
      select: over.select ?? null,
      ...(over.enforcementLine === true ? { enforcementLine: true } : {}),
    }),
  )
}

/* ------------------- Task 6 — the enforcement line ------------------- */

describe('enforcement line — one literal flag, or its own unavailable arm', () => {
  it('renders `hard` and `soft` as the literal enum with the status treatment', () => {
    const hard = render({ enforcementLine: true })
    expect(hard).toContain('data-ms-enforcement-line="hard"')
    expect(hard).toContain('Enforcement hard')
    expect(hard).toContain('data-ms-tone="warning"')

    const soft = render({ snapshot: { ...SNAPSHOT, enforcement: { hard: false, source: 'compass' } } as unknown as PanelSnapshot, enforcementLine: true })
    expect(soft).toContain('data-ms-enforcement-line="soft"')
    expect(soft).toContain('Enforcement soft')
    expect(soft).not.toContain('data-ms-enforcement-line="hard"')
  })

  it('an unreadable member renders its own unavailable line, never a guessed soft', () => {
    const markup = render({ snapshot: { ...SNAPSHOT, enforcement: null } as unknown as PanelSnapshot, enforcementLine: true })
    expect(markup).toContain('data-ms-enforcement-line="unavailable"')
    expect(markup).not.toContain('data-ms-enforcement-line="soft"')
    expect(markup).not.toContain('data-ms-enforcement-line="hard"')
    // The shared screen's own line says the same thing rather than guessing.
    expect(markup).toContain('Enforcement unavailable')
  })

  it('renders no knowledge count, categories or inventory (D30)', () => {
    const markup = render({ enforcementLine: true })
    expect(markup).not.toContain('data-ms-knowledge')
    expect(markup).not.toContain('41')
    expect(markup).not.toContain('docCount')
    expect(markup).not.toContain('specs')
  })

  it('the main-area seat renders no enforcement line (session chrome only)', () => {
    expect(render()).not.toContain('data-ms-enforcement-line')
  })
})

/* --------------------- Task 6 — the picker mount point --------------------- */

describe('workflow picker — mounted inside Focus, unchanged behaviour', () => {
  it('mounts the picker in the Focus destination, above the plan board', () => {
    const markup = render({
      snapshot: {
        ...SNAPSHOT,
        selection: { kind: 'error', code: 'workflow.multi-active', message: 'two active', activeWorkflowIds: ['wf-a', 'wf-b'] },
      } as unknown as PanelSnapshot,
      select: () => {},
      enforcementLine: true,
    })
    const focusAt = markup.indexOf('data-ms-screen="focus"')
    const pickerAt = markup.indexOf('data-ms-picker')
    const boardAt = markup.indexOf('data-ms-board"') === -1 ? markup.indexOf('ms-focus-board') : markup.indexOf('data-ms-board"')
    expect(focusAt).toBeGreaterThan(-1)
    expect(pickerAt).toBeGreaterThan(focusAt)
    expect(pickerAt).toBeLessThan(boardAt)
    expect(markup).toContain('wf-a')
    expect(markup).toContain('wf-b')
  })

  it('renders the unbound picker without a host commit function (the shared screen owns its visibility)', () => {
    // The picker's VISIBILITY is the shared screen's decision (it renders the
    // candidates the selection union carries); the host supplies the commit seat
    // or nothing. With nothing, the screen still renders and the plugin crashes
    // nowhere: hardening the affordance belongs to `@mstar-harness/ui`, which is
    // merged and out of this plan's scope.
    const markup = render({
      snapshot: {
        ...SNAPSHOT,
        selection: { kind: 'error', code: 'x', message: 'y', activeWorkflowIds: ['wf-a'] },
      } as unknown as PanelSnapshot,
      select: null,
    })
    expect(markup).toContain('data-ms-picker')
    expect(markup).toContain('wf-a')
  })
})
