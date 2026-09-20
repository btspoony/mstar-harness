/**
 * execution-read.spec.ts — §5 source readiness of the dsh host (plan S4).
 *
 * The dsh gates select the lifecycle their verdict is about from the root
 * `status.json` registry and the workflow snapshots. While the control
 * harness's EXECUTION authority is ACTIVE both documents are retired as a
 * source, so the selection has to come from the DB adapter
 * (`readExecutionWorkflowSource` → `readExecutionAuthority`) with explicit
 * identities — never a newest/only guess and never a fallback to the retired
 * bytes — and a write to a retired coordination document has to be refused
 * unconditionally (canonical path and symlink alias alike).
 *
 * Every case runs against the REAL engine: a real `node:sqlite` database
 * created by `initializeStore` / `initializeExecutionAuthority`, real catalog
 * rows through `registerCatalogEntity`, the workflow through
 * `createExecutionWorkflow`, and the real dsh readers/gates. Nothing is
 * mocked and no fixture echoes a canned reader result.
 */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  createExecutionWorkflow,
  initializeExecutionAuthority,
  initializeStore,
  registerCatalogEntity,
} from '@mstar-harness/engine'
import type { ExecutionCaller, ExecutionContext } from '@mstar-harness/engine'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { buildCatalogPayloadWithStore } from '../src/gates/catalog.ts'
import { EXECUTION_DIRECT_WRITE_CODE, storeAuthorityRefusals } from '../src/gates/store-authority.ts'
import { activeRowsOf, readExecutionWorkflowSource } from '../src/gates/workflow-selection.ts'
import { bootApp, seedHarness, v2Root, v2SnapshotWithPlans, v2WorkflowEntry, type BootResult } from './harness.ts'

let booted: BootResult | undefined
const roots: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const TS = '2026-09-21T00:00:00.000Z'

/** One booted app on a fresh workspace root (no store written yet). */
async function appWithRoot(name: string): Promise<{ app: BootResult; harnessDir: string }> {
  const root = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  roots.push(root)
  const app = booted = await bootApp({ root })
  return { app, harnessDir: app.harnessDir }
}

/** A fresh temp dir usable as a worktree path (the cwd binding rung compares
 * real paths, so the fixture path must exist). */
async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${label}-`))
  roots.push(dir)
  return dir
}

interface WorkflowSpec {
  readonly id: string
  readonly planId: string
  readonly planStatus?: string
  readonly integrationWorktreePath?: string
}

/**
 * REAL ACTIVE EXECUTION authority (primary spec §3/§4.3) with one or more
 * registered lifecycles: the create-only empty-execution initializer, each
 * lifecycle's catalog plan row, and the workflow that holds it — all through
 * the engine's own producers. Each `createExecutionWorkflow` consumes the
 * PREVIOUS receipt's root token, so a second lifecycle also proves the fixture
 * walked the registry revisions rather than guessing one.
 */
async function seedExecutionAuthority(harnessDir: string, workflows: readonly WorkflowSpec[]): Promise<void> {
  const handle = await initializeStore({ harnessDir })
  handle.close()
  let token = (await initializeExecutionAuthority({ harnessDir })).token
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
      { operationId: `register-${workflow.planId}`, actor: 'project-manager' },
    )
    const context: ExecutionContext = {
      harnessDir,
      caller: {
        sessionId: `host-${workflow.id}`,
        role: 'coordinator',
        workflowId: workflow.id,
        planId: null,
      } satisfies ExecutionCaller,
    }
    const receipt = await createExecutionWorkflow(context, {
      entry: { id: workflow.id, type: 'plan', started_at: TS, dir: `workflows/${workflow.id}` },
      snapshot: {
        schema_version: 1,
        id: workflow.id,
        type: 'plan',
        status: 'running',
        started_at: TS,
        updated_at: TS,
        plans: [
          {
            id: workflow.planId,
            title: `${workflow.planId} title`,
            file: `plans/${workflow.planId}.md`,
            status: workflow.planStatus ?? 'Todo',
          },
        ],
        delivery_kind: 'development',
        ...(workflow.integrationWorktreePath !== undefined
          ? { integration_worktree_path: workflow.integrationWorktreePath }
          : {}),
        branch: { source: `feature/${workflow.id}`, target: 'main' },
      } as never,
      expected: token,
      operationId: `create-${workflow.id}`,
    })
    token = receipt.token
  }
}

/** The retired files a real cutover leaves behind: a root `status.json` naming
 * a lifecycle the DB does not hold, plus that lifecycle's snapshot and plan
 * row. Seeded AFTER the authority is active (the initializer refuses a harness
 * that still carries live execution sources). The layout dirs make the root
 * marker-complete, which is what the engine's own document classifier needs to
 * resolve a target's harness root (the symlink-alias case). */
async function seedRetiredRegister(harnessDir: string, workflowId: string, planId: string): Promise<void> {
  await mkdir(join(harnessDir, 'projects'), { recursive: true })
  await seedHarness(harnessDir, {
    'status.json': v2Root([v2WorkflowEntry(workflowId)]),
    [`workflows/${workflowId}/snapshot.json`]: v2SnapshotWithPlans(workflowId, [
      { id: planId, title: `${planId} title`, file: `plans/${planId}.md`, status: 'InProgress' },
    ]),
  })
}

/** Unreadable authority through the REAL engine channel: a directory where the
 * database file belongs (`openStore` refuses `store.corrupt`). */
async function corruptStore(harnessDir: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) await rm(join(harnessDir, `store.db${suffix}`), { force: true })
  await mkdir(join(harnessDir, 'store.db'), { recursive: true })
}

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

describe('execution-dsh-read — the DSh source reads the authority, never the retired files (plan S4)', () => {
  it('selects the DB registry (and its plan rows) on an ACTIVE authority, ignoring the retired register', async () => {
    const { harnessDir } = await appWithRoot('execution-db-select')
    await seedExecutionAuthority(harnessDir, [{ id: 'wf-db', planId: 'plan-db' }])
    await seedRetiredRegister(harnessDir, 'wf-file-stale', 'plan-file')

    const source = await readExecutionWorkflowSource({ harnessDir })
    expect(source.kind).toBe('active')
    if (source.kind !== 'active') return
    expect(source.workflowId).toBe('wf-db')
    expect(source.dir).toBe('workflows/wf-db')
    // The materialized state is the AUTHORITY's: the DB plan row, never the
    // retired snapshot's.
    expect(activeRowsOf(source.snapshot).map((row) => row.id)).toEqual(['plan-db'])
  })

  it('carries the DB selection into the catalog state section with no file-route fallback', async () => {
    const { app, harnessDir } = await appWithRoot('execution-catalog')
    await seedExecutionAuthority(harnessDir, [{ id: 'wf-db', planId: 'plan-db', planStatus: 'InProgress' }])
    await seedRetiredRegister(harnessDir, 'wf-file-stale', 'plan-file')

    const state = (await buildCatalogPayloadWithStore(app.ctx, harnessDir)).state
    expect(state).not.toBeNull()
    if (state === null) return
    expect(state.selection).toEqual({ kind: 'active', workflowId: 'wf-db', dir: 'workflows/wf-db' })
    expect(state.plans.map((plan) => plan.id)).toEqual(['plan-db'])
    // The retired register's lifecycle never reaches the row — not as a plan
    // aggregate, not as a structured degrade.
    expect(JSON.stringify(state)).not.toContain('plan-file')
  })

  it('preserves explicit identity: the durable pick decides, and an unbound multi-active set is an error', async () => {
    const { harnessDir } = await appWithRoot('execution-identity')
    const worktree = await tempDir('execution-worktree')
    await seedExecutionAuthority(harnessDir, [
      { id: 'wf-alpha', planId: 'plan-alpha', integrationWorktreePath: worktree },
      { id: 'wf-beta', planId: 'plan-beta' },
    ])

    // Rung 1 (cwd): the lifecycle owning the integration worktree, from DB state.
    const byCwd = await readExecutionWorkflowSource({ harnessDir }, { cwd: join(worktree, 'src') })
    expect(byCwd.kind === 'active' ? byCwd.workflowId : null).toBe('wf-alpha')

    // Rung 3 (the session's durable pick): the NAMED lifecycle, never the
    // registry's first entry.
    const byPick = await readExecutionWorkflowSource({ harnessDir }, { selectedWorkflowId: 'wf-beta' })
    expect(byPick.kind === 'active' ? byPick.workflowId : null).toBe('wf-beta')

    // No binding at all: a multi-active set is refused, never narrowed by
    // position or recency.
    const unbound = await readExecutionWorkflowSource({ harnessDir })
    expect(unbound.kind).toBe('error')
    if (unbound.kind !== 'error' || unbound.selection.kind !== 'error') return
    expect(unbound.selection.code).toBe('workflow.selection.unbound-multi-active')
    expect(unbound.selection.activeWorkflowIds).toEqual(['wf-alpha', 'wf-beta'])

    // An id the authority does not hold stays NOT FOUND — the DB registry is
    // the whole active set.
    const missing = await readExecutionWorkflowSource({ harnessDir }, { selectedWorkflowId: 'wf-absent' })
    expect(missing.kind).toBe('error')
  })

  it('refuses an unreadable authority instead of falling back to the retired files', async () => {
    const { harnessDir } = await appWithRoot('execution-unreadable')
    await seedExecutionAuthority(harnessDir, [{ id: 'wf-db', planId: 'plan-db' }])
    await seedRetiredRegister(harnessDir, 'wf-file-stale', 'plan-file')
    await corruptStore(harnessDir)

    const source = await readExecutionWorkflowSource({ harnessDir })
    expect(source.kind).toBe('unavailable')
    expect(source.kind === 'unavailable' ? source.code : '').toBe('store.corrupt')

    const state = (await buildCatalogPayloadWithStore(booted!.ctx, harnessDir)).state
    expect(state?.selection.kind).toBe('error')
    expect(JSON.stringify(state)).not.toContain('wf-file-stale')
  })

  it('keeps the file route when no store exists at all', async () => {
    const { harnessDir } = await appWithRoot('execution-files')
    await seedRetiredRegister(harnessDir, 'wf-file', 'plan-file')

    expect(await readExecutionWorkflowSource({ harnessDir })).toEqual({ kind: 'files' })
  })

  it('refuses a retired coordination-document write by its canonical and symlinked paths', async () => {
    const { harnessDir } = await appWithRoot('execution-write')
    await seedExecutionAuthority(harnessDir, [{ id: 'wf-db', planId: 'plan-db' }])
    await seedRetiredRegister(harnessDir, 'wf-file-stale', 'plan-file')

    // The session's OWN classification (the status gate's answer): the root
    // register and a workflow snapshot are both retired persistence routes.
    const status = await storeAuthorityRefusals({
      resolvedHarnessDir: harnessDir,
      directKind: 'status',
      rawPath: join(harnessDir, 'status.json'),
    })
    expect(status.map((violation) => violation.code)).toEqual([EXECUTION_DIRECT_WRITE_CODE])
    expect(status[0]?.message).toContain('ACTIVE')

    const snapshot = await storeAuthorityRefusals({
      resolvedHarnessDir: harnessDir,
      directKind: 'snapshot',
      rawPath: join(harnessDir, 'workflows', 'wf-db', 'snapshot.json'),
    })
    expect(snapshot.map((violation) => violation.code)).toEqual([EXECUTION_DIRECT_WRITE_CODE])

    // A symlink alias outside the harness: the AUTHORITY decision is made on
    // the path the write really lands on (§4.3), so the alias is refused like
    // the document itself. The caller classified nothing — exactly the case
    // the landed-path probe exists for.
    const aliasDir = await tempDir('execution-alias')
    const alias = join(aliasDir, 'retired-status.json')
    await symlink(join(harnessDir, 'status.json'), alias)
    const aliased = await storeAuthorityRefusals({ resolvedHarnessDir: null, directKind: null, rawPath: alias })
    expect(aliased.map((violation) => violation.code)).toEqual([EXECUTION_DIRECT_WRITE_CODE])

    // Nothing else is captured: a non-authority target keeps its document
    // validator (no refusal from this route).
    expect(
      await storeAuthorityRefusals({ resolvedHarnessDir: null, directKind: null, rawPath: join(dirname(harnessDir), 'notes.md') }),
    ).toEqual([])
  })

  it('keeps the issue-domain register route, and refuses fail-closed when the authority cannot be read', async () => {
    const { harnessDir } = await appWithRoot('execution-register')
    await seedExecutionAuthority(harnessDir, [{ id: 'wf-db', planId: 'plan-db' }])

    const register = await storeAuthorityRefusals({
      resolvedHarnessDir: harnessDir,
      directKind: 'register',
      rawPath: join(harnessDir, 'projects', '_default', 'residuals.json'),
    })
    expect(register.map((violation) => violation.code)).toEqual(['project.register.retired'])

    await corruptStore(harnessDir)
    const unreadable = await storeAuthorityRefusals({
      resolvedHarnessDir: harnessDir,
      directKind: 'status',
      rawPath: join(harnessDir, 'status.json'),
    })
    expect(unreadable.map((violation) => violation.code)).toEqual(['store.authority-unavailable'])
    expect(unreadable[0]?.message).toContain('execution authority')
  })

  it('refuses a dispatch launch when the authority cannot be read, and allows it when the DB lifecycle is registered', async () => {
    const { app, harnessDir } = await appWithRoot('execution-dispatch')
    await seedExecutionAuthority(harnessDir, [{ id: 'wf-db', planId: 'plan-db' }])
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-file-stale')]),
      'workflows/wf-file-stale/snapshot.json': v2SnapshotWithPlans('wf-file-stale', [
        { id: 'plan-file', title: 'plan-file title', file: 'plans/plan-file.md', status: 'InProgress' },
      ]),
    })

    // The DB lifecycle is registered, so the launch is allowed — and it was
    // decided from the DB registry: the retired register names a lifecycle the
    // authority does not hold at all.
    let reached = 0
    const allowed = await app.ctx.waterfall('tools/pre-execute', dispatchExec(), async () => {
      reached += 1
      return { kind: 'allow' as const }
    })
    expect(allowed.kind).toBe('allow')
    expect(reached).toBe(1)

    // §5 fail-closed: with the authority unreadable the registration verdict
    // cannot be established, so the launch is refused instead of proceeding
    // against a half-known workspace. (The retired file route would have
    // allowed it — this is the refusal the S4 route adds.)
    await corruptStore(harnessDir)
    const refused = await app.ctx.waterfall('tools/pre-execute', dispatchExec(), async () => {
      reached += 1
      return { kind: 'allow' as const }
    })
    expect(refused.kind).toBe('deny')
    expect(refused.kind === 'deny' ? refused.reason : '').toContain('store.corrupt')
    expect(reached).toBe(1)
  })

  it('supports the pre-activation file route unchanged (no store, register write keeps its validator)', async () => {
    const { harnessDir } = await appWithRoot('execution-pre-activation')
    await seedRetiredRegister(harnessDir, 'wf-file', 'plan-file')

    // No store: the register is still the live findings authority, so the
    // authority route returns no refusal and the document validator decides.
    expect(
      await storeAuthorityRefusals({
        resolvedHarnessDir: harnessDir,
        directKind: 'register',
        rawPath: join(harnessDir, 'projects', '_default', 'residuals.json'),
      }),
    ).toEqual([])
    // …and the root register write is not captured either.
    expect(
      await storeAuthorityRefusals({
        resolvedHarnessDir: harnessDir,
        directKind: 'status',
        rawPath: join(harnessDir, 'status.json'),
      }),
    ).toEqual([])
  })
})
