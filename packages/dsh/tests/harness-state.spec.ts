/**
 * `mstar-harness-state` catalog row — the workspace-state digest appended
 * at `agent/pre-step` after the engine-status and iteration-gate rows: the
 * plan registry, open residual counts, branch/policy anchors, active
 * leases, knowledge index digest and the steering compass direction
 * one-liner. All fields come from the same per-workspace cached build as
 * the sibling rows (one status.json / compass / knowledge-index read per
 * cache refresh — TTL-bounded, Config `catalogTtlMs`).
 *
 * Covered:
 *  1. Full digest — seeded status.json (plans + residuals + metadata +
 *     lease) + compass (direction) + knowledge index render every line.
 *  2. Absent row — no harness dir or no status.json → no `mstar-harness-state`
 *     row (advisory degrade, sibling-row semantics).
 *  3. TTL refresh — a status.json change lands within `catalogTtlMs`
 *     (plan status + residual changes re-render after the interval).
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
const stepPayload = (messages: UserMessage[], cwd?: string) => ({
  agent: cwd === undefined ? {} : { session: { header: { cwd } } },
  messages,
  turn: 1,
  step: 1,
  signal: new AbortController().signal,
})

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** The last message of an enter decision (the appended rows when present). */
const lastMessage = (decision: { kind: 'enter'; messages: UserMessage[] }): UserMessage | undefined =>
  decision.messages.at(-1)

/** The harness-state row of an enter decision (undefined when absent). */
function stateRowOf(decision: { kind: 'enter'; messages: UserMessage[] }): UserMessage | undefined {
  return decision.messages.find((m) => m.source.kind === 'mstar-harness-state')
}

/** The rendered text of one row. */
const textOf = (row: UserMessage | undefined): string =>
  row?.content[0]?.type === 'text' ? row.content[0].text : ''

/** A status.json exercising every state-row feature (plans, residuals, metadata, lease). */
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
 * 1. Full digest — every line renders from the seeded workspace state
 * ========================================================================== */

describe('mstar-harness-state — the workspace digest row at agent/pre-step', () => {
  it('renders plans, residuals, branch/policy anchors, leases, knowledge and direction', async () => {
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
    // engine-status + iteration-gate + harness-state.
    expect(decision.messages.length).toBe(inbox.length + 3)

    const row = stateRowOf(decision)
    expect(row?.source).toMatchObject({
      kind: 'mstar-harness-state',
      form: 'catalog',
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
    expect(text).toContain('<mstar_harness_state>')
    expect(text).toContain('plans: plan-a(InProgress) plan-b(Done)')
    expect(text).toContain('residuals: high 1, nit 1')
    expect(text).toContain('branch: dev-dsh → dev-dsh (spec integration: iteration/v2.2.0)')
    expect(text).toContain('policy: push no-push; worktree feature-worktree; control /control/worktree')
    expect(text).toContain('leases: plan-a → dsh-session-1 (/worktrees/plan-a)')
    expect(text).toContain('knowledge: 3 docs (architecture-patterns, conventions)')
    expect(text).toContain('direction: The dsh host plugin needs richer in-session harness context for operators.')
    expect(text).toContain('</mstar_harness_state>')
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

    const row = stateRowOf(decision)
    expect(row?.source).toMatchObject({ iterationBaseBranch: 'dev-dsh', targetBranch: 'dev-dsh' })
    expect(textOf(row)).toContain('branch: dev-dsh → dev-dsh')
  })
})

/* ===========================================================================
 * 2. Absent row — no harness dir or no status.json
 * ========================================================================== */

describe('mstar-harness-state — advisory degrade (row absent)', () => {
  it('no status.json → no state row (engine-status still appends)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-absent-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    booted = await bootApp({ root })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(stateRowOf(decision)).toBeUndefined()
    expect(decision.messages.length).toBe(1) // engine-status only
    expect(decision.messages[0]!.source.kind).toBe('mstar-engine-status')
  })

  it('no harness dir (agent-less, no config) → no state row', async () => {
    booted = await bootApp({ harnessDir: null })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(stateRowOf(decision)).toBeUndefined()
  })
})

/* ===========================================================================
 * 3. TTL refresh — status.json changes land within catalogTtlMs
 * ========================================================================== */

describe('mstar-harness-state — TTL refresh (Config catalogTtlMs)', () => {
  it('a plan status + residual change re-renders after the interval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-ttl-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [{ id: 'plan-a', status: 'Todo' }], residual_findings: {}, metadata: {} }),
    })
    // 50ms refresh interval: the test proves both the cache hit (immediate
    // re-use) and the bounded re-read (after the interval).
    booted = await bootApp({ root, catalogTtlMs: 50 })

    const first = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    expect(textOf(stateRowOf(first))).toContain('plans: plan-a(Todo)')

    // Within the TTL the cached row stands even after a status change.
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({
        version: 1,
        updated_at: '2026-08-08',
        plans: [{ id: 'plan-a', status: 'Done' }],
        residual_findings: { 'plan-a': [{ severity: 'critical', description: 'new finding' }] },
        metadata: {},
      }),
    })
    const second = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    expect(textOf(stateRowOf(second))).toContain('plans: plan-a(Todo)')

    // After the TTL the row refreshes from disk.
    await new Promise((resolve) => setTimeout(resolve, 80))
    const third = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const thirdText = textOf(stateRowOf(third))
    expect(thirdText).toContain('plans: plan-a(Done)')
    expect(thirdText).toContain('residuals: critical 1')
  })
})
