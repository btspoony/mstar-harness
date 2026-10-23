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
import { type Context } from '@deepseek-ai/cordis'
import {
  apply as applySkillLocal,
  Config as SkillLocalSchema,
  inject as skillLocalInject,
  name as skillLocalName,
} from '@deepseek-ai/dsh-skill-filesystem'
import { resolveRepoEnforcement } from '@mstar-harness/engine'
// Type-only: loads the `ctx.commands` cordis augmentation + the command
// handler invocation shape from the (peer-stub / real) dsh-commands seam —
// the runtime registration goes through `ctx.inject(['commands'], …)`.
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DshMstar } from './service.ts'
import {
  Config,
  HarnessResolver,
  packagedAgentsDir,
  skillLocalConfig,
} from './gates/_shared.ts'
import {
  preStepCatalogListener,
  createCatalogInvalidation,
  DEFAULT_CATALOG_TTL_MS,
  readCatalogPayload,
  selectionHintFor,
} from './gates/catalog.ts'
import type { CatalogCacheEntry, EmissionDigest } from './gates/catalog.ts'
import { installEngineStatusEndpoint } from './engine-status-endpoint.ts'
import { installPanelSnapshotEndpoint } from './panel/panel-snapshot-endpoint.ts'
import { writeIntentListener, editIntentListener } from './gates/status.ts'
import type { StatusGateAdvisory } from './gates/status.ts'
import { skillWriteIntentListener } from './gates/skill-lint.ts'
import type { SkillLintAdvisory } from './gates/skill-lint.ts'
import { seamWriteIntentListener } from './gates/seams.ts'
import type { SeamId, SeamLintAdvisory } from './gates/seams.ts'
import { registerNativeCommandTools } from './gates/native-commands.ts'
import { leafSeatToolListener } from './gates/leaf-seat.ts'
import { DshHostAdapter } from './gates/adapter.ts'
import type { DshHostAdapterOptions } from './gates/adapter.ts'
import { resolveExecutionLedgerTarget } from './gates/workflow-selection.ts'
import {
  preExecuteListener,
  DISPATCH_LOGGER,
} from './gates/dispatch.ts'
import type { DispatchGateAdvisory } from './gates/dispatch.ts'
import {
  AGENT_FLOW_LOGGER,
  registerSettleListener,
  registerSubagentCatalogListener,
  recordJobSettle,
  setAgentFlowInvalidator,
  setAgentFlowLogger,
} from './gates/agent-flow.ts'
import type { AgentFlowPairing, JobDoneSnapshot } from './gates/agent-flow.ts'
import {
  ROLE_PERSONA_LOGGER,
  probeRolePersonaSeam,
  registerRolePersonaChannel,
  setRolePersonaLogger,
} from './gates/role-persona.ts'
import {
  WORKFLOW_LEDGER_LOGGER,
  registerWorkflowLedger,
  setWorkflowLedgerLogger,
} from './gates/workflow-ledger.ts'
import {
  GOAL_BRIDGE_LOGGER,
  registerGoalBridge,
  setGoalBridgeLogger,
} from './gates/goal-bridge.ts'
import {
  PLAN_MODE_BRIDGE_LOGGER,
  registerPlanModeBridge,
  setPlanModeBridgeLogger,
} from './gates/plan-mode-bridge.ts'
import {
  ADVISORY_LOGGER,
  resetAdvisoryAbortWarn,
  runFallbacksAdvisory,
  setAdvisoryLogger,
} from './gates/fallbacks-advisory.ts'
import {
  SEEDS_LOGGER,
  declareMstarSeeds,
} from './gates/fallbacks-seeds.ts'
import { fallbacksMounted, fallbacksService } from './gates/fallbacks-probe.ts'
import {
  HARNESS_PROMPT_LOGGER,
  registerHarnessPrompt,
  setHarnessPromptLogger,
} from './gates/system-prompt.ts'
import {
  EXECUTION_BINDING_ROOTS_LOGGER,
  beginExecutionBindingRootStoreOpening,
  endExecutionBindingRootStoreOpening,
  executionBindingRootsDomain,
  executionBindingRootStoreOf,
  installExecutionBindingRootStore,
  setExecutionBindingRootsLogger,
} from './gates/execution-binding-roots-domain.ts'
import { warnExecutionBindingRootStoreUnavailable } from './gates/execution-binding-roots.ts'

// Re-export the service type from the package entry: the cordis
// `Context` augmentation (`ctx.dshMstar`) lives in service.d.ts, so the entry
// must reference it for consumers importing `@mstar-harness/dsh` to see a
// typed `ctx.dshMstar`.
export { DshMstar } from './service.ts'
export type { DshMstarOptions } from './service.ts'
export type {
  MstarEngineStatusSource,
  MstarEngineStatusPayload,
  MstarHarnessState,
  MstarIterationGateView,
  AgentFlowEventView,
  AgentFlowSummaryRow,
  AgentFlowView,
  WorkflowSelectionView,
} from './types.ts'
export {
  SETTLE_SEAM,
  readAgentFlow,
  recordDispatch,
  recordSettle,
  recordWorkflowVerdict,
} from './gates/agent-flow.ts'
export type {
  AgentFlowEvent,
  DispatchVerdict,
  SettleOutcome,
  WorkflowGateMode,
  WorkflowVerdict,
  WorkflowVerdictInput,
} from './gates/agent-flow.ts'
export { Config, HarnessResolver, skillLocalConfig } from './gates/_shared.ts'
export type { StatusGateAdvisory } from './gates/status.ts'
export { SkillLintVetoError, lintSkillDoc, lintSkillWrite } from './gates/skill-lint.ts'
export type { SkillLintAdvisory } from './gates/skill-lint.ts'
export { SeamVetoError, lintSeamWrite, lintDesignMdWrite, lintAuditWrite, lintCompoundWrite, lintRolesWrite } from './gates/seams.ts'
export type { SeamId, SeamLintAdvisory } from './gates/seams.ts'
export type { DispatchGateAdvisory } from './gates/dispatch.ts'
export {
  ROLE_PERSONA_LOGGER,
  registerRolePersonaChannel,
  setRolePersonaLogger,
} from './gates/role-persona.ts'
export type { RolePersonaLogLevel, RolePersonaLogSink, SubagentActivationSpecView, SubagentStartRequestView, SubagentsServiceView } from './gates/role-persona.ts'
export { ADVISORY_LOGGER, runFallbacksAdvisory, setAdvisoryLogger } from './gates/fallbacks-advisory.ts'
export type { AdvisoryLogLevel, AdvisoryLogSink, AdvisoryPassReport } from './gates/fallbacks-advisory.ts'
export { DshHostAdapter } from './gates/adapter.ts'
export type { DshHostAdapterOptions } from './gates/adapter.ts'

/** Cordis function-plugin name registered by the Loader. */
export const name = 'dsh'

/**
 * Services required before this plugin's `apply` fiber starts.
 * `loader` — the dsh profile loader's entry tree — is guaranteed before
 * apply (the plugin row is composed BY the loader), so the Task 1 probe can
 * read `ctx.loader.entries()` at decision points (plugin-inventory
 * precedent; no runtime dependency on `@deepseek-ai/cordis-plugin-loader`).
 */
export const inject: string[] = ['loader']

declare module '@deepseek-ai/cordis' {
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
     * review reports under `{REVIEW_DIR}`, knowledge docs under
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
 * root by `bundle-assets` at build time; gitignored). Package-relative
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

/** The bundled-commands logger (the `mstar/<topic>` logger-name convention). */
const COMMANDS_LOGGER = 'mstar/commands'

/** Static value shape after a frontmatter label: `[ \t]*` spaces, colon, non-empty value. */
const FRONTMATTER_FIELD_RE = /^[ \t]*:[ \t]*(.+)$/

/**
 * Frontmatter field value of one command markdown
 * (`name`/`description`/`agent`/`input`). Line-based scan — labels are
 * matched literally and the value shape via a static regex, so no pattern is
 * assembled from caller-supplied strings. First matching line wins.
 */
function commandFrontmatterField(frontmatter: string, label: string): string | undefined {
  for (const line of frontmatter.split('\n')) {
    if (!line.startsWith(label)) continue
    const match = FRONTMATTER_FIELD_RE.exec(line.slice(label.length))
    if (match) return match[1].trim()
  }
  return undefined
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
 * commands service. Absent mirror (no `bundle-assets` run) → no registrations
 * and an ERROR log naming the missing mirror path plus the recovery
 * (`bun run dsh:bundle-assets`) — a silent boot must not mask the lost
 * slash-command surface.
 * @param ctx - registrant context carrying the commands service.
 */
function registerMstarCommands(ctx: Context): void {
  const dir = packagedCommandsDir()
  if (dir === undefined) {
    // Fail loud: resolve the EXPECTED package-relative mirror path for the
    // message (the absent dir carries no path of its own), then emit at
    // error level so a missing bundle is visible in the boot log.
    const expected = fileURLToPath(new URL('../harness-commands', import.meta.url))
    ctx.logger(COMMANDS_LOGGER).error(
      `mstar bundled commands not registered: the packaged 'harness-commands/' mirror is missing (expected ${expected}); run \`bun run dsh:bundle-assets\` in packages/dsh to sync it, then rebuild/reload the plugin`,
    )
    return
  }
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

/** One-line cause of a refused optional unit: the host error's stable `code` when it carries one. */
function causeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' ? `${code}: ${message}` : message
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
  // workspace root. Repos whose harness root is not one of the probed
  // names (`.mstar/` → `.agents/` → `.plans/`/`plans/`) declare
  // `config.harnessDir`, which wins outright.
  const resolver = new HarnessResolver(config.harnessDir)
  const bootHarnessDir = resolver.forWorkspace(undefined)
  // The Service constructor registers itself on the fiber via reflect.provide,
  // so construction alone exposes `ctx.dshMstar` (dsh service convention).
  new DshMstar(ctx, { harnessDir: bootHarnessDir })
  // Agent-flow settle pairing store : apply-scoped in-memory Maps, SAME lifetime as the
  // catalog cache below — an HMR restart resets them and completions outside
  // the window stay unpaired (documented honest degrade; no cross-apply
  // pairing). Shared by the dispatch recording (callId → dispatchRef via the
  // background jobId) and the jobs `settled` event subscription (reads jobId).
  // `catalogBySession` slot map carries the call-window child-identity join
  // (raw label → candidate, keyed by the live parent Session object) through
  // the same lifetime: a catalog outside the apply window joins nothing.
  const pairing: AgentFlowPairing = {
    dispatchByCallId: new Map(),
    dispatchByJobId: new Map(),
    // Team member child SessionId → the `spawn_teammate` dispatch that created
    // it, consumed by the member's `subagent/end` settlement (the tool return
    // is NOT a completion). Bounded by the agent-flow module.
    teamDispatchByChildId: new Map(),
    catalogBySession: new WeakMap(),
  }
  // The host-facing HostAdapter facade — the fs-intent / pre-execute gates
  // route through it (host hooks and in-plugin gates share ONE code path).
  // Constructed as a dsh service: `ctx.dshHostAdapter` is available to
  // inject consumers and host hooks after boot.
  const adapter = new DshHostAdapter(ctx, { resolver, config, pairing })

  // Agent-flow ledger — bind the `mstar/agent-flow` logger sink (record
  // failures and the settle-pairing trace log through it) and register the
  // `tools/post-execute` settle listener . The dispatch side records
  // unconditionally via `DshHostAdapter.dispatchGate` (+ the callId pairing).
  setAgentFlowLogger((level, message) => {
    const logger = ctx.logger(AGENT_FLOW_LOGGER)
    if (level === 'warn') logger.warn(message)
    else if (level === 'error') logger.error(message)
    else logger.info(message)
  })
  // Role-persona logger sink.
  setRolePersonaLogger((level, message) => {
    const logger = ctx.logger(ROLE_PERSONA_LOGGER)
    if (level === 'debug') logger.debug(message)
    else logger.warn(message)
  })
  // Harness-rules system-prompt injection (plan  
  // the global-layer `mstar:harness-rules` pointer section + the
  // `mstar:engine-status` runtime-context summary (visible to the root
  // session AND dispatched children; child identity rides the native
  // subagent preset channel — mstar owns no child-scoped section).
  // The module sink is bound to the dsh logger (module-sink pattern); the
  // registration itself is optional-unit — a composition without
  // dsh-system-prompt keeps boot unaffected (one debug log,
  // `registerHarnessPrompt` returns false).
  setHarnessPromptLogger((level, message) => {
    const logger = ctx.logger(HARNESS_PROMPT_LOGGER)
    if (level === 'debug') logger.debug(message)
    else logger.warn(message)
  })
  // The catalog row's watermark FALLBACK tracks CONFIRMED LIVE registration,
  // never the scheduling verdict: `registerHarnessPrompt` returning `true`
  // only means its async inject child was scheduled — that child's
  // `section`/`context`/provider can still fail (contained) or its
  // registration can later be disposed (service removal / HMR), and in both
  // cases nothing carries the version / harness dir / enforcement facts.
  // Count LANDED registrations instead: 0 live registrations ⇒ the row is
  // the only channel for the watermark trio and re-renders it itself.
  // A counter rather than a boolean keeps the state correct under a
  // re-apply/teardown overlap: each landed registration adds one and its own
  // disposer removes one, whatever order the two fibers settle in.
  let harnessPromptRegistrationsActive = 0
  registerHarnessPrompt(ctx, {
    resolver,
    onRegistered: () => {
      harnessPromptRegistrationsActive += 1
    },
    onDisposed: () => {
      if (harnessPromptRegistrationsActive > 0) harnessPromptRegistrationsActive -= 1
    },
  })
  // Adoption advisory  — the warn-only deployment-taxonomy
  // pass: when fallbacks is mounted, ONE pass per apply reports the adoption
  // state (seeded / persona-overridden / missing + revert affordance via the
  // effective readback; the structural roles.list read on the loader-
  // fallback path). Never writes the fallbacks config; unreadable config →
  // skip + one debug. With the service present the pass is ASYNC — it awaits
  // the idempotent re-declare before the readback; the latch arms ONLY when
  // the pass reports it ran AND converged (`AdvisoryPassReport`) — an
  // aborted pass (e.g. a rejected re-declare) must never suppress the
  // `subagent/start` decision-point retry.
  setAdvisoryLogger((level, message) => {
    const logger = ctx.logger(ADVISORY_LOGGER)
    if (level === 'debug') logger.debug(message)
    else logger.warn(message)
  })
  // Degraded-abort warn budget: at most ONE advisory abort warn per apply
  // (module-level dedup in the advisory) — this apply opens the budget; the
  // seeds inject child's teardown below re-opens it on a fiber swap.
  // Accepted dispositions (plan QC wave 1):
  // - The dedup flag is PROCESS-WIDE module state (the same module-sink
  //   pattern as `setAdvisoryLogger`), not per-context: concurrently
  //   composed contexts in one process share the one-warn budget, so the
  //   worst case is one suppressed diagnostic warn under concurrent
  //   multi-context composition (production composes a single app).
  // - A decision point landing inside the boot-retry window below (~300 ms)
  //   can consume the budget on an ULTIMATELY-HEALTHY boot: its pass awaits
  //   the re-declare, the transient reject aborts it, one degraded warn
  //   fires — bounded (≤1/apply) and self-healing (the next decision point
  //   re-runs the pass and converges).
  resetAdvisoryAbortWarn()
  // One-shot latch: the pass is attempted at apply (profiles that declare
  // the fallbacks row before dsh) and — when unmounted at boot — at the
  // first `subagent/start` decision point (the loader mounts entries
  // concurrently; the same decision-point probe pattern as the persona
  // channel's service-read interception).
  // The latch is RE-ARMED when the `llm-fallbacks` service disappears (the
  // seeds inject child below returns a teardown resetting it): after an HMR
  // fiber swap the fresh seed registry needs a new decision-point pass to
    // re-converge.
  let advisoryPassed = false
  // In-flight guard : the service-present pass
  // is async, so a burst of decision points inside its settle window must
  // not re-enter the pass (each re-entry would duplicate every warn).
  let advisoryPassInFlight = false
  // Pass-generation guard (PR #97 finding 1 — advisory latch race after
  // HMR): the async pass can outlive the `llm-fallbacks` inject teardown
  // (a fiber swap while the pass is in flight). The teardown bumps the
  // generation; a stale completion only arms the latch when its generation
  // is still current — otherwise the NEXT decision point re-runs the pass
  // and the HMR re-convergence is not lost.
  let advisoryGeneration = 0
  const runAdvisoryPass = (): void => {
    if (advisoryPassed || advisoryPassInFlight) return
    advisoryPassInFlight = true
    const generation = advisoryGeneration
    void runFallbacksAdvisory(ctx, packagedAgentsDir())
      .then((report) => {
        // Honest latch: arm only on a pass that RAN and CONVERGED. An
        // aborted pass (e.g. a rejected re-declare) reports
        // `{ ran: true, converged: false }` and must leave the latch open —
        // the next decision point re-runs the pass (R2: the old boolean
        // contract reported a rejected re-declare as ran → armed).
        if (report.ran && report.converged && generation === advisoryGeneration) advisoryPassed = true
      })
      .finally(() => {
        advisoryPassInFlight = false
      })
  }
  runAdvisoryPass()

  // Mstar role seeds : zero-config
  // declaration of the 13 `mode: subagent` roles into the fallbacks seed
  // registry. The seed registry is an upstream per-apply in-memory state
  // (the `FallbacksSeedManager` is constructed inside the fallbacks
  // `apply()`; a fiber dispose drops it), so the upstream companion
  // contract is "re-declare at your own apply/mount" — this conditional
  // child (`ctx.inject(['llm-fallbacks'])`) fires when the service appears
  // and RE-FIRES on every re-apply (HMR / fiber swap): no one-shot latch.
  // Unmounted at apply → the child stays inactive and fires on a later
  // fallbacks apply; one debug log documents the armed state. The declare
  // is fire-and-forget with a BOUNDED retry: the provider swaps its seed
  // write channel in one macrotask after its apply, so the immediate
  // declare can lose that settings-binding race and reject with the
  // upstream "settings service is unavailable" string. Attempt 1 fires
  // immediately; a rejected attempt schedules the next one at +50 ms /
  // +250 ms (3 attempts total, fixed delays, no jitter); a resolved attempt
  // stops the loop. The timers are plain `setTimeout` handles owned by this
  // child closure (`fallbacks-seeds.ts` stays timer-free) and cleared by
  // the teardown disposer below; a stale attempt firing after teardown is
  // a silent no-op. Intermediate failures log one debug each; when every
  // attempt failed, the terminal `.catch` (the upstream preset self-declare
  // pattern) logs ONE error — declare never throws out of apply.
  if (!fallbacksMounted(ctx)) {
    ctx.logger(SEEDS_LOGGER).debug('fallbacks not mounted at apply — mstar seeds inject child armed; declare fires when the llm-fallbacks service appears (apply/HMR)')
  }
  ctx.inject(['llm-fallbacks'], (serviceCtx) => {
    const service = fallbacksService(serviceCtx)
    if (service === undefined) return
    // Bounded retry state — owned by THIS child closure (module purity:
    // `fallbacks-seeds.ts` never sees a timer). The teardown disposer below
    // sets `disposed` and clears every pending handle; a late-firing
    // attempt after that is a silent no-op (never a post-dispose declare
    // or log).
    // Per-attempt diagnostics are intentional (accepted disposition, plan QC
    // wave 1): every retry re-runs the full batch assembly, so
    // `declareMstarSeeds`'s internal warn lines (a failing readback,
    // interpolation-hazard skips) may re-emit up to once per attempt in the
    // failure window. Dedupe is deliberately REJECTED — per-attempt
    // observability is what keeps the transient-failure window legible; the
    // exactly-once bound covers only the terminal ERROR below.
    let disposed = false
    const retryTimers: ReturnType<typeof setTimeout>[] = []
    const declareAttempt = (attempt: number): void => {
      declareMstarSeeds(service, {
        agentsDir: packagedAgentsDir(),
        log: (level, message) => {
          const logger = ctx.logger(SEEDS_LOGGER)
          if (level === 'warn') logger.warn(message)
          else if (level === 'error') logger.error(message)
          else logger.debug(message)
        },
      }).catch((error) => {
        if (disposed) return
        // Non-Error rejections (string/plain object — plausible from a
        // settings seam) must not log `undefined`; align with the upstream
        // preset child's `error?.message ?? String(error)`.
        const message = error instanceof Error ? error.message : String(error)
        if (attempt >= 3) {
          ctx.logger(SEEDS_LOGGER).error(`mstar seeds declaration failed (contained — fallbacks taxonomy unchanged): ${message}`)
          return
        }
        ctx.logger(SEEDS_LOGGER).debug(`seeds declare attempt ${attempt}/3 failed: ${message}`)
        retryTimers.push(setTimeout(() => {
          if (!disposed) declareAttempt(attempt + 1)
        }, attempt === 1 ? 50 : 250))
      })
    }
    declareAttempt(1)
    // HMR/fiber-swap re-arm : when
    // the fallbacks service disappears, reset the advisory one-shot latch so
    // the NEXT decision point re-converges the seeds state. The seed registry
    // is per-apply in-memory state and a fiber swap drops it; without the
    // reset, `advisoryPassed` would stay armed from the pre-swap pass and the
    // re-declare convergence would never run again. The generation bump also
    // invalidates any pass still in flight from BEFORE the swap — its stale
    // completion must not re-arm the latch (see `runAdvisoryPass`).
    return () => {
      disposed = true
      for (const timer of retryTimers) clearTimeout(timer)
      advisoryPassed = false
      advisoryGeneration += 1
      // A fiber swap re-opens the advisory's degraded-abort warn budget (the
      // re-applied fiber is a fresh apply) alongside the latch reset above.
      resetAdvisoryAbortWarn()
    }
  })
  registerSettleListener(ctx, config, pairing)
  // Subagent-catalog join (live half): ONE root-context `session/event`
  // observer registered here — before any execution can start — that joins a
  // parent-owned `subagent/catalog` (the child session identity upstream
  // publishes) back to the dispatch ref its pre-execute reserved the label
  // for, appending a nonterminal `subagent-link` row. The catch-up half runs
  // at each dispatch's post-execute eligibility; neither half scans history,
  // so a catalog predating this apply joins nothing (honest, apply-scoped —
  // the same boundary as the pairing store it reads). Contained: a throwing
  // observation degrades to a log line and never affects the session append.
  registerSubagentCatalogListener(ctx, pairing)

  // Workflow-ledger session-event consumer : a cold scan over `ctx.sessions.list()`
  // at apply (durable `tool-workflow/*` rows already in each session's events
  // snapshot — constructor-seeded events never hit the firehose) plus a live
  // `session/event` firehose listener, both appending through
  // `recordWorkflowEvent` (fully try/catch-contained). The dsh-session seam
  // is STRUCTURAL (`ctx.get('sessions')` — the package is not a dependency);
  // an absent service degrades to one debug log with the consumer disabled.
  // Observe-only: a failing ledger write never crashes or alters a workflow
  // The consumer also carries the P-c answer observation (plan
  //   Task 4 fold-in — the Task-2 Important
  // handoff): a recorded run-start means the approval waterfall allowed the
  // call, so the run's name is cached `allow` in the adapter's apply-scoped
  // `workflowAskCache` — a later same-name call under `ask` reuses the
  // decision without re-asking. The observation
  // promotes ONLY names the policy marked asked this apply (`markAsked` on
  // every ask verdict) — a run observed without a prior ask (P-b advisory
  // under ask mode, warn/off runs) never pre-authorizes the name. Bounded +
  // contained (see workflow-ledger.ts).
  setWorkflowLedgerLogger((level, message) => {
    const logger = ctx.logger(WORKFLOW_LEDGER_LOGGER)
    if (level === 'warn') logger.warn(message)
    else logger.debug(message)
  })
  registerWorkflowLedger(ctx, resolver, adapter.workflowAskCache, resolveExecutionLedgerTarget)

  // Goal bridge : observe-only blocked-goal advisory — ONE
  // `session/event` firehose listener (a `goal/change` envelope whose goal is
  // blocked logs ONE warn with the block code, a bounded objective summary and
  // the project-register residual pointer). The module sink is bound to the
  // dsh logger (agent-flow ledger precedent). mstar NEVER writes dsh goal
  // state — no `create` / `edit` / `complete` / `pause` / `resume` — so the
  // plugin can never re-arm a goal an operator paused; the bridge writes
  // nothing at all (`{HARNESS_DIR}` / status.json stay SSOT).
  setGoalBridgeLogger((level, message) => {
    const logger = ctx.logger(GOAL_BRIDGE_LOGGER)
    if (level === 'debug') logger.debug(message)
    else logger.warn(message)
  })
  registerGoalBridge(ctx, resolver)

  // PlanMode bridge :
  // the Prepare-phase flag flip — a one-way mirror of the harness Prepare
  // state (active steering compass + ≥1 plan row `Todo` in status.json)
  // into the host plan-mode session state (`ctx.get('planMode')` structural
  // read — no peer dependency). The module sink is bound to the dsh logger
  // (goal-bridge precedent); the registration is optional-unit: the planMode
  // service absent → ONE debug log + boot unaffected. `set` is idempotent
  // (`'noop'` — repeated evaluation at the session-start + `subagent/start`
  // decision points never churns `plan/mode` events). The bridge never
  // writes harness state (`{HARNESS_DIR}` / status.json stay SSOT — one-way
  // mirror, plan Global Constraints).
  setPlanModeBridgeLogger((level, message) => {
    const logger = ctx.logger(PLAN_MODE_BRIDGE_LOGGER)
    if (level === 'debug') logger.debug(message)
    else logger.warn(message)
  })
  registerPlanModeBridge(ctx, resolver)

  // Background-job settle pairing listens to the exported jobs lifecycle event
  // stream. `settled` carries the registry job id and terminal projection.
  // Deferred injection keeps the jobs service optional: without it, foreground
  // settle pairing still works and background jobs remain honestly unpaired.
  ctx.inject(['jobs'], (jobsCtx) => {
    const jobs = (jobsCtx as unknown as {
      jobs: {
        events: {
          subscribe(
            filter: { owners: 'scope' },
            listener: (event:
              | { type: 'settled'; job: JobDoneSnapshot }
              | { type: 'registered' | 'progress' | 'stopping' | 'removed' | 'output' }) => void,
          ): unknown
        }
      }
    }).jobs
    try {
      return jobs.events.subscribe({ owners: 'scope' }, (event) => {
        if (event.type === 'settled') recordJobSettle(event.job, pairing)
      })
    } catch (error) {
      ctx.logger(AGENT_FLOW_LOGGER).error(
        `jobs.events.subscribe registration failed (background settle pairing degraded): ${(error as Error).message}`,
      )
    }
  })

  // Catalog-invalidation hook: the real harnessDir → cache-key reverse-map
  // closure is created + bound alongside the catalog cache below (see the catalog section comment).

  // Bundled mstar commands — the omp/opencode slash-command parity surface
  // (iteration-start / iteration-drive / iteration-loop / codebase-audit),
  // registered from `harness-commands/` when the commands service exists.
  registerMstarCommands(ctx)

  // Skills mount — single canonical mount: register configured
  // skill roots with the dsh skill-filesystem provider contract. The object form
  // mirrors the module shape the dsh Loader composes for the real
  // `@deepseek-ai/dsh-skill-filesystem` package (`{ name, inject, Config, apply }`),
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
  // no dispatchBinding is declared, the anti-recursion red line FAILS
  // CLOSED — every Assignment-shaped dispatch emits
  // `dispatch.anti-recursion.empty-binding` (critical) until
  // dispatchBinding is set — surface the absence instead of only
  // documenting it. (Boot-time the only known enforcement source is the
  // explicit Config override — compass hard is per-workspace and resolves
  // at event time.)
  const effectiveHard = config.enforcement === 'hard' || (bootHarnessDir !== null && resolveRepoEnforcement(bootHarnessDir).hard)
  if (effectiveHard && (config.dispatchBinding ?? '').trim() === '') {
    ctx.logger(DISPATCH_LOGGER).warn(
      'Enforcement: hard is active but dispatchBinding is unset — the empty host binding fails closed: every Assignment-shaped dispatch emits dispatch.anti-recursion.empty-binding (critical) until dispatchBinding is set',
    )
  }
  // Deploy-time observability: a renamed dsh subagent tool
  // (toolName) with dispatchTools unset silently disables BOTH the dispatch
  // gate and host detection — mirror the dispatchBinding warn so the absence
  // is surfaced instead of only documented.
  if (effectiveHard && config.dispatchTools === undefined) {
    ctx.logger(DISPATCH_LOGGER).warn(
      'Enforcement: hard is active but dispatchTools is unset — the dispatch gate matches the default tool names "subagent" and "subagent_fork"; a deployment renaming either dsh subagent tool (toolName) without declaring dispatchTools silently disables the gate',
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

  // Leaf-seat tool boundary — the folded MCP surface's coordinator actions
  // (`plan.bind`, `plan.complete`, `session.recover`) refused for a known leaf
  // seat before the MCP client child executes, on every connection INCLUDING
  // the profile-wide generic `mstar-mcp` row: that row is launched from the
  // bundle patch and carries no `--seat`, so the server-side restriction cannot
  // cover it and this host boundary is what refuses the seat.
  // Same refusal channel and prepend reachability argument as the gate above.
  ctx.on('tools/pre-execute', (exec, next) => leafSeatToolListener(exec, next), { prepend: true })

  // Role → agent preset channel: an `internal/get`
  // waterfall listener wraps `ctx.subagents` reads so a role-matched
  // `startActivation` — the single start surface in dsh 0.2.1 — selects the
  // preset the deployment declared for that role
  // (`@deepseek-ai/dsh-subagent` `SubagentStartRequest.agentPreset`). dsh
  // mounts that preset as the child's composition (persona through
  // `@deepseek-ai/dsh-persona`, tools, skills) and replays the selection on
  // resume: the old native `persona` slot is GONE in 0.2.1, so the preset is
  // the upstream way to give a delegated child its role identity. The
  // underlying `SubagentRuntime` object is never mutated; the listener is
  // owned by this fiber (HMR-safe). Selection is capability-gated and
  // fallbacks-independent — see `role-persona.ts`.
  registerRolePersonaChannel(ctx, config)
  // Seam probe (observation only, ONCE per apply — see `probeRolePersonaSeam`):
  // a cordis `internal/get` rename/removal would leave the channel registered
  // but never dispatched (persona delivery silently gone). The probe performs
  // ONE controlled proxied read through a transient canary and fails LOUD —
  // ONE warn when the channel is not installed (`ok === false`); an
  // unresolved subagents service and any probe-internal error stay `ok` with
  // one debug (fail-open; apply and subagent starts are never affected).
  probeRolePersonaSeam(ctx)

  // Adoption-advisory decision point — `subagent/start` emit (listener narrowed to the advisory only): the loader has settled by the first dispatch, so
  // an advisory skipped at apply (fallbacks row mounted after dsh) runs its
  // ONE pass here instead — never more than once per apply. The payload is
  // not consumed (persona delivery no longer rides this seam).
  ctx.events.on('subagent/start', () => {
    runAdvisoryPass()
  })

  // Engine-status catalog — advisory `agent/pre-step` waterfall listener
  // (agent catalog): calls `next()` (never vetoes or
  // replaces the delegated messages) and appends the ONE unified
  // `mstar-engine` catalog message to the composed step messages,
  // so the session log carries the engine status + iteration phase gate +
  // workspace-state digest (model-visible ⟺ logged).
  //
  // Per-SESSION catalog identity (D4): every session's payload is keyed by
  // harness dir + `session.header.id` + cwd + its effective selection hint,
  // built on first use and TTL-refreshed (Config `catalogTtlMs`, default
  // 60000): the pre-step hot path is a timestamp compare + Map lookup between
  // refreshes, and a mid-session status/compass/residual change lands within
  // one interval (see catalogPayloadFor / buildCatalogPayload). No boot-seeded
  // shared entry exists any more — two sessions in one workspace (even the
  // same cwd) can never be served each other's selection; a session with no
  // stable id is built uncached.
  //
  // Change-driven re-emission (D2): per session+workspace the row is appended
  // on first emission, when its rendered text changed, or when the
  // panel-relevant payload projection changed — never solely because a new
  // turn started (see preStepCatalogListener / panelDigestOf / agentDigestKey).
  const ttlMs = config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
  const catalogCache = new Map<string, CatalogCacheEntry>()
  // Per session+workspace emission digests (last rendered text + panel
  // projection) for the change-driven re-emission.
  const catalogDigests = new Map<string, EmissionDigest>()
  // Catalog-invalidation hook : the apply-scoped session-keyed reverse map +
  // invalidation closure, created HERE with the same lifetime as the cache
  // above (an HMR fiber restart recreates both — module-level state would
  // survive and point at a destroyed cache). `catalogPayloadFor` registers
  // each session's key on hit/build. Bound to the agent-flow ledger hook
  // (`setAgentFlowInvalidator`): every successful recordDispatch/recordSettle
  // fires it with the affected `{HARNESS_DIR}` → EVERY current session entry
  // of that workspace is deleted → the next pre-step rebuilds and (digest text
  // change) re-injects the row — the 60s TTL no longer bounds ledger-change
  // latency (AC-2). No mapping → safe no-op; a throwing invalidation is
  // contained by the record path (log-only, never blocks the ledger record).
  const catalogInvalidation = createCatalogInvalidation(catalogCache, catalogDigests)
  setAgentFlowInvalidator(catalogInvalidation.invalidate)
  ctx.on('agent/pre-step', (payload, next) =>
    preStepCatalogListener(ctx, resolver, catalogCache, ttlMs, catalogInvalidation, catalogDigests, payload, next, {
      // Without a system-prompt service — or while its registration is not
      // CONFIRMED live (scheduled ≠ landed; a contained failure or a disposal
      // counts) — the row is the ONLY channel for the watermark trio; with a
      // live registration the trio stays in the always-on prompt. The lazy
      // predicate is re-evaluated per step, so a registration landing (or
      // disappearing) mid-session flips the row on the next step.
      showWatermark: () => harnessPromptRegistrationsActive === 0,
    }))

  // Picker write channel — the `mstar` service + its invocation descriptor on
  // the host's SHARED `/api` typert gateway, serving ONE thing: the
  // `mstar/selectWorkflow` UI control (a durable, session-scoped pick). The
  // emission snapshot read that used to live here is retired; the panel's read
  // is the store-backed `mstar/panelSnapshot` installed below
  // (`panel/panel-snapshot-endpoint.ts`), not the last emission persisted above.
  //
  // Both units are OPTIONAL (see `installEngineStatusEndpoint`): the service
  // is deduped per context, and the descriptor is registered inside
  // `ctx.inject(['typert'], …)`. This row's STATIC inject is deliberately left
  // free of `connection` / `webServer` — naming either there would pend the
  // whole row (and with it the boot) on a base-only/headless profile, which is
  // exactly the failure both sibling plugins avoid by registering web-only
  // units through optional children.
  installEngineStatusEndpoint(ctx, {
    resolver,
    bootHarnessDir,
    // A picker commit changes THIS session's durable hint: drop its cached
    // catalog payload + digest so the next pre-step rebuilds from the
    // acknowledged binding (the other sessions' keys stay untouched).
    invalidateSelection: (harnessDir, sessionId) => catalogInvalidation.invalidateSession(harnessDir, sessionId),
  })
  // The panel's store-backed read: its own service under the shared `mstar`
  // wire namespace (its descriptor rides the contribution above — typert admits
  // one per package face). The `retained` facts (the iteration gate, the
  // knowledge digest and the selection no dashboard DTO carries) are REUSED
  // from the cache above through the same reader and the same hint fold the
  // pre-step uses — one key rule, one TTL rule, no second catalog build.
  installPanelSnapshotEndpoint(ctx, {
    resolver,
    bootHarnessDir,
    readRetained: (harnessDir, sessionId, cwd) =>
      readCatalogPayload(
        ctx,
        catalogCache,
        catalogInvalidation,
        harnessDir,
        sessionId,
        cwd,
        selectionHintFor(harnessDir, { sessionId, cwd }),
        ttlMs,
      ),
  })

  // The dsh-native tool surface — three tools, registered and HMR-disposed in
  // the module: `mstar_plan_bind` (producer of the dsh durable execution
  // binding + its adoption receipt, which the MCP bind cannot write),
  // `mstar_audit_validate` (no MCP twin) and `mstar_execution_clear` (no
  // shared command). Every other command is an action of the shared MCP
  // connection.
  registerNativeCommandTools(ctx, resolver)

  // Durable adopted control root : install the seam that lets a cross-root
  // `mstar_plan_bind` adoption survive a host restart. The host's
  // storage-domain facility is OPTIONAL — this row's static inject stays
  // `['loader']` (naming it there would pend the whole row, and the boot, on a
  // composition without the facility), so the unit is a deferred child: the
  // reactive inject below is the install contract, so a boot where the service
  // is merely late installs when it arrives and says nothing at apply time.
  // Every failure path — `open` rejected, an install that throws while wiring
  // the opened handle, an HMR re-apply meeting `already-open` — logs ONE
  // warning naming the cause and the recovery, and
  // leaves today's per-process receipt in place; the plugin still mounts. The
  // child's fiber owns the handle: its disposer uninstalls the seam
  // SYNCHRONOUSLY first (no consumer may read a closing or closed domain) and
  // only then awaits `close()`, which drains the queued durable writes.
  // Cordis invokes exporters unguarded: a throwing log sink must never make
  // this apply throw, so every seam warning takes the house guarded shape.
  const warnExecutionBindingRoots = (message: string): void => {
    try {
      ctx.logger(EXECUTION_BINDING_ROOTS_LOGGER).warn(message)
    } catch {}
  }
  setExecutionBindingRootsLogger(warnExecutionBindingRoots)
  ctx.inject(['storageDomain'], async (storageCtx) => {
    // The facility IS provided, so the seam is coming: an adoption that lands
    // while `open` is in flight is back-filled at install, and reporting it as
    // "no seam" would name a cause that is not true. Only a settled `open` that
    // installed nothing makes the absence real for the rest of this process.
    // The token is THIS activation's — no other activation's completion,
    // refusal or disposal may release it. Two effects own the release, because
    // neither covers the other: the child's fires when its facility goes away,
    // while the row's fires on teardown of a child that a stalled `open` keeps
    // from ever unloading (a child pending on `open` is disposed only once that
    // `open` settles; the row's disposal runs its own effects concurrently).
    const activation = beginExecutionBindingRootStoreOpening()
    const releaseActivation = (): void => endExecutionBindingRootStoreOpening(activation)
    try {
      storageCtx.effect(() => releaseActivation, 'mstar:execution-binding-roots pending open')
      ctx.effect(() => releaseActivation, 'mstar:execution-binding-roots pending open (row teardown)')
    } catch {
      // Either owner is already tearing down, so nothing can install here and no
      // one is left to warn: release the activation rather than leak it.
      releaseActivation()
      return
    }
    // The `open` try covers ONLY the open: an install failure below happened
    // after the domain opened, so reporting it as "open refused" would name a
    // cause that is not true (and the latch would then hide the truth forever).
    let domain: Awaited<ReturnType<typeof storageCtx.storageDomain.open>>
    try {
      domain = await storageCtx.storageDomain.open(executionBindingRootsDomain)
    } catch (error) {
      releaseActivation()
      // This absence carries its OWN cause (the facility is provided; only this
      // `open` was refused) and its own recovery, so it spends the one-shot
      // latch: the generic "the host provides no seam" line would be false here.
      warnExecutionBindingRootStoreUnavailable(
        `durable adopted control root unavailable: open refused (${causeOf(error)}) — the selected control root stays a per-process receipt; restart so the next apply can open the domain once the refused name (an \`already-open\` holder) is released, then a resume re-bind carrying the original session reference records it durably`,
      )
      return
    }
    releaseActivation()
    let uninstall: () => void
    try {
      uninstall = installExecutionBindingRootStore(executionBindingRootStoreOf(domain))
    } catch (error) {
      // The domain opened but wiring it into the seam failed. Close the handle
      // (the facility must not keep the name open for the next apply) and
      // report the INSTALL failure with its own cause, spending the latch: the
      // "open refused" line would be false here.
      try {
        await domain.close()
      } catch (closeError) {
        warnExecutionBindingRoots(`durable adopted control root store close failed after a failed install (${causeOf(closeError)})`)
      }
      warnExecutionBindingRootStoreUnavailable(
        `durable adopted control root unavailable: install failed (${causeOf(error)}) — the selected control root stays a per-process receipt; restart so the next apply retries the install, then a resume re-bind carrying the original session reference records it durably`,
      )
      return
    }
    try {
      storageCtx.effect(() => async () => {
        // Synchronous first: a read must never reach a closing or closed domain.
        uninstall()
        try {
          await domain.close()
        } catch (error) {
          warnExecutionBindingRoots(`durable adopted control root store close failed during disposal (${causeOf(error)})`)
        }
      }, 'mstar:execution-binding-roots durable store')
    } catch (error) {
      // The child fiber was torn down while `open` was still in flight and
      // refuses a new effect (INACTIVE_EFFECT). Drop the seam and close the
      // handle right here — the facility would otherwise keep the name open
      // and the next apply would meet `already-open` instead of regaining
      // durability.
      uninstall()
      try {
        await domain.close()
      } catch (closeError) {
        warnExecutionBindingRoots(`durable adopted control root store close failed after a disposed apply (${causeOf(closeError)})`)
      }
      warnExecutionBindingRootStoreUnavailable(
        `durable adopted control root store discarded: its apply fiber was already disposed when open resolved (${causeOf(error)}) — the late handle was closed; the next apply may re-open the domain`,
      )
    }
  })
}
