/**
 * Warn-only adoption advisory for the OPTIONAL `dsh-llm-fallbacks` plugin
 * (plan `20260815-dsh-fallbacks-personas` Task 4): when the capability is
 * mounted, ONE advisory pass per apply structurally reads the deployment's
 * fallbacks row config from the loader entry (`entry.options.config` —
 * architect-verified field: `EntryOptions.config` "Config passed to the
 * plugin", the same value the plugin's `apply()` receives) and warns
 * (bounded: ≤1 warn per category, logger `mstar/fallbacks-advisory`) on
 * taxonomy gaps:
 *
 * - (b) mstar role ids missing from the deployment's `roles.list` — the
 *   mstar role-id set is derived from the `harness-agents/` mirror (Task 3
 *   surface: `subagentRoleIds` — shell file stems filtered to
 *   `mode: subagent`), never hardcoded;
 * - (c) declared role entities with an empty persona;
 * - (d) legacy keys in the row config — the service's own
 *   `detectLegacyKeys` when applied (one of the 6 service keys); when the
 *   service is absent (loader-fallback probe path) the legacy check is
 *   SKIPPED rather than reimplemented.
 *
 * Unreadable row config (absent field / non-object, or an unreadable
 * `roles.list`) → skip + one debug log. Unmounted → the pass is not invoked
 * (returns `false`, no logs). The advisory NEVER writes the fallbacks config
 * — the read is read-only over the deployment's config layer (never the
 * fallbacks plugin's module internals) — and never throws (the caller's
 * dispatch/apply flow is never affected).
 *
 * Module boundary: no barrel — the entry imports this module by explicit
 * relative path (the decoration-module pattern).
 */
import type { Context } from '@deepseek-ai/cordis'
import { subagentRoleIds } from './agent-personas.ts'
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

/** Structural view of one declared fallbacks role entity (`roles.list` entry). */
interface RoleEntityView {
  id?: unknown
  persona?: unknown
}

/**
 * One advisory pass: unmounted → not invoked (`false`, no logs); mounted →
 * structurally read the deployment's fallbacks row config and warn on
 * taxonomy gaps (bounded: ≤1 warn per category). Never throws — every
 * failure mode degrades to skip + one debug log. Never writes.
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param agentsDir - the `harness-agents/` mirror root the mstar role-id set
 *   is derived from; absent → the taxonomy checks are skipped (one debug
 *   log; the legacy-keys check is mirror-independent and still runs).
 * @returns `true` when the pass ran (mounted), `false` when unmounted — the
 *   caller (entry `apply`) uses the boolean for the one-pass-per-apply latch.
 */
export function runFallbacksAdvisory(ctx: Context, agentsDir: string | undefined): boolean {
  try {
    if (!fallbacksMounted(ctx)) return false
    const config = readRowConfig(ctx)
    if (config === undefined) {
      log('debug', 'fallbacks row config unreadable (absent or non-object) — adoption advisory skipped')
      return true
    }
    // (d) Legacy keys — the service's own detector when applied; skipped
    // (never reimplemented) on the loader-fallback probe path.
    const service = fallbacksService(ctx)
    if (service !== undefined) {
      const legacy = service.detectLegacyKeys(config)
      if (legacy.length > 0) {
        log('warn', `fallbacks config carries legacy keys (detectLegacyKeys): ${legacy.join(', ')} — migrate to the current shape (role entities use 'persona'; 'chains', 'roles.default', 'label' and 'description' are removed)`)
      }
    }
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
    for (const entity of list) {
      const view = entity as RoleEntityView
      if (typeof view.id !== 'string' || view.id === '') continue
      declared.set(view.id, view)
    }
    // (b) Missing ids — ONE warn listing them.
    const missing = mstarIds.filter((id) => !declared.has(id))
    if (missing.length > 0) {
      log('warn', `fallbacks roles.list is missing mstar roles: ${missing.join(', ')} — declare them (or a taxonomy alias) so role-matched fallback chains resolve`)
    }
    // (c) Empty personas — ONE warn naming them.
    const emptyPersona = [...declared.values()]
      .filter((entity) => {
        const persona = entity.persona
        return typeof persona !== 'string' || persona.trim() === ''
      })
      .map((entity) => entity.id as string)
    if (emptyPersona.length > 0) {
      log('warn', `fallbacks roles.list declares roles with an empty persona: ${emptyPersona.join(', ')} — declare a persona (or remove the role)`)
    }
    return true
  } catch (error) {
    // Contained like the gate's degrade path: skip the pass, never crash.
    log('warn', `fallbacks adoption advisory aborted (degraded — warn-only, deployment config untouched): ${(error as Error).message}`)
    return true
  }
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
