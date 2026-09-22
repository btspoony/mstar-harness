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
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  bindExecutionSession,
  createExecutionWorkflow,
  initializeExecutionAuthority,
  initializeStore,
  openStore,
  registerCatalogEntity,
  storeDbPath,
} from '@mstar-harness/engine'
import {
  adoptExecutionBinding,
  clearExecutionBinding,
  resolveExecutionLedgerTarget,
  resolveActiveWorkflow,
  resolveReadWorkflow,
  _terminalStatusCacheHas,
} from '../src/gates/workflow-selection.ts'
import { updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
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

  it('collects the cwd rung independently after an ambiguous lease rung', async () => {
    const root = await freshRoot('ambiguous-lease-then-cwd')
    const harnessDir = join(root, 'harness')
    const control = join(root, 'repo')
    const elsewhere = join(root, 'elsewhere')
    await mkdir(join(control, 'src'), { recursive: true })
    await mkdir(elsewhere, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      // Both entries match the SAME holder → rung 1 is ambiguous. Only wf-a's
      // control checkout contains the cwd, so wf-a must still win at rung 2.
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', {
        plans: [planRow(lease({ holder: 'agent-7' }))],
        control_worktree_path: control,
      }),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', {
        plans: [planRow(lease({ holder: 'agent-7', worktree_path: elsewhere }))],
        control_worktree_path: elsewhere,
      }),
    })
    expect(resolveActiveWorkflow(harnessDir, { leaseHolder: 'agent-7', cwd: join(control, 'src') })).toEqual({
      kind: 'active',
      workflowId: 'wf-a',
      dir: 'workflows/wf-a',
    })
    // A mixed ambiguity (holder match on wf-a, lease worktree_path match on
    // wf-b) is the same case: the lease rung decides nothing, rung 2 does.
    await seedHarness(harnessDir, {
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', {
        plans: [planRow(lease({ holder: 'omp:iter-other', worktree_path: join(control, 'src') }))],
        control_worktree_path: elsewhere,
      }),
    })
    expect(resolveActiveWorkflow(harnessDir, { leaseHolder: 'agent-7', cwd: join(control, 'src') })).toEqual({
      kind: 'active',
      workflowId: 'wf-a',
      dir: 'workflows/wf-a',
    })
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

  it('a non-object snapshot contributes no automatic evidence and never throws', async () => {
    const root = await freshRoot('null-snapshot')
    const harnessDir = join(root, 'harness')
    const control = join(root, 'repo')
    const elsewhere = join(root, 'elsewhere')
    await mkdir(join(control, 'src'), { recursive: true })
    await mkdir(elsewhere, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      // `readJson` casts arbitrary JSON: a bare `null` is not a snapshot record.
      'workflows/wf-a/snapshot.json': 'null',
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { control_worktree_path: control }),
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(control, 'src') })).toEqual({
      kind: 'active',
      workflowId: 'wf-b',
      dir: 'workflows/wf-b',
    })
    // The malformed entry is the only cwd candidate → no evidence, no throw.
    await seedHarness(harnessDir, {
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { control_worktree_path: elsewhere }),
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(control, 'src') })).toEqual({
      ...UNBOUND,
      activeWorkflowIds: ['wf-a', 'wf-b'],
    })
    // An array parses the same way — the guard is record-ness, not a null check.
    await seedHarness(harnessDir, {
      'workflows/wf-a/snapshot.json': '[]',
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', { control_worktree_path: control }),
    })
    expect(resolveActiveWorkflow(harnessDir, { cwd: join(control, 'src') })).toEqual({
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

  it('rejects every registry entry outside the v2 workflow-entry contract', async () => {
    const root = await freshRoot('entry-contract')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    const cases: Array<[string, unknown]> = [
      // `dir` escaping the harness would make the resolver read outside it.
      ['escape-dir', { id: 'wf-b', type: 'plan', started_at: '2026-08-19', dir: '../outside' }],
      ['absolute-dir', { id: 'wf-b', type: 'plan', started_at: '2026-08-19', dir: '/tmp/outside' }],
      // Required `type` / `started_at` are part of the same contract.
      ['missing-type', { id: 'wf-b', started_at: '2026-08-19', dir: 'workflows/wf-b' }],
      ['missing-started-at', { id: 'wf-b', type: 'plan', dir: 'workflows/wf-b' }],
      ['unknown-type', { id: 'wf-b', type: 'hotfix', started_at: '2026-08-19', dir: 'workflows/wf-b' }],
      // A non-object row is not an entry.
      ['non-object', 'wf-b'],
    ]
    for (const [name, bad] of cases) {
      await seedHarness(harnessDir, {
        'status.json': v2Root([v2WorkflowEntry('wf-a'), bad]),
        'workflows/wf-a/snapshot.json': v2Snapshot('wf-a'),
      })
      expect([name, resolveActiveWorkflow(harnessDir, { selectedWorkflowId: 'wf-a' })]).toEqual([
        name,
        { kind: 'error', code: 'workflow.selection.invalid-entry', message: expect.any(String) },
      ])
    }
  })

  it('rejects a duplicated id in the registry', async () => {
    const root = await freshRoot('duplicate-id')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-a')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a'),
    })
    expect(resolveActiveWorkflow(harnessDir, { selectedWorkflowId: 'wf-a' })).toEqual({
      kind: 'error',
      code: 'workflow.selection.invalid-registry',
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

  it('a non-object status root is a selection error — never a throw', async () => {
    const root = await freshRoot('non-object-status-root')
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    // `readJson` casts arbitrary parsed JSON: a bare `null` (or an array) has
    // no `version`, so the root is rejected as unreadable instead of being
    // dereferenced. The read path inherits the same non-`no-active` error and
    // never falls through to terminal history.
    for (const raw of ['null', '[]']) {
      await seedHarness(harnessDir, { 'status.json': raw })
      expect(resolveActiveWorkflow(harnessDir, { selectedWorkflowId: 'wf-a' })).toEqual({
        kind: 'error',
        code: 'status.unreadable',
        message: expect.any(String),
      })
      expect(resolveReadWorkflow(harnessDir, { selectedWorkflowId: 'wf-a' })).toEqual({
        kind: 'error',
        code: 'status.unreadable',
        message: expect.any(String),
      })
    }
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

it('automatically selects canonical integration cwd and refuses conflicting topology evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-canonical-cwd-'))
  const harnessDir = join(root, 'harness')
  try {
    for (const fields of [
      { integration_worktree_path: join(root, 'integration') },
      { control_worktree_path: join(root, 'integration') },
      { integration_worktree_path: join(root, 'integration'), control_worktree_path: join(root, 'integration') },
    ]) {
      await seedHarness(harnessDir, {
        'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
        'workflows/wf-a/snapshot.json': JSON.stringify({ ...JSON.parse(v2Snapshot('wf-a')), ...fields }),
        'workflows/wf-b/snapshot.json': v2Snapshot('wf-b'),
      })
      const selected = resolveActiveWorkflow(harnessDir, { cwd: join(root, 'integration', 'src') })
      if ('control_worktree_path' in fields && 'integration_worktree_path' in fields) expect(selected.kind).toBe('error')
      else expect(selected).toMatchObject({ kind: 'active', workflowId: 'wf-a' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('requires canonical native adoption for active writers and permits legacy only after clear', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ledger-target-')))
  const harnessDir = join(root, '.mstar')
  const cwd = root
  await mkdir(cwd, { recursive: true })
  try {
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a'),
    })
    const binding = {
      version: 1 as const,
      harnessRoot: harnessDir,
      session: { storeId: 'store-a', epoch: 3, workflowId: 'wf-a', role: 'coordinator' as const, sessionId: 'session-a', planId: null },
    }
    expect(adoptExecutionBinding(harnessDir, 'session-a', cwd, { ...binding, harnessRoot: join(root, 'foreign') })).toBe(false)
    expect(adoptExecutionBinding(harnessDir, 'session-a', cwd, binding)).toBe(true)
    // The DB is absent, so a canonical execution witness cannot silently
    // become a legacy writer or an idle/no-work answer.
    await expect(resolveExecutionLedgerTarget('session-a', cwd)).resolves.toBeNull()
    expect(clearExecutionBinding(harnessDir, 'session-a', cwd)).toBe(true)
    await expect(resolveExecutionLedgerTarget('session-a', cwd)).resolves.toMatchObject({
      workflowId: 'wf-a',
      source: 'legacy',
      epoch: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('legacy targets accept only a real workflow directory (symlinked dir, dangling link, file link)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ledger-legacy-dir-')))
  const harnessDir = join(root, '.mstar')
  const workflowRoot = join(harnessDir, 'workflows')
  const realDir = join(root, 'real-wf-a')
  try {
    await mkdir(realDir, { recursive: true })
    await writeFile(join(realDir, 'snapshot.json'), v2Snapshot('wf-a'))
    await mkdir(workflowRoot, { recursive: true })
    await seedHarness(harnessDir, { 'status.json': v2Root([v2WorkflowEntry('wf-a')]) })

    // A symlinked workflow dir resolves to the CANONICAL spelling: the ledger,
    // its identity index and its cursor must share one dir per lifecycle.
    await symlink(realDir, join(workflowRoot, 'wf-a'))
    await expect(resolveExecutionLedgerTarget('s-legacy', root)).resolves.toEqual({
      workflowId: 'wf-a',
      workflowDir: realDir,
      sessionId: 's-legacy',
      source: 'legacy',
      epoch: null,
    })

    // A dangling symlink is not a directory and must never become a target ...
    await rm(join(workflowRoot, 'wf-a'), { force: true })
    await symlink(join(root, 'gone-wf-a'), join(workflowRoot, 'wf-a'))
    await expect(resolveExecutionLedgerTarget('s-legacy', root)).resolves.toBeNull()

    // ... and neither is a symlink to a regular file.
    const plainFile = join(root, 'not-a-workflow-dir')
    await writeFile(plainFile, 'not a directory\n')
    await rm(join(workflowRoot, 'wf-a'), { force: true })
    await symlink(plainFile, join(workflowRoot, 'wf-a'))
    await expect(resolveExecutionLedgerTarget('s-legacy', root)).resolves.toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * The REAL active authority (`initializeStore` → `initializeExecutionAuthority`
 * → catalog registration → `createExecutionWorkflow` → `bindExecutionSession`),
 * i.e. the same fixture convention `execution-read.spec.ts` uses: nothing here
 * is mocked and no reader result is canned.
 */
it('serves an execution target only for the current canonical session, refusing stale and revoked authority', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ledger-active-')))
  const harnessDir = join(root, '.mstar')
  const cwd = root
  const wfId = 'wf-a'
  const sessionId = 'host-a'
  const stamp = '2026-09-23T00:00:00.000Z'
  try {
    await mkdir(harnessDir, { recursive: true })
    ;(await initializeStore({ harnessDir })).close()
    const initialized = await initializeExecutionAuthority({ harnessDir })
    await registerCatalogEntity(
      { harnessDir },
      { kind: 'plan', id: 'plan-a', title: 'plan-a title', rootKind: 'plans', relativePath: 'plans/plan-a.md' },
      { operationId: 'register-plan-a', actor: 'workflow-selection.spec' },
    )
    const created = await createExecutionWorkflow(
      // The creating identity IS the coordinator that may bind: the engine
      // refuses a coordinator bind from any other caller (only the validated
      // recovery transition replaces the creator), so the fixture keeps one
      // identity for create + bind.
      { harnessDir, caller: { sessionId, role: 'coordinator', workflowId: wfId, planId: null } },
      {
        entry: { id: wfId, type: 'plan', started_at: stamp, dir: `workflows/${wfId}` },
        snapshot: {
          schema_version: 1,
          id: wfId,
          type: 'plan',
          status: 'running',
          started_at: stamp,
          updated_at: stamp,
          plans: [{ id: 'plan-a', title: 'plan-a title', file: 'plans/plan-a.md', status: 'Todo' }],
          delivery_kind: 'development',
          branch: { source: `feature/${wfId}`, target: 'main' },
        } as never,
        expected: initialized.token,
        operationId: 'create-wf-a',
      },
    )
    const bound = await bindExecutionSession(
      { harnessDir, caller: { sessionId, role: 'coordinator', workflowId: wfId, planId: null } },
      {
        workflowId: wfId,
        planId: null,
        role: 'coordinator',
        expected: created.data.workflows[0]!.workflowToken,
        operationId: 'bind-host-a',
      },
    )
    // The row's dir exists only AFTER activation: a legacy workflow dir present
    // at initialisation would refuse the authority itself.
    await mkdir(join(harnessDir, 'workflows', wfId), { recursive: true })
    ;(await openStore({ harnessDir }, 'read')).close()
    const binding = { version: 1 as const, harnessRoot: harnessDir, session: bound.data }

    // Positive: canonical adoption plus the session row current at this store/epoch.
    expect(adoptExecutionBinding(harnessDir, sessionId, cwd, binding)).toBe(true)
    await expect(resolveExecutionLedgerTarget(sessionId, cwd)).resolves.toEqual({
      workflowId: wfId,
      workflowDir: join(harnessDir, 'workflows', wfId),
      sessionId,
      source: 'execution',
      epoch: created.epoch,
    })

    // A witness from another epoch is STALE: no writer, and no re-adoption
    // inferred from the in-memory cache.
    expect(updateWorkflowSessionBinding(harnessDir, sessionId, cwd, {
      executionBinding: { ...binding, session: { ...bound.data, epoch: created.epoch + 5 } },
      excludedBeforeSeq: 0,
    }).kind).toBe('written')
    await expect(resolveExecutionLedgerTarget(sessionId, cwd)).resolves.toBeNull()

    // A REVOKED row (the state `recoverExecutionCoordinator` leaves for the
    // replaced holder — written here as the raw fixture row, the engine's own
    // test convention) is not a current binding.
    expect(updateWorkflowSessionBinding(harnessDir, sessionId, cwd, { executionBinding: binding, excludedBeforeSeq: 0 }).kind).toBe('written')
    const db = new DatabaseSync(storeDbPath({ harnessDir }))
    try {
      // The engine's own revocation statement (`revokeSessionRow`): the prior
      // holder's row is KEPT as history and stops being an ACTIVE binding.
      db.prepare(
        "update execution_sessions set state = 'revoked', revision = revision + 1 " +
          "where workflow_id = ? and role = ? and session_id = ? and state <> 'revoked'",
      ).run(wfId, 'coordinator', sessionId)
    } finally {
      db.close()
    }
    ;(await openStore({ harnessDir }, 'read')).close()
    await expect(resolveExecutionLedgerTarget(sessionId, cwd)).resolves.toBeNull()

    // With the authority ACTIVE a cleared witness yields NO writer: the route
    // is authoritative, so no file-based (legacy) target is inferred.
    expect(clearExecutionBinding(harnessDir, sessionId, cwd)).toBe(true)
    await expect(resolveExecutionLedgerTarget(sessionId, cwd)).resolves.toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
