/**
 * Task 6 — HMR-safety disposal test (dsh packages/AGENTS.md: "Registry
 * contributions prove disposal through the HMR-safety test ... dispose the
 * fiber and observe removal"; docs/testing.md unit tier: "Every registry gets
 * an HMR-safety test (dispose the contributing fiber, assert cleanup)").
 *
 * The dsh function plugin registers every contribution on the apply fiber's
 * context: the fs intent waterfall listeners (prepended), the
 * `tools/pre-execute` waterfall listener, and the `ctx.dshMstar` service
 * (Service self-registration). Disposing the fiber must unwind ALL of them —
 * a hot reload never leaves a stale gate vetoing or advising on the reloaded
 * module's behalf. Teardown-order guarantee under test: the registrations are
 * fiber-scoped effects, so disposal unwinds them (tool-facing waterfall
 * listeners and the service) before any registry/catalog consumer can observe
 * the reloaded app — no half-removed contribution survives.
 *
 * Mount form: `ctx.plugin(plugin, config)` (Plugin.Object shape — the same
 * mount the Loader performs for a function plugin, dsh-private compact
 * HMR-safety pattern); the real Loader composition is covered by the
 * status/dispatch/lease suites.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { StatusGateError } from '../src/index.ts'
import { INVALID_STATUS, seedHarness } from './harness.ts'

/** Violating writable Assignment (missing Execute as — the field-gate case). */
const MISSING_EXECUTE_AS = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x

Do the thing.
`

/** FsTarget for `{HARNESS_DIR}/status.json` (local-backend shape). */
const statusTarget = (harnessDir: string): FsTarget => ({
  targetKey: join(harnessDir, 'status.json') as FsTarget['targetKey'],
  displayPath: join(harnessDir, 'status.json'),
})

/** One pending subagent tool call in the registry pipeline shape. */
const subagentExec = (prompt: string): ToolExecution => ({
  callId: 'c1' as ToolExecution['callId'],
  name: 'subagent',
  arguments: { description: 'probe', prompt },
  signal: new AbortController().signal,
  token: Symbol('dsh.tool.execution'),
})

/** The registry's bare default decision (the waterfall's terminal `next()`). */
const defaultAllow = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

describe('HMR safety — fiber.dispose removes every gate contribution', () => {
  it('disposes the gates + service on fiber.dispose and a reloaded fiber restores them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-hmr-'))
    const harnessDir = join(root, 'harness')
    const ctx = new Context()
    try {
      await seedHarness(harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })

      // Mount 1 — every gate is live on the new fiber.
      const fiber = await ctx.plugin(plugin, { enforcement: 'hard', harnessDir })
      expect(ctx.dshMstar).toBeDefined()
      await expect(
        ctx.waterfall('fs/write-intent', statusTarget(harnessDir), {}, () => undefined),
      ).rejects.toBeInstanceOf(StatusGateError)
      const denied = await ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)
      expect(denied).toMatchObject({ kind: 'deny' })

      // Dispose — the status listener, the dispatch listener and the service
      // are all unwound: no veto, no deny, no service.
      await fiber.dispose()
      expect(ctx.dshMstar).toBeUndefined()
      const writeAfter = await ctx.waterfall('fs/write-intent', statusTarget(harnessDir), {}, () => undefined)
      expect(writeAfter).toBeUndefined()
      const dispatchAfter = await ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)
      expect(dispatchAfter).toEqual({ kind: 'allow' })

      // HMR reload — a fresh fiber restores the full gate set.
      const reloaded = await ctx.plugin(plugin, { enforcement: 'hard', harnessDir })
      expect(ctx.dshMstar).toBeDefined()
      await expect(
        ctx.waterfall('fs/write-intent', statusTarget(harnessDir), {}, () => undefined),
      ).rejects.toBeInstanceOf(StatusGateError)
      const deniedAgain = await ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)
      expect(deniedAgain).toMatchObject({ kind: 'deny' })
      await reloaded.dispose()
      expect(ctx.dshMstar).toBeUndefined()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})
