/**
 * Host half of the panel's engine-status channel: the `mstar/engineStatus`
 * endpoint on the host's SHARED `/api` typert gateway.
 *
 * WHY this shape: a plugin cannot own a route. The host's typertGateway owns
 * the single `/api` interceptor (`connection.rpc.intercept('/api')` would
 * throw), and a third-party `connection.rpc.handle(...)` channel mounts through
 * `webServer` on the CALLING fiber — which would force `webServer` into this
 * plugin's static inject and pend the row on a base-only profile. The working
 * third-party pattern is therefore a cordis service extending
 * `TypertRemoteService` (the namespace IS the service key) whose endpoint
 * descriptors are contributed with `ctx.typert.register(...)` from an OPTIONAL
 * child (`ctx.inject(['typert'], …)`): a composition without a typert registry
 * simply has no `/api` endpoints, and the plugin's runtime keeps working.
 *
 * The browser half calls `connection.rpc.call('/api', 'mstar/engineStatus',
 * { args: { sessionId, cwd } })` — the payload contract is exactly one
 * plain-object `args` field keyed by the declared parameter names.
 *
 * HARD constraint — headless boot safety: this module is reachable from
 * `apply`, and it must never make the host row statically inject `connection`
 * or `webServer`. Everything web-only is inside the optional inject child; the
 * endpoint's own reads (`ctx.get('sessions')`, `ctx.get('sessionController')`)
 * are structural and degrade when the service is absent.
 *
 * VALIDATION CHAIN — the endpoint serves ONE session's snapshot and answers
 * otherwise. In order:
 *  1. argument shape (non-empty ids, an absolute traversal-free `cwd`);
 *  2. the session is resolved SERVER-side — the live `ctx.sessions.get(id)`
 *     first, then the session controller's persisted `inspect(id)` fallback;
 *  3. the `{HARNESS_DIR}` comes from the SERVER-side session cwd (or the
 *     boot-resolved config root) — never from client-asserted input;
 *  4. the store entry for that session must exist;
 *  5. the client-asserted `cwd` must EQUAL the record's `cwd`, and the record's
 *     `cwd` must equal the resolved session's cwd.
 * Every failure returns the explicit unavailable state WITH a reason: never
 * another session's data, never a silently-close match, never a path built from
 * unvalidated input.
 *
 * @module @mstar-harness/dsh/engine-status-endpoint
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { HarnessResolver } from './gates/_shared.ts'
import { readEngineStatusSnapshot, type EngineStatusSnapshotEntry } from './engine-status-store.ts'
import { MSTAR_ENGINE_STATUS_METHOD, MSTAR_ENGINE_STATUS_NAMESPACE } from './engine-status-wire.ts'

// The wire address is declared ONCE for both halves (`./engine-status-wire.ts`)
// and re-exported here for the host-side consumers that already import this
// module; a rename can therefore never land on one side only.
export { MSTAR_ENGINE_STATUS_METHOD, MSTAR_ENGINE_STATUS_NAMESPACE }

/** The contributing package identity (also the invocation id prefix). */
const CONTRIBUTING_PACKAGE = '@mstar-harness/dsh'
/** Logger label for the endpoint's own degradation lines. */
const ENDPOINT_LOGGER = 'mstar-engine-status-endpoint'

/** The served snapshot (the stored emission, echoed back with its identity). */
export interface MstarEngineStatusOk {
  readonly status: 'ok'
  readonly sessionId: string
  readonly cwd: string
  /** ISO timestamp of the emission the entry records. */
  readonly at: string
  /** The agent turn the row was emitted for. */
  readonly turn: number
  /** The exact catalog payload emitted to that session's model. */
  readonly payload: Record<string, unknown>
}

/**
 * The explicit "no answer" result. `reason` is machine-readable and always
 * present — a degraded path is never silent.
 */
export interface MstarEngineStatusUnavailableResult {
  readonly status: 'unavailable'
  readonly reason: string
}

/** The endpoint's wire result. */
export type MstarEngineStatusResult = MstarEngineStatusOk | MstarEngineStatusUnavailableResult

/** Options the endpoint needs from the plugin's apply scope. */
export interface MstarEngineStatusEndpointOptions {
  /** The per-workspace `{HARNESS_DIR}` resolver (the same one the gates use). */
  readonly resolver: HarnessResolver
  /** The boot-resolved config root when an explicit `harnessDir` is configured. */
  readonly bootHarnessDir: string | null
}

/** Structural view of the live sessions service (`get(id)` only). */
interface SessionsView {
  get(id: string): unknown
}

/** Structural view of the session controller's persisted (cold) read. */
interface SessionControllerView {
  inspect(sessionId: string, signal?: AbortSignal): Promise<unknown>
}

/** The explicit unavailable result (one constructor — one shape everywhere). */
function unavailable(reason: string): MstarEngineStatusUnavailableResult {
  return { status: 'unavailable', reason }
}

/** A non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** The `header.cwd` of a structural session/inspection object, or undefined. */
function headerCwdOf(value: unknown): string | undefined {
  const header = (value as { header?: { cwd?: unknown } } | null | undefined)?.header
  return nonEmptyString(header?.cwd)
}

/**
 * Refuse a client-asserted path that is not a plain absolute path: a relative
 * path would be resolved against the host process cwd (never the caller's), and
 * a `..` segment or NUL byte is a traversal probe, not a workspace.
 */
function isRefusedPath(cwd: string): boolean {
  if (cwd.includes('\0')) return true
  if (!isAbsolute(cwd)) return true
  return cwd.split(/[\\/]+/).includes('..')
}

/** The resolved session cwd, or the explicit reason the session is unusable. */
type SessionCwdResolution =
  | { readonly kind: 'ok'; readonly cwd: string; readonly source: 'live' | 'persisted' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Host-side `mstar/engineStatus` service: `/api/mstar/engineStatus` serves the
 * stored snapshot of the session the caller asserts.
 */
export class MstarEngineStatusGateway extends TypertRemoteService {
  private readonly resolver: HarnessResolver
  private readonly bootHarnessDir: string | null

  /**
   * @param ctx - owning Cordis context.
   * @param options - the apply-scoped resolver + boot root.
   */
  constructor(ctx: Context, options: MstarEngineStatusEndpointOptions) {
    super(ctx, MSTAR_ENGINE_STATUS_NAMESPACE)
    this.resolver = options.resolver
    this.bootHarnessDir = options.bootHarnessDir
  }

  /**
   * Serve one session's stored engine-status snapshot after the validation
   * chain documented in the module header.
   * @param sessionId - the session whose snapshot is requested (client-asserted).
   * @param cwd - the session workspace the client believes it is reading (client-asserted).
   * @returns the stored emission, or the explicit unavailable state with a reason.
   */
  async engineStatus(sessionId: string, cwd: string): Promise<MstarEngineStatusResult> {
    try {
      return await this.serve(sessionId, cwd)
    } catch (error) {
      // The endpoint never throws across the wire: an unexpected fault is
      // reported as a degraded answer, never as a host error the client has to
      // interpret (and never as another session's data).
      this.ctx.logger(ENDPOINT_LOGGER).warn(
        `engineStatus failed for ${String(sessionId)} (answering unavailable): ${(error as Error)?.message ?? error}`,
      )
      return unavailable('internal-error')
    }
  }

  /** The validation chain itself (contained by {@link engineStatus}). */
  private async serve(sessionId: unknown, cwd: unknown): Promise<MstarEngineStatusResult> {
    const sid = nonEmptyString(sessionId)
    if (sid === undefined) return unavailable('invalid-session-id')
    const claimed = nonEmptyString(cwd)
    if (claimed === undefined) return unavailable('invalid-cwd')
    if (isRefusedPath(claimed)) return unavailable('cwd-refused')

    // (2) Resolve the session SERVER-side — the client's claim is not evidence.
    const session = await this.resolveSessionCwd(sid)
    if (session.kind !== 'ok') return unavailable(session.reason)

    // (3) The store root comes from the SERVER-side cwd (or the boot root).
    const harnessDir = this.bootHarnessDir ?? this.resolver.forWorkspace(session.cwd)
    if (harnessDir === null || harnessDir === '') return unavailable('no-harness-dir')

    // (4) An entry for THAT session must exist — an absent/torn/unknown store
    // answers unavailable, never a best-effort parse.
    const read = readEngineStatusSnapshot(harnessDir, sid)
    if (read.kind !== 'ok') return unavailable(`store-${read.reason}`)
    const entry: EngineStatusSnapshotEntry = read.entry

    // (5) The asserted cwd must match the record, and the record must match the
    // resolved session — a mismatch is a stale/foreign read, not a close match.
    if (entry.cwd !== claimed) return unavailable('cwd-mismatch')
    if (entry.cwd !== session.cwd) return unavailable('session-cwd-mismatch')

    return {
      status: 'ok',
      sessionId: sid,
      cwd: entry.cwd,
      at: entry.at,
      turn: entry.turn,
      payload: entry.payload,
    }
  }

  /**
   * Resolve the authoritative cwd of one session: the LIVE session first
   * (`ctx.sessions.get(id)`), then the session controller's persisted
   * `inspect(id)` fallback for a session that is not currently attached.
   * A missing service, a missing session or a cwd-less header is an explicit
   * unavailable reason, never a guess.
   */
  private async resolveSessionCwd(sessionId: string): Promise<SessionCwdResolution> {
    const sessions = this.ctx.get('sessions') as SessionsView | undefined
    const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    const liveCwd = headerCwdOf(live)
    if (liveCwd !== undefined) return { kind: 'ok', cwd: liveCwd, source: 'live' }

    const controller = this.ctx.get('sessionController') as SessionControllerView | undefined
    if (typeof controller?.inspect !== 'function') {
      return { kind: 'unavailable', reason: live === undefined ? 'session-absent' : 'session-cwd-absent' }
    }
    let inspection: unknown
    try {
      inspection = await controller.inspect(sessionId)
    } catch {
      return { kind: 'unavailable', reason: 'session-inspect-failed' }
    }
    const persistedCwd = headerCwdOf(inspection)
    if (persistedCwd === undefined) return { kind: 'unavailable', reason: 'session-cwd-absent' }
    return { kind: 'ok', cwd: persistedCwd, source: 'persisted' }
  }
}

/**
 * The generated-style invocation descriptor for `/api/mstar/engineStatus`.
 *
 * Registered EXPLICITLY (not through `@Remote` SRC markers): the host gateway
 * checks its own `ctx.typert.local` table FIRST, while SRC discovery reads a
 * module-private marker table that a locally-resolved plugin copy can never
 * share with the host installation.
 */
export function mstarEngineStatusContribution(): TypertContribution {
  return {
    package: CONTRIBUTING_PACKAGE,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      {
        id: `${CONTRIBUTING_PACKAGE}#${MSTAR_ENGINE_STATUS_NAMESPACE}/${MSTAR_ENGINE_STATUS_METHOD}`,
        service: MSTAR_ENGINE_STATUS_NAMESPACE,
        namespace: MSTAR_ENGINE_STATUS_NAMESPACE,
        method: MSTAR_ENGINE_STATUS_METHOD,
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
          { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
    ],
  }
}

/**
 * Is a `mstar` gateway already registered on this context?
 *
 * The dedupe ADMISSION TEST, taken before the constructor so the duplicate path
 * is explicit: constructing a second `MstarEngineStatusGateway` whose `provide`
 * finds the name taken throws out of the service's `fiber.effect`, and the
 * dedupe then rests on matching cordis' error text. This reads the live
 * registration instead — the FIRST instance keeps serving with its own
 * resolver/boot root, which is what the sibling-apply spec pins.
 *
 * An unreadable registry is not a reason to skip the service: fall through to
 * the constructor, whose own guard still contains the duplicate.
 */
function engineStatusServicePresent(ctx: Context): boolean {
  try {
    return ctx.get(MSTAR_ENGINE_STATUS_NAMESPACE) !== undefined
  } catch {
    return false
  }
}

/**
 * Is this endpoint already contributed to the typert registry? The same
 * admission test for the descriptor: `typert.register()` validates before it
 * touches the effect, and a duplicate makes the registration child fail.
 * @param tctx - the context carrying the `typert` service.
 */
function engineStatusEndpointPresent(tctx: { typert?: unknown }): boolean {
  try {
    const local = (tctx.typert as {
      local?: { get?: (endpoint: string) => unknown; hasSeen?: (endpoint: string) => boolean }
    } | undefined)?.local
    const endpoint = `${MSTAR_ENGINE_STATUS_NAMESPACE}/${MSTAR_ENGINE_STATUS_METHOD}`
    if (typeof local?.get === 'function') return local.get(endpoint) !== undefined
    if (typeof local?.hasSeen === 'function') return local.hasSeen(endpoint)
  } catch {
    // An unreadable registry is not evidence of a duplicate.
  }
  return false
}

/**
 * Install the host half of the channel on one apply scope.
 *
 * Two optional units, never a static inject on the plugin row:
 *  - the `mstar` service — deduped per context by the admission test above, so
 *    a second apply on the same context (a sibling fiber, an HMR re-apply)
 *    keeps the FIRST instance and its options and does not disturb it;
 *  - the endpoint contribution, likewise skipped when the registry already
 *    serves this endpoint, and otherwise registered inside
 *    `ctx.inject(['typert'], …)` returning that registration's own disposer —
 *    so the endpoints withdraw with the child fiber (or when the typert service
 *    goes away), and a deduped apply contributes no disposer that could remove
 *    another fiber's registration.
 *
 * Withdrawal follows ownership: the endpoint lives exactly as long as its OWNER
 * fiber does. A deduped sibling that disposes withdraws nothing (it registered
 * nothing); the owner disposing withdraws the service and the endpoints, and a
 * later apply on a live context registers them afresh.
 * @param ctx - the plugin's apply context.
 * @param options - the apply-scoped resolver + boot root.
 */
export function installEngineStatusEndpoint(
  ctx: Context,
  options: MstarEngineStatusEndpointOptions,
): void {
  if (false) {
    ctx.logger(ENDPOINT_LOGGER).debug('mstar engine-status gateway already registered — kept as-is (multi-fiber dedupe)')
  } else {
    try {
      void new MstarEngineStatusGateway(ctx, options)
    } catch (error) {
      // The admission test lost a race (or the registry was unreadable): a
      // name that is taken now belongs to the earlier registrant, which stays.
      if (!(error instanceof Error) || !error.message.includes('has been registered')) throw error
      ctx.logger(ENDPOINT_LOGGER).debug('mstar engine-status gateway registered concurrently — kept the first (multi-fiber dedupe)')
    }
  }
  ctx.inject(['typert'], (tctx) => {
    if (false) {
      tctx.logger(ENDPOINT_LOGGER).debug('mstar engine-status endpoints already registered — none on this fiber (multi-fiber dedupe)')
      return () => {}
    }
    try {
      return tctx.typert.register(mstarEngineStatusContribution())
    } catch (error) {
      // Duplicate registration (a second fiber on the same host registry) is
      // expected and harmless; anything else is a real fault and propagates.
      if (!(error instanceof Error) || !error.message.includes('already registered')) throw error
      tctx.logger(ENDPOINT_LOGGER).debug('mstar engine-status endpoints registered concurrently — none on this fiber (multi-fiber dedupe)')
      return () => {}
    }
  })
}
