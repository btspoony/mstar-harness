/**
 * Seat registration for the unified panel (plan dsh-panel-unification Task 1).
 *
 * The plugin keeps what it had — the right-Sidebar page tab type plus its keyed
 * body and chip title — and adds the two seats the central panel needs:
 *
 * 1. a keyed `main` occupant (`main` is a keyed, root-scoped slot: "Central
 *    panel selected by sidebar entry id" — dsh-client-ui-layout
 *    `lib/types/client/index.d.ts`), registered under the definition id;
 * 2. a `sidebar.panellist` row whose list id IS that main key (dsh-client-ui-sidebar
 *    `lib/types/client/contract/slots.d.ts`: "Each list id addresses the matching
 *    main panel"), at the shared row order;
 * 3. `layout` in the plugin's `inject`, because selection is `ctx.layout.selectPanel`
 *    (dsh-client-ui-layout `lib/types/client/service.d.ts`) — a cordis service the
 *    plugin must declare before reaching for it, exactly as the shipped plugin
 *    manager does (`dsh-client-ui-plugin-manager/lib/client.js`).
 *
 * The spec mounts the REAL `SlotRegistry`/`LocaleRuntime` browser bundles
 * (tests/client-bundles.ts) and models the two host faces the registration
 * depends on: the slot declarations (a fixture chain, as the installed
 * ui-layout/ui-sidebar apply declares them) and `ctx.layout` (whose
 * `selectPanel` throws on an unregistered key and preserves the selection).
 */

import { describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { clientExports } from './client-bundles.ts'
import { apply, inject } from '../src/client/index.ts'
import {
  MSTAR_GUIDE_ORDER,
  MSTAR_PANEL_ID,
  MSTAR_PANEL_KIND,
  MSTAR_PANEL_ROW_ORDER,
  mstarPanelDefinition,
  selectMstarPanel,
} from '../src/client/panel/definition.ts'
import { SidebarRowIcon } from '../src/client/panel/SidebarRowIcon.tsx'
import { NS } from '../src/client/panel/locale.ts'

// The REAL client service values — SlotRegistry / LocaleRuntime are cordis
// services loaded from the browser bundles through the loader shim, exactly
// like the established plugin-entry specs.
type RendererClientExports = typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
const { SlotRegistry: SlotRegistryCtor } = clientExports('@deepseek-ai/dsh-client-ui-renderer') as unknown as
  Pick<RendererClientExports, 'SlotRegistry'>
type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

/** The definition registrations `apply` performed (the host's tab-type registry is its own service). */
function recordingTabRegistry() {
  const registered: ReturnType<typeof mstarPanelDefinition>[] = []
  return {
    registered,
    register: (definition: ReturnType<typeof mstarPanelDefinition>) => {
      registered.push(definition)
      return () => {
        const at = registered.indexOf(definition)
        if (at >= 0) registered.splice(at, 1)
      }
    },
  }
}

type LayoutFace = { selectPanel(panelId: MainPanelId | null): void }

/** One real cordis context wired with the faces the plugin entry touches. */
function makeCtx(): {
  ctx: Context
  slots: SlotRegistry
  locale: LocaleRuntime
  tabs: ReturnType<typeof recordingTabRegistry>
  /** Panel ids `selectPanel` accepted, in call order. */
  selections: Array<MainPanelId | null>
  runEffectDisposers: () => void
} {
  const ctx = new Context()
  const slots = new SlotRegistryCtor(ctx)
  const locale = new LocaleRuntimeCtor(ctx)
  const selections: Array<MainPanelId | null> = []
  // The host's own contract (dsh-client-ui-layout service.d.ts): a registered
  // main key selects; `null` returns to the Conversation; an unregistered key
  // throws and leaves the current selection intact.
  const layout: LayoutFace = {
    selectPanel(panelId) {
      const live =
        panelId === null || slots.entries('main').some((entry) => entry.options.key === panelId)
      if (!live) throw new Error(`main panel ${String(panelId)} is not registered`)
      selections.push(panelId)
    },
  }
  const faces: Record<string, unknown> = { slots, locale, sessions: {}, sidebarRightTabs: recordingTabRegistry(), layout }
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
    tabs: faces.sidebarRightTabs as ReturnType<typeof recordingTabRegistry>,
    selections,
    runEffectDisposers: () => {
      for (const dispose of effectDisposers) dispose()
    },
  }
}

/**
 * Declare the two seats the way the installed layout/sidebar applies do: as
 * root-scoped children of the framework's a-priori `root` slot. Slot names the
 * plugin's consumed SlotMap face does not carry are erased, as in the
 * established plugin-entry fixtures.
 */
function declareSeats(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root' as 'sidebar.right.pane.tab',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('unified panel — seat registration (plugin entry)', () => {
  it('declares `layout` and `theme` in inject beside the five services the entry already waits for', () => {
    // `layout` is the panel-selection face; `theme` is the colour-scheme face the
    // product inherits (Task 5). Both are cordis services, so both are declared.
    expect(inject).toEqual(['slots', 'sessions', 'locale', 'connection', 'sidebarRightTabs', 'layout', 'theme'])
  })

  it('keeps the right-Sidebar page tab type registered', () => {
    const { ctx, tabs } = makeCtx()
    apply(ctx)
    expect(tabs.registered).toHaveLength(1)
    expect(tabs.registered[0]!.id).toBe(MSTAR_PANEL_ID)
    expect(tabs.registered[0]!.kind).toBe(MSTAR_PANEL_KIND)
    expect(tabs.registered[0]!.guide![0]!.order).toBe(MSTAR_GUIDE_ORDER)
  })

  it('agrees on one id across the tab type, the main key and the sidebar row', () => {
    const { ctx, slots } = makeCtx()
    apply(ctx)
    // Both new seats wait for their declarations, like every slot registration.
    expect(slots.entries('main')).toHaveLength(0)
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)

    const disposeSeats = declareSeats(slots)
    const main = slots.entries('main')
    const rows = slots.entries('sidebar.panellist')
    expect(main).toHaveLength(1)
    expect(rows).toHaveLength(1)
    // The sidebar row's id is the main panel's key: that is what makes the row
    // open THIS panel rather than a host one.
    expect(rows[0]!.options.id).toBe(MSTAR_PANEL_ID)
    expect(main[0]!.options.key).toBe(rows[0]!.options.id as string)
    // Both seats speak the panel's namespace, and the row carries its order.
    expect(main[0]!.locale).toBe(NS)
    expect(rows[0]!.locale).toBe(NS)
    expect(rows[0]!.options.order).toBe(MSTAR_PANEL_ROW_ORDER)
    disposeSeats()
  })

  it('labels the sidebar row through the dictionary thunk, so a locale switch needs no re-registration', () => {
    const { ctx, slots, locale } = makeCtx()
    apply(ctx)
    const disposeSeats = declareSeats(slots)
    const row = slots.entries('sidebar.panellist')[0]!
    // `label` is re-read per render (slots contract), so the thunk tracks the locale.
    locale.setLocale('en')
    expect(typeof row.options.label === 'function' ? (row.options.label as () => string)() : row.options.label).toBe(
      'Morning Star Workflow',
    )
    locale.setLocale('zh')
    expect(typeof row.options.label === 'function' ? (row.options.label as () => string)() : row.options.label).toBe(
      '晨星工作流',
    )
    // The registration did not move while the locale changed.
    expect(slots.entries('sidebar.panellist')[0]).toBe(row)
    disposeSeats()
  })

  it('the row icon draws the brand glyph at the size the sidebar asks for', () => {
    const markup = renderToStaticMarkup(createElement(SidebarRowIcon, { size: 18, active: true }))
    expect(markup).toContain('<svg')
    expect(markup).toContain('width="18"')
    expect(markup).toContain('height="18"')
  })

  it('the selection call targets the panel identity, and works only once its seat is live', () => {
    const { ctx, slots, selections } = makeCtx()
    apply(ctx)
    const layout = (ctx as unknown as { layout: LayoutFace }).layout
    // Before the declaration there is no live `main` occupant: the host contract
    // is a throw, not a silent no-op — and our own call does not swallow it.
    expect(() => selectMstarPanel(layout)).toThrow(/is not registered/)

    const disposeSeats = declareSeats(slots)
    selectMstarPanel(layout)
    // `null` is the host's return-to-Conversation, not ours to wrap.
    layout.selectPanel(null)
    // `null` is the Conversation; the branded id compares as its string value.
    expect(selections.map((selected) => (selected === null ? null : String(selected)))).toEqual([MSTAR_PANEL_ID, null])
    disposeSeats()
  })

  it('a second registration of the same main key fails loudly and shadows nothing', () => {
    const { ctx, slots } = makeCtx()
    apply(ctx)
    const disposeSeats = declareSeats(slots)
    const ours = slots.entries('main')[0]!
    // The real registry owns the conflict rule (one occupancy per cell at the
    // same priority throws naming the occupant) — the plugin never needs a
    // second copy of it.
    expect(() =>
      slots.register({ name: 'main', key: MSTAR_PANEL_ID } as never, () => null),
    ).toThrow(new RegExp(`"${MSTAR_PANEL_ID}"`))
    expect(slots.entries('main')).toHaveLength(1)
    expect(slots.entries('main')[0]).toBe(ours)
    disposeSeats()
  })

  it('unload disposes both new seats with the entry', () => {
    const { ctx, slots, runEffectDisposers } = makeCtx()
    apply(ctx)
    const disposeSeats = declareSeats(slots)
    expect(slots.entries('main')).toHaveLength(1)
    expect(slots.entries('sidebar.panellist')).toHaveLength(1)

    runEffectDisposers()
    expect(slots.entries('main')).toHaveLength(0)
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)
    disposeSeats()
  })
})
