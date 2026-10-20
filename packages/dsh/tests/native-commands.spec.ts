/**
 * The dsh native tool surface after the duplicate-command removal — exactly one
 * tool, `mstar_execution_clear`.
 *
 * Fourteen mstar commands used to be registered here and in `gates/tools.ts` as
 * dsh tools, each duplicating an MCP tool of the SAME name 1:1 (two identical
 * model-facing surfaces, ~10k characters of fixed context per request). The
 * scoped MCP mount is the writable command surface on this host and covers all
 * of them, so those tools are gone and this suite pins their ABSENCE beside the
 * surviving tool's contract: identity from `exec.agent.id` (never model-supplied),
 * the fail-closed leaf-seat guard, and the named refusals with their
 * `data.recordedCwd` fact.
 *
 * Every case boots the REAL-composition harness (the same plugin the dsh app
 * loads) and drives the tool through the REAL registry, while the execution
 * authority is a SYNTHETIC store fixture built by the engine's own producers
 * (initializeStore → catalog registration → createExecutionWorkflow →
 * bindExecutionSession, the `execution-session.spec.ts` idiom) — the real
 * control-root store in `.mstar/` is never touched.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  bindExecutionSession,
  createExecutionWorkflow,
  decodeExecutionSessionRef,
  encodeExecutionSessionRef,
  initializeStore,
  readExecutionState,
  registerCatalogEntity,
} from '@mstar-harness/engine'
import type { ExecutionCaller, ExecutionContext, ExecutionSessionRef } from '@mstar-harness/engine'
import { adoptExecutionBinding, resolveExecutionLedgerTarget } from '../src/gates/workflow-selection.ts'
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { WorkflowSessionBinding } from '../src/engine-status-store.ts'
import { bootApp, type BootResult } from './harness.ts'

const TS = '2026-09-21T00:00:00.000Z'
const WORKFLOW_ID = 'wf-native-surface'
const PLAN_ID = 'plan-native-surface'
const PARENT_ID = 'session-native-parent'
const CHILD_ID = 'session-native-child'
const CLEAR_TOOL = 'mstar_execution_clear'

/**
 * The fourteen tools this change removed: the seven writable commands (now MCP
 * `mstar_plan` / `mstar_workflow` / `mstar_issue` actions, one tool per family)
 * and the seven read-only mirrors (now `mstar_sdd` / `mstar_iteration` /
 * `mstar_design_md` / `mstar_audit` / `mstar_compound` / `mstar_roles`).
 */
const REMOVED_TOOLS = [
  'mstar_plan_bind',
  'mstar_plan_prepare',
  'mstar_plan_progress',
  'mstar_plan_complete',
  'mstar_workflow_register',
  'mstar_issue_add',
  'mstar_issue_close',
  'mstar_sdd_workspace',
  'mstar_sdd_task_brief',
  'mstar_iteration_gate',
  'mstar_design_md_validate',
  'mstar_audit_validate',
  'mstar_compound_validate',
  'mstar_roles_validate',
] as const

let booted: BootResult | undefined
const roots: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const callId = 'native-commands.spec' as ToolCallId
const signal = new AbortController().signal

/** The caller identity the tool must observe: `exec.agent.id` IS the session id (ADR constraint 1). Extra header facts (leaf markers) ride `session.header` unchanged. */
function agentOf(id: string, cwd: string, header: Record<string, unknown> = {}): unknown {
  return { id, session: { id, header: { id, cwd, ...header } } }
}

/** Run one tool call through the composed registry as one specific agent. */
function run(ctx: BootResult['ctx'], name: string, agent: unknown, args: Record<string, unknown>) {
  return ctx.tools.execute({ callId, name, arguments: args, agent: agent as never, signal })
}

/** Narrow one successful tool result to its canonical value (the command envelope). */
function envelopeOf(result: Awaited<ReturnType<BootResult['ctx']['tools']['execute']>>): Record<string, unknown> {
  if (result.isError) throw new Error(`tool call failed: ${result.error?.message ?? 'unknown error'}`)
  return result.value as Record<string, unknown>
}

/** The refusal recovery text the envelope carries under `details`. */
function recoveryOf(envelope: Record<string, unknown>): string {
  return String((envelope.details as { recovery?: string } | undefined)?.recovery ?? '')
}

/** The session's stored binding slot, narrowed through the read's own discriminant. */
function storedBinding(harnessDir: string, cwd: string, sessionId = CHILD_ID): WorkflowSessionBinding | undefined {
  const read = readWorkflowSessionBinding(harnessDir, sessionId, cwd)
  if (read.kind !== 'ok') throw new Error(`the binding slot read failed: ${read.reason}`)
  return read.binding
}

/**
 * The REAL execution authority at `harnessDir` for `sessionId`: an initialized
 * store, one registered catalog plan, one created lifecycle whose CREATING
 * identity is that session, and that identity BOUND as the workflow's
 * coordinator — so the engine reference the bind minted is adoptable.
 */
async function seedBoundAuthority(harnessDir: string, sessionId: string): Promise<ExecutionSessionRef> {
  await mkdir(harnessDir, { recursive: true })
  const handle = await initializeStore({ harnessDir })
  handle.close()
  const rootToken = (await readExecutionState({ harnessDir })).token
  await registerCatalogEntity(
    { harnessDir },
    { kind: 'plan', id: PLAN_ID, title: `${PLAN_ID} title`, rootKind: 'plans', relativePath: `plans/${PLAN_ID}.md` },
    { operationId: `register-${PLAN_ID}`, actor: 'native-commands.spec' },
  )
  const context = {
    harnessDir,
    caller: { sessionId, role: 'coordinator', workflowId: WORKFLOW_ID } satisfies ExecutionCaller,
  } satisfies ExecutionContext
  const created = await createExecutionWorkflow(context, {
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
      branch: { source: 'feature/native-surface', target: 'main' },
    } as never,
    expected: rootToken,
    operationId: `create-${WORKFLOW_ID}`,
  })
  const workflowToken = created.data.workflows[0]?.workflowToken
  if (workflowToken === undefined) throw new Error('the created lifecycle carries no workflow token')
  const bound = await bindExecutionSession(context, {
    workflowId: WORKFLOW_ID,
    expected: workflowToken,
    operationId: `bind-${WORKFLOW_ID}`,
  })
  return bound.data
}

/**
 * Adopt the bound reference into the session's durable slot — the write whose
 * clear is the surviving tool's whole job. The adoption goes through the shared
 * `adoptExecutionBinding` (the canonical C1 write the picker never manufactures).
 */
async function adoptFor(harnessDir: string, cwd: string, sessionId: string): Promise<ExecutionSessionRef> {
  const ref = await seedBoundAuthority(harnessDir, sessionId)
  const adopted = adoptExecutionBinding(
    harnessDir,
    sessionId,
    cwd,
    { version: 1, harnessRoot: harnessDir, session: ref },
    { storeId: ref.storeId, epoch: ref.epoch },
  )
  if (!adopted) throw new Error('the fixture adoption was refused')
  // The ledger-attribution resolver canonicalizes the REAL dir under
  // {WORKFLOW_DIR} (existsSync → statSync → realpathSync); the store fixture
  // registers the lifecycle but materializes no dir, so seed it.
  await mkdir(join(harnessDir, 'workflows', ref.workflowId), { recursive: true })
  return ref
}

// ---------------------------------------------------------------------------
// Registration surface — one tool, fourteen absences
// ---------------------------------------------------------------------------

describe('native tool surface — one tool, no MCP duplicates', () => {
  it('registers mstar_execution_clear and none of the fourteen removed command tools', async () => {
    const app = booted = await bootApp()
    expect(app.ctx.tools.get(CLEAR_TOOL)).toBeDefined()
    for (const name of REMOVED_TOOLS) {
      // The duplicate surface is gone with no alias and no compatibility tool:
      // every one of these commands is reached through the scoped MCP mount
      // (`mcp__mstar__<family>` with an `action`).
      expect(app.ctx.tools.get(name), name).toBeUndefined()
    }
  })

  it('publishes an EMPTY parameter face: identity is never model-supplied', async () => {
    const app = booted = await bootApp()
    const tool = app.ctx.tools.get(CLEAR_TOOL)!
    // The registry publishes the tool's `parameters` as a JSON schema; the
    // clear declares none, so the model has no field to put an identity in.
    const published = tool.parameters as { properties?: Record<string, unknown> }
    expect(Object.keys(published.properties ?? {})).toEqual([])
  })

  it('unregisters on fiber.dispose (HMR: a post-dispose lookup finds none)', async () => {
    const app = booted = await bootApp()
    expect(app.ctx.tools.get(CLEAR_TOOL)).toBeDefined()
    expect(app.pluginFiber).toBeDefined()
    await app.pluginFiber!.dispose()
    expect(app.ctx.tools.get(CLEAR_TOOL)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The surviving capability — clearing the session's own durable binding
// ---------------------------------------------------------------------------

describe('mstar_execution_clear — the one native-only capability', () => {
  it("clears the calling session's adopted binding, keeps the selection, and ignores a model-supplied session id", async () => {
    const app = booted = await bootApp()
    const ref = await adoptFor(app.harnessDir, app.root, CHILD_ID)
    // The user's durable pick survives the clear (the slash clear's guarantee).
    expect(updateWorkflowSessionBinding(app.harnessDir, CHILD_ID, app.root, {
      selectedWorkflowId: WORKFLOW_ID,
      excludedBeforeSeq: 4,
    }).kind).toBe('written')
    // The session is attributed while the binding is adopted.
    expect(await resolveExecutionLedgerTarget(CHILD_ID, app.root)).not.toBeNull()

    // A session id in the arguments is NOT an identity channel: the call acts
    // on the CALLER's binding, never on the id the model typed.
    const cleared = envelopeOf(await run(app.ctx, CLEAR_TOOL, agentOf(CHILD_ID, app.root), { sessionId: PARENT_ID }))
    expect(cleared.status).toBe('ok')
    expect(cleared.command).toBe('execution.clear')
    expect(cleared.code).toBe('execution.clear.ok')

    const binding = storedBinding(app.harnessDir, app.root)
    expect(binding?.executionBinding ?? null).toBeNull()
    expect(binding?.selectedWorkflowId).toBe(WORKFLOW_ID)
    expect(binding?.excludedBeforeSeq).toBe(4)
    // The parent's slot — the id the model supplied — was never touched.
    expect(storedBinding(app.harnessDir, app.root, PARENT_ID)?.executionBinding ?? null).toBeNull()
    // The ledger's explicit route required the binding: after the clear the
    // session is no longer attributed.
    expect(await resolveExecutionLedgerTarget(CHILD_ID, app.root)).toBeNull()
    // `ref` is only here to keep the fixture's receipt in scope for readers.
    expect(decodeExecutionSessionRef(encodeExecutionSessionRef(ref)).sessionId).toBe(CHILD_ID)
  })

  it('refuses a known leaf seat fail-closed, before any store read', async () => {
    const app = booted = await bootApp()
    await adoptFor(app.harnessDir, app.root, CHILD_ID)
    // The leaf markers are exactly the two shapes the shared predicate reads.
    for (const header of [{ origin: 'subagent' }, { delegationDepth: 2 }]) {
      const refused = envelopeOf(await run(app.ctx, CLEAR_TOOL, agentOf(CHILD_ID, app.root, header), {}))
      expect(refused.status).toBe('refused')
      expect(refused.code).toBe('execution.clear.leaf-seat')
      expect(String(refused.message)).toContain('known leaf sessions')
      // Fail-closed means nothing was read or written: the binding is intact.
      expect(storedBinding(app.harnessDir, app.root)?.executionBinding).not.toBeNull()
    }
  })

  it('names a recovery route that still exists — the harnessDir config, never a removed tool', async () => {
    const app = booted = await bootApp()
    // An ACTIVE authority with no binding row for this session is the
    // "nothing to clear" case; without a store the same call answers the
    // store refusal instead (pinned by the case below).
    const handle = await initializeStore({ harnessDir: app.harnessDir })
    handle.close()
    const refused = envelopeOf(await run(app.ctx, CLEAR_TOOL, agentOf(CHILD_ID, app.root), {}))
    expect(refused.status).toBe('refused')
    expect(refused.code).toBe('execution.clear.no-binding')
    expect(String(refused.message).split('\n')[0])
      .toBe('no clearable execution binding is reachable from the control root resolved here')
    const recovery = recoveryOf(refused)
    // The route an operator can actually take: the plugin's own `harnessDir`
    // config resolves a control root the workspace probe cannot reach.
    expect(recovery).toContain('`harnessDir` config')
    expect(recovery).toContain('no action is needed')
    // No recovery sentence may advertise the removed native command surface.
    for (const removed of ['mstar_plan_bind', 'native bind', 'mstar plan bind']) {
      expect(recovery).not.toContain(removed)
    }
  })

  it('carries the recorded workspace in the store refusal when this session is keyed to another cwd', async () => {
    const app = booted = await bootApp()
    const recordedWorkspace = await mkdtemp(join(tmpdir(), 'native-surface-workspace-'))
    roots.push(recordedWorkspace)
    await mkdir(app.harnessDir, { recursive: true })
    const handle = await initializeStore({ harnessDir: app.harnessDir })
    handle.close()
    // A durable record for this session exists, keyed to another workspace…
    expect(updateWorkflowSessionBinding(app.harnessDir, CHILD_ID, recordedWorkspace, {
      selectedWorkflowId: WORKFLOW_ID,
      excludedBeforeSeq: 2,
    }).kind).toBe('written')

    // …so a clear from THIS workspace gets the store's own cwd-mismatch
    // refusal, carrying the workspace the durable key actually names.
    const refused = envelopeOf(await run(app.ctx, CLEAR_TOOL, agentOf(CHILD_ID, app.root), {}))
    expect(refused.status).toBe('refused')
    expect(refused.code).toBe('execution.clear.store-refused')
    expect(refused.data).toEqual({ recordedCwd: recordedWorkspace })
    const recovery = recoveryOf(refused)
    expect(recovery).toContain('`data.recordedCwd`')
    expect(recovery).toContain(recordedWorkspace)
    // Nothing was cleared: the record at the recorded workspace is untouched.
    expect(storedBinding(app.harnessDir, recordedWorkspace)?.executionBinding ?? null).toBeNull()
  })
})
