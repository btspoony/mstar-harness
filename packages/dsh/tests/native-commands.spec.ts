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
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  createExecutionWorkflow,
  encodeExecutionSessionRef,
  initializeStore,
  readExecutionState,
  registerCatalogEntity,
} from '@mstar-harness/engine'
import type { ExecutionCaller, ExecutionContext, ExecutionSessionRef } from '@mstar-harness/engine'
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { WorkflowSessionBinding } from '../src/engine-status-store.ts'
import { clearExecutionBinding, resolveExecutionLedgerTarget } from '../src/gates/workflow-selection.ts'
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
async function bootedWithFixture(): Promise<BootResult & {
  featureWorktree: string
  sourceSha: string
  baseSha: string
  evidenceDir: string
}> {
  const fixture = await gitFixtureRoot()
  const app = booted = await bootApp({ root: fixture.root })
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

  it('describes flattened json payloads mechanically from the published schema (F-5)', async () => {
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
// (c2) F-0 — a refused bind surfaces the ENGINE's refusal verbatim: the
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
    expect(binding?.executionBinding?.harnessRoot).toBe(app.harnessDir)
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
    // REGRESSION (the must-fix review finding): the bind's explicit `harness`
    // names the control root the engine bind commits in — the adoption's
    // engine resume and the durable slot write MUST land in THAT root. The old
    // behavior derived the adoption target from the workspace resolver only,
    // so the resume ran against (or the slot landed under) the wrong root.
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
    expect(storedBinding(app.harnessDir, app.root)?.executionBinding ?? null).toBeNull()

    // The engine coordinator seat lives in root B's store, not root A's.
    const stateB = await readExecutionState({ harnessDir: harnessB })
    expect(stateB.data.workflows[0]?.coordinator?.sessionId).toBe(CHILD_ID)
    const stateA = await readExecutionState({ harnessDir: app.harnessDir })
    expect(stateA.data.workflows[0]?.coordinator ?? null).toBeNull()
  })
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

  it('refuses with the named error when there is nothing to clear', async () => {
    const app = await bootedWithFixture()
    const child = agentOf(CHILD_ID, app.root)
    const refused = envelopeOf(await run(app.ctx, 'mstar_execution_clear', child, {}))
    expect(refused.status).toBe('refused')
    expect(refused.code).toBe('execution.clear.no-binding')
    // The existing named error text of the removed slash arm, surfaced as the
    // refusal message's first line (the envelope appends Help/Recovery lines).
    expect(String(refused.message).split('\n')[0]).toBe('no clearable execution binding')
    const details = refused.details as { recovery?: string; helpRoute?: string } | undefined
    expect(typeof details?.recovery).toBe('string')
    expect((details?.recovery ?? '').length).toBeGreaterThan(0)
  })
})
