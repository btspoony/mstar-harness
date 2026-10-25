/**
 * The keyed `main` seat — the full-page host for the SAME product (plan
 * dsh-panel-unification Task 3).
 *
 * The load-bearing assertion of this suite is identity, not content: both seats
 * resolve ONE destination set from `panel-shell.tsx` and mount ONE screen
 * implementation from `@mstar-harness/ui`. A second hand-written list, or a
 * second `Focus` call, is the failure this file exists to catch.
 *
 * It also pins what a full-page seat must NOT add: no plugin window chrome
 * (titlebar, close control, frame) and no second top edge — the host's tab strip
 * is the panel's whole top boundary, and the only heading is the shared screen's
 * own.
 */

import { describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as uiEn, zh as uiZh } from '@mstar-harness/ui'
import { clientExports } from './client-bundles.ts'
import { bindUseSessions, gatewayOk, SESSION, settleRender, stubGateway, visibleTabKit } from './gateway-stub.ts'
import { en, NS, zh } from '../src/client/panel/locale.ts'
import { MstarPanelSnapshotClient } from '../src/client/panel/panel-snapshot-client.ts'
import { PanelView } from '../src/client/panel/PanelView.tsx'
import { MainPanelView } from '../src/client/panel/MainPanelView.tsx'
import { PANEL_DESTINATIONS, SHELL_DESTINATIONS } from '../src/client/panel/panel-shell.tsx'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'

type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

const PKG_DIR = join(import.meta.dir, '..')

/* ------------------------------- fixtures ------------------------------- */

const ok = (data: unknown) => ({ state: 'ok', data })

const SNAPSHOT = {
  at: '2026-10-25T10:00:00.000Z',
  version: '4.0.9',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: false, source: 'compass' },
  workspace: {
    workflow: ok({
      id: 'wf-main',
      type: 'plan',
      status: 'running',
      phase: 'phase-2-execute',
      branch: { base: 'main', source: 'feature/main', integration: null, target: 'main' },
      plans: [{ planId: 'p-run', status: 'InProgress', progress: 'mounting the main seat' }],
    }),
    iteration: ok({ iterationId: 'iter-main', gateStep: 3, plans: [{ planId: 'p-run' }] }),
    roadmap: { state: 'not-applicable', reason: 'no project resolves' },
    issues: ok({ items: [], total: 0 }),
    projects: ok({ items: [], total: 0 }),
  },
  retained: {
    iterationGate: null,
    knowledge: null,
    selection: { kind: 'active', workflowId: 'wf-main', dir: 'workflows/wf-main' },
    at: null,
  },
  ledger: null,
} as unknown as PanelSnapshot

function localeRuntime(active = 'en'): LocaleRuntime {
  const locale = new LocaleRuntimeCtor(new Context())
  locale.register(NS, { zh, en })
  locale.setLocale(active)
  return locale
}

/** Render the main seat with a live snapshot transport. */
async function mainSeat(locale: LocaleRuntime): Promise<string> {
  const gateway = stubGateway(gatewayOk({ kind: 'ok', snapshot: SNAPSHOT }))
  const client = new MstarPanelSnapshotClient(gateway.connection, { pollIntervalMs: 0 })
  const markup = await settleRender(() =>
    renderToStaticMarkup(createElement(MainPanelView, {
      sessionId: SESSION,
      useSessions: bindUseSessions(),
      t: locale.bind(NS),
      panelSnapshot: client,
      localeFace: locale,
    } as never)),
  )
  client.dispose()
  return markup
}

/** Render the sidebar seat with the same transport and data. */
async function sidebarSeat(locale: LocaleRuntime): Promise<string> {
  const gateway = stubGateway(gatewayOk({ kind: 'ok', snapshot: SNAPSHOT }))
  const client = new MstarPanelSnapshotClient(gateway.connection, { pollIntervalMs: 0 })
  const markup = await settleRender(() =>
    renderToStaticMarkup(createElement(PanelView, {
      sessionId: SESSION,
      useSessions: bindUseSessions(),
      t: locale.bind(NS),
      panelSnapshot: client,
      localeFace: locale,
      ...visibleTabKit(),
    } as never)),
  )
  client.dispose()
  return markup
}

/** The destination ids a rendered nav carries, in order. */
function navIds(markup: string): string[] {
  return Array.from(markup.matchAll(/data-ms-nav-item="([a-z]+)"/g), (match) => match[1] ?? '')
}

/** The screens a rendering mounts. */
function screens(markup: string): string[] {
  return Array.from(markup.matchAll(/data-ms-screen="([a-z-]+)"/g), (match) => match[1] ?? '')
}

/* --------------------------- 1. one implementation --------------------------- */

describe('main seat — the same product, one implementation', () => {
  it('both seats resolve the SAME destination set from one source', async () => {
    const locale = localeRuntime()
    const main = navIds(await mainSeat(locale))
    const sidebar = navIds(await sidebarSeat(locale))

    // One list, read from `panel-shell.tsx` by both seats.
    expect(main).toEqual([...SHELL_DESTINATIONS])
    expect(sidebar).toEqual(main)
    expect(SHELL_DESTINATIONS).toEqual(['focus', ...PANEL_DESTINATIONS])
    expect(PANEL_DESTINATIONS).toEqual(['overview', 'issues', 'workflows', 'iterations', 'projects'])
    // And the labels are the shared dictionary's, identically.
    for (const id of SHELL_DESTINATIONS) {
      expect(main).toContain(id)
      expect(uiEn[id].pageTitle.length).toBeGreaterThan(0)
    }
  })

  it('both seats mount the same shared Focus screen, in the same order', async () => {
    const locale = localeRuntime()
    const main = await mainSeat(locale)
    const sidebar = await sidebarSeat(locale)
    // One screen, and it is the shared one (`data-ms-*` anchors come from
    // `@mstar-harness/ui`, never from this plugin).
    expect(screens(main)).toEqual(['focus'])
    expect(screens(sidebar)).toEqual(['focus'])
    expect(main).toContain('data-ms-binding="bound"')
    expect(main).toContain('data-ms-plan="p-run"')
    expect(main).toContain('data-ms-progress-note=""')
    expect(main).toContain('data-ms-delivery="iteration"')
    // The two seats' product bodies are byte-identical: any difference here
    // would be a second implementation.
    expect(bodyOf(main)).toBe(bodyOf(sidebar))
  })

  it('renders Chinese product copy through the same bridge as the sidebar', async () => {
    const locale = localeRuntime('zh')
    const main = await mainSeat(locale)
    expect(main).toContain(uiZh.focus.pageTitle)
    expect(main).toContain(uiZh.focus.bindingBound('wf-main'))
    expect(main).toContain(uiZh.overview.pageTitle)
  })
})

/** Everything from the first product anchor onward (the nav + screen). */
function bodyOf(markup: string): string {
  const at = markup.indexOf('<nav')
  return at === -1 ? '' : markup.slice(at)
}

/* ----------------------------- 2. no host chrome ----------------------------- */

describe('main seat — host chrome is the host’s', () => {
  it('renders no plugin titlebar, close control or frame', async () => {
    const markup = await mainSeat(localeRuntime())
    for (const forbidden of ['data-mstar-titlebar', 'data-mstar-close', 'data-mstar-frame', 'role="dialog"']) {
      expect(markup).not.toContain(forbidden)
    }
    // The seat is one root and nothing else around the product.
    expect(markup).toContain('data-mstar-seat="main"')
    // The host's tab strip is the panel's top edge: no second top edge here.
    expect(markup).not.toContain('data-mstar-tab-nav')
  })

  it('renders exactly the shared screen’s own heading — no invented one', async () => {
    const markup = await mainSeat(localeRuntime())
    const headings = Array.from(markup.matchAll(/<h1[^>]*>([^<]*)<\/h1>/g), (match) => match[1])
    expect(headings).toEqual([uiEn.focus.pageTitle])
  })

  it('the sidebar keeps the "open full page" affordance; the main seat does not', async () => {
    // Without the host's layout handler the control does not render at all (a
    // button that cannot act must not look clickable).
    expect(await sidebarSeat(localeRuntime())).not.toContain('data-mstar-open-main')
    const sidebarWithAffordance = await sidebarSeatOpener()
    expect(sidebarWithAffordance).toContain('data-mstar-open-main=""')
    // Its label is the panel's own dictionary key, localized by the host.
    expect(sidebarWithAffordance).toContain(en['panel.open-full-page'])
    // The full page does not offer to open itself.
    expect(await mainSeat(localeRuntime())).not.toContain('data-mstar-open-main')
  })

  it('the affordance label follows the host locale', async () => {
    const locale = localeRuntime('zh')
    const gateway = stubGateway(gatewayOk({ kind: 'ok', snapshot: SNAPSHOT }))
    const client = new MstarPanelSnapshotClient(gateway.connection, { pollIntervalMs: 0 })
    const markup = await settleRender(() =>
      renderToStaticMarkup(createElement(PanelView, {
        sessionId: SESSION,
        useSessions: bindUseSessions(),
        t: locale.bind(NS),
        panelSnapshot: client,
        localeFace: locale,
        openMainPanel: () => {},
        ...visibleTabKit(),
      } as never)),
    )
    client.dispose()
    expect(markup).toContain(zh['panel.open-full-page'])
  })
})

/** Render the sidebar seat with the host's open-main handler present. */
async function sidebarSeatOpener(): Promise<string> {
  const locale = localeRuntime()
  const gateway = stubGateway(gatewayOk({ kind: 'ok', snapshot: SNAPSHOT }))
  const client = new MstarPanelSnapshotClient(gateway.connection, { pollIntervalMs: 0 })
  const markup = await settleRender(() =>
    renderToStaticMarkup(createElement(PanelView, {
      sessionId: SESSION,
      useSessions: bindUseSessions(),
      t: locale.bind(NS),
      panelSnapshot: client,
      localeFace: locale,
      openMainPanel: () => {},
      ...visibleTabKit(),
    } as never)),
  )
  client.dispose()
  return markup
}

/* ------------------------------ 3. no placeholder ------------------------------ */

describe('main seat — the placeholder is gone', () => {
  it('no source file still names MainSeatPlaceholder', () => {
    for (const file of ['src/client/index.ts', 'src/client/panel/MainPanelView.tsx', 'src/client/panel/panel-shell.tsx']) {
      const text = readFileSync(join(PKG_DIR, file), 'utf8')
      expect(text).not.toContain('MainSeatPlaceholder')
    }
    // The identifier's landmark element is gone with it.
    expect(readFileSync(join(PKG_DIR, 'src/client/index.ts'), 'utf8')).not.toContain("data-mstar-panel")
  })

  it('the seat renders the product shell instead of a landmark', async () => {
    const markup = await mainSeat(localeRuntime())
    expect(markup).toContain('data-ms-shell')
    expect(markup).toContain('data-mstar-seat="main"')
  })
})

/* --------------------------- 4. transport states --------------------------- */

describe('main seat — it owns the same transport states as the sidebar', () => {
  it('waiting: no transport renders the waiting anchor, not the product', async () => {
    const locale = localeRuntime()
    const markup = await settleRender(() =>
      renderToStaticMarkup(createElement(MainPanelView, {
        sessionId: SESSION,
        useSessions: bindUseSessions(),
        t: locale.bind(NS),
      } as never)),
    )
    expect(markup).toContain('data-mstar-panel="waiting"')
    expect(markup).not.toContain('data-ms-shell')
  })

  it('no-harness keeps its own anchor', async () => {
    const locale = localeRuntime()
    const gateway = stubGateway(gatewayOk({ kind: 'no-harness' }))
    const client = new MstarPanelSnapshotClient(gateway.connection, { pollIntervalMs: 0 })
    const markup = await settleRender(() =>
      renderToStaticMarkup(createElement(MainPanelView, {
        sessionId: SESSION,
        useSessions: bindUseSessions(),
        t: locale.bind(NS),
        panelSnapshot: client,
      } as never)),
    )
    client.dispose()
    expect(markup).toContain('data-mstar-panel="no-harness"')
    expect(markup).not.toContain('data-ms-shell')
  })
})
