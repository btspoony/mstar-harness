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
 * - type layer (enforced by `typecheck:tests` — `bunx tsc --noEmit -p
 *   tests/tsconfig.json`): the exact VALUE export namespace (`keyof typeof
 *   entry` vs the frozen 17-name value union — type-only names never appear
 *   on the module namespace object, so a `keyof` union cannot carry them),
 *   the 10 type-only names pinned individually (`EntryTypes.X` probes — each
 *   reference fails typecheck if the export disappears), plus the cordis
 *   `Context` / `Events` augmentation probes.
 *
 * Frozen at BASE `76bbad4` (pre-split). Do not edit the lists below without
 * an explicit export-surface change review — the split is moves-only.
 *
 * Extended for plan `20260810-agent-flow-catalog-graph` (Task 1): the
 * agent-flow ledger's public API (`recordDispatch` / `recordSettle` /
 * `readAgentFlow` + `AGENT_FLOW_FILE` / `AGENT_FLOW_MAX_EVENTS` /
 * `SETTLE_SEAM`) and its event/view types joined the entry surface — a
 * deliberate, reviewed addition (new module), not a split drift.
 */
import { describe, expect, it } from 'bun:test'
import type { Context, Events } from '@deepseek-ai/cordis'
import * as entry from '../src/index.ts'
import type * as EntryTypes from '../src/index.ts'

/** The frozen VALUE exports (runtime-visible; `Config` is also an interface). */
const FROZEN_VALUE_EXPORTS = [
  'AGENT_FLOW_FILE',
  'AGENT_FLOW_MAX_EVENTS',
  'Config',
  'DECORATION_LOGGER',
  'DshHostAdapter',
  'DshMstar',
  'HarnessResolver',
  'PERSONA_SECTION_NAME',
  'PERSONA_SECTION_ORDER',
  'SETTLE_SEAM',
  'SeamVetoError',
  'SkillLintVetoError',
  'apply',
  'decorateSubagentStart',
  'inject',
  'lintAuditWrite',
  'lintCompoundWrite',
  'lintDesignMdWrite',
  'lintRolesWrite',
  'lintSeamWrite',
  'lintSkillDoc',
  'lintSkillWrite',
  'name',
  'readAgentFlow',
  'recordDispatch',
  'recordSettle',
  'setDecorationLogger',
  'skillLocalConfig',
] as const

/** The frozen TYPE-ONLY exports (erased at runtime — pinned for typecheck). */
const FROZEN_TYPE_ONLY_EXPORTS = [
  'AgentFlowEvent',
  'AgentFlowEventView',
  'AgentFlowSummaryRow',
  'AgentFlowView',
  'DecorationLogLevel',
  'DecorationLogSink',
  'DispatchGateAdvisory',
  'DispatchVerdict',
  'DshHostAdapterOptions',
  'DshMstarOptions',
  'MstarEngineStatusSource',
  'MstarHarnessState',
  'MstarIterationGateView',
  'SeamId',
  'SeamLintAdvisory',
  'SettleOutcome',
  'SkillLintAdvisory',
  'StatusGateAdvisory',
  'SubagentRunInfoView',
] as const

type Assert<T extends true> = T

/**
 * Exact VALUE export-namespace identity: `keyof typeof entry` exposes only the
 * runtime-visible (value) exports — type-only exports never appear on the
 * module namespace object, so they cannot join a `keyof` union. The exact-set
 * check therefore runs against the frozen VALUE names (17, `Config` once),
 * and the 10 type-only names are pinned individually by the `EntryTypes.X`
 * probes below (each reference fails typecheck if the export disappears).
 * Fails typecheck on ANY value-export drift — removal, rename, or addition.
 */
type FrozenValueExportNames = typeof FROZEN_VALUE_EXPORTS[number]

type _ExactValueExportNamespace = Assert<
  [keyof typeof entry] extends [FrozenValueExportNames]
    ? ([FrozenValueExportNames] extends [keyof typeof entry] ? true : false)
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
      AgentFlowEvent: null as unknown as EntryTypes.AgentFlowEvent,
      AgentFlowEventView: null as unknown as EntryTypes.AgentFlowEventView,
      AgentFlowSummaryRow: null as unknown as EntryTypes.AgentFlowSummaryRow,
      AgentFlowView: null as unknown as EntryTypes.AgentFlowView,
      DecorationLogLevel: null as unknown as EntryTypes.DecorationLogLevel,
      DecorationLogSink: null as unknown as EntryTypes.DecorationLogSink,
      DispatchGateAdvisory: null as unknown as EntryTypes.DispatchGateAdvisory,
      DispatchVerdict: null as unknown as EntryTypes.DispatchVerdict,
      DshHostAdapterOptions: null as unknown as EntryTypes.DshHostAdapterOptions,
      DshMstarOptions: null as unknown as EntryTypes.DshMstarOptions,
      MstarEngineStatusSource: null as unknown as EntryTypes.MstarEngineStatusSource,
      MstarHarnessState: null as unknown as EntryTypes.MstarHarnessState,
      MstarIterationGateView: null as unknown as EntryTypes.MstarIterationGateView,
      SeamId: null as unknown as EntryTypes.SeamId,
      SeamLintAdvisory: null as unknown as EntryTypes.SeamLintAdvisory,
      SettleOutcome: null as unknown as EntryTypes.SettleOutcome,
      SkillLintAdvisory: null as unknown as EntryTypes.SkillLintAdvisory,
      StatusGateAdvisory: null as unknown as EntryTypes.StatusGateAdvisory,
      SubagentRunInfoView: null as unknown as EntryTypes.SubagentRunInfoView,
    }
    expect(Object.keys(typeProbe).sort()).toEqual([...FROZEN_TYPE_ONLY_EXPORTS].sort())
  })

  it('plugin manifest contract: name/inject/apply are the Loader entry points', () => {
    expect(entry.name).toBe('dsh')
    expect(Array.isArray(entry.inject)).toBe(true)
    expect(typeof entry.apply).toBe('function')
  })
})
