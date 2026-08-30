/**
 * Native-first role-persona delivery (plan `20260831-dsh-alpha2-optional-fallbacks`
 * Task 3): a role-matched subagent start merges the persona into the request's
 * NATIVE `persona` slot (`@deepseek-ai/dsh-subagent`
 * `SubagentStartRequest.persona`) — the additive `mstar:role-persona`
 * system-prompt section is gone. Native semantics: the request persona
 * registers the scoped `deployment:persona` section (order
 * `DEPLOYMENT_PERSONA` = 0) on the child, SHADOWING the deployment persona
 * for that child alone, is persisted in the child descriptor, and is
 * reapplied on resume — delivery, persistence, and resume replay all belong
 * to dsh.
 *
 * Interception seam: the cordis service-read waterfall
 * (`Events['internal/get']`, `@deepseek-ai/cordis` 4.0.2
 * `lib/types/events.d.ts`) — the framework's documented interception hook
 * for values read through the context proxy. The listener wraps the
 * `subagents` service VALUE on read (a prototype-delegating wrapper whose
 * `start` merges the role persona into the request before delegating); the
 * real `SubagentRuntime` object is never mutated — readers of
 * `ctx.subagents` (the tool-subagent reads it per call through a
 * plugin-fiber context) transparently receive the wrapper. The listener is
 * owned by the applying fiber (cordis listener effects), so an HMR fiber
 * swap unwinds and restores it like every other registration.
 *
 * Role identity uses the engine Assignment header grammar — the SAME
 * parsers the dispatch gate uses (`assignmentHeaderRegion` +
 * `parseAssignmentFields`) — over the start request's prompt text (the
 * `ContentBlock[]` the child receives as its first user message). Persona
 * lookup (plan `20260815-dsh-fallbacks-personas` Task 3) is the single
 * {@link personaFor} surface — `Config.rolePersonas[executeAs]` →
 * `harness-agents/` mirror default → skip (never gated on `roleMap` or on
 * the fallbacks mounted state: persona delivery is fallbacks-independent).
 * `roleMap` is a taxonomy bridge for logging + future rule-driven interop
 * only. The mirror root is bound at apply (`setRolePersonaAgentsDir` ←
 * `packagedAgentsDir()`), package-relative so the shipped bundle works from
 * any launch cwd.
 *
 * Capability gate (native fail-loud contract): `SubagentRuntime.start`
 * REJECTS a request carrying `persona` for a provider whose
 * `SubagentCapabilities.persona` is false (e.g. out-of-process providers) —
 * "rejected rather than accepted-then-ignored". The merge therefore checks
 * `getProvider(name).capabilities.persona` FIRST: without the capability the
 * persona is skipped with one contained debug log and the start proceeds
 * unchanged — the contained degrade, never a failed dispatch.
 *
 * Precedence: an explicit `request.persona` (e.g. tool-subagent's own
 * `Config.persona`) is caller intent and WINS — the role persona fills the
 * slot only when the request does not already carry one.
 *
 * Degradation (the wrapper never throws before delegating — contained like
 * the dispatch gate's degrade path): unparseable prompt / role-unmatched →
 * silent pass-through; persona lookup miss with NO mirror → one debug log
 * per apply (S-002 latch); a throwing merge aborts the merge only — the
 * ORIGINAL request reaches the service and the start is never affected.
 *
 * Persona text is rendered by dsh system-prompt's STRICT `{{...}}`
 * interpolation (the native persona has the same template semantics as the
 * deployment persona), so persona values MUST NOT contain `{{` paired with
 * a later `}}` — the Config schema rejects such values at plugin mount (see
 * `_shared.ts` `rolePersonas` / `PERSONA_INTERPOLATION_HAZARD`); a mirror
 * default carrying the hazard is warned + skipped at extraction (never a
 * boot throw).
 *
 * Module boundary: no barrel — the entry imports this module by explicit
 * relative path and re-exports the public names verbatim. No dsh-subagent
 * dependency: the runtime surface is consumed structurally (same pattern as
 * the probe's `LoaderEntryView` and T2's `fallbacks-structural.ts`).
 */
import type { Context } from '@deepseek-ai/cordis'
import { assignmentHeaderRegion, parseAssignmentFields } from '@mstar-harness/engine'
import type { Config } from './_shared.ts'
import { personaFor } from './agent-personas.ts'

/** Logger label for the role-persona channel (dsh logger naming: `<scope>/<subject>`). */
export const ROLE_PERSONA_LOGGER = 'mstar/role-persona'

/** The cordis service name the channel intercepts (`ctx.subagents`). */
const SUBAGENTS_SERVICE = 'subagents'

/** One consumed prompt content block (`@deepseek-ai/dsh-llm` `ContentBlock` text members). */
interface PromptBlockView {
  readonly type: string
  readonly text?: string
}

/**
 * Structural view of the one-shot start request the channel merges into
 * (`@deepseek-ai/dsh-subagent` `SubagentStartRequest` — consumed fields
 * only: `prompt` is the role-extraction source, `persona` is the merge
 * target). The wrapper forwards the request object SPREAD, so every
 * non-consumed field (`label`, `parent`, `signal`, `agentOptions`, …)
 * reaches the service unchanged at runtime; the view types only what this
 * module reads.
 */
export interface SubagentStartRequestView {
  /** Content delivered as the child's user message (the Assignment carrier). */
  readonly prompt: readonly PromptBlockView[]
  /** Optional per-child persona — when already set, the caller wins. */
  readonly persona?: string
}

/**
 * Structural view of the capability set the channel gates on
 * (`@deepseek-ai/dsh-subagent` `SubagentCapabilities` — only `persona` is
 * consumed: the native fail-loud contract rejects a persona request for a
 * provider without it, so the channel must pre-check).
 */
interface SubagentCapabilitiesView {
  readonly persona?: boolean
}

/** Structural view of one registered provider (`SubagentProvider` consumed surface). */
interface SubagentProviderView {
  readonly capabilities: SubagentCapabilitiesView
}

/**
 * Structural view of the `subagents` runtime the wrapper delegates to
 * (`@deepseek-ai/dsh-subagent` `SubagentRuntime` consumed surface:
 * capability reads + one-shot starts). `start` returns the service's own
 * run promise — opaque here, forwarded untouched.
 */
export interface SubagentsServiceView {
  /** Look up a provider by name (the capability-gate read). */
  getProvider(name: string): SubagentProviderView | undefined
  /** Establish one published child on the named provider (the delegated start). */
  start(name: string, request: SubagentStartRequestView): unknown
}

/** Role-persona log levels the module sink understands. */
export type RolePersonaLogLevel = 'debug' | 'warn'

/** Module-level log sink — bound by `apply` to `ctx.logger(ROLE_PERSONA_LOGGER)` (agent-flow ledger precedent). */
export type RolePersonaLogSink = (level: RolePersonaLogLevel, message: string) => void

let rolePersonaLogSink: RolePersonaLogSink = () => {}

/**
 * Bind the role-persona log sink (the entry `apply` binds it to
 * `ctx.logger(ROLE_PERSONA_LOGGER)`). Returns the PRIOR sink so a caller
 * can restore it (test pattern: agent-flow `setAgentFlowLogger`).
 */
export function setRolePersonaLogger(sink: RolePersonaLogSink): RolePersonaLogSink {
  const prior = rolePersonaLogSink
  rolePersonaLogSink = sink
  return prior
}

/**
 * The persona-defaults mirror root (`harness-agents/`), bound by the entry
 * `apply` to the packaged mirror (package-relative resolution — the shipped
 * bundle works from any launch cwd). `undefined` → the channel is
 * config-only (no mirror defaults).
 */
let rolePersonaAgentsDir: string | undefined

/**
 * S-002: once-per-apply latch for the mirror-absent debug — the latch is
 * keyed on the agents-dir binding (each `setRolePersonaAgentsDir` call,
 * i.e. each apply, resets it), so the "no mirror" debug fires at most once
 * per apply instead of once per start (advisory-latch pattern).
 */
let mirrorAbsentDebugged = false

/**
 * Bind the persona-defaults mirror root. Returns the PRIOR binding so a
 * caller can restore it (test pattern: {@link setRolePersonaLogger}).
 * @param dir - the mirror root, or `undefined` to disable mirror defaults.
 */
export function setRolePersonaAgentsDir(dir: string | undefined): string | undefined {
  const prior = rolePersonaAgentsDir
  rolePersonaAgentsDir = dir
  mirrorAbsentDebugged = false
  return prior
}

/** Wrapper identity cache — one wrapper per underlying service value, so repeated reads agree. */
const wrapperCache = new WeakMap<object, unknown>()

/**
 * Register the native persona channel on the plugin's context: an
 * `internal/get` waterfall listener (the cordis service-read interception
 * hook) that wraps `ctx.subagents` reads. The listener is owned by the
 * applying fiber — an HMR fiber swap unwinds it (reads return the raw
 * service again) and a re-apply restores it.
 *
 * Never throws: the wrap step is contained — on any internal error the read
 * returns the UNWRAPPED service value (persona delivery degrades, the
 * runtime is untouched).
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param config - validated plugin configuration (`rolePersonas` is the
 *   only payload source; `roleMap` is never consulted for the merge).
 */
export function registerRolePersonaChannel(ctx: Context, config: Config): void {
  // The persona payload source is bound at registration (the apply-scoped
  // validated Config) — the merge reads it without a config parameter so the
  // wrapper's `start` signature stays the service's own.
  config_rolePersonas = config.rolePersonas
  // Waterfall listener: `(ctx, name, error, next)` — calling `next()` runs
  // the remaining chain (finally the built-in resolution) and its return is
  // the value readers receive. Dispatch carries no `this`, so no context
  // filter applies: the hook sees service reads from every fiber, exactly
  // the reachability the tool-subagent's per-call reads need.
  ctx.on('internal/get', (_readCtx, name, _error, next) => {
    const value: unknown = next()
    if (name !== SUBAGENTS_SERVICE) return value
    try {
      return wrapSubagentsService(value)
    } catch (error) {
      // Contained: an internal wrap error degrades to the raw service —
      // persona delivery is skipped, the runtime is untouched.
      log('warn', `role persona channel degraded to pass-through (subagent starts unaffected): ${errorMessage(error)}`)
      return value
    }
  })
}

/**
 * Wrap one `ctx.subagents` read value: non-objects and non-runtime shapes
 * (the service is absent) pass through untouched. The wrapper is a
 * prototype-delegating object whose OWN `start` merges the role persona
 * into the request before delegating — the underlying service object is
 * never mutated (no monkey-patching). Identity is cached per underlying
 * value so repeated reads agree.
 */
function wrapSubagentsService(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const service = value as SubagentsServiceView
  if (typeof service.start !== 'function' || typeof service.getProvider !== 'function') return value
  const cached = wrapperCache.get(value)
  if (cached !== undefined) return cached
  const wrapper: SubagentsServiceView = Object.create(value)
  wrapper.start = (name: string, request: SubagentStartRequestView) => {
    let merged = request
    try {
      merged = withRolePersona(service, name, request)
    } catch (error) {
      // Contained like the gate's degrade path: the merge aborts, the
      // ORIGINAL request reaches the service — the start is never affected.
      log('warn', `role persona merge degraded to pass-through (subagent start unaffected): ${errorMessage(error)}`)
    }
    return service.start(name, merged)
  }
  wrapperCache.set(value, wrapper)
  return wrapper
}

/**
 * Resolve the role persona for one start request and merge it into the
 * native `persona` slot. Pure decision function — returns the request
 * UNCHANGED on every skip path (no-op is silent unless a debug log is
 * explicitly part of the contract below):
 *
 * 1. request already carries `persona` → caller intent wins (silent).
 * 2. perf guard: no `rolePersonas` AND no mirror → nothing to resolve
 *    (silent; `== null` covers schemastery's nullable pass-through).
 * 3. prompt carries no text → nothing to parse (silent).
 * 4. prompt is not Assignment-shaped (`Execute as` absent) → silent.
 * 5. persona lookup miss: mirror ABSENT → one debug log per apply (S-002
 *    latch); mirror present → silent (no eligible shell).
 * 6. provider unknown → silent (the service fails loud its own way —
 *    `NO_PROVIDER` — the channel must not shadow that).
 * 7. provider lacks the persona capability (out-of-process) → one debug
 *    log, request unchanged — the native contract rejects a persona for
 *    such a provider, so merging would fail the start (never acceptable).
 * 8. hit → merge + one debug log naming the source.
 */
function withRolePersona(
  service: SubagentsServiceView,
  providerName: string,
  request: SubagentStartRequestView,
): SubagentStartRequestView {
  // (1) Explicit caller persona wins — mstar never overrides caller intent.
  if (request.persona !== undefined) return request
  // (2) Perf guard: with `rolePersonas` unset (or empty) AND no persona
  // mirror there is nothing to resolve — skip the Assignment parse entirely.
  const personas = config_rolePersonas
  const agentsDir = rolePersonaAgentsDir
  if ((personas == null || Object.keys(personas).length === 0) && agentsDir === undefined) return request
  // (3) The prompt text: text blocks joined with newlines (the same
  // projection the child's seeded user message carries).
  const taskPrompt = (request.prompt ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  if (taskPrompt.trim().length === 0) return request
  // (4) The SAME engine Assignment grammar the dispatch gate uses: the
  // header region only, so a body-quoted field line cannot shape a merge.
  const executeAs = parseAssignmentFields(assignmentHeaderRegion(taskPrompt)).executeAs
  if (executeAs === undefined) return request
  // (5) Single lookup (personaFor): `rolePersonas[role]` → mirror default →
  // skip. A mirror default carrying the interpolation hazard is warned +
  // skipped at extraction (never a boot throw).
  const persona = personaFor(executeAs, { rolePersonas: personas, agentsDir }, (message) => log('warn', message))
  if (persona === undefined) {
    // Case (e): with NO mirror the lookup was config-only — one debug log
    // per APPLY (S-002 latch), not per start. With the mirror present and
    // no eligible shell, the miss stays silent.
    if (agentsDir === undefined && !mirrorAbsentDebugged) {
      mirrorAbsentDebugged = true
      log('debug', 'harness-agents mirror absent — role persona skipped (config-only lookups; mirror defaults unavailable)')
    }
    return request
  }
  // (6) Provider unknown → silent: `start` fails loud its own way
  // (`NO_PROVIDER`), and the channel must not shadow that contract.
  const provider = service.getProvider(providerName)
  if (provider === undefined) return request
  // (7) Capability gate: the native contract REJECTS a persona request for
  // a provider without the capability ("fail loud, no silent degradation")
  // — merging would fail the start, so the persona is skipped instead and
  // the start proceeds unchanged (the contained degrade).
  if (provider.capabilities?.persona !== true) {
    log('debug', `subagent provider '${providerName}' lacks the persona capability — role persona for '${executeAs}' skipped (start proceeds unchanged)`)
    return request
  }
  // (8) Hit — merge into the native slot. dsh composes it as the scoped
  // `deployment:persona` section (SHADOWING the deployment persona for this
  // child), persists it in the child descriptor, and reapplies it on resume.
  log('debug', `role persona delivered via the native subagent persona channel for role '${executeAs}' (source: ${persona.source === 'config' ? 'mstar Config' : 'harness-agents default'})`)
  return { ...request, persona: persona.text }
}

/** The `rolePersonas` config the channel reads (bound at registration). */
let config_rolePersonas: Config['rolePersonas']

/** Best-effort human-readable message from an arbitrary thrown value (agent-flow `errorMessage` pattern). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function log(level: RolePersonaLogLevel, message: string): void {
  try {
    rolePersonaLogSink(level, message)
  } catch {
    // Never-throws invariant (plan QC F-002): a throwing log sink must not
    // escape the channel — the subagent start is never affected.
  }
}
