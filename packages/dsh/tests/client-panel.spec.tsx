/**
 * Render tests for the Morning Star workflow-viz panel page (Task 2 + Task 3):
 * the `conversation.view` view tab that renders the `mstar-engine-status`
 * catalog source (spec `panel-contract.md` §2/§3/§4).
 *
 * Coverage:
 * - full fixture (iteration + state + freshness): every section renders —
 *   the sidebar meta dock (version/harness, header removed), the
 *   IterationTaskPage on the tasks tab (Content Head with the horizontal
 *   Step 1–5 row + branches, and the full-width 6-column kanban — the
 *   WorkflowCanvas zone dashboard is replaced by Task 2 and no longer
 *   renders here), plan status board, residual counts, branch/policy/lease
 *   anchors, knowledge digest, direction one-liner, last-updated marker;
 * - full-tab layout (spec panel-zones §2, v3 + panel-tabs §2): root fills
 *   the Tab without page scroll (`overflow: hidden`); the tasks page's own
 *   scroll body (`data-mstar-tasks-scroll`, the full-width kanban area) is
 *   the ONLY page-level scroller — the kanban is never compressed into a
 *   small box; sidebar is its own scroll container with a fixed bottom meta
 *   dock; zero bare hex/rgb in the panel + zones CSS;
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
 * - T7 iteration-task page (spec panel-tabs §3, plan 20260811-panel-tabs-shell
 *   Task 2): the Content Head — `data-iteration-head-*` anchors pin the
 *   collapse/expand defaults (active → expanded, inactive → collapsed one-line
 *   summary with the muted "not started" note + toggle affordance), the
 *   horizontal 5-step row (PHASE_IDS order, current/next/idle, connectors,
 *   current-step verdict) and the branches panel; the kanban anchors
 *   (`data-kanban-column` 6 columns / `data-tasks-total` / `data-mstar-kanban`)
 *   ride the reused TaskBoard; css asserts the tasks area is the independent
 *   vertical scroll body and the kanban columns spread full-width. The
 *   WorkflowCanvas-era render surfaces (zone frames, footer legend/gate
 *   summary, agent event dock, agent flow zone) are GONE from the tasks tab —
 *   their render tests migrate to the agent-canvas / event-log plans (the
 *   projection layer stays unit-tested in client-graph-projection.spec.ts);
 *   the react-flow-era orange notes are asserted absent; zh labels;
 *   garbage-proof totality.
 * - T6 tabs-shell (spec panel-tabs §2/§6.1): the panel is re-laid-out as
 *   Tabs + Content — resident right sidebar (all tabs share it), fixed
 *   header nav (TabNav, 3 MenuTabs) + per-tab content; `data-mstar-graph`
 *   now anchors the CONTENT container; default tab = 任务迭代 (D1); tab
 *   switching content assertions ride the exported TabNav + PanelContent;
 *   agents/events tabs render muted placeholder pages (`data-mstar-page-*`).
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
import { PanelContent, PanelView } from '../src/client/panel/PanelView'
import { TabNav } from '../src/client/panel/TabNav'

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

  it('renders the IterationTaskPage (content head + full-width kanban) in the main area (T7)', () => {
    // The WorkflowCanvas zone dashboard is replaced by the IterationTaskPage
    // (spec §3, Task 2): the Content Head (active → expanded by default) +
    // the reused TaskBoard kanban. The canvas / footer / dock surfaces are
    // gone from the tasks tab.
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('data-iteration-head-active="true"')
    expect(html).toContain('data-iteration-head-expanded="true"')
    expect(html).toContain('data-iteration-head-steps')
    expect(html).toContain('data-iteration-head-branches')
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-mstar-kanban')
    expect(html).toContain('data-tasks-total="2"')
    // The old canvas/footer/violations surfaces do not render on the tasks page.
    expect(html).not.toContain('data-mstar-canvas')
    expect(html).not.toContain('data-mstar-graph-footer')
    expect(html).not.toContain('data-graph-violations-count')
    expect(html).not.toContain('data-agent-event-dock')
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

  it('no gate (harness present, iteration key absent) → collapsed muted head, kanban skeleton, state still renders, no orange note', () => {
    const html = panelHtml(noGateSource)
    expect(html).toContain('data-mstar-panel="panel"')
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('data-iteration-head-active="false"')
    // Inactive → collapsed one-line summary by default (spec §3).
    expect(html).toContain('data-iteration-head-expanded="false"')
    expect(html).toContain('iteration not started')
    expect(html).toContain('data-zone="tasks"')
    // The react-flow-era no-compass orange note is GONE (replaced by the
    // collapsed muted head).
    expect(html).not.toContain('data-graph-empty="no-compass"')
    expect(html).not.toContain('No steering compass / status.json')
    expect(html).toContain('data-mstar-section="state"')
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    // Empty state lists degrade to "none" rather than crashing.
    expect(html).toContain('data-mstar-empty="no-residuals"')
    expect(html).toContain('data-mstar-empty="no-leases"')
    expect(html).toContain('data-mstar-empty="no-knowledge"')
  })

  it('iteration: null (schema-drift variant of "absent") → same muted collapsed head, never a crash (AC-3)', () => {
    const html = panelHtml({
      ...noGateSource,
      iteration: null,
    } as unknown as MstarEngineStatusSource)
    expect(html).toContain('data-mstar-panel="panel"')
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('data-iteration-head-active="false"')
    expect(html).toContain('data-iteration-head-expanded="false"')
    expect(html).toContain('iteration not started')
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
  it('gate.ok false → FAIL verdict in the content head summary (data-iteration-head-verdict)', () => {
    const html = panelHtml(failGateSource)
    expect(html).toContain('data-iteration-head-verdict="fail"')
    expect(html).toContain('FAIL')
    // The old footer gate-summary surface is gone with the WorkflowCanvas.
    expect(html).not.toContain('data-graph-verdict')
    expect(html).not.toContain('data-graph-violations-count')
  })

  it('renders the panel body in zh when the locale flips (not just the tab label)', () => {
    const html = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('迭代启动')
    expect(html).toContain('任务')
    expect(html).toContain('代理执行')
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

  it('main area renders the IterationTaskPage inside the content region (T7 fills the tasks tab)', () => {
    expect(html).toContain('data-mstar-graph')
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-mstar-kanban')
    // The WorkflowCanvas / react-flow canvas anchors are gone.
    expect(html).not.toContain('data-mstar-canvas')
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

/* ---------------------------------------------------------------------------
 * T5 zones CSS audit (spec panel-zones §7): the T4 theme audit reads
 * panel.module.css only — this block audits the zones css (the canvas zone
 * frames / footer / AgentEventDock / stepper / kanban) for the same contract:
 * token-only dock styles (bg/border/8px radius + token event status colors),
 * transitions inside the 120–200ms window, font sizes on the ramp, and the
 * reduced-motion root rule covering EVERY zones transition/animation.
 * ------------------------------------------------------------------------- */

describe('workflow panel — T5 zones CSS audit: dock token styles + transition window + reduced-motion coverage (spec panel-zones §7)', () => {
  const cssText = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')

  it('every transition in the zones css sits in the 120–200ms window (spec §7)', () => {
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
  })

  it('the panel root reduced-motion rule covers EVERY zones transition/animation (spec §1.2)', () => {
    const root = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    // The global kill switch targets `*` (every element — the zones css
    // included) inside @media (prefers-reduced-motion: reduce).
    expect(root).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\*\s*\{[\s\S]*?transition:\s*none\s*!important[\s\S]*?animation:\s*none\s*!important/,
    )
    // The zones css DECLARES its own animations (the plan-3 next-edge dash
    // flow + the running-card pulse) but carries NO self-contained
    // reduced-motion block — the root rule (`* { animation: none !important }`
    // inside the media query, asserted above) is the single coverage point.
    expect(cssText).not.toMatch(/@media\s*\(prefers-reduced-motion/)
  })

  it('font sizes in the zones css ride the --dsw-font-xxxs-11 / xxs-12 / xs-13 ramp (spec §7)', () => {
    const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
    const fonts: string[] = []
    for (const m of stripped.matchAll(/\bfont\s*:/g)) {
      const rest = stripped.slice((m.index ?? 0) + m[0].length)
      const end = rest.search(/[;}]/)
      fonts.push(rest.slice(0, end === -1 ? rest.length : end).trim())
    }
    expect(fonts.length).toBeGreaterThan(0)
    for (const value of fonts) {
      expect(value).toMatch(/var\(--dsw-font-(?:xxxs-11|xxs-12|xs-13)\)/)
    }
  })

  it('AgentEventDock styles align with the zone frames: token bg/border + 8px radius + token event status colors', () => {
    // Dock frame = the same token treatment as the zone frames (bg-layer-1 /
    // border-l1 / 8px radius — spec §2/§7 "样式与新区块统一").
    const dockRule = cssText.match(/\.dock\s*\{[\s\S]*?\}/)
    expect(dockRule).not.toBeNull()
    expect(dockRule![0]).toContain('background: var(--dsw-alias-bg-layer-1)')
    expect(dockRule![0]).toContain('border: 1px solid var(--dsw-alias-border-l1)')
    expect(dockRule![0]).toContain('border-radius: 8px')
    // Event-row status colors: every status class is a --dsw-* state token
    // (dispatch → business/warn/error; settle → success/error — spec §2.4).
    for (const cls of ['flowStatusDispatched', 'flowStatusAdvisory', 'flowStatusDenied', 'flowStatusOk', 'flowStatusError']) {
      const rule = cssText.match(new RegExp(`\\.${cls}\\s*\\{[\\s\\S]*?\\}`))
      expect(rule, cls).not.toBeNull()
      expect(rule![0]).toMatch(/--dsw-alias-state-(?:business|warn|error|success)-/)
    }
    // Zero bare colors of any form in the dock region (whole-file scan covers
    // it — re-pin for the dock-specific audit).
    expect(dockRule![0]).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|color\(/)
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
    expect(zhHtml).toContain('data-mstar-page="tasks"')
    expect(zhHtml).toContain('data-iteration-head')
    expect(zhHtml).toContain('迭代启动')
    expect(zhHtml).toContain('任务')
    expect(zhHtml).toContain('代理执行')
  })
})

/* ---------------------------------------------------------------------------
 * T7 iteration-task page (spec panel-tabs §3, plan 20260811-panel-tabs-shell
 * Task 2): the tasks tab renders the IterationTaskPage — Content Head
 * (collapsible iteration summary + HORIZONTAL Step 1–5 row + branches) above
 * the full-width standard kanban (the reused TaskBoard). The WorkflowCanvas
 * zone dashboard (zone frames / footer legend + gate summary / corner event
 * dock / agent flow zone) no longer renders on the tasks tab — its render
 * surfaces migrate to the agent-canvas / event-log plans, the projection
 * layer stays unit-tested in client-graph-projection.spec.ts.
 * ------------------------------------------------------------------------- */

describe('workflow panel — T7 iteration-task page: content head collapse/expand + horizontal steps + full-width kanban (spec panel-tabs §3)', () => {
  const html = panelHtml(fullSource)

  it('active iteration → head EXPANDED by default: summary row + horizontal 5-step row + branches', () => {
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('data-iteration-head-active="true"')
    expect(html).toContain('data-iteration-head-expanded="true"')
    // Summary row: iteration id + verdict + Step n/5 status (the toggle button).
    expect(html).toContain('data-iteration-head-id="iter-20260809-dsh-workflow-viz"')
    expect(html).toContain('data-iteration-head-verdict="pass"')
    expect(html).toContain('Step 2/5')
    // The horizontal 5-step row: PHASE_IDS order, one current + one next + three idle.
    expect(html).toContain('data-iteration-head-steps')
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`data-step="${n}"`)
    expect(html.match(/data-step-state="current"/g)).toHaveLength(1)
    expect(html.match(/data-step-state="next"/g)).toHaveLength(1)
    expect(html.match(/data-step-state="idle"/g)).toHaveLength(3)
    expect(html).toMatch(/data-step="2"[^>]*data-step-state="current"/)
    expect(html).toMatch(/data-step="3"[^>]*data-step-state="next"/)
    // Phase names ride the zone.phase.* keys (en).
    expect(html).toContain('Iteration Start')
    expect(html).toContain('Autonomous Execute')
    expect(html).toContain('Iteration Close')
    expect(html).toContain('PR Delivery')
    expect(html).toContain('Merge Ready')
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
    // Branch panel renders while active: three data-branch rows (spec §3).
    expect(html).toContain('data-iteration-head-branches')
    expect(html).toContain('data-branches-title')
    expect(html).toContain('Branches')
    expect(html).toContain('data-branch="iteration-base"')
    expect(html).toContain('data-branch="target"')
    expect(html).toContain('data-branch="spec-integration"')
    expect(html).toContain('dev-dsh')
    expect(html).toContain('iteration/iter-20260809-dsh-workflow-viz')
  })

  it('inactive iteration → head COLLAPSED to a one-line summary by default; the toggle can expand the idle skeleton', () => {
    const g = panelHtml(noGateSource)
    expect(g).toContain('data-iteration-head')
    expect(g).toContain('data-iteration-head-active="false"')
    expect(g).toContain('data-iteration-head-expanded="false"')
    // One-line summary: id seat (unknown) + unknown verdict + the muted
    // "not started" note + the expand hint (the toggle button).
    expect(g).toContain('data-iteration-head-id')
    expect(g).toContain('data-iteration-head-verdict="unknown"')
    expect(g).toContain('iteration not started')
    expect(g).toContain('data-iteration-head-toggle')
    expect(g).toMatch(/data-iteration-head-toggle[^>]*aria-expanded="false"/)
    // Collapsed → no steps row, no verdict badge, no branches.
    expect(g).not.toContain('data-iteration-head-steps')
    expect(g).not.toContain('data-step=')
    expect(g).not.toContain('data-iteration-verdict')
    expect(g).not.toContain('data-iteration-head-branches')
    expect(g).not.toContain('data-branch=')
  })

  it('garbage iteration field → the same collapsed muted head, never a crash', () => {
    const garbage = panelHtml({ ...fullSource, iteration: 'not-an-object' } as unknown as MstarEngineStatusSource)
    expect(garbage).toContain('data-iteration-head')
    expect(garbage).toContain('data-iteration-head-active="false"')
    expect(garbage).toContain('data-iteration-head-expanded="false"')
    expect(garbage).toContain('iteration not started')
    expect(garbage).not.toContain('data-step=')
    expect(garbage).not.toContain('data-branch=')
  })

  it('FAIL gate → the head verdict badge carries data-iteration-head-verdict="fail"', () => {
    const failHtml = panelHtml(failGateSource)
    expect(failHtml).toContain('data-iteration-head-active="true"')
    expect(failHtml).toContain('data-iteration-head-expanded="true"')
    expect(failHtml).toContain('data-iteration-head-verdict="fail"')
    expect(failHtml).toContain('data-iteration-verdict="fail"')
  })

  it('zh locale: summary/phase/chip/branch labels localize; en labels do not leak', () => {
    const zhHtml = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(zhHtml).toContain('data-iteration-head-active="true"')
    expect(zhHtml).toContain('data-iteration-head-expanded="true"')
    expect(zhHtml).toContain('步骤 2/5')
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
    // The zh "not started" note localizes too.
    const zhInactive = panelHtml(noGateSource, undefined, undefined, 'zh')
    expect(zhInactive).toContain('data-iteration-head-expanded="false"')
    expect(zhInactive).toContain('迭代未启动')
  })

  it('renders the full-width kanban in the tasks scroll area: 6 columns + total', () => {
    expect(html).toContain('data-mstar-tasks-scroll')
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-mstar-kanban')
    const cols = [...html.matchAll(/data-kanban-column="([^"]+)"/g)].map((m) => m[1]!)
    expect(cols).toEqual(['Todo', 'InProgress', 'InReview', 'Done', 'Blocked', 'unknown'])
    expect(html).toContain('data-tasks-total="2"')
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
    // The tasks page never mounts the WorkflowCanvas-era surfaces.
    expect(html).not.toContain('data-mstar-canvas')
    expect(html).not.toContain('data-mstar-iteration-steps')
    expect(html).not.toContain('data-zone="iteration"')
    expect(html).not.toContain('data-zone="agents"')
    expect(html).not.toContain('data-agent-event-dock')
    expect(html).not.toContain('data-mstar-legend')
  })

  it('state null → the muted 6-column kanban skeleton + no-plans note, never an orange box (spec §8)', () => {
    const g = panelHtml({ ...fullSource, state: null })
    expect(g).toContain('data-mstar-page="tasks"')
    expect(g).toContain('data-zone="tasks"')
    expect(g.match(/data-kanban-column="/g)).toHaveLength(6)
    expect(g.match(/data-kanban-count="0"/g)).toHaveLength(6)
    expect(g).toContain('data-zone-empty="no-plans"')
    expect(g).toContain('no plans')
    expect(g).not.toContain('data-graph-empty="no-state"')
  })

  it('plans missing → same muted kanban skeleton + no-plans note, no no-plans orange note (spec §8)', () => {
    const g = panelHtml({
      ...fullSource,
      state: { ...fullSource.state!, plans: undefined },
    } as unknown as MstarEngineStatusSource)
    expect(g).toContain('data-zone="tasks"')
    expect(g.match(/data-kanban-column="/g)).toHaveLength(6)
    expect(g).toContain('data-zone-empty="no-plans"')
    expect(g).toContain('no plans')
    expect(g).not.toContain('data-graph-empty="no-plans"')
  })

  it('css: the tasks area is the page\'s independent vertical scroll body; the kanban columns spread full-width (spec §3/D2)', () => {
    const panelCss = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    // The page fills the content region (flex column); the tasks area takes
    // the remaining height and scrolls independently — never compressed into
    // a small box by a canvas height.
    expect(panelCss).toMatch(/\.iterationPage\s*\{[\s\S]*?flex:\s*1/)
    expect(panelCss).toMatch(/\.iterationTasks\s*\{[\s\S]*?flex:\s*1/)
    expect(panelCss).toMatch(/\.iterationTasks\s*\{[\s\S]*?min-height:\s*0/)
    expect(panelCss).toMatch(/\.iterationTasks\s*\{[\s\S]*?overflow-y:\s*auto/)
    // The head stays fixed (flex:none) above the scrolling tasks area.
    expect(panelCss).toMatch(/\.iterationHead\s*\{[\s\S]*?flex:\s*none/)
    // The kanban columns spread to fill the content width: flex grow without
    // a max-width cap (the removed 200px ceiling was the "small box").
    const zonesCss = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')
    const columnRule = zonesCss.match(/\.kanbanColumn\s*\{[\s\S]*?\}/)
    expect(columnRule).not.toBeNull()
    expect(columnRule![0]).toContain('flex: 1 1 0')
    expect(columnRule![0]).not.toContain('max-width')
  })
})

/* ---------------------------------------------------------------------------
 * T5 AC-3 orange-box zeroing (spec panel-zones §3/§8): the react-flow-era
 * orange warn notes (GraphCanvas, removed in T2) must be GONE from every
 * render — the whole `data-graph-empty` anchor family (no-compass / no-state /
 * no-plans), the old note texts (en + zh), and the `.stateUnknown` orange
 * bucket class. The replacement muted empty states (data-zone-empty /
 * the collapsed `page.iteration.not-started` head note) must be PRESENT
 * instead. T7 asserted parts of
 * this per-state; this block unifies the negative assertions across the full
 * degradation matrix in both locales (AC-3 "橙色框清零" render evidence).
 * ------------------------------------------------------------------------- */

describe('workflow panel — T5 AC-3 orange-box zeroing: old anchors/texts gone, muted empty anchors present, dual locale (spec panel-zones §3/§8)', () => {
  /** The react-flow-era orange anchor family — the WHOLE family must be gone (any value). */
  const OLD_ANCHOR = 'data-graph-empty'
  const OLD_TEXTS: Record<'en' | 'zh', readonly string[]> = {
    // graph.no-compass / graph.no-plans / graph.no-state (old locale values).
    en: ['No steering compass / status.json', 'no plan rows (state machine skeleton)', 'no workspace state digest'],
    zh: ['无 steering compass / status.json', '无 plan 行（状态机骨架）', '无工作区状态摘要'],
  }

  it('full fixture, en + zh: zero data-graph-empty anchors, zero old note texts, zero stateUnknown', () => {
    for (const lang of ['en', 'zh'] as const) {
      const html = panelHtml(fullSource, undefined, undefined, lang)
      expect(html).not.toContain(OLD_ANCHOR)
      expect(html).not.toContain('stateUnknown')
      for (const text of OLD_TEXTS[lang]) expect(html).not.toContain(text)
    }
  })

  it('no iteration, en + zh: collapsed muted head with the not-started note, no-compass anchor + text gone', () => {
    for (const lang of ['en', 'zh'] as const) {
      const g = panelHtml(noGateSource, undefined, undefined, lang)
      expect(g).toContain('data-iteration-head')
      expect(g).toContain('data-iteration-head-active="false"')
      expect(g).toContain('data-iteration-head-expanded="false"')
      expect(g).toContain(lang === 'en' ? 'iteration not started' : '迭代未启动')
      expect(g).not.toContain(OLD_ANCHOR)
      expect(g).not.toContain('data-graph-empty="no-compass"')
      expect(g).not.toContain(OLD_TEXTS[lang][0]!)
    }
  })

  it('state null, en + zh: muted no-plans note present, no-state anchor + text gone', () => {
    for (const lang of ['en', 'zh'] as const) {
      const g = panelHtml({ ...fullSource, state: null }, undefined, undefined, lang)
      expect(g).toContain('data-zone-empty="no-plans"')
      expect(g).toContain(lang === 'en' ? 'no plans' : '暂无计划')
      expect(g).not.toContain(OLD_ANCHOR)
      expect(g).not.toContain('data-graph-empty="no-state"')
      expect(g).not.toContain(OLD_TEXTS[lang][2]!)
    }
  })

  it('plans missing, en + zh: same muted skeleton, no-plans anchor + text gone', () => {
    for (const lang of ['en', 'zh'] as const) {
      const g = panelHtml({
        ...fullSource,
        state: { ...fullSource.state!, plans: undefined },
      } as unknown as MstarEngineStatusSource, undefined, undefined, lang)
      expect(g).toContain('data-zone-empty="no-plans"')
      expect(g).not.toContain(OLD_ANCHOR)
      expect(g).not.toContain('data-graph-empty="no-plans"')
      expect(g).not.toContain(OLD_TEXTS[lang][1]!)
    }
  })

  it('agentFlow null, en + zh: the tasks page renders no agents zone / no dock / no orange flow note (agents render moves to the agent-canvas plan)', () => {
    for (const lang of ['en', 'zh'] as const) {
      const g = panelHtml(fullSource, undefined, undefined, lang)
      expect(g).toContain('data-iteration-head')
      expect(g).not.toContain('data-zone="agents"')
      expect(g).not.toContain('data-agent-event-dock')
      expect(g).not.toContain(OLD_ANCHOR)
    }
  })

  it('the .stateUnknown orange bucket class is deleted from the zones css; unknown column stays muted NEUTRAL', () => {
    const cssText = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')
    // The react-flow-era `.stateUnknown` RULE (dashed warn border + warn
    // label) is gone with graph.module.css — no selector rule survives (a
    // comment may name the old class; the rule must not).
    expect(cssText).not.toMatch(/\.stateUnknown\s*\{/)
    // The unknown kanban column rule is the muted neutral treatment (spec §3):
    // caption-colored, dimmed — no warn/error/business state token (AC-3
    // umbrella re-assert; T4 pins the same rule).
    const unknownRule = cssText.match(/\[data-kanban-column='unknown'\]\s*\{[\s\S]*?\}/)
    expect(unknownRule).not.toBeNull()
    expect(unknownRule![0]).toContain('--dsw-alias-label-caption')
    expect(unknownRule![0]).toContain('opacity')
    expect(unknownRule![0]).not.toMatch(/--dsw-alias-state-(?:warn|error|business)/)
  })
})

describe('workflow panel — T7 data projection integration (spec panel-tabs §3)', () => {
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

  it('tasks page, meta dock and sidebar all render from the SAME catalog row (single source of truth)', () => {
    // Meta dock watermark = source.version / harnessDir (was the header).
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
    // Sidebar plan board rows = state.plans verbatim.
    expect(html).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
    // The tasks page renders from the same row: the head verdict from
    // iteration.gate.ok + the sidebar-visible plan row in the kanban.
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('data-iteration-head-verdict="pass"')
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-plan-status="InProgress"')
  })

  it('a new catalog row re-renders the tasks page with fresh data (no stale ring state)', () => {
    // Snapshot bump: server re-emission with a FAIL verdict.
    const beforeStore = createSnapshotStore(snapshotFor(fullSource, 1_720_000_000_000))
    expect(renderStore(beforeStore)).toContain('data-iteration-head-verdict="pass"')

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
    expect(after).toContain('data-iteration-head-verdict="fail"')
    expect(after).toContain('data-iteration-verdict="fail"')
    // The violation list itself renders on the event-log page (event-log plan) —
    // the tasks page surfaces only the verdict.
    expect(after).not.toContain('data-graph-violations-count')
  })

  it('missing / garbage fields degrade the WHOLE panel (meta dock + tasks page + sidebar) without crashing', () => {
    const noIteration = panelHtml({ ...fullSource, iteration: undefined } as unknown as MstarEngineStatusSource)
    expect(noIteration).toContain('data-mstar-meta')
    expect(noIteration).toContain('data-iteration-head')
    expect(noIteration).toContain('data-iteration-head-active="false"')
    expect(noIteration).not.toContain('data-graph-empty="no-compass"')
    expect(noIteration).toContain('data-mstar-sidebar')
    expect(noIteration).toContain('data-plan-id="20260809-dsh-workflow-viz-panel"')

    const garbageIteration = panelHtml({ ...fullSource, iteration: 'not-an-object' } as unknown as MstarEngineStatusSource)
    expect(garbageIteration).toContain('data-mstar-meta')
    expect(garbageIteration).toContain('data-iteration-head')
    expect(garbageIteration).toContain('data-iteration-head-active="false"')
    expect(garbageIteration).not.toContain('data-graph-empty="no-compass"')
    expect(garbageIteration).toContain('data-mstar-section="state"')
  })
})

/* ---------------------------------------------------------------------------
 * T4 task board kanban (spec panel-zones §3/§8): the 6 PLAN_STATE_IDS columns
 * with localized headers + count badges, plan cards (data-plan-id /
 * data-plan-status — the anchors shared with the sidebar), the dim inter-
 * column flow arrows (chain + Blocked ⇄), the Done cap hint (the projection
 * applied sortPlans + PLAN_CAP — the render surfaces the +N more), the muted
 * no-plans empty state, and the unknown column's muted NEUTRAL (non-orange)
 * treatment. The sort/cap assertions here are RENDER-layer only — the
 * projection-side tests in client-graph-projection.spec.ts are independent
 * (compass Risk Register).
 * ------------------------------------------------------------------------- */

describe('workflow panel — T4 task board kanban: 6 columns + counts + cards + arrows + Done cap + empty state (spec panel-zones §3/§8)', () => {
  /** The tasks zone slice: from the TaskBoard zone frame to the resident sidebar. */
  function tasksSlice(html: string): string {
    const start = html.indexOf('data-zone="tasks"')
    const end = html.indexOf('data-mstar-sidebar')
    return start === -1 || end === -1 ? html : html.slice(start, end)
  }

  /** One column's slice: from its `data-kanban-column` anchor to the next one. */
  function columnSlice(html: string, id: string): string {
    const start = html.indexOf(`data-kanban-column="${id}"`)
    const next = html.indexOf('data-kanban-column=', start + 1)
    return start === -1 ? '' : next === -1 ? html.slice(start) : html.slice(start, next)
  }

  /** A plan-status spread covering every bucket (unknown = non-5-state status). */
  const kanbanSource: MstarEngineStatusSource = {
    ...fullSource,
    state: {
      ...fullSource.state!,
      plans: [
        { id: 'plan-todo-1', status: 'Todo', doneAt: null },
        { id: 'plan-todo-2', status: 'Todo', doneAt: null },
        { id: 'plan-ip-1', status: 'InProgress', doneAt: null },
        { id: 'plan-ir-1', status: 'InReview', doneAt: null },
        { id: 'plan-done-1', status: 'Done', doneAt: '2026-08-01' },
        { id: 'plan-blocked-1', status: 'Blocked', doneAt: null },
        { id: 'plan-weird-1', status: 'Paused', doneAt: null },
      ],
    },
  }
  const html = panelHtml(kanbanSource)

  it('renders 6 columns in PLAN_STATE_IDS order with count badges and the total', () => {
    expect(html).toContain('data-mstar-kanban')
    const cols = [...html.matchAll(/data-kanban-column="([^"]+)"/g)].map((m) => m[1]!)
    expect(cols).toEqual(['Todo', 'InProgress', 'InReview', 'Done', 'Blocked', 'unknown'])
    // Header total (spec §3 — plan total across all columns, unknown included).
    expect(html).toContain('data-tasks-total="7"')
    expect(html).toContain('7 plans')
    // Count badges: Todo 2, one plan in each other bucket.
    expect(html).toContain('data-kanban-count="2"')
    expect(html.match(/data-kanban-count="1"/g)).toHaveLength(5)
  })

  it('buckets plan cards into their columns: data-plan-id / data-plan-status (shared anchors)', () => {
    const todo = columnSlice(html, 'Todo')
    expect(todo).toContain('data-plan-id="plan-todo-1"')
    expect(todo).toContain('data-plan-id="plan-todo-2"')
    expect(todo).toContain('data-plan-status="Todo"')
    expect(todo).not.toContain('data-plan-id="plan-ip-1"')
    const ip = columnSlice(html, 'InProgress')
    expect(ip).toContain('data-plan-id="plan-ip-1"')
    expect(ip).toContain('data-plan-status="InProgress"')
    expect(ip).not.toContain('data-plan-id="plan-todo-1"')
    // The non-5-state status (Paused) lands in the unknown bucket (spec §3).
    const unknown = columnSlice(html, 'unknown')
    expect(unknown).toContain('data-plan-id="plan-weird-1"')
    expect(unknown).toContain('data-plan-status="Paused"')
  })

  it('unknown column is muted NEUTRAL (spec §3) — never the warn/orange treatment', () => {
    const cssText = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')
    const unknownRule = cssText.match(/\[data-kanban-column='unknown'\]\s*\{[\s\S]*?\}/)
    expect(unknownRule).not.toBeNull()
    // Muted neutral: caption-colored text + dimmed, dashed frame.
    expect(unknownRule![0]).toContain('--dsw-alias-label-caption')
    expect(unknownRule![0]).toContain('opacity')
    // NOT orange: no warn/error/business state token in the unknown rule.
    expect(unknownRule![0]).not.toMatch(/--dsw-alias-state-(?:warn|error|business)/)
  })

  it('renders the dim inter-column flow arrows: chain → + Blocked ⇄ (spec §2.4)', () => {
    const k = tasksSlice(html)
    expect(k.match(/data-kanban-arrow=/g)).toHaveLength(4)
    expect(k).toContain('data-kanban-arrow="Todo-InProgress"')
    expect(k).toContain('data-kanban-arrow="InProgress-InReview"')
    expect(k).toContain('data-kanban-arrow="InReview-Done"')
    expect(k).toContain('data-kanban-arrow="InProgress-Blocked"')
    // The bidirectional glyph rides the Blocked back-edge.
    expect(k).toContain('⇄')
    // Arrows sit in the column gaps (chain: between the first four columns).
    const pos = (s: string) => k.indexOf(s)
    expect(pos('data-kanban-column="Todo"')).toBeLessThan(pos('data-kanban-arrow="Todo-InProgress"'))
    expect(pos('data-kanban-arrow="Todo-InProgress"')).toBeLessThan(pos('data-kanban-column="InProgress"'))
    expect(pos('data-kanban-column="InProgress"')).toBeLessThan(pos('data-kanban-arrow="InProgress-Blocked"'))
    expect(pos('data-kanban-arrow="InProgress-Blocked"')).toBeLessThan(pos('data-kanban-column="Blocked"'))
  })

  it('Done cap 5: 7 Done plans → top-5 in plan-sort order + count 7 + +2 more hint (data-kanban-truncated)', () => {
    const doneOverflow: MstarEngineStatusSource = {
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: '20260807-plan', status: 'Done', doneAt: '2026-08-07' },
          { id: '20260806-plan', status: 'Done', doneAt: '2026-08-06' },
          { id: '20260805-plan', status: 'Done', doneAt: '2026-08-05' },
          { id: '20260804-plan', status: 'Done', doneAt: '2026-08-04' },
          { id: '20260803-plan', status: 'Done', doneAt: '2026-08-03' },
          { id: '20260802-plan', status: 'Done', doneAt: '2026-08-02' },
          { id: '20260801-plan', status: 'Done', doneAt: '2026-08-01' },
        ],
      },
    }
    const g = panelHtml(doneOverflow)
    const done = columnSlice(g, 'Done')
    // Full count on the badge, top PLAN_CAP cards rendered (spec §3).
    expect(done).toContain('data-kanban-count="7"')
    expect(done.match(/data-plan-id="/g)).toHaveLength(5)
    // Plan-sort order (shared key, projection-side): doneAt digitized DESC.
    expect(done.indexOf('data-plan-id="20260807-plan"')).toBeLessThan(done.indexOf('data-plan-id="20260806-plan"'))
    expect(done.indexOf('data-plan-id="20260806-plan"')).toBeLessThan(done.indexOf('data-plan-id="20260803-plan"'))
    // Overflow hint: the hidden count + the localized +N more wording.
    expect(done).toContain('data-kanban-truncated="2"')
    expect(done).toContain('+2 more')
    expect(done).not.toContain('data-plan-id="20260802-plan"')
    expect(done).not.toContain('data-plan-id="20260801-plan"')
    // The projection-level assertions stay independent (Risk Register) — this
    // pins the RENDER of the capped column only.
  })

  it('Done cap boundary: exactly 5 Done plans → no truncation hint', () => {
    const five: MstarEngineStatusSource = {
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: Array.from({ length: 5 }, (_, i) => ({
          id: `2026080${i + 1}-plan`,
          status: 'Done',
          doneAt: `2026-08-0${i + 1}`,
        })),
      },
    }
    const done = columnSlice(panelHtml(five), 'Done')
    expect(done.match(/data-plan-id="/g)).toHaveLength(5)
    expect(done).not.toContain('data-kanban-truncated')
    expect(done).not.toContain('+1 more')
  })

  it('non-Done columns are never sorted or capped — input order preserved (spec §3)', () => {
    const unsorted: MstarEngineStatusSource = {
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: 'plan-z', status: 'Todo', doneAt: null },
          { id: 'plan-a', status: 'Todo', doneAt: null },
          { id: 'plan-m', status: 'Todo', doneAt: null },
        ],
      },
    }
    const todo = columnSlice(panelHtml(unsorted), 'Todo')
    // Input order (plan-z, plan-a, plan-m) — NOT the id lex DESC the Done
    // column would apply.
    expect(todo.indexOf('data-plan-id="plan-z"')).toBeLessThan(todo.indexOf('data-plan-id="plan-a"'))
    expect(todo.indexOf('data-plan-id="plan-a"')).toBeLessThan(todo.indexOf('data-plan-id="plan-m"'))
    expect(todo).not.toContain('data-kanban-truncated')
  })

  it('zh locale: localized column headers, total label and the muted no-plans note', () => {
    const zhHtml = panelHtml(kanbanSource, undefined, undefined, 'zh')
    const zhTasks = tasksSlice(zhHtml)
    // Column headers ride the zone.state.* keys (en is the raw status word).
    for (const label of ['待办', '进行中', '审查中', '已完成', '受阻', '未知']) {
      expect(zhTasks).toContain(label)
    }
    expect(zhTasks).toContain('7 个计划')
    // The empty note localizes too (state null → muted no-plans, spec §8).
    const zhEmpty = panelHtml({ ...fullSource, state: null }, undefined, undefined, 'zh')
    expect(tasksSlice(zhEmpty)).toContain('暂无计划')
    expect(zhEmpty).toContain('data-zone-empty="no-plans"')
  })
})

/* ---------------------------------------------------------------------------
 * T6 tabs-shell Task 1 (spec panel-tabs §2/§6.1, plan 20260811-panel-tabs-
 * shell): the panel is re-laid-out as Tabs + Content — a resident right
 * sidebar shared by every tab, a fixed header nav (TabNav) with the 3
 * MenuTabs (任务迭代 / 代理执行 / 事件记录) and a content region that
 * switches per tab. `data-mstar-graph` now anchors the CONTENT container
 * (spec §6.1 — previously the canvas container). Default tab = 任务迭代 (D1);
 * the tasks tab renders the IterationTaskPage (Task 2 — Content Head +
 * full-width kanban); agents/events render muted
 * placeholder pages (`data-mstar-page-*`). Switching assertions ride the
 * exported TabNav (activation state per prop) + PanelContent (tab → page
 * mapping) — `renderToStaticMarkup` renders the useState default (tasks), so
 * per-tab content is pinned through the exported mapping component.
 * ------------------------------------------------------------------------- */

describe('workflow panel — T6 tabs-shell: resident sidebar + header nav + content switching (spec panel-tabs §2/§6.1)', () => {
  it('renders the 3 MenuTab anchors in the header nav, tasks active by default (D1)', () => {
    const html = panelHtml(fullSource)
    expect(html).toContain('data-mstar-tab-nav')
    for (const id of ['tasks', 'agents', 'events']) expect(html).toContain(`data-mstar-tab="${id}"`)
    // Default tab = tasks (D1): exactly one active tab, two inactive; the
    // active anchor sits on the tasks tab.
    expect(html.match(/data-mstar-tab-active="true"/g)).toHaveLength(1)
    expect(html.match(/data-mstar-tab-active="false"/g)).toHaveLength(2)
    expect(html).toMatch(/data-mstar-tab="tasks"[^>]*data-mstar-tab-active="true"/)
    // Tab labels render (en).
    expect(html).toContain('Task Iteration')
    expect(html).toContain('Agent Run')
    expect(html).toContain('Event Log')
  })

  it('TabNav flips the active anchor per prop (activation state follows the tab)', () => {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const t = locale.bind(NS)
    for (const active of ['tasks', 'agents', 'events'] as const) {
      const html = renderToStaticMarkup(createElement(TabNav, { active, onChange: () => {}, t }))
      expect(html).toMatch(new RegExp(`data-mstar-tab="${active}"[^>]*data-mstar-tab-active="true"`))
      expect(html.match(/data-mstar-tab-active="false"/g)).toHaveLength(2)
    }
  })

  it('content switches with the tab: tasks → IterationTaskPage, agents/events → muted placeholder pages', () => {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const t = locale.bind(NS)
    // tasks → the IterationTaskPage (Content Head + kanban, spec §3).
    const tasks = renderToStaticMarkup(createElement(PanelContent, { tab: 'tasks', source: fullSource, t }))
    expect(tasks).toContain('data-mstar-page="tasks"')
    expect(tasks).toContain('data-iteration-head')
    expect(tasks).toContain('data-zone="tasks"')
    expect(tasks).not.toContain('data-mstar-canvas')
    // agents → placeholder page (data-mstar-page anchor + muted copy).
    const agents = renderToStaticMarkup(createElement(PanelContent, { tab: 'agents', source: fullSource, t }))
    expect(agents).toContain('data-mstar-page="agents"')
    expect(agents).toContain('Agent run page lands in a later plan (agent canvas)')
    expect(agents).not.toContain('data-zone=')
    // events → placeholder page.
    const events = renderToStaticMarkup(createElement(PanelContent, { tab: 'events', source: fullSource, t }))
    expect(events).toContain('data-mstar-page="events"')
    expect(events).toContain('Event log page lands in a later plan')
    expect(events).not.toContain('data-zone=')
    // The sidebar lives at the PanelView root — no tab content carries it.
    for (const html of [tasks, agents, events]) expect(html).not.toContain('data-mstar-sidebar')
  })

  it('the resident sidebar renders outside the tab-switching region, present under the default (tasks) tab', () => {
    const html = panelHtml(fullSource)
    // data-mstar-graph = the content container (spec §6.1): it precedes the
    // sidebar, and the sidebar follows the whole main area.
    expect(html).toContain('data-mstar-graph')
    expect(html).toContain('data-mstar-sidebar')
    expect(html).toContain('data-mstar-sidebar-scroll')
    expect(html.indexOf('data-mstar-graph')).toBeLessThan(html.indexOf('data-mstar-sidebar'))
    // The default render still shows the tasks page inside content.
    expect(html.indexOf('data-mstar-graph')).toBeLessThan(html.indexOf('data-iteration-head'))
  })

  it('waiting / no-harness branches keep data-mstar-panel + freshness, no tabs, no sidebar', () => {
    const waiting = panelHtml(null)
    expect(waiting).toContain('data-mstar-panel="waiting"')
    expect(waiting).not.toContain('data-mstar-tab-nav')
    expect(waiting).not.toContain('data-mstar-sidebar')
    const noHarness = panelHtml(noHarnessSource)
    expect(noHarness).toContain('data-mstar-panel="no-harness"')
    expect(noHarness).toContain('data-mstar-freshness')
    expect(noHarness).toContain('data-mstar-graph')
    expect(noHarness).not.toContain('data-mstar-tab-nav')
    expect(noHarness).not.toContain('data-mstar-sidebar')
  })

  it('zh locale localizes the tab labels + placeholder copy', () => {
    const zhHtml = panelHtml(fullSource, undefined, undefined, 'zh')
    expect(zhHtml).toContain('任务迭代')
    expect(zhHtml).toContain('代理执行')
    expect(zhHtml).toContain('事件记录')
    // en tab labels must not leak into the zh body.
    expect(zhHtml).not.toContain('Task Iteration')
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('zh')
    const agents = renderToStaticMarkup(createElement(PanelContent, { tab: 'agents', source: fullSource, t: locale.bind(NS) }))
    expect(agents).toContain('data-mstar-page="agents"')
    expect(agents).toContain('代理执行页由后续 plan 交付')
  })
})
