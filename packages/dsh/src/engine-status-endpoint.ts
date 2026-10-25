/**
 * Host half of the panel's WRITE channel: the `mstar/selectWorkflow` endpoint on
 * the host's SHARED `/api` typert gateway.
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
 * READ PATH: none. The panel's read is `mstar/panelSnapshot`
 * (`src/panel/panel-snapshot-endpoint.ts`), served by its own service under the
 * same `mstar` wire namespace; this module's descriptor list carries that
 * invocation too (typert admits one contribution per `<package>#<face>`). What
 * remains HERE is the picker's durable WRITE — retiring the read did not retire
 * the pick.
 *
 * The browser half calls `connection.rpc.call('/api', 'mstar/selectWorkflow',
 * { args: { sessionId, cwd, workflowId } })` — the payload contract is exactly
 * one plain-object `args` field keyed by the declared parameter names.
 *
 * HARD constraint — headless boot safety: this module is reachable from
 * `apply`, and it must never make the host row statically inject `connection`
 * or `webServer`. Everything web-only is inside the optional inject child; the
 * endpoint's own reads (`ctx.get('sessions')`, `ctx.get('agents')`,
 * `ctx.get('sessionController')`) are structural and degrade when the service
 * is absent.
 *
 * VALIDATION CHAIN — one session's pick is committed and answered otherwise. In
 * order: argument shape (non-empty ids, an absolute traversal-free `cwd`), a
 * LIVE session resolved SERVER-side, an exact `cwd` match, an ACTIVE workflow id,
 * automatic-binding compatibility, and a bounded session sequence. Every failure
 * returns the explicit unavailable state WITH a reason: never another session's
 * data, never a silently-close match, never a path built from unvalidated input.
 * @module @mstar-harness/dsh/engine-status-endpoint
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkflowSelectionView } from './types.ts'
import type { HarnessResolver } from './gates/_shared.ts'
import { readExecutionWorkflowSource, type SessionHint } from './gates/workflow-selection.ts'
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from './engine-status-store.ts'
import {
  MSTAR_ENGINE_STATUS_NAMESPACE,
  MSTAR_SELECT_WORKFLOW_METHOD,
} from './engine-status-wire.ts'
// The panel's store-backed read joins THIS package's host contribution: typert
// admits one contribution per `<package>#<face>`, so a second `register` from
// the same package is refused. Its descriptor names its own service and the
// shared `mstar` namespace, so nothing here changes for the two above.
import { mstarDashboardViewInvocation, mstarPanelSnapshotInvocation } from './panel/panel-snapshot-endpoint.ts'

// The wire address is declared ONCE for both halves (`./engine-status-wire.ts`)
// and re-exported here for the host-side consumers that already import this
// module; a rename can therefore never land on one side only.
export { MSTAR_ENGINE_STATUS_NAMESPACE, MSTAR_SELECT_WORKFLOW_METHOD }

/** The contributing package identity (also the invocation id prefix). */
const CONTRIBUTING_PACKAGE = '@mstar-harness/dsh'
/** Logger label for the endpoint's own degradation lines. */
const ENDPOINT_LOGGER = 'mstar-engine-status-endpoint'

/**
 * The explicit "no answer" result. `reason` is machine-readable and always
 * present — a degraded path is never silent.
 */
export interface MstarEngineStatusUnavailableResult {
  readonly status: 'unavailable'
  readonly reason: string
}

/** The picker commit result: the durable preference was acknowledged. */
export interface MstarSelectWorkflowOk {
  readonly status: 'selected'
  readonly sessionId: string
  readonly workflowId: string
}

/** The `selectWorkflow` UI control's wire result. */
export type MstarSelectWorkflowResult = MstarSelectWorkflowOk | MstarEngineStatusUnavailableResult

/** Options the endpoint needs from the plugin's apply scope. */
export interface MstarEngineStatusEndpointOptions {
  /** The per-workspace `{HARNESS_DIR}` resolver (the same one the gates use). */
  readonly resolver: HarnessResolver
  /** The boot-resolved config root when an explicit `harnessDir` is configured. */
  readonly bootHarnessDir: string | null
  /**
   * A picker commit landed for `(harnessDir, sessionId)`: drop that session's
   * cached catalog payload + re-emission digest so the next pre-step rebuilds
   * from the acknowledged binding. Optional (a host without the catalog wiring
   * still serves the control method); a throwing hook is contained.
   */
  readonly invalidateSelection?: (harnessDir: string, sessionId: string) => void
}

/** Structural view of the live sessions service (`get(id)` only). */
interface SessionsView {
  get(id: string): unknown
}

/** Structural view of the live agents service (`get(sessionId)` only). */
interface AgentsView {
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
 * The live Session's bounded integer sequence (`Session.seq` — the log
 * length), or undefined when the structural fake/older runtime carries none.
 * A pick cannot be acknowledged without it: the exclusion floor is
 * `max(old, seq)`.
 */
function liveSeqOf(value: unknown): number | undefined {
  const seq = (value as { seq?: unknown } | null | undefined)?.seq
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : undefined
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
 * Host-side `mstar` gateway: `/api/mstar/selectWorkflow` commits the session's
 * durable workflow pick. (The panel's read is a sibling service under the same
 * wire namespace — see the module header.)
 */
export class MstarEngineStatusGateway extends TypertRemoteService {
  private readonly resolver: HarnessResolver
  private readonly bootHarnessDir: string | null
  private readonly invalidateSelection: ((harnessDir: string, sessionId: string) => void) | undefined

  /**
   * @param ctx - owning Cordis context.
   * @param options - the apply-scoped resolver + boot root (+ pick invalidation hook).
   */
  constructor(ctx: Context, options: MstarEngineStatusEndpointOptions) {
    super(ctx, MSTAR_ENGINE_STATUS_NAMESPACE)
    this.resolver = options.resolver
    this.bootHarnessDir = options.bootHarnessDir
    this.invalidateSelection = options.invalidateSelection
  }

  /**
   * Commit one session's durable workflow selection (the panel's picker).
   *
   * Mandatory before the commit: the LIVE Session (a cold/persisted-only
   * target answers `session-not-live`), an exact cwd match, a bounded integer
   * session sequence, an ACTIVE workflow id from the freshly resolved
   * registry, and no conflicting higher-priority automatic (lease/cwd)
   * binding. The exclusion floor commits as `max(stored, seq)`. An identical
   * already-stored active pick is acknowledged WITHOUT advancing the floor.
   * No client-supplied directory, holder or sequence is accepted.
   * @param sessionId - the session whose selection is committed (client-asserted).
   * @param cwd - the session workspace the client asserts (must match the live session).
   * @param workflowId - the chosen ACTIVE lifecycle id.
   * @returns the acknowledgement, or the explicit unavailable state with a reason.
   */
  async selectWorkflow(sessionId: string, cwd: string, workflowId: string): Promise<MstarSelectWorkflowResult> {
    try {
      return await this.pick(sessionId, cwd, workflowId)
    } catch (error) {
      this.ctx.logger(ENDPOINT_LOGGER).warn(
        `selectWorkflow failed for ${String(sessionId)} (answering unavailable): ${(error as Error)?.message ?? error}`,
      )
      return unavailable('internal-error')
    }
  }

  /** The picker commit chain itself (contained by {@link selectWorkflow}). */
  private async pick(sessionId: unknown, cwd: unknown, workflowId: unknown): Promise<MstarSelectWorkflowResult> {
    const sid = nonEmptyString(sessionId)
    if (sid === undefined) return unavailable('invalid-session-id')
    const claimed = nonEmptyString(cwd)
    if (claimed === undefined) return unavailable('invalid-cwd')
    if (isRefusedPath(claimed)) return unavailable('cwd-refused')
    const wid = nonEmptyString(workflowId)
    if (wid === undefined) return unavailable('invalid-workflow-id')

    // (1) The target must be LIVE: a session that only exists in the persisted
    // controller cannot commit a pick until it is resumed.
    const sessions = this.ctx.get('sessions') as SessionsView | undefined
    const live = typeof sessions?.get === 'function' ? sessions.get(sid) : undefined
    const liveCwd = headerCwdOf(live)
    if (liveCwd === undefined) return unavailable('session-not-live')
    if (liveCwd !== claimed) return unavailable('cwd-mismatch')
    const seq = liveSeqOf(live)
    if (seq === undefined) return unavailable('session-seq-unavailable')

    const harnessDir = this.bootHarnessDir ?? this.resolver.forWorkspace(liveCwd)
    if (harnessDir === null || harnessDir === '') return unavailable('no-harness-dir')

    // (2) The requested id must be an ACTIVE id of the freshly resolved
    // registry (validated with the automatic rungs omitted, so the check is
    // about the registry itself rather than this session's evidence).
    const registry = await readExecutionWorkflowSource({ harnessDir })
    if (registry.kind === 'unavailable') return unavailable(`selection-unavailable:${registry.code}`)
    const selectedGeneration = registry.storeId === undefined || registry.epoch === undefined
      ? undefined
      : { storeId: registry.storeId, epoch: registry.epoch }
    if (registry.kind === 'error') {
      const selection = registry.selection
      if (selection.kind !== 'error' || selection.code !== 'workflow.selection.unbound-multi-active' ||
        !(selection.activeWorkflowIds ?? []).includes(wid)) return unavailable('workflow-not-active')
    } else if (registry.workflowId !== wid) return unavailable('workflow-not-active')

    // (3) A higher-priority automatic binding wins: refusing the pick keeps
    // lease/cwd attribution authoritative instead of letting the panel
    // overrule it (the picker never appears for a bound session anyway).
    const structural: SessionHint = {
      cwd: liveCwd,
      sessionId: sid,
    }
    const automatic = await readExecutionWorkflowSource({ harnessDir }, structural)
    if (automatic.kind === 'unavailable') return unavailable(`selection-unavailable:${automatic.code}`)
    if (automatic.storeId !== registry.storeId || automatic.epoch !== registry.epoch) return unavailable('selection-generation-changed')
    if (automatic.kind === 'active' && automatic.workflowId !== wid) return unavailable('binding-conflict')

    // (4) Idempotent re-apply: the same stored active pick is acknowledged
    // without advancing the exclusion floor (no spurious exclusion window).
    const stored = readWorkflowSessionBinding(harnessDir, sid, liveCwd)
    if (stored.kind === 'unavailable') return unavailable(`store-${stored.reason}`)
    if (stored.binding?.selectedWorkflowId === wid) {
      return { status: 'selected', sessionId: sid, workflowId: wid }
    }

    // (5) Commit the preference and the exclusion floor `max(stored, seq)`.
    const written = updateWorkflowSessionBinding(harnessDir, sid, liveCwd, {
      selectedWorkflowId: wid,
      excludedBeforeSeq: seq,
      ...(selectedGeneration === undefined ? {} : { selectedGeneration }),
    })
    if (written.kind === 'degraded') return unavailable(`store-${written.reason}`)
    try {
      this.invalidateSelection?.(harnessDir, sid)
    } catch (error) {
      // The pick is durable already: a throwing invalidation hook degrades the
      // cache refresh only (the TTL still bounds it), never the acknowledgement.
      this.ctx.logger(ENDPOINT_LOGGER).warn(
        `selectWorkflow cache invalidation degraded for ${sid} (the durable pick stands): ${(error as Error)?.message ?? error}`,
      )
    }
    return { status: 'selected', sessionId: sid, workflowId: wid }
  }

  /**
   * The session's CURRENT selection: the durable picker record folded with the
   * session's structural identity. An unreadable binding record keeps
   * the structural hint only (the pick is unknown, never invented), and the
   * request's `sessionId` is NEVER substituted for the session identity.
   */
  private async currentSelection(
    harnessDir: string,
    sessionId: string,
    cwd: string,
    live: boolean,
  ): Promise<WorkflowSelectionView> {
    const stored = readWorkflowSessionBinding(harnessDir, sessionId, cwd)
    const selected = stored.kind === 'ok' ? stored.binding?.selectedWorkflowId : undefined
    const hint: SessionHint = {
      cwd,
      sessionId,
      ...(selected === undefined ? {} : { selectedWorkflowId: selected }),
    }
    const source = await readExecutionWorkflowSource({ harnessDir }, hint)
    if (source.kind === 'active') return { kind: 'active', workflowId: source.workflowId, dir: source.dir }
    if (source.kind === 'unavailable') {
      return { kind: 'error', code: source.code, message: source.message }
    }
    return source.selection
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
 * The generated-style invocation descriptors for the shared `/api` gateway:
 * `/api/mstar/selectWorkflow` (the panel's durable pick) and the panel's
 * read `mstar/panelSnapshot` (contributed from `panel/panel-snapshot-endpoint.ts`).
 *
 * Registered EXPLICITLY (not through `@Remote` SRC markers): the host gateway
 * checks its own `ctx.typert.local` table FIRST, while SRC discovery reads a
 * module-private marker table that a locally-resolved plugin copy can never
 * share with the host installation.
 *
 * The panel's `mstar/panelSnapshot` descriptor rides this list (typert admits
 * one contribution per package face) while its service stays separate.
 */
export function mstarEngineStatusContribution(): TypertContribution {
  return {
    package: CONTRIBUTING_PACKAGE,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      {
        id: `${CONTRIBUTING_PACKAGE}#${MSTAR_ENGINE_STATUS_NAMESPACE}/${MSTAR_SELECT_WORKFLOW_METHOD}`,
        service: MSTAR_ENGINE_STATUS_NAMESPACE,
        namespace: MSTAR_ENGINE_STATUS_NAMESPACE,
        method: MSTAR_SELECT_WORKFLOW_METHOD,
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
          { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'src-json' } },
          { name: 'workflowId', wire: 'workflowId', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
      // The panel's store-backed read rides this contribution (one per package
      // face) while serving from its OWN service — see the import note above.
      mstarPanelSnapshotInvocation(),
      // The per-view read (Task 4a): one invocation answers every engine
      // dashboard view, so a screen reads its own view instead of receiving a
      // polled envelope of five.
      mstarDashboardViewInvocation(),
    ],
  }
}

/**
 * Is a `mstar` gateway already registered on this context?
 *
 * The dedupe ADMISSION TEST, taken by
 * {@link installEngineStatusEndpoint} before the constructor so the duplicate
 * path is explicit: constructing a second `MstarEngineStatusGateway` whose
 * `provide` finds the name taken throws out of the service's `fiber.effect`,
 * and the dedupe would then rest on matching cordis' error text. This reads the
 * live registration instead — the FIRST instance keeps serving with its own
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
 * Install the host half of the channel on one apply scope.
 *
 * Two optional units, never a static inject on the plugin row:
 *  - the `mstar` service — `engineStatusServicePresent` above is the admission
 *    test, so a second apply on the same context (a sibling fiber, an HMR
 *    re-apply) does not construct a second gateway and keeps the FIRST instance
 *    with its own resolver/boot root. Constructing a second one would make the
 *    service's `provide` find the name taken and throw out of the child effect,
 *    so the present-check is the primary dedupe and the `has been registered`
 *    catch arm below covers what it cannot see: the concurrent-apply window, and
 *    an unreadable registry (the helper falls through in both cases);
 *  - the endpoint contribution, registered inside `ctx.inject(['typert'], …)`
 *    and returning that registration's own disposer — so the endpoints withdraw
 *    with the child fiber (or when the typert service goes away).
 *
 * DESCRIPTOR DEDUPE RESTS ON THE CATCH ARM. The registry does serve a presence
 * probe — `local.get(endpoint)` answers the LIVE descriptor, or `undefined` when
 * absent — but a pre-flight check cannot close the concurrent-apply window (two
 * applies can both read it absent before either registers), so the registration
 * itself stays the authoritative test. `local.hasSeen(endpoint)` is no
 * substitute: it is a HISTORY probe, `true` for an endpoint registered at least
 * once and staying `true` after it is withdrawn, so as a presence test it would
 * skip re-registration for the endpoint a reload withdrew. A duplicate makes
 * `register` throw, the arm swallows exactly that error and returns a no-op
 * disposer, so a deduped apply can never withdraw another fiber's endpoint. The
 * cost of that is the dependency on typert's error text (`already registered`);
 * a `get`-based pre-check is the way to drop the dependency — it precedes the
 * arm, but cannot replace it.
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
  if (engineStatusServicePresent(ctx)) {
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
