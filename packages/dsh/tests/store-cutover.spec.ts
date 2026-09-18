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
import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildCatalogPayload, buildCatalogPayloadWithStore } from '../src/gates/catalog.ts'
import { catalogRegistrationRefusal, resolveActiveWorkflow } from '../src/gates/workflow-selection.ts'
import { validateStatusValue } from '../src/gates/status.ts'
import { bootApp, seedHarness, seedKnowledgeDoc, seedOpenIssue, seedStore, v2Root, v2Snapshot, v2SnapshotWithPlans, v2WorkflowEntry, type BootResult } from './harness.ts'

let booted: BootResult | undefined
const roots: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  setArtifactStore(undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** One booted app on a fresh workspace root (no store written yet). */
async function appWithRoot(name: string): Promise<{ app: BootResult; harnessDir: string }> {
  const root = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  roots.push(root)
  const app = booted = await bootApp({ root })
  return { app, harnessDir: app.harnessDir }
}

/** A booted app plus an ACTIVE empty store at its harness dir. */
async function storeApp(): Promise<{ app: BootResult; harnessDir: string }> {
  const { app, harnessDir } = await appWithRoot('store-cutover')
  await seedStore(harnessDir)
  return { app, harnessDir }
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

/** The Assignment-shaped dispatch call the `tools/pre-execute` gate sees. */
let execSeq = 0
function dispatchExec(): ToolExecution {
  return {
    callId: `c${++execSeq}`,
    name: 'subagent',
    arguments: {
      description: 'writable implement round',
      prompt: ['## Assignment', '**Execute as**: fullstack-dev', '**Task category**: logic', '**Execution mode**: sdd', '', 'Implement the thing.'].join('\n'),
    },
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
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
    for (const suffix of ['', '-wal', '-shm']) await unlink(join(harnessDir, `store.db${suffix}`)).catch(() => {})
    await mkdir(join(harnessDir, 'store.db'), { recursive: true })

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
    await registerCatalogEntity({ harnessDir }, {
      kind: 'plan',
      id: 'plan-a',
      title: 'Conflicting registration',
      rootKind: 'plans',
      relativePath: 'elsewhere.md',
    }, { operationId: 'seed-conflict', actor: 'project-manager' })
    setArtifactStore(createFsStore(harnessDir))
    await expect(registerShippedCatalogExecution({ harnessDir }, planRegistration(harnessDir, 'op-reg'))).rejects.toThrow(
      /catalog\.duplicate/,
    )

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
