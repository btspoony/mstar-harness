/**
 * Shared REAL-composition boot for `@mstar-harness/dsh` tests (plan Task 2
 * pattern, extended for the Task 3 status gate): boots the REAL-composition
 * app by mounting the seam rows directly with `ctx.plugin` in the exact
 * order the dsh app composes them (skill → system-prompt → tools → commands
 * → mstar), applying the plugin Config through the shipping schemastery
 * validation — entry/config semantics and fiber mounting are cordis's own
 * `ctx.plugin` path, with no `@cordisjs/plugin-loader` involved (the plugin
 * bundle carries no bare `cordis` dependency; only `@deepseek-ai/cordis`).
 *
 * Seam boundary: dev-time the dsh seam packages resolve from the npm registry
 * (into repo-root `node_modules/@deepseek-ai/`), but this suite deliberately drives the fs
 * intent waterfalls with a minimal typed harness — the same `ctx.waterfall`
 * dispatch the real `@deepseek-ai/dsh-tool-fs` write/edit tools perform
 * (`ctx.waterfall('fs/write-intent', target, exec, () => undefined)`).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { load as parseYaml } from 'js-yaml'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { JobDoneListener, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LoaderEntryView } from '../src/gates/fallbacks-probe.ts'
import type { SubagentsServiceView, ContinuableStartSpecView } from '../src/gates/role-persona.ts'
import * as plugin from '../src/index.ts'

/**
 * Bun (JavaScriptCore) compatibility shim for the REAL dsh seam packages.
 *
 * The real packages' lossless-JSON guards (dsh-session `snapshotJsonValue`,
 * dsh-tools schema validation) detect intrinsic prototypes by comparing
 * `Function.prototype.toString` against V8's exact `function Object() { [native code] }`
 * format. JavaScriptCore (Bun) prints native functions with newlines
 * (`function Object() {\n    [native code]\n}`), so under Bun every plain
 * object is rejected as non-intrinsic and tool results/schemas fail
 * materialization. This normalizes the native-code format to the V8 spelling
 * the real packages compare against — test-runtime only (dsh hosts run Node).
 */
{
  const intrinsicToString = Function.prototype.toString
  Function.prototype.toString = function toStringCompat(this: Function): string {
    const rendered = intrinsicToString.call(this)
    return rendered.includes('[native code]')
      ? `function ${this.name || 'anonymous'}() { [native code] }`
      : rendered
  }
}

/**
 * Minimal in-memory `loader` service for the composition boot (plan
 * `20260814-dsh-fallbacks-integration` Task 1 — Step 5 `inject: ['loader']`):
 * the mstar plugin's top-level `inject` now requires the `loader` service
 * before apply (the real dsh app always boots the profile loader first —
 * plugin-inventory precedent), so the harness mounts a structural fake that
 * answers `entries()` with a test-drivable entry list — the ONE contract the
 * Task 1 probe consumes (`fallbacksMounted` loader-entries fallback).
 * Mounted BEFORE the plugin row in every boot composition.
 */
export class FakeLoaderRegistry extends Service {
  /** Test-drivable entry list (the loader `EntryTree.entries()` contract). */
  entriesList: LoaderEntryView[] = []

  constructor(ctx: Context) {
    super(ctx, 'loader')
  }

  *entries(): Generator<LoaderEntryView> {
    yield* this.entriesList
  }
}

/**
 * Minimal in-memory `jobs` service for the settle-pairing tests (plan
 * `20260811-panel-f4-timeliness` Task 1 — Step 1 seam probe): implements the
 * ONE contract the plugin consumes — `onJobDone(listener)` with the upstream
 * `JobDoneListener` signature `(snapshot, owner)` — and lets the test drive
 * terminal snapshots through {@link fireDone}. Mounted as the
 * `@deepseek-ai/dsh-jobs-fake` module row (`bootApp({ jobsService: 'fake' })`)
 * so the plugin's REAL `ctx.inject(['jobs'])` wiring registers against it —
 * the full Loader → apply → inject → onJobDone composition under test,
 * without the heavy real registry (dsh-jobs-local + dsh-agent + a live
 * registered agent). The upstream snapshot contract (terminal statuses,
 * startedAt/finishedAt) is verified in the spec fixtures against the
 * `@deepseek-ai/dsh-jobs` types.
 */
export class FakeJobRegistry extends Service {
  private listener: JobDoneListener | undefined

  constructor(ctx: Context) {
    super(ctx, 'jobs')
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  /** Test driver: fire a terminal snapshot through the registered listener. */
  fireDone(snapshot: JobSnapshot, owner?: Agent): void {
    const listener = this.listener
    if (listener !== undefined) void listener(snapshot, owner)
  }
}

/**
 * Structural `subagent/start` payload (the advisory decision-point
 * listener's shape — the payload itself is no longer consumed by the
 * plugin; the event drives the one-pass advisory latch in tests).
 */
export interface SubagentStartPayload {
  /** Unique identity shared with the paired terminal event. */
  readonly runId: unknown
  /** Provider name recorded when the child was first created. */
  readonly provider: string
  /** The child agent's id. */
  readonly id: string
  /** Snapshot of whether the run's local agent was present when start fulfilled. */
  readonly local: boolean
}

/**
 * Recording subagent provider for the NATIVE persona-channel tests (plan
 * `20260831-dsh-alpha2-optional-fallbacks` Task 3): registers on the REAL
 * `@deepseek-ai/dsh-subagent` runtime and records the RESOLVED request each
 * `start` receives — after the channel's persona merge and capability gate.
 * The one-shot run handle is the minimal contract `observeRun` consumes
 * (`id`, `localAgent`, `result`); it resolves `completed` with no output so
 * the lifecycle pair emits and settles without fixtures.
 *
 * Continuable support is opt-in (`continuable: true`): the provider then
 * carries `prepareContinuable` (the NATIVE continuable gate — the runtime
 * rejects continuable starts loud without it) and records each prepared
 * request. Without the option the provider is one-shot-only, which is how
 * the continuable gate's skip branch is exercised.
 */
export class FakeSubagentProvider {
  /** Unique registry name (the `SubagentProvider.name` contract). */
  readonly name: string
  /** Start-time capabilities; only `persona` is test-drivable. */
  readonly capabilities = {
    agentOptions: false,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  }
  /** Descriptive-only flag (`SubagentProvider.inheritsParentContext`). */
  readonly inheritsParentContext = false
  /** The resolved requests, in start order (post-merge, post-gate). */
  readonly starts: Array<{ request: { persona?: string; descriptor?: { provider?: string; mode?: string } } }> = []
  /** Continuable-creation requests, in order (post-merge — the manager's detached creation call). */
  readonly continuablePrepares: unknown[] = []
  /** Whether the provider declares continuable-creation support. */
  readonly continuable: boolean
  /**
   * The detached continuable-creation hook (`SubagentProvider.prepareContinuable`
   * contract) — present ONLY when `continuable: true` (its presence is the
   * NATIVE continuable gate; the runtime rejects continuable starts loud
   * without it). Records the request and resolves an empty creation spec
   * (the manager consumes only `seed` before handing off to `agents.create`).
   */
  prepareContinuable: ((request: unknown) => Promise<Record<string, never>>) | undefined = undefined

  constructor(name: string, options: { personaCapability?: boolean; continuable?: boolean } = {}) {
    this.name = name
    this.capabilities.persona = options.personaCapability ?? false
    this.continuable = options.continuable ?? false
    if (this.continuable) {
      this.prepareContinuable = (request: unknown) => {
        this.continuablePrepares.push(request)
        return Promise.resolve({})
      }
    }
  }
  /**
   * Record the resolved request and resolve a settled run (the provider
   * contract: `provider.start(resolved)` — ONE argument, the request with
   * the service's `descriptor` already attached).
   */
  start(request: { persona?: string; descriptor?: { provider?: string; mode?: string } }): unknown {
    this.starts.push({ request })
    const id = SessionId(`fake-run-${this.starts.length}`)
    return {
      id,
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
      dispose: () => Promise.resolve(),
    }
  }
}

/**
 * Start one run through the NATIVE channel: `ctx.inject(['subagents'])`
 * runs in a plugin-fiber context, so the `ctx.subagents` read goes through
 * the cordis context proxy (plugin fibers carry a runtime) and reaches the
 * channel's `internal/get` wrapper — the same read path the real
 * tool-subagent's per-call `runtimeCtx.subagents.start(...)` /
 * `.startContinuable(...)` takes.
 */
export function startViaNativeChannel(
  app: BootResult,
  providerName: string,
  request: Parameters<SubagentsServiceView['start']>[1],
): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  void app.ctx.inject(['subagents'], (sctx) => {
    const service = sctx.subagents as unknown as SubagentsServiceView | undefined
    if (service === undefined) {
      reject(new Error('subagents service unavailable in the inject scope'))
      return
    }
    Promise.resolve(service.start(providerName, request)).then(resolve, reject)
  })
  return promise
}
/**
 * Start one CONTINUABLE child through the NATIVE channel: the same plugin-
 * fiber read path as {@link startViaNativeChannel}, calling the wrapper's
 * own `startContinuable` — the surface the real tool-subagent's
 * `backgroundMode: 'continuable'` background run takes
 * (`runtimeCtx.subagents.startContinuable({ provider, label, request, signal })`).
 */
export function startContinuableViaNativeChannel(
  app: BootResult,
  spec: ContinuableStartSpecView,
): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  void app.ctx.inject(['subagents'], (sctx) => {
    const service = sctx.subagents as unknown as SubagentsServiceView | undefined
    if (service === undefined) {
      reject(new Error('subagents service unavailable in the inject scope'))
      return
    }
    Promise.resolve(service.startContinuable(spec)).then(resolve, reject)
  })
  return promise
}

/**
 * Minimal in-memory `agents` service (plan `20260814-dsh-fallbacks-integration`
 * Task 2): implements the contracts the plugin's seams consume — `get(id)`
 * child resolution (documented in the `@deepseek-ai/dsh-subagent` event
 * contract; the real registry's own admission boundary) — plus
 * `register(agent)` so a test can fake-register a child agent (the
 * hooks-claude-code coverage pattern). Mounted as the
 * `@deepseek-ai/dsh-agent-fake` module row (`bootApp({ agentsService: 'fake' })`).
 * The real `AgentRegistry` additionally owns factory/loop wiring and emits
 * `agent/created` / `agent/disposed` — none of it consumed by the plugin.
 *
 * `create(inputs)` supports the CONTINUABLE persona-channel tests (plan
 * `20260831-dsh-alpha2-optional-fallbacks` Task 3 fix round): the real
 * continuation manager materializes every continuable child through
 * `agents.create({ sessionId, meta, seed, agentOptions, signal, setup })`.
 * This fake RECORDS the creation inputs and THROWS — the earliest real
 * observation point for the resolved continuable request (the creation
 * `seed` carries the `subagent/descriptor` event with the snapshot persona,
 * so the merged persona is observable without a live agent runtime). A
 * rejection here is the documented rollback boundary (creation owns
 * rollback before handle transfer), so the start call rejects cleanly.
 */
export class FakeAgentRegistry extends Service {
  private readonly live = new Map<string, Agent>()
  /** Recorded `agents.create` inputs (the continuable materialization observation point). */
  readonly createCalls: Array<{ sessionId: unknown; meta?: { parentSession?: string }; seed?: Array<{ type: string; data?: Record<string, unknown> }>; agentOptions?: unknown }> = []

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /** Record one live agent (the real registry's `register` contract). */
  register(agent: Agent): () => void {
    this.live.set(agent.id, agent)
    return () => {
      if (this.live.get(agent.id) === agent) this.live.delete(agent.id)
    }
  }

  /** Look up a live agent by id (the registry's ONE consumed surface). */
  get(id: string): Agent | undefined {
    return this.live.get(id)
  }

  /** Record the creation inputs and reject — capture-only (see class doc). */
  create(inputs: { sessionId: unknown; meta?: { parentSession?: string }; seed?: Array<{ type: string; data?: Record<string, unknown> }> }): never {
    this.createCalls.push(inputs)
    throw new Error('fake agents create: capture-only harness (continuable materialization stops here)')
  }
}

/**
 * Minimal in-memory `sessions` service for the workflow-ledger consumer e2e
 * tests (plan `20260815-dsh-workflow-gate` Task 4 — the W-B2 run rows +
 * the P-c answer observation alongside the gate verdict rows): implements
 * the ONE contract the workflow-ledger consumer reads — `get(id)` /
 * `list()` over live sessions (the depth advisory + cold scan) — plus
 * `register(session)` and an `append(session, type, data)` driver that
 * pushes an envelope into the session's `events` log and emits it on the
 * `session/event` firehose (the real store's append+emit contract). The
 * sessions are STRUCTURAL FAKES (plain objects): the consumer reads only
 * `id` / `events` / `header.cwd` / `header.delegationDepth` structurally,
 * and `@deepseek-ai/dsh-session` cannot construct under Bun/JSC. Mounted as
 * the `@deepseek-ai/dsh-session-fake` module row
 * (`bootApp({ sessionsService: 'fake' })`) so the plugin's REAL
 * `registerWorkflowLedger` wiring registers against it — the gate → session
 * event → consumer → ledger composition under test.
 */
export class FakeSessionsRegistry extends Service {
  private readonly app: Context
  private readonly live = new Map<string, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'sessions')
    this.app = ctx
  }

  /** Record one live session (the real store's `create`/`enter` contract). */
  register(session: unknown): void {
    const id = (session as { id?: unknown } | null | undefined)?.id
    if (typeof id === 'string' && id !== '') this.live.set(id, session)
  }

  /** Look up a live session by id (the consumer's depth-advisory read). */
  get(id: string): unknown {
    return this.live.get(id)
  }

  /** All live sessions, in registration order (the consumer's cold-scan read). */
  list(): unknown[] {
    return [...this.live.values()]
  }

  /**
   * Drive one append + `session/event` firehose emit — the real store's
   * append+emit contract (`seq = log.length`, push, then post-commit emit).
   * The CARRIER comes FIRST — the real store dispatches
   * `[carrier, 'session/event', session, event]` and cordis `dispatch`
   * shifts the leading object as `this` before the event name.
   */
  append(session: { id: string; events: unknown[] }, type: string, data: object): void {
    const event = { type, seq: session.events.length, time: 1_700_000_000_000 + session.events.length, data }
    session.events.push(event)
    this.app.events.emit({}, 'session/event', session, event)
  }
}
/**
 * Minimal in-memory `sessionPersistence` service for the CONTINUABLE
 * persona-channel tests (plan `20260831-dsh-alpha2-optional-fallbacks`
 * Task 3 fix round): the real continuation manager's `startContinuable`
 * requires the service to EXIST (`requirePersistence()` →
 * `PERSISTENCE_UNAVAILABLE` otherwise) but, for a fresh child without a
 * caller-reserved id, reads nothing from it before handing off to
 * `agents.create` (the capture-only boundary the agents fake provides).
 * Mounted as the `@deepseek-ai/dsh-session-persistence-fake` module row
 * (`bootApp({ sessionPersistence: 'fake' })`).
 */
export class FakeSessionPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }
}

/**
 * Minimal in-memory `settings` service for the REAL-fallbacks composition
 * (plan `20260817-dsh-roles-e2e` Task 1 — installed-deployment e2e): the
 * upstream `dsh-llm-fallbacks` plugin writes its seed registry through the
 * `settings` service (`seedsIo.writeRoles` → `sctx.settings.update(...)`),
 * which the real dsh app always provides (`dsh-settings-file` row). Without
 * it the fallbacks `declareSeeds` rejects with
 * `seedsSettingsUnavailable` and no mstar seed can land. This fake
 * implements the ONE consumed contract — `update(namespace, data)` (+ a
 * `get` readback for the spec) — mounted as the `@deepseek-ai/dsh-settings-fake`
 * module row (`bootApp({ settingsService: 'fake' })`), the same
 * structural-fake philosophy as the loader/jobs/agents/sessions fakes.
 */
export class FakeSettingsRegistry extends Service {
  private readonly store = new Map<string, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /** Persist one namespace payload (the fallbacks `update` contract). */
  update(namespace: string, data: unknown): Promise<void> {
    this.store.set(namespace, data)
    return Promise.resolve()
  }

  /** Read one namespace payload (spec readback). */
  get(namespace: string): unknown {
    return this.store.get(namespace)
  }
}

let fakeChildSeq = 0

/**
 * Seed a detached session carrying one `user/message` with `prompt` text —
 * the Assignment carrier shape the real tool-subagent hands to the subagent
 * runtime as the child's user message (and what the persona channel's role
 * parse reads through the start request's prompt blocks).
 */
export function seededSession(id: SessionId, prompt: string): Session {
  return Session.create(id, [{
    type: 'user/message',
    seq: SessionSeq(0),
    time: 1_700_000_000_000,
    data: {
      id: MessageId(`seed-${id}`),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }])
}

/**
 * Build a fake registered child around a caller-provided session: an
 * agent-scoped ctx (`createScope`, the dsh-scope primitive the agent runtime
 * uses) with `systemPrompt` injected, wrapped as the structural `Agent` a
 * test registers with the fake agents registry (the continuable persona
 * tests register it as the delegating parent; the real registry's
 * admission boundary is the same `agents.get(id)` identity read). The
 * `subagent/start` seam is driven directly (the hooks-claude-code coverage
 * pattern); the child's prompt assembly is viewed through `scopeKey`.
 */
export async function fakeChildWithSession(ctx: Context, session: Session): Promise<{ agent: Agent; scopeKey: object }> {
  const scopeKey = { id: session.id }
  let childCtx: Context | undefined
  await ctx.inject(['systemPrompt'], (scoped) => {
    childCtx = createScope(scoped, scopeKey).ctx
  })
  // `options` is part of the structural Agent surface the real runtime's
  // delegation-depth read consumes (`delegationDepthOf` /
  // `parentAgentOptionsForDelegation` read `agent.options.subagentDepth`).
  const agent = {
    id: session.id,
    ctx: childCtx!,
    session,
    options: {},
  } as unknown as Agent
  return { agent, scopeKey }
}

/** Build a fake registered child whose session is seeded with `prompt`. */
export async function fakeChild(ctx: Context, prompt: string): Promise<{ agent: Agent; scopeKey: object }> {
  const id = SessionId(`child-${fakeChildSeq++}`)
  return fakeChildWithSession(ctx, seededSession(id, prompt))
}

/** A structural `subagent/start` payload (the advisory decision-point listener's ignored shape). */
export function startInfo(id: string, provider = 'in-process'): SubagentStartPayload {
  return { runId: `run-${id}`, provider, id, local: true }
}
export interface BootOptions {
  /** `Enforcement` override for the plugin Config (`hard` | `soft`). */
  enforcement?: 'hard' | 'soft'
  /** Delegation tool names the dispatch gate matches (Config `dispatchTools`). */
  dispatchTools?: string[]
  /** The dispatching agent's own harness role (Config `dispatchBinding`). */
  dispatchBinding?: string
  /** Additional skill roots registered with skill-filesystem (Config `skillRoots`). */
  skillRoots?: string[]
  /** Bundled skill root registered with skill-filesystem (Config `bundledSkillDir`). */
  bundledSkillDir?: string
  /** Catalog cache refresh interval in ms (Config `catalogTtlMs`). */
  catalogTtlMs?: number
  /**
   * Mount the {@link FakeJobRegistry} as the `jobs` service (the
   * `@deepseek-ai/dsh-jobs-fake` row + module map) so the plugin's
   * `ctx.inject(['jobs'])` onJobDone wiring registers against it (plan
   * `20260811-panel-f4-timeliness` Task 1 seam probe).
   */
  jobsService?: 'fake'
  /**
   * Mount the {@link FakeAgentRegistry} as the `agents` service (the
   * `@deepseek-ai/dsh-agent-fake` row + module map) so the seams that read
   * live agents resolve fake-registered children via
   * `ctx.get('agents')?.get(id)` (plan
   * `20260814-dsh-fallbacks-integration` Task 2 — the real dsh app always
   * composes dsh-agent before the subagent seam). The REAL subagents row
   * also requires it: the runtime's constructor injects `agents` for its
   * continuation manager, and the continuable persona tests observe the
   * materialization through the fake's capture-only `create`.
   */
  agentsService?: 'fake'
  /**
   * Mount the REAL `@deepseek-ai/dsh-subagent` row (the `ctx.subagents`
   * runtime seam — plan `20260831-dsh-alpha2-optional-fallbacks` Task 3):
   * the native persona-channel tests register a {@link FakeSubagentProvider}
   * on it and drive starts through {@link startViaNativeChannel} /
   * {@link startContinuableViaNativeChannel}. Requires
   * `agentsService: 'fake'` — the runtime's constructor injects `agents`
   * for its continuation manager (the real dsh app always composes
   * dsh-agent before the subagent seam).
   */
  subagents?: 'real'
  /**
   * Mount the {@link FakeSessionsRegistry} as the `sessions` service (the
   * `@deepseek-ai/dsh-session-fake` row + module map) so the plugin's
   * `registerWorkflowLedger` consumer wiring registers against it — the W-B2
   * run rows + the P-c answer observation e2e (plan `20260815-dsh-workflow-gate`
   * Task 4; the real dsh app always composes dsh-session before the plugin).
   */
  sessionsService?: 'fake'
  /**
   * Mount the {@link FakeSessionPersistence} as the `sessionPersistence`
   * service (the `@deepseek-ai/dsh-session-persistence-fake` row + module
   * map): the REAL runtime's `startContinuable` requires the service to
   * exist (`PERSISTENCE_UNAVAILABLE` otherwise) — the continuable
   * persona-channel tests opt in (plan `20260831-dsh-alpha2-optional-fallbacks`
   * Task 3 fix round; the real dsh app composes a persistence backend
   * before continuable children are addressable).
   */
  sessionPersistence?: 'fake'
  /** Taxonomy bridge (Config `roleMap`): mstar role id → fallbacks role id. */
  roleMap?: Record<string, string>
  /** Persona map (Config `rolePersonas`): mstar role id → persona text. */
  rolePersonas?: Record<string, string>
  /** Workflow/ralph gate mode (Config `workflowGate`, plan `20260815-dsh-workflow-gate`). */
  workflowGate?: 'off' | 'warn' | 'ask' | 'hard'
  /** Workflow name allowlist (Config `workflowNames`; empty/absent ⇒ every name unknown). */
  workflowNames?: string[]
  /**
   * Seed a minimal v2 tree (root status.json + one active workflow snapshot)
   * under the boot harness dir BEFORE the plugin applies — the v3
   * write-path precondition for the agent-flow writer / workflow-ledger
   * consumer (plan `20260819-workflow-dsh-viz` Task 2). Opt-in: tests that
   * assert the bare-harness degrade (no status.json → state null) must NOT
   * set it.
   */
  seedV2?: boolean
  /** App root override (default: a fresh temp dir). */
  root?: string
  /**
   * Path to a committed fixture `cordis.yml` to boot INSTEAD of the inline
   * row list (e2e-session.spec full-app composition). The fixture's last row
   * must be the mstar plugin row without a `config:` block — the same
   * boot-time config lines are appended after it (temp harness dir and the
   * options above are session state, not commit-time constants).
   */
  cordisYml?: string
  /**
   * Explicit harness-dir override: a string sets that value, `null` OMITS
   * the config key entirely (the plugin then resolves per session
   * workspace at event time — never from the process cwd — so boot-time
   * gates/catalog are explicit-only), `undefined` (default) uses the
   * temp `root/harness` dir.
   */
  harnessDir?: string | null
  /**
   * Module-source override for the `@mstar-harness/dsh` row (plan
   * `20260817-dsh-roles-e2e` Task 1 — installed-deployment e2e): the
   * default is the src plugin (`../src/index.ts`); an installed-artifact
   * test passes the dist namespace imported from the real install. The
   * default behavior is unchanged when omitted.
   */
  pluginModule?: unknown
  /**
   * REAL `dsh-llm-fallbacks` row (plan `20260817-dsh-roles-e2e` Task 1):
   * when set, a `dsh-llm-fallbacks` row is mounted AFTER the mstar row
   * with this module as its source (the real profile entry-list order is
   * mstar first, fallbacks second — the seeds inject child is armed at
   * mstar apply and fires when the fallbacks service appears). Absent by
   * default — existing compositions are untouched.
   */
  fallbacksModule?: unknown
  /**
   * Mount the {@link FakeSettingsRegistry} as the `settings` service (the
   * `@deepseek-ai/dsh-settings-fake` row + module map): the REAL
   * `dsh-llm-fallbacks` plugin writes its seed registry through
   * `sctx.settings.update` (the real dsh app always composes the
   * `dsh-settings-file` row), so a fallbacks composition without a
   * settings seam cannot persist seed declarations. Mounted BEFORE the
   * fallbacks row so `writeRoles` binds at fallbacks apply. Absent by
   * default — existing compositions are untouched.
   */
  settingsService?: 'fake'
}

/** A booted app: context, temp root, resolved harness dir, and disposal. */
export interface BootResult {
  ctx: Context
  root: string
  harnessDir: string
  /**
   * The fallbacks row fiber (plan `20260817-dsh-roles-e2e` Task 1 — set
   * when `fallbacksModule` was mounted): the host may dispose it and
   * re-apply the row with a settings-derived config to model the real
   * app's config-stack re-composition (settings write → HMR re-apply).
   */
  fallbacksFiber?: Fiber
  /** Dispose the app fiber and remove the temp root. */
  dispose(): Promise<void>
}

/** Minimal valid status.json (engine test fixture `status.empty.json` shape). */
export const VALID_STATUS = {
  version: 1,
  updated_at: '2026-08-08',
  plans: [],
  residual_findings: {},
  metadata: {},
}

/** A schema-valid v2 root status.json (the v2 fixture for the status gate). */
export const VALID_STATUS_V2 = {
  version: 2,
  updated_at: '2026-08-19',
  workflows: [],
}

/** A v2-shaped status.json that fails the v2 schema (`workflows` non-array). */
export const INVALID_STATUS_V2 = {
  version: 2,
  updated_at: '2026-08-19',
  workflows: 'not-an-array',
}

/** A minimal v2 root status.json (version 2 + active `workflows[]` only). */
export function v2Root(workflows: unknown[]): string {
  return JSON.stringify({ version: 2, updated_at: '2026-08-19', workflows })
}

/** One active v2 root `workflows[]` entry (harness-relative `dir`). */
export function v2WorkflowEntry(id: string, type: 'plan' | 'iteration' = 'plan'): Record<string, unknown> {
  return { id, type, started_at: '2026-08-19', dir: `workflows/${id}` }
}

/** A minimal workflow snapshot (schema_version 1) for the given workflow id. */
export function v2Snapshot(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    id,
    type: 'plan',
    status: 'running',
    started_at: '2026-08-19',
    updated_at: '2026-08-19',
    plans: [],
    ...overrides,
  })
}

/** A v2 workflow snapshot carrying plan rows (the Task 3 snapshot-read fixture shape). */
export function v2SnapshotWithPlans(id: string, plans: unknown[], overrides: Record<string, unknown> = {}): string {
  return v2Snapshot(id, { plans, ...overrides })
}

/** A minimal v2 root status.json with one ACTIVE workflow entry. */
export function v2RootWithWorkflow(workflowId = 'wf-1'): string {
  return v2Root([v2WorkflowEntry(workflowId)])
}

/** A minimal project register doc (`projects/<id>/residuals.json` — entries keyed by plan id). */
export function v2Register(entries: Record<string, unknown[]>): string {
  return JSON.stringify({ entries })
}

/** One register residual entry (the v1 residual entry verbatim + register provenance). */
export function v2ResidualEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: 't',
    severity: 'medium',
    source: 'qc',
    scope: 'plan',
    decision: 'defer',
    owner: 'qa',
    target: 'n',
    tracking: null,
    source_plan: 'p1',
    registered_at: '2026-08-19',
    ...overrides,
  }
}

/**
 * Seed a minimal v2 tree under the harness dir: a v2 root status.json with
 * ONE active workflow entry + that workflow's snapshot. The agent-flow
 * writer / ledger resolve the ACTIVE workflow from this tree and append to
 * `workflows/<id>/` — the v3 write-path precondition.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param workflowId - the active workflow id (default `wf-1`).
 * @param plans - snapshot `plans[]` rows (default [] — the snapshot-read
 * fixture shape).
 */
export async function seedV2Tree(harnessDir: string, workflowId = 'wf-1', plans: unknown[] = []): Promise<void> {
  await seedHarness(harnessDir, {
    'status.json': v2Root([v2WorkflowEntry(workflowId)]),
    [`workflows/${workflowId}/snapshot.json`]: v2SnapshotWithPlans(workflowId, plans),
  })
}

/** Well-formed JSON that fails the status schema (plans must be an array). */
export const INVALID_STATUS = {
  version: 1,
  updated_at: '2026-08-08',
  plans: 'not-an-array',
  residual_findings: {},
  metadata: {},
}

/**
 * Seed files under the harness dir (the gate reads the on-disk document at
 * intent time, so seeding may happen any time before the intent dispatch).
 * @param harnessDir - the app's resolved `{HARNESS_DIR}`.
 * @param files - relative path → content map (intermediate dirs are created).
 */
export async function seedHarness(harnessDir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(harnessDir, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

/**
 * Boot a REAL-composition app: mount the seam rows directly with
 * `ctx.plugin` in the dsh app's row order, applying the mstar plugin Config
 * through the shipping schemastery validation. No `@cordisjs/plugin-loader`:
 * the bundle depends only on `@deepseek-ai/cordis`.
 * @param options - config override and root placement.
 * @returns the booted app handle.
 */
export async function bootApp(options: BootOptions = {}): Promise<BootResult> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-mstar-boot-'))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  // v3 write-path precondition (plan `20260819-workflow-dsh-viz` Task 2):
  // the agent-flow writer / workflow-ledger consumer append only to an
  // ACTIVE workflow — tests that exercise the ledger opt in to the seeded
  // v2 tree (root status.json + one active workflow snapshot).
  if (options.seedV2 === true) await seedV2Tree(harnessDir)
  // The REAL subagents row needs the agents service (the runtime's
  // constructor injects `agents` for its continuation manager) — fail the
  // boot fast instead of hanging the row fiber.
  if (options.subagents !== undefined && options.agentsService === undefined) {
    throw new Error('subagents: "real" requires agentsService: "fake" (the runtime injects agents)')
  }

  // The dsh skill registry row mounts first (real dsh app layout): the
  // `@mstar-harness/dsh` plugin mounts skill-filesystem as a child, which injects
  // the `skills` service. The tool/command registry rows mount before the
  // plugin so `ctx.tools` / `ctx.commands` exist when the v2 seams register
  // (the real dsh app always composes them).
  const inlineRows: ReadonlyArray<{ name: string; config?: Record<string, unknown> }> = [
    // The fake loader row mounts FIRST: the mstar plugin's top-level
    // `inject: ['loader']` (plan 20260814-dsh-fallbacks-integration Task 1)
    // requires the service before apply — the real dsh app always boots the
    // profile loader before composing plugin rows.
    { name: '@deepseek-ai/dsh-loader-fake' },
    { name: '@deepseek-ai/dsh-skill' },
    // The real dsh-tools ToolRegistry service injects `systemPrompt`
    // (unlike the removed peer-stub), so the system-prompt row mounts
    // before the tool registry row.
    { name: '@deepseek-ai/dsh-system-prompt' },
    // The tool registry row mounts before the plugin so `ctx.tools` exists
    // when the v2 seams register their model-facing tools (Task 1 of plan
    // 20260808-dsh-seams-bundle; the real dsh app always composes dsh-tools).
    { name: '@deepseek-ai/dsh-tools' },
    // The command registry row mounts before the plugin so `ctx.commands`
    // exists when the bundled mstar commands register (the real dsh app
    // always composes dsh-commands).
    { name: '@deepseek-ai/dsh-commands' },
    // The fake jobs service row (only when requested — plan
    // `20260811-panel-f4-timeliness` Task 1): provides `ctx.jobs` so the
    // plugin's deferred `ctx.inject(['jobs'])` onJobDone wiring fires.
    ...(options.jobsService !== undefined ? [{ name: '@deepseek-ai/dsh-jobs-fake' }] : []),
    // The fake agents service row (only when requested — plan
    // `20260814-dsh-fallbacks-integration` Task 2): provides `ctx.get('agents')`
    // so the seams that read live agents resolve fake-registered children.
    ...(options.agentsService !== undefined ? [{ name: '@deepseek-ai/dsh-agent-fake' }] : []),
    // The REAL subagents runtime row (only when requested — plan
    // `20260831-dsh-alpha2-optional-fallbacks` Task 3): provides
    // `ctx.subagents` so the native persona-channel tests can register a
    // fake provider and drive starts through the channel. Mounted BEFORE
    // the mstar row (the real dsh app composes the subagent seam before the
    // plugin layers).
    ...(options.subagents !== undefined ? [{ name: '@deepseek-ai/dsh-subagent' }] : []),
    // The fake sessions service row (only when requested — plan
    // `20260815-dsh-workflow-gate` Task 4): provides `ctx.get('sessions')`
    // so the plugin's `registerWorkflowLedger` consumer registers (W-B2 run
    // rows + the P-c answer observation e2e).
    ...(options.sessionsService !== undefined ? [{ name: '@deepseek-ai/dsh-session-fake' }] : []),
    // The fake session-persistence row (only when requested — plan
    // `20260831-dsh-alpha2-optional-fallbacks` Task 3 fix round): satisfies
    // the REAL runtime's `requirePersistence()` so `startContinuable`
    // proceeds past its persistence precondition (the continuable
    // persona-channel tests).
    ...(options.sessionPersistence !== undefined ? [{ name: '@deepseek-ai/dsh-session-persistence-fake' }] : []),
    // The fake settings service row (only when requested — plan
    // `20260817-dsh-roles-e2e` Task 1): mounted BEFORE the plugin layers
    // so the real fallbacks plugin's `ctx.inject(['settings'])` child
    // binds `writeRoles` at its own apply (the real dsh app composes the
    // `dsh-settings-file` row before the plugin layers).
    ...(options.settingsService !== undefined ? [{ name: '@deepseek-ai/dsh-settings-fake' }] : []),
    // The mstar plugin row (carries the boot-time Config below).
    { name: '@mstar-harness/dsh' },
    // The REAL fallbacks layer (only when requested — plan
    // `20260817-dsh-roles-e2e` Task 1 installed-deployment e2e): the real
    // dsh app's profile entry list puts `@mstar-harness/dsh` BEFORE
    // `dsh-llm-fallbacks` (probed on dsh 0.1.0-rc.6), so the seeds inject
    // child arms at mstar apply and fires when the fallbacks service
    // appears — the same sequence the seeds wiring test pins.
    ...(options.fallbacksModule !== undefined ? [{ name: 'dsh-llm-fallbacks' }] : []),
  ]
  let rows: ReadonlyArray<{ name: string; config?: Record<string, unknown> }> = inlineRows
  if (options.cordisYml !== undefined) {
    // Full-app fixture composition (e2e-session.spec): the committed rows
    // replace the inline list; the boot-time config block is applied to the
    // trailing mstar row exactly as for the inline list.
    const parsed = parseYaml(await readFile(options.cordisYml, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error(`fixture cordis.yml must be a row list: ${options.cordisYml}`)
    rows = parsed.map((row, index) => {
      if (typeof row !== 'object' || row === null || typeof (row as { name?: unknown }).name !== 'string') {
        throw new Error(`fixture row ${index} must declare a string name: ${options.cordisYml}`)
      }
      return { name: (row as { name: string }).name, config: (row as { config?: Record<string, unknown> }).config }
    })
    // The loader service is app-level in the real dsh app (the profile loader
    // boots the row composition), so it is prepended here for the fixture
    // composition too — the plugin's `inject: ['loader']` must resolve.
    rows = [{ name: '@deepseek-ai/dsh-loader-fake' }, ...rows]
  }

  const config: Record<string, unknown> = {}
  if (options.harnessDir !== null) config.harnessDir = options.harnessDir ?? harnessDir
  if (options.enforcement !== undefined) config.enforcement = options.enforcement
  if (options.dispatchTools !== undefined) config.dispatchTools = options.dispatchTools
  if (options.dispatchBinding !== undefined) config.dispatchBinding = options.dispatchBinding
  if (options.skillRoots !== undefined) config.skillRoots = options.skillRoots
  if (options.bundledSkillDir !== undefined) config.bundledSkillDir = options.bundledSkillDir
  if (options.catalogTtlMs !== undefined) config.catalogTtlMs = options.catalogTtlMs
  if (options.roleMap !== undefined) config.roleMap = options.roleMap
  if (options.rolePersonas !== undefined) config.rolePersonas = options.rolePersonas
  if (options.workflowGate !== undefined) config.workflowGate = options.workflowGate
  if (options.workflowNames !== undefined) config.workflowNames = options.workflowNames

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  // Module seams, keyed by row name. The seam packages export their plugin
  // function as `default` (CJS-style); the mstar plugin is named-only.
  const modules = new Map<string, unknown>([
    // `pluginModule` overrides the src default with an installed-artifact
    // module (plan `20260817-dsh-roles-e2e` Task 1).
    ['@mstar-harness/dsh', options.pluginModule ?? plugin],
    // The REAL fallbacks row module (plan `20260817-dsh-roles-e2e` Task 1;
    // only mounted when the option is set, see the row list above). The
    // seam unwrap handles the named-export plugin shape (`name`/`apply`/
    // `provide` namespace — same path as the mstar dist).
    ...(options.fallbacksModule !== undefined
      ? [['dsh-llm-fallbacks', options.fallbacksModule] as const]
      : []),
    // The `ctx.skills` registry seam — the REAL package, installed from the
    // npm registry; the host app provides it at runtime via peerDependencies.
    ['@deepseek-ai/dsh-skill', await import('@deepseek-ai/dsh-skill')],
    // The `ctx.systemPrompt` service seam the real dsh-tools ToolRegistry
    // injects — the REAL package (npm registry).
    ['@deepseek-ai/dsh-system-prompt', await import('@deepseek-ai/dsh-system-prompt')],
    // The `ctx.tools` registry seam — the REAL package (npm registry) whose
    // default export provides the ToolRegistry service (the host app provides
    // it at runtime via peerDependencies).
    ['@deepseek-ai/dsh-tools', await import('@deepseek-ai/dsh-tools')],
    // The `ctx.subagents` runtime seam — the REAL package (npm registry;
    // only mounted when `subagents: 'real'` is set, see the row list).
    ...(options.subagents !== undefined
      ? [['@deepseek-ai/dsh-subagent', await import('@deepseek-ai/dsh-subagent')] as const]
      : []),
    // The `ctx.commands` registry seam — the REAL package (npm registry) whose
    // named exports provide the CommandRuntime (the host app provides it at
    // runtime via peerDependencies).
    ['@deepseek-ai/dsh-commands', await import('@deepseek-ai/dsh-commands')],
    // The fake `loader` service (plan `20260814-dsh-fallbacks-integration`
    // Task 1): a `{ default }` module so the seam unwrap resolves the class.
    ['@deepseek-ai/dsh-loader-fake', { default: FakeLoaderRegistry }],
    // The fake `jobs` service (plan `20260811-panel-f4-timeliness` Task 1):
    // a `{ default }` module so the seam unwrap resolves the class.
    ...(options.jobsService !== undefined
      ? [['@deepseek-ai/dsh-jobs-fake', { default: FakeJobRegistry }] as const]
      : []),
    // The fake `agents` service (plan `20260814-dsh-fallbacks-integration`
    // Task 2): a `{ default }` module so the seam unwrap resolves the class.
    ...(options.agentsService !== undefined
      ? [['@deepseek-ai/dsh-agent-fake', { default: FakeAgentRegistry }] as const]
      : []),
    // The fake `sessions` service (plan `20260815-dsh-workflow-gate` Task 4):
    // a `{ default }` module so the seam unwrap resolves the class.
    ...(options.sessionsService !== undefined
      ? [['@deepseek-ai/dsh-session-fake', { default: FakeSessionsRegistry }] as const]
      : []),
    // The fake `sessionPersistence` service (plan
    // `20260831-dsh-alpha2-optional-fallbacks` Task 3 fix round): a
    // `{ default }` module so the seam unwrap resolves the class.
    ...(options.sessionPersistence !== undefined
      ? [['@deepseek-ai/dsh-session-persistence-fake', { default: FakeSessionPersistence }] as const]
      : []),
    // The fake `settings` service (plan `20260817-dsh-roles-e2e` Task 1):
    // a `{ default }` module so the seam unwrap resolves the class.
    ...(options.settingsService !== undefined
      ? [['@deepseek-ai/dsh-settings-fake', { default: FakeSettingsRegistry }] as const]
      : []),
  ])
  let fallbacksFiber: Fiber | undefined
  for (const row of rows) {
    const mod = modules.get(row.name)
    if (mod === undefined) throw new Error(`unexpected boot row: ${row.name}`)
    const mountable = (mod as { default?: unknown }).default ?? mod
    // `ctx.plugin` validates a plain config object against the plugin's
    // schemastery `Config` (the same validation the loader applied to rows).
    const fiber = await ctx.plugin(mountable as Parameters<Context['plugin']>[0], row.name === '@mstar-harness/dsh' && Object.keys(config).length > 0 ? config : undefined)
    // The fallbacks row handle (plan `20260817-dsh-roles-e2e` Task 1): the
    // e2e disposes it to model the host config-stack re-composition.
    if (row.name === 'dsh-llm-fallbacks') fallbacksFiber = fiber
  }
  return {
    ctx,
    root,
    harnessDir,
    fallbacksFiber,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Canonical value of one `mstar_*_validate` / `mstar_sdd_*` / seam tool
 * result. The dsh-tools seam types the successful `value` as lossless
 * `JsonValue` (includes `null` + primitives), so specs must narrow it to the
 * object contract the tools actually return before property access.
 */
export interface ToolResultValue {
  ok: boolean
  violations: Array<{ code: string; severity?: string; message?: string }>
  secrets?: Array<{ type: string }>
  level?: string
  level_missing?: string[]
  entry?: ToolResultValue
  exit?: ToolResultValue
  sdd_dir?: string
  brief_file?: string
  [key: string]: unknown
}

/** Narrow one successful tool result to its canonical value (throws on failure). */
export function valueOf(result: import('@deepseek-ai/dsh-tools').ToolExecutionResult): ToolResultValue {
  if (result.isError) throw new Error(`tool call failed: ${result.error?.message ?? 'unknown error'}`)
  return result.value as ToolResultValue
}
