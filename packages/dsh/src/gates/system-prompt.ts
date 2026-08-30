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
 *   minimal, never a rules dump (plan pointer-block constraint). The
 *   OUTPUT is zero-complete-`{{...}}`-groups text: dsh system-prompt
 *   renders section AND context text with STRICT `{{variable}}`
 *   interpolation and throws on unknown/malformed/undefined references
 *   (`interpolate` in `@deepseek-ai/dsh-system-prompt`), so every injected
 *   string must carry no complete group. The mechanism is LIVE, not static
 *   (plan QC fix wave W-1): every operator-controlled value embedded below
 *   (harness dir, plan ids, iteration id, lease fields, direction prose)
 *   is passed through `stripInterpolationHazard` — complete `{{…}}` groups
 *   are screened so a hostile value can never break prompt assembly, while
 *   a lone `{{` stays literal prose.
 * - The harness dir is resolved PER ASSEMBLY from the assembly context's
 *   agent (plan QC fix wave W-2 — the catalog pre-step precedent): the
 *   session cwd of the agent whose prompt is being assembled, via
 *   `resolver.forAgent`, with the boot value (`forWorkspace(undefined)`,
 *   the explicit config or null) as the fallback when the assembly carries
 *   no agent. Zero-config deployments (no explicit `harnessDir`, the
 *   probe-discovers-`.mstar/` default) therefore resolve the pointer and
 *   the status context to the session's own workspace instead of rendering
 *   a permanent `none`/`soft`. The enforcement word is LIVE — the section
 *   text is a provider (the plan:policy precedent) that re-reads
 *   `resolveCompassEnforcement` per assembly (the same existing read the
 *   gates and the catalog use — no new config key), so a mid-session
 *   compass soft/hard flip lands on the next assembly without
 *   re-registration, in zero-config and explicit-config deployments alike.
 * - The context provider reuses the catalog's unified machine-summary
 *   source (`buildCatalogSources` — the SAME builder the engine-status
 *   pre-step catalog row uses) and projects the SLIM digest (plan
 *   `20260820-dsh-engine-status-slim` Task 2): the version watermark
 *   ALWAYS, plus ONE `workflow … | plans: …` line only when the active set
 *   selects a lifecycle (`state.selection.kind === 'active'`). Harness dir
 *   and enforcement live in `mstar:harness-rules`; residuals / leases /
 *   direction / iteration-gate detail stay exclusive to the pre-step row.
 *   v3 (plan `20260819-workflow-dsh-viz` Task 3): the
 *   digest reads ONLY the catalog row (`state` — itself aggregated from the
 *   SELECTED workflow snapshot + project registers) — no direct
 *   status.json / snapshot file reads to change. The build is TTL-memoized
 *   PER RESOLVED HARNESS DIR
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
 * - Registration is deferred through `ctx.inject(['systemPrompt'], …)`
 *   (HMR-safe re-apply): the `section()`/`context()` calls run on the
 *   inject child, and the exact disposers they return are collected on
 *   that child via `systemPromptCtx.effect` (plan QC fix wave W-HMR) — the
 *   registrations therefore unwind with THIS plugin's apply by explicit
 *   ownership, so a re-apply disposes the old registrations before
 *   registering fresh ones (no duplicate-name throw, no stale closure from
 *   the previous apply). A direct global registration through the service
 *   instance without the collected disposers would instead rely on the
 *   cordis traceable-proxy `this.ctx` rebind for ownership — implicit and
 *   version-fragile; the explicit collection removes that dependency.
 * - Registration errors are contained (warn + return `false`); a throwing
 *   log sink is contained inside the log helper (never-throws invariant);
 *   the collected disposers run inside a try/catch so an exotic disposal
 *   throw can never break the fiber teardown.
 *
 * Module boundary: no barrel — the entry imports this module by explicit
 * relative path and does NOT re-export its public names (plan constraint);
 * tests import from this module directly.
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveRepoEnforcement } from '@mstar-harness/engine'
import type { EnforcementFlag } from '@mstar-harness/engine'
import type { MstarEngineStatusSource } from '../types.ts'
import { DEFAULT_CATALOG_TTL_MS, buildCatalogSources } from './catalog.ts'
import { joinCapped, stripInterpolationHazard, type HarnessResolver } from './_shared.ts'

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

/** One consumed prompt-section registration (`@deepseek-ai/dsh-system-prompt` `PromptSection` contract — text may be a provider, same as {@link PromptContextInput}). */
interface PromptSectionInput {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: object) => string)
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
 * dependency-free pattern; the package is NOT a peer dependency). `section` /
 * `context` return the exact Cordis effect disposer of the registration.
 */
interface SystemPromptView {
  section(section: PromptSectionInput): () => void
  context(context: PromptContextInput): () => void
}

/**
 * The harness dir for ONE assembly: resolved from the assembly context's
 * agent (the session cwd → `resolver.forAgent`, the catalog pre-step
 * precedent — plan QC fix wave W-2), with the boot value as the fallback
 * when the assembly carries no agent. Zero-config deployments (no explicit
 * `harnessDir` config) therefore render per session workspace instead of a
 * permanent `none`. Never throws: a resolver failure degrades to the boot
 * value (the provider must stay throw-free).
 * @param context - the assembly context (dsh `assembleContextFor(agent)`
 *   passes the real agent handle; structural read, never trusts the shape).
 * @param resolver - the per-workspace `{HARNESS_DIR}` resolver.
 * @param fallback - the boot value (`resolver.forWorkspace(undefined)`).
 */
function resolveAssemblyHarnessDir(context: object, resolver: HarnessResolver, fallback: string | null): string | null {
  const agent = (context as { agent?: unknown } | null | undefined)?.agent
  if (agent === undefined || agent === null) return fallback
  try {
    return resolver.forAgent(agent)
  } catch (error) {
    log('debug', `mstar:harness-rules per-assembly harness-dir resolution failed (falling back to the boot value): ${errorMessage(error)}`)
    return fallback
  }
}

/**
 * Register the harness-rules pointer section + the engine-status context on
 * the GLOBAL prompt layer.
 *
 * @param ctx - the registrant context (the plugin's apply ctx; unscoped →
 *   the registrations land on the global layer).
 * @param options.resolver - the per-workspace `{HARNESS_DIR}` resolver.
 *   The BOOT value (`forWorkspace(undefined)`, the explicit config or null)
 *   is the fallback; the section and context providers resolve the harness
 *   dir PER ASSEMBLY from the assembly context's agent (the session
 *   workspace), and the section's enforcement word is re-read from the
 *   compass per assembly — so both stay correct in zero-config deployments
 *   and follow mid-session compass flips.
 * @returns `true` when the service exists and registration was scheduled;
 *   `false` when `ctx.systemPrompt` is structurally absent (one debug log,
 *   boot unaffected) or the synchronous registration path threw (contained
 *   warn). The actual registration runs in an inject child that settles
 *   ASYNC — a failure there is contained to a warn and cannot be observed
 *   through this return value (`true` only guarantees scheduling, not
 *   landing; `apply` ignores the value, so boot is never affected). Never
 *   throws.
 */
export function registerHarnessPrompt(ctx: Context, options: { resolver: HarnessResolver }): boolean {
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptView | undefined
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function' || typeof systemPrompt.context !== 'function') {
    log('debug', 'systemPrompt service absent — mstar:harness-rules injection skipped (composition without dsh-system-prompt)')
    return false
  }
  let bootHarnessDir: string | null
  try {
    bootHarnessDir = options.resolver.forWorkspace(undefined)
  } catch (error) {
    log('warn', `mstar:harness-rules injection aborted (degraded — session boot unaffected): ${errorMessage(error)}`)
    return false
  }
  // Deferred through an inject child so the registrations unwind with THIS
  // plugin's apply (HMR-safe re-apply; see the module doc). The exact
  // disposers `section()`/`context()` return are additionally collected on
  // the inject child via `systemPromptCtx.effect` — explicit ownership that
  // does not depend on the cordis traceable-proxy `this.ctx` rebind (plan QC
  // fix wave W-HMR): on a re-apply the child fiber disposal runs the
  // disposers FIRST, so the fresh apply registers without a duplicate-name
  // throw and no stale closure (old resolver/harness dir) lingers.
  ctx.inject(['systemPrompt'], (systemPromptCtx) => {
    try {
      const view = systemPromptCtx.systemPrompt as unknown as SystemPromptView
      const disposeSection = view.section({
        name: HARNESS_RULES_SECTION_NAME,
        order: HARNESS_RULES_SECTION_ORDER,
        // Live text provider (plan:policy precedent — provider text, no
        // re-registration): the harness dir resolves per assembly from the
        // assembly context's agent (zero-config per-workspace), and the
        // enforcement word is re-read from that workspace's compass per
        // assembly, so a mid-session soft/hard flip lands on the next
        // assembly — in zero-config and explicit-config deployments alike.
        text: (context) => {
          const harnessDir = resolveAssemblyHarnessDir(context, options.resolver, bootHarnessDir)
          return harnessRulesText(harnessDir, sectionEnforcement(harnessDir))
        },
      })
      const disposeContext = view.context({
        name: ENGINE_STATUS_CONTEXT_NAME,
        order: ENGINE_STATUS_CONTEXT_ORDER,
        text: engineStatusProvider(ctx, options.resolver, bootHarnessDir),
      })
      systemPromptCtx.effect(function* () {
        yield () => {
          // Idempotent + contained: the disposers remove only their own
          // entries; a throw here would surface in the fiber teardown, so
          // each is individually guarded (never-throws discipline).
          try {
            disposeSection()
          } catch {
            // ignore — the layer entry is already gone
          }
          try {
            disposeContext()
          } catch {
            // ignore — the layer entry is already gone
          }
        }
      }, 'mstar:harness-rules disposer collection')
    } catch (error) {
      log('warn', `mstar:harness-rules registration failed (contained — session boot unaffected): ${errorMessage(error)}`)
    }
  })
  return true
}

/**
 * The section's live enforcement flag: re-resolved from the compass on every
 * assembly (the same `resolveCompassEnforcement` read the gates and the
 * catalog use — the existing read surface, no new config key). Fail-soft by
 * contract: a missing/unreadable iterations dir or compass resolves to
 * `soft`/`none` exactly like the gates themselves, so the pointer word never
 * diverges from the actual gate state and the provider never throws.
 */
function sectionEnforcement(harnessDir: string | null): EnforcementFlag {
  return harnessDir === null ? { hard: false, source: 'none' } : resolveRepoEnforcement(harnessDir)
}

/**
 * The pointer block: presence / enforcement word / resolved
 * `{HARNESS_DIR}` / one read-mstar-harness-core directive. Zero complete
 * `{{...}}` groups by construction (STRICT interpolation safety — plan QC
 * fix wave W-1): the operator-controlled harness dir is screened before
 * embedding, so a path containing `{{…}}` can never break prompt assembly.
 */
function harnessRulesText(harnessDir: string | null, enforcement: EnforcementFlag): string {
  return [
    'This session runs under the Morning Star (mstar) harness: prompts and tool calls are governed by the harness gates and rules.',
    `enforcement: ${enforcement.hard ? 'hard' : 'soft'}`,
    `harness dir: ${stripInterpolationHazard(harnessDir ?? 'none')}`,
    'Before non-trivial work, read the skill `skill://mstar-harness-core` — the authoritative harness entry point (mstar-harness-core first, then topic skills).',
  ].join('\n')
}

/**
 * The apply-scoped engine-status provider: a TTL-memoized bounded projection
 * over `buildCatalogSources` (the catalog's unified machine-summary builder
 * — same source as the pre-step engine-status row). The harness dir resolves
 * PER ASSEMBLY from the assembly context's agent (plan QC fix wave W-2 — the
 * zero-config default), and the memo is keyed by the resolved harness dir so
 * distinct session workspaces keep independent bounded rows instead of
 * sharing one stale boot row. The memo keeps one bounded disk read per
 * `DEFAULT_CATALOG_TTL_MS` per resolved dir instead of a status.json /
 * compass / ledger read on every prompt assembly.
 */
// simplify: separate per-provider TTL cache — a ledger-change invalidation
// clears the CATALOG's entry but not this memo, so the provider serves up to
// one TTL of staleness after a ledger change (same documented tradeoff as the
// catalog). Upgrade path: share the apply-scoped catalog cache + invalidation
// hook with the provider.
function engineStatusProvider(ctx: Context, resolver: HarnessResolver, bootHarnessDir: string | null): (context: object) => string {
  const memo = new Map<string | null, { source: MstarEngineStatusSource; builtAt: number }>()
  return (context) => {
    const harnessDir = resolveAssemblyHarnessDir(context, resolver, bootHarnessDir)
    const now = Date.now()
    let entry = memo.get(harnessDir)
    if (entry === undefined || now - entry.builtAt >= DEFAULT_CATALOG_TTL_MS) {
      entry = { source: buildCatalogSources(ctx, harnessDir), builtAt: now }
      memo.set(harnessDir, entry)
    }
    return engineStatusSummary(entry.source)
  }
}

/**
 * Cap on non-Done plan rows joined into the `mstar:engine-status` digest
 * (plan `20260820-dsh-engine-status-slim` Task 2 — retained from plan
 * `20260820-dsh-digest-bounds` Task 1, now applied to the non-Done-filtered
 * join of the active workflow's plans). Module-level and intentionally NOT
 * re-exported — `catalog.ts` must not import it (a reverse import would
 * close a `system-prompt.ts ↔ catalog.ts` cycle). The sibling catalog state
 * lines cap with their OWN constant (`CATALOG_STATE_JOIN_LIMIT`,
 * plan `20260830-dsh-catalog-cap`); the shared `joinCapped` implementation
 * now lives in `_shared.ts`.
 */
const DIGEST_PLAN_CAP = 8

/**
 * The slim `mstar:engine-status` digest (plan `20260820-dsh-engine-status-slim`
 * Task 2): the version watermark is ALWAYS injected, plus — only when the
 * session's workspace has an active workflow
 * (`source.state.selection.kind === 'active'`) — ONE compact
 * `workflow <id> (<type>) <status> | plans: <id>(<status>) …` line. Idle
 * sessions (empty/absent active set — `state === null`, or a `'terminal'` /
 * `'error'` selection) render the version line alone; the catalog's
 * terminal-mtime history fallback is therefore structurally unreachable
 * from this surface without touching `resolveReadWorkflow`.
 *
 * The plans join is the selected snapshot's non-Done rows
 * (`status !== 'Done'`), in catalog-array order, capped at
 * {@link DIGEST_PLAN_CAP} with a final `+N more` overflow marker when
 * longer; empty after the filter renders `plans: none`. Residuals /
 * leases / direction / harness dir / enforcement / the iteration-gate
 * detail all stay exclusive to the pre-step catalog row.
 *
 * STRICT-interpolation safety (plan QC fix wave W-1): every operator-
 * controlled value (workflow id, workflow type/status, plan ids, plan
 * statuses) is screened through `stripInterpolationHazard` before embedding
 * — a hostile `{{…}}` in any of them can never throw the renderer.
 * Engine-derived literals (version, `workflow`, `plans:`, `none`, `unknown`,
 * the `+N more` overflow marker) are constants, not operator text, and stay
 * unscreened.
 */
function engineStatusSummary(source: MstarEngineStatusSource): string {
  const lines = [`mstar engine status: v${source.version}`]
  const state = source.state
  if (state !== null) {
    const selection = state.selection
    if (selection.kind === 'active') {
      const pending = state.plans.filter((p) => p.status !== 'Done')
      const plans = pending.length === 0
        ? 'none'
        : joinCapped(pending, DIGEST_PLAN_CAP, ' ', (p) => `${stripInterpolationHazard(p.id)}(${stripInterpolationHazard(p.status)})`)
      const workflowType = stripInterpolationHazard(state.workflowType ?? 'unknown')
      const workflowStatus = stripInterpolationHazard(state.workflowStatus ?? 'unknown')
      lines.push(`workflow ${stripInterpolationHazard(selection.workflowId)} (${workflowType}) ${workflowStatus} | plans: ${plans}`)
    }
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
