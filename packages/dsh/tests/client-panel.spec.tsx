/**
 * Render tests for the Morning Star workflow-viz panel page (Task 2 + Task 3):
 * the `conversation.view` view tab that renders the `mstar-engine-status`
 * catalog source (spec `panel-contract.md` §2/§3/§4).
 *
 * Coverage:
 * - full fixture (iteration + state + freshness): every section renders —
 *   the sidebar meta dock (version/harness, header removed), the zone
 *   dashboard canvas (iteration/tasks/agents zones + fixed footer with
 *   legend/gate summary + corner event dock), plan status board,
 *   residual counts, branch/policy/lease anchors, knowledge digest,
 *   direction one-liner, last-updated marker;
 * - full-tab layout (spec panel-zones §2, v3): root fills the Tab without page
 *   scroll (`overflow: hidden`); the canvas zone container is the ONLY scroll
 *   body (own `overflow: auto`); the canvas footer bar is flex:none (fixed,
 *   never scrolls with the zones); the event dock is absolute bottom-left and
 *   hidden entirely at 0 events; sidebar is its own scroll container with a
 *   fixed bottom meta dock; zero bare hex/rgb in the panel + zones CSS;
 * - T4 theme audit (spec panel-zones §7): EVERY color-family declaration is a
 *   --dsw-* token (no bare color of any form), spacing/font ride the
 *   --mstar-space-* / --dsw-font-xxxs-11..xs-13 ramps, hover feedback sits in
 *   120–150ms (state switches ≤200ms), `prefers-reduced-motion` kills all
 *   transitions/animations, and the panel CSS carries no theme-specific color
 *   overrides (dark mode = host token flip);
 * - empty states: no catalog row (waiting), no harness, no gate — distinct
 *   hints, never a crash, never guessed values;
 * - partial source degradation: missing version → `unknown`;
 *   null knowledge / empty lists → `none` without crashing;
 * - data wiring (Task 3, spec §5): the component reads the catalog row
 *   through `useMstarEngineStatus(useSession)` — the fixture source rides a
 *   stub conversation snapshot (`createSnapshotStore`), and a snapshot bump
 *   (new catalog row) re-renders the panel with fresh data + freshness;
 * - plugin entry: `apply(ctx)` registers the `mstar-panel` dictionaries and
 *   the `conversation.view` tab (`id: 'mstar-workflow'`, `order: 20`,
 *   locale-following label thunk);
 * - T2 zone dashboard (spec panel-zones §2): the three zone frames
 *   (`data-zone="iteration|tasks|agents"`), the fixed footer bar (legend +
 *   gate summary + violations), and the canvas-corner AgentEventDock
 *   (`data-agent-event-dock` — rendered only when events exist, hidden
 *   entirely at 0); the react-flow-era orange notes are gone (`data-graph-
 *   empty="no-compass"` etc. asserted absent); zh labels; garbage-proof
 *   totality.
 *
 * Renderer: `react-dom/server.renderToStaticMarkup` over the real component
 * (dev-time seams linked from the dsh source tree; the `*.module.css` import
 * resolves to the raw
 * file-path string under `bun test`, so class attributes are dropped —
 * assertions pin `data-mstar-*` attributes, never class names).
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext, ConversationNode, ConversationSnapshot, SessionId, SlotsService } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { clientExports } from './client-bundles.ts'
import { Context } from 'cordis'
import type { MstarEngineStatusSource } from '../src/types'
import type { AgentFlowEventView, AgentFlowView } from '../src/types'
import type { EnforcementSource } from '@mstar-harness/engine'
import { apply } from '../src/client/index'

// The REAL client service values — loaded from the browser bundles through the
// loader shim; SlotsService / LocaleService are cordis services (ctx).
type RuntimeClientExports = typeof import('@deepseek-ai/dsh-client-runtime/client')
const { createSnapshotStore, SlotsService: SlotsServiceCtor } = clientExports('@deepseek-ai/dsh-client-runtime') as unknown as
  Pick<RuntimeClientExports, 'createSnapshotStore' | 'SlotsService'>
type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleService: LocaleServiceCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleService'>

/** One real SlotsService over a fresh cordis context (services are ctx-bound). */
function newSlots(): SlotsService {
  return new SlotsServiceCtor(new Context())
}

/** One real LocaleService over a fresh cordis context. */
function newLocale(): LocaleService {
  return new LocaleServiceCtor(new Context())
}
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
      { id: '20260809-dsh-workflow-viz-panel', status: 'InProgress', doneAt: null },
      { id: '20260808-dsh-package-core', status: 'Done', doneAt: '2026-08-08' },
    ],
    residuals: [
      { severity: 'high', count: 2 },
      { severity: 'medium', count: 1 },
    ],
    residualFindings: [
      { planId: '20260808-dsh-package-core', id: 'R1', severity: 'high', title: 'doneAt passthrough untested' },
      { planId: '20260809-dsh-workflow-viz-panel', id: 'R2', severity: 'medium', title: 'header removal doc drift' },
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
    plans: [{ id: '20260809-dsh-workflow-viz-panel', status: 'InProgress', doneAt: null }],
    residuals: [],
    residualFindings: null,
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

/** Runtime-shape degradation: missing version ⇒ `unknown` (spec §2.4); the meta dock renders version + harness dir only. */
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
  } as unknown as ConvViewProps
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
    } as unknown as ConversationNode)
  }
  return {
    sessionId: 's-1' as SessionId,
    nodes,
    running: false,
    openState: 'open',
    composerPhase: 'active',
    blank: false,
  } as unknown as ConversationSnapshot
}

/** Render the panel to static HTML through the real data path: snapshot store → useSession → hook → PanelView (default copy pinned to en). */
function panelHtml(
  source: MstarEngineStatusSource | null,
  locale: LocaleService = newLocale(),
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

  it('renders the sidebar meta dock (version / harness dir, watermark preserved)', () => {
    expect(html).toContain('data-mstar-meta')
    expect(html).toContain('data-mstar-meta-version')
    expect(html).toContain('data-mstar-meta-harness')
    // `data-mstar-watermark` moved here from the removed header (anchor lineage).
    expect(html).toContain('data-mstar-watermark')
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
  })

  it('renders the zone dashboard + fixed footer (legend + gate summary) in the main area (T2)', () => {
    // The react-flow graph is replaced by the zone dashboard (spec §2): the
    // three zone frames + the fixed footer bar (legend left, gate summary
    // right — PASS verdict + collapsible violations list).
    expect(html).toContain('data-mstar-canvas')
    expect(html).toContain('data-zone="iteration"')
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-zone="agents"')
    expect(html).toContain('data-mstar-graph-footer')
    expect(html).toContain('data-mstar-gate-summary')
    expect(html).toContain('data-graph-verdict="pass"')
    expect(html).toContain('data-graph-violations-count="2"')
    expect(html).toContain('data-violation-code="PLAN-3"')
    expect(html).toContain('data-violation-code="EXIT-1"')
    expect(html).toContain('plan 20260809-dsh-workflow-viz-panel not complete')
  })

  it('renders the state section: plans board, residual findings, policy (enforcement first), leases, knowledge, direction', () => {
    expect(html).toContain('data-mstar-section="state"')
    // Plan status board: id(status) rows.
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
    expect(html).toContain('data-plan-id="20260808-dsh-package-core"')
    expect(html).toContain('data-plan-status="Done"')
    // Residual findings: R# id + severity chip + title/planId (spec §5).
    expect(html).toContain('data-residual-finding')
    expect(html).toContain('data-residual-finding-id="R1"')
    expect(html).toContain('data-residual-finding-id="R2"')
    expect(html).toContain('data-residual-finding-severity="high"')
    expect(html).toContain('data-residual-finding-severity="medium"')
    expect(html).toContain('doneAt passthrough untested')
    expect(html).toContain('data-residual-finding-plan="20260809-dsh-workflow-viz-panel"')
    // Policy anchors — enforcement FIRST (from source.enforcement, spec §2.1).
    expect(html).toContain('data-field="enforcement"')
    expect(html).toContain('hard (iteration compass)')
    expect(html.indexOf('data-field="enforcement"')).toBeLessThan(html.indexOf('data-field="push-policy"'))
    expect(html).toContain('data-field="push-policy"')
    expect(html).toContain('push authorized')
    expect(html).toContain('data-field="worktree-mode"')
    expect(html).toContain('feature-worktree')
    expect(html).toContain('data-field="control-worktree-path"')
    // Branches block removed from the sidebar (moved to the iteration zone,
    // plan 20260810-panel-canvas-zones) — the branch anchors are gone.
    expect(html).not.toContain('data-field="iteration-base-branch"')
    expect(html).not.toContain('data-field="target-branch"')
    expect(html).not.toContain('data-field="spec-integration-branch"')
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

  it('no harness (harnessDir null + state null + no iteration) → no-harness hint + freshness, no meta dock', () => {
    const html = panelHtml(noHarnessSource)
    expect(html).toContain('data-mstar-panel="no-harness"')
    expect(html).toContain('No Morning Star harness detected')
    expect(html).toContain('data-mstar-freshness')
    // No sidebar / meta dock in the no-harness branch (hint + freshness only).
    expect(html).not.toContain('data-mstar-meta')
    expect(html).not.toContain('data-mstar-sidebar')
  })

  it('no gate (harness present, iteration key absent) → muted iteration zone, state still renders, no orange note', () => {
    const html = panelHtml(noGateSource)
    expect(html).toContain('data-mstar-panel="panel"')
    expect(html).toContain('data-mstar-canvas')
    expect(html).toContain('data-zone="iteration"')
    expect(html).toContain('data-zone="tasks"')
    // The react-flow-era no-compass orange note is GONE (replaced by the muted
    // zone placeholder; the disabled-iteration treatment lands with Task 3).
    expect(html).not.toContain('data-graph-empty="no-compass"')
    expect(html).not.toContain('No steering compass / status.json')
    expect(html).toContain('data-mstar-section="state"')
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    // Empty state lists degrade to "none" rather than crashing.
    expect(html).toContain('data-mstar-empty="no-residuals"')
    expect(html).toContain('data-mstar-empty="no-leases"')
    expect(html).toContain('data-mstar-empty="no-knowledge"')
  })

  it('iteration: null (schema-drift variant of "absent") → same muted degradation, never a crash (AC-3)', () => {
    const html = panelHtml({
      ...noGateSource,
      iteration: null,
    } as unknown as MstarEngineStatusSource)
    expect(html).toContain('data-mstar-panel="panel"')
    expect(html).toContain('data-mstar-canvas')
    expect(html).toContain('data-zone="iteration"')
    expect(html).not.toContain('data-graph-empty="no-compass"')
    expect(html).toContain('data-mstar-section="state"')
  })

  it('missing version degrades the meta dock to unknown, no guessed values', () => {
    const html = panelHtml(degradedSource)
    expect(html).toContain('mstar unknown')
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
  it('gate.ok false → FAIL badge in the footer gate summary + FAIL (n) count', () => {
    const html = panelHtml(failGateSource)
    expect(html).toContain('data-graph-verdict="fail"')
    expect(html).toContain('FAIL (2)')
    // The violation list still renders in FAIL mode (gate-level violations unchanged).
    expect(html).toContain('data-violation-code="PLAN-3"')
    expect(html).toContain('data-violation-code="EXIT-1"')
  })

  it('renders the panel body in zh when the locale flips (not just the tab label)', () => {
    const html = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(html).toContain('data-mstar-canvas')
    expect(html).toContain('迭代')
    expect(html).toContain('任务')
    expect(html).toContain('代理执行')
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
        { kind: 'context', seq: 2, time: 1_720_000_000_000, content: [], source: { ...fullSource, version: '2.0.3' }, form: 'catalog' } as unknown as ConversationNode,
        { kind: 'context', seq: 4, time: 1_720_001_000_000, content: [], source: fullSource, form: 'catalog' } as unknown as ConversationNode,
      ],
      running: false,
      openState: 'open',
      composerPhase: 'active',
      blank: false,
    } as unknown as ConversationSnapshot)
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const html = renderAgainst(store, locale)
    expect(html).toContain('mstar 2.0.4')
    expect(html).not.toContain('mstar 2.0.3')
  })

  it('a new catalog row (snapshot bump = refresh signal) re-renders the panel with fresh data', () => {
    const locale = newLocale()
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
  /** Real cordis context over the real services (slots + locale + sessions faces). */
  function makeCtx(): { ctx: ClientContext; slots: SlotsService; locale: LocaleService } {
    const ctx = new Context() as unknown as ClientContext
    const slots = new SlotsServiceCtor(ctx)
    const locale = new LocaleServiceCtor(ctx)
    // LocaleService is a plain class (not a cordis Service) — attach the
    // faces the plugin's client entry injects (slots registers itself).
    ;(ctx as unknown as Record<string, unknown>).locale = locale
    ;(ctx as unknown as Record<string, unknown>).sessions = {}
    return { ctx, slots, locale }
  }

  /** Declare the view-ring chain exactly like ui-conversation apply (spec §3.2). */
  function declareViewRing(slots: SlotsService): () => void {
    slots.register({
      name: 'root' as 'conversation.view',
      children: { 'conversation.session': { kind: 'single', scope: 'session' } } as never,
    } as never, () => null)
    return slots.register({
      name: 'conversation.session' as 'conversation.view',
      children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    } as never, () => null)
  }

  it('registers the mstar-panel dictionaries on apply', () => {
    const { ctx, locale } = makeCtx()
    apply(ctx)
    // Pin zh: the real LocaleService's initial locale is browser/persisted
    // derived (the removed peer-stub defaulted to the first-registered one).
    locale.setLocale('zh')
    expect(locale.bind(NS)('view.mstar-workflow')).toBe('MStar 工作流')
  })

  it('registers the conversation.view tab (id mstar-workflow, order 20, label follows locale)', () => {
    const { ctx, slots, locale } = makeCtx()
    apply(ctx)
    // Not declared yet: the inject callback must wait.
    expect(slots.entries('conversation.view')).toHaveLength(0)

    const disposeDeclarer = declareViewRing(slots)
    locale.setLocale('zh')
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

describe('workflow panel — T1 layout: sidebar meta dock / main grid / full-tab (spec panel-zones §2)', () => {
  const html = panelHtml(fullSource)

  it('the sidebar meta dock renders version + harness dir (header removed)', () => {
    // The old 3-cell header is gone; version/harness live in the sidebar bottom dock.
    expect(html).not.toContain('data-mstar-header')
    expect(html).not.toContain('data-mstar-header-cell')
    expect(html).toContain('data-mstar-meta')
    expect(html).toContain('data-mstar-meta-version')
    expect(html).toContain('data-mstar-meta-harness')
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
  })

  it('root + main CSS pin the full-tab v3 layout (no page scroll; the canvas zone container is the ONLY scroll body)', () => {
    const cssText = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    // Root fills the Tab and never scrolls (v3: the page NEVER scrolls).
    expect(cssText).toContain('grid-template-columns: minmax(0, 1fr) 300px')
    expect(cssText).toMatch(/grid-template-areas:\s*'main sidebar'/)
    expect(cssText).toContain('height: 100%')
    expect(cssText).toContain('min-height: 0')
    expect(cssText).toContain('overflow: hidden')
    expect(cssText).toMatch(/@media \(max-width: 860px\)/)
    // `.main` itself never scrolls (v3) — the canvas zone container scrolls.
    expect(cssText).toMatch(/\.main\s*\{[\s\S]*?overflow:\s*hidden/)
    // Sidebar is its own scroll container (digest region), not the page.
    expect(cssText).toContain('overflow-y: auto')
    expect(cssText).toContain('flex: 1')
    // Spacing ramp tokens defined at the panel root (spec §1.2).
    expect(cssText).toMatch(/--mstar-space-[1-6]:\s*\d+px/)
    // Theming is dsw-token driven only — no bare hex (dark mode = token value flip).
    expect(cssText).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(cssText).not.toMatch(/rgb\(|rgba\(/)
  })

  it('sidebar renders the plans / residuals / knowledge / leases status areas + the fixed meta dock', () => {
    expect(html).toContain('data-mstar-sidebar')
    expect(html).toContain('data-mstar-sidebar-scroll')
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-residual-finding-severity="high"')
    expect(html).toContain('data-knowledge-docs="3"')
    expect(html).toContain('data-lease-plan="20260809-dsh-workflow-viz-panel"')
    // The digest content lives INSIDE the sidebar scroll region; the meta dock
    // follows it (data-plan-id also appears earlier in the graph node plan rows,
    // so order is pinned against the sidebar's own state section marker).
    expect(html.indexOf('data-mstar-sidebar')).toBeLessThan(html.indexOf('data-mstar-section="state"'))
    expect(html.indexOf('data-mstar-section="state"')).toBeLessThan(html.indexOf('data-mstar-meta'))
    // The meta dock renders inside the sidebar (watermark lineage preserved).
    expect(html.indexOf('data-mstar-sidebar')).toBeLessThan(html.indexOf('data-mstar-watermark'))
  })

  it('main area renders the WorkflowCanvas zone dashboard inside the graph region (T2 fills the graph)', () => {
    expect(html).toContain('data-mstar-graph')
    expect(html).toContain('data-mstar-canvas')
    expect(html).toContain('data-zone="iteration"')
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-zone="agents"')
    // The react-flow canvas anchors are gone.
    expect(html).not.toContain('data-graph-canvas')
    expect(html).not.toContain('data-graph-nodes-draggable')
  })
})

describe('workflow panel — T4 theme audit: token-only colors, ramp metrics, reduced-motion (spec panel-zones §7)', () => {
  const cssText = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')

  /** Strip comments; collect the VALUE of every declaration on the given property set. */
  function declValues(propertyRe: RegExp): string[] {
    const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
    const values: string[] = []
    for (const m of stripped.matchAll(propertyRe)) {
      const rest = stripped.slice((m.index ?? 0) + m[0].length)
      const end = rest.search(/[;}]/)
      values.push(rest.slice(0, end === -1 ? rest.length : end).trim())
    }
    return values
  }

  it('every color-family declaration is a --dsw-* token — zero bare colors of ANY form (spec §7)', () => {
    // Full-file scan, not spot checks: color / background / border(-side)
    // declarations must all resolve through var(--dsw-alias-*|--dsw-static-*).
    const colorRe = /\b(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?)\s*:/g
    const colors = declValues(colorRe)
    expect(colors.length).toBeGreaterThan(0)
    for (const value of colors) {
      if (value === '0' || value === 'none') continue // structural border reset, not a color
      expect(value).toMatch(/var\(--dsw-(?:alias|static)-/)
    }
    // Zero bare colors of any form: hex, rgb/rgba, hsl/hsla, hwb, lab, lch, color().
    expect(cssText).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|color\(/)
  })

  it('spacing rides the --mstar-space-1..6 ramp — no bare px gaps/paddings/margins (spec §7)', () => {
    const spacingRe = /\b(?:gap|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?)\s*:/g
    const spacing = declValues(spacingRe)
    expect(spacing.length).toBeGreaterThan(0)
    for (const value of spacing) {
      if (value === '' || /^0(\s+0)*$/.test(value)) continue // zero reset
      expect(value).toMatch(/var\(--mstar-space-/)
    }
    // The ramp itself is the spec §1.2 hard metrics (4/8/12/16/24/32px).
    const ramp: ReadonlyArray<readonly [number, string]> = [
      [1, '4px'], [2, '8px'], [3, '12px'], [4, '16px'], [5, '24px'], [6, '32px'],
    ]
    for (const [n, px] of ramp) {
      expect(cssText).toContain(`--mstar-space-${n}: ${px}`)
    }
  })

  it('font sizes ride the --dsw-font-xxxs-11 / xxs-12 / xs-13 ramp (spec §7)', () => {
    const fonts = declValues(/\bfont\s*:/g)
    expect(fonts.length).toBeGreaterThan(0)
    for (const value of fonts) {
      expect(value).toMatch(/var\(--dsw-font-(?:xxxs-11|xxs-12|xs-13)\)/)
    }
  })

  it('hover feedback is 120–150ms, state switches ≤200ms — every transition duration in window (spec §7)', () => {
    const transitions = [...cssText.matchAll(/transition:\s*([^;}]+)/g)].map((m) => m[1]!.trim())
    expect(transitions.length).toBeGreaterThan(0)
    for (const t of transitions) {
      if (/^none/.test(t)) continue // reduced-motion kill switch
      const durations = [...t.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]!))
      expect(durations.length).toBeGreaterThan(0)
      for (const d of durations) {
        expect(d).toBeGreaterThanOrEqual(120)
        expect(d).toBeLessThanOrEqual(200)
      }
    }
    // At least one hover-affordance transition sits in the 120–150ms window.
    expect(cssText).toMatch(/transition:\s*[^;]*\b1[2-5]0ms/)
  })

  it('prefers-reduced-motion disables every transition and animation (spec §1.2/§7)', () => {
    expect(cssText).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(cssText).toMatch(/transition:\s*none\s*!important/)
    expect(cssText).toMatch(/animation:\s*none\s*!important/)
  })

  it('section titles are uppercase + letter-spaced; chip radius is unified (spec §7)', () => {
    expect(cssText).toMatch(/\.sectionTitle\s*\{[\s\S]*?text-transform:\s*uppercase/)
    expect(cssText).toMatch(/\.sectionTitle\s*\{[\s\S]*?letter-spacing:\s*0\.03em/)
    expect(cssText).toMatch(/\.subTitle\s*\{[\s\S]*?text-transform:\s*uppercase/)
    const radii = [...cssText.matchAll(/border-radius:\s*([^;]+)/g)].map((m) => m[1]!.trim())
    expect(radii.length).toBeGreaterThan(0)
    for (const r of radii) expect(['999px', '8px']).toContain(r)
  })

  it('dark mode is a host token flip — no theme-specific color overrides in the panel CSS (spec §7)', () => {
    // The panel carries zero colors of its own, so `body[data-ds-dark-theme]`
    // readability comes from the host's token values — a `data-ds-dark-theme`
    // selector with a hard-coded override in the panel CSS would be a leak.
    expect(cssText).not.toContain('data-ds-dark-theme')
  })
})

describe('workflow panel — T3 sidebar reorg: plan cap/sort, residual findings cap, policy enforcement (spec panel-zones §3/§5)', () => {
  /** Sidebar state-section slice: from `data-mstar-section="state"` to the meta dock — excludes the graph's own plan rows. */
  function stateSlice(html: string): string {
    const start = html.indexOf('data-mstar-section="state"')
    const end = html.indexOf('data-mstar-meta')
    return start === -1 || end === -1 ? html : html.slice(start, end)
  }

  it('plan board caps at 5 in spec §3 order with a +N more note; ≤5 renders no note', () => {
    const many = panelHtml({
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: 'plan-1', status: 'Todo', doneAt: null },
          { id: 'plan-2', status: 'InProgress', doneAt: null },
          { id: 'plan-3', status: 'InProgress', doneAt: null },
          { id: 'plan-4', status: 'InReview', doneAt: null },
          { id: 'plan-5', status: 'InReview', doneAt: null },
          { id: 'plan-6', status: 'Done', doneAt: '2026-08-08' },
          { id: 'plan-7', status: 'Done', doneAt: '2026-08-09' },
        ],
      },
    })
    const s = stateSlice(many)
    // Spec §3 order: doneAt digitized DESC first (plan-7, plan-6), then the
    // no-doneAt plans by id lex DESC (plan-5 … plan-3 fill the 5-row cap).
    expect(s.indexOf('data-plan-id="plan-7"')).toBeLessThan(s.indexOf('data-plan-id="plan-6"'))
    expect(s.indexOf('data-plan-id="plan-6"')).toBeLessThan(s.indexOf('data-plan-id="plan-5"'))
    expect(s).toContain('data-plan-id="plan-4"')
    expect(s).toContain('data-plan-id="plan-3"')
    // Cap 5 → the two lowest rows hide behind the +N more note.
    expect(s).toContain('data-plan-truncated')
    expect(s).toContain('+2 more')
    expect(s).not.toContain('data-plan-id="plan-2"')
    expect(s).not.toContain('data-plan-id="plan-1"')
    // The fixture (2 plans) renders no truncation note.
    expect(stateSlice(panelHtml(fullSource))).not.toContain('data-plan-truncated')
  })

  it('residual findings cap at 10 with an overflow hint; ≤10 renders none (spec §5)', () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      planId: 'plan-x',
      id: `R${i + 1}`,
      severity: 'nit' as string,
      title: `finding ${i + 1}`,
    }))
    const s = stateSlice(panelHtml({
      ...fullSource,
      state: { ...fullSource.state!, residualFindings: findings },
    }))
    expect(s).toContain('data-residual-truncated')
    expect(s).toContain('+2 more')
    expect(s).toContain('data-residual-finding-id="R1"')
    expect(s).toContain('data-residual-finding-id="R10"')
    expect(s).not.toContain('data-residual-finding-id="R11"')
    expect(s).not.toContain('data-residual-finding-id="R12"')
    // Fixture: 2 findings → no overflow hint.
    expect(stateSlice(panelHtml(fullSource))).not.toContain('data-residual-truncated')
  })

  it('residualFindings null (root key unreadable) degrades to the none note, never a crash', () => {
    const s = stateSlice(panelHtml(noGateSource))
    expect(s).toContain('data-mstar-empty="no-residuals"')
    expect(s).toContain('none')
  })

  it('enforcement missing / garbage degrades the policy row to unknown, never a crash', () => {
    // Missing (degradedSource carries enforcement: undefined) → unknown value.
    expect(panelHtml(degradedSource)).toContain('data-field="enforcement">unknown')
    // Garbage (non-object) → same unknown degrade.
    const garbage = panelHtml({ ...fullSource, enforcement: 'not-an-object' } as unknown as MstarEngineStatusSource)
    expect(garbage).toContain('data-field="enforcement">unknown')
  })

  it('soft enforcement renders soft + provenance source (spec §2.1)', () => {
    const soft = panelHtml({ ...fullSource, enforcement: { hard: false, source: 'iteration compass' as EnforcementSource } })
    expect(soft).toContain('data-field="enforcement"')
    expect(soft).toContain('soft (iteration compass)')
  })
})

describe('workflow panel — T1 panel rename: "MStar 工作流" / "MStar Workflow" (spec panel-layout-graph §1.1)', () => {
  it('view.mstar-workflow label flips with the locale', () => {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    expect(locale.bind(NS)('view.mstar-workflow')).toBe('MStar Workflow')
    locale.setLocale('zh')
    expect(locale.bind(NS)('view.mstar-workflow')).toBe('MStar 工作流')
  })

  it('zh body renders the meta dock + zone dashboard labels (header captions removed)', () => {
    const zhHtml = panelHtml(fullSource, undefined, undefined, 'zh')
    // zh/en dual-locale coverage of the meta dock: anchors + watermark values
    // (zh `watermark.*` values are identical to en — both render from the dock).
    expect(zhHtml).toContain('data-mstar-meta-version')
    expect(zhHtml).toContain('data-mstar-meta-harness')
    expect(zhHtml).toContain('mstar 2.0.4')
    expect(zhHtml).toContain('harness: /proj/.mstar')
    // The deleted header captions must not leak into the zh body; the
    // enforcement caption now lives in the sidebar POLICY section (moved from
    // the header — T3), so it IS expected in the zh body.
    expect(zhHtml).not.toContain('版本')
    expect(zhHtml).not.toContain('harness 目录')
    expect(zhHtml).toContain('执行策略')
    expect(zhHtml).toContain('data-field="enforcement"')
    // Zone dashboard zone headers (the react-flow phase labels are gone).
    expect(zhHtml).toContain('迭代')
    expect(zhHtml).toContain('任务')
    expect(zhHtml).toContain('代理执行')
    expect(zhHtml).toContain('图例')
  })
})

describe('workflow panel — T2 zone dashboard: three zones + fixed footer + corner event dock (spec panel-zones §2, v3)', () => {
  const html = panelHtml(fullSource)

  it('mounts the WorkflowCanvas in the main graph region with the three zone frames', () => {
    expect(html).toContain('data-mstar-graph')
    expect(html).toContain('data-mstar-canvas')
    expect(html).toContain('data-mstar-canvas-scroll')
    // Zone frames: iteration / tasks / agents, each with header + muted empty placeholder.
    for (const zone of ['iteration', 'tasks', 'agents']) {
      expect(html).toContain(`data-zone="${zone}"`)
    }
    expect(html).toContain('data-zone-header')
    expect(html).toContain('data-zone-empty')
    // The iteration zone renders its real content (Task 3): the Step 1–5
    // stepper + active header + branch panel — no longer a placeholder.
    expect(html).toContain('data-mstar-iteration-steps')
    expect(html).toContain('data-step="1"')
    expect(html).toContain('data-step="5"')
    expect(html).toContain('data-iteration-active="true"')
    expect(html).toContain('data-iteration-branches')
    // tasks/agents keep their muted placeholders until Task 4 / plan 3.
    expect(html).toContain('Task kanban pending')
    // fullSource.agentFlow === null → agents zone shows the degraded muted note.
    expect(html).toContain('No agent-flow evidence (ledger missing)')
  })

  it('renders the fixed footer bar: legend + gate summary with the collapsible violations list', () => {
    expect(html).toContain('data-mstar-graph-footer')
    expect(html).toContain('data-mstar-legend')
    expect(html).toContain('data-mstar-gate-summary')
    expect(html).toContain('data-graph-verdict="pass"')
    expect(html).toContain('data-graph-violations-count="2"')
    expect(html).toContain('data-violation-code="PLAN-3"')
    expect(html).toContain('data-violation-code="EXIT-1"')
  })

  it('the event dock is hidden entirely when there are no events (v3 — no placeholder box)', () => {
    // fullSource carries agentFlow: null → 0 events → dock must NOT exist.
    expect(html).not.toContain('data-agent-event-dock')
    expect(html).not.toContain('data-mstar-flow-events')
  })

  it('no-harness branch does NOT mount the canvas (mount gated on the empty-state branch, T1 minor-1)', () => {
    const g = panelHtml(noHarnessSource)
    expect(g).toContain('data-mstar-panel="no-harness"')
    expect(g).toContain('data-mstar-graph')
    expect(g).not.toContain('data-mstar-canvas')
  })

  it('no iteration → muted iteration zone + unknown verdict, state still renders, no orange note', () => {
    const g = panelHtml(noGateSource)
    expect(g).toContain('data-mstar-canvas')
    expect(g).toContain('data-zone="iteration"')
    // The react-flow-era no-compass orange note is gone (muted zone placeholder).
    expect(g).not.toContain('data-graph-empty="no-compass"')
    expect(g).not.toContain('No steering compass / status.json')
    expect(g).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(g).not.toContain('data-graph-verdict="pass"')
  })

  it('state null → tasks zone stays a muted frame; no no-state orange note (spec §8)', () => {
    const g = panelHtml({ ...fullSource, state: null })
    expect(g).toContain('data-mstar-canvas')
    expect(g).toContain('data-zone="tasks"')
    expect(g).not.toContain('data-graph-empty="no-state"')
  })

  it('plans missing → same muted tasks frame; no no-plans orange note (spec §8)', () => {
    const g = panelHtml({
      ...fullSource,
      state: { ...fullSource.state!, plans: undefined },
    } as unknown as MstarEngineStatusSource)
    expect(g).toContain('data-mstar-canvas')
    expect(g).toContain('data-zone="tasks"')
    expect(g).not.toContain('data-graph-empty="no-plans"')
  })

  it('renders the zone-semantic legend items, en + zh (react-flow items gone)', () => {
    for (const key of ['iteration', 'current', 'disabled', 'tasks', 'verdict-pass', 'verdict-fail', 'flow-expected', 'flow-actual', 'flow-unexpected']) {
      expect(html).toContain(`data-mstar-legend-item="${key}"`)
    }
    // The react-flow legend items (edge kinds, idle swatch) are gone.
    expect(html).not.toContain('data-mstar-legend-item="idle"')
    expect(html).not.toContain('data-mstar-legend-item="edge-forward"')
    expect(html).toContain('iteration zone')
    expect(html).toContain('disabled iteration')
    const zhHtml = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(zhHtml).toContain('data-mstar-legend-item="iteration"')
    expect(zhHtml).toContain('迭代未激活')
  })

  it('v3 zones CSS: canvas zone container is the ONLY scroll body, footer is flex:none, dock is absolute, <1200px stacks', () => {
    const cssText = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')
    // Canvas zone container: the only scroll body (spec §2, v3).
    expect(cssText).toMatch(/\.canvas\s*\{[\s\S]*?position:\s*relative/)
    expect(cssText).toMatch(/\.scroll\s*\{[\s\S]*?overflow:\s*auto/)
    expect(cssText).toContain('overscroll-behavior: contain')
    // Three-zone grid: iteration fixed left / tasks flex center / agents fixed right.
    expect(cssText).toContain('grid-template-columns: 300px minmax(0, 1fr) 380px')
    // <1200px → vertical stack.
    expect(cssText).toMatch(/@media \(max-width: 1200px\)/)
    expect(cssText).toMatch(/@media \(max-width: 1200px\)\s*\{[\s\S]*?grid-template-columns:\s*1fr/)
    // Footer bar: flex:none = fixed height, never scrolls with the zones.
    expect(cssText).toMatch(/\.footer\s*\{[\s\S]*?flex:\s*none/)
    // Event dock: absolute in the canvas container.
    expect(cssText).toMatch(/\.dock\s*\{[\s\S]*?position:\s*absolute/)
    // Token-only colors (zero bare colors of any form) — full-file scan.
    expect(cssText).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|color\(/)
    // Spacing rides the --mstar-space-* ramp (values are var() or zero resets).
    const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
    const spacingRe = /\b(?:gap|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?)\s*:/g
    const spacingValues: string[] = []
    for (const m of stripped.matchAll(spacingRe)) {
      const rest = stripped.slice((m.index ?? 0) + m[0].length)
      const end = rest.search(/[;}]/)
      spacingValues.push(rest.slice(0, end === -1 ? rest.length : end).trim())
    }
    expect(spacingValues.length).toBeGreaterThan(0)
    for (const value of spacingValues) {
      if (value === '' || /^0(\s+0)*$/.test(value)) continue // zero reset, not a metric
      expect(value).toMatch(/var\(--mstar-space-/)
    }
  })
})

describe('workflow panel — T3 iteration zone: Step stepper + header + branches + disabled (spec panel-zones §3/§8)', () => {
  const html = panelHtml(fullSource)

  it('active zone: header carries the iteration id, active note and Step N/5 label', () => {
    // fullSource: transition phase-2-execute → autonomous-execute → currentStep 2.
    expect(html).toContain('data-zone="iteration"')
    expect(html).toContain('data-iteration-active="true"')
    expect(html).toContain('data-iteration-id="iter-20260809-dsh-workflow-viz"')
    expect(html).toContain('data-iteration-active-note')
    expect(html).toContain('active iteration')
    expect(html).toContain('data-iteration-step-label="Step 2/5"')
    expect(html).toContain('Step 2/5')
    // The inactive note must not leak into the active zone.
    expect(html).not.toContain('data-iteration-inactive-note')
    expect(html).not.toContain('iteration inactive')
  })

  it('stepper: 5 steps in order, current/next/idle states, current-step verdict badge', () => {
    // All five Step N rows (1-based, PHASE_IDS order).
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`data-step="${n}"`)
    // Phase names ride the zone.phase.* keys (the graph.phase.* wording moved).
    expect(html).toContain('Iteration Start')
    expect(html).toContain('Autonomous Execute')
    expect(html).toContain('Iteration Close')
    expect(html).toContain('PR Delivery')
    expect(html).toContain('Merge Ready')
    // States: exactly one current (step 2) + one next (step 3), three idle.
    expect(html.match(/data-step-state="current"/g)).toHaveLength(1)
    expect(html.match(/data-step-state="next"/g)).toHaveLength(1)
    expect(html.match(/data-step-state="idle"/g)).toHaveLength(3)
    expect(html).toMatch(/data-step="2"[^>]*data-step-state="current"/)
    expect(html).toMatch(/data-step="3"[^>]*data-step-state="next"/)
    // State chips (localized labels).
    expect(html).toContain('current')
    expect(html).toContain('next')
    expect(html).toContain('idle')
    // Current-step verdict badge (fixture gate.ok → pass).
    expect(html).toContain('data-iteration-verdict="pass"')
    // Connectors: 4 between the 5 steps; only the segment leading INTO the
    // current step is lit (spec §3 — no "completed" checkmarks).
    expect(html.match(/data-step-connector="true"/g)).toHaveLength(4)
    expect(html).toContain('data-step-connector-state="lit"')
    expect(html.match(/data-step-connector-state="dim"/g)).toHaveLength(3)
  })

  it('FAIL gate → the current-step verdict badge carries data-iteration-verdict="fail"', () => {
    const failHtml = panelHtml(failGateSource)
    expect(failHtml).toContain('data-iteration-active="true"')
    expect(failHtml).toContain('data-iteration-verdict="fail"')
  })

  it('branch panel renders only while active: three data-branch rows with the state values', () => {
    expect(html).toContain('data-iteration-branches')
    expect(html).toContain('data-branches-title')
    expect(html).toContain('Branches')
    // Three rows (spec §3 — state.iterationBaseBranch / targetBranch / specIntegrationBranch).
    expect(html).toContain('data-branch="iteration-base"')
    expect(html).toContain('data-branch="target"')
    expect(html).toContain('data-branch="spec-integration"')
    expect(html).toContain('iteration base')
    expect(html).toContain('target')
    expect(html).toContain('spec integration')
    expect(html).toContain('dev-dsh')
    expect(html).toContain('iteration/iter-20260809-dsh-workflow-viz')
  })

  it('disabled state (no iteration / unresolvable transition): dimmed zone + muted note, 5 idle steps, no branches, no orange frame', () => {
    const g = panelHtml(noGateSource)
    expect(g).toContain('data-zone="iteration"')
    expect(g).toContain('data-iteration-active="false"')
    expect(g).toContain('data-iteration-inactive-note')
    expect(g).toContain('iteration inactive')
    // All five steps stay as the idle skeleton (spec §8) — no current/next.
    expect(g.match(/data-step-state="idle"/g)).toHaveLength(5)
    expect(g).not.toContain('data-step-state="current"')
    expect(g).not.toContain('data-step-state="next"')
    // The Step N/5 label and the verdict badge are current-step-only → absent.
    expect(g).not.toContain('data-iteration-step-label')
    expect(g).not.toContain('data-iteration-verdict')
    // Branches render ONLY while active (spec §3) → no branch anchors at all.
    expect(g).not.toContain('data-iteration-branches')
    expect(g).not.toContain('data-branch=')
    // A dimmed zone, not an orange warn frame (the react-flow note stays gone).
    expect(g).not.toContain('data-graph-empty="no-compass"')
    expect(g).not.toContain('No steering compass / status.json')
  })

  it('garbage iteration field → the same muted disabled zone, never a crash', () => {
    const garbage = panelHtml({ ...fullSource, iteration: 'not-an-object' } as unknown as MstarEngineStatusSource)
    expect(garbage).toContain('data-mstar-canvas')
    expect(garbage).toContain('data-zone="iteration"')
    expect(garbage).toContain('data-iteration-active="false"')
    expect(garbage).toContain('iteration inactive')
    expect(garbage).not.toContain('data-branch=')
  })

  it('zh locale: phase names, Step N/5 label, state chips and branch labels localize', () => {
    const zhHtml = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(zhHtml).toContain('data-iteration-active="true"')
    expect(zhHtml).toContain('data-iteration-step-label="步骤 2/5"')
    expect(zhHtml).toContain('正在激活的迭代')
    expect(zhHtml).toContain('迭代启动')
    expect(zhHtml).toContain('自主执行')
    expect(zhHtml).toContain('迭代收口')
    expect(zhHtml).toContain('PR 交付')
    expect(zhHtml).toContain('合并就绪')
    expect(zhHtml).toContain('当前')
    expect(zhHtml).toContain('下一步')
    expect(zhHtml).toContain('待命')
    expect(zhHtml).toContain('分支')
    expect(zhHtml).toContain('迭代 base')
    expect(zhHtml).toContain('目标分支')
    expect(zhHtml).toContain('spec 集成分支')
    // en phase labels must not leak into the zh body.
    expect(zhHtml).not.toContain('Autonomous Execute')
    // The zh disabled note localizes too.
    const zhInactive = panelHtml(noGateSource, undefined, undefined, 'zh')
    expect(zhInactive).toContain('data-iteration-active="false"')
    expect(zhInactive).toContain('迭代未激活')
  })
})

describe('workflow panel — T3 data projection integration (spec panel-zones §2/§3)', () => {
  const html = panelHtml(fullSource)

  /** Render the panel against a live snapshot store (same helper shape as the data-wiring block). */
  function renderStore(store: { getSnapshot(): ConversationSnapshot }, lang: 'en' | 'zh' = 'en'): string {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale(lang)
    return renderToStaticMarkup(createElement(PanelView, {
      ...kitProps({ useSession: bindUseSession(store) }),
      t: locale.bind(NS),
    }))
  }

  it('canvas, meta dock and sidebar all render from the SAME catalog row (single source of truth)', () => {
    // Meta dock watermark = source.version / harnessDir (was the header).
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
    // Sidebar plan board rows = state.plans verbatim.
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
    // The canvas zones + footer render from the same row: zone frames, the
    // PASS verdict from iteration.gate.ok, and the sidebar-visible plan row.
    expect(html).toContain('data-mstar-canvas')
    expect(html).toContain('data-zone="iteration"')
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-zone="agents"')
    expect(html).toContain('data-graph-verdict="pass"')
    expect(html).toContain('data-plan-status="InProgress"')
  })

  it('a new catalog row re-renders the canvas + footer with fresh data (no stale ring state)', () => {
    // Snapshot bump: server re-emission with a FAIL verdict + new violations.
    const beforeStore = createSnapshotStore(snapshotFor(fullSource, 1_720_000_000_000))
    expect(renderStore(beforeStore)).toContain('data-graph-verdict="pass"')

    const failing = {
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: {
          ...fullSource.iteration!.gate,
          ok: false,
          violations: [{ severity: 'high', code: 'EXIT-9', message: 'new violation row' }],
        },
      },
    } as unknown as MstarEngineStatusSource
    const store = createSnapshotStore(snapshotFor(failing, 1_720_000_000_000))
    const after = renderStore(store)
    expect(after).toContain('data-graph-verdict="fail"')
    expect(after).toContain('FAIL (1)')
    expect(after).toContain('data-graph-violations-count="1"')
    expect(after).toContain('data-violation-code="EXIT-9"')
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

  it('missing / garbage fields degrade the WHOLE panel (meta dock + canvas + sidebar) without crashing', () => {
    const noIteration = panelHtml({ ...fullSource, iteration: undefined } as unknown as MstarEngineStatusSource)
    expect(noIteration).toContain('data-mstar-meta')
    expect(noIteration).toContain('data-mstar-canvas')
    expect(noIteration).toContain('data-zone="iteration"')
    expect(noIteration).not.toContain('data-graph-empty="no-compass"')
    expect(noIteration).toContain('data-mstar-sidebar')
    expect(noIteration).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')

    const garbageIteration = panelHtml({ ...fullSource, iteration: 'not-an-object' } as unknown as MstarEngineStatusSource)
    expect(garbageIteration).toContain('data-mstar-meta')
    expect(garbageIteration).toContain('data-mstar-canvas')
    expect(garbageIteration).toContain('data-zone="iteration"')
    expect(garbageIteration).not.toContain('data-graph-empty="no-compass"')
    expect(garbageIteration).toContain('data-mstar-section="state"')
  })
})

/* ---------------------------------------------------------------------------
 * T2 event dock (spec panel-zones §2, v3): the agent-flow events render in the
 * canvas-corner AgentEventDock (absolute bottom-left, mounted ONLY when
 * events exist — hidden entirely, no placeholder, at 0 events) — role →
 * planId#taskId rows, status coloring, settled markers, unexpected re-list;
 * the agents zone placeholder carries the muted degraded/empty notes (spec
 * §8). The projection itself is unit-tested in client-graph-projection.spec.ts
 * — these pin the RENDER layer through the real data path (snapshot store →
 * useSession → PanelView → WorkflowCanvas → AgentEventDock).
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

describe('workflow panel — T2 event dock: canvas-corner agent-flow events (spec panel-zones §2, v3)', () => {
  it('agents zone shows the degraded muted note when the ledger is UNREADABLE (agentFlow null); dock hidden', () => {
    // fullSource.agentFlow === null → degraded (an unreadable ledger); the
    // agents zone carries the muted note and the dock is hidden entirely.
    const html = panelHtml(fullSource)
    expect(html).toContain('data-zone="agents"')
    expect(html).toContain('No agent-flow evidence (ledger missing)')
    expect(html).not.toContain('data-agent-event-dock')
    expect(html).not.toContain('data-mstar-flow-events')
  })

  it('mounts the dock when events exist: role → planId#taskId rows, status coloring, settled ✓, unexpected re-list', () => {
    const html = panelHtml(flowSource(flowEvents))
    expect(html).toContain('data-agent-event-dock')
    expect(html).toContain('data-agent-event-count="3"')
    expect(html).toContain('data-agent-event-unexpected-count="1"')
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
    // Unexpected events are re-listed in their own section.
    expect(html).toContain('data-mstar-flow-unexpected')
    expect(html).toContain('Unexpected roles')
    expect(html).toContain('scout')
    // With evidence present, the agents zone shows the generic pending placeholder.
    expect(html).toContain('Agent flow zone (entities / flow) pending')
  })

  it('the unexpected section mounts only on unexpected-role evidence (never a guessed warning)', () => {
    expect(panelHtml(flowSource(flowEvents))).toContain('data-mstar-flow-unexpected')
    expect(panelHtml(flowSource(flowEvents))).toContain('data-agent-event-unexpected-count="1"')
    const clean = panelHtml(flowSource([flowDispatch({ ts: 1, role: 'frontend-dev' })]))
    expect(clean).not.toContain('data-mstar-flow-unexpected')
    expect(clean).not.toContain('data-agent-event-unexpected-count')
    // The dock still mounts for expected-only evidence.
    expect(clean).toContain('data-agent-event-dock')
  })

  it('empty ledger (0 events) → agents zone muted empty note; dock hidden (no placeholder box)', () => {
    const html = panelHtml(flowSource([]))
    expect(html).toContain('data-zone="agents"')
    expect(html).toContain('No actual dispatches yet (recording starts at agent-flow plan merge)')
    expect(html).not.toContain('data-agent-event-dock')
    expect(html).not.toContain('data-mstar-flow-events')
  })

  it('garbage agentFlow → degraded muted note, never a crash', () => {
    const html = panelHtml({
      ...fullSource,
      state: { ...fullSource.state!, agentFlow: 42 },
    } as unknown as MstarEngineStatusSource)
    expect(html).toContain('data-mstar-canvas')
    expect(html).toContain('data-zone="agents"')
    expect(html).toContain('No agent-flow evidence (ledger missing)')
    expect(html).not.toContain('data-agent-event-dock')
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

  it('zh locale localizes the dock title + status labels', () => {
    const zhHtml = panelHtml(flowSource(flowEvents), undefined, undefined, 'zh')
    expect(zhHtml).toContain('Agent 流转事件')
    expect(zhHtml).toContain('已派发')
    expect(zhHtml).toContain('已结算')
    expect(zhHtml).toContain('未匹配角色')
    expect(zhHtml).toContain('3 条')
  })

  it('a new catalog row with fresh agentFlow events mounts/updates the dock (data path)', () => {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const store = createSnapshotStore(snapshotFor(fullSource, 1_720_000_000_000))
    const renderStore = () => renderToStaticMarkup(createElement(PanelView, {
      ...kitProps({ useSession: bindUseSession(store) }),
      t: locale.bind(NS),
    }))
    // fullSource: agentFlow null → degraded agents note + NO dock.
    expect(renderStore()).not.toContain('data-agent-event-dock')
    expect(renderStore()).toContain('No agent-flow evidence (ledger missing)')
    store.set(snapshotFor(flowSource(flowEvents), 1_720_000_004_000))
    const after = renderStore()
    expect(after).toContain('data-agent-event-dock')
    expect(after).toContain('data-agent-event-count="3"')
    expect(after).toContain('plan-1#T2')
    expect(after).not.toContain('No agent-flow evidence (ledger missing)')
  })
})
