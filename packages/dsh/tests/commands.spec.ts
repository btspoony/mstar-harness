/**
 * Bundled mstar commands (omp parity, iteration v2.1.0 gap fill): the plugin
 * registers the packaged `harness-commands/*.md` mirror (synced from the
 * repo root by `bundle-assets`; gitignored) on `ctx.commands` — every shipped
 * mstar slash command (`iteration-start`, `iteration-drive`, `iteration-loop`,
 * `codebase-audit`, `codebase-comment-cleanup`, `amazing-pr-review`,
 * `amazing-test-audit`, `amazing-e2e-check`), matching the omp/opencode
 * command surface. Each registered command's handler steers the command body
 * into the receiving agent as a user message (the dsh-commands "explicitly
 * schedule model-visible work through the receiving Agent" path).
 *
 * The commands service resolve from the npm registry* ; the registrations are deferred with
 * `ctx.inject(['commands'], …)` so the plugin boots without the service.
 *
 * why: the parity surface must follow the repo, so a command shipped in
 * `commands/` is covered here without editing this file.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, readdirSync, renameSync } from 'node:fs'
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

/** The packaged mirror path, present or not (the plugin's own resolution). */
function packagedMirrorPath(): string {
  return fileURLToPath(new URL('../harness-commands', import.meta.url))
}

/** Run `run` with the packaged mirror hidden (renamed away, restored in finally). */
async function withMirrorHidden<T>(run: () => Promise<T>): Promise<T> {
  const mirror = packagedMirrorPath()
  const hidden = `${mirror}.hidden-by-test`
  const existed = existsSync(mirror)
  if (existed) renameSync(mirror, hidden)
  try {
    return await run()
  } finally {
    if (existed) renameSync(hidden, mirror)
  }
}

/** One cordis boot-log record (the exporter `Message` subset the assertions read). */
interface BootLogRecord {
  type?: unknown
  name?: unknown
  args?: unknown[]
}

/** Structural view of the cordis logger service (the default buffer exporter —
 * its level cap admits ERROR records; see fallbacks-seeds-boot-order.spec.ts). */
interface LoggerServiceView {
  buffer: BootLogRecord[]
}

/** The boot-window ERROR records of one booted app (from the default buffer). */
function bootErrorRecords(booted: BootResult): BootLogRecord[] {
  const logger = booted.ctx.logger as unknown as LoggerServiceView | undefined
  return (logger?.buffer ?? []).filter((record) => record.type === 'error')
}

/**
 * why: read lazily and never at module scope, so a package-scoped checkout
 * (no sibling repo `commands/`) still collects this file; derived from the
 * repo, so a newly shipped command needs no edit here.
 */
function repoCommands(): string[] | undefined {
  const dir = fileURLToPath(new URL('../../../commands', import.meta.url))
  if (!existsSync(dir)) return undefined
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.replace(/\.md$/, ''))
    .sort()
}

const mirrorDir = packagedCommandsDir()

/** why: the mirror is a bundle-assets sync product (gitignored), so an absent
 * mirror skips the parity case — printed ALWAYS, never a silent green. */
const mirrorSkipReason = mirrorDir === undefined
  ? 'bundled-commands parity: SKIPPED — harness-commands mirror not synced (run `bun run bundle-assets` in packages/dsh)'
  : undefined
if (mirrorSkipReason !== undefined) console.log(mirrorSkipReason)

/** why: the mirror is the product's own inventory, so a package-scoped
 * checkout asserts parity and steering against it instead of passing vacuously. */
function mirrorCommandNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.replace(/\.md$/, ''))
    .sort()
}

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

describe('bundled mstar commands (omp parity)', () => {
  it.skipIf(mirrorDir === undefined)('executes each command: the handler steers the command body into the receiving agent as a USER message', async () => {
    // why: a package-scoped checkout has no sibling repo `commands/`, so the
    // mirror it ships is the expected inventory and the loop still runs.
    const expected = repoCommands() ?? mirrorCommandNames(mirrorDir!)
    // why: an empty inventory is a broken fixture, not a pass — the parity
    // compare and the steering loop would both go vacuous.
    expect(expected.length, `bundled command inventory is empty: harness-commands mirror ${mirrorDir} holds no Markdown`).toBeGreaterThan(0)
    booted = await bootApp()
    const { agent, steered } = fakeAgent()
    expect(booted.ctx.commands.list(agent).map((descriptor) => descriptor.name)).toEqual(expected)
    for (const name of expected) {
      const result = await booted.ctx.commands.execute(agent, `/${name}`, [], new AbortController().signal)
      expect(result?.result.kind).toBe('success')
      // Scheduling as user-source work is a role boundary, not injected context.
      const message = steered.at(-1)!
      expect(message.source.kind).toBe('user')
    }
  })
})

describe('bundled mstar commands — missing mirror fails loud', () => {
  it('logs an ERROR naming the mirror path and the recovery when the harness-commands mirror is absent', async () => {
    await withMirrorHidden(async () => {
      booted = await bootApp()
      const errors = bootErrorRecords(booted)
      // No silent early return: the registration path must emit an
      // error-level record naming the missing mirror and the recovery.
      expect(errors.length, `expected an ERROR log, got ${JSON.stringify(errors)}`).toBeGreaterThanOrEqual(1)
      const text = errors.map((record) => (record.args ?? []).map(String).join(' ')).join('\n')
      expect(text).toContain('harness-commands')
      expect(text).toContain('bun run dsh:bundle-assets')
    })
  })
})
