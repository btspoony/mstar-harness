/**
 * Plan  Task 3 (f12) — terminalStatusCache eviction
 * on file deletion.
 *
 * The terminal-mtime fallback (`resolveReadWorkflow`) walks every workflow
 * dir per catalog refresh; the module-level `terminalStatusCache` holds a
 * snapshot path → `{ mtimeMs, terminal }` verdict with a 64-entry cap.
 * The cache cap once left a key whose
 * target file was deleted: the `resolveReadWorkflow` loop short-circuits on
 * `!existsSync(snapshotPath)` and never reaches `terminalStatusOf`, so the
 * stale entry kept holding the cap while the dead workflow stayed
 * invisible. This spec pins the eviction contract:
 *
 * - after a cached terminal snapshot is deleted, the next read re-probes
 *   (the deleted workflow id is never selected) AND the cache key is gone;
 * - deleting the whole workflow dir is equivalent to deleting the snapshot
 *   file (both hit the `existsSync` short-circuit).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveActiveWorkflow,
  resolveReadWorkflow,
  _terminalStatusCacheHas,
} from '../src/gates/workflow-selection.ts'
import { leaseGateViolations } from '../src/gates/dispatch.ts'
import { seedHarness, v2Root, v2Snapshot, v2WorkflowEntry } from './harness.ts'

describe('workflow selection — terminalStatusCache eviction on deletion (f12)', () => {
  it('deleting the workflow dir evicts the cached key; the next read re-probes and selects nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-wfsel-evict-dir-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([]),
      'workflows/wf-new/snapshot.json': v2Snapshot('wf-new', { status: 'completed', ended_at: '2026-08-19', plans: [{ id: 'plan-new', status: 'Done' }] }),
    })
    const snapshotPath = join(harnessDir, 'workflows/wf-new/snapshot.json')

    // First read populates the cache (terminal verdict cached by mtime).
    expect(resolveReadWorkflow(harnessDir)).toEqual({ kind: 'terminal', workflowId: 'wf-new', dir: 'workflows/wf-new' })

    // Delete the whole workflow dir.
    await rm(join(harnessDir, 'workflows/wf-new'), { recursive: true, force: true })

    // The next read re-probes: no terminal snapshot remains — the deleted
    // workflow must NOT be selected, and the dead cache key must be gone.
    expect(resolveReadWorkflow(harnessDir)).toEqual({
      kind: 'error',
      code: 'workflow.selection.no-snapshot',
      message: expect.stringContaining('no terminal workflow snapshot'),
    })
    expect(_terminalStatusCacheHas(snapshotPath)).toBe(false)
  })

  it('deleting just the snapshot.json evicts the cached key; a remaining terminal is still selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-wfsel-evict-file-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([]),
      'workflows/wf-old/snapshot.json': v2Snapshot('wf-old', { status: 'completed', ended_at: '2026-08-18', plans: [{ id: 'plan-old', status: 'Done' }] }),
      'workflows/wf-new/snapshot.json': v2Snapshot('wf-new', { status: 'completed', ended_at: '2026-08-19', plans: [{ id: 'plan-new', status: 'Done' }] }),
    })
    // Deterministic mtimes: wf-old older, wf-new newer (selection by file mtime).
    const oldPath = join(harnessDir, 'workflows/wf-old/snapshot.json')
    const newPath = join(harnessDir, 'workflows/wf-new/snapshot.json')
    const base = Date.now() / 1000
    await utimes(oldPath, base - 200, base - 200)
    await utimes(newPath, base - 100, base - 100)

    // First read caches both verdicts and selects the newest terminal.
    expect(resolveReadWorkflow(harnessDir)).toEqual({ kind: 'terminal', workflowId: 'wf-new', dir: 'workflows/wf-new' })
    expect(_terminalStatusCacheHas(newPath)).toBe(true)

    // Delete only the newest snapshot file (dir remains).
    await rm(newPath, { force: true })

    // The next read must not select the deleted workflow; it falls back to
    // the surviving terminal, and the dead key is evicted from the cache.
    expect(resolveReadWorkflow(harnessDir)).toEqual({ kind: 'terminal', workflowId: 'wf-old', dir: 'workflows/wf-old' })
    expect(_terminalStatusCacheHas(newPath)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* D4 — session-scoped binding order (locked 2026-09-11)                       */
/* -------------------------------------------------------------------------- */

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true })
})

/** Fresh synthetic root under the OS temp dir (REAL dirs — the containment rule compares realpaths when both sides exist). */
async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-mstar-wfsel-${prefix}-`))
  roots.push(root)
  return root
}

/** One engine-valid `execution_lease` row. */
function lease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    holder: 'agent-1',
    claimed_at: '2026-09-11',
    worktree_path: '/srv/worktrees/wf-a',
    working_branch: 'feature/wf-a',
    ...overrides,
  }
}

/** A snapshot plan row carrying (or omitting) an `execution_lease`. */
function planRow(executionLease?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'p1',
    status: 'InProgress',
    ...(executionLease === undefined ? {} : { execution_lease: executionLease }),
  }
}

const UNBOUND = {
  kind: 'error' as const,
  code: 'workflow.selection.unbound-multi-active',
  message: expect.any(String) as unknown as string,
}

describe('workflow selection — binding order: lease', () => {
  it('binds the workflow whose lease holder matches — never the registry-first entry', async () => {
    const root = await freshRoot('lease-holder')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    const snapshots = {
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { plans: [planRow(lease({ holder: 'omp:iter-other' }))] }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { plans: [planRow(lease({ holder: 'agent-7' }))] }),
    }
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      ...snapshots,
    })
    expect(resolveActiveWorkflow(harnessDir, { leaseHolder: 'agent-7' })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
    // Registry order is not an input: the reversed list gives the same answer.
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-b'), v2WorkflowEntry('wf-a')]),
    })
    expect(resolveActiveWorkflow(harnessDir, { leaseHolder: 'agent-7' })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
  })

  it('binds a workflow whose lease worktree_path contains the session cwd', async () => {
    const root = await freshRoot('lease-cwd')
    const harnessDir = join(root, 'harness')
    const worktreeB = join(root, 'repo/.worktrees/wf-b')
    await mkdir(join(worktreeB, 'src'), { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', {
        plans: [planRow(lease({ worktree_path: join(root, 'repo/.worktrees/wf-a') }))],
      }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', {
        plans: [planRow(lease({ worktree_path: worktreeB }))],
      }),
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(worktreeB, 'src') })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
    // The worktree root itself is contained too.
    expect(resolveActiveWorkflow(harnessDir, { cwd: worktreeB })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
    // A sibling worktree is not.
    await mkdir(join(root, 'repo/.worktrees/wf-c'), { recursive: true })
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(root, 'repo/.worktrees/wf-c') })).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
  })

  it('an `omp:iter-…` holder never matches a bare dsh Agent.id (no prefix coercion)', async () => {
    const root = await freshRoot('opaque-holder')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { plans: [planRow(lease({ holder: 'omp:iter-1234' }))] }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { plans: [planRow(lease({ holder: 'agent-7' }))] }),
    })
    expect(resolveActiveWorkflow(harnessDir, { leaseHolder: 'iter-1234' }).kind).toBe('error')
    expect(resolveActiveWorkflow(harnessDir, { leaseHolder: 'agent-7' })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
    expect(resolveActiveWorkflow(harnessDir, { leaseHolder: 'omp:iter-1234' })).toEqual({
      kind: 'active',
      workflowId: 'wf-a',
      dir: 'workflows/wf-a',
    })
  })

  it('an invalid lease carries no automatic evidence', async () => {
    const root = await freshRoot('invalid-lease')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      // A tombstone lease (null) and a lease missing working_branch are both invalid.
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { plans: [planRow(undefined), { id: 'p2', execution_lease: null }] }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', {
        plans: [{ id: 'p3', execution_lease: lease({ working_branch: '' }) }],
      }),
    })
    expect(resolveActiveWorkflow(harnessDir, { leaseHolder: 'agent-1' })).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
  })
})

describe('workflow selection — binding order: cwd', () => {
  it('binds a workflow whose control_worktree_path contains the session cwd — `/repo` is not `/repo-other`', async () => {
    const root = await freshRoot('control-cwd')
    const harnessDir = join(root, 'harness')
    const control = join(root, 'repo')
    await mkdir(join(control, 'src'), { recursive: true })
    await mkdir(join(root, 'repo-other'), { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { control_worktree_path: control }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { control_worktree_path: join(root, 'elsewhere') }),
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(control, 'src') })).toEqual({
      kind: 'active',
      workflowId: 'wf-a',
      dir: 'workflows/wf-a',
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: control })).toEqual({
      kind: 'active',
      workflowId: 'wf-a',
      dir: 'workflows/wf-a',
    })
    // A lexical-prefix sibling is NOT contained (no longest-prefix arbitration).
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(root, 'repo-other') })).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
  })

  it('follows a symlink that stays inside the root and refuses one that escapes it', async () => {
    const root = await freshRoot('symlink')
    const harnessDir = join(root, 'harness')
    const control = join(root, 'repo')
    await mkdir(join(control, 'real'), { recursive: true })
    await mkdir(join(root, 'outside'), { recursive: true })
    await symlink(join(control, 'real'), join(control, 'link'))
    await symlink(join(root, 'outside'), join(control, 'esc'))
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { control_worktree_path: control }),
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(control, 'link') })).toEqual({
      kind: 'active',
      workflowId: 'wf-a',
      dir: 'workflows/wf-a',
    })
    // The escaping link resolves outside `/repo` — no automatic evidence.
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(control, 'esc') }).kind).toBe('error')
  })

  it('compares normalized absolute lexical paths when a path does not exist yet', async () => {
    const root = await freshRoot('lexical')
    const harnessDir = join(root, 'harness')
    const ghost = join(root, 'ghost-repo')
    const sibling = join(root, 'ghost-repo-other')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { control_worktree_path: ghost }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { control_worktree_path: sibling }),
    })
    // Trailing separators and `..` segments normalize away on both sides.
    expect(resolveActiveWorkflow(harnessDir, { cwd: `${ghost}/src/` })).toEqual({
      kind: 'active',
      workflowId: 'wf-a',
      dir: 'workflows/wf-a',
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: `${ghost}/deep/../src` }).kind).toBe('active')
    // The lexical segment boundary holds: `…/ghost-repo` is not `…/ghost-repo-other`.
    expect(resolveActiveWorkflow(harnessDir, { cwd: sibling })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: `${root}/ghost-repo-deep/src` }).kind).toBe('error')
  })

  it('a duplicated control root is ambiguous at rung 2 and falls through to the explicit pick', async () => {
    const root = await freshRoot('shared-control')
    const harnessDir = join(root, 'harness')
    const control = join(root, 'repo')
    await mkdir(join(control, 'src'), { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { control_worktree_path: control }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { control_worktree_path: control }),
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(control, 'src') })).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(control, 'src'), selectedWorkflowId: 'wf-b' })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
  })

  it('a unique lease/cwd match outranks a stale explicit preference', async () => {
    const root = await freshRoot('stale-explicit')
    const harnessDir = join(root, 'harness')
    const control = join(root, 'repo')
    await mkdir(join(control, 'src'), { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { control_worktree_path: join(root, 'elsewhere') }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { control_worktree_path: control }),
    })
    expect(
      resolveActiveWorkflow(harnessDir, { cwd: join(control, 'src'), selectedWorkflowId: 'wf-a' }),
    ).toEqual({ kind: 'active', workflowId: 'wf-b', dir: 'workflows/wf-b' })
  })
})

describe('workflow selection — binding order: explicit, unique, unbound', () => {
  it('an omitted hint with two actives is the unbound error carrying the active ids', async () => {
    const root = await freshRoot('unbound')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { plans: [planRow(lease())] }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { plans: [planRow(lease({ holder: 'agent-2' }))] }),
    })
    expect(resolveActiveWorkflow(harnessDir)).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
    // Never the first entry, with or without a hint that misses.
    expect(resolveActiveWorkflow(harnessDir, { cwd: '/nowhere' })).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
  })

  it('an explicit pick of an active id binds that workflow', async () => {
    const root = await freshRoot('explicit')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
    })
    expect(resolveActiveWorkflow(harnessDir, { selectedWorkflowId: 'wf-b' })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
  })

  it('an explicit id that is not active is ignored — a terminal id is never revived', async () => {
    const root = await freshRoot('terminal-explicit')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-gone/snapshot.json': v2Snapshot('wf-gone', { status: 'completed', ended_at: '2026-09-11' }),
    })
    expect(resolveActiveWorkflow(harnessDir, { selectedWorkflowId: 'wf-gone' })).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
    // …and read never substitutes that newer terminal snapshot for the pick.
    expect(resolveReadWorkflow(harnessDir, { selectedWorkflowId: 'wf-gone' })).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
  })

  it('a unique active registry needs no pick and carries no warning', async () => {
    const root = await freshRoot('unique')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-only')]),
      'workflows/wf-only/snapshot.json': v2Snapshot('wf-only'),
    })
    expect(resolveActiveWorkflow(harnessDir)).toEqual({
      kind: 'active',
      workflowId: 'wf-only',
      dir: 'workflows/wf-only',
    })
    expect(resolveReadWorkflow(harnessDir)).toEqual({
      kind: 'active',
      workflowId: 'wf-only',
      dir: 'workflows/wf-only',
    })
  })

  it('read forwards the hint to the same resolver', async () => {
    const root = await freshRoot('read-hint')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', { plans: [planRow(lease({ holder: 'agent-1' }))] }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { plans: [planRow(lease({ holder: 'agent-2' }))] }),
    })
    expect(resolveReadWorkflow(harnessDir, { leaseHolder: 'agent-2' })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
    expect(resolveReadWorkflow(harnessDir)).toEqual({ ...UNBOUND, activeWorkflowIds: ['wf-a', 'wf-b'] })
  })

  it('an unreadable snapshot removes only the automatic evidence — explicit and unique still select', async () => {
    const root = await freshRoot('unreadable')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      // wf-a has no snapshot at all; wf-b's is torn.
      'workflows/wf-b/snapshot.json': '{"schema_version":1,"id":"wf-b",',
    })
    expect(resolveActiveWorkflow(harnessDir, { leaseHolder: 'agent-1' })).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
    expect(resolveActiveWorkflow(harnessDir, { selectedWorkflowId: 'wf-b' })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
  })

  it('validates every registry entry — a bad entry is an error, not a smaller active set', async () => {
    const root = await freshRoot('invalid-entry')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), { id: 'wf-b' }]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a'),
    })
    const selection = resolveActiveWorkflow(harnessDir, { selectedWorkflowId: 'wf-a' })
    expect(selection).toEqual({
      kind: 'error',
      code: 'workflow.selection.invalid-entry',
      message: expect.any(String),
    })
  })

  it('only a real empty registry is `no-active`', async () => {
    const root = await freshRoot('registry-shape')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 2, updated_at: '2026-09-11', workflows: 'wf-a' }),
    })
    const selection = resolveActiveWorkflow(harnessDir)
    expect(selection.kind).toBe('error')
    expect(selection.kind === 'error' ? selection.code : '').not.toBe('workflow.selection.no-active')
    await seedHarness(harnessDir, { 'status.json': v2Root([]) })
    expect(resolveActiveWorkflow(harnessDir)).toEqual({
      kind: 'error',
      code: 'workflow.selection.no-active',
      message: expect.any(String),
    })
  })
})

describe('workflow selection — a cwd/lease binding is attribution, never lease ownership', () => {
  const PLAN_ID = '20260911-bind-attribution'
  const AGENT = 'agent-dispatch-1'

  it('a cwd bind does not erase the existing lease.dispatch.holder-mismatch', async () => {
    const root = await freshRoot('attribution')
    const worktree = join(root, 'worktrees/bind-attribution')
    await mkdir(join(worktree, 'src'), { recursive: true })
    const assignment = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Execution mode**: sdd
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${worktree}
**Working branch**: feature/bind-attribution

Do the thing.
`
    const exec = { agent: { id: AGENT } } as unknown as Parameters<typeof leaseGateViolations>[1]
    const leaseRow = lease({
      holder: 'omp:iter-1234',
      worktree_path: worktree,
      working_branch: 'feature/bind-attribution',
    })
    const seedFor = async (id: string, workflows: string[]): Promise<string> => {
      const harnessDir = join(id, 'harness')
      await mkdir(harnessDir, { recursive: true })
      await seedHarness(harnessDir, {
        'status.json': v2Root(workflows.map((workflowId) => v2WorkflowEntry(workflowId))),
        'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', {
          plans: [{ id: PLAN_ID, status: 'InProgress', execution_lease: leaseRow }],
        }),
        'workflows/wf-b/snapshot.json': v2Snapshot('wf-b'),
      })
      return harnessDir
    }
    const harnessDir = await seedFor(root, ['wf-a', 'wf-b'])

    // Two actives: the cwd rung binds wf-a (its lease worktree contains the cwd),
    // and wf-a's lease holder is the control-side vocabulary — never this Agent.id.
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(worktree, 'src') })).toEqual({
      kind: 'active',
      workflowId: 'wf-a',
      dir: 'workflows/wf-a',
    })
    // The hint-less gate never adopts wf-a's lease: the ambiguous active set is
    // reported unverifiable (fail-closed) — it does not silently pass.
    expect(leaseGateViolations(harnessDir, exec, true, assignment).map((v) => v.code)).toEqual([
      'lease.dispatch.unverifiable',
    ])
    // With one active workflow (the same snapshot bytes) the no-steal check still
    // fires: binding is attribution, the lease holder remains authoritative.
    const single = await seedFor(await freshRoot('attribution-single'), ['wf-a'])
    expect(leaseGateViolations(single, exec, true, assignment).map((v) => v.code)).toContain(
      'lease.dispatch.holder-mismatch',
    )
  })
})
