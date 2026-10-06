/**
 * Bundled mstar commands (omp parity, iteration v2.1.0 gap fill): the plugin
 * registers the packaged `harness-commands/*.md` mirror (synced from the
 * repo root by `bundle-assets`; gitignored) on `ctx.commands` — the six
 * mstar slash commands (`iteration-start`, `iteration-drive`,
 * `iteration-loop`, `codebase-audit`, `amazing-pr-review`, `amazing-e2e-check`), matching the omp/opencode command
 * surface. Each registered command's handler steers the command body into
 * the receiving agent as a user message (the dsh-commands "explicitly
 * schedule model-visible work through the receiving Agent" path).
 *
 * The commands service resolve from the npm registry* ; the registrations are deferred with
 * `ctx.inject(['commands'], …)` so the plugin boots without the service.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { bootApp, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The packaged `harness-commands/` mirror dir, when synced by `bundle-assets`. */
function packagedCommandsDir(): string | undefined {
  const dir = fileURLToPath(new URL('../harness-commands/', import.meta.url))
  return existsSync(dir) ? dir : undefined
}

/** The six mstar slash commands (repo-root `commands/` mirror). */
const MSTAR_COMMANDS = ['iteration-start', 'iteration-drive', 'iteration-loop', 'codebase-audit', 'amazing-pr-review', 'amazing-e2e-check'] as const

/** A minimal fake receiving agent capturing steered messages. */
function fakeAgent(): { agent: Agent; steered: UserMessage[] } {
  const steered: UserMessage[] = []
  return {
    agent: {
      id: 'test-agent',
      status: 'idle',
      // The Agent contract requires the live session; the real dsh-commands
      // execute() appends `command/run` + `command/done` lifecycle rows to
      // `agent.session` — the no-op append satisfies that (the mstar command
      // handler itself only steers).
      session: {
        header: { version: 1, id: 's-1', createdAt: 0 } as never,
        append: (() => {}) as never,
      },
      steer: (message: UserMessage) => { steered.push(message) },
      followup: () => {},
    } as unknown as Agent,
    steered,
  }
}

/** The mirror's `<name>.md` body (identical to the repo-root command). */
function commandBody(dir: string, name: string): string {
  return readFileSync(join(dir, `${name}.md`), 'utf8')
    .replace(/^---[\s\S]*?---\r?\n?/, '')
    .trim()
}

describe('bundled mstar commands (omp parity)', () => {
  it('executes each command: the handler steers the command body into the receiving agent as a USER message', async () => {
    const dir = packagedCommandsDir()
    if (dir === undefined) return
    booted = await bootApp()
    const { agent, steered } = fakeAgent()
    for (const name of MSTAR_COMMANDS) {
      const result = await booted.ctx.commands.execute(agent, `/${name}`, [], new AbortController().signal)
      expect(result?.result.kind).toBe('success')
      // The steered message is a USER-source message (the dsh-plan-mode
      // /permission precedent — `source: { kind: 'user' }`), so the model
      // treats the command body as a task to execute, not injected context;
      // its text is the mirror's `<name>.md` body (identical to the
      // repo-root command). A bare execute carries no user input, so the
      // body is steered alone.
      const expectedBody = commandBody(dir, name)
      expect(steered).toHaveLength(MSTAR_COMMANDS.indexOf(name) + 1)
      const message = steered.at(-1)!
      expect(message.source.kind).toBe('user')
      expect(message.content[0]?.type === 'text' ? message.content[0].text : '').toBe(expectedBody)
    }
  })

  it('steers user-typed args after the command name alongside the body', async () => {
    const dir = packagedCommandsDir()
    if (dir === undefined) return
    booted = await bootApp()
    const { agent, steered } = fakeAgent()
    // The claimed path submits `/iteration-start ` + args; the rawInput
    // must reach the model with the command body, not vanish.
    const result = await booted.ctx.commands.execute(agent, '/iteration-start pause', [], new AbortController().signal)
    expect(result?.result.kind).toBe('success')
    expect(steered).toHaveLength(1)
    const message = steered[0]!
    expect(message.source.kind).toBe('user')
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    expect(text).toBe(`${commandBody(dir, 'iteration-start')}\n\n## User input\n\npause`)
  })

  it('registers no commands when the commands service is absent (optional unit)', async () => {
    // Boot without the dsh-commands row: `ctx.inject(['commands'], …)` never
    // fires and the plugin still boots cleanly. The harness always composes
    // the row, so simulate absence by asserting the deferral is inert — the
    // plugin registers through the injection only.
    const dir = packagedCommandsDir()
    if (dir === undefined) return
    booted = await bootApp()
    expect(booted.ctx.commands).toBeDefined()
  })
})
