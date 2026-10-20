/**
 * Scoped MCP mount per agent (#528) — every `agent/created` gets a scoped
 * `@deepseek-ai/dsh-mcp-client` instance (a cordis `ctx.plugin` child fiber)
 * whose stdio `env` carries that agent's own id as `MSTAR_HOST_SESSION_ID`, so
 * two concurrent agents calling mstar MCP tools are attributed to their own
 * ids. The launch ALSO carries the server-owned session context: the session
 * workspace (`cwd` + `--workspace`) and the resolver-selected harness
 * (`--harness`), so the stdio server resolves roots in the caller's workspace
 * rather than the host process cwd.
 *
 * Known leaf seats (the shared leaf-seat contract `isLeafSeatHeader` in
 * `leaf-seat.ts` — ADR `docs/adr/dsh-native-identity-channels.md`:
 * `header.origin === 'subagent'` or `delegationDepth > 0`) can never own a
 * binding, but they still need the writable subset, so they get a RESTRICTED
 * mount: the same launch marked `--seat leaf`, whose server refuses the
 * coordinator-seat commands. A subagent never inherits the parent's id.
 *
 * The mount is optional-by-presence: with `@deepseek-ai/dsh-mcp-client` not
 * installed it registers nothing, logs ONE debug line and never throws.
 * Disposal: each mount is a child fiber of the registering context, so an HMR
 * fiber swap tears down every scoped instance (and its MCP child process) with
 * the plugin.
 *
 * The `dsh-mcp-client` package is not a dependency of this plugin (same
 * posture as `dsh-llm-fallbacks`), so the tests drive the module seam through
 * an injected module provider — a fake Object plugin recording the config
 * each scoped instance receives and counting its teardown disposers.
 */
import { describe, expect, it } from 'bun:test'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  MSTAR_HOST_SESSION_ID,
  SCOPED_MCP_MOUNT_LOGGER,
  registerScopedMcpMount,
  setScopedMcpMountLogger,
} from '../src/gates/scoped-mcp-mount.ts'
import { FakeLoaderRegistry } from './harness.ts'
import type { LoaderEntryView } from '../src/gates/fallbacks-probe.ts'
import type { McpClientModuleView } from '../src/gates/scoped-mcp-mount.ts'
import { isLeafSeatHeader } from '../src/gates/leaf-seat.ts'

/** A root-like agent (no `header.parentSession`, no leaf markers). */
const rootAgent = (id: string): unknown => ({ id, session: { header: { id, cwd: '/tmp/ws' } } })

/** A leaf seat by origin (`header.origin === 'subagent'` — the shared leaf-seat contract). */
const subagentLeaf = (id: string, parentSession?: string): unknown => ({
  id,
  session: { header: { id, cwd: '/tmp/ws', origin: 'subagent', ...(parentSession === undefined ? {} : { parentSession }) } },
})

/** A leaf seat by depth (`header.delegationDepth > 0`, origin unset — the same contract's other arm). */
const deepLeaf = (id: string): unknown => ({ id, session: { header: { id, cwd: '/tmp/ws', delegationDepth: 2 } } })

/**
 * Fake `@deepseek-ai/dsh-mcp-client` module: an Object plugin whose
 * `apply` records the config every scoped instance receives and returns a
 * counting disposer (the HMR teardown observability).
 */
class FakeMcpClientModule {
  /** The config each `ctx.plugin` scoped instance received, in mount order. */
  readonly configs: Array<Record<string, unknown>> = []
  /** How many scoped instance disposers ran (fiber teardowns). */
  disposed = 0

  readonly module = {
    name: 'fake-mcp-client',
    apply: (_ctx: Context, config: unknown): (() => void) => {
      this.configs.push(config as Record<string, unknown>)
      return () => {
        this.disposed += 1
      }
    },
  }

  /** The injected module provider: the fake is "installed". */
  readonly provider = async (): Promise<(typeof this.module) | undefined> => this.module
}

/** A provider reporting the package as absent (the optional-by-presence degrade). */
const absentProvider = async (): Promise<undefined> => undefined

/** Let the async module probe + per-agent mounts settle (one macrotask). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Capture the module log sink; returns the restore closure. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const prior = setScopedMcpMountLogger((level, message) => lines.push(`${level}: ${message}`))
  return { lines, restore: () => setScopedMcpMountLogger(prior) }
}

/** The mstar-mcp loader row the bundle patch declares (bundle/cordis.patch.yml shape). */
const MCP_ROW: LoaderEntryView = {
  options: {
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'mstar', transport: 'stdio', command: 'npx', args: ['-y', '@mstar-harness/cli', 'mcp'] },
  },
  disabled: false,
  fiber: {},
}

/**
 * A loader row fixture carrying the entry id (the real cordis `Entry.id` the
 * row selection reads; the shared `LoaderEntryView` omits it).
 */
type RowFixture = LoaderEntryView & { id?: string }

/** The shipped bundle row, as the loader entry exposes it (`- id: mstar-mcp` + its config). */
const MSTAR_ROW: RowFixture = {
  id: 'mstar-mcp',
  options: {
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'mstar', transport: 'stdio', command: 'npx', args: ['-y', '@mstar-harness/cli', 'mcp'] },
  },
  disabled: false,
  fiber: {},
}

/**
 * An unrelated `@deepseek-ai/dsh-mcp-client` row: a different MCP server a
 * profile may enable — different id, server name, command, args and env.
 * The env entry is a synthetic row marker, not a credential: this fixture
 * proves the unrelated row's config never rides along into a per-agent mount.
 */
const UNRELATED_ROW: RowFixture = {
  id: 'other-server-mcp',
  options: {
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'other',
      transport: 'stdio',
      command: 'uvx',
      args: ['other-server', '--stdio'],
      env: { OTHER_MCP_ROW_MARKER: 'unrelated-server-row' },
    },
  },
  disabled: false,
  fiber: {},
}

/** The per-agent identity env the mount must derive for one agent id. */
const envFor = (id: string): Record<string, string> => ({ [MSTAR_HOST_SESSION_ID]: id })

/** The workspace every fixture agent's session header carries. */
const WS = '/tmp/ws'

/** The launch args after the mount's overlay: identity channel + session workspace. */
const argsAfter = (...base: string[]): string[] => [...base, '--identity-env', MSTAR_HOST_SESSION_ID, '--workspace', WS]

describe('scoped MCP mount — per-agent registration', () => {
  it('two fixture agents → two scoped registrations with distinct per-agent env (a)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-b'), source: 'fresh' })
      await settle()

      expect(fake.configs).toHaveLength(2)
      expect(fake.configs[0]!.env).toEqual(envFor('agent-a'))
      expect(fake.configs[1]!.env).toEqual(envFor('agent-b'))
      // Distinct ids never share one env map — attribution is per agent.
      expect(fake.configs[0]!.env).not.toEqual(fake.configs[1]!.env)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('the base config mirrors the shipped bundle row (serverName/transport/command/args)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      await settle()

      const config = fake.configs[0]!
      expect(config.serverName).toBe('mstar')
      expect(config.transport).toBe('stdio')
      expect(config.command).toBe('npx')
      // The identity-env declaration rides the args: without it the CLI's
      // `registerMcpCommand` reads NO ambient identity, so the per-agent env
      // key would never reach the connection. The session workspace rides
      // both the child cwd and the explicit launch arg (a pinned harness would
      // otherwise relocate the invocation cwd to its parent).
      expect(config.args).toEqual(argsAfter('-y', '@mstar-harness/cli', 'mcp'))
      expect(config.cwd).toBe(WS)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a readable mstar-mcp loader row overrides the base config, per-agent env still applied', async () => {
    const ctx = new Context()
    const loader = new FakeLoaderRegistry(ctx)
    loader.entriesList = [
      {
        options: {
          name: '@deepseek-ai/dsh-mcp-client',
          config: { serverName: 'mstar', transport: 'stdio', command: 'bun', args: ['run', 'mcp'] },
        },
        disabled: false,
        fiber: {},
      },
    ]
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-row'), source: 'fresh' })
      await settle()

      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.command).toBe('bun')
      // A loader-derived row config gets the identity-env declaration too —
      // the per-agent env is only honored when the server is told to read it.
      expect(fake.configs[0]!.args).toEqual(argsAfter('run', 'mcp'))
      expect(fake.configs[0]!.env).toEqual(envFor('agent-row'))
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a loader row declaring another identity-env variable is normalized to the per-agent variable', async () => {
    const ctx = new Context()
    const loader = new FakeLoaderRegistry(ctx)
    loader.entriesList = [
      {
        options: {
          name: '@deepseek-ai/dsh-mcp-client',
          // A custom deployment row that declares the channel with ANOTHER
          // variable name: the mount injects only MSTAR_HOST_SESSION_ID, so
          // keeping OTHER_VAR would make the server read an env the mount
          // never sets (the identity would be absent — or worse, whatever
          // OTHER_VAR holds). The declaration is normalized, not skipped.
          config: { serverName: 'mstar', transport: 'stdio', command: 'bun', args: ['run', 'mcp', '--identity-env', 'OTHER_VAR'] },
        },
        disabled: false,
        fiber: {},
      },
    ]
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-row'), source: 'fresh' })
      await settle()

      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.args).toEqual(argsAfter('run', 'mcp'))
      expect(fake.configs[0]!.env).toEqual(envFor('agent-row'))
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('an unrelated dsh-mcp-client row ordered BEFORE the mstar-mcp row never becomes the mount base', async () => {
    const ctx = new Context()
    const loader = new FakeLoaderRegistry(ctx)
    // Two rows for the same package: a different server first, the MStar row
    // second (later layers win per row, so this order is ordinary). Selecting
    // the first row by package name alone would launch the WRONG server with
    // the per-agent identity env — the MStar row's own id must win.
    loader.entriesList = [UNRELATED_ROW, MSTAR_ROW]
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-row'), source: 'fresh' })
      await settle()

      expect(fake.configs).toHaveLength(1)
      const config = fake.configs[0]!
      expect(config.serverName).toBe('mstar')
      expect(config.transport).toBe('stdio')
      expect(config.command).toBe('npx')
      // The identity-env declaration rides the MStar row's args.
      expect(config.args).toEqual(argsAfter('-y', '@mstar-harness/cli', 'mcp'))
      // Only the per-agent env is overlayed — the unrelated row's env never rides along.
      expect(config.env).toEqual(envFor('agent-row'))
      // The unrelated server's launch surface appears nowhere in the mount.
      expect(JSON.stringify(config)).not.toContain('uvx')
      expect(JSON.stringify(config)).not.toContain('other-server')
      // Nor does its env row marker (key or value) ride along.
      expect(JSON.stringify(config)).not.toContain('OTHER_MCP_ROW_MARKER')
      expect(JSON.stringify(config)).not.toContain('unrelated-server-row')
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('no identifiable mstar row → the shipped-row mirror is the base, never the unrelated row', async () => {
    const ctx = new Context()
    const loader = new FakeLoaderRegistry(ctx)
    // The MStar row is absent (not enabled, removed by a profile override):
    // the unrelated `dsh-mcp-client` row must NOT be adopted as the base.
    loader.entriesList = [UNRELATED_ROW]
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-row'), source: 'fresh' })
      await settle()

      expect(fake.configs).toHaveLength(1)
      const config = fake.configs[0]!
      expect(config.serverName).toBe('mstar')
      expect(config.transport).toBe('stdio')
      expect(config.command).toBe('npx')
      expect(config.args).toEqual(argsAfter('-y', '@mstar-harness/cli', 'mcp'))
      expect(config.env).toEqual(envFor('agent-row'))
      expect(JSON.stringify(config)).not.toContain('uvx')
      expect(JSON.stringify(config)).not.toContain('other-server')
      // The unrelated row's env marker never leaks into the shipped-row mirror.
      expect(JSON.stringify(config)).not.toContain('OTHER_MCP_ROW_MARKER')
      expect(JSON.stringify(config)).not.toContain('unrelated-server-row')
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('an MStar row id wins even when its config omits the shipped identity fields', async () => {
    const ctx = new Context()
    const loader = new FakeLoaderRegistry(ctx)
    // The row's own id is authoritative on its own: a deployment row keeping
    // the bundle id but a custom serverName/command is still the MStar row.
    loader.entriesList = [
      UNRELATED_ROW,
      {
        id: 'mstar-mcp',
        options: {
          name: '@deepseek-ai/dsh-mcp-client',
          config: { serverName: 'mstar-pinned', transport: 'stdio', command: 'bun', args: ['run', 'mcp'] },
        },
        disabled: false,
        fiber: {},
      },
    ]
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-row'), source: 'fresh' })
      await settle()

      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.serverName).toBe('mstar-pinned')
      expect(fake.configs[0]!.command).toBe('bun')
      expect(fake.configs[0]!.args).toEqual(argsAfter('run', 'mcp'))
      expect(fake.configs[0]!.env).toEqual(envFor('agent-row'))
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('launches the server with the session workspace and the resolver-selected harness', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    // The host process cwd is deliberately not the session workspace: the
    // resolver selects repo B's harness for the caller, and the mount must
    // carry BOTH facts on the child's launch.
    const agent = { id: 'agent-b', session: { header: { id: 'agent-b', cwd: '/tmp/session-b' } } }
    const asked: unknown[] = []
    try {
      registerScopedMcpMount(ctx, {
        provider: fake.provider,
        resolver: { forAgent: (value) => { asked.push(value); return '/tmp/session-b/.mstar' } },
      })
      ctx.events.emit('agent/created', { agent, source: 'fresh' })
      await settle()

      expect(asked).toEqual([agent])
      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.cwd).toBe('/tmp/session-b')
      expect(fake.configs[0]!.args).toEqual([
        '-y', '@mstar-harness/cli', 'mcp', '--identity-env', MSTAR_HOST_SESSION_ID,
        '--workspace', '/tmp/session-b', '--harness', '/tmp/session-b/.mstar',
      ])
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a row-declared harness/workspace is normalized to the per-session values', async () => {
    const ctx = new Context()
    const loader = new FakeLoaderRegistry(ctx)
    loader.entriesList = [
      {
        options: {
          name: '@deepseek-ai/dsh-mcp-client',
          config: {
            serverName: 'mstar', transport: 'stdio', command: 'bun',
            args: ['run', 'mcp', '--harness', '/deployment/pin/.mstar', '--workspace', '/deployment/cwd'],
          },
        },
        disabled: false,
        fiber: {},
      },
    ]
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, {
        provider: fake.provider,
        resolver: { forAgent: () => '/tmp/session-b/.mstar' },
      })
      ctx.events.emit('agent/created', { agent: { id: 'agent-b', session: { header: { cwd: '/tmp/session-b' } } }, source: 'fresh' })
      await settle()

      expect(fake.configs[0]!.args).toEqual([
        'run', 'mcp', '--harness', '/tmp/session-b/.mstar', '--workspace', '/tmp/session-b',
        '--identity-env', MSTAR_HOST_SESSION_ID,
      ])
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a resolver failure costs the harness pin, never the mount', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, {
        provider: fake.provider,
        resolver: { forAgent: () => { throw new Error('coordination probe failed') } },
      })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      await settle()

      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.args).not.toContain('--harness')
      expect(fake.configs[0]!.cwd).toBe(WS)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a subagent never inherits the parent id: the child gets its own RESTRICTED mount', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('root-1'), source: 'fresh' })
      ctx.events.emit('agent/created', { agent: subagentLeaf('child-1', 'root-1'), source: 'child' })
      await settle()

      // Two mounts: the coordinating session's unrestricted connection and the
      // leaf's restricted one. The child's env carries its OWN id — never the
      // parent's — and its launch is marked `--seat leaf`.
      expect(fake.configs).toHaveLength(2)
      expect(fake.configs[0]!.env).toEqual(envFor('root-1'))
      expect(fake.configs[0]!.args).toEqual(argsAfter('-y', '@mstar-harness/cli', 'mcp'))
      expect(fake.configs[1]!.env).toEqual(envFor('child-1'))
      expect(fake.configs[1]!.args).toEqual(['-y', '@mstar-harness/cli', 'mcp', '--identity-env', MSTAR_HOST_SESSION_ID, '--seat', 'leaf', '--workspace', WS])
      const envValues = Object.values(fake.configs[0]!.env as Record<string, string>)
      expect(envValues).not.toContain('child-1')
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a repeated agent/created for the same id does not double-mount', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      await settle()

      expect(fake.configs).toHaveLength(1)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('an agent without a usable identity gets no mount (never guessed)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: { session: { header: { cwd: '/tmp/ws' } } }, source: 'fresh' })
      await settle()

      expect(fake.configs).toHaveLength(0)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })
})

describe('scoped MCP mount — restricted leaf-seat mount', () => {
  it('an origin-subagent leaf → the same launch marked --seat leaf (b)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: subagentLeaf('leaf-1'), source: 'child' })
      await settle()

      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.env).toEqual(envFor('leaf-1'))
      expect(fake.configs[0]!.args).toEqual(['-y', '@mstar-harness/cli', 'mcp', '--identity-env', MSTAR_HOST_SESSION_ID, '--seat', 'leaf', '--workspace', WS])
      expect(fake.configs[0]!.cwd).toBe(WS)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a delegationDepth > 0 leaf (origin unset) → the same restricted mount (b)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: deepLeaf('leaf-2'), source: 'child' })
      await settle()

      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.args).toContain('--seat')
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('isLeafSeatHeader keeps the shared leaf-seat contract shape (leaf-seat.ts / ADR)', () => {
    expect(isLeafSeatHeader({ origin: 'subagent' })).toBe(true)
    expect(isLeafSeatHeader({ origin: 'main', delegationDepth: 1 })).toBe(true)
    expect(isLeafSeatHeader({ origin: 'main' })).toBe(false)
    expect(isLeafSeatHeader({ origin: 'main', delegationDepth: 0 })).toBe(false)
    expect(isLeafSeatHeader({})).toBe(false)
    expect(isLeafSeatHeader(undefined)).toBe(false)
  })
})

describe('scoped MCP mount — optional-by-presence degrade', () => {
  it('no dsh-mcp-client present → no registration, ONE debug log, no throw (c)', async () => {
    const ctx = new Context()
    const { lines, restore } = captureLogs()
    try {
      expect(() => registerScopedMcpMount(ctx, { provider: absentProvider })).not.toThrow()
      // The absence debug is a one-time probe — it may settle after register returns.
      await settle()
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      await settle()

      const debugs = lines.filter((line) => line.startsWith('debug:'))
      expect(debugs).toHaveLength(1)
      expect(debugs[0]).toContain('@deepseek-ai/dsh-mcp-client')
      expect(lines.filter((line) => line.startsWith('warn:'))).toHaveLength(0)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a rejecting injected provider → ONE contained warn, no mount, no unhandled rejection', async () => {
    const ctx = new Context()
    // The production default provider is catch-all and never rejects; the
    // seam accepts an injected one, so the probe branch must contain a
    // rejection the same way a failed mount is contained (one warn — never
    // an unhandled rejection, which would fail this very test).
    const rejectingProvider = async (): Promise<McpClientModuleView> => {
      throw new Error('injected provider rejected')
    }
    const { lines, restore } = captureLogs()
    try {
      expect(() => registerScopedMcpMount(ctx, { provider: rejectingProvider })).not.toThrow()
      await settle()
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      await settle()

      const warns = lines.filter((line) => line.startsWith('warn:'))
      // TWO contained warns, each naming its own branch: the one-time probe
      // and the agent mount that awaited the same rejected promise. Both are
      // the documented one-warn posture — never an unhandled rejection
      // (which would fail this very test).
      expect(warns.filter((line) => line.includes('probe failed'))).toHaveLength(1)
      expect(warns.find((line) => line.includes('probe failed'))).toContain('injected provider rejected')
      expect(warns.filter((line) => line.includes('mount failed'))).toHaveLength(1)
      // The rejection stays contained: no mount was attempted either.
      expect(lines.filter((line) => line.startsWith('debug:'))).toHaveLength(0)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })
})

describe('scoped MCP mount — per-agent disposal', () => {
  it('disposing an agent disposes its fiber and frees the id; another agent is unaffected', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-b'), source: 'fresh' })
      await settle()
      expect(fake.configs).toHaveLength(2)
      expect(fake.disposed).toBe(0)

      // Closing agent-a disposes exactly ITS scoped fiber (the MCP stdio
      // child process dies with it); agent-b's mount is untouched.
      ctx.events.emit('agent/disposed', { agent: rootAgent('agent-a') })
      await settle()
      expect(fake.disposed).toBe(1)
      expect(fake.configs).toHaveLength(2)

      // The freed id mounts again (a re-created agent gets its own mount)…
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      await settle()
      expect(fake.configs).toHaveLength(3)
      expect(fake.configs[2]!.env).toEqual(envFor('agent-a'))
      // …and the disposal edge never leaks into the other agent.
      ctx.events.emit('agent/disposed', { agent: rootAgent('agent-b') })
      await settle()
      expect(fake.disposed).toBe(2)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a disposal edge for an unknown id is a silent no-op (never a throw)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      await settle()
      expect(() => ctx.events.emit('agent/disposed', { agent: rootAgent('never-mounted') })).not.toThrow()
      expect(fake.disposed).toBe(0)
      expect(fake.configs).toHaveLength(1)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a disposal DURING the module await creates no fiber and frees the id (a)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    // A provider the test releases manually: the mount's claim sits in the
    // await window while the disposal edge fires.
    let release!: (mod: McpClientModuleView | undefined) => void
    const gate = new Promise<McpClientModuleView | undefined>((resolve) => { release = resolve })
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: () => gate })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      await settle()
      // The mount is still waiting on the module: claimed, but no fiber.
      expect(fake.configs).toHaveLength(0)

      // Dispose INSIDE the window. The claim must invalidate — the reachable
      // order `created → provider unresolved → disposed → provider resolves`
      // must leave NO fiber for the closed agent (and not consume the one
      // disposal event on a fiber that does not exist yet).
      ctx.events.emit('agent/disposed', { agent: rootAgent('agent-a') })
      release(fake.module)
      await settle()
      expect(fake.configs).toHaveLength(0)
      expect(fake.disposed).toBe(0)

      // The freed id mounts again for a re-created agent.
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      await settle()
      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.env).toEqual(envFor('agent-a'))
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a same-id re-creation inside the await window mounts exactly once (b)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    let release!: (mod: McpClientModuleView | undefined) => void
    const gate = new Promise<McpClientModuleView | undefined>((resolve) => { release = resolve })
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: () => gate })
      // created → disposed → created, all inside the window: the stale
      // claim must be invalidated by the disposal, and the re-created
      // agent's fresh claim is the one that mounts — never both.
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      ctx.events.emit('agent/disposed', { agent: rootAgent('agent-a') })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      release(fake.module)
      await settle()

      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.env).toEqual(envFor('agent-a'))
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })
})

describe(`scoped MCP mount — HMR disposal (${SCOPED_MCP_MOUNT_LOGGER})`, () => {
  it('fiber.dispose tears down every scoped instance (d)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-a'), source: 'fresh' })
      ctx.events.emit('agent/created', { agent: rootAgent('agent-b'), source: 'fresh' })
      await settle()
      expect(fake.disposed).toBe(0)

      // HMR: the plugin fiber swap disposes the registering context — each
      // scoped instance (and its MCP child process) unloads with it.
      await ctx.fiber.dispose()
      expect(fake.disposed).toBe(fake.configs.length)
      expect(fake.configs.length).toBe(2)

      // After the swap the reloaded apply re-registers fresh: a disposed
      // context accepts no further mounts (contained), and the dedupe set
      // belongs to the dead apply.
      ctx.events.emit('agent/created', { agent: rootAgent('agent-c'), source: 'fresh' })
      await settle()
      expect(fake.configs).toHaveLength(2)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })
})
