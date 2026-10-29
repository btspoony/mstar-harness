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
 * TARGETS ARE NOT THE CLIENT'S JOB: the browser holds `{ sessionId, cwd }` and
 * nothing else, so an omitted `workflowId` / `iterationId` / `projectId` is
 * RESOLVED server-side inside `readPanelSnapshot` (the session's durable pick,
 * then the harness catalog). An asserted id is still shape-validated here and
 * still read against the server-resolved harness root — a client claim can
 * never redirect the read to another workspace.
 *
 * A WORKSPACE WITH NO HARNESS ANSWERS `no-harness`: that is a state of the
 * workspace, not a failed read, so it travels as its own kind instead of an
 * `unavailable` token the panel would have to decode.
 *
 * @module @mstar-harness/dsh/panel/panel-snapshot-endpoint
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { HarnessResolver } from '../gates/_shared.ts'
import {
  MSTAR_DASHBOARD_VIEW_METHOD,
  MSTAR_MILESTONE_ADD_METHOD,
  MSTAR_MILESTONE_ASSIGN_METHOD,
  MSTAR_MILESTONE_UPDATE_METHOD,
  MSTAR_PANEL_SNAPSHOT_METHOD,
  MSTAR_PANEL_SNAPSHOT_NAMESPACE,
} from '../engine-status-wire.ts'
import {
  addMilestone,
  assignIssueMilestone,
  readDashboardView,
  updateMilestone,
  type DashboardView,
  type IssueReceipt,
  type MilestonePatch,
  type MilestoneReceipt,
  type ReadEnvelope,
} from '@mstar-harness/engine'
import { leafSignalStateOf, type LeafSignalState, type PanelSnapshotRead } from './panel-snapshot.ts'
import { readPanelSnapshot, resolveWorkflowId, type PanelRetainedReader } from './read-panel-snapshot.ts'

/**
 * One per-view read's answer. The engine's own envelope passes through
 * unmodified (`data` may be `null` for a detail view that resolves to nothing —
 * that is an answer, not a failure), and the two non-answers keep their own
 * kinds so the client never decodes a wire token.
 */
export type DashboardViewRead =
  | { readonly kind: 'ok'; readonly envelope: ReadEnvelope<unknown> }
  | { readonly kind: 'no-harness' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** A query-parameter record: strings only, exactly what the engine's view layer validates. */
function queryParams(value: unknown): Record<string, string | undefined> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const params: Record<string, string | undefined> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') params[key] = raw
  }
  return params
}

/**
 * ONE answer shape for every milestone write (contract C1): the engine's own
 * refusal passes through verbatim — the client maps nothing and rewords
 * nothing — and a success carries the engine's own receipt.
 */
export type MilestoneWriteResult =
  | { readonly ok: true; readonly receipt: MilestoneReceipt | IssueReceipt }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** The ONE constructor of a refusal answer (an engine MilestoneError/IssueError). */
function refused(error: unknown): MilestoneWriteResult {
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code !== '') {
    return { ok: false, code, message: (error as Error)?.message ?? code }
  }
  return { ok: false, code: 'internal-error', message: (error as Error)?.message ?? 'internal-error' }
}

/** The contributing package identity (also the invocation id prefix). */
const CONTRIBUTING_PACKAGE = '@mstar-harness/dsh'
/** Logger label for the endpoint's own degradation lines. */
const ENDPOINT_LOGGER = 'mstar-panel-snapshot-endpoint'
/**
 * Logger label of the once-only leaf-signal degradation line. Its own label so
 * an operator reading host logs can grep the capability, not the endpoint.
 */
const LEAF_SIGNAL_LOGGER = 'mstar-leaf-signal'
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
  /**
   * The apply-scoped catalog reader for the `retained` facts. Optional: a host
   * without the catalog wiring answers `retained: null` and the snapshot stays
   * `ok`, so the panel never loses its workspace body to a missing catalog.
   */
  readonly readRetained?: PanelRetainedReader
  /**
   * Apply-scoped diagnostic sink for the once-only degradation line. Unset in
   * production, where the gateway writes through `ctx.logger`; a test (or a
   * host with its own log router) binds it per apply generation.
   */
  readonly warnLeafSignal?: (message: string) => void
}

/** Structural view of the live sessions service (`get(id)` only). */
interface SessionsView {
  get(id: string): unknown
}

/** Structural view of the session controller's persisted (cold) read. */
interface SessionControllerView {
  inspect(sessionId: string, signal?: AbortSignal): Promise<unknown>
}

/**
 * The warning-once gate (#619): the FIRST read that finds the shell service
 * absent yields the one line; every later read stays silent while the payload
 * keeps reporting the state. A factory so the flag is per gateway instance.
 * @returns a function yielding the line once, then `undefined`.
 */
export function leafSignalWarningOnce(): (state: LeafSignalState) => string | undefined {
  let warned = false
  return (state) => {
    if (warned || state.active) return undefined
    warned = true
    return `leaf-seat shell marker inactive: ${state.reason ?? 'shellEnv service absent'} Recovery: ${state.recovery ?? ''}`
  }
}

/** The explicit unavailable answer (one constructor — one shape everywhere). */
function unavailable(reason: string): PanelSnapshotRead {
  return { kind: 'unavailable', reason }
}

/** A non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The `SessionHeader` of either session surface, or undefined.
 *
 * The two surfaces carry it under DIFFERENT keys, read from the host's own types:
 * a live `Session` exposes `header: SessionHeader`
 * (`@deepseek-ai/dsh-session` `Session.header`), while a persisted inspection
 * exposes `meta: SessionHeader` (`@deepseek-ai/dsh-session-persistence`
 * `SessionInspection extends SessionStorageMetadata { meta: SessionHeader }`).
 * Reading only `header` made every cold session answer `session-cwd-absent`
 * while its workspace was right there.
 */
function sessionHeaderOf(value: unknown): { cwd?: unknown } | undefined {
  const row = value as { header?: unknown; meta?: unknown } | null | undefined
  const header = row?.header ?? row?.meta
  return header !== null && typeof header === 'object' ? (header as { cwd?: unknown }) : undefined
}

/** The session's workspace directory from either surface (`header.cwd` / `meta.cwd`). */
function headerCwdOf(value: unknown): string | undefined {
  return nonEmptyString(sessionHeaderOf(value)?.cwd)
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

/**
 * The ONE cwd acceptance rule, taken by both invocations (`panelSnapshot` and
 * `dashboardView`): the client's claim must be the resolved session's own — never
 * a close match, never another session's workspace.
 *
 * A `boot` resolution is compared like any other: the resolved workspace is the
 * one the host was launched in, and a claim naming anything else is refused.
 * Treating `boot` as a special case let the digest accept a request the per-view
 * read refused, which is how a panel rendered and then failed every destination.
 */
function cwdAccepted(session: { readonly cwd: string; readonly source: 'live' | 'persisted' | 'boot' }, claimed: string): boolean {
  return claimed === session.cwd
}

/** An id that could be a catalog id: no separators, no traversal segment. */
function isUnsafeId(value: string): boolean {
  return value === '.' || value === '..' || /[/\\\u0000]/.test(value)
}

/**
 * One optional id's argument-shape refusal, or undefined when it is usable.
 * An ABSENT id is legal: the service resolves it from the session's pick and
 * the harness catalog, and only an unresolvable one leaves its member
 * `not-applicable`.
 */
function refusedId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  const id = nonEmptyString(value)
  if (id === undefined) return `invalid-${name}-id`
  return isUnsafeId(id) ? `${name}-id-refused` : undefined
}

/**
 * The resolved session cwd, or the explicit reason the session is unusable.
 * `source` records WHICH surface answered: `live` (`Session.header.cwd`),
 * `persisted` (`SessionInspection.meta.cwd`) or `boot` (neither declared a
 * workspace, so the plugin reads the workspace the host was launched in and the
 * client's claim is not used as an address).
 */
type SessionCwdResolution =
  | { readonly kind: 'ok'; readonly cwd: string; readonly source: 'live' | 'persisted' | 'boot' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Host-side `mstar/panelSnapshot` service: `/api/mstar/panelSnapshot` serves the
 * composed store-backed snapshot of the session the caller asserts.
 */
export class MstarPanelSnapshotGateway extends TypertRemoteService {
  private readonly resolver: Pick<HarnessResolver, 'forWorkspace'>
  private readonly bootHarnessDir: string | null
  private readonly readRetained: PanelRetainedReader | undefined
  /**
   * The once-only warning gate. The `shellEnv` probe is NOT cached (a service
   * that loads later must flip the state), only the "already warned" fact is.
   */
  private warnLeafSignal: ((message: string) => void) | undefined
  private nextLeafSignalWarning = leafSignalWarningOnce()

  /**
   * @param ctx - owning Cordis context.
   * @param options - the apply-scoped resolver + boot root.
   */
  constructor(ctx: Context, options: PanelSnapshotEndpointOptions) {
    super(ctx, PANEL_SNAPSHOT_SERVICE, { namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE })
    this.resolver = options.resolver
    this.bootHarnessDir = options.bootHarnessDir
    this.readRetained = options.readRetained
    this.warnLeafSignal = options.warnLeafSignal
  }

  /**
   * Re-arm this gateway's once gate for a NEW apply generation (#619, review).
   *
   * The instance is kept across a re-apply (`installPanelSnapshotEndpoint`'s
   * dedupe), so a gate created in the constructor would stay consumed forever
   * and a legitimate warning could never be repeated after a reload while the
   * service is still absent. The registration entry point calls this on every
   * apply, rebinding the apply-scoped sink too, exactly like the plugin's other
   * logger sinks.
   * @param options - the re-applying scope's sink (unset ⇒ `ctx.logger`).
   */
  rearmLeafSignalWarning(options: Pick<PanelSnapshotEndpointOptions, 'warnLeafSignal'>): void {
    this.nextLeafSignalWarning = leafSignalWarningOnce()
    this.warnLeafSignal = options.warnLeafSignal
  }

  /**
   * Serve one session's composed panel snapshot after the validation chain
   * documented in the module header.
   * @param sessionId - the session whose snapshot is requested (client-asserted).
   * @param cwd - the session workspace the client believes it is reading (client-asserted).
   * @param workflowId - an asserted workflow id; resolved from the session's
   *   durable pick when omitted (the browser never supplies one).
   * @param iterationId - an asserted iteration id; resolved from the harness
   *   catalog when omitted.
   * @param projectId - an asserted project id; resolved from the harness catalog
   *   (`_default`, else the single project) when omitted.
   * @returns the snapshot, the `no-harness` kind, or the explicit unavailable
   *   state with a reason (`aborted` when the carrier cancelled).
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

  /**
   * Serve ONE engine dashboard view for a session — the per-view read path the
   * screens use (plan dsh-panel-unification Task 4a). It rides the same typert
   * contribution and the same server-side validation chain as
   * {@link panelSnapshot}: the client asserts its session and workspace, never
   * the ids or the store.
   *
   * @param sessionId - the session whose workspace is read (client-asserted).
   * @param cwd - the workspace the client believes it is reading (client-asserted,
   *   and required to equal the server-resolved session cwd).
   * @param view - the engine `DashboardView` name (`workflow-detail`, `iterations`, …).
   * @param params - the view's own query parameters, strings only.
   * @param id - the detail record id, for the three detail views.
   * @returns the engine read envelope, the `no-harness` kind, or an explicit reason.
   */
  async dashboardView(
    sessionId: string,
    cwd: string,
    view: string,
    params?: Record<string, string | undefined>,
    id?: string,
  ): Promise<DashboardViewRead> {
    try {
      const target = await this.resolveTarget(sessionId, cwd)
      if (target.kind !== 'ok') return target.kind === 'no-harness' ? { kind: 'no-harness' } : { kind: 'unavailable', reason: target.reason }
      const name = nonEmptyString(view)
      if (name === undefined) return { kind: 'unavailable', reason: 'invalid-view' }
      const envelope = await readDashboardView({
        context: { harnessDir: target.harnessDir },
        view: name as DashboardView,
        params: queryParams(params),
        ...(nonEmptyString(id) === undefined ? {} : { id: nonEmptyString(id) as string }),
      })
      return { kind: 'ok', envelope: envelope as ReadEnvelope<unknown> }
    } catch (error) {
      // A view the engine refuses (unknown name, unsafe id, a store fault) is a
      // degraded READ, never a transport error: the screen renders the reason.
      this.ctx.logger(ENDPOINT_LOGGER).warn(
        `dashboardView(${String(view)}) failed for ${String(sessionId)} (answering unavailable): ${(error as Error)?.message ?? error}`,
      )
      return { kind: 'unavailable', reason: (error as Error)?.message ?? 'internal-error' }
    }
  }

  /**
   * Create one milestone (engine `addMilestone`) under the observed store
   * revision (contract C2: `expectedStoreRevision` comes from the roadmap
   * read's envelope). One request, one transaction, no partial write.
   */
  async milestoneAdd(
    sessionId: string,
    cwd: string,
    projectId: string,
    input: { name: string; target: string | null; ordinal: number },
    mutation: { operationId: string; expectedStoreRevision: number },
  ): Promise<MilestoneWriteResult> {
    try {
      const target = await this.resolveTarget(sessionId, cwd)
      if (target.kind !== 'ok') {
        return {
          ok: false,
          code: 'store.not-active',
          message: "write refused: " + (target.kind === 'no-harness' ? 'no harness root resolves for this workspace' : target.reason),
        }
      }
      const receipt = await addMilestone(
        { harnessDir: target.harnessDir },
        { projectId, name: input.name, target: input.target ?? null, ordinal: input.ordinal },
        mutation,
      )
      return { ok: true, receipt }
    } catch (error) {
      return refused(error)
    }
  }

  /** Edit one milestone's name / target / ordinal / status (engine `updateMilestone`). */
  async milestoneUpdate(
    sessionId: string,
    cwd: string,
    projectId: string,
    milestoneId: string,
    patch: MilestonePatch,
    mutation: { operationId: string; expectedStoreRevision: number },
  ): Promise<MilestoneWriteResult> {
    try {
      const target = await this.resolveTarget(sessionId, cwd)
      if (target.kind !== 'ok') {
        return {
          ok: false,
          code: 'store.not-active',
          message: "write refused: " + (target.kind === 'no-harness' ? 'no harness root resolves for this workspace' : target.reason),
        }
      }
      const receipt = await updateMilestone({ harnessDir: target.harnessDir }, projectId, milestoneId, patch, mutation)
      return { ok: true, receipt }
    } catch (error) {
      return refused(error)
    }
  }

  /**
   * Assign one issue to a milestone - or unassign it with `milestoneId: null`
   * (engine `assignIssueMilestone`). The verb authorizes against the ACTIVE
   * coordinator execution session bound to this DSH session, so the workflow
   * id of that identity is resolved SERVER-side from the session pick and the
   * registry, exactly like the reads. A bound session's authorization outcome
   * (including `issue.scope-refused`) passes through verbatim; a session that
   * resolves NO active workflow never reaches the verb, and this adapter names
   * that cause itself under the same code.
   */
  async milestoneAssign(
    sessionId: string,
    cwd: string,
    issueId: string,
    input: { projectId: string; milestoneId: string | null; reason: string },
    mutation: { operationId: string; actor: string; expectedRevision: number; expectedStoreRevision: number },
  ): Promise<MilestoneWriteResult> {
    try {
      const target = await this.resolveTarget(sessionId, cwd)
      if (target.kind !== 'ok') {
        return {
          ok: false,
          code: 'store.not-active',
          message: "write refused: " + (target.kind === 'no-harness' ? 'no harness root resolves for this workspace' : target.reason),
        }
      }
      const workflowId = await resolveWorkflowId(target.harnessDir, target.sessionId, target.cwd)
      if (workflowId === undefined) {
        // Adapter-worded, not verbatim: the engine never ran because this
        // session has no active workflow to authorize against. The CODE is the
        // engine's own family so the client maps one axis; the message names
        // the real cause instead of an identity mismatch the store never saw.
        return {
          ok: false,
          code: 'issue.scope-refused',
          message: 'No active workflow resolves for this session, so no coordinator seat authorizes the assignment.',
        }
      }
      const receipt = await assignIssueMilestone(
        { harnessDir: target.harnessDir, caller: { sessionId: target.sessionId, role: 'coordinator', workflowId } },
        issueId,
        input,
        mutation,
      )
      return { ok: true, receipt }
    } catch (error) {
      return refused(error)
    }
  }

  /**
   * The leaf-signal state for ONE read (#619): `ctx.get('shellEnv')` is probed
   * at call time, never memoized, so a host service injected after `apply` (or
   * withdrawn) is reflected on the next panel read without a restart. An
   * apply-time check would be wrong for exactly that reason.
   *
   * REACHABILITY (review round 1): this method runs on a PANEL/STATUS READ, so
   * both the payload state and the once-per-apply-generation log line are
   * read-triggered. A host that never reads the panel gets neither — that is
   * stated in the field's reason and the changes fragment instead of being
   * papered over with a timer: no truthful apply-time signal exists, because a
   * cordis composition can mount `shellEnv` after this plugin (the deferred
   * `ctx.inject` exists for exactly that) and no "will never arrive" event
   * exists. No other consumer reads this payload today (`engine-status` does
   * not), so the panel snapshot is the one disclosure surface.
   * @returns the disclosure field for this read.
   */
  private leafSignal(): LeafSignalState {
    const state = leafSignalStateOf(this.ctx.get('shellEnv') !== undefined)
    const line = this.nextLeafSignalWarning(state)
    if (line === undefined) return state
    if (this.warnLeafSignal !== undefined) this.warnLeafSignal(line)
    else this.ctx.logger(LEAF_SIGNAL_LOGGER).warn(line)
    return state
  }

  /**
   * The shared argument chain: shape → server-resolved session → store root →
   * cwd equality. Both invocations take it, so a second read path cannot drift
   * from the first one's trust rules.
   */
  private async resolveTarget(
    sessionId: unknown,
    cwd: unknown,
  ): Promise<
    | { readonly kind: 'ok'; readonly harnessDir: string; readonly sessionId: string; readonly cwd: string }
    | { readonly kind: 'no-harness' }
    | { readonly kind: 'unavailable'; readonly reason: string }
  > {
    const sid = nonEmptyString(sessionId)
    if (sid === undefined) return { kind: 'unavailable', reason: 'invalid-session-id' }
    const claimed = nonEmptyString(cwd)
    if (claimed === undefined) return { kind: 'unavailable', reason: 'invalid-cwd' }
    if (isRefusedPath(claimed)) return { kind: 'unavailable', reason: 'cwd-refused' }
    const session = await this.resolveSessionCwd(sid)
    if (session.kind !== 'ok') return { kind: 'unavailable', reason: session.reason }
    if (!cwdAccepted(session, claimed)) return { kind: 'unavailable', reason: 'cwd-mismatch' }
    const harnessDir = this.bootHarnessDir ?? this.resolver.forWorkspace(session.cwd)
    if (harnessDir === null || harnessDir === '') return { kind: 'no-harness' }
    return { kind: 'ok', harnessDir, sessionId: sid, cwd: session.cwd }
  }

  /**
   * The carrier cancellation of THIS call, when the gateway is serving one.
   * `ctx.invocation` is set by the typert gateway for the duration of a Remote
   * call and absent otherwise (an in-process caller), so this reads the real
   * client timeout / socket close rather than a second timeout of our own.
   */
  private carrierSignal(): AbortSignal | undefined {
    return (this.ctx as { invocation?: { signal?: AbortSignal } }).invocation?.signal
  }

  /** The validation chain itself (contained by {@link panelSnapshot}). */
  private async serve(
    sessionId: unknown,
    cwd: unknown,
    workflowId: unknown,
    iterationId: unknown,
    projectId: unknown,
  ): Promise<PanelSnapshotRead> {
    const signal = this.carrierSignal()
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

    // (3) The store root comes from the SERVER-side cwd (or the boot root). A
    // workspace with no harness is NOT an error: `readPanelSnapshot` answers the
    // `no-harness` kind, which the panel renders as its inactive state.
    const harnessDir = this.bootHarnessDir ?? this.resolver.forWorkspace(session.cwd)

    // (4) The asserted cwd must be the resolved session's own — the same rule
    // `dashboardView` takes through `resolveTarget`, so the two paths cannot
    // disagree about who may read this workspace.
    if (!cwdAccepted(session, claimed)) return unavailable('cwd-mismatch')

    // An explicit `null` is ABSENT — `refusedId` above already accepted it as
    // such — so the forward site must agree. `String(null)` would hand the
    // service the literal id "null": the resolution branch then never runs, and
    // every member answers `ok` + no row for an id that cannot exist — a
    // resolution miss wearing the face of "the authority holds nothing". Reuse
    // the normalizer the validation used, so the two cannot drift apart.
    const assertedWorkflowId = nonEmptyString(workflowId)
    const assertedIterationId = nonEmptyString(iterationId)
    const assertedProjectId = nonEmptyString(projectId)

    return readPanelSnapshot({
      harnessDir,
      // The capability fact is probed here (the reader has no host context) and
      // travels as a value so one poll tick cannot disagree with the warning.
      leafSignal: this.leafSignal(),
      // The carrier's own lifetime: a client timeout or a closed socket stops
      // the read before its next view instead of leaving it running unpaid.
      ...(signal === undefined ? {} : { signal }),
      // The catalog cache is keyed by harness dir + the session's OWN identity +
      // cwd: the validated session supplies all three, never the client's claim.
      sessionId: sid,
      cwd: session.cwd,
      ...(assertedWorkflowId === undefined ? {} : { workflowId: assertedWorkflowId }),
      ...(assertedIterationId === undefined ? {} : { iterationId: assertedIterationId }),
      ...(assertedProjectId === undefined ? {} : { projectId: assertedProjectId }),
      ...(this.readRetained === undefined ? {} : { retained: this.readRetained }),
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
    if (persistedCwd !== undefined) return { kind: 'ok', cwd: persistedCwd, source: 'persisted' }
    // Both surfaces are genuinely silent: the session declares no workspace. Read
    // the one the host was launched in rather than claiming the workspace has
    // nothing — the client's claim is still not an address (see `serve`).
    const boot = nonEmptyString(process.cwd())
    if (boot !== undefined) return { kind: 'ok', cwd: boot, source: 'boot' }
    return { kind: 'unavailable', reason: 'session-cwd-absent' }
  }
}

/**
 * The ONE invocation descriptor this unit contributes: `mstar/panelSnapshot`
 * with five plain-object argument wires. Optional ids legitimately absent
 * (`src-json` codecs accept a missing wire field), so the panel can ask for the
 * workspace body without a selection.
 *
 * The descriptor is CARRIED by `mstarEngineStatusContribution()`: typert admits
 * exactly ONE contribution per `<package>#<face>`, so the package's single host
 * contribution lists it beside its own — see
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
 * The per-view invocation descriptor: `mstar/dashboardView` with the same
 * session/cwd assertion as the snapshot read, the view name, its query
 * parameters and the detail id. Carried by `mstarEngineStatusContribution()`
 * for the same one-contribution-per-face reason as the snapshot descriptor.
 */
export function mstarDashboardViewInvocation(): TypertContribution['invocations'][number] {
  return {
    id: `${CONTRIBUTING_PACKAGE}#${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_DASHBOARD_VIEW_METHOD}`,
    service: PANEL_SNAPSHOT_SERVICE,
    namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
    method: MSTAR_DASHBOARD_VIEW_METHOD,
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'src-json' } },
      { name: 'view', wire: 'view', source: 'json', codec: { mode: 'src-json' } },
      { name: 'params', wire: 'params', source: 'json', codec: { mode: 'src-json' } },
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'src-json' } },
    ],
    result: { mode: 'src-json' },
  }
}

/**
 * The milestone write descriptors (plan Task 4, contract C1). Each is one
 * plain-object argument wire on the SAME service/namespace as the reads, and
 * each is carried by `mstarEngineStatusContribution()` beside the read
 * descriptors (one contribution per package face).
 */
export function mstarMilestoneAddInvocation(): TypertContribution['invocations'][number] {
  return {
    id: `${CONTRIBUTING_PACKAGE}#${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_MILESTONE_ADD_METHOD}`,
    service: PANEL_SNAPSHOT_SERVICE,
    namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
    method: MSTAR_MILESTONE_ADD_METHOD,
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'src-json' } },
      { name: 'projectId', wire: 'projectId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'input', wire: 'input', source: 'json', codec: { mode: 'src-json' } },
      { name: 'mutation', wire: 'mutation', source: 'json', codec: { mode: 'src-json' } },
    ],
    result: { mode: 'src-json' },
  }
}

export function mstarMilestoneUpdateInvocation(): TypertContribution['invocations'][number] {
  return {
    id: `${CONTRIBUTING_PACKAGE}#${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_MILESTONE_UPDATE_METHOD}`,
    service: PANEL_SNAPSHOT_SERVICE,
    namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
    method: MSTAR_MILESTONE_UPDATE_METHOD,
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'src-json' } },
      { name: 'projectId', wire: 'projectId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'milestoneId', wire: 'milestoneId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'src-json' } },
      { name: 'mutation', wire: 'mutation', source: 'json', codec: { mode: 'src-json' } },
    ],
    result: { mode: 'src-json' },
  }
}

export function mstarMilestoneAssignInvocation(): TypertContribution['invocations'][number] {
  return {
    id: `${CONTRIBUTING_PACKAGE}#${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_MILESTONE_ASSIGN_METHOD}`,
    service: PANEL_SNAPSHOT_SERVICE,
    namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
    method: MSTAR_MILESTONE_ASSIGN_METHOD,
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'src-json' } },
      { name: 'issueId', wire: 'issueId', source: 'json', codec: { mode: 'src-json' } },
      { name: 'input', wire: 'input', source: 'json', codec: { mode: 'src-json' } },
      { name: 'mutation', wire: 'mutation', source: 'json', codec: { mode: 'src-json' } },
    ],
    result: { mode: 'src-json' },
  }
}

/**
 * Install the host half of the channel on one apply scope: just the cordis
 * service.
 *
 * The DESCRIPTOR is not registered here. typert admits exactly ONE
 * contribution per `<package>#<face>`, and this package's `host` face belongs
 * to `mstarEngineStatusContribution()`, which carries
 * {@link mstarPanelSnapshotInvocation} in its own list (the engine-status
 * module imports it). A second contribution from this module would be refused
 * at boot and leave the endpoint silently unserved.
 *
 * The present-check is the dedupe: a sibling apply / HMR re-apply keeps the
 * FIRST instance with its own resolver and boot root, exactly like the
 * engine-status gateway beside it.
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
    // The kept instance is from an EARLIER apply generation: re-arm its
    // once-gate (and rebind the generation's sink) before returning, or a
    // reload could never disclose the same absence again.
    const existing = ctx.get(PANEL_SNAPSHOT_SERVICE) as MstarPanelSnapshotGateway | undefined
    existing?.rearmLeafSignalWarning(options)
    ctx.logger(ENDPOINT_LOGGER).debug('mstar panel-snapshot gateway already registered — kept as-is (multi-fiber dedupe)')
    return
  }
  try {
    void new MstarPanelSnapshotGateway(ctx, options)
  } catch (error) {
    // The admission test lost a race: the earlier registrant stays.
    if (!(error instanceof Error) || !error.message.includes('has been registered')) throw error
    // Same generation boundary as the present-check above: the winner is kept,
    // this apply still re-arms its warning.
    const winner = ctx.get(PANEL_SNAPSHOT_SERVICE) as MstarPanelSnapshotGateway | undefined
    winner?.rearmLeafSignalWarning(options)
    ctx.logger(ENDPOINT_LOGGER).debug('mstar panel-snapshot gateway registered concurrently — kept the first (multi-fiber dedupe)')
  }
}
