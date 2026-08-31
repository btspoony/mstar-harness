/**
 * Task 4 — preset/mstar seeds coexistence (plan `20260816-dsh-b4-seeds`):
 * the upstream `dsh-llm-fallbacks` package (0.1.6+) self-declares its 7
 * bundled omp-style preset roles at ITS OWN apply. Under upstream
 * REPLACEMENT semantics (`declare` builds a new registry per batch — the
 * last declarer owns it; a non-preserved id keeps its config row but loses
 * its seeded annotation — R2), the preset batch and the mstar batch compete.
 * The mstar declaration (Task 2) merge-preserves the currently-seeded
 * non-mstar ids from the readback, and the advisory decision point (Task 3)
 * awaits an idempotent re-declare before its effective-state read — so BOTH
 * boot orders converge to the same 20-id fully-seeded registry.
 *
 * The fake below models the installed upstream semantics faithfully
 * (`FallbacksSeedManager`, dist 0.1.7): the seed registry is replaced
 * wholesale per declare, while the deployment taxonomy rows persist across
 * declares (`materialize` rewrites registry ids' row personas to the seed
 * personas and appends registry ids missing as rows — never deletes rows).
 *
 * The 13 mstar role ids are mirror-derived (`subagentRoleIds`) — never
 * hardcoded; the 7 preset ids are a constant (the brief's sanctioned
 * fake/constant form — a value cannot be type-imported), anchored at
 * runtime against the installed upstream `presetRoles` value so a future
 * preset-id change fails this suite instead of silently drifting.
 */
import { describe, expect, it, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { presetRoles } from 'dsh-llm-fallbacks'
import type { EffectiveRolesReadback, FallbacksService, SeedDeclaration, SeedDeclareOutcome } from 'dsh-llm-fallbacks'
import { FakeLoaderRegistry } from './harness.ts'
import { FALLBACKS_ENTRY_NAME, type LoaderEntryView } from '../src/gates/fallbacks-probe.ts'
import {
  declareMstarSeeds,
  type DeclareMstarSeedsOptions,
  type SeedOutcomeView,
  type SeedsLogLevel,
  type SeedsLogSink,
  type SeedsServiceView,
} from '../src/gates/fallbacks-seeds.ts'
import { subagentRoleIds } from '../src/gates/agent-personas.ts'
import { runFallbacksAdvisory, setAdvisoryLogger, type AdvisoryLogLevel } from '../src/gates/fallbacks-advisory.ts'
import { packageRoot } from '../scripts/bundle-harness-assets.ts'

/** The packaged mirror the real-contract tests anchor on (synced by bundle-assets). */
const REAL_MIRROR = join(packageRoot, 'harness-agents')

/**
 * The 7 bundled omp-style preset role ids (upstream `presetRoles` — a
 * package-root VALUE export since 0.1.6; `dist/presets.d.ts`). Constant form
 * per the brief; anchored at runtime against the installed value below
 * (drift gate — a future preset-id change fails the suite, not production).
 */
const PRESET_ROLE_IDS = ['designer', 'librarian', 'reviewer', 'scout', 'security-reviewer', 'sonic', 'task'] as const

/** One structured log record captured from the module sink. */
type LogRecord = [SeedsLogLevel, string]

/** Capture the module's per-call log sink (the brief's `{ agentsDir, log }` shape). */
function captureLog(): { records: LogRecord[]; sink: SeedsLogSink } {
  const records: LogRecord[] = []
  return { records, sink: (level, message) => { records.push([level, message]) } }
}

/** Run the seeds module under test with a capture sink. */
async function runSeeds(
  service: SeedsServiceView,
  agentsDir: string | undefined,
): Promise<{ view: SeedOutcomeView; records: LogRecord[] }> {
  const { records, sink } = captureLog()
  const view = await declareMstarSeeds(service, { agentsDir, log: sink } satisfies DeclareMstarSeedsOptions)
  return { view, records }
}

/**
 * A stateful seed-registry fake modeling the UPSTREAM semantics (installed
 * 0.1.7 `FallbacksSeedManager`): `declareSeeds` REPLACES the seed registry
 * with the new batch (new Map per batch), while the deployment taxonomy rows
 * PERSIST across declares — `materialize` rewrites registry ids' row personas
 * to the seed personas and appends registry ids missing as rows, never
 * deletes rows. `getEffectiveRoles` reads back the CURRENT rows with
 * seeded / seedPersona / personaOverridden derived from the CURRENT
 * registry — a row whose id left the registry stays present but unseeded.
 */
class SeedRegistryFake {
  declareCalls: SeedDeclaration[][] = []
  /** The seed-annotation registry — replaced wholesale per declare. */
  private registry = new Map<string, string>()
  /** The deployment taxonomy rows (id → persona) — persist across declares. */
  private taxonomy = new Map<string, string>()

  getEffectiveRoles(): EffectiveRolesReadback {
    return {
      roles: [...this.taxonomy.entries()].map(([id, persona]) => {
        const seedPersona = this.registry.get(id)
        const seeded = seedPersona !== undefined
        const row: EffectiveRolesReadback['roles'][number] = {
          id,
          persona,
          seeded,
          personaOverridden: seeded && persona !== seedPersona,
        }
        if (seeded) row.seedPersona = seedPersona
        return row
      }),
    }
  }

  async declareSeeds(seeds: readonly SeedDeclaration[]): Promise<SeedDeclareOutcome> {
    this.declareCalls.push([...seeds])
    const registry = new Map(seeds.map((s) => [s.id, s.persona]))
    // Materialize (upstream): registry ids present as rows are rewritten to
    // their seed personas; ids missing as rows are appended.
    for (const [id] of this.taxonomy) {
      const persona = registry.get(id)
      if (persona !== undefined) this.taxonomy.set(id, persona)
    }
    for (const [id, persona] of registry) {
      if (!this.taxonomy.has(id)) this.taxonomy.set(id, persona)
    }
    this.registry = registry
    return { applied: [...registry.keys()], skipped: [], conflicts: [] }
  }

  /** The current effective rows (the fake's readback model). */
  effectiveRows(): EffectiveRolesReadback['roles'] {
    return this.getEffectiveRoles().roles
  }

  /** The row-config legacy detector — the tests keep the config clean. */
  detectLegacyKeys(): string[] {
    return []
  }
}

/** A live, enabled fallbacks loader entry carrying the given row config. */
function liveEntry(rowConfig?: unknown): LoaderEntryView {
  return { options: { name: FALLBACKS_ENTRY_NAME, config: rowConfig }, disabled: false, fiber: {} }
}

/** A structurally well-formed fallbacks row config (the advisory reads it via the loader entry). */
function rowConfig(list: unknown[]): Record<string, unknown> {
  return {
    enabled: true,
    triggerCodes: ['429'],
    rootChain: ['gpt-4o'],
    roles: { list, rules: [] },
    cooldownMs: 60000,
  }
}

/** A mounted context with a loader row carrying `cfg` AND a provided fake service (seeds-aware path). */
function ctxWithService(service: SeedRegistryFake, cfg: Record<string, unknown>): Context {
  const ctx = new Context()
  const loader = new FakeLoaderRegistry(ctx)
  loader.entriesList = [liveEntry(cfg)]
  ctx.provide('llm-fallbacks', service as unknown as FallbacksService)
  return ctx
}

/** Capture advisory logs through the module sink (role-persona test pattern). */
function captureAdvisoryLogs(): { captured: Array<[AdvisoryLogLevel, string]>; restore: () => void } {
  const captured: Array<[AdvisoryLogLevel, string]> = []
  const prior = setAdvisoryLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setAdvisoryLogger(prior) }
}

/** The upstream preset declarations the fake seeds with (personas are placeholders — only the ids matter). */
function presetBatch(): SeedDeclaration[] {
  return PRESET_ROLE_IDS.map((id) => ({ id, persona: `Preset persona for ${id}` }))
}

describe('preset/mstar seeds coexistence — both boot orders converge to 20 seeded ids (plan 20260816-dsh-b4-seeds Task 4)', () => {
  it('the PRESET_ROLE_IDS constant matches the installed upstream presetRoles ids (drift anchor — 7 ids)', () => {
    const upstream = presetRoles.map((r) => r.id).sort()
    expect(upstream).toHaveLength(7)
    expect(upstream).toEqual([...PRESET_ROLE_IDS].sort())
  })

  test.skipIf(!existsSync(REAL_MIRROR))('id sets are disjoint: the 7 preset ids and the mirror-derived 13 mstar subagent ids never collide', () => {
    // The 13 mstar ids are MIRROR-DERIVED (never hardcoded — brief).
    const mstarIds = subagentRoleIds(REAL_MIRROR)
    expect(mstarIds).toHaveLength(13)
    expect(mstarIds).not.toContain('project-manager')
    const presetIds = [...PRESET_ROLE_IDS]
    expect(presetIds).toHaveLength(7)
    // No intersection: no preset id is a mstar role id (and vice versa).
    const mstarSet = new Set(mstarIds)
    expect(presetIds.filter((id) => mstarSet.has(id))).toEqual([])
    // The union is exactly 20 — a collision would shrink it.
    expect(new Set([...presetIds, ...mstarIds]).size).toBe(20)
  })

  test.skipIf(!existsSync(REAL_MIRROR))('(a) presets declare first, mstar second: merge-preserve carries the 7 preset ids → 20 ids, all seeded, no duplicate rows', async () => {
    const registry = new SeedRegistryFake()
    // Upstream preset self-declare at its own apply (replacement semantics).
    await registry.declareSeeds(presetBatch())
    expect(registry.effectiveRows()).toHaveLength(7)

    // The mstar declaration runs second — its readback sees the 7 preset ids
    // seeded and merge-preserves them into the batch.
    const { view, records } = await runSeeds(registry, REAL_MIRROR)
    expect(view.preserved.map((p) => p.id).sort()).toEqual([...PRESET_ROLE_IDS].sort())
    // The declaration batch is exactly 13 mstar + 7 preserved = 20, no duplicates.
    const declaredIds = view.declared.map((d) => d.id)
    expect(declaredIds).toHaveLength(20)
    expect(new Set(declaredIds).size).toBe(20)
    expect(new Set(declaredIds)).toEqual(new Set([...PRESET_ROLE_IDS, ...subagentRoleIds(REAL_MIRROR)]))
    expect(records.filter(([level]) => level === 'warn')).toEqual([])

    // Final effective state: 20 rows, every one seeded, no duplicate ids.
    const rows = registry.effectiveRows()
    expect(rows).toHaveLength(20)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
    expect(rows.every((r) => r.seeded)).toBe(true)
    // The preset ids keep their seeded annotations with their own personas.
    for (const id of PRESET_ROLE_IDS) {
      const row = rows.find((r) => r.id === id)
      expect(row).toBeDefined()
      expect(row!.seedPersona).toBe(`Preset persona for ${id}`)
      expect(row!.personaOverridden).toBe(false)
    }
  })

  test.skipIf(!existsSync(REAL_MIRROR))('(b) mstar first, presets second: mstar seeds lose annotation, ONE advisory re-declare converges back to 20 ids all seeded', async () => {
    const registry = new SeedRegistryFake()
    // mstar declares first (the entry inject child at fallbacks apply).
    await runSeeds(registry, REAL_MIRROR)
    expect(registry.effectiveRows()).toHaveLength(13)
    expect(registry.effectiveRows().every((r) => r.seeded)).toBe(true)

    // The upstream preset self-declare REPLACES the registry: only the 7
    // preset ids stay seeded; the 13 mstar ROWS REMAIN but are unseeded
    // (replacement semantics — R2: rows persist, annotations stripped).
    await registry.declareSeeds(presetBatch())
    const interim = registry.effectiveRows()
    expect(interim).toHaveLength(20)
    expect(new Set(interim.map((r) => r.id)).size).toBe(20)
    expect(interim.filter((r) => r.seeded).map((r) => r.id).sort()).toEqual([...PRESET_ROLE_IDS].sort())
    expect(interim.filter((r) => !r.seeded).map((r) => r.id).sort()).toEqual(subagentRoleIds(REAL_MIRROR))

    // ONE advisory decision-point pass: it awaits the idempotent re-declare
    // (merge-preserve carries the 7 preset ids back) then reads the effective
    // state — the registry converges to 20 ids, all seeded, no warns.
    const ctx = ctxWithService(registry, rowConfig([]))
    const { captured, restore } = captureAdvisoryLogs()
    try {
      expect(await runFallbacksAdvisory(ctx, REAL_MIRROR)).toBe(true)
    } finally {
      restore()
    }
    expect(captured.filter(([level]) => level === 'warn')).toEqual([])
    // The convergence debug names all 13 mstar ids (three-state: all seeded).
    const seededDebug = captured.find(([, message]) => message.includes('seeded at their defaults'))
    expect(seededDebug).toBeDefined()
    for (const id of subagentRoleIds(REAL_MIRROR)) expect(seededDebug![1]).toContain(id)

    // Final effective state: 20 rows, all seeded, no duplicate ids.
    const finalRows = registry.effectiveRows()
    expect(finalRows).toHaveLength(20)
    expect(new Set(finalRows.map((r) => r.id)).size).toBe(20)
    expect(finalRows.every((r) => r.seeded)).toBe(true)
    // The convergence was the advisory's re-declare: mstar(13) → presets(7) → 20.
    expect(registry.declareCalls).toHaveLength(3)
    expect(registry.declareCalls[2]!.map((d) => d.id)).toHaveLength(20)
    expect(new Set(registry.declareCalls[2]!.map((d) => d.id)).size).toBe(20)
  })
})
