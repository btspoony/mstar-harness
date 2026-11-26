/**
 * The milestone write channel (the dashboard alignment change, Task 4,
 * contract C1): the four write invocations — add, update, assign/unassign and
 * remove — ride the panel's own typert service, call the engine verbs with the
 * observed store revision, and answer `{ ok, receipt }` or the engine's own
 * refusal verbatim. Removal's emptiness rule is the engine's
 * (`milestone.not-empty`), so the attempt is made and the refusal passed
 * through.
 *
 * No test pins this workspace's revision: every expected revision is read
 * through the panel's own `roadmap` view first (contract C2).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { bootApp, seedOpenIssue, seedStore, type BootResult } from './harness.ts'
import { stubGateway } from './gateway-stub.ts'
import {
  MstarPanelSnapshotClient,
  type MstarPanelSnapshotConnection,
} from '../src/client/panel/panel-snapshot-client.ts'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { createMilestoneWrites, writeOperationIds } from '../src/client/panel/panel-shell.tsx'
import { registerCatalogEntity, withCollaborationWrite } from '@mstar-harness/engine'
import {
  PANEL_SNAPSHOT_SERVICE,
  mstarMilestoneAddInvocation,
  mstarMilestoneUpdateInvocation,
  mstarMilestoneAssignInvocation,
  mstarMilestoneRemoveInvocation,
  type MilestoneWriteResult,
} from '../src/panel/panel-snapshot-endpoint.ts'
import {
  ENGINE_STATUS_CHANNEL,
  MILESTONE_ADD_ENDPOINT,
  MILESTONE_ASSIGN_ENDPOINT,
  MILESTONE_REMOVE_ENDPOINT,
  MILESTONE_UPDATE_ENDPOINT,
  MSTAR_MILESTONE_ADD_METHOD,
  MSTAR_MILESTONE_ASSIGN_METHOD,
  MSTAR_MILESTONE_REMOVE_METHOD,
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
    input: { name: string; effortSessions: number | null; ordinal: number },
    mutation: { operationId: string; expectedStoreRevision: number },
  ): Promise<MilestoneWriteResult>
  milestoneUpdate(
    sessionId: string,
    cwd: string,
    projectId: string,
    milestoneId: string,
    patch: { name?: string; effortSessions?: number | null; status?: string },
    mutation: { operationId: string; expectedStoreRevision: number },
  ): Promise<MilestoneWriteResult>
  milestoneRemove(
    sessionId: string,
    cwd: string,
    projectId: string,
    milestoneId: string,
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

/**
 * Attach one issue to a milestone directly in the store, so the removal suite
 * holds a non-empty milestone without depending on the assign CHANNEL.
 */
async function assignDirectly(harnessDir: string, milestoneId: string | null, issueId: string): Promise<void> {
  // note: Issues are collaboration facts after the cutover: assign on that lane (the
  // execution store holds no issue rows).
  await withCollaborationWrite({ harnessDir }, ({ db }) => {
    db.prepare('update issues set milestone_id=? where id=?').run(milestoneId, issueId)
  })
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

interface RoadmapMilestone {
  milestoneId: string
  name: string
  status: string
  effortSessions: number | null
}

async function roadmapMilestones(endpoint: WriteEndpoint, sessionId: string, cwd: string): Promise<RoadmapMilestone[]> {
  const read = await endpoint.dashboardView(sessionId, cwd, 'roadmap', { project: '_default' })
  if (read.envelope === undefined) throw new Error('roadmap read failed in fixture')
  return (read.envelope.data as { milestones: { milestones: RoadmapMilestone[] } }).milestones.milestones
}

// why: route the production client's RPC at the REAL panel service, so a spec drives
// the client and shell over the real store — only the transport is local. A dropped
// or coerced `effortSessions` in either half then fails the readback below.
function serviceConnection(service: WriteEndpoint): MstarPanelSnapshotConnection {
  return {
    rpc: {
      async call(_channel: string, endpoint: string, payload: unknown): Promise<ConnectionRpcResult<unknown>> {
        const args = (payload as { args: Record<string, unknown> }).args
        const sessionId = String(args.sessionId)
        const cwd = String(args.cwd)
        const projectId = String(args.projectId)
        const mutation = args.mutation as { operationId: string; expectedStoreRevision: number }
        if (endpoint === MILESTONE_ADD_ENDPOINT) {
          const input = args.input as { name: string; effortSessions: number | null; ordinal: number }
          return { ok: true, value: await service.milestoneAdd(sessionId, cwd, projectId, input, mutation) }
        }
        if (endpoint === MILESTONE_UPDATE_ENDPOINT) {
          const patch = args.patch as { name?: string; effortSessions?: number | null; status?: string }
          return {
            ok: true,
            value: await service.milestoneUpdate(sessionId, cwd, projectId, String(args.milestoneId), patch, mutation),
          }
        }
        return {
          ok: false,
          error: { code: 'spec/unrouted', message: `spec bridge: unrouted endpoint ${endpoint}`, details: {} },
        }
      },
    },
  }
}

describe('milestone write descriptors', () => {
  it('registers one invocation per verb on the panel service and namespace', () => {
    for (const [descriptor, method, endpoint] of [
      [mstarMilestoneAddInvocation(), MSTAR_MILESTONE_ADD_METHOD, MILESTONE_ADD_ENDPOINT],
      [mstarMilestoneUpdateInvocation(), MSTAR_MILESTONE_UPDATE_METHOD, MILESTONE_UPDATE_ENDPOINT],
      [mstarMilestoneAssignInvocation(), MSTAR_MILESTONE_ASSIGN_METHOD, MILESTONE_ASSIGN_ENDPOINT],
      [mstarMilestoneRemoveInvocation(), MSTAR_MILESTONE_REMOVE_METHOD, MILESTONE_REMOVE_ENDPOINT],
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

describe('the C1 retry policy — one id AND request per logical write', () => {
  const deterministic = () => {
    let next = 0
    return () => `op-${++next}`
  }
  const request = (expectedStoreRevision: number) => ({ expectedStoreRevision })

  it('reuses the id and the ORIGINAL request for the same write, mints both for a different one', () => {
    const ids = writeOperationIds<{ expectedStoreRevision: number }>(deterministic())
    const first = ids.for('add:Milestone::0', request(7))
    // An ambiguous retry of the SAME logical write: same id, and — the part the
    // engine hashes — the same expectedStoreRevision.
    expect(ids.for('add:Milestone::0', request(9))).toEqual(first)
    expect(ids.for('add:Milestone::0', request(9)).request.expectedStoreRevision).toBe(7)
    expect(ids.for('add:Other::1', request(7)).operationId).not.toBe(first.operationId)
  })

  it('a terminal answer settles the write, so the next attempt is a new intent', () => {
    const ids = writeOperationIds<{ expectedStoreRevision: number }>(deterministic())
    const first = ids.for('remove:m-1', request(7))
    ids.settled()
    // A refusal the store made (not a transport failure) ends the logical write:
    // retrying it later must be a new request, not a replay of a judged one.
    expect(ids.for('remove:m-1', request(9))).not.toEqual(first)
  })
})

describe('the write CHANNEL retries a transport-ambiguous write with the SAME operationId', () => {
  it('reuses the id across the ambiguous retry; a different write gets a fresh one', async () => {
    // First milestoneAdd answers like the 5s deadline abort (transport-error, the
    // engine may or may not have committed); the retry of the same logical write
    // succeeds. The stub records every request payload.
    let milestoneAddCalls = 0
    const gateway = stubGateway()
    gateway.replyWith((_sessionId, _cwd, payload) => {
      const request = (payload as { args: { input: { name: string }; endpoint?: unknown } }).args
      if (request.input.name === 'Milestone one') {
        milestoneAddCalls += 1
        return milestoneAddCalls === 1
          ? { ok: false, error: { code: 'transport-error', message: 'timeout: no answer in 5000ms' } }
          : { ok: true, value: { ok: true, receipt: { milestoneId: 'm-1', changed: true, storeRevision: 9 } } }
      }
      return { ok: true, value: { ok: true, receipt: { milestoneId: 'm-2', changed: true, storeRevision: 10 } } }
    })
    const client = new MstarPanelSnapshotClient(gateway.connection)
    let minted = 0
    const ids = writeOperationIds<{ expectedStoreRevision: number }>(() => `op-logical-${++minted}`)
    const refusals: Array<string | null> = []
    const reloads: number[] = []
    const channel = createMilestoneWrites({
      client,
      sessionId: 's-1',
      cwd: '/proj',
      projectId: '_default',
      expectedStoreRevision: 7,
      reload: () => reloads.push(reloads.length + 1),
      onState: (state) => refusals.push(state.refusal),
      ids,
    })

    // The ambiguous attempt, then the user's retry of the SAME logical write.
    channel.create({ name: 'Milestone one', effortSessions: null, ordinal: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    channel.create({ name: 'Milestone one', effortSessions: null, ordinal: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const adds = gateway.calls.filter((call) => call.endpoint === MILESTONE_ADD_ENDPOINT)
    expect(adds).toHaveLength(2)
    const firstId = (adds[0]!.payload as { args: { mutation: { operationId: string } } }).args.mutation.operationId
    const retryId = (adds[1]!.payload as { args: { mutation: { operationId: string } } }).args.mutation.operationId
    // THE contract: the ambiguous retry carries the SAME operationId AND the same
    // expectedStoreRevision, so the engine replays its recorded receipt (a new
    // revision would hash differently and answer store.operation-conflict).
    expect(firstId).toBe('op-logical-1')
    expect(retryId).toBe(firstId)
    const revisions = adds.map(
      (call) => (call.payload as { args: { mutation: { expectedStoreRevision: number } } }).args.mutation.expectedStoreRevision,
    )
    expect(revisions).toEqual([7, 7])
    // And the ambiguous failure did NOT reload the read: refreshing the revision is
    // what would make the retry a different request (Greptile 4).
    expect(reloads).toHaveLength(1)
    // The transport failure surfaced as the refusal, and the successful retry cleared it.
    const stated = refusals.filter((value): value is string => value !== null)
    expect(stated).toHaveLength(1)
    expect(stated[0]).toContain('timeout')

    // A DIFFERENT logical write is a new intent: fresh id, because the previous
    // write settled on success.
    channel.create({ name: 'Another milestone', effortSessions: null, ordinal: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const thirdId = (
      gateway.calls.filter((call) => call.endpoint === MILESTONE_ADD_ENDPOINT)[2]!.payload as {
        args: { mutation: { operationId: string } }
      }
    ).args.mutation.operationId
    expect(thirdId).not.toBe(firstId)
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
      { name: 'Milestone one', effortSessions: 12, ordinal: 0 },
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

  it('carries the effort count: a create, an edit and a clear each round-trip to the store', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_ms2', app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)
    const milestonesOf = () => roadmapMilestones(endpoint, 'ses_ms2', app.root)

    const created = await endpoint.milestoneAdd(
      'ses_ms2',
      app.root,
      '_default',
      { name: 'Rename me', effortSessions: 12, ordinal: 0 },
      { operationId: 'op-create-2', expectedStoreRevision: await observedRevision(endpoint, 'ses_ms2', app.root) },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const milestoneId = (created.receipt as { milestoneId: string }).milestoneId
    expect((await milestonesOf())[0]).toMatchObject({ name: 'Rename me', effortSessions: 12 })

    const updated = await endpoint.milestoneUpdate(
      'ses_ms2',
      app.root,
      '_default',
      milestoneId,
      { name: 'Renamed', effortSessions: 20, status: 'active' },
      { operationId: 'op-update-2', expectedStoreRevision: await observedRevision(endpoint, 'ses_ms2', app.root) },
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect((updated.receipt as { changed: boolean }).changed).toBe(true)
    const edited = await milestonesOf()
    expect(edited).toHaveLength(1)
    expect(edited[0]).toMatchObject({ name: 'Renamed', status: 'active', effortSessions: 20 })

    // why: a clear is an explicit `effortSessions: null` patch, not an omitted
    // field — omitting it leaves the stored count alone.
    const cleared = await endpoint.milestoneUpdate(
      'ses_ms2',
      app.root,
      '_default',
      milestoneId,
      { effortSessions: null },
      { operationId: 'op-update-clear', expectedStoreRevision: await observedRevision(endpoint, 'ses_ms2', app.root) },
    )
    expect(cleared.ok).toBe(true)
    expect((await milestonesOf())[0]).toMatchObject({ name: 'Renamed', status: 'active', effortSessions: null })
  })

  it('carries a count and an explicit clear from the CHANNEL to the store', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_ms_chain', app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)

    // why: the seat re-arms the channel after every write with the freshly observed
    // revision, so the spec does the same — one channel per write, the production client throughout.
    const channelAt = (expectedStoreRevision: number) => {
      const states: { busy: boolean; refusal: string | null }[] = []
      const channel = createMilestoneWrites({
        client: new MstarPanelSnapshotClient(serviceConnection(endpoint)),
        sessionId: 'ses_ms_chain',
        cwd: app.root,
        projectId: '_default',
        expectedStoreRevision,
        reload: () => {},
        onState: (state) => states.push(state),
        ids: writeOperationIds<{ expectedStoreRevision: number }>(),
      })
      return {
        channel,
        // why: a write is settled only when its terminal answer flipped busy back
        // to false — a timer alone can read back before the engine has written.
        settle: async () => {
          for (let i = 0; i < 100 && states[states.length - 1]?.busy !== false; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
          expect(states[states.length - 1]?.busy).toBe(false)
        },
        refusal: () => channel.refusal,
      }
    }
    const revision = () => observedRevision(endpoint, 'ses_ms_chain', app.root)

    const create = channelAt(await revision())
    create.channel.create({ name: 'Chained', effortSessions: 12, ordinal: 0 })
    await create.settle()
    expect(create.refusal()).toBeNull()
    const created = await roadmapMilestones(endpoint, 'ses_ms_chain', app.root)
    expect(created).toMatchObject([{ name: 'Chained', effortSessions: 12 }])

    // why: the clear travels as an explicit `null` — an omitted field would leave the
    // stored 12 alone — and the STORE holds null afterwards.
    const clear = channelAt(await revision())
    clear.channel.update(created[0]!.milestoneId, { effortSessions: null })
    await clear.settle()
    expect(clear.refusal()).toBeNull()
    expect(await roadmapMilestones(endpoint, 'ses_ms_chain', app.root)).toMatchObject([
      { name: 'Chained', effortSessions: null },
    ])
  })

  it('sets and clears the effort count through the endpoint, and the roadmap read shows each value', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_eff', app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)

    const created = await endpoint.milestoneAdd(
      'ses_eff',
      app.root,
      '_default',
      { name: 'Estimated', effortSessions: null, ordinal: 0 },
      { operationId: 'op-effort-create', expectedStoreRevision: await observedRevision(endpoint, 'ses_eff', app.root) },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const milestoneId = (created.receipt as { milestoneId: string }).milestoneId

    const set = await endpoint.milestoneUpdate(
      'ses_eff',
      app.root,
      '_default',
      milestoneId,
      { effortSessions: 12 },
      { operationId: 'op-effort-set', expectedStoreRevision: await observedRevision(endpoint, 'ses_eff', app.root) },
    )
    expect(set.ok).toBe(true)
    const setRead = await endpoint.dashboardView('ses_eff', app.root, 'roadmap', { project: '_default' })
    const afterSet = (setRead.envelope?.data as { milestones: { milestones: Array<{ effortSessions: number | null }> } })
      .milestones.milestones
    expect(afterSet).toHaveLength(1)
    expect(afterSet[0]!.effortSessions).toBe(12)

    const cleared = await endpoint.milestoneUpdate(
      'ses_eff',
      app.root,
      '_default',
      milestoneId,
      { effortSessions: null },
      { operationId: 'op-effort-clear', expectedStoreRevision: await observedRevision(endpoint, 'ses_eff', app.root) },
    )
    expect(cleared.ok).toBe(true)
    const clearRead = await endpoint.dashboardView('ses_eff', app.root, 'roadmap', { project: '_default' })
    const afterClear = (clearRead.envelope?.data as { milestones: { milestones: Array<{ effortSessions: number | null }> } })
      .milestones.milestones
    expect(afterClear).toHaveLength(1)
    expect(afterClear[0]!.effortSessions).toBeNull()
  })

  it('removes an EMPTY milestone, and a non-empty one is refused verbatim', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_rm', app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)
    const issueId = await seedOpenIssue(app.harnessDir, {
      title: 'Sticky issue',
      severity: 'low',
      projectId: '_default',
      operationId: 'op-rm-seed',
    })

    const created = await endpoint.milestoneAdd(
      'ses_rm',
      app.root,
      '_default',
      { name: 'Doomed', effortSessions: null, ordinal: 0 },
      { operationId: 'op-rm-create', expectedStoreRevision: await observedRevision(endpoint, 'ses_rm', app.root) },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const milestoneId = (created.receipt as { milestoneId: string }).milestoneId

    // Non-empty: the engine refuses, and the channel passes code + message through.
    await assignDirectly(app.harnessDir, milestoneId, issueId)

    const nonEmpty = await endpoint.milestoneRemove(
      'ses_rm',
      app.root,
      '_default',
      milestoneId,
      { operationId: 'op-rm-nonempty', expectedStoreRevision: await observedRevision(endpoint, 'ses_rm', app.root) },
    )
    expect(nonEmpty).toMatchObject({ ok: false, code: 'milestone.not-empty' })
    expect(nonEmpty.ok === false && nonEmpty.message.length).toBeGreaterThan(0)

    // A revision that moved under the caller is the engine's own CAS refusal.
    const stale = await endpoint.milestoneRemove(
      'ses_rm',
      app.root,
      '_default',
      milestoneId,
      { operationId: 'op-rm-stale', expectedStoreRevision: 0 },
    )
    expect(stale).toMatchObject({ ok: false, code: 'milestone.revision-conflict' })

    // Empty the milestone again, then the removal succeeds on the fresh revision.
    await assignDirectly(app.harnessDir, null, issueId)
    const removed = await endpoint.milestoneRemove(
      'ses_rm',
      app.root,
      '_default',
      milestoneId,
      { operationId: 'op-rm-go', expectedStoreRevision: await observedRevision(endpoint, 'ses_rm', app.root) },
    )
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect((removed.receipt as { changed: boolean }).changed).toBe(true)
    const read = await endpoint.dashboardView('ses_rm', app.root, 'roadmap', { project: '_default' })
    const milestones = (read.envelope?.data as { milestones: { milestones: unknown[] } }).milestones.milestones
    expect(milestones).toHaveLength(0)
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
      { name: 'First', effortSessions: null, ordinal: 0 },
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
      { name: 'Second', effortSessions: null, ordinal: 1 },
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
    const first = await endpoint.milestoneAdd('ses_ms3', app.root, '_default', { name: 'Once', effortSessions: null, ordinal: 0 }, mutation)
    const second = await endpoint.milestoneAdd('ses_ms3', app.root, '_default', { name: 'Once', effortSessions: null, ordinal: 0 }, mutation)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    // The retry replayed the recorded receipt: the store holds ONE milestone, which
    // is the whole point of reusing the id across an ambiguous attempt (C1).
    const read = await endpoint.dashboardView('ses_ms3', app.root, 'roadmap', { project: '_default' })
    const held = (read.envelope?.data as { milestones: { milestones: unknown[] } }).milestones.milestones
    expect(held).toHaveLength(1)
    // And a DIFFERENT request reusing the id is refused, per the engine's rule.
    const conflict = await endpoint.milestoneAdd('ses_ms3', app.root, '_default', { name: 'Other', effortSessions: null, ordinal: 1 }, mutation)
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
      input: { name: 'Second', effortSessions: 12, ordinal: 1 },
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
        input: { name: 'Second', effortSessions: 12, ordinal: 1 },
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

  it("keeps a `gateway/*` envelope code from the transport, and degrades every other envelope code", async () => {
    const gateway = stubGateway(
      { ok: false, error: { code: 'gateway/timeout', message: 'gateway closed' } },
      { ok: false, error: { message: 'gateway closed' } },
      { ok: false, error: { code: 'milestone.invalid-input', message: '[milestone.invalid-input] name must not be empty.' } },
    )
    const client = new MstarPanelSnapshotClient(gateway.connection)
    const transport = await client.milestoneAdd({
      sessionId: 's-1',
      cwd: '/proj',
      projectId: '_default',
      input: { name: '', effortSessions: null, ordinal: 0 },
      mutation: { operationId: 'op-client-3', expectedStoreRevision: 7 },
    })
    expect(transport).toEqual({ ok: false, code: 'gateway/timeout', message: 'gateway closed' })
    const noCode = await client.milestoneAdd({
      sessionId: 's-1',
      cwd: '/proj',
      projectId: '_default',
      input: { name: 'Third', effortSessions: null, ordinal: 2 },
      mutation: { operationId: 'op-client-4', expectedStoreRevision: 7 },
    })
    expect(noCode).toEqual({ ok: false, code: 'transport-error', message: 'gateway closed' })
    // An engine-domain code that arrives on the envelope is not the transport's
    // verdict: the write stays ambiguous so the retry channel keeps its id.
    const foreign = await client.milestoneAdd({
      sessionId: 's-1',
      cwd: '/proj',
      projectId: '_default',
      input: { name: 'Fourth', effortSessions: null, ordinal: 3 },
      mutation: { operationId: 'op-client-5', expectedStoreRevision: 7 },
    })
    expect(foreign).toEqual({
      ok: false,
      code: 'transport-error',
      message: '[milestone.invalid-input] name must not be empty.',
    })
  })
})

describe('milestoneAssign — the requested seat authorizes the write, not a session binding', () => {
  it('assigns with no coordinator binding, and refuses a leaf actor verbatim', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_assign', app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)
    const issueId = await seedOpenIssue(app.harnessDir, {
      title: 'Unassigned fixture issue',
      severity: 'low',
      operationId: 'op-assign-seed',
    })
    const created = await endpoint.milestoneAdd(
      'ses_assign',
      app.root,
      '_default',
      { name: 'Assign me', effortSessions: null, ordinal: 0 },
      { operationId: 'op-assign-create', expectedStoreRevision: await observedRevision(endpoint, 'ses_assign', app.root) },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const milestoneId = (created.receipt as { milestoneId: string }).milestoneId

    // This workspace holds no coordinator execution session at all: the seat
    // named on the request is the authorization, so the assignment goes through.
    const assigned = await endpoint.milestoneAssign(
      'ses_assign',
      app.root,
      issueId,
      { projectId: '_default', milestoneId, reason: 'fixture assign' },
      {
        operationId: 'op-assign-1',
        actor: 'project-manager',
        expectedRevision: 1,
        expectedStoreRevision: await observedRevision(endpoint, 'ses_assign', app.root),
      },
    )
    expect(assigned.ok).toBe(true)
    if (!assigned.ok) return
    expect(assigned.receipt).toMatchObject({ issueId, revision: 2 })

    // A leaf actor holds no capture seat: the engine's own refusal passes through.
    const refusedSeat = await endpoint.milestoneAssign(
      'ses_assign',
      app.root,
      issueId,
      { projectId: '_default', milestoneId: null, reason: 'leaf attempt' },
      {
        operationId: 'op-assign-leaf',
        actor: 'fullstack-dev',
        expectedRevision: 2,
        expectedStoreRevision: await observedRevision(endpoint, 'ses_assign', app.root),
      },
    )
    expect(refusedSeat.ok).toBe(false)
    if (refusedSeat.ok) return
    expect(refusedSeat.code).toBe('issue.scope-refused')
    expect(refusedSeat.message).toContain('fullstack-dev')
  })

  it('refuses a session whose target does not resolve, before the verb runs', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    const endpoint = endpointOf(app)
    const result = await endpoint.milestoneAssign(
      'ses_unknown',
      app.root,
      'I-000001',
      { projectId: '_default', milestoneId: null, reason: 'no target' },
      { operationId: 'op-assign-no-target', actor: 'project-manager', expectedRevision: 1, expectedStoreRevision: 0 },
    )
    expect(result).toMatchObject({ ok: false, code: 'store.not-active' })
    expect(result.ok === false && result.message.length).toBeGreaterThan(0)
  })
})


describe('a refused write never reloads the read — the operator\'s draft survives', () => {
  // invariant: a reload re-keys the OnceReader, the destination renders the loading arm and the
  // mounted forms
  // (and the operator's typed draft) are destroyed. A refused write wrote
  // nothing, so there is nothing to reload: only an ACCEPTED write refreshes
  // the roadmap. These specs drive the production channel against the REAL
  // engine (the validation is the engine's own) and count the reload callback.

  async function harness(sessionId: string) {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, sessionId, app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)
    return { app, endpoint }
  }

  function channelFor(endpoint: WriteEndpoint, sessionId: string, cwd: string, revision: number) {
    const states: { busy: boolean; refusal: string | null }[] = []
    const reloads: number[] = []
    const channel = createMilestoneWrites({
      client: new MstarPanelSnapshotClient(serviceConnection(endpoint)),
      sessionId,
      cwd,
      projectId: '_default',
      expectedStoreRevision: revision,
      reload: () => reloads.push(1),
      onState: (state) => states.push(state),
      ids: writeOperationIds<{ expectedStoreRevision: number }>(),
    })
    return {
      channel,
      reloads,
      settle: async () => {
        for (let i = 0; i < 100 && states[states.length - 1]?.busy !== false; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        expect(states[states.length - 1]?.busy).toBe(false)
      },
    }
  }

  it('a refused CREATE (effort count 0) does not reload, and the refusal text reaches the channel verbatim', async () => {
    const { app, endpoint } = await harness('ses_draft_create')
    const seat = channelFor(endpoint, 'ses_draft_create', app.root, await observedRevision(endpoint, 'ses_draft_create', app.root))

    seat.channel.create({ name: 'Typed draft name', effortSessions: 0, ordinal: 0 })
    await seat.settle()

    // why: the engine refused the count, so the refusal is the channel's, verbatim.
    expect(seat.channel.refusal).toBeTruthy()
    expect(seat.channel.refusal).toContain('milestone.invalid-input')
    // invariant: nothing was written, so the read is NOT reloaded and the mounted form keeps
    // the operator's typed name and count.
    expect(seat.reloads).toHaveLength(0)
    // why: the store holds no milestone, so the refusal really wrote nothing.
    expect(await roadmapMilestones(endpoint, 'ses_draft_create', app.root)).toHaveLength(0)
  })

  it('a refused UPDATE (effort count -1) does not reload either', async () => {
    const { app, endpoint } = await harness('ses_draft_update')
    const created = await endpoint.milestoneAdd(
      'ses_draft_update',
      app.root,
      '_default',
      { name: 'Existing', effortSessions: 12, ordinal: 0 },
      { operationId: 'op-draft-seed', expectedStoreRevision: await observedRevision(endpoint, 'ses_draft_update', app.root) },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const milestoneId = (created.receipt as { milestoneId: string }).milestoneId

    const seat = channelFor(endpoint, 'ses_draft_update', app.root, await observedRevision(endpoint, 'ses_draft_update', app.root))
    seat.channel.update(milestoneId, { name: 'Renamed draft', effortSessions: -1 })
    await seat.settle()

    expect(seat.channel.refusal).toBeTruthy()
    expect(seat.channel.refusal).toContain('milestone.invalid-input')
    expect(seat.reloads).toHaveLength(0)
    // invariant: the stored milestone is untouched, so the editor stays open over true data.
    expect(await roadmapMilestones(endpoint, 'ses_draft_update', app.root)).toMatchObject([
      { name: 'Existing', effortSessions: 12 },
    ])
  })

  it('an ACCEPTED write still reloads the roadmap', async () => {
    const { app, endpoint } = await harness('ses_draft_accept')
    const seat = channelFor(endpoint, 'ses_draft_accept', app.root, await observedRevision(endpoint, 'ses_draft_accept', app.root))

    seat.channel.create({ name: 'Accepted', effortSessions: 12, ordinal: 0 })
    await seat.settle()

    expect(seat.channel.refusal).toBeNull()
    expect(seat.reloads).toHaveLength(1)
    expect(await roadmapMilestones(endpoint, 'ses_draft_accept', app.root)).toMatchObject([{ name: 'Accepted' }])
  })

  it('the reader itself is unchanged: a new identity (navigation) still enters loading', async () => {
    // why: the reload gate lives in the write channel; the reader's own behaviour — a new key is a
    // new read, loading until it answers — must
    // not change. Drives the production OnceReader directly.
    const { OnceReader } = require('../src/client/panel/once-reader.ts') as typeof import('../src/client/panel/once-reader.ts')
    const gateway = stubGateway()
    const client = new MstarPanelSnapshotClient(gateway.connection)
    const reader = new OnceReader<{ kind: string }>()
    reader.begin('view-one', client, async () => ({ kind: 'ok' }))
    expect(reader.getSnapshot().kind).toBe('loading')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(reader.getSnapshot().kind).toBe('ok')
    // why: navigation re-enters loading because a new identity is a new read.
    reader.begin('view-two', client, async () => ({ kind: 'ok' }))
    expect(reader.getSnapshot().kind).toBe('loading')
  })
})


describe('a revision conflict refreshes the read, the draft survives, and the retry lands', () => {
  // invariant: every write arms from the OPEN read's store revision. Once another writer moves
  // the store, the open page's revision is stale — the conflict refusal must therefore refresh
  // the read (the reload a validation refusal must NOT do), or every retry is refused forever.
  // These specs drive the production channel against the REAL engine; the conflict is built by
  // writing through the same endpoint between the channel's arming read and the submission.

  async function harness(sessionId: string) {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, sessionId, app.root)
    const endpoint = endpointOf(app)
    await seedProject(app.harnessDir)
    return { app, endpoint }
  }

  function channelFor(endpoint: WriteEndpoint, sessionId: string, cwd: string, revision: number, seats: { onAccepted?: (target: string) => void } = {}) {
    const states: { busy: boolean; refusal: string | null }[] = []
    const reloads: number[] = []
    const channel = createMilestoneWrites({
      client: new MstarPanelSnapshotClient(serviceConnection(endpoint)),
      sessionId,
      cwd,
      projectId: '_default',
      expectedStoreRevision: revision,
      reload: () => reloads.push(1),
      onState: (state) => states.push(state),
      ids: writeOperationIds<{ expectedStoreRevision: number }>(),
      // why: the production seat always arms the channel with the open page's project — a
      // direct factory caller that omits it exercises a path production never takes.
      draftsProject: '_default',
      ...(seats.onAccepted === undefined ? {} : { onAccepted: seats.onAccepted }),
    })
    return {
      channel,
      reloads,
      settle: async () => {
        for (let i = 0; i < 100 && states[states.length - 1]?.busy !== false; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        expect(states[states.length - 1]?.busy).toBe(false)
      },
    }
  }

  it('a revision-conflict refusal DOES refresh the read, and the resubmission on the fresh revision lands', async () => {
    const { app, endpoint } = await harness('ses_conflict')
    const revision = () => observedRevision(endpoint, 'ses_conflict', app.root)

    // why: the page's arming read — the channel carries THIS revision.
    const armed = await revision()
    const seat = channelFor(endpoint, 'ses_conflict', app.root, armed)

    // why: another writer advances the store BETWEEN the page's read and the operator's
    // submit — the same endpoint, a real write, so the store revision moves under the page.
    const other = await endpoint.milestoneAdd(
      'ses_conflict',
      app.root,
      '_default',
      { name: 'Someone else wrote', effortSessions: null, ordinal: 0 },
      { operationId: 'op-other-writer', expectedStoreRevision: armed },
    )
    expect(other.ok).toBe(true)

    // why: the operator's write now carries the stale revision — the engine's CAS refusal.
    seat.channel.create({ name: 'Typed draft name', effortSessions: 4, ordinal: 1 })
    await seat.settle()
    expect(seat.channel.refusal).toBeTruthy()
    expect(seat.channel.refusal).toContain('milestone.revision-conflict')
    // invariant: a revision conflict refreshes the reads — exactly what an input-validation
    // refusal must never do.
    expect(seat.reloads).toHaveLength(1)

    // why: the refresh re-arms the channel with the NEWLY observed revision, and the resubmission
    // of the same draft lands — the failure the stale-revision review finding reported was
    // this retry being refused forever.
    const rearmed = channelFor(endpoint, 'ses_conflict', app.root, await revision())
    rearmed.channel.create({ name: 'Typed draft name', effortSessions: 4, ordinal: 1 })
    await rearmed.settle()
    expect(rearmed.channel.refusal).toBeNull()
    expect(rearmed.reloads).toHaveLength(1)
    expect(await roadmapMilestones(endpoint, 'ses_conflict', app.root)).toMatchObject([
      { name: 'Someone else wrote' },
      { name: 'Typed draft name', effortSessions: 4 },
    ])
  })

  it('an accepted write clears its draft target; a refused one keeps it', async () => {
    const { app, endpoint } = await harness('ses_accept_clear')
    const cleared: string[] = []
    const seat = channelFor(endpoint, 'ses_accept_clear', app.root, await observedRevision(endpoint, 'ses_accept_clear', app.root), {
      onAccepted: (target) => cleared.push(target),
    })
    // why: the refusal path must NOT clear — the draft is the operator's to fix and resubmit.
    seat.channel.create({ name: 'Refused draft', effortSessions: 0, ordinal: 0 })
    await seat.settle()
    expect(seat.channel.refusal).toContain('milestone.invalid-input')
    expect(cleared).toHaveLength(0)

    const accepted = channelFor(endpoint, 'ses_accept_clear', app.root, await observedRevision(endpoint, 'ses_accept_clear', app.root), {
      onAccepted: (target) => cleared.push(target),
    })
    accepted.channel.create({ name: 'Accepted draft', effortSessions: 2, ordinal: 0 })
    await accepted.settle()
    expect(accepted.channel.refusal).toBeNull()
    // invariant: the create form's draft key is the project-scoped '_default:create' — the
    // accepted write clears exactly it.
    expect(cleared).toEqual(['_default:create'])
  })

  it('an accepted UPDATE clears the milestone-keyed entry, not the create one', async () => {
    const { app, endpoint } = await harness('ses_update_clear')
    const created = await endpoint.milestoneAdd(
      'ses_update_clear',
      app.root,
      '_default',
      { name: 'Edited target', effortSessions: 3, ordinal: 0 },
      { operationId: 'op-update-target-seed', expectedStoreRevision: await observedRevision(endpoint, 'ses_update_clear', app.root) },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const milestoneId = (created.receipt as { milestoneId: string }).milestoneId

    const cleared: string[] = []
    const seat = channelFor(endpoint, 'ses_update_clear', app.root, await observedRevision(endpoint, 'ses_update_clear', app.root), {
      onAccepted: (target) => cleared.push(target),
    })
    seat.channel.update(milestoneId, { name: 'Renamed' })
    await seat.settle()
    expect(seat.channel.refusal).toBeNull()
    expect(cleared).toEqual([`_default:${milestoneId}`])
  })

  it('the create draft is keyed by the project the form was opened over — a project switch never re-seeds', async () => {
    // invariant: the draft store is one per seat and survives navigation, so the key must carry
    // the identity the form belongs to. Seed project A's create slot through the SAME key the
    // production form computes (the roadmap's project identity plus the create target), switch
    // to project B, and B's form must read empty; back on A the typed text is still there.
    const { createMilestoneDraftStore, milestoneDraftTargetKey } = await import('@mstar-harness/ui')
    const drafts = createMilestoneDraftStore()
    const projectA = 'project-alpha'
    const projectB = 'project-beta'

    // why: the form's keystroke effect, mirrored — typing in A's create form writes A's key.
    drafts.write(milestoneDraftTargetKey(projectA, 'create'), { name: 'Typed in project A', effort: '3' })

    // why: B's form seeds from B's key — with the bare 'create' key it would read A's text.
    expect(drafts.read(milestoneDraftTargetKey(projectB, 'create'))).toBeUndefined()
    // invariant: returning to A re-seeds exactly what was typed there.
    expect(drafts.read(milestoneDraftTargetKey(projectA, 'create'))).toEqual({ name: 'Typed in project A', effort: '3' })

    // invariant: an accepted create in A clears A's entry through the channel's scoped target,
    // and a draft typed in B meanwhile is untouched.
    const { app, endpoint } = await harness('ses_draft_isolation')
    drafts.write(milestoneDraftTargetKey(projectB, 'create'), { name: 'Typed in project B', effort: '1' })
    const cleared: string[] = []
    const seat = channelFor(endpoint, 'ses_draft_isolation', app.root, await observedRevision(endpoint, 'ses_draft_isolation', app.root), {
      onAccepted: (target) => {
        cleared.push(target)
        drafts.clear(target)
      },
    })
    seat.channel.create({ name: 'Accepted in A', effortSessions: 2, ordinal: 0 })
    await seat.settle()
    expect(seat.channel.refusal).toBeNull()
    expect(cleared).toEqual([milestoneDraftTargetKey('_default', 'create')])
    expect(drafts.read(milestoneDraftTargetKey(projectB, 'create'))).toEqual({ name: 'Typed in project B', effort: '1' })
  })
})

