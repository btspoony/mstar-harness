/**
 * Dev-time stand-in for `@deepseek-ai/dsh-client-runtime/client` — the browser
 * runtime services and conversation-snapshot types consumed by the
 * `@mstar-harness/dsh` client panel plugin.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface pinned to dsh-private commit
 * 347a99b (2026-08-07 snapshot):
 *
 * - `ClientContext` = cordis `Context` with the merged service faces the panel
 *   consumes (`ctx.slots` / `ctx.sessions` here; `ctx.locale` merges in the
 *   `@deepseek-ai/dsh-client-locale` stub — same merge topology as the real
 *   packages);
 * - `ConversationSnapshot` / `ConversationNode` / `ContextMessageNode` /
 *   `KnownContextForm` — the session-log shapes the panel reads (catalog
 *   detection: `kind === 'context'` + `form === 'catalog'` +
 *   `source?.kind === 'mstar-engine-status'`);
 * - the session standard-kit merge (`useSession` / `sessionId` / `useProjection`)
 *   and the global kit (`useSessions` / `useWorkspaces`) onto the ui-slots
 *   EMPTY seats, exactly as the real runtime does;
 * - a minimal `SlotsService` twin (register/inject/entries/subscribe/getVersion
 *   over the ui-slots `SlotCore`) and a tiny `createSnapshotStore` observable
 *   for driving conversation snapshots in dev-time tests.
 *
 * Deliberate simplifications vs the real runtime: no connection stream, no
 * workspaces/session-history services, no provide-channel materialization —
 * the panel is a pure reader and consumes only the typed faces below.
 */

import type { Context } from 'cordis'
import type {
  HostObservable, MaybeSnapshotSelectorHook, ObservableSnapshot, RegisterOptions,
  SlotComponent, SnapshotSelectorHook, SlotLabel,
} from '@deepseek-ai/dsh-client-ui-slots'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsLocale, PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

/** Branded session id (mirrors the real wire type). */
export type SessionId = string & { readonly __sessionBrand?: never }

/** Context forms this UI version renders with a dedicated presentation ('catalog' is one of them). */
export type KnownContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'

/** A context/system injection surfaced in the flow. */
export interface ContextMessageNode {
  kind: 'context'
  seq: number
  /** Unix epoch ms from the source session event. */
  time: number
  content: readonly unknown[]
  /** The logged source, exactly as recorded over the wire (opaque JSON — the panel narrows by `kind`). */
  source: unknown
  /** Producer-declared information form (`contextForm` projection); null presents as opaque. */
  form: KnownContextForm | null
}

/** A finalized user message. */
export interface UserMessageNode {
  kind: 'user'
  seq: number
  time: number
  content: readonly unknown[]
  source: unknown
}

/** Fallback for surface events this UI version does not know. */
export interface UnknownSurfaceNode {
  kind: 'unknown'
  seq: number
  time: number
  type: string
  data: unknown
}

/** Finalized conversation node union (kind discriminates; the panel only reads `context` rows). */
export type ConversationNode = ContextMessageNode | UserMessageNode | UnknownSurfaceNode

/** The immutable snapshot contract Session hands to uSES. */
export interface ConversationSnapshot {
  sessionId: SessionId
  /** Human transcript plus retry notices and interrupted-turn terminal nodes in event order. */
  nodes: readonly ConversationNode[]
  running: boolean
  openState: 'cold' | 'loading' | 'open' | 'error'
  /** Input-area shape (blank / engaging / active). */
  composerPhase: 'blank' | 'engaging' | 'active'
  blank: boolean
}

/** The `useSessions` standard feed (list rows + current selection; minimal read face). */
export interface SessionListState {
  readonly byId: Readonly<Record<string, { readonly id: SessionId; readonly title: string; readonly cwd?: string }>>
  readonly order: readonly SessionId[]
}

/** The `useWorkspaces` standard feed (minimal read face). */
export interface WorkspaceListState {
  readonly byId: Readonly<Record<string, { readonly id: string; readonly title: string }>>
  readonly order: readonly string[]
}

/** The fifth framework hook seat: key-addressed projection reader (loose key — the panel does not consume projections). */
export type UseProjection = {
  (key: string): unknown
  <S>(key: string, selector: (value: unknown) => S, eq?: (a: S, b: S) => boolean): S
}

/** The conversation-snapshot selector hook supplied to session-scoped UI entries. */
export type UseConversationSession = SnapshotSelectorHook<ConversationSnapshot>

/** The outward sessions-service face (minimal: only the faces the panel's inject list implies). */
export interface ISessions {
  readonly list: ObservableSnapshot<SessionListState>
  open(id: SessionId): void
}

/**
 * The runtime's standard-kit merge onto the ui-slots EMPTY seats (mirrors
 * `runtime/src/client/index.ts` `declare module '@deepseek-ai/dsh-client-ui-slots'`).
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the session's conversation snapshot. */
    useSession: SnapshotSelectorHook<ConversationSnapshot>
    /** The framework-resolved session id (owners never pass it). */
    sessionId: SessionId
    /** Key-addressed projection reader (undefined = capability absent). */
    useProjection: UseProjection
  }
  interface SessionMaybeStandardProps {
    useSession: MaybeSnapshotSelectorHook<ConversationSnapshot>
    sessionId: SessionId | undefined
    useProjection: UseProjection
  }
  interface GlobalStandardProps {
    useSessions: SnapshotSelectorHook<SessionListState>
    useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
  }
}

declare module 'cordis' {
  interface Context {
    /** The slot registry service (register + declaration-waiting inject). */
    slots: SlotsService
    /** The outward sessions-service face. */
    sessions: ISessions
  }
}

/** The cordis context a client plugin's `apply(ctx)` receives (mirrors `ClientContext = Context`). */
export type ClientContext = Context

/**
 * Minimal twin of the runtime `SlotsService` (the real layer wraps `SlotCore`
 * with caller-fiber effects and `slots/changed` bridging; the stub keeps the
 * consumed faces — `register` / `inject` / `entries` / `subscribe` /
 * `getVersion` — synchronous and fiber-free).
 */
export class SlotsService {
  private readonly _core: SlotCore

  constructor(core?: SlotCore) {
    this._core = core ?? new SlotCore()
  }

  /** Contribute a component to a declared slot (load-time validation lives in the core). */
  register<
    K extends keyof import('@deepseek-ai/dsh-client-ui-slots').SlotMap & string,
    N extends (keyof import('@deepseek-ai/dsh-client-ui-slots').LocaleNamespaceMap & string) | undefined = undefined,
  >(
    options: RegisterOptions<K, N>,
    component: SlotComponent<PropsRuntime<K> & PropsLocale<N>>,
  ): () => void {
    return this._core.register(options, component)
  }

  /**
   * Wait for a slot's declaration lifetime, then run the callback (synchronously
   * when already declared; otherwise at the next declaration commit). The
   * disposer removes the contribution and cancels the pending wait.
   */
  inject(key: keyof import('@deepseek-ai/dsh-client-ui-slots').SlotMap & string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void {
    let active: (() => void) | undefined
    let stopped = false
    let unsubscribe = (): void => {}
    const stop = (): void => {
      if (stopped) return
      stopped = true
      unsubscribe()
      const dispose = active
      active = undefined
      dispose?.()
    }
    const reconcile = (): void => {
      if (stopped) return
      if (this._core.specDynamic(key) === undefined) return
      const effects = callback()
      const disposers = typeof effects === 'function' ? [effects] : [...effects]
      active = () => { for (const dispose of [...disposers].reverse()) dispose() }
    }
    unsubscribe = this._core.subscribeDeclaration(key, reconcile)
    reconcile()
    return stop
  }

  /** Snapshot the registered entries for a key (stable reference between mutations). */
  entries(key: keyof import('@deepseek-ai/dsh-client-ui-slots').SlotMap & string): readonly StoredEntry[] {
    return this._core.entries(key)
  }

  /** Look up a slot's declared spec (undefined while undeclared). */
  specDynamic(key: string): import('@deepseek-ai/dsh-client-ui-slots').SlotSpec<import('@deepseek-ai/dsh-client-ui-slots').SlotEntryDef> | undefined {
    return this._core.specDynamic(key)
  }

  /** Subscribe to a key's registration changes. */
  subscribe(key: keyof import('@deepseek-ai/dsh-client-ui-slots').SlotMap & string, fn: () => void): () => void {
    return this._core.subscribe(key, fn)
  }

  /** Version counter for uSES pairing. */
  getVersion(key: keyof import('@deepseek-ai/dsh-client-ui-slots').SlotMap & string): number {
    return this._core.getVersion(key)
  }
}

/**
 * Minimal observable snapshot store — the dev-time test double for driving
 * conversation snapshots (or any snapshot the panel reads) without hand-rolling
 * getSnapshot/subscribe pairs.
 */
export function createSnapshotStore<T>(initial: T): ObservableSnapshot<T> & { set(next: T): void } {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set: (next: T) => {
      current = next
      for (const fn of [...listeners]) fn()
    },
  }
}

export type { HostObservable, SlotLabel }
