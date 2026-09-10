/**
 * Smoke spec for the dsh client-seam peer stubs (T1): proves the dev-time
 * stand-ins type-check and behave like the consumed faces of the panel contract
 * (spec §4/§5/§6.4), pinned to dsh-private commit 347a99b (2026-08-07).
 *
 * Coverage:
 * - subpath imports (`@deepseek-ai/dsh-client-ui-renderer/client` etc.) resolve
 *   through the stub `exports` maps (module load fails otherwise);
 * - the ui-conversation SlotMap merge makes `'conversation.view'` a valid
 *   register target and `ConvViewProps` carries the session standard kit;
 * - the plugin's own LocaleNamespaceMap augmentation type-checks and produces
 *   the typed `t` seat;
 * - registry semantics the panel depends on: undeclared register throws, list
 *   id/order/label (label thunk re-read per projection), `inject` declaration
 *   waiting, disposer cascade;
 * - anchor reading: latest `kind==='context' && form==='catalog'` node whose
 *   FIRST-PARTY `plugin` source carries this plugin's identity — the panel's
 *   own exported discriminator, over `ChatSnapshot.legacy.nodes`, driven by the
 *   `createSnapshotStore` test double. The source is the locked three-member
 *   arm (never a payload), and the payload itself travels over the host's
 *   shared `/api` gateway (`use-mstar-engine-status` / `engine-status-client`).
 */

import { describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { clientExports } from './client-bundles.ts'
import { resolveSlotLabel, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextMessageNode, ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConvViewProps, ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
// The plugin's OWN `LocaleNamespaceMap` augmentation (src/client/panel/locale.ts)
// is the single declaration of the `'mstar-panel'` namespace — importing it
// here exercises the real typed `t` seat instead of re-declaring a conflicting
// key union (a second `declare module` for the same namespace would collide
// under `typecheck:tests`).
import { NS, type PanelKey } from '../src/client/panel/locale.ts'
import { latestEngineStatusRow } from '../src/client/panel/use-mstar-engine-status.ts'

// The REAL client service values — the store is a plain Node-ESM module
// (direct import); SlotRegistry / LocaleRuntime are cordis services loaded
// from the browser bundles through the loader shim (tests/client-bundles.ts):
// the `/client` subpath entries are `window.__ModuleLoader__` browser bundles,
// not Node ESM modules.
type RendererClientExports = typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
const { SlotRegistry: SlotRegistryCtor } = clientExports('@deepseek-ai/dsh-client-ui-renderer') as unknown as
  Pick<RendererClientExports, 'SlotRegistry'>
type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

const zh = {
  'view.mstar-workflow': '工作流',
  'empty.waiting': '等待首条 engine-status catalog…',
  'empty.no-harness': '未检测到 Morning Star harness',
} satisfies Record<string, string>
const en = {
  'view.mstar-workflow': 'Workflow',
  'empty.waiting': 'Waiting for the first engine-status catalog…',
  'empty.no-harness': 'No Morning Star harness detected',
} satisfies Record<string, string>

/** The panel's view component shape (spec §4.2): session standard kit + typed t seat, pure read. */
const PanelView = (_props: ConvViewProps & { t: (key: PanelKey) => string }) => null

/** Register the fixture view-ring declaration chain (ui-conversation apply, spec §3.2). */
function declareViewRing(slots: SlotRegistry): () => void {
  // Runtime slot names are plain strings; the real chain is `conversation` →
  // `conversation.session` → `conversation.view`, rooted at the a-priori
  // 'root' hole (single/root). The intermediate names live OUTSIDE the
  // panel's consumed SlotMap face, so the fixture erases them (the typed
  // constraint covers only the consumed surface).
  slots.register({
    name: 'root' as 'conversation.view',
    children: { 'conversation.session': { kind: 'single', scope: 'session' } } as never,
  } as never, () => null)
  return slots.register({
    name: 'conversation.session' as 'conversation.view',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  } as never, () => null)
}

/** Project the view-ring tabs exactly like ui-conversation's `views.list()` (spec §3.2). */
function projectTabs(slots: SlotRegistry): ViewTab[] {
  return slots.entries('conversation.view').map(entry => ({
    id: entry.options.id!,
    label: resolveSlotLabel(entry.options.label) ?? entry.options.id!,
  }))
}

describe('dsh client-seam peer stubs — slot registry (conversation.view)', () => {
  it('registering into an undeclared slot throws (custom slots are not renderable)', () => {
    const core = new SlotCore()
    expect(() => core.register({ name: 'conversation.view', id: 'x' }, () => null))
      .toThrow(/slot "conversation\.view" is not declared/)
  })

  it('inject waits for the declaration, then the panel entry registers the view tab (spec §4.1 shape)', () => {
    const ctx = new Context()
    const slots = new SlotRegistryCtor(ctx)
    const locale = new LocaleRuntimeCtor(ctx)
    // Untyped single-locale register: the fixture registers only the 3 keys it
    // asserts, while the typed 2-arg form would demand the full 60-key
    // `LocaleDictOf<'mstar-panel'>` union (the real plugin dicts are covered
    // by client-panel.spec.tsx).
    locale.register(NS, 'zh', zh)
    locale.register(NS, 'en', en)
    // The real LocaleRuntime's initial locale follows the browser/persisted
    // preference (the removed peer-stub defaulted to the first-registered
    // locale) — pin zh explicitly for the deterministic assertion.
    locale.setLocale('zh')
    const t = locale.bind(NS)

    let injected = false
    const disposeInject = slots.inject('conversation.view', () => {
      injected = true
      return slots.register({
        name: 'conversation.view',
        id: 'mstar-workflow',
        order: 20,
        label: () => t('view.mstar-workflow'),
        locale: NS,
      }, PanelView)
    })
    // Not declared yet: the callback must wait, not run.
    expect(injected).toBe(false)

    const disposeDeclarer = declareViewRing(slots)
    expect(injected).toBe(true)

    // Chat-style entry at order 0 sorts before the panel (order 20).
    slots.register({ name: 'conversation.view', id: 'chat', order: 0, label: 'Chat' }, () => null)
    const tabs = projectTabs(slots)
    expect(tabs.map(tab => tab.id)).toEqual(['chat', 'mstar-workflow'])
    expect(tabs[1].label).toBe('工作流')

    // Label thunks re-read per projection: switching the locale flips the tab.
    locale.setLocale('en')
    expect(projectTabs(slots)[1].label).toBe('Workflow')

    disposeInject()
    disposeDeclarer()
  })

  it('disposing the declarer collapses the child slot (disposer cascade)', () => {
    const ctx = new Context()
    const slots = new SlotRegistryCtor(ctx)
    const disposeDeclarer = declareViewRing(slots)
    expect(slots.spec('conversation.view')).not.toBeUndefined()
    disposeDeclarer()
    expect(slots.spec('conversation.view')).toBeUndefined()
    expect(() => slots.register({ name: 'conversation.view', id: 'x' }, () => null))
      .toThrow(/not declared/)
  })
})

describe('dsh client-seam peer stubs — catalog reading (spec §5)', () => {
  const sessionId = 's-1' as SessionId
  /**
   * The persisted ANCHOR row: the first-party `plugin` arm with exactly three
   * members — the payload is NOT on the source (it is fetched over the `/api`
   * gateway), and a fourth key here would be refused by every released
   * session-format edge.
   */
  const anchorSource = { kind: 'plugin', plugin: 'mstar-engine-status', form: 'catalog' } as const
  const engineRow = {
    kind: 'context',
    seq: 2,
    time: 1_720_000_000_000,
    content: [],
    source: anchorSource,
    form: 'catalog',
  } as unknown as ContextMessageNode

  /** The panel's OWN discriminator (spec §2.4) — imported, never re-declared. */
  const latestEngineStatus = latestEngineStatusRow

  it('the anchor source is exactly the three first-party members — never a payload', () => {
    expect(Object.keys(anchorSource).sort()).toEqual(['form', 'kind', 'plugin'])
    for (const payloadMember of ['version', 'harnessDir', 'enforcement', 'iteration', 'state']) {
      expect(anchorSource).not.toHaveProperty(payloadMember)
    }
  })

  it('reads the latest mstar-engine-status catalog row from the snapshot nodes', () => {
    const store = createSnapshotStore<ChatSnapshot>({
      legacy: {
        nodes: [
          { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
          engineRow,
        ],
        turnTimings: new Map(),
        turnEnds: new Map(),
        partial: null,
        runningCalls: [],
      },
    } as unknown as ChatSnapshot)
    // useChat-shaped selector over the test double (the framework hook is a
    // uSES selector over the same bare source).
    const nodes = store.getSnapshot().legacy.nodes
    expect(latestEngineStatus(nodes)).toBe(engineRow)
  })

  it('returns null while no catalog row exists (empty state) and on a later re-emission returns the newest', () => {
    const store = createSnapshotStore<ChatSnapshot>({
      legacy: {
        nodes: [{ kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null }],
        turnTimings: new Map(),
        turnEnds: new Map(),
        partial: null,
        runningCalls: [],
      },
    } as unknown as ChatSnapshot)
    expect(latestEngineStatus(store.getSnapshot().legacy.nodes)).toBeNull()

    const newer: ContextMessageNode = {
      ...engineRow,
      seq: 4,
      time: 1_720_001_000_000,
      source: { ...anchorSource },
    }
    store.set({
      legacy: {
        nodes: [
          { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
          engineRow,
          newer,
        ],
        turnTimings: new Map(),
        turnEnds: new Map(),
        partial: null,
        runningCalls: [],
      },
    } as unknown as ChatSnapshot)
    expect(latestEngineStatus(store.getSnapshot().legacy.nodes)).toBe(newer)
  })
})
