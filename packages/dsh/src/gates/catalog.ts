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
 * Module boundary: no barrel — the entry imports by explicit relative path;
 * the wiring exports (`preStepCatalogListener`, `buildCatalogSources`,
 * `DEFAULT_CATALOG_TTL_MS`, `EXPLICIT_CACHE_KEY`, `CatalogCacheEntry` /
 * `TurnDigest`, `createCatalogInvalidation` / `CatalogInvalidation`) are
 * entry-internal.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Context } from 'cordis'
import {
  evaluatePhaseGate,
  parseCompassFrontmatter,
  readJson,
  resolveCompassEnforcement,
  resolveIterationDir,
} from '@mstar-harness/engine'
import type { StatusDoc } from '@mstar-harness/engine'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {
  AgentFlowView,
  HarnessLeaseView,
  HarnessPlanView,
  HarnessResidualView,
  IterationGateView,
  MstarEngineStatusSource,
  MstarHarnessState,
  MstarIterationGateView,
  ResidualFindingView,
} from '../types.ts'
import { STATUS_FILE, asRecord, sessionCwdOf, HarnessResolver, iterationViolationView, iterationGateView } from './_shared.ts'
import { readAgentFlow, AGENT_FLOW_DEFAULT_LIMIT } from './agent-flow.ts'
/** Logger label for the engine-status catalog (dsh logger naming: `<scope>/<subject>`). */
const CATALOG_LOGGER = 'mstar/engine-status-catalog'

/** Default catalog cache refresh interval (ms) — see Config `catalogTtlMs`. */
export const DEFAULT_CATALOG_TTL_MS = 60_000

/** Catalog cache key for the explicit-`harnessDir` app-wide entry (one entry for every session). */
export const EXPLICIT_CACHE_KEY = '\u0000explicit'

/** Residual severity vocabulary (mstar-plan-artifacts severity SSOT order). */
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
    enforcement: harnessDir !== null ? resolveCompassEnforcement(harnessDir) : { hard: false, source: 'none' },
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
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
function harnessStateSource(harnessDir: string | null): MstarHarnessState | null {
  if (harnessDir === null) return null
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) return null
  try {
    const doc = readJson(statusPath) as StatusDoc
    const str = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    const plans: HarnessPlanView[] = []
    const leases: HarnessLeaseView[] = []
    if (Array.isArray(doc.plans)) {
      for (const row of doc.plans.map(asRecord)) {
        if (row === undefined) continue
        const id = typeof row.plan_id === 'string' ? row.plan_id : typeof row.id === 'string' ? row.id : undefined
        if (id === undefined) continue
        plans.push({
          id,
          status: typeof row.status === 'string' ? row.status : '',
          // done_at passthrough: trimmed string; missing/empty → null (an
          // ALWAYS-present nullable scalar — lossless JSON, never omitted).
          doneAt: str(row.done_at),
        })
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
    // Open residual findings (root `residual_findings[<plan-id>]` SSOT —
    // mstar-plan-artifacts): count by severity, non-zero severities only.
    const residuals: HarnessResidualView[] = []
    const residualMap = asRecord(doc.residual_findings)
    if (residualMap !== undefined) {
      const counts = new Map<string, number>()
      for (const planId of Object.keys(residualMap)) {
        const findings = residualMap[planId]
        if (!Array.isArray(findings)) continue
        for (const finding of findings) {
          const severity = asRecord(finding)?.severity
          if (typeof severity === 'string' && (RESIDUAL_SEVERITIES as readonly string[]).includes(severity)) {
            counts.set(severity, (counts.get(severity) ?? 0) + 1)
          }
        }
      }
      for (const severity of RESIDUAL_SEVERITIES) {
        const count = counts.get(severity)
        if (count !== undefined && count > 0) residuals.push({ severity, count })
      }
    }
    // Open residual findings DETAIL (spec §6): planId = the owning root key;
    // open-lifecycle filtered with engine `isOpenResidual` parity (missing /
    // null / false / 'open' → open; resolved/waived/superseded/duplicate →
    // closed); unknown severities skipped (same discipline as the rollup);
    // severity ordered critical→nit (stable sort keeps the source order
    // within one severity); capped at 10. The root key missing/unreadable →
    // null (advisory — same pattern as `knowledge`); key present with no
    // open entries → [].
    let residualFindings: ResidualFindingView[] | null = null
    if (residualMap !== undefined) {
      residualFindings = []
      for (const planId of Object.keys(residualMap)) {
        const findings = residualMap[planId]
        if (!Array.isArray(findings)) continue
        for (const finding of findings) {
          const entry = asRecord(finding)
          if (entry === undefined || !isOpenResidualParity(entry)) continue
          const severity = entry.severity
          if (typeof severity !== 'string' || residualSeverityIndex(severity) === -1) continue
          residualFindings.push({
            planId,
            id: typeof entry.id === 'string' ? entry.id : '',
            severity,
            title: typeof entry.title === 'string' ? entry.title : '',
          })
        }
      }
      residualFindings.sort((a, b) => residualSeverityIndex(a.severity) - residualSeverityIndex(b.severity))
      residualFindings = residualFindings.slice(0, 10)
    }
    const metadata = asRecord(doc.metadata)
    const compass = steeringCompassPath(harnessDir)
    let compassFields: Record<string, unknown> | undefined
    if (compass !== undefined) {
      try {
        compassFields = parseCompassFrontmatter(compass.compassPath)
      } catch {
        compassFields = undefined
      }
    }
    return {
      plans,
      residuals,
      residualFindings,
      iterationBaseBranch: str(metadata?.iteration_base_branch) ?? str(compassFields?.iteration_base_branch) ?? null,
      targetBranch: str(metadata?.target_branch) ?? str(compassFields?.target_branch) ?? null,
      specIntegrationBranch: str(metadata?.spec_integration_branch),
      pushPolicy: str(metadata?.push_policy),
      worktreeMode: str(metadata?.worktree_mode),
      controlWorktreePath: str(metadata?.control_worktree_path),
      leases,
      knowledge: knowledgeDigest(harnessDir),
      direction: compass !== undefined ? compassDirection(compass.compassPath) : null,
      // Actual subagent flow evidence — read on the same per-workspace cache
      // cycle as the sibling state rows (one bounded ledger read per TTL
      // refresh; spec §2.2). Fix-wave (qc1 F-001): a MISSING ledger reads as
      // the EMPTY view (recording hasn't started — the panel shows the
      // no-dispatches-yet empty state per the plan promise); only an
      // UNREADABLE ledger → null (advisory — the agent-flow line is absent).
      // The state section as a whole is still gated on status.json (missing
      // status → state null → agentFlow absent too — documented).
      agentFlow: readAgentFlow(harnessDir, 50),
    }
  } catch {
    return null // advisory degrade — the state section is absent, never hardening
  }
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
 * over the control-path status.json + the steering delivery-compass.md,
 * projected to the tool result shape (`IterationGateView`). Computed
 * ONCE per harness dir — at `apply()` when the explicit `harnessDir`
 * config is set, else on the first pre-step of each workspace root — and
 * reused per pre-step (no disk I/O on the agent-loop hot path). A
 * mid-session status/compass change does NOT re-evaluate until a config
 * reload re-runs `apply` (HMR fiber restart) — the documented staleness
 * tradeoff that keeps the hot path synchronous-I/O-free.
 *
 * Returns undefined when the row cannot be built: no harness dir,
 * missing status.json, no steering compass, or an unreadable/unparseable
 * document (advisory degrade — the engine-status catalog still appends; a
 * later tool call can re-evaluate on demand with explicit probes).
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
function iterationGateSource(harnessDir: string | null): MstarIterationGateView | undefined {
  if (harnessDir === null) return undefined
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) return undefined
  const compass = steeringCompassPath(harnessDir)
  if (compass === undefined) return undefined
  try {
    const statusDoc = readJson(statusPath)
    const compassDoc = parseCompassFrontmatter(compass.compassPath)
    // No git probes at boot: the row reports what the two control docs
    // prove (the tool remains the explicit-probe surface for branch checks).
    const result = evaluatePhaseGate(statusDoc, compassDoc)
    const gate: IterationGateView = {
      transition: result.transition,
      all_plans_done: result.allPlansDone,
      ok: result.ok,
      entry: iterationGateView(result.entry),
      exit: iterationGateView(result.exit),
      violations: result.violations.map(iterationViolationView),
    }
    return {
      iterationId: compass.iterationId,
      statusPath,
      compassPath: compass.compassPath,
      gate,
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

