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
import { initializeStore, readDshStatusEmission, readExecutionState } from '@mstar-harness/engine'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { buildCatalogPayloadWithStore } from '../src/gates/catalog.ts'
import { readEngineStatusSnapshot, writeEngineStatusSnapshot } from '../src/engine-status-store.ts'
import { bootApp, seedOpenIssue, seedStore, type BootResult } from './harness.ts'

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

describe('engine-status emission — written at the real change-driven emission', () => {
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

  it('keeps ONE row per session: an unchanged step emits nothing and a real change replaces the emission', async () => {
    // TTL 0 rebuilds the payload at every step, so a change is visible
    // immediately — and an UNCHANGED rebuild (whose only difference is the
    // emission's own store-revision write) must still emit nothing.
    const app = (booted = await bootApp({ catalogTtlMs: 0 }))
    await seedStore(app.harnessDir)
    const inbox = [inboxMessage()]
    for (const step of [1, 2, 3]) {
      const decision = await app.ctx.waterfall(
        'agent/pre-step',
        stepPayloadOf('ses_alpha', app.root, inbox, 7, step),
        defaultEnter(inbox),
      )
      // Only the first step appends: the rebuilt payload is unchanged, and the
      // revision its predecessor's write bumped is normalized away.
      expect(decision.kind === 'enter' && decision.messages.length).toBe(step === 1 ? inbox.length + 1 : inbox.length)
    }
    // The store keeps ONE row, still the first emission's turn.
    const sameTurn = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_alpha', app.root)
    expect(sameTurn.kind === 'ok' && sameTurn.emission?.turn).toBe(7)

    // A REAL change (a newly open issue changes the panel projection) is the
    // emission trigger: the row is replaced with the new turn.
    await seedOpenIssue(app.harnessDir, { title: 'a newly opened issue', severity: 'high', operationId: 'op-emission-turn' })
    const changed = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_alpha', app.root, inbox, 8, 1),
      defaultEnter(inbox),
    )
    expect(changed.kind === 'enter' && changed.messages.length).toBe(inbox.length + 1)
    const nextTurn = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_alpha', app.root)
    expect(nextTurn.kind === 'ok' && nextTurn.emission?.turn).toBe(8)
  })

  it('writes the replacement generation only for a real change, and refuses a write carrying the retired generation', async () => {
    const app = (booted = await bootApp({ catalogTtlMs: 0 }))
    await seedStore(app.harnessDir)
    const inbox = [inboxMessage()]
    const first = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_generation', app.root, inbox, 1),
      defaultEnter(inbox),
    )
    expect(first.kind === 'enter' && first.messages.length).toBe(inbox.length + 1)
    expect(readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_generation', app.root).kind).toBe('ok')
    // The generation the first emission was built under (the one it persisted with).
    const retired = await readExecutionState({ harnessDir: app.harnessDir })

    // Replace the authority generation.
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(app.harnessDir, `store.db${suffix}`), { force: true })
    const replacement = await initializeStore({ harnessDir: app.harnessDir })
    replacement.close()

    // No change → no emission, so the retired row is not resurrected and
    // nothing is written into the replacement generation.
    const unchanged = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_generation', app.root, inbox, 2),
      defaultEnter(inbox),
    )
    expect(unchanged.kind === 'enter' && unchanged.messages.length).toBe(inbox.length)
    const afterReplacement = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_generation', app.root)
    expect(afterReplacement.kind === 'ok' && afterReplacement.emission).toBeUndefined()

    // A REAL change in the replacement generation emits with the CURRENT
    // generation: the row lands, keyed by the new turn.
    await seedOpenIssue(app.harnessDir, { title: 'a replacement-generation issue', severity: 'medium', operationId: 'op-emission-generation' })
    const changed = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_generation', app.root, inbox, 3),
      defaultEnter(inbox),
    )
    expect(changed.kind === 'enter' && changed.messages.length).toBe(inbox.length + 1)
    const writtenRead = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_generation', app.root)
    expect(writtenRead.kind === 'ok' && writtenRead.emission?.turn).toBe(3)

    // The guard still refuses a write that carries the retired generation —
    // a cached payload can never resurrect the previous authority's row.
    const stale = writeEngineStatusSnapshot(app.harnessDir, {
      sessionId: 'ses_retired',
      cwd: app.root,
      turn: 9,
      payload: await buildCatalogPayloadWithStore(app.ctx, app.harnessDir),
      selectedGeneration: { storeId: retired.storeId, epoch: retired.epoch },
    })
    expect(stale.kind).toBe('degraded')
    expect(stale.kind === 'degraded' && stale.reason).toContain('store.stale-epoch')
    const retiredRead = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_retired', app.root)
    expect(retiredRead.kind === 'ok' && retiredRead.emission).toBeUndefined()
  })

  it('retries a degraded persist on a later UNCHANGED step without re-appending the row', async () => {
    // Default TTL: each session+workspace keeps ONE cached payload across the
    // three steps, so every step after the first carries the same rendered text
    // and panel projection (the change gate stays closed).
    const app = (booted = await bootApp())
    const inbox = [inboxMessage()]
    // (a) No ACTIVE store yet: the row IS emitted, and its persist degrades.
    const first = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_retry', app.root, inbox, 1, 1),
      defaultEnter(inbox),
    )
    expect(first.kind === 'enter' && first.messages.length).toBe(inbox.length + 1)
    expect(readEngineStatusSnapshot(app.harnessDir, 'ses_retry', app.root).kind).toBe('unavailable')

    // (b) The store becomes ACTIVE. The payload is unchanged, so no second row
    // is appended — but the pending persist is retried and lands.
    await seedStore(app.harnessDir)
    const second = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_retry', app.root, inbox, 2, 2),
      defaultEnter(inbox),
    )
    expect(second.kind === 'enter' && second.messages.length).toBe(inbox.length)
    const persisted = readEngineStatusSnapshot(app.harnessDir, 'ses_retry', app.root)
    expect(persisted.kind).toBe('ok')
    if (persisted.kind !== 'ok') throw new Error('unreachable')
    expect(persisted.entry.turn).toBe(2)

    // (c) The successful retry clears the latch: a third unchanged step neither
    // appends the row nor rewrites the emission (the persisted turn stays 2).
    const third = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayloadOf('ses_retry', app.root, inbox, 3, 3),
      defaultEnter(inbox),
    )
    expect(third.kind === 'enter' && third.messages.length).toBe(inbox.length)
    const unchanged = readDshStatusEmission({ harnessDir: app.harnessDir }, 'ses_retry', app.root)
    expect(unchanged.kind === 'ok' && unchanged.emission?.turn).toBe(2)
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
