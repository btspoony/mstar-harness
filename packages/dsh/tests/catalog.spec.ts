/**
 * Task 5 — mstar-engine-status catalog at agent/pre-step (plan
 * 20260808-dsh-host-adapter), extended by plan
 * `20260811-panel-f4-timeliness` Task 2: the catalog TTL invalidation — a
 * ledger change (recordDispatch) deletes the workspace cache entry so the
 * next pre-step rebuilds fresh sources and the digest re-emits the changed
 * row within the REAL TTL (AC-2); a non-record out-of-band ledger write
 * stays TTL-bounded (cache-hit behavior unchanged — only the record path
 * invalidates). Extended by plan `20260811-panel-f4-iteration-zone` Task 1:
 * the optional `iteration.compassStatus` surface (steering compass
 * frontmatter `status` — active/locked present, non-steering status
 * omits the whole iteration row; spec panel-f4 §5 D5).
 *
 * Dev-time reality (brief): the llm/agent seams are dev-time STUBS (no real
 * runtime), so the pre-step waterfall is simulated with the typed harness —
 * the exact `ctx.waterfall('agent/pre-step', payload, next)` dispatch the
 * real dsh agent loop performs (core/agent/types.ts, dsh-private 9451be2) —
 * with the terminal `next()` standing in for the loop's default step decision
 * (`{ kind: 'enter', messages: payload.messages }`).
 *
 * Contract under test (brief + plan Task 5): the listener is advisory — it
 * MUST call `next()` and build on the delegated decision; it never returns
 * `reject` (would block the step) and never replaces the delegated messages
 * (would drop them). It appends one `catalog`-form MessageSource named
 * `mstar-engine-status` whose content is the unified mstar version
 * (own manifest, single-version invariant with the bundled engine), the
 * compass enforcement mode (`resolveCompassEnforcement`), the harness dir,
 * — so the model-visible row is reconstructable from the session log
 * (MessageSource form; model-visible ⟺ logged). The watermark is
 * boot/workspace-resolved (qc3 W-002) and the append is error-contained
 * (qc3 W-003); an aborted step returns the delegated decision unchanged
 * (qc2 S-001). Fiber disposal removes the listener (HMR-safe).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import * as plugin from '../src/index.ts'
import type { MstarEngineStatusSource } from '../src/index.ts'
import { bootApp, FakeLoaderRegistry, seedHarness, v2Root, v2Snapshot, v2WorkflowEntry, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The plugin's own manifest version (the catalog's `version` field). */
const PLUGIN_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** One pre-existing user message the loop pulled from the inbox. */
const inboxMessage = (): UserMessage => createUserMessage({
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'hello from the inbox' }],
})

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** A `agent/pre-step` payload the agent loop would dispatch. */
const stepPayload = (messages: UserMessage[], signal = new AbortController().signal) => ({
  agent: {},
  messages,
  turn: 1,
  step: 1,
  signal,
} as never)

/** The last message of an enter decision (the appended catalog when present). */
const lastMessage = (decision: PreStepDecision): UserMessage | undefined =>
  decision.kind === 'enter' ? decision.messages.at(-1) : undefined

/** Narrow an enter decision to its appended engine-status catalog row. */
function catalogRowOf(decision: PreStepDecision): { row: UserMessage; source: MstarEngineStatusSource } {
  if (decision.kind !== 'enter') throw new Error('expected enter')
  const row = decision.messages.at(-1)
  if (row === undefined) throw new Error('missing catalog row')
  const source = row.source
  if (source.kind !== 'mstar-engine-status') throw new Error('missing catalog row')
  return { row, source }
}

/** The model-facing text of a catalog row. */
function textOf(row: UserMessage): string {
  return row.content[0]?.type === 'text' ? row.content[0].text : ''
}

describe('mstar-engine-status catalog — pre-step composition (REAL-composition boot)', () => {
  it('appends the catalog MessageSource; the text appears in the composed session log', async () => {
    const app = booted = await bootApp()
    const inbox = [inboxMessage()]

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    // Advisory: the delegated decision wins — enter, with every inbox message preserved.
    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' && decision.messages.length).toBe(inbox.length + 1)
    expect(decision.kind === 'enter' && decision.messages.slice(0, -1)).toEqual(inbox)

    // The appended row is the durable catalog MessageSource (model-visible ⟺ logged).
    const catalog = lastMessage(decision)
    expect(catalog?.role).toBe('user')
    expect(catalog?.source).toMatchObject({
      kind: 'mstar-engine-status',
      form: 'catalog',
      version: PLUGIN_VERSION,
      harnessDir: app.harnessDir,
      enforcement: { hard: false, source: 'none' },
    })
    // The composed session log carries the model-facing text.
    expect(catalog?.content[0]?.type).toBe('text')
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain(`mstar version: ${PLUGIN_VERSION}`)
    expect(text).toContain(`harness dir: ${app.harnessDir}`)
    expect(text).toContain('enforcement: soft')
  })

  it('renders the compass enforcement mode as the watermark (active hard compass → hard)', async () => {
    // The watermark is built at boot for the explicit config (the cache is
    // pre-seeded at apply) — the compass must exist before apply() runs to
    // be seen by the boot build.
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-compass-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'iterations/20260808-catalog-test/delivery-compass.md': [
        '---',
        'status: active',
        'enforcement: hard',
        '---',
        '',
        'body text must not count',
      ].join('\n'),
    })

    const app = booted = await bootApp({ root })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const catalog = lastMessage(decision)
    expect(catalog?.source).toMatchObject({
      kind: 'mstar-engine-status',
      form: 'catalog',
      enforcement: { hard: true, source: 'compass' },
    })
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain('enforcement: hard (compass)')
  })

  it('keeps the watermark stable within the catalog TTL — a compass appearing after boot does not re-watermark immediately (qc3 W-002, TTL-bounded)', async () => {
    const app = booted = await bootApp()
    // The cache is built at boot for the explicit config; a compass that
    // appears after boot does not change the catalog row until the catalog
    // TTL expires (Config `catalogTtlMs`, default 60000 — the documented
    // staleness tradeoff for keeping disk I/O off the hot path).
    await seedHarness(app.harnessDir, {
      'iterations/20260808-catalog-test/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const catalog = lastMessage(decision)
    expect(catalog?.source).toMatchObject({ enforcement: { hard: false, source: 'none' } })
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain('enforcement: soft')
  })

  it('omits the iteration section when the iteration-gate row cannot be built — the appended message stays losslessly JSON-serializable (Session.append boundary)', async () => {
    // Default boot fixture: explicit harnessDir but NO status.json and NO
    // steering compass, so `iterationGateSource` cannot build its row. The
    // unified source must then carry the optional `iteration` key ABSENT —
    // never `iteration: undefined`: the agent loop appends the composed
    // message to the real session, whose `Session.append` rejects event
    // data with undefined-valued object properties as non-lossless JSON
    // (round failure: `session event "user/message" carries
    // non-JSON-serializable data`).
    const app = booted = await bootApp()

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const catalog = lastMessage(decision)
    const source = catalog?.source as Record<string, unknown>
    expect(source).toMatchObject({ kind: 'mstar-engine-status' })
    expect(Object.keys(source).every((key) => source[key] !== undefined)).toBe(true)
    expect('iteration' in source).toBe(false)
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).not.toContain('iteration:')
  })

  it('delegates a rejected step without appending (advisory — never vetoes, never publishes on a blocked step)', async () => {
    const app = booted = await bootApp()
    const inbox = [inboxMessage()]

    const decision = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayload(inbox),
      () => Promise.resolve<PreStepDecision>({ kind: 'reject' }),
    )

    expect(decision).toEqual({ kind: 'reject' })
  })

  it('composes with later deciders — appends to the final delegated decision, not a fabricated one', async () => {
    const app = booted = await bootApp()
    const inbox = [inboxMessage()]
    // A later-mounted listener (e.g. another catalog) replaces the message set
    // with its own enter decision; the mstar listener must build on THAT.
    const replaced = [inboxMessage()]
    app.ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
      return next()
    }, { prepend: false })
    app.ctx.on('agent/pre-step', async (_payload, _next): Promise<PreStepDecision> => {
      return { kind: 'enter', messages: replaced }
    })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' && decision.messages.slice(0, -1)).toEqual(replaced)
    const catalog = lastMessage(decision)
    expect(catalog?.source).toMatchObject({ kind: 'mstar-engine-status' })
  })

  it('observes the step abort signal — an aborted step publishes no catalog and returns the delegated decision (qc2 S-001)', async () => {
    const app = booted = await bootApp()
    const controller = new AbortController()
    controller.abort()

    // Narrowed abort race: an abort after delegation returns the delegated
    // decision unchanged (clean abort semantics) instead of surfacing an
    // AbortError as a turn failure; the catalog simply is not appended.
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([], controller.signal), defaultEnter([]))

    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('contains a third-party decider with non-iterable messages — the step still delegates unchanged (qc3 W-003)', async () => {
    const app = booted = await bootApp()
    // A downstream (third-party) pre-step decider returns an enter decision
    // whose messages are not iterable (cordis waterfalls do not validate
    // listener return values). The catalog append must not abort the step:
    // the delegated decision is returned unchanged after an error log.
    const broken = 42 as unknown as UserMessage[]
    app.ctx.on('agent/pre-step', async (_payload, _next): Promise<PreStepDecision> => {
      return { kind: 'enter', messages: broken }
    })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    expect(decision).toEqual({ kind: 'enter', messages: broken })
  })
})

describe('mstar-engine-status catalog — iteration compassStatus (spec panel-f4 §5 D5, plan 20260811-panel-f4-iteration-zone Task 1)', () => {
  /** The iteration workflow id the steering compass registers. */
  const ITERATION_WORKFLOW = 'iter-20260811-catalog-compass'
  /** Minimal v2 root status.json (one active iteration workflow). */
  const VALID_STATUS_JSON = v2Root([v2WorkflowEntry(ITERATION_WORKFLOW, 'iteration')])

  /** A minimal engine-shape-VALID delivery-compass frontmatter (spec D5 — the steering status value is the signal). */
  function compassDoc(status: 'active' | 'locked' | 'completed'): string {
    return [
      '---',
      'iteration_id: iter-20260811-catalog-compass',
      'start_date: 2026-08-11',
      `status: ${status}`,
      'iteration_base_branch: dev-dsh',
      'target_branch: dev-dsh',
      '---',
      '',
      '## Direction lock',
      'Catalog compassStatus surface.',
    ].join('\n')
  }

  /** Boot with status.json + a delivery-compass seeded, then run one pre-step and return the catalog source. */
  async function sourceWithCompass(status: 'active' | 'locked' | 'completed'): Promise<MstarEngineStatusSource> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-compassstatus-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': VALID_STATUS_JSON,
      [`workflows/${ITERATION_WORKFLOW}/snapshot.json`]: v2Snapshot(ITERATION_WORKFLOW, { type: 'iteration' }),
      'iterations/iter-20260811-catalog-compass/delivery-compass.md': compassDoc(status),
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    return catalogRowOf(decision).source
  }

  it('surfaces `compassStatus: active` when the steering compass is active (Phase 1 in flight)', async () => {
    const source = await sourceWithCompass('active')
    expect(source.iteration).toBeDefined()
    expect(source.iteration!.compassStatus).toBe('active')
    expect(source.iteration!.iterationId).toBe('iter-20260811-catalog-compass')
    // The empty-plans fixture: engine emits phase-2-execute + ok:true during
    // Phase 1 — `iteration.active` is true, only the current step re-derives
    // from compassStatus (projection side).
    expect(source.iteration!.gate.transition).toBe('phase-2-execute')
    expect(source.iteration!.gate.ok).toBe(true)
  })

  it('surfaces `compassStatus: locked` when the steering compass is locked (Phase 1 complete)', async () => {
    const source = await sourceWithCompass('locked')
    expect(source.iteration!.compassStatus).toBe('locked')
  })

  it('omits compassStatus (and the whole iteration row) for a NON-steering status — the steering filter never admits it (belt-and-suspenders guard)', async () => {
    // `status: completed` is not active|locked → `steeringCompassPath` skips
    // the compass → no iteration section at all. The appended message stays
    // losslessly JSON-serializable (no undefined-valued props, Session.append).
    const source = await sourceWithCompass('completed')
    expect(Object.keys(source).every((key) => (source as unknown as Record<string, unknown>)[key] !== undefined)).toBe(true)
    expect('iteration' in source).toBe(false)
  })
})

describe('mstar-engine-status catalog — plan iterationRefs (plan 20260813-panel-quick-fixes Task 2)', () => {
  /** Boot with a v2 tree whose selected snapshot plans carry (or omit) `metadata.iteration_refs`, then return the state section. */
  async function stateWithPlans(plans: unknown[]): Promise<NonNullable<MstarEngineStatusSource['state']>> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-iterationrefs-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-iterrefs')]),
      'workflows/wf-iterrefs/snapshot.json': v2Snapshot('wf-iterrefs', { plans }),
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { source } = catalogRowOf(decision)
    const state = source.state
    if (state === null) throw new Error('expected a non-null state section')
    return state
  }

  it('projects each plan\'s metadata.iteration_refs into `iterationRefs` (string[]; missing → [])', async () => {
    const state = await stateWithPlans([
      { id: 'plan-a', status: 'Done', metadata: { iteration_refs: ['iter-20260812', 'iter-20260813'] } },
      { id: 'plan-b', status: 'Done', metadata: { iteration_refs: [] } },
      { id: 'plan-c', status: 'Done', metadata: {} },
      { id: 'plan-d', status: 'Done' },
    ])
    expect(state.plans.map((p) => p.iterationRefs)).toEqual([
      ['iter-20260812', 'iter-20260813'],
      [],
      [],
      [],
    ])
  })

  it('a non-array / partially-garbage iteration_refs → [] (or only the string members) — never omitted', async () => {
    const state = await stateWithPlans([
      { id: 'plan-a', status: 'Done', metadata: { iteration_refs: 'iter-x' } },
      { id: 'plan-b', status: 'Done', metadata: { iteration_refs: [42, 'iter-y', null, ''] } },
    ])
    expect(state.plans.map((p) => p.iterationRefs)).toEqual([[], ['iter-y']])
  })
})

describe('catalog TTL invalidation — ledger change refreshes within the TTL (plan 20260811-panel-f4-timeliness Task 2)', () => {
  /** A minimal Assignment for the ledger record (role derives to `fullstack-dev`). */
  const ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev

## Task 2

Implement the invalidation.
`

  /** A v2 tree with one active workflow (`wf-1`) and an empty workflow ledger. */
  async function seedV2Tree(root: string): Promise<string> {
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
    })
    return harnessDir
  }

  it('a ledger change within the TTL invalidates the cache — the next pre-step rebuilds fresh sources and the digest re-emits the changed row (AC-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-invalidate-'))
    const harnessDir = await seedV2Tree(root)
    // REAL TTL (default 60000): a refresh at the second pre-step can only
    // come from the ledger-change invalidation — never from a TTL expiry.
    const app = booted = await bootApp({ root })

    // Pre-step 1 (turn 1): no ledger events yet — the row is injected once.
    const first = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { source: firstSource } = catalogRowOf(first)
    expect(firstSource.state!.agentFlow).toEqual({ events: [], summary: [] })

    // One successful ledger record — the apply-bound invalidator deletes the
    // workspace's catalog cache entry (the TTL itself is untouched).
    // Final-state (Task 2 writer cutover): the record itself lands in the
    // ACTIVE workflow dir — the catalog reads the SAME file, so the
    // invalidation observable is the record's own line (no out-of-band write).
    plugin.recordDispatch({ harnessDir, prompt: ASSIGNMENT, violations: [], hard: false })

    // Pre-step 2 — SAME turn (step 2): the digest gate suppresses an
    // UNCHANGED row, so this re-injection can only be the digest text change
    // from the invalidation-triggered rebuild (the sources now carry the new
    // workflow-dir dispatch event).
    const second = await app.ctx.waterfall('agent/pre-step', {
      agent: {},
      messages: [],
      turn: 1,
      step: 2,
      signal: new AbortController().signal,
    } as never, defaultEnter([]))
    const { row, source } = catalogRowOf(second)
    expect(source.state!.agentFlow!.events).toHaveLength(1)
    expect(source.state!.agentFlow!.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'ok', role: 'fullstack-dev' })
    expect(textOf(row)).toContain('agent flow: 1 events')
    expect(textOf(row)).toContain('by role: fullstack-dev 1')
  })

  it('cross-workspace isolation: a ledger record in workspace A invalidates ONLY A — B\'s cached entry survives within the TTL (qc1 F-103 / qc2 F-003 / qc3 F-004 fix-wave)', async () => {
    // Two workspaces, each with its OWN probed harness root — no explicit
    // config, so each session cwd resolves its own `{HARNESS_DIR}` and its own
    // cache key (the session cwd) + reverse-map entry (D3: per-workspace
    // invalidation — a record deletes EXACTLY the affected workspace's entry,
    // never a global clear).
    const wsA = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-isolate-a-'))
    const wsB = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-isolate-b-'))
    for (const ws of [wsA, wsB]) {
      await seedHarness(join(ws, '.mstar'), {
        'status.json': v2Root([v2WorkflowEntry('wf-1')]),
        'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
      })
    }
    const stepFor = (cwd: string, turn: number) => ({
      agent: { session: { header: { cwd } } },
      messages: [],
      turn,
      step: 1,
      signal: new AbortController().signal,
    } as never)
    const app = booted = await bootApp({ harnessDir: null })

    // Register BOTH workspace keys with one pre-step each (the cache is built
    // on first use + the reverse map registers on build).
    const sourceA1 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor(wsA, 1), defaultEnter([]))).source
    const sourceB1 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor(wsB, 1), defaultEnter([]))).source
    expect(sourceA1.state!.agentFlow).toEqual({ events: [], summary: [] })
    expect(sourceB1.state!.agentFlow).toEqual({ events: [], summary: [] })

    // An OUT-OF-BAND ledger line in B (direct write to the workflow dir,
    // bypassing recordDispatch → NO invalidation fires for B): if B's cache
    // entry survives, the line stays INVISIBLE within the REAL TTL (cache hit
    // — no rebuild). This is the observable for "B's cached entry survives":
    // the dsh-llm message envelope deep-clones its source (`createMessage` →
    // `freezeMessage` → `structuredClone`), so cache-hit identity cannot be
    // asserted by reference equality through the message — the direct-write
    // invisibility is the equivalent (and stronger) cache-hit proof.
    await writeFile(
      join(wsB, '.mstar', 'workflows/wf-1', plugin.AGENT_FLOW_FILE),
      `${JSON.stringify({ v: 1, ts: Date.now(), kind: 'dispatch', role: 'fullstack-dev', verdict: 'ok', hard: false })}\n`,
    )

    // A ledger record for workspace A ONLY — the apply-bound invalidator
    // fires with A's harness dir → deletes exactly A's cache entry.
    // Final-state (Task 2 writer cutover): the record itself lands in A's
    // ACTIVE workflow dir — the catalog reads the SAME file, so the rebuild
    // observable is the record's own line (no out-of-band write).
    plugin.recordDispatch({ harnessDir: join(wsA, '.mstar'), prompt: ASSIGNMENT, violations: [], hard: false })

    // Next pre-step for A (new turn): the entry was invalidated → REBUILT (a
    // fresh source carrying the new workflow-dir dispatch event).
    const sourceA2 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor(wsA, 2), defaultEnter([]))).source
    expect(sourceA2.state!.agentFlow!.events).toHaveLength(1)
    expect(sourceA2.state!.agentFlow!.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'ok', role: 'fullstack-dev' })

    // Next pre-step for B (new turn): B's entry was NOT invalidated → the
    // cache HIT serves the cached build — the out-of-band B line stays
    // invisible within the TTL (no global clear; a multi-workspace deployment
    // does not rebuild every workspace per record).
    const sourceB2 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor(wsB, 2), defaultEnter([]))).source
    expect(sourceB2.state!.agentFlow).toEqual({ events: [], summary: [] }) // cached build — the direct line is NOT visible
  })

  it('without a ledger change the cache-hit behavior is unchanged — a directly-written ledger line stays invisible within the TTL (only the record path invalidates)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-cachehit-'))
    const harnessDir = await seedV2Tree(root)
    const app = booted = await bootApp({ root })

    // Pre-step 1 (turn 1): no events → no agent-flow line.
    const first = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    expect(textOf(lastMessage(first)!)).not.toContain('agent flow:')

    // Write a ledger line DIRECTLY into the workflow dir (bypassing
    // recordDispatch → NO invalidation fires): the disk now differs from the
    // cached build.
    await writeFile(
      join(harnessDir, 'workflows/wf-1', plugin.AGENT_FLOW_FILE),
      `${JSON.stringify({ v: 1, ts: Date.now(), kind: 'dispatch', role: 'fullstack-dev', verdict: 'ok', hard: false })}\n`,
    )

    // Pre-step 2 (turn 2, within the REAL TTL): the cache entry was NOT
    // invalidated → the cached build is reused (stale) — the 60s TTL
    // fallback still bounds an out-of-band ledger change.
    const second = await app.ctx.waterfall('agent/pre-step', {
      agent: {},
      messages: [],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    } as never, defaultEnter([]))
    const { row, source } = catalogRowOf(second)
    expect(source.state!.agentFlow).toEqual({ events: [], summary: [] })
    expect(textOf(row)).not.toContain('agent flow:')
  })
})

/* ===========================================================================
 * v3 per-lifecycle aggregation (plan 20260819-workflow-dsh-viz Task 1) —
 * the catalog row aggregates the SELECTED workflow lifecycle (compass
 * v3.0.0 § Catalog selection rule): active `workflows[]` first (multi-active
 * → first + a structured warning), else the latest terminal snapshot by
 * mtime, else a clear error. ZoneView field shapes stay byte-compatible
 * (the golden test pins the legacy-row shape).
 * ========================================================================== */

describe('mstar-engine-status catalog — v3 per-lifecycle aggregation (plan 20260819-workflow-dsh-viz Task 1)', () => {
  /** The selected workflow id of the golden fixture. */
  const GOLDEN_WORKFLOW = 'wf-golden'
  /** The golden fixture's snapshot plans[] (legacy PlanRow shape verbatim). */
  const GOLDEN_PLANS = [
    {
      plan_id: 'plan-a',
      title: 'Plan A',
      status: 'InProgress',
      execution_lease: {
        holder: 'dsh-session-1',
        claimed_at: '2026-08-19',
        worktree_path: '/worktrees/plan-a',
        working_branch: 'feature/plan-a',
      },
    },
    { id: 'plan-b', title: 'Plan B', status: 'Done', done_at: '2026-08-19' },
  ]
  /** The golden fixture's project register (the v1 `residual_findings` home). */
  const GOLDEN_REGISTER = {
    entries: {
      'plan-b': [
        { id: 'R1', title: 'deferred blocker', severity: 'high', lifecycle: 'open', source_plan: 'plan-b', registered_at: '2026-08-19' },
        { id: 'R2', title: 'style nit', severity: 'nit', source_plan: 'plan-b', registered_at: '2026-08-19' },
      ],
    },
  }
  /** The golden fixture's project roadmap (frontmatter milestones — the project rollup source). */
  const GOLDEN_ROADMAP = [
    '---',
    'project_id: _default',
    'title: Golden project',
    'status: active',
    'created_at: 2026-08-19',
    'milestones:',
    '  - P1 foundation',
    '  - P2 migrate + dogfood',
    '  - P3 dsh viz',
    '---',
    '',
    '## Direction',
    '',
    '- [x] P1 foundation',
    '- [ ] P2 migrate + dogfood',
    '',
  ].join('\n')
  /** The golden fixture's workflow-dir agent-flow ledger (two events). */
  const GOLDEN_FLOW_LINES = [
    { v: 1, ts: 1_700_000_000_000, kind: 'dispatch', role: 'fullstack-dev', planId: 'plan-a', taskId: 'T1', verdict: 'ok', hard: false },
    { v: 1, ts: 1_700_000_000_001, kind: 'settle', role: 'fullstack-dev', planId: 'plan-a', taskId: 'T1', outcome: 'ok' },
  ]
  /** A steering compass with a `## Direction lock` problem statement. */
  const GOLDEN_COMPASS = [
    '---',
    'iteration_id: v2.2.0',
    'start_date: 2026-08-19',
    'status: active',
    'iteration_base_branch: dev-dsh',
    'target_branch: dev-dsh',
    'plans:',
    '  - plan-a',
    '---',
    '',
    '## Direction lock',
    '',
    '- **Problem statement:** Golden direction.',
    '',
  ].join('\n')
  /** A knowledge index with one doc. */
  const GOLDEN_KNOWLEDGE = [
    '# Knowledge Index',
    '',
    '| Document | Source | Description | Status |',
    '|----------|--------|-------------|--------|',
    '| `conventions/harness-context.md` | iteration:v2.2.0 | context digest | active |',
    '',
  ].join('\n')

  it('v2 fixture tree → catalog row equal-shape vs the legacy-row golden (ZoneView shapes byte-compatible)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-golden-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry(GOLDEN_WORKFLOW, 'iteration')]),
      [`workflows/${GOLDEN_WORKFLOW}/snapshot.json`]: v2Snapshot(GOLDEN_WORKFLOW, {
        type: 'iteration',
        plans: GOLDEN_PLANS,
        branch: { base: 'dev-dsh', integration: 'iteration/v2.2.0', target: 'dev-dsh' },
        execution_policy: { push_policy: 'no-push', worktree_mode: 'feature-worktree' },
        control_worktree_path: '/control/worktree',
      }),
      'projects/_default/residuals.json': JSON.stringify(GOLDEN_REGISTER),
      'projects/_default/roadmap.md': GOLDEN_ROADMAP,
      [`workflows/${GOLDEN_WORKFLOW}/agent-flow.jsonl`]: `${GOLDEN_FLOW_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'iterations/v2.2.0/delivery-compass.md': GOLDEN_COMPASS,
      'knowledge/README.md': GOLDEN_KNOWLEDGE,
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row, source } = catalogRowOf(decision)

    // The state section: every field is the legacy-row golden shape, sourced
    // from the selected workflow snapshot + workflow agent-flow + project
    // register; `selection` is the additive v3 field.
    expect(source.state).toEqual({
      selection: { kind: 'active', workflowId: GOLDEN_WORKFLOW, dir: `workflows/${GOLDEN_WORKFLOW}` },
      plans: [
        { id: 'plan-a', status: 'InProgress', doneAt: null, iterationRefs: [] },
        { id: 'plan-b', status: 'Done', doneAt: '2026-08-19', iterationRefs: [] },
      ],
      residuals: [
        { severity: 'high', count: 1 },
        { severity: 'nit', count: 1 },
      ],
      residualFindings: [
        { planId: 'plan-b', id: 'R1', severity: 'high', title: 'deferred blocker' },
        { planId: 'plan-b', id: 'R2', severity: 'nit', title: 'style nit' },
      ],
      project: {
        milestones: ['P1 foundation', 'P2 migrate + dogfood', 'P3 dsh viz'],
        openResiduals: [
          { severity: 'high', count: 1 },
          { severity: 'nit', count: 1 },
        ],
      },
      iterationBaseBranch: 'dev-dsh',
      targetBranch: 'dev-dsh',
      specIntegrationBranch: 'iteration/v2.2.0',
      pushPolicy: 'no-push',
      worktreeMode: 'feature-worktree',
      controlWorktreePath: '/control/worktree',
      leases: [{ planId: 'plan-a', holder: 'dsh-session-1', worktreePath: '/worktrees/plan-a' }],
      knowledge: { docCount: 1, categories: ['conventions'] },
      direction: 'Golden direction.',
      agentFlow: {
        events: [
          { ts: 1_700_000_000_001, kind: 'settle', agent: null, role: 'fullstack-dev', planId: 'plan-a', taskId: 'T1', taskCategory: null, paired: true, outcome: 'ok' },
          { ts: 1_700_000_000_000, kind: 'dispatch', agent: null, role: 'fullstack-dev', planId: 'plan-a', taskId: 'T1', taskCategory: null, verdict: 'ok', hard: false },
        ],
        // Settle rows count under the '' pseudo-role (the summary's
        // dispatch-role bucket only); the dispatch counts under its role.
        summary: [
          { role: '', outcome: 'ok', count: 1 },
          { role: 'fullstack-dev', outcome: 'ok', count: 1 },
        ],
      },
    })

    // The iteration section: the gate evaluates the SELECTED snapshot (the
    // evaluated-doc path is the snapshot, not the root status.json).
    expect(source.iteration).toMatchObject({
      iterationId: 'v2.2.0',
      statusPath: join(harnessDir, `workflows/${GOLDEN_WORKFLOW}/snapshot.json`),
      compassPath: join(harnessDir, 'iterations/v2.2.0/delivery-compass.md'),
      gate: { transition: 'phase-2-execute', all_plans_done: false, ok: true },
      compassStatus: 'active',
    })

    // The model text renders the selected workflow + the legacy data lines.
    const text = textOf(row)
    expect(text).toContain(`workflow: ${GOLDEN_WORKFLOW} (active)`)
    expect(text).toContain('plans: plan-a(InProgress) plan-b(Done)')
    expect(text).toContain('residuals: high 1, nit 1')
    expect(text).toContain('branch: dev-dsh → dev-dsh (spec integration: iteration/v2.2.0)')
    expect(text).toContain('policy: push no-push; worktree feature-worktree; control /control/worktree')
    expect(text).toContain('leases: plan-a → dsh-session-1 (/worktrees/plan-a)')
    expect(text).toContain('agent flow: 2 events; by role: fullstack-dev 1')
  })

  it('no snapshots → clear error (never a root v1 read)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-nosnapshot-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    // v2 root with an EMPTY active set and no workflows/ dir at all.
    await seedHarness(harnessDir, {
      'status.json': v2Root([]),
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row, source } = catalogRowOf(decision)

    const state = source.state
    expect(state).not.toBeNull()
    if (state === null) return
    expect(state.selection).toEqual({
      kind: 'error',
      code: 'workflow.selection.no-snapshot',
      message: expect.stringContaining('no workflow snapshot'),
    })
    // The aggregates are empty by construction — never a root v1 read.
    expect(state.plans).toEqual([])
    expect(state.agentFlow).toBeNull()
    // No snapshot → no iteration gate row either.
    expect(source.iteration).toBeUndefined()
    // The model text carries the clear error.
    expect(textOf(row)).toContain('workflow selection: ERROR (workflow.selection.no-snapshot)')
  })

  it('a v1 (unmigrated) root → migration-required error — the v1 plans[] are never read (no dual-read)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-v1root-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    // A v1 root carrying plans — the catalog must NOT fall back to them.
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({
        version: 1,
        updated_at: '2026-08-08',
        plans: [{ id: 'plan-a', status: 'Todo' }],
        residual_findings: {},
        metadata: {},
      }),
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row, source } = catalogRowOf(decision)

    const state = source.state
    expect(state).not.toBeNull()
    if (state === null) return
    expect(state.selection).toEqual({
      kind: 'error',
      code: 'status.migration-required',
      message: expect.stringContaining('mstar migrate'),
    })
    // The v1 plans are NOT projected (no dual-read).
    expect(state.plans).toEqual([])
    expect(textOf(row)).toContain('workflow selection: ERROR (status.migration-required)')
  })

  it('multiple active workflows → first entry selected + operator-visible warning field (no silent pick)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-multiactive-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { plans: [{ id: 'plan-a', status: 'Todo' }] }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { plans: [{ id: 'plan-b', status: 'Done' }] }),
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row, source } = catalogRowOf(decision)

    const state = source.state
    expect(state).not.toBeNull()
    if (state === null) return
    // The FIRST active entry is selected, with a structured warning.
    expect(state.selection).toEqual({
      kind: 'active',
      workflowId: 'wf-a',
      dir: 'workflows/wf-a',
      warning: {
        code: 'workflow.selection.multi-active',
        message: expect.stringContaining('2 active lifecycles'),
      },
    })
    // The state aggregates the FIRST workflow only.
    expect(state.plans).toEqual([{ id: 'plan-a', status: 'Todo', doneAt: null, iterationRefs: [] }])
    // The warning is operator-visible in the model text too.
    expect(textOf(row)).toContain('workflow warning: workflow.selection.multi-active')
  })

  it('no active workflows → the latest terminal snapshot by mtime (history view); non-terminal snapshots are skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-terminal-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([]),
      'workflows/wf-old/snapshot.json': v2Snapshot('wf-old', { status: 'completed', ended_at: '2026-08-18', plans: [{ id: 'plan-old', status: 'Done' }] }),
      'workflows/wf-new/snapshot.json': v2Snapshot('wf-new', { status: 'completed', ended_at: '2026-08-19', plans: [{ id: 'plan-new', status: 'Done' }] }),
      // A non-terminal snapshot NOT in the root active set is inconsistent —
      // the terminal filter must skip it (never selected).
      'workflows/wf-running/snapshot.json': v2Snapshot('wf-running', { plans: [{ id: 'plan-running', status: 'InProgress' }] }),
    })
    // Deterministic mtimes: wf-old older, wf-new newer (the selection is by
    // file mtime, not by the snapshot's updated_at).
    const oldPath = join(harnessDir, 'workflows/wf-old/snapshot.json')
    const newPath = join(harnessDir, 'workflows/wf-new/snapshot.json')
    const runningPath = join(harnessDir, 'workflows/wf-running/snapshot.json')
    const base = Date.now() / 1000
    await utimes(oldPath, base - 200, base - 200)
    await utimes(newPath, base - 100, base - 100)
    await utimes(runningPath, base - 50, base - 50)
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row, source } = catalogRowOf(decision)

    const state = source.state
    expect(state).not.toBeNull()
    if (state === null) return
    expect(state.selection).toEqual({ kind: 'terminal', workflowId: 'wf-new', dir: 'workflows/wf-new' })
    expect(state.plans).toEqual([{ id: 'plan-new', status: 'Done', doneAt: null, iterationRefs: [] }])
    expect(textOf(row)).toContain('workflow: wf-new (terminal)')
  })
})

describe('catalog teardown — fiber.dispose removes the pre-step listener (HMR-safe)', () => {
  it('disposes the listener on fiber.dispose and a reloaded fiber restores it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-'))
    const harnessDir = join(root, 'harness')
    const ctx = new Context()
    // The plugin's top-level `inject: ['loader']` (Task 1) must resolve
    // before apply — same loader-guarantee the real dsh app provides.
    new FakeLoaderRegistry(ctx)
    const inbox = [inboxMessage()]
    try {
      // Mount 1 — the catalog is appended on pre-step.
      const fiber = await ctx.plugin(plugin, { harnessDir })
      const live = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(lastMessage(live)?.source).toMatchObject({ kind: 'mstar-engine-status' })

      // Dispose — the listener is unwound: the terminal decision passes through unchanged.
      await fiber.dispose()
      const after = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(after).toEqual({ kind: 'enter', messages: inbox })

      // HMR reload — a fresh fiber restores the catalog contribution.
      const reloaded = await ctx.plugin(plugin, { harnessDir })
      const again = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(lastMessage(again)?.source).toMatchObject({ kind: 'mstar-engine-status' })
      await reloaded.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})
