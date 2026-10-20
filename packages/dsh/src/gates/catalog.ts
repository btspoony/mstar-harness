/**
 * Engine-status pre-step catalog — the ONE unified `mstar-engine`
 * row appended at `agent/pre-step`. *
 * `preStepCatalogListener` delegates through `next()` and appends the unified
 * catalog message (ONE compact lifecycle delta line) to the composed step
 * messages, change-gated per session+workspace: first emission, then a
 * rendered-text change only. The panel projection is compared separately, so a
 * panel-only change still persists the payload without spending a model row on
 * it. The block is a PROJECTION of the payload — the open-item rollup, the
 * branch policy, plan row scopes, the knowledge digest, the compass direction
 * and the agent-flow ledger stay payload-only (the panel renders them from the
 * persisted emission), and each dropped fact is read on demand from its own
 * authority: `mstar status tech-debt` for the open-issue rollup,
 * `mstar roadmap show` / the compass document for direction and branch policy,
 * `{KNOWLEDGE_DIR}` for the knowledge documents. There is no single
 * `status` command that serves them. The version / harness-dir /
 * enforcement watermark stays in the payload and in the always-on system
 * prompt — never in the row text. A workspace with no resolved
 * `{HARNESS_DIR}` composes no row at all. The per-workspace TTL cache
 * (`buildCatalogPayload` / `catalogPayloadFor`, Config `catalogTtlMs`) keeps
 * the hot path a timestamp compare + Map lookup between refreshes.
 *
 * v3 per-lifecycle aggregation :
 * the state + iteration sections aggregate the SELECTED workflow lifecycle
 * (compass v3.0.0 § Catalog selection rule — `resolveReadWorkflow` in
 * `workflow-selection.ts`): the session's scope/cwd/durable pick, else the
 * only active entry, else the latest terminal snapshot by mtime for an EMPTY
 * active registry; N>1 with no binding is the picker error, never first entry.
 * verbatim, `agentFlow` from the selected workflow's native event rows, open
 * issues from the issue authority, and roadmap milestones from the store
 * roadmap authority — never from retired root or workflow files.
 * The direction one-liner and the iteration gate come
 * from the SELECTED snapshot's own `compass_ref` (harness-relative, its
 * frontmatter `iteration_id` matching the snapshot id, `status` active|locked)
 * — never a directory-wide first-active compass scan.
 *
 * Session-scoped catalog identity (D4): the cache key is
 * `harnessDir + session.header.id + cwd + effective hint`, so two sessions in
 * one workspace (even the same cwd) can never share a payload; a session with
 * no stable id is built UNCACHED rather than served another session's
 * selection. The apply-scoped invalidation keeps every current session key per
 * harness dir and evicts them all on a ledger change; a picker commit
 * additionally drops that session's key (and its re-emission digest).
 *
 * Module boundary: no barrel — the entry imports by explicit relative path;
 * the wiring exports (`preStepCatalogListener`, `buildCatalogPayload`,
 * `DEFAULT_CATALOG_TTL_MS`, `CatalogCacheEntry` / `EmissionDigest`,
 * `PreStepCatalogOptions`, `panelDigestOf`, `renderEngineStatusCatalog`,
 * `createCatalogInvalidation` / `CatalogInvalidation`) are entry-internal, and
 * the two renderers/projections — plus the `gateSegment` they share with the
 * always-on digest — are exported so both modes are unit-testable.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import {
  evaluatePhaseGate,
  listCatalog,
  parseCompassFrontmatter,
  parseCompassFrontmatterText,
  queryDashboard,
  resolveRepoEnforcement,
  withStoreRead,
  listRoadmapAuthority,
} from '@mstar-harness/engine'
import type { DshSelectedGeneration } from '@mstar-harness/engine'
import type { IssuePage, ReadProjection, StoreContext } from '@mstar-harness/engine'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {
  HarnessPlanView,
  HarnessRowScopeView,
  HarnessResidualSeverity,
  HarnessResidualView,
  IterationGateView,
  MstarEngineStatusPayload,
  MstarEngineStatusSource,
  MstarHarnessProject,
  MstarHarnessState,
  MstarIterationGateView,
  ResidualFindingView,
  RoadmapSourceView,
  StoreFactsView,
  WorkflowSelectionView,
} from '../types.ts'
import { CATALOG_STATE_JOIN_LIMIT, asRecord, joinCapped, agentIdOf, sessionCwdOf, sessionHeaderIdOf, sessionHintOf, stripInterpolationHazard, HarnessResolver, iterationViolationView, iterationGateView } from './_shared.ts'
import { readAgentFlow, AGENT_FLOW_DEFAULT_LIMIT } from './agent-flow.ts'
import { readExecutionWorkflowSource, type SessionHint } from './workflow-selection.ts'
import type { ExecutionWorkflowSourceRead } from './workflow-selection.ts'
import { readWorkflowSessionBinding, writeEngineStatusSnapshot } from '../engine-status-store.ts'
/** Logger label for the engine-status catalog (dsh logger naming: `<scope>/<subject>`). */
const CATALOG_LOGGER = 'mstar/engine-status-catalog'

/** Default catalog cache refresh interval (ms) — see Config `catalogTtlMs`. */
export const DEFAULT_CATALOG_TTL_MS = 60_000

/**
 * Issue severity rank, highest first (issue-store contract §2 `severity`), and
 * the display's bucket order for the open-issue rollup. The authority's own
 * order (`listIssues`: severity rank desc → last real activity desc → id asc)
 * decides the DETAIL rows; this list only orders the severity BUCKETS so the
 * digest reads critical→nit regardless of which bucket arrived first.
 */
const ISSUE_SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'] as const

/**
 * How many open issues one catalog refresh will enumerate before it discloses
 * that the rollup is a partial view (the count then carries the page bound in
 * its text). The issue page API caps one request at 200 rows, so the rollup
 * pages; the usual harness has tens of open issues and never reaches the cap.
 */
const ISSUE_ROLLUP_MAX_PAGES = 5
/** One issue page's row cap (issue contract §5: `limit` max 200). */
const ISSUE_PAGE_LIMIT = 200

/** The plugin's own manifest version (single-version invariant; own manifest first). */
function pluginVersion(): string {
  // The module moved from `src/index.ts` (one level below the package root)
  // into `src/gates/catalog.ts` (two levels below in the source layout, but
  // still inlined one level below in the bundled `dist/index.js`). Probe both
  // depths so the manifest resolves identically from source and from the
  // bundle (behavior-preserving move; the dist path is the original one).
  for (const rel of ['../package.json', '../../package.json'] as const) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { version?: string }
      if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
    } catch {
      // no manifest at this depth — try the next
    }
  }
  return '0.0.0'
}

/**
 * The durable source of the ONE unified engine-status catalog row: the
 * plugin's producer-owned kind with a CLOSED member set. dsh session-format
 * V4 refuses the retired `{ kind: 'plugin', plugin }` wrapper at message
 * admission, so the kind itself identifies the producer; rows written by
 * older generations are lifted by the V3→V4 migration and stay readable.
 * Every fact the row publishes travels in {@link engineStatusPayload}
 * instead.
 */
function engineStatusSource(): MstarEngineStatusSource {
  return { kind: 'mstar-engine', form: 'catalog' }
}

/**
 * The selection verdict of a SYNCHRONOUS catalog consumer: it never read the
 * execution authority, so it cannot claim an ACTIVE workflow. The message is
 * model-facing (the state section renders it verbatim), so it names the
 * authority and carries the same recovery the pre-step route offers — a code
 * alone gives the agent neither a cause nor a way out.
 */
function syncAuthoritySelection(_harnessDir: string, _hint?: SessionHint): WorkflowSelectionView {
  return {
    kind: 'error',
    code: 'status.missing',
    message: 'no ACTIVE execution workflow was read by the synchronous catalog consumer \u2014 the execution authority serves the active set; register one with "mstar workflow register" (plan) or "mstar iteration register"',
  }
}

/**
 * The payload the ONE unified engine-status catalog row renders from (the
 * renderer projects the iteration gate + workspace-state digest out of it; the
 * version / harness-dir / enforcement watermark stays payload + panel data).
 * Every field is
 * boot/workspace-resolved — the unified mstar version is a
 * process-immutable manifest read, the compass enforcement resolves like
 * the gates themselves, and the iteration/state sections come from the
 * same per-workspace cached build. With an explicit `harnessDir` config
 * the payload is built ONCE at `apply()`; without one it is built on the
 * FIRST pre-step of each workspace. The whole cache entry is then
 * TTL-refreshed (Config `catalogTtlMs`, default 60000 — a mid-session
 * status/compass/issue change lands within one interval). The documented
 * staleness tradeoff keeps disk/DB I/O off the agent-loop hot path: a
 * timestamp compare + Map lookup per step between refreshes.
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 * @param hint - the carrying session's structural identity + durable pick
 *   (D4): the ONE selection resolves the state and iteration sections
 *   together, so the read path can never aggregate two different lifecycles.
 * @param facts - the store-backed open-item facts (issues rollup + knowledge
 *   catalog digest) the async pre-read produced. Omitted only by the
 *   synchronous callers (the `mstar:engine-status` context provider and
 *   direct tool/test calls): the state then discloses that the authority was
 *   not read rather than showing an empty rollup as if it were a finding of
 *   "none open", and the route decision falls to the synchronous authority
 *   guard ({@link syncAuthoritySelection}) — never a file-derived selection
 *   while the execution authority is ACTIVE.
 */
function engineStatusPayload(harnessDir: string | null, hint?: SessionHint, facts?: StoreFacts): MstarEngineStatusPayload {
  // The pre-read's ACTIVE/error/unavailable verdict is the sole route. A
  // synchronous consumer can only apply the direct-file veto and report that
  // it did not read an ACTIVE execution workflow.
  const authority = facts?.authority
  const resolved = harnessDir === null
    ? undefined
    : authority === undefined
      ? syncAuthoritySelection(harnessDir, hint)
      : authority.kind === 'active'
        ? ({ kind: 'active', workflowId: authority.workflowId, dir: authority.dir } as const)
        : authority.kind === 'error'
          ? authority.selection
          : authority.kind === 'unavailable'
            ? ({ kind: 'error', code: authority.code, message: authority.message } as const)
            : ({ kind: 'error', code: 'status.missing', message: 'no ACTIVE execution workflow was read' } as const)
  // The materialized lifecycle the route selected (an ACTIVE execution
  // authority hands its own state over): the sections below never re-read a
  // retired document to find out what the selection was about.
  const snapshot = authority?.kind === 'active' ? authority.snapshot : undefined
  const selection = resolved
  const iteration = harnessDir !== null ? iterationGateSource(harnessDir, selection, snapshot) : undefined
  return {
    version: pluginVersion(),
    harnessDir,
    enforcement: harnessDir !== null ? resolveRepoEnforcement(harnessDir) : { hard: false, source: 'none' },
    // The iteration section is OPTIONAL: when the row cannot be built (no
    // status.json / no linked compass / unreadable docs) the key must be
    // ABSENT, never `iteration: undefined` — the agent loop appends the
    // composed message to the real session, whose `Session.append` rejects
    // event data that is not losslessly JSON-serializable (undefined-valued
    // object properties included) with a hard round failure.
    ...(iteration !== undefined ? { iteration } : {}),
    state: harnessDir !== null && selection !== undefined
      ? harnessStateSource(harnessDir, selection, facts ?? UNREAD_STORE_FACTS, snapshot)
      : null,
  }
}


// Keep generation metadata off the model-facing, JSON-serialized catalog payload.
const authorityGenerationByPayload = new WeakMap<MstarEngineStatusPayload, DshSelectedGeneration>()
/** One TTL cache entry: the unified payload plus the build timestamp. */
export interface CatalogCacheEntry {
  payload: MstarEngineStatusPayload
  builtAt: number
}

/**
 * The apply-scoped catalog invalidation (D4): the `harnessDir → { session →
 * cache key }` reverse map + the digest set, created per-apply by the entry
 * (same lifetime as the cache — module-level state would survive an HMR fiber
 * restart and point at a destroyed cache).
 *
 * WHY a set per harness: two sessions in one workspace key their OWN catalog
 * payloads, so a ledger record for that harness must drop EVERY current
 * session key (never a single shared one) — and a picker commit must drop
 * exactly ONE session's key without touching its neighbours.
 */
export interface CatalogInvalidation {
  /**
   * Register `key` as one session's cache key for `harnessDir` — called by
   * `catalogPayloadFor` on hit AND build. A session whose hint changed
   * (a picker commit) has its OLD key dropped here, so the reverse map never
   * grows a key history. A null harness dir or a session with no stable id
   * has no cached entry to invalidate → no-op.
   */
  register(harnessDir: string | null, sessionId: string | undefined, key: string): void
  /**
   * Delete every current session's cache entry for `harnessDir` (the ledger
   * record path invokes this through the apply-bound hook). A missing mapping
   * is a safe no-op, and a missing entry after a previous invalidation is a
   * no-op too (the next pre-step rebuilds regardless). A throwing
   * invalidation is contained by the record path (log-only — it never blocks
   * the ledger record).
   */
  invalidate(harnessDir: string): void
  /**
   * Delete ONE session's cache entry (and its emission digest) — the picker
   * commit path: the session's durable hint changed, so the next pre-step
   * rebuilds from the acknowledged binding and re-emits the row even if the
   * rendered text is unchanged. A picker commit is an explicit re-anchor, so
   * deleting the digest intentionally re-arms the emission (documented
   * behavior; it is not part of the per-turn path).
   */
  invalidateSession(harnessDir: string | null, sessionId: string | undefined): void
}

/** Create the apply-scoped invalidation bound to ONE catalog cache + its digests. */
export function createCatalogInvalidation(
  cache: Map<string, CatalogCacheEntry>,
  digests: Map<string, EmissionDigest>,
): CatalogInvalidation {
  /** harnessDir → (session id → cache key). */
  const keysByHarnessDir = new Map<string, Map<string, string>>()
  const sessionsOf = (harnessDir: string): Map<string, string> => {
    let sessions = keysByHarnessDir.get(harnessDir)
    if (sessions === undefined) {
      sessions = new Map()
      keysByHarnessDir.set(harnessDir, sessions)
    }
    return sessions
  }
  return {
    register(harnessDir, sessionId, key) {
      if (harnessDir === null || sessionId === undefined) return
      const sessions = sessionsOf(harnessDir)
      const previous = sessions.get(sessionId)
      // Replace the session's previous key (no unbounded key history): the
      // old payload belongs to a hint this session no longer carries.
      if (previous !== undefined && previous !== key) cache.delete(previous)
      sessions.set(sessionId, key)
    },
    invalidate(harnessDir) {
      const sessions = keysByHarnessDir.get(harnessDir)
      if (sessions === undefined) return
      for (const key of sessions.values()) cache.delete(key)
    },
    invalidateSession(harnessDir, sessionId) {
      if (harnessDir === null || sessionId === undefined) return
      const key = keysByHarnessDir.get(harnessDir)?.get(sessionId)
      if (key !== undefined) cache.delete(key)
      // The digest is identity-keyed (JSON tuple of session id + cwd): drop
      // every entry of this session so the next pre-step re-emits the rebuilt
      // row (the picker commit is an explicit re-anchor). The prefix is the
      // injective first-field encoding, not a raw delimiter, so a session id
      // that is a prefix of another cannot steal it.
      const prefix = `[${JSON.stringify(sessionId)},`
      for (const digestKey of [...digests.keys()]) {
        if (digestKey.startsWith(prefix)) digests.delete(digestKey)
      }
    },
  }
}

/**
 * The cache key of ONE session's catalog payload (D4): the resolved harness
 * dir + the durable `session.header.id` + the session cwd + the EFFECTIVE
 * hint fields that can change the selection (the durable pick — cwd and
 * session id are already in the tuple). Two sessions in
 * the same cwd therefore never share a payload, and a picker commit is a
 * different key rather than a mutated entry.
 *
 * Encoded as a JSON string array so a delimiter (NUL / quote / comma) inside
 * an opaque field cannot fuse two distinct tuples — `\u0000`-join was not
 * collision-free for those values.
 */
export function catalogCacheKey(
  harnessDir: string | null,
  sessionId: string,
  cwd: string,
  hint: SessionHint | undefined,
): string {
  return JSON.stringify([
    harnessDir ?? '',
    sessionId,
    cwd,
    hint?.selectedWorkflowId ?? '',
  ])
}

/**
 * Build the unified catalog payload for one harness dir (boot for the
 * explicit config, first-use per workspace otherwise, then TTL-refreshed —
 * see `catalogPayloadFor`). Logs the manifest fallback once per build — a
 * '0.0.0' version would watermark every catalog row wrongly, so the
 * fallback is never silent.
 * @param ctx - registrant context (logger for the manifest fallback).
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 * @param hint - the carrying session's structural identity + durable pick
 *   (omitted ⇒ the automatic rungs miss and only a unique active lifecycle —
 *   or the picker error — resolves).
 */
export function buildCatalogPayload(
  ctx: Context,
  harnessDir: string | null,
  hint?: SessionHint,
  facts?: StoreFacts,
): MstarEngineStatusPayload {
  const payload = engineStatusPayload(harnessDir, hint, facts)
  if (payload.version === '0.0.0') {
    ctx.logger(CATALOG_LOGGER).warn('plugin manifest version unavailable — falling back to 0.0.0 for the engine-status catalog watermark')
  }
  return payload
}

/**
 * Look up the catalog payload for one SESSION with a TTL: within the interval
 * the cached build is reused (the agent-loop hot path is a timestamp compare +
 * Map lookup); after it the payload is rebuilt from disk (one bounded sync
 * re-read per session per interval — the mid-session plan/compass/residual
 * staleness window the user opted into; Config `catalogTtlMs`).
 *
 * A session with no stable id is built UNCACHED (its payload is still
 * rendered for its own step, but nothing is stored under a shared
 * unknown-session key that another session could read).
 *
 * The `harnessDir → session → key` reverse map is registered on BOTH hit and
 * build, so a later ledger record (dispatch/settle) can invalidate exactly the
 * affected harness's current sessions, and a picker commit can invalidate
 * exactly one session (see `createCatalogInvalidation`).
 * @param ctx - registrant context (logger for the manifest fallback).
 * @param cache - the per-session TTL cache.
 * @param invalidation - the apply-scoped reverse-map registration.
 * @param harnessDir - the resolved `{HARNESS_DIR}` for this session.
 * @param sessionId - the durable `session.header.id` (undefined ⇒ uncached build).
 * @param cwd - the session workspace the payload is resolved for.
 * @param hint - the carrying session's effective selection hint.
 * @param ttlMs - refresh interval in milliseconds.
 */
/**
 * The wired ASYNC build: the store-backed pre-read ({@link readStoreFacts} —
 * the issue rollup, the knowledge catalog digest and the selected workflow's
 * catalog-registration verdict) followed by the synchronous payload assembly.
 * This is what the pre-step listener serves, and the only way to get a payload
 * whose open-item facts came from the authority; `buildCatalogPayload` without
 * facts is the synchronous path whose state discloses that no store read
 * happened. Never throws for a refused store — the refusal travels in the
 * state's `storeFacts`.
 */
export async function buildCatalogPayloadWithStore(
  ctx: Context,
  harnessDir: string | null,
  hint?: SessionHint,
): Promise<MstarEngineStatusPayload> {
  const facts = await readBuildFacts(harnessDir, hint)
  const payload = buildCatalogPayload(ctx, harnessDir, hint, facts)
  const authority = facts?.authority
  if (authority !== undefined && authority.kind !== 'unavailable' &&
    authority.storeId !== undefined && authority.epoch !== undefined) {
    authorityGenerationByPayload.set(payload, { storeId: authority.storeId, epoch: authority.epoch })
  }
  return payload
}

async function catalogPayloadFor(
  ctx: Context,
  cache: Map<string, CatalogCacheEntry>,
  invalidation: CatalogInvalidation,
  harnessDir: string | null,
  sessionId: string | undefined,
  cwd: string,
  hint: SessionHint | undefined,
  ttlMs: number,
): Promise<MstarEngineStatusPayload> {
  if (sessionId === undefined) return await buildCatalogPayloadWithStore(ctx, harnessDir, hint)
  const key = catalogCacheKey(harnessDir, sessionId, cwd, hint)
  const entry = cache.get(key)
  if (entry !== undefined && Date.now() - entry.builtAt < ttlMs) {
    invalidation.register(harnessDir, sessionId, key)
    return entry.payload
  }
  const payload = await buildCatalogPayloadWithStore(ctx, harnessDir, hint)
  cache.set(key, { payload, builtAt: Date.now() })
  invalidation.register(harnessDir, sessionId, key)
  return payload
}

/**
 * The async pre-read ONE cache refresh performs before the payload is built:
 * the store-backed open-item facts, plus the catalog-registration verdict for
 * the SELECTED workflow. A workflow whose catalog registration is still
 * pending is never displayed as a healthy active lifecycle — the state's
 * selection is replaced by the structured refusal (the same channel a v1 root
 * or an unbound multi-active set uses), with the reconcile command in the
 * message, so the model sees the half-registered workspace before it
 * dispatches into it (where the dispatch gate refuses outright).
 */
async function readBuildFacts(harnessDir: string | null, hint: SessionHint | undefined): Promise<StoreFacts | undefined> {
  if (harnessDir === null) return undefined
  const facts = await readStoreFacts(harnessDir)
  const authority = await readExecutionWorkflowSource({ harnessDir }, hint)
  return { ...facts, authority }
}

/** Renderer options for {@link renderEngineStatusCatalog}. */
export interface RenderEngineStatusOptions {
  /**
   * Re-render the watermark trio. Set while no `system-prompt` registration is
   * CONFIRMED live (the service is absent, the asynchronous registration
   * failed, or an earlier registration was disposed): there the always-on
   * `mstar:harness-rules` / `mstar:engine-status` prompt does not carry the
   * version / harness-dir / enforcement context, so suppressing the trio would
   * leave the model with none of it. The default (live registration) keeps the
   * row watermark-free.
   */
  readonly includeWatermark?: boolean
}

/** The plan status that keeps a row out of the compact `plans:` join. */
const DONE_PLAN_STATUS = 'Done'

/**
 * Model-facing rendering of the unified engine-status catalog (the
 * `<mstar_engine_status>` block): the wrapper plus ONE compact delta line.
 *
 * The row is a DELTA, not a snapshot: it carries only the lifecycle facts a
 * step acts on — the selected `workflow`, its non-Done `plans`, the
 * `branch` anchors, and (when a steering compass resolved) the phase-`gate`
 * verdict. Residual counts and issue detail rows, the branch policy, plan
 * row scopes, the knowledge digest, the compass direction and the agent-flow
 * ledger all stay in the payload (the panel renders them) and out of the row
 * text. This is a PROJECTION of the payload, not a byte-identical render: the
 * version / harness-dir / enforcement watermark stays in the payload (the
 * panel meta dock renders it) and — while the prompt registration is live —
 * stays model-visible once in the always-on system prompt
 * (`mstar:engine-status` digest + `mstar:harness-rules`), so the steady-state
 * row does not repeat it.
 *
 * The row is ONE delta line, plus the `workflow warning:` disclosure when the
 * selection carries a warning (and the watermark trio on the
 * registration-less fallback) — never more.
 *
 * The row text is also the emission comparison key's model half
 * ({@link preStepCatalogListener}): dropping a field here drops it from the
 * re-emission trigger too, which is what stops an incidental count change from
 * appending an identical-looking row. Anything the model must still be able to
 * notice therefore has to be rendered here — or carried by the always-on
 * digest (`system-prompt.ts`).
 *
 * `includeWatermark` is the fallback channel while NO `system-prompt`
 * registration is confirmed live (the service absent, the asynchronous
 * registration failed, or a previous registration was disposed): the trio then
 * leads the block, exactly as the pre-trim renderer emitted it, so the facts
 * the rest of the harness assumes are model-visible still reach the model.
 * Exported (like {@link panelDigestOf}) so both modes are unit-testable.
 * @param source - the payload the current step composed.
 * @param options - see {@link RenderEngineStatusOptions}.
 */
export function renderEngineStatusCatalog(
  source: MstarEngineStatusPayload,
  options: RenderEngineStatusOptions = {},
): string {
  const lines = ['<mstar_engine_status>']
  if (options.includeWatermark === true) {
    const enforcement = `${source.enforcement.hard ? 'hard' : 'soft'}${source.enforcement.source === 'none' ? '' : ` (${source.enforcement.source})`}`
    lines.push(`mstar version: ${source.version}`)
    lines.push(`harness dir: ${stripInterpolationHazard(source.harnessDir ?? 'none')}`)
    lines.push(`enforcement: ${enforcement}`)
  }
  const state = source.state
  if (state !== null) {
    if (state.selection.kind === 'error') {
      // Clear selection error (v1/unmigrated root, no snapshots): the
      // operator-visible reason replaces the data line — the aggregates
      // are empty by construction and must not read as "no plans".
      lines.push(`workflow selection: ERROR (${state.selection.code}) ${state.selection.message}`)
    } else {
      const segments = [`workflow: ${state.selection.workflowId} (${state.selection.kind})`]
      // Non-Done rows only: a completed plan is not a decision the next step
      // makes, and the always-on digest (`system-prompt.ts`) renders the same
      // non-Done filter — the two surfaces never duplicate a Done row. An
      // EMPTY registry and an all-Done workflow must not share one text: "none
      // registered" (nothing to pick up yet) and "all done" (nothing left) are
      // different states for the next step.
      const pending = state.plans.filter((plan) => plan.status !== DONE_PLAN_STATUS)
      const plans = state.plans.length === 0
        ? 'none registered'
        : pending.length === 0
          ? 'all done'
          : joinCapped(pending, CATALOG_STATE_JOIN_LIMIT, ' ', (plan) => `${plan.id}(${plan.status})`)
      segments.push(`plans: ${plans}`)
      if (state.iterationBaseBranch !== null && state.targetBranch !== null) {
        segments.push(`branch: ${state.iterationBaseBranch} → ${state.targetBranch}`)
      }
      // The iteration section is the phase GATE: the workflow id it names is
      // already on this line, so only the verdict + transition join it.
      if (source.iteration !== undefined) segments.push(gateSegment(source.iteration.gate))
      lines.push(segments.join(' | '))
      if (state.selection.kind === 'active' && state.selection.warning !== undefined) {
        lines.push(`workflow warning: ${state.selection.warning.code} ${state.selection.warning.message}`)
      }
    }
  }
  lines.push('</mstar_engine_status>')
  return lines.join('\n')
}

/**
 * The compact `gate:` segment: verdict + the phase transition it points at,
 * plus the violation codes on a FAIL (a bare FAIL would name no cause).
 *
 * Exported because the always-on `mstar:engine-status` digest
 * (`system-prompt.ts`) carries the SAME segment after compaction — one format,
 * not two drifting copies (`system-prompt.ts` already imports this module).
 * @param gate - the evaluated iteration phase gate.
 */
export function gateSegment(gate: IterationGateView): string {
  if (gate.ok) return `gate: PASS (${gate.transition})`
  const codes = gate.violations.map((violation) => violation.code).join(', ')
  return codes === '' ? `gate: FAIL (${gate.transition})` : `gate: FAIL (${gate.transition}): ${codes}`
}

/**
 * The PANEL-relevant projection of one payload, as the panel side of the
 * emission digest's comparison: the payload JSON with
 * `state.storeFacts.storeRevision` normalized to `null`.
 *
 * Why exactly that field: emitting persists the payload (`persistEngineStatusSnapshot`),
 * and that store write advances the shared store revision 1:1 — so comparing
 * raw payloads would read the emission's own side effect as a change and
 * re-persist every step, recreating the per-turn repetition the change-driven
 * cadence removes. Every other payload field is either static or a real fact
 * the panel renders (e.g. `state.residualFindings[].title` changes the panel
 * without changing the row text, so it must still trigger a persist).
 *
 * This is deliberately WIDER than the model row: the row renders a compact
 * delta, so a projection change that the row cannot show (`state.residuals`,
 * `state.agentFlow`, `state.knowledge`, `state.rowScopes`, …) still persists the
 * new payload for the panel — it just does not append a row.
 *
 * Pure: the input payload is never mutated (shallow copies of the payload and
 * its state; `storeFacts` is replaced with a normalized copy).
 * @param payload - the payload the current step composed.
 * @returns the JSON comparison key (stable across a revision bump).
 */
export function panelDigestOf(payload: MstarEngineStatusPayload): string {
  const state = payload.state
  if (state === null || state.storeFacts === undefined) return JSON.stringify(payload)
  return JSON.stringify({
    ...payload,
    state: { ...state, storeFacts: { ...state.storeFacts, storeRevision: null } },
  })
}

/**
 * The workspace-state catalog source: the plan registry, open-issue counts,
 * branch/policy anchors, per-row recorded scope, knowledge catalog digest and the
 * steering compass direction one-liner — the "where are we" facts the model
 * would otherwise have to read status.json / the compass / the catalog for.
 * Built from the SAME cached cycle as the sibling rows (one status.json +
 * compass read per cache refresh; the issue/catalog facts arrive as the
 * async pre-read's {@link StoreFacts}). A resolved `{HARNESS_DIR}` ALWAYS
 * yields a section: a selection verdict — `status.missing` included — is an
 * operator-visible reason and keeps it PRESENT with its code, message and
 * recovery, even after the execution authority retired the file registry.
 * The caller is the one that answers `state: null`, and only for an
 * unresolved harness dir.
 *
 * v3 per-lifecycle aggregation (compass v3.0.0 § Catalog selection rule):
 * the state section aggregates the SELECTED workflow lifecycle — resolved
 * ONCE by the caller (D4: the same selection the iteration gate consumes).
 * `state.plans[]` / `rowScopes` come from the selected snapshot's `plans[]` rows
 * verbatim (root action JSON stays the execution authority), `agentFlow` from
 * the selected workflow's native SQLite ledger window, and open-item facts
 * from `{HARNESS_DIR}/store.db` (the issue/catalog authority). Never a root v1
 * `plans[]` read, and never a project register: retired registers are not
 * consulted here. Direction and branch fallbacks come from the selected
 * snapshot's `compass_ref`.
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 * @param selection - the ONE read-path selection for this build.
 * @param facts - the store-backed open-item facts (see {@link StoreFacts}).
 * @param authoritySnapshot - §5 (plan S4) the selected lifecycle's state as the
 *   execution authority materialized it. Present exactly when the route was
 *   `execution`: the retired `status.json` / snapshot documents are then NOT
 *   consulted (the authority is the source), and the section is built even
 *   though no `status.json` needs to exist.
 */
function harnessStateSource(
  harnessDir: string,
  selection: WorkflowSelectionView,
  facts: StoreFacts,
  authoritySnapshot?: Record<string, unknown>,
): MstarHarnessState {
  if (selection.kind === 'error') {
    // EVERY selection verdict is an operator-visible reason, so it keeps the
    // section PRESENT: `status.missing` included. `state === null` means
    // exactly one thing — no resolved `{HARNESS_DIR}` — and must never absorb
    // an initialization failure for a workspace that HAS one (the model would
    // silently lose both the cause and the recovery path).
    return selectionErrorState(selection, facts, harnessDir)
  }
  if (authoritySnapshot === undefined) {
    return selectionErrorState({
      kind: 'error',
      code: 'execution.state-unavailable',
      message: 'the ACTIVE workflow state was not supplied to the catalog reader',
    }, facts, harnessDir)
  }
  try {
    const str = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    /** `plans[].metadata.iteration_refs` → non-empty string[]; missing/non-array → [] (lossless). */
    const iterationRefsOf = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
    const snapshot = authoritySnapshot
    // The ACTIVE execution authority materializes the selected workflow state;
    // this consumer never reads a coordination snapshot from disk.
    // The SELECTED snapshot's OWN compass (D4): direction and the branch
    // fallbacks read this lifecycle's `compass_ref` only — a session never
    // borrows another iteration's direction.
    const compass = selectedCompass(harnessDir, selection.workflowId, snapshot)
    const compassFields = compass?.doc
    const plans: HarnessPlanView[] = []
    const rowScopes: HarnessRowScopeView[] = []
    if (Array.isArray(snapshot.plans)) {
      for (const row of snapshot.plans.map(asRecord)) {
        if (row === undefined) continue
        const id = typeof row.plan_id === 'string' ? row.plan_id : typeof row.id === 'string' ? row.id : undefined
        if (id === undefined) continue
        const metadata = asRecord(row.metadata)
        plans.push({
          id,
          status: typeof row.status === 'string' ? row.status : '',
          // done_at passthrough: trimmed string; missing/empty → null (an
          // ALWAYS-present nullable scalar — lossless JSON, never omitted).
          doneAt: str(row.done_at),
          // Iteration memberships :
          // `metadata.iteration_refs` array of iteration ids; missing/non-array
          // → [] (an ALWAYS-present array — lossless JSON, never omitted).
          iterationRefs: iterationRefsOf(metadata?.iteration_refs),
        })
        // The row's own recorded writable scope: ordinary metadata a Todo or
        // Done row keeps, never a concurrent-ownership claim.
        if (typeof metadata?.worktree_path === 'string') {
          rowScopes.push({
            planId: id,
            workingBranch: str(metadata.working_branch) ?? '',
            worktreePath: str(metadata.worktree_path),
          })
        }
      }
    }
    const { residuals, residualFindings } = facts
    // v3 branch/policy anchors: the snapshot's first-class fields (migrate
    // lifts the v1 root metadata into `branch` / `execution_policy` /
    // `integration_worktree_path`); the SELECTED lifecycle's compass frontmatter
    // stays the fallback for base/target.
    const branch = asRecord(snapshot.branch)
    const executionPolicy = asRecord(snapshot.execution_policy)
    return {
      selection,
      workflowType: str(snapshot.type),
      workflowStatus: str(snapshot.status),
      plans,
      residuals,
      residualFindings,
      project: projectRollupSource(facts.roadmap, facts.residuals),
      iterationBaseBranch: str(branch?.base) ?? str(compassFields?.iteration_base_branch) ?? null,
      targetBranch: str(branch?.target) ?? str(compassFields?.target_branch) ?? null,
      specIntegrationBranch: str(branch?.integration),
      pushPolicy: str(executionPolicy?.push_policy),
      worktreeMode: str(executionPolicy?.worktree_mode),
      integrationWorktreePath: str(snapshot.integration_worktree_path),
      rowScopes,
      knowledge: facts.knowledge,
      storeFacts: facts.source,
      direction: compass !== undefined ? compassDirection(compass.compassPath) : null,
      // Read the selected workflow's native event window through the store.
      // `null` means no authoritative window is available; it is not an empty
      // success and no retired JSONL path is consulted.
      agentFlow: readAgentFlow(join(harnessDir, selection.dir), selection.workflowId, AGENT_FLOW_DEFAULT_LIMIT, harnessDir),
    }
  } catch {
    // A resolved `{HARNESS_DIR}` ALWAYS answers a section: a build failure is
    // an operator-visible error section (with a real re-read command), never a
    // silent `state: null` — that value now means exactly "no harness dir".
    return selectionErrorState({
      kind: 'error',
      code: 'execution.state-unreadable',
      message: 'the workspace state could not be read \u2014 re-read it with "mstar status validate" and retry the step; the catalog row degrades instead of failing the step',
    }, facts, harnessDir)
  }
}

/**
 * The shared empty-aggregate state for a selection failure (S-d :
 * the state section stays PRESENT with the operator-visible reason and
 * empty aggregates — never a root v1 read, never a silent null state. The
 * project rollup zone still shows the workspace-level open-issue counts (the
 * rollup is read once per refresh and passed in).
 *
 * No selected lifecycle ⇒ no compass: direction is null rather than borrowed
 * from whichever iteration happens to be steering.
 */
function selectionErrorState(
  selection: WorkflowSelectionView,
  facts: StoreFacts,
  harnessDir: string,
): MstarHarnessState {
  return {
    selection,
    workflowType: null,
    workflowStatus: null,
    plans: [],
    // The open-item rollup is NOT selection-scoped: issues are plan- and
    // workflow-independent (issue contract §6), and a selection failure (an
    // unbound multi-active set, a v1 root) must not blank the workspace's
    // open-item facts.
    residuals: facts.residuals,
    residualFindings: facts.residualFindings,
    project: projectRollupSource(facts.roadmap, facts.residuals),
    iterationBaseBranch: null,
    targetBranch: null,
    specIntegrationBranch: null,
    pushPolicy: null,
    worktreeMode: null,
    integrationWorktreePath: null,
    rowScopes: [],
    knowledge: facts.knowledge,
    storeFacts: facts.source,
    direction: null,
    agentFlow: null,
  }
}

/**
 * The project rollup uses only roadmap records read from the store authority.
 * The issue counts are independent and remain available if that read fails.
 */
function projectRollupSource(roadmap: ProjectRoadmapFacts, residuals: readonly HarnessResidualView[]): MstarHarnessProject {
  return {
    milestones: roadmap.milestones,
    roadmapSource: roadmap.source,
    openResiduals: residuals,
  }
}

/**
 * The open-item facts the state section renders: the issue rollup, its detail
 * rows and the knowledge catalog digest — ALL read from the issue/catalog
 * authority (`{HARNESS_DIR}/store.db`), plus the disclosure of how that read
 * went (`source`). Collected by {@link readStoreFacts} on the async pre-step
 * path; the synchronous builders fall back to {@link UNREAD_STORE_FACTS},
 * which says so instead of pretending the rollup is empty.
 */
interface ProjectRoadmapFacts {
  readonly milestones: readonly string[]
  readonly source: RoadmapSourceView
}

interface StoreFacts {
  readonly source: StoreFactsView
  readonly roadmap: ProjectRoadmapFacts
  readonly residuals: readonly HarnessResidualView[]
  readonly residualFindings: readonly ResidualFindingView[] | null
  readonly knowledge: { readonly docCount: number; readonly categories: readonly string[] } | null
  /** The one ACTIVE/error/unavailable execution-authority verdict for this build. */
  readonly authority?: ExecutionWorkflowSourceRead
}

/** The empty aggregate a build without a store read reports (never a silent "none open"). */
const UNREAD_STORE_FACTS: StoreFacts = {
  source: {
    kind: 'unavailable',
    projection: null,
    storeRevision: null,
    diagnostic: 'the issue/catalog store was not read for this build',
  },
  roadmap: {
    milestones: [],
    source: {
      kind: 'unavailable',
      absentProjectIds: [],
      diagnostic: 'the roadmap authority was not read for this build',
    },
  },
  residuals: [],
  residualFindings: null,
  knowledge: null,
}

/** Read the store-backed roadmap authority once, retaining catalog order. */
async function readProjectRoadmapFacts(context: StoreContext): Promise<ProjectRoadmapFacts> {
  try {
    const records = await listRoadmapAuthority(context)
    const milestones: string[] = []
    const absentProjectIds: string[] = []
    let hasRoadmap = false
    for (const record of records) {
      if (record.roadmap === null) {
        absentProjectIds.push(record.projectId)
        continue
      }
      hasRoadmap = true
      const document = parseCompassFrontmatterText(record.roadmap.contentMarkdown, `store roadmap ${record.projectId}`)
      if (Array.isArray(document.milestones)) {
        for (const milestone of document.milestones) {
          if (typeof milestone === 'string' && milestone.trim() !== '') milestones.push(milestone)
        }
      }
    }
    return {
      milestones,
      source: { kind: hasRoadmap ? 'present' : 'absent', absentProjectIds, diagnostic: null },
    }
  } catch (error) {
    return {
      milestones: [],
      source: { kind: 'unavailable', absentProjectIds: [], diagnostic: storeRefusalText(error) },
    }
  }
}

/** One refresh's open-issue rollup, roadmap source, and knowledge digest. */
async function readStoreFacts(harnessDir: string): Promise<StoreFacts> {
  const context: StoreContext = { harnessDir }
  const roadmap = await readProjectRoadmapFacts(context)
  try {
    const envelope = await withStoreRead(context, queryDashboard('issues', { issue: { disposition: 'open', limit: ISSUE_PAGE_LIMIT } }))
    const items: Array<IssuePage['items'][number]> = [...envelope.data.items]
    // The rollup counts EVERY open issue: page through the authority's own
    // order until the reported total is covered (bounded — a capped count
    // then discloses the bound instead of silently undercounting).
    let pages = 1
    while (items.length < envelope.data.total && pages < ISSUE_ROLLUP_MAX_PAGES) {
      const next = await withStoreRead(context, queryDashboard('issues', { issue: { disposition: 'open', limit: ISSUE_PAGE_LIMIT, offset: items.length } }))
      if (next.data.items.length === 0) break
      items.push(...next.data.items)
      pages += 1
    }
    const counts = new Map<HarnessResidualSeverity, number>()
    for (const item of items) counts.set(item.severity, (counts.get(item.severity) ?? 0) + 1)
    const residuals: HarnessResidualView[] = []
    for (const severity of ISSUE_SEVERITIES) {
      const count = counts.get(severity)
      if (count !== undefined && count > 0) residuals.push({ severity, count })
    }
    // The detail rows keep the AUTHORITY's order (severity rank desc → last
    // real activity desc → id asc) and its own severity string; `planId`
    // stays empty — an issue is plan-independent, and its plan/iteration
    // links are provenance, not a column of a summary row.
    const residualFindings: ResidualFindingView[] = items.slice(0, 10).map((item) => ({
      planId: '',
      id: item.id,
      severity: item.severity,
      title: item.title,
    }))
    return {
      source: {
        kind: 'store',
        projection: envelope.projection.freshness,
        storeRevision: envelope.storeRevision,
        diagnostic: storeProjectionDiagnostic(envelope.projection, items.length, envelope.data.total),
      },
      residuals,
      roadmap,
      residualFindings,
      knowledge: await readKnowledgeDigest(context),
    }
  } catch (error) {
    return {
      source: {
        kind: 'unavailable',
        projection: null,
        storeRevision: null,
        diagnostic: storeRefusalText(error),
      },
      roadmap,
      residuals: [],
      residualFindings: null,
      knowledge: null,
    }
  }
}

/**
 * The disclosure text of ONE store-backed read: `null` while the projection is
 * current and the count whole, otherwise the named reason — a STALE or
 * UNAVAILABLE projection (execution views may lag; the issue rows read here
 * are authoritative either way) and/or the paging bound.
 */
function storeProjectionDiagnostic(projection: ReadProjection, counted: number, total: number): string | null {
  const parts: string[] = []
  if (projection.freshness !== 'current') {
    const sources = projection.diagnostics.map((diagnostic) => diagnostic.sourceKey).join(', ')
    parts.push(`projection ${projection.freshness}${sources === '' ? '' : ` (${sources})`} — issue rows stay authoritative`)
  }
  if (counted < total) parts.push(`first ${counted} of ${total} open issues counted`)
  return parts.length === 0 ? null : parts.join('; ')
}

/**
 * One refusal as the display states it: the engine's stable code (when the
 * error carries one) plus its message verbatim. A below-floor runtime, a
 * missing capability, a staged/corrupt store and a schema drift all arrive
 * here as the engine's own actionable text — never as an empty rollup, and
 * never converted into a JSON fallback.
 */
function storeRefusalText(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' && code !== '' ? `[${code}] ${message}` : message
}

/**
 * Knowledge catalog digest from the DB catalog (state-projection contract §1:
 * document identity lives in `store.db`, bodies stay files — the retired
 * `{KNOWLEDGE_DIR}/README.md` index is NOT read). `docCount` counts every
 * registered knowledge document (archived/superseded rows stay registered)
 * and `categories` are the distinct first path segments of their
 * catalog-relative paths. Throws when the catalog cannot be read — the caller
 * has already proven the authority active, and a failed catalog read must
 * reach {@link readStoreFacts}'s catch instead of reporting an empty digest.
 */
async function readKnowledgeDigest(context: StoreContext): Promise<{ docCount: number; categories: string[] }> {
  const page = await listCatalog(context, { kind: 'document', documentKind: 'knowledge', limit: ISSUE_PAGE_LIMIT })
  const categories = new Set<string>()
  for (const item of page.items) {
    const category = item.relativePath.split('/')[0]
    if (category !== undefined && category !== '' && item.relativePath.includes('/')) categories.add(category)
  }
  return { docCount: page.total, categories: [...categories].sort() }
}

/**
 * Steering compass direction one-liner: the first paragraph under the
 * `## Direction lock` heading (the problem statement bullet), markdown
 * emphasis stripped, truncated to ~160 chars. Null when unavailable.
 * @param compassPath - the steering `delivery-compass.md` path.
 */
function compassDirection(compassPath: string): string | null {
  try {
    const content = readFileSync(compassPath, 'utf8')
    const section = content.match(/^## Direction lock[^\n]*\n+([\s\S]*?)(?=\n## |$)/m)
    if (section === null) return null
    const paragraph = section[1]!
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '')
    if (paragraph === undefined) return null
    const cleaned = paragraph
      .replace(/^[-*]\s+/, '')
      .replace(/\*\*[^*]+:\*\*\s*/, '') // strip a leading `**Label:** ` prefix (e.g. "Problem statement:")
      .replace(/\*\*/g, '')
      .trim()
    if (cleaned === '') return null
    return cleaned.length > 160 ? `${cleaned.slice(0, 157)}…` : cleaned
  } catch {
    return null
  }
}

/**
 * The SELECTED lifecycle's own iteration compass (D4): its snapshot
 * `compass_ref` must be a harness-relative path inside the harness, basename
 * `delivery-compass.md`, whose realpath stays inside `{HARNESS_DIR}` (a
 * symlink whose target escapes is rejected), whose frontmatter `iteration_id`
 * equals the selected snapshot id, and whose `status` is `active` | `locked`.
 * No directory enumeration: a session never borrows another iteration's
 * direction or phase gate, and a lifecycle whose compass has completed stops
 * steering.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param workflowId - the selected snapshot's id (the compass attribution key).
 * @param snapshot - the parsed selected snapshot document.
 * @returns the compass path + parsed frontmatter, or undefined when this
 *   lifecycle carries no steering compass of its own.
 */
function selectedCompass(
  harnessDir: string,
  workflowId: string,
  snapshot: Record<string, unknown>,
): { iterationId: string; compassPath: string; doc: Record<string, unknown> } | undefined {
  const ref = snapshot.compass_ref
  if (typeof ref !== 'string' || ref.trim() === '' || isAbsolute(ref)) return undefined
  const compassPath = join(harnessDir, ref)
  if (!pathInside(harnessDir, compassPath)) return undefined
  if (basename(compassPath) !== 'delivery-compass.md') return undefined
  if (!existsSync(compassPath)) return undefined
  let resolvedHarness: string
  let resolvedCompass: string
  try {
    resolvedHarness = realpathSync(harnessDir)
    resolvedCompass = realpathSync(compassPath)
  } catch {
    return undefined
  }
  if (!pathInside(resolvedHarness, resolvedCompass)) return undefined
  let doc: Record<string, unknown>
  try {
    doc = parseCompassFrontmatter(compassPath)
  } catch {
    return undefined
  }
  if (doc.status !== 'active' && doc.status !== 'locked') return undefined
  if (doc.iteration_id !== workflowId) return undefined
  return { iterationId: workflowId, compassPath, doc }
}

/**
 * Lexical or canonical containment: `candidate` is a path strictly inside
 * `root` (not `root` itself, not a `..` escape, not an absolute relative).
 */
function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * The cached iteration-gate catalog row: `evaluatePhaseGate`
 * over the SELECTED workflow snapshot (compass v3.0.0 § Catalog selection
 * rule — the same selection the state section aggregates) + that snapshot's
 * OWN linked delivery compass, projected to the tool result shape
 * (`IterationGateView`). Computed per catalog build and reused within the
 * cache TTL (no disk I/O on the agent-loop hot path between refreshes).
 *
 * Returns undefined when the row cannot be built: no harness dir,
 * missing status.json, a selection error (v1 root / no snapshots / unbound
 * multi-active), no linked steering compass (`compass_ref` missing, outside
 * the harness, non-steering, or not this lifecycle's own), or an
 * unreadable/unparseable document (advisory degrade — the engine-status
 * catalog still appends; a later tool call can re-evaluate on demand with
 * explicit probes).
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 * @param selection - the ONE read-path selection for this build.
 * @param authoritySnapshot - §5 (plan S4) the selected lifecycle's state as the
 *   execution authority materialized it: present exactly on the `execution`
 *   route, where the retired snapshot file is not opened and no `status.json`
 *   needs to exist.
 */
function iterationGateSource(
  harnessDir: string | null,
  selection: WorkflowSelectionView | undefined,
  authoritySnapshot?: Record<string, unknown>,
): MstarIterationGateView | undefined {
  if (harnessDir === null || selection === undefined || selection.kind === 'error' || authoritySnapshot === undefined) return undefined
  try {
    const snapshotDoc = authoritySnapshot
    const compass = selectedCompass(harnessDir, selection.workflowId, snapshotDoc)
    if (compass === undefined) return undefined
    // No git probes at boot: the row reports what the two control docs
    // prove (the tool remains the explicit-probe surface for branch checks).
    const result = evaluatePhaseGate(snapshotDoc, compass.doc)
    const gate: IterationGateView = {
      transition: result.transition,
      all_plans_done: result.allPlansDone,
      ok: result.ok,
      entry: iterationGateView(result.entry),
      exit: iterationGateView(result.exit),
      violations: result.violations.map(iterationViolationView),
    }
    // Steering compass `status` — the authoritative Phase-1-in-flight signal
    // (spec panel-f4 §5 D5; consumed by the iteration current-step projection).
    // `selectedCompass` already filters to `active | locked`, so this guard is
    // belt-and-suspenders only: a non-union value omits the field (lossless
    // omit-when-absent — `Session.append` rejects undefined-valued props).
    const compassStatus = compass.doc.status === 'active' || compass.doc.status === 'locked'
      ? compass.doc.status
      : undefined
    return {
      iterationId: compass.iterationId,
      compassPath: compass.compassPath,
      gate,
      ...(compassStatus !== undefined ? { compassStatus } : {}),
    }
  } catch {
    return undefined // degrade — the iteration section is absent, no hardening
  }
}

/** Listener options for {@link preStepCatalogListener}. */
export interface PreStepCatalogOptions {
  /**
   * Render the watermark trio in the row. Driven by CONFIRMED live prompt
   * registration (`registerHarnessPrompt`'s `onRegistered`/`onDisposed`
   * hooks), never by the scheduling return value: a boolean pins the verdict
   * at apply time, while a predicate is re-evaluated per step and therefore
   * follows a registration that lands late, fails contained, or is disposed
   * (HMR / service removal). True (or a predicate returning true) means no
   * prompt section carries the version / harness dir / enforcement facts, so
   * the row must.
   */
  readonly showWatermark?: boolean | (() => boolean)
}

/**
 * Advisory `agent/pre-step` waterfall listener (agent
 * catalog): delegates through `next()` (never `reject` — that would block the
 * step — and never replaces the delegated messages) and appends the ONE
 * unified `mstar-engine` catalog message to the composed step
 * messages, so the durable session log carries it (model-visible ⟺ logged,
 * MessageSource form): the `<mstar_engine_status>` block renders ONE compact
 * delta line — selected workflow, non-Done plans, branch anchors, and the
 * iteration phase-gate verdict when a steering compass + an ACTIVE execution
 * workflow resolve.
 *
 * Change-driven re-emission (D2): per session+workspace, the row is appended on
 * first emission and then only when its rendered text changed — the row's own
 * text IS the model-row comparison key, so the fields the compact row no longer
 * renders (residual counts and issue detail rows, the agent-flow ledger, the
 * knowledge digest, plan row scopes, policy, direction) can change without
 * appending an identical-looking row. The panel projection is compared
 * separately ({@link panelDigestOf} — the panel renders more than the row, e.g.
 * the open-issue detail rows): a panel-only change persists the new payload for
 * the panel and appends nothing. The start of a new turn is NOT a trigger for
 * either: an unchanged workspace shows the row once, not once per turn.
 * A workspace with no resolved `{HARNESS_DIR}` composes no row at all and
 * records no digest (the projection would be an empty wrapper). The gate keys
 * on the RESOLVED HARNESS DIR, never on a null state: a selection verdict
 * (`status.missing` included) is an operator-visible error row, so suppressing
 * it would hide both the cause and its recovery from the model.
 *
 * Watermark fallback: when no `system-prompt` registration is CONFIRMED live
 * (`showWatermark` — a boolean or a per-step predicate), the row re-renders the
 * version / harness-dir / enforcement trio — there is no always-on prompt
 * section carrying it. The predicate form exists because registration is
 * scheduled asynchronously: a scheduled-but-failed (or later disposed)
 * registration leaves nothing carrying the trio, so the fallback must follow
 * landed state, not the scheduling return value.
 *
 * Persist retry: the snapshot persist is a SECOND, independent obligation of an
 * emission. A DEGRADED write (a transient store failure — no ACTIVE authority
 * yet, a busy store, a retired generation) is retried on later steps while the
 * payload stays unchanged, WITHOUT re-appending the identical model row, so a
 * transient failure cannot latch the web panel stale until the next payload
 * change. A by-design skip (no session id / cwd / harness dir) is never
 * retried. The retried write carries the digest's ORIGINAL emission turn: the
 * snapshot records when the model last saw the row, not when the write landed.
 *
 * An aborted step publishes nothing: the delegated decision
 * is returned unchanged (tool-skill precedent; a narrowed abort race —
 * an abort after delegation must not surface as a turn failure).
 *
 * Error containment: the append path is wrapped — a failure
 * (e.g. a downstream decider returning a non-iterable `messages` set, or a
 * throwing message factory) logs and returns the delegated decision
 * unchanged; the advisory listener never aborts the very step it observes.
 *
 * simplify: dev-time stub — the digest is in-memory per app (the real
 * dsh-session log is unavailable at dev time; digest state resets on
 * fiber disposal, which is also HMR-correct).
 * @param ctx - registrant context (logger for the containment path).
 * @param resolver - the per-workspace `{HARNESS_DIR}` resolver (the probe
 * never starts from the process cwd).
 * @param cache - per-session TTL catalog cache: each session's payload is
 * keyed by harness dir + `session.header.id` + cwd + effective hint, so two
 * sessions in one workspace never share a selection; a session with no stable
 * id is built uncached.
 * @param ttlMs - catalog refresh interval in milliseconds.
 * @param invalidation - the apply-scoped session-keyed invalidation (ledger
 * records evict every session of a harness; a picker commit evicts one).
 * @param digests - per session+workspace emission digests (last rendered text +
 * its panel projection, plus the degraded-persist retry latch) for the
 * change-driven re-emission.
 * @param payload - the proposed step the loop is about to enter.
 * @param next - the remaining pre-step chain; its value is the delegated decision.
 * @param options - `showWatermark` re-renders the watermark trio while no
 * `system-prompt` registration is confirmed live (a boolean or a per-step
 * predicate — the predicate form tracks landed/disposed registrations).
 */
export async function preStepCatalogListener(
  ctx: Context,
  resolver: HarnessResolver,
  cache: Map<string, CatalogCacheEntry>,
  ttlMs: number,
  invalidation: CatalogInvalidation,
  digests: Map<string, EmissionDigest>,
  payload: { agent: unknown; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
  options: PreStepCatalogOptions = {},
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject' || payload.signal.aborted) return decision
  try {
    // The harness dir resolves from the WORKSPACE of the session whose agent
    // enters the step (the session cwd) — never the process cwd. Each session
    // then keys its OWN cache entry (D4), built on first use and TTL-refreshed
    // (Config `catalogTtlMs`; the hot path is a timestamp compare + Map lookup
    // between refreshes).
    const cwd = sessionCwdOf(payload.agent)
    const sessionId = sessionHeaderIdOf(payload.agent)
    const harnessDir = resolver.forWorkspace(cwd)
    // The carrying session's effective selection hint: the structural identity
    // plus this session's DURABLE pick. An unreadable binding record is not
    // "no pick" for the WRITE path (which pauses attribution); the catalog is
    // a READ path and must still render, so it falls back to the structural
    // hint and reports the degrade once through the logger.
    const hint = sessionHintForCatalog(harnessDir, payload.agent)
    const catalogPayload = await catalogPayloadFor(ctx, cache, invalidation, harnessDir, sessionId, cwd ?? '', hint, ttlMs)
    // No resolved `{HARNESS_DIR}` ⇒ the payload carries no state section, and
    // after D1 the rendered block would be an empty `<mstar_engine_status>`
    // wrapper: compose no row and record no digest (there is nothing that could
    // change later without a harness dir appearing). The predicate is the
    // RESOLVED DIR, not the state: `state === null` means exactly "no harness
    // dir", and a selection verdict for a resolved workspace must render.
    if (harnessDir === null) return decision
    const messages = [...decision.messages]
    // Re-evaluated PER STEP: the fallback follows confirmed live registration,
    // so a registration that lands (or is disposed) after apply flips the row
    // on the next step rather than being frozen at boot.
    const includeWatermark = typeof options.showWatermark === 'function' ? options.showWatermark() : options.showWatermark === true
    const text = renderEngineStatusCatalog(catalogPayload, { includeWatermark })
    const panelKey = panelDigestOf(catalogPayload)
    const digestKey = agentDigestKey(payload.agent, cwd)
    const prior = digests.get(digestKey)
    // TWO independent change decisions (D2), because the model row and the
    // panel render different facts:
    //
    // - The MODEL ROW's comparison key is its rendered text alone. The row is a
    //   compact delta (`renderEngineStatusCatalog`), so the fields it no longer
    //   renders — residual counts and issue detail, the agent-flow ledger, the
    //   knowledge digest, plan row scopes, policy, direction — can change
    //   without appending an identical-looking row. That is the point: the
    //   change-driven cadence used to re-emit the whole snapshot on an
    //   incidental count bump, and those stale copies are never reclaimed.
    // - The PANEL's comparison key stays the FULL payload projection
    //   ({@link panelDigestOf}), so a panel-only change still persists the new
    //   payload for the panel. It just does not spend a model-visible row on it.
    //
    // A new turn alone is NOT a trigger for either. Per session+workspace, so
    // different sessions/workspaces keep independent digests.
    const rowChanged = prior === undefined || prior.text !== text
    const panelChanged = prior === undefined || prior.panelKey !== panelKey
    if (rowChanged) {
      messages.push(createUserMessage({ source: engineStatusSource(), content: [{ type: 'text', text }] }))
    }
    // The EMISSION turn of the row the model last saw: this step's turn when
    // the row is (re)appended, the retained one otherwise — a panel-only update
    // and a retried persist both leave it alone. The snapshot records WHEN THE
    // MODEL SAW the row, so relabelling it with a step that appended nothing
    // would make the panel's freshness footer and the session evidence disagree.
    const emittedTurn = rowChanged || prior === undefined ? payload.turn : prior.emittedTurn
    // The emission TIME has the same obligation: capture it when the row is
    // appended, retain it otherwise, and repeat it to a retried persist. The
    // store write is a separate obligation that may land later, so stamping the
    // write's own clock would report the retry as the freshness time even
    // though the model saw the row earlier.
    const emittedAt = rowChanged || prior === undefined ? new Date().toISOString() : prior.emittedAt
    // The persist is a separate obligation with its OWN trigger set: the model
    // row changed, the panel projection changed (the panel renders more than
    // the row), or the last attempt degraded (a transient store failure must
    // not latch the panel stale until the payload changes again). The persisted
    // snapshot is written at THIS gate — the only place the composed payload is
    // known to have been composed for this step's readers. A later reader (the
    // web-only host endpoint) therefore serves a record of a real emission, never
    // a re-resolution that could disagree with the session log. Keyed by
    // `session.header.id`: a stub without a real id has nothing to key on, so
    // the write is skipped (a reader then answers the explicit unavailable
    // state rather than another session's row) and never retried.
    let persistPending = prior?.persistPending ?? false
    if (rowChanged || panelChanged || persistPending) {
      const persisted = persistEngineStatusSnapshot(
        ctx,
        harnessDir,
        cwd,
        emittedTurn,
        emittedAt,
        catalogPayload,
        payload.agent,
        authorityGenerationByPayload.get(catalogPayload),
      )
      persistPending = persisted === 'degraded'
    }
    if (rowChanged || panelChanged) {
      digests.set(digestKey, { text, panelKey, emittedTurn, emittedAt, persistPending })
    } else {
      // Nothing observable changed: only the retry latch moves, so the digest
      // identity (and its original emission turn and time) stays.
      prior.persistPending = persistPending
    }
    return { kind: 'enter', messages }
  } catch (error) {
    ctx.logger(CATALOG_LOGGER).error(
      `engine-status catalog append failed (degraded, step delegates unchanged): ${(error as Error).message}`,
    )
    return decision
  }
}

/**
 * The carrying session's catalog selection hint: the structural identity off
 * the agent (cwd + `header.id`) folded with the DURABLE pick when the binding
 * record is readable. An
 * unreadable record keeps the structural hint only — the pick is unknown,
 * never invented, so the resolver falls back to row-scope/cwd/unique evidence (or
 * reports the picker error) instead of this reader guessing. The catalog is a
 * read path: it renders the honest degrade rather than refusing to render.
 * @param harnessDir - the resolved `{HARNESS_DIR}` for the session workspace.
 * @param agent - the stepping agent.
 */
function sessionHintForCatalog(harnessDir: string | null, agent: unknown): SessionHint | undefined {
  const identity = sessionHintOf(agent)
  if (identity === undefined) return undefined
  const { cwd, sessionId } = identity
  if (cwd === undefined || sessionId === undefined || harnessDir === null) return identity
  const binding = readWorkflowSessionBinding(harnessDir, sessionId, cwd)
  const selected = binding.kind === 'ok' ? binding.binding?.selectedWorkflowId : undefined
  return selected === undefined ? identity : { ...identity, selectedWorkflowId: selected }
}

/**
 * Per session+workspace emission digest: the two comparison keys the gate
 * decides on — the rendered MODEL-ROW text and the panel-relevant payload
 * projection ({@link panelDigestOf}) as of the last append/persist. A digest
 * keys its CHANGE decisions on content, not on turns — a new turn is not an
 * emission trigger. The two keys are deliberately different widths: the row is
 * a compact delta, so only a row-text change appends a model message, while the
 * wider panel projection also persists when a payload-only fact changed.
 *
 * It retains {@link emittedTurn} and {@link emittedAt}, because the persisted
 * snapshot must keep the turn and time the row was actually emitted at — even
 * when a panel-only update or a degraded persist retry lands on a much later
 * step.
 */
export interface EmissionDigest {
  /** The last model-row text appended for this session+workspace. */
  readonly text: string
  /** The panel projection ({@link panelDigestOf}) of the last persisted payload. */
  readonly panelKey: string
  /**
   * The turn the row was EMITTED in (first emission or rendered-text change). A
   * panel-only persist and a retried persist reuse it verbatim, so the stored
   * snapshot's `turn` always names the turn the model last saw the row — never
   * the turn of a step that appended nothing.
   */
  readonly emittedTurn: number
  /**
   * The ISO time the row was EMITTED at (captured with the same append decision
   * as {@link emittedTurn}). A panel-only persist and a retried persist reuse it
   * verbatim, so the stored snapshot's freshness time never moves to a write's
   * own clock.
   */
  readonly emittedAt: string
  /**
   * The last persist attempt for this digest DEGRADED (a transient store
   * failure). The gate retries the persist on a later step while the payload
   * is unchanged, without re-appending the identical row, and clears this once
   * the write lands. A by-design skip (no session id / cwd / harness dir)
   * never sets it, so nothing retries forever.
   */
  persistPending: boolean
}

/**
 * Digest key of one agent: its SESSION identity (`session.header.id`, the
 * picker key and the catalog cache key) + its session workspace. A stub
 * without a session id falls back to its own agent id, and dev stubs without
 * either share the `<unknown>` bucket per workspace. JSON-encoded with the
 * cache key so a delimiter inside either field cannot collide two identities.
 */
function agentDigestKey(agent: unknown, cwd: string | undefined): string {
  return JSON.stringify([
    sessionHeaderIdOf(agent) ?? agentIdOf(agent) ?? '<unknown>',
    cwd ?? '',
  ])
}

/**
 * Persist the catalog payload this step composed as this session's newest
 * durable emission row in the control-root store (`dsh_status_emissions`),
 * keyed by the session id + its workspace — the edge-safe source a later host
 * endpoint serves. The payload is persisted on a row change AND on a
 * panel-only projection change, so the panel never waits for the model row. Only the NEWEST emission per session is kept: the shared envelope's
 * 50-entry mirror, its age rule and its byte ceiling were write-path
 * containment of one file and have no reader.
 *
 * Contained: no session id, an unresolved `{HARNESS_DIR}` or a store that
 * cannot be written (no ACTIVE authority, a schema drift, a busy store)
 * degrades to a warn log — the advisory emission path never aborts the step it
 * observes (same containment rule as the append path above), and never
 * fabricates a successful write.
 *
 * The tri-state verdict is the retry latch: `'degraded'` asks the gate to
 * retry the persist on a later step with the same payload, `'skipped'` is by
 * design (no session id / cwd / harness dir — nothing to key a row to, so it is
 * never retried), and `'written'` clears any pending retry.
 * @param ctx - registrant context (logger only).
 * @param harnessDir - the workspace's resolved `{HARNESS_DIR}` (null when none).
 * @param cwd - the session workspace the payload was resolved for.
 * @param turn - the agent turn the row was emitted for.
 * @param emittedAt - the ISO time the row was emitted at (retained across a
 *   retried persist, so the stored freshness time never moves to the retry).
 * @param catalogPayload - the exact payload object handed to the step messages.
 * @param agent - the stepping agent (the snapshot's session identity).
 */
function persistEngineStatusSnapshot(
  ctx: Context,
  harnessDir: string | null,
  cwd: string | undefined,
  turn: number,
  emittedAt: string,
  catalogPayload: MstarEngineStatusPayload,
  agent: unknown,
  selectedGeneration?: DshSelectedGeneration,
): 'written' | 'degraded' | 'skipped' {
  const sessionId = sessionHeaderIdOf(agent)
  if (sessionId === undefined || cwd === undefined) return 'skipped'
  // No harness root ⇒ nothing to key a snapshot to: the endpoint answers the
  // explicit unavailable state for that workspace anyway, so this is a normal
  // composition (a workspace that never initialized a harness) rather than a
  // degraded write — skip it without a warn per turn.
  if (harnessDir === null) return 'skipped'
  const result = writeEngineStatusSnapshot(harnessDir, {
    sessionId,
    cwd,
    turn,
    payload: catalogPayload,
    emittedAt,
    ...(selectedGeneration === undefined ? {} : { selectedGeneration }),
  })
  if (result.kind === 'degraded') {
    ctx.logger(CATALOG_LOGGER).warn(
      `engine-status snapshot not persisted for ${sessionId} (readers answer unavailable): ${result.reason}`,
    )
    return 'degraded'
  }
  return 'written'
}

