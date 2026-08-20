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
import { bootApp, seedHarness, v2Root, v2Snapshot, v2WorkflowEntry, type BootResult } from './harness.ts'
import { ENGINE_VERSION } from './engine-version.ts'

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
} as never)

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<{ kind: 'enter'; messages: UserMessage[] }>) =>
  () => Promise.resolve({ kind: 'enter', messages })

/** The last message of an enter decision (the appended rows when present). */
const lastMessage = (decision: PreStepDecision): UserMessage | undefined =>
  decision.kind === 'enter' ? decision.messages.at(-1) : undefined

/** The rendered text of one row. */
const textOf = (row: UserMessage | undefined): string =>
  row?.content[0]?.type === 'text' ? row.content[0].text : ''

/** A v2 tree exercising every state-section feature (plans, residuals, metadata, lease). */
const RICH_WORKFLOW = 'v2.2.0'
const RICH_ROOT = v2Root([v2WorkflowEntry(RICH_WORKFLOW, 'iteration')])
const RICH_SNAPSHOT = v2Snapshot(RICH_WORKFLOW, {
  type: 'iteration',
  plans: [
    {
      plan_id: 'plan-a',
      title: 'Plan A',
      status: 'InProgress',
      // No done_at: the always-present doneAt must project to null.
      execution_lease: {
        holder: 'dsh-session-1',
        claimed_at: '2026-08-08',
        worktree_path: '/worktrees/plan-a',
        working_branch: 'feature/plan-a',
      },
    },
    { id: 'plan-b', title: 'Plan B', status: 'Done', done_at: '2026-08-08' },
  ],
  branch: {
    base: 'dev-dsh',
    integration: 'iteration/v2.2.0',
    target: 'dev-dsh',
  },
  execution_policy: {
    push_policy: 'no-push',
    worktree_mode: 'feature-worktree',
  },
  control_worktree_path: '/control/worktree',
})
/** The project register (the v1 `residual_findings` home after migrate). */
const RICH_REGISTER = JSON.stringify({
  entries: {
    'plan-b': [
      { id: 'R1', title: 'deferred blocker', severity: 'high', lifecycle: 'open', source_plan: 'plan-b', registered_at: '2026-08-08' },
      { id: 'R2', title: 'style nit', severity: 'nit', source_plan: 'plan-b', registered_at: '2026-08-08' },
    ],
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
      'status.json': RICH_ROOT,
      [`workflows/${RICH_WORKFLOW}/snapshot.json`]: RICH_SNAPSHOT,
      'projects/_default/residuals.json': RICH_REGISTER,
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

    // Iteration gate section (steering compass + selected workflow snapshot resolve).
    expect(source.iteration).toMatchObject({
      iterationId: 'v2.2.0',
      statusPath: join(harnessDir, `workflows/${RICH_WORKFLOW}/snapshot.json`),
      gate: { transition: 'phase-2-execute', all_plans_done: false },
    })

    // Workspace-state section.
    expect(source.state).toMatchObject({
      selection: { kind: 'active', workflowId: RICH_WORKFLOW, dir: `workflows/${RICH_WORKFLOW}` },
      plans: [
        { id: 'plan-a', status: 'InProgress', doneAt: null },
        { id: 'plan-b', status: 'Done', doneAt: '2026-08-08' },
      ],
      residuals: [
        { severity: 'high', count: 1 },
        { severity: 'nit', count: 1 },
      ],
      residualFindings: [
        { planId: 'plan-b', id: 'R1', severity: 'high', title: 'deferred blocker' },
        { planId: 'plan-b', id: 'R2', severity: 'nit', title: 'style nit' },
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
    expect(text).toContain(`mstar version: ${ENGINE_VERSION}`)
    expect(text).toContain('harness dir:')
    expect(text).toContain('iteration: v2.2.0')
    expect(text).toContain('gate: PASS')
    expect(text).toContain(`workflow: ${RICH_WORKFLOW} (active)`)
    expect(text).toContain('plans: plan-a(InProgress) plan-b(Done)')
    expect(text).toContain('residuals: high 1, nit 1')
    expect(text).toContain('branch: dev-dsh → dev-dsh (spec integration: iteration/v2.2.0)')
    expect(text).toContain('policy: push no-push; worktree feature-worktree; control /control/worktree')
    expect(text).toContain('leases: plan-a → dsh-session-1 (/worktrees/plan-a)')
    expect(text).toContain('knowledge: 3 docs (architecture-patterns, conventions)')
    expect(text).toContain('direction: The dsh host plugin needs richer in-session harness context for operators.')
    expect(text).toContain('</mstar_engine_status>')
  })

  it('falls back to compass frontmatter for base/target branches when the snapshot carries no branch anchors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-branch-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-branch')]),
      'workflows/wf-branch/snapshot.json': v2Snapshot('wf-branch'),
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
 * 1b. residualFindings register semantics (spec §6, v3 home): no project
 *     register files → null (advisory — same pattern as `knowledge`);
 *     register(s) present, no open entries → []
 * ========================================================================== */

describe('mstar-engine-status — residualFindings register semantics (spec §6)', () => {
  it('no project register files → residualFindings null (residuals rollup stays [])', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-noroot-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
    })
    booted = await bootApp({ root })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return
    expect(source.state).toMatchObject({ residuals: [], residualFindings: null })
  })

  it('register present with no open entries → residualFindings [] (closed lifecycles only)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-noopen-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
      'projects/_default/residuals.json': JSON.stringify({
        entries: {
          'plan-a': [
            { id: 'R1', title: 'already fixed', severity: 'high', lifecycle: 'resolved', source_plan: 'plan-a', registered_at: '2026-08-08' },
            { id: 'R2', title: 'wontfix', severity: 'low', lifecycle: 'waived', source_plan: 'plan-a', registered_at: '2026-08-08' },
          ],
        },
      }),
    })
    booted = await bootApp({ root })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return
    // W-A fix-wave: closed entries must NOT count toward the severity
    // rollup either — the workspace shows no open residuals at all.
    expect(source.state).toMatchObject({ residualFindings: [], residuals: [] })
  })
})

/* ===========================================================================
 * 1c. residualFindings open-filter branches + severity order + cap 10 +
 *     doneAt passthrough (spec §6): the open filter is engine `isOpenResidual`
 *     parity — missing / null / false / 'open' → open, anything else (incl.
 *     `true` and non-'open' strings) → closed; severity ordered critical→nit
 *     with unknown severities skipped; capped at 10; `done_at` trimmed, with
 *     empty / whitespace / non-string → null.
 * ========================================================================== */

describe('mstar-engine-status — residualFindings open-filter branches + severity order + cap (spec §6)', () => {
  /** Seed a v2 tree whose project register carries the given entries. */
  async function seedWithRegister(entries: Record<string, unknown[]>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-register-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
      'projects/_default/residuals.json': JSON.stringify({ entries }),
    })
    booted = await bootApp({ root })
  }

  it('open filter parity: missing / null / false lifecycle → open; strict "open" string → open; true and non-"open" strings → closed', async () => {
    await seedWithRegister({
      'plan-a': [
        { id: 'R-missing', title: 'no lifecycle key', severity: 'critical', source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-null', title: 'null lifecycle', severity: 'high', lifecycle: null, source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-false', title: 'false lifecycle', severity: 'medium', lifecycle: false, source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-open', title: 'string open', severity: 'low', lifecycle: 'open', source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-true', title: 'truthy non-string lifecycle', severity: 'critical', lifecycle: true, source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-resolved', title: 'resolved', severity: 'high', lifecycle: 'resolved', source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-superseded', title: 'superseded', severity: 'nit', lifecycle: 'superseded', source_plan: 'plan-a', registered_at: '2026-08-08' },
      ],
    })

    const decision = await booted!.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return
    const state = source.state
    expect(source.state).not.toBeNull()
    if (state === null) return
    expect(state.residualFindings).toEqual([
      { planId: 'plan-a', id: 'R-missing', severity: 'critical', title: 'no lifecycle key' },
      { planId: 'plan-a', id: 'R-null', severity: 'high', title: 'null lifecycle' },
      { planId: 'plan-a', id: 'R-false', severity: 'medium', title: 'false lifecycle' },
      { planId: 'plan-a', id: 'R-open', severity: 'low', title: 'string open' },
    ])
    // W-A fix-wave: the severity ROLLUP applies the same open parity — the
    // closed entries (R-true critical, R-resolved high, R-superseded nit)
    // never count; only the four open entries do.
    expect(state.residuals).toEqual([
      { severity: 'critical', count: 1 },
      { severity: 'high', count: 1 },
      { severity: 'medium', count: 1 },
      { severity: 'low', count: 1 },
    ])
  })

  it('severity order critical→nit regardless of source order; unknown severities skipped; missing id/title → ""', async () => {
    await seedWithRegister({
      'plan-a': [
        { id: 'R-nit', title: 'nit first in source', severity: 'nit', source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-unknown', title: 'unknown severity must be skipped', severity: 'urgent', source_plan: 'plan-a', registered_at: '2026-08-08' },
        { severity: 'critical', title: '', source_plan: 'plan-a', registered_at: '2026-08-08' }, // no id → '' (never thrown)
        { id: 'R-medium', title: 'medium', severity: 'medium', source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-low', title: 'low', severity: 'low', source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-high', title: 'high', severity: 'high', source_plan: 'plan-a', registered_at: '2026-08-08' },
        { id: 'R-no-title', severity: 'nit', source_plan: 'plan-a', registered_at: '2026-08-08' }, // no title → ''
      ],
    })

    const decision = await booted!.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return
    const state = source.state
    expect(source.state).not.toBeNull()
    if (state === null) return
    expect(state.residualFindings).toEqual([
      { planId: 'plan-a', id: '', severity: 'critical', title: '' },
      { planId: 'plan-a', id: 'R-high', severity: 'high', title: 'high' },
      { planId: 'plan-a', id: 'R-medium', severity: 'medium', title: 'medium' },
      { planId: 'plan-a', id: 'R-low', severity: 'low', title: 'low' },
      { planId: 'plan-a', id: 'R-nit', severity: 'nit', title: 'nit first in source' },
      { planId: 'plan-a', id: 'R-no-title', severity: 'nit', title: '' },
    ])
  })

  it('cap 10: more than 10 open findings (across plans) → the first 10 by severity order, planId preserved', async () => {
    const criticals = Array.from({ length: 4 }, (_, i) => ({ id: `C${i + 1}`, title: `critical ${i + 1}`, severity: 'critical', source_plan: 'plan-a', registered_at: '2026-08-08' }))
    const nits = Array.from({ length: 8 }, (_, i) => ({ id: `N${i + 1}`, title: `nit ${i + 1}`, severity: 'nit', source_plan: 'plan-b', registered_at: '2026-08-08' }))
    await seedWithRegister({
      'plan-a': criticals.slice(0, 2),
      'plan-b': [...criticals.slice(2), ...nits],
    })

    const decision = await booted!.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return
    const state = source.state
    expect(source.state).not.toBeNull()
    if (state === null) return
    const findings = state.residualFindings
    if (findings === null) return
    // 12 open total → capped at 10: the 4 criticals (stable source order:
    // plan-a C1..C2, then plan-b C3..C4) + the first 6 nits.
    expect(findings).toHaveLength(10)
    expect(findings.map((f) => f.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6'])
    // planId preserved: C1..C2 from plan-a, C3..C4 from plan-b, nits from plan-b.
    expect(findings.slice(0, 2).every((f) => f.planId === 'plan-a' && f.severity === 'critical')).toBe(true)
    expect(findings.slice(2, 4).every((f) => f.planId === 'plan-b' && f.severity === 'critical')).toBe(true)
    expect(findings.slice(4).every((f) => f.planId === 'plan-b' && f.severity === 'nit')).toBe(true)
  })
})

/* ===========================================================================
 * 1d. doneAt passthrough (spec §6): trimmed string; missing / empty /
 *     whitespace-only / non-string `done_at` → null (always-present nullable
 *     scalar — never omitted).
 * ========================================================================== */

describe('mstar-engine-status — doneAt passthrough (spec §6)', () => {
  it('trims whitespace; empty / whitespace-only / non-string / missing done_at → null', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-doneat-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1', {
        plans: [
          { id: 'plan-a', status: 'Done', done_at: '  2026-08-09  ' },
          { id: 'plan-b', status: 'Done', done_at: '   ' },
          { id: 'plan-c', status: 'Done', done_at: '' },
          { id: 'plan-d', status: 'Done', done_at: 20260810 },
          { id: 'plan-e', status: 'Done' },
        ],
      }),
    })
    booted = await bootApp({ root })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return
    const state = source.state
    expect(source.state).not.toBeNull()
    if (state === null) return
    expect(state.plans).toEqual([
      { id: 'plan-a', status: 'Done', doneAt: '2026-08-09', iterationRefs: [] },
      { id: 'plan-b', status: 'Done', doneAt: null, iterationRefs: [] },
      { id: 'plan-c', status: 'Done', doneAt: null, iterationRefs: [] },
      { id: 'plan-d', status: 'Done', doneAt: null, iterationRefs: [] },
      { id: 'plan-e', status: 'Done', doneAt: null, iterationRefs: [] },
    ])
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
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1', { plans: [{ id: 'plan-a', status: 'Todo' }] }),
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

    // Same turn, TTL-refreshed change (snapshot plan status + register
    // residual changed): the row re-appears with the new state.
    await seedHarness(harnessDir, {
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1', { plans: [{ id: 'plan-a', status: 'Done' }] }),
      'projects/_default/residuals.json': JSON.stringify({
        entries: { 'plan-a': [{ severity: 'critical', description: 'new finding', source_plan: 'plan-a', registered_at: '2026-08-08' }] },
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
