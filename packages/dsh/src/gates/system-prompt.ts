/**
 * Harness-rules system-prompt injection (plan `20260816-dsh-nb1-systemprompt`
 * Task 2): the root session's ONE `mstar:harness-rules` pointer section plus
 * the `mstar:engine-status` runtime-context summary, both registered on the
 * GLOBAL prompt layer — visible to the root session AND every dispatched
 * child — without touching the child-scoped `mstar:role-persona` section
 * (fallbacks-decoration; distinct name, distinct layer — duplicate-name
 * throws are per name per layer, verified `scope/src/store.ts`).
 *
 * Content discipline:
 * - The section is a POINTER block (presence / enforcement word / resolved
 *   `{HARNESS_DIR}` / one read-mstar-harness-core directive) — deliberately
 *   minimal, never a rules dump (plan pointer-block constraint). Static
 *   text with zero complete `{{...}}` groups: dsh system-prompt renders
 *   section AND context text with STRICT `{{variable}}` interpolation and
 *   throws on unknown/malformed/undefined references (`interpolate` in
 *   `@deepseek-ai/dsh-system-prompt`), so every injected string must carry
 *   no complete group. The enforcement word and the harness dir are
 *   boot-resolved (the same `resolveCompassEnforcement` read the gates and
 *   the catalog use — Task 3 makes the word live per assembly).
 * - The context provider reuses the catalog's unified machine-summary
 *   source (`buildCatalogSources` — the SAME builder the engine-status
 *   pre-step catalog row uses) and projects a BOUNDED subset: watermark +
 *   iteration gate + compact state line. Full status.json content
 *   (residual detail, agent-flow events, knowledge digest, branch/policy
 *   anchors) stays out. The build is TTL-memoized per apply
 *   (`DEFAULT_CATALOG_TTL_MS`) so the per-assembly hot path does not
 *   re-read status.json / the compass / the ledger on every prompt
 *   assembly (the catalog's documented staleness tradeoff).
 *
 * Degradation (boot is never affected — the decoration's contained-degrade
 * discipline):
 * - Structural existence check via `ctx.get('systemPrompt')` — the
 *   `ctx.get('agents')` precedent: a DIRECT `ctx.systemPrompt` property
 *   read throws "cannot get property without inject" on a started cordis
 *   fiber when the service is not composed. Absent service → return `false`
 *   + exactly one debug log.
 * - Registration is deferred through `ctx.inject(['systemPrompt'], …)` so
 *   the section/context effects unwind with THIS plugin's apply (HMR-safe:
 *   a re-apply disposes the old registrations before registering fresh
 *   ones — a direct global registration through the service instance would
 *   throw duplicate-name on re-apply, because its effect would land on the
 *   systemPrompt service fiber, which survives the plugin's HMR).
 * - Registration errors are contained (warn + return `false`); a throwing
 *   log sink is contained inside the log helper (never-throws invariant).
 *
 * Module boundary: no barrel — the entry imports this module by explicit
 * relative path and does NOT re-export its public names (plan constraint);
 * tests import from this module directly.
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveCompassEnforcement } from '@mstar-harness/engine'
import type { EnforcementFlag } from '@mstar-harness/engine'
import type { MstarEngineStatusSource } from '../types.ts'
import { DEFAULT_CATALOG_TTL_MS, buildCatalogSources } from './catalog.ts'
import type { HarnessResolver } from './_shared.ts'

/** Logger label for the harness-prompt injection (dsh logger naming: `<scope>/<subject>`). */
export const HARNESS_PROMPT_LOGGER = 'mstar/harness-prompt'

/** The global harness-rules pointer section name (root AND child assemblies). */
export const HARNESS_RULES_SECTION_NAME = 'mstar:harness-rules'

/** Prompt order of the harness-rules section — after the deployment persona (0) and the child role persona (1), before plan:policy (50). */
export const HARNESS_RULES_SECTION_ORDER = 2

/** The engine-status runtime-context contribution name (durable user-role snapshot). */
export const ENGINE_STATUS_CONTEXT_NAME = 'mstar:engine-status'

/** Prompt order of the engine-status context — first in the runtime snapshot, before the policy sentences (110+). */
export const ENGINE_STATUS_CONTEXT_ORDER = 100

/** Harness-prompt log levels the module sink understands. */
export type HarnessPromptLogLevel = 'debug' | 'warn'

/** Module-level harness-prompt log sink — bound by `apply` to `ctx.logger(HARNESS_PROMPT_LOGGER)` (decoration precedent). */
export type HarnessPromptLogSink = (level: HarnessPromptLogLevel, message: string) => void

let harnessPromptLogSink: HarnessPromptLogSink = () => {}

/**
 * Bind the harness-prompt log sink (the entry `apply` binds it to
 * `ctx.logger(HARNESS_PROMPT_LOGGER)`). Returns the PRIOR sink so a caller
 * can restore it (test pattern: {@link setDecorationLogger}).
 */
export function setHarnessPromptLogger(sink: HarnessPromptLogSink): HarnessPromptLogSink {
  const prior = harnessPromptLogSink
  harnessPromptLogSink = sink
  return prior
}

/** One consumed prompt-section registration (`@deepseek-ai/dsh-system-prompt` `PromptSection` contract). */
interface PromptSectionInput {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** One consumed runtime-context registration (`PromptContext` contract — text may be a provider). */
interface PromptContextInput {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: object) => string)
}

/**
 * The global prompt surface the module registers through (`ctx.systemPrompt`
 * while dsh-system-prompt is composed — the structural view proves the
 * dependency-free pattern; the package is NOT a peer dependency).
 */
interface SystemPromptView {
  section(section: PromptSectionInput): unknown
  context(context: PromptContextInput): unknown
}

/**
 * Register the harness-rules pointer section + the engine-status context on
 * the GLOBAL prompt layer.
 *
 * @param ctx - the registrant context (the plugin's apply ctx; unscoped →
 *   the registrations land on the global layer).
 * @param options.resolver - the per-workspace `{HARNESS_DIR}` resolver; the
 *   boot value (`forWorkspace(undefined)`, the explicit config or null) is
 *   baked into the static pointer and the provider's data source.
 * @returns `true` when the service exists and registration was scheduled;
 *   `false` when `ctx.systemPrompt` is structurally absent (one debug log,
 *   boot unaffected) or the synchronous registration path threw (contained
 *   warn). Never throws.
 */
export function registerHarnessPrompt(ctx: Context, options: { resolver: HarnessResolver }): boolean {
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptView | undefined
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function' || typeof systemPrompt.context !== 'function') {
    log('debug', 'systemPrompt service absent — mstar:harness-rules injection skipped (composition without dsh-system-prompt)')
    return false
  }
  let harnessDir: string | null
  let enforcement: EnforcementFlag
  try {
    harnessDir = options.resolver.forWorkspace(undefined)
    enforcement = harnessDir === null ? { hard: false, source: 'none' } : resolveCompassEnforcement(harnessDir)
  } catch (error) {
    log('warn', `mstar:harness-rules injection aborted (degraded — session boot unaffected): ${errorMessage(error)}`)
    return false
  }
  // Deferred through an inject child so the registrations unwind with THIS
  // plugin's apply (HMR-safe re-apply; see the module doc).
  ctx.inject(['systemPrompt'], (systemPromptCtx) => {
    try {
      const view = systemPromptCtx.systemPrompt as unknown as SystemPromptView
      view.section({
        name: HARNESS_RULES_SECTION_NAME,
        order: HARNESS_RULES_SECTION_ORDER,
        text: harnessRulesText(harnessDir, enforcement),
      })
      view.context({
        name: ENGINE_STATUS_CONTEXT_NAME,
        order: ENGINE_STATUS_CONTEXT_ORDER,
        text: engineStatusProvider(ctx, harnessDir),
      })
    } catch (error) {
      log('warn', `mstar:harness-rules registration failed (contained — session boot unaffected): ${errorMessage(error)}`)
    }
  })
  return true
}

/**
 * The static pointer block: presence / enforcement word / resolved
 * `{HARNESS_DIR}` / one read-mstar-harness-core directive. Zero complete
 * `{{...}}` groups by construction (STRICT interpolation safety).
 */
function harnessRulesText(harnessDir: string | null, enforcement: EnforcementFlag): string {
  return [
    'This session runs under the Morning Star (mstar) harness: prompts and tool calls are governed by the harness gates and rules.',
    `enforcement: ${enforcement.hard ? 'hard' : 'soft'}`,
    `harness dir: ${harnessDir ?? 'none'}`,
    'Before non-trivial work, read the skill `skill://mstar-harness-core` — the authoritative harness entry point (mstar-harness-core first, then topic skills).',
  ].join('\n')
}

/**
 * The apply-scoped engine-status provider: a TTL-memoized bounded projection
 * over `buildCatalogSources` (the catalog's unified machine-summary builder
 * — same source as the pre-step engine-status row). The memo keeps one
 * bounded disk read per `DEFAULT_CATALOG_TTL_MS` per apply instead of a
 * status.json/compass/ledger read on every prompt assembly.
 */
// simplify: separate per-provider TTL cache — a ledger-change invalidation
// clears the CATALOG's entry but not this memo, so the provider serves up to
// one TTL of staleness after a ledger change (same documented tradeoff as the
// catalog). Upgrade path: share the apply-scoped catalog cache + invalidation
// hook with the provider.
function engineStatusProvider(ctx: Context, harnessDir: string | null): () => string {
  let cached: MstarEngineStatusSource | null = null
  let builtAt = 0
  return () => {
    const now = Date.now()
    if (cached === null || now - builtAt >= DEFAULT_CATALOG_TTL_MS) {
      cached = buildCatalogSources(ctx, harnessDir)
      builtAt = now
    }
    return engineStatusSummary(cached)
  }
}

/**
 * The bounded machine summary: watermark + iteration gate + one compact
 * state line (+ the compass direction one-liner when present). Deliberately
 * EXCLUDES the full status.json surface — residual finding detail,
 * agent-flow events, knowledge digest and branch/policy anchors stay out.
 */
function engineStatusSummary(source: MstarEngineStatusSource): string {
  const lines = [
    `mstar engine status: v${source.version} | harness ${source.harnessDir ?? 'none'} | enforcement ${source.enforcement.hard ? 'hard' : 'soft'}`,
  ]
  const iteration = source.iteration
  if (iteration !== undefined) {
    const gate = iteration.gate
    const codes = gate.violations.map((v) => v.code).join(', ')
    lines.push(`iteration ${iteration.iterationId}: gate ${gate.ok ? 'PASS' : `FAIL (${codes})`} | transition ${gate.transition} | all plans done ${gate.all_plans_done}`)
  }
  const state = source.state
  if (state !== null) {
    const plans = state.plans.length === 0 ? 'none' : state.plans.map((p) => `${p.id}(${p.status})`).join(' ')
    const residuals = state.residuals.length === 0 ? 'none' : state.residuals.map((r) => `${r.severity} ${r.count}`).join(', ')
    const leases = state.leases.length === 0 ? 'none active' : state.leases.map((l) => `${l.planId} → ${l.holder}`).join('; ')
    lines.push(`plans: ${plans} | residuals: ${residuals} | leases: ${leases}`)
    if (state.direction !== null) lines.push(`direction: ${state.direction}`)
  }
  return lines.join('\n')
}

/** Best-effort human-readable message from an arbitrary thrown value (decoration `errorMessage` pattern). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function log(level: HarnessPromptLogLevel, message: string): void {
  try {
    harnessPromptLogSink(level, message)
  } catch {
    // Never-throws invariant (decoration F-002 pattern): a throwing log
    // sink must not escape the registration path — boot is never affected.
  }
}
