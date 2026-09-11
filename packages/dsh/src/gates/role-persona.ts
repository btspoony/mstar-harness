/**
 * Native-first role-persona delivery : a role-matched subagent start merges the persona into the request's
 * NATIVE `persona` slot (`@deepseek-ai/dsh-subagent`
 * `SubagentStartRequest.persona`) — the additive `mstar:role-persona`
 * system-prompt section is gone. Native semantics: the request persona
 * registers the scoped `deployment:persona` section (order
 * `DEPLOYMENT_PERSONA` = 0) on the child, SHADOWING the deployment persona
 * for that child alone, is persisted in the child descriptor, and is
 * reapplied on resume — delivery, persistence, and resume replay all belong
 * to dsh. BOTH start surfaces are wrapped: the one-shot `start` AND the
 * opt-in continuable `startContinuable` (tool-subagent
 * `backgroundMode: 'continuable'` routes its background run through
 * `ContinuableStartSpec.request`) — the old `subagent/start` emit
 * decoration covered continuable children too, and this channel must not
 * regress that.
 *
 * Interception seam: the cordis service-read waterfall
 * (`Events['internal/get']`, `@deepseek-ai/cordis` 4.0.2
 * `lib/types/events.d.ts`) — the framework's documented interception hook
 * for values read through the context proxy. The listener wraps the
 * `subagents` service VALUE on read (a prototype-delegating wrapper whose
 * `start`/`startContinuable` merge the role persona into the request before
 * delegating); the real `SubagentRuntime` object is never mutated — readers
 * of `ctx.subagents` (the tool-subagent reads it per call through a
 * plugin-fiber context) transparently receive the wrapper. The listener is
 * owned by the applying fiber (cordis listener effects), so an HMR fiber
 * swap unwinds and restores it like every other registration.
 *
 * The continuable request has no earlier seam: `registerContinuableSetup`
 * contributions are child-scope installers (`(childCtx) => () => void` —
 * no per-start data slot), so the earliest point where the continuable
 * request exists is the `startContinuable(spec)` call itself, which the
 * wrapper owns.
 *
 * Role identity uses the engine Assignment header grammar — the SAME
 * parsers the dispatch gate uses (`assignmentHeaderRegion` +
 * `parseAssignmentFields`) — over the start request's prompt text (the
 * `ContentBlock[]` the child receives as its first user message). Persona
 * lookup  is the single
 * {@link personaFor} surface — `Config.rolePersonas[executeAs]` →
 * `harness-agents/` mirror default → skip (never gated on `roleMap` or on
 * the fallbacks mounted state: persona delivery is fallbacks-independent).
 * `roleMap` is a taxonomy bridge for logging + future rule-driven interop
 * only. The mirror root is bound at apply (`setRolePersonaAgentsDir` ←
 * `packagedAgentsDir()`), package-relative so the shipped bundle works from
 * any launch cwd. Lifetime: the root is a module-level binding with ONE
 * writer — the per-apply `setRolePersonaAgentsDir` call — and it is read
 * per start, so every start observes an apply-constant value; re-calling
 * the setter (an HMR re-apply) IS the re-bind, and that re-bind is the
 * intended reset (it also re-arms the mirror-absent latch below). The
 * per-apply payload `Config.rolePersonas` is the contrast: closed over per
 * apply in `registerRolePersonaChannel`.
 *
 * Capability gates (native fail-loud contracts, per surface): one-shot
 * `SubagentRuntime.start` REJECTS a request carrying `persona` for a
 * provider whose `SubagentCapabilities.persona` is false (e.g.
 * out-of-process providers) — "rejected rather than accepted-then-ignored"
 * — so the one-shot merge checks `getProvider(name).capabilities.persona`
 * first. Continuable children are composed by the continuation manager
 * itself and are gated by `SubagentProvider.prepareContinuable` instead
 * (upstream `SubagentCapabilities` doc: the flags "describe the ONE-SHOT
 * path"), so the continuable merge checks `prepareContinuable` — the
 * manager applies a merged persona unconditionally. Either way: gate miss →
 * the persona is skipped with one contained debug log and the start
 * proceeds unchanged — the contained degrade, never a failed dispatch.
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
 * Seam probe (apply-time, observation only): a future cordis rename/removal
 * of `internal/get` would stop the listener from ever firing — persona
 * delivery would silently degrade to the raw service with no runtime
 * signal. {@link probeRolePersonaSeam} runs ONCE per apply right after
 * {@link registerRolePersonaChannel}: a temporary canary listener + ONE
 * controlled proxied read (`ctx.subagents` — NEVER `ctx.get`, whose accessor
 * bypasses the waterfall and would false-warn every healthy boot) assert
 * that the seam dispatched AND the returned value carries the wrapper brand.
 * A broken seam warns ONCE per apply (fail-loud); an unresolved service is
 * `service-absent` (`ok: true` + one debug — the apply ctx does not resolve
 * `subagents`; cordis resolves the service in dispatch scopes, where reads
 * are intercepted per read); any probe-internal error fails
 * OPEN (`ok` + one debug) — the probe never throws and never blocks a
 * dispatch. The decision core is the pure {@link evaluateSeamProbe}, so the
 * whole outcome table is unit-pinnable without cordis internals.
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
 * relative path and re-exports the public names verbatim, EXCEPT the four
 * probe exports (`PERSONA_SEAM_EVENT`, `ROLE_PERSONA_WRAPPER_BRAND`,
 * `evaluateSeamProbe`, `probeRolePersonaSeam`), which are deliberately NOT
 * re-exported from the entry: the frozen entry surface keeps the probe
 * observable only through this module (tests import it directly; the
 * shipped bundle exports no probe symbol). No dsh-subagent
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

/**
 * The interception seam: the cordis service-read waterfall event the channel
 * listener registers on. The registration and the apply-time seam probe both
 * reference THIS constant — a future cordis rename of `internal/get` becomes
 * a one-line, probe-family-caught edit here instead of a silent delivery
 * stop (the probe family pins the literal; see `probeRolePersonaSeam`).
 */
export const PERSONA_SEAM_EVENT = 'internal/get'

/**
 * Wrapper brand — the non-enumerable symbol own property every persona
 * wrapper carries (`wrapSubagentsService` stamps it at creation). The apply-
 * time seam probe reads it to assert the wrapper was actually installed on
 * the controlled read. Non-enumerable + symbol keeps the wrapper's
 * key/spread/JSON surface identical to the wrapped service's (behavior-
 * neutral by construction).
 */
export const ROLE_PERSONA_WRAPPER_BRAND: symbol = Symbol('mstar.role-persona.wrapper')

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
 * module reads. The continuable surface merges into the SAME view
 * (`ContinuableStartSpec.request` is `Omit<SubagentStartRequest, 'label' |
 * 'signal' | 'outputSchema'>` — same `prompt`/`persona` shape).
 */
export interface SubagentStartRequestView {
  /** Content delivered as the child's user message (the Assignment carrier). */
  readonly prompt: readonly PromptBlockView[]
  /** Optional per-child persona — when already set, the caller wins. */
  readonly persona?: string
}

/**
 * Structural view of the continuable start spec the channel merges into
 * (`@deepseek-ai/dsh-subagent` `ContinuableStartSpec` — consumed fields
 * only). The wrapper forwards the spec object SPREAD, so every
 * non-consumed field (`label`, `childId`, `signal`) reaches the service
 * unchanged at runtime; the view types only what this module reads.
 */
export interface ContinuableStartSpecView {
  /** The `ctx.subagents` provider whose continuable creation establishes the child. */
  readonly provider: string
  /** The delegation request (the merge target: same view as the one-shot request). */
  readonly request: SubagentStartRequestView
}

/**
 * Structural view of the capability set the channel gates on
 * (`@deepseek-ai/dsh-subagent` `SubagentCapabilities` — only `persona` is
 * consumed: the ONE-SHOT fail-loud contract rejects a persona request for a
 * provider without it, so the one-shot merge must pre-check).
 */
interface SubagentCapabilitiesView {
  readonly persona?: boolean
}

/**
 * Structural view of one registered provider (`SubagentProvider` consumed
 * surface). `prepareContinuable` is the NATIVE continuable gate (upstream:
 * continuable children "are composed by the continuation manager itself
 * and are gated by `SubagentProvider.prepareContinuable` instead") — its
 * presence, not the one-shot `persona` flag, decides whether a merged
 * persona can be honored on the continuable surface.
 */
interface SubagentProviderView {
  readonly capabilities: SubagentCapabilitiesView
  readonly prepareContinuable?: unknown
}

/**
 * Structural view of the `subagents` runtime the wrapper delegates to
 * (`@deepseek-ai/dsh-subagent` `SubagentRuntime` consumed surface:
 * capability reads + one-shot and continuable starts). Start methods
 * return the service's own promises/ids — opaque here, forwarded untouched.
 */
export interface SubagentsServiceView {
  /** Look up a provider by name (the capability-gate read). */
  getProvider(name: string): SubagentProviderView | undefined
  /** Establish one published child on the named provider (the delegated one-shot start). */
  start(name: string, request: SubagentStartRequestView): unknown
  /** Establish one durable continuable child (the delegated continuable start). */
  startContinuable(spec: ContinuableStartSpecView): unknown
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
 *
 * Lifetime (module sink, deliberately not apply-closed): one binding per
 * process with exactly ONE writer — {@link setRolePersonaAgentsDir},
 * called once per apply from the entry (`packagedAgentsDir()`) — while the
 * only read (`withRolePersona`, per start) observes an apply-constant
 * value: the binding cannot change mid-apply, so the module variable is
 * apply-scoped in effect. Contrast: the persona payload
 * `Config.rolePersonas` is apply-closed (closed over in
 * `registerRolePersonaChannel`); the mirror root is apply-scoped by
 * re-binding rather than by closure.
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
 * Bind the persona-defaults mirror root — the module sink's only writer,
 * invoked once per apply from the entry with `packagedAgentsDir()`, so an
 * HMR re-apply re-binds the root instead of inheriting the previous
 * apply's binding. That re-bind is the intended reset: beyond swapping the
 * root it re-arms the S-002 mirror-absent latch (`mirrorAbsentDebugged`),
 * keeping the "no mirror" debug at most once per apply, and the returned
 * PRIOR binding lets a caller restore the previous root (test pattern:
 * {@link setRolePersonaLogger}).
 * @param dir - the mirror root, or `undefined` to disable mirror defaults.
 */
export function setRolePersonaAgentsDir(dir: string | undefined): string | undefined {
  const prior = rolePersonaAgentsDir
  rolePersonaAgentsDir = dir
  mirrorAbsentDebugged = false
  return prior
}

/**
 * Wrapper identity cache — one wrapper per (service value, persona-config
 * generation). Repeated reads of the same service under the same
 * registration agree on one wrapper; an HMR re-apply binds a NEW validated
 * Config object, so the identity check re-wraps with the fresh binding
 * (the old fiber's listener is gone by then — its wrapper is unreachable).
 */
const wrapperCache = new WeakMap<object, { rolePersonas: Config['rolePersonas']; wrapper: unknown }>()

/**
 * Register the native persona channel on the plugin's context: an
 * `internal/get` waterfall listener (the cordis service-read interception
 * hook) that wraps `ctx.subagents` reads. The listener is owned by the
 * applying fiber — an HMR fiber swap unwinds it (reads return the raw
 * service again) and a re-apply restores it.
 *
 * Composition-order independence (`prepend`): the SAME seam is wrapped by a
 * mounted role-identity layer (`dsh-llm-fallbacks` — its dispatch seam resolves
 * the Assignment's declared role and merges that role's declared `persona`),
 * and BOTH wrappers fill the SAME native `persona` slot, each only when it is
 * free — so whichever wrapper runs FIRST owns the slot. A waterfall runs
 * listeners outermost-first, and `prepend` registers this one at the front,
 * so the harness channel is outermost on ANY row order: the default profile
 * mounts the mstar row first, while a re-ordered profile (or a re-applied
 * plugin row) mounts it last. The operator's `rolePersonas` override — the
 * harness's authoritative role identity for a role it resolves — therefore
 * wins the slot over a fallbacks-side persona for the same role instead of
 * losing it to whichever layer happened to apply first. A role the harness
 * resolves NOTHING for still falls through to the fallbacks seam (the
 * outermost wrapper delegates the caller's own request object on every skip
 * path), and reads of every other service are returned untouched.
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
  // The persona payload source is closed over from THIS apply's validated
  // Config — never a process global (two applies must not cross-talk), and
  // the wrapper's `start`/`startContinuable` signatures stay the service's
  // own (the closure carries the binding).
  const rolePersonas = config.rolePersonas
  // Waterfall listener: `(ctx, name, error, next)` — calling `next()` runs
  // the remaining chain (finally the built-in resolution) and its return is
  // the value readers receive. Dispatch carries no `this`, so no context
  // filter applies: the hook sees service reads from every fiber, exactly
  // the reachability the tool-subagent's per-call reads need.
  ctx.on(PERSONA_SEAM_EVENT, (_readCtx, name, _error, next) => {
    const value: unknown = next()
    if (name !== SUBAGENTS_SERVICE) return value
    try {
      return wrapSubagentsService(value, rolePersonas)
    } catch (error) {
      // Contained: an internal wrap error degrades to the raw service —
      // persona delivery is skipped, the runtime is untouched.
      log('warn', `role persona channel degraded to pass-through (subagent starts unaffected): ${errorMessage(error)}`)
      return value
    }
  }, { prepend: true })
}

/** The fail-loud warn (ONE per apply, `ok === false`) — the reason is appended. */
const SEAM_WARN = `role persona channel not installed — cordis '${PERSONA_SEAM_EVENT}' seam missing or unrecognized (rolePersonas will not be merged into subagent starts)`

/** Outcome of one apply-time seam probe ({@link probeRolePersonaSeam}). */
export interface PersonaSeamProbeResult {
  /** `true` = the channel is healthy OR the probe failed open (never block apply). */
  ok: boolean
  /**
   * Why the probe classified the channel the way it did. `ok: false` ALWAYS
   * carries a reason; `service-absent` may appear with `ok: true` (the
   * sanctioned no-warn unresolved-service classification).
   */
  reason?: 'seam-absent' | 'wrap-skipped' | 'service-absent'
}

/** One probe observation — the inputs of the pure decision core. */
export interface SeamProbeInputs {
  /** Whether the temporary canary listener fired during the controlled read. */
  dispatched: boolean
  /** The value the controlled read threw (`undefined` = the read resolved). */
  readError: unknown
  /** The controlled read's resolved value (`undefined` when the read threw). */
  value: unknown
}

/**
 * Pure decision core of the seam probe — the ENTIRE outcome table, unit-
 * pinnable without cordis internals:
 *
 * - canary silent → `{ ok: false, reason: 'seam-absent' }` — cordis no
 *   longer dispatches the seam; our listener can never run. Dominates the
 *   other inputs (a silent canary means the delivery channel is gone).
 * - canary fired + read threw → `{ ok: true, reason: 'service-absent' }` —
 *   the seam works but the reading ctx does not resolve `subagents` (on the
 *   real composition the apply ctx is inject-guarded; cordis resolves the
 *   service in dispatch scopes, where reads are intercepted per read). Never
 *   a warn.
 * - canary fired + branded value → `{ ok: true }` — healthy.
 * - canary fired + any other resolved value (unbranded object, primitive,
 *   undefined) → `{ ok: false, reason: 'wrap-skipped' }` — the listener ran
 *   but the shape was unrecognized (the `wrapSubagentsService` pass-through).
 */
export function evaluateSeamProbe({ dispatched, readError, value }: SeamProbeInputs): PersonaSeamProbeResult {
  if (!dispatched) return { ok: false, reason: 'seam-absent' }
  if (readError !== undefined) return { ok: true, reason: 'service-absent' }
  if (typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[ROLE_PERSONA_WRAPPER_BRAND] === true) {
    return { ok: true }
  }
  return { ok: false, reason: 'wrap-skipped' }
}

/**
 * Apply-time seam probe — runs EXACTLY ONCE per apply, immediately after
 * {@link registerRolePersonaChannel} (entry wiring), and classifies the
 * channel's install state per {@link evaluateSeamProbe} (observation only —
 * it never changes delivery semantics):
 *
 * 1. register a TEMPORARY {@link PERSONA_SEAM_EVENT} canary listener
 *    (`(ctx, name, error, next) => { dispatched = true; return next() }`),
 *    keeping the disposer `ctx.on` returns;
 * 2. perform ONE controlled proxied read `ctx.subagents` inside try/catch —
 *    the exact read path the per-call `ctx.subagents.start(...)` dispatch
 *    takes. NEVER `ctx.get('subagents')`: the accessor reads the service
 *    store directly and bypasses the waterfall, which would false-warn
 *    `seam-absent` on every healthy boot;
 * 3. dispose the canary SYNCHRONOUSLY (`finally` — also on the throwing
 *    read path);
 * 4. classify via {@link evaluateSeamProbe} and log: `ok === false` → ONE
 *    warn ({@link SEAM_WARN} + reason); `service-absent` → one debug; a
 *    healthy probe stays silent.
 *
 * Contained failure: the body is fully try/catch-wrapped — any probe-
 * internal error (e.g. a rejected listener registration) fails OPEN with
 * `{ ok: true }` plus ONE debug naming the error. Never throws out of
 * `apply`; never affects a subagent start.
 *
 * @param ctx - the plugin's registrant context (a runtime-bearing context —
 *   proxied property reads on it dispatch the seam waterfall).
 */
export function probeRolePersonaSeam(ctx: Context): PersonaSeamProbeResult {
  try {
    let dispatched = false
    let readError: unknown
    let value: unknown
    const disposeCanary = ctx.on(PERSONA_SEAM_EVENT, (_readCtx, _name, _error, next) => {
      dispatched = true
      return next()
    })
    try {
      value = (ctx as unknown as { subagents?: unknown }).subagents
    } catch (error) {
      readError = error
    } finally {
      disposeCanary()
    }
    const result = evaluateSeamProbe({ dispatched, readError, value })
    if (!result.ok) {
      log('warn', `${SEAM_WARN} (reason: ${result.reason})`)
    } else if (result.reason === 'service-absent') {
      log('debug', `role persona seam probe: 'subagents' unresolved at apply (the apply ctx does not resolve it — cordis resolves the service in dispatch scopes, where reads are intercepted per read)`)
    }
    return result
  } catch (error) {
    // Contained fail-open: a broken probe must never fail apply — report
    // once at debug and treat the channel as healthy (observation only).
    // The report itself is nested-guarded: `errorMessage(error)` is
    // evaluated HERE, outside `log`'s own sink guard, so a thrown value
    // with a hostile `toString` — or a throwing sink — must not escape
    // the probe's fail-open path.
    try {
      log('debug', `role persona seam probe failed internally — fail-open (observation only): ${errorMessage(error)}`)
    } catch {
      // Swallowed: fail-open reporting is best-effort by contract.
    }
    return { ok: true }
  }
}

/**
 * Wrap one `ctx.subagents` read value: non-objects and non-runtime shapes
 * (the service is absent) pass through untouched. The wrapper is a
 * prototype-delegating object whose OWN `start`/`startContinuable` merge
 * the role persona into the request before delegating — the underlying
 * service object is never mutated (no monkey-patching), and no surface the
 * service does not carry is invented (a runtime without `startContinuable`
 * keeps answering `typeof service.startContinuable === 'undefined'`).
 * Identity is cached per (service value, persona-config generation) so
 * repeated reads agree and re-applies re-bind.
 */
function wrapSubagentsService(value: unknown, rolePersonas: Config['rolePersonas']): unknown {
  if (typeof value !== 'object' || value === null) return value
  const service = value as SubagentsServiceView
  if (typeof service.start !== 'function' || typeof service.getProvider !== 'function') return value
  const cached = wrapperCache.get(value)
  if (cached !== undefined && cached.rolePersonas === rolePersonas) return cached.wrapper
  const wrapper: SubagentsServiceView = Object.create(value)
  // Wrapper brand (seam-probe assertion target): a NON-enumerable symbol own
  // property — invisible to Object.keys/spread/JSON, so the wrapper's key
  // and spread surface stays identical to the service's (no behavior change).
  Object.defineProperty(wrapper, ROLE_PERSONA_WRAPPER_BRAND, { value: true, enumerable: false })
  wrapper.start = (name: string, request: SubagentStartRequestView) => {
    let merged = request
    try {
      merged = withRolePersona(service, name, request, rolePersonas, 'one-shot')
    } catch (error) {
      // Contained like the gate's degrade path: the merge aborts, the
      // ORIGINAL request reaches the service — the start is never affected.
      log('warn', `role persona merge degraded to pass-through (subagent start unaffected): ${errorMessage(error)}`)
    }
    return service.start(name, merged)
  }
  if (typeof service.startContinuable === 'function') {
    wrapper.startContinuable = (spec: ContinuableStartSpecView) => {
      let merged = spec
      try {
        const mergedRequest = withRolePersona(service, spec.provider, spec.request, rolePersonas, 'continuable')
        if (mergedRequest !== spec.request) merged = { ...spec, request: mergedRequest }
      } catch (error) {
        // Contained like the one-shot path: the merge aborts, the ORIGINAL
        // spec reaches the service — the continuable start is never affected.
        log('warn', `role persona merge degraded to pass-through (continuable subagent start unaffected): ${errorMessage(error)}`)
      }
      return service.startContinuable(merged)
    }
  }
  wrapperCache.set(value, { rolePersonas, wrapper })
  return wrapper
}

/**
 * Resolve the role persona for one start request and merge it into the
 * native `persona` slot (one-shot AND continuable — the decision chain is
 * shared, only the terminal capability gate differs). Pure decision
 * function — returns the request UNCHANGED on every skip path (no-op is
 * silent unless a debug log is explicitly part of the contract below):
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
 * 7. surface capability gate (see below) → one debug log, request
 *    unchanged — merging what the runtime would reject is never acceptable.
 * 8. hit → merge + one debug log naming the surface and the source.
 *
 * The gate per surface (native fail-loud contracts): one-shot
 * `SubagentRuntime.start` rejects a persona for a provider without
 * `SubagentCapabilities.persona` ("fail loud, no silent degradation");
 * continuable children are composed by the continuation manager itself and
 * gated by `provider.prepareContinuable` instead (upstream
 * `SubagentCapabilities` doc — the flags describe the ONE-SHOT path), and a
 * provider without it rejects the continuable start loud regardless of any
 * persona, so the merge is skipped there.
 */
function withRolePersona(
  service: SubagentsServiceView,
  providerName: string,
  request: SubagentStartRequestView,
  rolePersonas: Config['rolePersonas'],
  surface: 'one-shot' | 'continuable',
): SubagentStartRequestView {
  // (1) Explicit caller persona wins — mstar never overrides caller intent.
  if (request.persona !== undefined) return request
  // (2) Perf guard: with `rolePersonas` unset (or empty) AND no persona
  // mirror there is nothing to resolve — skip the Assignment parse entirely.
  const personas = rolePersonas
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
  // (7) Surface capability gate: the native contracts reject a merged
  // persona the runtime cannot honor ("fail loud, no silent degradation")
  // — merging would fail the start, so the persona is skipped instead and
  // the start proceeds unchanged (the contained degrade).
  if (surface === 'one-shot' ? provider.capabilities?.persona !== true : typeof provider.prepareContinuable !== 'function') {
    log(
      'debug',
      surface === 'one-shot'
        ? `subagent provider '${providerName}' lacks the persona capability — role persona for '${executeAs}' skipped (start proceeds unchanged)`
        : `subagent provider '${providerName}' does not support continuable children — role persona for '${executeAs}' skipped (the native continuable start fails loud its own way)`,
    )
    return request
  }
  // (8) Hit — merge into the native slot. dsh composes it as the scoped
  // `deployment:persona` section (SHADOWING the deployment persona for this
  // child), persists it in the child descriptor, and reapplies it on resume
  // (one-shot via the resolved provider request; continuable via the
  // manager's descriptor + composition).
  log('debug', `role persona delivered via the native subagent persona channel for role '${executeAs}' (${surface} start, source: ${persona.source === 'config' ? 'mstar Config' : 'harness-agents default'})`)
  return { ...request, persona: persona.text }
}

/** Best-effort human-readable message from an arbitrary thrown value (agent-flow `errorMessage` pattern). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function log(level: RolePersonaLogLevel, message: string): void {
  try {
    rolePersonaLogSink(level, message)
  } catch {
    // Never-throws invariant : a throwing log sink must not
    // escape the channel — the subagent start is never affected.
  }
}
