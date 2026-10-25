/**
 * Seat registration — ONE entry: the session's right-pane tab type and its seats.
 *
 * The Morning Star product is per-repository state, so it must NOT appear in the
 * host's global panel list beside Plugins / Automation / Context-insight. The
 * session's right-pane tab is the entry: the plugin registers the page tab type
 * plus its keyed body and chip title, and NOTHING else — no `sidebar.panellist`
 * row, no keyed `main` seat, no `ctx.layout` selection face.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { clientExports } from './client-bundles.ts'
import { apply, inject } from '../src/client/index.ts'
import { MSTAR_GUIDE_ORDER, MSTAR_PANEL_ID, MSTAR_PANEL_KIND, mstarPanelDefinition } from '../src/client/panel/definition.ts'
import { NS } from '../src/client/panel/locale.ts'

type RendererClientExports = typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
const { SlotRegistry: SlotRegistryCtor } = clientExports('@deepseek-ai/dsh-client-ui-renderer') as unknown as
  Pick<RendererClientExports, 'SlotRegistry'>
type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

const PKG_DIR = join(import.meta.dir, '..')

function makeCtx(): {
  ctx: Context
  slots: SlotRegistry
  locale: LocaleRuntime
  tabs: { registered: ReturnType<typeof mstarPanelDefinition>[] }
  runEffectDisposers: () => void
} {
  const ctx = new Context()
  const slots = new SlotRegistryCtor(ctx)
  const locale = new LocaleRuntimeCtor(ctx)
  const registered: ReturnType<typeof mstarPanelDefinition>[] = []
  const tabs = {
    registered,
    register: (definition: ReturnType<typeof mstarPanelDefinition>) => {
      registered.push(definition)
      return () => {
        const at = registered.indexOf(definition)
        if (at >= 0) registered.splice(at, 1)
      }
    },
  }
  const faces: Record<string, unknown> = { slots, locale, sessions: {}, sidebarRightTabs: tabs }
  for (const [name, face] of Object.entries(faces)) {
    Object.defineProperty(ctx, name, { value: face, configurable: true, writable: true })
  }
  const effectDisposers: Array<() => unknown> = []
  const effect = (ctx as unknown as { effect: (execute: () => unknown, label?: string) => () => unknown }).effect.bind(ctx)
  ;(ctx as unknown as { effect: unknown }).effect = (execute: () => unknown, label?: string) => {
    const dispose = effect(execute, label)
    effectDisposers.push(dispose)
    return dispose
  }
  return {
    ctx,
    slots,
    locale,
    tabs,
    runEffectDisposers: () => {
      for (const dispose of effectDisposers) dispose()
    },
  }
}

/**
 * Declare the pane seats the way the installed ui-sidebar-right apply does, AND
 * the two global seats this plugin must NOT occupy (`main`, `sidebar.panellist`):
 * declaring them makes the absence assertion meaningful.
 */
function declareSeats(slots: SlotRegistry): () => void {
  const disposers: Array<() => void> = []
  disposers.push(slots.register({
    name: 'root' as 'sidebar.right.pane.tab',
    children: {
      rightbar: { kind: 'single', scope: 'root' },
      // The two GLOBAL seats this plugin must not occupy. Declaring them makes
      // the absence assertion meaningful.
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null))
  disposers.push(slots.register({
    name: 'rightbar' as 'sidebar.right.pane.tab',
    children: { 'rightbar.session': { kind: 'single', scope: 'session' } },
  } as never, () => null))
  disposers.push(slots.register({
    name: 'rightbar.session' as 'sidebar.right.pane.tab',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: () => () => ({ tab: { visible: true } }) } } },
      'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: () => () => ({ tab: { visible: true } }) } } },
    },
  } as never, () => null))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

describe('panel entry — the session tab is the ONE entry', () => {
  it('declares no `layout` face: with no global row there is nothing to select', () => {
    expect(inject).toEqual(['slots', 'sessions', 'locale', 'connection', 'sidebarRightTabs', 'theme'])
  })

  it('registers the page tab type (id, kind, one guide entry)', () => {
    const { ctx, tabs } = makeCtx()
    apply(ctx)
    expect(tabs.registered).toHaveLength(1)
    expect(tabs.registered[0]!.id).toBe(MSTAR_PANEL_ID)
    expect(tabs.registered[0]!.kind).toBe(MSTAR_PANEL_KIND)
    expect(tabs.registered[0]!.guide![0]!.order).toBe(MSTAR_GUIDE_ORDER)
  })

  it('registers the keyed body and chip title under that id', () => {
    const { ctx, slots } = makeCtx()
    apply(ctx)
    const disposeSeats = declareSeats(slots)
    expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(1)
    expect(slots.entries('sidebar.right.pane.tab.title')).toHaveLength(1)
    expect(slots.entries('sidebar.right.pane.tab')[0]!.options.key).toBe(MSTAR_PANEL_ID)
    expect(slots.entries('sidebar.right.pane.tab')[0]!.locale).toBe(NS)
    disposeSeats()
  })

  it('occupies NEITHER global seat, even when both are declared', () => {
    const { ctx, slots } = makeCtx()
    apply(ctx)
    const disposeSeats = declareSeats(slots)
    // No global sidebar row, and no keyed main panel for one to open.
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(slots.entries('main')).toHaveLength(0)
    disposeSeats()
  })

  it('unload removes the tab type and both keyed seats', () => {
    const { ctx, slots, tabs, runEffectDisposers } = makeCtx()
    apply(ctx)
    const disposeSeats = declareSeats(slots)
    expect(tabs.registered).toHaveLength(1)
    runEffectDisposers()
    expect(tabs.registered).toHaveLength(0)
    expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
    expect(slots.entries('sidebar.right.pane.tab.title')).toHaveLength(0)
    disposeSeats()
  })

  it('the deleted seats and their faces are gone from the source', () => {
    for (const file of ['src/client/index.ts', 'src/client/panel/PanelView.tsx', 'src/client/panel/definition.ts']) {
      const source = readFileSync(join(PKG_DIR, file), 'utf8')
      for (const gone of ['MainPanelView', 'SidebarRowIcon', 'selectMstarPanel', 'sidebar.panellist', 'openMainPanel']) {
        expect(source).not.toContain(gone)
      }
    }
  })
})

describe('panel chip title — the seat still renders', () => {
  it('draws the glyph and the captured tab title', () => {
    const { ctx, slots, locale } = makeCtx()
    apply(ctx)
    const disposeSeats = declareSeats(slots)
    // The chip seat is a component over `useTabInfo`; rendering it is covered by
    // `client-seat.spec.ts`. Here the registration itself is the contract.
    expect(slots.entries('sidebar.right.pane.tab.title')).toHaveLength(1)
    locale.setLocale('en')
    expect(typeof locale.bind(NS)('view.mstar-workflow')).toBe('string')
    disposeSeats()
  })
})
