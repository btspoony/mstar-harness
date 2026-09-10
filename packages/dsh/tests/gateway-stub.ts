/**
 * Test double for the host's shared `/api` typert gateway — the panel's ONE
 * data path.
 *
 * The persisted catalog row is an ANCHOR (its `source` is the frozen
 * three-member first-party arm and carries no payload), so a panel fixture is
 * now the PAYLOAD THE HOST WOULD HAVE STORED for the session, delivered
 * through the channel the production client actually calls:
 * `connection.rpc.call('/api', 'mstar/engineStatus', { args: { sessionId, cwd } })`.
 *
 * Specs therefore stub THE CHANNEL (this module) — never the removed `source`
 * members. {@link GatewayStub.calls} records every literal call so a spec can
 * assert the request shape, and the reply helpers build the endpoint result
 * and the transport envelope exactly as the host half produces them.
 */

import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MstarEngineStatusConnection } from '../src/client/panel/engine-status-client.ts'
import type { UseSessions } from '../src/client/panel/use-mstar-engine-status.ts'

/** Session id / workspace directory the specs' fixtures belong to (synthetic). */
export const SESSION_ID = 's-1'
export const SESSION_CWD = '/proj'

/** The endpoint result's snapshot timestamp (freshness marker). */
export const SNAPSHOT_AT = '2024-07-03T09:23:20.000Z'

/** The locked anchor source: exactly three members, never a payload. */
export const ANCHOR_SOURCE = { kind: 'plugin', plugin: 'mstar-engine-status', form: 'catalog' } as const

/** One recorded gateway call (the literal arguments, for request-shape asserts). */
export interface GatewayCall {
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

/** The stub gateway: the `connection` service face + the recorded calls. */
export interface GatewayStub {
  readonly connection: MstarEngineStatusConnection
  readonly calls: GatewayCall[]
  /** Answer every later call with these envelopes (the last one repeats). */
  reply(...envelopes: unknown[]): void
  /** Answer every later call from a function of the asserted request. */
  replyWith(reply: (sessionId: string, cwd: string) => unknown): void
}

/**
 * Build a gateway stub that answers with the given transport envelopes (the
 * `{ok: true, value}` / `{ok: false, error}` results `rpc.call` resolves to).
 * With no envelopes the call resolves to `undefined` — an unreadable answer.
 */
export function stubGateway(...envelopes: unknown[]): GatewayStub {
  const calls: GatewayCall[] = []
  let queue = envelopes.length > 0 ? [...envelopes] : [undefined]
  let byRequest: ((sessionId: string, cwd: string) => unknown) | null = null
  const connection: MstarEngineStatusConnection = {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<never> {
        calls.push({ channel, endpoint, payload })
        const args = (payload as { args?: { sessionId?: string; cwd?: string } } | null)?.args ?? {}
        if (byRequest !== null) return Promise.resolve(byRequest(args.sessionId ?? '', args.cwd ?? '') as never)
        const next = queue.length > 1 ? queue.shift() : queue[0]
        return Promise.resolve(next as never)
      },
    },
  }
  return {
    connection,
    calls,
    reply: (...next: unknown[]) => { queue = next.length > 0 ? [...next] : [undefined]; byRequest = null },
    replyWith: (reply) => { byRequest = reply },
  }
}

/** The `{status:'ok'}` endpoint result for one stored snapshot payload. */
export function okResult(
  payload: unknown,
  over: { sessionId?: string; cwd?: string; at?: string; turn?: number } = {},
): Record<string, unknown> {
  return {
    status: 'ok',
    sessionId: over.sessionId ?? SESSION_ID,
    cwd: over.cwd ?? SESSION_CWD,
    at: over.at ?? SNAPSHOT_AT,
    turn: over.turn ?? 1,
    payload,
  }
}

/** The `{status:'unavailable', reason}` endpoint result (the host's degraded answer). */
export function unavailableResult(reason: string): Record<string, unknown> {
  return { status: 'unavailable', reason }
}

/** The transport success envelope the typert gateway returns. */
export function gatewayOk(value: unknown): Record<string, unknown> {
  return { ok: true, value }
}

/** The transport failure envelope the typert gateway returns. */
export function gatewayError(code: string, message = code): Record<string, unknown> {
  return { ok: false, error: { code, message, details: {} } }
}

/** The ready-made "a snapshot was served" envelope. */
export function servedSnapshot(
  payload: unknown,
  over: { sessionId?: string; cwd?: string; at?: string; turn?: number } = {},
): Record<string, unknown> {
  return gatewayOk(okResult(payload, over))
}

/** A finalized user message — never matches the anchor discriminator. */
export function userNode(): ConversationNode {
  return { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null }
}

/** One `mstar-engine-status` anchor row at the given message time. */
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
    source: { kind: 'plugin', plugin: 'mstar-iteration-gate', form: 'catalog' },
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
