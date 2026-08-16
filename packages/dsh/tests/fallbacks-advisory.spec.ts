/**
 * Task 4 — warn-only adoption advisory (plan `20260815-dsh-fallbacks-personas`):
 * when fallbacks is mounted, ONE advisory pass per apply structurally reads the
 * deployment's fallbacks row config from the loader entry (`entry.options.config`
 * — architect-verified field: `EntryOptions.config` "Config passed to the
 * plugin", the same value the plugin's `apply()` receives) and warns (bounded:
 * ≤1 warn per category, logger `mstar/fallbacks-advisory`) on taxonomy gaps:
 *
 * - (b) mstar role ids missing from the deployment's `roles.list` — the
 *   mstar role-id set is derived from the `harness-agents/` mirror
 *   (Task 3 surface, never hardcoded);
 * - (c) declared role entities with an empty persona;
 * - (d) legacy keys in role entities (`detectLegacyKeys` semantics — the
 *   service's own detector when applied).
 *
 * Unreadable row config (absent field / non-object) → skip + one debug log;
 * unmounted → the advisory is not invoked (returns false, no logs). The
 * advisory NEVER writes the fallbacks config (fixtures assert the row-config
 * object is unmutated) and never throws.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import type { EffectiveRolesReadback, FallbacksService, SeedDeclaration, SeedDeclareOutcome } from 'dsh-llm-fallbacks'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootApp, FakeLoaderRegistry, startInfo, type BootResult } from './harness.ts'
import { FALLBACKS_ENTRY_NAME, type LoaderEntryView } from '../src/gates/fallbacks-probe.ts'
import { packagedAgentsDir } from '../src/gates/_shared.ts'
import {
  ADVISORY_LOGGER,
  runFallbacksAdvisory,
  setAdvisoryLogger,
  type AdvisoryLogLevel,
} from '../src/gates/fallbacks-advisory.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The mirror-derived mstar role-id set the fixture shells declare. */
const MIRROR_ROLES = ['architect', 'fullstack-dev', 'scout']

/** One fixture shell markdown: constrained repo-owned frontmatter + a stub body. */
function shell(frontmatter: string[]): string {
  return ['---', ...frontmatter, '---', '', '## Morning Star Role Binding', '', 'You are the role shell.'].join('\n')
}

/** Seed a throwaway fixture mirror with the three subagent-mode shells. */
async function fixtureMirror(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-advisory-mirror-'))
  const shells: Array<[string, string[]]> = [
    ['architect', ['name: architect', 'description: |-', '  Architect the plan.', 'mode: subagent']],
    ['fullstack-dev', ['name: fullstack-dev', 'description: |-', '  Implement the task.', 'mode: subagent']],
    ['scout', ['name: scout', 'description: |-', '  Explore the repository.', 'mode: subagent']],
  ]
  for (const [role, frontmatter] of shells) await writeFile(join(dir, `${role}.md`), shell(frontmatter))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * A fixture mirror where the listed role descriptions carry a `{{...}}`
 * interpolation hazard — extraction rejects those defaults (per-id skip +
 * diagnostic) while the other shells stay clean (Task 3 Fix wave 1: the
 * declaration/skip warn surface must stay ONE consolidated line).
 */
async function fixtureMirrorWithHazards(hazardIds: string[]): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-advisory-mirror-'))
  const bases: Array<[string, string]> = [
    ['architect', 'Architect the plan.'],
    ['fullstack-dev', 'Implement the task.'],
    ['scout', 'Explore the repository.'],
  ]
  for (const [role, text] of bases) {
    const description = hazardIds.includes(role) ? `${text} {{user}}` : text
    await writeFile(join(dir, `${role}.md`), shell(['name: ' + role, 'description: |-', `  ${description}`, 'mode: subagent']))
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** One declared fallbacks role entity (`roles.list` entry). */
function role(id: string, persona: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, persona, ...extra }
}

/** A structurally well-formed fallbacks row config around the given roles.list. */
function rowConfig(list: unknown[]): Record<string, unknown> {
  return {
    enabled: true,
    triggerCodes: ['429'],
    rootChain: ['gpt-4o'],
    roles: { list, rules: [] },
    cooldownMs: 60000,
  }
}

/** A live, enabled fallbacks loader entry carrying the given row config (undefined = unconfigured row). */
function liveEntry(rowConfig?: unknown): LoaderEntryView {
  return { options: { name: FALLBACKS_ENTRY_NAME, config: rowConfig }, disabled: false, fiber: {} }
}

/** A context whose loader answers entries() with the given list (probe test pattern). */
function ctxWithLoader(entries: LoaderEntryView[]): Context {
  const ctx = new Context()
  const loader = new FakeLoaderRegistry(ctx)
  loader.entriesList = entries
  return ctx
}

/** Capture advisory logs through the module sink (decoration test pattern). */
function captureLogs(): { captured: Array<[AdvisoryLogLevel, string]>; restore: () => void } {
  const captured: Array<[AdvisoryLogLevel, string]> = []
  const prior = setAdvisoryLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setAdvisoryLogger(prior) }
}

/**
 * One effective readback row with the upstream `EffectiveRole` shape (Task 3
 * — the advisory's seeds-aware path reads the EFFECTIVE state, not the raw
 * `roles.list`).
 */
function effRow(
  id: string,
  persona: string,
  seeded: boolean,
  personaOverridden = false,
  seedPersona?: string,
): EffectiveRolesReadback['roles'][number] {
  const row: EffectiveRolesReadback['roles'][number] = { id, persona, seeded, personaOverridden }
  if (seeded && seedPersona !== undefined) row.seedPersona = seedPersona
  return row
}

/**
 * Structural fake of the fallbacks service surface the advisory consumes —
 * spies the call ORDER of the seed methods (the Task 3 decision point must
 * await the idempotent re-declare BEFORE the effective-state readback).
 */
class FakeAdvisoryService {
  /** The consumed-method call order (`getEffectiveRoles` / `declareSeeds`). */
  calls: string[] = []
  declareCalls: SeedDeclaration[][] = []
  constructor(
    private readonly readback: EffectiveRolesReadback,
    private readonly outcome: SeedDeclareOutcome = { applied: [], skipped: [], conflicts: [] },
  ) {}
  getEffectiveRoles(): EffectiveRolesReadback {
    this.calls.push('getEffectiveRoles')
    return this.readback
  }
  async declareSeeds(seeds: readonly SeedDeclaration[]): Promise<SeedDeclareOutcome> {
    this.calls.push('declareSeeds')
    this.declareCalls.push([...seeds])
    return this.outcome
  }
  /** The row-config legacy detector — the tests keep the config clean. */
  detectLegacyKeys(): string[] {
    return []
  }
}

/** A mounted context with a loader row carrying `cfg` AND a provided fake service (seeds-aware path). */
function ctxWithService(service: FakeAdvisoryService, cfg: Record<string, unknown>): Context {
  const ctx = ctxWithLoader([liveEntry(cfg)])
  ctx.provide('llm-fallbacks', service as unknown as FallbacksService)
  return ctx
}

describe('fallbacks adoption advisory — mounted, warn-only, bounded', () => {
  it('(a) roles.list covers all mirror role ids with non-empty personas → pass, no logs, config unmutated', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = rowConfig(MIRROR_ROLES.map((id) => role(id, `Persona for ${id}`)))
      const snapshot = structuredClone(cfg)
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        // Clean taxonomy → no warn, no debug.
        expect(captured).toEqual([])
        // The advisory is read-only over the deployment's config layer.
        expect(cfg).toEqual(snapshot)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(b) mstar role ids missing from roles.list → ONE warn listing them', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = rowConfig([role('architect', 'Architect persona'), role('fullstack-dev', 'Dev persona')])
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('scout')
        expect(captured.filter(([level]) => level === 'debug')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(c) declared role with an empty persona → ONE warn naming the id', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = rowConfig(MIRROR_ROLES.map((id) => role(id, id === 'scout' ? '' : `Persona for ${id}`)))
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('scout')
        expect(warns[0]![1]).toContain('empty persona')
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(c2) a null/non-object entry in roles.list → skipped + one debug each; the pass continues for the other entries (S-003)', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = rowConfig([role('architect', 'Architect persona'), null, 'not-an-entity', role('fullstack-dev', 'Dev persona')])
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        // The malformed entries are skipped; the well-formed entries still
        // drive the taxonomy checks — scout is still missing → ONE warn.
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('scout')
        // Each skipped malformed entry → one debug (null + string = 2).
        const debugs = captured.filter(([level]) => level === 'debug')
        expect(debugs).toHaveLength(2)
        expect(debugs.every(([, message]) => message.includes('roles.list entry'))).toBe(true)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(d) legacy keys in the row config → ONE warn citing detectLegacyKeys semantics (service-present path)', async () => {
    const mirror = await fixtureMirror()
    try {
      // The seeds-aware path still runs the service's OWN detector on the row
      // config; the fake reports the two-block-era keys (label/description).
      const fake = new FakeAdvisoryService({
        roles: MIRROR_ROLES.map((id) => effRow(id, `${id} default.`, true, false, `${id} default.`)),
      })
      fake.detectLegacyKeys = () => ['roles.list[].label', 'roles.list[].description']
      const cfg = rowConfig(MIRROR_ROLES.map((id) => role(id, `Persona for ${id}`)))
      const snapshot = structuredClone(cfg)
      const ctx = ctxWithService(fake, cfg)
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('detectLegacyKeys')
        expect(warns[0]![1]).toContain('roles.list[].label')
        expect(warns[0]![1]).toContain('roles.list[].description')
        expect(cfg).toEqual(snapshot)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(e) row config absent (unconfigured row) → skip + ONE debug, no warn', async () => {
    const mirror = await fixtureMirror()
    try {
      const ctx = ctxWithLoader([liveEntry()])
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        expect(captured.filter(([level]) => level === 'debug')).toHaveLength(1)
        expect(captured[0]![0]).toBe('debug')
        expect(captured[0]![1]).toContain('unreadable')
        expect(captured.filter(([level]) => level === 'warn')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(e2) non-object row config → skip + ONE debug, no warn', async () => {
    const mirror = await fixtureMirror()
    try {
      const ctx = ctxWithLoader([liveEntry('not-an-object')])
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        expect(captured.filter(([level]) => level === 'debug')).toHaveLength(1)
        expect(captured[0]![1]).toContain('unreadable')
        expect(captured.filter(([level]) => level === 'warn')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(e3) unreadable roles block → skip taxonomy + ONE debug, no warn', async () => {
    const mirror = await fixtureMirror()
    try {
      const cfg = { enabled: true, triggerCodes: ['429'], rootChain: ['gpt-4o'], roles: 'not-an-object' }
      const ctx = ctxWithLoader([liveEntry(cfg)])
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        expect(captured.filter(([level]) => level === 'debug')).toHaveLength(1)
        expect(captured[0]![1]).toContain('roles')
        expect(captured.filter(([level]) => level === 'warn')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(f) unmounted fallbacks (no loader service) → advisory not invoked: false, no logs', async () => {
    const mirror = await fixtureMirror()
    try {
      const ctx = new Context()
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(false)
        expect(captured).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(f2) disabled fallbacks entry → advisory not invoked: false, no logs', async () => {
    const mirror = await fixtureMirror()
    try {
      const ctx = ctxWithLoader([{ options: { name: FALLBACKS_ENTRY_NAME, config: rowConfig([]) }, disabled: true, fiber: {} }])
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(false)
        expect(captured).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('wiring — apply binds the advisory and runs ONE pass at the first subagent/start decision point', async () => {
    const mirror = packagedAgentsDir()
    if (mirror === undefined) return // bundle-assets not run — the live mirror is a precondition
    booted = await bootApp()
    // The loader mounts entries concurrently — at apply the row list is
    // empty, so the apply-time attempt sees unmounted and the latch stays
    // open; the first decision point (subagent/start) runs the pass.
    ;(booted.ctx.get('loader') as FakeLoaderRegistry).entriesList = [liveEntry(rowConfig([]))]
    const { captured, restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo('agent-1'))
      // Task 3: the pass is now async (the service-present path awaits the
      // idempotent re-declare before the readback) — flush the microtask so
      // the one-shot latch arms before the second decision point.
      await Promise.resolve()
      const warns = captured.filter(([level]) => level === 'warn')
      expect(warns.length).toBeGreaterThan(0)
      expect(warns.some(([, message]) => message.includes('roles.list is missing'))).toBe(true)
      // Bounded: a second decision point emits nothing new (one pass per apply).
      const before = captured.length
      booted.ctx.events.emit('subagent/start', startInfo('agent-2'))
      expect(captured.slice(before)).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('fallbacks adoption advisory — seeds-aware effective state (service present, plan 20260816-dsh-b4-seeds Task 3)', () => {
  /** All three fixture mstar roles seeded at their defaults (clean effective state). */
  function seededReadback(): EffectiveRolesReadback {
    return {
      roles: MIRROR_ROLES.map((id) => effRow(id, `${id} default.`, true, false, `${id} default.`)),
    }
  }

  it('(s1) all mstar roles seeded and not overridden → pass, NO warns, one debug naming the seeded ids', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService(seededReadback())
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        expect(captured.filter(([level]) => level === 'warn')).toEqual([])
        // Seeded state is silent-by-default: one debug confirms convergence.
        const seededDebug = captured.find(([, message]) => message.includes('seeded at their defaults'))
        expect(seededDebug).toBeDefined()
        for (const id of MIRROR_ROLES) expect(seededDebug![1]).toContain(id)
        // The re-declare ran (convergence) — its own debug summary is present.
        expect(captured.some(([, message]) => message.includes('mstar seeds declared'))).toBe(true)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s2) a persona-overridden mstar role → ONE warn naming it WITH the revert entry (settings card rollback button + fallbacks/revert-seed gateway)', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService({
        roles: [
          effRow('architect', 'Architect default.', true, false, 'Architect default.'),
          effRow('fullstack-dev', 'Dev default.', true, false, 'Dev default.'),
          effRow('scout', 'Operator override of scout', true, true, 'Scout default.'),
        ],
      })
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('scout')
        expect(warns[0]![1]).toContain('override')
        // Revert affordance: the settings-card rollback button + the gateway.
        expect(warns[0]![1]).toContain('settings card')
        expect(warns[0]![1]).toContain('fallbacks/revert-seed')
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s3) an mstar role with NO effective row → ONE warn listing it as missing', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService({
        roles: [
          effRow('architect', 'Architect default.', true, false, 'Architect default.'),
          effRow('fullstack-dev', 'Dev default.', true, false, 'Dev default.'),
        ],
      })
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('scout')
        expect(warns[0]![1]).toContain('missing')
        // Readback-driven, not roles.list-driven: the PRESENT mstar rows
        // (architect, fullstack-dev) are not reported missing — only scout
        // genuinely lacks an effective row.
        expect(warns[0]![1]).not.toContain('architect')
        expect(warns[0]![1]).not.toContain('fullstack-dev')
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s4) empty persona on a NON-seeded row → ONE warn naming it ((iv) non-seeded branch)', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService({
        roles: [
          ...seededReadback().roles,
          // A non-mstar row that never got seeded and carries no persona.
          effRow('designer', '', false),
        ],
      })
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('designer')
        expect(warns[0]![1]).toContain('empty persona')
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s4b) empty persona on a seeded-at-default row → NO empty-persona warn ((iv) filter — the brief formula)', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService({
        roles: [
          effRow('architect', '', true, false, 'Architect default.'),
          effRow('fullstack-dev', 'Dev default.', true, false, 'Dev default.'),
          effRow('scout', 'Scout default.', true, false, 'Scout default.'),
        ],
      })
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        expect(captured.filter(([level]) => level === 'warn')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s5) spy order: the decision point awaits the re-declare BEFORE the effective readback (getEffectiveRoles → declareSeeds → getEffectiveRoles)', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService(seededReadback())
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        // `declareMstarSeeds` reads back first (merge-preserve), then
        // declares; the advisory's own readback comes strictly after the
        // declare — the boot dual-inject-child race window is closed.
        expect(fake.calls).toEqual(['getEffectiveRoles', 'declareSeeds', 'getEffectiveRoles'])
        // The re-declare carried the full mstar batch (idempotent convergence).
        expect(fake.declareCalls).toHaveLength(1)
        expect(fake.declareCalls[0]!.map((d) => d.id).sort()).toEqual([...MIRROR_ROLES].sort())
        expect(captured.filter(([level]) => level === 'warn')).toEqual([])
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s6) declare-outcome skips/conflicts merge into ONE warn (upstream persona-source code + revert entry)', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService(seededReadback(), {
        applied: ['architect', 'fullstack-dev'],
        skipped: [{ id: 'scout', reason: 'invalid-id' }],
        conflicts: [{ id: 'fullstack-dev', kind: 'persona-source' }],
      })
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('invalid-id')
        expect(warns[0]![1]).toContain('scout')
        expect(warns[0]![1]).toContain('persona-source')
        expect(warns[0]![1]).toContain('fullstack-dev')
        // Conflicts mean an operator override was retained — revert entry.
        expect(warns[0]![1]).toContain('fallbacks/revert-seed')
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s7) an overridden-EMPTY mstar row → overridden warn (with revert entry) AND empty-persona warn, one warn each', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService({
        roles: [
          effRow('architect', 'Architect default.', true, false, 'Architect default.'),
          effRow('fullstack-dev', 'Dev default.', true, false, 'Dev default.'),
          effRow('scout', '', true, true, 'Scout default.'),
        ],
      })
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(2)
        expect(warns.some(([, message]) => message.includes('overrides the seed persona') && message.includes('fallbacks/revert-seed'))).toBe(true)
        expect(warns.some(([, message]) => message.includes('empty persona'))).toBe(true)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s8) a REJECTING re-declare is contained: the pass returns true, ONE degraded warn, never throws', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService(seededReadback())
      fake.declareSeeds = async () => { throw new Error('settings write failed') }
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('aborted (degraded')
        expect(warns[0]![1]).toContain('settings write failed')
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s9) a throwing effective readback is contained: pass returns true, never throws (probe semantics)', async () => {
    const mirror = await fixtureMirror()
    try {
      const fake = new FakeAdvisoryService(seededReadback())
      const realGet = fake.getEffectiveRoles.bind(fake)
      fake.getEffectiveRoles = () => {
        realGet() // keep the call-order log honest
        throw new Error('settings unavailable')
      }
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        // The seed-declare readback AND the advisory readback both degrade —
        // contained, no crash, no taxonomy guess.
        expect(captured.some(([, message]) => message.includes('effective-state readback failed'))).toBe(true)
        expect(captured.filter(([level]) => level === 'warn').length).toBeGreaterThanOrEqual(1)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })

  it('(s10) multi-role local skips → exactly ONE warn (the consolidated declaration line); per-id skip diagnostics stay on debug (≤1 warn per category)', async () => {
    // architect + scout mirror defaults carry the `{{...}}` interpolation
    // hazard → both skip locally at extraction with per-id diagnostics;
    // fullstack-dev stays clean and is the only id reaching the declare.
    const mirror = await fixtureMirrorWithHazards(['architect', 'scout'])
    try {
      const fake = new FakeAdvisoryService(seededReadback())
      const ctx = ctxWithService(fake, rowConfig([]))
      const { captured, restore } = captureLogs()
      try {
        expect(await runFallbacksAdvisory(ctx, mirror.dir)).toBe(true)
        // Declaration/skip category: ONE consolidated warn — the per-id
        // diagnostics must NOT surface as extra warns (plan global
        // constraint: ≤1 warn per category).
        const warns = captured.filter(([level]) => level === 'warn')
        expect(warns).toHaveLength(1)
        expect(warns[0]![1]).toContain('seed declaration')
        expect(warns[0]![1]).toContain('skipped locally')
        expect(warns[0]![1]).toContain('architect (no-persona)')
        expect(warns[0]![1]).toContain('scout (no-persona)')
        // Per-id skip diagnostics survive on the advisory DEBUG channel.
        const perIdDebugs = captured.filter(([, message]) => message.includes('harness-agents default skipped for role'))
        expect(perIdDebugs).toHaveLength(2)
        expect(perIdDebugs.some(([, message]) => message.includes("role 'architect'"))).toBe(true)
        expect(perIdDebugs.some(([, message]) => message.includes("role 'scout'"))).toBe(true)
      } finally {
        restore()
      }
    } finally {
      await mirror.cleanup()
    }
  })
})
