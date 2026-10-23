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
import type { Context } from '@deepseek-ai/cordis'
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
import {
  clearExecutionBindingRoot,
  executionBindingRootOf,
  recordExecutionBindingRoot,
  resetExecutionBindingRootsForTests,
  setDurableReceiptBoundForTests,
} from '../src/gates/execution-binding-roots.ts'
import {
  EXECUTION_BINDING_ROOTS_LOGGER,
  beginExecutionBindingRootStoreOpening,
  endExecutionBindingRootStoreOpening,
  executionBindingRootStoreOf,
  executionBindingRootStoreOpening,
  executionBindingRootsDomain,
  installExecutionBindingRootStore,
  type ExecutionBindingRootStore,
} from '../src/gates/execution-binding-roots-domain.ts'
import { adoptionRecoveryText, postCommitAdoptionRefusal } from '../src/gates/native-commands.ts'
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { WorkflowSessionBinding } from '../src/engine-status-store.ts'
import { bootApp, restartSeam, rootTableOf, seamDisposers, type BootResult } from './harness.ts'

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
  for (const dispose of seamDisposers.splice(0)) dispose()
  resetExecutionBindingRootsForTests()
  setDurableReceiptBoundForTests(undefined)
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
// The DURABLE adopted-root seam — the receipt outlives the process
//
// A native bind carrying an explicit `harness` selects another control root
// and records the receipt for the carrying session; the plugin's durable seam
// mirrors that receipt into the host's storage domain, so the ledger
// attribution and the native clear still resolve the ADOPTED root after a
// restart. The restart is modelled over ONE fake medium: the seam is installed
// over an in-memory map, the in-process overlay is cleared, and a fresh seam is
// installed over the SAME map — exactly what a new process meeting the same
// durable state sees. The storage domain itself is the brief's stub facility
// (`open(spec)` resolving `{ table, close }`): no storage backend is involved.
// ---------------------------------------------------------------------------

/**
 * One opened stub domain: the fake table over the medium plus its close. The
 * plugin builds its store from `table()` and installs the seam in the next
 * synchronous statement, so `table()` is also the fixture-visible install point.
 */
type StubDomainHandle = { table(): ExecutionBindingRootStore; close(): Promise<void> }

/** The standard stub handle over one medium (a no-op close: disposal never owns the medium). */
const stubHandleOf = (medium: Map<string, string>): StubDomainHandle => ({
  table: () => rootTableOf(medium),
  close: async () => {},
})

/**
 * A stub `storageDomain` facility whose `open` waits on a gate the FIXTURE
 * settles — no wall-clock wait. `opened` resolves from inside `open`, so a
 * fixture can order against the child's registered continuation (settle the
 * gate, or dispose the row while it is still pending); `installed` resolves
 * from `table()`, in the install path itself. `openedWith` keeps the spec the
 * plugin handed to `open` (the declaration the seam is bound to).
 */
function stubFacilityOf(handle: StubDomainHandle): {
  facility: { open(spec?: unknown): Promise<StubDomainHandle> }
  opened: Promise<void>
  installed: Promise<void>
  openedWith(): unknown
  settle(): void
} {
  const gate = Promise.withResolvers<StubDomainHandle>()
  const opened = Promise.withResolvers<void>()
  const installed = Promise.withResolvers<void>()
  let spec: unknown
  return {
    facility: {
      open: (openedSpec) => {
        spec = openedSpec
        // The child registers its continuation on `gate.promise` after this
        // returns, so resolving `opened` here gives the fixture that order.
        opened.resolve()
        return gate.promise
      },
    },
    opened: opened.promise,
    installed: installed.promise,
    openedWith: () => spec,
    settle: () => gate.resolve({
      table: () => {
        installed.resolve()
        return handle.table()
      },
      close: () => handle.close(),
    }),
  }
}

/**
 * Let every continuation queued on an already-settled promise run: the clear
 * path and the install replay queue their durable delete/put without awaiting
 * it (and the fake table applies each operation at call time), so this is a
 * microtask flush — never a wait on wall-clock time. Call it after settling a
 * gate whose continuation the fixture has already been ordered behind.
 */
const flushQueuedContinuations = async (): Promise<void> => { await Promise.resolve() }

let providerSeq = 0

/**
 * Mount a stub `storageDomain` facility as a plugin row: the plugin's own
 * `ctx.inject(['storageDomain'], …)` child opens it and installs the seam the
 * way the real host does. Returns the row's disposal, which runs the child's
 * disposer — the seam uninstall followed by the domain close.
 */
async function mountStorageDomain(app: BootResult, facility: unknown): Promise<{ dispose(): Promise<void> }> {
  const row = {
    name: `stub-storage-domain-${++providerSeq}`,
    apply(ctx: Context) {
      (ctx as unknown as { provide(name: string, value: unknown): () => void }).provide('storageDomain', facility)
    },
  }
  const provider = app.ctx.plugin(row as unknown as Parameters<Context['plugin']>[0])
  await provider
  return provider as unknown as { dispose(): Promise<void> }
}

/**
 * The cross-root fixture: boot on the git root, seed the ADOPTED root's own
 * unbound lifecycle, install the durable seam through the stub facility, and
 * run the native bind with an explicit `harness` selector.
 */
async function crossRootBindFixture(): Promise<{
  app: BootResult
  adoptedRoot: string
  medium: Map<string, string>
  provider: { dispose(): Promise<void> }
}> {
  const app = await bootedWithFixture()
  const adoptedRoot = await mkdtemp(join(tmpdir(), 'native-adopted-root-'))
  roots.push(adoptedRoot)
  await seedUnboundWorkflow(adoptedRoot, CHILD_ID)
  await mkdir(join(adoptedRoot, 'workflows', WORKFLOW_ID), { recursive: true })
  const medium = new Map<string, string>()
  const stub = stubFacilityOf(stubHandleOf(medium))
  const provider = await mountStorageDomain(app, stub.facility)
  // The fixture owns the open gate: settle it, then await the product's own
  // install point instead of waiting on the clock.
  stub.settle()
  await stub.installed
  // The cross-root native bind: the explicit `harness` selector names root B.
  const bound = envelopeOf(await run(app.ctx, BIND_TOOL, agentOf(CHILD_ID, app.root), {
    execution: true,
    coordinator: true,
    workflow: WORKFLOW_ID,
    harness: adoptedRoot,
  }))
  if (bound.status !== 'ok') throw new Error(`the cross-root native bind was refused: ${String(bound.code)}`)
  return { app, adoptedRoot, medium, provider }
}

describe('durable adopted-root seam — the declared domain and its host adapter', () => {
  it('opens the DECLARED domain spec: the facility receives executionBindingRootsDomain with its `roots` table', async () => {
    const app = booted = await bootApp()
    const stub = stubFacilityOf(stubHandleOf(new Map()))
    const provider = await mountStorageDomain(app, stub.facility)
    await stub.opened
    const spec = stub.openedWith() as { name: string; tables: Record<string, unknown> }
    expect(spec).toBe(executionBindingRootsDomain)
    expect(spec.name).toBe('mstar_execution_binding_roots')
    expect(Object.keys(spec.tables)).toEqual(['roots'])
    stub.settle()
    await stub.installed
    await provider.dispose()
  })

  it('executionBindingRootStoreOf round-trips through the `roots` table', async () => {
    const records = new Map<string, string>()
    const calls: string[] = []
    const domain = {
      name: 'mstar_execution_binding_roots',
      table: (name: string) => {
        calls.push(`table ${name}`)
        return {
          get: (key: string) => { calls.push(`get ${key}`); return records.get(key) },
          put: async (key: string, value: string) => { calls.push(`put ${key}`); records.set(key, value) },
          delete: async (key: string) => { calls.push(`delete ${key}`); return records.delete(key) },
        }
      },
    }
    const store = executionBindingRootStoreOf(domain as unknown as Parameters<typeof executionBindingRootStoreOf>[0])
    await store.put('k', 'v')
    expect(store.get('k')).toBe('v')
    expect(await store.delete('k')).toBe(true)
    expect(store.get('k')).toBeUndefined()
    // Delegation, not an internal call sequence: the store must ask the domain
    // for the declared `roots` table.
    expect(calls).toContain('table roots')
  })
})

describe('durable adopted-root seam — a cross-root bind survives a restart', () => {
  it('resolves the adopted root for BOTH the ledger target and the clear after a restart, with no resume re-bind', async () => {
    const { app, adoptedRoot, medium, provider } = await crossRootBindFixture()
    // The bind's receipt reached the DURABLE medium, not only the overlay:
    // with the in-process receipts dropped, the installed seam still answers
    // the adopted root.
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe(adoptedRoot)
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe(adoptedRoot)

    // ---- the restart: the seam and the in-process receipts die, the medium does not ----
    await provider.dispose()
    restartSeam(medium)

    // Ledger attribution: the slot lives in the ADOPTED root, and the target
    // names that root (the receipt outranks the workspace harness).
    const target = await resolveExecutionLedgerTarget(CHILD_ID, app.root)
    expect(target).not.toBeNull()
    expect(target?.workflowId).toBe(WORKFLOW_ID)
    expect(target?.harnessDir).toBe(adoptedRoot)
    expect(target?.workflowDir).toBe(realpathSync(join(adoptedRoot, 'workflows', WORKFLOW_ID)))

    // The native clear resolves the same root and clears THAT slot — with no
    // resume re-bind: an ok envelope carries no recovery route at all.
    const cleared = envelopeOf(await run(app.ctx, CLEAR_TOOL, agentOf(CHILD_ID, app.root), {}))
    expect(cleared.status).toBe('ok')
    expect(cleared.code).toBe('execution.clear.ok')
    expect(recoveryOf(cleared)).toBe('')
    expect(adoptedBindingOf(adoptedRoot, app.root, CHILD_ID)).toBeNull()
    // A cross-root bind never writes the workspace root.
    expect(adoptedBindingOf(app.harnessDir, app.root, CHILD_ID)).toBeNull()
  })

  it('a clear removes the durable record: a second clear after another restart answers no-binding instead of re-resolving the adopted root', async () => {
    const { app, adoptedRoot, medium, provider } = await crossRootBindFixture()
    // The slot the clear must reach, read before it is cleared.
    const adoptedSlot = storedBinding(adoptedRoot, app.root)?.executionBinding
    if (adoptedSlot === undefined || adoptedSlot === null) throw new Error('the cross-root bind wrote no durable slot')

    await provider.dispose()
    const uninstall = restartSeam(medium)
    expect(envelopeOf(await run(app.ctx, CLEAR_TOOL, agentOf(CHILD_ID, app.root), {})).code).toBe('execution.clear.ok')
    // The clear's durable delete is fire-and-forget; flush its queued
    // continuation. That the record is GONE is proven by the restart below.
    await flushQueuedContinuations()

    // Re-populate the ADOPTED root's slot: a stale receipt would clear THIS.
    expect(updateWorkflowSessionBinding(adoptedRoot, CHILD_ID, app.root, {
      executionBinding: adoptedSlot,
      excludedBeforeSeq: 0,
    }).kind).toBe('written')

    // ---- another restart: the cleared receipt must not come back ----
    restartSeam(medium, uninstall)
    const second = envelopeOf(await run(app.ctx, CLEAR_TOOL, agentOf(CHILD_ID, app.root), {}))
    expect(second.status).toBe('refused')
    expect(second.code).toBe('execution.clear.no-binding')
    // The adopted root was never reached: its re-populated slot is intact.
    expect(adoptedBindingOf(adoptedRoot, app.root, CHILD_ID)).not.toBeNull()
  })

  it('an adoption that lands before the store installs is back-filled at install and survives a restart', async () => {
    const app = await bootedWithFixture()
    const adoptedRoot = await mkdtemp(join(tmpdir(), 'native-adopted-root-'))
    roots.push(adoptedRoot)
    await seedUnboundWorkflow(adoptedRoot, CHILD_ID)
    await mkdir(join(adoptedRoot, 'workflows', WORKFLOW_ID), { recursive: true })
    const medium = new Map<string, string>()
    const stub = stubFacilityOf(stubHandleOf(medium))
    const provider = await mountStorageDomain(app, stub.facility)
    // The facility's `open` is still pending when the bind adopts root B: the
    // receipt is recorded in-process, and its durable write has no store to
    // reach yet.
    await stub.opened
    const bound = envelopeOf(await run(app.ctx, BIND_TOOL, agentOf(CHILD_ID, app.root), {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: adoptedRoot,
    }))
    expect(bound.status).toBe('ok')

    // The install back-fills the overlay: the receipt predates the store and
    // still reaches the table (the restart below is what proves it).
    stub.settle()
    await stub.installed
    await flushQueuedContinuations()

    // ---- the restart: the seam and the in-process receipts die, the medium does not ----
    await provider.dispose()
    restartSeam(medium)
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe(adoptedRoot)
  })

  it('disposal removes the seam: a read falls back to the in-process receipt and nothing reaches the closed domain', async () => {
    const app = booted = await bootApp()
    const medium = new Map<string, string>()
    let closed = 0
    let closing = false
    let readsAfterClose = 0
    let duringClose: string | undefined
    const stub = stubFacilityOf({
      table: () => ({
        get: (key: string) => {
          if (closing) readsAfterClose += 1
          return medium.get(key)
        },
        put: async (key: string, value: string) => { medium.set(key, value) },
        delete: async (key: string) => {
          const had = medium.has(key)
          medium.delete(key)
          return had
        },
      }),
      close: async () => {
        closing = true
        // The ordering assertion: a key backed ONLY by the seam must already
        // answer `undefined` here — i.e. the uninstall ran before the close.
        duringClose = executionBindingRootOf(PARENT_ID, app.root)
        closed += 1
      },
    })
    const provider = await mountStorageDomain(app, stub.facility)
    stub.settle()
    await stub.installed
    // Both returned promises are the durable writes: awaiting them means the
    // seam already holds both keys — no clock involved.
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/adopted-root')
    await recordExecutionBindingRoot(PARENT_ID, app.root, '/synthetic/parent-root')
    // With the overlay out of the way both keys answer through the seam.
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe('/synthetic/adopted-root')
    expect(executionBindingRootOf(PARENT_ID, app.root)).toBe('/synthetic/parent-root')
    // Overlay receipt for the child only; the parent's key still reads the seam.
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/adopted-root')

    // Dispose the composition's provider: the child's disposer uninstalls the
    // seam synchronously BEFORE closing the domain.
    await provider.dispose()
    expect(closed).toBe(1)
    expect(duringClose).toBeUndefined()
    expect(readsAfterClose).toBe(0)
    // The read falls back to the in-process receipt — the disposal kept it — and
    // the seam-backed key does not answer through a closed domain.
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe('/synthetic/adopted-root')
    expect(executionBindingRootOf(PARENT_ID, app.root)).toBeUndefined()
    // The record is still on the medium: a fresh seam — what the next process
    // installs — reads it.
    const fresh = installExecutionBindingRootStore(rootTableOf(medium))
    seamDisposers.push(fresh)
    expect(executionBindingRootOf(PARENT_ID, app.root)).toBe('/synthetic/parent-root')
  })

  it('a disposer restores the seam installed before it; disposing the first leaves no seam', async () => {
    const app = booted = await bootApp()
    resetExecutionBindingRootsForTests()
    const disposeA = installExecutionBindingRootStore(rootTableOf(new Map()))
    // A holds the child's root; B (installed over A) additionally the parent's.
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/a-root')
    const disposeB = installExecutionBindingRootStore(rootTableOf(new Map()))
    seamDisposers.push(() => {
      disposeB()
      disposeA()
    })
    await recordExecutionBindingRoot(PARENT_ID, app.root, '/synthetic/b-root')
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(PARENT_ID, app.root)).toBe('/synthetic/b-root')
    // Disposing B restores A, whose medium never held the parent key.
    disposeB()
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(PARENT_ID, app.root)).toBeUndefined()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe('/synthetic/a-root')
    // Disposing A leaves no seam at all: every durable read is absent again.
    disposeA()
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
  })

  it('a clear for a key nothing ever stored writes no tombstone and leaves the next read undefined', async () => {
    const app = booted = await bootApp()
    const medium = new Map<string, string>()
    const writes: string[] = []
    const store: ExecutionBindingRootStore = {
      get: (key) => medium.get(key),
      put: async (key, value) => { writes.push(`put ${key}`); medium.set(key, value) },
      delete: async (key) => { writes.push(`delete ${key}`); return medium.delete(key) },
    }
    const uninstall = installExecutionBindingRootStore(store)
    seamDisposers.push(uninstall)
    await clearExecutionBindingRoot(CHILD_ID, app.root)
    // The clear still issues its (idempotent) durable delete, but no record —
    // and therefore no tombstone — is ever written for an unobserved key.
    expect(writes).toEqual([`delete ${CHILD_ID}\u0000${app.root}`])
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
    // The install-time replay is the guard's only observable effect: a second
    // store over the same medium (what the next process installs) replays a
    // tombstone as ANOTHER delete, while a key nothing ever stored replays
    // nothing. Exactly one delete and no put for this key means no tombstone.
    const reinstall = installExecutionBindingRootStore(store)
    seamDisposers.push(reinstall)
    expect(writes).toEqual([`delete ${CHILD_ID}\u0000${app.root}`])
    // Nothing was stored durably either: with the overlay dropped the key stays absent.
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
  })

  it('a fiber torn down while open is in flight contains the inactive-effect throw, drops the just-installed seam and closes the late handle once', async () => {
    const app = booted = await bootApp()
    const lateClose = Promise.withResolvers<void>()
    let closedLate = 0
    const stub = stubFacilityOf({
      // A leaked seam would answer this fake root; a removed one answers nothing.
      table: () => ({
        get: () => '/late-leaked-root',
        put: async () => {},
        delete: async () => false,
      }),
      close: async () => {
        closedLate += 1
        lateClose.resolve()
      },
    })
    await mountStorageDomain(app, stub.facility)
    // The child is suspended on `open` (its continuation is registered): tear
    // the plugin row down while it is still in flight, then settle the gate.
    await stub.opened
    const disposing = (app.pluginFiber as unknown as { dispose(): Promise<void> }).dispose()
    stub.settle()
    await disposing
    // Wait for the late handle's close — the observable end of the contained
    // apply, not a wall-clock wait.
    await lateClose.promise
    // The late handle was closed exactly once — the next apply cannot meet `already-open`.
    expect(closedLate).toBe(1)
    // The just-installed seam was removed: no read can reach the late handle.
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
  })

  it('overlapping activations each own their pending open: one finishing never clears another\'s', () => {
    // Two activations (an HMR re-inject while the earlier `open` is pending):
    // the first refusal must not make the second one look settled.
    const first = beginExecutionBindingRootStoreOpening()
    const second = beginExecutionBindingRootStoreOpening()
    endExecutionBindingRootStoreOpening(first)
    expect(executionBindingRootStoreOpening()).toBe(true)
    endExecutionBindingRootStoreOpening(second)
    expect(executionBindingRootStoreOpening()).toBe(false)
    // Releasing an already-released activation is a no-op, never a leak.
    endExecutionBindingRootStoreOpening(second)
    expect(executionBindingRootStoreOpening()).toBe(false)
  })

  it('a row torn down while open NEVER settles releases its own activation: the next adoption still warns instead of staying silent', async () => {
    const app = booted = await bootApp()
    const logged: Array<{ name: string; type: string; args: unknown[] }> = []
    const stopLogging = (app.ctx.logger as unknown as { exporter(exporter: unknown): () => void }).exporter({
      levels: { default: 2 },
      export: (message: { name: string; type: string; args: unknown[] }) => logged.push(message),
    })
    const before = logged.length
    const stub = stubFacilityOf(stubHandleOf(new Map()))
    await mountStorageDomain(app, stub.facility)
    await stub.opened
    // The stalled-backend shape the receipt bound names: `open` never settles,
    // so the child's continuation never runs. The row's teardown is then the
    // ONLY thing that can release the activation — a process-wide flag would
    // stay set and silence every later adoption in this process.
    const disposing = (app.pluginFiber as unknown as { dispose(): Promise<void> }).dispose()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(executionBindingRootStoreOpening()).toBe(false)
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/adopted-root')
    const warned = logged.slice(before).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)
    expect(warned).toHaveLength(1)
    expect(warned[0]!.type).toBe('warn')
    expect(String(warned[0]!.args[0])).toContain('per-process')
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe('/synthetic/adopted-root')
    stopLogging()
    // Let the disposal finish (its child is waiting on this gate) so the suite
    // tears the app down in order.
    stub.settle()
    await disposing
  })

  it('the absence path: an adoption with no facility warns once, one inside the open window warns nothing and back-fills, and the absence after a seam install warns again — the plugin still mounts', async () => {
    const app = booted = await bootApp()
    const logged: Array<{ name: string; type: string; args: unknown[] }> = []
    const stopLogging = (app.ctx.logger as unknown as { exporter(exporter: unknown): () => void }).exporter({
      levels: { default: 2 },
      export: (message: { name: string; type: string; args: unknown[] }) => logged.push(message),
    })
    const before = logged.length
    const warnedSince = (from: number) => logged.slice(from).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)

    // ---- (a) no facility mounted yet: a genuine absence warns ONCE ----
    // Spending the latch BEFORE the seam exists is what makes the install-time
    // reset observable: from here the one-shot warning can only speak again if
    // installing a seam reset it.
    await recordExecutionBindingRoot(PARENT_ID, app.root, '/synthetic/pre-mount-root')
    const preMount = warnedSince(before)
    expect(preMount).toHaveLength(1)
    expect(String(preMount[0]!.args[0])).toContain('per-process')

    // ---- (b) the facility is provided, its `open` is still in flight ----
    // This is the deferred-install window, not a missing seam: the receipt is
    // back-filled at install, so the warning's "no seam" cause would be false
    // and the latch (already spent) is not consulted into a second warning.
    const medium = new Map<string, string>()
    const stub = stubFacilityOf(stubHandleOf(medium))
    const provider = await mountStorageDomain(app, stub.facility)
    await stub.opened
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/adopted-root')
    expect(warnedSince(before)).toHaveLength(1)
    // The install back-fills the receipt into the durable table.
    stub.settle()
    await stub.installed
    await flushQueuedContinuations()
    expect(medium.get(`${CHILD_ID}\u0000${app.root}`)).toBe('/synthetic/adopted-root')

    // ---- (c) the facility is gone: the SECOND absence warns again ----
    // Disposal uninstalls the seam. The latch was already spent in (a), so only
    // the install-time reset can let this later absence speak — delete that
    // reset and this assertion reddens (negative check).
    await provider.dispose()
    await recordExecutionBindingRoot(PARENT_ID, app.root, '/synthetic/parent-root')
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/second-root')
    const warned = warnedSince(before)
    expect(warned).toHaveLength(2)
    const secondAbsence = warned[1]!
    expect(secondAbsence.type).toBe('warn')
    expect(String(secondAbsence.args[0])).toContain('per-process')
    // The recovery names the resume shape the module's contract accepts.
    expect(String(secondAbsence.args[0])).toContain('resume re-bind')
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe('/synthetic/second-root')
    // Today's fallback: the receipt is gone with the process.
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
    // The plugin still mounts, and the clear answers its unchanged
    // workspace-route refusal (the durable seam is not installed).
    storeHandles.push(await initializeStore({ harnessDir: app.harnessDir }))
    const refused = envelopeOf(await run(app.ctx, CLEAR_TOOL, agentOf(CHILD_ID, app.root), {}))
    expect(refused.status).toBe('refused')
    expect(refused.code).toBe('execution.clear.no-binding')
    stopLogging()
  })

  it('a refused storage-domain open degrades to the same receipt — ONE warning names the cause, nothing is installed, the plugin still mounts', async () => {
    const app = booted = await bootApp()
    const logged: Array<{ name: string; type: string; args: unknown[] }> = []
    const stopLogging = (app.ctx.logger as unknown as { exporter(exporter: unknown): () => void }).exporter({
      levels: { default: 2 },
      export: (message: { name: string; type: string; args: unknown[] }) => logged.push(message),
    })
    const before = logged.length
    // The fixture owns the refusal: `open` returns a gate, the fixture awaits
    // the child's registered continuation, then rejects it. No clock involved.
    const gate = Promise.withResolvers<StubDomainHandle>()
    const opened = Promise.withResolvers<void>()
    const provider = await mountStorageDomain(app, {
      open: () => {
        opened.resolve()
        return gate.promise
      },
    })
    await opened.promise
    gate.reject(Object.assign(new Error('domain mstar_execution_binding_roots is already open'), { code: 'already-open' }))
    await flushQueuedContinuations()
    // ONE warning, carrying the refused cause AND the restart-then-resume
    // recovery — short tokens, not the whole sentence (copy edits must not red
    // the test).
    const added = logged.slice(before).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)
    expect(added).toHaveLength(1)
    expect(added[0]!.type).toBe('warn')
    expect(String(added[0]!.args[0])).toContain('already-open')
    expect(String(added[0]!.args[0])).toContain('restart')
    // The recovery names the resume shape the module's contract accepts.
    expect(String(added[0]!.args[0])).toContain('resume re-bind')
    // Nothing was installed: the receipt is the per-process map again.
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/adopted-root')
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe('/synthetic/adopted-root')
    // The adoption AFTER the refusal adds NO second warning: the refused `open`
    // already reported this absence with its true cause, so the generic "the
    // host provides no storage-domain seam" line (false here — the facility is
    // provided, only this `open` was refused) must not fire for it.
    const afterAdoption = logged.slice(before).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)
    expect(afterAdoption).toHaveLength(1)
    expect(String(afterAdoption[0]!.args[0])).toContain('open refused')
    expect(String(afterAdoption[0]!.args[0])).not.toContain('the host provides no storage-domain seam')
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
    // The plugin still mounts and answers today's fallback.
    storeHandles.push(await initializeStore({ harnessDir: app.harnessDir }))
    const refused = envelopeOf(await run(app.ctx, CLEAR_TOOL, agentOf(CHILD_ID, app.root), {}))
    expect(refused.code).toBe('execution.clear.no-binding')
    stopLogging()
    await provider.dispose()
  })

  it('an install failure after a successful open names the INSTALL cause, not "open refused", and its latch silences the generic absence line', async () => {
    const app = booted = await bootApp()
    const logged: Array<{ name: string; type: string; args: unknown[] }> = []
    const stopLogging = (app.ctx.logger as unknown as { exporter(exporter: unknown): () => void }).exporter({
      levels: { default: 2 },
      export: (message: { name: string; type: string; args: unknown[] }) => logged.push(message),
    })
    const before = logged.length
    let closed = 0
    // The OPEN succeeds; what fails is the install stage — the domain's
    // `table('roots')`, called while wiring the opened handle into the seam.
    // Reporting this as "open refused" would name a cause that is not true.
    const stub = stubFacilityOf({
      table: () => { throw new Error('the roots table is unavailable') },
      close: async () => { closed += 1 },
    })
    const provider = await mountStorageDomain(app, stub.facility)
    stub.settle()
    // Drain the microtasks of the open, the failed install and the close; both
    // are await-free for the fixture (no wall-clock wait).
    await new Promise<void>((resolve) => setImmediate(resolve))
    const added = logged.slice(before).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)
    expect(added).toHaveLength(1)
    expect(added[0]!.type).toBe('warn')
    const message = String(added[0]!.args[0])
    // The install-failure token, its own cause, and the named recovery.
    expect(message).toContain('install failed')
    expect(message).toContain('the roots table is unavailable')
    expect(message).toContain('restart')
    expect(message).toContain('resume re-bind')
    expect(message).not.toContain('open refused')
    // The opened handle was closed again, so the next apply can re-open the name.
    expect(closed).toBe(1)
    // ONE adoption: the truthful install-failure line already spent the one-shot
    // latch, so the generic "no storage-domain seam" line (false here — the
    // facility opened fine) must not follow it.
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/adopted-root')
    const afterAdoption = logged.slice(before).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)
    expect(afterAdoption).toHaveLength(1)
    expect(String(afterAdoption[0]!.args[0])).not.toContain('the host provides no storage-domain seam')
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe('/synthetic/adopted-root')
    stopLogging()
    await provider.dispose()
  })

  it('a rejected durable put is contained: the bind still completes, the cause is logged once, and the receipt still answers', async () => {
    const app = await bootedWithFixture()
    const adoptedRoot = await mkdtemp(join(tmpdir(), 'native-adopted-root-'))
    roots.push(adoptedRoot)
    await seedUnboundWorkflow(adoptedRoot, CHILD_ID)
    await mkdir(join(adoptedRoot, 'workflows', WORKFLOW_ID), { recursive: true })
    const logged: Array<{ name: string; type: string; args: unknown[] }> = []
    const stopLogging = (app.ctx.logger as unknown as { exporter(exporter: unknown): () => void }).exporter({
      levels: { default: 2 },
      export: (message: { name: string; type: string; args: unknown[] }) => logged.push(message),
    })
    const before = logged.length
    const stub = stubFacilityOf({
      table: () => ({
        get: () => undefined,
        put: async () => { throw new Error('durable table refused the write') },
        delete: async () => false,
      }),
      close: async () => {},
    })
    const provider = await mountStorageDomain(app, stub.facility)
    stub.settle()
    await stub.installed
    // The bind awaits the receipt's durable write, and its rejection must never
    // reach the native bind: the tool still answers ok, with the cause logged.
    const bound = envelopeOf(await run(app.ctx, BIND_TOOL, agentOf(CHILD_ID, app.root), {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: adoptedRoot,
    }))
    expect(bound.status).toBe('ok')
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe(adoptedRoot)
    const warned = logged.slice(before).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)
    expect(warned).toHaveLength(1)
    expect(warned[0]!.type).toBe('warn')
    expect(String(warned[0]!.args[0])).toContain('durable table refused the write')
    // The returned promise itself is contained: awaiting it cannot reject.
    await recordExecutionBindingRoot(PARENT_ID, app.root, '/synthetic/parent-root')
    expect(executionBindingRootOf(PARENT_ID, app.root)).toBe('/synthetic/parent-root')
    expect(logged.slice(before).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)).toHaveLength(2)
    stopLogging()
    await provider.dispose()
  })

  it('acks the bind only AFTER the durable receipt landed: a pending put holds the tool call open', async () => {
    // The assertion below is that the bind is still unanswered one macrotask
    // hop after the put started. On a starved runner that hop could outlast the
    // production 250 ms bound, which would answer the bind for the bound's
    // reason and read as "did not await the write" — the wrong cause. Raising
    // the bound (no clock wait) is what keeps THIS case about the ordering.
    setDurableReceiptBoundForTests(5_000)
    const app = await bootedWithFixture()
    const adoptedRoot = await mkdtemp(join(tmpdir(), 'native-adopted-root-'))
    roots.push(adoptedRoot)
    await seedUnboundWorkflow(adoptedRoot, CHILD_ID)
    await mkdir(join(adoptedRoot, 'workflows', WORKFLOW_ID), { recursive: true })
    const putGate = Promise.withResolvers<void>()
    const putStarted = Promise.withResolvers<void>()
    const stub = stubFacilityOf({
      table: () => ({
        get: () => undefined,
        put: async () => {
          putStarted.resolve()
          await putGate.promise
        },
        delete: async () => false,
      }),
      close: async () => {},
    })
    const provider = await mountStorageDomain(app, stub.facility)
    stub.settle()
    await stub.installed
    let answered = false
    const binding = run(app.ctx, BIND_TOOL, agentOf(CHILD_ID, app.root), {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: adoptedRoot,
    }).then((result) => {
      answered = true
      return result
    })
    // The adoption reached the durable put and is waiting on the backend. One
    // macrotask boundary runs every queued microtask (the whole tool surface),
    // so a bind that did not await the write would already have answered here.
    await putStarted.promise
    await new Promise((resolve) => setImmediate(resolve))
    try {
      // The receipt is the LAST statement before `return envelope`, so an
      // answered tool here could not have awaited the durable write.
      try {
        expect(answered).toBe(false)
      } finally {
        // Release the gate even when the assertion throws: a held gate would
        // leave the tool promise pending for good.
        putGate.resolve()
      }
      // The backend acknowledged; only now does the bind report success.
      expect(envelopeOf(await binding).status).toBe('ok')
    } finally {
      await provider.dispose()
    }
  })

  it('a durable put that never settles is bounded: the bind still answers from the overlay and the cause is logged once', async () => {
    const app = await bootedWithFixture()
    const adoptedRoot = await mkdtemp(join(tmpdir(), 'native-adopted-root-'))
    roots.push(adoptedRoot)
    await seedUnboundWorkflow(adoptedRoot, CHILD_ID)
    await mkdir(join(adoptedRoot, 'workflows', WORKFLOW_ID), { recursive: true })
    const logged: Array<{ name: string; type: string; args: unknown[] }> = []
    const stopLogging = (app.ctx.logger as unknown as { exporter(exporter: unknown): () => void }).exporter({
      levels: { default: 2 },
      export: (message: { name: string; type: string; args: unknown[] }) => logged.push(message),
    })
    const before = logged.length
    // The stalled backend: `put` resolves only after an acknowledgment this
    // fixture never gives until cleanup — the production bound must answer.
    const stalled = Promise.withResolvers<void>()
    const stub = stubFacilityOf({
      table: () => ({
        get: () => undefined,
        put: async () => { await stalled.promise },
        delete: async () => false,
      }),
      close: async () => {},
    })
    const provider = await mountStorageDomain(app, stub.facility)
    stub.settle()
    await stub.installed
    try {
      const bound = envelopeOf(await run(app.ctx, BIND_TOOL, agentOf(CHILD_ID, app.root), {
        execution: true,
        coordinator: true,
        workflow: WORKFLOW_ID,
        harness: adoptedRoot,
      }))
      // The bind answered even though the write never did: the overlay receipt
      // already answers, exactly as before the durable channel existed. The
      // timeout warning is the proof the bound fired (no clock assertion).
      expect(bound.status).toBe('ok')
      expect(executionBindingRootOf(CHILD_ID, app.root)).toBe(adoptedRoot)
      const warned = logged.slice(before).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)
      expect(warned).toHaveLength(1)
      expect(warned[0]!.type).toBe('warn')
      expect(String(warned[0]!.args[0])).toContain('not acknowledged')
    } finally {
      stopLogging()
      stalled.resolve()
      await provider.dispose()
    }
  })

  it('a rejected durable delete is contained: the clear resolves and the tombstone hides the root while the durable record survives', async () => {
    const app = booted = await bootApp()
    const logged: Array<{ name: string; type: string; args: unknown[] }> = []
    const stopLogging = (app.ctx.logger as unknown as { exporter(exporter: unknown): () => void }).exporter({
      levels: { default: 2 },
      export: (message: { name: string; type: string; args: unknown[] }) => logged.push(message),
    })
    const medium = new Map<string, string>()
    const uninstall = installExecutionBindingRootStore({
      get: (key) => medium.get(key),
      put: async (key, value) => { medium.set(key, value) },
      delete: async () => { throw new Error('durable table refused the delete') },
    })
    seamDisposers.push(uninstall)
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/adopted-root')

    const before = logged.length
    await clearExecutionBindingRoot(CHILD_ID, app.root)
    // The tombstone answers at once, even though the backend never removed the record.
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
    // With no in-process knowledge left, the durable record still answers: the
    // failed delete lost nothing.
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe('/synthetic/adopted-root')
    const warned = logged.slice(before).filter((row) => row.name === EXECUTION_BINDING_ROOTS_LOGGER)
    expect(warned).toHaveLength(1)
    expect(String(warned[0]!.args[0])).toContain('durable table refused the delete')
    stopLogging()
  })

  it('a delayed durable delete never blocks the read: the tombstone answers while the delete is in flight', async () => {
    const app = booted = await bootApp()
    const medium = new Map<string, string>()
    const backend = Promise.withResolvers<boolean>()
    let deletes = 0
    let landed = 0
    const uninstall = installExecutionBindingRootStore({
      get: (key) => medium.get(key),
      put: async (key, value) => { medium.set(key, value) },
      delete: async (key) => {
        deletes += 1
        const had = await backend.promise
        medium.delete(key)
        landed += 1
        return had
      },
    })
    seamDisposers.push(uninstall)
    await recordExecutionBindingRoot(CHILD_ID, app.root, '/synthetic/adopted-root')

    const clearing = clearExecutionBindingRoot(CHILD_ID, app.root)
    // The tombstone is synchronous: the read never waits on the backend.
    expect(deletes).toBe(1)
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
    // The durable delete has not landed — the read answered anyway.
    expect(landed).toBe(0)
    backend.resolve(true)
    await clearing
    expect(landed).toBe(1)
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
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

