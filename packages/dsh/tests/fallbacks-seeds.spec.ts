/**
 * Task 2 — persona payload + seeds declaration module (plan
 * ): `declareMstarSeeds` assembles the declaration
 * batch (the 13 `mode: subagent` mstar personas + merge-preserved seeded
 * non-mstar ids from the readback), gates interpolatable personas BEFORE
 * `declareSeeds` (skip + warn, never throws), and re-fires from the entry's
 * `ctx.inject(['llm-fallbacks'])` conditional child on every fallbacks
 * (re-)apply (service appears → declare; fiber swap → declare again).
 *
 * The service is consumed as a STRUCTURAL view (`SeedsServiceView`) — the
 * fake below spies `declareSeeds` / `getEffectiveRoles`; no runtime
 * `dsh-llm-fallbacks` import (the module boundary: type-only, mirroring
 * `fallbacks-probe.ts`).
 */
import { describe, expect, it, test, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { EffectiveRolesReadback, SeedDeclaration, SeedDeclareOutcome } from 'dsh-llm-fallbacks'
import { bootApp, type BootResult } from './harness.ts'
import {
  declareMstarSeeds,
  SEEDS_LOGGER,
  type DeclareMstarSeedsOptions,
  type SeedOutcomeView,
  type SeedsLogLevel,
  type SeedsLogSink,
  type SeedsServiceView,
} from '../src/gates/fallbacks-seeds.ts'
import { personaFor, subagentRoleIds } from '../src/gates/agent-personas.ts'
import { fallbacksService } from '../src/gates/fallbacks-probe.ts'
import { packageRoot } from '../scripts/bundle-harness-assets.ts'

/** The packaged mirror the real-contract tests anchor on (synced by bundle-assets). */
const REAL_MIRROR = join(packageRoot, 'harness-agents')

/** The exact mandatory-load guide line the brief fixes (one line, host-neutral). Identity-first roles: topic skills are PM-activated presets. */
function loadLine(roleId: string): string {
  return `Load mstar-roles (references/${roleId}.md) first — identity comes before skills; load topic skills only when the Assignment activates them via its Skill presets field.`
}

/** One structured log record captured from the module sink. */
type LogRecord = [SeedsLogLevel, string]

/** Capture the module's per-call log sink (the brief's `{ agentsDir, log }` shape). */
function captureLog(): { records: LogRecord[]; sink: SeedsLogSink } {
  const records: LogRecord[] = []
  return { records, sink: (level, message) => { records.push([level, message]) } }
}

/** Structural fake of the fallbacks seed surface — spies both consumed methods. */
class FakeSeedsService implements SeedsServiceView {
  declareCalls: SeedDeclaration[][] = []
  readbackCalls = 0
  constructor(
    private readonly readback: EffectiveRolesReadback,
    private readonly outcome: SeedDeclareOutcome = { applied: [], skipped: [], conflicts: [] },
  ) {}
  getEffectiveRoles(): EffectiveRolesReadback {
    this.readbackCalls += 1
    return this.readback
  }
  async declareSeeds(seeds: readonly SeedDeclaration[]): Promise<SeedDeclareOutcome> {
    this.declareCalls.push([...seeds])
    return this.outcome
  }
}

/** A readback that throws — the contained-failure probe case. */
class ThrowingReadbackService extends FakeSeedsService {
  override getEffectiveRoles(): EffectiveRolesReadback {
    this.readbackCalls += 1
    throw new Error('settings unavailable')
  }
}

/**
 * Wiring fake of the upstream provider payload (the synchronous
 * `ctx.provide('llm-fallbacks', …)` shape: name + version + the seed
 * surface): the FIRST `declareSeeds` rejects with a caller-supplied message
 * (the live apply-window rejection), later calls resolve and the successful
 * batch becomes the readback (the real registry's replacement semantics —
 * `getEffectiveRoles` mirrors the last successful declare).
 */
class FlakyFirstDeclareService implements SeedsServiceView {
  readonly name = 'llm-fallbacks'
  readonly version = 'test'
  declareCalls: SeedDeclaration[][] = []
  private declaredBatch: readonly SeedDeclaration[] | undefined
  constructor(private readonly firstFailure: string) {}
  getEffectiveRoles(): EffectiveRolesReadback {
    return {
      roles: (this.declaredBatch ?? []).map((d) => ({
        id: d.id,
        persona: d.persona,
        seeded: true,
        personaOverridden: false,
        source: 'external',
        seedPersona: d.persona,
      })),
    }
  }
  async declareSeeds(seeds: readonly SeedDeclaration[]): Promise<SeedDeclareOutcome> {
    this.declareCalls.push([...seeds])
    if (this.declareCalls.length === 1) throw new Error(this.firstFailure)
    this.declaredBatch = [...seeds]
    return { applied: seeds.map((d) => d.id), skipped: [], conflicts: [] }
  }
}

/** One fixture shell markdown: constrained repo-owned frontmatter + a stub body. */
function shell(frontmatter: string[]): string {
  return ['---', ...frontmatter, '---', '', '## Morning Star Role Binding', '', 'You are the role shell.'].join('\n')
}

async function seedShell(dir: string, roleId: string, frontmatter: string[]): Promise<void> {
  await writeFile(join(dir, `${roleId}.md`), shell(frontmatter))
}

/** Seed a throwaway fixture mirror with the given `[roleId, frontmatter]` shells. */
async function fixtureMirror(shells: Array<[string, string[]]>): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fallbacks-seeds-'))
  for (const [roleId, frontmatter] of shells) await seedShell(dir, roleId, frontmatter)
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Run the module under test with a capture sink. */
async function runSeeds(
  service: SeedsServiceView,
  agentsDir: string | undefined,
): Promise<{ view: SeedOutcomeView; records: LogRecord[] }> {
  const { records, sink } = captureLog()
  const view = await declareMstarSeeds(service, { agentsDir, log: sink } satisfies DeclareMstarSeedsOptions)
  return { view, records }
}

/** One seeded readback row with the upstream `EffectiveRole` shape (0.5.2 derives `source` at read time: the declaring set's label, `user` iff unseeded — these fakes declare via the public API with no `set`, i.e. `external`). */
function seededRow(id: string, seedPersona: string, overridden = false): EffectiveRolesReadback['roles'][number] {
  return { id, persona: overridden ? `operator override of ${id}` : seedPersona, seeded: true, personaOverridden: overridden, source: 'external', seedPersona }
}

/** One structured boot-log record (the cordis logger `Message` subset the
 * boot-log assertions read — narrowed structurally, no cordis type coupling;
 * the boot-order spec's record shape). */
interface BootLogRecord {
  type?: unknown
  name?: unknown
  args?: unknown[]
}

/** Best-effort flattened text of one boot-log record (the message match surface). */
function recordText(record: BootLogRecord): string {
  return (record.args ?? []).map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')
}

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

describe('declareMstarSeeds — persona payload + merge-preserve + gates', () => {
  it('(a) real mirror: the 13 subagent roles are declared with description + mandatory-load line, outcome passed through', async () => {
    if (!existsSync(REAL_MIRROR)) return // mirror not synced (bundle-assets not run)
    const ids = subagentRoleIds(REAL_MIRROR)
    expect(ids).toHaveLength(13)
    expect(ids).not.toContain('project-manager')
    const fake = new FakeSeedsService({ roles: [] }, { applied: [...ids], skipped: [], conflicts: [] })
    const { view } = await runSeeds(fake, REAL_MIRROR)
    // Every subagent role declared exactly once, no local skips.
    expect(view.declared.map((d) => d.id)).toEqual(ids)
    expect(view.skipped).toEqual([])
    expect(view.preserved).toEqual([])
    // Persona = mirror description verbatim + blank line + the one guide line.
    for (const decl of view.declared) {
      const resolved = personaFor(decl.id, { agentsDir: REAL_MIRROR })
      expect(resolved).toBeDefined()
      expect(decl.persona).toBe(`${resolved!.text}\n\n${loadLine(decl.id)}`)
      expect(decl.persona).not.toMatch(/\{\{[\s\S]*\}\}/)
    }
    // The service received exactly that batch; the upstream outcome is passed through.
    expect(fake.declareCalls).toHaveLength(1)
    expect(fake.declareCalls[0]!.map((d) => d.id)).toEqual(ids)
    expect(view.outcome).toEqual({ applied: ids, skipped: [], conflicts: [] })
  })

  it('(b) fixture mirror: persona text shape is description, blank line, guide line (role-id templated)', async () => {
    const mirror = await fixtureMirror([['fullstack-dev', ['description: |-', '  Fullstack implementer.', 'mode: subagent']]])
    try {
      const fake = new FakeSeedsService({ roles: [] })
      const { view } = await runSeeds(fake, mirror.dir)
      expect(view.declared).toEqual([{ id: 'fullstack-dev', persona: `Fullstack implementer.\n\n${loadLine('fullstack-dev')}` }])
      expect(view.skipped).toEqual([])
    } finally {
      await mirror.cleanup()
    }
  })

  it('(c) a preserved persona carrying the {{...}} interpolation hazard is skipped with reason interpolation + one warn, never declared', async () => {
    const fake = new FakeSeedsService({
      roles: [seededRow('designer', 'You are the {{role}} executor.')],
    })
    const { view, records } = await runSeeds(fake, undefined)
    expect(view.declared).toEqual([])
    expect(view.skipped).toEqual([{ id: 'designer', reason: 'interpolation' }])
    expect(view.preserved).toEqual([])
    const warns = records.filter(([level]) => level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]![1]).toContain('designer')
    expect(warns[0]![1]).toContain('interpolation')
  })

  it('(d) a mirror shell whose description carries the hazard is skipped with a warn (extraction semantics aligned), never declared', async () => {
    const mirror = await fixtureMirror([['ops-engineer', ['description: |-', '  You are the {{role}} executor.', 'mode: subagent']]])
    try {
      const fake = new FakeSeedsService({ roles: [] })
      const { view, records } = await runSeeds(fake, mirror.dir)
      expect(view.declared).toEqual([])
      expect(view.skipped).toEqual([{ id: 'ops-engineer', reason: 'no-persona' }])
      const warns = records.filter(([level]) => level === 'warn')
      expect(warns).toHaveLength(1)
      expect(warns[0]![1]).toContain('ops-engineer')
    } finally {
      await mirror.cleanup()
    }
  })

  it('(e) a subagent role with no usable default is skipped (no-persona), never declared', async () => {
    const mirror = await fixtureMirror([
      ['fullstack-dev', ['description: |-', '  Fullstack implementer.', 'mode: subagent']],
      // No `description` field — extraction yields no usable default.
      ['ops-engineer', ['mode: subagent']],
    ])
    try {
      const fake = new FakeSeedsService({ roles: [] })
      const { view } = await runSeeds(fake, mirror.dir)
      expect(view.declared.map((d) => d.id)).toEqual(['fullstack-dev'])
      expect(view.skipped).toEqual([{ id: 'ops-engineer', reason: 'no-persona' }])
    } finally {
      await mirror.cleanup()
    }
  })

  it('(f) merge-preserve: seeded non-mstar ids enter the batch with seedPersona; unseeded and mstar ids do not', async () => {
    const mirror = await fixtureMirror([['architect', ['description: |-', '  Architect default text.', 'mode: subagent']]])
    try {
      const fake = new FakeSeedsService({
        roles: [
          // Preserved: seeded non-mstar id — batch persona is seedPersona, NOT the operator override.
          seededRow('designer', 'The designer default.', true),
          seededRow('librarian', 'The librarian default.'),
          // Not preserved: unseeded row (0.5.2 derives `source: 'user'`).
          { id: 'reviewer', persona: 'x', seeded: false, personaOverridden: false, source: 'user' },
          // Not preserved: mstar id — declared from the MIRROR instead of the readback seed.
          seededRow('architect', 'Architect readback seed.', true),
        ],
      })
      const { view } = await runSeeds(fake, mirror.dir)
      expect(view.preserved).toEqual([
        { id: 'designer', persona: 'The designer default.' },
        { id: 'librarian', persona: 'The librarian default.' },
      ])
      const ids = view.declared.map((d) => d.id)
      expect(ids).toContain('designer')
      expect(ids).toContain('librarian')
      expect(ids).not.toContain('reviewer')
      // The mstar id is declared from the mirror (SSOT), not the readback seedPersona.
      expect(view.declared).toContainEqual({ id: 'architect', persona: `Architect default text.\n\n${loadLine('architect')}` })
      expect(view.declared).not.toContainEqual({ id: 'architect', persona: 'Architect readback seed.' })
    } finally {
      await mirror.cleanup()
    }
  })

  it('(g) idempotent: a second call re-declares an identical batch (upstream no-delta write is the manager contract; the module is deterministic)', async () => {
    const mirror = await fixtureMirror([['fullstack-dev', ['description: |-', '  Fullstack implementer.', 'mode: subagent']]])
    try {
      const fake = new FakeSeedsService({ roles: [seededRow('designer', 'The designer default.')] })
      const first = await runSeeds(fake, mirror.dir)
      const second = await runSeeds(fake, mirror.dir)
      expect(fake.declareCalls).toHaveLength(2)
      expect(fake.declareCalls[0]).toEqual(fake.declareCalls[1])
      expect(fake.readbackCalls).toBe(2)
      expect(second.view).toEqual(first.view)
    } finally {
      await mirror.cleanup()
    }
  })

  it('(h) a throwing readback is contained: empty view, no declare, one warn, never rejects', async () => {
    const fake = new ThrowingReadbackService({ roles: [] })
    const { view, records } = await runSeeds(fake, undefined)
    expect(view.declared).toEqual([])
    expect(view.preserved).toEqual([])
    expect(fake.declareCalls).toHaveLength(0)
    expect(records.some(([level, message]) => level === 'warn' && message.includes('readback'))).toBe(true)
  })

  it('(k) empty declaration batch → the upstream declareSeeds is NEVER called (registry untouched; S-empty guard)', async () => {
    // No mstar ids (agentsDir absent) and the only seeded non-mstar row
    // carries the interpolation hazard → declared = []. Upstream declare is
    // REPLACEMENT semantics: calling declareSeeds([]) would commit an empty
    // registry, stripping any annotations a concurrent declarer (the preset
    // child) committed in the readback→commit window. The guard skips the
    // upstream call entirely — the registry is untouched.
    const fake = new FakeSeedsService({
      roles: [seededRow('designer', 'You are the {{role}} executor.')],
    })
    const { view, records } = await runSeeds(fake, undefined)
    expect(view.declared).toEqual([])
    expect(view.skipped).toEqual([{ id: 'designer', reason: 'interpolation' }])
    expect(fake.declareCalls).toHaveLength(0)
    // One debug documents the skip (the upstream call was never made).
    expect(records.some(([level, message]) => level === 'debug' && message.includes('empty batch'))).toBe(true)
  })
})

describe('entry wiring — ctx.inject([\'llm-fallbacks\']) conditional child re-fires per service (re-)apply', () => {
  /** A function plugin that provides a fake fallbacks service on its fiber. */
  function fallbacksProvider(fake: FakeSeedsService): { name: string; apply(ctx: Context): void } {
    return {
      name: 'fake-fallbacks-provider',
      apply(ctx: Context) {
        ctx.provide('llm-fallbacks', fake)
      },
    }
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 10)
      await promise
    }
  }

  test.skipIf(!existsSync(REAL_MIRROR))('(i) unmounted boot arms the child; service appears → declare; fiber swap → declare again with the same batch', async () => {
    const app = booted = await bootApp()
    // Unmounted at apply: no service, boot degrades (the inject child stays armed).
    expect(fallbacksService(app.ctx)).toBeUndefined()

    // Service appears (fallbacks applied) → the child fires and declares.
    const first = new FakeSeedsService({ roles: [] })
    const fiber1 = await app.ctx.plugin(fallbacksProvider(first))
    await waitFor(() => first.declareCalls.length === 1)
    const expectedIds = subagentRoleIds(REAL_MIRROR)
    expect(first.declareCalls[0]!.map((d) => d.id).sort()).toEqual([...expectedIds].sort())

    // Service removed (fiber swap window) → child unwinds; no further declares.
    await fiber1.dispose()
    expect(fallbacksService(app.ctx)).toBeUndefined()

    // Service re-appears (fallbacks re-applied / HMR) → re-fire, identical batch.
    const second = new FakeSeedsService({ roles: [] })
    const fiber2 = await app.ctx.plugin(fallbacksProvider(second))
    await waitFor(() => second.declareCalls.length === 1)
    expect(second.declareCalls[0]).toEqual(first.declareCalls[0])
    await fiber2.dispose()
  })

  it('(j) the module never throws into apply: the wiring is fire-and-forget (a rejecting declareSeeds is caught terminally)', async () => {
    const app = booted = await bootApp()
    const failing = new FakeSeedsService({ roles: [] })
    failing.declareSeeds = async () => { throw new Error('settings write failed') }
    const fiber = await app.ctx.plugin(fallbacksProvider(failing))
    // The child must not reject the boot: the wiring's terminal catch absorbs it.
    await waitFor(() => failing.readbackCalls >= 1)
    // Give the fire-and-forget rejection a settle window — the app stays alive.
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 50)
    await promise
    expect(fallbacksService(app.ctx)).toBeDefined()
    await fiber.dispose()
  })

  test.skipIf(!existsSync(REAL_MIRROR))('(l) bounded retry: a rejecting first declare converges on attempt 2 (exactly two calls; readback reflects the second batch)', async () => {
    // The live apply-window rejection, verbatim (the upstream
    // write-channel race the boot-order regression pins end to end).
    const flaky = new FlakyFirstDeclareService('llm-fallbacks: seeds: settings service is unavailable — seed roles cannot be written')
    // Synchronous provider stub — the same provide shape as the real
    // fallbacks plugin (service object applied in the plugin's apply).
    const stub = {
      name: 'fake-fallbacks-provider',
      apply(ctx: Context) {
        ctx.provide('llm-fallbacks', flaky)
      },
    }
    booted = await bootApp({ fallbacksModule: stub, settingsService: 'fake' })
    const service = fallbacksService(booted.ctx)
    expect(service, 'the stub-provided llm-fallbacks service is applied').toBeDefined()
    // Attempt 1 rejects; the bounded retry lands at +50 ms and resolves.
    await waitFor(() => flaky.declareCalls.length === 2)
    expect(flaky.declareCalls, 'exactly two declare attempts (a resolved attempt stops the loop)').toHaveLength(2)
    const expectedIds = subagentRoleIds(REAL_MIRROR)
    // Both attempts declared the mirror-derived mstar batch.
    expect(flaky.declareCalls[0]!.map((d) => d.id).sort()).toEqual([...expectedIds].sort())
    expect(flaky.declareCalls[1]!.map((d) => d.id).sort()).toEqual([...expectedIds].sort())
    // The readback reflects the SECOND (successful) call's batch.
    const readback = service!.getEffectiveRoles()
    expect(readback.roles.map((r) => r.id).sort()).toEqual([...expectedIds].sort())
    expect(readback.roles.every((r) => r.seeded)).toBe(true)
    // Settle past any further scheduling — no third attempt ever fires. The
    // window is airtight: a regression scheduling a post-resolution attempt
    // at the +250 ms retry delay would fire ≈300 ms after the resolved
    // retry, so the settle must exceed that (320 ms > 300 ms); the old
    // 120 ms settle let that regression pass.
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 320)
    await promise
    expect(flaky.declareCalls, 'no attempt after the resolved retry').toHaveLength(2)
  })

  test.skipIf(!existsSync(REAL_MIRROR))('(m) persistent-rejecting declare burns out ONCE: exactly ONE seeds ERROR (the terminal line), zero per-attempt errors', async () => {
    // The exactly-once terminal-error HARD constraint: a persistently
    // failing service must produce ONE ERROR on the seeds logger after the
    // 3-attempt burnout — per-attempt failures stay on DEBUG, so a
    // regression that logs one error PER attempt (or drops the terminal
    // error entirely) fails here.
    const dead = new FakeSeedsService({ roles: [] })
    const failure = 'llm-fallbacks: seeds: settings service is unavailable — seed roles cannot be written'
    // The override replaces the spy method (it never reaches the class
    // counter), so it counts its own invocations — the burnout signal.
    let declareAttempts = 0
    dead.declareSeeds = async () => {
      declareAttempts += 1
      throw new Error(failure)
    }
    const stub = {
      name: 'fake-fallbacks-provider',
      apply(ctx: Context) {
        ctx.provide('llm-fallbacks', dead)
      },
    }
    // No dispose before the burnout: the retry loop must run to its natural
    // terminal (attempts at ≈0/50/≈300 ms — the +250 ms second delay).
    booted = await bootApp({ fallbacksModule: stub, settingsService: 'fake' })
    // Count-based burnout detection (not a bare settle): the terminal catch
    // runs as microtasks after attempt 3's rejection flushes, so observing
    // the third declare attempt is the burnout signal.
    await waitFor(() => declareAttempts === 3)
    // The default cordis buffer's level cap is INFO, so ERROR-class records
    // land in it (the boot-order spec's probe-verified capture) — the exact
    // level class this assertion reads (debug lines don't count).
    const logger = booted.ctx.logger as unknown as { buffer?: BootLogRecord[] } | undefined
    const seedsErrors = (logger?.buffer ?? []).filter((record) => record.name === SEEDS_LOGGER && record.type === 'error')
    expect(seedsErrors, 'exactly ONE terminal seeds ERROR after the burnout').toHaveLength(1)
    const text = recordText(seedsErrors[0]!)
    expect(text).toContain('mstar seeds declaration failed (contained — fallbacks taxonomy unchanged):')
    // The terminal record carries the UPSTREAM rejection message, not a
    // generic one — the operator sees the actual failure cause.
    expect(text).toContain(failure)
  })
})
