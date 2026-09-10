/**
 * Emission-path spec: the durable engine-status snapshot is written by the
 * REAL `agent/pre-step` waterfall (the same boot composition and dispatch the
 * dsh agent loop uses), not by a test-built payload object.
 *
 * This is the harness the store spec deliberately does NOT provide: a
 * freshly-constructed payload proves nothing about what the emission site
 * persists, so every assertion here goes through
 * `bootApp()` → `ctx.waterfall('agent/pre-step', …)` and then reads the file.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { buildCatalogPayload } from '../src/gates/catalog.ts'
import {
  ENGINE_STATUS_SNAPSHOT_RELATIVE_PATH,
  readEngineStatusSnapshot,
} from '../src/engine-status-store.ts'
import { bootApp, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** One pre-existing user message the loop pulled from the inbox. */
const inboxMessage = (): UserMessage =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inbox' }] })

/** The loop's default pre-step decision: enter with the inbox messages. */
const defaultEnter =
  (messages: UserMessage[]) =>
  (): Promise<PreStepDecision> =>
    Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** One `agent/pre-step` payload carrying a real session identity. */
function stepPayloadOf(sessionId: string, cwd: string, messages: UserMessage[], turn = 1, step = 1) {
  return {
    agent: { session: { header: { id: sessionId, cwd } } },
    messages,
    turn,
    step,
    signal: new AbortController().signal,
  } as never
}

/** The stored envelope read straight off the disk. */
function envelope(app: BootResult): { sv: number; entries: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(`${app.harnessDir}/${ENGINE_STATUS_SNAPSHOT_RELATIVE_PATH}`, 'utf8'))
}

describe('engine-status snapshot — written at the real digest-gated emission', () => {
  it('persists the emitted payload keyed by session.header.id', async () => {
    const app = (booted = await bootApp())
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_alpha', app.root, inbox, 4),
      defaultEnter(inbox),
    )
    // The real path emitted the row…
    expect(decision.kind === 'enter' && decision.messages.length).toBe(inbox.length + 1)
    // …and the same payload landed in the store under the session's own key.
    expect(existsSync(`${app.harnessDir}/${ENGINE_STATUS_SNAPSHOT_RELATIVE_PATH}`)).toBe(true)
    const doc = envelope(app)
    expect(doc.sv).toBe(1)
    expect(Object.keys(doc.entries)).toEqual(['ses_alpha'])
    const read = readEngineStatusSnapshot(app.harnessDir, 'ses_alpha')
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') throw new Error('unreachable')
    expect(read.entry.rv).toBe(1)
    expect(read.entry.cwd).toBe(app.root)
    expect(read.entry.turn).toBe(4)
    // The stored payload is the REAL composed catalog payload (the same builder
    // the emission site uses), not a fixture object.
    expect(JSON.stringify(read.entry.payload)).toBe(
      JSON.stringify(buildCatalogPayload(app.ctx, app.harnessDir)),
    )
  })

  it('writes once per turn: a same-turn, unchanged row does not add an entry', async () => {
    const app = (booted = await bootApp())
    const inbox = [inboxMessage()]
    for (const step of [1, 2, 3]) {
      await app.ctx.waterfall(
        'agent/pre-step',
        stepPayloadOf('ses_alpha', app.root, inbox, 7, step),
        defaultEnter(inbox),
      )
    }
    expect((envelope(app).entries.ses_alpha ?? []).length).toBe(1)
    // The next turn is a new emission (the digest gate keys on the turn).
    await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_alpha', app.root, inbox, 8, 1),
      defaultEnter(inbox),
    )
    const bucket = envelope(app).entries.ses_alpha as Array<{ turn: number }>
    expect(bucket.map((entry) => entry.turn)).toEqual([7, 8])
  })

  it('keys independent sessions separately', async () => {
    const app = (booted = await bootApp())
    const inbox = [inboxMessage()]
    await app.ctx.waterfall('agent/pre-step', stepPayloadOf('ses_alpha', app.root, inbox, 1), defaultEnter(inbox))
    await app.ctx.waterfall('agent/pre-step', stepPayloadOf('ses_beta', '/proj/other', inbox, 1), defaultEnter(inbox))
    expect(Object.keys(envelope(app).entries).sort()).toEqual(['ses_alpha', 'ses_beta'])
    expect(readEngineStatusSnapshot(app.harnessDir, 'ses_beta').kind).toBe('ok')
  })

  it('still emits the row but persists nothing when the agent carries no session id', async () => {
    const app = (booted = await bootApp())
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall(
      'agent/pre-step',
      { agent: {}, messages: inbox, turn: 1, step: 1, signal: new AbortController().signal } as never,
      defaultEnter(inbox),
    )
    // The advisory row is unaffected — only the snapshot write is skipped (a
    // keyless write would have to invent an identity).
    expect(decision.kind === 'enter' && decision.messages.length).toBe(inbox.length + 1)
    expect(existsSync(`${app.harnessDir}/${ENGINE_STATUS_SNAPSHOT_RELATIVE_PATH}`)).toBe(false)
  })
})
