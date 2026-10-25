/**
 * Test double for the host's shared `/api` typert gateway — the panel's ONE
 * data path.
 *
 * The panel's data arrives through the channel the production client actually
 * calls: `connection.rpc.call('/api', 'mstar/panelSnapshot', { args: … })` (the
 * store-backed read) or `… 'mstar/selectWorkflow'` (the picker's commit).
 *
 * Specs therefore stub THE CHANNEL (this module) — never a component internal.
 * {@link GatewayStub.calls} records every literal call so a spec can assert the
 * request shape, and the reply helpers build the transport envelopes exactly as
 * the host half produces them.
 */

import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MstarPanelSnapshotConnection } from '../src/client/panel/panel-snapshot-client.ts'
import type { UseSessions } from '../src/client/panel/use-mstar-workflow-picker.ts'
import { createPanelStore, type PanelStoreState } from '../src/client/panel/panel-store.ts'

/** Session id / workspace directory the specs' fixtures belong to (synthetic). */
export const SESSION_ID = 's-1'
export const SESSION_CWD = '/proj'

/** The locked anchor source: exactly two members, never a payload. */
export const ANCHOR_SOURCE = { kind: 'mstar-engine', form: 'catalog' } as const

/** One recorded gateway call (the literal arguments, for request-shape asserts). */
export interface GatewayCall {
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

/** The stub gateway: the `connection` service face + the recorded calls. */
export interface GatewayStub {
  readonly connection: MstarPanelSnapshotConnection
  readonly calls: GatewayCall[]
  /** Answer every later call with these envelopes (the last one repeats). */
  reply(...envelopes: unknown[]): void
  /** Answer every later call from a function of the asserted request (its payload is the third argument). */
  replyWith(reply: (sessionId: string, cwd: string, payload: unknown) => unknown): void
  /** Answer ONE endpoint permanently (a second data path beside the queued one). */
  replyFor(endpoint: string, value: unknown): void
}

/**
 * Build a gateway stub that answers with the given transport envelopes (the
 * `{ok: true, value}` / `{ok: false, error}` results `rpc.call` resolves to).
 * With no envelopes the call resolves to `undefined` — an unreadable answer.
 */
export function stubGateway(...envelopes: unknown[]): GatewayStub {
  const calls: GatewayCall[] = []
  let queue = envelopes.length > 0 ? [...envelopes] : [undefined]
  let byRequest: ((sessionId: string, cwd: string, payload: unknown) => unknown) | null = null
  const byEndpoint = new Map<string, unknown>()
  const connection: MstarPanelSnapshotConnection = {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<never> {
        calls.push({ channel, endpoint, payload })
        const args = (payload as { args?: { sessionId?: string; cwd?: string } } | null)?.args ?? {}
        if (byEndpoint.has(endpoint)) return Promise.resolve(byEndpoint.get(endpoint) as never)
        if (byRequest !== null) return Promise.resolve(byRequest(args.sessionId ?? '', args.cwd ?? '', payload) as never)
        const next = queue.length > 1 ? queue.shift() : queue[0]
        return Promise.resolve(next as never)
      },
    },
  }
  return {
    connection,
    calls,
    reply: (...next: unknown[]) => { queue = next.length > 0 ? [...next] : [undefined]; byRequest = null },
    replyFor: (endpoint, value) => { byEndpoint.set(endpoint, value) },
    replyWith: (reply) => { byRequest = reply },
  }
}

/** The transport success envelope the typert gateway returns. */
export function gatewayOk(value: unknown): Record<string, unknown> {
  return { ok: true, value }
}

/** The transport failure envelope the typert gateway returns. */
export function gatewayError(code: string, message = code): Record<string, unknown> {
  return { ok: false, error: { code, message, details: {} } }
}

/** A finalized user message — never matches the anchor discriminator. */
export function userNode(): ConversationNode {
  return { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null }
}

/** One engine-status anchor row (the current `mstar-engine` identity) at the given message time. */
export function anchorRow(seq: number, time: number): ConversationNode {
  return {
    kind: 'context',
    seq,
    time,
    content: [],
    source: { ...ANCHOR_SOURCE },
    form: 'catalog',
  } as unknown as ConversationNode
}

/** A catalog row of a DIFFERENT mstar kind — must be skipped (the discriminator). */
export function otherKindCatalogRow(): ConversationNode {
  return {
    kind: 'context',
    seq: 3,
    time: 1_720_000_000_000,
    content: [],
    source: { kind: 'mstar-iteration-gate', form: 'catalog' },
    form: 'catalog',
  } as unknown as ConversationNode
}

/** A minimal immutable chat-target snapshot (the shape `useChat` hands the selector). */
export function chatSnapshot(nodes: readonly ConversationNode[]): ChatSnapshot {
  return {
    legacy: {
      nodes,
      turnTimings: new Map(),
      turnEnds: new Map(),
      partial: null,
      runningCalls: [],
    },
  } as unknown as ChatSnapshot
}

/** A chat-target snapshot whose ONLY content is the anchor row (or none). */
export function anchorSnapshot(anchorTime: number | null): ChatSnapshot {
  return chatSnapshot(anchorTime === null ? [userNode()] : [userNode(), anchorRow(2, anchorTime)])
}

/** Plain selector binding over the stub snapshot store — the dev-time twin of the uSES binding. */
export function bindUseChat<T>(store: { getSnapshot(): T }): SnapshotSelectorHook<T> {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(store.getSnapshot())
  }
}

/** The session-list seat: one session row carrying its workspace directory. */
export function bindUseSessions(
  sessionId: string = SESSION_ID,
  cwd: string | null = SESSION_CWD,
): UseSessions {
  const state = {
    ids: [sessionId],
    byId: { [sessionId]: cwd === null ? { id: sessionId } : { id: sessionId, cwd } },
    current: sessionId,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  } as unknown as SessionListState
  return function useSelector<S>(sel: (s: SessionListState) => S): S {
    return sel(state)
  }
}

/** A live snapshot store over an anchor snapshot (for snapshot-bump specs). */
export function anchorStore(anchorTime: number | null = 1_720_001_000_000) {
  return createSnapshotStore<ChatSnapshot>(anchorSnapshot(anchorTime))
}

/** The session id as the panel prop type expects it (branded). */
export const SESSION = SESSION_ID as SessionId

/**
 * A VISIBLE sidebar tab record — the seat's tab-information face the panel
 * body reads (plan sidebar §L6.3.2's fixture shape: sidebar / panel / tab).
 * `id` keys the entry store; `visible: true` passes the §L2.6 gate (the
 * hidden-tab half of the gate is client-seat.spec.ts's subject).
 */
export function visibleTabInfo(tabId = 'tab-1') {
  return {
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1' },
    tab: {
      id: tabId,
      kind: 'mstar-workflow',
      title: 'Morning Star Workflow',
      contentId: 'sidebar://mstar-workflow',
      visible: true,
    },
  }
}

/**
 * The visible-tab fixture kit (plan sidebar §L2.4): the seat's
 * tab-information hook + the body's entry-store share (`useStore` + the
 * baked `select` action) over ONE REAL panel store instance — the dev-time
 * twin of the sidebar seat dispatch. `create(scopeKey)` is the tests'
 * isolation seam (each kit gets its own instance); pass the same kit to two
 * renders to prove a selection survives the body's unmount/remount cycle.
 */
export function visibleTabKit(tabId = 'tab-1') {
  const instance = createPanelStore().create(tabId)
  return {
    useTabInfo: () => visibleTabInfo(tabId),
    useStore: (sel: (s: PanelStoreState) => unknown) => sel(instance.getSnapshot()),
    actions: instance.actions,
    instance,
  }
}

/**
 * Render once, let an in-flight gateway answer land, then render again — the
 * SSR twin of the browser's store-subscription re-render. The FIRST pass is
 * what issues the gateway call (the hook's own trigger), so a spec that uses
 * this helper exercises the real fetch path.
 * @param render - one synchronous render pass.
 * @returns the settled markup.
 */
export async function settleRender(render: () => string): Promise<string> {
  render()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return render()
}
