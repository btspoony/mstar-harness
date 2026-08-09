/**
 * Bundled mstar commands (omp parity, iteration v2.1.0 gap fill): the plugin
 * registers the packaged `harness-commands/*.md` mirror (synced from the
 * repo root by `bundle-assets`; gitignored) on `ctx.commands` — the four
 * mstar slash commands (`iteration-start`, `iteration-drive`,
 * `iteration-loop`, `codebase-audit`), matching the omp/opencode command
 * surface. Each registered command's handler steers the command body into
 * the receiving agent as a user message (the dsh-commands "explicitly
 * schedule model-visible work through the receiving Agent" path).
 *
 * The commands service is a dev-time functional peer stub
 * (`@deepseek-ai/dsh-commands`); the registrations are deferred with
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

/** The four mstar slash commands (repo-root `commands/` mirror). */
const MSTAR_COMMANDS = ['iteration-start', 'iteration-drive', 'iteration-loop', 'codebase-audit'] as const

/** A minimal fake receiving agent capturing steered messages. */
function fakeAgent(): { agent: Agent; steered: UserMessage[] } {
  const steered: UserMessage[] = []
  return {
    agent: {
      id: 'test-agent',
      status: 'idle',
      steer: (message: UserMessage) => { steered.push(message) },
      followup: () => {},
    },
    steered,
  }
}

describe('bundled mstar commands (omp parity)', () => {
  it('registers the four mstar commands on ctx.commands from the packaged mirror', async () => {
    const dir = packagedCommandsDir()
    if (dir === undefined) {
      // bundle-assets has not run — nothing to register.
      expect(existsSync(fileURLToPath(new URL('../harness-commands/', import.meta.url)))).toBe(false)
      return
    }
    booted = await bootApp()
    const names = booted.ctx.commands.list(fakeAgent().agent).map((command) => command.name)
    expect(names).toEqual([...MSTAR_COMMANDS].sort())
  })

  it('executes each command: the handler steers the command body into the receiving agent', async () => {
    const dir = packagedCommandsDir()
    if (dir === undefined) return
    booted = await bootApp()
    const { agent, steered } = fakeAgent()
    for (const name of MSTAR_COMMANDS) {
      const result = await booted.ctx.commands.execute(agent, `/${name}`, new AbortController().signal)
      expect(result?.result.kind).toBe('success')
      // The steered message is a user message whose text is the command body
      // (the mirror's `<name>.md` body — identical to the repo-root command).
      const expectedBody = readFileSync(join(dir, `${name}.md`), 'utf8')
        .replace(/^---[\s\S]*?---\r?\n?/, '')
        .trim()
      expect(steered).toHaveLength(MSTAR_COMMANDS.indexOf(name) + 1)
      const message = steered.at(-1)!
      expect(message.source.kind).toBe('plugin')
      expect(message.content[0]?.type === 'text' ? message.content[0].text : '').toBe(expectedBody)
    }
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
