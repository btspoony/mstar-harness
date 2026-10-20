/**
 * Task 2 (#526) — the native writable command surface — plus Task 5 (#530)'s
 * `mstar_execution_clear`, the dsh-native tool beyond the shared-command
 * mapping.
 *
 * The seven writable mstar commands (plan bind/prepare/progress/complete +
 * workflow register + issue add/close) are registered as native dsh tools over
 * `ctx.tools.register`, alongside the one dsh-native clear tool. Each command
 * tool calls the shared `@mstar-harness/commands`
 * implementation through its programmatic entry (`executeCommand`), and
 * injects `sessionId` from `exec.agent.id` — NEVER from model arguments.
 *
 * Every case boots the REAL-composition harness (the same plugin the dsh app
 * loads) and drives the tools through the REAL registry, while the execution
 * authority is a SYNTHETIC store fixture built by the engine's own producers
 * (initializeStore → catalog registration → createExecutionWorkflow, the
 * `execution-session.spec.ts` idiom) — the real control-root store in
 * `.mstar/` is never touched.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  createExecutionWorkflow,
  decodeExecutionSessionRef,
  encodeExecutionSessionRef,
  initializeStore,
  readDshScanBound,
  readExecutionState,
  registerCatalogEntity,
  resolveHarnessDir,
  resolveProcessHarnessDir,
} from '@mstar-harness/engine'
import type { ExecutionCaller, ExecutionContext, ExecutionSessionRef } from '@mstar-harness/engine'
import { readAgentFlow } from '../src/gates/agent-flow.ts'
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { WorkflowSessionBinding } from '../src/engine-status-store.ts'
import { clearExecutionBinding, resolveExecutionLedgerTarget } from '../src/gates/workflow-selection.ts'
import { adoptionRecoveryText } from '../src/gates/native-commands.ts'
import { executionBindingRootOf, recordExecutionBindingRoot, resetExecutionBindingRootsForTests } from '../src/gates/execution-binding-roots.ts'
import { awaitWorkflowLedgerIdle, setWorkflowLedgerLogger } from '../src/gates/workflow-ledger.ts'
import { bootApp, type BootResult } from './harness.ts'

const TS = '2026-09-21T00:00:00.000Z'
const WORKFLOW_ID = 'wf-native-commands'
const PLAN_ID = 'plan-native-commands'
const PARENT_ID = 'session-native-parent'
const CHILD_ID = 'session-native-child'

/** The named writable set (issue AC) — every tool the module must register: the 7 shared-command tools + the dsh-native clear (#530). */
const TOOL_NAMES = [
  'mstar_plan_bind',
  'mstar_plan_prepare',
  'mstar_plan_progress',
  'mstar_plan_complete',
  'mstar_workflow_register',
  'mstar_issue_add',
  'mstar_issue_close',
  'mstar_execution_clear',
] as const

let booted: BootResult | undefined
const roots: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  resetExecutionBindingRootsForTests()
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

/**
 * Narrow one successful bind envelope to the engine session reference its
 * receipt carries (both bind arms answer `ExecutionRead<ExecutionSessionRef>`
 * as the envelope `data`).
 */
function bindRefOf(envelope: Record<string, unknown>): ExecutionSessionRef {
  const receipt = envelope.data as { data?: ExecutionSessionRef } | undefined
  const ref = receipt?.data
  if (typeof ref !== 'object' || ref === null) throw new Error('the bind envelope carried no session reference receipt')
  return ref
}

/** The CHILD session's stored binding slot, narrowed through the read's own discriminant. */
function storedBinding(harnessDir: string, cwd: string): WorkflowSessionBinding | undefined {
  const read = readWorkflowSessionBinding(harnessDir, CHILD_ID, cwd)
  if (read.kind !== 'ok') throw new Error(`the binding slot read failed: ${read.reason}`)
  return read.binding
}

/**
 * Run one case with `MSTAR_HARNESS_DIR` removed, restoring the previous value
 * (present or absent) afterwards. `resolveHarnessDir` honours that environment
 * override ahead of any probe, so a case whose PREMISE is "the workspace
 * declares no harness" must not silently change meaning when a developer's
 * shell exports one — with the override in place the premise is wrong and the
 * assertion below fails on the developer's environment, never on the behavior.
 */
async function withoutHarnessEnv<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.MSTAR_HARNESS_DIR
  delete process.env.MSTAR_HARNESS_DIR
  try {
    return await body()
  } finally {
    if (saved === undefined) delete process.env.MSTAR_HARNESS_DIR
    else process.env.MSTAR_HARNESS_DIR = saved
  }
}

/**
 * The REAL execution authority at `harnessDir`: an initialized store, one
 * registered catalog plan, and one created lifecycle whose CREATING identity
 * is `coordinatorSessionId` — deliberately NOT bound, so the native
 * `mstar_plan_bind` call is the bind the lifecycle actually uses.
 */
async function seedUnboundWorkflow(harnessDir: string, coordinatorSessionId: string): Promise<void> {
  await mkdir(harnessDir, { recursive: true })
  const handle = await initializeStore({ harnessDir })
  handle.close()
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
        // The registered delivery source is the fixture feature branch — the
        // same branch the completion proof pins (complete re-checks the pair).
        branch: { source: 'feature/native-surface', target: 'main' },
      } as never,
      expected: rootToken,
      operationId: `create-${WORKFLOW_ID}`,
    },
  )
  if (created.data.workflows[0] === undefined) throw new Error('the fixture workflow was not created')
}

/** Run fixture Git with process-local signing and identity overrides; returns stdout (for rev-parse). */
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
 * A REAL Git fixture root: the root itself is the `main` control checkout (the
 * engine's control root is the harness dir's parent, so the harness must live
 * INSIDE a Git checkout), plus one linked feature worktree carrying one real
 * commit — `plan.prepare` validates the checkout/branch pair and
 * `plan.complete` verifies actual Git proof (HEAD sha, branch tip, review
 * ancestry) against that worktree.
 */
async function gitFixtureRoot(): Promise<{ root: string; worktree: string; sourceSha: string; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'native-commands-git-'))
  roots.push(root)
  const worktree = join(root, 'feature')
  git(['init', '-q', '-b', 'main'], root)
  await writeFile(join(root, 'seed.txt'), 'seed\n')
  git(['add', 'seed.txt'], root)
  git(['commit', '-q', '-m', 'fixture'], root)
  git(['worktree', 'add', '-q', worktree, '-b', 'feature/native-surface'], root)
  // One real commit on the feature branch: the completion proof pins it.
  await writeFile(join(worktree, 'change.txt'), 'change\n')
  git(['add', 'change.txt'], worktree)
  git(['commit', '-q', '-m', 'feature change'], worktree)
  const sourceSha = git(['rev-parse', 'HEAD'], worktree).trim()
  const baseSha = git(['rev-parse', 'main'], root).trim()
  return { root, worktree, sourceSha, baseSha }
}

/** Boot the composed app and seed the synthetic lifecycle for the CHILD session. */
async function bootedWithFixture(options: { sessions?: 'fake'; harnessDir?: null } = {}): Promise<BootResult & {
  featureWorktree: string
  sourceSha: string
  baseSha: string
  evidenceDir: string
}> {
  const fixture = await gitFixtureRoot()
  const app = booted = await bootApp({
    root: fixture.root,
    // The fake sessions service mounts the plugin's REAL workflow-ledger
    // consumer wiring (the two-root ledger-consumer regressions drive real
    // `tool-workflow/*` rows through it); absent, the consumer is disabled.
    ...(options.sessions === undefined ? {} : { sessionsService: options.sessions }),
    // `harnessDir: null` omits the boot-time config key, so the plugin's
    // resolver probes each session's workspace instead of answering one
    // constant. The default configured root would mask every
    // workspace-first workspace resolution defect: the resolver answers it
    // regardless of the carrying session's cwd.
    ...(options.harnessDir === undefined ? {} : { harnessDir: options.harnessDir }),
  })
  await seedUnboundWorkflow(app.harnessDir, CHILD_ID)
  // The evidence files live in the plan's own SDD area (the engine accepts
  // only absolute evidence paths inside {PLAN_DIR} / {SDD_DIR}/<plan-id>).
  const evidenceDir = join(app.harnessDir, 'sdd', PLAN_ID)
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(join(evidenceDir, 'qc.md'), 'qc consolidated report\n')
  await writeFile(join(evidenceDir, 'qa.md'), 'qa report\n')
  // The ledger-attribution resolver canonicalizes the REAL dir under
  // {WORKFLOW_DIR} (existsSync → statSync → realpathSync); the store fixture
  // registers the lifecycle but materializes no dir, so seed it — the same
  // idiom as the shared seedActiveWorkflow fixture.
  await mkdir(join(app.harnessDir, 'workflows', WORKFLOW_ID), { recursive: true })
  return Object.assign(app, {
    featureWorktree: fixture.worktree,
    sourceSha: fixture.sourceSha,
    baseSha: fixture.baseSha,
    evidenceDir,
  })
}

// ---------------------------------------------------------------------------
// Registration surface
// ---------------------------------------------------------------------------

describe('native command tool registration', () => {
  it('registers exactly the named writable set on ctx.tools', async () => {
    const app = booted = await bootApp()
    for (const name of TOOL_NAMES) {
      expect(app.ctx.tools.get(name)).toBeDefined()
    }
  })

  it('publishes no session-id parameter (identity is never model-supplied)', async () => {
    const app = booted = await bootApp()
    for (const name of TOOL_NAMES) {
      const tool = app.ctx.tools.get(name)
      expect(tool).toBeDefined()
      // ADR constraints 1–2: identity flows from exec.agent.id; the model face
      // carries no session selector a call could spoof.
      expect(Object.keys(tool!.parameters ?? {})).not.toContain('sessionId')
    }
  })

  it('describes flattened json payloads mechanically from the published schema', async () => {
    const app = booted = await bootApp()
    const propertiesOf = (name: string): Record<string, { description?: string }> => {
      // The registry's get returns the compiled tool: its parameter root is
      // the implicit object root, so the authored specs live under
      // `properties`.
      const parameters = app.ctx.tools.get(name)!.parameters as { properties?: Record<string, { description?: string }> } | undefined
      return parameters?.properties ?? {}
    }
    // `plan.complete`'s evidence is a shaped object whose qc/qa members are
    // REQUIRED: the description must name them (and their own members) so a
    // caller can construct a valid payload without guessing.
    const evidence = propertiesOf('mstar_plan_complete').evidence
    expect(evidence?.description).toBeDefined()
    for (const member of ['qc', 'qa', 'decision', 'reports', 'consolidated', 'gate', 'report']) {
      expect(evidence!.description).toContain(member)
    }
    // `issue.add`'s payload input node is a permissive placeholder; the
    // description is derived from the payload descriptor's own published
    // schema (CaptureInput) instead.
    const payload = propertiesOf('mstar_issue_add').payload
    expect(payload?.description).toBeDefined()
    for (const member of ['projectId', 'title', 'kind', 'severity', 'rootCauseKey', 'discoveredAt']) {
      expect(payload!.description).toContain(member)
    }
    // Scalar fields stay help-only: the derivation never invents text for a
    // typed node.
    const workflow = propertiesOf('mstar_plan_bind').workflow
    expect(workflow?.description ?? '').not.toContain('Payload:')
  })
})

// ---------------------------------------------------------------------------
// (F) mstar_issue_close — the root-union parameter contract. `issue.close`
// validates through a z.union (one branch per terminal disposition), so its
// published schema has no top-level `properties`: the parameter spec must
// project the union's object branches into callable parameters instead of
// publishing an empty table.
// ---------------------------------------------------------------------------

/** One captured-issue payload with the registry's own required field set. */
const capturePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectId: 'issue-close-spec',
  title: 'Stale chunk bound in the workflow script',
  kind: 'bug',
  severity: 'medium',
  impact: 'the pool bound can silently regress',
  acceptance: 'the bound is pinned by a host-independent check',
  sourceIdentity: 'issue-close-spec/stale-chunk',
  rootCauseKey: 'chunk-root-cause',
  acceptanceKey: 'chunk-acceptance',
  occurrenceKey: 'chunk-occ-1',
  sourceKind: 'qc',
  location: 'skills/mstar-host/references/dsh-workflow-scripts.md',
  observedBehavior: 'observed by the spec fixture',
  evidence: ['fixture evidence'],
  discoveredAt: '2026-10-19T00:00:00Z',
  ...overrides,
})

describe('mstar_issue_close parameter contract (root union projection)', () => {
  const propertiesOf = (tool: { parameters?: unknown }): Record<string, { required?: boolean; description?: string }> => {
    const parameters = tool.parameters as { properties?: Record<string, { required?: boolean; description?: string }> } | undefined
    return parameters?.properties ?? {}
  }

  it('publishes id/actor/expect from the anyOf branches, with branch requirements as description text', async () => {
    const app = booted = await bootApp()
    const tool = app.ctx.tools.get('mstar_issue_close')!
    const properties = propertiesOf(tool)
    // The compiled registry tool collects per-property `required: true` into
    // the schema's top-level required list — the same projection the model
    // face sees.
    const required = ((tool.parameters as { required?: string[] }).required ?? [])
    for (const field of ['id', 'actor', 'expect']) {
      expect(properties[field], `${field} must be published`).toBeDefined()
      expect(required, `${field} must be required`).toContain(field)
    }
    // The payload field carries the complete ClosureEvidence contract through
    // the payload-summary path.
    expect(properties.payload?.description).toContain('reason')
    // Branch-specific requirements carry as description text, never as a
    // second validation layer: the disposition names the const branches that
    // require it versus the default branch that omits it.
    const disposition = properties.disposition?.description ?? ''
    expect(disposition).toContain('required on')
    expect(disposition).toContain('resolved')
    expect(disposition).toContain('default')
    // A field every branch requires gains no union text (the required mark
    // already says it).
    expect(properties.id?.description ?? '').not.toContain('required on')
  })

  it('a valid close built from the published contract reaches the shared execution path', async () => {
    const app = booted = await bootApp()
    ;(await initializeStore({ harnessDir: app.harnessDir })).close()
    const child = agentOf(CHILD_ID, app.root)
    const added = envelopeOf(await run(app.ctx, 'mstar_issue_add', child, {
      actor: 'project-manager',
      payload: capturePayload(),
    }))
    expect(added.status).toBe('ok')
    const receipt = added.data as { issueId: string; revision: number }
    const closed = envelopeOf(await run(app.ctx, 'mstar_issue_close', child, {
      id: receipt.issueId,
      actor: 'project-manager',
      expect: receipt.revision,
      payload: { reason: 'verified fixed by the fixture', references: ['docs/fixture.md'], alignmentRef: 'plan-fixture' },
    }))
    expect(closed.status).toBe('ok')
    expect(closed.command).toBe('issue.close')
  })
})

// ---------------------------------------------------------------------------
// (a) plan lifecycle from native tools alone
// ---------------------------------------------------------------------------

describe('native plan lifecycle — bind → prepare → progress → complete', () => {
  it('completes the lifecycle shell-free with the caller identity, ignoring a model-supplied session id', async () => {
    const app = await bootedWithFixture()
    // The session cwd is the control checkout; the prepare gate validates the
    // linked feature worktree + branch pair.
    const child = agentOf(CHILD_ID, app.root)
    const worktree = app.featureWorktree

    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      // A model MUST NOT be able to choose the identity: this argument is
      // stripped before admission and the caller's own id is injected.
      sessionId: 'model-spoofed-session',
    }))
    expect(bound.status).toBe('ok')

    const prepared = envelopeOf(await run(app.ctx, 'mstar_plan_prepare', child, {
      workflow: WORKFLOW_ID,
      plan: PLAN_ID,
      worktreePath: worktree,
      workingBranch: 'feature/native-surface',
    }))
    expect(prepared.status).toBe('ok')

    const progressed = envelopeOf(await run(app.ctx, 'mstar_plan_progress', child, {
      workflow: WORKFLOW_ID,
      plan: PLAN_ID,
      progress: { status: 'InProgress', summary: 'native surface progress', evidence_paths: [] },
    }))
    expect(progressed.status).toBe('ok')

    const completed = envelopeOf(await run(app.ctx, 'mstar_plan_complete', child, {
      workflow: WORKFLOW_ID,
      plan: PLAN_ID,
      // The REAL Git proof the engine verifies: the feature worktree's pinned
      // HEAD (review_head = source_sha), with main as the review base.
      evidence: {
        source_sha: app.sourceSha,
        review_base: app.baseSha,
        review_head: app.sourceSha,
        qc: {
          decision: 'Approve',
          reports: [join(app.evidenceDir, 'qc.md')],
          consolidated: join(app.evidenceDir, 'qc.md'),
        },
        qa: { gate: 'mandatory', decision: 'pass', report: join(app.evidenceDir, 'qa.md') },
      },
    }))
    expect(completed.status).toBe('ok')

    // The lifecycle's coordinator binding is the CALLER's id — not the spoofed
    // argument, not the parent's.
    const state = await readExecutionState({ harnessDir: app.harnessDir })
    expect(state.data.workflows[0]?.coordinator?.sessionId).toBe(CHILD_ID)
  })
})

// ---------------------------------------------------------------------------
// (b) leaf-vs-parent identity
// ---------------------------------------------------------------------------

describe('native identity — a leaf call carries its own id, never the parent id', () => {
  it('binds the child session and refuses the parent on the same workflow', async () => {
    const app = await bootedWithFixture()
    expect(CHILD_ID).not.toEqual(PARENT_ID)
    const child = agentOf(CHILD_ID, app.root)
    const parent = agentOf(PARENT_ID, app.root)

    // The CHILD binds with its own id: the engine's owner check accepts it.
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(bound.status).toBe('ok')
    const state = await readExecutionState({ harnessDir: app.harnessDir })
    expect(state.data.workflows[0]?.coordinator?.sessionId).toBe(CHILD_ID)

    // The PARENT's call arrives with the parent's id (if the tool leaked the
    // child's id here, the engine could not tell the callers apart) and the
    // engine refuses the second coordinator on the bound workflow.
    const parentResult = await run(app.ctx, 'mstar_plan_bind', parent, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    })
    const parentEnvelope = envelopeOf(parentResult)
    expect(parentEnvelope.status).not.toBe('ok')
    // The binding is unchanged: still the child's, never the parent's.
    const after = await readExecutionState({ harnessDir: app.harnessDir })
    expect(after.data.workflows[0]?.coordinator?.sessionId).toBe(CHILD_ID)
  })
})

// ---------------------------------------------------------------------------
// (b2) the fail-closed leaf-seat guard — a known leaf can never mint a
// coordinator seat (the guard #530 deleted, restored on the native surface)
// ---------------------------------------------------------------------------

describe('native leaf-seat refusal — a known leaf can never mint a coordinator seat', () => {
  it('refuses a REAL subagent-origin leaf on plan bind: named error, no binding, no engine seat', async () => {
    const app = await bootedWithFixture()
    // A REAL leaf header (origin: 'subagent') — not merely a second session.
    const leaf = agentOf(CHILD_ID, app.root, { origin: 'subagent' })
    const refused = envelopeOf(await run(app.ctx, 'mstar_plan_bind', leaf, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(refused.status).toBe('refused')
    expect(refused.code).toBe('plan.bind.leaf-seat')
    // The named error the removed execution-session guard threw.
    expect(String(refused.message).split('\n')[0]).toBe('known leaf sessions cannot adopt, clear, or run on any operation')
    expect(refused.exitCode).not.toBe(0)
    // No durable binding was written…
    expect(storedBinding(app.harnessDir, app.root)?.executionBinding ?? null).toBeNull()
    // …and the engine holds no coordinator seat for the leaf's id.
    const state = await readExecutionState({ harnessDir: app.harnessDir })
    expect(state.data.workflows[0]?.coordinator ?? null).toBeNull()
  })

  it('delegation depth alone marks a leaf: bind, complete and clear all refuse fail-closed', async () => {
    const app = await bootedWithFixture()
    const leaf = agentOf(CHILD_ID, app.root, { delegationDepth: 2 })
    const bindRefused = envelopeOf(await run(app.ctx, 'mstar_plan_bind', leaf, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(bindRefused.status).toBe('refused')
    expect(bindRefused.code).toBe('plan.bind.leaf-seat')
    const completeRefused = envelopeOf(await run(app.ctx, 'mstar_plan_complete', leaf, {
      workflow: WORKFLOW_ID,
      plan: PLAN_ID,
    }))
    expect(completeRefused.status).toBe('refused')
    expect(completeRefused.code).toBe('plan.complete.leaf-seat')
    const clearRefused = envelopeOf(await run(app.ctx, 'mstar_execution_clear', leaf, {}))
    expect(clearRefused.status).toBe('refused')
    expect(clearRefused.code).toBe('execution.clear.leaf-seat')
    // None of the three refused calls wrote a binding or a seat.
    expect(storedBinding(app.harnessDir, app.root)?.executionBinding ?? null).toBeNull()
    const state = await readExecutionState({ harnessDir: app.harnessDir })
    expect(state.data.workflows[0]?.coordinator ?? null).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (c2) A refused bind surfaces the ENGINE's refusal verbatim: the
// adoption narrowing never rewrites a non-ok envelope as a dsh-side
// binding refusal, even when the bind arms were requested.
// ---------------------------------------------------------------------------

describe('refused bind envelope passes through verbatim (no adoption rewrite)', () => {
  it('a refused bind with execution: true carries the engine refusal, never binding.receipt-unrecognizable', async () => {
    const app = await bootedWithFixture()
    const child = agentOf(CHILD_ID, app.root)
    // A REAL bind first: the workflow then holds CHILD's coordinator seat, so
    // the SECOND bind below is refused by the ENGINE (occupied coordinator) —
    // with execution: true, i.e. exactly the input the adoption narrowing
    // would otherwise read as a bind arm.
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(bound.status).toBe('ok')
    const parent = agentOf(PARENT_ID, app.root)
    const refused = envelopeOf(await run(app.ctx, 'mstar_plan_bind', parent, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(refused.status).toBe('refused')
    // Verbatim: the engine's own refusal code and message — never the
    // dsh-side adoption refusal the receipt narrowing would mint.
    expect(refused.code).not.toBe('binding.receipt-unrecognizable')
    expect(String(refused.code).startsWith('binding.')).toBe(false)
    expect(String(refused.message)).not.toContain('no recognizable execution session reference')
    expect(String(refused.message)).not.toContain('execution binding was NOT adopted')
    expect(refused.command).toBe('plan.bind')
    // The refusal exits non-zero like every engine refusal.
    expect(refused.exitCode).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (c) engine refusal envelope surfaces verbatim
// ---------------------------------------------------------------------------

describe('engine refusal surface', () => {
  it('surfaces a stale-token CAS refusal verbatim, with no second validation layer', async () => {
    const app = await bootedWithFixture()
    const child = agentOf(CHILD_ID, app.root)
    expect(envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    })).status).toBe('ok')

    const refused = envelopeOf(await run(app.ctx, 'mstar_plan_progress', child, {
      workflow: WORKFLOW_ID,
      plan: PLAN_ID,
      // A forged/stale CAS token: only the ENGINE can judge this — the tool
      // must not pre-validate it away.
      expect: 'mstar-forged-stale-token',
      progress: { status: 'InProgress', summary: 'stale token call', evidence_paths: [] },
    }))
    expect(refused.version).toBe(1)
    expect(refused.command).toBe('plan.progress')
    expect(refused.status).toBe('refused')
    // The message is the engine's own refusal text, not a dsh-side paraphrase.
    expect(typeof refused.message).toBe('string')
    expect(refused.message).toMatch(/coordination\.|token|revision|expect/i)
    // The exit code and envelope code travel through untouched.
    expect(refused.exitCode).not.toBe(0)
  })

  it('surfaces an admission usage refusal verbatim for a missing required field', async () => {
    const app = await bootedWithFixture()
    const child = agentOf(CHILD_ID, app.root)
    const refused = envelopeOf(await run(app.ctx, 'mstar_plan_prepare', child, {
      // workflow + plan + worktreePath + workingBranch are required by the
      // engine path; an empty call is a usage refusal from the shared
      // admission, verbatim.
    }))
    expect(refused.status).toBe('usage')
    expect(refused.command).toBe('plan.prepare')
    expect(typeof refused.message).toBe('string')
    expect(Array.isArray(refused.details)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (d) HMR disposal
// ---------------------------------------------------------------------------

describe('HMR disposal', () => {
  it('unregisters the native tools on fiber.dispose (a post-dispose get finds none)', async () => {
    const app = booted = await bootApp()
    for (const name of TOOL_NAMES) {
      expect(app.ctx.tools.get(name)).toBeDefined()
    }
    expect(app.pluginFiber).toBeDefined()
    await app.pluginFiber!.dispose()
    for (const name of TOOL_NAMES) {
      expect(app.ctx.tools.get(name)).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// (e) Task 3 (#527) — binding adoption on the native path
// ---------------------------------------------------------------------------

describe('native binding adoption — a native plan bind persists the executionBinding slot', () => {
  it('adopts the engine-minted reference after plan bind --execution, preserves the session selection, and the ledger resolves with no slash command', async () => {
    const app = await bootedWithFixture()
    // A pre-existing durable selection (the picker pick + exclusion floor)
    // must survive adoption untouched.
    expect(updateWorkflowSessionBinding(app.harnessDir, CHILD_ID, app.root, {
      selectedWorkflowId: WORKFLOW_ID,
      excludedBeforeSeq: 7,
    }).kind).toBe('written')
    const child = agentOf(CHILD_ID, app.root)

    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(bound.status).toBe('ok')

    const binding = storedBinding(app.harnessDir, app.root)
    // The adopted reference is the engine's own mint — the canonical C1
    // binding naming the carrying session, not a dsh-invented record.
    expect(binding?.executionBinding?.version).toBe(1)
    expect(binding?.executionBinding?.harnessRoot).toBe(realpathSync(app.harnessDir))
    expect(binding?.executionBinding?.session.workflowId).toBe(WORKFLOW_ID)
    expect(binding?.executionBinding?.session.sessionId).toBe(CHILD_ID)
    expect(binding?.executionBinding?.session.role).toBe('coordinator')
    // The user selection is preserved: the adopted workflow becomes the
    // stored pick and the exclusion floor is kept (merged, never reset).
    expect(binding?.selectedWorkflowId).toBe(WORKFLOW_ID)
    expect(binding?.excludedBeforeSeq).toBe(7)

    // Ledger attribution works with NO slash command: the workflow resolves
    // from the binding slot this bind populated.
    const target = await resolveExecutionLedgerTarget(CHILD_ID, app.root)
    expect(target).not.toBeNull()
    expect(target?.workflowId).toBe(WORKFLOW_ID)
    // The F-207 boundary canonicalizes the dir (realpathSync), so the
    // expected value is the fixture dir's own realpath.
    expect(target?.workflowDir).toBe(realpathSync(join(app.harnessDir, 'workflows', WORKFLOW_ID)))
    expect(target?.sessionId).toBe(CHILD_ID)
  })

  it('refuses foreign, copied and stale references and never adopts them', async () => {
    const app = await bootedWithFixture()
    const child = agentOf(CHILD_ID, app.root)
    // A REAL native bind first: it mints the canonical ref the forged ones
    // derive from, and its adoption is the baseline the clears reset.
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(bound.status).toBe('ok')
    const real = bindRefOf(bound)

    const forged: Array<[string, Partial<ExecutionSessionRef>]> = [
      // A reference that names another session (the same first check the
      // slash adoption made — the carrying session must match).
      ['foreign', { sessionId: 'other-session' }],
      // The right session, a foreign store: the engine resume refuses it.
      ['copied', { storeId: '00000000-0000-4000-8000-000000000009' }],
      // A superseded epoch: the engine resume refuses it.
      ['stale', { epoch: real.epoch + 1 }],
      // A reference whose scope names a DIFFERENT workflow (the fourth
      // refused class of the AC): the engine's session read refuses it, and
      // the dsh-side resumed-receipt re-check below never sees an ok.
      ['scope-mismatched', { workflowId: 'wf-other-scope' }],
    ]
    for (const [label, override] of forged) {
      // Clear the adopted baseline so "nothing adopted" is observable per case.
      expect(clearExecutionBinding(app.harnessDir, CHILD_ID, app.root)).toBe(true)
      const result = await run(app.ctx, 'mstar_plan_bind', child, {
        resumeRef: encodeExecutionSessionRef({ ...real, ...override }),
      })
      const envelope = envelopeOf(result)
      expect(envelope.status, `${label} reference must be refused`).not.toBe('ok')
      expect(
        storedBinding(app.harnessDir, app.root)?.executionBinding ?? null,
        `${label} reference must never be adopted`,
      ).toBeNull()
    }
  })

  it('adopts only after the engine resume succeeds — the slot write carries the resumed receipt and a refused resume writes nothing', async () => {
    const app = await bootedWithFixture()
    const child = agentOf(CHILD_ID, app.root)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(bound.status).toBe('ok')
    const real = bindRefOf(bound)

    // Clear, then re-adopt through the RESUME arm with the engine's own
    // reference: the slot write carries exactly the resumed receipt's ref.
    expect(clearExecutionBinding(app.harnessDir, CHILD_ID, app.root)).toBe(true)
    const resumed = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      resumeRef: encodeExecutionSessionRef(real),
    }))
    expect(resumed.status).toBe('ok')
    const binding = storedBinding(app.harnessDir, app.root)
    expect(binding?.executionBinding?.session).toEqual(real)
    expect(binding?.selectedWorkflowId).toBe(WORKFLOW_ID)
    const target = await resolveExecutionLedgerTarget(CHILD_ID, app.root)
    expect(target?.workflowId).toBe(WORKFLOW_ID)

    // The ordering fact: a stale-epoch resume is refused BEFORE any slot
    // write, so the adopted baseline above survives untouched.
    const refused = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      resumeRef: encodeExecutionSessionRef({ ...real, epoch: real.epoch + 1 }),
    }))
    expect(refused.status).not.toBe('ok')
    expect(storedBinding(app.harnessDir, app.root)?.executionBinding?.session).toEqual(real)
  })

  it('adopts into the harness the bind itself selected (explicit per-call harness), never the workspace harness', async () => {
    // REGRESSION: the bind's explicit `harness` names the control root the
    // engine bind commits in — the adoption's engine resume and the durable
    // slot write MUST land in THAT root. Deriving the adoption target from the
    // workspace resolver alone runs the resume against (or lands the slot
    // under) the wrong root.
    const app = await bootedWithFixture()
    // Root B: a second, distinct control harness with its own store + lifecycle.
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    await mkdir(join(harnessB, 'workflows', WORKFLOW_ID), { recursive: true })

    // The carrying session's workspace IS root A (app.root); the bind names root B.
    const child = agentOf(CHILD_ID, app.root)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(bound.status).toBe('ok')

    // The slot lands BESIDE the bind it adopted — root B, never the workspace root.
    const bindingB = storedBinding(harnessB, app.root)
    expect(bindingB?.executionBinding?.version).toBe(1)
    expect(bindingB?.executionBinding?.harnessRoot).toBe(harnessB)
    expect(bindingB?.executionBinding?.session.workflowId).toBe(WORKFLOW_ID)
    expect(bindingB?.executionBinding?.session.sessionId).toBe(CHILD_ID)
    expect(storedBinding(app.harnessDir, app.root)).toBeUndefined()

    // The engine coordinator seat lives in root B's store, not root A's.
    const stateB = await readExecutionState({ harnessDir: harnessB })
    expect(stateB.data.workflows[0]?.coordinator?.sessionId).toBe(CHILD_ID)
    const stateA = await readExecutionState({ harnessDir: app.harnessDir })
    expect(stateA.data.workflows[0]?.coordinator ?? null).toBeNull()
  })

  it('resolves a RELATIVE explicit harness to an absolute root before the adoption and the receipt', async () => {
    // REGRESSION: the shared admission resolves an explicit `harness` with
    // `resolve(context.cwd, input.harness)` and the engine bind commits in that
    // ABSOLUTE root, so the adoption must record the same absolute root.
    // Recording the RAW relative string makes the stored `harnessRoot`, the
    // receipt root and the ledger target disagree with the store the bind
    // actually wrote.
    const app = await bootedWithFixture()
    // The carrying workspace holds the control harness BELOW it, selected
    // relatively — resolved against the same lexical base the shared admission
    // uses (the session workspace).
    const workspace = await mkdtemp(join(tmpdir(), 'native-commands-relative-'))
    roots.push(workspace)
    const relativeHarness = join('control', '.mstar')
    const harnessRoot = join(workspace, relativeHarness)
    await seedUnboundWorkflow(harnessRoot, CHILD_ID)
    await mkdir(join(harnessRoot, 'workflows', WORKFLOW_ID), { recursive: true })

    const child = agentOf(CHILD_ID, workspace)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: relativeHarness,
    }))
    expect(bound.status).toBe('ok')

    // The stored binding, the receipt root and the ledger target all name the
    // ONE absolute root the engine bound in — the resolved RELATIVE selector,
    // never the raw string the call passed.
    const expectedRoot = resolve(workspace, relativeHarness)
    expect(storedBinding(harnessRoot, workspace)?.executionBinding?.harnessRoot).toBe(expectedRoot)
    expect(executionBindingRootOf(CHILD_ID, workspace)).toBe(expectedRoot)
    const target = await resolveExecutionLedgerTarget(CHILD_ID, workspace)
    expect(target?.harnessDir).toBe(expectedRoot)
    expect(target?.workflowId).toBe(WORKFLOW_ID)
  })

  it('resolves the FULL consumer chain from the harness the bind selected: attribution and clear act on root B, root A is never written', async () => {
    // REGRESSION: the adoption writes the durable slot into the harness the
    // bind selected, so the CONSUMERS must resolve that root instead of
    // re-deriving the harness from the workspace. Re-deriving resolves root A,
    // drops the binding in attribution, and answers `no-binding` against A
    // while B holds the slot. The chain below is the fixed behavior: bind to
    // B → the ledger attribution resolves FROM B → the native clear clears B
    // → root A is never written at any step.
    const app = await bootedWithFixture()
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    await mkdir(join(harnessB, 'workflows', WORKFLOW_ID), { recursive: true })

    const child = agentOf(CHILD_ID, app.root)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(bound.status).toBe('ok')

    // 1. The ledger attribution resolves from B: the target names B's
    //    workflow dir and carries B as its harness dir (the store the
    //    ledger's scan bound and event append act in). The workflow dir is
    //    canonicalized by the ledger boundary (realpath), so the comparison
    //    canonicalizes B's side too.
    const target = await resolveExecutionLedgerTarget(CHILD_ID, app.root)
    expect(target?.workflowId).toBe(WORKFLOW_ID)
    expect(target?.sessionId).toBe(CHILD_ID)
    expect(target?.harnessDir).toBe(harnessB)
    expect(target?.workflowDir !== undefined &&
      realpathSync(target.workflowDir) === realpathSync(join(harnessB, 'workflows', WORKFLOW_ID))).toBe(true)

    // 2. The native clear clears B — and only B. The workspace root answers
    //    with no record both before and after; the selection survives in B.
    const cleared = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    expect(cleared.status).toBe('ok')
    expect(cleared.command).toBe('execution.clear')
    const bindingAfterClear = storedBinding(harnessB, app.root)
    expect(bindingAfterClear?.executionBinding ?? null).toBeNull()
    expect(bindingAfterClear?.selectedWorkflowId).toBe(WORKFLOW_ID)
    // The attribution is detached with the slot (the same fact the single-root
    // clear guarantees): no durable execution binding, no ledger target.
    expect(await resolveExecutionLedgerTarget(CHILD_ID, app.root)).toBeNull()
    // Root A was never written by ANY step of the chain — no adoption slot, no
    // clear residue, no record at all.
    expect(storedBinding(app.harnessDir, app.root)).toBeUndefined()
    const stateA = await readExecutionState({ harnessDir: app.harnessDir })
    expect(stateA.data.workflows[0]?.coordinator ?? null).toBeNull()

    // 3. With the receipt dropped, a second clear answers the named
    //    no-binding refusal (nothing left to clear anywhere).
    const again = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    expect(again.status).toBe('refused')
    expect(again.code).toBe('execution.clear.no-binding')
  })

  it('feeds real rows through the ledger CONSUMER from the SELECTED root: the B floor governs gate, bound and append; the A floor never filters', async () => {
    // REGRESSION: the ledger's binding guard and exclusion floor must resolve
    // the same root the append goes to; re-deriving them from the WORKSPACE
    // root filtered root B's events through root A's floor. The consumer below
    // is the plugin's real wiring (bootApp sessionsService:'fake' →
    // registerWorkflowLedger) and the rows are real `tool-workflow/*`
    // envelopes; the floors are DIFFERENT per root.
    const app = await bootedWithFixture({ sessions: 'fake' })
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    await mkdir(join(harnessB, 'workflows', WORKFLOW_ID), { recursive: true })

    const child = agentOf(CHILD_ID, app.root)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(bound.status).toBe('ok')

    // DIFFERENT A/B floors (each store merges by max, so the order below is
    // not load-bearing): A's floor excludes EVERY row of this fixture's log,
    // B's floor excludes only its first row.
    expect(updateWorkflowSessionBinding(app.harnessDir, CHILD_ID, app.root, { excludedBeforeSeq: 50 }).kind).toBe('written')
    expect(updateWorkflowSessionBinding(harnessB, CHILD_ID, app.root, { excludedBeforeSeq: 1 }).kind).toBe('written')

    // A REAL structural session carrying two tool-workflow/run-start rows:
    // seq 0 is B-excluded (0 < 1), seq 1 is B-legitimate (1 >= 1) yet
    // A-excluded (1 < 50).
    const session = {
      header: { id: CHILD_ID, cwd: app.root, createdAt: 1_700_000_000_000 },
      seq: 2,
      inheritedEventCount: 0,
      eventAt: (seq: number) =>
        seq === 0
          ? { type: 'tool-workflow/run-start', seq: 0, time: 1_700_000_000_001, data: { runId: 'b-excluded', name: 'b-excluded' } }
          : seq === 1
            ? { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_002, data: { runId: 'b-legitimate', name: 'b-legitimate' } }
            : undefined,
    }
    ;(app.ctx.get('sessions') as unknown as { register(session: unknown): void }).register(session)

    // Live route first (the consume path's guard + floor): the pre-fix ledger
    // read A's floor (50) here and dropped BOTH rows.
    app.ctx.events.emit({}, 'session/event', session, session.eventAt(0))
    app.ctx.events.emit({}, 'session/event', session, session.eventAt(1))
    await awaitWorkflowLedgerIdle()
    const ledgerB = join(harnessB, 'workflows', WORKFLOW_ID)
    expect(readAgentFlow(ledgerB, WORKFLOW_ID)?.events.map((event) => event.kind === 'workflow-run' ? event.runId : event.kind)).toEqual(['b-legitimate'])
    expect(readDshScanBound({ harnessDir: harnessB }, WORKFLOW_ID, CHILD_ID)).toMatchObject({ next: 2 })

    // Cold-scan route (the scanStartSeq bound): the rescan starts AT the B
    // floor, replays the one accepted identity and records nothing new.
    app.ctx.events.emit({}, 'session/created', session)
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(ledgerB, WORKFLOW_ID)?.events.map((event) => event.kind === 'workflow-run' ? event.runId : event.kind)).toEqual(['b-legitimate'])
    expect(readDshScanBound({ harnessDir: harnessB }, WORKFLOW_ID, CHILD_ID)).toMatchObject({ next: 2 })

    // Root A: no rows, no scan bound, floor untouched at 50 — the A floor sat
    // there the whole time and filtered nothing on B.
    expect(readAgentFlow(join(app.harnessDir, 'workflows', WORKFLOW_ID), WORKFLOW_ID)?.events ?? []).toEqual([])
    expect(readDshScanBound({ harnessDir: app.harnessDir }, WORKFLOW_ID, CHILD_ID)).toBeUndefined()
    expect(storedBinding(app.harnessDir, app.root)?.excludedBeforeSeq).toBe(50)
  })

  it('keeps attribution alive when the WORKSPACE root\'s binding store is unreadable and the selected root stays healthy', async () => {
    // REGRESSION (the guard half): the pre-fix ledger read its
    // binding guard from the workspace harness, so an unreadable A store
    // paused attribution for a valid B binding.
    //
    // Unreadable-A mechanism: A's `store.db` is REPLACED by a new file of
    // garbage bytes (rename first, so the engine's inode-keyed probe
    // connection cache misses and the fresh open fails SQLITE_NOTADB →
    // `readWorkflowSessionBinding` answers `unavailable`). No fixture seam
    // swap is involved.
    const app = await bootedWithFixture({ sessions: 'fake' })
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    await mkdir(join(harnessB, 'workflows', WORKFLOW_ID), { recursive: true })

    const child = agentOf(CHILD_ID, app.root)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(bound.status).toBe('ok')

    await rename(join(app.harnessDir, 'store.db'), join(app.harnessDir, 'store.db.fixture-backup'))
    await writeFile(join(app.harnessDir, 'store.db'), 'this is not a sqlite database')

    const warnings: string[] = []
    const previousLogger = setWorkflowLedgerLogger((level, message) => {
      if (level === 'warn') warnings.push(message)
    })
    try {
      const session = {
        header: { id: CHILD_ID, cwd: app.root, createdAt: 1_700_000_000_100 },
        seq: 1,
        inheritedEventCount: 0,
        eventAt: (seq: number) => seq === 0
          ? { type: 'tool-workflow/run-start', seq: 0, time: 1_700_000_000_101, data: { runId: 'b-guard-run', name: 'b-guard-run' } }
          : undefined,
      }
      ;(app.ctx.get('sessions') as unknown as { register(session: unknown): void }).register(session)
      app.ctx.events.emit({}, 'session/created', session)
      await awaitWorkflowLedgerIdle()

      // The row landed through the SELECTED root's healthy store — A's broken
      // binding store never paused it (no attribution-paused warn either).
      expect(readAgentFlow(join(harnessB, 'workflows', WORKFLOW_ID), WORKFLOW_ID)?.events)
        .toMatchObject([{ kind: 'workflow-run', runId: 'b-guard-run' }])
      expect(readDshScanBound({ harnessDir: harnessB }, WORKFLOW_ID, CHILD_ID)).toMatchObject({ next: 1 })
      expect(readAgentFlow(join(app.harnessDir, 'workflows', WORKFLOW_ID), WORKFLOW_ID)?.events ?? []).toEqual([])
      expect(warnings.some((message) => message.includes('attribution paused'))).toBe(false)
    } finally {
      setWorkflowLedgerLogger(previousLogger)
    }
  })

  it('attributes real ledger rows from the adoption receipt when the workspace declares NO harness', () => withoutHarnessEnv(async () => {
    // REGRESSION: the ledger target resolver must read the adoption receipt
    // BEFORE probing the carrying WORKSPACE; probing first answers null for a
    // native bind into another control root from a workspace with no harness at
    // all, and every ledger row of the valid binding is then dropped. Below:
    // bind into B from such a workspace, then drive a real
    // `tool-workflow/run-start` row through the plugin's real consumer.
    const app = await bootedWithFixture({ sessions: 'fake' })
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    await mkdir(join(harnessB, 'workflows', WORKFLOW_ID), { recursive: true })
    // The carrying workspace declares NO harness: no `.mstar` / `.agents` /
    // `.plans` / `.mstarc` under it, so the engine's own probe answers null.
    const workspace = await mkdtemp(join(tmpdir(), 'native-commands-workspace-'))
    roots.push(workspace)
    expect(resolveHarnessDir(workspace, { workspaceRoot: workspace })).toBeNull()

    const child = agentOf(CHILD_ID, workspace)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(bound.status).toBe('ok')

    // (a) The target resolves from the receipt alone — the workspace probe has
    // nothing to answer.
    const target = await resolveExecutionLedgerTarget(CHILD_ID, workspace)
    expect(target?.harnessDir).toBe(harnessB)
    expect(target?.workflowId).toBe(WORKFLOW_ID)

    // (b) A real row through the REAL consumer lands in B's ledger and
    // advances B's scan bound.
    const session = {
      header: { id: CHILD_ID, cwd: workspace, createdAt: 1_700_000_000_200 },
      seq: 1,
      inheritedEventCount: 0,
      eventAt: (seq: number) => seq === 0
        ? { type: 'tool-workflow/run-start', seq: 0, time: 1_700_000_000_201, data: { runId: 'b-no-workspace-harness', name: 'b-no-workspace-harness' } }
        : undefined,
    }
    ;(app.ctx.get('sessions') as unknown as { register(session: unknown): void }).register(session)
    app.ctx.events.emit({}, 'session/event', session, session.eventAt(0))
    await awaitWorkflowLedgerIdle()

    const ledgerB = join(harnessB, 'workflows', WORKFLOW_ID)
    expect(readAgentFlow(ledgerB, WORKFLOW_ID)?.events.map((event) => event.kind === 'workflow-run' ? event.runId : event.kind))
      .toEqual(['b-no-workspace-harness'])
    expect(readDshScanBound({ harnessDir: harnessB }, WORKFLOW_ID, CHILD_ID)).toMatchObject({ next: 1 })

    // (c) The workspace stays untouched: nothing is ever written into it or
    // beside it, and root A's ledger gains no row either.
    expect(readdirSync(workspace)).toEqual([])
    expect(readAgentFlow(join(app.harnessDir, 'workflows', WORKFLOW_ID), WORKFLOW_ID)?.events ?? []).toEqual([])
  }))

  it('clears a binding adopted in another control root when the workspace declares NO harness', () => withoutHarnessEnv(async () => {
    // REGRESSION: the clear must read the adoption receipt BEFORE the workspace
    // probe. The workspace-first order refused `execution.clear.no-harness` for
    // every session that validly bound into another control root from a
    // workspace declaring no harness — and no other supported clear route can
    // reach that durable slot. The app is booted WITHOUT a configured harness
    // dir: a configured root would answer the resolver for every workspace and
    // mask the order entirely.
    const app = await bootedWithFixture({ harnessDir: null })
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    await mkdir(join(harnessB, 'workflows', WORKFLOW_ID), { recursive: true })
    // The carrying workspace declares NO harness: no `.mstar` / `.agents` /
    // `.plans` / `.mstarc` under it, so both the engine's probe and the
    // plugin's unconfigured resolver answer null for this cwd.
    const workspace = await mkdtemp(join(tmpdir(), 'native-commands-workspace-'))
    roots.push(workspace)
    expect(resolveHarnessDir(workspace, { workspaceRoot: workspace })).toBeNull()

    const child = agentOf(CHILD_ID, workspace)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(bound.status).toBe('ok')
    expect(storedBinding(harnessB, workspace)?.executionBinding?.harnessRoot).toBe(harnessB)
    expect(executionBindingRootOf(CHILD_ID, workspace)).toBe(harnessB)

    // The clear reaches B through the receipt and drops the durable slot AFTER
    // the real clear; the selection survives (the clear's contract).
    const cleared = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    // The code first: a workspace-first order answers the no-harness refusal
    // here, and this assertion names that exact refusal when it regresses.
    expect(cleared.code).toBe('execution.clear.ok')
    expect(cleared.status).toBe('ok')
    expect(cleared.command).toBe('execution.clear')
    const bindingB = storedBinding(harnessB, workspace)
    expect(bindingB?.executionBinding ?? null).toBeNull()
    expect(bindingB?.selectedWorkflowId).toBe(WORKFLOW_ID)

    // The receipt is dropped with the slot: the selected root is no longer
    // resolvable for this session, so the second clear cannot reach B again —
    // it answers the no-harness refusal, NOT `no-binding` (a surviving receipt
    // would have resolved B's cleared slot and answered `no-binding`). That is
    // the receipt-drop observable available when the workspace resolves no
    // fallback root of its own.
    expect(executionBindingRootOf(CHILD_ID, workspace)).toBeUndefined()
    const again = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    expect(again.status).toBe('refused')
    expect(again.code).toBe('execution.clear.no-harness')
  }))

  it('recovers a lost adoption receipt through the RESUME re-bind with the same harness; a plain re-execution bind still refuses', async () => {
    // REGRESSION: the module note and the adoption refusal used to
    // name "re-run the bind" as the receipt-loss recovery — but a live ACTIVE
    // holder is never replaced by a bind (coordination.identity-mismatch).
    // The real recovery is a resume re-bind carrying the ORIGINAL session
    // reference and the SAME harness.
    const app = await bootedWithFixture()
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    await mkdir(join(harnessB, 'workflows', WORKFLOW_ID), { recursive: true })

    const child = agentOf(CHILD_ID, app.root)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(bound.status).toBe('ok')
    const real = bindRefOf(bound)

    // The host restart / fiber reload: the in-process receipt map is gone
    // (the module's test-only reset — the same factory a real restart
    // observes), while the durable binding slot in B survives.
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()

    // A plain re-execution bind is NOT a recovery: the engine refuses the
    // bind against the recorded holder row (post-bind the store epoch is
    // ahead of the row's — the own-row guard answers) and writes nothing.
    const plain = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(plain.status).toBe('refused')
    expect(plain.code).toBe('execution.session-unavailable')
    expect(storedBinding(harnessB, app.root)?.executionBinding?.session).toEqual(real)
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()

    // The real recovery: resume with the ORIGINAL session reference and the
    // SAME harness — the engine resumes the still-bound seat, the adoption
    // re-writes the slot and re-records the receipt.
    const recovered = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      resumeRef: encodeExecutionSessionRef(real),
      harness: harnessB,
    }))
    expect(recovered.status).toBe('ok')
    const binding = storedBinding(harnessB, app.root)
    expect(binding?.executionBinding?.session).toEqual(real)
    expect(binding?.executionBinding?.harnessRoot).toBe(harnessB)
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe(harnessB)
    expect((await resolveExecutionLedgerTarget(CHILD_ID, app.root))?.harnessDir).toBe(harnessB)
  })

  it('carries the engine-minted reference in a post-commit adoption refusal and the resume re-bind it names re-adopts', async () => {
    // REGRESSION: the adoption runs AFTER the engine bind committed, and its
    // catch replaces the successful envelope with a refusal. That refusal used
    // to drop the minted reference and still tell the caller to "pass the
    // original session reference, still durable in the binding slot" — on the
    // one path where the slot write failed. A mismatched pre-existing durable
    // selection is the deterministic public trigger: the session's selection is
    // recorded under ANOTHER workspace, the store keyed by (session, workspace)
    // refuses the adoption write, while the ENGINE bind in the same root
    // commits, so the refusal's own recovery is the only way back.
    const app = await bootedWithFixture()
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    await mkdir(join(harnessB, 'workflows', WORKFLOW_ID), { recursive: true })
    const recordedWorkspace = await mkdtemp(join(tmpdir(), 'native-commands-workspace-'))
    roots.push(recordedWorkspace)
    expect(updateWorkflowSessionBinding(harnessB, CHILD_ID, recordedWorkspace, {
      selectedWorkflowId: WORKFLOW_ID,
      excludedBeforeSeq: 4,
    }).kind).toBe('written')

    const child = agentOf(CHILD_ID, app.root)
    const refused = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(refused.status).toBe('refused')
    // The engine bind COMMITTED: the coordinator seat belongs to the caller…
    const state = await readExecutionState({ harnessDir: harnessB })
    expect(state.data.workflows[0]?.coordinator?.sessionId).toBe(CHILD_ID)
    // …and the refusal states that beside its refusal status, without
    // contradicting it (the ADOPTION was refused, the bind was not).
    expect(refused.committed).toBe(true)
    // The refusal carries what its own recovery needs, in the input shapes the
    // caller hands straight back.
    const data = refused.data as { resumeRef?: string; workflowId?: string; harness?: string; recordedCwd?: string } | undefined
    expect(typeof data?.resumeRef).toBe('string')
    expect(data?.workflowId).toBe(WORKFLOW_ID)
    // `harness` is the root the engine BIND committed in, not a re-derived
    // adoption root.
    expect(data?.harness).toBe(harnessB)
    // The durable key is (session, workspace), so the refusal must carry the
    // workspace the session's records are actually keyed to — otherwise its
    // own "run from the recorded workspace" recovery is undiscoverable.
    expect(typeof data?.recordedCwd).toBe('string')
    expect(data?.recordedCwd).toBe(recordedWorkspace)
    const carried = decodeExecutionSessionRef(data!.resumeRef!)
    // The carried value IS the engine-minted reference, not a fabrication.
    expect(state.data.workflows[0]!.coordinator).toEqual(carried)
    // The recovery text names the reference it carries, the same harness, and
    // the recorded workspace it is to be run from.
    const recovery = String((refused.details as { recovery?: string } | undefined)?.recovery ?? '')
    expect(recovery).toContain('BOUND')
    expect(recovery).toContain('`data.resumeRef`')
    expect(recovery).toContain('SAME `harness`')
    expect(recovery).toContain('`data.recordedCwd`')
    expect(recovery).toContain(recordedWorkspace)
    // Nothing was adopted for the CURRENT workspace (the store refused that
    // key), which is why the reference exists nowhere but this refusal.
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()
    expect(readWorkflowSessionBinding(harnessB, CHILD_ID, app.root)).toMatchObject({
      kind: 'unavailable',
      reason: 'cwd-mismatch',
    })

    // The advertised recovery, performed with the CARRIED values only: the
    // carried `resumeRef` + the same `harness`, from the recorded workspace
    // the refusal names (derived from the refusal, not from this test's own
    // bookkeeping). It re-adopts the slot there and records the receipt for
    // that root.
    const recorded = agentOf(CHILD_ID, data!.recordedCwd!)
    const recovered = envelopeOf(await run(app.ctx, 'mstar_plan_bind', recorded, {
      resumeRef: data!.resumeRef!,
      harness: data!.harness!,
    }))
    expect(recovered.status).toBe('ok')
    const binding = storedBinding(harnessB, data!.recordedCwd!)
    expect(binding?.executionBinding?.session).toEqual(carried)
    expect(binding?.executionBinding?.harnessRoot).toBe(harnessB)
    // The user selection and exclusion floor the store keyed to that workspace
    // survive the adoption unchanged.
    expect(binding?.selectedWorkflowId).toBe(WORKFLOW_ID)
    expect(binding?.excludedBeforeSeq).toBe(4)
    expect(executionBindingRootOf(CHILD_ID, data!.recordedCwd!)).toBe(harnessB)
  })

  it('keeps the workspace-root path unchanged: a bind without an explicit harness attributes and clears through the workspace harness', async () => {
    // The workspace path (no explicit per-call harness) must behave exactly as
    // before the selected-harness resolution existed.
    const app = await bootedWithFixture()
    const child = agentOf(CHILD_ID, app.root)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(bound.status).toBe('ok')

    const target = await resolveExecutionLedgerTarget(CHILD_ID, app.root)
    expect(target?.workflowId).toBe(WORKFLOW_ID)
    expect(target?.harnessDir).toBe(realpathSync(app.harnessDir))
    expect(target?.workflowDir !== undefined &&
      realpathSync(target.workflowDir) === realpathSync(join(app.harnessDir, 'workflows', WORKFLOW_ID))).toBe(true)

    const cleared = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    expect(cleared.status).toBe('ok')
    expect(storedBinding(app.harnessDir, app.root)?.executionBinding ?? null).toBeNull()
    expect(await resolveExecutionLedgerTarget(CHILD_ID, app.root)).toBeNull()
  })

  it('adopts an implicit-harness bind from a SUBDIRECTORY session in the root the engine bound in', () => withoutHarnessEnv(async () => {
    // REGRESSION: the adoption re-derived its target from the plugin's
    // workspace-only probe, whose boundary is the session cwd itself. For a
    // session whose cwd is a SUBDIRECTORY of the repository that declares the
    // control harness, that probe answers null while the shared admission
    // (git top-level / main worktree) answers the parent root. The engine bind
    // has already committed THERE, so the old branch answered a bare
    // post-commit `binding.no-harness` telling the caller to re-run a bind the
    // engine refuses (a live ACTIVE holder) — no supported way out.
    const app = await bootedWithFixture({ harnessDir: null })
    const subdirectory = join(app.root, 'packages', 'app')
    await mkdir(subdirectory, { recursive: true })
    // The premise: the plugin probe answers null for this workspace…
    expect(resolveHarnessDir(subdirectory, { workspaceRoot: subdirectory })).toBeNull()
    // …while the shared admission's own resolution answers the root the
    // repository declares (git top level → `.mstarc` → `harness/`).
    const engineRoot = resolveProcessHarnessDir(subdirectory)!
    expect(engineRoot).toBe(realpathSync(app.harnessDir))

    const child = agentOf(CHILD_ID, subdirectory)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    // The code first: the pre-fix refusal names this exact branch.
    expect(bound.code).not.toBe('binding.no-harness')
    expect(bound.status).toBe('ok')
    // The durable slot and the adoption receipt both name the engine's root,
    // keyed by the session's own workspace.
    const binding = storedBinding(app.harnessDir, subdirectory)
    expect(binding?.executionBinding?.harnessRoot).toBe(engineRoot)
    expect(binding?.executionBinding?.session.sessionId).toBe(CHILD_ID)
    expect(executionBindingRootOf(CHILD_ID, subdirectory)).toBe(engineRoot)
    // The seat the engine bound and the slot the adoption wrote are one store.
    const state = await readExecutionState({ harnessDir: app.harnessDir })
    expect(state.data.workflows[0]?.coordinator?.sessionId).toBe(CHILD_ID)
  }))

  it('adopts an implicit-harness bind in the ENGINE bind root even when the workspace probes a NESTED harness', () => withoutHarnessEnv(async () => {
    // REGRESSION: when both probes resolve, the plugin's workspace probe
    // can answer a NESTED harness while the shared admission answers the
    // repository root (a linked worktree, or a workspace declaring its own
    // `.mstar`). The adoption used to target the probe's root, so its engine
    // resume failed and `data.harness` named the WRONG store. The recorded
    // adoption root must be the root the engine bind committed in.
    const app = await bootedWithFixture({ harnessDir: null })
    const nested = join(app.root, 'nested')
    await mkdir(join(nested, '.mstar'), { recursive: true })
    // Both resolutions answer, and they disagree — the divergence premise.
    expect(resolveHarnessDir(nested, { workspaceRoot: nested })).toBe(join(nested, '.mstar'))
    const engineRoot = resolveProcessHarnessDir(nested)!
    expect(engineRoot).toBe(realpathSync(app.harnessDir))
    expect(engineRoot).not.toBe(join(nested, '.mstar'))

    const child = agentOf(CHILD_ID, nested)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(bound.status).toBe('ok')
    // The recorded harness is the engine's bind root, never the nested probe.
    const binding = storedBinding(app.harnessDir, nested)
    expect(binding?.executionBinding?.harnessRoot).toBe(engineRoot)
    expect(executionBindingRootOf(CHILD_ID, nested)).toBe(engineRoot)
  }))
})

// ---------------------------------------------------------------------------
// (f) Task 5 (#530) — the native clear (the slash command's replacement)
// ---------------------------------------------------------------------------

describe('native execution clear — the replacement reachability for clearExecutionBinding', () => {
  it('clears the adopted binding after a native bind, preserving the selection and detaching the ledger attribution', async () => {
    const app = await bootedWithFixture()
    const child = agentOf(CHILD_ID, app.root)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
    }))
    expect(bound.status).toBe('ok')
    expect(storedBinding(app.harnessDir, app.root)?.executionBinding).not.toBeNull()

    const cleared = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    expect(cleared.status).toBe('ok')
    expect(cleared.command).toBe('execution.clear')
    const binding = storedBinding(app.harnessDir, app.root)
    expect(binding?.executionBinding ?? null).toBeNull()
    // The user selection survives the clear (the same fact the slash clear
    // guaranteed).
    expect(binding?.selectedWorkflowId).toBe(WORKFLOW_ID)
    // The ledger's explicit route required the binding: after the clear this
    // session is no longer attributed.
    expect(await resolveExecutionLedgerTarget(CHILD_ID, app.root)).toBeNull()
  })

  it('names the cross-root case and the resume re-bind when a restart lost the receipt, and that re-bind restores the clear', async () => {
    // REGRESSION: after a host restart the in-process adoption receipt is gone,
    // so the clear falls back to the workspace/configured root and answered
    // `no-binding` with "This session has no durable execution binding to clear
    // — adopt one first … otherwise no action is needed". For a cross-harness
    // binding that cause is FALSE (the durable slot exists in root B) and the
    // only working recovery (the resume re-bind that re-records the selected
    // root) was hidden. The refusal must name the true cause and that route.
    const app = await bootedWithFixture()
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    await mkdir(join(harnessB, 'workflows', WORKFLOW_ID), { recursive: true })

    const child = agentOf(CHILD_ID, app.root)
    const bound = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      execution: true,
      coordinator: true,
      workflow: WORKFLOW_ID,
      harness: harnessB,
    }))
    expect(bound.status).toBe('ok')
    const real = bindRefOf(bound)
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe(harnessB)

    // The host restart / fiber reload: the receipt map is gone (the module's
    // own test seam is the same factory a real restart observes), while the
    // durable binding in harnessB survives.
    resetExecutionBindingRootsForTests()
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBeUndefined()

    const refused = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    expect(refused.status).toBe('refused')
    // The code is unchanged — only the message/recovery become true.
    expect(refused.code).toBe('execution.clear.no-binding')
    expect(String(refused.message).split('\n')[0])
      .toBe('no clearable execution binding is reachable from the control root resolved here')
    const recovery = String((refused.details as { recovery?: string } | undefined)?.recovery ?? '')
    // The true cause (not reachable from the root resolved here) plus every
    // part of the performable route and the no-action case.
    expect(recovery).toContain('a binding adopted into a DIFFERENT control root is not reachable from it')
    expect(recovery).toContain('`resumeRef`')
    expect(recovery).toContain('SAME `harness`')
    expect(recovery).toContain('no action is needed')
    // Nothing was cleared: B still holds the adopted binding.
    expect(storedBinding(harnessB, app.root)?.executionBinding?.session).toEqual(real)

    // The advertised path works: the resume re-bind with the ORIGINAL reference
    // and the same harness re-records the selected root, then the clear acts on
    // root B.
    const reAdopted = envelopeOf(await run(app.ctx, 'mstar_plan_bind', child, {
      resumeRef: encodeExecutionSessionRef(real),
      harness: harnessB,
    }))
    expect(reAdopted.status).toBe('ok')
    expect(executionBindingRootOf(CHILD_ID, app.root)).toBe(harnessB)
    const cleared = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    expect(cleared.status).toBe('ok')
    expect(cleared.code).toBe('execution.clear.ok')
    expect(storedBinding(harnessB, app.root)?.executionBinding ?? null).toBeNull()
  })

  it('refuses with the named error when there is nothing to clear', async () => {
    const app = await bootedWithFixture()
    const child = agentOf(CHILD_ID, app.root)
    const refused = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    expect(refused.status).toBe('refused')
    expect(refused.code).toBe('execution.clear.no-binding')
    // The named no-binding message states its TRUE scope: the control root this
    // clear resolved (the envelope appends Help/Recovery lines).
    expect(String(refused.message).split('\n')[0])
      .toBe('no clearable execution binding is reachable from the control root resolved here')
    const details = refused.details as { recovery?: string; helpRoute?: string } | undefined
    expect(typeof details?.recovery).toBe('string')
    expect((details?.recovery ?? '').length).toBeGreaterThan(0)
  })

  it('carries the recorded workspace in the store refusal when this session is keyed to another cwd', async () => {
    // REGRESSION: the clear's store refusal used to say "the durable binding
    // record must be readable and writable for this session and its exact
    // cwd" — a key the caller cannot see. The durable record IS keyed to
    // another workspace, so the refusal now carries that workspace and names
    // it in the recovery.
    const app = await bootedWithFixture()
    const rootB = await mkdtemp(join(tmpdir(), 'native-commands-harness-b-'))
    roots.push(rootB)
    const harnessB = join(rootB, '.mstar')
    const recordedWorkspace = await mkdtemp(join(tmpdir(), 'native-commands-workspace-'))
    roots.push(recordedWorkspace)
    await seedUnboundWorkflow(harnessB, CHILD_ID)
    // A durable record for this session exists, keyed to another workspace…
    expect(updateWorkflowSessionBinding(harnessB, CHILD_ID, recordedWorkspace, {
      selectedWorkflowId: WORKFLOW_ID,
      excludedBeforeSeq: 2,
    }).kind).toBe('written')
    // …and the in-process receipt points the clear at that store for the
    // CURRENT workspace, so the store refuses the key it is asked for.
    recordExecutionBindingRoot(CHILD_ID, app.root, harnessB)

    const refused = envelopeOf(await run(app.ctx, 'mstar_execution_clear', agentOf(CHILD_ID, app.root), {}))
    expect(refused.status).toBe('refused')
    expect(refused.code).toBe('execution.clear.store-refused')
    expect(refused.data).toEqual({ recordedCwd: recordedWorkspace })
    const recovery = String((refused.details as { recovery?: string } | undefined)?.recovery ?? '')
    expect(recovery).toContain('`data.recordedCwd`')
    expect(recovery).toContain(recordedWorkspace)
    // Nothing was cleared: the record at the recorded workspace is untouched.
    expect(storedBinding(harnessB, recordedWorkspace)?.executionBinding ?? null).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (g) The stage of a POST-COMMIT adoption failure decides the recovery: an
// engine-resume refusal rejects the very reference a resume re-bind would
// carry, so promising re-adoption there advertises a loop. The deterministic
// trigger for the slot arm is the public regression above; the engine-resume
// arm has no public trigger (the reference was minted by the bind that just
// succeeded), so the pure selection is asserted directly.
// ---------------------------------------------------------------------------

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
