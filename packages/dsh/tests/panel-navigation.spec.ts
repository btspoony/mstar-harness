/**
 * Sidebar product shell — navigation, the Focus landing view and the fact-set
 * boundary (plan dsh-panel-unification Task 2).
 *
 * This suite replaces the retired panel's section-routing assertions: the panel
 * no longer owns tabs, pages, a digest, a meta dock or a freshness footer, and
 * the event log is deleted rather than hidden. What it must prove now:
 *
 * 1. `Focus` is the LANDING view and renders the IA §3.2 facts in order;
 * 2. the five product destinations are reachable from the shared nav;
 * 3. no event-log section and no meta dock/freshness/digest survives anywhere
 *    in the shell;
 * 4. `Focus` renders none of the project-scoped set (no residuals, no
 *    milestones, no knowledge rollup) and an unbound session renders the PICKER
 *    instead of fabricated content.
 *
 * Assertions target the shared layer's data anchors (`data-ms-*`), never
 * localized copy, except where the case is exactly the locale bridge.
 */

import { describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as uiEn, zh as uiZh } from '@mstar-harness/ui'
import { clientExports } from './client-bundles.ts'
import { bindUseSessions, gatewayOk, SESSION, settleRender, stubGateway, visibleTabKit } from './gateway-stub.ts'
import { en, NS, zh } from '../src/client/panel/locale.ts'
import { MstarPanelSnapshotClient } from '../src/client/panel/panel-snapshot-client.ts'
import { PanelView } from '../src/client/panel/PanelView.tsx'
import { PANEL_DESTINATIONS, PanelShell, productLocale } from '../src/client/panel/panel-shell.tsx'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'

type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

/* ------------------------------- fixtures ------------------------------- */

type Member = { state: 'ok'; data: unknown } | { state: 'not-applicable' | 'unavailable'; reason: string }

const ok = (data: unknown): Member => ({ state: 'ok', data })

/** The workflow member the shell takes: the per-view read's three-state answer. */
type RenderWorkflowMember =
  | { readonly state: 'read'; readonly data: unknown }
  | { readonly state: 'not-applicable'; readonly reason: string }
  | { readonly state: 'unavailable'; readonly reason: string }

const WORKFLOW = {
  id: 'wf-focus',
  type: 'plan',
  status: 'running',
  phase: 'phase-2-execute',
  branch: { base: 'main', source: 'feature/focus', integration: null, target: 'main' },
  plans: [
    { planId: 'p-done', status: 'Done', progress: 'shipped' },
    { planId: 'p-run', status: 'InProgress', progress: 'recording the shell' },
    { planId: 'p-blocked', status: 'Blocked', progress: 'waiting on the host contract' },
    { planId: 'p-quiet', status: 'Todo', progress: null },
  ],
}

/** A snapshot whose bound workflow is `wf-focus` and whose iteration holds one of its plans. */
/** The session digest the seat reads (Task 4: enforcement / knowledge / selection + the delivery fallback). */
function snapshot(over: { selection?: unknown; iteration?: Member; enforcement?: unknown } = {}): PanelSnapshot {
  return {
    enforcement: over.enforcement ?? { hard: true, source: 'compass' },
    knowledge: { docCount: 41, categories: [] },
    selection: over.selection === undefined
      ? { kind: 'active', workflowId: 'wf-focus', dir: 'workflows/wf-focus' }
      : over.selection,
    iteration: over.iteration ?? ok({ iterationId: 'iter-shell', gateStep: 2, plans: [{ planId: 'p-run' }] }),
  } as unknown as PanelSnapshot
}

/**
 * Render the pure shell for one destination. `workflow` is the per-view
 * `workflow-detail` member the seat hands down (Task 4).
 */
function shell(
  snap: PanelSnapshot = snapshot(),
  destination: (typeof PANEL_DESTINATIONS)[number] | 'focus' = 'focus',
  locale: 'en' | 'zh' = 'en',
  workflow: RenderWorkflowMember = { state: 'read', data: WORKFLOW },
): string {
  return renderToStaticMarkup(
    createElement(PanelShell, {
      snapshot: snap,
      workflow: workflow as never,
      destination,
      locale,
      navLabel: 'Morning Star Workflow',
      onSelect: () => {},
      select: null,
    }),
  )
}

/** The nav item the markup marks `aria-current="page"` (attribute order is React's). */
function currentItem(markup: string): string | null {
  for (const tag of markup.match(/<button[^>]*>/g) ?? []) {
    if (tag.includes('aria-current="page"')) return tag.match(/data-ms-nav-item="([a-z]+)"/)?.[1] ?? null
  }
  return null
}

/** A locale runtime bound to the panel's namespace, as the host composition does. */
function localeRuntime(active = 'en'): LocaleRuntime {
  const locale = new LocaleRuntimeCtor(new Context())
  locale.register(NS, { zh, en })
  locale.setLocale(active)
  return locale
}

/* ------------------------------ 1. landing ------------------------------ */


/**
 * Settle the seat's chained reads: the digest lands, then the per-view reads it
 * enables (`workflow-detail`, `iterations`), each one render later.
 */
async function settledSeat(render: () => string): Promise<string> {
  let markup = ''
  for (let pass = 0; pass < 4; pass += 1) {
    markup = await settleRender(render)
  }
  return markup
}

describe('sidebar shell — Focus is the landing view', () => {
  const markup = shell()

  it('renders the Focus screen as the shell body', () => {
    expect(markup).toContain('data-ms-screen="focus"')
    // One screen only: the shell hosts no destination side by side.
    expect(markup.match(/data-ms-screen=/g)).toHaveLength(1)
  })

  it('renders the five §3.2 facts in order', () => {
    // 1. the binding line, bound to this session's workflow
    expect(markup).toContain('data-ms-binding="bound"')
    // 2. + 3. the workflow identity and its plan board, per status group
    expect(markup).toContain('data-ms-workflow=""')
    expect(markup).toContain('data-ms-branch-chain=""')
    expect(markup).toContain('data-ms-group="InProgress"')
    expect(markup.indexOf('data-ms-binding')).toBeLessThan(markup.indexOf('data-ms-workflow'))
    // 3. the recorded progress of a moving plan, the blocked reason, and the
    //    absent line for a plan that records neither
    expect(markup).toContain('data-ms-progress-note=""')
    expect(markup).toContain('data-ms-blocked-reason=""')
    expect(markup).toContain('data-ms-progress-absent=""')
    // 4. the delivery line of the iteration that holds one of its plans
    expect(markup).toContain('data-ms-delivery="iteration"')
    // 5. the enforcement flag, last
    expect(markup).toContain('data-ms-enforcement="hard"')
    expect(markup.indexOf('data-ms-delivery')).toBeLessThan(markup.indexOf('data-ms-enforcement'))
  })

  it('renders NO project-scoped set and no knowledge rollup', () => {
    // The residuals panel, milestones and the trend live one destination away.
    expect(markup).not.toContain('data-ms-residuals')
    expect(markup).not.toContain('data-ms-milestone')
    expect(markup).not.toContain('data-ms-trend')
    // D30: a document count is inventory, not work — the model never reads it.
    expect(markup).not.toContain('docCount')
  })

  it('renders no delivery step when the iteration records no compass', () => {
    const noStep = shell(snapshot({ iteration: ok({ iterationId: 'iter-shell', gateStep: null, plans: [{ planId: 'p-run' }] }) }))
    expect(noStep).toContain('data-ms-delivery="iteration"')
    expect(noStep).toContain(uiEn.focus.deliveryUnknownStep)
    // Never a fabricated `step 0 of 5`.
    expect(noStep).not.toContain('step 0 of 5')
  })

  it('says "No iteration" when the bound plans are delivered standalone', () => {
    const standalone = shell(snapshot({ iteration: ok({ iterationId: 'iter-other', gateStep: 4, plans: [{ planId: 'p-unrelated' }] }) }))
    expect(standalone).toContain('data-ms-delivery="no-iteration"')
    expect(standalone).toContain(uiEn.focus.deliveryNoIteration)
    // The unrelated iteration's step is NOT this session's delivery position.
    expect(standalone).not.toContain('iter-other')
  })
})

/* --------------------------- 2. nav / destinations --------------------------- */

describe('sidebar shell — the five destinations are reachable from the shared nav', () => {
  it('renders the five product destinations plus the session landing, in order', () => {
    const markup = shell()
    const ids = Array.from(markup.matchAll(/data-ms-nav-item="([a-z]+)"/g), (match) => match[1])
    expect(ids).toEqual(['focus', ...PANEL_DESTINATIONS])
    expect(PANEL_DESTINATIONS).toEqual(['overview', 'issues', 'workflows', 'iterations', 'projects'])
    // Labels come from the shared dictionary, never from host-local strings.
    for (const id of PANEL_DESTINATIONS) expect(markup).toContain(`>${uiEn[id].pageTitle}<`)
  })

  it('marks the landing as current and moves the marker with the destination', () => {
    expect(currentItem(shell())).toBe('focus')
    expect(currentItem(shell(snapshot(), 'issues'))).toBe('issues')
    expect(currentItem(shell(snapshot(), 'projects'))).toBe('projects')
    // A destination whose screen lands in its own round renders no body — and
    // never a fabricated absence state.
    expect(shell(snapshot(), 'issues')).not.toContain('data-ms-screen=')
  })
})

/* ------------------------- 3. the removed surfaces ------------------------- */

describe('sidebar shell — the removed surfaces are gone', () => {
  it('has no event-log section, digest, meta dock or freshness footer', () => {
    const markup = shell()
    for (const anchor of [
      'data-event-log',
      'data-mstar-section="state"',
      'data-mstar-sidebar',
      'data-mstar-meta',
      'data-mstar-freshness',
      'data-mstar-tab-nav',
      'data-mstar-graph',
    ]) {
      expect(markup).not.toContain(anchor)
    }
  })

  it('renders no card framing or panel title of its own around the product', () => {
    const markup = shell()
    // The host's tab strip is the panel's top edge: no heading and no card.
    expect(markup).not.toContain('data-mstar-empty-card')
    expect(markup).not.toContain('<h1>Morning Star')
  })
})

/* ----------------------- 4. unbound / degraded states ----------------------- */

describe('sidebar shell — unbound and degraded sessions never fabricate content', () => {
  it('renders the picker (not a fabricated workflow) when the session is unbound', () => {
    // An unbound session's host read answers `not-applicable`: there is no
    // workflow to describe, and the selection arrives as the pickable error.
    const markup = shell(
      snapshot({
        selection: { kind: 'error', code: 'workflow.multi-active', message: 'two workflows are active', activeWorkflowIds: ['wf-a', 'wf-b'] },
      }),
      'focus',
      'en',
      { state: 'not-applicable', reason: 'no workflow is bound to this session' },
    )
    expect(markup).toContain('data-ms-binding="error"')
    expect(markup).toContain('data-ms-picker=""')
    expect(markup).toContain('wf-a')
    expect(markup).toContain('wf-b')
    // The board is an arm, not invented rows.
    expect(markup).not.toContain('data-ms-workflow=""')
    expect(markup).toContain('data-ms-delivery="no-iteration"')
  })

  it('keeps an unreadable workflow a member-level arm while the rest still renders', () => {
    const markup = shell(snapshot(), 'focus', 'en', { state: 'unavailable', reason: 'execution projection unavailable' })
    expect(markup).toContain('data-ms-binding="bound"')
    expect(markup).toContain('execution projection unavailable')
    expect(markup).toContain('data-ms-enforcement="hard"')
  })
})

/* ----------------------------- 5. locale bridge ----------------------------- */

describe('sidebar shell — the product copy follows the host locale', () => {
  it('maps host locale ids onto the product locales', () => {
    expect(productLocale('zh-CN')).toBe('zh')
    expect(productLocale('zh')).toBe('zh')
    expect(productLocale('en-US')).toBe('en')
    expect(productLocale('de-DE')).toBe('en')
  })

  it('renders Chinese copy and Chinese nav labels when the host is Chinese', () => {
    const markup = shell(snapshot(), 'focus', 'zh')
    expect(markup).toContain(uiZh.overview.pageTitle)
    expect(markup).toContain(uiZh.focus.pageTitle)
    expect(markup).toContain(uiZh.focus.bindingBound('wf-focus'))
    expect(markup).not.toContain(uiEn.focus.bindingBound('wf-focus'))
  })

  it('the seat renders its transport state until the digest answers (effects do not run under SSR)', () => {
    // The digest hook reads in an effect, which `renderToStaticMarkup` never
    // runs: the seat's LOADED state is a browser-render concern (Task 7/e2e),
    // while the same shell is covered directly by the pure cases above.
    const locale = localeRuntime('zh')
    const markup = renderToStaticMarkup(createElement(PanelView, {
      sessionId: SESSION,
      useSessions: bindUseSessions(),
      t: locale.bind(NS),
      localeFace: locale,
      ...visibleTabKit(),
    } as never))
    expect(markup).toContain('data-mstar-seat="sidebar"')
    expect(markup).toContain('data-mstar-empty="waiting"')
  })
})

/* ------------------------- 6. host transport states ------------------------- */

describe('sidebar shell — the seat still owns its transport states', () => {
  it('waiting: no transport injected renders the waiting anchor and no product', async () => {
    const locale = localeRuntime('en')
    const markup = await settledSeat(() =>
      renderToStaticMarkup(createElement(PanelView, {
        sessionId: SESSION,
        useSessions: bindUseSessions(),
        t: locale.bind(NS),
        ...visibleTabKit(),
      } as never)),
    )
    expect(markup).toContain('data-mstar-panel="waiting"')
    expect(markup).not.toContain('data-ms-shell')
  })

})
