/**
 * Warn-only adoption advisory for the OPTIONAL `dsh-llm-fallbacks` plugin
 * (plan `20260815-dsh-fallbacks-personas` Task 4 + `20260816-dsh-b4-seeds`
 * Task 3): when the capability is mounted, ONE advisory pass per apply
 * reports the deployment's fallbacks taxonomy state (bounded: ≤1 warn per
 * category, logger `mstar/fallbacks-advisory`):
 *
 * - Service present (seeds-aware path): the decision point FIRST awaits the
 *   idempotent re-declare (`declareMstarSeeds`) — converging the boot
 *   dual-inject-child race window — then reads the EFFECTIVE state
 *   (`getEffectiveRoles`, sync) and reports per mstar role id:
 *   (i) missing row → missing warn; (ii) `seeded && !personaOverridden` →
 *   seeded (silent, one debug); (iii) `personaOverridden` → persona-
 *   overridden warn (ids + the revert entry: the `fallbacks/revert-seed`
 *   gateway / settings-card rollback button). Empty-persona warns fire only
 *   for non-seeded rows or overridden-empty rows. The declare outcome's
 *   skips/conflicts (upstream conflict code `'persona-source'`) merge into
 *   one warn. The legacy-keys check runs through the service's own
 *   `detectLegacyKeys` on the row config.
 * - Loader-fallback path (no service): the structural read is preserved
 *   (`readRowConfig`/`readRolesList` — (b) missing ids / (c) empty personas
 *   over the raw `roles.list`); the legacy check is SKIPPED (never
 *   reimplemented) and no revert entry appears (no seeds surface).
 *
 * The mstar role-id set is derived from the `harness-agents/` mirror
 * (`subagentRoleIds` — shell file stems filtered to `mode: subagent`),
 * never hardcoded.
 *
 * Unreadable row config (absent field / non-object, or an unreadable
 * `roles.list`) → skip + one debug log. Unmounted → the pass is not invoked
 * (returns `false`, no logs). The advisory NEVER writes the fallbacks config
 * — the read is read-only over the deployment's config layer (never the
 * fallbacks plugin's module internals); the only write path is the
 * idempotent seeds re-declare through the released seeds surface (no-delta
 * → no settings write upstream). The advisory never throws (the caller's
 * dispatch/apply flow is never affected).
 *
 * Module boundary: no barrel — the entry imports this module by explicit
 * relative path (the decoration-module pattern).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { EffectiveRolesReadback, FallbacksService } from 'dsh-llm-fallbacks'
import { subagentRoleIds } from './agent-personas.ts'
import { declareMstarSeeds, type SeedOutcomeView, type SeedsLogSink } from './fallbacks-seeds.ts'
import { fallbacksEntry, fallbacksMounted, fallbacksService } from './fallbacks-probe.ts'

/** Logger label for the adoption advisory (dsh logger naming: `<scope>/<subject>`). */
export const ADVISORY_LOGGER = 'mstar/fallbacks-advisory'

/** Advisory log levels the module sink understands. */
export type AdvisoryLogLevel = 'debug' | 'warn'

/** Module-level advisory log sink — bound by `apply` to `ctx.logger(ADVISORY_LOGGER)` (decoration-module pattern). */
export type AdvisoryLogSink = (level: AdvisoryLogLevel, message: string) => void

let advisoryLogSink: AdvisoryLogSink = () => {}

/**
 * Bind the advisory log sink (the entry `apply` binds it to
 * `ctx.logger(ADVISORY_LOGGER)`). Returns the PRIOR sink so a caller can
 * restore it (test pattern: {@link setDecorationLogger}).
 */
export function setAdvisoryLogger(sink: AdvisoryLogSink): AdvisoryLogSink {
  const prior = advisoryLogSink
  advisoryLogSink = sink
  return prior
}

/**
 * Warn id-list cap: an id-list warn line lists at most this many ids before
 * the `… and K more` suffix — a huge registry (thousands of rows) must not
 * produce a multi-KB log line (plan QC fix wave S-cap). Exported for the
 * suite's cap assertions; module surface only — the entry's frozen 47-name
 * export surface deliberately does not re-export it.
 */
export const ADVISORY_ID_LIST_CAP = 20

/** Format an id list for one warn/debug line: first N ids, then `… and K more`. */
function capIdList(items: readonly string[]): string {
  if (items.length <= ADVISORY_ID_LIST_CAP) return items.join(', ')
  return `${items.slice(0, ADVISORY_ID_LIST_CAP).join(', ')}… and ${items.length - ADVISORY_ID_LIST_CAP} more`
}

/** Structural view of one declared fallbacks role entity (`roles.list` entry). */
interface RoleEntityView {
  id?: unknown
  persona?: unknown
}

/**
 * One advisory pass: unmounted → not invoked (`false`, no logs); mounted →
 * report the taxonomy adoption state (bounded: ≤1 warn per category). With
 * the service present the pass is ASYNC: it awaits the idempotent re-declare
 * before the effective-state readback (report determinism — the boot
 * dual-inject-child race window is closed). Never throws — every failure
 * mode degrades to skip + one debug/warn. Never writes the fallbacks config.
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param agentsDir - the `harness-agents/` mirror root the mstar role-id set
 *   is derived from; absent → the taxonomy checks are skipped (one debug
 *   log; the legacy-keys check is mirror-independent and still runs).
 * @returns `true` when the pass ran (mounted), `false` when unmounted — the
 *   caller (entry `apply`) uses the boolean for the one-pass-per-apply latch.
 */
export async function runFallbacksAdvisory(ctx: Context, agentsDir: string | undefined): Promise<boolean> {
  try {
    if (!fallbacksMounted(ctx)) return false
    const config = readRowConfig(ctx)
    if (config === undefined) {
      log('debug', 'fallbacks row config unreadable (absent or non-object) — adoption advisory skipped')
      return true
    }
    const service = fallbacksService(ctx)
    if (service !== undefined) {
      // Seeds-aware path: the effective state (seed annotations) only exists
      // through the service; the structural roles.list read cannot tell
      // seeded vs overridden, so it is replaced by the readback here.
      return await runSeedsAdvisory(service, config, agentsDir)
    }
    // Loader-fallback path (no service): preserve the structural read.
    return runStructuralAdvisory(config, agentsDir)
  } catch (error) {
    // Contained like the gate's degrade path: skip the pass, never crash.
    log('warn', `fallbacks adoption advisory aborted (degraded — warn-only, deployment config untouched): ${errorMessage(error)}`)
    return true
  }
}

/**
 * Service-present path: legacy keys → mirror gate → await the idempotent
 * re-declare → effective readback → three-state report + declare-outcome
 * merge. The re-declare's own diagnostics are forwarded on the advisory
 * DEBUG channel only — per-id skip detail stays visible without breaking
 * the ≤1-warn-per-category bound (the declaration/skip warn surface is the
 * single consolidated `reportDeclareOutcome` line).
 */
async function runSeedsAdvisory(
  service: FallbacksService,
  config: Record<string, unknown>,
  agentsDir: string | undefined,
): Promise<boolean> {
  // (d) Legacy keys — the service's own detector when applied (mirror-
  // independent: runs even without a mirror).
  const legacy = service.detectLegacyKeys(config)
  if (legacy.length > 0) {
    log('warn', `fallbacks config carries legacy keys (detectLegacyKeys): ${capIdList(legacy)} — migrate to the current shape (role entities use 'persona'; 'chains', 'roles.default', 'label' and 'description' are removed)`)
  }
  // The mstar role-id set is mirror-derived (never hardcoded): no mirror →
  // no taxonomy reference → one debug. The re-declare is gated the same way
  // (a preserved-only batch has no mstar analysis to converge).
  if (agentsDir === undefined) {
    log('debug', 'harness-agents mirror absent — fallbacks adoption taxonomy check skipped (config-only advisory)')
    return true
  }
  const mstarIds = subagentRoleIds(agentsDir)
  if (mstarIds.length === 0) {
    log('debug', 'harness-agents mirror has no subagent-mode shells — fallbacks adoption taxonomy check skipped')
    return true
  }
  // Decision-point convergence: await the idempotent re-declare FIRST, then
  // read the EFFECTIVE state — the report deterministically reflects the
  // current declaration batch even when the entry's inject child is still in
  // flight (the boot dual-inject-child race window).
  // Re-declare diagnostics forward to the advisory DEBUG channel only: the
  // warn surface for the declaration/skip category is the ONE consolidated
  // line from `reportDeclareOutcome` (plan global constraint: ≤1 warn per
  // category). Per-id skip detail (extraction/interpolation hazards) stays
  // on debug for operators who raise the log level. Failures that matter
  // still warn on their own path (rejecting declare → outer catch; throwing
  // readback → the advisory's own readback warn).
  const seedsLog: SeedsLogSink = (_level, message) => log('debug', message)
  const view = await declareMstarSeeds(service, { agentsDir, log: seedsLog })
  // Readback — sync (probe semantics: a throwing readback degrades to skip +
  // one warn; the adoption state is unavailable, never guessed).
  let readback: EffectiveRolesReadback
  try {
    readback = service.getEffectiveRoles()
  } catch (error) {
    log('warn', `fallbacks effective-state readback failed — adoption state unavailable: ${errorMessage(error)}`)
    return true
  }
  reportEffectiveState(mstarIds, readback)
  reportDeclareOutcome(view)
  return true
}

/** Loader-fallback path (no service): the structural roles.list read, unchanged. */
function runStructuralAdvisory(config: Record<string, unknown>, agentsDir: string | undefined): boolean {
  // The mstar role-id set is mirror-derived (Task 3 surface), never
  // hardcoded: no mirror → no taxonomy reference → one debug.
  if (agentsDir === undefined) {
    log('debug', 'harness-agents mirror absent — fallbacks adoption taxonomy check skipped (config-only advisory)')
    return true
  }
  const mstarIds = subagentRoleIds(agentsDir)
  if (mstarIds.length === 0) {
    log('debug', 'harness-agents mirror has no subagent-mode shells — fallbacks adoption taxonomy check skipped')
    return true
  }
  const list = readRolesList(config)
  if (list === undefined) {
    log('debug', 'fallbacks roles block not structurally readable (roles.list absent or non-array) — adoption advisory skipped')
    return true
  }
  const declared = new Map<string, RoleEntityView>()
  for (let index = 0; index < list.length; index++) {
    const entity = list[index]
    // S-003: a null/primitive entry must not abort the pass — skip the
    // malformed entry with one debug and keep checking the rest.
    if (entity === null || typeof entity !== 'object') {
      log('debug', `fallbacks roles.list entry ${index} is not an object (${entity === null ? 'null' : typeof entity}) — skipped`)
      continue
    }
    const view = entity as RoleEntityView
    if (typeof view.id !== 'string' || view.id === '') continue
    declared.set(view.id, view)
  }
  // (b) Missing ids — ONE warn listing them.
  const missing = mstarIds.filter((id) => !declared.has(id))
  if (missing.length > 0) {
    log('warn', `fallbacks roles.list is missing mstar roles: ${capIdList(missing)} — declare them under the mstar role id (or map via a taxonomy that uses those ids) so role-matched fallback chains resolve`)
  }
  // (c) Empty personas — ONE warn naming them.
  const emptyPersona = [...declared.values()]
    .filter((entity) => {
      const persona = entity.persona
      return typeof persona !== 'string' || persona.trim() === ''
    })
    .map((entity) => entity.id as string)
  if (emptyPersona.length > 0) {
    log('warn', `fallbacks roles.list declares roles with an empty persona: ${capIdList(emptyPersona)} — declare a persona (or remove the role)`)
  }
  return true
}

/**
 * Three-state report per mstar id over the effective readback + the (iv)
 * empty-persona filter (bounded: ≤1 warn per category).
 */
function reportEffectiveState(mstarIds: string[], readback: EffectiveRolesReadback): void {
  const byId = new Map<string, EffectiveRolesReadback['roles'][number]>()
  for (const row of readback.roles) {
    const key = row.id.trim()
    // Plan QC fix wave S-byid: upstream tolerates duplicate ids (materialize
    // keeps both rows), so the trimmed-key map must not let a later duplicate
    // row flip the three-state report — FIRST row wins, surfaced on debug.
    if (byId.has(key)) {
      log('debug', `effective readback carries a duplicate id '${key}' after trimming — first row wins for the three-state report`)
      continue
    }
    byId.set(key, row)
  }
  const missing: string[] = []
  const overridden: string[] = []
  const seeded: string[] = []
  for (const id of mstarIds) {
    const row = byId.get(id)
    if (row === undefined) {
      // (i) No effective row — missing.
      missing.push(id)
      continue
    }
    if (row.personaOverridden) {
      // (iii) Seeded but the row persona differs from the current default.
      overridden.push(id)
      continue
    }
    // (ii) Seeded at the default — silent-by-default (one debug below). A
    // present-but-unseeded mstar row (e.g. an operator row that conflicted
    // with the seed default) is explained by the declare-outcome report.
    if (row.seeded) seeded.push(id)
  }
  if (missing.length > 0) {
    log('warn', `fallbacks taxonomy is missing mstar roles: ${capIdList(missing)} — declare them under the mstar role id (or map via a taxonomy that uses those ids) so role-matched fallback chains resolve`)
  }
  if (seeded.length > 0) {
    log('debug', `fallbacks taxonomy: mstar roles seeded at their defaults — ${capIdList(seeded)}`)
  }
  if (overridden.length > 0) {
    // Revert affordance: the upstream `fallbacks/revert-seed` gateway / the
    // fallbacks settings-card rollback button restores the CURRENT seed
    // default (the operator override is retained until then).
    log('warn', `fallbacks taxonomy overrides the seed persona for mstar roles: ${capIdList(overridden)} — the operator override is retained; revert to the seed default via the fallbacks settings card rollback button (fallbacks/revert-seed gateway)`)
  }
  // (iv) Empty personas — ONLY non-seeded rows or overridden-empty rows (a
  // seeded-at-default row cannot carry an empty persona from our seeds).
  const emptyPersona = readback.roles
    .filter((row) => {
      const persona = row.persona
      if (typeof persona === 'string' && persona.trim() !== '') return false
      return !row.seeded || row.personaOverridden
    })
    .map((row) => row.id)
  if (emptyPersona.length > 0) {
    log('warn', `fallbacks taxonomy declares roles with an empty persona: ${capIdList(emptyPersona)} — declare a persona (or remove the role)`)
  }
}

/**
 * Declare-outcome merge: local skips (`interpolation`/`no-persona`), upstream
 * skips and conflicts (upstream code `'persona-source'`) fold into ONE warn —
 * the operator sees why roles are not seeded at defaults. The revert entry
 * appears when an override was retained (conflict); plain skips have no seed
 * to revert to.
 */
function reportDeclareOutcome(view: SeedOutcomeView): void {
  const { skipped, outcome } = view
  const conflicts = outcome.conflicts
  if (skipped.length === 0 && outcome.skipped.length === 0 && conflicts.length === 0) return
  const parts: string[] = []
  if (skipped.length > 0) {
    parts.push(`skipped locally: ${capIdList(skipped.map((s) => `${s.id} (${s.reason})`))}`)
  }
  if (outcome.skipped.length > 0) {
    parts.push(`skipped upstream: ${capIdList(outcome.skipped.map((s) => `${s.id} (${s.reason})`))}`)
  }
  if (conflicts.length > 0) {
    parts.push(`conflicts: ${capIdList(conflicts.map((c) => `${c.id} (${c.kind} — operator override retained)`))}`)
  }
  const revertNote = conflicts.length > 0 ? ' — revert an override via the fallbacks settings card rollback button (fallbacks/revert-seed gateway)' : ''
  log('warn', `fallbacks seed declaration: ${parts.join('; ')}${revertNote}`)
}

/** Best-effort human-readable message from an arbitrary thrown value (agent-flow `errorMessage` pattern). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the deployment's fallbacks row config structurally
 * (`entry.options.config` — the raw settings document the row carries;
 * schemastery-validated by the fallbacks plugin itself, never here).
 */
function readRowConfig(ctx: Context): Record<string, unknown> | undefined {
  const entry = fallbacksEntry(ctx)
  if (entry === undefined) return undefined
  const config = entry.options.config
  if (config === undefined || config === null || typeof config !== 'object' || Array.isArray(config)) return undefined
  return config as Record<string, unknown>
}

/** Read the deployment's `roles.list` structurally (absent → undefined; schema-defaulted `[]` reads as an empty list). */
function readRolesList(config: Record<string, unknown>): unknown[] | undefined {
  const roles = config.roles
  if (roles === undefined || roles === null || typeof roles !== 'object' || Array.isArray(roles)) return undefined
  const list = (roles as Record<string, unknown>).list
  if (!Array.isArray(list)) return undefined
  return list
}

function log(level: AdvisoryLogLevel, message: string): void {
  try {
    advisoryLogSink(level, message)
  } catch {
    // Never-throws invariant: a throwing log sink must not escape the pass.
  }
}
