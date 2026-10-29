/**
 * The milestone write channel (plan 20261029-dashboard-alignment Task 4,
 * contract C1): the three write invocations ride the panel's own typert
 * service, call the engine verbs with the observed store revision, and answer
 * `{ ok, receipt }` or the engine's own refusal verbatim. Milestone REMOVE is
 * deliberately absent: the engine's `removeMilestone` verb is landing on the
 * engine track and the remove action ships after it merges.
 *
 * No test pins this workspace's revision: every expected revision is read
 * through the panel's own `roadmap` view first (contract C2).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { bootApp, seedOpenIssue, seedStore, type BootResult } from './harness.ts'
import { stubGateway } from './gateway-stub.ts'
import { MstarPanelSnapshotClient } from '../src/client/panel/panel-snapshot-client.ts'
import { registerCatalogEntity } from '@mstar-harness/engine'
import {
  PANEL_SNAPSHOT_SERVICE,
  mstarMilestoneAddInvocation,
  mstarMilestoneUpdateInvocation,
  mstarMilestoneAssignInvocation,
  type MilestoneWriteResult,
} from '../src/panel/panel-snapshot-endpoint.ts'
import {
  ENGINE_STATUS_CHANNEL,
  MILESTONE_ADD_ENDPOINT,
  MILESTONE_ASSIGN_ENDPOINT,
  MILESTONE_UPDATE_ENDPOINT,
  MSTAR_MILESTONE_ADD_METHOD,
  MSTAR_MILESTONE_ASSIGN_METHOD,
  MSTAR_MILESTONE_UPDATE_METHOD,
  MSTAR_PANEL_SNAPSHOT_NAMESPACE,
} from '../src/engine-status-wire.ts'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'

let booted: BootResult | undefined
const roots: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface WriteEndpoint {
  milestoneAdd(
    sessionId: string,
    cwd: string,
    projectId: string,
    input: { name: string; target: string | null; ordinal: number },
    mutation: { operationId: string; expectedStoreRevision: number },
  ): Promise<MilestoneWriteResult>
  milestoneUpdate(
    sessionId: string,
    cwd: string,
    projectId: string,
    milestoneId: string,
    patch: { name?: string; target?: string | null; status?: string },
    mutation: { operationId: string; expectedStoreRevision: number },
  ): Promise<MilestoneWriteResult>
  milestoneAssign(
    sessionId: string,
    cwd: string,
    issueId: string,
    input: { projectId: string; milestoneId: string | null; reason: string },
    mutation: { operationId: string; actor: string; expectedRevision: number; expectedStoreRevision: number },
  ): Promise<MilestoneWriteResult>
  dashboardView(
    sessionId: string,
    cwd: string,
    view: string,
    params?: Record<string, string | undefined>,
    id?: string,
  ): Promise<{ kind: string; envelope?: { storeRevision: number; data: unknown } }>
}

function endpointOf(app: BootResult): WriteEndpoint {
  const service = app.ctx.get(PANEL_SNAPSHOT_SERVICE) as WriteEndpoint | undefined
  if (service === undefined) throw new Error('panel-snapshot service not registered')
  return service
}

/** Register the `_default` project the milestone verbs address. */
async function seedProject(harnessDir: string): Promise<void> {
  await registerCatalogEntity(
    { harnessDir },
    { kind: 'project', id: '_default', title: 'Default project', rootKind: 'projects', relativePath: '_default', lifecycle: 'active' },
    { operationId: `seed-project-${harnessDir}`, actor: 'project-manager' },
  )
}

function liveSession(app: BootResult, id: string, cwd: string): void {
  const sessions = app.ctx.get('sessions') as { register(session: unknown): void } | undefined
  if (sessions === undefined) throw new Error('sessions service not mounted')
  sessions.register({ id, header: { cwd }, seq: 0 })
}

/** The observed store revision, read the way the panel reads it (contract C2). */
async function observedRevision(endpoint: WriteEndpoint, sessionId: string, cwd: string): Promise<number> {
  const read = await endpoint.dashboardView(sessionId, cwd, 'roadmap', { project: '_default' })
  if (read.kind !== 'ok' || read.envelope === undefined) throw new Error('roadmap read failed in fixture')
  return read.envelope.storeRevision
}

describe('milestone write descriptors', () => {
  it('registers one invocation per verb on the panel service and namespace', () => {
    for (const [descriptor, method, endpoint] of [
      [mstarMilestoneAddInvocation(), MSTAR_MILESTONE_ADD_METHOD, MILESTONE_ADD_ENDPOINT],
      [mstarMilestoneUpdateInvocation(), MSTAR_MILESTONE_UPDATE_METHOD, MILESTONE_UPDATE_ENDPOINT],
      [mstarMilestoneAssignInvocation(), MSTAR_MILESTONE_ASSIGN_METHOD, MILESTONE_ASSIGN_ENDPOINT],
    ] as const) {
      expect(descriptor).toMatchObject({
        service: PANEL_SNAPSHOT_SERVICE,
        namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
        method,
        invocation: { kind: 'direct' },
        result: { mode: 'src-json' },
      })
      expect(`${descriptor.namespace}/${descriptor.method}`).toBe(endpoint)
    }
  })
})

describe('milestoneAdd / milestoneUpdate — engine verbs with the observed revision', () => {
  it('creates a milestone, then refuses a stale-revision update verbatim', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_ms', app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)

    const before = await observedRevision(endpoint, 'ses_ms', app.root)
    const created = await endpoint.milestoneAdd(
      'ses_ms',
      app.root,
      '_default',
      { name: 'Milestone one', target: '2026-11-30', ordinal: 0 },
      { operationId: 'op-create-1', expectedStoreRevision: before },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const receipt = created.receipt as { milestoneId: string; changed: boolean; storeRevision: number }
    expect(receipt.milestoneId).toBeTruthy()
    expect(receipt.changed).toBe(true)
    expect(receipt.storeRevision).toBe(before + 1)

    // The observed revision moved under the caller: the engine's own refusal,
    // verbatim — code and message pass through, nothing is reworded.
    const stale = await endpoint.milestoneUpdate(
      'ses_ms',
      app.root,
      '_default',
      receipt.milestoneId,
      { name: 'Renamed' },
      { operationId: 'op-update-stale', expectedStoreRevision: before },
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.code).toBe('milestone.revision-conflict')
    expect(stale.message).toContain('revision')
  })

  it('edits name and status with the fresh revision, and the read shows it', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_ms2', app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)

    const created = await endpoint.milestoneAdd(
      'ses_ms2',
      app.root,
      '_default',
      { name: 'Rename me', target: null, ordinal: 0 },
      { operationId: 'op-create-2', expectedStoreRevision: await observedRevision(endpoint, 'ses_ms2', app.root) },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const milestoneId = (created.receipt as { milestoneId: string }).milestoneId

    const updated = await endpoint.milestoneUpdate(
      'ses_ms2',
      app.root,
      '_default',
      milestoneId,
      { name: 'Renamed', status: 'active' },
      { operationId: 'op-update-2', expectedStoreRevision: await observedRevision(endpoint, 'ses_ms2', app.root) },
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect((updated.receipt as { changed: boolean }).changed).toBe(true)

    const read = await endpoint.dashboardView('ses_ms2', app.root, 'roadmap', { project: '_default' })
    const milestones = (read.envelope?.data as { milestones: { milestones: Array<{ name: string; status: string }> } })
      .milestones.milestones
    expect(milestones).toHaveLength(1)
    expect(milestones[0]).toMatchObject({ name: 'Renamed', status: 'active' })
  })

  it('honours the ordinal the caller supplies, so a second create is not silently ordinal 0', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_ms4', app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)

    const first = await endpoint.milestoneAdd(
      'ses_ms4',
      app.root,
      '_default',
      { name: 'First', target: null, ordinal: 0 },
      { operationId: 'op-ordinal-1', expectedStoreRevision: await observedRevision(endpoint, 'ses_ms4', app.root) },
    )
    expect(first.ok).toBe(true)
    // The screen's second create carries the current list length, not a constant:
    // dropping it made every milestone land at ordinal 0 and the board order
    // collapse to insertion order.
    const second = await endpoint.milestoneAdd(
      'ses_ms4',
      app.root,
      '_default',
      { name: 'Second', target: null, ordinal: 1 },
      { operationId: 'op-ordinal-2', expectedStoreRevision: await observedRevision(endpoint, 'ses_ms4', app.root) },
    )
    expect(second.ok).toBe(true)

    const read = await endpoint.dashboardView('ses_ms4', app.root, 'roadmap', { project: '_default' })
    const milestones = (read.envelope?.data as { milestones: { milestones: Array<{ name: string; ordinal: number }> } })
      .milestones.milestones
    expect(milestones.map((row) => [row.name, row.ordinal])).toEqual([
      ['First', 0],
      ['Second', 1],
    ])
  })

  it('replays an identical retry by operationId instead of writing twice', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_ms3', app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)
    const revision = await observedRevision(endpoint, 'ses_ms3', app.root)
    const mutation = { operationId: 'op-replay-1', expectedStoreRevision: revision }
    const first = await endpoint.milestoneAdd('ses_ms3', app.root, '_default', { name: 'Once', target: null, ordinal: 0 }, mutation)
    const second = await endpoint.milestoneAdd('ses_ms3', app.root, '_default', { name: 'Once', target: null, ordinal: 0 }, mutation)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    // And a DIFFERENT request reusing the id is refused, per the engine's rule.
    const conflict = await endpoint.milestoneAdd('ses_ms3', app.root, '_default', { name: 'Other', target: null, ordinal: 1 }, mutation)
    expect(conflict.ok).toBe(false)
    if (conflict.ok) return
    expect(conflict.code).toBe('store.operation-conflict')
  })
})

describe('the client surface — one request per write, arguments intact', () => {
  it('sends the ordinal and the observed revision it was given, on the write endpoint', async () => {
    const gateway = stubGateway({ ok: true, value: { ok: true, receipt: { milestoneId: 'm-1', changed: true } } })
    const client = new MstarPanelSnapshotClient(gateway.connection)
    const result = await client.milestoneAdd({
      sessionId: 's-1',
      cwd: '/proj',
      projectId: '_default',
      input: { name: 'Second', target: '2026-11-30', ordinal: 1 },
      mutation: { operationId: 'op-client-1', expectedStoreRevision: 7 },
    })
    expect(result.ok).toBe(true)
    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0]!.channel).toBe(ENGINE_STATUS_CHANNEL)
    expect(gateway.calls[0]!.endpoint).toBe(MILESTONE_ADD_ENDPOINT)
    expect(gateway.calls[0]!.payload).toEqual({
      args: {
        sessionId: 's-1',
        cwd: '/proj',
        projectId: '_default',
        input: { name: 'Second', target: '2026-11-30', ordinal: 1 },
        mutation: { operationId: 'op-client-1', expectedStoreRevision: 7 },
      },
    })
  })

  it('passes an engine refusal through as the closed union, message intact', async () => {
    const gateway = stubGateway({
      ok: true,
      value: { ok: false, code: 'milestone.revision-conflict', message: '[milestone.revision-conflict] Store revision changed since it was observed.' },
    })
    const client = new MstarPanelSnapshotClient(gateway.connection)
    const result = await client.milestoneUpdate({
      sessionId: 's-1',
      cwd: '/proj',
      projectId: '_default',
      milestoneId: 'm-1',
      patch: { name: 'Renamed' },
      mutation: { operationId: 'op-client-2', expectedStoreRevision: 7 },
    })
    expect(result).toEqual({
      ok: false,
      code: 'milestone.revision-conflict',
      message: '[milestone.revision-conflict] Store revision changed since it was observed.',
    })
    expect(gateway.calls[0]!.endpoint).toBe(MILESTONE_UPDATE_ENDPOINT)
  })
})

describe('milestoneAssign — engine authorization passes through verbatim', () => {
  it('surfaces the engine scope refusal when no coordinator binding exists', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_assign', app.root)
    const endpoint = endpointOf(app)
    const issueId = await seedOpenIssue(app.harnessDir, {
      title: 'Unassigned fixture issue',
      severity: 'low',
      operationId: 'op-assign-seed',
    })
    const result = await endpoint.milestoneAssign(
      'ses_assign',
      app.root,
      issueId,
      { projectId: '_default', milestoneId: null, reason: 'fixture unassign' },
      { operationId: 'op-assign-1', actor: 'project-manager', expectedRevision: 1, expectedStoreRevision: await observedRevision(endpoint, 'ses_assign', app.root) },
    )
    // This workspace holds no ACTIVE coordinator execution session for the
    // fixture DSH session, so the engine refuses; the channel's job is to pass
    // that refusal through untouched.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('issue.scope-refused')
    expect(result.message.length).toBeGreaterThan(0)
  })
})
