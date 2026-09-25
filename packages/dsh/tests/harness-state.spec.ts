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
import { bootApp, seedHarness, seedKnowledgeDoc, seedOpenIssue, seedStore, v2Root, v2Snapshot, v2WorkflowEntry, type BootResult } from './harness.ts'
import { buildCatalogPayload, buildCatalogPayloadWithStore } from '../src/gates/catalog.ts'
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
  // The selected lifecycle's ONLY compass link (D4): direction and the
  // iteration gate come from this `compass_ref`, never a directory-wide
  // first-active compass scan. `migrate.ts` producer shape — the linked
  // compass frontmatter `iteration_id` equals the snapshot id.
  compass_ref: 'iterations/v2.2.0/delivery-compass.md',
  plans: [
    {
      plan_id: 'plan-a',
      title: 'Plan A',
      file: 'plans/plan-a.md',
      status: 'InProgress',
      // No done_at: the always-present doneAt must project to null.
      execution_lease: {
        holder: 'dsh-session-1',
        claimed_at: '2026-08-08',
        worktree_path: '/worktrees/plan-a',
        working_branch: 'feature/plan-a',
      },
    },
    { id: 'plan-b', title: 'Plan B', file: 'plans/plan-b.md', status: 'Done', done_at: '2026-08-08' },
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
  integration_worktree_path: '/integration/worktree',
})
/** The project register (the v1 `residual_findings` home after migrate). */
const RICH_REGISTER = JSON.stringify({
  entries: {
    'plan-b': [
      { id: 'R9', title: 'legacy register row (must stay invisible)', severity: 'critical', lifecycle: 'open', source_plan: 'plan-b', registered_at: '2026-08-08' },
    ],
  },
})

/** The RICH fixture's open issues — the authority the digest reads. */
const RICH_ISSUES = [
  { title: 'deferred blocker', severity: 'high' as const, operationId: 'op-rich-1' },
  { title: 'style nit', severity: 'info' as const, operationId: 'op-rich-2' },
]

/** The RICH fixture's registered knowledge documents (categories in path order). */
const RICH_DOCS = [
  { id: 'doc-shape', relativePath: 'architecture-patterns/dsh-plugin-shape.md', title: 'Plugin shape' },
  { id: 'doc-context', relativePath: 'conventions/harness-context.md', title: 'Harness context' },
]

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
    // The issue/catalog authority: a real store holding the fixture's open
    // issues and its registered knowledge rows. The seeded README index and
    // register above stay on disk to prove neither is read.
    await seedStore(harnessDir)
    for (const issue of RICH_ISSUES) await seedOpenIssue(harnessDir, { ...issue })
    for (const doc of RICH_DOCS) {
      await seedKnowledgeDoc(harnessDir, { ...doc, operationId: `op-doc-${doc.id}` })
    }
    const inbox = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })]

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    // ONE unified row.
    expect(decision.messages.length).toBe(inbox.length + 1)

    const row = lastMessage(decision)
    expect(row?.source).toEqual({ kind: 'plugin', plugin: 'mstar-engine', form: 'catalog' })
    if (row?.source.kind !== 'plugin') return
    // The catalog payload is NOT persisted on the row's source — it is read
    // from the same builder the pre-step listener rendered the row from.
    const payload = await buildCatalogPayloadWithStore(booted!.ctx, harnessDir)

    // Iteration gate section (steering compass + selected workflow snapshot resolve).
    expect(payload.iteration).toMatchObject({
      iterationId: 'v2.2.0',
      statusPath: join(harnessDir, `workflows/${RICH_WORKFLOW}/snapshot.json`),
      gate: { transition: 'phase-2-execute', all_plans_done: false },
    })

    // Workspace-state section.
    expect(payload.state).toMatchObject({
      selection: { kind: 'active', workflowId: RICH_WORKFLOW, dir: `workflows/${RICH_WORKFLOW}` },
      plans: [
        { id: 'plan-a', status: 'InProgress', doneAt: null },
        { id: 'plan-b', status: 'Done', doneAt: '2026-08-08' },
      ],
      residuals: [
        { severity: 'high', count: 1 },
        { severity: 'info', count: 1 },
      ],
      residualFindings: [
        { planId: '', id: 'I-000001', severity: 'high', title: 'deferred blocker' },
        { planId: '', id: 'I-000002', severity: 'info', title: 'style nit' },
      ],
      iterationBaseBranch: 'dev-dsh',
      targetBranch: 'dev-dsh',
      specIntegrationBranch: 'iteration/v2.2.0',
      pushPolicy: 'no-push',
      worktreeMode: 'feature-worktree',
      integrationWorktreePath: '/integration/worktree',
      leases: [{ planId: 'plan-a', holder: 'dsh-session-1', worktreePath: '/worktrees/plan-a' }],
      knowledge: { docCount: 2, categories: ['architecture-patterns', 'conventions'] },
    })
    const text = textOf(row)
    expect(text).toContain('<mstar_engine_status>')
    expect(text).toContain(`mstar version: ${ENGINE_VERSION}`)
    expect(text).toContain('harness dir:')
    expect(text).toContain('iteration: v2.2.0')
    expect(text).toContain('gate: PASS')
    expect(text).toContain(`workflow: ${RICH_WORKFLOW} (active)`)
    expect(text).toContain('plans: plan-a(InProgress) plan-b(Done)')
    expect(text).toContain('residuals: high 1, info 1')
    expect(text).toContain('branch: dev-dsh → dev-dsh (spec integration: iteration/v2.2.0)')
    expect(text).toContain('policy: push no-push; worktree feature-worktree; integration /integration/worktree')
    expect(text).toContain('leases: plan-a → dsh-session-1 (/worktrees/plan-a)')
    expect(text).toContain('knowledge: 2 docs (architecture-patterns, conventions)')
    expect(text).toContain('direction: The dsh host plugin needs richer in-session harness context for operators.')
    expect(text).toContain('</mstar_engine_status>')
  })

  it('falls back to compass frontmatter for base/target branches when the snapshot carries no branch anchors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-branch-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    // The compass MUST belong to the SELECTED workflow (D4): `compass_ref`
    // points at this lifecycle's own compass and the frontmatter
    // `iteration_id` equals the snapshot id, so the base/target fallback can
    // never borrow another iteration's compass.
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-branch')]),
      'workflows/wf-branch/snapshot.json': v2Snapshot('wf-branch', {
        compass_ref: 'iterations/wf-branch/delivery-compass.md',
      }),
      'iterations/wf-branch/delivery-compass.md': '---\niteration_id: wf-branch\nstatus: active\niteration_base_branch: dev-dsh\ntarget_branch: dev-dsh\n---\n',
    })
    booted = await bootApp({ root })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    if (row?.source.kind !== 'plugin') return
    // The catalog payload is NOT persisted on the row's source — it is read
    // from the same builder the pre-step listener rendered the row from.
    const payload = await buildCatalogPayloadWithStore(booted!.ctx, harnessDir)
    expect(payload.state).toMatchObject({ iterationBaseBranch: 'dev-dsh', targetBranch: 'dev-dsh' })
    expect(textOf(row)).toContain('branch: dev-dsh → dev-dsh')
  })
})

/* ===========================================================================
 * 1b. open-issue semantics: the digest reads store.db, and an unreadable
 *     authority is disclosed instead of reported as "no open issues".
 * ========================================================================== */

describe('mstar-engine-status — open-issue facts come from the store', () => {
  it('no store at all → residualFindings null + an explicit unavailable disclosure', async () => {
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
    if (row?.source.kind !== 'plugin') return
    const payload = await buildCatalogPayloadWithStore(booted!.ctx, harnessDir)
    expect(payload.state).toMatchObject({ residuals: [], residualFindings: null })
    expect(payload.state?.storeFacts?.kind).toBe('unavailable')
    expect(payload.state?.storeFacts?.diagnostic).toContain('store.not-initialized')
    // The model-facing row says so rather than claiming "none open".
    expect(textOf(row)).toContain('residuals: unavailable')
  })

  it('an active store with no open issue → residualFindings [] (an authoritative empty answer)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-noopen-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
    })
    booted = await bootApp({ root })
    await seedStore(harnessDir)

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    if (row?.source.kind !== 'plugin') return
    const payload = await buildCatalogPayloadWithStore(booted!.ctx, harnessDir)
    expect(payload.state).toMatchObject({ residualFindings: [], residuals: [] })
    expect(textOf(row)).toContain('residuals: none open')
  })
})

/* ===========================================================================
 * 1c. The detail rows carry the AUTHORITY's own order and fields: severity
 *     rank desc → last activity desc → id asc, severity verbatim, capped 10.
 * ========================================================================== */

describe('mstar-engine-status — open-issue detail order, fields and cap', () => {
  /** Seed a v2 tree plus a store holding one open issue per severity; returns the harness dir. */
  async function seedWithIssues(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-register-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
    })
    booted = await bootApp({ root })
    await seedStore(harnessDir)
    return harnessDir
  }

  it('severity is the issue vocabulary verbatim, and the buckets read critical→info', async () => {
    const harnessDir = await seedWithIssues()
    await seedOpenIssue(harnessDir, { title: 'info issue', severity: 'info', operationId: 'op-i' })
    await seedOpenIssue(harnessDir, { title: 'critical issue', severity: 'critical', operationId: 'op-c' })
    await seedOpenIssue(harnessDir, { title: 'medium issue', severity: 'medium', operationId: 'op-m' })

    const payload = await buildCatalogPayloadWithStore(booted!.ctx, harnessDir)
    expect(payload.state?.residuals).toEqual([
      { severity: 'critical', count: 1 },
      { severity: 'medium', count: 1 },
      { severity: 'info', count: 1 },
    ])
    // Severity rank desc first: the critical leads regardless of capture order.
    expect(payload.state?.residualFindings?.map((finding) => [finding.severity, finding.title])).toEqual([
      ['critical', 'critical issue'],
      ['medium', 'medium issue'],
      ['info', 'info issue'],
    ])
  })

  it('twelve open issues → the detail view is capped at 10 while the buckets count all twelve', async () => {
    const harnessDir = await seedWithIssues()
    for (let index = 1; index <= 4; index++) {
      await seedOpenIssue(harnessDir, { title: `critical ${index}`, severity: 'critical', operationId: `op-c${index}` })
    }
    for (let index = 1; index <= 8; index++) {
      await seedOpenIssue(harnessDir, { title: `info ${index}`, severity: 'info', operationId: `op-n${index}` })
    }

    const payload = await buildCatalogPayloadWithStore(booted!.ctx, harnessDir)
    expect(payload.state?.residuals).toEqual([
      { severity: 'critical', count: 4 },
      { severity: 'info', count: 8 },
    ])
    const findings = payload.state?.residualFindings
    expect(findings).toHaveLength(10)
    // The four criticals lead; the six info rows shown are whichever the
    // authority's own order ranked highest WITHIN that severity (rank desc →
    // last real activity desc → id asc — the info rows were captured at
    // different instants, so their activity order, not their id order,
    // decides). What the display must never do is invent a rank or an id.
    const criticalIds = new Set(['I-000001', 'I-000002', 'I-000003', 'I-000004'])
    expect(findings?.slice(0, 4).every((finding) => finding.severity === 'critical' && criticalIds.has(finding.id))).toBe(true)
    expect(findings?.slice(4).every((finding) => finding.severity === 'info')).toBe(true)
    const infoIds = new Set(Array.from({ length: 8 }, (_, index) => `I-${String(index + 5).padStart(6, '0')}`))
    expect(findings?.slice(4).every((finding) => infoIds.has(finding.id))).toBe(true)
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
          { id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Done', done_at: '  2026-08-09  ' },
          { id: 'plan-b', title: 'Plan B', file: 'plans/plan-b.md', status: 'Done', done_at: '   ' },
          { id: 'plan-c', title: 'Plan C', file: 'plans/plan-c.md', status: 'Done', done_at: '' },
          { id: 'plan-d', title: 'Plan D', file: 'plans/plan-d.md', status: 'Done', done_at: 810 },
          { id: 'plan-e', title: 'Plan E', file: 'plans/plan-e.md', status: 'Done' },
        ],
      }),
    })
    booted = await bootApp({ root })

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const row = lastMessage(decision)
    if (row?.source.kind !== 'plugin') return
    // The catalog payload is NOT persisted on the row's source — it is read
    // from the same builder the pre-step listener rendered the row from.
    const payload = await buildCatalogPayloadWithStore(booted!.ctx, harnessDir)
    const state = payload.state
    expect(payload.state).not.toBeNull()
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
    if (row?.source.kind !== 'plugin') return
    // The catalog payload is NOT persisted on the row's source — it is read
    // from the same builder the pre-step listener rendered the row from.
    const payload = await buildCatalogPayloadWithStore(booted!.ctx, harnessDir)
    expect(payload.state).toBeNull()
    expect(payload.iteration).toBeUndefined()
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
    if (row?.source.kind !== 'plugin') return
    // No explicit `harnessDir` config and an agent-less payload → the
    // resolved `{HARNESS_DIR}` is null (the payload the listener built).
    const payload = buildCatalogPayload(booted!.ctx, null)
    expect(payload.harnessDir).toBeNull()
    expect(payload.state).toBeNull()
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
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1', { plans: [{ id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Todo' }] }),
    })
    await seedStore(harnessDir)
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

    // Same turn, TTL-refreshed change (snapshot plan status + a new store
    // issue): the row re-appears with the new state.
    await seedHarness(harnessDir, {
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1', { plans: [{ id: 'plan-a', title: 'Plan A', file: 'plans/plan-a.md', status: 'Done' }] }),
    })
    await seedOpenIssue(harnessDir, { title: 'new finding', severity: 'critical', operationId: 'op-ttl' })
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
