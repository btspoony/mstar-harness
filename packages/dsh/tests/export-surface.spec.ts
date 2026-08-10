/**
 * Export-surface snapshot for `src/index.ts` — the frozen baseline for the
 * `src/index.ts → src/gates/*` split (plan `20260810-dsh-entry-split`,
 * Task 1; BASE `76bbad4`).
 *
 * The entry's public export surface is part of the plugin's contract:
 * consumers import `apply`, `Config`, `DshHostAdapter`, the `lint*` veto
 * entries, the advisory types and the cordis `Context` augmentation from
 * `@mstar-harness/dsh`. During the pure-refactor split (Tasks 2–4) that
 * surface must stay IDENTICAL (导出集恒等), so this test freezes it:
 *
 * - runtime layer (enforced by `bun test`): the exact set of VALUE exports
 *   (`Object.keys` of the module namespace) — catches any value-export
 *   drift (removal, rename, or accidental addition);
 * - type layer (enforced wherever the tests are typechecked): the exact
 *   full export namespace (`keyof typeof entry` vs the frozen 28-name
 *   union — value + type-only names) plus the cordis `Context` / `Events`
 *   augmentation probes.
 *
 * Frozen at BASE `76bbad4` (pre-split). Do not edit the lists below without
 * an explicit export-surface change review — the split is moves-only.
 */
import { describe, expect, it } from 'bun:test'
import type { Context, Events } from 'cordis'
import * as entry from '../src/index.ts'
import type * as EntryTypes from '../src/index.ts'

/** The frozen VALUE exports (runtime-visible; `Config` is also an interface). */
const FROZEN_VALUE_EXPORTS = [
  'Config',
  'DshHostAdapter',
  'DshMstar',
  'HarnessResolver',
  'SeamVetoError',
  'SkillLintVetoError',
  'apply',
  'inject',
  'lintAuditWrite',
  'lintCompoundWrite',
  'lintDesignMdWrite',
  'lintRolesWrite',
  'lintSeamWrite',
  'lintSkillDoc',
  'lintSkillWrite',
  'name',
  'skillLocalConfig',
] as const

/** The frozen TYPE-ONLY exports (erased at runtime — pinned for typecheck). */
const FROZEN_TYPE_ONLY_EXPORTS = [
  'DispatchGateAdvisory',
  'DshHostAdapterOptions',
  'DshMstarOptions',
  'MstarEngineStatusSource',
  'MstarHarnessState',
  'MstarIterationGateView',
  'SeamId',
  'SeamLintAdvisory',
  'SkillLintAdvisory',
  'StatusGateAdvisory',
] as const

/** The frozen FULL export namespace (values + type-only names; `Config` once). */
type FrozenExportNames =
  | 'Config'
  | 'DshHostAdapter'
  | 'DshHostAdapterOptions'
  | 'DshMstar'
  | 'DshMstarOptions'
  | 'DispatchGateAdvisory'
  | 'HarnessResolver'
  | 'MstarEngineStatusSource'
  | 'MstarHarnessState'
  | 'MstarIterationGateView'
  | 'SeamId'
  | 'SeamLintAdvisory'
  | 'SeamVetoError'
  | 'SkillLintAdvisory'
  | 'SkillLintVetoError'
  | 'StatusGateAdvisory'
  | 'apply'
  | 'inject'
  | 'lintAuditWrite'
  | 'lintCompoundWrite'
  | 'lintDesignMdWrite'
  | 'lintRolesWrite'
  | 'lintSeamWrite'
  | 'lintSkillDoc'
  | 'lintSkillWrite'
  | 'name'
  | 'skillLocalConfig'

type Assert<T extends true> = T

/**
 * Exact export-namespace identity: mutual assignability between
 * `keyof typeof entry` (all value + type exports) and the frozen union.
 * Fails typecheck on ANY export drift — removal, rename, or addition.
 */
type _ExactExportNamespace = Assert<
  [keyof typeof entry] extends [FrozenExportNames]
    ? ([FrozenExportNames] extends [keyof typeof entry] ? true : false)
    : false
>

/** Cordis augmentation probes — fail typecheck if the augmentation is removed/renamed. */
type _CordisCtxAugment = Context['dshHostAdapter']
type _CordisEventDispatchGate = Events['mstar/dispatch-gate']
type _CordisEventStatusGate = Events['mstar/status-gate']
type _CordisEventSkillLint = Events['mstar/skill-lint']
type _CordisEventSeamLint = Events['mstar/seam-lint']

describe('src/index.ts export surface (frozen — plan 20260810-dsh-entry-split T1)', () => {
  it('value exports: exact set unchanged', () => {
    expect(Object.keys(entry).sort()).toEqual([...FROZEN_VALUE_EXPORTS].sort())
  })

  it('type-only exports: exact set unchanged (typecheck-guarded probes)', () => {
    // Runtime cannot see type-only exports; each `EntryTypes.X` reference
    // fails typecheck if the export disappears. The probe object pins the
    // frozen list as documentation and in the test output.
    const typeProbe = {
      DispatchGateAdvisory: null as unknown as EntryTypes.DispatchGateAdvisory,
      DshHostAdapterOptions: null as unknown as EntryTypes.DshHostAdapterOptions,
      DshMstarOptions: null as unknown as EntryTypes.DshMstarOptions,
      MstarEngineStatusSource: null as unknown as EntryTypes.MstarEngineStatusSource,
      MstarHarnessState: null as unknown as EntryTypes.MstarHarnessState,
      MstarIterationGateView: null as unknown as EntryTypes.MstarIterationGateView,
      SeamId: null as unknown as EntryTypes.SeamId,
      SeamLintAdvisory: null as unknown as EntryTypes.SeamLintAdvisory,
      SkillLintAdvisory: null as unknown as EntryTypes.SkillLintAdvisory,
      StatusGateAdvisory: null as unknown as EntryTypes.StatusGateAdvisory,
    }
    expect(Object.keys(typeProbe).sort()).toEqual([...FROZEN_TYPE_ONLY_EXPORTS].sort())
  })

  it('plugin manifest contract: name/inject/apply are the Loader entry points', () => {
    expect(entry.name).toBe('dsh')
    expect(Array.isArray(entry.inject)).toBe(true)
    expect(typeof entry.apply).toBe('function')
  })
})
