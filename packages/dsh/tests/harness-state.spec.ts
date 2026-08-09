/**
 * The unified `mstar-engine-status` catalog row — ONE injection per step
 * carrying the watermark (version, harness dir, enforcement), the iteration
 * phase-gate section (when a steering compass + status.json resolve) and
 * the workspace-state digest section (plan registry, open residual counts,
 * branch/policy anchors, active leases, knowledge index digest, compass
 * direction). All fields come from the same per-workspace cached build (one
 * status.json / compass / knowledge-index read per cache refresh —
 * TTL-bounded, Config `catalogTtlMs`), and the row is digest-gated: injected
 * once per turn, re-injected only when its rendered text changed.
 *
 * Covered:
 *  1. Full digest — seeded status.json (plans + residuals + metadata +
 *     lease) + compass (direction) + knowledge index render every section.
 *  2. Absent state — no status.json / no harness dir → the row exists with
 *     `state: null` (the state lines are absent; watermark stays).
 *  3. TTL refresh — a status.json change lands within `catalogTtlMs`.
 *  4. Digest gating — same turn unchanged → no re-injection; same turn with
 *     a TTL-refreshed change → re-injection; new turn → re-injection.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { bootApp, seedHarness, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- helpers ---------------------------------- */

/** A pre-step payload whose agent carries a session cwd (the workspace). */
const stepPayload = (messages: UserMessage[], cwd?: string, turn = 1, agentId?: string) => ({
  agent: agentId !== undefined
    ? { id: agentId, session: { header: { cwd } } }
    : cwd === undefined ? {} : { session: { header: { cwd } } },
  messages,
  turn,
  step: 1,
  signal: new AbortController().signal,
})

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** The last message of an enter decision (the appended rows when present). */
const lastMessage = (decision: { kind: 'enter'; messages: UserMessage[] }): UserMessage | undefined =>
  decision.messages.at(-1)

/** The rendered text of one row. */
const textOf = (row: UserMessage | undefined): string =>
  row?.content[0]?.type === 'text' ? row.content[0].text : ''

/** A status.json exercising every state-section feature (plans, residuals, metadata, lease). */
const RICH_STATUS = JSON.stringify({
  version: 1,
  updated_at: '2026-08-08',
  plans: [
    {
      plan_id: 'plan-a',
      title: 'Plan A',
      status: 'InProgress',
      execution_lease: {
        holder: 'dsh-session-1',
        claimed_at: '2026-08-08',
        worktree_path: '/worktrees/plan-a',
        working_branch: 'feature/plan-a',
      },
    },
    { id: 'plan-b', title: 'Plan B', status: 'Done' },
  ],
  residual_findings: {
    'plan-b': [
      { severity: 'high', description: 'deferred blocker' },
      { severity: 'nit', description: 'style nit' },
    ],
  },
  metadata: {
    iteration_base_branch: 'dev-dsh',
    target_branch: 'dev-dsh',
    spec_integration_branch: 'iteration/v2.2.0',
    push_policy: 'no-push',
    worktree_mode: 'feature-worktree',
    control_worktree_path: '/control/worktree',
  },
})

/** A steering compass with a `## Direction lock` problem statement. */
const RICH_COMPASS = [
  '---',
  'iteration_id: v2.2.0',
  'status: active',
  'enforcement: hard',
  'iteration_base_branch: dev-dsh',
  'target_branch: dev-dsh',
  'plans:',
  '  - plan-a',
  '---',
  '',
  '## Direction lock (autonomous)',
  '',
  '- **Problem statement:** The dsh host plugin needs richer in-session harness context for operators.',
  '',
  '## Scope',
  '',
  'body',
].join('\n')

/** A knowledge index with two categories. */
const KNOWLEDGE_README = [
  '# Knowledge Index',
  '',
  '| Document | Source | Description | Status |',
  '|----------|--------|-------------|--------|',
  '| `architecture-patterns/dsh-plugin-shape.md` | iteration:v2.2.0 | plugin shape | active |',
  '| `conventions/harness-context.md` | iteration:v2.2.0 | context digest | active |',
  '| `conventions/other.md` | iteration:v2.2.0 | another | archived |',
  '',
].join('\n')

/* ===========================================================================
 * 1. Full digest — every section renders from the seeded workspace state
 * ========================================================================== */

describe('mstar-engine-status — the unified catalog row (watermark + gate + state)', () => {
  it('renders the watermark, iteration gate and the full workspace-state digest in ONE row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': RICH_STATUS,
      'iterations/v2.2.0/delivery-compass.md': RICH_COMPASS,
      'knowledge/README.md': KNOWLEDGE_README,
    })
    booted = await bootApp({ root })
    const inbox = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })]

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    // ONE unified row.
    expect(decision.messages.length).toBe(inbox.length + 1)

    const row = lastMessage(decision)
    expect(row?.source).toMatchObject({ kind: 'mstar-engine-status', form: 'catalog' })
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return

    // Iteration gate section (steering compass + status.json resolve).
    expect(source.iteration).toMatchObject({
      iterationId: 'v2.2.0',
      statusPath: join(harnessDir, 'status.json'),
      gate: { transition: 'phase-2-execute', all_plans_done: false },
    })

    // Workspace-state section.
    expect(source.state).toMatchObject({
      plans: [
        { id: 'plan-a', status: 'InProgress' },
        { id: 'plan-b', status: 'Done' },
      ],
      residuals: [
        { severity: 'high', count: 1 },
        { severity: 'nit', count: 1 },
      ],
      iterationBaseBranch: 'dev-dsh',
      targetBranch: 'dev-dsh',
      specIntegrationBranch: 'iteration/v2.2.0',
      pushPolicy: 'no-push',
      worktreeMode: 'feature-worktree',
      controlWorktreePath: '/control/worktree',
      leases: [{ planId: 'plan-a', holder: 'dsh-session-1', worktreePath: '/worktrees/plan-a' }],
      knowledge: { docCount: 3, categories: ['architecture-patterns', 'conventions'] },
    })
    const text = textOf(row)
    expect(text).toContain('<mstar_engine_status>')
    expect(text).toContain('mstar version: 2.0.4')
    expect(text).toContain('harness dir:')
    expect(text).toContain('iteration: v2.2.0')
    expect(text).toContain('gate: PASS')
    expect(text).toContain('plans: plan-a(InProgress) plan-b(Done)')
    expect(text).toContain('residuals: high 1, nit 1')
    expect(text).toContain('branch: dev-dsh → dev-dsh (spec integration: iteration/v2.2.0)')
    expect(text).toContain('policy: push no-push; worktree feature-worktree; control /control/worktree')
    expect(text).toContain('leases: plan-a → dsh-session-1 (/worktrees/plan-a)')
    expect(text).toContain('knowledge: 3 docs (architecture-patterns, conventions)')
    expect(text).toContain('direction: The dsh host plugin needs richer in-session harness context for operators.')
    expect(text).toContain('</mstar_engine_status>')
  })

  it('falls back to compass frontmatter for base/target branches when metadata is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-branch-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
      'iterations/v2.2.0/delivery-compass.md': '---\niteration_id: v2.2.0\nstatus: active\niteration_base_branch: dev-dsh\ntarget_branch: dev-dsh\n---\n',
    })
    booted = await bootApp({ root })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return
    expect(source.state).toMatchObject({ iterationBaseBranch: 'dev-dsh', targetBranch: 'dev-dsh' })
    expect(textOf(row)).toContain('branch: dev-dsh → dev-dsh')
  })
})

/* ===========================================================================
 * 2. Absent state — the row exists, the state section is null
 * ========================================================================== */

describe('mstar-engine-status — advisory degrade (state section null)', () => {
  it('no status.json → the row still appends with state: null (watermark only)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-absent-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    booted = await bootApp({ root })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(1)
    const row = lastMessage(decision)
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return
    expect(source.state).toBeNull()
    expect(source.iteration).toBeUndefined()
    const text = textOf(row)
    expect(text).toContain('<mstar_engine_status>')
    expect(text).not.toContain('plans:')
  })

  it('no harness dir (agent-less, no config) → the row appends with harnessDir null and state null', async () => {
    booted = await bootApp({ harnessDir: null })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(1)
    const row = lastMessage(decision)
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return
    expect(source.harnessDir).toBeNull()
    expect(source.state).toBeNull()
    expect(textOf(row)).toContain('harness dir: none')
  })
})

/* ===========================================================================
 * 3. TTL refresh + 4. digest gating
 * ========================================================================== */

describe('mstar-engine-status — TTL refresh and digest-gated re-emission', () => {
  it('same turn unchanged → no re-injection; TTL-refreshed change → re-injection; new turn → re-injection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-ttl-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [{ id: 'plan-a', status: 'Todo' }], residual_findings: {}, metadata: {} }),
    })
    // 50ms refresh interval: proves both the cache hit (immediate reuse)
    // and the bounded re-read (after the interval).
    booted = await bootApp({ root, catalogTtlMs: 50 })
    const agentId = 'digest-agent'

    // Turn 1, step 1: the row is injected.
    const first = await booted.ctx.waterfall('agent/pre-step', stepPayload([], undefined, 1, agentId), defaultEnter([]))
    expect(textOf(lastMessage(first))).toContain('plans: plan-a(Todo)')

    // Same turn, unchanged (within the TTL): NO re-injection — the digest
    // gate suppresses the identical row (the 20-step-turn case).
    const sameTurn = await booted.ctx.waterfall('agent/pre-step', stepPayload([], undefined, 1, agentId), defaultEnter([]))
    expect(sameTurn.kind).toBe('enter')
    if (sameTurn.kind !== 'enter') return
    expect(sameTurn.messages).toHaveLength(0)

    // Same turn, TTL-refreshed change (status + residual changed): the row
    // re-appears with the new state.
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({
        version: 1,
        updated_at: '2026-08-08',
        plans: [{ id: 'plan-a', status: 'Done' }],
        residual_findings: { 'plan-a': [{ severity: 'critical', description: 'new finding' }] },
        metadata: {},
      }),
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const changed = await booted.ctx.waterfall('agent/pre-step', stepPayload([], undefined, 1, agentId), defaultEnter([]))
    const changedText = textOf(lastMessage(changed))
    expect(changedText).toContain('plans: plan-a(Done)')
    expect(changedText).toContain('residuals: critical 1')

    // New turn: full re-injection even when nothing changed.
    const newTurn = await booted.ctx.waterfall('agent/pre-step', stepPayload([], undefined, 2, agentId), defaultEnter([]))
    expect(textOf(lastMessage(newTurn))).toContain('plans: plan-a(Done)')

    // A different agent keeps an independent digest (its own injection).
    const other = await booted.ctx.waterfall('agent/pre-step', stepPayload([], undefined, 1, 'other-agent'), defaultEnter([]))
    expect(textOf(lastMessage(other))).toContain('plans: plan-a(Done)')
  })
})
