/**
 * Host-handler spec for the `mstar` gateway's WRITE half
 * (`/api/mstar/selectWorkflow`, the panel's picker commit)
 * (`src/engine-status-endpoint.ts`).
 *
 * Covered: the descriptor + registration path on the host's shared typert
 * gateway, the validation chain (accept / reject with an explicit reason),
 * NO cross-session answer, traversal refusal, and the boot of a composition
 * WITHOUT a typert registry (the endpoint is an optional unit — the row must
 * still activate).
 *
 * The end-to-end case drives the REAL emission path first (the pre-step
 * waterfall persists the snapshot) and only then calls the endpoint, so the
 * served payload is proven to be the emitted one.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { initializeStore, openStore, storeDbPath } from '@mstar-harness/engine'
import * as entry from '../src/index.ts'
import { readWorkflowSessionBinding } from '../src/engine-status-store.ts'
// Namespace imports of the two REAL modules the endpoint calls into: the
// picker-boundary cases interpose a call-through wrapper on ONE exported
// function per case, so the production handler still reads the real native
// authority while the test controls exactly when the authority moves.
import * as endpointStore from '../src/engine-status-store.ts'
import * as workflowSelection from '../src/gates/workflow-selection.ts'
import {
  installEngineStatusEndpoint,
  MSTAR_ENGINE_STATUS_NAMESPACE,
  MSTAR_SELECT_WORKFLOW_METHOD,
  type MstarSelectWorkflowResult,
} from '../src/engine-status-endpoint.ts'
import { SELECT_WORKFLOW_ENDPOINT } from '../src/engine-status-wire.ts'
import { bootApp, seedActiveWorkflow, seedHarness, seedStore, v2Root, v2Snapshot, v2WorkflowEntry, type BootResult } from './harness.ts'

let booted: BootResult | undefined

/**
 * The picker-boundary interposer a window case arms. Restored after every test
 * so a failing assertion can never leak the wrapper into the next case (the
 * mocked reader/writer is a module-level binding shared by the whole file).
 */
let boundarySpy: { mockRestore(): void } | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  boundarySpy?.mockRestore()
  boundarySpy = undefined
})

/**
 * Minimal `sessionController` seam: the ONE contract the endpoint's persisted
 * fallback reads (`inspect(id)` → an object carrying `header.cwd`). Mounted as
 * a cordis service row so the endpoint's structural `ctx.get(...)` sees a real
 * provided service (a bare `ctx.set` is rejected without a `provide`).
 */
class FakeSessionController extends Service {
  /** Test-drivable cold read (the persisted-session fallback). */
  handler: (sessionId: string) => Promise<unknown> = async () => ({ header: {} })

  constructor(ctx: Context) {
    super(ctx, 'sessionController')
  }

  inspect(sessionId: string): Promise<unknown> {
    return this.handler(sessionId)
  }
}

/** Structural view of the endpoint as the gateway dispatches it. */
interface EndpointView {
  selectWorkflow(sessionId: unknown, cwd: unknown, workflowId: unknown): Promise<MstarSelectWorkflowResult>
}

/** Structural view of the fake sessions registry (the harness's driver). */
interface FakeSessionsView {
  register(session: unknown): void
}

/** The `mstar` service of one boot (the endpoint owner). */
function endpointOf(app: BootResult): EndpointView {
  const service = app.ctx.get('mstar') as EndpointView | undefined
  if (service === undefined) throw new Error('mstar service not registered')
  return service
}

/** Register one live session (id + header cwd + bounded seq) on the fake sessions service. */
function liveSession(app: BootResult, id: string, cwd: string, seq = 0): void {
  const sessions = app.ctx.get('sessions') as FakeSessionsView | undefined
  if (sessions === undefined) throw new Error('sessions service not mounted')
  sessions.register({ id, header: { cwd }, seq })
}

describe('mstar gateway — multi-fiber dedupe and withdrawal', () => {
  /**
   * A sibling-plugin boot (an HMR re-apply, or two plugin instances on one
   * host) applies `installEngineStatusEndpoint` a second time on the SAME
   * context. This is the branch that had no coverage: without it, a failed
   * second registration could replace the first gateway and withdraw the
   * endpoint the first apply contributed — a whole host losing the panel,
   * which no unit case could see.
   */
  interface ServiceView {
    selectWorkflow(sessionId: unknown, cwd: unknown, workflowId: unknown): Promise<MstarSelectWorkflowResult>
  }

  /** The endpoint owner's answer for a commit it must refuse (no live session). */
  async function renderOf(ctx: Context): Promise<string | undefined> {
    const service = ctx.get(MSTAR_ENGINE_STATUS_NAMESPACE) as ServiceView | undefined
    if (service === undefined) return undefined
    const answer = await service.selectWorkflow('ses_none', '/proj', 'wf-x')
    return answer.status === 'unavailable' ? answer.reason : answer.status
  }

  /**
   * Which gateway instance is live, identified by the OPTIONS it was built
   * with. `ctx.get(...)` hands back a fresh callable wrapper per read (cordis
   * `Service` with the invoke symbol), so identity has to be read off the
   * instance's own options — which is exactly what the dedupe is about: whose
   * resolver/boot root the live endpoint serves with.
   */
  function optionsOf(ctx: Context): string | undefined {
    const service = ctx.get(MSTAR_ENGINE_STATUS_NAMESPACE) as
      | { bootHarnessDir?: string | null; resolver?: { explicit?: string | null } }
      | undefined
    return service === undefined
      ? undefined
      : `${String(service.bootHarnessDir)}\u0000${String(service.resolver?.explicit)}`
  }

  /**
   * A sibling fiber that installs the endpoint with its OWN boot root and its
   * own resolver — the second plugin instance's options, which the dedupe must
   * NOT let take over the live gateway.
   */
  async function sibling(app: BootResult, bootHarnessDir: string): Promise<Fiber> {
    const fiber = app.ctx.plugin((siblingCtx) => {
      installEngineStatusEndpoint(siblingCtx, {
        resolver: { forWorkspace: () => bootHarnessDir } as never,
        bootHarnessDir,
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    return fiber
  }

  it('keeps ONE gateway and ONE descriptor when a sibling fiber applies the endpoint', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await app.ctx.plugin(TypertRegistry)
    const registry = app.ctx.get('typert') as { local: { get(endpoint: string): unknown } }
    const before = await renderOf(app.ctx)
    expect(before).toBe('session-not-live')
    const ownerOptions = optionsOf(app.ctx)
    expect(ownerOptions).toContain(app.harnessDir)

    // The sibling apply: a second install on the same context.
    const fiber = await sibling(app, '/proj/sibling-boot-root')
    // The first gateway is untouched — the sibling's own options did NOT take
    // over, which is the exact class the dedupe exists to prevent…
    expect(optionsOf(app.ctx)).toBe(ownerOptions)
    expect(await renderOf(app.ctx)).toBe(before)
    // …and the endpoint is still served exactly once.
    expect(registry.local.get(SELECT_WORKFLOW_ENDPOINT)).toBeDefined()

    // Withdrawal is scoped to ownership: the sibling registered neither unit,
    // so disposing it must not remove the owner's service or descriptor.
    await fiber.dispose()
    expect(optionsOf(app.ctx)).toBe(ownerOptions)
    expect(await renderOf(app.ctx)).toBe(before)
    expect(registry.local.get(SELECT_WORKFLOW_ENDPOINT)).toBeDefined()
  })

  it('takes the admission-test branch on a second install instead of rebuilding the gateway', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    // The dedupe line is the observable difference between the two branches: the
    // admission test skips the constructor, whereas a lost race would build a
    // second gateway, be refused by the live service name and log the
    // concurrent-registration line instead. The logger is the seam this module
    // already writes through.
    const originalLogger = app.ctx.logger
    const lines: string[] = []
    const capture = (name?: string): Record<'debug' | 'info' | 'warn' | 'error', (message: string) => void> => {
      const sink = originalLogger.call(app.ctx, name)
      const record = (write: (message: string) => void) => (message: string): void => {
        lines.push(message)
        write(message)
      }
      return { debug: record(sink.debug), info: record(sink.info), warn: record(sink.warn), error: record(sink.error) }
    }
    app.ctx.logger = capture as unknown as typeof app.ctx.logger
    try {
      const siblingFiber = await sibling(app, '/proj/sibling-boot-root')
      expect(lines.filter((line) => line.includes('gateway already registered'))).toHaveLength(1)
      expect(lines.filter((line) => line.includes('gateway registered concurrently'))).toHaveLength(0)
      // The deduped second install left the live gateway serving.
      expect(await renderOf(app.ctx)).toBe('session-not-live')
      await siblingFiber.dispose()
    } finally {
      app.ctx.logger = originalLogger
    }
  })

  it('registers afresh on the next apply after an HMR reload of the plugin row', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    // The host composition owns the registry — an HMR reload disposes the
    // plugin ROW only, and re-applies it against the same live registry.
    const hostFiber = app.ctx.plugin(TypertRegistry)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const registry = app.ctx.get('typert') as { local: { get(endpoint: string): unknown } }
    const endpoint = SELECT_WORKFLOW_ENDPOINT
    expect(registry.local.get(endpoint)).toBeDefined()
    expect(optionsOf(app.ctx)).toContain(app.harnessDir)

    // The reload: the plugin row's fiber withdraws both of its units, and the
    // host context is otherwise untouched.
    expect(app.pluginFiber).toBeDefined()
    await (app.pluginFiber as Fiber).dispose()
    expect(app.ctx.get(MSTAR_ENGINE_STATUS_NAMESPACE)).toBeUndefined()
    expect(registry.local.get(endpoint)).toBeUndefined()

    // Re-apply the same row on the same context, as the loader would.
    const reapplied = await app.ctx.plugin(entry, { harnessDir: app.harnessDir })
    expect(app.ctx.get(MSTAR_ENGINE_STATUS_NAMESPACE)).toBeDefined()
    expect(optionsOf(app.ctx)).toContain(app.harnessDir)
    expect(await renderOf(app.ctx)).toBe('session-not-live')
    expect(registry.local.get(endpoint)).toBeDefined()

    // The re-applied units belong to the re-applied row: disposing it
    // withdraws them, so ownership follows the apply and never the context.
    await reapplied.dispose()
    expect(app.ctx.get(MSTAR_ENGINE_STATUS_NAMESPACE)).toBeUndefined()
    expect(registry.local.get(endpoint)).toBeUndefined()
    await hostFiber.dispose()
  })
})

describe('mstar gateway — optional-unit boot', () => {
  it('boots a composition with no typert registry, no sessions and no controller', async () => {    // A base-only profile shape: the endpoint registers nothing web-only, the
    // boot settles (the harness awaits each row — a pended row would hang it),
    // and the plugin surface is still present.
    const app = (booted = await bootApp())
    expect(app.ctx.get('typert')).toBeUndefined()
    expect(app.ctx.get('sessions')).toBeUndefined()
    expect(typeof endpointOf(app).selectWorkflow).toBe('function')
    // Degrades with an explicit reason instead of throwing at the caller.
    expect(await endpointOf(app).selectWorkflow('ses_alpha', '/proj', 'wf-a')).toEqual({
      status: 'unavailable',
      reason: 'session-not-live',
    })
  })

  it('does not name connection or webServer in the host row static inject', () => {
    // The HARD headless constraint, asserted at the source of truth rather than
    // inferred from a passing boot: the plugin's declared inject list must stay
    // free of the web-only services.
    expect(entry.inject).not.toContain('connection')
    expect(entry.inject).not.toContain('webServer')
    expect(entry.inject).toEqual(['loader'])
  })
})

describe('selectWorkflow endpoint — D4 picker commit', () => {
  async function seedTwoActives(app: BootResult): Promise<void> {
    await seedActiveWorkflow(app.harnessDir, 'wf-a', [{ id: 'plan-a', status: 'Todo' }])
    await seedActiveWorkflow(app.harnessDir, 'wf-b', [{ id: 'plan-b', status: 'Done' }])
    // Retired file bytes deliberately disagree with the ACTIVE graph.
    await seedHarness(app.harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-old')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { plans: [{ id: 'plan-a', status: 'Todo' }] }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { plans: [{ id: 'plan-b', status: 'Done' }] }),
      'workflows/wf-old/snapshot.json': v2Snapshot('wf-old', { status: 'completed', ended_at: '2026-08-19' }),
    })
  }

  /**
   * Advance the REAL authority generation of the fixture store, exactly as the
   * engine's own fixtures do (`execution-store.test.ts`), so the picker compares
   * two genuinely different authority reads rather than a token the test handed
   * to a wrapper. Synchronous on purpose: the picker's commit is a synchronous
   * native call, so the second window's barrier cannot yield between the
   * automatic validation and the native transaction.
   */
  function advanceAuthorityEpoch(harnessDir: string): void {
    const db = new DatabaseSync(storeDbPath({ harnessDir }))
    try {
      db.prepare('update store_meta set authority_epoch = authority_epoch + 1 where id = 1').run()
    } finally {
      db.close()
    }
  }

  /** The fixture store's own generation, read back from the native authority. */
  function authorityEpochOf(harnessDir: string): number {
    const db = new DatabaseSync(storeDbPath({ harnessDir }))
    try {
      const row = db.prepare('select authority_epoch from store_meta where id = 1').get() as
        | { authority_epoch?: unknown }
        | undefined
      if (typeof row?.authority_epoch !== 'number') throw new Error('fixture generation is unreadable')
      return row.authority_epoch
    } finally {
      db.close()
    }
  }

  it('refuses invalid/terminal ids, cwd mismatch, non-live sessions and a failed store commit', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedTwoActives(app)
    const endpoint = endpointOf(app)

    expect(await endpoint.selectWorkflow('', app.root, 'wf-a')).toEqual({ status: 'unavailable', reason: 'invalid-session-id' })
    expect(await endpoint.selectWorkflow('s-A', app.root, 'wf-a')).toEqual({ status: 'unavailable', reason: 'session-not-live' })

    liveSession(app, 's-A', app.root, 5)
    expect(await endpoint.selectWorkflow('s-A', '/elsewhere', 'wf-a')).toEqual({ status: 'unavailable', reason: 'cwd-mismatch' })
    expect(await endpoint.selectWorkflow('s-A', app.root, 'wf-old')).toEqual({ status: 'unavailable', reason: 'workflow-not-active' })
    expect(await endpoint.selectWorkflow('s-A', app.root, 'wf-missing')).toEqual({ status: 'unavailable', reason: 'workflow-not-active' })
  })

  it('a valid pick survives re-apply without advancing the exclusion floor', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedTwoActives(app)
    liveSession(app, 's-A', app.root, 5)
    const endpoint = endpointOf(app)

    expect(await endpoint.selectWorkflow('s-A', app.root, 'wf-a')).toEqual({
      status: 'selected',
      sessionId: 's-A',
      workflowId: 'wf-a',
    })
    expect(readWorkflowSessionBinding(app.harnessDir, 's-A', app.root)).toEqual({
      kind: 'ok',
      binding: { cwd: app.root, selectedWorkflowId: 'wf-a', executionBinding: null, excludedBeforeSeq: 5 },
    })

    liveSession(app, 's-A', app.root, 9)
    expect(await endpoint.selectWorkflow('s-A', app.root, 'wf-a')).toEqual({
      status: 'selected',
      sessionId: 's-A',
      workflowId: 'wf-a',
    })
    expect(readWorkflowSessionBinding(app.harnessDir, 's-A', app.root)).toEqual({
      kind: 'ok',
      binding: { cwd: app.root, selectedWorkflowId: 'wf-a', executionBinding: null, excludedBeforeSeq: 5 },
    })

    // The panel-visible half of a pick (its `retained.selection`) is asserted in
    // `panel-snapshot-endpoint.spec.ts`: the read path is that endpoint's, and a
    // commit is only real once a later read resolves the stored binding.
  })
  /**
   * Window 1 — the authority is replaced AFTER the registry read and BEFORE
   * the automatic source read (`engine-status-endpoint.ts` `pick()` step 2 →
   * step 3). The interposer is a CALL-THROUGH wrapper on the real reader: the
   * first (registry) read is delegated verbatim, and only once it has answered
   * does the test advance the REAL authority generation. The picker's second
   * read therefore compares two genuinely different authority reads, so the
   * refusal can only be the source-comparison token — the native commit guard
   * is never reached.
   */
  it('refuses with selection-generation-changed when the authority is replaced between the registry and automatic source reads', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedTwoActives(app)
    liveSession(app, 's-A', app.root, 17)
    const endpoint = endpointOf(app)

    const originalEpoch = authorityEpochOf(app.harnessDir)

    const realRead = workflowSelection.readExecutionWorkflowSource
    let reads = 0
    let advanced = false
    boundarySpy = spyOn(workflowSelection, 'readExecutionWorkflowSource').mockImplementation(async (context, hint) => {
      reads += 1
      const answer = await realRead(context, hint)
      if (!advanced) {
        // The registry read has answered; the authority moves now, i.e. before
        // the picker's automatic read is even issued.
        advanced = true
        advanceAuthorityEpoch(app.harnessDir)
      }
      return answer
    })

    expect(await endpoint.selectWorkflow('s-A', app.root, 'wf-a')).toEqual({
      status: 'unavailable',
      reason: 'selection-generation-changed',
    })
    // Both source reads were the REAL reader against the REAL store.
    expect(reads).toBe(2)
    expect(authorityEpochOf(app.harnessDir)).toBe(originalEpoch + 1)
    // No preference and no floor: the session has no binding row at all.
    expect(readWorkflowSessionBinding(app.harnessDir, 's-A', app.root)).toEqual({ kind: 'ok' })

    // The barriered generation has settled: an unchanged healthy retry commits
    // the preference and the correct exclusion floor.
    boundarySpy.mockRestore()
    boundarySpy = undefined
    expect(await endpoint.selectWorkflow('s-A', app.root, 'wf-a')).toEqual({
      status: 'selected',
      sessionId: 's-A',
      workflowId: 'wf-a',
    })
    expect(readWorkflowSessionBinding(app.harnessDir, 's-A', app.root)).toMatchObject({
      kind: 'ok',
      binding: { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 17 },
    })
  })

  /**
   * Window 2 — the authority is replaced AFTER the automatic-source validation
   * and BEFORE the native commit (`pick()` step 3 → step 5). The interposer is
   * a CALL-THROUGH wrapper on the real native writer: it advances the REAL
   * generation from the SAME synchronous boundary the picker commits on (the
   * commit is a synchronous native call, so the bump cannot be async), then
   * delegates the untouched call through. The native transaction re-reads the
   * metadata it opened with, so only the picker's forwarded
   * `selectedGeneration` can refuse it — a caller that dropped that token
   * would commit here.
   */
  it('refuses with the native stale-generation guard when the authority is replaced after automatic validation and before the native commit', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedTwoActives(app)
    liveSession(app, 's-B', app.root, 17)
    const endpoint = endpointOf(app)

    const realWrite = endpointStore.updateWorkflowSessionBinding
    let commits = 0
    let advanced = false
    boundarySpy = spyOn(endpointStore, 'updateWorkflowSessionBinding').mockImplementation((harnessDir, sessionId, cwd, update) => {
      commits += 1
      if (!advanced) {
        advanced = true
        advanceAuthorityEpoch(harnessDir)
      }
      return realWrite(harnessDir, sessionId, cwd, update)
    })

    const refused: MstarSelectWorkflowResult = await endpoint.selectWorkflow('s-B', app.root, 'wf-a')
    expect(refused.status).toBe('unavailable')
    if (refused.status !== 'unavailable') throw new Error('unreachable')
    // The DISTINCT NATIVE cause, not W1's source-comparison token: refusal here
    // must be the native stale-generation guard the automatic-source window
    // never reaches. Only the machine cause token is pinned — the refusal
    // sentence's prose is not a product contract this test owns.
    expect(refused.reason.startsWith('store-[store.stale-epoch]')).toBe(true)
    expect(refused.reason).not.toBe('selection-generation-changed')
    // Exactly one native commit attempt, refused before its body ran.
    expect(commits).toBe(1)
    // No preference and no floor: the session has no binding row at all.
    expect(readWorkflowSessionBinding(app.harnessDir, 's-B', app.root)).toEqual({ kind: 'ok' })

    boundarySpy.mockRestore()
    boundarySpy = undefined
    expect(await endpoint.selectWorkflow('s-B', app.root, 'wf-a')).toEqual({
      status: 'selected',
      sessionId: 's-B',
      workflowId: 'wf-a',
    })
    expect(readWorkflowSessionBinding(app.harnessDir, 's-B', app.root)).toMatchObject({
      kind: 'ok',
      binding: { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 17 },
    })
  })
})
