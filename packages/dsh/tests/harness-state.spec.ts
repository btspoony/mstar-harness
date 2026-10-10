/**
 * ACTIVE catalog rendering and store-backed issue facts, plus unavailable-store
 * disclosure and null-harness behavior. Legacy status.json/snapshot.json
 * digest, doneAt, compass-fallback, and TTL mutation cases are retired below
 * with their file-route dispositions.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { bootApp, seedActiveWorkflow, seedHarness, seedKnowledgeDoc, seedOpenIssue, seedStore, v2Root, v2Snapshot, v2WorkflowEntry, type BootResult } from './harness.ts'
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


/* ===========================================================================
 * 1. Full digest — every section renders from the seeded workspace state
 * ========================================================================== */

// Disposition: the workspace digest and compass-fallback cases below were built solely from retired status.json/snapshot.json execution state; keep store-backed issue and unavailable-state behavior covered.

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
    expect(textOf(row)).toContain('workflow selection: ERROR (store.not-initialized)')
  })

  it('an active store with no open issue → residualFindings [] (an authoritative empty answer)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-harness-state-noopen-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedActiveWorkflow(harnessDir, 'wf-1', [], {}, 'state-no-open', root)
    booted = await bootApp({ root })

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

// Disposition: doneAt normalization was asserted only over legacy snapshot plan rows; ACTIVE plan rows are covered by store-backed consumers.

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
    expect(payload.state?.selection).toMatchObject({ kind: 'error', code: 'store.not-initialized' })
    expect(payload.state?.storeFacts?.kind).toBe('unavailable')
    const text = textOf(row)
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

// Disposition: TTL refresh mutated snapshot.json directly; the file-route-only refresh case is retired.
