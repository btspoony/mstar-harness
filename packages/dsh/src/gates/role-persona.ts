/**
 * Role-persona delivery through the upstream Agent Preset selection — a
 * role-matched subagent start selects the preset the deployment declared for
 * that role (`Config.rolePresets` → `SubagentStartRequest.agentPreset`).
 *
 * Why not the persona slot: dsh 0.2.1 removed `SubagentStartRequest.persona`
 * (and the `start`/`startContinuable` pair) — `tool-subagent` rejects the old
 * `persona` config with "configure persona and tool plugins in an Agent Preset
 * and select it with agentPreset (spawn only)", and the continuation manager
 * composes a fresh child from `request.agentPreset` ALONE
 * (`applyChildComposition`: explicit selection mounts the named preset,
 * omission joins the parent's live generation). Persona text is therefore
 * owned by a preset row (`@deepseek-ai/dsh-persona`), and this channel owns
 * only the role → preset SELECTION. The selected preset owns the child's whole
 * composition (persona, tools, skills) — it is never a persona-only patch, so
 * the deployment declares one complete preset per role and lists its id here.
 *
 * Interception seam: the cordis service-read waterfall
 * (`Events['internal/get']`, `@deepseek-ai/cordis` 4.0.2
 * `lib/types/events.d.ts`) — the framework's documented interception hook
 * for values read through the context proxy. The listener wraps the
 * `subagents` service VALUE on read (a prototype-delegating wrapper whose
 * `startActivation` merges the role's preset into the spec before
 * delegating); the real `SubagentRuntime` object is never mutated — readers
 * of `ctx.subagents` (the tool-subagent reads it per call through a
 * plugin-fiber context) transparently receive the wrapper. The listener is
 * owned by the applying fiber (cordis listener effects), so an HMR fiber
 * swap unwinds and restores it like every other registration.
 *
 * `startActivation(spec)` is the ONE start surface in dsh 0.2.1 (local and
 * external children alike), so both delegation shapes — a one-shot run and a
 * continuable background child — are covered by the single merge.
 *
 * Role identity uses the engine Assignment header grammar — the SAME
 * parsers the dispatch gate uses (`assignmentHeaderRegion` +
 * `parseAssignmentFields`) — over the start request's prompt text (the
 * `ContentBlock[]` the child receives as its first user message).
 * `Config.rolePresets[executeAs]` is the channel's only payload source
 * (never gated on `roleMap` or on the fallbacks mounted state: delivery is
 * fallbacks-independent) and is closed over per apply in
 * `registerRolePersonaChannel`. `roleMap` is a taxonomy bridge for logging +
 * future rule-driven interop only.
 *
 * Capability gates (upstream `tool-subagent` `assertProvider`): independent
 * preset selection requires a provider whose
 * `SubagentCapabilities.agentPreset` is true and whose
 * `inheritsParentContext` is false — "provider does not support independent
 * agent preset selection" otherwise. The selection also requires the
 * `agentPresets` service (the web-app and headless bundles mount
 * `@deepseek-ai/dsh-agent-preset-registry`; a composition without it cannot
 * mount a preset and dsh fails loud `PRESET_UNAVAILABLE`). Gate miss → the
 * selection is skipped with one contained debug log and the start proceeds
 * unchanged — the contained degrade, never a failed dispatch.
 *
 * Precedence: a request that already carries `agentPreset` (the tool's
 * configured default or the model's own `agent_preset` choice) is caller
 * intent and WINS — the channel fills the slot only when it is free.
 *
 * Dispatch-role gate: the same wrapper first normalizes the role declaration
 * (`Config.roleGate`, default `hard`) — an explicit `Execute as:` / `Act as:`
 * / `Role:` field or a backticked/bold already-declared role id is rewritten
 * into the canonical Assignment header, and only a start with NO reliable
 * declaration is refused. The rewritten request is what the preset merge and
 * the runtime receive. The canonical/pass judgement reads the SAME raw header
 * the preset merge parses — fence masking only decides which text may supply a
 * repair candidate — so a gate pass never means the merge sees no role. The
 * gate exempts non-harness projects (judged at the
 * child's EFFECTIVE start directory, so an omitted/relative `cwd` inherits the
 * parent's), canonical prompts, `agentPreset` requests and unknown providers;
 * its refusal is raised outside the contained-degradation catch below. The
 * configured mode is read LIVE per start from the Loader's `volatile` field,
 * so a dsh plugin-settings save applies on the next start without a remount.
 *
 * Degradation (the preset merge never throws before delegating — contained
 * like the dispatch gate's degrade path): unparseable prompt / role without a
 * configured preset → silent pass-through; a throwing merge aborts the
 * merge only — the ORIGINAL request reaches the service and the start is
 * never affected. The role gate's own reads are contained the same way; only
 * its configured `hard` verdict refuses a start.
 *
 * Seam probe (apply-time, observation only): a future cordis rename/removal
 * of `internal/get` would stop the listener from ever firing — delivery
 * would silently degrade to the raw service with no runtime signal.
 * {@link probeRolePersonaSeam} runs ONCE per apply right after
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
 * Configured preset ids are validated ONCE per apply as soon as the
 * `agentPresets` service resolves: an id the roster does not declare is
 * reported with ONE warning (the deployment's own `agent-preset/not-found`
 * would otherwise surface only when a role-matched child fails to start) and
 * is left configured — a later-mounting row may still declare it.
 *
 * Module boundary: no barrel — the entry imports this module by explicit
 * relative path and re-exports the public names verbatim, EXCEPT the four
 * probe exports (`PERSONA_SEAM_EVENT`, `ROLE_PERSONA_WRAPPER_BRAND`,
 * `evaluateSeamProbe`, `probeRolePersonaSeam`) and the role-gate contract
 * (`RoleGateMode`, `RoleGateEvidence`, `RoleGateInput`, `RoleGateDecision`,
 * `evaluateRoleGate`, `rewritePromptWithExecuteAs`), which are deliberately
 * NOT re-exported from the entry: the frozen entry surface keeps the probe
 * and the pure gate decision observable only through this module (tests
 * import it directly; the shipped bundle exports no probe symbol). No
 * dsh-subagent dependency: the
 * runtime surface is consumed structurally (same pattern as the probe's
 * `LoaderEntryView` and T2's `fallbacks-structural.ts`).
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the registry's `Context` augmentation (the `agentPresets`
// service name) without a runtime dependency — the plugin consumes the host
// service structurally.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { assignmentHeaderRegion, parseAssignmentFields, resolveHarnessDir } from '@mstar-harness/engine'
import {
  isLiveConfigRef,
  packagedAgentsDir,
  sessionCwdOf,
  type Config,
  type LiveConfigRef,
} from './_shared.ts'
import { ROLE_ID_PATTERN, subagentRoleIds } from './agent-personas.ts'

/** Logger label for the role-persona channel (dsh logger naming: `<scope>/<subject>`). */
export const ROLE_PERSONA_LOGGER = 'mstar/role-persona'

/** The cordis service name the channel intercepts (`ctx.subagents`). */
const SUBAGENTS_SERVICE = 'subagents'

/** The cordis service name a selected preset is resolved from (`ctx.agentPresets`). */
const AGENT_PRESETS_SERVICE = 'agentPresets'

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
 * only: `prompt` is the role-extraction source, `agentPreset` is the
 * selection target). The wrapper forwards the request object SPREAD, so
 * every non-consumed field (`cwd`, `label`, `parent`, `signal`,
 * `agentOptions`, …) reaches the service unchanged at runtime; the view
 * types only what this module reads.
 */
export interface SubagentStartRequestView {
  /** Content delivered as the child's user message (the Assignment carrier). */
  readonly prompt: readonly PromptBlockView[]
  /** Optional preset already selected by the tool or the model — caller intent wins. */
  readonly agentPreset?: string
  /**
   * Initial child directory as requested (the role gate resolves the child's
   * EFFECTIVE start directory from it: absolute as-is, relative against
   * {@link parent}, omitted = the parent's own directory).
   */
  readonly cwd?: string
  /**
   * The spawning agent (`SubagentStartRequest.parent`). Its session cwd is the
   * default child directory, exactly what the runtime's own `resolveDirectory`
   * inherits when `cwd` is omitted.
   */
  readonly parent?: unknown
}

/**
 * Structural view of the activation spec the channel merges into
 * (`@deepseek-ai/dsh-subagent` `SubagentActivationSpec` — consumed fields
 * only). The wrapper forwards the spec object SPREAD, so every
 * non-consumed field (`label`, `childId`, `signal`, `delivery`) reaches the
 * service unchanged at runtime; the view types only what this module reads.
 */
export interface SubagentActivationSpecView {
  /** Registered backend the child is started on (the capability-gate key). */
  readonly provider: string
  /** The delegation request (the merge target). */
  readonly request: SubagentStartRequestView
}

/**
 * Structural view of the capability set the channel gates on
 * (`@deepseek-ai/dsh-subagent` `SubagentCapabilities` — only `agentPreset`
 * is consumed: an independent selection requires it, and the runtime rejects
 * one for a provider without it).
 */
interface SubagentCapabilitiesView {
  readonly agentPreset?: boolean
}

/**
 * Structural view of one registered provider (`SubagentProvider` consumed
 * surface). A provider that inherits its parent's conversation cannot accept
 * an independent composition (upstream `tool-subagent` rejects the pair
 * `!capabilities.agentPreset || inheritsParentContext`), so the selection is
 * skipped for it.
 */
interface SubagentProviderView {
  readonly capabilities: SubagentCapabilitiesView
  readonly inheritsParentContext?: boolean
}

/**
 * Structural view of the `subagents` runtime the wrapper delegates to
 * (`@deepseek-ai/dsh-subagent` `SubagentRuntime` consumed surface:
 * capability reads + the one start call). `startActivation` returns the
 * service's own promise — opaque here, forwarded untouched.
 */
export interface SubagentsServiceView {
  /** Look up a provider by name (the capability-gate read). */
  getProvider(name: string): SubagentProviderView | undefined
  /** Establish one child on the named provider (the delegated start). */
  startActivation(spec: SubagentActivationSpecView): unknown
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
 * Wrapper identity cache — one wrapper per (service value, per-apply channel
 * state). Repeated reads of the same service under the same registration agree
 * on one wrapper; an HMR re-apply creates a NEW state object, so the identity
 * check re-wraps with the fresh binding (the old fiber's listener is gone by
 * then — its wrapper is unreachable).
 */
const wrapperCache = new WeakMap<object, { state: ChannelState; wrapper: unknown }>()

/**
 * Per-apply channel state — never a process global (two applies must not
 * cross-talk). It carries the once-per-apply latch for the missing-registry
 * debug; the registry itself is read per start through
 * {@link agentPresetsService} (an accessor read, which cordis permits without
 * an injection), so a row that mounts later is picked up without a re-apply.
 */
interface ChannelState {
  /** Once-per-apply latch for the missing-registry debug. */
  registryAbsentLogged: boolean
  /** Once-per-apply latch for the role gate's `warn` advisory. */
  roleGateWarned: boolean
}

/**
 * Read the OPTIONAL `agentPresets` registry for one start — through the
 * accessor (`ctx.get`), not a service property: cordis refuses to READ a
 * service the reading context does not inject ("cannot get property
 * `agentPresets` without inject"), while the accessor is the documented
 * structural read for a host service this package does not inject (house
 * pattern: `fallbacks-probe.ts`, `plan-mode-bridge.ts`). A composition
 * without the registry row (the base and SDK bundles mount none) answers
 * `undefined`, and the selection is skipped.
 * @param ctx - the registrant context the wrapper was created for.
 * @returns the registry, or `undefined` when this composition mounts none.
 */
function agentPresetsService(ctx: Context): Context['agentPresets'] | undefined {
  return ctx.get('agentPresets')
}

/**
 * Live reader for `Config.roleGate`. The Loader hands a `volatile` field to
 * `apply` as an identity-stable `{ get }` reference whose snapshot it
 * re-commits on every settings save, so reading it per start is what makes a
 * saved edit take effect on the NEXT start without a reload. A plain value (a
 * host that resolves the schema without the volatile protocol) is read as-is;
 * an unrecognized value falls back to the shipped default.
 *
 * @param value - the configured field (a live reference or a plain value).
 * @returns a reader returning the CURRENT gate mode.
 */
function roleGateReader(value: Config['roleGate'] | LiveConfigRef): () => RoleGateMode {
  return () => {
    const current = isLiveConfigRef(value) ? value.get() : value
    return current === 'off' || current === 'warn' || current === 'hard' ? current : 'hard'
  }
}

/**
 * Register the role-preset channel on the plugin's context: an
 * `internal/get` waterfall listener (the cordis service-read interception
 * hook) that wraps `ctx.subagents` reads. The listener is owned by the
 * applying fiber — an HMR fiber swap unwinds it (reads return the raw
 * service again) and a re-apply restores it.
 *
 * Composition-order independence (`prepend`): the SAME seam may be wrapped by
 * another layer, and each wrapper only fills a slot that is still free — so
 * whichever wrapper runs FIRST owns it. A waterfall runs listeners
 * outermost-first, and `prepend` registers this one at the front, so the
 * harness channel is outermost on ANY row order: the default profile mounts
 * the mstar row first, while a re-ordered profile (or a re-applied plugin row)
 * mounts it last. That matters because an operator's `rolePresets` are the
 * harness's authoritative role identity — the channel must not lose the slot
 * to whichever layer happened to apply first (the previous competing layer,
 * `dsh-llm-fallbacks`, filled the removed native `persona` slot and can no
 * longer reach this one). A role the harness maps to no preset still falls
 * through to the other layer (the outermost wrapper delegates the caller's own
 * request object on every skip path), and reads of every other service are
 * returned untouched.
 *
 * Never throws: the wrap step is contained — on any internal error the read
 * returns the UNWRAPPED service value (delivery degrades, the runtime is
 * untouched).
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param config - validated plugin configuration (`rolePresets` is the
 *   only payload source; `roleMap` is never consulted for the selection).
 */
export function registerRolePersonaChannel(ctx: Context, config: Config): void {
  // The preset mapping is closed over from THIS apply's validated Config —
  // never a process global (two applies must not cross-talk), and the
  // wrapper's `startActivation` signature stays the service's own (the
  // closure carries the binding).
  const rolePresets = config.rolePresets
  // Dispatch-role gate: the configured mode and the declared role-id set the
  // repair tier reads. Declared = the configured presets' role keys ∪ the
  // packaged mirror's subagent shell stems (the SAME taxonomy the fallbacks
  // advisory derives — never a hard-coded role list). The mode is read LIVE
  // per start (see {@link roleGateReader}): the settings form edits a volatile
  // field, and a save must take effect on the next start without a remount.
  const readRoleGate = roleGateReader(config.roleGate)
  const declaredRoleIds = new Set<string>([
    ...Object.keys(rolePresets ?? {}),
    ...subagentRoleIds(packagedAgentsDir() ?? ''),
  ])
  const state: ChannelState = { registryAbsentLogged: false, roleGateWarned: false }
  // Waterfall listener: `(ctx, name, error, next)` — calling `next()` runs
  // the remaining chain (finally the built-in resolution) and its return is
  // the value readers receive. Dispatch carries no `this`, so no context
  // filter applies: the hook sees service reads from every fiber, exactly
  // the reachability the tool-subagent's per-call reads need.
  ctx.on(PERSONA_SEAM_EVENT, (_readCtx, name, _error, next) => {
    const value: unknown = next()
    if (name !== SUBAGENTS_SERVICE) return value
    try {
      return wrapSubagentsService(value, rolePresets, state, ctx, readRoleGate, declaredRoleIds)
    } catch (error) {
      // Contained: an internal wrap error degrades to the raw service —
      // delivery is skipped, the runtime is untouched.
      log('warn', `role preset channel degraded to pass-through (subagent starts unaffected): ${errorMessage(error)}`)
      return value
    }
  }, { prepend: true })
  bindAgentPresetRegistry(ctx, rolePresets)
}

/**
 * Bind the OPTIONAL `agentPresets` registry for this apply and validate the
 * configured ids once it resolves.
 *
 * The binding is an injection, not a property read: cordis refuses to read a
 * service the reading context does not inject ("cannot get property
 * \`agentPresets\` without inject"), and the channel's wrapper runs on a
 * service read from an arbitrary fiber — so the registry is captured here, in
 * the one context that owns the injection, and consulted as plain state at
 * start time. A composition without the registry row (the base and SDK
 * bundles mount none) simply never resolves it: the ids stay configured and
 * the start-time gate logs one debug for the apply.
 *
 * Validation is advisory: one warning per id the roster does not declare
 * (otherwise a typo would surface only as a failed child start). The mapping
 * itself is untouched — a later-mounting row that declares the id still works.
 *
 * @param ctx - the plugin's registrant context (the injection owner).
 * @param state - this apply's channel state (receives the resolved service).
 * @param rolePresets - the configured role → preset mapping, when any.
 */
function bindAgentPresetRegistry(ctx: Context, rolePresets: Config['rolePresets']): void {
  const validate = async (presets: Context['agentPresets']): Promise<void> => {
    for (const [role, presetId] of Object.entries(rolePresets ?? {})) {
      try {
        await presets.readDocument(presetId)
      } catch (error) {
        log('warn', `rolePresets["${role}"] = "${presetId}" is not a deployed agent preset (${errorMessage(error)}) — a role-matched delegation for that role will fail loud at start; declare the preset or remove the mapping`)
      }
    }
  }
  if (rolePresets === undefined || Object.keys(rolePresets).length === 0) return
  try {
    ctx.inject([AGENT_PRESETS_SERVICE], (sctx) => {
      void validate(sctx.agentPresets).catch(() => {})
    })
  } catch (error) {
    // Contained: validation is advisory — a context that cannot register the
    // optional injection must not fail apply (the start-time gate then
    // reports the registry as absent).
    log('debug', `role preset id validation unavailable (${errorMessage(error)})`)
  }
}

/** The fail-loud warn (ONE per apply, `ok === false`) — the reason is appended. */
const SEAM_WARN = `role persona channel not installed — cordis '${PERSONA_SEAM_EVENT}' seam missing or unrecognized (role presets will not be selected for subagent starts)`

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
 *    the exact read path the per-call `ctx.subagents.startActivation(...)`
 *    dispatch takes. NEVER `ctx.get('subagents')`: the accessor reads the
 *    service store directly and bypasses the waterfall, which would
 *    false-warn `seam-absent` on every healthy boot;
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
      // Unchecked cast: the seam is asserted by the breach itself, and the
      // resolved value is classified structurally below.
      const host = ctx as unknown as { subagents?: unknown }
      value = host.subagents
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
 * Dispatch-role gate (`Config.roleGate`) — normalize an explicit role
 * declaration into the canonical Assignment header, refuse only when there is
 * none. Role identity is prompt-only on dsh, so a delegation that says
 * "Role: `fullstack-dev`" in prose binds nothing and both role consumers
 * (the fallbacks persona chain and `rolePresets`) silently see a role-less
 * child. The gate runs BEFORE the preset merge in the same wrapper, so the
 * rewritten request is what the inner merge and the runtime receive.
 *
 * Never a guess: only an explicit field line (`Execute as:` / `Act as:` /
 * `Role:`) or a backticked/bold token that is an ALREADY-DECLARED role id is
 * a repair candidate. Free prose ("You are an architect doing…") is never
 * mined, and two distinct candidates at the same or different tiers are
 * ambiguous — an ambiguous prompt is not repaired (it falls to the mode).
 */

/** Role-gate mode (`Config.roleGate`). */
export type RoleGateMode = 'off' | 'warn' | 'hard'

/** Which tier identified a repair candidate (`field` outranks `token`). */
export type RoleGateEvidence = 'field' | 'token'

/** Inputs of the pure role-gate decision ({@link evaluateRoleGate}). */
export interface RoleGateInput {
  /** The start request under gate (prompt + `agentPreset` + `cwd`). */
  readonly request: SubagentStartRequestView
  /** Configured mode. */
  readonly mode: RoleGateMode
  /**
   * The child's EFFECTIVE start directory (named in the refusal message; the
   * harness-project test is pre-resolved by the caller from this same value).
   */
  readonly cwd?: string
  /** `cwd` resolves a `{HARNESS_DIR}` — false exempts the start from the gate. */
  readonly harnessProject: boolean
  /** The runtime declares `provider`; an unknown provider fails loud its own way (`NO_PROVIDER`). */
  readonly providerKnown: boolean
  /** Declared role ids: `Config.rolePresets` keys ∪ packaged mirror shell stems. */
  readonly declaredRoleIds: ReadonlySet<string>
}

/**
 * The gate's verdict:
 * - `pass` — silent pass-through (caller intent, canonical header, non-harness
 *   project, unknown provider, `off`, or the wrapper's contained fail-open);
 * - `repair` — the request carries a rewritten prompt (canonical header);
 * - `warn` — no reliable declaration (or an ambiguous one), advisory mode;
 * - `refuse` — no reliable declaration (or an ambiguous one), `hard` mode
 *   (throws before delegating).
 */
export type RoleGateDecision =
  | { readonly kind: 'pass'; readonly reason: 'agent-preset' | 'canonical' | 'non-harness' | 'provider-unknown' | 'off' | 'degraded' }
  | { readonly kind: 'repair'; readonly request: SubagentStartRequestView; readonly roleId: string; readonly evidence: RoleGateEvidence }
  | { readonly kind: 'warn'; readonly message: string }
  | { readonly kind: 'refuse'; readonly message: string }

/** Field labels whose value is a role declaration (case-insensitive). */
const ROLE_FIELD_LABELS: ReadonlySet<string> = new Set(['execute as', 'act as', 'role'])

/** Bold field line (`**Execute as**: <value>`, optional list bullet). */
const BOLD_FIELD_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?\*\*\s*([^*:]+?)\s*\*\*\s*:\s*(.*)$/
/** Plain field line (`Role: <value>`, optional list bullet) — same grammar as the engine parser. */
const PLAIN_FIELD_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/

/** A prompt that OPENS with an Assignment section (heading + its blank-line run). */
const OPEN_ASSIGNMENT_HEADING_RE = /^([ \t]*#{2}[ \t]+Assignment[ \t]*)(\r?\n(?:[ \t]*\r?\n)*)?/

/** An existing `Execute as` field line (bold or plain label, case-insensitive, optional list bullet). */
const EXECUTE_AS_FIELD_LINE_RE = /^([ \t]*(?:[-*][ \t]+)?)(?:\*\*\s*Execute as\s*\*\*\s*:|Execute as\s*:)[ \t]*(.*)$/gim

/**
 * Evaluate the dispatch-role gate for one start — PURE (the harness-project
 * test is pre-resolved by the caller), first match wins:
 *
 * 1. `agentPreset` already set → pass (caller intent wins, silent).
 * 2. header already carries a USABLE `Execute as` value → pass (idempotent,
 *    silent; read from the RAW header, the binding seam's own scope).
 * 3. not a harness project → pass (a non-harness project never pays the gate).
 * 4. unknown provider → pass (the service fails loud its own way).
 * 5. exactly one distinct repair candidate (field tier or declared token) →
 *    repair the prompt; ambiguous or none → the configured mode
 *    (`off` silent, `warn` one advisory, `hard` refusal).
 *
 * @param input - the request, mode, pre-resolved harness/provider facts and
 *   the declared role-id set.
 * @returns the verdict described by {@link RoleGateDecision}.
 */
export function evaluateRoleGate(input: RoleGateInput): RoleGateDecision {
  const { request } = input
  // (1) An explicit selection is caller intent — never gated.
  if (request.agentPreset !== undefined) return { kind: 'pass', reason: 'agent-preset' }
  const text = promptText(request)
  // The CANDIDATE scan and the REWRITE read the fence-masked text: a quoted
  // example is never a declaration, and the scan and the rewrite cannot
  // disagree about where fences are. The READ below judges the raw header.
  const unfenced = maskFencedCodeBlocks(text)
  // (2) A USABLE canonical declaration is already in place — no rewrite
  // (byte-identical). This reads the RAW header, which is exactly the input
  // the binding seam downstream (`withRolePreset`) parses: judging the masked
  // header would pass a declaration the raw header never reaches (a fenced
  // `## Task` truncates it), and a "pass" would leave the child unbound. A
  // wrapped/odd `Execute as` value is not canonical: the downstream parsers
  // keep it raw, so it binds nothing and falls through to the repair tiers
  // below (replaced in place, never duplicated).
  //
  // A FULLY fenced canonical-looking declaration therefore PASSES: the header
  // slice is line-based and fence-unaware, so `withRolePreset` parses that
  // quoted line as the declaration and binds its role. The gate returns the
  // verdict the seam actually reaches instead of a "cleaner" one that
  // contradicts it; a rewrite would also silently edit quoted content.
  const headerExecuteAs = parseAssignmentFields(assignmentHeaderRegion(text)).executeAs
  if (headerExecuteAs !== undefined && isCanonicalExecuteAs(headerExecuteAs)) {
    return { kind: 'pass', reason: 'canonical' }
  }
  // (3) Non-harness projects are exempt (the caller resolved the child's
  // EFFECTIVE start directory, so an omitted/relative cwd is decided by the
  // directory the child inherits, never treated as non-harness blindly).
  if (!input.harnessProject) return { kind: 'pass', reason: 'non-harness' }
  // (4) The runtime's own `NO_PROVIDER` failure must not be shadowed.
  if (!input.providerKnown) return { kind: 'pass', reason: 'provider-unknown' }
  // (5) Repair candidates: exactly one distinct value across both tiers.
  const { fields, tokens } = roleCandidates(unfenced, input.declaredRoleIds)
  const candidates = [...new Set([...fields, ...tokens])]
  if (fields.length <= 1 && tokens.length <= 1 && candidates.length === 1) {
    const roleId = candidates[0]!
    return {
      kind: 'repair',
      roleId,
      evidence: fields.length === 1 ? 'field' : 'token',
      request: repairRequest(request, roleId),
    }
  }
  // (6) No reliable declaration (zero candidates) or an ambiguous one (two
  // or more distinct) → the configured mode, with the cause-specific text.
  if (input.mode === 'off') return { kind: 'pass', reason: 'off' }
  const message = declarationMessage(input.cwd, input.mode, candidates)
  if (input.mode === 'warn') return { kind: 'warn', message }
  return { kind: 'refuse', message }
}

/** The prompt text projection both the parser and the rewrite operate on (text blocks joined with newlines). */
function promptText(request: SubagentStartRequestView): string {
  return (request.prompt ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

/**
 * The directory the child will actually start in — the runtime's own
 * `resolveDirectory` rule (`dsh-subagent`): an absolute `cwd` is used as-is, a
 * relative one resolves against the parent's directory, an omitted one IS the
 * parent's directory. The parent directory is the spawning agent's session cwd
 * (the same structural read the plugin's workspace resolver uses), falling
 * back to the process cwd when the parent carries none. Treating an omitted
 * cwd as non-harness would exempt exactly the channel the gate exists for
 * (`subagent` / `spawn_teammate` omit it and inherit the parent directory).
 */
function effectiveStartDirectory(request: SubagentStartRequestView): string {
  const cwd = request.cwd
  if (cwd !== undefined && cwd.trim() !== '' && isAbsolute(cwd)) return resolve(cwd)
  const parentDir = sessionCwdOf(request.parent) ?? process.cwd()
  return cwd === undefined || cwd.trim() === '' ? resolve(parentDir) : resolve(parentDir, cwd)
}

/**
 * Whether one directory is a harness project: the engine resolver probes from
 * that directory and STOPS there (`workspaceRoot = cwd`) — the same boundary
 * the plugin's own workspace resolver uses. The probe start is absolutized
 * first: a relative `workspaceRoot` would anchor the boundary below the probe
 * start and null out an otherwise resolvable harness root.
 */
function isHarnessProject(directory: string): boolean {
  const abs = resolve(directory)
  return resolveHarnessDir(abs, { workspaceRoot: abs }) !== null
}

/**
 * Scan one prompt for repair candidates: field lines in the Assignment HEADER
 * region (the engine's header scope) and backticked/bold tokens anywhere that
 * are already-declared role ids. Returns the DISTINCT values per tier.
 *
 * @param unfenced - the prompt text ALREADY fence-masked (see
 *   {@link maskFencedCodeBlocks}): a quoted example is not a declaration, in
 *   either tier. The rewrite masks the same way, so the two agree.
 */
function roleCandidates(unfenced: string, declaredRoleIds: ReadonlySet<string>): { fields: string[]; tokens: string[] } {
  const fields = new Set<string>()
  for (const line of assignmentHeaderRegion(unfenced).split(/\r?\n/)) {
    const match = BOLD_FIELD_LINE_RE.exec(line) ?? PLAIN_FIELD_LINE_RE.exec(line)
    if (match === null || !ROLE_FIELD_LABELS.has(match[1]!.trim().toLowerCase())) continue
    const roleId = normalizeRoleFieldValue(match[2]!)
    if (roleId !== undefined) fields.add(roleId)
  }
  const tokens = new Set<string>()
  for (const match of unfenced.matchAll(/`([^`\n]+)`/g)) addDeclaredToken(tokens, match[1]!, declaredRoleIds)
  for (const match of unfenced.matchAll(/\*\*([^*\n]+)\*\*/g)) addDeclaredToken(tokens, match[1]!, declaredRoleIds)
  return { fields: [...fields], tokens: [...tokens] }
}

/**
 * Mask fenced code blocks for one prompt text — real Markdown fence rules: a
 * fence opens on a run of 3+ backticks or 3+ tildes, and closes only on the
 * SAME character with a run at least as long (a different character or a
 * shorter run is content, so a four-backtick fence is not closed by three).
 * An unterminated fence stays intact.
 *
 * A CRLF prompt keeps its `\r` in the split result, and `.` / `$` never match
 * past it — so the trailing carriage return is stripped for FENCE recognition
 * only. Without that, every line of a CRLF prompt fails the fence pattern and
 * masking degenerates to a no-op (a quoted `Execute as:` becomes a candidate).
 *
 * Every masked character becomes a space (the CR included), newlines are kept:
 * the result is character-position identical to the input, so the rewrite can
 * match on the masked text and splice into the original by the same offsets.
 */
function maskFencedCodeBlocks(text: string): string {
  const out: string[] = []
  let openChar: string | undefined
  let openRun = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
    if (openChar === undefined) {
      if (fence !== null) {
        openChar = fence[1]![0]
        openRun = fence[1]!.length
      }
      out.push(fence === null ? rawLine : ' '.repeat(rawLine.length))
      continue
    }
    const closes = fence !== null && fence[1]![0] === openChar && fence[1]!.length >= openRun && fence[2]!.trim() === ''
    if (closes) openChar = undefined
    out.push(' '.repeat(rawLine.length))
  }
  return out.join('\n')
}

/** Add one wrapped token when it is a declared role id (`inherit` is never a role). */
function addDeclaredToken(tokens: Set<string>, raw: string, declaredRoleIds: ReadonlySet<string>): void {
  const value = normalizeWrapped(raw) ?? raw.trim()
  if (ROLE_ID_PATTERN.test(value) && value !== 'inherit' && declaredRoleIds.has(value)) tokens.add(value)
}

/** A directly usable `Execute as` value: the role-id shape, or the explicit `inherit` intent. */
function isCanonicalExecuteAs(value: string): boolean {
  const trimmed = value.trim()
  return ROLE_ID_PATTERN.test(trimmed) || trimmed === 'inherit'
}

/** Trim ONE leading `@`, surrounding quotes or backticks; accept only the role-id shape (never `inherit`). */
function normalizeRoleFieldValue(raw: string): string | undefined {
  let value = raw.trim()
  if (value.startsWith('@')) value = value.slice(1).trim()
  value = normalizeWrapped(value) ?? value
  return ROLE_ID_PATTERN.test(value) && value !== 'inherit' ? value : undefined
}

/** Strip one matching pair of surrounding quotes or backticks (undefined when none). */
function normalizeWrapped(raw: string): string | undefined {
  const value = raw.trim()
  const match = /^(?:"([^"]*)"|'([^']*)'|`([^`]*)`)$/.exec(value)
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3] ?? '').trim()
}

/**
 * Rewrite one prompt with the canonical role declaration: every existing
 * (unusable) `Execute as` header line has its value replaced IN PLACE and its
 * label normalized to the canonical spelling — the parsers match the label
 * case-sensitively and bind the LAST field line, so replacing only the first
 * occurrence would leave a later broken line winning the read. An Assignment
 * section that OPENS the prompt gets `Execute as: <id>` as its first field
 * line, and any other prompt gets the canonical header block prepended. Every
 * character outside the repaired field lines is preserved. Fenced examples are
 * not field lines: the scan runs on the fence-masked text (same offsets as the
 * input), so a quoted `Execute as:` line is neither repaired nor shadowed —
 * and only a field line the RAW header reaches is repaired in place: one past
 * the raw header boundary (a fenced `## Task` truncates the header there)
 * binds nothing, so the canonical line is inserted after the `## Assignment`
 * heading instead, i.e. before the point the binding seam stops at.
 *
 * @param text - the prompt text to rewrite.
 * @param roleId - the repaired role id.
 * @returns the rewritten prompt text.
 */
export function rewritePromptWithExecuteAs(text: string, roleId: string): string {
  const headerLength = assignmentHeaderRegion(text).length
  const existing = [...assignmentHeaderRegion(maskFencedCodeBlocks(text)).matchAll(EXECUTE_AS_FIELD_LINE_RE)]
    .filter((field) => field.index! < headerLength)
  if (existing.length > 0) {
    // Splice from the END backwards so earlier offsets stay valid.
    let out = text
    for (const field of existing.reverse()) {
      const start = field.index + field[1]!.length
      const end = field.index + field[0]!.length
      out = `${out.slice(0, start)}Execute as: ${roleId}${out.slice(end)}`
    }
    return out
  }
  const match = OPEN_ASSIGNMENT_HEADING_RE.exec(text)
  if (match === null) return `## Assignment\n\nExecute as: ${roleId}\n\n${text}`
  const heading = match[1]!
  const blanks = match[2]
  const gap = blanks === undefined ? '\n\n' : blanks.endsWith('\n') ? blanks : `${blanks}\n`
  return `${heading}${gap}Execute as: ${roleId}\n${text.slice(match[0].length)}`
}

/**
 * Rewrite the request prompt over the SAME text range the candidate scan
 * reads — the text blocks joined with newlines. The rewritten text is carried
 * by the first text block and the remaining text blocks are folded into it:
 * rewriting only the first block would let a later block's old `Execute as`
 * line shadow the canonical one after the join. Non-text blocks stay in place.
 */
function repairRequest(request: SubagentStartRequestView, roleId: string): SubagentStartRequestView {
  const blocks = request.prompt ?? []
  const index = blocks.findIndex((block) => block.type === 'text')
  if (index < 0) return request
  const rewritten = rewritePromptWithExecuteAs(promptText(request), roleId)
  const prompt = blocks.flatMap((block, i) =>
    i === index ? [{ ...block, text: rewritten }] : block.type === 'text' ? [] : [block],
  )
  return { ...request, prompt }
}

/**
 * The `hard` refusal / `warn` advisory text: the actual cause (no declaration,
 * or more than one distinct one), the exact fix, and the mode-appropriate
 * recovery (a refusal with no recovery path is a defect; an advisory that
 * tells a warn-mode operator to switch to warn is noise).
 *
 * @param cwd - the child's effective start directory, when known.
 * @param mode - the configured mode (`hard` refusal or `warn` advisory).
 * @param candidates - the distinct repair candidates found (0 or >1).
 */
function declarationMessage(cwd: string | undefined, mode: 'warn' | 'hard', candidates: readonly string[]): string {
  const where = cwd === undefined ? 'the subagent start' : `the subagent start from cwd '${cwd}'`
  const cause =
    candidates.length > 1
      ? `declares ${candidates.length} distinct roles (${candidates.map((id) => `'${id}'`).join(', ')}) — exactly one role declaration is required`
      : `carries no role declaration — the delegation prompt is missing 'Execute as: <role-id>' in its Assignment header ` +
        `(no 'Execute as:' / 'Act as:' / 'Role:' field, and no declared role id in backticks or bold)`
  const fix =
    candidates.length > 1
      ? `Fix: keep exactly one role declaration — remove the extra 'Role:' / 'Act as:' / 'Execute as:' lines, or name the one role in 'Execute as: <role-id>' under the '## Assignment' heading.`
      : `Fix: add 'Execute as: <role-id>' under the '## Assignment' heading of the prompt.`
  const recovery =
    mode === 'warn'
      ? `The start proceeded under 'roleGate: warn'; set 'roleGate: off' to skip this advisory (a single explicit declaration is still normalized either way).`
      : `Escape hatch: set 'roleGate: warn' (one advisory, the start proceeds) or 'roleGate: off' (the refusal is skipped; a single explicit declaration is still normalized) in the dsh plugin config.`
  return `${where} ${cause}. ${fix} ${recovery}`
}

/**
 * Wrap one `ctx.subagents` read value: non-objects and non-runtime shapes
 * (the service is absent) pass through untouched. The wrapper is a
 * prototype-delegating object whose OWN `startActivation` merges the role's
 * preset into the spec before delegating — the underlying service object is
 * never mutated (no monkey-patching), and no surface the service does not
 * carry is invented (a runtime without `startActivation` keeps answering
 * `typeof service.startActivation === 'undefined'`). Identity is cached per
 * (service value, preset mapping, registrant context) so repeated reads
 * agree and re-applies re-bind.
 */
function wrapSubagentsService(
  value: unknown,
  rolePresets: Config['rolePresets'],
  state: ChannelState,
  ctx: Context,
  readRoleGate: () => RoleGateMode,
  declaredRoleIds: ReadonlySet<string>,
): unknown {
  if (typeof value !== 'object' || value === null) return value
  const service = value as SubagentsServiceView
  if (typeof service.startActivation !== 'function' || typeof service.getProvider !== 'function') return value
  const cached = wrapperCache.get(value)
  if (cached !== undefined && cached.state === state) return cached.wrapper
  const wrapper: SubagentsServiceView = Object.create(value)
  // Wrapper brand (seam-probe assertion target): a NON-enumerable symbol own
  // property — invisible to Object.keys/spread/JSON, so the wrapper's key
  // and spread surface stays identical to the service's (no behavior change).
  Object.defineProperty(wrapper, ROLE_PERSONA_WRAPPER_BRAND, { value: true, enumerable: false })
  wrapper.startActivation = (spec: SubagentActivationSpecView) => {
    // (1) Dispatch-role normalization BEFORE the preset merge: the rewritten
    // request is what the inner consumer (and the runtime) receives, so a
    // prose-declared role binds the same way a canonical header does. The
    // `hard` refusal is raised by the pure evaluator's verdict, OUTSIDE the
    // merge's contained-degradation catch below — a gate refusal must never
    // be swallowed. Only the gate's own reads are contained.
    let gated = spec
    let decision: RoleGateDecision
    try {
      // The child's EFFECTIVE start directory — an omitted/relative cwd
      // inherits the parent's directory, so it must be resolved BEFORE the
      // harness predicate (an omitted cwd is never a non-harness exemption).
      const startDirectory = effectiveStartDirectory(spec.request)
      decision = evaluateRoleGate({
        request: spec.request,
        mode: readRoleGate(),
        cwd: startDirectory,
        harnessProject: isHarnessProject(startDirectory),
        providerKnown: service.getProvider(spec.provider) !== undefined,
        declaredRoleIds,
      })
    } catch {
      // Contained fail-open: an unreadable request/provider is a pathological
      // caller object, and the merge below reads the same fields under its
      // own contained warn — the gate adds no second failure surface and no
      // second log line for it.
      decision = { kind: 'pass', reason: 'degraded' }
    }
    if (decision.kind === 'refuse') throw new Error(decision.message)
    if (decision.kind === 'warn') {
      if (!state.roleGateWarned) {
        state.roleGateWarned = true
        log('warn', decision.message)
      }
    }
    if (decision.kind === 'repair') {
      gated = { ...spec, request: decision.request }
      log(
        'debug',
        `role gate repaired the dispatch role '${decision.roleId}' from a ${decision.evidence === 'field' ? 'role field line' : 'declared role-id token'}; the canonical 'Execute as' header is what the child receives`,
      )
    }
    let merged = gated
    try {
      const mergedRequest = withRolePreset(agentPresetsService(ctx), state, service, spec.provider, gated.request, rolePresets)
      if (mergedRequest !== gated.request) merged = { ...gated, request: mergedRequest }
    } catch (error) {
      // Contained like the gate's degrade path: the merge aborts, the
      // ORIGINAL spec reaches the service — the start is never affected.
      log('warn', `role preset merge degraded to pass-through (subagent start unaffected): ${errorMessage(error)}`)
    }
    return service.startActivation(merged)
  }
  wrapperCache.set(value, { state, wrapper })
  return wrapper
}

/**
 * Resolve the role's preset for one start request and merge it into the
 * native `agentPreset` slot. Pure decision function — returns the request
 * UNCHANGED on every skip path (no-op is silent unless a debug log is
 * explicitly part of the contract below):
 *
 * 1. request already carries `agentPreset` → caller intent wins (silent).
 * 2. perf guard: no `rolePresets` (or none configured) → nothing to resolve
 *    (silent; `== null` covers schemastery's nullable pass-through).
 * 3. prompt carries no text → nothing to parse (silent).
 * 4. prompt is not Assignment-shaped (`Execute as` absent) → silent.
 * 5. the role has no configured preset → silent (only mapped roles select).
 * 6. provider unknown → silent (the service fails loud its own way —
 *    `NO_PROVIDER` — the channel must not shadow that).
 * 7. capability gate → one debug log, request unchanged — selecting a
 *    preset the runtime would reject is never acceptable: the provider must
 *    support an independent selection (`capabilities.agentPreset`) and must
 *    not inherit its parent's conversation.
 * 8. the registry is not mounted → one debug log per APPLY (latch) — dsh
 *    fails loud `PRESET_UNAVAILABLE` for a selection it cannot mount.
 * 9. hit → merge (one debug log naming the role and the preset).
 */
function withRolePreset(
  presets: Context['agentPresets'] | undefined,
  state: ChannelState,
  service: SubagentsServiceView,
  providerName: string,
  request: SubagentStartRequestView,
  rolePresets: Config['rolePresets'],
): SubagentStartRequestView {
  // (1) An explicit selection (tool default or the model's own choice) wins
  // — mstar never overrides caller intent.
  if (request.agentPreset !== undefined) return request
  // (2) Perf guard: with no mapping there is nothing to resolve — skip the
  // Assignment parse entirely.
  if (rolePresets == null || Object.keys(rolePresets).length === 0) return request
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
  // (5) Only a mapped role selects a preset (an empty mapping value is
  // treated as unmapped).
  const presetId = rolePresets[executeAs]
  if (presetId === undefined || presetId.trim().length === 0) return request
  // (6) Provider unknown → silent: `startActivation` fails loud its own way
  // (`NO_PROVIDER`), and the channel must not shadow that contract.
  const provider = service.getProvider(providerName)
  if (provider === undefined) return request
  // (7) Capability gate: an independent selection needs provider support and
  // a provider that does not inherit its parent's conversation (upstream
  // rejects the pair).
  if (provider.capabilities?.agentPreset !== true || provider.inheritsParentContext === true) {
    log(
      'debug',
      `subagent provider '${providerName}' does not support independent preset selection — role preset for '${executeAs}' skipped (start proceeds unchanged)`,
    )
    return request
  }
  // (8) The selection is only usable where the registry is mounted.
  if (presets === undefined) {
    if (!state.registryAbsentLogged) {
      state.registryAbsentLogged = true
      log('debug', `role preset selection skipped: the '${AGENT_PRESETS_SERVICE}' service is not mounted in this composition (the web and headless bundles mount @deepseek-ai/dsh-agent-preset-registry)`)
    }
    return request
  }
  // (9) Hit — merge into the native selection slot. dsh mounts the named
  // preset as the child's composition (persona, tools and skills), records
  // the selection in the child's log, and replays it on cold resume.
  log('debug', `role preset delivered through the native subagent preset channel for role '${executeAs}' → preset '${presetId}' (provider: ${providerName})`)
  return { ...request, agentPreset: presetId }
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
