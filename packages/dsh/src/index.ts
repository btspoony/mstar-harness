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

// Re-export the service type from the package entry: the cordis
// `Context` augmentation (`ctx.dshMstar`) lives in service.d.ts, so the entry
// must reference it for consumers importing `@mstar-harness/dsh` to see a
// typed `ctx.dshMstar`.
export { DshMstar } from './service.ts'
export type { DshMstarOptions } from './service.ts'
export type { MstarEngineStatusSource, MstarHarnessState, MstarIterationGateView } from './types.ts'
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

/** Frontmatter field value of one command markdown (`name`/`description`/`agent`). */
function commandFrontmatterField(frontmatter: string, label: string): string | undefined {
  const match = new RegExp(`^${label}[ \\t]*:[ \\t]*(.+)$`, 'm').exec(frontmatter)
  return match?.[1]?.trim()
}

/**
 * Parse one bundled mstar command markdown (`harness-commands/<name>.md`):
 * the `---` frontmatter block yields `name` + `description` (registration
 * metadata); the body is the command content the handler steers into the
 * receiving agent. Returns undefined for files without a parseable block.
 */
function parseCommandMarkdown(content: string): { name: string; description: string; body: string } | undefined {
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
  return { name, description, body: lines.slice(end + 1).join('\n').trim() }
}

/**
 * Register the bundled mstar commands (`harness-commands/*.md`, synced from
 * the repo root by `bundle-assets`; gitignored) on `ctx.commands` — the
 * omp/opencode slash-command parity surface (`/iteration-start`,
 * `/iteration-drive`, `/iteration-loop`, `/codebase-audit`). Each command
 * handler steers the command body into the receiving agent as a user message
 * (the dsh-commands "explicitly schedule model-visible work through the
 * receiving Agent" path), returning a success result. The registration is
 * deferred with `ctx.inject(['commands'], …)` — the same optional-unit
 * pattern as the tools — so the plugin boots without the commands service.
 * Absent mirror (no `bundle-assets` run) → no registrations.
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
        handler: (invocation: CommandInvocation) => {
          // The command body is delivered to the model as a USER message —
          // the dsh-plan-mode /permission command precedent (`source:
          // { kind: 'user' }`). A plugin-source message reads as injected
          // context (trajectory UI labels it "Plugin · …"), and the model
          // treats it as system-provided context rather than a task to
          // execute; a user-source message is what makes the model act on
          // the mstar command body.
          const message = createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: parsed.body }],
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
  // The host-facing HostAdapter facade — the fs-intent / pre-execute gates
  // route through it (host hooks and in-plugin gates share ONE code path).
  // Constructed as a dsh service: `ctx.dshHostAdapter` is available to
  // inject consumers and host hooks after boot.
  const adapter = new DshHostAdapter(ctx, { resolver, config })

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
  // Per agent+workspace turn digests for the digest-gated re-emission
  // (inject once per turn; re-inject only when the row changed).
  const catalogDigests = new Map<string, TurnDigest>()
  ctx.on('agent/pre-step', (payload, next) =>
    preStepCatalogListener(ctx, resolver, explicitKey, catalogCache, ttlMs, catalogDigests, payload, next))

  // v2 seams — sdd + iteration model-facing tools: `mstar sdd …` / `mstar iteration gate` equivalents on `ctx.tools`.
  registerSddIterationTools(ctx, resolver)

  // Seam tools — on-demand `mstar_*_validate` equivalents
  // (design-md / audit / compound / roles).
  registerSeamTools(ctx, resolver)
}
