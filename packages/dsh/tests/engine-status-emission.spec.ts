/**
 * Emission-path spec: the durable engine-status emission is written by the
 * REAL `agent/pre-step` waterfall (the same boot composition and dispatch the
 * dsh agent loop uses), not by a test-built payload object.
 *
 * This is the harness the store spec deliberately does NOT provide: a
 * freshly-constructed payload proves nothing about what the emission site
 * persists, so every assertion here goes through
 * `bootApp()` → `ctx.waterfall('agent/pre-step', …)` and then reads the
 * emission back through the store's own read verb.
 *
 * The harness carries an ACTIVE store: an emission is a store row, and a
 * workspace without an ACTIVE authority persists nothing (that degrade is
 * covered by the store spec — here the store exists, so a written row is the
 * only correct outcome).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { initializeStore, readDshStatusEmission } from '@mstar-harness/engine'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { buildCatalogPayloadWithStore } from '../src/gates/catalog.ts'
import { readEngineStatusSnapshot } from '../src/engine-status-store.ts'
import { bootApp, seedStore, type BootResult } from './harness.ts'

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

describe('engine-status emission — written at the real digest-gated emission', () => {
  it('persists the emitted payload keyed by session.header.id and cwd', async () => {
    const app = (booted = await bootApp())
    await seedStore(app.harnessDir)
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_alpha', app.root, inbox, 4),
      defaultEnter(inbox),
    )
    // The real path emitted the row…
    expect(decision.kind === 'enter' && decision.messages.length).toBe(inbox.length + 1)
    // …and the same payload landed as this session's emission row.
    const read = readEngineStatusSnapshot(app.harnessDir, 'ses_alpha', app.root)
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') throw new Error('unreachable')
    expect(read.entry.rv).toBe(1)
    expect(read.entry.cwd).toBe(app.root)
    expect(read.entry.turn).toBe(4)
    // The stored payload is the REAL composed catalog payload (the same builder
    // the emission site uses), not a fixture object. The store facts' revision
    // is normalized away: persisting the emission advances the shared store
    // revision, so a payload rebuilt after the write legitimately reports a
    // newer revision than the one the model saw.
    const normalize = (payload: unknown): string => {
      const copy = JSON.parse(JSON.stringify(payload)) as { state?: { storeFacts?: { storeRevision?: unknown } } }
      if (copy.state?.storeFacts !== undefined) delete copy.state.storeFacts.storeRevision
      return JSON.stringify(copy)
    }
    expect(normalize(read.entry.payload)).toBe(
      normalize(await buildCatalogPayloadWithStore(app.ctx, app.harnessDir)),
    )
  })

  it('keeps ONE row per session: a later turn replaces the emission instead of appending history', async () => {
    const app = (booted = await bootApp())
    await seedStore(app.harnessDir)
    const inbox = [inboxMessage()]
    for (const step of [1, 2, 3]) {
      await app.ctx.waterfall(
        'agent/pre-step',
        stepPayloadOf('ses_alpha', app.root, inbox, 7, step),
        defaultEnter(inbox),
      )
    }
    // Same-turn re-emission is digest-gated AND the store keeps one row.
    const sameTurn = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_alpha', app.root)
    expect(sameTurn.kind === 'ok' && sameTurn.emission?.turn).toBe(7)
    // The next turn is a new emission: it UPSERTs the same session row.
    await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_alpha', app.root, inbox, 8, 1),
      defaultEnter(inbox),
    )
    const nextTurn = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_alpha', app.root)
    expect(nextTurn.kind === 'ok' && nextTurn.emission?.turn).toBe(8)
  })

  it('does not write a cached emission into a replacement authority generation', async () => {
    const app = (booted = await bootApp())
    await seedStore(app.harnessDir)
    const inbox = [inboxMessage()]
    await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_generation', app.root, inbox, 1),
      defaultEnter(inbox),
    )
    expect(readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_generation', app.root).kind).toBe('ok')

    for (const suffix of ['', '-wal', '-shm']) rmSync(join(app.harnessDir, `store.db${suffix}`), { force: true })
    const replacement = await initializeStore({ harnessDir: app.harnessDir })
    replacement.close()

    const decision = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_generation', app.root, inbox, 2),
      defaultEnter(inbox),
    )
    expect(decision.kind).toBe('enter')
    const replacementRead = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_generation', app.root)
    expect(replacementRead.kind === 'ok' && replacementRead.emission).toBeUndefined()
  })

  it('keys independent sessions separately', async () => {
    const app = (booted = await bootApp())
    await seedStore(app.harnessDir)
    const inbox = [inboxMessage()]
    await app.ctx.waterfall('agent/pre-step', stepPayloadOf('ses_alpha', app.root, inbox, 1), defaultEnter(inbox))
    await app.ctx.waterfall('agent/pre-step', stepPayloadOf('ses_beta', '/proj/other', inbox, 1), defaultEnter(inbox))
    expect(readEngineStatusSnapshot(app.harnessDir, 'ses_alpha', app.root).kind).toBe('ok')
    expect(readEngineStatusSnapshot(app.harnessDir, 'ses_beta', '/proj/other').kind).toBe('ok')
    // A cwd that is not the row's own workspace is never served.
    expect(readEngineStatusSnapshot(app.harnessDir, 'ses_beta', app.root).kind).toBe('unavailable')
  })

  it('still emits the row but persists no row when the agent carries no session id', async () => {
    const app = (booted = await bootApp())
    await seedStore(app.harnessDir)
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall(
      'agent/pre-step',
      { agent: {}, messages: inbox, turn: 1, step: 1, signal: new AbortController().signal } as never,
      defaultEnter(inbox),
    )
    // The advisory row is unaffected — only the emission write is skipped (a
    // keyless write would have to invent an identity).
    expect(decision.kind === 'enter' && decision.messages.length).toBe(inbox.length + 1)
    const absentRead = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_alpha', app.root)
    expect(absentRead.kind === 'ok' && absentRead.emission).toBeUndefined()
  })
})
