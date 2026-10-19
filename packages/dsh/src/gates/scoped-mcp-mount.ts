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
 * one per-caller identity channel the stdio MCP route has. The leaf-seat
 * skip list is the shared leaf-seat contract (`isLeafSeatHeader` in
 * `leaf-seat.ts`; ADR `docs/adr/dsh-native-identity-channels.md`): a
 * known leaf can never own a binding, so it never gets a child process.
 *
 * Optional-by-presence (the degradation posture of the rest of the plugin):
 * `@deepseek-ai/dsh-mcp-client` is NOT a dependency of this plugin — when
 * the package is not installed the mount registers nothing, logs ONE debug
 * line (a one-time probe per apply), and never throws. The server command
 * mirrors the shipped bundle's `mstar-mcp` row (bundle/cordis.patch.yml:
 * `npx -y @mstar-harness/cli mcp`, stdio); when the deployment's loader
 * carries a readable row config for the package, that config is the base and
 * only the per-agent `env` is overlaid.
 *
 * Disposal: the `agent/created` listener is a fiber-scoped effect and every
 * mount is a child fiber of the registering context, so an HMR fiber swap
 * unloads each scoped instance — and with it the MCP client's stdio child
 * process — with the plugin. No explicit disposer is kept here.
 */
import type { Context } from '@deepseek-ai/cordis'
import { isLeafSeatHeader } from './leaf-seat.ts'

/** Logger label for the scoped MCP mount (dsh logger naming: `<scope>/<subject>`). */
export const SCOPED_MCP_MOUNT_LOGGER = 'mstar/scoped-mcp-mount'

/** The env key carrying the per-agent session identity into the MCP server child. */
export const MSTAR_HOST_SESSION_ID = 'MSTAR_HOST_SESSION_ID'

/** The package the mount reuses (one string literal; never a static import — optional-by-presence). */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/**
 * The base config mirroring the shipped bundle's `mstar-mcp` row
 * (bundle/cordis.patch.yml) — the same server command the shipped bundle
 * uses. A readable deployment row config replaces this wholesale (per-agent
 * `env` is overlaid after).
 */
const DEFAULT_ROW_CONFIG: Record<string, unknown> = {
  serverName: 'mstar',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@mstar-harness/cli', 'mcp'],
}

/**
 * The per-agent env map one scoped instance launches its server child with:
 * exactly the one identity key — never inherited, never shared.
 */
export function scopedMountEnvFor(sessionId: string): Record<string, string> {
  return { [MSTAR_HOST_SESSION_ID]: sessionId }
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
 * surface, no loader-plugin dependency).
 */
interface LoaderEntryView {
  options: { name?: unknown; config?: unknown }
  disabled?: unknown
}

/** Minimal structural view of the cordis `loader` service (`ctx.loader.entries()`). */
interface LoaderView {
  entries(): Iterable<LoaderEntryView>
}

/**
 * The deployment's `mstar-mcp` row config when the loader carries a readable
 * entry for the package (present, enabled, object config) — the base the
 * per-agent `env` overlays. Absent/unreadable → `undefined` (the caller uses
 * the shipped-row mirror). Point-in-time read, no cache.
 */
function loaderRowConfig(ctx: Context): Record<string, unknown> | undefined {
  const loader = ctx.get('loader') as LoaderView | undefined
  if (loader === undefined || typeof loader.entries !== 'function') return undefined
  for (const entry of loader.entries()) {
    const options = entry?.options
    if (options === undefined || options.name !== MCP_CLIENT_PACKAGE) continue
    if (entry.disabled === true) continue
    const config = options.config
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined
    return { ...(config as Record<string, unknown>) }
  }
  return undefined
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
}

/**
 * Register the scoped MCP mount: an `agent/created` listener (root and
 * children alike fire — the leaf filter lives inside, the plan-mode-bridge
 * registration pattern) that mounts ONE scoped `@deepseek-ai/dsh-mcp-client`
 * instance per non-leaf agent, its stdio `env` carrying
 * `MSTAR_HOST_SESSION_ID = agent.id`.
 *
 * Ordering per event: leaf check → identity check → dedupe (one mount per
 * agent id per apply — a repeat event never spawns a second child process)
 * → module resolve (shared one-shot promise; absent → silent, the one-time
 * probe below owns the single debug) → `ctx.plugin(module, config)` with the
 * row-config base + the per-agent env. Every step is try/catch-contained: a
 * failure logs one warn and the agent proceeds without its mount (never a
 * boot or session failure).
 *
 * The one-time absence probe resolves the module once at registration and
 * logs ONE debug when the package is not installed — the whole degrade
 * posture is that single line; per-agent events stay silent (the register
 * already reported the disabled state).
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param options - optional overrides (tests inject the module provider).
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
  // Per-apply dedupe: agent ids already mounted by THIS context. The
  // apply-scoped lifetime is the HMR story — a reloaded fiber starts a fresh
  // set and re-mounts only the agents created after the swap.
  const mounted = new Set<string>()

  const mount = async (agent: unknown): Promise<void> => {
    try {
      // Leaf seats first (cheap + synchronous): the shared leaf-seat
      // contract — a known leaf never owns a binding, never gets a mount.
      const header = (agent as { session?: { header?: unknown } } | null | undefined)?.session?.header
      if (isLeafSeatHeader(header)) return
      // Identity is required and never guessed: no usable id → no mount.
      const id = (agent as { id?: unknown } | null | undefined)?.id
      if (typeof id !== 'string' || id.trim() === '') return
      if (mounted.has(id)) return
      // Claim BEFORE the await: concurrent `agent/created` events for the
      // same id must never double-mount (both handlers resume after the
      // shared module promise settles — only the claimant proceeds).
      mounted.add(id)
      const mod = await modulePromise
      if (mod === undefined) {
        mounted.delete(id)
        return
      }
      mounted.add(id)
      // The scoped instance: one cordis child fiber per agent — its disposal
      // rides THIS context's fiber (HMR-safe; no disposer kept here). The
      // config is the row-config base (deployment row when readable, else
      // the shipped-row mirror) plus exactly the per-agent identity env.
      const base = loaderRowConfig(ctx) ?? DEFAULT_ROW_CONFIG
      const config: Record<string, unknown> = {
        ...base,
        env: { ...((base.env as Record<string, string> | undefined) ?? {}), ...scopedMountEnvFor(id) },
      }
      ctx.plugin(mod as unknown as Parameters<Context['plugin']>[0], config)
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
}
