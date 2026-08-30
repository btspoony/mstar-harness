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
 *   entry` vs the frozen 31-name value union — type-only names never appear
 *   on the module namespace object, so a `keyof` union cannot carry them),
 *   the 25 type-only names pinned individually (`EntryTypes.X` probes — each
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
 *
 * Extended for plan `20260815-dsh-workflow-gate` (Task 4): the durable
 * workflow/ralph gate verdict record (`recordWorkflowVerdict` + the
 * `workflow-verdict` vocabulary types) joined the entry surface — the
 * ledger plan's record path, matching the `recordDispatch` / `recordSettle`
 * precedent.
 */
import { describe, expect, it } from 'bun:test'
import type { Context, Events } from '@deepseek-ai/cordis'
import * as entry from '../src/index.ts'
import type * as EntryTypes from '../src/index.ts'

/** The frozen VALUE exports (runtime-visible; `Config` is also an interface). */
const FROZEN_VALUE_EXPORTS = [
  // Deliberate addition for plan `20260815-dsh-fallbacks-personas` Task 4:
  // the warn-only adoption advisory surface (logger label, the one-pass
  // entry, and the apply-bound sink setter — mirror of the role-persona
  // logger pattern).
  'ADVISORY_LOGGER',
  'AGENT_FLOW_FILE',
  'AGENT_FLOW_MAX_EVENTS',
  'Config',
  'DshHostAdapter',
  'DshMstar',
  'HarnessResolver',
  // Deliberate replacement for plan `20260831-dsh-alpha2-optional-fallbacks`
  // Task 3: the native persona-channel surface (logger label, the channel
  // registration, and the apply-bound sink/mirror setters) replaces the
  // removed `subagent/start` decoration exports (DECORATION_LOGGER,
  // PERSONA_SECTION_NAME, PERSONA_SECTION_ORDER, decorateSubagentStart,
  // setDecorationAgentsDir, setDecorationLogger).
  'ROLE_PERSONA_LOGGER',
  'SETTLE_SEAM',
  'SeamVetoError',
  'SkillLintVetoError',
  'apply',
  'registerRolePersonaChannel',
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
  // Deliberate addition for plan `20260815-dsh-workflow-gate` Task 4: the
  // durable workflow/ralph gate verdict record (one row per gated call —
  // the ledger plan's record path; the `workflow-verdict` kind).
  'recordWorkflowVerdict',
  'runFallbacksAdvisory',
  // Deliberate replacement for plan `20260831-dsh-alpha2-optional-fallbacks`
  // Task 3: the persona-defaults mirror-root binding and the channel log
  // sink (apply binds both; tests restore them) — `setRolePersonaAgentsDir`
  // + `setRolePersonaLogger` replace `setDecorationAgentsDir` +
  // `setDecorationLogger`.
  'setAdvisoryLogger',
  'setRolePersonaAgentsDir',
  'setRolePersonaLogger',
  'skillLocalConfig',
] as const

/** The frozen TYPE-ONLY exports (erased at runtime — pinned for typecheck). */
const FROZEN_TYPE_ONLY_EXPORTS = [
  'AdvisoryLogLevel',
  'AdvisoryLogSink',
  'AgentFlowEvent',
  'AgentFlowEventView',
  'AgentFlowSummaryRow',
  'AgentFlowView',
  // Deliberate replacement for plan `20260831-dsh-alpha2-optional-fallbacks`
  // Task 3: the native persona-channel vocabulary (log levels/sink + the
  // structural runtime/request views) replaces the removed decoration types
  // (DecorationLogLevel, DecorationLogSink, SubagentRunInfoView).
  'RolePersonaLogLevel',
  'RolePersonaLogSink',
  'SubagentStartRequestView',
  'SubagentsServiceView',
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
  // Deliberate additions for plan `20260815-dsh-workflow-gate` Task 4: the
  // `workflow-verdict` ledger vocabulary (verdict + mode + record input —
  // the adapter's public `recordWorkflowVerdict` method types).
  'WorkflowGateMode',
  'WorkflowVerdict',
  'WorkflowVerdictInput',
] as const

type Assert<T extends true> = T

/**
 * Exact VALUE export-namespace identity: `keyof typeof entry` exposes only the
 * runtime-visible (value) exports — type-only exports never appear on the
 * module namespace object, so they cannot join a `keyof` union. The exact-set
 * check therefore runs against the frozen VALUE names (31, `Config` once),
 * and the 25 type-only names are pinned individually by the `EntryTypes.X`
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
      AdvisoryLogLevel: null as unknown as EntryTypes.AdvisoryLogLevel,
      AdvisoryLogSink: null as unknown as EntryTypes.AdvisoryLogSink,
      AgentFlowEvent: null as unknown as EntryTypes.AgentFlowEvent,
      AgentFlowEventView: null as unknown as EntryTypes.AgentFlowEventView,
      AgentFlowSummaryRow: null as unknown as EntryTypes.AgentFlowSummaryRow,
      AgentFlowView: null as unknown as EntryTypes.AgentFlowView,
      RolePersonaLogLevel: null as unknown as EntryTypes.RolePersonaLogLevel,
      RolePersonaLogSink: null as unknown as EntryTypes.RolePersonaLogSink,
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
      SubagentStartRequestView: null as unknown as EntryTypes.SubagentStartRequestView,
      SubagentsServiceView: null as unknown as EntryTypes.SubagentsServiceView,
      WorkflowGateMode: null as unknown as EntryTypes.WorkflowGateMode,
      WorkflowVerdict: null as unknown as EntryTypes.WorkflowVerdict,
      WorkflowVerdictInput: null as unknown as EntryTypes.WorkflowVerdictInput,
    }
    expect(Object.keys(typeProbe).sort()).toEqual([...FROZEN_TYPE_ONLY_EXPORTS].sort())
  })

  it('plugin manifest contract: name/inject/apply are the Loader entry points', () => {
    expect(entry.name).toBe('dsh')
    expect(Array.isArray(entry.inject)).toBe(true)
    expect(typeof entry.apply).toBe('function')
  })
})
