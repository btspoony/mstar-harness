/**
 * The dsh native tool surface — exactly three tools, each justified by the rule
 * its module header states: `mstar_plan_bind` (the producer of the dsh-local
 * durable execution binding + adoption receipt the MCP bind cannot write),
 * `mstar_audit_validate` (a capability the MCP surface does not publish) and
 * `mstar_execution_clear` (no shared command exists).
 *
 * Fourteen mstar commands used to be registered here and in `gates/tools.ts` as
 * dsh tools, each duplicating an MCP tool of the SAME name 1:1 (two identical
 * model-facing surfaces, ~10k characters of fixed context per request). The
 * shared MCP connection is the writable command surface on this host and covers
 * all of them, so those tools are gone and this suite pins their ABSENCE beside the
 * surviving tools' contracts: identity from `exec.agent.id` (never
 * model-supplied), the fail-closed leaf-seat guard, the durable adoption a
 * native bind performs, and the named refusals with their `data.recordedCwd`
 * fact.
 *
 * Every case boots the REAL-composition harness (the same plugin the dsh app
 * loads) and drives the tools through the REAL registry, while the execution
 * authority is a SYNTHETIC store fixture built by the engine's own producers
 * (initializeStore → catalog registration → createExecutionWorkflow →
 * bindExecutionSession, the `execution-session.spec.ts` idiom) — the real
 * control-root store in `.mstar/` is never touched.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import type { ExecutionCaller, ExecutionContext, ExecutionSessionRef, StoreHandle } from '@mstar-harness/engine'
import { adoptExecutionBinding, resolveExecutionLedgerTarget } from '../src/gates/workflow-selection.ts'
import { adoptionRecoveryText, postCommitAdoptionRefusal } from '../src/gates/native-commands.ts'
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { WorkflowSessionBinding } from '../src/engine-status-store.ts'
import { bootApp, type BootResult } from './harness.ts'

const TS = '2026-09-21T00:00:00.000Z'
const WORKFLOW_ID = 'wf-native-surface'
const PLAN_ID = 'plan-native-surface'
const PARENT_ID = 'session-native-parent'
const CHILD_ID = 'session-native-child'
const BIND_TOOL = 'mstar_plan_bind'
const AUDIT_TOOL = 'mstar_audit_validate'
const CLEAR_TOOL = 'mstar_execution_clear'

/**
 * The registered surface — the whole `mstar_` native namespace on this host.
 * Rule (module header): a tool lives here only as the producer of a dsh-local
 * durable record the MCP route cannot write, or as a capability the MCP surface
 * does not publish at all.
 */
const NATIVE_SURFACE = [AUDIT_TOOL, CLEAR_TOOL, BIND_TOOL] as const

/**
 * The twelve tools this change removed: the six remaining writable commands
 * (now MCP `mstar_plan` / `mstar_workflow` / `mstar_issue` actions, one tool per
 * family) and the six remaining read-only mirrors (now `mstar_sdd` /
 * `mstar_iteration` / `mstar_design_md` / `mstar_compound` / `mstar_roles`).
 * `mstar_plan_bind` and `mstar_audit_validate` are NOT here: they survive
 * because no MCP route replaces what they uniquely do.
 */
const REMOVED_TOOLS = [
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
  'mstar_compound_validate',
  'mstar_roles_validate',
] as const

let booted: BootResult | undefined
const roots: string[] = []

/**
 * The store connections this case holds open, one per root at most: a fixture
 * acquires it while the store is created or seeded and keeps it to the end.
 *
 * The reason is the runtime's own close: once the last connection to a WAL
 * store closes, its journal sidecars are removed when the handle is collected,
 * and a read-only open of that quiesced shape fails with SQLITE_CANTOPEN,
 * which the engine reports as `store.corrupt` "unable to open database file".
 * The fixture's live connection keeps the journal in place, so every read the
 * case performs — the tool's own read and the durable-slot reads — meets an
 * open store instead of a just-closed one.
 */
const storeHandles: StoreHandle[] = []

afterEach(async () => {
  for (const handle of storeHandles.splice(0)) handle.close()
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
 * The session's adopted execution binding, or `null` — a slot that was never
 * written reads as `ok` with no binding. An UNREADABLE store is not "no
 * record": it fails the case with the store's own reason, so "nothing was
 * written" can never pass because the store could not be opened.
 */
function adoptedBindingOf(harnessDir: string, cwd: string, sessionId: string): WorkflowSessionBinding['executionBinding'] | null {
  const read = readWorkflowSessionBinding(harnessDir, sessionId, cwd)
  if (read.kind !== 'ok') throw new Error(`the binding slot read failed: ${read.reason}`)
  return read.binding?.executionBinding ?? null
}

/**
 * The REAL execution authority at `harnessDir` for `sessionId`: an initialized
 * store, one registered catalog plan, one created lifecycle whose CREATING
 * identity is that session, and that identity BOUND as the workflow's
 * coordinator — so the engine reference the bind minted is adoptable.
 */
async function seedBoundAuthority(harnessDir: string, sessionId: string): Promise<ExecutionSessionRef> {
  await mkdir(harnessDir, { recursive: true })
  // The fixture's ONE connection for this root: kept open through the case so
  // the reads below never open a just-closed store (see `storeHandles`).
  storeHandles.push(await initializeStore({ harnessDir }))
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

/**
 * The REAL execution authority at `harnessDir`: an initialized store, one
 * registered catalog plan, and one created lifecycle whose CREATING identity is
 * `coordinatorSessionId` — deliberately NOT bound, so the native
 * `mstar_plan_bind` call is the bind the lifecycle actually uses.
 */
async function seedUnboundWorkflow(harnessDir: string, coordinatorSessionId: string): Promise<void> {
  await mkdir(harnessDir, { recursive: true })
  // The fixture's ONE connection for this root, kept open for the case (see
  // `storeHandles`): the bind's refusal path reads the slot afterwards.
  storeHandles.push(await initializeStore({ harnessDir }))
  const rootToken = (await readExecutionState({ harnessDir })).token
  await registerCatalogEntity(
    { harnessDir },
    { kind: 'plan', id: PLAN_ID, title: `${PLAN_ID} title`, rootKind: 'plans', relativePath: `plans/${PLAN_ID}.md` },
    { operationId: `register-${PLAN_ID}`, actor: 'native-commands.spec' },
  )
  const created = await createExecutionWorkflow(
    {
      harnessDir,
      caller: { sessionId: coordinatorSessionId, role: 'coordinator', workflowId: WORKFLOW_ID } satisfies ExecutionCaller,
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
        branch: { source: 'feature/native-surface', target: 'main' },
      } as never,
      expected: rootToken,
      operationId: `create-${WORKFLOW_ID}`,
    },
  )
  if (created.data.workflows[0] === undefined) throw new Error('the fixture workflow was not created')
}

/** Run fixture Git with process-local signing and identity overrides; returns stdout. */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: 'Fixture User',
      GIT_CONFIG_KEY_2: 'user.email',
      GIT_CONFIG_VALUE_2: 'fixture@example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
}

/**
 * A REAL Git fixture root: the root itself is the `main` control checkout, plus
 * one linked feature worktree. `plan bind` resolves its control root through the
 * same git-top-level/workspace probe the CLI uses, so the fixture is what makes
 * the native call resolve the harness the fixture seeded.
 */
async function gitFixtureRoot(): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), 'native-commands-git-'))
  roots.push(root)
  const worktree = join(root, 'feature')
  git(['init', '-q', '-b', 'main'], root)
  await writeFile(join(root, 'seed.txt'), 'seed\n')
  git(['add', 'seed.txt'], root)
  git(['commit', '-q', '-m', 'fixture'], root)
  git(['worktree', 'add', '-q', worktree, '-b', 'feature/native-surface'], root)
  return { root, worktree }
}

/** Boot the composed app on a git fixture root and seed the UNBOUND lifecycle for CHILD_ID. */
async function bootedWithFixture(): Promise<BootResult> {
  const fixture = await gitFixtureRoot()
  const app = booted = await bootApp({ root: fixture.root })
  await seedUnboundWorkflow(app.harnessDir, CHILD_ID)
  // The ledger-attribution resolver canonicalizes the REAL dir under
  // {WORKFLOW_DIR}; the store fixture registers the lifecycle but materializes
  // no dir, so seed it.
  await mkdir(join(app.harnessDir, 'workflows', WORKFLOW_ID), { recursive: true })
  return app
}

// ---------------------------------------------------------------------------
// Registration surface — three tools, twelve absences
// ---------------------------------------------------------------------------

describe('native tool surface — three tools, no MCP duplicates', () => {
  it('registers exactly mstar_plan_bind, mstar_audit_validate and mstar_execution_clear', async () => {
    const app = booted = await bootApp()
    // The model-facing registry view: every `mstar_` name the model can call
    // on this host. The COUNT is the assertion — a fourth native tool means
    // the rule in the module header was broken, not that a name is missing.
    const names = app.ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(name => name.startsWith('mstar_'))
      .sort()
    expect(names).toHaveLength(NATIVE_SURFACE.length)
    expect(names).toEqual([...NATIVE_SURFACE])
    for (const name of NATIVE_SURFACE) expect(app.ctx.tools.get(name), name).toBeDefined()
    for (const name of REMOVED_TOOLS) {
      // The duplicate surface is gone with no alias and no compatibility tool:
      // every one of these commands is reached through the shared MCP
      // connection (`mcp__mstar__<family>` with an `action`).
      expect(app.ctx.tools.get(name), name).toBeUndefined()
    }
  })

  it('unregisters every native tool on fiber.dispose (HMR: a post-dispose lookup finds none)', async () => {
    const app = booted = await bootApp()
    for (const name of NATIVE_SURFACE) expect(app.ctx.tools.get(name), name).toBeDefined()
    expect(app.pluginFiber).toBeDefined()
    await app.pluginFiber!.dispose()
    for (const name of NATIVE_SURFACE) expect(app.ctx.tools.get(name), name).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// mstar_plan_bind — the durable-slot producer
// ---------------------------------------------------------------------------

describe('mstar_plan_bind — the command that writes the dsh durable binding', () => {
  it('publishes no session-id parameter (identity is never model-supplied)', async () => {
    const app = booted = await bootApp()
    const published = app.ctx.tools.get(BIND_TOOL)!.parameters as { properties?: Record<string, unknown> }
    const properties = Object.keys(published.properties ?? {})
    // The bind's own documented selectors are published; the session selector
    // is not one of them.
    expect(properties).toContain('workflow')
    expect(properties).toContain('execution')
    expect(properties).not.toContain('sessionId')
  })

  it('adopts the engine-minted reference after a native execution bind, keeps the selection, and the ledger resolves', async () => {
    const app = await bootedWithFixture()
    // A pre-existing durable selection (the picker pick + exclusion floor)
    // must survive adoption untouched.
    expect(updateWorkflowSessionBinding(app.harnessDir, CHILD_ID, app.root, {
      selectedWorkflowId: WORKFLOW_ID,
      excludedBeforeSeq: 7,
    }).kind).toBe('written')

    const bound = envelopeOf(await run(app.ctx, BIND_TOOL, agentOf(CHILD_ID, app.root), {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      // A model-supplied identity is STRIPPED before admission: the adoption
      // below must name the CALLING session, never this value.
      sessionId: PARENT_ID,
    }))
    expect(bound.status).toBe('ok')

    const binding = storedBinding(app.harnessDir, app.root)
    // The adopted reference is the engine's own mint — the canonical C1
    // binding naming the carrying session, not a dsh-invented record. This is
    // the capability the MCP `mstar_plan` action `bind` does NOT have: it binds
    // the engine seat and leaves this slot unwritten.
    expect(binding?.executionBinding?.version).toBe(1)
    expect(binding?.executionBinding?.harnessRoot).toBe(realpathSync(app.harnessDir))
    expect(binding?.executionBinding?.session.workflowId).toBe(WORKFLOW_ID)
    expect(binding?.executionBinding?.session.sessionId).toBe(CHILD_ID)
    expect(binding?.executionBinding?.session.role).toBe('coordinator')
    // The user selection is preserved: the adopted workflow becomes the stored
    // pick and the exclusion floor is kept (merged, never reset).
    expect(binding?.selectedWorkflowId).toBe(WORKFLOW_ID)
    expect(binding?.excludedBeforeSeq).toBe(7)

    // Ledger attribution works with NO slash command: the workflow resolves
    // from the binding slot this bind populated.
    const target = await resolveExecutionLedgerTarget(CHILD_ID, app.root)
    expect(target).not.toBeNull()
    expect(target?.workflowId).toBe(WORKFLOW_ID)
    expect(target?.workflowDir).toBe(realpathSync(join(app.harnessDir, 'workflows', WORKFLOW_ID)))
    expect(target?.sessionId).toBe(CHILD_ID)
    // The id the model typed was never adopted for the parent either.
    expect(adoptedBindingOf(app.harnessDir, app.root, PARENT_ID)).toBeNull()
  })

  it('refuses a known leaf seat fail-closed, before any admission or engine round-trip', async () => {
    const app = await bootedWithFixture()
    // The leaf markers are exactly the two shapes the shared predicate reads.
    for (const header of [{ origin: 'subagent' }, { delegationDepth: 2 }]) {
      const refused = envelopeOf(await run(app.ctx, BIND_TOOL, agentOf(CHILD_ID, app.root, header), {
        execution: true,
        coordinator: true,
        workflow: WORKFLOW_ID,
      }))
      expect(refused.status).toBe('refused')
      expect(refused.code).toBe('plan.bind.leaf-seat')
      expect(String(refused.message).split('\n')[0]).toBe('known leaf sessions cannot adopt, clear, or run on any operation')
      // Fail-closed means nothing was written: the durable slot stays absent.
      expect(adoptedBindingOf(app.harnessDir, app.root, CHILD_ID)).toBeNull()
    }
  })

  it('returns the engine refusal verbatim and adopts nothing when the bind is refused', async () => {
    const app = await bootedWithFixture()
    // The workflow's creating identity is the CHILD session; the parent is not
    // its coordinator, so the engine refuses the bind.
    const refused = envelopeOf(await run(app.ctx, BIND_TOOL, agentOf(PARENT_ID, app.root), {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(refused.status).not.toBe('ok')
    // The engine's own code, never a dsh adoption rewrite: a refused bind is
    // the engine's verdict and the adoption returns the envelope unchanged.
    expect(String(refused.code)).not.toStartWith('binding.')
    expect(adoptedBindingOf(app.harnessDir, app.root, PARENT_ID)).toBeNull()
    expect(adoptedBindingOf(app.harnessDir, app.root, CHILD_ID)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The surviving capability — clearing the session's own durable binding
// ---------------------------------------------------------------------------

describe('mstar_execution_clear — the native-only clear', () => {
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

  it('publishes an EMPTY parameter face: identity is never model-supplied', async () => {
    const app = booted = await bootApp()
    const tool = app.ctx.tools.get(CLEAR_TOOL)!
    // The registry publishes the tool's `parameters` as a JSON schema; the
    // clear declares none, so the model has no field to put an identity in.
    const published = tool.parameters as { properties?: Record<string, unknown> }
    expect(Object.keys(published.properties ?? {})).toEqual([])
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
    // store refusal instead (pinned by the case below). The handle stays open
    // through the call and the assertions — closing it here would make the
    // clear's own read the first connection to a just-closed store.
    storeHandles.push(await initializeStore({ harnessDir: app.harnessDir }))
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
    storeHandles.push(await initializeStore({ harnessDir: app.harnessDir }))
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

// ---------------------------------------------------------------------------
// The POST-COMMIT adoption contract — the failing stage selects the recovery
//
// Both arms run only after the shared `plan.bind` returned ok, so the engine
// seat is bound either way; the two failures must never advertise the same
// route. The deterministic trigger for the slot arm is the public store
// cwd-mismatch regression above; the engine-resume arm has no public trigger
// (the reference was minted by the bind that just succeeded), so the pure
// selection is asserted directly.
// ---------------------------------------------------------------------------

/** The post-commit facts an adoption refusal carries beside its canonical envelope. */
function postCommitFactsOf(envelope: unknown): { committed?: unknown; data?: unknown } {
  return envelope as { committed?: unknown; data?: unknown }
}

/** The message a refusal envelope carries (the shared shape, read without narrowing the status union). */
function refusalMessageOf(envelope: unknown): string {
  return String((envelope as { message?: unknown }).message ?? '')
}

/** One coordinator reference in the engine's canonical shape (a pure fixture: never compared against a minted one). */
const ADOPTED_REF: ExecutionSessionRef = {
  storeId: 'store-native-contract',
  epoch: 3,
  workflowId: WORKFLOW_ID,
  role: 'coordinator',
  sessionId: CHILD_ID,
}

describe('post-commit adoption recovery — the failing stage selects the route', () => {
  it('does not promise a resume re-bind after the ENGINE resume refused the reference', () => {
    const recovery = adoptionRecoveryText('resume', 'store.stale-epoch')
    // The engine refused this very reference: the recovery must not instruct
    // the caller to re-run the resume re-bind it rejected, nor promise that
    // that re-bind re-adopts the slot.
    expect(recovery).not.toContain('The resume re-adopts the binding slot')
    expect(recovery).not.toContain('re-run the native bind as a resume carrying')
    // The seat is bound and the slot was not written…
    expect(recovery).toContain('BOUND')
    expect(recovery).toContain('NOT written')
    // …and the actual cause plus the engine's own coordinator recovery route
    // are named.
    expect(recovery).toContain('store.stale-epoch')
    expect(recovery).toContain('mstar session recover')
    expect(recovery).toContain('--prior-session')
  })

  it('keeps the resume re-bind as the recovery when only the durable slot write failed', () => {
    const recovery = adoptionRecoveryText('durable-slot', 'store.authority-unreadable')
    expect(recovery).toContain('`data.resumeRef` as `resumeRef`')
    expect(recovery).toContain('SAME `harness`')
    expect(recovery).toContain('re-adopts')
    // Without a recorded-workspace fact the recovery only describes the
    // condition (there is no `data.recordedCwd` to point at).
    expect(recovery).not.toContain('`data.recordedCwd`')
  })

  it('names the recorded workspace in the slot-write recovery when the store answered cwd-mismatch', () => {
    const recovery = adoptionRecoveryText('durable-slot', 'store.authority-unreadable', '/recorded/workspace')
    expect(recovery).toContain('`data.recordedCwd`')
    expect(recovery).toContain('/recorded/workspace')
  })
})

// ---------------------------------------------------------------------------
// The three refusals of a committed bind that never reached the durable write
//
// A real engine mints a readable reference naming the carrying session, so no
// fixture reaches these arms; the selection is where the contract lives. Each
// arm must stay `committed` (the seat IS bound), and must carry exactly the
// facts its own recovery names — the engine coordinator route on the two arms
// where a resume re-bind would loop, the caller-identity fix on the third.
// ---------------------------------------------------------------------------

describe('post-commit adoption refusals — the facts each recovery names', () => {
  it('binding.receipt-unrecognizable: no reference exists, so the recovery is the engine coordinator route', () => {
    const refusal = postCommitAdoptionRefusal({
      kind: 'receipt-unrecognizable',
      sessionId: CHILD_ID,
      workflowId: WORKFLOW_ID,
    })
    expect(refusal.status).toBe('refused')
    expect(refusal.code).toBe('binding.receipt-unrecognizable')
    expect(postCommitFactsOf(refusal).committed).toBe(true)
    // Nothing was read out of the receipt: there is no `resumeRef` to carry,
    // only the workflow the bind input named.
    expect(postCommitFactsOf(refusal).data).toEqual({ workflowId: WORKFLOW_ID })
    const recovery = recoveryOf(refusal as unknown as Record<string, unknown>)
    expect(recovery).toContain(`mstar session recover --workflow ${WORKFLOW_ID}`)
    expect(recovery).toContain(`--prior-session ${CHILD_ID}`)
    expect(recovery).toContain('--unowned=true')
    expect(recovery).toContain('BOUND')
    expect(recovery).toContain('NOT written')
    // A resume re-bind would carry the reference this arm could not read.
    expect(recovery).not.toContain('re-adopts the binding slot')
  })

  it('binding.no-harness: the minted reference is carried, and the recovery never promises a re-bind', () => {
    const refusal = postCommitAdoptionRefusal({ kind: 'no-harness', ref: ADOPTED_REF })
    expect(refusal.status).toBe('refused')
    expect(refusal.code).toBe('binding.no-harness')
    expect(postCommitFactsOf(refusal).committed).toBe(true)
    // The minted reference is the one fact that makes the recovery performable
    // without the slot this path could not write.
    expect(postCommitFactsOf(refusal).data).toEqual({
      resumeRef: encodeExecutionSessionRef(ADOPTED_REF),
      workflowId: WORKFLOW_ID,
    })
    const recovery = recoveryOf(refusal as unknown as Record<string, unknown>)
    expect(recovery).toContain(`mstar session recover --workflow ${WORKFLOW_ID}`)
    expect(recovery).toContain(`--prior-session ${CHILD_ID}`)
    expect(recovery).toContain('--unowned=true')
    // The plain re-bind is refused while the seat is bound: the recovery must
    // not advertise the loop it would present.
    expect(recovery).not.toContain('re-run the bind as a resume')
  })

  it('binding.foreign-reference: nothing is carried and the fix is the calling identity', () => {
    const foreign: ExecutionSessionRef = { ...ADOPTED_REF, sessionId: PARENT_ID }
    const refusal = postCommitAdoptionRefusal({ kind: 'foreign-reference', ref: foreign, sessionId: CHILD_ID })
    expect(refusal.status).toBe('refused')
    expect(refusal.code).toBe('binding.foreign-reference')
    expect(postCommitFactsOf(refusal).committed).toBe(true)
    // No engine recovery is offered: an unadoptable reference stays that way,
    // and no fact of this refusal would make one performable.
    expect(postCommitFactsOf(refusal).data).toBeUndefined()
    expect(refusalMessageOf(refusal)).toContain(PARENT_ID)
    expect(refusalMessageOf(refusal)).toContain(CHILD_ID)
    expect(recoveryOf(refusal as unknown as Record<string, unknown>))
      .toBe('Run the bind as the carrying session itself; a reference to another session is never adoptable.')
  })
})

