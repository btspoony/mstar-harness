/**
 * store-cutover.spec.ts — the dsh host's issue/catalog authority cutover.
 *
 * Every case runs against the REAL engine: a real `node:sqlite` database
 * created by `initializeStore`, real migrations, real catalog/issue rows
 * written through the domain verbs (`captureIssue` / `linkIssue` /
 * `registerCatalogEntity`) and, where a pending registration is needed, the
 * real catalog-registration journal entered through the real registration
 * writer (failure injected at the REAL artifact-store write boundary, never a
 * mocked reader). Nothing is mocked and no fixture echoes a canned reader
 * result — the assertions read what the host actually renders and gates.
 *
 * What the cutover has to prove (task brief §Proof):
 * 1. DB issue AND catalog data is visible with NO live index and NO live
 *    register on disk — the readers never fall back to either.
 * 2. A stale/unavailable PROJECTION is distinguished from a current one.
 * 3. A runtime refusal (below-floor / missing capability) is NOT rendered as
 *    empty findings, and never passes a closure gate.
 * 4. A pending catalog registration refuses dispatch, while an
 *    uninitialized/staged store (pre-activation) does not.
 * 5. The current phase/leases still come from the JSON execution authority.
 */
import { mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  MIN_BUN_VERSION,
  StoreError,
  assertStoreRuntimeSupported,
  createFsStore,
  detectStoreRuntime,
  openStore,
  reconcileCatalogExecution,
  registerCatalogEntity,
  registerShippedCatalogExecution,
  setArtifactStore,
} from '@mstar-harness/engine'
import type { ArtifactStore } from '@mstar-harness/engine'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildCatalogPayload, buildCatalogPayloadWithStore } from '../src/gates/catalog.ts'
import { catalogRegistrationRefusal, resolveActiveWorkflow } from '../src/gates/workflow-selection.ts'
import { StatusVetoError, validateStatusValue } from '../src/gates/status.ts'
import { bootApp, seedHarness, seedKnowledgeDoc, seedOpenIssue, seedStore, v2Register, v2ResidualEntry, v2Root, v2Snapshot, v2SnapshotWithPlans, v2WorkflowEntry, type BootResult } from './harness.ts'
import type { StatusGateAdvisory } from '../src/index.ts'

let booted: BootResult | undefined
const roots: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  setArtifactStore(undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** One booted app on a fresh workspace root (no store written yet). */
async function appWithRoot(name: string, enforcement?: 'hard' | 'soft'): Promise<{ app: BootResult; harnessDir: string }> {
  const root = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  roots.push(root)
  const app = booted = await bootApp({ root, ...(enforcement !== undefined ? { enforcement } : {}) })
  return { app, harnessDir: app.harnessDir }
}

/** A booted app plus an ACTIVE empty store at its harness dir (`enforcement` opts into hard mode). */
async function storeApp(enforcement?: 'hard' | 'soft'): Promise<{ app: BootResult; harnessDir: string }> {
  const { app, harnessDir } = await appWithRoot('store-cutover', enforcement)
  await seedStore(harnessDir)
  return { app, harnessDir }
}

/**
 * Make `{HARNESS_DIR}/store.db` unopenable through the REAL engine channel: a
 * DIRECTORY where the database file belongs (`openStore` refuses with
 * `store.corrupt`). The below-floor/capability refusal cannot be staged
 * in-process (`globalThis.Bun` is non-writable under Bun), so a refusal the
 * engine really raises proves the same channel.
 */
async function corruptStore(harnessDir: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) await unlink(join(harnessDir, `store.db${suffix}`)).catch(() => {})
  await mkdir(join(harnessDir, 'store.db'), { recursive: true })
}

/** FsTarget for one workflow snapshot under the boot harness dir (local-backend shape). */
function snapshotTarget(harnessDir: string, workflowId = 'wf-store'): FsTarget {
  const path = join(harnessDir, 'workflows', workflowId, 'snapshot.json')
  return { targetKey: path as FsTarget['targetKey'], displayPath: path }
}

/** Collect the `mstar/status-gate` advisories emitted on one app context. */
function captureStatusAdvisories(ctx: BootResult['ctx']): StatusGateAdvisory[] {
  const advisories: StatusGateAdvisory[] = []
  ctx.on('mstar/status-gate', (payload) => { advisories.push(payload) })
  return advisories
}

/**
 * A valid workflow snapshot whose one plan row CONFIGURES the findings cleanup
 * gate (`v2SnapshotWithPlans` carries the schema fields the engine validator
 * requires, so the cleanup extension is actually reached).
 */
function cleanupSnapshot(planId: string, mode: 'zero-residual' | 'allow-residual' = 'zero-residual'): Record<string, unknown> {
  return JSON.parse(v2SnapshotWithPlans(
    'wf-store',
    [{ id: planId, title: 'Plan a', file: 'plans/plan-a.md', status: 'InProgress', metadata: { findings_cleanup: mode } }],
    { status: 'running' },
  )) as Record<string, unknown>
}

/** The same snapshot as JSON text (the on-disk seed form). */
function cleanupSnapshotJson(planId: string, mode: 'zero-residual' | 'allow-residual' = 'zero-residual'): string {
  return JSON.stringify(cleanupSnapshot(planId, mode))
}

/** One pending tool call in the registry pipeline shape (dsh-tools ToolExecution). */
let execSeq = 0
function toolExec(name: string, args: unknown): ToolExecution {
  return {
    callId: `c${++execSeq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** The Assignment-shaped dispatch call the `tools/pre-execute` gate sees. */
function dispatchExec(): ToolExecution {
  return toolExec('subagent', {
    description: 'writable implement round',
    prompt: ['## Assignment', '**Execute as**: fullstack-dev', '**Task category**: logic', '**Execution mode**: sdd', '', 'Implement the thing.'].join('\n'),
  })
}

/** A shape-valid `workflow` fan-out call (no Assignment prompt — `meta.name` only). */
function workflowExec(metaName = 'probe'): ToolExecution {
  return toolExec('workflow', { script: 'probe', meta: { name: metaName, description: 'probe' } })
}

/** A shape-valid `ralph` fan-out call (no Assignment prompt — `objective` only). */
function ralphExec(objective = 'probe the codebase'): ToolExecution {
  return toolExec('ralph', { objective })
}

/** The pre-step payload the agent loop dispatches (a session id keys the catalog cache). */
function stepPayload(messages: unknown[]) {
  return {
    agent: { session: { header: { id: 's-store-cutover' } } },
    messages,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  } as never
}

/** The artifact store a real registration writes through, with ONE kind's `put` injected to fail. */
function failingStore(harnessDir: string, kind: 'snapshot' | 'status'): ArtifactStore {
  const base = createFsStore(harnessDir)
  let remaining = 1
  return {
    ...base,
    put: async (doc) => {
      if (remaining > 0 && doc.kind === kind) {
        remaining -= 1
        throw new Error(`injected ${kind} write failure`)
      }
      return base.put(doc)
    },
  }
}

/** The shipped plan-registration input (the real writer's own transport). */
function planRegistration(harnessDir: string, operationId: string) {
  return {
    operationId,
    actor: 'project-manager',
    workflow: {
      kind: 'plan' as const,
      workflowId: 'wf-store',
      options: {
        harnessDir,
        plan: { id: 'plan-a', title: 'Store cutover plan', file: 'plans/plan-a.md' },
        deliveryKind: 'development' as const,
        branchSource: 'feature/store-cutover',
        branchTarget: 'main',
        startedAt: '2026-09-19T00:00:00.000Z',
      },
    },
  }
}

/**
 * Drive a REAL root-visible pending registration for `operationId`: another
 * writer takes the plan's catalog location after the reviewed delta was
 * prepared, so the execution half lands (snapshot + root entry) while the
 * publish refuses — exactly the crash window the journal exists for. The
 * refusal is asserted here: it is what leaves the operation pending.
 */
async function seedPendingRegistration(harnessDir: string, operationId: string): Promise<void> {
  await registerCatalogEntity({ harnessDir }, {
    kind: 'plan',
    id: 'plan-a',
    title: 'Conflicting registration',
    rootKind: 'plans',
    relativePath: 'elsewhere.md',
  }, { operationId: 'seed-conflict', actor: 'project-manager' })
  setArtifactStore(createFsStore(harnessDir))
  await expect(registerShippedCatalogExecution({ harnessDir }, planRegistration(harnessDir, operationId))).rejects.toThrow(
    /catalog\.duplicate/,
  )
}

/* ===========================================================================
 * 1. The issue + catalog authority is visible with no live index/register
 * ========================================================================== */

describe('store cutover — the authority is the store, never the retired files', () => {
  it('renders DB issues and the DB knowledge catalog with no register and no README index on disk', async () => {
    const { app, harnessDir } = await storeApp()
    // A v2 root + snapshot (the JSON execution authority) and NOTHING else: no
    // projects/<id>/residuals.json, no knowledge/README.md.
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
    })
    await seedOpenIssue(harnessDir, { title: 'open high from the DB', severity: 'high', operationId: 'op-a' })
    await seedOpenIssue(harnessDir, { title: 'open info from the DB', severity: 'info', operationId: 'op-b' })
    await seedKnowledgeDoc(harnessDir, {
      id: 'doc-conventions',
      relativePath: 'conventions/harness-context.md',
      title: 'Harness context',
      operationId: 'op-doc-1',
    })

    const state = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    expect(state).not.toBeNull()
    if (state === null) return
    // The issue rollup came from store.db — the retired register does not exist.
    expect(state.residuals).toEqual([{ severity: 'high', count: 1 }, { severity: 'info', count: 1 }])
    expect(state.residualFindings?.map((finding) => [finding.id, finding.severity, finding.title])).toEqual([
      ['I-000001', 'high', 'open high from the DB'],
      ['I-000002', 'info', 'open info from the DB'],
    ])
    expect(state.project.openResiduals).toEqual(state.residuals)
    // The knowledge digest came from the catalog table — no README.md exists.
    expect(state.knowledge).toEqual({ docCount: 1, categories: ['conventions'] })
    expect(state.storeFacts?.kind).toBe('store')
    // A freshly initialized store has never built a projection generation, so
    // the envelope reports `unavailable` — the pre-refresh state, disclosed
    // rather than hidden.
    expect(state.storeFacts?.projection).toBe('unavailable')
    expect(state.storeFacts?.diagnostic).toContain('projection unavailable')
  })

  it('renders the DB rollup through the async pre-read (the row the model actually sees)', async () => {
    const { app, harnessDir } = await storeApp()
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
    })
    await seedOpenIssue(harnessDir, { title: 'critical from the DB', severity: 'critical', operationId: 'op-c' })

    const inbox = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })]
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), async () => ({ kind: 'enter' as const, messages: inbox }))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const row = decision.messages[decision.messages.length - 1]!
    const text = row.content[0]?.type === 'text' ? row.content[0].text : ''
    expect(text).toContain('residuals: critical 1')
    // The projection disclosure rides along — the row never presents the
    // projected views as if they were built.
    expect(text).toContain('store: projection unavailable')
  })
})

/* ===========================================================================
 * 2. Freshness disclosure: a stale projection is named, not silently sold
 * ========================================================================== */

describe('store cutover — projection freshness is disclosed', () => {
  it('a stale projection is distinguished from a current one (issue rows stay authoritative)', async () => {
    const { app, harnessDir } = await storeApp()
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
    })
    await seedOpenIssue(harnessDir, { title: 'counted while the projection is stale', severity: 'medium', operationId: 'op-stale' })
    // Drive the real projection_meta row to `stale` with a named source
    // diagnostic — the state a refused refresh leaves behind.
    const handle = await openStore({ harnessDir }, 'write')
    handle.db
      .prepare("update projection_meta set freshness = 'stale', last_error_json = ? where id = 1")
      .run(JSON.stringify({
        sources: [{
          sourceKey: 'workflows/wf-store/snapshot.json',
          reason: 'changed-mid-read',
          message: 'the snapshot changed while the projections were captured',
        }],
      }))
    handle.close()

    const state = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    expect(state?.storeFacts?.kind).toBe('store')
    expect(state?.storeFacts?.projection).toBe('stale')
    expect(state?.storeFacts?.diagnostic).toContain('projection stale')
    expect(state?.storeFacts?.diagnostic).toContain('workflows/wf-store/snapshot.json')
    // The stale projection did NOT suppress the rows read from the authority.
    expect(state?.residuals).toEqual([{ severity: 'medium', count: 1 }])
  })
})

/* ===========================================================================
 * 3. A refusal is never empty findings, and never passes a closure gate
 * ========================================================================== */

describe('store cutover — refusals are disclosed and fail closed', () => {
  it('a runtime refusal is rendered with the engine\'s actionable text, and never becomes empty findings', async () => {
    const { app, harnessDir } = await storeApp()
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
    })
    await seedOpenIssue(harnessDir, { title: 'invisible only while the store refuses', severity: 'critical', operationId: 'op-refused' })

    // The below-floor/capability refusal cannot be staged in-process: the
    // engine reads the runtime off `globalThis.Bun`, which Bun exposes as a
    // non-writable, non-configurable property. So the REFUSAL CHANNEL is
    // proven with a refusal the engine really raises (a corrupt store), and
    // the floor refusal itself is pinned below through the engine's own check
    // — the same single authority the readers surface (`openStore` calls it
    // before touching a file, so the runtime case travels this same catch).
    await corruptStore(harnessDir)

    let refusal: StoreError | undefined
    try {
      await openStore({ harnessDir }, 'read')
    } catch (error) {
      refusal = error as StoreError
    }
    expect(refusal?.code).toBe('store.corrupt')

    const state = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    // The refusal is disclosed with the engine's own text — NOT an empty
    // "none open" rollup.
    expect(state?.storeFacts?.kind).toBe('unavailable')
    expect(state?.storeFacts?.diagnostic).toContain('store.corrupt')
    expect(state?.residualFindings).toBeNull()
    expect(state?.knowledge).toBeNull()

    // …and the closure gate FAILS CLOSED on the same refusal: the snapshot
    // document is never reported valid while the authority cannot be read.
    const gate = await validateStatusValue(cleanupSnapshot('plan-a'), 'snapshot', harnessDir)
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((violation) => violation.code)).toContain('findings.cleanup-authority-unavailable')
    expect(gate.violations[0]?.message).toContain('store.corrupt')
  })

  it('the below-floor/capability refusal is the engine\'s actionable one, not a local restatement', () => {
    // The readers never re-implement the floor: they surface whatever
    // `openStore` raises, and that raise is this text (issue contract §8).
    try {
      assertStoreRuntimeSupported({ isBun: true, version: '1.3.0' })
      throw new Error('expected the below-floor runtime to be refused')
    } catch (error) {
      expect((error as StoreError).code).toBe('store.runtime-unsupported')
      expect((error as StoreError).message).toContain(`Bun >=${MIN_BUN_VERSION}`)
      expect((error as StoreError).message).toContain('Upgrade the runtime')
      expect((error as StoreError).message).toContain('No older-runtime fallback exists')
    }
    try {
      assertStoreRuntimeSupported({ isBun: true, version: '1.4.0', hasSqlite: false })
      throw new Error('expected the missing capability to be refused')
    } catch (error) {
      expect((error as StoreError).code).toBe('store.runtime-unsupported')
      expect((error as StoreError).message).toContain('node:sqlite')
      expect((error as StoreError).message).toContain('No fallback runtime or driver is supported')
    }
  })

  it('a missing store is a named refusal for the reader, and a fail-closed closure gate', async () => {
    const { app, harnessDir } = await appWithRoot('store-missing')
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
    })

    const state = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    expect(state?.storeFacts?.kind).toBe('unavailable')
    expect(state?.storeFacts?.diagnostic).toContain('store.not-initialized')
    expect(state?.residualFindings).toBeNull()

    const gate = await validateStatusValue(cleanupSnapshot('plan-a'), 'snapshot', harnessDir)
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((violation) => violation.code)).toContain('findings.cleanup-authority-unavailable')
  })

  it('a staged store never passes as no findings (the authority must be active)', async () => {
    const { harnessDir } = await storeApp()
    const handle = await openStore({ harnessDir }, 'write')
    handle.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run()
    handle.close()

    const gate = await validateStatusValue(cleanupSnapshot('plan-a'), 'snapshot', harnessDir)
    expect(gate.ok).toBe(false)
    expect(gate.violations[0]?.message).toContain('store.not-active')
  })

  it("the plan's own open linked issues fail the configured cleanup gate; another plan's and an unlinked one do not", async () => {
    const { harnessDir } = await storeApp()
    const issueId = await seedOpenIssue(harnessDir, { title: 'linked blocker', severity: 'high', planId: 'plan-a', operationId: 'op-linked' })
    // Neither of these belongs to plan-a: a second plan's critical issue and an
    // issue with no plan provenance at all.
    await seedOpenIssue(harnessDir, { title: 'other plan', severity: 'critical', planId: 'plan-b', operationId: 'op-other' })
    await seedOpenIssue(harnessDir, { title: 'unlinked', severity: 'critical', operationId: 'op-unlinked' })

    const zero = await validateStatusValue(cleanupSnapshot('plan-a'), 'snapshot', harnessDir)
    expect(zero.ok).toBe(false)
    expect(zero.violations.map((violation) => violation.code)).toEqual(['findings.zero-residual-open-issue'])
    expect(zero.violations[0]?.message).toContain(issueId)

    // allow-residual tolerates the plan's own non-critical issue…
    const allow = await validateStatusValue(cleanupSnapshot('plan-a', 'allow-residual'), 'snapshot', harnessDir)
    expect(allow.ok).toBe(true)
    // …while a linked CRITICAL blocks both modes (issue contract §4).
    await seedOpenIssue(harnessDir, { title: 'critical blocker', severity: 'critical', planId: 'plan-a', operationId: 'op-critical' })
    const blocked = await validateStatusValue(cleanupSnapshot('plan-a', 'allow-residual'), 'snapshot', harnessDir)
    expect(blocked.ok).toBe(false)
    expect(blocked.violations.map((violation) => violation.code)).toEqual(['findings.allow-residual-critical'])
  })

  it('the fs-intent listener VETOES the snapshot write while the authority is unreadable (no repair escape)', async () => {
    const { app, harnessDir } = await storeApp('hard')
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
    })
    await corruptStore(harnessDir)
    const advisories = captureStatusAdvisories(app.ctx)
    let reached = 0

    const outcome = await app.ctx.waterfall('fs/write-intent', snapshotTarget(harnessDir), {}, async () => {
      reached += 1
      return { kind: 'createIfAbsent' as const }
    }).then(() => undefined, (error: unknown) => error)

    // The store-authority refusal is the ONE violation class the content-blind
    // repair escape may not admit: no write to the document can repair an
    // unreadable authority (the remedy is a store command), so admitting the
    // write would only let the plan row the closure gate asks about be removed
    // while no authority can re-derive the violation. The veto is the dsh
    // fs-policy channel — a throw — and it is NOT delegated to `next()`.
    expect(outcome).toBeInstanceOf(StatusVetoError)
    expect((outcome as StatusVetoError).code).toBe('status.veto')
    expect((outcome as StatusVetoError).violations.map((violation) => violation.code)).toEqual([
      'findings.cleanup-authority-unavailable',
    ])
    expect(reached).toBe(0) // the intent decision is never delegated: the write cannot land
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBeUndefined() // NOT a repair-escape allow
    expect(advisories[0]!.degraded).toBeUndefined()
    expect(advisories[0]!.result.violations.map((violation) => violation.code)).toEqual([
      'findings.cleanup-authority-unavailable',
    ])

    // The host hook reads the SAME validation path, so a writing host that
    // asks before the write gets the same refusal.
    const hook = await app.ctx.dshHostAdapter.beforeStatusWrite(join(harnessDir, 'workflows', 'wf-store', 'snapshot.json'), undefined)
    expect(hook.ok).toBe(false)
    expect(hook.code).toBe('findings.cleanup-authority-unavailable')
  })

  it('a schema violation still takes the repair escape under the same hard enforcement', async () => {
    const { app, harnessDir } = await storeApp('hard')
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      // A document the gate cannot even parse: the closure question is never
      // reached, so this write may BE the repair (the narrowed escape leaves
      // the document-validity class exactly as it was).
      'workflows/wf-store/snapshot.json': 'not json {{{',
    })
    const advisories = captureStatusAdvisories(app.ctx)
    let reached = 0

    const intent = await app.ctx.waterfall('fs/write-intent', snapshotTarget(harnessDir), {}, async () => {
      reached += 1
      return { kind: 'createIfAbsent' as const }
    })

    expect(intent).toEqual({ kind: 'createIfAbsent' }) // delegated: the write proceeds
    expect(reached).toBe(1)
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.violations.map((violation) => violation.code)).toEqual(['status.invalid-json'])
  })
})

/* ===========================================================================
 * 4. Root workflow selection stays JSON-owned; a pending registration refuses
 * ========================================================================== */

describe('store cutover — root selection is JSON-owned, registration is not', () => {
  it('a pending catalog registration refuses dispatch, and reconciling it restores dispatch', async () => {
    const { app, harnessDir } = await storeApp()
    // The REAL root-visible pending state: another writer takes the plan's
    // catalog location after the reviewed delta was prepared, so the execution
    // half lands (snapshot + root entry) while the publish refuses — exactly
    // the crash window the journal exists for.
    await seedPendingRegistration(harnessDir, 'op-reg')

    // Root routing stays JSON-owned: the selection reads the JSON registry the
    // registration writer just populated.
    const selection = resolveActiveWorkflow(harnessDir)
    expect(selection).toEqual({ kind: 'active', workflowId: 'wf-store', dir: 'workflows/wf-store' })

    const refusal = await catalogRegistrationRefusal(harnessDir, 'wf-store')
    expect(refusal?.code).toBe('catalog.registration-pending')
    expect(refusal?.message).toContain('catalog reconcile')

    let reached = 0
    const refused = await app.ctx.waterfall('tools/pre-execute', dispatchExec(), async () => {
      reached += 1
      return { kind: 'allow' as const }
    })
    expect(refused.kind).toBe('deny')
    expect(refused.kind === 'deny' ? refused.reason : '').toContain('no committed catalog registration')
    expect(reached).toBe(0)

    // The read path renders the same verdict instead of a healthy row.
    const state = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    expect(state?.selection).toEqual({
      kind: 'error',
      code: 'catalog.registration-pending',
      message: expect.stringContaining('catalog reconcile'),
    })

    // Reconciling is what clears it: with the conflicting row withdrawn the
    // journal publishes, and the very next dispatch is allowed through.
    const handle = await openStore({ harnessDir }, 'write')
    handle.db.prepare("delete from catalog_entities where kind = 'plan' and id = 'plan-a'").run()
    handle.close()
    const receipt = await reconcileCatalogExecution({ harnessDir }, 'op-reg')
    expect(receipt.recovered).toBe(true)
    expect(await catalogRegistrationRefusal(harnessDir, 'wf-store')).toBeNull()

    const allowed = await app.ctx.waterfall('tools/pre-execute', dispatchExec(), async () => {
      reached += 1
      return { kind: 'allow' as const }
    })
    expect(allowed.kind).toBe('allow')
    expect(reached).toBe(1)

    // …and the display recovers with it (no lingering refusal).
    const healthy = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    expect(healthy?.selection).toEqual({ kind: 'active', workflowId: 'wf-store', dir: 'workflows/wf-store' })
  })

  it('the workflow/ralph fan-out branch is refused too — the registration veto is not dispatch-only', async () => {
    const { app, harnessDir } = await storeApp()
    await seedPendingRegistration(harnessDir, 'op-fanout')
    let reached = 0
    const allow = async () => {
      reached += 1
      return { kind: 'allow' as const }
    }

    // `workflow` and `ralph` carry no Assignment prompt, so the dispatch-tool
    // branch never sees them — but they fan out child agents that write in the
    // same workspace, so a half-registered lifecycle must not launch through
    // them either.
    const workflowCall = await app.ctx.waterfall('tools/pre-execute', workflowExec(), allow)
    expect(workflowCall.kind).toBe('deny')
    expect(workflowCall.kind === 'deny' ? workflowCall.reason : '').toContain('no committed catalog registration')
    expect(reached).toBe(0) // a denied call short-circuits: no child is started

    const ralphCall = await app.ctx.waterfall('tools/pre-execute', ralphExec(), allow)
    expect(ralphCall.kind).toBe('deny')
    expect(reached).toBe(0)

    // A malformed fan-out call keeps the workflow branch's documented
    // fail-open: it names no workflow/objective, so there is nothing to refuse.
    const before = reached
    const malformed = await app.ctx.waterfall('tools/pre-execute', toolExec('workflow', { script: 'probe' }), allow)
    expect(malformed).toEqual({ kind: 'allow' })
    expect(reached).toBe(before + 1)

    // Reconciling the registration restores the fan-out surface exactly as it
    // restores a subagent dispatch.
    const handle = await openStore({ harnessDir }, 'write')
    handle.db.prepare("delete from catalog_entities where kind = 'plan' and id = 'plan-a'").run()
    handle.close()
    expect((await reconcileCatalogExecution({ harnessDir }, 'op-fanout')).recovered).toBe(true)

    const allowed = await app.ctx.waterfall('tools/pre-execute', workflowExec(), allow)
    expect(allowed).toEqual({ kind: 'allow' })
    expect(reached).toBe(before + 2)
  })

  it('a pre-activation workspace (no store at all) is never retro-refused', async () => {
    const { app, harnessDir } = await appWithRoot('store-preactivation')
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
    })
    expect(await catalogRegistrationRefusal(harnessDir, 'wf-store')).toBeNull()
    let allowed = 0
    const decision = await app.ctx.waterfall('tools/pre-execute', dispatchExec(), async () => {
      allowed += 1
      return { kind: 'allow' as const }
    })
    expect(decision.kind).toBe('allow')
    expect(allowed).toBe(1)
  })
})

/* ===========================================================================
 * 5. Execution facts stay JSON: phase/leases/status come from the snapshot
 * ========================================================================== */
describe('store cutover — the JSON execution authority still owns phase and leases', () => {
  it('phase, status and leases render from the snapshot even while the store is unavailable', async () => {
    const { app, harnessDir } = await appWithRoot('store-json-authority')
    const worktreePath = join(harnessDir, '..', 'wt')
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': v2Snapshot('wf-store', {
        type: 'iteration',
        status: 'paused',
        plans: [{
          id: 'plan-a',
          title: 'Plan a',
          file: 'plans/plan-a.md',
          status: 'InProgress',
          progress: '3/5 tasks',
          execution_lease: {
            holder: 'dsh:session-1',
            claimed_at: '2026-09-19',
            worktree_path: worktreePath,
            working_branch: 'feature/store-cutover',
          },
        }],
        branch: { base: 'dev', target: 'main' },
        execution_policy: { push_policy: 'no-push', worktree_mode: 'feature-worktree' },
      }),
    })

    const state = buildCatalogPayload(app.ctx, harnessDir).state
    expect(state).not.toBeNull()
    if (state === null) return
    // The JSON author's facts, verbatim — and NOT sourced from the projection.
    expect(state.selection).toEqual({ kind: 'active', workflowId: 'wf-store', dir: 'workflows/wf-store' })
    expect(state.workflowType).toBe('iteration')
    expect(state.workflowStatus).toBe('paused')
    expect(state.plans).toEqual([{ id: 'plan-a', status: 'InProgress', doneAt: null, iterationRefs: [] }])
    expect(state.leases).toEqual([{ planId: 'plan-a', holder: 'dsh:session-1', worktreePath }])
    expect(state.iterationBaseBranch).toBe('dev')
    expect(state.targetBranch).toBe('main')
    expect(state.pushPolicy).toBe('no-push')
    // The store is missing here, which is disclosed — and it did NOT touch the
    // JSON-sourced rows above.
    expect(state.storeFacts?.kind).toBe('unavailable')
  })

  it('never recreates the retired register: a residual written to disk is invisible to the host', async () => {
    const { app, harnessDir } = await storeApp()
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': JSON.stringify({
        entries: { 'plan-a': [{ id: 'R9', title: 'legacy register row', severity: 'critical', source_plan: 'plan-a', registered_at: '2026-09-01' }] },
      }),
    })

    const state = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    expect(state?.residuals).toEqual([])
    expect(state?.residualFindings).toEqual([])
    // A legacy register can never gate a plan again: the plan has no open issue.
    const gate = await validateStatusValue(cleanupSnapshot('plan-a'), 'snapshot', harnessDir)
    expect(gate.ok).toBe(true)
  })
})

/* ===========================================================================
 * 6. The store-authority refusal class (G4b, plan QC fix wave FW-1): the
 *    fs-intent listener and the status-write adapter refuse the authority
 *    bytes in BOTH enforcement modes — an authority invariant, never a
 *    document judgment, and never the repair escape.
 * ========================================================================== */

describe('store authority — fs-intent and adapter refuse authority bytes (FW-1)', () => {
  /**
   * Seal a freshly seeded store for readers (the G2a pattern): one read
   * open+close so later reads do not hit the documented bun-test open flake
   * (a read right after the writer closes can surface `store.corrupt` /
   * `store.busy` — which the authority route correctly treats as
   * fail-closed `store.authority-unavailable`).
   */
  async function sealStoreForReaders(harnessDir: string): Promise<void> {
    const handle = await openStore({ harnessDir }, 'read')
    handle.close()
  }

  /** FsTarget for the authority database / a WAL sidecar at the harness root. */
  const storeTarget = (harnessDir: string, suffix = ''): FsTarget => {
    const path = join(harnessDir, `store.db${suffix}`)
    return { targetKey: path as FsTarget['targetKey'], displayPath: path }
  }
  /** FsTarget for a project register under the harness root. */
  const registerTarget = (harnessDir: string): FsTarget => {
    const path = join(harnessDir, 'projects', '_default', 'residuals.json')
    return { targetKey: path as FsTarget['targetKey'], displayPath: path }
  }

  it('a hand write of store.db is VETOED with store.direct-write-refused in WARN mode too (unconditional)', async () => {
    const { app, harnessDir } = await storeApp()
    await sealStoreForReaders(harnessDir)
    // The register seed completes the harness-root markers (status.json +
    // workflows/ + projects/) the authority classification requires.
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })
    const advisories = captureStatusAdvisories(app.ctx)
    let reached = 0

    const outcome = await app.ctx
      .waterfall('fs/write-intent', storeTarget(harnessDir), {}, async () => {
        reached += 1
        return { kind: 'createIfAbsent' as const }
      })
      .then(() => undefined, (error: unknown) => error)

    expect(outcome).toBeInstanceOf(StatusVetoError)
    expect((outcome as StatusVetoError).violations.map((violation) => violation.code)).toEqual(['store.direct-write-refused'])
    expect(reached).toBe(0) // the veto is never delegated: the write cannot land
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(false) // warn mode — the veto is NOT the enforcement axis
    expect(advisories[0]!.repair).toBeUndefined()
    expect(advisories[0]!.degraded).toBeUndefined()
    expect(advisories[0]!.result.violations.map((violation) => violation.code)).toEqual(['store.direct-write-refused'])
  })

  it('a hand write of store.db is vetoed under hard enforcement as well, and the WAL sidecars too', async () => {
    const { app, harnessDir } = await storeApp('hard')
    await sealStoreForReaders(harnessDir)
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })
    for (const suffix of ['', '-wal', '-shm']) {
      const outcome = await app.ctx
        .waterfall('fs/write-intent', storeTarget(harnessDir, suffix), {}, async () => ({ kind: 'createIfAbsent' as const }))
        .then(() => undefined, (error: unknown) => error)
      expect(outcome, suffix).toBeInstanceOf(StatusVetoError)
      expect((outcome as StatusVetoError).violations.map((violation) => violation.code)).toEqual(['store.direct-write-refused'])
    }
  })

  it('a register write while the store is ACTIVE is vetoed with project.register.retired in WARN mode too', async () => {
    const { app, harnessDir } = await storeApp()
    await sealStoreForReaders(harnessDir)
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })
    const advisories = captureStatusAdvisories(app.ctx)

    const outcome = await app.ctx
      .waterfall('fs/write-intent', registerTarget(harnessDir), {}, async () => ({ kind: 'createIfAbsent' as const }))
      .then(() => undefined, (error: unknown) => error)

    expect(outcome).toBeInstanceOf(StatusVetoError)
    expect((outcome as StatusVetoError).violations.map((violation) => violation.code)).toEqual(['project.register.retired'])
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.result.violations.map((violation) => violation.code)).toEqual(['project.register.retired'])
  })

  it('a register write while the authority is UNREADABLE is vetoed with store.authority-unavailable (fail-closed)', async () => {
    const { app, harnessDir } = await storeApp()
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })
    await corruptStore(harnessDir)

    const outcome = await app.ctx
      .waterfall('fs/write-intent', registerTarget(harnessDir), {}, async () => ({ kind: 'createIfAbsent' as const }))
      .then(() => undefined, (error: unknown) => error)

    expect(outcome).toBeInstanceOf(StatusVetoError)
    const refusal = (outcome as StatusVetoError).violations[0]!
    expect(refusal.code).toBe('store.authority-unavailable')
    expect(refusal.message).toContain('store.corrupt')
  })

  it('a register write in a PRE-ACTIVATION workspace keeps the legacy document route (no refusal)', async () => {
    const { app, harnessDir } = await appWithRoot('store-authority-legacy')
    // Contract §7: no store / a staged store leaves the register the live
    // findings authority — the write falls through to its document validator
    // (the shape-valid register below passes silently).
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })
    const advisories = captureStatusAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', registerTarget(harnessDir), {}, async () => ({ kind: 'createIfAbsent' as const }))

    expect(intent).toEqual({ kind: 'createIfAbsent' }) // delegated: the legacy authority still owns the register
    expect(advisories).toHaveLength(0)
  })

  it('the host hook refuses the same class: beforeStatusWrite maps the authority refusals to a structured code', async () => {
    const { app, harnessDir } = await storeApp()
    await sealStoreForReaders(harnessDir)
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })

    const storeWrite = await app.ctx.dshHostAdapter.beforeStatusWrite(join(harnessDir, 'store.db'), undefined)
    expect(storeWrite.ok).toBe(false)
    expect(storeWrite.code).toBe('store.direct-write-refused')

    const registerWrite = await app.ctx.dshHostAdapter.beforeStatusWrite(join(harnessDir, 'projects', '_default', 'residuals.json'), undefined)
    expect(registerWrite.ok).toBe(false)
    expect(registerWrite.code).toBe('project.register.retired')

    // A non-authority, non-coordination target keeps passing the hook.
    const other = await app.ctx.dshHostAdapter.beforeStatusWrite(join(harnessDir, 'other.json'), undefined)
    expect(other.ok).toBe(true)
  })

  it('a pre-activation workspace keeps the hook register validation (legacy authority)', async () => {
    const { app, harnessDir } = await appWithRoot('store-authority-hook-legacy')
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })

    const hook = await app.ctx.dshHostAdapter.beforeStatusWrite(
      join(harnessDir, 'projects', '_default', 'residuals.json'),
      JSON.parse(v2Register({})) as Record<string, unknown>,
    )
    expect(hook.ok).toBe(true)
    expect(hook.code).toBe('host.beforeStatusWrite.ok')
  })

  it('a CASE-VARIANT store.db basename (Store.db) is vetoed like the file itself (FW-3)', async () => {
    const { app, harnessDir } = await storeApp()
    await sealStoreForReaders(harnessDir)
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })
    const advisories = captureStatusAdvisories(app.ctx)

    // On a case-insensitive volume (Darwin/APFS) this write lands on the
    // authority database itself; the folded basename match refuses it on a
    // case-sensitive volume too (the authority name is volume-invariant).
    const path = join(harnessDir, 'Store.db')
    const outcome = await app.ctx
      .waterfall('fs/write-intent', { targetKey: path as FsTarget['targetKey'], displayPath: path }, {}, async () => ({ kind: 'createIfAbsent' as const }))
      .then(() => undefined, (error: unknown) => error)

    expect(outcome).toBeInstanceOf(StatusVetoError)
    expect((outcome as StatusVetoError).violations.map((violation) => violation.code)).toEqual(['store.direct-write-refused'])
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((violation) => violation.code)).toEqual(['store.direct-write-refused'])

    // The status-write adapter refuses the same case-variant target.
    const hook = await app.ctx.dshHostAdapter.beforeStatusWrite(path, undefined)
    expect(hook.ok).toBe(false)
    expect(hook.code).toBe('store.direct-write-refused')
  })

  it('a CASE-VARIANT register (RESIDUALS.json) takes the authority route (FW-3)', async () => {
    const { app, harnessDir } = await storeApp()
    await sealStoreForReaders(harnessDir)
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })

    const path = join(harnessDir, 'projects', '_default', 'RESIDUALS.json')
    const outcome = await app.ctx
      .waterfall('fs/write-intent', { targetKey: path as FsTarget['targetKey'], displayPath: path }, {}, async () => ({ kind: 'createIfAbsent' as const }))
      .then(() => undefined, (error: unknown) => error)

    expect(outcome).toBeInstanceOf(StatusVetoError)
    expect((outcome as StatusVetoError).violations.map((violation) => violation.code)).toEqual(['project.register.retired'])

    const hook = await app.ctx.dshHostAdapter.beforeStatusWrite(path, undefined)
    expect(hook.ok).toBe(false)
    expect(hook.code).toBe('project.register.retired')
  })

  it('a pre-activation register whose alias lands on an ACTIVE harness register is vetoed (stricter-wins, RV-2)', async () => {
    const { app, harnessDir } = await appWithRoot('store-authority-cross-legacy')
    // The DESTINATION harness: marker-complete, ACTIVE store, real register.
    const destHarness = join(dirname(harnessDir), 'dest-workspace', '.mstar')
    await seedHarness(destHarness, {
      'status.json': v2Root([]),
      'workflows/.keep': '',
      'projects/_default/residuals.json': v2Register({}),
    })
    await seedStore(destHarness)
    await sealStoreForReaders(destHarness)
    // The SOURCE harness (the app's own, pre-activation): its register is a
    // symlink to the destination's register — a write lands there with only
    // the source authority checked, so the landed context must veto.
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
    })
    await mkdir(join(harnessDir, 'projects', '_default'), { recursive: true })
    const sourceRegister = join(harnessDir, 'projects', '_default', 'residuals.json')
    await symlink(join(destHarness, 'projects', '_default', 'residuals.json'), sourceRegister)

    const outcome = await app.ctx
      .waterfall('fs/write-intent', registerTarget(harnessDir), {}, async () => ({ kind: 'createIfAbsent' as const }))
      .then(() => undefined, (error: unknown) => error)
    expect(outcome).toBeInstanceOf(StatusVetoError)
    expect((outcome as StatusVetoError).violations.map((violation) => violation.code)).toEqual(['project.register.retired'])

    const hook = await app.ctx.dshHostAdapter.beforeStatusWrite(sourceRegister, undefined)
    expect(hook.ok).toBe(false)
    expect(hook.code).toBe('project.register.retired')
  })

  it('a pre-activation register whose alias lands on ANOTHER pre-activation register keeps the legacy route (RV-2)', async () => {
    const { app, harnessDir } = await appWithRoot('store-authority-cross-legacy-both')
    // Both contexts pre-activation (issue contract §7): the landed register
    // keeps its document validator — no authority veto on either side.
    const destHarness = join(dirname(harnessDir), 'dest-workspace', '.mstar')
    await seedHarness(destHarness, {
      'status.json': v2Root([]),
      'workflows/.keep': '',
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
    })
    await mkdir(join(harnessDir, 'projects', '_default'), { recursive: true })
    const sourceRegister = join(harnessDir, 'projects', '_default', 'residuals.json')
    await symlink(join(destHarness, 'projects', '_default', 'residuals.json'), sourceRegister)
    const advisories = captureStatusAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', registerTarget(harnessDir), {}, async () => ({ kind: 'createIfAbsent' as const }))
    expect(intent).toEqual({ kind: 'createIfAbsent' })
    expect(advisories).toHaveLength(0)

    const hook = await app.ctx.dshHostAdapter.beforeStatusWrite(sourceRegister, JSON.parse(v2Register({})) as Record<string, unknown>)
    expect(hook.ok).toBe(true)
    expect(hook.code).toBe('host.beforeStatusWrite.ok')
  })

  it('a fresh authority write through a SYMLINKED PARENT is refused by the landed classification (S-G4b-03)', async () => {
    const { app, harnessDir } = await appWithRoot('store-authority-fresh-parent')
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-store')]),
      'workflows/wf-store/snapshot.json': cleanupSnapshotJson('plan-a'),
      'projects/_default/residuals.json': v2Register({ 'plan-a': [v2ResidualEntry('R1', { severity: 'low', source_plan: 'plan-a' })] }),
    })
    // The final component is simply ABSENT: realpath fails and the target is
    // not itself a link, but an ANCESTOR directory is a symlink INTO the
    // harness tree — the filesystem lands the write at the protected
    // destination, so the landed classification must canonicalize the nearest
    // existing ancestor instead of trusting the textual path. The store is
    // seeded AFTER the fresh store.db case below, so that target is genuinely
    // absent when it runs.
    const outside = join(dirname(harnessDir), 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(harnessDir, join(outside, 'link'))

    const freshStore = join(outside, 'link', 'store.db')
    const outcome = await app.ctx
      .waterfall('fs/write-intent', { targetKey: freshStore as FsTarget['targetKey'], displayPath: freshStore }, {}, async () => ({ kind: 'createIfAbsent' as const }))
      .then(() => undefined, (error: unknown) => error)
    expect(outcome).toBeInstanceOf(StatusVetoError)
    expect((outcome as StatusVetoError).violations.map((violation) => violation.code)).toEqual(['store.direct-write-refused'])
    const storeHook = await app.ctx.dshHostAdapter.beforeStatusWrite(freshStore, undefined)
    expect(storeHook.ok).toBe(false)
    expect(storeHook.code).toBe('store.direct-write-refused')

    // A case-variant register name under the symlinked parent takes the same
    // landed route (the folded shape walk runs on the canonicalized path); an
    // ACTIVE store makes the landed route retire the register.
    await seedStore(harnessDir)
    await sealStoreForReaders(harnessDir)
    const caseVariant = join(outside, 'link', 'projects', '_default', 'RESIDUALS.json')
    const register = await app.ctx
      .waterfall('fs/write-intent', { targetKey: caseVariant as FsTarget['targetKey'], displayPath: caseVariant }, {}, async () => ({ kind: 'createIfAbsent' as const }))
      .then(() => undefined, (error: unknown) => error)
    expect(register).toBeInstanceOf(StatusVetoError)
    expect((register as StatusVetoError).violations.map((violation) => violation.code)).toEqual(['project.register.retired'])

    // The shape the textual probes CANNOT see: the link points INTO the
    // harness at a non-root directory, so no harness marker is stat-reachable
    // on the textual path — only the canonicalized landed path classifies.
    // The linked project dir holds no register file, so the target is absent.
    await mkdir(join(harnessDir, 'projects', 'other'), { recursive: true })
    await symlink(join(harnessDir, 'projects', 'other'), join(outside, 'into-link'))
    const into = join(outside, 'into-link', 'residuals.json')
    const intoOutcome = await app.ctx
      .waterfall('fs/write-intent', { targetKey: into as FsTarget['targetKey'], displayPath: into }, {}, async () => ({ kind: 'createIfAbsent' as const }))
      .then(() => undefined, (error: unknown) => error)
    expect(intoOutcome).toBeInstanceOf(StatusVetoError)
    expect((intoOutcome as StatusVetoError).violations.map((violation) => violation.code)).toEqual(['project.register.retired'])

    // A plain fresh file with NO symlinked ancestor keeps the legacy pass —
    // the walk only canonicalizes when an ancestor actually exists.
    const advisories = captureStatusAdvisories(app.ctx)
    const plain = join(outside, 'fresh.db')
    const intent = await app.ctx
      .waterfall('fs/write-intent', { targetKey: plain as FsTarget['targetKey'], displayPath: plain }, {}, async () => ({ kind: 'createIfAbsent' as const }))
    expect(intent).toEqual({ kind: 'createIfAbsent' })
    expect(advisories).toHaveLength(0)
  })
})
