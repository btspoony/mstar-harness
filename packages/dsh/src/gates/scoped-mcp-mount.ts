/**
 * Scoped MCP mount per agent (#528) — every non-leaf `agent/created` gets a
 * scoped `@deepseek-ai/dsh-mcp-client` instance (a cordis `ctx.plugin` child
 * fiber of THIS context) whose stdio `env` carries that agent's own id as
 * `MSTAR_HOST_SESSION_ID`, so two concurrent agents calling mstar MCP tools
 * are attributed to their own ids — and a subagent never inherits the
 * parent's id.
 *
 * ADR constraint (teams' name-target addressing is not a shell identity
 * channel): the scoped mount exists BECAUSE a child process can only be
 * attributed by the environment it is launched with — per-agent env is the
 * one per-caller identity channel the stdio MCP route has.
 *
 * Server-owned session context: the same launch is the only channel through
 * which the stdio server can learn WHICH workspace the caller belongs to. The
 * mount therefore launches every child with the session workspace
 * (`config.cwd` plus the `--workspace` launch arg) and, when the resolver
 * selects one, the session harness (`--harness`) beside the identity env/args.
 * Without them a host process running in repo A served a session in repo B and
 * every root-sensitive MCP command resolved A.
 *
 * Leaf seats (the shared `isLeafSeatHeader` contract in `leaf-seat.ts`; ADR
 * `docs/adr/dsh-native-identity-channels.md`) get a RESTRICTED mount instead
 * of no mount: the same launch, marked `--seat leaf`, so the leaf keeps the
 * writable subset it may use (`issue.add` / `issue.close` / `plan.prepare` /
 * `plan.progress`) while the server refuses the coordinator-seat commands
 * (`plan.bind` / `plan.complete`) before any execution — a leaf can never
 * bind or complete a plan, adopt a credential, or clear a binding.
 *
 * Defence in depth, not the sole enforcement: this mount only covers the
 * per-agent scoped connection, while the profile-wide `mstar-mcp` row is
 * generic (no identity, no `--seat`). The `tools/pre-execute` leaf-seat
 * boundary (`leaf-seat.ts`) refuses that same coordinator arm for a known leaf
 * on EVERY connection, before this scoped server's own restriction is reached.
 *
 * Optional-by-presence (the degradation posture of the rest of the plugin):
 * `@deepseek-ai/dsh-mcp-client` is NOT a dependency of this plugin — when
 * the package is not installed the mount registers nothing, logs ONE debug
 * line (a one-time probe per apply), and never throws. The server command
 * mirrors the shipped bundle's `mstar-mcp` row (bundle/cordis.patch.yml:
 * `npx -y @mstar-harness/cli mcp`, stdio). The base is that row ONLY: the
 * loader read selects the deployment row by the row's OWN identity (the
 * bundle row id `mstar-mcp`, else the MStar server identity in its config —
 * `serverName: mstar` or the `@mstar-harness/cli … mcp` launch args), never
 * by the package name alone, because a profile may enable another
 * `@deepseek-ai/dsh-mcp-client` row for a different server before it. When no
 * row is identifiably the MStar row, the shipped-row mirror is the base —
 * never another server's row. Only the per-agent `env` and the identity-env
 * args are overlaid.
 *
 * Disposal: the `agent/created` listener is a fiber-scoped effect, so an HMR
 * fiber swap unloads the registering context with every mount it made. Each
 * mount's child fiber is ALSO retained per agent id: the `agent/disposed`
 * listener disposes and deletes it, so closing one agent tears down its own
 * MCP child process (a leaked stdio child for every closed session would
 * otherwise accumulate for the app's lifetime) and frees the id — a second
 * agent is untouched, and a disposed id may mount again.
 */
import type { Context } from '@deepseek-ai/cordis'
import { sessionCwdOf } from './_shared.ts'
import { isLeafSeatHeader } from './leaf-seat.ts'

/** Logger label for the scoped MCP mount (dsh logger naming: `<scope>/<subject>`). */
export const SCOPED_MCP_MOUNT_LOGGER = 'mstar/scoped-mcp-mount'

/** The env key carrying the per-agent session identity into the MCP server child. */
export const MSTAR_HOST_SESSION_ID = 'MSTAR_HOST_SESSION_ID'

/**
 * The exact CLI flag the `mcp` subcommand reads for the identity channel
 * (`registerMcpCommand` in `packages/cli/src/mcp/command.ts`:
 * `--identity-env <NAME>`; without it the server reads NO ambient identity,
 * so a per-agent env alone would never reach the connection).
 */
const IDENTITY_ENV_FLAG = '--identity-env'

/** The launch arg carrying the exact harness root the resolver selected for the session. */
const HARNESS_FLAG = '--harness'

/** The launch arg carrying the session workspace (the child's launch cwd alone is not enough when a harness is pinned). */
const WORKSPACE_FLAG = '--workspace'

/** The launch arg declaring the connection's seat to the server. */
const SEAT_FLAG = '--seat'

/** The leaf seat value; the server refuses coordinator-seat commands for this connection. */
const LEAF_SEAT = 'leaf'

/** The package the mount reuses (one string literal; never a static import — optional-by-presence). */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** The shipped bundle row id (`bundle/cordis.patch.yml`: `- id: mstar-mcp`). */
const MSTAR_ROW_ID = 'mstar-mcp'

/** The shipped row's `serverName` — the server identity the bundle declares. */
const MSTAR_SERVER_NAME = 'mstar'

/** The CLI package the shipped row launches (`npx -y @mstar-harness/cli mcp`). */
const MSTAR_CLI_PACKAGE = '@mstar-harness/cli'

/**
 * The base config mirroring the shipped bundle's `mstar-mcp` row
 * (bundle/cordis.patch.yml) — the same server command the shipped bundle
 * uses, plus the identity-env declaration the CLI requires. A readable
 * deployment row config replaces the non-args members wholesale and only the
 * per-agent `env` and the identity-env args are overlaid.
 */
const DEFAULT_ROW_CONFIG: Record<string, unknown> = {
  serverName: MSTAR_SERVER_NAME,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', MSTAR_CLI_PACKAGE, 'mcp', IDENTITY_ENV_FLAG, MSTAR_HOST_SESSION_ID],
}

/**
 * The per-agent env map one scoped instance launches its server child with:
 * exactly the one identity key — never inherited, never shared.
 */
export function scopedMountEnvFor(sessionId: string): Record<string, string> {
  return { [MSTAR_HOST_SESSION_ID]: sessionId }
}

/**
 * The per-agent launch facts the mount overlays on a row's args. Every member
 * is optional by presence: a session with no workspace or no resolved harness
 * simply ships fewer args (the server then keeps its own probe).
 */
export interface ScopedMountContext {
  /** The caller is a known leaf seat — launch a restricted connection. */
  readonly leaf?: boolean
  /** The resolver-selected harness root for the caller's session workspace. */
  readonly harness?: string
  /** The caller's session workspace. */
  readonly workspace?: string
}

/** Replace one flag's value, or append the pair when the row does not declare it. */
function withFlag(args: readonly unknown[], flag: string, value: string): unknown[] {
  const declared = args.indexOf(flag)
  if (declared >= 0 && declared + 1 < args.length) {
    const normalized = [...args]
    normalized[declared + 1] = value
    return normalized
  }
  return [...args, flag, value]
}

/**
 * The args one scoped instance launches its server child with: the base args
 * plus the identity-env declaration, the leaf seat marker, and the
 * server-owned session context (workspace + harness) — the per-agent `env`
 * only delivers the identity if the server is TOLD to read that variable, and
 * the workspace/harness are only known to the child through its launch.
 * A base row that already declares one of these flags is NORMALIZED to the
 * per-agent value (the session context is more specific than a deployment
 * default); a config whose `args` is not an array is passed through untouched.
 */
export function scopedMountArgsFor(args: unknown, context: ScopedMountContext = {}): unknown {
  if (!Array.isArray(args)) return args
  let next = withFlag(args, IDENTITY_ENV_FLAG, MSTAR_HOST_SESSION_ID)
  if (context.leaf === true) next = withFlag(next, SEAT_FLAG, LEAF_SEAT)
  if (context.workspace !== undefined) next = withFlag(next, WORKSPACE_FLAG, context.workspace)
  if (context.harness !== undefined) next = withFlag(next, HARNESS_FLAG, context.harness)
  return next
}

/** Consumer log levels the module sink understands. */
export type ScopedMcpMountLogLevel = 'debug' | 'warn'

/** Module-level consumer log sink — bound by `apply` to `ctx.logger(SCOPED_MCP_MOUNT_LOGGER)` (goal-bridge precedent). */
export type ScopedMcpMountLogSink = (level: ScopedMcpMountLogLevel, message: string) => void

let scopedMcpMountLogSink: ScopedMcpMountLogSink = () => {}

/**
 * Bind the scoped-mount log sink (the entry `apply` binds it to
 * `ctx.logger(SCOPED_MCP_MOUNT_LOGGER)`). Returns the PRIOR sink so a caller
 * can restore it (test pattern: goal-bridge `setGoalBridgeLogger`).
 */
export function setScopedMcpMountLogger(sink: ScopedMcpMountLogSink): ScopedMcpMountLogSink {
  const prior = scopedMcpMountLogSink
  scopedMcpMountLogSink = sink
  return prior
}

/** Log one consumer message through the bound sink (no-op before bind). */
function log(level: ScopedMcpMountLogLevel, message: string): void {
  scopedMcpMountLogSink(level, message)
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ---------------------------------- structural views ---------------------------------- */

/**
 * The consumed surface of the `@deepseek-ai/dsh-mcp-client` module — the
 * cordis Object-plugin shape the dsh Loader composes for every package
 * (`{ name, inject, Config, apply }`; the value surface is structural, the
 * package is not a dependency).
 */
export interface McpClientModuleView {
  name?: unknown
  inject?: unknown
  Config?: unknown
  apply: (ctx: Context, config: unknown) => unknown
}

/** An injectable module resolver (tests swap in a fake; production resolves the real package). */
export type McpClientModuleProvider = () => Promise<McpClientModuleView | undefined>

/**
 * Minimal structural view of one cordis loader `Entry` the row-config read
 * consumes (`fallbacks-probe.ts` `LoaderEntryView` — the same consumed
 * surface, plus the entry `id` this read needs to identify the MStar row; no
 * loader-plugin dependency).
 */
interface LoaderEntryView {
  /** The entry id inside its tree (`Entry.id` — the bundle row id at the root). */
  id?: unknown
  options: { name?: unknown; config?: unknown }
  disabled?: unknown
}

/** Minimal structural view of the cordis `loader` service (`ctx.loader.entries()`). */
interface LoaderView {
  entries(): Iterable<LoaderEntryView>
}

/**
 * `true` when the row config carries the MStar server identity the shipped
 * bundle declares: `serverName: mstar`, or the `@mstar-harness/cli mcp` launch
 * args of its row. This identifies a deployment row that keeps the MStar
 * identity under another (or no) id — it never matches an unrelated
 * `dsh-mcp-client` server's row.
 */
function isMstarServerConfig(config: Record<string, unknown>): boolean {
  if (config.serverName === MSTAR_SERVER_NAME) return true
  const args = config.args
  if (!Array.isArray(args)) return false
  const cli = args.indexOf(MSTAR_CLI_PACKAGE)
  return cli >= 0 && args[cli + 1] === 'mcp'
}

/**
 * The deployment's `mstar-mcp` row config when the loader carries a readable
 * entry for it (present, enabled, object config) — the base the per-agent
 * `env` overlays. Selection is by the row's OWN identity, never by package
 * name alone: the bundle row id (`mstar-mcp`) wins outright; absent it, the
 * first row whose config carries the MStar server identity is used; absent
 * both, `undefined` (the caller uses the shipped-row mirror). An unrelated
 * `dsh-mcp-client` row is never selected, however early it sits in the tree.
 * Point-in-time read, no cache.
 */
function loaderRowConfig(ctx: Context): Record<string, unknown> | undefined {
  const loader = ctx.get('loader') as LoaderView | undefined
  if (loader === undefined || typeof loader.entries !== 'function') return undefined
  let identityMatch: Record<string, unknown> | undefined
  for (const entry of loader.entries()) {
    const options = entry?.options
    if (options === undefined || options.name !== MCP_CLIENT_PACKAGE) continue
    if (entry.disabled === true) continue
    const config = options.config
    if (typeof config !== 'object' || config === null || Array.isArray(config)) continue
    const row = config as Record<string, unknown>
    // The row's own id is authoritative — the shipped bundle declares it.
    if (entry.id === MSTAR_ROW_ID) return { ...row }
    if (identityMatch === undefined && isMstarServerConfig(row)) identityMatch = { ...row }
  }
  return identityMatch
}

/* ---------------------------------- the default provider ---------------------------------- */

/**
 * Runtime dynamic import kept behind a variable so the bundler never tries
 * to resolve the optional package at build time (the probe's one-string-
 * literal posture). Structural check: only a module (or default interop)
 * exposing an `apply` function counts as installed.
 */
const dynamicImport = (specifier: string): Promise<unknown> => import(specifier)

const defaultProvider: McpClientModuleProvider = async () => {
  try {
    const mod: unknown = await dynamicImport(MCP_CLIENT_PACKAGE)
    const candidate =
      typeof mod === 'object' && mod !== null && typeof (mod as Record<string, unknown>).apply === 'function'
        ? (mod as Record<string, unknown>)
        : typeof mod === 'object' &&
            mod !== null &&
            typeof (mod as { default?: unknown }).default === 'object' &&
            (mod as { default?: Record<string, unknown> }).default !== null &&
            typeof (mod as { default?: Record<string, unknown> }).default!.apply === 'function'
          ? (mod as { default: Record<string, unknown> }).default
          : undefined
    if (candidate === undefined) return undefined
    return candidate as unknown as McpClientModuleView
  } catch {
    return undefined
  }
}

/* ---------------------------------- registration ---------------------------------- */

/** Options of {@link registerScopedMcpMount}. */
export interface ScopedMcpMountOptions {
  /** The module resolver (production default resolves the optional package; tests inject a fake). */
  provider?: McpClientModuleProvider
  /** The per-session harness resolver (`HarnessResolver.forAgent`); the mount pins the resolved root on the child. */
  resolver?: { forAgent(agent: unknown): string | null }
}

/**
 * The minimal consumed surface of the fiber `ctx.plugin` returns (cordis
 * `Fiber & PromiseLike<Fiber>`): retaining it per agent id and disposing it
 * on `agent/disposed` is the per-agent teardown — the HMR story stays the
 * registering context's own fiber swap.
 */
interface ScopedPluginFiber {
  dispose(): unknown
}

/**
 * Register the scoped MCP mount: an `agent/created` listener (root and
 * children alike fire — the leaf arm lives inside, the plan-mode-bridge
 * registration pattern) that mounts ONE scoped `@deepseek-ai/dsh-mcp-client`
 * instance per agent, its stdio `env` carrying
 * `MSTAR_HOST_SESSION_ID = agent.id` and its launch carrying the session
 * workspace and the resolver-selected harness.
 *
 * Ordering per event: leaf check → identity check → dedupe (one mount per
 * agent id per apply — a repeat event never spawns a second child process)
 * → module resolve (shared one-shot promise; absent → silent, the one-time
 * probe below owns the single debug) → `ctx.plugin(module, config)` with the
 * row-config base + the per-agent env, the identity-env args and the
 * server-owned session context (workspace + harness), the returned fiber
 * RETAINED under the agent id. A known leaf mounts the SAME launch with the
 * `--seat leaf` marker: the server refuses the coordinator-seat commands for
 * that connection instead of leaving the leaf with no writable route. The
 * paired `agent/disposed` listener disposes and deletes the retained fiber,
 * so a closed agent's MCP child process dies with it and its id may mount
 * again. Every step is try/catch-contained: a failure logs one warn and the
 * agent proceeds without its mount (never a boot or session failure).
 *
 * The one-time absence probe resolves the module once at registration and
 * logs ONE debug when the package is not installed — the whole degrade
 * posture is that single line; per-agent events stay silent (the register
 * already reported the disabled state).
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param options - optional overrides (tests inject the module provider and the per-session resolver).
 */
export function registerScopedMcpMount(ctx: Context, options: ScopedMcpMountOptions = {}): void {
  const provider = options.provider ?? defaultProvider
  // Shared one-shot module resolve: the probe and every per-agent mount
  // await the same promise, so the package is probed exactly once per apply.
  const modulePromise: Promise<McpClientModuleView | undefined> = provider()
  void modulePromise.then((mod) => {
    if (mod === undefined) {
      log(
        'debug',
        `${MCP_CLIENT_PACKAGE} not installed — scoped per-agent MCP mounts disabled (one debug per apply; no tools change)`,
      )
    }
  }).catch((error: unknown) => {
    // Contained: an injected provider may reject (tests, future callers — the
    // production default is catch-all). The probe branch dies with ONE warn,
    // the same posture as a failed mount; never an unhandled rejection.
    log('warn', `scoped MCP module probe failed (contained — per-agent mounts stay try/catch-contained): ${errorMessage(error)}`)
  })
  // Per-apply mount table: agent id → its mount claim. A claim lands before
  // the module await and carries a per-mount token; the fiber follows once
  // the mount runs. The `agent/disposed` edge deletes the claim whether or
  // not the fiber exists, and only the continuation still holding the
  // CURRENT token mounts — so a disposal during the await leaves no fiber
  // behind and frees the id immediately, while a same-id re-creation inside
  // the window re-claims with a fresh token and mounts alone.
  // The apply-scoped lifetime is the HMR story — a reloaded fiber starts a
  // fresh set and re-mounts only the agents created after the swap — while
  // the `agent/disposed` edge below tears one agent's child process down
  // early.
  const mounted = new Map<string, { token: number; fiber?: ScopedPluginFiber }>()
  let claimSeq = 0

  const mount = async (agent: unknown): Promise<void> => {
    try {
      // Leaf seats first (cheap + synchronous): the shared leaf-seat
      // contract — a known leaf never owns a binding. It still needs the
      // writable command surface, so it gets a RESTRICTED mount below.
      const header = (agent as { session?: { header?: unknown } } | null | undefined)?.session?.header
      const leaf = isLeafSeatHeader(header)
      // Identity is required and never guessed: no usable id → no mount.
      const id = (agent as { id?: unknown } | null | undefined)?.id
      if (typeof id !== 'string' || id.trim() === '') return
      if (mounted.has(id)) return
      // Claim BEFORE the await: concurrent `agent/created` events for the
      // same id must never double-mount (both handlers resume after the
      // shared module promise settles — only the claimant proceeds).
      const token = ++claimSeq
      mounted.set(id, { token })
      const mod = await modulePromise
      if (mod === undefined) {
        mounted.delete(id)
        return
      }
      // Post-await claim re-check: the agent may have been disposed while
      // this mount awaited the shared module (the disposal edge deletes the
      // claim whether or not a fiber exists), or the freed id may have been
      // re-claimed by a re-created agent. Only the continuation still
      // holding the CURRENT token mounts — a stale claim creates no fiber
      // for a closed agent and never consumes its id.
      const claim = mounted.get(id)
      if (claim === undefined || claim.token !== token) return
      // The scoped instance: one cordis child fiber per agent, RETAINED so
      // the `agent/disposed` edge can dispose it when the agent closes. The
      // config is the row-config base (deployment row when readable, else
      // the shipped-row mirror) plus the identity-env args, the server-owned
      // session context (workspace + resolved harness), exactly the per-agent
      // identity env, and — for a leaf — the restricted seat marker.
      const base = loaderRowConfig(ctx) ?? DEFAULT_ROW_CONFIG
      const workspace = sessionCwdOf(agent)
      // The harness pin is a convenience, not a gate: a resolver failure or a
      // workspace with no harness must never cost the agent its mount. The
      // workspace cwd below still anchors the server's own probe.
      let harness: string | null = null
      try {
        harness = options.resolver?.forAgent(agent) ?? null
      } catch {
        harness = null
      }
      const config: Record<string, unknown> = {
        ...base,
        args: scopedMountArgsFor(base.args, {
          leaf,
          ...(workspace === undefined ? {} : { workspace }),
          ...(harness === null ? {} : { harness }),
        }),
        env: { ...((base.env as Record<string, string> | undefined) ?? {}), ...scopedMountEnvFor(id) },
        ...(workspace === undefined ? {} : { cwd: workspace }),
      }
      claim.fiber = ctx.plugin(mod as unknown as Parameters<Context['plugin']>[0], config)
    } catch (error) {
      // Contained: a dead context (post-dispose mount attempt during an HMR
      // swap) or a plugin startup failure logs one warn — the agent proceeds
      // without its mount.
      log('warn', `scoped MCP mount failed for one agent (contained — the agent proceeds without its mount): ${errorMessage(error)}`)
    }
  }

  // Primary edge: `agent/created` fires per agent, root and children alike —
  // the leaf filter lives inside (plan-mode-bridge.ts:316 registration
  // pattern; the payload is consumed structurally).
  ctx.events.on('agent/created', (payload: { agent?: unknown }) => {
    if (payload.agent !== undefined) void mount(payload.agent)
  })

  // Per-agent teardown edge: a closed agent's retained fiber disposes (its
  // MCP stdio child process dies with it), its id frees for a re-created
  // agent, and every other agent's mount is untouched. The claim is deleted
  // whether or not the fiber exists — a disposal that lands while the mount
  // still awaits the shared module invalidates the pending claim, so the
  // post-await continuation never mounts for the closed agent. Contained
  // like the mount: a disposal failure logs one warn, never a session
  // failure.
  ctx.events.on('agent/disposed', (payload: { agent?: unknown }) => {
    const id = (payload.agent as { id?: unknown } | null | undefined)?.id
    if (typeof id !== 'string') return
    const claim = mounted.get(id)
    if (claim === undefined) return
    mounted.delete(id)
    const fiber = claim.fiber
    if (fiber === undefined) return
    void Promise.resolve(fiber).then((instance) => instance.dispose()).catch((error: unknown) => {
      log('warn', `scoped MCP mount disposal failed for one agent (contained — the session close proceeds): ${errorMessage(error)}`)
    })
  })
}
