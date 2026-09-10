/**
 * Seat contract tests for the panel's right-Sidebar migration (plan sidebar
 * §L1, AC1/AC2/AC6): the plugin entry registers a page tab TYPE
 * (`ctx.sidebarRightTabs.register`) plus its two keyed seats — the pane body
 * (`sidebar.right.pane.tab`) and the chip title
 * (`sidebar.right.pane.tab.title`) — under the definition's `id`, and nothing
 * anywhere registers the old conversation-area view tab.
 *
 * The seat is modelled by the declared fixture chain `rightbar` →
 * `rightbar.session` → the keyed `sidebar.right.pane.tab` /
 * `sidebar.right.pane.tab.title` seats (the same shape the installed
 * ui-sidebar-right apply declares, rooted at the a-priori `root` hole) over
 * the REAL `SlotRegistry` (client-bundles.ts shim) — never by a
 * conversation.view stub. The body's hidden-tab behavior is asserted by
 * rendering `PanelView` directly under a stub `useTabInfo` (the only seat
 * capability the gate reads is `tab.visible`).
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { clientExports } from './client-bundles.ts'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { apply } from '../src/client/index.ts'
import { MSTAR_GUIDE_ORDER, MSTAR_PANEL_ID, MSTAR_PANEL_KIND, mstarPanelDefinition } from '../src/client/panel/definition.ts'
import { en, NS, zh } from '../src/client/panel/locale.ts'
import { PanelView } from '../src/client/panel/PanelView.tsx'
import { anchorSnapshot, bindUseChat, bindUseSessions, SESSION } from './gateway-stub.ts'

// The REAL client service values — SlotRegistry / LocaleRuntime are cordis
// services loaded from the browser bundles through the loader shim
// (tests/client-bundles.ts), exactly like the established plugin-entry specs.
type RendererClientExports = typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
const { SlotRegistry: SlotRegistryCtor } = clientExports('@deepseek-ai/dsh-client-ui-renderer') as unknown as
  Pick<RendererClientExports, 'SlotRegistry'>
type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

/** The definition registrations `apply` performed, in order. */
function recordingTabRegistry() {
  const registered: SidebarRightTabDefinition[] = []
  return {
    registered,
    // The registry face apply uses (the real SidebarRightTabRegistry is the
    // host's service — the recording double keeps the spec on our side of
    // the contract, per the established plugin-entry fixture technique).
    register: (definition: SidebarRightTabDefinition) => {
      registered.push(definition)
      return () => {
        const at = registered.indexOf(definition)
        if (at >= 0) registered.splice(at, 1)
      }
    },
  }
}

/** One real cordis context wired with the faces the plugin entry touches. */
function makeCtx(): {
  ctx: Context
  slots: SlotRegistry
  locale: LocaleRuntime
  tabs: ReturnType<typeof recordingTabRegistry>
  /** The disposers `apply`'s ctx.effect calls returned (the unload path). */
  runEffectDisposers: () => void
  sidebarRightTouched: () => boolean
} {
  const ctx = new Context()
  const slots = new SlotRegistryCtor(ctx)
  const locale = new LocaleRuntimeCtor(ctx)
  ;(ctx as unknown as Record<string, unknown>).slots = slots
  ;(ctx as unknown as Record<string, unknown>).locale = locale
  ;(ctx as unknown as Record<string, unknown>).sessions = {}
  // Record the effect disposers exactly as the host's unload path would run
  // them (each ctx.effect's returned disposer).
  const effectDisposers: Array<() => unknown> = []
  const effect = (ctx as unknown as { effect: (execute: () => unknown, label?: string) => () => unknown }).effect.bind(ctx)
  ;(ctx as unknown as { effect: unknown }).effect = (execute: () => unknown, label?: string) => {
    const dispose = effect(execute, label)
    effectDisposers.push(dispose)
    return dispose
  }
  const tabs = recordingTabRegistry()
  ;(ctx as unknown as Record<string, unknown>).sidebarRightTabs = tabs
  // The plugin entry must never reach the imperative controller: the guide
  // capsule's open is the host's gesture (plan §L1.3 — `ctx.sidebarRight` is
  // deliberately NOT injected). A trapping getter proves the negative.
  let touched = false
  Object.defineProperty(ctx, 'sidebarRight', {
    get() {
      touched = true
      return undefined
    },
    configurable: true,
  })
  return {
    ctx,
    slots,
    locale,
    tabs,
    runEffectDisposers: () => {
      for (const dispose of effectDisposers) dispose()
    },
    sidebarRightTouched: () => touched,
  }
}

/** The stub tab-info hook factory the fixture seat declarations carry. */
const fixtureTabInfo = () => () => ({ tab: { visible: true } })

/**
 * Declare the sidebar seat chain exactly like the installed ui-sidebar-right
 * apply does: `root` → `rightbar` → `rightbar.session` → the two keyed
 * seats. `withConversation` adds the old conversation chain to the same root
 * tree (for the no-registration negative). Slot names outside the plugin's
 * consumed SlotMap face are erased (the typed constraint covers only the
 * consumed surface).
 */
function declareFixture(slots: SlotRegistry, opts: { withConversation?: boolean } = {}): () => void {
  const disposers: Array<() => void> = []
  disposers.push(slots.register({
    name: 'root' as 'sidebar.right.pane.tab',
    children: {
      rightbar: { kind: 'single', scope: 'root' },
      ...(opts.withConversation ? { 'conversation.session': { kind: 'single', scope: 'session' } } : {}),
    },
  } as never, () => null))
  disposers.push(slots.register({
    name: 'rightbar' as 'sidebar.right.pane.tab',
    children: { 'rightbar.session': { kind: 'single', scope: 'session' } },
  } as never, () => null))
  disposers.push(slots.register({
    name: 'rightbar.session' as 'sidebar.right.pane.tab',
    children: {
      'sidebar.right.pane.tab': {
        kind: 'keyed',
        scope: 'session',
        inject: { hooks: { tabInfo: fixtureTabInfo } },
      },
      'sidebar.right.pane.tab.title': {
        kind: 'keyed',
        scope: 'session',
        inject: { hooks: { tabInfo: fixtureTabInfo } },
      },
    },
  } as never, () => null))
  if (opts.withConversation) {
    disposers.push(slots.register({
      name: 'conversation.session' as 'sidebar.right.pane.tab',
      children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    } as never, () => null))
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

describe('workflow panel — sidebar seat registration (plugin entry)', () => {
  it('registers the page tab type: id, kind, a page type (patterns/canOpen/priority omitted), one guide entry at order 20', () => {
    const { ctx, tabs } = makeCtx()
    apply(ctx)
    expect(tabs.registered).toHaveLength(1)
    const definition = tabs.registered[0]!
    expect(definition.id).toBe(MSTAR_PANEL_ID)
    expect(definition.id).toBe('@mstar-harness/dsh')
    expect(definition.kind).toBe(MSTAR_PANEL_KIND)
    expect(definition.kind).toBe('mstar-workflow')
    expect(definition).not.toHaveProperty('patterns')
    expect(definition).not.toHaveProperty('canOpen')
    expect(definition).not.toHaveProperty('priority')
    expect(definition.guide).toHaveLength(1)
    expect(definition.guide![0]!.order).toBe(MSTAR_GUIDE_ORDER)
    expect(definition.guide![0]!.order).toBe(20)
  })

  it('the guide entry thunks resolve in both locales (title follows view key, description the guide key)', () => {
    const { ctx, locale, tabs } = makeCtx()
    // apply itself registers the dictionaries — the entry owns registration.
    apply(ctx)
    locale.setLocale('en')
    const definition = tabs.registered[0]!
    const guide = definition.guide![0]!
    // The chip title thunk takes the page address; the guide thunks take none.
    // All three are thunks re-read per use, so a locale switch flips the copy
    // without re-registration.
    expect(definition.title('sidebar://mstar-workflow')).toBe('MStar Workflow')
    expect(guide.title()).toBe('MStar Workflow')
    expect(guide.description?.()).toBe('Workspace state, plans, and iteration progress')
    locale.setLocale('zh')
    expect(definition.title('sidebar://mstar-workflow')).toBe('MStar 工作流')
    expect(guide.title()).toBe('MStar 工作流')
    expect(guide.description?.()).toBe('查看工作区状态、计划与迭代进度')
  })

  it('registers the body and chip-title seats under the definition id once the seats are declared', () => {
    const { ctx, slots, tabs } = makeCtx()
    apply(ctx)
    // The tab type registers eagerly (its registry is an injected service,
    // not a slot wait); the keyed seats wait for their slot declarations.
    expect(tabs.registered).toHaveLength(1)
    expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
    expect(slots.entries('sidebar.right.pane.tab.title')).toHaveLength(0)

    const disposeFixture = declareFixture(slots)
    // The tab type stays registered (it never waited); the keyed seats appear.
    expect(tabs.registered).toHaveLength(1)
    const bodies = slots.entries('sidebar.right.pane.tab')
    const titles = slots.entries('sidebar.right.pane.tab.title')
    expect(bodies).toHaveLength(1)
    expect(titles).toHaveLength(1)
    // Both under the definition's id, the body with the panel's namespace.
    expect(bodies[0]!.options.key).toBe(MSTAR_PANEL_ID)
    expect(titles[0]!.options.key).toBe(MSTAR_PANEL_ID)
    expect(bodies[0]!.locale).toBe(NS)
    disposeFixture()
  })

  it('registers NOTHING into conversation.view even when that seat is declared, and never touches ctx.sidebarRight', () => {
    const { ctx, slots, sidebarRightTouched } = makeCtx()
    apply(ctx)
    const disposeFixture = declareFixture(slots, { withConversation: true })
    expect(slots.entries('conversation.view')).toHaveLength(0)
    expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(1)
    // The guide capsule's open is the host's gesture — the entry never needs
    // the imperative controller, and the trapping getter proves it stayed
    // untouched through apply + seat declaration.
    expect(sidebarRightTouched()).toBe(false)
    disposeFixture()
  })

  it('running the entry\'s effect disposers tears the tab type and both seat registrations down', () => {
    const { ctx, slots, tabs, runEffectDisposers } = makeCtx()
    apply(ctx)
    const disposeFixture = declareFixture(slots)
    expect(tabs.registered).toHaveLength(1)
    expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(1)
    expect(slots.entries('sidebar.right.pane.tab.title')).toHaveLength(1)
    disposeFixture()
    // Unload: the host disposes the plugin's effects — the tab type and both
    // keyed seats leave their registries with them.
    runEffectDisposers()
    expect(tabs.registered).toHaveLength(0)
    expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
    expect(slots.entries('sidebar.right.pane.tab.title')).toHaveLength(0)
  })
})

describe('workflow panel — sidebar body visibility gate (plan §L2.6)', () => {
  /** Render the body directly with a stub `useTabInfo` (waiting state: no anchor row, no transport). */
  function renderBody(visible: boolean): string {
    const locale = new LocaleRuntimeCtor(new Context())
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const store = { getSnapshot: () => anchorSnapshot(null) }
    return renderToStaticMarkup(createElement(PanelView, {
      sessionId: SESSION,
      useChat: bindUseChat(store),
      useSessions: bindUseSessions(),
      t: locale.bind(NS),
      useTabInfo: () => ({ tab: { visible } }),
    } as never))
  }

  it('tab.visible === false renders nothing (no projection, no DOM)', () => {
    expect(renderBody(false)).toBe('')
  })

  it('tab.visible === true renders the panel', () => {
    expect(renderBody(true)).toContain('data-mstar-panel="waiting"')
  })
})

describe('workflow panel — no conversation.view registration remains (AC1 negative)', () => {
  it('src/client/** contains no conversation.view registration', () => {
    const clientDir = join(import.meta.dir, '..', 'src', 'client')
    const offenders: string[] = []
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name)
        if (name.isDirectory()) visit(path)
        else if (/\.(ts|tsx)$/.test(name.name) && readFileSync(path, 'utf8').includes('conversation.view')) {
          offenders.push(path)
        }
      }
    }
    visit(clientDir)
    expect(offenders).toEqual([])
  })
})
