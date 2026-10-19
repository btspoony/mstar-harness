/**
 * Scoped MCP mount per agent (#528) — every non-leaf `agent/created` gets a
 * scoped `@deepseek-ai/dsh-mcp-client` instance (a cordis `ctx.plugin` child
 * fiber) whose stdio `env` carries that agent's own id as
 * `MSTAR_HOST_SESSION_ID`, so two concurrent agents calling mstar MCP tools
 * are attributed to their own ids. Known leaf seats (the execution-session
 * leaf contract: `header.origin === 'subagent'` or `delegationDepth > 0`)
 * can never own a binding and get NO mount — a subagent never inherits the
 * parent's id. The mount is optional-by-presence: with
 * `@deepseek-ai/dsh-mcp-client` not installed it registers nothing, logs ONE
 * debug line and never throws. Disposal: each mount is a child fiber of the
 * registering context, so an HMR fiber swap tears down every scoped instance
 * (and its MCP child process) with the plugin.
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
  isLeafSeatHeader,
  registerScopedMcpMount,
  setScopedMcpMountLogger,
} from '../src/gates/scoped-mcp-mount.ts'
import { FakeLoaderRegistry } from './harness.ts'
import type { LoaderEntryView } from '../src/gates/fallbacks-probe.ts'

/** A root-like agent (no `header.parentSession`, no leaf markers). */
const rootAgent = (id: string): unknown => ({ id, session: { header: { id, cwd: '/tmp/ws' } } })

/** A leaf seat by origin (`header.origin === 'subagent'` — execution-session contract). */
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

/** The per-agent identity env the mount must derive for one agent id. */
const envFor = (id: string): Record<string, string> => ({ [MSTAR_HOST_SESSION_ID]: id })

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
      expect(config.args).toEqual(['-y', '@mstar-harness/cli', 'mcp'])
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
      expect(fake.configs[0]!.args).toEqual(['run', 'mcp'])
      expect(fake.configs[0]!.env).toEqual(envFor('agent-row'))
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a subagent never inherits the parent id: root mounts once, the child (leaf) gets nothing', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: rootAgent('root-1'), source: 'fresh' })
      ctx.events.emit('agent/created', { agent: subagentLeaf('child-1', 'root-1'), source: 'child' })
      await settle()

      expect(fake.configs).toHaveLength(1)
      expect(fake.configs[0]!.env).toEqual(envFor('root-1'))
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

describe('scoped MCP mount — leaf-seat skip list', () => {
  it('an origin-subagent leaf → no mount (b)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: subagentLeaf('leaf-1'), source: 'child' })
      await settle()

      expect(fake.configs).toHaveLength(0)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('a delegationDepth > 0 leaf (origin unset) → no mount (b)', async () => {
    const ctx = new Context()
    const fake = new FakeMcpClientModule()
    const { restore } = captureLogs()
    try {
      registerScopedMcpMount(ctx, { provider: fake.provider })
      ctx.events.emit('agent/created', { agent: deepLeaf('leaf-2'), source: 'child' })
      await settle()

      expect(fake.configs).toHaveLength(0)
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('isLeafSeatHeader mirrors the execution-session leaf contract shape', () => {
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
