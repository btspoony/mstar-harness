/**
 * The product surface establishes the shared frame (PR 597 F1).
 *
 * The shared base layer scopes every screen-frame rule under `.ms-container`
 * (`packages/ui/src/styles/base.css`): the 1440px max width, the 14/20/16 gutter
 * and the 16px/600 title. The dashboard supplies that class on its root element.
 * This seat did not, so inside dsh the screens rendered with no frame at all —
 * the regression the review found, and one a dashboard-only render gate cannot
 * see.
 *
 * Two halves, both asserted here because neither alone is parity:
 *
 *  1. STRUCTURAL (this file, SSR): the shell puts `MS_CONTAINER_CLASS` on the
 *     element that wraps the product screens — so the shared rules have an
 *     ancestor to match. This is a server render of the real component, not a
 *     source scan, because the contract is about the rendered tree.
 *  2. SHIPPED (this file, after the client build): the built `dist/client.js`
 *     carries the scoped frame rule text, so the CSS the seat loads is the one
 *     that does the styling.
 *
 * No capture is possible for the dsh half: rendering the panel needs the dsh host
 * (its renderer, slot geometry and theme bridge), which is not available in this
 * repository's test environment. The evidence is therefore structural, and stated
 * as such rather than presented as a picture.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MS_CONTAINER_CLASS, MS_PANE_BODY_CLASS, MS_PANE_HEAD_CLASS } from '@mstar-harness/ui'
import { PanelShell } from '../src/client/panel/panel-shell.tsx'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'

/** The smallest snapshot the shell renders a destination from. */
const workflowFixture = {
  id: 'wf-frame',
  type: 'plan',
  status: 'running',
  phase: 'phase-2-execute',
  branch: { base: 'main', source: 'feature/frame', integration: null, target: 'main' },
  plans: [{ planId: 'p-frame', status: 'InProgress', progress: null }],
}
const snapshot = {
  enforcement: { hard: false, source: 'compass' },
  knowledge: null,
  selection: { kind: 'active', workflowId: 'wf-frame', dir: 'workflows/wf-frame' },
  iteration: { state: 'not-applicable', reason: 'unused in this case' },
  workflowFixture,
} as unknown as PanelSnapshot

const html = renderToStaticMarkup(createElement(PanelShell, {
  snapshot,
  workflow: { state: 'read', data: workflowFixture as never },
  destination: 'focus',
  locale: 'en',
  navLabel: 'Morning Star Workflow',
  onSelect: () => {},
  select: null,
  delivery: null,
}))

/** The class list of the element carrying one contract attribute. */
function classListOf(attribute: string): string | null {
  const at = html.indexOf(attribute)
  if (at < 0) return null
  const open = html.lastIndexOf('<', at)
  const tag = html.slice(open, html.indexOf('>', at))
  return /class="([^"]*)"/.exec(tag)?.[1] ?? null
}

describe('the dsh seat mounts the shared frame', () => {
  it('the product scroller carries the container class', () => {
    // The class goes on the PRODUCT surface (the scroller), not on the whole
    // shell: the host's own nav band must keep its chrome.
    const classes = classListOf('data-mstar-scroll')
    expect(classes).not.toBeNull()
    expect(classes!.split(/\s+/)).toContain(MS_CONTAINER_CLASS)
  })

  it('the frame does not reach the host chrome above it', () => {
    // The nav band sits outside the container, so no `.ms-container` element rule
    // rewrites the host's own links and headings.
    const shell = /<div class="([^"]*)" data-ms-shell=""/.exec(html)?.[1] ?? ''
    expect(shell.split(/\s+/)).not.toContain(MS_CONTAINER_CLASS)
    const navAt = html.indexOf('data-ms-shell=""')
    const scrollAt = html.indexOf('data-mstar-scroll')
    expect(navAt).toBeGreaterThan(-1)
    expect(scrollAt).toBeGreaterThan(navAt)
  })
})

describe('the pane frame (Task 4 of the narrow-pane plan)', () => {
  it('the nav band is the pane head band and the product body carries the closing inset', () => {
    // The prototype's `.dsh-page-head` / `.dsh-page-body` (`design-v1.html:482-488`):
    // a surface band closed by a hairline, and a body that ends 24px in. Both are
    // the shared layer's hooks (`base.css`), so the next host applies the same two
    // classes instead of restating two declarations.
    expect(html).toContain('data-ms-pane-head=""')
    expect(classListOf('data-ms-pane-head')).toContain(MS_PANE_HEAD_CLASS)
    expect(html).toContain('data-ms-pane-body=""')
    expect(classListOf('data-ms-pane-body')).toContain(MS_PANE_BODY_CLASS)
    // The body is also the container the shared screens query, and the head band
    // is host chrome outside it.
    expect(classListOf('data-ms-pane-body')).toContain(MS_CONTAINER_CLASS)
  })
})

describe('the shipped client carries the scoped frame', () => {
  const bundle = join(import.meta.dir, '..', 'dist', 'client.js')
  const text = existsSync(bundle) ? readFileSync(bundle, 'utf8') : ''

  it('inlines the frame rule under its container scope', () => {
    if (!existsSync(bundle)) {
      throw new Error('dist/client.js is missing — run `bun run --cwd packages/dsh build-client` before this suite')
    }
    // The gutter, the max width and the title scale, all scoped: a document-wide
    // rule would be the defect this scope exists to prevent.
    expect(text).toContain(`.${MS_CONTAINER_CLASS} [data-ms-screen] {`)
    expect(text).toMatch(new RegExp(`\\.${MS_CONTAINER_CLASS} \\[data-ms-screen\\] \\{[^}]*padding: 14px 20px 16px`))
    expect(text).toMatch(new RegExp(`\\.${MS_CONTAINER_CLASS} \\[data-ms-screen\\] h1 \\{[^}]*font-size: var\\(--ms-fs-16\\)`))
    expect(text).toMatch(new RegExp(`\\.${MS_CONTAINER_CLASS} \\[data-ms-screen\\] \\[data-ms-screen\\] \\{[^}]*padding: 0`))
  })
})
