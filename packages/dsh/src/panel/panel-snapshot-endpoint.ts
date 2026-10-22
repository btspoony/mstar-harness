/**
 * Host half of the panel-snapshot channel: the `mstar/panelSnapshot` endpoint
 * on the host's SHARED `/api` typert gateway.
 *
 * WHY its own service: the panel's read is the store-backed one, while the
 * `mstar` engine-status gateway serves the last MODEL EMISSION (retired as a
 * read path). Two cordis services can share the `mstar` WIRE namespace — a
 * descriptor names its own service key — so this half is independently
 * installable and withdrawable, and neither retirement can take the other's
 * endpoint with it.
 *
 * VALIDATION CHAIN — mirrored from `engine-status-endpoint.ts` (the single
 * source of this order), answered entirely BEFORE any store read:
 *  1. argument shape (non-empty session id, an absolute traversal-free `cwd`,
 *     and, when present, single-safe workflow/iteration/project ids);
 *  2. the session is resolved SERVER-side — the live `ctx.sessions.get(id)`
 *     first, then the session controller's persisted `inspect(id)` fallback;
 *  3. the `{HARNESS_DIR}` comes from the SERVER-side session cwd (or the
 *     boot-resolved config root) — never from client-asserted input;
 *  4. the client-asserted `cwd` must EQUAL the resolved session cwd.
 * Only then does `readPanelSnapshot` touch the store, and its own degradation
 * is returned as a value: this endpoint never throws a transport error for a
 * store that refuses.
 *
 * @module @mstar-harness/dsh/panel/panel-snapshot-endpoint
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { HarnessResolver } from '../gates/_shared.ts'
import {
  MSTAR_PANEL_SNAPSHOT_METHOD,
  MSTAR_PANEL_SNAPSHOT_NAMESPACE,
} from '../engine-status-wire.ts'
import type { PanelSnapshotRead } from './panel-snapshot.ts'
import { readPanelSnapshot } from './read-panel-snapshot.ts'

/** The contributing package identity (also the invocation id prefix). */
const CONTRIBUTING_PACKAGE = '@mstar-harness/dsh'
/** Logger label for the endpoint's own degradation lines. */
const ENDPOINT_LOGGER = 'mstar-panel-snapshot-endpoint'
/**
 * The cordis service key of this half. Deliberately NOT the wire namespace:
 * the `mstar` key already belongs to the engine-status gateway, and a second
 * provider under the same key would collide.
 */
export const PANEL_SNAPSHOT_SERVICE = 'mstarPanelSnapshot'

/** Options the endpoint needs from the plugin's apply scope. */
export interface PanelSnapshotEndpointOptions {
  /** The per-workspace `{HARNESS_DIR}` resolver (the same one the gates use). */
  readonly resolver: Pick<HarnessResolver, 'forWorkspace'>
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

/** The explicit unavailable answer (one constructor — one shape everywhere). */
function unavailable(reason: string): PanelSnapshotRead {
  return { kind: 'unavailable', reason }
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

/** An id that could be a catalog id: no separators, no traversal segment. */
function isUnsafeId(value: string): boolean {
  return value === '.' || value === '..' || /[/\\\u0000]/.test(value)
}

/**
 * One optional id's argument-shape refusal, or undefined when it is usable.
 * An ABSENT id is legal (the corresponding view answers `not-applicable`).
 */
function refusedId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  const id = nonEmptyString(value)
  if (id === undefined) return `invalid-${name}-id`
  return isUnsafeId(id) ? `${name}-id-refused` : undefined
}

/** The resolved session cwd, or the explicit reason the session is unusable. */
type SessionCwdResolution =
  | { readonly kind: 'ok'; readonly cwd: string }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Host-side `mstar/panelSnapshot` service: `/api/mstar/panelSnapshot` serves the
 * composed store-backed snapshot of the session the caller asserts.
 */
export class MstarPanelSnapshotGateway extends TypertRemoteService {
  private readonly resolver: Pick<HarnessResolver, 'forWorkspace'>
  private readonly bootHarnessDir: string | null

  /**
   * @param ctx - owning Cordis context.
   * @param options - the apply-scoped resolver + boot root.
   */
  constructor(ctx: Context, options: PanelSnapshotEndpointOptions) {
    super(ctx, PANEL_SNAPSHOT_SERVICE, { namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE })
    this.resolver = options.resolver
    this.bootHarnessDir = options.bootHarnessDir
  }

  /**
   * Serve one session's composed panel snapshot after the validation chain
   * documented in the module header.
   * @param sessionId - the session whose snapshot is requested (client-asserted).
   * @param cwd - the session workspace the client believes it is reading (client-asserted).
   * @param workflowId - the workflow the panel has selected, when it has one.
   * @param iterationId - the iteration the panel has selected, when it has one.
   * @param projectId - the project the roadmap view is scoped to, when resolved.
   * @returns the snapshot, or the explicit unavailable state with a reason.
   */
  async panelSnapshot(
    sessionId: string,
    cwd: string,
    workflowId?: string,
    iterationId?: string,
    projectId?: string,
  ): Promise<PanelSnapshotRead> {
    try {
      return await this.serve(sessionId, cwd, workflowId, iterationId, projectId)
    } catch (error) {
      // Never a transport error: an unexpected fault is a degraded answer the
      // panel already knows how to render.
      this.ctx.logger(ENDPOINT_LOGGER).warn(
        `panelSnapshot failed for ${String(sessionId)} (answering unavailable): ${(error as Error)?.message ?? error}`,
      )
      return unavailable('internal-error')
    }
  }

  /** The validation chain itself (contained by {@link panelSnapshot}). */
  private async serve(
    sessionId: unknown,
    cwd: unknown,
    workflowId: unknown,
    iterationId: unknown,
    projectId: unknown,
  ): Promise<PanelSnapshotRead> {
    // (1) Argument shape — before anything reads the store.
    const sid = nonEmptyString(sessionId)
    if (sid === undefined) return unavailable('invalid-session-id')
    const claimed = nonEmptyString(cwd)
    if (claimed === undefined) return unavailable('invalid-cwd')
    if (isRefusedPath(claimed)) return unavailable('cwd-refused')
    for (const refused of [
      refusedId(workflowId, 'workflow'),
      refusedId(iterationId, 'iteration'),
      refusedId(projectId, 'project'),
    ]) {
      if (refused !== undefined) return unavailable(refused)
    }

    // (2) Resolve the session SERVER-side — the client's claim is not evidence.
    const session = await this.resolveSessionCwd(sid)
    if (session.kind !== 'ok') return unavailable(session.reason)

    // (3) The store root comes from the SERVER-side cwd (or the boot root).
    const harnessDir = this.bootHarnessDir ?? this.resolver.forWorkspace(session.cwd)
    if (harnessDir === null || harnessDir === '') return unavailable('no-harness-dir')

    // (4) The asserted cwd must be the resolved session's own — never a
    // close match, and never a claim onto another session's workspace.
    if (claimed !== session.cwd) return unavailable('cwd-mismatch')

    return readPanelSnapshot({
      harnessDir,
      ...(workflowId === undefined ? {} : { workflowId: String(workflowId) }),
      ...(iterationId === undefined ? {} : { iterationId: String(iterationId) }),
      ...(projectId === undefined ? {} : { projectId: String(projectId) }),
    })
  }

  /**
   * Resolve the authoritative cwd of one session: the LIVE session first
   * (`ctx.sessions.get(id)`), then the session controller's persisted
   * `inspect(id)` fallback for a session that is not currently attached.
   */
  private async resolveSessionCwd(sessionId: string): Promise<SessionCwdResolution> {
    const sessions = this.ctx.get('sessions') as SessionsView | undefined
    const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    const liveCwd = headerCwdOf(live)
    if (liveCwd !== undefined) return { kind: 'ok', cwd: liveCwd }

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
    return { kind: 'ok', cwd: persistedCwd }
  }
}

/**
 * The ONE invocation descriptor this unit contributes: `mstar/panelSnapshot`
 * with five plain-object argument wires. Optional ids legitimately absent
 * (`src-json` codecs accept a missing wire field), so the panel can ask for the
 * workspace body without a selection.
 *
 * Exported separately from {@link mstarPanelSnapshotContribution}: typert admits
 * exactly ONE contribution per `<package>#<face>`, so this descriptor is what a
 * shared host contribution carries beside its own — see
 * {@link installPanelSnapshotEndpoint} for the constraint.
 */
export function mstarPanelSnapshotInvocation(): TypertContribution['invocations'][number] {
  return {
    id: `${CONTRIBUTING_PACKAGE}#${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_PANEL_SNAPSHOT_METHOD}`,
    service: PANEL_SNAPSHOT_SERVICE,
    namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
    method: MSTAR_PANEL_SNAPSHOT_METHOD,
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'src-json' } },
      { name: 'workflowId', wire: 'workflowId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'iterationId', wire: 'iterationId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'projectId', wire: 'projectId', source: 'json', codec: { mode: 'src-json' } },
    ],
    result: { mode: 'src-json' },
  }
}

/**
 * The invocation descriptor for the shared `/api` gateway:
 * `/api/mstar/panelSnapshot` with one plain-object `args` field keyed by the
 * five declared parameter names. Optional ids legitimately absent (`src-json`
 * codecs accept a missing wire field), so the panel can ask for the workspace
 * body without a selection.
 */
export function mstarPanelSnapshotContribution(): TypertContribution {
  return {
    package: CONTRIBUTING_PACKAGE,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [mstarPanelSnapshotInvocation()],
  }
}

/**
 * A registration refusal that the SECOND registrant may ignore: the endpoint or
 * its invocation id already exists (a sibling fiber / HMR re-apply got there
 * first). A duplicate PACKAGE FACE is NOT benign — typert admits one
 * contribution per `<package>#<face>`, so that refusal means this unit's
 * descriptor can never be served, and swallowing it would leave the endpoint
 * silently absent. It propagates.
 * @param error - what `typert.register` threw.
 */
function isBenignDuplicate(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('endpoint "') || error.message.includes('invocation id "')
}

/**
 * Install the host half of the channel on one apply scope.
 *
 * Two optional units, never a static inject on the plugin row: the service
 * (present-check first, so a sibling apply / HMR re-apply keeps the FIRST
 * instance and its own resolver), and the endpoint contribution inside
 * `ctx.inject(['typert'], …)`, returning that registration's own disposer so
 * the endpoint withdraws with the child fiber.
 * @param ctx - the plugin's apply context.
 * @param options - the apply-scoped resolver + boot root.
 */
export function installPanelSnapshotEndpoint(ctx: Context, options: PanelSnapshotEndpointOptions): void {
  let present = false
  try {
    present = ctx.get(PANEL_SNAPSHOT_SERVICE) !== undefined
  } catch {
    present = false
  }
  if (present) {
    ctx.logger(ENDPOINT_LOGGER).debug('mstar panel-snapshot gateway already registered — kept as-is (multi-fiber dedupe)')
  } else {
    try {
      void new MstarPanelSnapshotGateway(ctx, options)
    } catch (error) {
      // The admission test lost a race: the earlier registrant stays.
      if (!(error instanceof Error) || !error.message.includes('has been registered')) throw error
      ctx.logger(ENDPOINT_LOGGER).debug('mstar panel-snapshot gateway registered concurrently — kept the first (multi-fiber dedupe)')
    }
  }
  ctx.inject(['typert'], (tctx) => {
    try {
      return tctx.typert.register(mstarPanelSnapshotContribution())
    } catch (error) {
      if (!isBenignDuplicate(error)) throw error
      tctx.logger(ENDPOINT_LOGGER).debug('mstar panel-snapshot endpoint registered concurrently — none on this fiber (multi-fiber dedupe)')
      return () => {}
    }
  })
}
