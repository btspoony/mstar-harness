/**
 * Morning Star harness gates for dsh (DeepSeek Harness).
 *
 * Cordis function plugin: named exports only — the dsh Loader discards the plugin's namespace
 * (dropping `inject` metadata) when a default export is present, so this module never
 * default-exports. Registrations happen through `ctx` effects/events in `apply`.
 *
 * @module @mstar-harness/dsh
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Context } from 'cordis'
import {
  apply as applySkillLocal,
  Config as SkillLocalSchema,
  inject as skillLocalInject,
  name as skillLocalName,
} from '@deepseek-ai/dsh-skill-local'
import { resolveCompassEnforcement } from '@mstar-harness/engine'
// Type-only: loads the `ctx.commands` cordis augmentation + the command
// handler invocation shape from the (peer-stub / real) dsh-commands seam —
// the runtime registration goes through `ctx.inject(['commands'], …)`.
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DshMstar } from './service.ts'
import {
  Config,
  HarnessResolver,
  skillLocalConfig,
} from './gates/_shared.ts'
import {
  preStepCatalogListener,
  buildCatalogSources,
  createCatalogInvalidation,
  DEFAULT_CATALOG_TTL_MS,
  EXPLICIT_CACHE_KEY,
} from './gates/catalog.ts'
import type { CatalogCacheEntry, TurnDigest } from './gates/catalog.ts'
import { writeIntentListener, editIntentListener } from './gates/status.ts'
import type { StatusGateAdvisory } from './gates/status.ts'
import { skillWriteIntentListener } from './gates/skill-lint.ts'
import type { SkillLintAdvisory } from './gates/skill-lint.ts'
import { seamWriteIntentListener } from './gates/seams.ts'
import type { SeamId, SeamLintAdvisory } from './gates/seams.ts'
import { registerSddIterationTools, registerSeamTools } from './gates/tools.ts'
import { DshHostAdapter } from './gates/adapter.ts'
import type { DshHostAdapterOptions } from './gates/adapter.ts'
import {
  preExecuteListener,
  DISPATCH_LOGGER,
} from './gates/dispatch.ts'
import type { DispatchGateAdvisory } from './gates/dispatch.ts'
import {
  AGENT_FLOW_LOGGER,
  registerSettleListener,
  recordTaskSettle,
  setAgentFlowInvalidator,
  setAgentFlowLogger,
} from './gates/agent-flow.ts'
import type { AgentFlowPairing, TaskDoneSnapshot } from './gates/agent-flow.ts'

// Re-export the service type from the package entry: the cordis
// `Context` augmentation (`ctx.dshMstar`) lives in service.d.ts, so the entry
// must reference it for consumers importing `@mstar-harness/dsh` to see a
// typed `ctx.dshMstar`.
export { DshMstar } from './service.ts'
export type { DshMstarOptions } from './service.ts'
export type {
  MstarEngineStatusSource,
  MstarHarnessState,
  MstarIterationGateView,
  AgentFlowEventView,
  AgentFlowSummaryRow,
  AgentFlowView,
} from './types.ts'
export {
  AGENT_FLOW_FILE,
  AGENT_FLOW_MAX_EVENTS,
  SETTLE_SEAM,
  readAgentFlow,
  recordDispatch,
  recordSettle,
} from './gates/agent-flow.ts'
export type { AgentFlowEvent, DispatchVerdict, SettleOutcome } from './gates/agent-flow.ts'
export { Config, HarnessResolver, skillLocalConfig } from './gates/_shared.ts'
export type { StatusGateAdvisory } from './gates/status.ts'
export { SkillLintVetoError, lintSkillDoc, lintSkillWrite } from './gates/skill-lint.ts'
export type { SkillLintAdvisory } from './gates/skill-lint.ts'
export { SeamVetoError, lintSeamWrite, lintDesignMdWrite, lintAuditWrite, lintCompoundWrite, lintRolesWrite } from './gates/seams.ts'
export type { SeamId, SeamLintAdvisory } from './gates/seams.ts'
export type { DispatchGateAdvisory } from './gates/dispatch.ts'
export { DshHostAdapter } from './gates/adapter.ts'
export type { DshHostAdapterOptions } from './gates/adapter.ts'

/** Cordis function-plugin name registered by the Loader. */
export const name = 'dsh'

/**
 * Services required before this plugin's `apply` fiber starts.
 * Empty for the scaffold: the plan's gates register on events (`fs/write-intent`,
 * `tools/pre-execute`), not on injected services; `inject` grows if a service seam is needed.
 */
export const inject: string[] = []

declare module 'cordis' {
  interface Context {
    /**
     * The plugin's engine `HostAdapter` implementation (`host: 'dsh'`) —
     * provided as a dsh service (constructed in `apply`, same convention as
     * `ctx.dshMstar`) so host hooks and future inject consumers share the
     * one instance.
     */
    dshHostAdapter: DshHostAdapter
  }

  interface Events {
    /**
     * Advisory: a subagent dispatch passed the dispatch gate in warn mode
     * (violations logged, dispatch allowed). Emitted only when the Assignment
     * has violations; clean passes stay silent.
     * @param payload - the gate verdict and dispatch identity.
     * @mode emit
     */
    'mstar/dispatch-gate'(payload: DispatchGateAdvisory): void
    /**
     * Advisory: a `{HARNESS_DIR}/status.json` write/edit intent passed the
     * status gate in warn mode (violations logged, write allowed). Emitted
     * only when the current document has violations; clean passes stay silent.
     * @param payload - the gate verdict and target.
     * @mode emit
     */
    'mstar/status-gate'(payload: StatusGateAdvisory): void
    /**
     * Advisory: a `SKILL.md` write-intent under a configured skill root
     * found skill-authoring lint violations in the pre-write on-disk
     * document (warn mode), was allowed as a hard-mode repair escape, or
     * degraded to allow. Emitted only when the current document has
     * violations; clean passes stay silent.
     * @param payload - the lint verdict and target.
     * @mode emit
     */
    'mstar/skill-lint'(payload: SkillLintAdvisory): void
    /**
     * Advisory: an artifact-scoped write-intent (DESIGN.md / DESIGN.dark.md,
     * audit plan files under `plans/audit-*`, knowledge docs under
     * `{HARNESS_DIR}/knowledge/`, mstar-roles SKILL.md + references) found
     * engine violations in the pre-write on-disk document (warn mode), was
     * allowed as a hard-mode repair escape, or degraded to allow. Emitted
     * only when the current document has violations; clean passes stay
     * silent. The `seam` field discriminates the four gates.
     * @param payload - the gate verdict, seam, and target.
     * @mode emit
     */
    'mstar/seam-lint'(payload: SeamLintAdvisory): void
  }
}

/**
 * The plugin package's own `harness-commands/` mirror (synced from the repo
 * root by `bundle-assets` at build/postinstall; gitignored). Package-relative
 * like {@link packagedSkillsDir}. Returns undefined when absent.
 */
function packagedCommandsDir(): string | undefined {
  try {
    const dir = fileURLToPath(new URL('../harness-commands', import.meta.url))
    return existsSync(dir) ? dir : undefined
  } catch {
    return undefined
  }
}

/** Frontmatter field value of one command markdown (`name`/`description`/`agent`/`input`). */
function commandFrontmatterField(frontmatter: string, label: string): string | undefined {
  const match = new RegExp(`^${label}[ \\t]*:[ \\t]*(.+)$`, 'm').exec(frontmatter)
  return match?.[1]?.trim()
}

/**
 * Strip one pair of surrounding double quotes (frontmatter authors quote
 * values containing `[`/`]` so YAML treats them as scalars, not flow
 * sequences — e.g. `input: "[direction] [pause]"`).
 */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

/**
 * Parse one bundled mstar command markdown (`harness-commands/<name>.md`):
 * the `---` frontmatter block yields `name` + `description` (registration
 * metadata) and the optional `input` hint (the dsh-commands `input.hint`
 * advertised to capable clients — declaring it makes the dsh web client
 * CLAIM the command: the picked `/name ` token is inserted into the
 * composer with the command highlight and the hint as ghost text, waits
 * for the user's follow-up args, and only submits on Enter; without it
 * the client executes the bare command immediately on pick). The body is
 * the command content the handler steers into the receiving agent.
 * Returns undefined for files without a parseable block.
 */
function parseCommandMarkdown(content: string): { name: string; description: string; input?: string; body: string } | undefined {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length === 0 || lines[0]!.trim() !== '---') return undefined
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') { end = i; break }
  }
  if (end === -1) return undefined
  const frontmatter = lines.slice(1, end).join('\n')
  const name = commandFrontmatterField(frontmatter, 'name')
  const description = commandFrontmatterField(frontmatter, 'description')
  if (name === undefined || description === undefined) return undefined
  const input = commandFrontmatterField(frontmatter, 'input')
  // The dsh-commands registry rejects an empty input hint — treat a blank
  // `input:` as absent so the command registers without the claim.
  return {
    name,
    description: unquote(description),
    ...(input !== undefined && input !== '' ? { input: unquote(input) } : {}),
    body: lines.slice(end + 1).join('\n').trim(),
  }
}

/**
 * Register the bundled mstar commands (`harness-commands/*.md`, synced from
 * the repo root by `bundle-assets`; gitignored) on `ctx.commands` — the
 * omp/opencode slash-command parity surface (`/iteration-start`,
 * `/iteration-drive`, `/iteration-loop`, `/codebase-audit`). Each command
 * handler steers the command body into the receiving agent as a user message
 * (the dsh-commands "explicitly schedule model-visible work through the
 * receiving Agent" path), returning a success result. When the frontmatter
 * declares an `input` hint, the registration advertises `input.hint`, which
 * flips the dsh web client's decision table from detached bare execution to
 * a leadingInput claim (composer insert + args wait — the /plan, /goal,
 * /advisor interaction); user-typed args are appended to the steered text.
 * The registration is deferred with `ctx.inject(['commands'], …)` — the same
 * optional-unit pattern as the tools — so the plugin boots without the
 * commands service. Absent mirror (no `bundle-assets` run) → no
 * registrations.
 * @param ctx - registrant context carrying the commands service.
 */
function registerMstarCommands(ctx: Context): void {
  const dir = packagedCommandsDir()
  if (dir === undefined) return
  ctx.inject(['commands'], (commandsCtx) => {
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.md')) continue
      const parsed = parseCommandMarkdown(readFileSync(join(dir, file), 'utf8'))
      if (parsed === undefined) continue
      commandsCtx.commands.register({
        name: parsed.name,
        description: parsed.description,
        // Declaring `input.hint` makes the dsh web client CLAIM the command
        // on menu pick instead of executing it detached: `/name ` is
        // inserted into the composer (command-colored token, the hint as
        // ghost text) and the line submits only on Enter — the interaction
        // the user asked for. Commands without a frontmatter `input:` keep
        // the previous bare-immediate behavior.
        ...(parsed.input !== undefined ? { input: { hint: parsed.input } } : {}),
        handler: (invocation: CommandInvocation) => {
          // The command body is delivered to the model as a USER message —
          // the dsh-plan-mode /permission command precedent (`source:
          // { kind: 'user' }`). A plugin-source message reads as injected
          // context (trajectory UI labels it "Plugin · …"), and the model
          // treats it as system-provided context rather than a task to
          // execute; a user-source message is what makes the model act on
          // the mstar command body.
          const rawInput = invocation.rawInput.trim()
          // A claimed execution can carry user-typed follow-up args
          // (`/iteration-start <direction>`); append them to the steered
          // text so the model receives the prompt alongside the command
          // body. A bare execute (`/iteration-start`) has an empty rawInput
          // and steers the body alone.
          const text = rawInput === ''
            ? parsed.body
            : `${parsed.body}\n\n## User input\n\n${rawInput}`
          const message = createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text }],
          })
          invocation.agent.steer(message)
          return { kind: 'success', text: `mstar ${parsed.name} started` }
        },
      })
    }
  })
}

/**
 * Apply the plugin to the registrant context: resolve `{HARNESS_DIR}` via the
 * engine (per-workspace — the probe never starts from the process cwd),
 * expose the engine surface as `ctx.dshMstar`, construct the host
 * adapter (the gates route through it — one code path with the host hooks),
 * and register the status gate on the fs intent waterfalls + the dispatch
 * gate on `tools/pre-execute`.
 *
 * Layering: the gates are co-located engine wrappers in this
 * module importing `@mstar-harness/engine` directly (same plugin, engine
 * bundled at build time); `ctx.dshMstar` is the composition/test façade for
 * future inject consumers (catalogs) — see the README Service section; the
 * adapter is the host-facing facade. The engine is the single grammar for
 * both paths.
 * @param ctx - Cordis context of the composed app.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Per-workspace `{HARNESS_DIR}` resolution: the probe NEVER starts from
  // the process cwd — it starts from the WORKSPACE root of the session
  // whose agent drives each event (the session cwd). At boot there is no
  // session yet, so the boot value is the explicit config or null; every
  // event path (fs intents, tools/pre-execute, agent/pre-step, tool
  // executes) resolves per its own session workspace, memoized per
  // workspace root. Repos whose harness root is not a probed name
  // (`.mstar/` → `.agents/` → `.plans/`/`plans/` — e.g. this repo's
  // `.harness/`) declare `config.harnessDir`, which wins outright.
  const resolver = new HarnessResolver(config.harnessDir)
  const bootHarnessDir = resolver.forWorkspace(undefined)
  // The Service constructor registers itself on the fiber via reflect.provide,
  // so construction alone exposes `ctx.dshMstar` (dsh service convention).
  new DshMstar(ctx, { harnessDir: bootHarnessDir })
  // Agent-flow settle pairing store (plan `20260811-panel-f4-timeliness`
  // Task 1, decision D1): apply-scoped in-memory Maps, SAME lifetime as the
  // catalog cache below — an HMR restart resets them and completions outside
  // the window stay unpaired (documented honest degrade; no cross-apply
  // pairing). Shared by the dispatch recording (callId → dispatchRef via the
  // adapter), the post-execute settle listener (reads callId, writes the
  // background taskId) and the onTaskDone wiring (reads taskId).
  const pairing: AgentFlowPairing = {
    dispatchByCallId: new Map(),
    dispatchByTaskId: new Map(),
  }
  // The host-facing HostAdapter facade — the fs-intent / pre-execute gates
  // route through it (host hooks and in-plugin gates share ONE code path).
  // Constructed as a dsh service: `ctx.dshHostAdapter` is available to
  // inject consumers and host hooks after boot.
  const adapter = new DshHostAdapter(ctx, { resolver, config, pairing })

  // Agent-flow ledger — bind the `mstar/agent-flow` logger sink (record
  // failures and the settle-pairing trace log through it) and register the
  // `tools/post-execute` settle listener (plan `20260811-panel-f4-timeliness`
  // Task 1 — the seam IS emitted by the real registry, verified; foreground
  // dispatch calls settle here, background subagents settle via the
  // `ctx.tasks.onTaskDone` pairing wired below). The dispatch side records
  // unconditionally via `DshHostAdapter.dispatchGate` (+ the callId pairing).
  setAgentFlowLogger((level, message) => {
    const logger = ctx.logger(AGENT_FLOW_LOGGER)
    if (level === 'warn') logger.warn(message)
    else if (level === 'error') logger.error(message)
    else logger.info(message)
  })
  registerSettleListener(ctx, config, pairing)

  // Background-task settle pairing — the SECOND real completion seam: a
  // terminal task snapshot (completed/killed/failed) pairs via the registry
  // task id (stored by the post-execute background branch) to the dispatch
  // that started it → recordSettle (completed→ok / killed→denied /
  // failed→error; durationMs = finishedAt − startedAt when available).
  // Deferred with `ctx.inject(['tasks'], …)` — the SAME optional-unit
  // pattern as `registerMstarCommands`: cordis 4 service visibility requires
  // inject (a direct `ctx.tasks` access throws "cannot get property without
  // inject"), and the plugin must boot without the tasks service (a
  // composition without dsh-tasks keeps the ledger dispatch+settle for
  // foreground calls and leaves background tasks unpaired — honest degrade).
  // 'tasks' is deliberately NOT in the top-level `inject` (that would block
  // the whole plugin apply on the service). The child fiber's registrations
  // are effect-scoped and unwind with this apply.
  ctx.inject(['tasks'], (tasksCtx) => {
    // The dsh-tasks service is an OPTIONAL seam — the plugin deliberately
    // carries no runtime/type import of it (structural `TaskDoneSnapshot`
    // contract in agent-flow.ts), so the runtime `tasksCtx.tasks` is cast to
    // the ONE consumed surface: `onTaskDone(listener)` with the upstream
    // `TaskDoneListener = (snapshot, owner) => void | PromiseLike<void>`.
    const tasks = (tasksCtx as unknown as { tasks: { onTaskDone(listener: (snapshot: TaskDoneSnapshot, _owner: unknown) => void): unknown } }).tasks
    try {
      // Registration contained (qc2 F-004 fix-wave) for symmetry with the
      // rest of the seam wiring: the listener body itself is already
      // try/catch-contained (`recordTaskSettle`), but a THROWING registration
      // would surface as an unhandled child-fiber error at an arbitrary later
      // time (whenever the tasks service appears) — contained here instead
      // (a failed registration only degrades background settle pairing,
      // honestly: the child fiber still unwinds with this apply).
      tasks.onTaskDone((snapshot, _owner) => {
        recordTaskSettle(snapshot, pairing)
      })
    } catch (error) {
      ctx.logger(AGENT_FLOW_LOGGER).error(
        `tasks.onTaskDone registration failed (contained — background settle pairing degraded): ${(error as Error).message}`,
      )
    }
  })

  // Catalog-invalidation hook: the real harnessDir → cache-key reverse-map
  // closure is created + bound alongside the catalog cache below (Task 2 —
  // see the catalog section comment).

  // Bundled mstar commands — the omp/opencode slash-command parity surface
  // (iteration-start / iteration-drive / iteration-loop / codebase-audit),
  // registered from `harness-commands/` when the commands service exists.
  registerMstarCommands(ctx)

  // Skills mount — single canonical mount: register configured
  // skill roots with the dsh skill-local provider contract. The object form
  // mirrors the module shape the dsh Loader composes for the real
  // `@deepseek-ai/dsh-skill-local` package (`{ name, inject, Config, apply }`),
  // so `inject: ['skills']` defers the child fiber until `ctx.skills` exists
  // regardless of mount order. Dev-time the seam package is a peer stub (no
  // real runtime) — this call is the contract-typed registration; real-runtime
  // composition is verified at P3 e2e (README Known Limitations).
  const skillConfig = skillLocalConfig(config)
  if (skillConfig !== undefined) {
    ctx.plugin(
      { name: skillLocalName, inject: skillLocalInject, Config: SkillLocalSchema, apply: applySkillLocal },
      skillConfig,
    )
  }

  // Deploy-time observability: when enforcement resolves hard but
  // no dispatchBinding is declared, the anti-recursion red line is off by
  // construction — surface the absence instead of only documenting it.
  // (Boot-time the only known enforcement source is the explicit Config
  // override — compass hard is per-workspace and resolves at event time.)
  const effectiveHard = config.enforcement === 'hard' || (bootHarnessDir !== null && resolveCompassEnforcement(bootHarnessDir).hard)
  if (effectiveHard && (config.dispatchBinding ?? '').trim() === '') {
    ctx.logger(DISPATCH_LOGGER).warn(
      'Enforcement: hard is active but dispatchBinding is unset — the anti-recursion precheck is skipped (an Assignment whose Execute as equals the dispatching agent cannot be detected)',
    )
  }
  // Deploy-time observability: a renamed dsh subagent tool
  // (toolName) with dispatchTools unset silently disables BOTH the dispatch
  // gate and host detection — mirror the dispatchBinding warn so the absence
  // is surfaced instead of only documented.
  if (effectiveHard && config.dispatchTools === undefined) {
    ctx.logger(DISPATCH_LOGGER).warn(
      'Enforcement: hard is active but dispatchTools is unset — the dispatch gate matches the default tool name "subagent"; a deployment renaming the dsh subagent tool (toolName) without declaring dispatchTools silently disables the gate',
    )
  }

  // Status gate — fs intent slot (single-slot waterfall; prepend so this
  // decider runs before dsh-fs-policy regardless of mount order).
  ctx.on('fs/write-intent', (target, actor, next) => writeIntentListener(ctx, resolver, config, adapter, target, actor, next), { prepend: true })
  ctx.on('fs/edit-intent', (target, actor, next) => editIntentListener(ctx, resolver, config, adapter, target, actor, next), { prepend: true })

  // Skill-authoring lint gate — fs/write-intent slot scoped to SKILL.md
  // under the configured skill roots (same single-slot waterfall +
  // prepend + next() delegation contract as the status gate — this gate
  // also never throws except the intentional incoming-doc veto in
  // `lintSkillWrite`).
  ctx.on('fs/write-intent', (target, actor, next) => skillWriteIntentListener(ctx, resolver, config, target, actor, next), { prepend: true })

  // Artifact seam gates — fs/write-intent slots scoped per artifact
  // (design-md / audit / compound / roles; same envelope: warn advisory
  // default, hard-mode repair escape on the content-blind listener, typed
  // `SeamVetoError` on the known-document branch, degrade-to-allow). The
  // scopes are disjoint, so the four listeners never double-decide one
  // target.
  const seams: SeamId[] = ['design-md', 'audit', 'compound', 'roles']
  for (const seam of seams) {
    ctx.on('fs/write-intent', (target, actor, next) => seamWriteIntentListener(ctx, resolver, config, seam, target, actor, next), { prepend: true })
  }

  // Dispatch gate — tools/pre-execute waterfall (refusal channel:
  // PreToolDecision.deny returned without next()). Registered prepend for the
  // same reachability reason as the fs slots: an earlier-mounted
  // listener that returns a decision without next() would short-circuit the
  // chain and make this security gate unreachable — "a deny short-circuits
  // regardless of order" holds only once the listener is reached.
  ctx.on('tools/pre-execute', (exec, next) => preExecuteListener(ctx, resolver, config, adapter, exec, next), { prepend: true })

  // Engine-status catalog — advisory `agent/pre-step` waterfall listener
  // (agent catalog): calls `next()` (never vetoes or
  // replaces the delegated messages) and appends the ONE unified
  // `mstar-engine-status` catalog message to the composed step messages,
  // so the session log carries the engine status + iteration phase gate +
  // workspace-state digest (model-visible ⟺ logged).
  //
  // Watermark resolution: with an explicit `harnessDir` config one
  // app-wide cache entry is built ONCE at boot (the unified mstar version
  // is a process-immutable manifest read, compass enforcement is
  // boot-resolved like the gates, and the iteration gate is
  // boot-evaluated); without the config each workspace root gets its own
  // entry, built on its first pre-step. Every entry is then TTL-refreshed
  // (Config `catalogTtlMs`, default 60000): the pre-step hot path is a
  // timestamp compare + Map lookup between refreshes, and a mid-session
  // status/compass/residual change lands within one interval (see
  // catalogSourcesFor / buildCatalogSources).
  //
  // Digest-gated re-emission: per agent+workspace the row is injected once
  // per turn and re-injected only when its rendered text changed (a
  // 20-step turn shows the catalog once, not 20 times — see
  // preStepCatalogListener / agentDigestKey).
  const ttlMs = config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
  const explicitKey = bootHarnessDir !== null ? EXPLICIT_CACHE_KEY : undefined
  const catalogCache = new Map<string, CatalogCacheEntry>()
  if (explicitKey !== undefined) {
    catalogCache.set(explicitKey, { sources: buildCatalogSources(ctx, bootHarnessDir), builtAt: Date.now() })
  }
  // Catalog-invalidation hook (plan `20260811-panel-f4-timeliness` Task 2 —
  // decision D3): the apply-scoped `harnessDir → cache key` reverse map +
  // invalidation closure, created HERE with the same lifetime as the cache
  // above (an HMR fiber restart recreates both — module-level state would
  // survive and point at a destroyed cache). The explicit-config key is
  // pre-registered so a ledger record between apply and the first pre-step
  // still invalidates the boot-seeded entry; `catalogSourcesFor` registers
  // every other workspace's key on hit/build. Bound to the agent-flow
  // ledger hook (`setAgentFlowInvalidator`, Task 1 delivery): every
  // successful recordDispatch/recordSettle fires it with the affected
  // `{HARNESS_DIR}` → that workspace's entry is deleted → the next pre-step
  // rebuilds and (digest text change) re-injects the row — the 60s TTL no
  // longer bounds ledger-change latency (AC-2). No mapping → safe no-op; a
  // throwing invalidation is contained by the record path (log-only, never
  // blocks the ledger record).
  const catalogInvalidation = createCatalogInvalidation(catalogCache)
  if (explicitKey !== undefined) catalogInvalidation.register(bootHarnessDir, explicitKey)
  setAgentFlowInvalidator(catalogInvalidation.invalidate)
  // Per agent+workspace turn digests for the digest-gated re-emission
  // (inject once per turn; re-inject only when the row changed).
  const catalogDigests = new Map<string, TurnDigest>()
  ctx.on('agent/pre-step', (payload, next) =>
    preStepCatalogListener(ctx, resolver, explicitKey, catalogCache, ttlMs, catalogInvalidation.register, catalogDigests, payload, next))

  // v2 seams — sdd + iteration model-facing tools: `mstar sdd …` / `mstar iteration gate` equivalents on `ctx.tools`.
  registerSddIterationTools(ctx, resolver)

  // Seam tools — on-demand `mstar_*_validate` equivalents
  // (design-md / audit / compound / roles).
  registerSeamTools(ctx, resolver)
}
