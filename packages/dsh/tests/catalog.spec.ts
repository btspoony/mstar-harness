/**
 * Task 5 — mstar-engine-status catalog at agent/pre-step (plan
 * ), extended by plan
 *  Task 2: the catalog TTL invalidation — a
 * ledger change (recordDispatch) deletes the workspace cache entry so the
 * next pre-step rebuilds fresh sources and the digest re-emits the changed
 * row within the REAL TTL (AC-2); a non-record out-of-band ledger write
 * stays TTL-bounded (cache-hit behavior unchanged — only the record path
 * invalidates). Extended by:
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
 * Contract under test (brief + : the listener is advisory — it
 * MUST call `next()` and build on the delegated decision; it never returns
 * `reject` (would block the step) and never replaces the delegated messages
 * (would drop them). It appends one `catalog`-form MessageSource named
 * `mstar-engine` whose content is the renderer's PROJECTION of the payload:
 * the `<mstar_engine_status>` wrapper plus the iteration-gate and
 * workspace-state lines. The version / harness dir / enforcement watermark
 * stays in the payload (the panel meta dock renders it) and in the always-on
 * system prompt — never in the row text, so the model-visible row is still
 * reconstructable from the session log (MessageSource form; model-visible ⟺
 * logged). The append is change-driven (first emission, rendered-text change,
 * or panel-projection change; a new turn alone appends nothing) and a
 * workspace without a resolved `{HARNESS_DIR}` composes no row at all. The
 * append is error-contained ; an aborted step returns the delegated
 * decision unchanged . Fiber disposal removes the listener (HMR-safe).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  appendDshLedgerRow,
  createExecutionWorkflow,
  initializeStore,
  openStore,
  readExecutionState,
  importRoadmapAuthority,
  registerCatalogEntity,
  reviewRoadmapImport,
  replaceRoadmapAuthority,
} from '@mstar-harness/engine'
import type { ExecutionCaller, ExecutionContext } from '@mstar-harness/engine'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import * as plugin from '../src/index.ts'
import type { MstarEngineStatusPayload, MstarEngineStatusSource } from '../src/index.ts'
import {
  buildCatalogPayload,
  buildCatalogPayloadWithStore,
  catalogCacheKey,
  panelDigestOf,
  renderEngineStatusCatalog,
} from '../src/gates/catalog.ts'
import { readEngineStatusSnapshot, updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import { bootApp, FakeLoaderRegistry, seedActiveWorkflow, seedHarness, seedKnowledgeDoc, seedOpenIssue, seedStore, selectedGenerationFor, type BootResult } from './harness.ts'

let booted: BootResult | undefined
function appendLiveEvent(harnessDir: string, workflowId: string, event: Record<string, unknown>): void {
  const result = appendDshLedgerRow(
    { harnessDir },
    workflowId,
    JSON.stringify(event),
    undefined,
    selectedGenerationFor(harnessDir),
  )
  if (result.kind !== 'written') throw new Error(`Native ledger write failed: ${result.reason}`)
}

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

/* ===========================================================================
 * Execution-authority fixtures (plan S4 / Phase-5 F3): the REAL store through
 * the engine's own producers, and NO root `status.json` — the state a real
 * cutover leaves once the retired registry is gone.
 * ========================================================================== */

const AUTHORITY_TS = '2026-09-21T00:00:00.000Z'

/**
 * Initialize the REAL execution authority (create-only empty-execution
 * initializer) with zero or more registered lifecycles. Each
 * `createExecutionWorkflow` consumes the PREVIOUS receipt's root token, so a
 * second lifecycle walks the registry revisions instead of guessing one.
 */
async function seedExecutionAuthority(
  harnessDir: string,
  workflows: readonly { id: string; planId: string }[],
): Promise<void> {
  const handle = await initializeStore({ harnessDir })
  handle.close()
  let token = (await readExecutionState({ harnessDir })).token
  for (const workflow of workflows) {
    await registerCatalogEntity(
      { harnessDir },
      {
        kind: 'plan',
        id: workflow.planId,
        title: `${workflow.planId} title`,
        rootKind: 'plans',
        relativePath: `plans/${workflow.planId}.md`,
      },
      { operationId: `register-${workflow.planId}`, actor: 'catalog.spec' },
    )
    const receipt = await createExecutionWorkflow(
      {
        harnessDir,
        caller: {
          sessionId: `host-${workflow.id}`,
          role: 'coordinator',
          workflowId: workflow.id,
        } satisfies ExecutionCaller,
      } satisfies ExecutionContext,
      {
        entry: { id: workflow.id, type: 'plan', started_at: AUTHORITY_TS, dir: `workflows/${workflow.id}` },
        snapshot: {
          schema_version: 1,
          id: workflow.id,
          type: 'plan',
          status: 'running',
          started_at: AUTHORITY_TS,
          updated_at: AUTHORITY_TS,
          plans: [
            {
              id: workflow.planId,
              title: `${workflow.planId} title`,
              file: `plans/${workflow.planId}.md`,
              status: 'Todo',
            },
          ],
          delivery_kind: 'development',
          branch: { source: `feature/${workflow.id}`, target: 'main' },
        } as never,
        expected: token,
        operationId: `create-${workflow.id}`,
      },
    )
    token = receipt.token
  }
}

/**
 * Seal a freshly seeded store for readers (the G2a / store-cutover pattern):
 * one read open+close so later reads do not hit the documented bun-test open
 * flake (a read right after the writer closes can surface `store.corrupt` /
 * `store.busy`, which the authority route correctly treats as fail-closed
 * `store.authority-unavailable`). Without it the store's SHAPE, not the
 * authority ROUTE these cases are about, would decide the verdict.
 */
async function sealStoreForReaders(harnessDir: string): Promise<void> {
  const handle = await openStore({ harnessDir }, 'read')
  handle.close()
}

/** Unreadable authority through the REAL engine channel: a directory where the
 * database file belongs (`openStore` refuses `store.corrupt`). */
async function corruptStore(harnessDir: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) await rm(join(harnessDir, `store.db${suffix}`), { force: true })
  await mkdir(join(harnessDir, 'store.db'), { recursive: true })
}

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** The session every simulated step carries (the durable catalog-cache key). */
const SESSION_ID = 's-catalog'

/** A `agent/pre-step` payload the agent loop would dispatch. */
const stepPayload = (messages: UserMessage[], signal = new AbortController().signal) => ({
  agent: { session: { header: { id: SESSION_ID } } },
  messages,
  turn: 1,
  step: 1,
  signal,
} as never)

/**
 * A later step of the SAME session carrying its workspace: the emission persist
 * is keyed by `session.header.id` + cwd, so a step without a cwd writes nothing
 * and cannot witness a panel-only update.
 */
const stepAtWorkspace = (cwd: string, turn: number, messages: UserMessage[] = []) => ({
  agent: { session: { header: { id: SESSION_ID, cwd } } },
  messages,
  turn,
  step: 1,
  signal: new AbortController().signal,
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
  if (source.kind !== 'mstar-engine') throw new Error('missing catalog row')
  return { row, source: source as MstarEngineStatusSource }
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
    // The PERSISTED source is the producer-owned catalog kind and nothing else.
    expect(catalog?.source).toEqual({ kind: 'mstar-engine', form: 'catalog' })
    // The facts the row renders from are not persisted with it — they come
    // from the same builder the pre-step listener used.
    expect(buildCatalogPayload(app.ctx, app.harnessDir)).toMatchObject({
      version: PLUGIN_VERSION,
      harnessDir: app.harnessDir,
      enforcement: { hard: false, source: 'none' },
    })
    // The composed session log carries the model-facing text: the payload is a
    // PROJECTION — the wrapper + the state lines, never the watermark trio
    // (the payload above keeps those facts for the panel).
    expect(catalog?.content[0]?.type).toBe('text')
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text.startsWith('<mstar_engine_status>\n')).toBe(true)
    expect(text.endsWith('\n</mstar_engine_status>')).toBe(true)
    expect(text).not.toContain('mstar version:')
    expect(text).not.toContain('harness dir:')
    expect(text).not.toContain('enforcement:')
  })

  it('reads the compass enforcement mode into the payload — the rendered row no longer carries the watermark (D1)', async () => {
    // The enforcement flag is built at boot for the explicit config (the cache
    // is built on first use) — the compass must exist before apply() runs to
    // be seen by the build.
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-compass-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'iterations/00000808-catalog-test/delivery-compass.md': [
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
    expect(catalog?.source).toEqual({ kind: 'mstar-engine', form: 'catalog' })
    expect(buildCatalogPayload(app.ctx, app.harnessDir).enforcement).toEqual({ hard: true, source: 'compass' })
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).not.toContain('enforcement:')
  })

  it('serves the cached build within the catalog TTL — a compass appearing after the build is not read, and no row is re-appended (D2)', async () => {
    const app = booted = await bootApp()
    // Prime the session cache (D4: no boot pre-seed — the first pre-step
    // builds it). A compass that appears afterwards is not read until the TTL
    // expires (or a ledger invalidation drops the entry).
    const first = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    expect(textOf(catalogRowOf(first).row)).not.toContain('iteration:')
    await seedHarness(app.harnessDir, {
      'iterations/00000808-catalog-test/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })
    // A FRESH build sees the compass…
    expect(buildCatalogPayload(app.ctx, app.harnessDir).enforcement).toEqual({ hard: true, source: 'compass' })

    // …but the pre-step serves the cached build: the row is unchanged, so the
    // new turn appends nothing (had the entry rebuilt, the new state would
    // have changed the row and re-emitted it).
    const decision = await app.ctx.waterfall('agent/pre-step', {
      agent: { session: { header: { id: SESSION_ID } } },
      messages: [],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    } as never, defaultEnter([]))

    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' && decision.messages).toEqual([])
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
    expect(catalog?.source).toEqual({ kind: 'mstar-engine', form: 'catalog' })
    // The optional `iteration` key is ABSENT from the payload — never
    // `iteration: undefined`: the payload is the wire value a consumer
    // receives, so the lossless-JSON discipline still applies to it.
    const payload = buildCatalogPayload(app.ctx, app.harnessDir) as unknown as Record<string, unknown>
    expect(Object.keys(payload).every((key) => payload[key] !== undefined)).toBe(true)
    expect('iteration' in payload).toBe(false)
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
    expect(catalog?.source).toEqual({ kind: 'mstar-engine', form: 'catalog' })
  })

  it('observes the step abort signal — an aborted step publishes no catalog and returns the delegated decision ', async () => {
    const app = booted = await bootApp()
    const controller = new AbortController()
    controller.abort()

    // Narrowed abort race: an abort after delegation returns the delegated
    // decision unchanged (clean abort semantics) instead of surfacing an
    // AbortError as a turn failure; the catalog simply is not appended.
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([], controller.signal), defaultEnter([]))

    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('contains a third-party decider with non-iterable messages — the step still delegates unchanged ', async () => {
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

describe('mstar-engine-status catalog — watermark-free projection + change-driven emission (D1/D2)', () => {
  /** A later step of the SAME session+workspace (the durable catalog identity). */
  const stepPayloadAt = (turn: number, messages: UserMessage[] = []) => ({
    agent: { session: { header: { id: SESSION_ID } } },
    messages,
    turn,
    step: 1,
    signal: new AbortController().signal,
  } as never)

  it('renders an ACTIVE payload as ONE compact delta line — workflow + non-Done plans, never the watermark trio (D1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-projection-'))
    const harnessDir = join(root, 'harness')
    await seedActiveWorkflow(harnessDir, 'wf-projection', [
      { id: 'plan-projection', title: 'Plan', file: 'plans/plan-projection.md', status: 'Todo' },
      { id: 'plan-finished', title: 'Plan', file: 'plans/plan-finished.md', status: 'Done' },
    ], {}, SESSION_ID, root, 'wf-projection')
    const app = booted = await bootApp({ root, harnessDir })

    const { row } = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([])))
    const text = textOf(row)

    // The whole block is the wrapper + ONE line: this fixture resolves no
    // branch anchors and no steering compass, so the delta carries exactly the
    // workflow and its non-Done plans (the Done row is not a pending decision).
    expect(text).toBe([
      '<mstar_engine_status>',
      'workflow: wf-projection (active) | plans: plan-projection(Todo)',
      '</mstar_engine_status>',
    ].join('\n'))
    // The watermark trio duplicates the always-on system prompt: the row never
    // repeats it (it is a PROJECTION of the payload, not a byte-identical render).
    for (const dropped of ['mstar version:', 'harness dir:', 'enforcement:', 'residuals:', 'knowledge:', 'direction:', 'policy:', 'row scope:', 'agent flow:', 'store:']) {
      expect(text).not.toContain(dropped)
    }
    // …while the payload keeps the facts the panel meta dock renders (the Done
    // row included — the payload is the authority for every panel field).
    const payload = await buildCatalogPayloadWithStore(app.ctx, harnessDir)
    expect(payload).toMatchObject({
      version: PLUGIN_VERSION,
      harnessDir,
      enforcement: { hard: false, source: 'none' },
    })
    expect(payload.state?.storeFacts?.storeRevision).toEqual(expect.any(Number))
    expect(payload.state?.plans.map((plan) => plan.status)).toEqual(['Todo', 'Done'])
  })

  it('panelDigestOf ignores ONLY the self-perturbing store revision — and never mutates the payload (D2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-panelkey-'))
    const harnessDir = join(root, 'harness')
    await seedActiveWorkflow(harnessDir, 'wf-panelkey', [], {}, SESSION_ID, root, 'wf-panelkey')
    await seedOpenIssue(harnessDir, { title: 'panel-visible issue', severity: 'high', operationId: 'op-panelkey-1' })
    const app = booted = await bootApp({ root, harnessDir })
    const payload = await buildCatalogPayloadWithStore(app.ctx, harnessDir)
    if (payload.state === null) throw new Error('expected a state section')
    const revision = payload.state.storeFacts?.storeRevision
    if (revision === null || revision === undefined) throw new Error('expected a store revision')
    /** A deep copy so each case perturbs only its own field. */
    const copy = (): MstarEngineStatusPayload => JSON.parse(JSON.stringify(payload)) as MstarEngineStatusPayload

    const before = JSON.stringify(payload)
    const baseline = panelDigestOf(payload)

    // The emission's OWN store write bumps the revision 1:1 — it must not read
    // as a change (otherwise the row re-emits every step, the defect D2 removes).
    const bumped = copy()
    if (bumped.state === null || bumped.state.storeFacts === undefined) throw new Error('expected store facts')
    ;(bumped.state.storeFacts as { storeRevision: number | null }).storeRevision = revision + 1
    expect(panelDigestOf(bumped)).toBe(baseline)

    // A panel-visible detail change IS a change, even when the rollup the text
    // renders is byte-identical (the detail rows are panel-only facts).
    const retitled = copy()
    if (retitled.state === null || retitled.state.residualFindings === null) throw new Error('expected residual findings')
    ;(retitled.state.residualFindings[0] as { title: string }).title = 'a retitled open issue'
    expect(panelDigestOf(retitled)).not.toBe(baseline)
    expect(retitled.state.residuals).toEqual(payload.state.residuals)

    // Pure: the input payload and its real revision are untouched.
    expect(JSON.stringify(payload)).toBe(before)
    expect(payload.state.storeFacts?.storeRevision).toBe(revision)
  })

  it('two steps in DIFFERENT turns with unchanged state append the row once (the retired turn term, D2)', async () => {
    const app = booted = await bootApp()
    const first = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    expect(catalogRowOf(first).source).toEqual({ kind: 'mstar-engine', form: 'catalog' })

    // A new turn alone is NOT an emission trigger: the cached build is
    // unchanged, so nothing is appended.
    for (const turn of [2, 3]) {
      const later = await app.ctx.waterfall('agent/pre-step', stepPayloadAt(turn), defaultEnter([]))
      expect(later.kind).toBe('enter')
      expect(later.kind === 'enter' && later.messages).toEqual([])
    }
  })

  it('a residual-count-only change appends NO row — the compact delta ignores facts it does not render (D2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-cadence-'))
    const harnessDir = join(root, 'harness')
    await seedActiveWorkflow(harnessDir, 'wf-cadence', [], {}, SESSION_ID, root, 'wf-cadence')
    // TTL 0: each step rebuilds, so the fixture's change reaches the gate
    // immediately (the CHANGE, not the turn, decides whether the row is
    // appended).
    const app = booted = await bootApp({ root, harnessDir, catalogTtlMs: 0 })

    const first = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(root, 1), defaultEnter([]))).row
    expect(textOf(first)).not.toContain('residuals:')

    await seedOpenIssue(harnessDir, { title: 'a newly opened issue', severity: 'high', operationId: 'op-cadence-1' })

    // The open-item rollup changed, but the row does not render it: a residual
    // count alone must not spend a model row on an identical-looking delta.
    const second = await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(root, 2), defaultEnter([]))
    expect(second.kind).toBe('enter')
    expect(second.kind === 'enter' && second.messages).toEqual([])

    // …the PANEL payload still moved: the persist is a separate obligation and
    // its projection is sensitive to the issue facts.
    const stored = readEngineStatusSnapshot(harnessDir, SESSION_ID, root)
    expect(stored.kind).toBe('ok')
    if (stored.kind !== 'ok') throw new Error('unreachable')
    expect(stored.entry.payload.state).toMatchObject({ residuals: [{ severity: 'high', count: 1 }] })
    // The persisted freshness turn stays the one the model saw a row in.
    expect(stored.entry.turn).toBe(1)
  })

  it('a panel-visible change with identical rendered text persists the payload without appending a row (the split gate + revision exclusion, D2)', async () => {
    const app = booted = await bootApp({ catalogTtlMs: 0 })
    await seedStore(app.harnessDir)
    // Error-branch state (no ACTIVE lifecycle): the error line REPLACES the
    // data line, so the open-issue facts below are panel-only.
    const first = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(app.root, 1), defaultEnter([]))).row
    const firstText = textOf(first)
    expect(firstText).toContain('workflow selection: ERROR')

    await seedOpenIssue(app.harnessDir, { title: 'a panel-visible issue', severity: 'high', operationId: 'op-panel-1' })

    // Identical text → the model row is not re-spent…
    const second = await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(app.root, 2), defaultEnter([]))
    expect(second.kind).toBe('enter')
    expect(second.kind === 'enter' && second.messages).toEqual([])
    // …but the panel's payload DID move (the persisted emission carries the new
    // facts) and its freshness turn still names the emission the model saw.
    const stored = readEngineStatusSnapshot(app.harnessDir, SESSION_ID, app.root)
    expect(stored.kind).toBe('ok')
    if (stored.kind !== 'ok') throw new Error('unreachable')
    expect(stored.entry.payload.state).toMatchObject({ residuals: [{ severity: 'high', count: 1 }] })
    expect(stored.entry.turn).toBe(1)

    // A third step with NO change neither appends nor writes: the second step's
    // own store write bumped the revision, which the projection normalizes away.
    const tokenBefore = (await readExecutionState({ harnessDir: app.harnessDir })).token
    const third = await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(app.root, 3), defaultEnter([]))
    expect(third.kind).toBe('enter')
    expect(third.kind === 'enter' && third.messages).toEqual([])
    expect((await readExecutionState({ harnessDir: app.harnessDir })).token).toBe(tokenBefore)
  })

  it('state === null (no resolved {HARNESS_DIR}) composes no mstar-engine row and records no digest (D4)', async () => {
    const app = booted = await bootApp({ harnessDir: null })
    const inbox = [inboxMessage()]

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
    expect(decision).toEqual({ kind: 'enter', messages: inbox })
    expect(buildCatalogPayload(app.ctx, null).state).toBeNull()

    // No digest was recorded either, so a later turn stays row-free rather
    // than emitting an empty `<mstar_engine_status></mstar_engine_status>`.
    const later = await app.ctx.waterfall('agent/pre-step', stepPayloadAt(2, inbox), defaultEnter(inbox))
    expect(later).toEqual({ kind: 'enter', messages: inbox })
  })
})

/* ===========================================================================
 * The compact engine-status delta (Task 3): the model row is a DELTA —
 * workflow + non-Done plans + branch anchors + gate verdict — and its rendered
 * text IS the emission gate's model-side comparison key. Every other payload
 * field (the panel renders them) is therefore excluded from that key, so an
 * incidental count change can never spend a model-visible row on a
 * visually-identical line.
 * ========================================================================== */

describe('compact engine-status delta — the model-row comparison key', () => {
  /** A payload carrying EVERY fact the row no longer renders. */
  const richPayload = (): MstarEngineStatusPayload => ({
    // Synthetic fixture input only — the row never renders the version and no
    // assertion compares it against the real plugin manifest.
    version: '9.9.9-fixture',
    harnessDir: '/proj/.mstar',
    enforcement: { hard: true, source: 'compass' },
    iteration: {
      iterationId: 'iter-compact',
      compassPath: '/proj/.mstar/iterations/iter-compact/delivery-compass.md',
      compassStatus: 'active',
      gate: {
        transition: 'phase-2-execute',
        all_plans_done: false,
        ok: true,
        entry: { ok: true, violations: [] },
        exit: { ok: true, violations: [] },
        violations: [],
      },
    },
    state: {
      selection: { kind: 'active', workflowId: 'wf-compact', dir: 'workflows/wf-compact' },
      workflowType: 'iteration',
      workflowStatus: 'running',
      plans: [
        { id: 'plan-a', status: 'Todo', doneAt: null, iterationRefs: [] },
        { id: 'plan-b', status: 'InProgress', doneAt: null, iterationRefs: [] },
        { id: 'plan-c', status: 'Done', doneAt: '2026-08-08', iterationRefs: [] },
      ],
      residuals: [
        { severity: 'critical', count: 1 },
        { severity: 'high', count: 2 },
        { severity: 'medium', count: 3 },
        { severity: 'low', count: 4 },
        { severity: 'nit', count: 5 },
      ],
      residualFindings: [{ planId: '', id: 'I-1', severity: 'high', title: 'a panel-only detail row' }],
      project: { milestones: ['P1 foundation'], roadmapSource: { kind: 'present', absentProjectIds: [], diagnostic: null }, openResiduals: [] },
      iterationBaseBranch: 'feature/x',
      targetBranch: 'main',
      specIntegrationBranch: 'iteration/iter-compact',
      pushPolicy: 'no-push',
      worktreeMode: 'feature-worktree',
      integrationWorktreePath: '/integration/wt',
      rowScopes: [{ planId: 'plan-a', workingBranch: 'feature/plan-a', worktreePath: '/wt/plan-a' }],
      knowledge: { docCount: 3, categories: ['conventions', 'testing'] },
      storeFacts: { kind: 'store', projection: 'current', storeRevision: 42, diagnostic: 'a store diagnostic' },
      direction: 'Golden direction.',
      agentFlow: {
        events: [{ ts: 1_700_000_000_000, kind: 'dispatch', agent: null, role: 'fullstack-dev', planId: 'plan-a', taskId: 'T1', taskCategory: null, verdict: 'ok', hard: false }],
        summary: [{ role: 'fullstack-dev', outcome: 'ok', count: 1 }],
      },
    },
  })

  /** A deep copy so each case perturbs exactly its own field. */
  const copy = (payload: MstarEngineStatusPayload): MstarEngineStatusPayload =>
    JSON.parse(JSON.stringify(payload)) as MstarEngineStatusPayload

  it('renders ONE delta line — workflow + non-Done plans + branch + gate — and no dropped fact', () => {
    const text = renderEngineStatusCatalog(richPayload())
    expect(text).toBe([
      '<mstar_engine_status>',
      'workflow: wf-compact (active) | plans: plan-a(Todo) plan-b(InProgress) | branch: feature/x → main | gate: PASS (phase-2-execute)',
      '</mstar_engine_status>',
    ].join('\n'))
    // Every dropped fact is absent by LABEL, so a future re-add fails here.
    for (const dropped of [
      'residuals:', 'store:', 'knowledge:', 'direction:', 'policy:', 'row scope:',
      'agent flow:', 'iteration:', 'transition:', 'all plans done:',
    ]) {
      expect(text).not.toContain(dropped)
    }
  })

  it('a dropped field changing keeps the row text identical while the panel key moves (the emission-key exclusion)', () => {
    const payload = richPayload()
    const text = renderEngineStatusCatalog(payload)
    const panelKey = panelDigestOf(payload)
    /** One case: a mutation the row must NOT see, with the panel fact it changes. */
    const cases: ReadonlyArray<readonly [string, (mutated: MstarEngineStatusPayload) => void]> = [
      ['residual counts', (mutated) => { if (mutated.state !== null) (mutated.state as { residuals: unknown }).residuals = [{ severity: 'critical', count: 9 }] }],
      ['residual detail rows', (mutated) => { if (mutated.state !== null) (mutated.state as { residualFindings: unknown }).residualFindings = [] }],
      ['knowledge digest', (mutated) => { if (mutated.state !== null) (mutated.state as { knowledge: unknown }).knowledge = { docCount: 0, categories: [] } }],
      ['compass direction', (mutated) => { if (mutated.state !== null) (mutated.state as { direction: unknown }).direction = 'A different direction.' }],
      ['agent flow', (mutated) => { if (mutated.state !== null) (mutated.state as { agentFlow: unknown }).agentFlow = null }],
      ['row scopes', (mutated) => { if (mutated.state !== null) (mutated.state as { rowScopes: unknown }).rowScopes = [] }],
      ['branch policy', (mutated) => { if (mutated.state !== null) (mutated.state as { pushPolicy: unknown }).pushPolicy = null }],
      ['spec integration branch', (mutated) => { if (mutated.state !== null) (mutated.state as { specIntegrationBranch: unknown }).specIntegrationBranch = null }],
      ['roadmap milestones', (mutated) => { if (mutated.state !== null) (mutated.state.project as { milestones: unknown }).milestones = [] }],
      ['store diagnostic', (mutated) => { if (mutated.state !== null && mutated.state.storeFacts !== undefined) (mutated.state.storeFacts as { diagnostic: unknown }).diagnostic = null }],
      ['workflow type/status (digest facts)', (mutated) => { if (mutated.state !== null) { (mutated.state as { workflowType: unknown }).workflowType = 'plan'; (mutated.state as { workflowStatus: unknown }).workflowStatus = 'paused' } }],
    ]
    for (const [label, mutate] of cases) {
      const mutated = copy(payload)
      mutate(mutated)
      expect({ label, text: renderEngineStatusCatalog(mutated) }).toEqual({ label, text })
      expect({ label, changed: panelDigestOf(mutated) !== panelKey }).toEqual({ label, changed: true })
    }
  })

  it('a rendered fact changing re-renders the row (plan status, branch anchors, gate verdict)', () => {
    const payload = richPayload()
    const text = renderEngineStatusCatalog(payload)
    /** One case: a mutation the row MUST show (it is the emission trigger). */
    const cases: ReadonlyArray<readonly [string, (mutated: MstarEngineStatusPayload) => void]> = [
      ['plan status', (mutated) => { if (mutated.state !== null) (mutated.state.plans[0] as { status: string }).status = 'InProgress' }],
      ['branch anchors', (mutated) => { if (mutated.state !== null) (mutated.state as { targetBranch: unknown }).targetBranch = 'dev' }],
      ['gate verdict', (mutated) => {
        if (mutated.iteration === undefined) return
        const gate = mutated.iteration.gate as { ok: boolean; transition: string; violations: unknown }
        gate.ok = false
        gate.transition = 'phase-3-close'
        gate.violations = [{ severity: 'high', code: 'EXIT_STATUS_NOT_COMPLETED', message: 'compass must be completed' }]
      }],
    ]
    for (const [label, mutate] of cases) {
      const mutated = copy(payload)
      mutate(mutated)
      const mutatedText = renderEngineStatusCatalog(mutated)
      expect({ label, differs: mutatedText !== text }).toEqual({ label, differs: true })
    }
    // The FAIL verdict names its codes (a bare FAIL names no cause).
    const failed = copy(payload)
    const gate = failed.iteration!.gate as { ok: boolean; transition: string; violations: unknown }
    gate.ok = false
    gate.violations = [{ severity: 'high', code: 'EXIT_STATUS_NOT_COMPLETED', message: 'compass must be completed' }]
    expect(renderEngineStatusCatalog(failed)).toContain('gate: FAIL (phase-2-execute): EXIT_STATUS_NOT_COMPLETED')
  })

  it('an iteration-gate change appends a new row through the real pre-step (the gate is a rendered delta fact)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-gate-delta-'))
    const harnessDir = join(root, 'harness')
    const COMPASS_REL = 'iterations/iter-gate/delivery-compass.md'
    /** A steering compass registering the given plan ids (the gate's plan set). */
    const compassDoc = (plans: readonly string[]): string => [
      '---',
      'iteration_id: iter-gate',
      'start_date: 2026-08-19',
      'status: active',
      'iteration_base_branch: feature/x',
      'target_branch: main',
      'plans:',
      ...plans.map((planId) => `  - ${planId}`),
      '---',
      '',
      '## Direction lock',
      '',
      '- **Problem statement:** Gate-delta fixture.',
      '',
    ].join('\n')
    await seedActiveWorkflow(harnessDir, 'iter-gate', [
      { id: 'plan-todo', title: 'Todo plan', file: 'plans/plan-todo.md', status: 'Todo' },
      { id: 'plan-done', title: 'Done plan', file: 'plans/plan-done.md', status: 'Done' },
    ], { type: 'iteration', compass_ref: COMPASS_REL }, SESSION_ID, root, 'iter-gate')
    // The compass registers the OPEN plan: the gate points at execute and passes.
    await seedHarness(harnessDir, { [COMPASS_REL]: compassDoc(['plan-todo']) })
    const app = booted = await bootApp({ root, harnessDir, catalogTtlMs: 0 })

    const first = textOf(catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(root, 1), defaultEnter([]))).row)
    expect(first).toContain('gate: PASS (phase-2-execute)')

    // Re-register the DONE plan: every registered plan is Done, so the gate
    // moves to the close phase and fails on the still-active compass. The plans
    // segment is unchanged — the GATE alone is the delta.
    await writeFile(join(harnessDir, COMPASS_REL), compassDoc(['plan-done']))
    const second = textOf(catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(root, 2), defaultEnter([]))).row)
    expect(second).toContain('gate: FAIL (phase-3-close)')
    expect(second.split(' | ').find((segment) => segment.startsWith('plans: ')))
      .toBe(first.split(' | ').find((segment) => segment.startsWith('plans: ')))
  })
})

describe('mstar-engine-status catalog — status.missing is an identifiable error state (row-trim finding A)', () => {
  it('renders an ERROR row with a recovery path for a RESOLVED harness dir, never a suppressed state (A)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-status-missing-'))
    const harnessDir = join(root, 'harness')
    const app = booted = await bootApp({ root, harnessDir })
    // The SYNCHRONOUS builder is the documented `status.missing` producer: no
    // ACTIVE execution workflow was pre-read, so the payload must say so. A
    // resolved harness dir therefore yields an ERROR state — `state === null`
    // means exactly "no resolved {HARNESS_DIR}" and must not absorb this case.
    const payload = buildCatalogPayload(app.ctx, harnessDir)
    const state = payload.state
    expect(state).not.toBeNull()
    if (state === null) throw new Error('unreachable')
    expect(payload.harnessDir).toBe(harnessDir)
    expect(state.selection).toMatchObject({ kind: 'error', code: 'status.missing' })
    // The rendered model line names the identifiable failure…
    const text = renderEngineStatusCatalog(payload)
    expect(text).toContain('workflow selection: ERROR (status.missing)')
    expect(text).not.toBe('<mstar_engine_status>\n</mstar_engine_status>')
    // …AND carries a recovery the operator can actually run.
    expect(text).toContain('mstar workflow register')
    expect(text).toContain('mstar iteration register')

    // The gate keys on the resolved harness dir, not on a null state: the real
    // pre-step emits a row for this workspace even though its authority answers
    // an error selection. `status.missing` itself is file/sync-route only, so
    // the async route's own verdict (`workflow.selection.no-active` with an
    // ACTIVE store) is the shape it must render here — the same PRESENT-state
    // error branch the sync `status.missing` above now reaches.
    await seedStore(app.harnessDir)
    const asyncPayload = await buildCatalogPayloadWithStore(app.ctx, harnessDir)
    expect(asyncPayload.state).not.toBeNull()
    expect(asyncPayload.state?.selection).toMatchObject({
      kind: 'error',
      code: 'workflow.selection.no-active',
    })
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
    const rowText = textOf(catalogRowOf(decision).row)
    expect(rowText).toContain('workflow selection: ERROR (')
    expect(rowText).toContain('mstar workflow register')
  })
})

describe('mstar-engine-status catalog — watermark fallback without a system-prompt service (row-trim finding C)', () => {
  it('renders the watermark trio only for the fallback composition, ahead of the state lines (C)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-watermark-'))
    const harnessDir = join(root, 'harness')
    const app = booted = await bootApp({ root, harnessDir })
    const payload = buildCatalogPayload(app.ctx, harnessDir)

    // Default composition (the host carries a system prompt): the trio stays
    // out of the row — the always-on prompt is its single channel.
    const plain = renderEngineStatusCatalog(payload)
    expect(plain).not.toContain('mstar version:')
    expect(plain).not.toContain('harness dir:')
    expect(plain).not.toContain('enforcement:')

    // Fallback composition (no `system-prompt` service): the row retains the
    // trio, or the model sees none of these facts at all.
    const fallback = renderEngineStatusCatalog(payload, { includeWatermark: true })
    expect(fallback.startsWith('<mstar_engine_status>\nmstar version: ')).toBe(true)
    expect(fallback).toContain(`mstar version: ${PLUGIN_VERSION}`)
    expect(fallback).toContain(`harness dir: ${harnessDir}`)
    expect(fallback).toContain('enforcement: soft')
    // Ahead of the iteration/state sections it qualifies.
    expect(fallback.indexOf('enforcement: soft')).toBeLessThan(fallback.indexOf('workflow selection: ERROR'))
    expect(fallback.endsWith('\n</mstar_engine_status>')).toBe(true)

    // No harness dir resolves: `none`, exactly as the retired payload render said.
    const unbound = buildCatalogPayload(app.ctx, null)
    expect(renderEngineStatusCatalog(unbound, { includeWatermark: true })).toContain('harness dir: none')
  })
})

describe('mstar-engine-status catalog — iteration compassStatus (spec panel-f4 §5 D5)', () => {
  /** The iteration workflow id the steering compass registers. */
  const ITERATION_WORKFLOW = 'iter-00000811-catalog-compass'

  /** A minimal engine-shape-VALID delivery-compass frontmatter (spec D5 — the steering status value is the signal). */
  function compassDoc(status: 'active' | 'locked' | 'completed'): string {
    return [
      '---',
      'iteration_id: iter-00000811-catalog-compass',
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

  /** Boot with status.json + a delivery-compass seeded, run one pre-step, and return the catalog payload (the row's source carries none). */
  /** Boot with an ACTIVE execution workflow and its referenced delivery compass. */
  async function payloadWithCompass(status: 'active' | 'locked' | 'completed'): Promise<MstarEngineStatusPayload> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-compassstatus-'))
    const harnessDir = join(root, 'harness')
    await seedActiveWorkflow(harnessDir, ITERATION_WORKFLOW, [], {
      type: 'iteration',
      compass_ref: 'iterations/iter-00000811-catalog-compass/delivery-compass.md',
    }, SESSION_ID, root, ITERATION_WORKFLOW)
    await mkdir(join(harnessDir, 'iterations/iter-00000811-catalog-compass'), { recursive: true })
    await writeFile(join(harnessDir, 'iterations/iter-00000811-catalog-compass/delivery-compass.md'), compassDoc(status))
    const app = booted = await bootApp({ root, harnessDir })
    await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    return buildCatalogPayloadWithStore(app.ctx, harnessDir)
  }

  it('surfaces `compassStatus: active` when the steering compass is active (Phase 1 in flight)', async () => {
    const payload = await payloadWithCompass('active')
    expect(payload.iteration).toBeDefined()
    expect(payload.iteration!.compassStatus).toBe('active')
    expect(payload.iteration!.iterationId).toBe('iter-00000811-catalog-compass')
    // The empty-plans fixture: engine emits phase-2-execute + ok:true during
    // Phase 1 — `iteration.active` is true, only the current step re-derives
    // from compassStatus (projection side).
    expect(payload.iteration!.gate.transition).toBe('phase-2-execute')
    expect(payload.iteration!.gate.ok).toBe(true)
  })

  it('surfaces `compassStatus: locked` when the steering compass is locked (Phase 1 complete)', async () => {
    const payload = await payloadWithCompass('locked')
    expect(payload.iteration!.compassStatus).toBe('locked')
  })

  it('omits compassStatus (and the whole iteration row) for a NON-steering status — the steering filter never admits it (belt-and-suspenders guard)', async () => {
    // `status: completed` is not active|locked → `selectedCompass` refuses the
    // link → no iteration section at all. The appended message stays
    // losslessly JSON-serializable (no undefined-valued props, Session.append).
    const payload = await payloadWithCompass('completed')
    expect(Object.keys(payload).every((key) => (payload as unknown as Record<string, unknown>)[key] !== undefined)).toBe(true)
    expect('iteration' in payload).toBe(false)
  })
})

describe('mstar-engine-status catalog — plan iterationRefs ', () => {
  /** Boot an ACTIVE workflow whose plans carry `metadata.iteration_refs`. */
  async function stateWithPlans(plans: unknown[]): Promise<NonNullable<MstarEngineStatusPayload['state']>> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-iterationrefs-'))
    const harnessDir = join(root, 'harness')
    await seedActiveWorkflow(harnessDir, 'wf-iterrefs', plans as never[], {}, SESSION_ID, root, 'wf-iterrefs')
    const app = booted = await bootApp({ root, harnessDir })
    await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const state = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    if (state === null) throw new Error('expected a non-null state section')
    return state
  }

  it('projects each plan\'s metadata.iteration_refs into `iterationRefs` (string[]; missing → [])', async () => {
    const state = await stateWithPlans([
      { id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Done', metadata: { iteration_refs: ['iter-00000812', 'iter-00000813'] } },
      { id: 'plan-b', title: 'Plan B', file: 'plans/plan-b.md', status: 'Done', metadata: { iteration_refs: [] } },
      { id: 'plan-c', title: 'Plan C', file: 'plans/plan-c.md', status: 'Done', metadata: {} },
      { id: 'plan-d', title: 'Plan D', file: 'plans/plan-d.md', status: 'Done' },
    ])
    expect(state.plans.map((p) => p.iterationRefs)).toEqual([
      ['iter-00000812', 'iter-00000813'],
      [],
      [],
      [],
    ])
  })

  it('a non-array / partially-garbage iteration_refs → [] (or only the string members) — never omitted', async () => {
    const state = await stateWithPlans([
      { id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Done', metadata: { iteration_refs: 'iter-x' } },
      { id: 'plan-b', title: 'Plan B', file: 'plans/plan-b.md', status: 'Done', metadata: { iteration_refs: [42, 'iter-y', null, ''] } },
    ])
    expect(state.plans.map((p) => p.iterationRefs)).toEqual([[], ['iter-y']])
  })
})

describe('catalog TTL invalidation — ledger change refreshes within the TTL ', () => {
  /** A minimal Assignment for the ledger record (role derives to `fullstack-dev`). */
  const ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev

## Task 2

Implement the invalidation.
`

  /** A one-workflow ACTIVE execution tree. */
  async function seedActiveTree(root: string): Promise<string> {
    const harnessDir = join(root, 'harness')
    await seedActiveWorkflow(harnessDir, 'wf-1', [], {}, SESSION_ID, root, 'wf-1')
    return harnessDir
  }

  /** A persisted emission's payload — the PANEL-side witness of a rebuild. */
  const emissionOf = (harnessDir: string, sessionId: string, cwd: string): Record<string, unknown> => {
    const read = readEngineStatusSnapshot(harnessDir, sessionId, cwd)
    if (read.kind !== 'ok') throw new Error(`no persisted emission for ${sessionId}: ${read.kind === 'unavailable' ? read.reason : 'unexpected state'}`)
    return read.entry.payload
  }
  /** The agent-flow roles of a persisted emission payload (the ledger witness). */
  const flowRolesOf = (payload: Record<string, unknown>): string[] => {
    const state = payload.state as { agentFlow: { events: { role: string }[] } | null } | null
    return (state?.agentFlow?.events ?? []).map((event) => event.role)
  }

  it('a ledger change within the TTL invalidates the cache — the next pre-step rebuilds and the PANEL emission carries the new facts (AC-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-invalidate-'))
    const harnessDir = await seedActiveTree(root)
    // REAL TTL (default 60000): a refresh at the second pre-step can only
    // come from the ledger-change invalidation — never from a TTL expiry.
    const app = booted = await bootApp({ root, harnessDir })
    await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(root, 1), defaultEnter([]))
    // No ledger events yet: the compact row renders no flow line at all, and
    // the emission that persisted its payload carries an empty ledger window.
    expect(flowRolesOf(emissionOf(harnessDir, SESSION_ID, root))).toEqual([])

    // One successful ledger record — the apply-bound invalidator deletes the
    // workspace's catalog cache entry (the TTL itself is untouched).
    // Final-state (Task 2 writer cutover): the record itself lands in the
    // ACTIVE workflow dir — the catalog reads the SAME file, so the
    // invalidation observable is the record's own line (no out-of-band write).
    plugin.recordDispatch({
      harnessDir,
      workflowId: 'wf-1',
      resolvedWorkflowDir: join(harnessDir, 'workflows/wf-1'),
      selectedGeneration: selectedGenerationFor(harnessDir),
      prompt: ASSIGNMENT,
      violations: [],
      hard: false,
    })

    // Pre-step 2 — SAME turn, within the REAL TTL: a ledger record is not a
    // RENDERED delta fact, so the compact row is not re-appended…
    const second = await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(root, 1), defaultEnter([]))
    expect(second.kind).toBe('enter')
    expect(second.kind === 'enter' && second.messages).toEqual([])
    // …yet the cache WAS invalidated: the emission now carries the rebuilt
    // payload with the recorded dispatch event (had the cached build been
    // served, the window would still be empty), and its freshness turn still
    // names the step the model actually saw a row in.
    const rebuilt = readEngineStatusSnapshot(harnessDir, SESSION_ID, root)
    expect(rebuilt.kind).toBe('ok')
    if (rebuilt.kind !== 'ok') throw new Error('unreachable')
    expect(flowRolesOf(rebuilt.entry.payload)).toEqual(['fullstack-dev'])
    expect(rebuilt.entry.turn).toBe(1)
  })

  it('cross-workspace isolation: a ledger record in workspace A invalidates ONLY A — B\'s cached entry survives within the TTL ', async () => {
    // Two workspaces, each with its OWN probed harness root — no explicit
    // config, so each session cwd resolves its own `{HARNESS_DIR}` and its own
    // cache key (the session id + cwd) + reverse-map entry (D4: per-session
    // keys, per-harness invalidation — a record deletes EVERY session of the
    // affected harness, never a global clear).
    const wsA = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-isolate-a-'))
    const wsB = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-isolate-b-'))
    for (const ws of [wsA, wsB]) {
      await seedActiveWorkflow(join(ws, '.mstar'), 'wf-1', [], {}, 'seed-wf-1', ws, 'wf-1')
    }
    const stepFor = (cwd: string, turn: number, sessionId: string) => ({
      agent: { session: { header: { id: sessionId, cwd } } },
      messages: [],
      turn,
      step: 1,
      signal: new AbortController().signal,
    } as never)
    const app = booted = await bootApp({ harnessDir: null })

    // Register BOTH workspace keys with one pre-step each (the cache is built
    // on first use + the reverse map registers on build).
    await app.ctx.waterfall('agent/pre-step', stepFor(wsA, 1, 's-A'), defaultEnter([]))
    await app.ctx.waterfall('agent/pre-step', stepFor(wsB, 1, 's-B'), defaultEnter([]))
    expect(flowRolesOf(emissionOf(join(wsA, '.mstar'), 's-A', wsA))).toEqual([])
    expect(flowRolesOf(emissionOf(join(wsB, '.mstar'), 's-B', wsB))).toEqual([])

    // An OUT-OF-BAND ledger line in B (direct write to the workflow dir,
    // bypassing recordDispatch → NO invalidation fires for B): if B's cache
    // entry survives, the line stays INVISIBLE in B's persisted emission
    // within the REAL TTL (cache hit — no rebuild). That is the observable for
    // "B's cached entry survives".
    appendLiveEvent(join(wsB, '.mstar'), 'wf-1', { v: 1, ts: Date.now(), kind: 'dispatch', role: 'fullstack-dev', verdict: 'ok', hard: false })

    // A ledger record for workspace A ONLY — the apply-bound invalidator
    // fires with A's harness dir → deletes exactly A's cache entry.
    // Final-state (Task 2 writer cutover): the record itself lands in A's
    // ACTIVE workflow dir — the catalog reads the SAME file, so the rebuild
    // observable is the record's own line (no out-of-band write).
    plugin.recordDispatch({
      harnessDir: join(wsA, '.mstar'),
      workflowId: 'wf-1',
      resolvedWorkflowDir: join(wsA, '.mstar/workflows/wf-1'),
      selectedGeneration: selectedGenerationFor(join(wsA, '.mstar')),
      prompt: ASSIGNMENT,
      violations: [],
      hard: false,
    })

    // Next pre-step for A (new turn): the entry was invalidated → REBUILT (a
    // fresh source carrying the new workflow-dir dispatch event), so the
    // persisted emission now shows that event. The compact row itself renders
    // no ledger detail, so no model row is spent on it.
    const afterA = await app.ctx.waterfall('agent/pre-step', stepFor(wsA, 2, 's-A'), defaultEnter([]))
    expect(afterA.kind === 'enter' && afterA.messages).toEqual([])
    expect(flowRolesOf(emissionOf(join(wsA, '.mstar'), 's-A', wsA))).toEqual(['fullstack-dev'])

    // Next pre-step for B (new turn): B's entry was NOT invalidated → the
    // cache HIT serves the cached build, nothing is re-appended and the
    // persisted emission still shows an empty window: the out-of-band B line
    // stays invisible within the TTL (no global clear; a multi-workspace
    // deployment does not rebuild every workspace per record).
    const afterB = await app.ctx.waterfall('agent/pre-step', stepFor(wsB, 2, 's-B'), defaultEnter([]))
    expect(afterB.kind).toBe('enter')
    expect(afterB.kind === 'enter' && afterB.messages).toEqual([])
    expect(flowRolesOf(emissionOf(join(wsB, '.mstar'), 's-B', wsB))).toEqual([])
  })

  it('without a ledger change the cache-hit behavior is unchanged — a directly-written ledger line stays invisible within the TTL (only the record path invalidates)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-cachehit-'))
    const harnessDir = await seedActiveTree(root)
    const app = booted = await bootApp({ root, harnessDir })

    // Pre-step 1 (turn 1): no events → the persisted window is empty.
    await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(root, 1), defaultEnter([]))
    expect(flowRolesOf(emissionOf(harnessDir, SESSION_ID, root))).toEqual([])

    // Write a ledger line DIRECTLY into the workflow dir (bypassing
    // recordDispatch → NO invalidation fires): the disk now differs from the
    // cached build.
    appendLiveEvent(harnessDir, 'wf-1', { v: 1, ts: Date.now(), kind: 'dispatch', role: 'fullstack-dev', verdict: 'ok', hard: false })

    // Pre-step 2 (turn 2, within the REAL TTL): the cache entry was NOT
    // invalidated → the cached build is served, so nothing is appended and the
    // new line never reaches the persisted emission. The 60s TTL remains the
    // bound on out-of-band ledger reads.
    const second = await app.ctx.waterfall('agent/pre-step', stepAtWorkspace(root, 2), defaultEnter([]))
    expect(second.kind).toBe('enter')
    expect(second.kind === 'enter' && second.messages).toEqual([])
    expect(flowRolesOf(emissionOf(harnessDir, SESSION_ID, root))).toEqual([])
  })
})

describe('mstar-engine-status catalog — compact delta plans join cap (spec D4)', () => {
  /** The pinned cap value (spec D1) — intentionally hardcoded, NOT imported,
   * so a drift of `CATALOG_STATE_JOIN_LIMIT` fails this matrix. */
  const CAP = 8
  /** The fixture plan-row shape (snapshot `plans[]` entry with a recorded row scope). */
  interface CapRow {
    id: string
    title: string
    file: string
    status: string
    metadata: {
      worktree_path: string
      working_branch: string
    }
  }
  /** One snapshot plan row carrying recorded scope (payload-only now — the row no longer renders it). */
  const capRow = (index: number): CapRow => ({
    id: `plan-${index}`,
    title: `Plan ${index}`,
    file: `plans/plan-${index}.md`,
    status: 'InProgress',
    metadata: {
      worktree_path: `/worktrees/plan-${index}`,
      working_branch: `feature/plan-${index}`,
    },
  })
  /** The pre-cap (legacy) plans rendering — the byte-identical reference for ≤ CAP rows (separator `' '`). */
  const uncappedPlans = (rows: CapRow[]): string => rows.map((row) => `${row.id}(${row.status})`).join(' ')
  /**
   * The exact `plans:` SEGMENT of the row's single delta line (byte-identity
   * assertions, not substring): segments are joined with `' | '`.
   */
  const plansOf = (text: string): string => {
    const segment = text.split('\n')
      .find((line) => line.startsWith('workflow: '))
      ?.split(' | ')
      .find((part) => part.startsWith('plans: '))
    if (segment === undefined) throw new Error(`missing plans: segment in ${JSON.stringify(text)}`)
    return segment
  }
  /** Boot a one-workflow ACTIVE tree whose snapshot carries `count` leased plans. */
  const catalogFor = async (count: number) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-cap-'))
    const harnessDir = join(root, 'harness')
    const plans = Array.from({ length: count }, (_, index) => capRow(index))
    await seedActiveWorkflow(harnessDir, 'wf-cap', plans, {}, SESSION_ID, root, 'wf-cap')
    const app = booted = await bootApp({ root, harnessDir })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row } = catalogRowOf(decision)
    const state = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    if (state === null) throw new Error('missing state')
    return { text: textOf(row), state }
  }

  it('empty (0) → `plans: none` and no `row scope:` segment in the row (payload keeps the aggregates)', async () => {
    const { text, state } = await catalogFor(0)
    expect(plansOf(text)).toBe('plans: none')
    expect(text).not.toContain('row scope:')
    expect(state.plans).toEqual([])
    expect(state.rowScopes).toEqual([])
  })

  it('singleton (1) → full join, no overflow token, byte-identical to the uncapped rendering', async () => {
    const rows = [capRow(0)]
    const { text } = await catalogFor(1)
    expect(plansOf(text)).toBe(`plans: ${uncappedPlans(rows)}`)
  })

  it('exactly at the limit (8) → full join, no overflow token, byte-identical to the uncapped rendering', async () => {
    const rows = Array.from({ length: CAP }, (_, index) => capRow(index))
    const { text, state } = await catalogFor(CAP)
    expect(plansOf(text)).toBe(`plans: ${uncappedPlans(rows)}`)
    expect(state.plans).toHaveLength(CAP)
    // The recorded scopes stay in the payload — the panel renders them.
    expect(state.rowScopes).toHaveLength(CAP)
  })

  it('limit+1 (9) → first 8 rows + final `+1 more` join element (plans ` ` separator)', async () => {
    const rows = Array.from({ length: CAP + 1 }, (_, index) => capRow(index))
    const { text, state } = await catalogFor(CAP + 1)
    // The overflow token is the LAST join element (it carries no leading
    // space of its own — it lands after the separator).
    expect(plansOf(text)).toBe(`plans: ${uncappedPlans(rows.slice(0, CAP))} +1 more`)
    // The capped row renders nowhere on the line.
    expect(plansOf(text)).not.toContain('plan-8')
    // The aggregates stay full — the cap touches the text join only (D5).
    expect(state.plans).toHaveLength(CAP + 1)
    expect(state.rowScopes).toHaveLength(CAP + 1)
  })

  it('double-limit (16) → `+8 more` pins the D2 overflow wording', async () => {
    const rows = Array.from({ length: 2 * CAP }, (_, index) => capRow(index))
    const { text } = await catalogFor(2 * CAP)
    expect(plansOf(text)).toBe(`plans: ${uncappedPlans(rows.slice(0, CAP))} +8 more`)
    expect(plansOf(text)).not.toContain('plan-15')
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
      expect(lastMessage(live)?.source).toEqual({ kind: 'mstar-engine', form: 'catalog' })

      // Dispose — the listener is unwound: the terminal decision passes through unchanged.
      await fiber.dispose()
      const after = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(after).toEqual({ kind: 'enter', messages: inbox })

      // HMR reload — a fresh fiber restores the catalog contribution.
      const reloaded = await ctx.plugin(plugin, { harnessDir })
      const again = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(lastMessage(again)?.source).toEqual({ kind: 'mstar-engine', form: 'catalog' })
      await reloaded.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('D4 session-scoped catalog selection', () => {
  const ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev

## Task

Pick.
`

  it('two same-cwd sessions with different picks keep their own plans/ledger within TTL; one ledger invalidation refreshes both', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-d4-isolate-'))
    const harnessDir = join(root, 'harness')
    await seedActiveWorkflow(harnessDir, 'wf-a', [{ id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Todo' }], {}, 'seed-wf-a', root, 'wf-a')
    await seedActiveWorkflow(harnessDir, 'wf-b', [{ id: 'plan-b', title: 'Plan B', file: 'plans/plan-b.md', status: 'Done' }], {}, 'seed-wf-b', root, 'wf-b')
    const app = booted = await bootApp({ root, harnessDir })
    expect(updateWorkflowSessionBinding(harnessDir, 's-A', root, { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 0 }).kind).toBe('written')
    expect(updateWorkflowSessionBinding(harnessDir, 's-B', root, { selectedWorkflowId: 'wf-b', excludedBeforeSeq: 0 }).kind).toBe('written')

    const stepFor = (sessionId: string, turn: number) => ({
      agent: { session: { header: { id: sessionId, cwd: root } } },
      messages: [],
      turn,
      step: 1,
      signal: new AbortController().signal,
    } as never)

    const rowA1 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor('s-A', 1), defaultEnter([]))).row
    const rowB1 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor('s-B', 1), defaultEnter([]))).row
    expect(textOf(rowA1)).toContain('workflow: wf-a (active)')
    expect(textOf(rowA1)).toContain('plan-a(Todo)')
    expect(textOf(rowA1)).not.toContain('plan-b')
    expect(textOf(rowB1)).toContain('workflow: wf-b (active)')
    // wf-b's only plan is Done: the delta renders no pending plan for it.
    expect(textOf(rowB1)).toContain('plans: none')
    expect(textOf(rowB1)).not.toContain('plan-a')
    // Each session persisted its OWN selection's payload (the panel side of D4).
    const persistedPlansOf = (sessionId: string): unknown => {
      const read = readEngineStatusSnapshot(harnessDir, sessionId, root)
      if (read.kind !== 'ok') throw new Error(`no persisted emission for ${sessionId}`)
      return (read.entry.payload.state as { plans: unknown }).plans
    }
    expect(persistedPlansOf('s-A')).toEqual([{ id: 'plan-a', status: 'Todo', doneAt: null, iterationRefs: [] }])
    expect(persistedPlansOf('s-B')).toEqual([{ id: 'plan-b', status: 'Done', doneAt: null, iterationRefs: [] }])

    // A ledger line written DIRECTLY for wf-b (bypassing recordDispatch → no
    // invalidation): no cache entry is refreshed, so nothing is appended and
    // neither session's persisted window moves.
    appendLiveEvent(harnessDir, 'wf-b', { v: 1, ts: Date.now(), kind: 'dispatch', role: 'architect', verdict: 'ok', hard: false })
    const afterA = await app.ctx.waterfall('agent/pre-step', stepFor('s-A', 2), defaultEnter([]))
    const afterB = await app.ctx.waterfall('agent/pre-step', stepFor('s-B', 2), defaultEnter([]))
    expect(afterA.kind === 'enter' && afterA.messages).toEqual([])
    expect(afterB.kind === 'enter' && afterB.messages).toEqual([])
    /** The agent-flow roles of one session's persisted emission payload. */
    const persistedRolesOf = (sessionId: string): string[] => {
      const read = readEngineStatusSnapshot(harnessDir, sessionId, root)
      if (read.kind !== 'ok') throw new Error(`no persisted emission for ${sessionId}`)
      const state = read.entry.payload.state as { agentFlow: { events: { role: string }[] } | null } | null
      return (state?.agentFlow?.events ?? []).map((event) => event.role)
    }
    expect(persistedRolesOf('s-A')).toEqual([])
    expect(persistedRolesOf('s-B')).toEqual([])

    plugin.recordDispatch({
      harnessDir,
      workflowId: 'wf-a',
      resolvedWorkflowDir: join(harnessDir, 'workflows/wf-a'),
      selectedGeneration: selectedGenerationFor(harnessDir),
      prompt: ASSIGNMENT,
      violations: [],
      hard: false,
    })
    // The record invalidates EVERY session entry of this harness: both rebuild
    // (the direct wf-b line and the recorded wf-a line), so both persisted
    // panel payloads now carry their own selected workflow's ledger window.
    // The compact rows render no ledger detail, so neither step appends one.
    const stepA3 = await app.ctx.waterfall('agent/pre-step', stepFor('s-A', 3), defaultEnter([]))
    const stepB3 = await app.ctx.waterfall('agent/pre-step', stepFor('s-B', 3), defaultEnter([]))
    expect(stepA3.kind === 'enter' && stepA3.messages).toEqual([])
    expect(stepB3.kind === 'enter' && stepB3.messages).toEqual([])
    expect(persistedRolesOf('s-A')).toEqual(['fullstack-dev'])
    expect(persistedRolesOf('s-B')).toEqual(['architect'])
  })

  it('an unbound session with multiple ACTIVE workflows remains a picker error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-d4-terminal-'))
    const harnessDir = join(root, 'harness')
    await seedActiveWorkflow(harnessDir, 'wf-a', [{ id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Todo' }], {}, 'seed-wf-a', root, 'wf-a')
    await seedActiveWorkflow(harnessDir, 'wf-b', [{ id: 'plan-b', title: 'Plan B', file: 'plans/plan-b.md', status: 'Done' }], {}, 'seed-wf-b', root, 'wf-b')
    const app = booted = await bootApp({ root, harnessDir })
    const payload = await buildCatalogPayloadWithStore(app.ctx, harnessDir)
    expect(payload.state?.selection).toEqual({
      kind: 'error',
      code: 'workflow.selection.unbound-multi-active',
      message: expect.stringContaining('2 active lifecycles'),
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
    expect(payload.state?.plans).toEqual([])
    expect(payload.state?.direction).toBeNull()
    expect(payload.iteration).toBeUndefined()
  })

  it('state, direction and iteration gate all come from the same selected workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-d4-cohere-'))
    const harnessDir = join(root, 'harness')
    const compass = (id: string, direction: string): string => [
      '---',
      `iteration_id: ${id}`,
      'start_date: 2026-08-19',
      'status: active',
      'iteration_base_branch: dev-dsh',
      'target_branch: dev-dsh',
      '---',
      '',
      '## Direction lock',
      '',
      `- **Problem statement:** ${direction}`,
      '',
    ].join('\n')
    await seedActiveWorkflow(harnessDir, 'wf-a', [{ id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Todo' }], {
      type: 'iteration', compass_ref: 'iterations/wf-a/delivery-compass.md',
    }, 'seed-wf-a', root, 'wf-a')
    await seedActiveWorkflow(harnessDir, 'wf-b', [{ id: 'plan-b', title: 'Plan B', file: 'plans/plan-b.md', status: 'Done' }], {
      type: 'iteration', compass_ref: 'iterations/wf-b/delivery-compass.md',
    }, 'seed-wf-b', root, 'wf-b')
    await mkdir(join(harnessDir, 'iterations/wf-a'), { recursive: true })
    await mkdir(join(harnessDir, 'iterations/wf-b'), { recursive: true })
    await writeFile(join(harnessDir, 'iterations/wf-a/delivery-compass.md'), compass('wf-a', 'Direction A.'))
    await writeFile(join(harnessDir, 'iterations/wf-b/delivery-compass.md'), compass('wf-b', 'Direction B.'))
    const app = booted = await bootApp({ root, harnessDir })
    const payload = await buildCatalogPayloadWithStore(app.ctx, harnessDir, {
      cwd: root,
      sessionId: 's-A',
      selectedWorkflowId: 'wf-a',
    })
    expect(payload.state?.selection).toEqual({ kind: 'active', workflowId: 'wf-a', dir: 'workflows/wf-a' })
    expect(payload.state?.plans).toEqual([{ id: 'plan-a', status: 'Todo', doneAt: null, iterationRefs: [] }])
    expect(payload.state?.direction).toBe('Direction A.')
    expect(payload.iteration).toMatchObject({
      iterationId: 'wf-a',
      compassPath: join(harnessDir, 'iterations/wf-a/delivery-compass.md'),
      compassStatus: 'active',
    })
  })
})

describe('D4 catalog identity encoding + selected compass path', () => {
  it('two tuples that differ only by a delimiter in an opaque field do not collide', () => {
    const harness = '/h'
    // Adjacent sessionId / cwd: `\u0000`-join fused these into one key.
    expect(catalogCacheKey(harness, 's', 'a\u0000b', undefined))
      .not.toBe(catalogCacheKey(harness, 's\u0000a', 'b', undefined))
    // Adjacent selectedWorkflowId / cwd — the same delimiter-shift.
    expect(catalogCacheKey(harness, 's', '/ws', { cwd: 'x\u0000y', selectedWorkflowId: 'wf-a' }))
      .not.toBe(catalogCacheKey(harness, 's', '/ws', { cwd: 'x', selectedWorkflowId: 'y\u0000wf-a' }))
  })

  const compassDoc = (id: string, direction: string): string => [
    '---',
    `iteration_id: ${id}`,
    'start_date: 2026-08-19',
    'status: active',
    'iteration_base_branch: dev-dsh',
    'target_branch: dev-dsh',
    '---',
    '',
    '## Direction lock',
    '',
    `- **Problem statement:** ${direction}`,
    '',
  ].join('\n')

  it('refuses a compass_ref whose basename is not delivery-compass.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-compass-basename-'))
    const harnessDir = join(root, 'harness')
    await seedActiveWorkflow(harnessDir, 'wf-a', [{ id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Todo' }], {
      type: 'iteration', compass_ref: 'iterations/wf-a/notes.md',
    }, SESSION_ID, root, 'wf-a')
    await mkdir(join(harnessDir, 'iterations/wf-a'), { recursive: true })
    await writeFile(join(harnessDir, 'iterations/wf-a/notes.md'), compassDoc('wf-a', 'Stolen direction.'))
    const app = booted = await bootApp({ root, harnessDir })
    const payload = await buildCatalogPayloadWithStore(app.ctx, harnessDir)
    expect(payload.state?.selection).toEqual({ kind: 'active', workflowId: 'wf-a', dir: 'workflows/wf-a' })
    expect(payload.state?.direction).toBeNull()
    expect(payload.iteration).toBeUndefined()
  })

  it('refuses a delivery-compass.md symlink whose target escapes the harness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-compass-symlink-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-compass-outside-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    const outsideFile = join(outsideDir, 'delivery-compass.md')
    await writeFile(outsideFile, compassDoc('wf-a', 'Escaped direction.'))
    await seedActiveWorkflow(harnessDir, 'wf-a', [{ id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Todo' }], {
      type: 'iteration', compass_ref: 'iterations/wf-a/delivery-compass.md',
    }, SESSION_ID, root, 'wf-a')
    await mkdir(join(harnessDir, 'iterations/wf-a'), { recursive: true })
    await symlink(outsideFile, join(harnessDir, 'iterations/wf-a/delivery-compass.md'))
    try {
      const app = booted = await bootApp({ root, harnessDir })
      const payload = await buildCatalogPayloadWithStore(app.ctx, harnessDir)
      expect(payload.state?.selection).toEqual({ kind: 'active', workflowId: 'wf-a', dir: 'workflows/wf-a' })
      expect(payload.state?.direction).toBeNull()
      expect(payload.iteration).toBeUndefined()
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
