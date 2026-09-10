/**
 * Persisted engine-status source contract — the regression pin.
 *
 * The ONE unified engine-status catalog row is appended on the first step of
 * every turn, so its `source` is a PERSISTED, cross-repo format: dsh freezes
 * the `kind` vocabulary per released session-format edge, and the released
 * historical edges refuse both a `kind` outside the first-party set and any
 * unexpected `source` member. A row that fails either audit makes the edge
 * refuse the WHOLE session log, so the contract is pinned here on a row
 * produced by the REAL composition (the `bootApp` + `ctx.waterfall(
 * 'agent/pre-step', …)` path of `catalog.spec.ts`) — never on a hand-written
 * literal, which would keep passing while the emitted row drifted.
 *
 * Assertion 1 pins the exact source value; assertion 2 pins the CLOSED member
 * set, i.e. the mechanism itself — a future "just add one field to the source"
 * edit fails here first, before it can brick a log.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { bootApp, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The ONE locked persisted source of the engine-status catalog row. */
const LOCKED_SOURCE = { kind: 'plugin', plugin: 'mstar-engine-status', form: 'catalog' } as const

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** A `agent/pre-step` payload the agent loop would dispatch. */
const stepPayload = (messages: UserMessage[]) => ({
  agent: {},
  messages,
  turn: 1,
  step: 1,
  signal: new AbortController().signal,
} as never)

/** Run one real-composition pre-step and return the appended catalog row. */
async function emittedCatalogRow(): Promise<UserMessage> {
  const app = booted = await bootApp()
  const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
  if (decision.kind !== 'enter') throw new Error('expected an enter decision')
  const row = decision.messages.at(-1)
  if (row === undefined) throw new Error('missing catalog row')
  return row
}

describe('engine-status catalog row — persisted source contract (edge-safe)', () => {
  it('persists exactly the first-party plugin arm — no custom kind, no extra member', async () => {
    const row = await emittedCatalogRow()

    expect(row.source).toEqual(LOCKED_SOURCE)
  })

  it('persists a CLOSED member set — form/kind/plugin and nothing else', async () => {
    const row = await emittedCatalogRow()

    expect(Object.keys(row.source).sort()).toEqual(['form', 'kind', 'plugin'])
  })
})
