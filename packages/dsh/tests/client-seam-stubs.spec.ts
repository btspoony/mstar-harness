/**
 * Smoke spec for the dsh client-seam peer stubs (T1): proves the dev-time
 * stand-ins type-check and behave like the consumed faces of the panel contract
 * (spec §4/§5/§6.4), pinned to dsh-private commit 347a99b (2026-08-07).
 *
 * Coverage:
 * - subpath imports (`@deepseek-ai/dsh-client-runtime/client` etc.) resolve
 *   through the stub `exports` maps (module load fails otherwise);
 * - the ui-conversation SlotMap merge makes `'conversation.view'` a valid
 *   register target and `ConvViewProps` carries the session standard kit;
 * - the plugin's own LocaleNamespaceMap augmentation type-checks and produces
 *   the typed `t` seat;
 * - registry semantics the panel depends on: undeclared register throws, list
 *   id/order/label (label thunk re-read per projection), `inject` declaration
 *   waiting, disposer cascade;
 * - catalog reading: latest `kind==='context' && form==='catalog' &&
 *   source.kind==='mstar-engine-status'` node over `ConversationSnapshot.nodes`,
 *   driven by the `createSnapshotStore` test double.
 */

import { describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { clientExports } from './client-bundles.ts'
import { resolveSlotLabel, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextMessageNode, ConversationNode, ConversationSnapshot, SessionId, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import type { ConvViewProps, ViewTab } from '@deepseek-ai/dsh-client-ui-conversation/client'
// The plugin's OWN `LocaleNamespaceMap` augmentation (src/client/panel/locale.ts)
// is the single declaration of the `'mstar-panel'` namespace — importing it
// here exercises the real typed `t` seat instead of re-declaring a conflicting
// key union (a second `declare module` for the same namespace would collide
// under `typecheck:tests`).
import { NS, type PanelKey } from '../src/client/panel/locale.ts'

// The REAL client service values — loaded from the browser bundles through the
// loader shim (tests/client-bundles.ts): the `/client` subpath entries are
// `window.__ModuleLoader__` browser bundles, not Node ESM modules. The real
// SlotsService / LocaleService are cordis services (constructed with a
// Context), unlike the removed peer-stub stand-ins.
type RuntimeClientExports = typeof import('@deepseek-ai/dsh-client-runtime/client')
const { createSnapshotStore, SlotsService: SlotsServiceCtor } = clientExports('@deepseek-ai/dsh-client-runtime') as unknown as
  Pick<RuntimeClientExports, 'createSnapshotStore' | 'SlotsService'>
type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleService: LocaleServiceCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleService'>

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
function declareViewRing(slots: SlotsService): () => void {
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
function projectTabs(slots: SlotsService): ViewTab[] {
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
    const slots = new SlotsServiceCtor(ctx)
    const locale = new LocaleServiceCtor(ctx)
    // Untyped single-locale register: the fixture registers only the 3 keys it
    // asserts, while the typed 2-arg form would demand the full 60-key
    // `LocaleDictOf<'mstar-panel'>` union (the real plugin dicts are covered
    // by client-panel.spec.tsx).
    locale.register(NS, 'zh', zh)
    locale.register(NS, 'en', en)
    // The real LocaleService's initial locale follows the browser/persisted
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
    const slots = new SlotsServiceCtor(ctx)
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
  const engineRow = {
    kind: 'context',
    seq: 2,
    time: 1_720_000_000_000,
    content: [],
    source: { kind: 'mstar-engine-status', form: 'catalog', version: '2.0.4', harnessDir: '/proj/.mstar', state: null },
    form: 'catalog',
  } as unknown as ContextMessageNode

  /** The panel's discriminator (spec §2.4): latest `mstar-engine-status` catalog row. */
  const latestEngineStatus = (nodes: readonly ConversationNode[]) =>
    [...nodes].reverse().find(
      node => node.kind === 'context'
        && node.form === 'catalog'
        && (node.source as { kind?: string } | null)?.kind === 'mstar-engine-status',
    )

  it('reads the latest mstar-engine-status catalog row from the snapshot nodes', () => {
    const store = createSnapshotStore<ConversationSnapshot>({
      sessionId,
      nodes: [
        { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
        engineRow,
      ],
      running: false,
      openState: 'open',
      composerPhase: 'active',
      blank: false,
    } as unknown as ConversationSnapshot)
    // useSession-shaped selector over the test double (the framework hook is a
    // uSES selector over the same bare source).
    const nodes = store.getSnapshot().nodes
    expect(latestEngineStatus(nodes)).toBe(engineRow)
  })

  it('returns undefined while no catalog row exists (empty state) and on a later re-emission returns the newest', () => {
    const store = createSnapshotStore<ConversationSnapshot>({
      sessionId,
      nodes: [{ kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null }],
      running: false,
      openState: 'open',
      composerPhase: 'active',
      blank: false,
    } as unknown as ConversationSnapshot)
    expect(latestEngineStatus(store.getSnapshot().nodes)).toBeUndefined()

    const newer: ContextMessageNode = {
      ...engineRow,
      seq: 4,
      time: 1_720_001_000_000,
      source: { kind: 'mstar-engine-status', form: 'catalog', version: '2.0.4', harnessDir: '/proj/.mstar', state: null },
    }
    store.set({
      sessionId,
      nodes: [
        { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
        engineRow,
        newer,
      ],
      running: false,
      openState: 'open',
      composerPhase: 'active',
      blank: false,
    } as unknown as ConversationSnapshot)
    expect(latestEngineStatus(store.getSnapshot().nodes)).toBe(newer)
  })
})
