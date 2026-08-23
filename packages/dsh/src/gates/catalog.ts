/**
 * Engine-status pre-step catalog — the ONE unified `mstar-engine-status`
 * row appended at `agent/pre-step` (plan `20260810-dsh-entry-split` §14
 * extraction).
 *
 * `preStepCatalogListener` delegates through `next()` and appends the unified
 * catalog message (watermark fields + iteration phase-gate section +
 * workspace-state digest) to the composed step messages, digest-gated per
 * agent+workspace turn. The per-workspace TTL cache
 * (`buildCatalogSources` / `catalogSourcesFor`, Config `catalogTtlMs`) keeps
 * the hot path a timestamp compare + Map lookup between refreshes.
 *
 * v3 per-lifecycle aggregation (plan `20260819-workflow-dsh-viz` Task 1):
 * the state + iteration sections aggregate the SELECTED workflow lifecycle
 * (compass v3.0.0 § Catalog selection rule — `resolveReadWorkflow` in
 * `workflow-selection.ts`): active `workflows[]` first (multi-active →
 * first + a structured warning), else the latest terminal snapshot by
 * mtime, else a clear error. `state.plans[]` / leases come from the
 * selected snapshot's `plans[]` rows verbatim, `agentFlow` from the
 * workflow dir's `agent-flow.jsonl`, residuals from the project registers
 * — never a root v1 `plans[]` / root `agent-flow.jsonl` read.
 *
 * Module boundary: no barrel — the entry imports by explicit relative path;
 * the wiring exports (`preStepCatalogListener`, `buildCatalogSources`,
 * `DEFAULT_CATALOG_TTL_MS`, `EXPLICIT_CACHE_KEY`, `CatalogCacheEntry` /
 * `TurnDigest`, `createCatalogInvalidation` / `CatalogInvalidation`) are
 * entry-internal.
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import {
  evaluatePhaseGate,
  parseCompassFrontmatter,
  parseCompassFrontmatterText,
  readJson,
  resolveProjectDir,
  resolveRepoEnforcement,
  resolveIterationDir,
  PROJECT_REGISTER_FILE,
  PROJECT_ROADMAP_FILE,
  WORKFLOW_SNAPSHOT_FILE,
} from '@mstar-harness/engine'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {
  AgentFlowView,
  HarnessLeaseView,
  HarnessPlanView,
  HarnessResidualView,
  IterationGateView,
  MstarEngineStatusSource,
  MstarHarnessProject,
  MstarHarnessState,
  MstarIterationGateView,
  ResidualFindingView,
  WorkflowSelectionView,
} from '../types.ts'
import { STATUS_FILE, asRecord, sessionCwdOf, HarnessResolver, iterationViolationView, iterationGateView } from './_shared.ts'
import { readAgentFlow, AGENT_FLOW_DEFAULT_LIMIT } from './agent-flow.ts'
import { resolveReadWorkflow } from './workflow-selection.ts'
/** Logger label for the engine-status catalog (dsh logger naming: `<scope>/<subject>`). */
const CATALOG_LOGGER = 'mstar/engine-status-catalog'

/** Default catalog cache refresh interval (ms) — see Config `catalogTtlMs`. */
export const DEFAULT_CATALOG_TTL_MS = 60_000

/** Catalog cache key for the explicit-`harnessDir` app-wide entry (one entry for every session). */
export const EXPLICIT_CACHE_KEY = '\u0000explicit'

/** Residual severity vocabulary (mstar-artifacts severity SSOT order). */
const RESIDUAL_SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'] as const

/**
 * Engine `isOpenResidual` parity (packages/engine/src/status.ts lines
 * 159–163): an entry is open when `lifecycle` is missing, `null` or `false`
 * (the jq `//` default covers `false` too — `lifecycle: false` counts as
 * open), otherwise it must be the STRING `'open'`. The engine does not
 * export this from the public surface, so the catalog implements the same
 * semantics locally (iteration non-goals forbid engine changes).
 */
function isOpenResidualParity(entry: Record<string, unknown>): boolean {
  const lifecycle = entry.lifecycle
  const effective = lifecycle === false || lifecycle === null || lifecycle === undefined ? 'open' : lifecycle
  return effective === 'open'
}

/** Severity sort index for a residual finding (critical first). */
function residualSeverityIndex(severity: string): number {
  return (RESIDUAL_SEVERITIES as readonly string[]).indexOf(severity)
}

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
 * The durable source for the ONE unified engine-status catalog row (the
 * watermark + iteration gate + workspace-state digest). Every field is
 * boot/workspace-resolved — the unified mstar version is a
 * process-immutable manifest read, the compass enforcement resolves like
 * the gates themselves, and the iteration/state sections come from the
 * same per-workspace cached build. With an explicit `harnessDir` config
 * the source is built ONCE at `apply()`; without one it is built on the
 * FIRST pre-step of each workspace. The whole cache entry is then
 * TTL-refreshed (Config `catalogTtlMs`, default 60000 — a mid-session
 * status/compass/residual change lands within one interval). The
 * documented staleness tradeoff keeps synchronous disk I/O off the
 * agent-loop hot path: a timestamp compare + Map lookup per step between
 * refreshes.
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
function engineStatusSource(harnessDir: string | null): MstarEngineStatusSource {
  const iteration = harnessDir !== null ? iterationGateSource(harnessDir) : undefined
  return {
    kind: 'mstar-engine-status',
    form: 'catalog',
    version: pluginVersion(),
    harnessDir,
    enforcement: harnessDir !== null ? resolveRepoEnforcement(harnessDir) : { hard: false, source: 'none' },
    // The iteration section is OPTIONAL: when the row cannot be built (no
    // status.json / no steering compass / unreadable docs) the key must be
    // ABSENT, never `iteration: undefined` — the agent loop appends the
    // composed message to the real session, whose `Session.append` rejects
    // event data that is not losslessly JSON-serializable (undefined-valued
    // object properties included) with a hard round failure.
    ...(iteration !== undefined ? { iteration } : {}),
    state: harnessDir !== null ? harnessStateSource(harnessDir) : null,
  }
}

/** One TTL cache entry: the unified source plus the build timestamp. */
export interface CatalogCacheEntry {
  sources: MstarEngineStatusSource
  builtAt: number
}

/**
 * The apply-scoped `harnessDir → cache key` reverse map + invalidation
 * closure (plan `20260811-panel-f4-timeliness` Task 2, decision D3): the
 * catalog cache is keyed by {@link EXPLICIT_CACHE_KEY} or the session cwd,
 * while ledger records (dispatch/settle) identify the affected workspace by
 * `{HARNESS_DIR}` — the reverse map bridges the two so a ledger change
 * deletes EXACTLY the affected workspace's entry (no global clear; a
 * multi-workspace deployment does not rebuild every workspace). BOTH the map
 * and the closure are created per-apply by the entry (same lifetime as the
 * cache): module-level state would survive an HMR fiber restart and point at
 * a destroyed cache.
 */
export interface CatalogInvalidation {
  /**
   * Register `key` as the cache key of `harnessDir` — called by
   * `catalogSourcesFor` on cache hit AND build, and pre-registered by the
   * entry at apply for the explicit-config boot entry (a ledger record
   * between apply and the first pre-step must still invalidate the
   * pre-seeded entry). A null harness dir (no `{HARNESS_DIR}` resolved) has
   * no cache entry to invalidate → no-op.
   */
  register(harnessDir: string | null, key: string): void
  /**
   * Delete the cache entry of `harnessDir` (D3 — the ledger record path
   * invokes this through the apply-bound hook). A missing mapping is a safe
   * no-op, and a missing entry after a previous invalidation is a no-op too
   * (the next pre-step rebuilds regardless). A throwing invalidation is
   * contained by the record path (log-only — it never blocks the ledger
   * record).
   */
  invalidate(harnessDir: string): void
}

/** Create the apply-scoped invalidation bound to ONE catalog cache (entry-internal wiring — see {@link CatalogInvalidation}). */
export function createCatalogInvalidation(cache: Map<string, CatalogCacheEntry>): CatalogInvalidation {
  const keyByHarnessDir = new Map<string, string>()
  return {
    register(harnessDir, key) {
      if (harnessDir === null) return
      keyByHarnessDir.set(harnessDir, key)
    },
    invalidate(harnessDir) {
      const key = keyByHarnessDir.get(harnessDir)
      if (key === undefined) return
      cache.delete(key)
    },
  }
}

/**
 * Build the unified catalog source for one harness dir (boot for the
 * explicit config, first-use per workspace otherwise, then TTL-refreshed —
 * see `catalogSourcesFor`). Logs the manifest fallback once per build — a
 * '0.0.0' version would watermark every catalog row wrongly, so the
 * fallback is never silent.
 * @param ctx - registrant context (logger for the manifest fallback).
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
export function buildCatalogSources(ctx: Context, harnessDir: string | null): MstarEngineStatusSource {
  const source = engineStatusSource(harnessDir)
  if (source.version === '0.0.0') {
    ctx.logger(CATALOG_LOGGER).warn('plugin manifest version unavailable — falling back to 0.0.0 for the engine-status catalog watermark')
  }
  return source
}

/**
 * Look up the catalog sources for one cache key with a TTL: within the
 * interval the cached build is reused (the agent-loop hot path is a
 * timestamp compare + Map lookup); after it the sources are rebuilt from
 * disk (one bounded sync re-read per workspace per interval — the
 * mid-session plan/compass/residual staleness window the user opted into;
 * Config `catalogTtlMs`).
 *
 * The `harnessDir → key` reverse map (plan `20260811-panel-f4-timeliness`
 * Task 2, decision D3) is registered on BOTH hit and build: a later ledger
 * record (dispatch/settle) for this harness dir can then invalidate exactly
 * this cache entry through the apply-bound closure (see
 * `createCatalogInvalidation`) — the 60s TTL no longer bounds ledger-change
 * latency (AC-2).
 * @param ctx - registrant context (logger for the manifest fallback).
 * @param cache - the per-workspace TTL cache.
 * @param register - the apply-scoped reverse-map registration (harnessDir → key).
 * @param key - cache key (the explicit-config key, else the session cwd).
 * @param harnessDir - the resolved `{HARNESS_DIR}` for this key.
 * @param ttlMs - refresh interval in milliseconds.
 */
function catalogSourcesFor(
  ctx: Context,
  cache: Map<string, CatalogCacheEntry>,
  register: (harnessDir: string | null, key: string) => void,
  key: string,
  harnessDir: string | null,
  ttlMs: number,
): MstarEngineStatusSource {
  const entry = cache.get(key)
  if (entry !== undefined && Date.now() - entry.builtAt < ttlMs) {
    register(harnessDir, key)
    return entry.sources
  }
  const sources = buildCatalogSources(ctx, harnessDir)
  cache.set(key, { sources, builtAt: Date.now() })
  register(harnessDir, key)
  return sources
}

/** Model-facing rendering of the unified engine-status catalog (the `<mstar_engine_status>` block). */
function renderEngineStatusCatalog(source: MstarEngineStatusSource): string {
  const enforcement = `${source.enforcement.hard ? 'hard' : 'soft'}${source.enforcement.source === 'none' ? '' : ` (${source.enforcement.source})`}`
  const lines = [
    '<mstar_engine_status>',
    `mstar version: ${source.version}`,
    `harness dir: ${source.harnessDir ?? 'none'}`,
    `enforcement: ${enforcement}`,
  ]
  const iteration = source.iteration
  if (iteration !== undefined) {
    const gate = iteration.gate
    const codes = gate.violations.map((v) => v.code).join(', ')
    lines.push(`iteration: ${iteration.iterationId}`)
    lines.push(`transition: ${gate.transition}`)
    lines.push(`all plans done: ${gate.all_plans_done}`)
    lines.push(`gate: ${gate.ok ? 'PASS' : `FAIL (${codes})`}`)
  }
  const state = source.state
  if (state !== null) {
    if (state.selection.kind === 'error') {
      // Clear selection error (v1/unmigrated root, no snapshots): the
      // operator-visible reason replaces the data lines — the aggregates
      // are empty by construction and must not read as "no plans".
      lines.push(`workflow selection: ERROR (${state.selection.code}) ${state.selection.message}`)
    } else {
      lines.push(`workflow: ${state.selection.workflowId} (${state.selection.kind})`)
      if (state.selection.kind === 'active' && state.selection.warning !== undefined) {
        lines.push(`workflow warning: ${state.selection.warning.code} ${state.selection.warning.message}`)
      }
      lines.push(`plans: ${state.plans.length === 0 ? 'none registered' : state.plans.map((p) => `${p.id}(${p.status})`).join(' ')}`)
      lines.push(`residuals: ${state.residuals.length === 0 ? 'none open' : state.residuals.map((r) => `${r.severity} ${r.count}`).join(', ')}`)
      if (state.iterationBaseBranch !== null && state.targetBranch !== null) {
        const integration = state.specIntegrationBranch !== null ? ` (spec integration: ${state.specIntegrationBranch})` : ''
        lines.push(`branch: ${state.iterationBaseBranch} → ${state.targetBranch}${integration}`)
      }
      const policy = [
        state.pushPolicy !== null ? `push ${state.pushPolicy}` : null,
        state.worktreeMode !== null ? `worktree ${state.worktreeMode}` : null,
        state.controlWorktreePath !== null ? `control ${state.controlWorktreePath}` : null,
      ].filter((part): part is string => part !== null).join('; ')
      if (policy !== '') lines.push(`policy: ${policy}`)
      lines.push(`leases: ${state.leases.length === 0 ? 'none active' : state.leases.map((l) => `${l.planId} → ${l.holder}${l.worktreePath !== null ? ` (${l.worktreePath})` : ''}`).join('; ')}`)
      if (state.knowledge !== null) {
        lines.push(`knowledge: ${state.knowledge.docCount} doc${state.knowledge.docCount === 1 ? '' : 's'} (${state.knowledge.categories.join(', ')})`)
      }
      if (state.direction !== null) lines.push(`direction: ${state.direction}`)
      const flow = state.agentFlow
      if (flow !== null && flow.events.length > 0) {
        lines.push(renderAgentFlowLine(flow))
      }
    }
  }
  lines.push('</mstar_engine_status>')
  return lines.join('\n')
}

/**
 * The model-facing agent-flow line (spec §2.2): ONE compact row, emitted only
 * when the ledger has events. Role totals collapse the role × outcome summary
 * (top 5 by count); `latest` is the newest dispatch's `role→planId#taskId`
 * with the local HH:MM timestamp. The event detail lives in the structured
 * `source.agentFlow` only — the model text must not balloon.
 * @param flow - the ledger view (non-empty events).
 */
function renderAgentFlowLine(flow: AgentFlowView): string {
  const byRole = new Map<string, number>()
  for (const row of flow.summary) {
    if (row.role === '') continue
    byRole.set(row.role, (byRole.get(row.role) ?? 0) + row.count)
  }
  const top = [...byRole.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const roles = top.length === 0 ? 'none' : top.map(([role, count]) => `${role} ${count}`).join(', ')
  const latest = flow.events.find((event) => event.kind === 'dispatch')
  const latestText = latest === undefined
    ? 'none'
    : `${[latest.role, [latest.planId, latest.taskId !== null ? `#${latest.taskId}` : null]
        .filter((part): part is string => part !== null)
        .join('')].filter((part) => part !== '').join('→')} ${hhmm(latest.ts)}`
  // Window-full marker (qc3 F-004 fix-wave): the read window caps at
  // AGENT_FLOW_DEFAULT_LIMIT (50), so an events array AT the cap reads like
  // a total — annotate it. The marker is approximate when the ledger holds
  // exactly `limit` events (the window is full either way; distinguishing
  // would need an extra full-ledger read the compact line must not do).
  const windowFull = flow.events.length >= AGENT_FLOW_DEFAULT_LIMIT
  return `agent flow: ${flow.events.length} events${windowFull ? ` (latest ${AGENT_FLOW_DEFAULT_LIMIT})` : ''}; by role: ${roles}; latest: ${latestText}`
}

/** Local HH:MM for a timestamp (the agent-flow line's time-of-day). */
function hhmm(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * The workspace-state catalog source: the plan registry, open residual
 * counts, branch/policy anchors, active leases, knowledge index digest and
 * the steering compass direction one-liner — the "where are we" facts the
 * model would otherwise have to read status.json / the compass / the
 * knowledge index for. Built from the SAME cached cycle as the sibling
 * rows (one status.json + compass + knowledge-index read per cache
 * refresh). Returns undefined when the workspace has no harness dir or no
 * status.json (the row is absent — advisory degrade, same as the
 * iteration-gate row).
 *
 * v3 per-lifecycle aggregation (compass v3.0.0 § Catalog selection rule):
 * the state section aggregates the SELECTED workflow lifecycle — active
 * `workflows[]` first (multi-active → first + a structured warning), else
 * the latest terminal snapshot by mtime (history view), else a clear
 * selection error. `state.plans[]` / `leases` come from the selected
 * snapshot's `plans[]` rows verbatim, `agentFlow` from the workflow dir's
 * `agent-flow.jsonl`, residuals from the project registers
 * (`projects/<id>/residuals.json` — the v1 `residual_findings` home after
 * migrate). Never a root v1 `plans[]` / root `agent-flow.jsonl` read.
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
function harnessStateSource(harnessDir: string | null): MstarHarnessState | null {
  if (harnessDir === null) return null
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) return null
  try {
    const selection = resolveReadWorkflow(harnessDir)
    // ONE residual rollup per catalog build (qc3 S-1 fix-wave): the state
    // section AND the project rollup zone consume the same register parse —
    // never two independent `residualRollup` walks per refresh.
    const rollup = residualRollup(harnessDir)
    const str = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    /** `plans[].metadata.iteration_refs` → non-empty string[]; missing/non-array → [] (lossless). */
    const iterationRefsOf = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
    const compass = steeringCompassPath(harnessDir)
    let compassFields: Record<string, unknown> | undefined
    if (compass !== undefined) {
      try {
        compassFields = parseCompassFrontmatter(compass.compassPath)
      } catch {
        compassFields = undefined
      }
    }
    if (selection.kind === 'error') {
      // Clear selection error (v1/unmigrated root, no snapshots): the state
      // section stays PRESENT with the operator-visible reason and empty
      // aggregates — never a root v1 read, never a silent empty row.
      return selectionErrorState(selection, rollup, harnessDir, compass)
    }
    const snapshotPath = join(harnessDir, selection.dir, WORKFLOW_SNAPSHOT_FILE)
    let snapshot: Record<string, unknown>
    if (!existsSync(snapshotPath)) {
      // S-d fix-wave: an active/terminal selection whose snapshot is
      // MISSING degrades to a STRUCTURED selection error (the state section
      // stays PRESENT with the operator-visible reason and empty
      // aggregates) — never a silent null state section. (`readJson` would
      // return `{}` for a missing file — an empty aggregate with a lying
      // `active` selection; the engine helper's ENOENT-lossless contract.)
      return selectionErrorState(
        {
          kind: 'error',
          code: 'workflow.selection.snapshot-unreadable',
          message: `cannot read the selected workflow snapshot ${snapshotPath}`,
        },
        rollup,
        harnessDir,
        compass,
      )
    }
    try {
      snapshot = readJson(snapshotPath)
    } catch {
      // Same structured degrade for an unreadable/corrupt snapshot file.
      return selectionErrorState(
        {
          kind: 'error',
          code: 'workflow.selection.snapshot-unreadable',
          message: `cannot read the selected workflow snapshot ${snapshotPath}`,
        },
        rollup,
        harnessDir,
        compass,
      )
    }
    const plans: HarnessPlanView[] = []
    const leases: HarnessLeaseView[] = []
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
          // Iteration memberships (plan 20260813-panel-quick-fixes Task 2):
          // `metadata.iteration_refs` array of iteration ids; missing/non-array
          // → [] (an ALWAYS-present array — lossless JSON, never omitted).
          iterationRefs: iterationRefsOf(metadata?.iteration_refs),
        })
        // v3 lease home: per-row `execution_lease` on the snapshot plan row
        // (the v1 root-metadata home is gone).
        const lease = asRecord(row.execution_lease)
        if (lease !== undefined && typeof lease.holder === 'string') {
          leases.push({
            planId: id,
            holder: lease.holder,
            worktreePath: str(lease.worktree_path),
          })
        }
      }
    }
    const { residuals, residualFindings } = rollup
    // v3 branch/policy anchors: the snapshot's first-class fields (migrate
    // lifts the v1 root metadata into `branch` / `execution_policy` /
    // `control_worktree_path`); the compass frontmatter stays the fallback
    // for base/target.
    const branch = asRecord(snapshot.branch)
    const executionPolicy = asRecord(snapshot.execution_policy)
    return {
      selection,
      workflowType: str(snapshot.type),
      workflowStatus: str(snapshot.status),
      plans,
      residuals,
      residualFindings,
      project: projectRollupSource(harnessDir, residuals),
      iterationBaseBranch: str(branch?.base) ?? str(compassFields?.iteration_base_branch) ?? null,
      targetBranch: str(branch?.target) ?? str(compassFields?.target_branch) ?? null,
      specIntegrationBranch: str(branch?.integration),
      pushPolicy: str(executionPolicy?.push_policy),
      worktreeMode: str(executionPolicy?.worktree_mode),
      controlWorktreePath: str(snapshot.control_worktree_path),
      leases,
      knowledge: knowledgeDigest(harnessDir),
      direction: compass !== undefined ? compassDirection(compass.compassPath) : null,
      // Actual subagent flow evidence — read on the same per-workspace cache
      // cycle as the sibling state rows (one bounded ledger read per TTL
      // refresh; spec §2.2). v3: the ledger lives in the SELECTED workflow
      // dir (`workflows/<id>/agent-flow.jsonl`), never the root file.
      // Fix-wave (qc1 F-001): a MISSING ledger reads as the EMPTY view
      // (recording hasn't started — the panel shows the no-dispatches-yet
      // empty state per the plan promise); only an UNREADABLE ledger → null
      // (advisory — the agent-flow line is absent). The state section as a
      // whole is still gated on status.json (missing status → state null →
      // agentFlow absent too — documented).
      agentFlow: readAgentFlow(join(harnessDir, selection.dir), 50),
    }
  } catch {
    return null // advisory degrade — the state section is absent, never hardening
  }
}

/**
 * The shared empty-aggregate state for a selection failure (S-d fix-wave):
 * the state section stays PRESENT with the operator-visible reason and
 * empty aggregates — never a root v1 read, never a silent null state. The
 * project rollup zone still shows the workspace-level residual counts (the
 * rollup is computed once per build — qc3 S-1 — and passed in).
 */
function selectionErrorState(
  selection: WorkflowSelectionView,
  rollup: { residuals: HarnessResidualView[]; residualFindings: ResidualFindingView[] | null },
  harnessDir: string,
  compass: { iterationId: string; compassPath: string } | undefined,
): MstarHarnessState {
  return {
    selection,
    workflowType: null,
    workflowStatus: null,
    plans: [],
    residuals: [],
    residualFindings: null,
    project: projectRollupSource(harnessDir, rollup.residuals),
    iterationBaseBranch: null,
    targetBranch: null,
    specIntegrationBranch: null,
    pushPolicy: null,
    worktreeMode: null,
    controlWorktreePath: null,
    leases: [],
    knowledge: knowledgeDigest(harnessDir),
    direction: compass !== undefined ? compassDirection(compass.compassPath) : null,
    agentFlow: null,
  }
}

/**
 * The additive project rollup (compass v3.0.0 AC-4 / AC-P3 — the panel's
 * fifth zone): roadmap milestones + open-residual severity counts from the
 * PROJECT layer (`projects/<id>/roadmap.md` frontmatter `milestones[]` +
 * `projects/<id>/residuals.json` registers — the v1 root
 * `residual_findings` home after migrate). Aggregates across ALL project
 * registers (workspace-level, same semantics as {@link residualRollup}).
 * Always-present (lossless): no roadmap files → `milestones: []`; no
 * registers / no open entries → `openResiduals: []`. Unreadable roadmaps
 * are skipped (advisory).
 *
 * qc3 S-1 (fix-wave): the open-residual rollup is computed ONCE per catalog
 * build by the caller and passed in — this zone never re-walks the project
 * registers itself.
 */
function projectRollupSource(harnessDir: string, residuals: HarnessResidualView[]): MstarHarnessProject {
  const milestones: string[] = []
  const projectsDir = resolveProjectDir(harnessDir, { harnessDir })
  if (existsSync(projectsDir)) {
    let entries: Dirent[]
    try {
      entries = readdirSync(projectsDir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const roadmapPath = join(projectsDir, entry.name, PROJECT_ROADMAP_FILE)
      if (!existsSync(roadmapPath)) continue
      try {
        // The roadmap frontmatter shares the compass flat-subset grammar
        // (engine `parseCompassFrontmatterText` — the same parser
        // `validateRoadmap` uses).
        const doc = parseCompassFrontmatterText(readFileSync(roadmapPath, 'utf8'), roadmapPath)
        if (Array.isArray(doc.milestones)) {
          for (const milestone of doc.milestones) {
            if (typeof milestone === 'string' && milestone.trim() !== '') milestones.push(milestone)
          }
        }
      } catch {
        continue // unreadable roadmap — skip (advisory)
      }
    }
  }
  return { milestones, openResiduals: residuals }
}

/**
 * Open residual findings from the v3 project registers
 * (`projects/<id>/residuals.json` — the v1 `residual_findings` home after
 * migrate; compass AC-2/AC-3). Aggregates across ALL project registers
 * (workspace-level, same semantics as the v1 root key). No register files
 * → `residualFindings: null` (advisory — same pattern as `knowledge`);
 * register(s) present with no open entries → [].
 */
function residualRollup(harnessDir: string): { residuals: HarnessResidualView[]; residualFindings: ResidualFindingView[] | null } {
  const registers = projectRegisters(harnessDir)
  const residuals: HarnessResidualView[] = []
  const counts = new Map<string, number>()
  let residualFindings: ResidualFindingView[] | null = null
  if (registers.length > 0) {
    residualFindings = []
    for (const register of registers) {
      const entries = asRecord(register.doc.entries)
      if (entries === undefined) continue
      for (const planId of Object.keys(entries)) {
        const findings = entries[planId]
        if (!Array.isArray(findings)) continue
        for (const finding of findings) {
          const entry = asRecord(finding)
          if (entry === undefined) continue
          // Open-parity FIRST (W-A fix-wave): a closed register entry
          // (resolved / waived / closed lifecycle) is NOT an open residual
          // — the engine's `isOpenResidual` parity — so it must never
          // count toward the severity rollup NOR the detail view. The
          // register is open-by-construction after migrate, but a stale or
          // already-closed entry must not inflate the workspace counts or
          // the fifth-zone chips (engine treats closed entries as closed).
          if (!isOpenResidualParity(entry)) continue
          const severity = entry.severity
          // Rollup: every valid-severity OPEN entry counts.
          if (typeof severity === 'string' && (RESIDUAL_SEVERITIES as readonly string[]).includes(severity)) {
            counts.set(severity, (counts.get(severity) ?? 0) + 1)
          }
          // Detail: open-lifecycle filtered (same parity as the count —
          // one filter drives both); unknown severities skipped; severity
          // ordered critical→nit (stable sort keeps the source order
          // within one severity); capped at 10.
          if (typeof severity !== 'string' || residualSeverityIndex(severity) === -1) continue
          residualFindings.push({
            planId,
            id: typeof entry.id === 'string' ? entry.id : '',
            severity,
            title: typeof entry.title === 'string' ? entry.title : '',
          })
        }
      }
    }
    for (const severity of RESIDUAL_SEVERITIES) {
      const count = counts.get(severity)
      if (count !== undefined && count > 0) residuals.push({ severity, count })
    }
    residualFindings.sort((a, b) => residualSeverityIndex(a.severity) - residualSeverityIndex(b.severity))
    residualFindings = residualFindings.slice(0, 10)
  }
  return { residuals, residualFindings }
}

/**
 * Read every project register (`projects/<id>/residuals.json`) under the
 * harness dir. Unreadable registers are skipped (advisory); a missing
 * projects dir / no register files → [].
 */
function projectRegisters(harnessDir: string): Array<{ projectId: string; doc: Record<string, unknown> }> {
  const projectsDir = resolveProjectDir(harnessDir, { harnessDir })
  if (!existsSync(projectsDir)) return []
  let entries
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const registers: Array<{ projectId: string; doc: Record<string, unknown> }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const registerPath = join(projectsDir, entry.name, PROJECT_REGISTER_FILE)
    if (!existsSync(registerPath)) continue
    try {
      registers.push({ projectId: entry.name, doc: readJson(registerPath) })
    } catch {
      continue // unreadable register — skip (advisory)
    }
  }
  return registers
}

/**
 * Knowledge index digest: `{HARNESS_DIR}/knowledge/README.md` rows →
 * doc count + distinct categories (the first path segment of each row's
 * Document cell). Null when the index is absent or unreadable (advisory).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
function knowledgeDigest(harnessDir: string): { docCount: number; categories: string[] } | null {
  const indexPath = join(harnessDir, 'knowledge', 'README.md')
  if (!existsSync(indexPath)) return null
  try {
    const categories = new Set<string>()
    let docCount = 0
    for (const line of readFileSync(indexPath, 'utf8').split(/\r?\n/)) {
      const row = line.trim().match(/^\|(.+)\|$/)
      if (row === null) continue
      const cells = row[1]!.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '')
      if (cells.length < 4) continue
      const path = cells[0]!.replace(/^`|`$/g, '')
      const category = path.split('/')[0]
      if (category === undefined || category === '' || !path.includes('/')) continue
      categories.add(category)
      docCount += 1
    }
    if (docCount === 0) return null
    return { docCount, categories: [...categories].sort() }
  } catch {
    return null
  }
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
 * Locate the steering iteration compass (mirror of the engine's
 * `resolveCompassEnforcement` scan): the FIRST `{ITERATION_DIR}/<id>/
 * delivery-compass.md` whose frontmatter `status` is `active` or `locked`.
 * Completed/status-less/archived compasses do not steer the repo — the
 * pre-step gate section reports the iteration that is still in flight.
 * Silent on any read failure (the catalog row is advisory).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
function steeringCompassPath(harnessDir: string): { iterationId: string; compassPath: string } | undefined {
  const iterationsDir = resolveIterationDir(harnessDir)
  if (!existsSync(iterationsDir)) return undefined
  let entries
  try {
    entries = readdirSync(iterationsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const compassPath = join(iterationsDir, entry.name, 'delivery-compass.md')
    if (!existsSync(compassPath)) continue
    let content: string
    try {
      content = readFileSync(compassPath, 'utf8')
    } catch {
      continue
    }
    // Frontmatter only: leading `---` fence through the closing fence; only
    // steering compasses count (resolveCompassEnforcement parity).
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (frontmatter === null || !/^status[ \t]*:[ \t]*(?:active|locked)[ \t]*$/m.test(frontmatter[1]!)) continue
    return { iterationId: entry.name, compassPath }
  }
  return undefined
}

/**
 * The cached iteration-gate catalog row: `evaluatePhaseGate`
 * over the SELECTED workflow snapshot (compass v3.0.0 § Catalog selection
 * rule — the same selection the state section aggregates) + the steering
 * delivery-compass.md, projected to the tool result shape
 * (`IterationGateView`). Computed ONCE per harness dir — at `apply()` when
 * the explicit `harnessDir` config is set, else on the first pre-step of
 * each workspace root — and reused per pre-step (no disk I/O on the
 * agent-loop hot path). A mid-session status/compass change does NOT
 * re-evaluate until a config reload re-runs `apply` (HMR fiber restart) —
 * the documented staleness tradeoff that keeps the hot path
 * synchronous-I/O-free.
 *
 * Returns undefined when the row cannot be built: no harness dir,
 * missing status.json, no steering compass, a selection error (v1 root /
 * no snapshots), or an unreadable/unparseable document (advisory degrade —
 * the engine-status catalog still appends; a later tool call can
 * re-evaluate on demand with explicit probes).
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
function iterationGateSource(harnessDir: string | null): MstarIterationGateView | undefined {
  if (harnessDir === null) return undefined
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) return undefined
  const compass = steeringCompassPath(harnessDir)
  if (compass === undefined) return undefined
  const selection = resolveReadWorkflow(harnessDir)
  if (selection.kind === 'error') return undefined
  const snapshotPath = join(harnessDir, selection.dir, WORKFLOW_SNAPSHOT_FILE)
  try {
    // v3 relocation: the gate's first doc is the SELECTED workflow snapshot
    // (`workflows/<id>/snapshot.json`); the compass stays the second input.
    const snapshotDoc = readJson(snapshotPath)
    const compassDoc = parseCompassFrontmatter(compass.compassPath)
    // No git probes at boot: the row reports what the two control docs
    // prove (the tool remains the explicit-probe surface for branch checks).
    const result = evaluatePhaseGate(snapshotDoc, compassDoc)
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
    // `steeringCompassPath` already filters to `active | locked`, so this guard
    // is belt-and-suspenders only: a non-union value omits the field (lossless
    // omit-when-absent — `Session.append` rejects undefined-valued props).
    const compassStatus = compassDoc.status === 'active' || compassDoc.status === 'locked'
      ? compassDoc.status
      : undefined
    return {
      iterationId: compass.iterationId,
      // The evaluated doc: the selected workflow snapshot (v3), not the root
      // status.json — mirrors the CLI `iteration gate --workflow <id>` input.
      statusPath: snapshotPath,
      compassPath: compass.compassPath,
      gate,
      ...(compassStatus !== undefined ? { compassStatus } : {}),
    }
  } catch {
    return undefined // degrade — the iteration section is absent, no hardening
  }
}

/**
 * Advisory `agent/pre-step` waterfall listener (agent
 * catalog): delegates through `next()` (never `reject` — that would block the
 * step — and never replaces the delegated messages) and appends the ONE
 * unified `mstar-engine-status` catalog message to the composed step
 * messages, so the durable session log carries it (model-visible ⟺ logged,
 * MessageSource form): the `<mstar_engine_status>` block renders the
 * watermark fields (version, harness dir, enforcement), plus the iteration
 * phase-gate section when a steering compass + status.json resolve, plus
 * the workspace-state digest section when the workspace has a status.json.
 *
 * Digest-gated re-emission (the documented P3 dedup, landed early): per
 * agent+workspace, the row is injected ONCE per turn — later steps of the
 * same turn append it again only when its rendered text CHANGED (a TTL
 * refresh picked up new state). The durable session log therefore carries
 * the row on the first step of every turn plus each change, not on every
 * step; a 20-step turn shows the catalog once, not 20 times.
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
 * @param explicitKey - the app-wide cache key when an explicit
 * `harnessDir` config is set (undefined → per-session-cwd keys).
 * @param cache - per-workspace TTL catalog sources cache (boot pre-seeded
 * for the explicit-config case; otherwise built on first use of each
 * workspace root and TTL-refreshed — Config `catalogTtlMs`).
 * @param ttlMs - catalog refresh interval in milliseconds.
 * @param register - the apply-scoped `harnessDir → cache key` reverse-map
 * registration (plan `20260811-panel-f4-timeliness` Task 2 — keeps every
 * workspace's entry invalidatable by a ledger change; see
 * `createCatalogInvalidation`).
 * @param digests - per agent+workspace turn digests (last rendered text)
 * for the digest-gated re-emission.
 * @param payload - the proposed step the loop is about to enter.
 * @param next - the remaining pre-step chain; its value is the delegated decision.
 */
export async function preStepCatalogListener(
  ctx: Context,
  resolver: HarnessResolver,
  explicitKey: string | undefined,
  cache: Map<string, CatalogCacheEntry>,
  ttlMs: number,
  register: (harnessDir: string | null, key: string) => void,
  digests: Map<string, TurnDigest>,
  payload: { agent: unknown; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject' || payload.signal.aborted) return decision
  try {
    // The watermark harness dir resolves from the WORKSPACE of the session
    // whose agent enters the step (the session cwd) — never the process
    // cwd. With an explicit config the whole app shares one cache entry
    // (pre-seeded at boot); without one each workspace root gets its own
    // entry, built on first use and TTL-refreshed (Config `catalogTtlMs` —
    // a mid-session plan/compass/residual change lands within one interval;
    // the hot path is a timestamp compare + Map lookup between refreshes).
    const cwd = sessionCwdOf(payload.agent)
    const harnessDir = resolver.forWorkspace(cwd)
    const key = explicitKey ?? cwd ?? ''
    const sources = catalogSourcesFor(ctx, cache, register, key, harnessDir, ttlMs)
    const messages = [...decision.messages]
    const text = renderEngineStatusCatalog(sources)
    // Digest gate: inject the ONE unified row on the first step of a turn,
    // or when its rendered text changed since the last injection (a TTL
    // refresh picked up new state). Per agent+workspace, so different
    // sessions/workspaces keep independent digests.
    const digestKey = agentDigestKey(payload.agent, cwd)
    const prior = digests.get(digestKey)
    if (prior === undefined || prior.turn !== payload.turn || prior.text !== text) {
      messages.push(createUserMessage({ source: sources, content: [{ type: 'text', text }] }))
    }
    digests.set(digestKey, { turn: payload.turn, text })
    return { kind: 'enter', messages }
  } catch (error) {
    ctx.logger(CATALOG_LOGGER).error(
      `engine-status catalog append failed (degraded, step delegates unchanged): ${(error as Error).message}`,
    )
    return decision
  }
}

/** Per agent+workspace turn digest: the rendered catalog text as of the last injection. */
export interface TurnDigest {
  turn: number
  text: string
}

/** Digest key of one agent: the agent id + its session workspace (dev stubs without an id share the `<unknown>` bucket per workspace). */
function agentDigestKey(agent: unknown, cwd: string | undefined): string {
  const id = (agent as { id?: unknown } | null | undefined)?.id
  return `${typeof id === 'string' ? id : '<unknown>'}\u0000${cwd ?? ''}`
}

