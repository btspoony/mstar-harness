/**
 * Harness-rules system-prompt injection (visible to the root session AND every dispatched
 * child — on their own names and layers (the child persona rides the NATIVE
 * subagent persona channel since plan
 *   Task 3 — no child-scoped
 * `mstar:role-persona` section exists anymore; duplicate-name throws remain
 * per name per layer, verified `scope/src/store.ts`).
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
 *   : every operator-controlled value embedded below
 *   (harness dir, plan ids, iteration id, lease fields, direction prose)
 *   is passed through `stripInterpolationHazard` — complete `{{…}}` groups
 *   are screened so a hostile value can never break prompt assembly, while
 *   a lone `{{` stays literal prose.
 * - The harness dir is resolved PER ASSEMBLY from the assembly context's
 *   agent : the
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
 *   payload (`buildCatalogPayloadWithStore` — the same ACTIVE graph-backed
 *   builder used by the pre-step catalog row) and projects the SLIM digest.
 *   The prompt API's provider is synchronous, so the configured workspace is
 *   resolved once when the service is injected; additional per-assembly
 *   workspaces are loaded asynchronously and cached for their next assembly.
 *   The cache is TTL-refreshed per resolved harness dir.
 *
 * Degradation (boot is never affected — the persona channel's contained-degrade
 * discipline):
 * - Structural existence check via `ctx.get('systemPrompt')` — the
 *   `ctx.get('agents')` precedent: a DIRECT `ctx.systemPrompt` property
 *   read throws "cannot get property without inject" on a started cordis
 *   fiber when the service is not composed. Absent service → return `false`
 *   + exactly one debug log.
 * - Registration is deferred through `ctx.inject(['systemPrompt'], …)`
 *   (HMR-safe re-apply): the `section()`/`context()` calls run on the
 *   inject child, and the exact disposers they return are collected on
 *   that child via `systemPromptCtx.effect`  — the
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
import type { MstarEngineStatusPayload } from '../types.ts'
import { DEFAULT_CATALOG_TTL_MS, buildCatalogPayload, buildCatalogPayloadWithStore, gateSegment } from './catalog.ts'
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

/** Module-level harness-prompt log sink — bound by `apply` to `ctx.logger(HARNESS_PROMPT_LOGGER)` (module-sink precedent). */
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

/**
 * Lifecycle hooks for {@link registerHarnessPrompt} — the scheduling-independent
 * registration signal. `onRegistered` fires ONLY after both the
 * `mstar:harness-rules` section and the `mstar:engine-status` context have
 * actually landed (never from the contained failure path); `onDisposed` fires
 * from the registration disposer after those entries are removed (HMR
 * re-apply / service removal), so the fallback can return. Both hooks are
 * contained: a throw is logged and can never change the registration outcome
 * or escape the fiber teardown.
 */
export interface HarnessPromptRegistrationHooks {
  /** Both registrations landed (last successful step of the inject callback). */
  onRegistered?: () => void
  /** The registrations were disposed; nothing from this registration is live. */
  onDisposed?: () => void
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
 * precedent —), with the boot value as the fallback
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
 * @param options.onRegistered - fires after BOTH registrations have landed
 *   (the last successful step of the inject callback; a contained
 *   registration failure never calls it). This — not the return value — is
 *   the confirmed-live signal a consumer must base fallback rendering on.
 * @param options.onDisposed - fires from the collected disposer after the
 *   section and context are removed (HMR re-apply / service removal), so a
 *   consumer's confirmed-live state can return to the fallback.
 * @returns `true` when the service exists and registration was scheduled;
 *   `false` when `ctx.systemPrompt` is structurally absent (one debug log,
 *   boot unaffected) or the synchronous registration path threw (contained
 *   warn). The actual registration runs in an inject child that settles
 *   ASYNC — a failure there is contained to a warn and cannot be observed
 *   through this return value (`true` only guarantees scheduling, not
 *   landing; `apply` ignores the value, so boot is never affected). Use
 *   {@link HarnessPromptRegistrationHooks} for landed-state decisions. Never
 *   throws.
 */
export function registerHarnessPrompt(
  ctx: Context,
  options: { resolver: HarnessResolver } & HarnessPromptRegistrationHooks,
): boolean {
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
  // does not depend on the cordis traceable-proxy `this.ctx` rebind : on a re-apply the child fiber disposal runs the
  // disposers FIRST, so the fresh apply registers without a duplicate-name
  // throw and no stale closure (old resolver/harness dir) lingers.
  ctx.inject(['systemPrompt'], async (systemPromptCtx) => {
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
          return harnessRulesText(harnessDir, sectionEnforcement(harnessDir), teamLayerMounted(ctx))
        },
      })
      const disposeContext = view.context({
        name: ENGINE_STATUS_CONTEXT_NAME,
        order: ENGINE_STATUS_CONTEXT_ORDER,
        text: await engineStatusProvider(ctx, options.resolver, bootHarnessDir),
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
          // The entries are gone: this registration no longer carries the
          // version / harness dir / enforcement facts, so a fallback consumer
          // must return to its watermark. Called after BOTH removal attempts
          // (and independently of their outcome — the hook is the live-state
          // signal, not a disposal-success report).
          notifyRegistrationHook(options.onDisposed, 'onDisposed')
        }
      }, 'mstar:harness-rules disposer collection')
      // LAST successful step — nothing below can fail the registration, so
      // the hook is exactly the "both registrations landed" signal. A throw
      // from `section`, the awaited provider, or `context` above skips it and
      // is caught by the contained path below: a failed registration must
      // never report itself as live.
      notifyRegistrationHook(options.onRegistered, 'onRegistered')
    } catch (error) {
      log('warn', `mstar:harness-rules registration failed (contained — session boot unaffected): ${errorMessage(error)}`)
    }
  })
  return true
}

/**
 * Invoke one lifecycle hook with the module's never-throws discipline: a
 * throwing consumer callback is logged and swallowed, so it can neither fail
 * the registration nor break the fiber teardown.
 */
function notifyRegistrationHook(hook: (() => void) | undefined, name: string): void {
  if (hook === undefined) return
  try {
    hook()
  } catch (error) {
    log('warn', `mstar:harness-rules ${name} hook failed (contained — registration state unchanged): ${errorMessage(error)}`)
  }
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
 * The delegation contract: which channel is the default and what shape every
 * dispatch prompt must take. Appended only when the Agent Teams service is
 * mounted — without it `spawn_teammate` does not exist, so the first line
 * would name a tool the session cannot call.
 *
 * Both facts are otherwise reachable only through `mstar-host` →
 * `references/dsh.md`, which a coordinator that is mid-task on something else
 * does not open; a session that never reads it sends writable work through
 * `subagent` and hand-writes header-less `workflow agent()` prompts, and
 * neither the dispatch gate (no pre-start seam on `workflow`) nor the role
 * gate (reads only `Execute as`) can correct that after the fact.
 */
const TEAM_DELEGATION_CONTRACT = [
  'delegation: Agent Teams is mounted — `spawn_teammate` is the default channel for writable work (one durable teammate per writable track); `subagent` is a one-off read-only seat.',
  'dispatch prompt: every delegation prompt — `workflow agent()` included — opens with "## Assignment" and "Execute as: <role>"; the role gate cannot repair a header-less `workflow` child.',
].join('\n')

/**
 * Whether the optional Agent Teams service is mounted — the same structural
 * read the ledger uses (`references/dsh-agent-teams.md`). Read per assembly,
 * not at apply: the service may land after this plugin's apply on some
 * compositions. Never throws.
 */
function teamLayerMounted(ctx: Context): boolean {
  try {
    return ctx.get('agentTeams') !== undefined
  } catch {
    return false
  }
}

/**
 * The pointer block: presence / enforcement word / resolved
 * `{HARNESS_DIR}` / one read-mstar-harness-core directive — plus the
 * delegation contract when the Team layer is mounted. Zero complete
 * `{{...}}` groups by construction (STRICT interpolation safety — plan QC
 * fix wave W-1): the operator-controlled harness dir is screened before
 * embedding, so a path containing `{{…}}` can never break prompt assembly.
 */
function harnessRulesText(harnessDir: string | null, enforcement: EnforcementFlag, teamMounted: boolean): string {
  return [
    'This session runs under the Morning Star (mstar) harness: prompts and tool calls are governed by the harness gates and rules.',
    `enforcement: ${enforcement.hard ? 'hard' : 'soft'}`,
    `harness dir: ${stripInterpolationHazard(harnessDir ?? 'none')}`,
    'Before non-trivial work, read the skill `skill://mstar-harness-core` — the authoritative harness entry point (mstar-harness-core first, then topic skills).',
    ...(teamMounted ? [TEAM_DELEGATION_CONTRACT] : []),
  ].join('\n')
}

/**
 * The apply-scoped engine-status provider. The system-prompt API requires a
 * synchronous text provider, so hydrate its cache asynchronously when the
 * service is injected and refresh in the background when a workspace's TTL
 * expires. The configured workspace is ready for its first assembly; a new
 * per-agent workspace starts its bounded read on first use.
 */
function engineStatusProvider(
  ctx: Context,
  resolver: HarnessResolver,
  bootHarnessDir: string | null,
): Promise<(context: object) => string> {
  const memo = new Map<string | null, { payload: MstarEngineStatusPayload; builtAt: number }>()
  const pending = new Map<string | null, Promise<void>>()
  const refresh = (harnessDir: string | null): Promise<void> => {
    const active = pending.get(harnessDir)
    if (active !== undefined) return active
    const request = (harnessDir === null
      ? Promise.resolve(buildCatalogPayload(ctx, null))
      : buildCatalogPayloadWithStore(ctx, harnessDir)
    ).then((payload) => {
      memo.set(harnessDir, { payload, builtAt: Date.now() })
    }).catch((error: unknown) => {
      log('warn', `mstar:engine-status ACTIVE catalog read failed: ${errorMessage(error)}`)
      if (!memo.has(harnessDir)) {
        memo.set(harnessDir, { payload: buildCatalogPayload(ctx, harnessDir), builtAt: Date.now() })
      }
    }).finally(() => {
      pending.delete(harnessDir)
    })
    pending.set(harnessDir, request)
    return request
  }

  return (async () => {
    await refresh(bootHarnessDir)
    return (context: object): string => {
      const harnessDir = resolveAssemblyHarnessDir(context, resolver, bootHarnessDir)
      const entry = memo.get(harnessDir)
      if (entry === undefined) {
        void refresh(harnessDir)
        return engineStatusSummary(buildCatalogPayload(ctx, harnessDir))
      }
      if (Date.now() - entry.builtAt >= DEFAULT_CATALOG_TTL_MS) void refresh(harnessDir)
      return engineStatusSummary(entry.payload)
    }
  })()
}

/**
 * Cap on non-Done plan rows joined into the `mstar:engine-status` digest
 * . Module-level and intentionally NOT
 * re-exported — `catalog.ts` must not import it (a reverse import would
 * close a `system-prompt.ts ↔ catalog.ts` cycle). The sibling catalog state
 * lines cap with their OWN constant (`CATALOG_STATE_JOIN_LIMIT`,
 *); the shared `joinCapped` implementation
 * now lives in `_shared.ts`.
 */
const DIGEST_PLAN_CAP = 8

/**
 * The slim `mstar:engine-status` digest (only when the
 * session's workspace has an active workflow
 * (`payload.state.selection.kind === 'active'`) — ONE compact
 * `workflow <id> (<type>) <status> | plans: <id>(<status>) … [| branch: <base>
 * → <target>] [| gate: …]` line. Idle sessions (empty/absent active set —
 * `state === null`, or a `'terminal'` / `'error'` selection) render the version
 * line alone; the catalog's terminal-mtime history fallback is therefore
 * structurally unreachable from this surface without touching
 * `resolveReadWorkflow`.
 *
 * The plans join is the selected snapshot's non-Done rows
 * (`status !== 'Done'`), in catalog-array order, capped at
 * {@link DIGEST_PLAN_CAP} with a final `+N more` overflow marker when
 * longer; an empty registry renders `plans: none` and an all-Done workflow
 * `plans: all done` (two different states, never one text).
 *
 * Division of labour with the pre-step catalog row: this always-on digest is
 * the surface that survives a row-less step AND host-side compaction (the row
 * is a change-driven DELTA and is not re-anchored per turn), so it carries the
 * version, the active workflow, its non-Done plans, the `branch` anchors (when
 * the payload resolved both) and the iteration phase-`gate` verdict (when a
 * steering compass gated it) — the two facts a post-compaction step still has
 * to decide on. Residuals / plan row scopes / direction / harness dir /
 * enforcement / the agent-flow ledger are NOT re-added here: they stay
 * payload-only (the panel renders them from the persisted emission) and each is
 * read on demand from its own authority (`mstar status tech-debt`, the compass
 * document, `mstar roadmap show`, the knowledge tree) — no single `status`
 * command serves them. Do not restate a dropped row line in this digest: the
 * two surfaces must not duplicate each other.
 *
 * STRICT-interpolation safety : every operator-
 * controlled value (workflow id, workflow type/status, plan ids, plan
 * statuses, branch anchors) is screened through `stripInterpolationHazard`
 * before embedding — a hostile `{{…}}` in any of them can never throw the
 * renderer. Engine-derived literals (version, `workflow`, `plans:`, `none`,
 * `all done`, `unknown`, the `+N more` overflow marker) are constants, not
 * operator text, and stay unscreened.
 */
function engineStatusSummary(payload: MstarEngineStatusPayload): string {
  const lines = [`mstar engine status: v${payload.version}`]
  const state = payload.state
  if (state !== null) {
    const selection = state.selection
    if (selection.kind === 'active') {
      const pending = state.plans.filter((p) => p.status !== 'Done')
      const plans = state.plans.length === 0
        ? 'none'
        : pending.length === 0
          ? 'all done'
          : joinCapped(pending, DIGEST_PLAN_CAP, ' ', (p) => `${stripInterpolationHazard(p.id)}(${stripInterpolationHazard(p.status)})`)
      const workflowType = stripInterpolationHazard(state.workflowType ?? 'unknown')
      const workflowStatus = stripInterpolationHazard(state.workflowStatus ?? 'unknown')
      // The ROW's segment order (catalog.ts `renderEngineStatusCatalog`): the
      // same facts in the same sequence, so a reader comparing the two surfaces
      // does not have to re-learn a second layout.
      const segments = [
        `workflow ${stripInterpolationHazard(selection.workflowId)} (${workflowType}) ${workflowStatus}`,
        `plans: ${plans}`,
      ]
      if (state.iterationBaseBranch !== null && state.targetBranch !== null) {
        segments.push(`branch: ${stripInterpolationHazard(state.iterationBaseBranch)} → ${stripInterpolationHazard(state.targetBranch)}`)
      }
      // The iteration section IS the phase gate: the workflow id it names is
      // already in the first segment, so only the verdict + transition join.
      if (payload.iteration !== undefined) segments.push(gateSegment(payload.iteration.gate))
      lines.push(segments.join(' | '))
    }
  }
  return lines.join('\n')
}

/** Best-effort human-readable message from an arbitrary thrown value (shared `errorMessage` pattern). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function log(level: HarnessPromptLogLevel, message: string): void {
  try {
    harnessPromptLogSink(level, message)
  } catch {
    // Never-throws invariant : a throwing log
    // sink must not escape the registration path — boot is never affected.
  }
}
