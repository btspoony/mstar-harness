/**
 * Task 5 (#530) — the durable execution binding's clear path after the
 * slash command that hosted it was removed.
 *
 * `clearExecutionSessionBinding` is the validation/adoption internals the
 * native `mstar_execution_clear` tool wraps (native-commands.spec.ts drives
 * the tool end-to-end); these cases pin the internals against the REAL
 * execution authority (a temporary store built by the engine's own producers
 * plus one coordinator bind), never a stub.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindExecutionSession,
  decodeExecutionSessionRef,
  encodeExecutionSessionRef,
  createExecutionWorkflow,
  readExecutionState,
  initializeStore,
  registerCatalogEntity,
} from '@mstar-harness/engine'
import type { ExecutionCaller, ExecutionContext } from '@mstar-harness/engine'
import { clearExecutionSessionBinding } from '../src/gates/execution-session.ts'
import { adoptExecutionBinding } from '../src/gates/workflow-selection.ts'
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { WorkflowSessionBinding } from '../src/engine-status-store.ts'

const TS = '2026-09-21T00:00:00.000Z'
const SESSION_ID = 'session-native'
const WORKFLOW_ID = 'wf-native'
const PLAN_ID = 'plan-native'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-${prefix}-`))
  roots.push(root)
  return root
}

/**
 * The stored control record, narrowed through the read's OWN discriminant
 * (`unavailable` carries a reason instead of a binding).
 */
function storedBinding(harnessDir: string, cwd: string): WorkflowSessionBinding | undefined {
  const read = readWorkflowSessionBinding(harnessDir, SESSION_ID, cwd)
  return read.kind === 'ok' ? read.binding : undefined
}

/**
 * The REAL execution authority: a temporary store, one registered catalog plan,
 * one created lifecycle whose CREATING identity is the native session, and that
 * identity bound as the workflow's coordinator session. Returns the canonical
 * engine reference the bind minted (the only thing an adoption ever accepts).
 */
async function seedNativeAuthority(harnessDir: string): Promise<string> {
  const handle = await initializeStore({ harnessDir })
  handle.close()
  const rootToken = (await readExecutionState({ harnessDir })).token
  await registerCatalogEntity(
    { harnessDir },
    { kind: 'plan', id: PLAN_ID, title: `${PLAN_ID} title`, rootKind: 'plans', relativePath: `plans/${PLAN_ID}.md` },
    { operationId: `register-${PLAN_ID}`, actor: 'execution-session.spec' },
  )
  const created = await createExecutionWorkflow(
    {
      harnessDir,
      caller: { sessionId: SESSION_ID, role: 'coordinator', workflowId: WORKFLOW_ID } satisfies ExecutionCaller,
    } satisfies ExecutionContext,
    {
      entry: { id: WORKFLOW_ID, type: 'plan', started_at: TS, dir: `workflows/${WORKFLOW_ID}` },
      snapshot: {
        schema_version: 1,
        id: WORKFLOW_ID,
        type: 'plan',
        status: 'running',
        started_at: TS,
        updated_at: TS,
        plans: [{ id: PLAN_ID, title: `${PLAN_ID} title`, file: `plans/${PLAN_ID}.md`, status: 'Todo' }],
        delivery_kind: 'development',
        branch: { source: `feature/${WORKFLOW_ID}`, target: 'main' },
      } as never,
      expected: rootToken,
      operationId: `create-${WORKFLOW_ID}`,
    },
  )
  const workflowToken = created.data.workflows[0]?.workflowToken
  if (workflowToken === undefined) throw new Error('the created lifecycle carries no workflow token')
  const bound = await bindExecutionSession(
    {
      harnessDir,
      caller: { sessionId: SESSION_ID, role: 'coordinator', workflowId: WORKFLOW_ID } satisfies ExecutionCaller,
    } satisfies ExecutionContext,
    { workflowId: WORKFLOW_ID, expected: workflowToken, operationId: `bind-${WORKFLOW_ID}` },
  )
  return encodeExecutionSessionRef(bound.data)
}

describe('execution binding clear internals — canonical clear', () => {
  it('clears the adopted binding while preserving the selection and the exclusion floor, then reports nothing to clear', async () => {
    const root = await tempRoot('exec-clear')
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const ref = await seedNativeAuthority(harnessDir)
    const parsed = decodeExecutionSessionRef(ref)
    // A pre-existing durable selection + exclusion floor (the picker's facts)
    // and the canonical C1 adoption the native bind path performs.
    expect(updateSelection(harnessDir, root, WORKFLOW_ID, 7)).toBe(true)
    expect(adoptExecutionBinding(
      harnessDir,
      SESSION_ID,
      root,
      { version: 1, harnessRoot: harnessDir, session: parsed },
      { storeId: parsed.storeId, epoch: parsed.epoch },
    )).toBe(true)

    await expect(clearExecutionSessionBinding(harnessDir, SESSION_ID, root)).resolves.toEqual({ kind: 'cleared' })
    const cleared = storedBinding(harnessDir, root)
    expect(cleared?.executionBinding ?? null).toBeNull()
    // The user selection and floor survive the clear.
    expect(cleared?.selectedWorkflowId).toBe(WORKFLOW_ID)
    expect(cleared?.excludedBeforeSeq).toBe(7)

    // A second clear has nothing left to clear — the named no-op, not a write.
    await expect(clearExecutionSessionBinding(harnessDir, SESSION_ID, root)).resolves.toEqual({ kind: 'no-binding' })
  })

  it('reports no-binding for a session that never recorded a binding', async () => {
    const root = await tempRoot('exec-clear-fresh')
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const handle = await initializeStore({ harnessDir })
    handle.close()
    await expect(clearExecutionSessionBinding(harnessDir, SESSION_ID, root)).resolves.toEqual({ kind: 'no-binding' })
  })

  it('refuses when the durable record is not readable for this exact cwd', async () => {
    const root = await tempRoot('exec-clear-cwd')
    const harnessDir = join(root, '.mstar')
    await mkdir(harnessDir, { recursive: true })
    const ref = await seedNativeAuthority(harnessDir)
    const parsed = decodeExecutionSessionRef(ref)
    expect(adoptExecutionBinding(
      harnessDir,
      SESSION_ID,
      root,
      { version: 1, harnessRoot: harnessDir, session: parsed },
      { storeId: parsed.storeId, epoch: parsed.epoch },
    )).toBe(true)
    // A different cwd must never clear (or even read as "no pick") a record
    // another cwd holds — the store's own cwd-mismatch refusal surfaces.
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    await expect(clearExecutionSessionBinding(harnessDir, SESSION_ID, elsewhere)).resolves.toEqual({
      kind: 'refused',
      reason: 'cwd-mismatch',
    })
    // The adopted binding is untouched by the refused attempt.
    expect(storedBinding(harnessDir, root)?.executionBinding?.session).toEqual(parsed)
  })
})

/** The picker's durable selection + exclusion floor, written through the store. */
function updateSelection(harnessDir: string, cwd: string, workflowId: string, excludedBeforeSeq: number): boolean {
  return updateWorkflowSessionBinding(harnessDir, SESSION_ID, cwd, {
    selectedWorkflowId: workflowId,
    excludedBeforeSeq,
  }).kind === 'written'
}
