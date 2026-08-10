/**
 * Render tests for the Morning Star workflow-viz panel page (Task 2 + Task 3):
 * the `conversation.view` view tab that renders the `mstar-engine-status`
 * catalog source (spec `panel-contract.md` §2/§3/§4).
 *
 * Coverage:
 * - full fixture (iteration + state + freshness): every section renders —
 *   watermark line, iteration phase/transition/gate verdict + violation
 *   codes, plan status board, residual counts, branch/policy/lease anchors,
 *   knowledge digest, direction one-liner, last-updated marker;
 * - empty states: no catalog row (waiting), no harness, no gate — distinct
 *   hints, never a crash, never guessed values;
 * - partial source degradation: missing version/enforcement → `unknown`;
 *   null knowledge / empty lists → `none` without crashing;
 * - data wiring (Task 3, spec §5): the component reads the catalog row
 *   through `useMstarEngineStatus(useSession)` — the fixture source rides a
 *   stub conversation snapshot (`createSnapshotStore`), and a snapshot bump
 *   (new catalog row) re-renders the panel with fresh data + freshness;
 * - plugin entry: `apply(ctx)` registers the `mstar-panel` dictionaries and
 *   the `conversation.view` tab (`id: 'mstar-workflow'`, `order: 20`,
 *   locale-following label thunk);
 * - T3 flow column (spec agent-flow-catalog-graph §2.4): the expected/actual
 *   agent-flow pipeline — 6 flow-stage skeleton nodes + lit/count from
 *   dispatch evidence, the evidence-driven unexpected node, the event footer
 *   strip (role → planId#taskId rows, status coloring, settled markers,
 *   unexpected re-list), degraded/empty notes, legend flow-* items, zh labels,
 *   and garbage-proof totality.
 *
 * Renderer: `react-dom/server.renderToStaticMarkup` over the real component
 * (dev-time peer-stub seams; the `*.module.css` import resolves to the raw
 * file-path string under `bun test`, so class attributes are dropped —
 * assertions pin `data-mstar-*` attributes, never class names).
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSnapshotStore, SlotsService,
  type ClientContext, type ConversationNode, type ConversationSnapshot, type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import type { MstarEngineStatusSource } from '../src/types'
import type { AgentFlowEventView, AgentFlowView } from '../src/types'
import type { EnforcementSource } from '@mstar-harness/engine'
import { apply } from '../src/client/index'
import { en, NS, zh } from '../src/client/panel/locale'
import { PanelView } from '../src/client/panel/PanelView'

/** Full fixture: every field the panel renders (spec §2.1–§2.3). */
const fullSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.0.4',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: true, source: 'iteration compass' as EnforcementSource },
  iteration: {
    iterationId: 'iter-20260809-dsh-workflow-viz',
    statusPath: '/proj/.mstar/status.json',
    compassPath: '/proj/.mstar/iterations/iter-20260809-dsh-workflow-viz/delivery-compass.md',
    gate: {
      transition: 'phase-2-execute',
      all_plans_done: false,
      ok: true,
      entry: { ok: true, violations: [] },
      exit: { ok: true, violations: [] },
      violations: [
        { severity: 'medium', code: 'PLAN-3', message: 'plan 20260809-dsh-workflow-viz-panel not complete' },
        { severity: 'low', code: 'EXIT-1', message: 'minor wording drift in the compass' },
      ],
    },
  },
  state: {
    plans: [
      { id: '20260809-dsh-workflow-viz-panel', status: 'InProgress' },
      { id: '20260808-dsh-package-core', status: 'Done' },
    ],
    residuals: [
      { severity: 'high', count: 2 },
      { severity: 'medium', count: 1 },
    ],
    iterationBaseBranch: 'dev-dsh',
    targetBranch: 'dev-dsh',
    specIntegrationBranch: 'iteration/iter-20260809-dsh-workflow-viz',
    pushPolicy: 'push authorized',
    worktreeMode: 'feature-worktree',
    controlWorktreePath: '/Users/bibi/workspace/ai/mstar-workflow',
    leases: [
      {
        planId: '20260809-dsh-workflow-viz-panel',
        holder: 'dsh-web-mstar-workflow',
        worktreePath: '/Users/bibi/workspace/ai/mstar-workflow/.worktrees/mstar-workflow-workflow-viz',
      },
    ],
    knowledge: {
      docCount: 3,
      categories: ['architecture-patterns', 'conventions', 'tooling-decisions'],
    },
    direction: 'dsh is highly customizable (client plugins + slot registry)',
    agentFlow: null,
  },
}

/** `state` null + harnessDir null + no iteration ⇒ no-harness state (spec §3). */
const noHarnessSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.0.4',
  harnessDir: null,
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: null,
}

/** Harness present but no iteration key ⇒ no-gate state; state renders normally (spec §3). */
const noGateSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.0.4',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: {
    plans: [{ id: '20260809-dsh-workflow-viz-panel', status: 'InProgress' }],
    residuals: [],
    iterationBaseBranch: null,
    targetBranch: null,
    specIntegrationBranch: null,
    pushPolicy: null,
    worktreeMode: null,
    controlWorktreePath: null,
    leases: [],
    knowledge: null,
    direction: null,
    agentFlow: null,
  },
}

/**
 * Gate verdict FAIL (spec §2.2): `ok: false` on the gate + a failed exit
 * sub-phase with violations ⇒ `data-gate-verdict="FAIL"` and the `FAIL (n)`
 * count branch of `phaseVerdict` — neither is exercised by the ok:true
 * fixture (QC2-003).
 */
const failGateSource: MstarEngineStatusSource = {
  ...fullSource,
  iteration: {
    ...fullSource.iteration!,
    gate: {
      ...fullSource.iteration!.gate,
      ok: false,
      exit: {
        ok: false,
        violations: [
          { severity: 'high', code: 'EXIT-3', message: 'exit gate not satisfied' },
          { severity: 'low', code: 'EXIT-4', message: 'compass wording drift' },
        ],
      },
    },
  },
}

/** Runtime-shape degradation: version/enforcement missing ⇒ `unknown` (spec §2.4). */
const degradedSource = {
  ...fullSource,
  version: undefined,
  enforcement: undefined,
} as unknown as MstarEngineStatusSource

/** Session-standard kit the view ring hands every conversation.view entry (stub faces; unused by the pure render). */
function kitProps(overrides?: Partial<ConvViewProps>): ConvViewProps {
  return {
    sessionId: 's-1' as SessionId,
    useSession: (() => null) as never,
    useProjection: (() => null) as never,
    useSessions: (() => null) as never,
    useWorkspaces: (() => null) as never,
    ...overrides,
  }
}

/**
 * Plain selector binding over the stub snapshot store — the dev-time twin of
 * the real uSES binding (web-react `bindSnapshotSelector`): selection applies
 * to the store's current snapshot; a `store.set` bump is picked up on the next
 * render, mirroring the snapshot-bump refresh semantics (spec §5).
 */
function bindUseSession(store: { getSnapshot(): ConversationSnapshot }): SnapshotSelectorHook<ConversationSnapshot> {
  return function useSelector<S>(sel: (s: ConversationSnapshot) => S): S {
    return sel(store.getSnapshot())
  }
}

/** Build a conversation snapshot carrying the fixture source as the newest catalog row (spec §5 data path). */
function snapshotFor(source: MstarEngineStatusSource | null, lastUpdated: number | null): ConversationSnapshot {
  const nodes: ConversationNode[] = [
    { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
  ]
  if (source !== null) {
    nodes.push({
      kind: 'context',
      seq: 2,
      time: lastUpdated ?? 1_720_001_000_000,
      content: [],
      source,
      form: 'catalog',
    })
  }
  return {
    sessionId: 's-1' as SessionId,
    nodes,
    running: false,
    openState: 'open',
    composerPhase: 'active',
    blank: false,
  }
}

/** Render the panel to static HTML through the real data path: snapshot store → useSession → hook → PanelView (default copy pinned to en). */
function panelHtml(
  source: MstarEngineStatusSource | null,
  locale: LocaleService = new LocaleService(),
  lastUpdated: number | null = 1_720_001_000_000,
  lang: 'en' | 'zh' = 'en',
): string {
  locale.register(NS, { zh, en })
  locale.setLocale(lang)
  const store = createSnapshotStore(snapshotFor(source, lastUpdated))
  return renderToStaticMarkup(createElement(PanelView, {
    ...kitProps({ useSession: bindUseSession(store) }),
    t: locale.bind(NS),
  }))
}

describe('workflow panel — full fixture renders every section (spec §2)', () => {
  const html = panelHtml(fullSource)

  it('renders the watermark line (version / harness dir / enforcement)', () => {
    expect(html).toContain('data-mstar-watermark')
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
    expect(html).toContain('enforcement: hard (iteration compass)')
  })

  it('renders the graph region with the iteration gate folded into the graph + footer (T2)', () => {
    // Iteration/gate detail moved into the main-area graph (spec §1.1/§2.3/§2.6):
    // transition → current-phase highlight; ok → PASS badge; violations → footer list.
    expect(html).toContain('data-graph-canvas')
    expect(html).toContain('data-graph-node="phase:autonomous-execute"')
    expect(html).toContain('data-graph-node-state="current"')
    expect(html).toContain('data-graph-verdict="pass"')
    expect(html).toContain('data-graph-violations="2"')
    expect(html).toContain('data-mstar-gate-summary')
    expect(html).toContain('data-graph-violations-count="2"')
    expect(html).toContain('data-violation-code="PLAN-3"')
    expect(html).toContain('data-violation-code="EXIT-1"')
    expect(html).toContain('plan 20260809-dsh-workflow-viz-panel not complete')
  })

  it('renders the state section: plans board, residuals, branches, policy, leases, knowledge, direction', () => {
    expect(html).toContain('data-mstar-section="state"')
    // Plan status board: id(status) rows.
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
    expect(html).toContain('data-plan-id="20260808-dsh-package-core"')
    expect(html).toContain('data-plan-status="Done"')
    // Residual counts by severity.
    expect(html).toContain('data-residual-severity="high"')
    expect(html).toContain('data-residual-severity="medium"')
    expect(html).toContain('data-residual-count="2"')
    expect(html).toContain('data-residual-count="1"')
    // Branch anchors.
    expect(html).toContain('data-field="iteration-base-branch"')
    expect(html).toContain('iteration/iter-20260809-dsh-workflow-viz')
    // Policy anchors.
    expect(html).toContain('data-field="push-policy"')
    expect(html).toContain('push authorized')
    expect(html).toContain('data-field="worktree-mode"')
    expect(html).toContain('feature-worktree')
    // Lease anchors.
    expect(html).toContain('data-lease-plan="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('dsh-web-mstar-workflow')
    // Knowledge digest.
    expect(html).toContain('data-knowledge-docs="3"')
    expect(html).toContain('architecture-patterns')
    expect(html).toContain('tooling-decisions')
    // Direction one-liner.
    expect(html).toContain('data-direction')
    expect(html).toContain('dsh is highly customizable (client plugins + slot registry)')
  })

  it('renders the freshness marker (last-updated + refresh note)', () => {
    expect(html).toContain('data-mstar-freshness')
    expect(html).toMatch(/last updated\s+\S+/)
    expect(html).toContain('refreshes with catalog re-emission')
  })
})

describe('workflow panel — empty states and degradation (spec §3, §2.4)', () => {
  it('no catalog row (source null) → waiting hint, no crash', () => {
    const html = panelHtml(null)
    expect(html).toContain('data-mstar-panel="waiting"')
    expect(html).toContain('Waiting for the first engine-status catalog')
  })

  it('no harness (harnessDir null + state null + no iteration) → no-harness hint + watermark none', () => {
    const html = panelHtml(noHarnessSource)
    expect(html).toContain('data-mstar-panel="no-harness"')
    expect(html).toContain('No Morning Star harness detected')
    expect(html).toContain('harness: none')
  })

  it('no gate (harness present, iteration key absent) → graph renders schema skeleton + no-compass note, state still renders', () => {
    const html = panelHtml(noGateSource)
    expect(html).toContain('data-mstar-panel="panel"')
    expect(html).toContain('data-graph-canvas')
    expect(html).toContain('data-graph-empty="no-compass"')
    expect(html).toContain('No steering compass / status.json')
    expect(html).toContain('data-mstar-section="state"')
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    // Empty state lists degrade to "none" rather than crashing.
    expect(html).toContain('data-mstar-empty="no-residuals"')
    expect(html).toContain('data-mstar-empty="no-leases"')
    expect(html).toContain('data-mstar-empty="no-knowledge"')
  })

  it('iteration: null (schema-drift variant of "absent") → same no-compass degradation, never a crash (AC-3)', () => {
    const html = panelHtml({
      ...noGateSource,
      iteration: null,
    } as unknown as MstarEngineStatusSource)
    expect(html).toContain('data-mstar-panel="panel"')
    expect(html).toContain('data-graph-canvas')
    expect(html).toContain('data-graph-empty="no-compass"')
    expect(html).toContain('No steering compass / status.json')
    expect(html).toContain('data-mstar-section="state"')
  })

  it('missing version / enforcement degrade to unknown, no guessed values', () => {
    const html = panelHtml(degradedSource)
    expect(html).toContain('mstar unknown')
    expect(html).toContain('enforcement: unknown')
  })

  it('partial state (null direction, empty lists) renders without crashing', () => {
    const html = panelHtml({
      ...fullSource,
      state: {
        ...fullSource.state!,
        direction: null,
        leases: [],
        knowledge: null,
      },
    })
    expect(html).toContain('data-mstar-section="state"')
    expect(html).toContain('data-direction')
    expect(html).toContain('data-mstar-empty="no-leases"')
    expect(html).toContain('data-mstar-empty="no-knowledge"')
  })
})

describe('workflow panel — FAIL gate verdict and zh body (spec §2.2, §4.3)', () => {
  it('gate.ok false → FAIL badge on the current node + FAIL (n) in the gate summary', () => {
    const html = panelHtml(failGateSource)
    expect(html).toContain('data-graph-verdict="fail"')
    expect(html).toContain('FAIL (2)')
    // The violation list still renders in FAIL mode (gate-level violations unchanged).
    expect(html).toContain('data-violation-code="PLAN-3"')
    expect(html).toContain('data-violation-code="EXIT-1"')
  })

  it('renders the panel body in zh when the locale flips (not just the tab label)', () => {
    const html = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(html).toContain('data-graph-canvas')
    expect(html).toContain('自主执行')
    expect(html).toContain('违规 (2)')
    expect(html).toContain('data-mstar-section="state"')
    expect(html).toContain('工作区状态')
    expect(html).toContain('3 篇文档')
    expect(html).toContain('最后更新')
    // en graph labels must not leak into the zh body.
    expect(html).not.toContain('Autonomous Execute')
    expect(html).not.toContain('Workspace state')
  })
})

describe('workflow panel — data wiring through the hook (spec §5)', () => {
  /** Render the panel against a live snapshot store (real PanelView + useMstarEngineStatus path). */
  function renderAgainst(store: { getSnapshot(): ConversationSnapshot }, locale: LocaleService): string {
    return renderToStaticMarkup(createElement(PanelView, {
      ...kitProps({ useSession: bindUseSession(store) }),
      t: locale.bind(NS),
    }))
  }

  it('renders the LATEST catalog row when the snapshot carries several (spec §2.4)', () => {
    const store = createSnapshotStore<ConversationSnapshot>({
      sessionId: 's-1' as SessionId,
      nodes: [
        { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
        { kind: 'context', seq: 2, time: 1_720_000_000_000, content: [], source: { ...fullSource, version: '2.0.3' }, form: 'catalog' },
        { kind: 'context', seq: 4, time: 1_720_001_000_000, content: [], source: fullSource, form: 'catalog' },
      ],
      running: false,
      openState: 'open',
      composerPhase: 'active',
      blank: false,
    })
    const locale = new LocaleService()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const html = renderAgainst(store, locale)
    expect(html).toContain('mstar 2.0.4')
    expect(html).not.toContain('mstar 2.0.3')
  })

  it('a new catalog row (snapshot bump = refresh signal) re-renders the panel with fresh data', () => {
    const locale = new LocaleService()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const store = createSnapshotStore(snapshotFor(fullSource, 1_720_000_000_000))

    const before = renderAgainst(store, locale)
    expect(before).toContain('mstar 2.0.4')
    expect(before).toContain('harness: /proj/.mstar')
    expect(before).toContain('data-mstar-freshness')

    // Server re-emission appends a newer row → snapshot bump → hook re-scans → re-render.
    const refreshed = { ...fullSource, version: '2.0.5', harnessDir: '/proj2/.mstar' }
    store.set(snapshotFor(refreshed, 1_720_002_000_000))
    const after = renderAgainst(store, locale)
    expect(after).toContain('mstar 2.0.5')
    expect(after).toContain('harness: /proj2/.mstar')
    expect(after).not.toContain('harness: /proj/.mstar')
    expect(after).toContain('data-mstar-freshness')
  })
})

describe('workflow panel — plugin entry registers locale + conversation.view tab (spec §4)', () => {
  /** Minimal cordis context over the stub services (slots + locale + sessions faces). */
  function makeCtx(): { ctx: ClientContext; slots: SlotsService; locale: LocaleService } {
    const slots = new SlotsService()
    const locale = new LocaleService()
    const ctx = {
      effect: (fn: () => unknown) => { fn() },
      slots,
      locale,
      sessions: {},
    } as unknown as ClientContext
    return { ctx, slots, locale }
  }

  /** Declare the view-ring chain exactly like ui-conversation apply (spec §3.2). */
  function declareViewRing(slots: SlotsService): () => void {
    slots.register({
      name: 'root' as 'conversation.view',
      children: { 'conversation.session': { kind: 'single', scope: 'session' } } as never,
    }, () => null)
    return slots.register({
      name: 'conversation.session' as 'conversation.view',
      children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    }, () => null)
  }

  it('registers the mstar-panel dictionaries on apply', () => {
    const { ctx, locale } = makeCtx()
    apply(ctx)
    expect(locale.bind(NS)('view.mstar-workflow')).toBe('MStar 工作流')
  })

  it('registers the conversation.view tab (id mstar-workflow, order 20, label follows locale)', () => {
    const { ctx, slots, locale } = makeCtx()
    apply(ctx)
    // Not declared yet: the inject callback must wait.
    expect(slots.entries('conversation.view')).toHaveLength(0)

    const disposeDeclarer = declareViewRing(slots)
    const entries = slots.entries('conversation.view')
    expect(entries).toHaveLength(1)
    const tab = entries[0]!
    expect(tab.options.id).toBe('mstar-workflow')
    expect(tab.options.order).toBe(20)
    expect(resolveSlotLabel(tab.options.label)).toBe('MStar 工作流')

    // Label thunk re-reads per projection: locale switch flips the tab.
    locale.setLocale('en')
    expect(resolveSlotLabel(tab.options.label)).toBe('MStar Workflow')

    disposeDeclarer()
  })
})

describe('workflow panel — T1 layout: header / sidebar / main grid (spec panel-layout-graph §1)', () => {
  const html = panelHtml(fullSource)

  it('header renders version / harness dir / enforcement as three evenly-spread cells', () => {
    expect(html).toContain('data-mstar-header')
    const cells = [...html.matchAll(/data-mstar-header-cell="([^"]+)"/g)].map((m) => m[1]!)
    expect(cells).toEqual(['version', 'harness', 'enforcement'])
    // Caption label (uppercased via CSS) + value per cell.
    expect(html).toContain('>version<')
    expect(html).toContain('>harness<')
    expect(html).toContain('>enforcement<')
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
    expect(html).toContain('enforcement: hard (iteration compass)')
  })

  it('root + header CSS pin the hard grid metrics (even spread, 300px sidebar, <860px stack, ramp spacing, zero bare hex)', () => {
    const cssText = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    expect(cssText).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
    expect(cssText).toContain('grid-template-columns: minmax(0, 1fr) 300px')
    expect(cssText).toMatch(/grid-template-areas:\s*'header header'\s*'main\s+sidebar'/)
    expect(cssText).toMatch(/@media \(max-width: 860px\)/)
    // Spacing ramp tokens defined at the panel root (spec §1.2).
    expect(cssText).toMatch(/--mstar-space-[1-6]:\s*\d+px/)
    // Theming is dsw-token driven only — no bare hex (dark mode = token value flip).
    expect(cssText).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('sidebar renders the plans / residuals / knowledge / leases status areas', () => {
    expect(html).toContain('data-mstar-sidebar')
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-residual-severity="high"')
    expect(html).toContain('data-knowledge-docs="3"')
    expect(html).toContain('data-lease-plan="20260809-dsh-workflow-viz-panel"')
    // The state digest content lives INSIDE the sidebar region (data-plan-id also
    // appears earlier in the graph node plan rows, so order is pinned against the
    // sidebar's own state section marker).
    expect(html.indexOf('data-mstar-sidebar')).toBeLessThan(html.indexOf('data-mstar-section="state"'))
  })

  it('main area renders the react-flow graph canvas inside the graph region (T2 fills the graph)', () => {
    expect(html).toContain('data-mstar-graph')
    expect(html).toContain('data-graph-canvas')
    expect(html).toContain('data-graph-nodes-draggable="false"')
  })
})

describe('workflow panel — T1 panel rename: "MStar 工作流" / "MStar Workflow" (spec panel-layout-graph §1.1)', () => {
  it('view.mstar-workflow label flips with the locale', () => {
    const locale = new LocaleService()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    expect(locale.bind(NS)('view.mstar-workflow')).toBe('MStar Workflow')
    locale.setLocale('zh')
    expect(locale.bind(NS)('view.mstar-workflow')).toBe('MStar 工作流')
  })

  it('zh body renders localized header captions and the graph phase labels', () => {
    const zhHtml = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(zhHtml).toContain('版本')
    expect(zhHtml).toContain('harness 目录')
    expect(zhHtml).toContain('执行策略')
    expect(zhHtml).toContain('自主执行')
    expect(zhHtml).toContain('迭代收口')
  })
})

describe('workflow panel — T2 graph: react-flow loop canvas (spec panel-layout-graph §2/§4)', () => {
  const html = panelHtml(fullSource)

  it('mounts the GraphCanvas in the main graph region, read-only interaction (nodesDraggable=false)', () => {
    expect(html).toContain('data-mstar-graph')
    expect(html).toContain('data-graph-canvas')
    expect(html).toContain('data-graph-nodes-draggable="false"')
  })

  it('renders all 5 phase-ring nodes with current highlighted, next marked, PASS badge on current', () => {
    for (const id of ['iteration-start', 'autonomous-execute', 'iteration-close', 'pr-delivery', 'merge-ready']) {
      expect(html).toContain(`data-graph-node="phase:${id}"`)
    }
    expect(html).toContain('data-graph-node-state="current"')
    expect(html).toContain('data-graph-node-state="next"')
    // Phase 1/5 schema-only nodes stay unlit (idle) — engine never emits those transitions (spec §2.3).
    expect(html).toContain('data-graph-node-state="idle"')
    expect(html).toContain('data-graph-verdict="pass"')
    expect(html).toContain('data-graph-violations="2"')
    expect(html).toContain('Autonomous Execute')
    expect(html).toContain('Iteration Close')
  })

  it('renders the plan state machine buckets with lit markers, counts and plan rows', () => {
    expect(html).toContain('data-graph-node="state:InProgress"')
    expect(html).toContain('data-graph-node="state:Done"')
    expect(html).toContain('data-graph-lit="true"')
    expect(html).toContain('data-graph-count="1"')
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
  })

  it('renders the legend + gate summary footer with the collapsible violations list', () => {
    expect(html).toContain('data-mstar-legend')
    expect(html).toContain('data-mstar-graph-footer')
    expect(html).toContain('data-mstar-gate-summary')
    expect(html).toContain('data-graph-violations-count="2"')
    expect(html).toContain('data-violation-code="PLAN-3"')
    expect(html).toContain('data-violation-code="EXIT-1"')
  })

  it('the connector edge links the current phase to the active plan bucket', () => {
    // InProgress is the only lit non-Done/Blocked bucket in the panel fixture → connector target.
    // (The marker uses '→' — React HTML-escapes '>' inside attribute values.)
    expect(html).toContain('data-graph-connector="phase:autonomous-execute→state:InProgress"')
  })

  it('no-harness branch does NOT mount the canvas (mount gated on the empty-state branch, T1 minor-1)', () => {
    const g = panelHtml(noHarnessSource)
    expect(g).toContain('data-mstar-panel="no-harness"')
    expect(g).toContain('data-mstar-graph')
    expect(g).not.toContain('data-graph-canvas')
  })

  it('no iteration → schema ring + no-compass note, state machine still renders, no verdict badge', () => {
    const g = panelHtml(noGateSource)
    expect(g).toContain('data-graph-canvas')
    expect(g).toContain('data-graph-empty="no-compass"')
    expect(g).toContain('data-graph-node="state:InProgress"')
    expect(g).not.toContain('data-graph-verdict="pass"')
  })

  it('state null → machine skeleton + no-state note; graph still mounts (spec §2.5)', () => {
    const g = panelHtml({ ...fullSource, state: null })
    expect(g).toContain('data-graph-canvas')
    expect(g).toContain('data-graph-empty="no-state"')
  })

  it('plans missing → machine skeleton + no-plans note (spec §2.5)', () => {
    const g = panelHtml({
      ...fullSource,
      state: { ...fullSource.state!, plans: undefined },
    } as unknown as MstarEngineStatusSource)
    expect(g).toContain('data-graph-canvas')
    expect(g).toContain('data-graph-empty="no-plans"')
  })

  it('renders the iteration id as the phase-ring caption (T2 minor-1, spec §2.6)', () => {
    expect(html).toContain('data-graph-iteration-id="iter-20260809-dsh-workflow-viz"')
    // The locale label + the id render inside the same caption element (zh body too).
    const zhHtml = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(zhHtml).toContain('data-graph-iteration-id="iter-20260809-dsh-workflow-viz"')
  })

  it('legend includes the idle (unlit) swatch, en + zh (T2 minor-2, spec §4)', () => {
    expect(html).toContain('data-mstar-legend-item="idle"')
    expect(html).toContain('unlit (schema)')
    const zhHtml = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(zhHtml).toContain('data-mstar-legend-item="idle"')
    expect(zhHtml).toContain('未点亮（schema）')
  })
})

describe('workflow panel — T3 data projection integration (spec panel-layout-graph §2.1/§2.5)', () => {
  const html = panelHtml(fullSource)

  /** Render the panel against a live snapshot store (same helper shape as the data-wiring block). */
  function renderStore(store: { getSnapshot(): ConversationSnapshot }, lang: 'en' | 'zh' = 'en'): string {
    const locale = new LocaleService()
    locale.register(NS, { zh, en })
    locale.setLocale(lang)
    return renderToStaticMarkup(createElement(PanelView, {
      ...kitProps({ useSession: bindUseSession(store) }),
      t: locale.bind(NS),
    }))
  }

  /** The `data-graph-node-state` value of one node div, from static HTML. */
  function nodeState(h: string, nodeId: string): string | null {
    const start = h.indexOf(`data-graph-node="${nodeId}"`)
    if (start === -1) return null
    const end = h.indexOf('data-graph-node="', start + 1)
    const slice = end === -1 ? h.slice(start) : h.slice(start, end)
    const m = slice.match(/data-graph-node-state="([^"]+)"/)
    return m === null ? null : m[1]!
  }

  it('graph, header and sidebar all render from the SAME catalog row (single source of truth)', () => {
    // Header watermark = source.version / harnessDir / enforcement.
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
    // Sidebar plan board rows = state.plans verbatim.
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
    // Graph InProgress bucket lit with the same plan row + count.
    expect(html).toContain('data-graph-node="state:InProgress"')
    expect(html).toContain('data-graph-lit="true"')
    expect(html).toContain('data-graph-count="1"')
    expect(html).toContain('data-plan-status="InProgress"')
    // Current-phase highlight follows iteration.gate.transition; the connector
    // picks the same active bucket the sidebar board shows.
    expect(html).toContain('data-graph-node="phase:autonomous-execute"')
    expect(html).toContain('data-graph-node-state="current"')
    expect(html).toContain('data-graph-connector="phase:autonomous-execute→state:InProgress"')
  })

  it('a new catalog row with a new transition re-lights the ring (current + next move)', () => {
    const phase2 = {
      ...fullSource,
      iteration: { ...fullSource.iteration!, gate: { ...fullSource.iteration!.gate, transition: 'phase-2-execute' } },
    } as unknown as MstarEngineStatusSource
    const store = createSnapshotStore(snapshotFor(phase2, 1_720_000_000_000))
    const before = renderStore(store)
    expect(nodeState(before, 'phase:autonomous-execute')).toBe('current')
    expect(nodeState(before, 'phase:iteration-close')).toBe('next')
    expect(nodeState(before, 'phase:iteration-start')).toBe('idle')

    // Snapshot bump: server re-emission with phase-3-close → highlight moves.
    const phase3 = {
      ...fullSource,
      iteration: { ...fullSource.iteration!, gate: { ...fullSource.iteration!.gate, transition: 'phase-3-close' } },
    } as unknown as MstarEngineStatusSource
    store.set(snapshotFor(phase3, 1_720_002_000_000))
    const after = renderStore(store)
    expect(nodeState(after, 'phase:iteration-close')).toBe('current')
    expect(nodeState(after, 'phase:pr-delivery')).toBe('next')
    expect(nodeState(after, 'phase:autonomous-execute')).toBe('idle')
    // The connector edge follows the new current phase.
    expect(after).toContain('data-graph-connector="phase:iteration-close→state:InProgress"')
  })

  it('a new catalog row with changed plans re-buckets the machine + moves the connector', () => {
    const beforeSource = {
      ...fullSource,
      state: { ...fullSource.state!, plans: [{ id: 'plan-b', status: 'InProgress' }] },
    }
    const store = createSnapshotStore(snapshotFor(beforeSource, 1_720_000_000_000))
    const before = renderStore(store)
    expect(before).toContain('data-graph-count="1"')
    expect(before).toContain('data-graph-connector="phase:autonomous-execute→state:InProgress"')

    const afterSource = {
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: 'plan-b', status: 'InProgress' },
          { id: 'plan-c', status: 'InReview' },
          { id: 'plan-d', status: 'InReview' },
        ],
      },
    }
    store.set(snapshotFor(afterSource, 1_720_002_000_000))
    const after = renderStore(store)
    // InReview bucket lit with 2 plans; connector moves to the most-populated bucket.
    expect(after).toContain('data-graph-node="state:InReview"')
    expect(after).toContain('data-graph-lit="true"')
    expect(after).toContain('data-graph-count="2"')
    expect(after).toContain('data-plan-id="plan-c"')
    expect(after).toContain('data-graph-connector="phase:autonomous-execute→state:InReview"')
  })

  it('new violations on a fresh row update the footer count + list', () => {
    const clean = {
      ...fullSource,
      iteration: { ...fullSource.iteration!, gate: { ...fullSource.iteration!.gate, violations: [] } },
    }
    const store = createSnapshotStore(snapshotFor(clean, 1_720_000_000_000))
    const before = renderStore(store)
    expect(before).toContain('data-graph-violations-count="0"')
    expect(before).toContain('no violations')

    const failing = {
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: {
          ...fullSource.iteration!.gate,
          violations: [{ severity: 'high', code: 'EXIT-9', message: 'new violation row' }],
        },
      },
    } as unknown as MstarEngineStatusSource
    store.set(snapshotFor(failing, 1_720_002_000_000))
    const after = renderStore(store)
    expect(after).toContain('data-graph-violations-count="1"')
    expect(after).toContain('data-violation-code="EXIT-9"')
  })

  it('missing / garbage fields degrade the WHOLE panel (header + graph + sidebar) without crashing', () => {
    const noIteration = panelHtml({ ...fullSource, iteration: undefined } as unknown as MstarEngineStatusSource)
    expect(noIteration).toContain('data-mstar-header')
    expect(noIteration).toContain('data-graph-canvas')
    expect(noIteration).toContain('data-graph-empty="no-compass"')
    expect(noIteration).toContain('data-mstar-sidebar')
    expect(noIteration).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')

    const garbageIteration = panelHtml({ ...fullSource, iteration: 'not-an-object' } as unknown as MstarEngineStatusSource)
    expect(garbageIteration).toContain('data-mstar-header')
    expect(garbageIteration).toContain('data-graph-canvas')
    expect(garbageIteration).toContain('data-graph-empty="no-compass"')
    expect(garbageIteration).toContain('data-mstar-section="state"')
  })
})

/* ---------------------------------------------------------------------------
 * T3 flow column (spec agent-flow-catalog-graph §2.4): GraphCanvas renders the
 * expected/actual agent-flow pipeline — the 6 flow-stage skeleton nodes +
 * lit/count from dispatch evidence, the evidence-driven unexpected node, the
 * event footer strip (role → planId#taskId, status coloring, settled markers,
 * unexpected re-list), the degraded/empty notes, the legend flow-* items and
 * the zh labels. The projection itself is unit-tested in
 * client-graph-projection.spec.ts — these pin the RENDER layer through the
 * real data path (snapshot store → useSession → PanelView → GraphCanvas).
 * ------------------------------------------------------------------------- */

/** One dispatch row as the T1 ledger view emits it (spec §2.2). */
function flowDispatch(over: {
  ts: number
  role: string
  agent?: string
  planId?: string
  taskId?: string
  verdict?: 'ok' | 'advisory' | 'denied'
}): AgentFlowEventView {
  return {
    ts: over.ts,
    kind: 'dispatch',
    agent: over.agent ?? null,
    role: over.role,
    planId: over.planId ?? null,
    taskId: over.taskId ?? null,
    taskCategory: null,
    ...(over.verdict !== undefined ? { verdict: over.verdict } : {}),
  }
}

/** One settle row (spec §2.2 — settles carry no role). */
function flowSettle(over: {
  ts: number
  agent?: string
  outcome?: 'ok' | 'error' | 'denied'
  durationMs?: number
}): AgentFlowEventView {
  return {
    ts: over.ts,
    kind: 'settle',
    agent: over.agent ?? null,
    role: '',
    planId: null,
    taskId: null,
    taskCategory: null,
    ...(over.outcome !== undefined ? { outcome: over.outcome } : {}),
    ...(over.durationMs !== undefined ? { durationMs: over.durationMs } : {}),
  }
}

/** fullSource with `state.agentFlow` carrying the given events (latest-first). */
function flowSource(events: readonly AgentFlowEventView[]): MstarEngineStatusSource {
  return {
    ...fullSource,
    state: { ...fullSource.state!, agentFlow: { events, summary: [] } as AgentFlowView },
  }
}

/** A believable mixed event window (latest-first): paired settle → lit implement dispatch → unexpected scout. */
const flowEvents: AgentFlowEventView[] = [
  flowSettle({ ts: 1_720_000_004_000, agent: 'a1', outcome: 'ok', durationMs: 340 }),
  flowDispatch({ ts: 1_720_000_003_000, agent: 'a1', role: 'frontend-dev', planId: 'plan-1', taskId: 'T2', verdict: 'ok' }),
  flowDispatch({ ts: 1_720_000_001_000, agent: 'a2', role: 'scout', planId: 'plan-9', taskId: 'T1' }),
]

describe('workflow panel — T3 flow column: expected/actual agent-flow pipeline (spec agent-flow-catalog-graph §2.4)', () => {
  /** The opening-div slice of one flow node (avoids colliding with the state machine's lit/count attrs). */
  function flowNodeSlice(h: string, nodeId: string): string {
    const start = h.indexOf(`data-graph-node="flow:${nodeId}"`)
    if (start === -1) return ''
    const end = h.indexOf('data-graph-node="', start + 1)
    return end === -1 ? h.slice(start) : h.slice(start, end)
  }

  it('renders the 6 expected-stage skeleton nodes + degraded note when the ledger is UNREADABLE (agentFlow null)', () => {
    // The fixture simulates the server's degraded case (null agentFlow —
    // only an unreadable ledger yields null post-fix-wave qc1 F-001; a
    // MISSING ledger arrives as the empty view and renders the empty note
    // instead, pinned in the next test block).
    const html = panelHtml(fullSource) // fullSource.agentFlow === null → degraded
    for (const id of [
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:sdd-task-review',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
      'autonomous-execute:ops-on-demand',
    ]) {
      expect(html).toContain(`data-graph-node="flow:${id}"`)
    }
    // Schema skeleton only — nothing lit without evidence, and the unlit
    // marker lives on the flow node itself.
    expect(flowNodeSlice(html, 'autonomous-execute:sdd-implement')).toContain('data-graph-lit="false"')
    expect(flowNodeSlice(html, 'iteration-start:review-edit-chain')).toContain('data-graph-lit="false"')
    // Degraded note + empty event strip.
    expect(html).toContain('data-graph-empty="flow-degraded"')
    expect(html).toContain('No agent-flow evidence (ledger missing)')
    expect(html).toContain('data-graph-flow-count="0"')
    expect(html).toContain('Agent flow events')
    // No unexpected node without unexpected evidence.
    expect(html).not.toContain('data-graph-node="flow:unexpected"')
  })

  it('lights stages + count badges from dispatch evidence (exact stage mapping)', () => {
    const html = panelHtml(flowSource([
      flowDispatch({ ts: 3, role: 'fullstack-dev' }),
      flowDispatch({ ts: 2, role: 'fullstack-dev' }),
      flowDispatch({ ts: 1, role: 'product-manager' }),
    ]))
    const implement = flowNodeSlice(html, 'autonomous-execute:sdd-implement')
    expect(implement).toContain('data-graph-lit="true"')
    expect(implement).toContain('data-graph-count="2"')
    const review = flowNodeSlice(html, 'iteration-start:review-edit-chain')
    expect(review).toContain('data-graph-lit="true"')
    expect(review).toContain('data-graph-count="1"')
    // Unrelated stages stay unlit schema boxes.
    expect(flowNodeSlice(html, 'autonomous-execute:qc-tri')).toContain('data-graph-lit="false"')
    // Roles chips render from the schema vocab.
    expect(html).toContain('data-flow-role="frontend-dev"')
    expect(html).toContain('data-flow-role="generalPurpose"')
    expect(html).toContain('data-graph-flow-phase="autonomous-execute"')
  })

  it('renders the event footer strip: role → planId#taskId rows, status coloring, settled ✓, unexpected re-list', () => {
    const html = panelHtml(flowSource(flowEvents))
    expect(html).toContain('data-graph-flow-count="3"')
    expect(html).toContain('data-graph-flow-unexpected-count="1"')
    expect(html).toContain('data-mstar-flow-events')
    // Row attributes: kind / status / expected / settled.
    expect(html).toContain('data-graph-flow-event-kind="dispatch"')
    expect(html).toContain('data-graph-flow-event-kind="settle"')
    expect(html).toContain('data-graph-flow-event-status="dispatched"')
    expect(html).toContain('data-graph-flow-event-status="ok"')
    expect(html).toContain('data-graph-flow-event-expected="true"')
    expect(html).toContain('data-graph-flow-event-expected="false"')
    // The paired dispatch carries the settled ✓ marker.
    expect(html).toContain('data-graph-flow-event-settled="true"')
    // Row cells: role → planId#taskId, status labels, settle duration.
    expect(html).toContain('frontend-dev')
    expect(html).toContain('plan-1#T2')
    expect(html).toContain('dispatched')
    expect(html).toContain('settled ok')
    expect(html).toContain('340ms')
    // Unexpected events are re-listed in their own warn section.
    expect(html).toContain('data-mstar-flow-unexpected')
    expect(html).toContain('Unexpected roles')
    expect(html).toContain('scout')
    // The unexpected node + warn-edge source render on evidence.
    expect(html).toContain('data-graph-node="flow:unexpected"')
    expect(flowNodeSlice(html, 'unexpected')).toContain('data-graph-count="1"')
    // With evidence present, no degraded/empty note.
    expect(html).not.toContain('data-graph-empty="flow-degraded"')
    expect(html).not.toContain('data-graph-empty="flow-empty"')
  })

  it('mounts the unexpected node only on unexpected-role evidence (never a guessed warning)', () => {
    expect(panelHtml(flowSource(flowEvents))).toContain('data-graph-node="flow:unexpected"')
    const clean = panelHtml(flowSource([flowDispatch({ ts: 1, role: 'frontend-dev' })]))
    expect(clean).not.toContain('data-graph-node="flow:unexpected"')
    expect(clean).toContain('data-graph-node="flow:autonomous-execute:sdd-implement"')
  })

  it('renders hidden connection-point handles on every node type (ReactFlow v12 edge prerequisite — T3 fix loop)', () => {
    const html = panelHtml(flowSource(flowEvents))
    const slice = (prefix: string, nodeId: string) => {
      const start = html.indexOf(`data-graph-node="${prefix}:${nodeId}"`)
      if (start === -1) return ''
      const end = html.indexOf('data-graph-node="', start + 1)
      return end === -1 ? html.slice(start) : html.slice(start, end)
    }
    // Pipeline stages: target(top) + source(bottom) for the chain, and
    // source(right) as the unexpected warn edge origin (buildEdges binds by
    // these ids — an edge whose endpoint exposes no handle is dropped by
    // @xyflow/react, so this is the render-side prerequisite for edges).
    for (const id of [
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:sdd-task-review',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
      'autonomous-execute:ops-on-demand',
    ]) {
      const stage = slice('flow', id)
      expect(stage).toContain('data-handleid="target:top"')
      expect(stage).toContain('data-handleid="source:bottom"')
      expect(stage).toContain('data-handleid="source:right"')
    }
    // The unexpected warn node receives the edge on its left side.
    expect(slice('flow', 'unexpected')).toContain('data-handleid="target:left"')
    // Phase ring: vertical loop, bottom→top.
    expect(slice('phase', 'iteration-start')).toContain('data-handleid="target:top"')
    expect(slice('phase', 'iteration-start')).toContain('data-handleid="source:bottom"')
    expect(slice('phase', 'merge-ready')).toContain('data-handleid="source:bottom"')
    // State machine topology: vertical chain bottom→top + the side-by-side
    // Blocked branch right↔left; Done is terminal (target only); unknown is
    // sink-only — it accepts the connector edge inbound (target:top, when
    // unknown is the most-planned lit bucket) but exposes no source handles
    // (no outbound edges; T3-review M1).
    const inProgress = slice('state', 'InProgress')
    expect(inProgress).toContain('data-handleid="target:top"')
    expect(inProgress).toContain('data-handleid="source:bottom"')
    expect(inProgress).toContain('data-handleid="source:right"')
    expect(inProgress).toContain('data-handleid="target:right"')
    const blocked = slice('state', 'Blocked')
    expect(blocked).toContain('data-handleid="target:left"')
    expect(blocked).toContain('data-handleid="source:left"')
    const done = slice('state', 'Done')
    expect(done).toContain('data-handleid="target:top"')
    expect(done).not.toContain('data-handleid="source:bottom"')
    const unknown = slice('state', 'unknown')
    expect(unknown).toContain('data-handleid="target:top"')
    expect(unknown).not.toContain('data-handleid="source:')
  })

  it('empty ledger (0 events) → empty-state note, skeleton unlit, strip count 0', () => {
    const html = panelHtml(flowSource([]))
    expect(html).toContain('data-graph-empty="flow-empty"')
    expect(html).toContain('No actual dispatches yet (recording starts at agent-flow plan merge)')
    expect(html).toContain('data-graph-flow-count="0"')
    expect(flowNodeSlice(html, 'autonomous-execute:sdd-implement')).toContain('data-graph-lit="false"')
  })

  it('garbage agentFlow → degraded note, never a crash', () => {
    const html = panelHtml({
      ...fullSource,
      state: { ...fullSource.state!, agentFlow: 42 },
    } as unknown as MstarEngineStatusSource)
    expect(html).toContain('data-graph-canvas')
    expect(html).toContain('data-graph-empty="flow-degraded"')
    expect(html).toContain('data-graph-node="flow:autonomous-execute:sdd-implement"')
  })

  it('legend includes the flow-expected / flow-actual / flow-unexpected swatches, en + zh', () => {
    const html = panelHtml(fullSource)
    expect(html).toContain('data-mstar-legend-item="flow-expected"')
    expect(html).toContain('data-mstar-legend-item="flow-actual"')
    expect(html).toContain('data-mstar-legend-item="flow-unexpected"')
    expect(html).toContain('expected stage (hollow)')
    expect(html).toContain('actual dispatch (filled)')
    expect(html).toContain('unexpected role (outlined)')
    const zhHtml = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(zhHtml).toContain('data-mstar-legend-item="flow-expected"')
    expect(zhHtml).toContain('预期 stage（空心）')
    expect(zhHtml).toContain('实际派发（实心）')
    expect(zhHtml).toContain('未匹配角色（描边）')
  })

  it('zh locale localizes the flow strip labels + status colors', () => {
    const zhHtml = panelHtml(flowSource(flowEvents), undefined, undefined, 'zh')
    expect(zhHtml).toContain('Agent 流转事件')
    expect(zhHtml).toContain('已派发')
    expect(zhHtml).toContain('已结算')
    expect(zhHtml).toContain('未匹配角色')
    expect(zhHtml).toContain('3 条')
  })

  it('a new catalog row with fresh agentFlow events updates the strip (data path)', () => {
    const locale = new LocaleService()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const store = createSnapshotStore(snapshotFor(fullSource, 1_720_000_000_000))
    const renderStore = () => renderToStaticMarkup(createElement(PanelView, {
      ...kitProps({ useSession: bindUseSession(store) }),
      t: locale.bind(NS),
    }))
    expect(renderStore()).toContain('data-graph-flow-count="0"')
    expect(renderStore()).toContain('data-graph-empty="flow-degraded"')
    store.set(snapshotFor(flowSource(flowEvents), 1_720_000_004_000))
    const after = renderStore()
    expect(after).toContain('data-graph-flow-count="3"')
    expect(after).not.toContain('data-graph-empty="flow-degraded"')
    expect(after).toContain('data-graph-node="flow:unexpected"')
    expect(after).toContain('plan-1#T2')
  })
})
