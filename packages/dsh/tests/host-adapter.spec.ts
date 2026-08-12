/**
 * Task 2 — plugin HostAdapter implementation (host: dsh) (plan
 * 20260808-dsh-host-adapter).
 *
 * The adapter is the host-facing facade over the P1 gate internals: the
 * `fs/write-intent` / `fs/edit-intent` / `tools/pre-execute` listeners and
 * the adapter hooks share ONE code path (`statusGate` / `dispatchGate`), so
 * violation codes are identical by construction. Parity is asserted
 * directly: the same input through the real waterfall (the booted plugin's
 * listeners) and through the adapter → the same codes.
 *
 * Hook semantics (documented decisions, see task-2-report.md):
 * - `beforeStatusWrite(path, doc)` validates the INCOMING document when the
 *   host provides it (the opencode consumer convention for this engine hook
 *   — the write's content is the meaningful signal for a direct writer);
 *   with `doc === undefined` it falls back to the current on-disk document
 *   at `path` via the gate's single-read `validateStatusDoc` semantics
 *   (missing file = first create = pass). Both inputs flow through the same
 *   `validateStatusValue` pipeline → same codes as the fs-intent gate.
 * - `beforeDispatch(assignment)` covers the dispatch gate validation path
 *   (validateAssignmentFields + branch gate + anti-recursion; read-only
 *   roles skip the branch gate). The lease gate stays in the
 *   `tools/pre-execute` listener, which owns the ToolExecution context
 *   (session id) — `beforeDispatch` has no exec by contract. The fields
 *   form is normalized to the engine's own header grammar and gated through
 *   the same text path.
 * - `beforeMerge(lease)` is a thin wrapper over the engine
 *   `validateIntegrationMergeLease` (reserve/validate integration merge
 *   lease — the testable subset now; P3 wires the reservation).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { HostAdapter } from '@mstar-harness/engine'
import type { AssignmentFields } from '@mstar-harness/engine'
import type { IntegrationMergeLease } from '@mstar-harness/engine'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { DshHostAdapter, HarnessResolver, type Config } from '../src/index.ts'
import type { DispatchGateAdvisory, StatusGateAdvisory } from '../src/index.ts'
import { bootApp, INVALID_STATUS, VALID_STATUS, seedHarness, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- fixtures ---------------------------------- */

/** Fully valid writable Assignment (mirrors the dispatch-gate spec). */
const VALID_WRITABLE = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/dsh-host-adapter

Do the thing, evidence-first.
`

/** Writable assignment with no branch form at all (field-gate violation). */
const MISSING_BRANCH = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic

Do the thing.
`

/** Read-only orientation role — no branch form is legitimate. */
const SCOUT_NO_BRANCH = `## Assignment

**Execute as**: scout
**Delegation**: n/a
**Task category**: deep

Survey the codebase, report only.
`

/** Existing-branch form on a default protected branch without an exception. */
const WORKING_BRANCH_MAIN = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: main

Do the thing.
`

/** Self-recursion: the Assignment's `Execute as` equals the dispatcher's own role. */
const SELF_RECURSION = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x

Do the thing.
`

/** Working branch on main with a BODY-QUOTED direct-on exception — both paths must ignore the body (qc2 F-001). */
const BODY_QUOTED_BRANCH_POLICY = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: main

## Task

The task body quotes an example header line:
**Branch policy**: direct on main — hotfix quoted in the body
`

/** The fields-form equivalent of WORKING_BRANCH_MAIN (parsed input shape). */
const MAIN_FIELDS = {
  executeAs: 'fullstack-dev',
  delegation: 'forbidden',
  taskCategory: 'logic',
  workingBranch: 'main',
} satisfies AssignmentFields

/** The canonical text form of MAIN_FIELDS (engine header grammar). */
const MAIN_FIELDS_TEXT = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: main
`

/** A parsed-fields Assignment missing all three core fields. */
const BARE_FIELDS = { workingBranch: 'feature/x' } satisfies AssignmentFields

/** The canonical text form of BARE_FIELDS. */
const BARE_FIELDS_TEXT = `## Assignment

**Working branch**: feature/x
`

/* ---------------------------------- helpers ---------------------------------- */

/**
 * An adapter over an ISOLATED root context (default ctx logger, empty
 * Config). The booted app provides the app's single `ctx.dshHostAdapter`
 * service (Task 3: adapter attached on ctx) — direct constructions for
 * config-variant tests use a fresh context so the service name does not
 * collide with the provided instance.
 */
function makeAdapter(opts: { config?: Config; log?: (level: 'info' | 'warn' | 'error', msg: string) => void } = {}): DshHostAdapter {
  return new DshHostAdapter(new Context(), {
    // Explicit harness dir through the resolver (the boot app's configured
    // root — per-workspace probing is covered by workspace-resolution.spec).
    resolver: new HarnessResolver(booted!.harnessDir),
    config: opts.config ?? {},
    log: opts.log,
  })
}

/** FsTarget for `{HARNESS_DIR}/status.json` (local-backend shape). */
const statusTarget = (harnessDir: string): FsTarget => ({
  targetKey: join(harnessDir, 'status.json') as FsTarget['targetKey'],
  displayPath: join(harnessDir, 'status.json'),
})

/** Collect status-gate advisory emits on the app context. */
function captureStatusAdvisories(ctx: BootResult['ctx']): StatusGateAdvisory[] {
  const advisories: StatusGateAdvisory[] = []
  ctx.on('mstar/status-gate', (payload) => { advisories.push(payload) })
  return advisories
}

/** Collect dispatch-gate advisory emits on the app context. */
function captureDispatchAdvisories(ctx: BootResult['ctx']): DispatchGateAdvisory[] {
  const advisories: DispatchGateAdvisory[] = []
  ctx.on('mstar/dispatch-gate', (payload) => { advisories.push(payload) })
  return advisories
}

const statusCodes = (advisory: StatusGateAdvisory | undefined): string[] => advisory?.result.violations.map((v) => v.code) ?? []
const dispatchCodes = (advisory: DispatchGateAdvisory | undefined): string[] => advisory?.result.violations.map((v) => v.code) ?? []

/** One pending subagent tool call (dsh-tools registry pipeline shape). */
function subagentExec(prompt: string): ToolExecution {
  return {
    callId: 'c1' as ToolExecution['callId'],
    name: 'subagent',
    arguments: { description: 'probe', prompt },
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** The registry's bare default decision (the waterfall's terminal `next()`). */
const defaultAllow = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

/* ---------------------------------- host identity + log ---------------------------------- */

describe('DshHostAdapter — host identity and log channel', () => {
  it('reports host === dsh and satisfies the engine HostAdapter contract', async () => {
    booted = await bootApp()
    const adapter = makeAdapter()

    expect(adapter.host).toBe('dsh')

    // Type-only interface conformance (engine host.ts — the dsh plugin is
    // the concrete adapter; the engine never imports host SDKs).
    const asHostAdapter: HostAdapter = adapter
    expect(asHostAdapter.host).toBe('dsh')
  })

  it('log routes every level to the configured sink', async () => {
    booted = await bootApp()
    const entries: Array<[string, string]> = []
    const adapter = makeAdapter({ log: (level, msg) => { entries.push([level, msg]) } })

    adapter.log('info', 'hello')
    adapter.log('warn', 'careful')
    adapter.log('error', 'boom')

    expect(entries).toEqual([
      ['info', 'hello'],
      ['warn', 'careful'],
      ['error', 'boom'],
    ])
  })

  it('log defaults to the dsh ctx logger (mstar/host-adapter scope) without throwing', async () => {
    booted = await bootApp()
    const adapter = makeAdapter()

    adapter.log('info', 'ctx logger path')
  })
})

/* ---------------------------------- beforeStatusWrite ---------------------------------- */

describe('beforeStatusWrite — status gate validation path (same codes as the fs-intent gate)', () => {
  it('bad doc → failing ValidationResult whose code matches the gate advisory for the same document', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })
    const adapter = makeAdapter()
    const statusPath = join(app.harnessDir, 'status.json')

    // Gate parity: run the fs/write-intent waterfall over the same on-disk
    // document and read the advisory's codes.
    const advisories = captureStatusAdvisories(app.ctx)
    await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)
    const gateCodes = statusCodes(advisories[0])

    const result = await adapter.beforeStatusWrite(statusPath, INVALID_STATUS)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('status.invalid-plans')
    expect(gateCodes).toContain(result.code)
    expect(gateCodes).toContain('status.invalid-plans')
    // The first violation's shape is preserved verbatim (severity + message).
    expect(result.severity).toBe('high')
    expect(result.message).toContain('plans')
  })

  it('doc === undefined → on-disk fallback; malformed JSON yields the gate status.invalid-json code', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': '{ "version": 1,' })
    const adapter = makeAdapter()
    const statusPath = join(app.harnessDir, 'status.json')

    const advisories = captureStatusAdvisories(app.ctx)
    await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    const result = await adapter.beforeStatusWrite(statusPath, undefined)

    expect(result.ok).toBe(false)
    expect(result.code).toBe('status.invalid-json')
    expect(statusCodes(advisories[0])).toContain('status.invalid-json')
  })

  it('missing file with doc === undefined → pass (first create; gate parity — nothing to validate)', async () => {
    const app = booted = await bootApp()
    const adapter = makeAdapter()
    const statusPath = join(app.harnessDir, 'status.json')

    const advisories = captureStatusAdvisories(app.ctx)
    await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)
    expect(advisories).toHaveLength(0) // the gate stays silent for a first create

    const result = await adapter.beforeStatusWrite(statusPath, undefined)
    expect(result.ok).toBe(true)
  })

  it('valid incoming doc passes even when the on-disk document is bad (doc-first semantics)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })
    const adapter = makeAdapter()

    // The host provides the write's content: the hook validates THAT doc
    // (the opencode consumer convention) — the write may BE the repair.
    const result = await adapter.beforeStatusWrite(join(app.harnessDir, 'status.json'), VALID_STATUS)
    expect(result.ok).toBe(true)
    expect(result.code).toBe('host.beforeStatusWrite.ok')
  })
})

/* ---------------------------------- beforeDispatch ---------------------------------- */

describe('beforeDispatch — dispatch gate validation path (same codes as tools/pre-execute)', () => {
  it('bad Assignment text → failing GateResult whose codes equal the gate advisory codes', async () => {
    const app = booted = await bootApp()
    const adapter = makeAdapter()

    const advisories = captureDispatchAdvisories(app.ctx)
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)
    expect(decision).toEqual({ kind: 'allow' })

    const result = await adapter.beforeDispatch(MISSING_BRANCH)

    expect(result.ok).toBe(false)
    expect(result.hardBlocked).toBe(false) // warn mode — the verdict is advisory
    expect(result.violations.map((v) => v.code)).toEqual(dispatchCodes(advisories[0]))
    expect(result.violations.map((v) => v.code)).toContain('assignment.field.branch-missing')
  })

  it('Working branch on main → dispatch.default-branch.protected, same code as the gate', async () => {
    const app = booted = await bootApp()
    const adapter = makeAdapter()

    const advisories = captureDispatchAdvisories(app.ctx)
    await app.ctx.waterfall('tools/pre-execute', subagentExec(WORKING_BRANCH_MAIN), defaultAllow)

    const result = await adapter.beforeDispatch(WORKING_BRANCH_MAIN)

    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.code)).toEqual(dispatchCodes(advisories[0]))
    expect(result.violations.map((v) => v.code)).toContain('dispatch.default-branch.protected')
  })

  it('read-only role (scout) without branch form → pass (branch gate skipped, same as the gate)', async () => {
    const app = booted = await bootApp()
    const adapter = makeAdapter()

    const advisories = captureDispatchAdvisories(app.ctx)
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SCOUT_NO_BRANCH), defaultAllow)
    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)

    const result = await adapter.beforeDispatch(SCOUT_NO_BRANCH)
    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('valid writable Assignment → pass', async () => {
    booted = await bootApp()
    const adapter = makeAdapter()

    const result = await adapter.beforeDispatch(VALID_WRITABLE)
    expect(result.ok).toBe(true)
  })

  it('anti-recursion binding → dispatch.anti-recursion.self-type (critical), same as the gate', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'fullstack-dev' })
    const adapter = makeAdapter({ config: { dispatchBinding: 'fullstack-dev' } })

    const advisories = captureDispatchAdvisories(app.ctx)
    await app.ctx.waterfall('tools/pre-execute', subagentExec(SELF_RECURSION), defaultAllow)

    const result = await adapter.beforeDispatch(SELF_RECURSION)

    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.code)).toContain('dispatch.anti-recursion.self-type')
    expect(result.violations.map((v) => v.code)).toEqual(dispatchCodes(advisories[0]))
    const anti = result.violations.find((v) => v.code === 'dispatch.anti-recursion.self-type')
    expect(anti?.severity).toBe('critical')
  })

  it('hard enforcement → hardBlocked true, matching the waterfall deny decision', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const adapter = makeAdapter({ config: { enforcement: 'hard' } })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)
    expect(decision.kind).toBe('deny')

    const result = await adapter.beforeDispatch(MISSING_BRANCH)
    expect(result.ok).toBe(false)
    expect(result.hardBlocked).toBe(true)
    expect(result.violations.map((v) => v.code)).toContain('assignment.field.branch-missing')
  })

  it('parsed AssignmentFields form → identical codes to the canonical text form', async () => {
    booted = await bootApp()
    const adapter = makeAdapter()

    const fromFields = await adapter.beforeDispatch(MAIN_FIELDS)
    const fromText = await adapter.beforeDispatch(MAIN_FIELDS_TEXT)

    expect(fromFields.ok).toBe(false)
    expect(fromFields.violations).toEqual(fromText.violations)
    expect(fromFields.violations.map((v) => v.code)).toContain('dispatch.default-branch.protected')

    const bare = await adapter.beforeDispatch(BARE_FIELDS)
    const bareText = await adapter.beforeDispatch(BARE_FIELDS_TEXT)
    expect(bare.violations).toEqual(bareText.violations)
    expect(bare.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining([
        'assignment.field.missing-execute-as',
        'assignment.field.missing-delegation',
        'assignment.field.missing-task-category',
      ]),
    )
  })

  it('header-region scoping holds for BOTH paths — a body-quoted direct-on exception is invisible to the listener AND the adapter (qc2 F-001 parity)', async () => {
    const app = booted = await bootApp()
    const adapter = makeAdapter()

    const advisories = captureDispatchAdvisories(app.ctx)
    await app.ctx.waterfall('tools/pre-execute', subagentExec(BODY_QUOTED_BRANCH_POLICY), defaultAllow)

    const result = await adapter.beforeDispatch(BODY_QUOTED_BRANCH_POLICY)

    // The waterfall listener and the adapter slice the engine header region
    // identically (dispatchGateCore), so the default-branch protection fires
    // with the same codes on both paths — the quoted exception is not a
    // direct-on override for either.
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.code)).toEqual(dispatchCodes(advisories[0]))
    expect(result.violations.map((v) => v.code)).toContain('dispatch.default-branch.protected')
  })
})

/* ---------------------------------- beforeMerge ---------------------------------- */

describe('beforeMerge — integration merge lease (thin engine validateIntegrationMergeLease wrapper)', () => {
  it('valid lease → pass', async () => {
    booted = await bootApp()
    const adapter = makeAdapter()

    const result = await adapter.beforeMerge({
      holder: 'omp-session-holder',
      claimed_at: '2026-08-08T04:00:00Z',
      plan_id: '20260808-dsh-host-adapter',
      source_branch: 'feature/dsh-host-adapter',
      target_branch: 'spec_integration_branch',
    })
    expect(result.ok).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('invalid lease (missing required fields) → failing GateResult with lease.merge-lease.* codes', async () => {
    booted = await bootApp()
    const adapter = makeAdapter()

    const result = await adapter.beforeMerge({ holder: 'h' } as IntegrationMergeLease)
    const codes = result.violations.map((v) => v.code)

    expect(result.ok).toBe(false)
    expect(codes).toEqual(
      expect.arrayContaining([
        'lease.merge-lease.missing-claimed-at',
        'lease.merge-lease.missing-plan-id',
        'lease.merge-lease.missing-source-branch',
        'lease.merge-lease.missing-target-branch',
      ]),
    )
  })

  it('non-object lease → lease.merge-lease.invalid (absent/null are never valid lease values)', async () => {
    booted = await bootApp()
    const adapter = makeAdapter()

    const result = await adapter.beforeMerge(null as never)
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.code)).toEqual(['lease.merge-lease.invalid'])
  })
})
