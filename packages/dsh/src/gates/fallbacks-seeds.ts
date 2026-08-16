/**
 * Zero-config seed declaration for the OPTIONAL `dsh-llm-fallbacks` plugin
 * (plan `20260816-dsh-b4-seeds` Task 2): when the `llm-fallbacks` service is
 * applied, this module declares the 13 `mode: subagent` mstar roles into the
 * fallbacks seed registry — persona = mirror `description` (verbatim, the
 * SSOT stays `mstar-roles`) + one mandatory-load guide line.
 *
 * Batch assembly (per-apply, re-runnable):
 *
 * 1. `getEffectiveRoles()` readback → the currently-seeded NON-mstar ids are
 *    merge-preserved (`{ id: row.id.trim(), persona: row.seedPersona }` —
 *    seedPersona, NOT the row persona, so an operator override stays flagged
 *    `personaOverridden` upstream). Upstream `declare` REPLACES the whole
 *    registry, so without preservation a mstar-only batch would strip
 *    preset/companion ids of their seeded annotations (rows remain — R2).
 * 2. `subagentRoleIds()` × `personaFor()` resolve the mstar personas from
 *    the `harness-agents/` mirror (the decoration's existing lookup surface;
 *    `mode: primary` shells like `project-manager` are excluded).
 * 3. Interpolation gate (HARD): any persona carrying the dsh system-prompt
 *    STRICT `{{...}}` hazard is skipped + warned BEFORE `declareSeeds` —
 *    never declared, never throws (aligned with `agent-personas.ts`
 *    extraction semantics; a mirror default is already rejected at
 *    extraction, so the gate's live path is the UNFILTERED readback data
 *    of a preserved row).
 *
 * The upstream `SeedDeclareOutcome` is passed through verbatim; the
 * structured `SeedOutcomeView` is this module's own view (the service is a
 * structural parameter — fake-testable, no runtime value import; the type
 * imports are type-only, mirroring `fallbacks-probe.ts` — the bundle keeps
 * ZERO runtime references to `dsh-llm-fallbacks`).
 *
 * Failure semantics: a throwing readback is contained (skip + one warn —
 * probe semantics); a rejecting `declareSeeds` PROPAGATES to the caller —
 * the entry wiring attaches a terminal `.catch` (the upstream preset
 * self-declare pattern), so declare never throws out of `apply`.
 *
 * Module boundary: no barrel — the entry imports this module by explicit
 * relative path; the entry does not re-export it.
 */
import type { EffectiveRolesReadback, SeedDeclaration, SeedDeclareOutcome } from 'dsh-llm-fallbacks'
import { PERSONA_INTERPOLATION_HAZARD } from './_shared.ts'
import { personaFor, subagentRoleIds, type PersonaWarnSink } from './agent-personas.ts'

/** Logger label for the mstar seeds declaration (dsh logger naming: `<scope>/<subject>`). */
export const SEEDS_LOGGER = 'mstar/fallbacks-seeds'

/** Seed-declaration log levels the module sink understands. */
export type SeedsLogLevel = 'debug' | 'warn' | 'error'

/** Per-call log sink — the entry binds it to `ctx.logger(SEEDS_LOGGER)`; tests pass a capture sink. */
export type SeedsLogSink = (level: SeedsLogLevel, message: string) => void

/**
 * The consumed service surface — a structural subset of the upstream
 * `FallbacksService` (the two seed methods the declaration flow uses).
 * Fake-testable: tests pass a spy object; the real service is assignable
 * (structural typing anchors the contract against the installed `.d.ts`).
 */
export interface SeedsServiceView {
  /** (a) Declare the companion's FULL current seed set (replacement semantics). */
  declareSeeds(seeds: readonly SeedDeclaration[]): Promise<SeedDeclareOutcome>
  /** (b) Sync readback — effective taxonomy with seed annotations. */
  getEffectiveRoles(): EffectiveRolesReadback
}

/** Options for {@link declareMstarSeeds}. */
export interface DeclareMstarSeedsOptions {
  /** The `harness-agents/` mirror root; absent → no mstar personas (preserved-only batch). */
  agentsDir: string | undefined
  /** The module log sink (entry binds `ctx.logger(SEEDS_LOGGER)`). */
  log: SeedsLogSink
}

/** One locally-skipped id with its gate reason (never reached `declareSeeds`). */
export interface SeedSkipView {
  id: string
  reason: 'interpolation' | 'no-persona'
}

/** One merge-preserved seeded non-mstar id (batch persona = upstream `seedPersona`). */
export interface PreservedSeedView {
  id: string
  persona: string
}

/** Structured result of one {@link declareMstarSeeds} call — this module's own view. */
export interface SeedOutcomeView {
  /** The full declaration batch handed to `declareSeeds` (mstar personas + preserved ids). */
  declared: SeedDeclaration[]
  /** Locally skipped ids (interpolation gate / no usable default) — never declared. */
  skipped: SeedSkipView[]
  /** The seeded non-mstar ids preserved from the readback into the batch. */
  preserved: PreservedSeedView[]
  /** The upstream `SeedDeclareOutcome` — passed through verbatim. */
  outcome: SeedDeclareOutcome
}

/** The empty upstream outcome used for contained-failure views (readback threw). */
const EMPTY_OUTCOME: SeedDeclareOutcome = { applied: [], skipped: [], conflicts: [] }

/** Best-effort human-readable message from an arbitrary thrown value (agent-flow `errorMessage` pattern). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The mandatory-load guide line the brief fixes (one line, host-neutral, role-id templated). */
function mstarLoadLine(roleId: string): string {
  return `Load mstar-roles (references/${roleId}.md) and the role's Required Skill Dependencies before acting.`
}

/**
 * Declare the mstar subagent seeds: readback → merge-preserve seeded
 * non-mstar ids → resolve mirror personas → interpolation gate → declare.
 * Idempotent by construction (the same inputs produce the same batch; the
 * upstream manager's no-delta check skips the settings write).
 *
 * @param service - the structural seed surface (real service or test fake).
 * @param options - mirror root + log sink.
 * @returns the structured outcome view; rejects only when `declareSeeds`
 *   itself rejects (the wiring attaches the terminal catch).
 */
export async function declareMstarSeeds(
  service: SeedsServiceView,
  options: DeclareMstarSeedsOptions,
): Promise<SeedOutcomeView> {
  const { agentsDir, log } = options
  // 1. Readback — probe semantics: a throwing readback degrades to skip +
  //    one warn (never throws out of the decision point).
  let readback: EffectiveRolesReadback
  try {
    readback = service.getEffectiveRoles()
  } catch (error) {
    log('warn', `fallbacks seed readback failed — mstar seeds not declared: ${errorMessage(error)}`)
    return { declared: [], skipped: [], preserved: [], outcome: EMPTY_OUTCOME }
  }
  // 2. The mstar role-id set is mirror-derived (never hardcoded); an absent
  //    or shell-less mirror contributes no mstar personas.
  const mstarIds = agentsDir === undefined ? [] : subagentRoleIds(agentsDir)
  const mstarSet = new Set(mstarIds)
  // 3. Merge-preserve: currently-seeded non-mstar ids keep their seeded
  //    annotations through the replacement declare. `seedPersona` (not the
  //    row persona) — an operator override stays flagged `personaOverridden`.
  const preservedCandidates: PreservedSeedView[] = []
  for (const row of readback.roles) {
    if (!row.seeded) continue
    const id = row.id.trim()
    if (id === '' || mstarSet.has(id)) continue
    if (row.seedPersona === undefined || row.seedPersona.trim() === '') {
      log('debug', `seeded row '${id}' carries no seedPersona (upstream contract: present iff seeded) — not preserved`)
      continue
    }
    preservedCandidates.push({ id, persona: row.seedPersona })
  }
  // 4. Mstar personas — the decoration's existing lookup; extraction-time
  //    hazard warns are forwarded to the module log (aligned semantics).
  const declared: SeedDeclaration[] = []
  const skipped: SeedSkipView[] = []
  const forwardWarn: PersonaWarnSink = (message) => log('warn', message)
  for (const roleId of mstarIds) {
    const persona = personaFor(roleId, { agentsDir }, forwardWarn)
    if (persona === undefined) {
      skipped.push({ id: roleId, reason: 'no-persona' })
      continue
    }
    if (PERSONA_INTERPOLATION_HAZARD.test(persona.text)) {
      log('warn', `seed persona for mstar role '${roleId}' contains a "{{" paired with a later "}}" (dsh system-prompt strict interpolation renders persona text and throws on unknown or malformed references) — skipped`)
      skipped.push({ id: roleId, reason: 'interpolation' })
      continue
    }
    declared.push({ id: roleId, persona: `${persona.text}\n\n${mstarLoadLine(roleId)}` })
  }
  // 5. Preserved personas pass the SAME interpolation gate — the readback is
  //    unfiltered external data, so this is the gate's live path.
  const preserved: PreservedSeedView[] = []
  for (const entry of preservedCandidates) {
    if (PERSONA_INTERPOLATION_HAZARD.test(entry.persona)) {
      log('warn', `preserved seed persona for '${entry.id}' contains a "{{" paired with a later "}}" (dsh system-prompt strict interpolation renders persona text and throws on unknown or malformed references) — skipped`)
      skipped.push({ id: entry.id, reason: 'interpolation' })
      continue
    }
    declared.push({ id: entry.id, persona: entry.persona })
    preserved.push(entry)
  }
  // 6. Declare (replacement semantics upstream). A rejection propagates —
  //    the entry wiring's terminal `.catch` absorbs it (never out of apply).
  //    Empty-batch guard (plan QC fix wave S-empty): upstream declare is
  //    REPLACEMENT semantics — its no-delta check compares against the
  //    PREVIOUS batch, so an empty batch differs and COMMITS an empty
  //    registry, stripping any annotations a concurrent declarer (the preset
  //    child) committed in the readback→commit window. With nothing to
  //    declare, skip the upstream call entirely: the registry is untouched.
  if (declared.length === 0) {
    log('debug', 'no mstar or preserved seeds to declare — empty batch skipped (registry untouched)')
    return { declared, skipped, preserved, outcome: EMPTY_OUTCOME }
  }
  const outcome = await service.declareSeeds(declared)
  log('debug', `mstar seeds declared: ${declared.length} ids (${mstarIds.length} mstar + ${preserved.length} preserved); ${skipped.length} skipped locally`)
  return { declared, skipped, preserved, outcome }
}
