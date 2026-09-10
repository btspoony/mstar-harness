/**
 * Render tests for the Morning Star workflow-viz panel page (Task 2 + Task 3):
 * the right-Sidebar pane body that renders the `mstar-engine-status`
 * catalog source (spec `panel-contract.md` §2/§3/§4).
 *
 * Coverage:
 * - full fixture (iteration + state + freshness): every section renders —
 *   the meta dock (version/harness, header removed), the
 *   IterationTaskPage on the tasks tab (Content Head with the vertical
 *   Step 1–5 stack + branches, and the five stacked kanban groups — the
 *   WorkflowCanvas zone dashboard is replaced by Task 2 and no longer
 *   renders here), plan status board, residual counts, branch/policy/lease
 *   anchors, knowledge digest, direction one-liner, last-updated marker;
 * - narrow-column shell (plan sidebar §L2.1/L2.2/L2.7): the root is a
 *   single flex column with three zones — the section nav (flex:none), the
 *   panel-owned scroll body (`[data-mstar-scroll]`, the ONLY overflow-y
 *   element, carrying `data-mstar-graph`), the pinned meta dock — the
 *   workspace-state digest IN FLOW at the end of the scroll body (its old
 *   nested scroller retired), no composer-overlay opt-in, `container-type`
 *   on the root with @container width rules and NO viewport media queries;
 * - section store (plan sidebar §L2.4): the selected section lives in the
 *   entry store keyed by the sidebar tab id (default 'tasks') and survives
 *   the body's unmount/remount cycle through the store;
 * - theme audit (spec panel-zones §7): EVERY color-family declaration is a
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
 *   through `useMstarEngineStatus(useChat)` — the fixture source rides a
 *   stub chat-target snapshot (`createSnapshotStore`), and a snapshot bump
 *   (new catalog row) re-renders the panel with fresh data + freshness;
 * - plugin entry: `apply(ctx)` registers the `mstar-panel` dictionaries and
 *   the sidebar body + chip-title seats (keyed `@mstar-harness/dsh`, the
 *   body's `locale: 'mstar-panel'`); the definition's shape is
 *   client-seat.spec.ts's subject;
 * - iteration-task page (spec panel-tabs §3
 *   Task 2): the Content Head — `data-iteration-head-*` anchors pin the
 *   collapse/expand defaults (active → expanded, inactive → collapsed one-line
 *   summary with the muted "not started" note + toggle affordance), the
 *   vertical 5-step stack (PHASE_IDS order, current/next/done/idle,
 *   current-step verdict) and the branches panel; the kanban anchors
 *   (`data-kanban-column` 5 stacked groups / `data-tasks-total` /
 *   `data-mstar-kanban`) ride the reused TaskBoard; css asserts the tasks
 *   area is flow content in the panel's single scroll body, the kanban
 *   groups stack (the ≥720px group grid reaches them), and the tasks
 *   subtree carries no horizontal scroller. The
 *   WorkflowCanvas-era render surfaces (zone frames, footer legend/gate
 *   summary, agent event dock, agent flow zone) are GONE from the tasks tab —
 *   their render tests migrate to the agent-canvas / event-log plans (the
 *   projection layer stays unit-tested in client-graph-projection.spec.ts);
 *   the react-flow-era orange notes are asserted absent; zh labels;
 *   garbage-proof totality.
 * - iteration zone (spec panel-f4 §2.3 R8/R9
 *   iteration-zone Task 2): the expanded head body is a LEFT-RIGHT split —
 *   branches (small half, DOM-first) + steps (large half), the
 *   `data-iteration-head-split` container present only while branches render;
 *   the verdict badge renders only for a current step with a real gate
 *   verdict (Phase 1 → Step 1 current, verdict unknown → NO badge) and every
 *   step reserves the fixed-height `data-step-verdict-seat` so the centered
 *   groups align (no `align-self` skew, no block shift).
 * - tabs-shell (spec panel-tabs §2/§6.1): the panel is laid out as
 *   section nav + content (plan sidebar §L2.1 — the workspace-state digest
 *   follows the content in the scroll-zone flow), fixed section nav
 *   (TabNav, 3 tabs) + per-tab content; `data-mstar-graph` anchors the
 *   scroll zone; default tab = 任务迭代 (D1); tab
 *   switching content assertions ride the exported TabNav + PanelContent;
 *   the agents tab renders the draggable AgentCanvasPage and the events tab
 *   the real EventLogPage (`data-mstar-page-*` + the `data-event-log-*`
 *   anchor family).
 * - event-log page (spec panel-tabs §5
 *   Task 2): the 事件记录 tab is a non-canvas log page — the Agent 流转事件 /
 *   违规记录 partitions (`data-event-log-section`), per-row expandable
 *   `<details>` rows (`data-event-log-details` / `data-event-log-field`
 *   full-catalog detail bodies — missing fields render「—», never fabricated),
 *   the muted empty states (`data-event-log-empty` both-empty +
 *   `data-event-log-empty-section` mixed), the unexpected-dispatch fold-in
 *   (`data-event-log-expected="false"` badge, never double-appended), and
 *   the AgentEventDock removal (zero `data-agent-event-dock` anchors —
 *   无双份日志 decision, spec §5).
 * - agent canvas (spec panel-tabs §4/§6.2
 *   Task 2): the agents tab is the draggable canvas page — `data-canvas-pan`
 *   exposes the pan transform (pointer-event drag helpers unit-tested +
 *   the deterministic `initialPan` SSR seam), `data-agent-entity` covers the
 *   full KNOWN_AGENTS roster (idle cards muted via `data-agent-idle`, lit
 *   cards carry the agent-name title + `data-agent-record` fields), and the
 *   expected/actual/next `data-agent-edge-*` lines exist per the AgentEdge
 *   model.
 *
 * Renderer: `react-dom/server.renderToStaticMarkup` over the real component
 * (dev-time seams installed from the npm registry; the `*.module.css` import
 * resolves to the raw
 * file-path string under `bun test`, so class attributes are dropped —
 * assertions pin `data-mstar-*` attributes, never class names).
 */

import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { clientExports } from './client-bundles.ts'
import { Context } from '@deepseek-ai/cordis'
import type { MstarEngineStatusPayload } from '../src/types'
import { MstarEngineStatusClient } from '../src/client/panel/engine-status-client'
import {
  anchorRow,
  bindUseSessions,
  chatSnapshot,
  gatewayError,
  gatewayOk,
  SESSION,
  SESSION_CWD,
  SESSION_ID,
  servedSnapshot,
  settleRender,
  stubGateway,
  unavailableResult,
  userNode,
  visibleTabKit,
} from './gateway-stub.ts'
import type { AgentFlowEventView, AgentFlowView } from '../src/types'
import type { EnforcementSource } from '@mstar-harness/engine'
import { apply } from '../src/client/index'
import { KNOWN_AGENTS } from '../src/client/panel/graph/schema'
import { projectGraph, type ZoneView } from '../src/client/panel/graph/project-graph'
import {
  AgentCanvasPage,
  layoutAgents,
  panDragMove,
  panDragStart,
  panTransform,
  UNKNOWN_COLUMN,
  PAN_ORIGIN,
  type PanState,
} from '../src/client/panel/pages/AgentCanvasPage'

// The REAL client service values — the store is a plain Node-ESM module
// (direct import); SlotRegistry / LocaleRuntime are cordis services loaded
// from the browser bundles through the loader shim (ctx).
type RendererClientExports = typeof import('@deepseek-ai/dsh-client-ui-renderer/client')
const { SlotRegistry: SlotRegistryCtor } = clientExports('@deepseek-ai/dsh-client-ui-renderer') as unknown as
  Pick<RendererClientExports, 'SlotRegistry'>
type LocaleClientExports = typeof import('@deepseek-ai/dsh-client-locale/client')
const { LocaleRuntime: LocaleRuntimeCtor } = clientExports('@deepseek-ai/dsh-client-locale') as unknown as
  Pick<LocaleClientExports, 'LocaleRuntime'>

/** One real SlotRegistry over a fresh cordis context (services are ctx-bound). */
function newSlots(): SlotRegistry {
  return new SlotRegistryCtor(new Context())
}

/** One real LocaleRuntime over a fresh cordis context. */
function newLocale(): LocaleRuntime {
  return new LocaleRuntimeCtor(new Context())
}
import { en, NS, zh } from '../src/client/panel/locale'
import { PanelContent, PanelView, type MstarPanelBodyProps } from '../src/client/panel/PanelView'
import { TabNav } from '../src/client/panel/TabNav'
import { IterationTaskPage } from '../src/client/panel/pages/IterationTaskPage'
import {
  IterationInfoSection,
  iterationSplitActive,
  nextExpandedOnActivation,
} from '../src/client/panel/pages/IterationInfoSection'
import { EventLogPage } from '../src/client/panel/pages/EventLogPage'
import { toggleKanbanExpanded, visibleKanbanPlans } from '../src/client/panel/zones/TaskBoard'
import { PLAN_CAP } from '../src/client/panel/plan-sort'

/** Full fixture: every field the panel renders (spec §2.1–§2.3). */
const fullSource: MstarEngineStatusPayload = {
  version: '2.0.4',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: true, source: 'iteration compass' as EnforcementSource },
  iteration: {
    iterationId: 'iter-00000809-dsh-workflow-viz',
    statusPath: '/proj/.mstar/status.json',
    compassPath: '/proj/.mstar/iterations/iter-00000809-dsh-workflow-viz/delivery-compass.md',
    gate: {
      transition: 'phase-2-execute',
      all_plans_done: false,
      ok: true,
      entry: { ok: true, violations: [] },
      exit: { ok: true, violations: [] },
      violations: [
        { severity: 'medium', code: 'PLAN-3', message: 'plan  not complete' },
        { severity: 'low', code: 'EXIT-1', message: 'minor wording drift in the compass' },
      ],
    },
  },
  state: {
    selection: { kind: 'active', workflowId: 'iter-00000809-dsh-workflow-viz', dir: 'workflows/iter-00000809-dsh-workflow-viz' },
    workflowType: 'plan',
    workflowStatus: 'running',
    plans: [
      { id: '00000809-dsh-workflow-viz-panel', status: 'InProgress', doneAt: null, iterationRefs: [] },
      { id: '00000808-dsh-package-core', status: 'Done', doneAt: '2026-08-08', iterationRefs: [] },
    ],
    residuals: [
      { severity: 'high', count: 2 },
      { severity: 'medium', count: 1 },
    ],
    residualFindings: [
      { planId: '00000808-dsh-package-core', id: 'R1', severity: 'high', title: 'doneAt passthrough untested' },
      { planId: '00000809-dsh-workflow-viz-panel', id: 'R2', severity: 'medium', title: 'header removal doc drift' },
    ],
    project: { milestones: [], openResiduals: [] },
    iterationBaseBranch: 'dev-dsh',
    targetBranch: 'dev-dsh',
    specIntegrationBranch: 'iteration/iter-00000809-dsh-workflow-viz',
    pushPolicy: 'push authorized',
    worktreeMode: 'feature-worktree',
    controlWorktreePath: '/Users/bibi/workspace/ai/mstar-workflow',
    leases: [
      {
        planId: '00000809-dsh-workflow-viz-panel',
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
const noHarnessSource: MstarEngineStatusPayload = {
  version: '2.0.4',
  harnessDir: null,
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: null,
}

/** Harness present but no iteration key ⇒ no-gate state; state renders normally (spec §3). */
const noGateSource: MstarEngineStatusPayload = {
  version: '2.0.4',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: {
    selection: { kind: 'active', workflowId: 'wf-1', dir: 'workflows/wf-1' },
    workflowType: 'plan',
    workflowStatus: 'running',
    plans: [{ id: '00000809-dsh-workflow-viz-panel', status: 'InProgress', doneAt: null, iterationRefs: [] }],
    residuals: [],
    residualFindings: null,
    project: { milestones: [], openResiduals: [] },
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
const failGateSource: MstarEngineStatusPayload = {
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
} as unknown as MstarEngineStatusPayload

/**
 * Session-standard kit the sidebar body seat hands every dispatch: the chat
 * selector, the Host session list (the panel reads the session's `cwd`
 * from it — the host cross-checks the asserted cwd), the session identity,
 * the plugin's engine-status client, and the visible-tab fixture kit (the
 * seat's tab-information hook + the entry-store share — plan sidebar §L2.4;
 * the hidden-tab gate is client-seat.spec.ts's subject).
 */
function kitProps(overrides?: Partial<MstarPanelBodyProps>): MstarPanelBodyProps {
  const kit = visibleTabKit()
  return {
    sessionId: SESSION,
    useChat: (() => null) as never,
    useSessions: bindUseSessions(SESSION_ID, SESSION_CWD) as never,
    ...kit,
    ...overrides,
  } as unknown as MstarPanelBodyProps
}

/**
 * Plain selector binding over the stub snapshot store — the dev-time twin of
 * the real uSES binding (web-react `bindSnapshotSelector`): selection applies
 * to the store's current snapshot; a `store.set` bump is picked up on the next
 * render, mirroring the snapshot-bump refresh semantics (spec §5).
 */
function bindUseChat(store: { getSnapshot(): ChatSnapshot }): SnapshotSelectorHook<ChatSnapshot> {
  return function useSelector<S>(sel: (s: ChatSnapshot) => S): S {
    return sel(store.getSnapshot())
  }
}

/**
 * Build a chat-target snapshot carrying the ANCHOR row at the given time
 * (`null` = the plugin never ran on this session). The row itself carries NO
 * payload — the persisted source is the locked three-member arm and the
 * payload is served over the `/api` gateway (spec §5 data path).
 */
function snapshotFor(source: MstarEngineStatusPayload | null, lastUpdated: number | null): ChatSnapshot {
  const nodes: ConversationNode[] = [
    { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
  ]
  if (source !== null) nodes.push(anchorRow(2, lastUpdated ?? ANCHOR_TIME))
  return {
    legacy: {
      nodes,
      turnTimings: new Map(),
      turnEnds: new Map(),
      partial: null,
      runningCalls: [],
    },
  } as unknown as ChatSnapshot
}

/** The fixture anchor row's message time (the specs' default). */
const ANCHOR_TIME = 1_720_001_000_000

/** One gateway stub serving the fixture payload as the host's stored snapshot. */
function gatewayFor(source: MstarEngineStatusPayload | null, at: number | null = ANCHOR_TIME): ReturnType<typeof stubGateway> {
  return stubGateway(servedSnapshot(source, { at: new Date(at ?? ANCHOR_TIME).toISOString() }))
}

/** One locale seat with the panel dictionaries registered exactly once. */
function panelLocale(lang: 'en' | 'zh'): LocaleRuntime {
  const locale = newLocale()
  locale.register(NS, { zh, en })
  locale.setLocale(lang)
  return locale
}

/** One panel fixture: locale + log store + gateway stub + the client over it. */
interface PanelFixture {
  readonly locale: LocaleRuntime
  readonly store: { getSnapshot(): ChatSnapshot }
  readonly gateway: ReturnType<typeof stubGateway>
  readonly engineStatus: MstarEngineStatusClient
}

/** Bind one fixture (the client is created ONCE so both passes share its cache). */
function panelFixture(
  locale: LocaleRuntime,
  store: { getSnapshot(): ChatSnapshot },
  gateway: ReturnType<typeof stubGateway>,
): PanelFixture {
  return { locale, store, gateway, engineStatus: new MstarEngineStatusClient(gateway.connection) }
}

/** One synchronous render pass of the panel over the given fixture. */
function renderPanelPass(content: PanelFixture): string {
  return renderToStaticMarkup(createElement(PanelView, {
    ...kitProps({ useChat: bindUseChat(content.store) }),
    engineStatus: content.engineStatus,
    t: content.locale.bind(NS),
  } as never))
}

/**
 * Render the panel to static HTML through the real data path: anchor snapshot
 * store → useChat/useSessions → hook → `/api` gateway → PanelView. The first
 * pass issues the gateway call; the returned markup is the settled one
 * (default copy pinned to en).
 */
async function panelHtml(
  source: MstarEngineStatusPayload | null,
  locale: LocaleRuntime = newLocale(),
  lastUpdated: number | null = ANCHOR_TIME,
  lang: 'en' | 'zh' = 'en',
): Promise<string> {
  const store = createSnapshotStore(snapshotFor(source, lastUpdated))
  const gateway = gatewayFor(source, lastUpdated)
  const seat = locale === undefined ? panelLocale(lang) : locale
  if (locale !== undefined) {
    locale.register(NS, { zh, en })
    locale.setLocale(lang)
  }
  const fixture = panelFixture(seat, store, gateway)
  return settleRender(() => renderPanelPass(fixture))
}

/**
 * One dispatch row as the T1 ledger view emits it (spec §2.2) — the canvas
 * evidence fixture (same shape the projection spec's `dispatchRow` builds).
 */
function dispatchEvent(over: {
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

/** One settle row as the T1 ledger view emits it (spec §2.2 — carries the PAIRED dispatch identity when `role` is given,). */
function settleEvent(over: { ts: number; agent?: string; outcome?: 'ok' | 'error' | 'denied'; role?: string; planId?: string; taskId?: string }): AgentFlowEventView {
  return {
    ts: over.ts,
    kind: 'settle',
    agent: over.agent ?? null,
    role: over.role ?? '',
    planId: over.planId ?? null,
    taskId: over.taskId ?? null,
    taskCategory: null,
    ...(over.role !== undefined ? { paired: true } : {}),
    ...(over.outcome !== undefined ? { outcome: over.outcome } : {}),
  }
}

/** A full source whose `state.agentFlow` carries the given events (latest-first). */
function flowSource(events: readonly unknown[]): MstarEngineStatusPayload {
  return {
    ...fullSource,
    state: {
      ...fullSource.state!,
      agentFlow: { events, summary: [] } as unknown as AgentFlowView,
    },
  }
}

/** Render the AgentCanvasPage to static HTML (en locale; optional pan seed). */
function agentsHtml(source: MstarEngineStatusPayload, initialPan?: PanState): string {
  const locale = newLocale()
  locale.register(NS, { zh, en })
  locale.setLocale('en')
  const view = projectGraph(source)
  return renderToStaticMarkup(createElement(AgentCanvasPage, {
    view: view.agents,
    iteration: view.iteration,
    t: locale.bind(NS),
    ...(initialPan !== undefined ? { initialPan } : {}),
  }))
}

/** The SSR markup of one entity card (the `<li data-agent-entity=...>` region). */
function cardRegion(html: string, key: string): string {
  const start = html.indexOf(`data-agent-entity="${key}"`)
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('</li>', start)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end)
}

describe('workflow panel — full fixture renders every section (spec §2)', () => {
  let html = ''
  beforeAll(async () => { html = await panelHtml(fullSource) })

  it('renders the sidebar meta dock (version / harness dir, watermark preserved)', async () => {
    expect(html).toContain('data-mstar-meta')
    expect(html).toContain('data-mstar-meta-version')
    expect(html).toContain('data-mstar-meta-harness')
    // `data-mstar-watermark` moved here from the removed header (anchor lineage).
    expect(html).toContain('data-mstar-watermark')
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
  })

  it('renders the IterationTaskPage (content head + full-width kanban) in the main area (T7)', async () => {
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

  it('renders the additive project rollup zone (roadmap milestones + open residual severity counts) on the tasks page', async () => {
    const rollupSource: MstarEngineStatusPayload = {
      ...fullSource,
      state: {
        ...fullSource.state!,
        project: {
          milestones: ['P1 foundation', 'P2 migrate + dogfood'],
          openResiduals: [
            { severity: 'critical', count: 1 },
            { severity: 'medium', count: 2 },
          ],
        },
      },
    }
    const html = await panelHtml(rollupSource)
    expect(html).toContain('data-zone="project"')
    expect(html).toContain('data-project-milestones-title')
    expect(html).toContain('data-project-milestone')
    expect(html).toContain('P1 foundation')
    expect(html).toContain('P2 migrate + dogfood')
    expect(html).toContain('data-project-residuals-title')
    expect(html).toContain('data-project-residual')
    expect(html).toContain('data-project-residual-count="1"')
    expect(html).toContain('data-project-residual-count="2"')
    // The four existing zones still render (additive-only, compass AC-4).
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-iteration-head')
  })

  it('renders the state section: plans board, residual findings, policy (enforcement first), leases, knowledge, direction', async () => {
    expect(html).toContain('data-mstar-section="state"')
    // Plan status board: id(status) rows.
    expect(html).toContain('data-plan-id="00000809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
    expect(html).toContain('data-plan-id="00000808-dsh-package-core"')
    expect(html).toContain('data-plan-status="Done"')
    // Residual findings: R# id + severity chip + title/planId (spec §5).
    expect(html).toContain('data-residual-finding')
    expect(html).toContain('data-residual-finding-id="R1"')
    expect(html).toContain('data-residual-finding-id="R2"')
    expect(html).toContain('data-residual-finding-severity="high"')
    expect(html).toContain('data-residual-finding-severity="medium"')
    expect(html).toContain('doneAt passthrough untested')
    expect(html).toContain('data-residual-finding-plan="00000809-dsh-workflow-viz-panel"')
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
    //) — the branch anchors are gone.
    expect(html).not.toContain('data-field="iteration-base-branch"')
    expect(html).not.toContain('data-field="target-branch"')
    expect(html).not.toContain('data-field="spec-integration-branch"')
    // Lease anchors.
    expect(html).toContain('data-lease-plan="00000809-dsh-workflow-viz-panel"')
    expect(html).toContain('dsh-web-mstar-workflow')
    // Knowledge digest.
    expect(html).toContain('data-knowledge-docs="3"')
    expect(html).toContain('architecture-patterns')
    expect(html).toContain('tooling-decisions')
    // Direction one-liner.
    expect(html).toContain('data-direction')
    expect(html).toContain('dsh is highly customizable (client plugins + slot registry)')
  })

  it('renders the freshness marker (the served snapshot\u2019s own emission, never "live")', async () => {
    expect(html).toContain('data-mstar-freshness')
    // The freshness marker is the SERVED snapshot's own `at` (never "live") …
    expect(html).toMatch(/snapshot\s+\S+/)
    expect(html).toContain(`data-mstar-freshness-at="${new Date(ANCHOR_TIME).toISOString()}"`)
    // … plus the agent turn it was written for, so the footer names WHICH
    // emission the panel is showing. That is what keeps it true when the
    // current turn's write failed and the stored entry is an earlier one: the
    // copy names the store's record instead of claiming to be the last emission.
    expect(html).toContain('data-mstar-freshness-turn="')
    expect(html).toMatch(/turn\s+\d+/)
    expect(html).toContain('the stored snapshot for this session')
    // …and it must NOT re-introduce the claim that this is the last emission.
    expect(html).not.toContain('last catalog emission')
  })
})

describe('workflow panel — empty states and degradation (spec §3, §2.4)', () => {
  it('no catalog row (source null) → waiting hint, no crash', async () => {
    const html = await panelHtml(null)
    expect(html).toContain('data-mstar-panel="waiting"')
    expect(html).toContain('Waiting for the first engine-status catalog')
  })

  it('no harness (harnessDir null + state null + no iteration) → no-harness hint + freshness, no meta dock', async () => {
    const html = await panelHtml(noHarnessSource)
    expect(html).toContain('data-mstar-panel="no-harness"')
    expect(html).toContain('No Morning Star harness detected')
    expect(html).toContain('data-mstar-freshness')
    // No sidebar / meta dock in the no-harness branch (hint + freshness only).
    expect(html).not.toContain('data-mstar-meta')
    expect(html).not.toContain('data-mstar-sidebar')
  })

  it('no gate (harness present, iteration key absent) → collapsed muted head, kanban skeleton, state still renders, no orange note', async () => {
    const html = await panelHtml(noGateSource)
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
    expect(html).toContain('data-plan-id="00000809-dsh-workflow-viz-panel"')
    // Empty state lists degrade to "none" rather than crashing.
    expect(html).toContain('data-mstar-empty="no-residuals"')
    expect(html).toContain('data-mstar-empty="no-leases"')
    expect(html).toContain('data-mstar-empty="no-knowledge"')
  })

  it('iteration: null (schema-drift variant of "absent") → same muted collapsed head, never a crash (AC-3)', async () => {
    const html = await panelHtml({
      ...noGateSource,
      iteration: null,
    } as unknown as MstarEngineStatusPayload)
    expect(html).toContain('data-mstar-panel="panel"')
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('data-iteration-head-active="false"')
    expect(html).toContain('data-iteration-head-expanded="false"')
    expect(html).toContain('iteration not started')
    expect(html).not.toContain('data-graph-empty="no-compass"')
    expect(html).toContain('data-mstar-section="state"')
  })

  it('missing version degrades the meta dock to unknown, no guessed values', async () => {
    const html = await panelHtml(degradedSource)
    expect(html).toContain('mstar unknown')
  })

  it('partial state (null direction, empty lists) renders without crashing', async () => {
    const html = await panelHtml({
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
  it('gate.ok false → FAIL verdict in the content head summary (data-iteration-head-verdict)', async () => {
    const html = await panelHtml(failGateSource)
    expect(html).toContain('data-iteration-head-verdict="fail"')
    expect(html).toContain('FAIL')
    // The old footer gate-summary surface is gone with the WorkflowCanvas.
    expect(html).not.toContain('data-graph-verdict')
    expect(html).not.toContain('data-graph-violations-count')
  })

  it('renders the panel body in zh when the locale flips (not just the tab label)', async () => {
    const html = await panelHtml(fullSource, undefined, undefined, 'zh')
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('迭代启动')
    expect(html).toContain('任务')
    expect(html).toContain('代理执行')
    expect(html).toContain('data-mstar-section="state"')
    expect(html).toContain('工作区状态')
    expect(html).toContain('3 篇文档')
    expect(html).toContain('快照')
    // en graph labels must not leak into the zh body.
    expect(html).not.toContain('Autonomous Execute')
    expect(html).not.toContain('Workspace state')
  })
})

describe('workflow panel — data wiring through the hook (spec §5)', () => {
  /**
   * Render the panel against a live snapshot store and a gateway stub (the
   * real PanelView + useMstarEngineStatus path). The first pass issues the
   * gateway call, so a snapshot bump between two calls asks again.
   */
  async function renderAgainst(
    store: { getSnapshot(): ChatSnapshot },
    locale: LocaleRuntime,
    gateway: ReturnType<typeof stubGateway> = gatewayFor(fullSource),
  ): Promise<string> {
    const fixture = panelFixture(locale, store, gateway)
    return settleRender(() => renderPanelPass(fixture))
  }

  it('several anchor rows ask for ONE snapshot — the newest anchor drives the request (spec §2.4)', async () => {
    const store = createSnapshotStore<ChatSnapshot>({
      legacy: {
        nodes: [
          { kind: 'user', seq: 1, time: 1_719_999_000_000, content: [], source: null },
          anchorRow(2, 1_720_000_000_000),
          anchorRow(4, 1_720_001_000_000),
        ],
        turnTimings: new Map(),
        turnEnds: new Map(),
        partial: null,
        runningCalls: [],
      },
    } as unknown as ChatSnapshot)
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    // The gateway serves the payload of the session's newest snapshot.
    const gateway = gatewayFor({ ...fullSource, version: '2.0.4' })
    const html = await renderAgainst(store, locale, gateway)
    expect(html).toContain('mstar 2.0.4')
    expect(gateway.calls).toHaveLength(1)

    // A newer anchor row asks again (the log tail is the refresh signal).
    store.set(chatSnapshot([userNode(), anchorRow(6, 1_720_002_000_000)]))
    gateway.reply(servedSnapshot({ ...fullSource, version: '2.0.5' }, { at: new Date(1_720_002_000_000).toISOString() }))
    const after = await renderAgainst(store, locale, gateway)
    expect(after).toContain('mstar 2.0.5')
    expect(gateway.calls).toHaveLength(2)
  })

  it('a new catalog row (snapshot bump = refresh signal) re-renders the panel with fresh data', async () => {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const store = createSnapshotStore(snapshotFor(fullSource, 1_720_000_000_000))
    const gateway = gatewayFor(fullSource, 1_720_000_000_000)

    const before = await renderAgainst(store, locale, gateway)
    expect(before).toContain('mstar 2.0.4')
    expect(before).toContain('harness: /proj/.mstar')
    expect(before).toContain('data-mstar-freshness')
    expect(before).toContain(`data-mstar-freshness-at="${new Date(1_720_000_000_000).toISOString()}"`)

    // Server re-emission appends a newer anchor row → snapshot bump → the hook
    // re-scans, asks the gateway for the newer snapshot and re-renders.
    const refreshed = { ...fullSource, version: '2.0.5', harnessDir: '/proj2/.mstar' }
    gateway.reply(servedSnapshot(refreshed, { at: new Date(1_720_002_000_000).toISOString() }))
    store.set(snapshotFor(fullSource, 1_720_002_000_000))
    const after = await renderAgainst(store, locale, gateway)
    expect(after).toContain('mstar 2.0.5')
    expect(after).toContain('harness: /proj2/.mstar')
    expect(after).not.toContain('harness: /proj/.mstar')
    expect(after).toContain(`data-mstar-freshness-at="${new Date(1_720_002_000_000).toISOString()}"`)
  })
})

describe('workflow panel — plugin entry registers locale + the sidebar seats (spec §4)', () => {
  /** Real cordis context over the real services (slots + locale + sessions faces). */
  function makeCtx(): { ctx: Context; slots: SlotRegistry; locale: LocaleRuntime } {
    const ctx = new Context()
    const slots = new SlotRegistryCtor(ctx)
    const locale = new LocaleRuntimeCtor(ctx)
    // LocaleRuntime is a plain class (not a cordis Service) — attach the
    // faces the plugin's client entry injects (slots registers itself).
    ;(ctx as unknown as Record<string, unknown>).locale = locale
    ;(ctx as unknown as Record<string, unknown>).sessions = {}
    // The tab-type registry is the host's service — a recording double keeps
    // this describe on the apply-wiring face (the definition's full shape is
    // client-seat.spec.ts's subject).
    const registered: unknown[] = []
    ;(ctx as unknown as Record<string, unknown>).sidebarRightTabs = {
      register: (definition: unknown) => {
        registered.push(definition)
        return () => {
          const at = registered.indexOf(definition)
          if (at >= 0) registered.splice(at, 1)
        }
      },
    }
    return { ctx, slots, locale }
  }

  /** Declare the sidebar seat chain exactly like ui-sidebar-right apply. */
  function declareRightbar(slots: SlotRegistry): () => void {
    slots.register({
      name: 'root' as 'sidebar.right.pane.tab',
      children: { rightbar: { kind: 'single', scope: 'root' } },
    } as never, () => null)
    slots.register({
      name: 'rightbar' as 'sidebar.right.pane.tab',
      children: { 'rightbar.session': { kind: 'single', scope: 'session' } },
    } as never, () => null)
    return slots.register({
      name: 'rightbar.session' as 'sidebar.right.pane.tab',
      children: {
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: () => () => ({ tab: { visible: true } }) } } },
        'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: () => () => ({ tab: { visible: true } }) } } },
      },
    } as never, () => null)
  }

  it('registers the mstar-panel dictionaries on apply', async () => {
    const { ctx, locale } = makeCtx()
    apply(ctx)
    // Pin zh: the real LocaleRuntime's initial locale is browser/persisted
    // derived (the removed peer-stub defaulted to the first-registered one).
    locale.setLocale('zh')
    expect(locale.bind(NS)('view.mstar-workflow')).toBe('MStar 工作流')
  })

  it('registers the sidebar body + title seats (keyed @mstar-harness/dsh, locale + entry store)', async () => {
    const { ctx, slots, locale } = makeCtx()
    apply(ctx)
    // Not declared yet: the inject callbacks must wait.
    expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(0)

    const disposeRightbar = declareRightbar(slots)
    locale.setLocale('zh')
    const bodies = slots.entries('sidebar.right.pane.tab')
    const titles = slots.entries('sidebar.right.pane.tab.title')
    expect(bodies).toHaveLength(1)
    expect(titles).toHaveLength(1)
    expect(bodies[0]!.options.key).toBe('@mstar-harness/dsh')
    expect(titles[0]!.options.key).toBe('@mstar-harness/dsh')
    expect(bodies[0]!.locale).toBe(NS)
    // The body seat declares the entry store (plan sidebar §L2.4) — the
    // props share (`useStore` + baked actions) is backed by it. The core
    // records the declared store seat on the stored entry (top-level member).
    expect(bodies[0]!.store).toBeDefined()

    disposeRightbar()
  })
})

describe('workflow panel — T2 narrow-column shell: three zones / single scroll owner / digest in flow (plan sidebar §L2)', () => {
  let html = ''
  beforeAll(async () => { html = await panelHtml(fullSource) })

  it('the meta dock renders version + harness dir (header removed)', async () => {
    // The old 3-cell header is gone; version/harness live in the pinned meta dock.
    expect(html).not.toContain('data-mstar-header')
    expect(html).not.toContain('data-mstar-header-cell')
    expect(html).toContain('data-mstar-meta')
    expect(html).toContain('data-mstar-meta-version')
    expect(html).toContain('data-mstar-meta-harness')
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
  })

  it('shell DOM: nav → scroll(=graph) → page → digest → freshness → meta, in one column', async () => {
    // The three flex zones of §L2.1, in order: the section nav, the scroll
    // zone (which carries the content-container anchor `data-mstar-graph`),
    // the pinned meta dock. The digest renders IN FLOW inside the scroll
    // body after the active page; the freshness footer follows it.
    expect(html).toContain('data-mstar-tab-nav')
    expect(html).toContain('data-mstar-scroll')
    expect(html).toContain('data-mstar-graph')
    expect(html).toContain('data-mstar-sidebar')
    expect(html).toContain('data-mstar-meta')
    expect(html.match(/data-mstar-scroll/g)).toHaveLength(1)
    // The scroll zone IS the graph content container (one anchor, one zone).
    expect(html.indexOf('data-mstar-tab-nav')).toBeLessThan(html.indexOf('data-mstar-scroll'))
    expect(html.indexOf('data-mstar-scroll')).toBeLessThan(html.indexOf('data-iteration-head'))
    expect(html.indexOf('data-iteration-head')).toBeLessThan(html.indexOf('data-mstar-sidebar'))
    expect(html.indexOf('data-mstar-sidebar')).toBeLessThan(html.indexOf('data-mstar-freshness'))
    expect(html.indexOf('data-mstar-freshness')).toBeLessThan(html.indexOf('data-mstar-meta'))
    // The digest's nested scroller is RETIRED — the digest is flow content.
    expect(html).not.toContain('data-mstar-sidebar-scroll')
  })

  it('root + zone CSS pin the narrow-column shell: flex zones, container-type, @container rules, NO viewport media queries (plan sidebar §L2.1/L2.7)', () => {
    const cssText = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    // The root is the three-zone flex column bound to the pane body's
    // definite height — no shell grid areas, no page scroll.
    expect(cssText).toMatch(/\.root\s*\{[\s\S]*?display:\s*flex[\s\S]*?flex-direction:\s*column/)
    expect(cssText).toMatch(/\.root\s*\{[\s\S]*?height:\s*100%/)
    expect(cssText).toMatch(/\.root\s*\{[\s\S]*?min-height:\s*0/)
    expect(cssText).toMatch(/\.root\s*\{[\s\S]*?overflow:\s*hidden/)
    expect(cssText).toMatch(/\.root\s*\{[\s\S]*?container-type:\s*inline-size/)
    expect(cssText).not.toContain('grid-template-areas')
    // Zone flex contract: nav and meta dock are flex:none — they cannot move;
    // the scroll zone takes the rest and is the ONLY scroller.
    expect(cssText).toMatch(/\.tabNav\s*\{[\s\S]*?flex:\s*none/)
    expect(cssText).toMatch(/\.scroll\s*\{[\s\S]*?flex:\s*1\s+1\s+auto/)
    expect(cssText).toMatch(/\.scroll\s*\{[\s\S]*?min-height:\s*0/)
    expect(cssText).toMatch(/\.scroll\s*\{[\s\S]*?overflow-y:\s*auto/)
    expect(cssText).toMatch(/\.scroll\s*\{[\s\S]*?overflow-x:\s*hidden/)
    expect(cssText).toMatch(/\.meta\s*\{[\s\S]*?flex:\s*none/)
    // Singular scroll ownership (§L2.2): exactly ONE overflow-y declaration
    // in the shell CSS and it lives on .scroll; NO element declares an
    // overflow-x scroller. The tasks subtree's own module css (zones) is
    // swept too: its former `.kanban` horizontal scroller is retired with
    // the stacked groups. The events subtree joins the sweep with its flow-row
    // conversion: both partition scrollers and the whole-page overflow rule
    // are retired. (The canvas module dies with the agents task — the
    // whole-panel sweep is theirs.)
    const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '')   // comments off — scan declarations only
    const overflowY = [...stripped.matchAll(/overflow-y:\s*([^;}]+)/g)].map((m) => m[1]!.trim())
    expect(overflowY).toEqual(['auto'])
    const scrollBlock = stripped.match(/\.scroll\s*\{[^}]*overflow-y: auto[^}]*\}/)
    expect(scrollBlock).not.toBeNull()
    expect(scrollBlock![0]).toContain('overflow-x: hidden')
    expect(stripped).not.toMatch(/overflow-x:\s*(?:auto|scroll)/)
    const zonesStripped = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect([...zonesStripped.matchAll(/overflow-y:\s*([^;}]+)/g)]).toEqual([])
    expect(zonesStripped).not.toMatch(/overflow-x:\s*(?:auto|scroll)/)
    const eventsStripped = readFileSync(new URL('../src/client/panel/pages/event-log.module.css', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(eventsStripped).not.toMatch(/overflow(?:-x|-y)?:/)   // no scroller, no clip — flow content only
    expect(eventsStripped).not.toMatch(/@media\s*\((?:max|min)-width:/)   // the width signal is the shell's container system
    // Width signal (§L2.7): container queries only — the two obsolete
    // viewport media queries are deleted (reduced-motion is not a width query).
    expect(cssText).toMatch(/@container\s*\(max-width:\s*480px\)/)
    expect(cssText).toMatch(/@container\s*\(min-width:\s*720px\)/)
    expect(cssText).toMatch(/@container\s*\(min-width:\s*720px\)\s*\{[\s\S]*?\.groupGrid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(280px,\s*1fr\)\)/)
    expect(cssText).toMatch(/\.groupGrid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(cssText).not.toMatch(/@media\s*\((?:max|min)-width:/)
    // Spacing ramp tokens defined at the panel root (spec §1.2).
    expect(cssText).toMatch(/--mstar-space-[1-6]:\s*\d+px/)
  })

  it('the composer-overlay opt-in is GONE: no attribute, no --dsh-composer-height reserve (plan sidebar §L1.5 row)', async () => {
    // The sidebar pane body is already a definite-height box (L0.12), so the
    // old conversation-view opt-in (attribute + composer-height padding
    // reserve) has no reason to exist — inverted from the pre-migration
    // assertion, which required it.
    expect(html).not.toContain('data-conversation-composer-overlay')
    const cssText = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    expect(cssText).not.toContain('--dsh-composer-height')
    expect(cssText).not.toMatch(/padding-bottom:\s*calc\(/)
  })

  it('the digest renders in flow: state section inside the scroll body, meta dock after the scroll zone', async () => {
    expect(html).toContain('data-mstar-sidebar')
    expect(html).toContain('data-mstar-section="state"')
    expect(html).toContain('data-plan-id="00000809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-residual-finding-severity="high"')
    expect(html).toContain('data-knowledge-docs="3"')
    expect(html).toContain('data-lease-plan="00000809-dsh-workflow-viz-panel"')
    // The digest content lives in the scroll body's flow (after the active
    // page); the pinned meta dock follows the whole scroll zone (data-plan-id
    // also appears earlier in the graph node plan rows, so order is pinned
    // against the sidebar's own state section marker).
    expect(html.indexOf('data-mstar-sidebar')).toBeLessThan(html.indexOf('data-mstar-section="state"'))
    expect(html.indexOf('data-mstar-section="state"')).toBeLessThan(html.indexOf('data-mstar-meta'))
    // The meta dock renders outside the scroll zone (watermark lineage preserved).
    expect(html.indexOf('data-mstar-sidebar')).toBeLessThan(html.indexOf('data-mstar-watermark'))
  })

  it('the selection seat renders the aggregated workflow — active / multi-active warning / terminal history / selection error ', async () => {
    // Active without warning (the full fixture).
    expect(html).toContain('data-selection-kind="active"')
    expect(html).toContain('data-selection-workflow="iter-00000809-dsh-workflow-viz"')
    expect(html).not.toContain('data-selection-warning')

    // Multi-active → the structured warning is surfaced (no silent pick).
    const warned = await panelHtml({
      ...fullSource,
      state: {
        ...fullSource.state!,
        selection: {
          kind: 'active',
          workflowId: 'wf-a',
          dir: 'workflows/wf-a',
          warning: { code: 'workflow.selection.multi-active', message: '2 active lifecycles in status.json workflows[] — selected the first (wf-a); no silent pick' },
        },
      },
    })
    expect(warned).toContain('data-selection-warning')
    expect(warned).toContain('2 active lifecycles')

    // Terminal history view → the history marker renders beside the id.
    const terminal = await panelHtml({
      ...fullSource,
      state: { ...fullSource.state!, selection: { kind: 'terminal', workflowId: 'wf-old', dir: 'workflows/wf-old' } },
    })
    expect(terminal).toContain('data-selection-kind="terminal"')
    expect(terminal).toContain('data-selection-workflow="wf-old"')
    expect(terminal).toContain('data-selection-history')

    // Selection error → code + reason rendered, never a crash.
    const errored = await panelHtml({
      ...fullSource,
      state: {
        ...fullSource.state!,
        selection: { kind: 'error', code: 'workflow.selection.snapshot-unreadable', message: 'cannot read the selected workflow snapshot /proj/.mstar/workflows/wf-ghost/snapshot.json' },
      },
    })
    expect(errored).toContain('data-selection-kind="error"')
    expect(errored).toContain('data-selection-code="workflow.selection.snapshot-unreadable"')
    expect(errored).toContain('cannot read the selected workflow snapshot')
  })

  it('the scroll zone renders the IterationTaskPage inside the flow (T7 fills the tasks tab)', async () => {
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

describe('workflow panel — T2 section store: keyed by tab id, default tasks, survives remount via the store (plan sidebar §L2.4)', () => {
  it('an untouched store reads the tasks default (D1, SSR-stable)', async () => {
    const html = await panelHtml(fullSource)
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toMatch(/data-mstar-tab="tasks"[^>]*data-mstar-tab-active="true"/)
  })

  it('a selection survives the body\'s unmount/remount cycle THROUGH the store (not component state)', async () => {
    // One kit = one real store instance + one tab record. Render → select
    // through the baked action → render AGAIN with the same kit: a fresh
    // PanelView (the simulated remount after another pane tab was active)
    // reads the persisted section from the store.
    const kit = visibleTabKit('tab-1')
    // The client is created ONCE (both passes share its snapshot cache, like
    // the panelFixture helper) — a fresh client per pass would re-enter the
    // loading state on the settled pass.
    const engineStatus = new MstarEngineStatusClient(gatewayFor(fullSource).connection)
    const render = () => settleRender(() => renderToStaticMarkup(createElement(PanelView, {
      sessionId: SESSION,
      ...kit,
      useChat: bindUseChat(createSnapshotStore(snapshotFor(fullSource, ANCHOR_TIME))),
      useSessions: bindUseSessions(SESSION_ID, SESSION_CWD) as never,
      engineStatus,
      t: panelLocale('en').bind(NS),
    } as never)))
    expect((await render()).includes('data-mstar-page="tasks"')).toBe(true)
    kit.actions.select('tab-1', 'agents')
    const second = await render()
    expect(second).toContain('data-mstar-page="agents"')
    expect(second).toMatch(/data-mstar-tab="agents"[^>]*data-mstar-tab-active="true"/)
    // The store (not a useState default) is what carried the selection:
    // its snapshot holds the key.
    expect(kit.instance.getSnapshot().byTab['tab-1']).toBe('agents')
  })

  it('the store is keyed by TAB ID — a second tab record stays on the tasks default', () => {
    const kit = visibleTabKit('tab-1')
    kit.actions.select('tab-1', 'events')
    // A different tab record reads `undefined` → the 'tasks' default.
    expect(kit.instance.getSnapshot().byTab['tab-2']).toBeUndefined()
    expect(kit.instance.getSnapshot().byTab['tab-1']).toBe('events')
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

  it('every color-family declaration is a --dsw-* token — zero bare colors of ANY form (spec §7)', async () => {
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

  it('spacing rides the --mstar-space-1..6 ramp — no bare px gaps/paddings/margins (spec §7)', async () => {
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

  it('font sizes ride the --dsw-font-xxxs-11 / xxs-12 / xs-13 ramp (spec §7)', async () => {
    const fonts = declValues(/\bfont\s*:/g)
    expect(fonts.length).toBeGreaterThan(0)
    for (const value of fonts) {
      expect(value).toMatch(/var\(--dsw-font-(?:xxxs-11|xxs-12|xs-13)\)/)
    }
  })

  it('hover feedback is 120–150ms, state switches ≤200ms — every transition duration in window (spec §7)', async () => {
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

  it('prefers-reduced-motion disables every transition and animation (spec §1.2/§7)', async () => {
    expect(cssText).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(cssText).toMatch(/transition:\s*none\s*!important/)
    expect(cssText).toMatch(/animation:\s*none\s*!important/)
  })

  it('section titles are uppercase + letter-spaced; chip radius is unified (spec §7)', async () => {
    expect(cssText).toMatch(/\.sectionTitle\s*\{[\s\S]*?text-transform:\s*uppercase/)
    expect(cssText).toMatch(/\.sectionTitle\s*\{[\s\S]*?letter-spacing:\s*0\.03em/)
    expect(cssText).toMatch(/\.subTitle\s*\{[\s\S]*?text-transform:\s*uppercase/)
    const radii = [...cssText.matchAll(/border-radius:\s*([^;]+)/g)].map((m) => m[1]!.trim())
    expect(radii.length).toBeGreaterThan(0)
    for (const r of radii) expect(['999px', '8px']).toContain(r)
  })

  it('dark mode is a host token flip — no theme-specific color overrides in the panel CSS (spec §7)', async () => {
    // The panel carries zero colors of its own, so `body[data-ds-dark-theme]`
    // readability comes from the host's token values — a `data-ds-dark-theme`
    // selector with a hard-coded override in the panel CSS would be a leak.
    expect(cssText).not.toContain('data-ds-dark-theme')
  })
})

/* ---------------------------------------------------------------------------
 * T5 zones CSS audit (spec panel-zones §7): the T4 theme audit reads
 * panel.module.css only — this block audits the zones css (the kanban /
 * legend — the AgentEventDock was removed by the event-log plan, spec §5;
 * its row styles migrated to `pages/event-log.module.css`, audited here)
 * for the same contract: token-only styles (bg/border/8px radius + token
 * event status colors), transitions inside the 120–200ms window, font sizes
 * on the ramp, and the reduced-motion root rule covering EVERY zones
 * transition/animation.
 * ------------------------------------------------------------------------- */

describe('workflow panel — T5 zones CSS audit: dock token styles + transition window + reduced-motion coverage (spec panel-zones §7)', () => {
  const cssText = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')

  it('every transition in the zones css sits in the 120–200ms window (spec §7)', async () => {
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

  it('the panel root reduced-motion rule covers EVERY zones transition/animation (spec §1.2)', async () => {
    const root = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    // The global kill switch targets `*` (every element — the zones css
    // included) inside @media (prefers-reduced-motion: reduce).
    expect(root).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\*\s*\{[\s\S]*?transition:\s*none\s*!important[\s\S]*?animation:\s*none\s*!important/,
    )
    // The zones css (kanban / dock / legend) carries NO self-contained
    // reduced-motion block — the root rule is the single coverage point.
    // (The canvas animations live in the page css; the next block audits
    // them — the AgentFlowZone stage styles were deleted with the component
    // by the agent-canvas plan, so no keyframes remain here.)
    expect(cssText).not.toMatch(/@media\s*\(prefers-reduced-motion/)
  })

  it('font sizes in the zones css ride the --dsw-font-xxxs-11 / xxs-12 / xs-13 ramp (spec §7)', async () => {
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

  it('event-log page styles align with the zone frames: token bg/border + 8px radius + token status colors', async () => {
    const pageCss = readFileSync(new URL('../src/client/panel/pages/event-log.module.css', import.meta.url), 'utf8')
    // Partition frame = the same token treatment as the zone frames
    // (bg-layer-1 / border-l1 / 8px radius — spec §2/§7 "样式与新区块统一").
    const sectionRule = pageCss.match(/\.section\s*\{[\s\S]*?\}/)
    expect(sectionRule).not.toBeNull()
    expect(sectionRule![0]).toContain('background: var(--dsw-alias-bg-layer-1)')
    expect(sectionRule![0]).toContain('border: 1px solid var(--dsw-alias-border-l1)')
    expect(sectionRule![0]).toContain('border-radius: 8px')
    // Event-row status colors (migrated from the retired dock): every status
    // class is a --dsw-* state token (dispatch → business/warn/error; settle
    // → success/error — spec §2.4).
    for (const cls of ['statusDispatched', 'statusAdvisory', 'statusDenied', 'statusOk', 'statusError']) {
      const rule = pageCss.match(new RegExp(`\\.${cls}\\s*\\{[\\s\\S]*?\\}`))
      expect(rule, cls).not.toBeNull()
      expect(rule![0]).toMatch(/--dsw-alias-state-(?:business|warn|error|success)-/)
    }
    // Zero bare colors of any form in the event-log css (whole-file scan).
    expect(pageCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|color\(/)
  })

  it('event-log page: flow-row partitions in the panel scroll body — no locked-height grid, no nested scroller, no width media query (plan sidebar §L4.1)', async () => {
    const pageCss = readFileSync(new URL('../src/client/panel/pages/event-log.module.css', import.meta.url), 'utf8')
    const stripped = pageCss.replace(/\/\*[\s\S]*?\*\//g, '')
    // Page frame (§L4.1): the two partitions are FLOW ROWS inside the panel's
    // single scroll body — the locked-height two-column grid is retired. The
    // local rule carries only the grid-item floor; the grid itself (one column
    // below 720px, the ≥720px spread) rides the shell's shared `.groupGrid`
    // class, not a second layout.
    const pageRule = pageCss.match(/\.eventLogPage\s*\{[\s\S]*?\}/)
    expect(pageRule).not.toBeNull()
    expect(pageRule![0]).toContain('min-width: 0')
    expect(pageRule![0]).not.toContain('grid-template')
    expect(pageRule![0]).not.toContain('overflow')
    expect(pageRule![0]).not.toContain('flex')
    // The partition keeps its framed anatomy; the locked-row shrink floor
    // (`min-height: 0` for the internal scroll) is gone with the scroll.
    const sectionRule = pageCss.match(/\.section\s*\{[\s\S]*?\}/)
    expect(sectionRule![0]).toContain('min-width: 0')
    expect(sectionRule![0]).not.toContain('min-height')
    // The row list is a plain flow list — the per-partition internal scroll
    // (`overflow-y: auto` + the flex fill/shrink pair) is retired; rows grow
    // the panel scroll body instead.
    const listRule = pageCss.match(/\.rowList\s*\{[\s\S]*?\}/)
    expect(listRule).not.toBeNull()
    expect(listRule![0]).not.toMatch(/overflow(?:-x|-y)?:/)
    expect(listRule![0]).not.toContain('flex: 1')
    expect(listRule![0]).not.toContain('min-height')
    // Width signal (§L2.7): NO viewport media query survives in the module —
    // the former 1200px stack fallback is the shared grid's one-column base.
    // Motion is killed by the root reduced-motion rule, not a local block.
    expect(stripped).not.toMatch(/@media\s*\((?:max|min)-width:/)
    expect(stripped).not.toMatch(/@media\s*\(prefers-reduced-motion/)
  })
})

/* ---------------------------------------------------------------------------
 * T5b agent-canvas page CSS audit (spec panel-tabs §4/§6.2, plan
 *  Task 3): the canvas page css (grid / cards /
 * edge animations) is new with this plan — the same contract as T4/T5:
 * zero bare colors of any form, transitions inside the 120–200ms window,
 * fonts on the ramp, keyframes + animation declarations present, and NO
 * self-contained reduced-motion block (the panel root rule covers it).
 * ------------------------------------------------------------------------- */

describe('workflow panel — T5b agent-canvas page CSS audit (spec panel-tabs §4/§7)', () => {
  const cssText = readFileSync(new URL('../src/client/panel/pages/agent-canvas.module.css', import.meta.url), 'utf8')

  it('every color-family declaration is a --dsw-* token — zero bare colors of ANY form', async () => {
    const colorRe = /\b(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?)\s*:/g
    const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
    const colors: string[] = []
    for (const m of stripped.matchAll(colorRe)) {
      const rest = stripped.slice((m.index ?? 0) + m[0].length)
      const end = rest.search(/[;}]/)
      colors.push(rest.slice(0, end === -1 ? rest.length : end).trim())
    }
    expect(colors.length).toBeGreaterThan(0)
    for (const value of colors) {
      if (value === '0' || value === 'none' || value === 'currentColor') continue // structural resets / inherits
      expect(value).toMatch(/var\(--dsw-(?:alias|static)-/)
    }
    expect(cssText).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|color\(/)
  })

  it('spacing rides the --mstar-space-* ramp; font sizes ride the --dsw-font-xxxs-11/xxs-12/xs-13 ramp', async () => {
    const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
    const spacingRe = /\b(?:gap|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?)\s*:/g
    const spacing: string[] = []
    for (const m of stripped.matchAll(spacingRe)) {
      const rest = stripped.slice((m.index ?? 0) + m[0].length)
      const end = rest.search(/[;}]/)
      spacing.push(rest.slice(0, end === -1 ? rest.length : end).trim())
    }
    for (const value of spacing) {
      if (value === '' || /^0(\s+0)*$/.test(value)) continue // zero reset
      expect(value).toMatch(/var\(--mstar-space-/)
    }
    const fonts: string[] = []
    for (const m of stripped.matchAll(/\bfont\s*:/g)) {
      const rest = stripped.slice((m.index ?? 0) + m[0].length)
      const end = rest.search(/[;}]/)
      fonts.push(rest.slice(0, end === -1 ? rest.length : end).trim())
    }
    for (const value of fonts) {
      expect(value).toMatch(/var\(--dsw-font-(?:xxxs-11|xxs-12|xs-13)\)/)
    }
  })

  it('every transition duration sits in the 120–200ms window (hover affordance)', async () => {
    const transitions = [...cssText.matchAll(/transition:\s*([^;}]+)/g)].map((m) => m[1]!.trim())
    expect(transitions.length).toBeGreaterThan(0)
    for (const t of transitions) {
      if (/^none/.test(t)) continue
      const durations = [...t.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]!))
      expect(durations.length).toBeGreaterThan(0)
      for (const d of durations) {
        expect(d).toBeGreaterThanOrEqual(120)
        expect(d).toBeLessThanOrEqual(200)
      }
    }
  })

  it('declares ONLY the running-card pulse animation (the next-edge dash flow is REMOVED with the next edge — T5); NO own reduced-motion block (root rule covers)', async () => {
    // The canvas ANIMATION (spec §6.2
    // Task 5 — running glow pulse) is declared here — the single motion-kill
    // coverage point stays the panel ROOT rule (`* { animation: none
    // !important }` under prefers-reduced-motion: reduce, asserted in T5).
    // The next-edge dash flow is GONE with the next edge (design doc §2.2).
    const keyframes = [...cssText.matchAll(/@keyframes\s+([a-z0-9-]+)/g)].map((m) => m[1]).sort()
    expect(keyframes).toEqual(['canvas-card-pulse'])
    const animDecls = [...cssText.matchAll(/animation\s*:\s*([^;}]+)/g)].map((m) => m[1]!.trim())
    expect(animDecls).toContain('canvas-card-pulse 1.6s ease-in-out infinite')
    expect(animDecls).not.toContain('canvas-dash-flow')
    expect(cssText).not.toMatch(/@media\s*\(prefers-reduced-motion/)
    // Zero dark-theme overrides — dark mode is the host token flip.
    expect(cssText).not.toContain('data-ds-dark-theme')
  })

  it('arrowhead fills target the marker <path> itself — no descendant selector', async () => {
    // The marker defs put the class ON the <path> element (AgentCanvasPage.tsx
    // `canvas-arrow-*` markers), so a `.canvasArrowX path` descendant selector
    // can never match — the SVG default (black) fill would win and the lit
    // supervise arrowheads would never render business-primary. Pin the
    // direct-class form + the token pairing with each edge's stroke color.
    expect(cssText).not.toMatch(/\.canvasArrow[A-Za-z]+\s+path\s*\{/)
    const arrowRule = (cls: string) => cssText.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    // Task 5 (design doc §2.2): the expected / next arrowheads are REMOVED
    // with their edges — only actual + supervise markers remain.
    expect(arrowRule('canvasArrowExpected')).toBe('')
    expect(arrowRule('canvasArrowNext')).toBe('')
    expect(arrowRule('canvasArrowActual')).toContain('fill: var(--dsw-alias-state-business-primary)')
    expect(arrowRule('canvasArrowSupervise')).toContain('fill: var(--dsw-alias-label-caption)')
    expect(arrowRule('canvasArrowSuperviseLit')).toContain('fill: var(--dsw-alias-state-business-primary)')
  })

  it('evidenced supervise line renders SOLID — the lit rule RESETS the base dasharray (cascade outcome)', async () => {
    // qc1 W-001 : `.canvasEdgeSupervise` declares
    // `stroke-dasharray: 5 4` and `.canvasEdgeSuperviseLit` overrides only
    // `stroke` — both single-class specificity (0,1,0), so the dash
    // survived into the evidenced lit state (the design doc §2.7 requires a
    // 1.5px business SOLID line). The P4 W-001 lesson: assert the cascade
    // OUTCOME — the lit rule must carry an explicit dasharray reset — not
    // merely that the lit rule exists.
    const rule = (cls: string) => cssText.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    expect(rule('canvasEdgeSupervise')).toContain('stroke-dasharray: 5 4')
    expect(rule('canvasEdgeSuperviseLit')).toContain('stroke-dasharray: none')
  })
})

describe('workflow panel — T3 sidebar reorg: plan cap/sort, residual findings cap, policy enforcement (spec panel-zones §3/§5)', () => {
  /** Sidebar state-section slice: from `data-mstar-section="state"` to the meta dock — excludes the graph's own plan rows. */
  function stateSlice(html: string): string {
    const start = html.indexOf('data-mstar-section="state"')
    const end = html.indexOf('data-mstar-meta')
    return start === -1 || end === -1 ? html : html.slice(start, end)
  }

  it('plan board caps at 5 in spec §3 order with a +N more note; ≤5 renders no note', async () => {
    const many = await panelHtml({
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: 'plan-1', status: 'Todo', doneAt: null, iterationRefs: [] },
          { id: 'plan-2', status: 'InProgress', doneAt: null, iterationRefs: [] },
          { id: 'plan-3', status: 'InProgress', doneAt: null, iterationRefs: [] },
          { id: 'plan-4', status: 'InReview', doneAt: null, iterationRefs: [] },
          { id: 'plan-5', status: 'InReview', doneAt: null, iterationRefs: [] },
          { id: 'plan-6', status: 'Done', doneAt: '2026-08-08', iterationRefs: [] },
          { id: 'plan-7', status: 'Done', doneAt: '2026-08-09', iterationRefs: [] },
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
    expect(stateSlice(await panelHtml(fullSource))).not.toContain('data-plan-truncated')
  })

  it('residual findings cap at 10 with an overflow hint; ≤10 renders none (spec §5)', async () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      planId: 'plan-x',
      id: `R${i + 1}`,
      severity: 'nit' as string,
      title: `finding ${i + 1}`,
    }))
    const s = stateSlice(await panelHtml({
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
    expect(stateSlice(await panelHtml(fullSource))).not.toContain('data-residual-truncated')
  })

  it('residualFindings null (root key unreadable) degrades to the none note, never a crash', async () => {
    const s = stateSlice(await panelHtml(noGateSource))
    expect(s).toContain('data-mstar-empty="no-residuals"')
    expect(s).toContain('none')
  })

  it('enforcement missing / garbage degrades the policy row to unknown, never a crash', async () => {
    // Missing (degradedSource carries enforcement: undefined) → unknown value.
    expect(await panelHtml(degradedSource)).toContain('data-field="enforcement">unknown')
    // Garbage (non-object) → same unknown degrade.
    const garbage = await panelHtml({ ...fullSource, enforcement: 'not-an-object' } as unknown as MstarEngineStatusPayload)
    expect(garbage).toContain('data-field="enforcement">unknown')
  })

  it('soft enforcement renders soft + provenance source (spec §2.1)', async () => {
    const soft = await panelHtml({ ...fullSource, enforcement: { hard: false, source: 'iteration compass' as EnforcementSource } })
    expect(soft).toContain('data-field="enforcement"')
    expect(soft).toContain('soft (iteration compass)')
  })
})

describe('workflow panel — T1 panel rename: "MStar 工作流" / "MStar Workflow" (spec panel-layout-graph §1.1)', () => {
  it('view.mstar-workflow label flips with the locale', async () => {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    expect(locale.bind(NS)('view.mstar-workflow')).toBe('MStar Workflow')
    locale.setLocale('zh')
    expect(locale.bind(NS)('view.mstar-workflow')).toBe('MStar 工作流')
  })

  it('zh body renders the meta dock + zone dashboard labels (header captions removed)', async () => {
    const zhHtml = await panelHtml(fullSource, undefined, undefined, 'zh')
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
 * T7 iteration-task page (spec panel-tabs §3
 * Task 2): the tasks tab renders the IterationTaskPage — Content Head
 * (collapsible iteration summary + VERTICAL Step 1–5 stack + branches) above
 * the five stacked kanban groups (the reused TaskBoard; plan sidebar §L4.2).
 * The WorkflowCanvas
 * zone dashboard (zone frames / footer legend + gate summary / corner event
 * dock / agent flow zone) no longer renders on the tasks tab — its render
 * surfaces migrate to the agent-canvas / event-log plans, the projection
 * layer stays unit-tested in client-graph-projection.spec.ts.
 * ------------------------------------------------------------------------- */

describe('workflow panel — T7 iteration-task page: content head collapse/expand + vertical steps + stacked kanban groups (spec panel-tabs §3, plan sidebar §L4.2)', () => {
  let html = ''
  beforeAll(async () => { html = await panelHtml(fullSource) })

  it('active iteration → head EXPANDED by default: summary row + vertical 5-step stack + branches', async () => {
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('data-iteration-head-active="true"')
    expect(html).toContain('data-iteration-head-expanded="true"')
    // Summary row: iteration id + verdict + n/5 status — PURE NUMBER, no
    // "Step" wording.
    expect(html).toContain('data-iteration-head-id="iter-00000809-dsh-workflow-viz"')
    expect(html).toContain('data-iteration-head-verdict="pass"')
    expect(html).toContain('2/5')
    expect(html).not.toContain('Step ')
    // The vertical 5-step stack: PHASE_IDS order, one done + one current +
    // one next + two idle (the
    // completed Step 1 before current projects `done`, not idle).
    expect(html).toContain('data-iteration-head-steps')
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`data-step="${n}"`)
    expect(html.match(/data-step-state="done"/g)).toHaveLength(1)
    expect(html.match(/data-step-state="current"/g)).toHaveLength(1)
    expect(html.match(/data-step-state="next"/g)).toHaveLength(1)
    expect(html.match(/data-step-state="idle"/g)).toHaveLength(2)
    expect(html).toMatch(/data-step="1"[^>]*data-step-state="done"/)
    expect(html).toMatch(/data-step="2"[^>]*data-step-state="current"/)
    expect(html).toMatch(/data-step="3"[^>]*data-step-state="next"/)
    // Badges are PURE NUMBERS (plan Item 1 — no 步骤/Step prefix).
    for (const n of [1, 2, 3, 4, 5]) expect(html).toMatch(new RegExp(`data-step-badge[^>]*>${n}<`))
    // Phase names ride the zone.phase.* keys (en).
    expect(html).toContain('Iteration Start')
    expect(html).toContain('Autonomous Execute')
    expect(html).toContain('Iteration Close')
    expect(html).toContain('PR Delivery')
    expect(html).toContain('Merge Ready')
    // State chips (localized labels) — all four states render (plan
    // The done chip label added —
    // en value follows the status-id-lowercase convention, like current/
    // next/idle).
    expect(html).toContain('current')
    expect(html).toContain('next')
    expect(html).toContain('idle')
    // The done step's chip sits on the SAME item as its done anchor (Step 1,
    // asserted above) and carries the localized 'done' label.
    expect(html).toMatch(/data-step="1"[^>]*data-step-state="done"[^>]*>[\s\S]*?data-step-chip[^>]*>done</)
    // Current-step verdict badge (fixture gate.ok → pass).
    expect(html).toContain('data-iteration-verdict="pass"')
    // Connectors are REMOVED (plan Item 1 — the gap replaces them; the
    // current-step highlight lives on the block itself, asserted above).
    expect(html).not.toContain('data-step-connector')
    // Branch panel renders while active: three data-branch rows (spec §3).
    expect(html).toContain('data-iteration-head-branches')
    expect(html).toContain('data-branches-title')
    expect(html).toContain('Branches')
    expect(html).toContain('data-branch="iteration-base"')
    expect(html).toContain('data-branch="target"')
    expect(html).toContain('data-branch="spec-integration"')
    expect(html).toContain('dev-dsh')
    expect(html).toContain('iteration/iter-00000809-dsh-workflow-viz')
  })

  it('LIVE activation re-sync (Task 2 review Important-1): the head expands when the SAME mounted instance sees active flip false→true; user collapse while already active is never overridden', async () => {
    // The collapse/expand state is seeded from `iteration.active` at mount
    // (SSR-stable, asserted above); a live catalog update can flip active
    // false→true WITHOUT a remount, and spec §3 says an active iteration
    // must show the expanded steps. The pure transition powers the
    // component's useEffect — pin the full transition table here:
    const t = nextExpandedOnActivation
    // activation edge: inactive → active forces expand, regardless of the
    // user's previous choice (the started iteration must show its steps).
    expect(t(false, false, true)).toBe(true)
    expect(t(true, false, true)).toBe(true)
    // steady active: the user's own collapse (or expand) is preserved — a
    // repeated catalog emission must not fight the user.
    expect(t(true, true, true)).toBe(true)
    expect(t(false, true, true)).toBe(false)
    // deactivation edge (true→false): never force a collapse — the muted
    // "not started" note + the collapsed affordance still render from
    // `active` itself on the next pass.
    expect(t(true, true, false)).toBe(true)
    expect(t(false, true, false)).toBe(false)
    // inactive → inactive: no change (initial mount no-op).
    expect(t(false, false, false)).toBe(false)
  })

  it('inactive iteration → head COLLAPSED to a one-line summary by default; the toggle can expand the idle skeleton', async () => {
    const g = await panelHtml(noGateSource)
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

  it('garbage iteration field → the same collapsed muted head, never a crash', async () => {
    const garbage = await panelHtml({ ...fullSource, iteration: 'not-an-object' } as unknown as MstarEngineStatusPayload)
    expect(garbage).toContain('data-iteration-head')
    expect(garbage).toContain('data-iteration-head-active="false"')
    expect(garbage).toContain('data-iteration-head-expanded="false"')
    expect(garbage).toContain('iteration not started')
    expect(garbage).not.toContain('data-step=')
    expect(garbage).not.toContain('data-branch=')
  })

  it('FAIL gate → the head verdict badge carries data-iteration-head-verdict="fail"', async () => {
    const failHtml = await panelHtml(failGateSource)
    expect(failHtml).toContain('data-iteration-head-active="true"')
    expect(failHtml).toContain('data-iteration-head-expanded="true"')
    expect(failHtml).toContain('data-iteration-head-verdict="fail"')
    expect(failHtml).toContain('data-iteration-verdict="fail"')
  })

  it('zh locale: summary/phase/chip/branch labels localize; en labels do not leak', async () => {
    const zhHtml = await panelHtml(fullSource, undefined, undefined, 'zh')
    expect(zhHtml).toContain('data-iteration-head-active="true"')
    expect(zhHtml).toContain('data-iteration-head-expanded="true"')
    // Pure numbers in zh too (plan Item 1 — no 步骤 wording at all).
    expect(zhHtml).toContain('2/5')
    expect(zhHtml).not.toContain('步骤')
    expect(zhHtml).toContain('迭代启动')
    expect(zhHtml).toContain('自主执行')
    expect(zhHtml).toContain('迭代收口')
    expect(zhHtml).toContain('PR 交付')
    expect(zhHtml).toContain('合并就绪')
    expect(zhHtml).toContain('当前')
    expect(zhHtml).toContain('下一步')
    expect(zhHtml).toContain('已完成')
    expect(zhHtml).toContain('待命')
    // The done chip localizes too — anchored to the done step item (Step 1).
    expect(zhHtml).toMatch(/data-step="1"[^>]*data-step-state="done"[^>]*>[\s\S]*?data-step-chip[^>]*>已完成</)
    expect(zhHtml).toContain('分支')
    expect(zhHtml).toContain('迭代 base')
    expect(zhHtml).toContain('目标分支')
    expect(zhHtml).toContain('spec 集成分支')
    // en phase labels must not leak into the zh body.
    expect(zhHtml).not.toContain('Autonomous Execute')
    // The zh "not started" note localizes too.
    const zhInactive = await panelHtml(noGateSource, undefined, undefined, 'zh')
    expect(zhInactive).toContain('data-iteration-head-expanded="false"')
    expect(zhInactive).toContain('迭代未启动')
  })

  it('renders the five stacked kanban groups in the panel scroll flow: 5 groups + total; the page-owned scroll body is retired (plan sidebar §L2.2/§L4.2)', async () => {
    // The page's independent vertical scroll body is RETIRED — the tasks
    // page renders flow content inside the panel's single scroll body
    // (`[data-mstar-scroll]`), and the retired anchor must be gone.
    expect(html).not.toContain('data-mstar-tasks-scroll')
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-mstar-kanban')
    const cols = [...html.matchAll(/data-kanban-column="([^"]+)"/g)].map((m) => m[1]!)
    expect(cols).toEqual(['Todo', 'InProgress', 'InReview', 'Done', 'blocked-unknown'])
    expect(html).toContain('data-tasks-total="2"')
    expect(html).toContain('data-plan-id="00000809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
    // Flow placement (§L2.5 tasks column): the board sits inside the panel
    // scroll body, and the project rollup + the in-flow digest FOLLOW it in
    // the same scroll flow (the digest is `[data-mstar-sidebar]`).
    expect(html.indexOf('data-mstar-scroll')).toBeLessThan(html.indexOf('data-mstar-page="tasks"'))
    expect(html.indexOf('data-mstar-kanban')).toBeLessThan(html.indexOf('data-mstar-sidebar'))
    // The tasks page never mounts the WorkflowCanvas-era surfaces.
    expect(html).not.toContain('data-mstar-canvas')
    expect(html).not.toContain('data-mstar-iteration-steps')
    expect(html).not.toContain('data-zone="iteration"')
    expect(html).not.toContain('data-zone="agents"')
    expect(html).not.toContain('data-agent-event-dock')
    expect(html).not.toContain('data-mstar-legend')
  })

  it('state null → the muted 5-column kanban skeleton + no-plans note, never an orange box (spec §8)', async () => {
    const g = await panelHtml({ ...fullSource, state: null })
    expect(g).toContain('data-mstar-page="tasks"')
    expect(g).toContain('data-zone="tasks"')
    expect(g.match(/data-kanban-column="/g)).toHaveLength(5)
    expect(g.match(/data-kanban-count="0"/g)).toHaveLength(5)
    expect(g).toContain('data-zone-empty="no-plans"')
    expect(g).toContain('no plans')
    expect(g).not.toContain('data-graph-empty="no-state"')
  })

  it('plans missing → same muted kanban skeleton + no-plans note, no no-plans orange note (spec §8)', async () => {
    const g = await panelHtml({
      ...fullSource,
      state: { ...fullSource.state!, plans: undefined },
    } as unknown as MstarEngineStatusPayload)
    expect(g).toContain('data-zone="tasks"')
    expect(g.match(/data-kanban-column="/g)).toHaveLength(5)
    expect(g).toContain('data-zone-empty="no-plans"')
    expect(g).toContain('no plans')
    expect(g).not.toContain('data-graph-empty="no-plans"')
  })

  it('css: the tasks page is flow content in the panel scroll zone; the kanban stacks as five groups on the shared group grid (plan sidebar §L2.2/§L4.2/§L4.3)', async () => {
    const panelCss = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    // The page is a flex column in the scroll zone's flow; the tasks area is
    // plain flow content — the panel scroll body (`[data-mstar-scroll]`) is
    // the single scroller (§L2.2), so it owns NO scroll and NO flex sizing.
    expect(panelCss).toMatch(/\.iterationPage\s*\{[\s\S]*?flex:\s*1/)
    expect(panelCss).toMatch(/\.iterationTasks\s*\{[\s\S]*?display:\s*flex/)
    expect(panelCss).not.toMatch(/\.iterationTasks\s*\{[^}]*overflow/)
    expect(panelCss).not.toMatch(/\.iterationTasks\s*\{[^}]*flex:\s*1/)
    // The head stays fixed (flex:none) above the flowing tasks area.
    expect(panelCss).toMatch(/\.iterationHead\s*\{[\s\S]*?flex:\s*none/)
    // The board rides the SHARED group grid (§L4.3 — one wide rule, not a
    // second layout): TaskBoard applies the shell's `.groupGrid` class to
    // the `data-mstar-kanban` container, so the ≥720px container spread
    // reaches the board groups.
    const taskBoardSrc = readFileSync(new URL('../src/client/panel/zones/TaskBoard.tsx', import.meta.url), 'utf8')
    expect(taskBoardSrc).toMatch(/panelCss\.groupGrid/)
    // The kanban itself is NO LONGER a horizontal flex row with an internal
    // scroller (§L4.2): no flex row, no overflow, no 120px column floors.
    const zonesCss = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')
    const kanbanRule = zonesCss.match(/\.kanban\s*\{[\s\S]*?\}/)
    expect(kanbanRule).not.toBeNull()
    expect(kanbanRule![0]).not.toContain('display: flex')
    expect(kanbanRule![0]).not.toContain('overflow')
    const columnRule = zonesCss.match(/\.kanbanColumn\s*\{[\s\S]*?\}/)
    expect(columnRule).not.toBeNull()
    expect(columnRule![0]).not.toContain('flex: 1 1 0')
    expect(columnRule![0]).not.toContain('min-width: 120px')
    expect(columnRule![0]).not.toContain('max-width')
  })
})

/* ---------------------------------------------------------------------------
 * F4.3 iteration zone (spec panel-f4 §2.3 R8/R9
 * iteration-zone Task 2): the expanded head body becomes a LEFT-RIGHT split —
 * branches (`data-iteration-head-branches`) LEFT small half + steps
 * (`data-iteration-head-steps`) RIGHT large half, DOM order branches BEFORE
 * steps (a plain flex row puts branches left); the `data-iteration-head-split`
 * container exists ONLY while branches render (active + non-null). The
 * verdict badge renders ONLY for a current step carrying a REAL gate verdict
 * (`step.state === 'current' && step.verdict !== 'unknown'`) — Phase 1
 * (compassStatus active → Step 1 current, verdict unknown) renders NO badge.
 * Every step reserves a fixed-height verdict seat (`data-step-verdict-seat`)
 * so the centered content groups align across steps — the old conditional
 * in-flow badge shifted the current step and `align-self: flex-start`
 * skewed it left (both root causes asserted gone).
 * ------------------------------------------------------------------------- */

describe('workflow panel — F4.3 iteration zone: split layout + verdict badge seat/condition (spec panel-f4 §2.3 R8/R9)', () => {
  /** Phase 1 in flight: compassStatus active → Step 1 current, verdict unknown (Task 1 projection). */
  const phase1Source: MstarEngineStatusPayload = {
    ...fullSource,
    iteration: { ...fullSource.iteration!, compassStatus: 'active' },
  }

  it('active + branches → the split container wraps branches (DOM-first) and steps', async () => {
    const html = await panelHtml(fullSource)
    expect(html).toContain('data-iteration-head-split')
    // DOM order: the split wraps BOTH panels, branches BEFORE steps (spec
    // R8; the stacked narrow-column head keeps that order — branches render
    // above the vertical stepper, plan sidebar §L4.2).
    expect(html.indexOf('data-iteration-head-split')).toBeLessThan(html.indexOf('data-iteration-head-branches'))
    expect(html.indexOf('data-iteration-head-branches')).toBeLessThan(html.indexOf('data-iteration-head-steps'))
  })

  it('inactive → no branches, no split container (the steps row alone)', async () => {
    const g = await panelHtml(noGateSource)
    expect(g).not.toContain('data-iteration-head-split')
    expect(g).not.toContain('data-iteration-head-branches')
    expect(g).not.toContain('data-branch=')
  })

  it('expanded head without the split → the steps-row-alone fallback: 5 verdict seats, 0 badges, no split/branches ', async () => {
    // The user-visible case (a manually EXPANDED inactive head) is
    // SSR-unreachable in this suite — `expanded` is seeded from `active`
    // (`useState(active)`), and effects/clicks cannot run under
    // `renderToStaticMarkup`. The wrapper DECISION is therefore pinned pure
    // (inactive → fallback), and the fallback DOM is pinned by rendering the
    // only statically-reachable expanded + no-split state (`active` with
    // `branches: null` — projection-unreachable, since branches are always
    // projected non-null while active, but the fallback JSX is the SAME
    // single `stepsRow` element the expanded-inactive head renders — one
    // source, the two cases cannot diverge).
    expect(iterationSplitActive(false, null)).toBe(false)
    expect(iterationSplitActive(true, null)).toBe(false)
    expect(iterationSplitActive(true, { iterationBase: 'a', target: 'b', specIntegration: 'c' })).toBe(true)
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    const view = projectGraph(noGateSource)
    const html = renderToStaticMarkup(createElement(IterationTaskPage, {
      view: { ...view, iteration: { ...view.iteration, active: true, currentStep: null, branches: null } },
      t: locale.bind(NS),
    }))
    // The expanded body renders the steps row ALONE — no split wrapper, no
    // branch panel (spec R8 fallback).
    expect(html).toContain('data-iteration-head-expanded="true"')
    expect(html).toContain('data-iteration-head-steps')
    expect(html).not.toContain('data-iteration-head-split')
    expect(html).not.toContain('data-iteration-head-branches')
    // All 5 steps reserve the fixed-height verdict seat; the idle skeleton
    // carries no current step, so the badge condition (current + verdict
    // != unknown) renders 0 badges.
    expect(html.match(/data-step-verdict-seat/g)).toHaveLength(5)
    expect(html).not.toContain('data-iteration-verdict')
    expect(html).not.toMatch(/data-step-state="current"/)
  })

  it('every step reserves the verdict seat; the badge renders only once, on a real gate verdict', async () => {
    const html = await panelHtml(fullSource)
    // Structural parity: all 5 steps carry the fixed-height seat — the
    // conditional badge never shifts the current step's centered group.
    expect(html.match(/data-step-verdict-seat/g)).toHaveLength(5)
    // Locked/transition path (fixture has NO compassStatus): Step 2 current
    // with the gate verdict pass → the badge fills the seat (existing
    // assertion kept — no regression).
    expect(html).toContain('data-iteration-verdict="pass"')
    expect(html.match(/data-iteration-verdict=/g)).toHaveLength(1)
  })

  it('Phase 1 (compassStatus active): Step 1 current, Step 2 next, verdict unknown, NO badge', async () => {
    const html = await panelHtml(phase1Source)
    expect(html).toContain('data-iteration-head-active="true"')
    expect(html).toContain('data-iteration-head-expanded="true"')
    // Step 1 (iteration-start) is current; Step 2 is next (spec R9).
    expect(html.match(/data-step-state="current"/g)).toHaveLength(1)
    expect(html).toMatch(/data-step="1"[^>]*data-step-state="current"/)
    expect(html).toMatch(/data-step="2"[^>]*data-step-state="next"/)
    expect(html).toContain('1/5')
    // Summary verdict unknown — Phase 1 has no gate-derived badge data.
    expect(html).toContain('data-iteration-head-verdict="unknown"')
    // The badge render condition is pinned: current + verdict unknown → NO
    // badge (the old code rendered for ANY current step, unknown included).
    expect(html).not.toContain('data-iteration-verdict')
    // The split still wraps the panels while active + branches present.
    expect(html).toContain('data-iteration-head-split')
    // The seat stays reserved even without a badge — blocks align.
    expect(html.match(/data-step-verdict-seat/g)).toHaveLength(5)
  })

  it('Phase 1 in zh: no badge either, seat row still reserved (zh/en parity)', async () => {
    const zhHtml = await panelHtml(phase1Source, undefined, undefined, 'zh')
    expect(zhHtml).toContain('data-iteration-head-verdict="unknown"')
    expect(zhHtml).not.toContain('data-iteration-verdict')
    expect(zhHtml.match(/data-step-verdict-seat/g)).toHaveLength(5)
  })

  it('css: the head body stacks (branches then the vertical stepper) — no viewport media queries left in the shell css; badge aligned via the fixed-height seat, no align-self skew (plan sidebar §L4.2)', async () => {
    const cssText = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')
    // The split container is a STACKED column now (§L4.2 — a left-right row
    // cannot fit the 300px floor): branches and the stepper stack with a
    // ramp gap, DOM order unchanged (branches first).
    expect(cssText).toMatch(/\.iterationHeadSplit\s*\{[\s\S]*?display:\s*flex[\s\S]*?flex-direction:\s*column[\s\S]*?gap:\s*var\(--mstar-space-/)
    // The stepper is the vertical 5-item stack (§L4.2): the row runs down
    // the column; each item is a horizontal badge·phase·chip·seat row.
    expect(cssText).toMatch(/\.iterationStepsRow\s*\{[\s\S]*?flex-direction:\s*column/)
    expect(cssText).toMatch(/\.iterationStepItem\s*\{[\s\S]*?display:\s*flex/)
    expect(cssText).not.toMatch(/\.iterationStepItem\s*\{[^}]*flex:\s*1\s+1\s+0/)
    expect(cssText).not.toMatch(/\.iterationStepsRow\s*\{[^}]*overflow-x/)
    // Viewport media queries are DELETED (plan sidebar §L2.7): neither the
    // ≤860px stack fallback nor the ≥861px branch width cap survives — the
    // width signal is the root's container queries (asserted in the shell
    // block).
    expect(cssText).not.toMatch(/@media\s*\((?:max|min)-width:/)
    // Verdict alignment fix: every step reserves a fixed-height flex seat; the
    // badge rule carries NO align-self (the `align-self: flex-start` skew
    // root cause is gone — spec §2.3 R9 "不再歪斜、不导致 Step 对齐偏移").
    expect(cssText).toMatch(/\.iterationVerdictSeat\s*\{[\s\S]*?display:\s*flex[\s\S]*?height:\s*22px/)
    const verdictRule = cssText.match(/\.iterationVerdict\s*\{[\s\S]*?\}/)
    expect(verdictRule).not.toBeNull()
    expect(verdictRule![0]).not.toMatch(/align-self/)
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

  it('full fixture, en + zh: zero data-graph-empty anchors, zero old note texts, zero stateUnknown', async () => {
    for (const lang of ['en', 'zh'] as const) {
      const html = await panelHtml(fullSource, undefined, undefined, lang)
      expect(html).not.toContain(OLD_ANCHOR)
      expect(html).not.toContain('stateUnknown')
      for (const text of OLD_TEXTS[lang]) expect(html).not.toContain(text)
    }
  })

  it('no iteration, en + zh: collapsed muted head with the not-started note, no-compass anchor + text gone', async () => {
    for (const lang of ['en', 'zh'] as const) {
      const g = await panelHtml(noGateSource, undefined, undefined, lang)
      expect(g).toContain('data-iteration-head')
      expect(g).toContain('data-iteration-head-active="false"')
      expect(g).toContain('data-iteration-head-expanded="false"')
      expect(g).toContain(lang === 'en' ? 'iteration not started' : '迭代未启动')
      expect(g).not.toContain(OLD_ANCHOR)
      expect(g).not.toContain('data-graph-empty="no-compass"')
      expect(g).not.toContain(OLD_TEXTS[lang][0]!)
    }
  })

  it('state null, en + zh: muted no-plans note present, no-state anchor + text gone', async () => {
    for (const lang of ['en', 'zh'] as const) {
      const g = await panelHtml({ ...fullSource, state: null }, undefined, undefined, lang)
      expect(g).toContain('data-zone-empty="no-plans"')
      expect(g).toContain(lang === 'en' ? 'no plans' : '暂无计划')
      expect(g).not.toContain(OLD_ANCHOR)
      expect(g).not.toContain('data-graph-empty="no-state"')
      expect(g).not.toContain(OLD_TEXTS[lang][2]!)
    }
  })

  it('plans missing, en + zh: same muted skeleton, no-plans anchor + text gone', async () => {
    for (const lang of ['en', 'zh'] as const) {
      const g = await panelHtml({
        ...fullSource,
        state: { ...fullSource.state!, plans: undefined },
      } as unknown as MstarEngineStatusPayload, undefined, undefined, lang)
      expect(g).toContain('data-zone-empty="no-plans"')
      expect(g).not.toContain(OLD_ANCHOR)
      expect(g).not.toContain('data-graph-empty="no-plans"')
      expect(g).not.toContain(OLD_TEXTS[lang][1]!)
    }
  })

  it('agentFlow null, en + zh: the tasks page renders no agents zone / no dock / no orange flow note (agents render moves to the agent-canvas plan)', async () => {
    for (const lang of ['en', 'zh'] as const) {
      const g = await panelHtml(fullSource, undefined, undefined, lang)
      expect(g).toContain('data-iteration-head')
      expect(g).not.toContain('data-zone="agents"')
      expect(g).not.toContain('data-agent-event-dock')
      expect(g).not.toContain(OLD_ANCHOR)
    }
  })

  it('the .stateUnknown orange bucket class is deleted from the zones css; blocked-unknown column stays muted NEUTRAL', async () => {
    const cssText = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')
    // The react-flow-era `.stateUnknown` RULE (dashed warn border + warn
    // label) is gone with graph.module.css — no selector rule survives (a
    // comment may name the old class; the rule must not).
    expect(cssText).not.toMatch(/\.stateUnknown\s*\{/)
    // The merged blocked-unknown kanban column rule is the muted neutral
    // treatment (spec §3): caption-colored, dimmed — no warn/error/business
    // state token (AC-3 umbrella re-assert; T4 pins the same rule).
    const unknownRule = cssText.match(/\[data-kanban-column='blocked-unknown'\]\s*\{[\s\S]*?\}/)
    expect(unknownRule).not.toBeNull()
    expect(unknownRule![0]).toContain('--dsw-alias-label-caption')
    expect(unknownRule![0]).toContain('opacity')
    expect(unknownRule![0]).not.toMatch(/--dsw-alias-state-(?:warn|error|business)/)
  })
})

describe('workflow panel — T7 data projection integration (spec panel-tabs §3)', () => {
  let html = ''
  beforeAll(async () => { html = await panelHtml(fullSource) })

  /**
   * Render the panel against a live snapshot store and the payload the gateway
   * serves for it (same helper shape as the data-wiring block).
   */
  async function renderStore(
    store: { getSnapshot(): ChatSnapshot },
    lang: 'en' | 'zh' = 'en',
    payload: MstarEngineStatusPayload = fullSource,
  ): Promise<string> {
    const gateway = gatewayFor(payload)
    const fixture = panelFixture(panelLocale(lang), store, gateway)
    return settleRender(() => renderPanelPass(fixture))
  }

  it('tasks page, meta dock and sidebar all render from the SAME catalog row (single source of truth)', async () => {
    // Meta dock watermark = source.version / harnessDir (was the header).
    expect(html).toContain('mstar 2.0.4')
    expect(html).toContain('harness: /proj/.mstar')
    // Sidebar plan board rows = state.plans verbatim.
    expect(html).toContain('data-plan-id="00000809-dsh-workflow-viz-panel"')
    expect(html).toContain('data-plan-status="InProgress"')
    // The tasks page renders from the same row: the head verdict from
    // iteration.gate.ok + the sidebar-visible plan row in the kanban.
    expect(html).toContain('data-mstar-page="tasks"')
    expect(html).toContain('data-iteration-head')
    expect(html).toContain('data-iteration-head-verdict="pass"')
    expect(html).toContain('data-zone="tasks"')
    expect(html).toContain('data-plan-status="InProgress"')
  })

  it('a new catalog row re-renders the tasks page with fresh data (no stale ring state)', async () => {
    // Snapshot bump: server re-emission with a FAIL verdict.
    const beforeStore = createSnapshotStore(snapshotFor(fullSource, 1_720_000_000_000))
    expect(await renderStore(beforeStore)).toContain('data-iteration-head-verdict="pass"')
    expect(beforeStore.getSnapshot()).toBeDefined()

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
    } as unknown as MstarEngineStatusPayload
    const store = createSnapshotStore(snapshotFor(failing, 1_720_001_000_000))
    const after = await renderStore(store, 'en', failing)
    expect(after).toContain('data-iteration-head-verdict="fail"')
    expect(after).toContain('data-iteration-verdict="fail"')
    // The violation list itself renders on the event-log page (event-log plan) —
    // the tasks page surfaces only the verdict.
    expect(after).not.toContain('data-graph-violations-count')
  })

  it('missing / garbage fields degrade the WHOLE panel (meta dock + tasks page + sidebar) without crashing', async () => {
    const noIteration = await panelHtml({ ...fullSource, iteration: undefined } as unknown as MstarEngineStatusPayload)
    expect(noIteration).toContain('data-mstar-meta')
    expect(noIteration).toContain('data-iteration-head')
    expect(noIteration).toContain('data-iteration-head-active="false"')
    expect(noIteration).not.toContain('data-graph-empty="no-compass"')
    expect(noIteration).toContain('data-mstar-sidebar')
    expect(noIteration).toContain('data-plan-id="00000809-dsh-workflow-viz-panel"')

    const garbageIteration = await panelHtml({ ...fullSource, iteration: 'not-an-object' } as unknown as MstarEngineStatusPayload)
    expect(garbageIteration).toContain('data-mstar-meta')
    expect(garbageIteration).toContain('data-iteration-head')
    expect(garbageIteration).toContain('data-iteration-head-active="false"')
    expect(garbageIteration).not.toContain('data-graph-empty="no-compass"')
    expect(garbageIteration).toContain('data-mstar-section="state"')
  })
})

/* ---------------------------------------------------------------------------
 * T4 task board kanban (spec panel-zones §3/§8
 * Task 1): the 5 PLAN_STATE_IDS groups — stacked in constant order (plan
 * sidebar §L4.2) — with localized headers + count badges,
 * plan cards (data-plan-id / data-plan-status — the anchors shared with the
 * sidebar), the flow glyphs riding each target group's header (chain → plus
 * the Blocked ⇄ back-edge docking at the merged column), the clickable
 * 「更多」 expand (the projection
 * KEEPS all rows and reports `capped` — the render truncates to PLAN_CAP and
 * surfaces the +N more button), the muted no-plans empty state, and the merged
 * blocked-unknown column's muted NEUTRAL (non-orange) treatment. The sort/cap
 * assertions here are RENDER-layer only — the projection-side tests in
 * client-graph-projection.spec.ts are independent (compass Risk Register).
 * ------------------------------------------------------------------------- */

describe('workflow panel — T4 task board kanban: 5 stacked groups + counts + cards + flow glyphs + 「更多」 expand + empty state (spec panel-zones §3/§8, plan sidebar §L4.2)', () => {
  /** The tasks zone slice: from the TaskBoard zone frame to the in-flow digest. */
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

  /** A plan-status spread covering every column (Blocked + a non-5-state
   * status both fold into the merged blocked-unknown column). */
  const kanbanSource: MstarEngineStatusPayload = {
    ...fullSource,
    state: {
      ...fullSource.state!,
      plans: [
        { id: 'plan-todo-1', status: 'Todo', doneAt: null, iterationRefs: [] },
        { id: 'plan-todo-2', status: 'Todo', doneAt: null, iterationRefs: [] },
        { id: 'plan-ip-1', status: 'InProgress', doneAt: null, iterationRefs: [] },
        { id: 'plan-ir-1', status: 'InReview', doneAt: null, iterationRefs: [] },
        { id: 'plan-done-1', status: 'Done', doneAt: '2026-08-01', iterationRefs: [] },
        { id: 'plan-blocked-1', status: 'Blocked', doneAt: null, iterationRefs: [] },
        { id: 'plan-weird-1', status: 'Paused', doneAt: null, iterationRefs: [] },
      ],
    },
  }
  let html = ''
  beforeAll(async () => { html = await panelHtml(kanbanSource) })

  it('renders 5 stacked groups in PLAN_STATE_IDS order with count badges and the total', async () => {
    expect(html).toContain('data-mstar-kanban')
    const cols = [...html.matchAll(/data-kanban-column="([^"]+)"/g)].map((m) => m[1]!)
    expect(cols).toEqual(['Todo', 'InProgress', 'InReview', 'Done', 'blocked-unknown'])
    // Header total (spec §3 — plan total across all columns, merged included).
    expect(html).toContain('data-tasks-total="7"')
    expect(html).toContain('7 plans')
    // Count badges: Todo 2, merged (Blocked + Paused) 2, three columns at 1.
    expect(html.match(/data-kanban-count="2"/g)).toHaveLength(2)
    expect(html.match(/data-kanban-count="1"/g)).toHaveLength(3)
  })

  it('buckets plan cards into their columns: data-plan-id / data-plan-status (shared anchors)', async () => {
    const todo = columnSlice(html, 'Todo')
    expect(todo).toContain('data-plan-id="plan-todo-1"')
    expect(todo).toContain('data-plan-id="plan-todo-2"')
    expect(todo).toContain('data-plan-status="Todo"')
    expect(todo).not.toContain('data-plan-id="plan-ip-1"')
    const ip = columnSlice(html, 'InProgress')
    expect(ip).toContain('data-plan-id="plan-ip-1"')
    expect(ip).toContain('data-plan-status="InProgress"')
    expect(ip).not.toContain('data-plan-id="plan-todo-1"')
    // Blocked AND the non-5-state status (Paused) both land in the merged
    // blockeded-unknown column.
    const merged = columnSlice(html, 'blocked-unknown')
    expect(merged).toContain('data-plan-id="plan-blocked-1"')
    expect(merged).toContain('data-plan-status="Blocked"')
    expect(merged).toContain('data-plan-id="plan-weird-1"')
    expect(merged).toContain('data-plan-status="Paused"')
    // The old separate Blocked / unknown columns no longer exist.
    expect(html).not.toContain('data-kanban-column="Blocked"')
    expect(html).not.toContain('data-kanban-column="unknown"')
  })

  it('blocked-unknown column is muted NEUTRAL (spec §3) — never the warn/orange treatment', async () => {
    const cssText = readFileSync(new URL('../src/client/panel/zones/zones.module.css', import.meta.url), 'utf8')
    const mergedRule = cssText.match(/\[data-kanban-column='blocked-unknown'\]\s*\{[\s\S]*?\}/)
    expect(mergedRule).not.toBeNull()
    // Muted neutral: caption-colored text + dimmed, dashed frame.
    expect(mergedRule![0]).toContain('--dsw-alias-label-caption')
    expect(mergedRule![0]).toContain('opacity')
    // NOT orange: no warn/error/business state token in the merged rule.
    expect(mergedRule![0]).not.toMatch(/--dsw-alias-state-(?:warn|error|business)/)
  })

  it('flow glyphs ride the target group header: chain → + the Blocked ⇄ back-edge docking at the merged group (spec §2.4, plan sidebar §L4.2)', async () => {
    const k = tasksSlice(html)
    // All four glyphs survive, labels unchanged.
    expect(k.match(/data-kanban-arrow=/g)).toHaveLength(4)
    expect(k).toContain('data-kanban-arrow="Todo-InProgress"')
    expect(k).toContain('data-kanban-arrow="InProgress-InReview"')
    expect(k).toContain('data-kanban-arrow="InReview-Done"')
    expect(k).toContain('data-kanban-arrow="InProgress-Blocked"')
    // The bidirectional glyph rides the Blocked back-edge.
    expect(k).toContain('⇄')
    // Each glyph docks INSIDE its target group's header (the stacked groups
    // have no inter-column gaps): the target column anchor precedes its
    // glyph, and the glyph precedes the next column anchor.
    const pos = (s: string) => k.indexOf(s)
    expect(pos('data-kanban-column="Todo"')).toBeLessThan(pos('data-kanban-column="InProgress"'))
    expect(pos('data-kanban-column="InProgress"')).toBeLessThan(pos('data-kanban-arrow="Todo-InProgress"'))
    expect(pos('data-kanban-arrow="Todo-InProgress"')).toBeLessThan(pos('data-kanban-column="InReview"'))
    // The glyph sits in the header row, before the group's count badge.
    const ip = columnSlice(html, 'InProgress')
    expect(ip.indexOf('data-kanban-arrow="Todo-InProgress"')).toBeLessThan(ip.indexOf('data-kanban-count='))
    // The ⇄ back-edge docks at the merged group's header, before its count.
    const merged = columnSlice(html, 'blocked-unknown')
    expect(merged.indexOf('data-kanban-arrow="InProgress-Blocked"')).toBeLessThan(merged.indexOf('data-kanban-count='))
  })

  it('overflow: 7 Done plans → top-5 rendered + count 7 + a clickable +2 more button (data-kanban-more)', async () => {
    const doneOverflow: MstarEngineStatusPayload = {
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: '00000807-plan', status: 'Done', doneAt: '2026-08-07', iterationRefs: [] },
          { id: '00000806-plan', status: 'Done', doneAt: '2026-08-06', iterationRefs: [] },
          { id: '00000805-plan', status: 'Done', doneAt: '2026-08-05', iterationRefs: [] },
          { id: '00000804-plan', status: 'Done', doneAt: '2026-08-04', iterationRefs: [] },
          { id: '00000803-plan', status: 'Done', doneAt: '2026-08-03', iterationRefs: [] },
          { id: '00000802-plan', status: 'Done', doneAt: '2026-08-02', iterationRefs: [] },
          { id: '00000801-plan', status: 'Done', doneAt: '2026-08-01', iterationRefs: [] },
        ],
      },
    }
    const g = await panelHtml(doneOverflow)
    const done = columnSlice(g, 'Done')
    // Full count on the badge, top PLAN_CAP cards rendered by default (Task 1).
    expect(done).toContain('data-kanban-count="7"')
    expect(done.match(/data-plan-id="/g)).toHaveLength(5)
    // Plan-sort order (shared key, projection-side): doneAt digitized DESC.
    expect(done.indexOf('data-plan-id="00000807-plan"')).toBeLessThan(done.indexOf('data-plan-id="00000806-plan"'))
    expect(done.indexOf('data-plan-id="00000806-plan"')).toBeLessThan(done.indexOf('data-plan-id="00000803-plan"'))
    // Overflow: a real <button> with the data-kanban-more anchor + the
    // localized +N more wording; the hidden rows are not rendered yet.
    expect(done).toContain('<button')
    expect(done).toContain('data-kanban-more="expand"')
    expect(done).toContain('+2 more')
    expect(done).not.toContain('data-plan-id="00000802-plan"')
    expect(done).not.toContain('data-plan-id="00000801-plan"')
    // The projection-level assertions stay independent (Risk Register) — this
    // pins the RENDER of the capped column only.
  })

  it('overflow boundary: exactly 5 Done plans → no 「更多」 button', async () => {
    const five: MstarEngineStatusPayload = {
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: Array.from({ length: 5 }, (_, i) => ({
          id: `2026080${i + 1}-plan`,
          status: 'Done',
          doneAt: `2026-08-0${i + 1}`,
          iterationRefs: [],
        })),
      },
    }
    const done = columnSlice(await panelHtml(five), 'Done')
    expect(done.match(/data-plan-id="/g)).toHaveLength(5)
    expect(done).not.toContain('data-kanban-more')
    expect(done).not.toContain('+1 more')
  })

  it('non-Done columns keep input order (only Done sorts); ≤PLAN_CAP → no 「更多」 button (spec §3)', async () => {
    const unsorted: MstarEngineStatusPayload = {
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: 'plan-z', status: 'Todo', doneAt: null, iterationRefs: [] },
          { id: 'plan-a', status: 'Todo', doneAt: null, iterationRefs: [] },
          { id: 'plan-m', status: 'Todo', doneAt: null, iterationRefs: [] },
        ],
      },
    }
    const todo = columnSlice(await panelHtml(unsorted), 'Todo')
    // Input order (plan-z, plan-a, plan-m) — NOT the id lex DESC the Done
    // column would apply.
    expect(todo.indexOf('data-plan-id="plan-z"')).toBeLessThan(todo.indexOf('data-plan-id="plan-a"'))
    expect(todo.indexOf('data-plan-id="plan-a"')).toBeLessThan(todo.indexOf('data-plan-id="plan-m"'))
    expect(todo).not.toContain('data-kanban-more')
  })

  it('zh locale: localized column headers, total label and the muted no-plans note', async () => {
    const zhHtml = await panelHtml(kanbanSource, undefined, undefined, 'zh')
    const zhTasks = tasksSlice(zhHtml)
    // Column headers ride the zone.state.* keys (the merged column is「受阻/未知」).
    for (const label of ['待办', '进行中', '审查中', '已完成', '受阻/未知']) {
      expect(zhTasks).toContain(label)
    }
    expect(zhTasks).toContain('7 个计划')
    // The empty note localizes too (state null → muted no-plans, spec §8).
    const zhEmpty = await panelHtml({ ...fullSource, state: null }, undefined, undefined, 'zh')
    expect(tasksSlice(zhEmpty)).toContain('暂无计划')
    expect(zhEmpty).toContain('data-zone-empty="no-plans"')
  })
})

describe('workflow panel — 「更多」 interaction ', () => {
  it('visibleKanbanPlans truncates to PLAN_CAP by default and reveals ALL rows when expanded', async () => {
    const v = projectGraph({
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: Array.from({ length: 7 }, (_, i) => ({ id: `p-${i}`, status: 'Done', doneAt: null, iterationRefs: [] })),
      },
    })
    const done = v.tasks.columns.find((c) => c.id === 'Done')!
    expect(done.plans).toHaveLength(7)
    // Collapsed → top PLAN_CAP; expanded → every row (no silent drop).
    expect(visibleKanbanPlans(done, false)).toHaveLength(PLAN_CAP)
    expect(visibleKanbanPlans(done, true)).toHaveLength(7)
    expect(visibleKanbanPlans(done, true).map((p) => p.id)).toEqual(done.plans.map((p) => p.id))
  })

  it('toggleKanbanExpanded adds/removes a column id (the click path)', async () => {
    const on = toggleKanbanExpanded(new Set(), 'Done')
    expect(on.has('Done')).toBe(true)
    expect(toggleKanbanExpanded(on, 'Done').has('Done')).toBe(false)
    // Independent columns — toggling one never touches another.
    const both = toggleKanbanExpanded(new Set(['Todo']), 'Done')
    expect(both.has('Todo')).toBe(true)
    expect(both.has('Done')).toBe(true)
  })
})

/* ---------------------------------------------------------------------------
 * T6 tabs-shell Task 1 (spec panel-tabs §2/§6.1
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

describe('workflow panel — T6 tabs-shell: section nav + content switching + in-flow digest (spec panel-tabs §2/§6.1)', () => {
  it('renders the 3 MenuTab anchors in the header nav, tasks active by default (D1)', async () => {
    const html = await panelHtml(fullSource)
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

  it('TabNav flips the active anchor per prop (activation state follows the tab)', async () => {
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

  it('content switches with the tab: tasks → IterationTaskPage, agents → AgentCanvasPage, events → EventLogPage', async () => {
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
    // agents → the draggable canvas page: data-mstar-page + the pan anchor +
    // full-roster entity cards.
    const agents = renderToStaticMarkup(createElement(PanelContent, { tab: 'agents', source: fullSource, t }))
    expect(agents).toContain('data-mstar-page="agents"')
    expect(agents).toContain('data-canvas-viewport')
    expect(agents).toContain('data-canvas-pan')
    expect(agents).toContain('data-agent-entity=')
    expect(agents).not.toContain('data-mstar-page-note')
    expect(agents).not.toContain('data-zone=')
    // events → the real log page :
    // the two partitions + expandable rows + muted empty states (the muted
    // placeholder note is gone — its copy landed in this page).
    const events = renderToStaticMarkup(createElement(PanelContent, { tab: 'events', source: fullSource, t }))
    expect(events).toContain('data-mstar-page="events"')
    expect(events).toContain('data-event-log-section="events"')
    expect(events).toContain('data-event-log-section="violations"')
    expect(events).toContain('data-event-log-details')
    expect(events).not.toContain('data-mstar-page-note')
    expect(events).not.toContain('data-agent-event-dock')
    expect(events).not.toContain('data-zone=')
    // The sidebar lives at the PanelView root — no tab content carries it.
    for (const html of [tasks, agents, events]) expect(html).not.toContain('data-mstar-sidebar')
  })

  it('the digest renders in the scroll zone after the page content — outside the tab-switching region', async () => {
    const html = await panelHtml(fullSource)
    // data-mstar-graph = the scroll zone (plan sidebar §L2.1 — the content
    // container anchor rides the shell's single scroller): the active page
    // renders inside it first, the digest follows in the same flow.
    expect(html).toContain('data-mstar-graph')
    expect(html).toContain('data-mstar-sidebar')
    // The digest's nested scroller is retired (§L2.1) — flow content only.
    expect(html).not.toContain('data-mstar-sidebar-scroll')
    expect(html.indexOf('data-mstar-graph')).toBeLessThan(html.indexOf('data-mstar-sidebar'))
    // The default render still shows the tasks page inside the scroll zone.
    expect(html.indexOf('data-mstar-graph')).toBeLessThan(html.indexOf('data-iteration-head'))
    expect(html.indexOf('data-iteration-head')).toBeLessThan(html.indexOf('data-mstar-sidebar'))
  })

  it('waiting / no-harness branches keep data-mstar-panel + freshness, no tabs, no sidebar', async () => {
    const waiting = await panelHtml(null)
    expect(waiting).toContain('data-mstar-panel="waiting"')
    expect(waiting).not.toContain('data-mstar-tab-nav')
    expect(waiting).not.toContain('data-mstar-sidebar')
    const noHarness = await panelHtml(noHarnessSource)
    expect(noHarness).toContain('data-mstar-panel="no-harness"')
    expect(noHarness).toContain('data-mstar-freshness')
    expect(noHarness).toContain('data-mstar-graph')
    expect(noHarness).not.toContain('data-mstar-tab-nav')
    expect(noHarness).not.toContain('data-mstar-sidebar')
  })

  it('zh locale localizes the tab labels + the agents canvas page copy', async () => {
    const zhHtml = await panelHtml(fullSource, undefined, undefined, 'zh')
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
    expect(agents).toContain('data-canvas-pan')
    // The degraded canvas note + summary are localized (spec §4/§8).
    expect(agents).toContain('agentFlow 证据缺失')
    expect(agents).toContain('执行中')
  })
})

/* ---------------------------------------------------------------------------
 * T9 event-log page (spec panel-tabs §5
 * Task 2): the 事件记录 tab is a NON-canvas log page — the Agent 流转事件 /
 * 违规记录 partitions (`data-event-log-section` + counts), per-row
 * expandable native `<details>` rows (`data-event-log-details` — the summary
 * IS the row; the body carries the FULL catalog fields via the T1-Min-3
 * id→FlowEventView backfill, `data-event-log-field` + `-missing="true"`),
 * the muted empty states (`data-event-log-empty` both-empty /
 * `data-event-log-empty-section` mixed — never an orange warn frame), the
 * unexpected-dispatch fold-in (`data-event-log-expected="false"` + the
 * `flow.unexpected` badge, DISPATCH-only — settle rows never flag as
 * unexpected), the out-of-Date-range ts degrade,
 * the dock migration
 * (zero `data-agent-event-dock` anchors — 无双份日志, spec §5) and the zh
 * copy. Row data rides the `eventLogEntries` assembly.
 * ------------------------------------------------------------------------- */

describe('workflow panel — T9 event-log page: partitions + rows + details + empty states (spec panel-tabs §5, plan event-log Task 2)', () => {
  /** Render the EventLogPage to static HTML (en default; the full projection). */
  function eventsHtml(source: MstarEngineStatusPayload, lang: 'en' | 'zh' = 'en'): string {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale(lang)
    return renderToStaticMarkup(createElement(EventLogPage, {
      view: projectGraph(source),
      t: locale.bind(NS),
    }))
  }

  it('renders the two partitions with row anchors and counts (events + violations)', async () => {
    const html = eventsHtml(flowSource([
      { ts: 3_000, kind: 'settle', role: '', planId: null, taskId: null, taskCategory: null, agent: 'a-1', outcome: 'ok', durationMs: 1234 },
      { ts: 2_000, kind: 'dispatch', role: 'fullstack-dev', planId: 'plan-x', taskId: 'T1', taskCategory: 'logic', agent: 'a-1', verdict: 'advisory' },
    ]))
    expect(html).toContain('data-mstar-page="events"')
    // Partitions (spec §5): Agent 流转事件 + 违规记录, each with its count.
    expect(html).toContain('data-event-log-section="events"')
    expect(html).toContain('data-event-log-section="violations"')
    expect(html).toContain('data-event-log-section-count="2"')
    // Rows: 2 event rows (latest-first: settle then dispatch) + 2 violations.
    expect(html.match(/data-event-log-row-kind="event"/g)).toHaveLength(2)
    expect(html.match(/data-event-log-row-kind="violation"/g)).toHaveLength(2)
    expect(html).toContain('data-event-log-row-id="3000-settle-0"')
    expect(html).toContain('data-event-log-row-id="2000-dispatch-1"')
    // Row summary cells: settle glyph row (no role) + dispatch role/stage/task.
    expect(html).toContain('data-event-log-stage="autonomous-execute:sdd-implement"')
    expect(html).toContain('data-event-log-target="plan-x#T1"')
    expect(html).toContain('data-event-log-status="advisory"')
    expect(html).toContain('data-event-log-agent="a-1"')
    expect(html).toContain('data-event-log-duration="1234"')
    // Violation rows carry the severity chip + code (spec §5).
    expect(html).toContain('data-event-log-severity="medium"')
    expect(html).toContain('data-event-log-code="PLAN-3"')
  })

  it('every row is an expandable <details> whose body carries the full catalog fields (T1-Min-3 backfill)', async () => {
    const html = eventsHtml(flowSource([
      { ts: 3_000, kind: 'settle', role: '', planId: null, taskId: null, taskCategory: null, agent: 'a-1', outcome: 'ok', durationMs: 1234 },
      { ts: 2_000, kind: 'dispatch', role: 'fullstack-dev', planId: 'plan-x', taskId: 'T1', taskCategory: 'logic', agent: 'a-1', verdict: 'advisory' },
    ]))
    // 4 rows (2 events + 2 violations), each an expandable <details>.
    expect(html.match(/<details/g)).toHaveLength(4)
    expect(html.match(/data-event-log-details/g)).toHaveLength(4)
    expect(html).toContain('<summary')
    // The event detail body carries the FULL source fields — planId/taskId/
    // taskCategory come from the id→FlowEventView backfill (T1-Min-3).
    for (const field of ['role', 'agent', 'stage', 'plan', 'task', 'category', 'time', 'kind', 'status', 'expected', 'settled', 'duration']) {
      expect(html).toContain(`data-event-log-field="${field}"`)
    }
    expect(html).toContain('data-event-log-field="plan"')
    // Present values render verbatim (plan-x / T1 / logic / 1234ms / labels).
    expect(html).toContain('plan-x')
    expect(html).toContain('T1')
    expect(html).toContain('logic')
    expect(html).toContain('1234ms')
    expect(html).toContain('advisory') // the advisory status label
    expect(html).toContain('dispatch') // the kind label
    // The violation detail body carries severity/code/message.
    expect(html).toContain('data-event-log-field="severity"')
    expect(html).toContain('data-event-log-field="code"')
    expect(html).toContain('data-event-log-field="message"')
    expect(html).toContain('plan  not complete')
  })

  it('missing fields degrade to 「—」 in the detail body — never fabricated (T1-Min-2 ts)', async () => {
    // A sparse dispatch: no role/agent/plan/task/category/stage, ts 0, no
    // duration — every one of those detail fields must render「—」.
    const html = eventsHtml(flowSource([
      { ts: 0, kind: 'dispatch', role: '', planId: null, taskId: null, taskCategory: null, agent: null },
    ]))
    // 8 missing fields: role / agent / stage / plan / task / category / time / duration.
    expect(html.match(/data-event-log-missing="true"/g)).toHaveLength(8)
    expect(html).toContain('data-event-log-field="time"')
    // ts 0 → no fabricated clock time on the row either.
    expect(html).not.toContain('data-event-log-time=')
    // Each missing value renders「—」(spec §5).
    expect(html.match(/—/g)).toHaveLength(8)
    // The status/kind/expected/settled seats still render honest values.
    expect(html).toContain('data-event-log-status="dispatched"')
  })

  it('settle rows render「—」for the settled field — the completion record itself, not a misleading no (T2-Min-2)', async () => {
    // A settle row IS the completion record: the detail body's settled seat
    // renders「—」(not applicable) instead of a flat 'no' (review T2-Min-2).
    const html = eventsHtml(flowSource([
      { ts: 3_000, kind: 'settle', role: '', planId: null, taskId: null, taskCategory: null, agent: 'a-1', outcome: 'ok', durationMs: 1234 },
    ]))
    const settleField = html.match(/data-event-log-field="settled"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(settleField).toContain('data-event-log-missing="true"')
    expect(settleField).toContain('>—</span>')
    // The settle row's detail body: 7 not-applicable fields (role/stage/
    // plan/task/category/settled/expected — the expected-role seat is
    // not applicable on a completion record); agent/time/kind/status/duration
    // render their honest values.
    expect(html.match(/data-event-log-missing="true"/g)).toHaveLength(7)
    // A dispatch row (not settled) still renders the honest 'no'.
    const dispatchHtml = eventsHtml(flowSource([
      { ts: 2_000, kind: 'dispatch', role: 'fullstack-dev', planId: 'plan-x', taskId: 'T1', taskCategory: 'logic', agent: 'a-1', verdict: 'advisory' },
    ]))
    const dispatchField = dispatchHtml.match(/data-event-log-field="settled"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(dispatchField).toContain('data-event-log-missing="false"')
    expect(dispatchField).toContain('>no</span>')
  })

  it('both empty → single muted 暂无记录 note, no partitions (spec §8)', async () => {
    const html = eventsHtml({
      ...flowSource([]),
      iteration: { ...fullSource.iteration!, gate: { ...fullSource.iteration!.gate, violations: [] } },
    })
    expect(html).toContain('data-event-log-empty="')
    expect(html).toContain('No records yet')
    expect(html).not.toContain('data-event-log-section=')
    expect(html).not.toContain('<details')
  })

  it('workflow rows render with the run name + workflow detail fields; unknown kinds render as generic rows (plan W-B2 Task 4)', async () => {
    const html = eventsHtml(flowSource([
      { ts: 3_000, kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed' },
      { ts: 2_000, kind: 'workflow-agent', runId: 'run-1', seq: 1, label: 'worker', childId: 'child-1' },
      { ts: 1_000, kind: 'workflow-run', runId: 'run-1', name: 'fan-out', agent: 'sess-1' },
      { ts: 500, kind: 'future-kind' }, // unknown kind → generic row (degradation path)
    ]))
    // All four rows render — none dropped: 3 workflow + 1 unknown-kind generic.
    expect(html.match(/data-event-log-row-kind="event"/g)).toHaveLength(4)
    expect(html).toContain('data-event-log-row-id="3000-workflow-run-end-0"')
    expect(html).toContain('data-event-log-row-id="2000-workflow-agent-1"')
    expect(html).toContain('data-event-log-row-id="1000-workflow-run-2"')
    expect(html).toContain('data-event-log-row-id="500-future-kind-3"')
    // The summary identity shows the run name (agent/end rows resolve it via
    // the window lookup; the run row carries its own name).
    expect(html.match(/data-event-log-name="fan-out"/g)).toHaveLength(3)
    // Workflow detail fields render (run-id / name / members / stop-reason).
    for (const field of ['run-id', 'name', 'members', 'stop-reason']) {
      expect(html).toContain(`data-event-log-field="${field}"`)
    }
    // The run-END row (rendered first, latest-first) carries the stop reason.
    const endRow = html.match(/data-event-log-row-id="3000-workflow-run-end-0"[\s\S]*?<\/li>/)?.[0] ?? ''
    const stopField = endRow.match(/data-event-log-field="stop-reason"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(stopField).toContain('data-event-log-missing="false"')
    expect(stopField).toContain('>completed</span>')
    // The workflow-RUN row carries the member count (1 agent row in the
    // window); the end/agent rows have no count (「—」).
    const runRow = html.match(/data-event-log-row-id="1000-workflow-run-2"[\s\S]*?<\/li>/)?.[0] ?? ''
    const membersField = runRow.match(/data-event-log-field="members"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(membersField).toContain('data-event-log-missing="false"')
    expect(membersField).toContain('>1</span>')
    const endMembers = endRow.match(/data-event-log-field="members"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(endMembers).toContain('data-event-log-missing="true"')
    // No unexpected badge on workflow/generic rows (dispatch-only marker).
    expect(html).not.toContain('data-event-log-unexpected')
  })

  it('mixed empty: violations only → the events partition degrades independently (its own muted note)', async () => {
    // fullSource: agentFlow null (0 events) + 2 gate violations.
    const html = eventsHtml(fullSource)
    expect(html).toContain('data-event-log-section="events"')
    expect(html).toContain('data-event-log-empty-section="events"')
    expect(html).toContain('No flow events yet')
    expect(html).toContain('data-event-log-section="violations"')
    expect(html).toContain('data-event-log-row-kind="violation"')
    expect(html).not.toContain('data-event-log-empty="')
  })

  it('mixed empty: events only → the violations partition degrades independently (its own muted note)', async () => {
    const html = eventsHtml({
      ...flowSource([dispatchEvent({ ts: 3, role: 'fullstack-dev', agent: 'a1' })]),
      iteration: { ...fullSource.iteration!, gate: { ...fullSource.iteration!.gate, violations: [] } },
    })
    expect(html).toContain('data-event-log-row-kind="event"')
    expect(html).toContain('data-event-log-empty-section="violations"')
    expect(html).toContain('No violations yet')
    expect(html).not.toContain('data-event-log-empty="')
  })

  it('unexpected dispatches fold into the events partition once (expected=false badge — never double-appended)', async () => {
    const html = eventsHtml(flowSource([dispatchEvent({ ts: 4, role: 'scout', agent: 's-9' })]))
    // Exactly ONE event row for the off-pipeline dispatch (view.unexpected is
    // a re-list — Task 1 folds via expected:false; the page never re-lists).
    expect(html.match(/data-event-log-row-kind="event"/g)).toHaveLength(1)
    expect(html).toContain('data-event-log-expected="false"')
    expect(html).toContain('data-event-log-unexpected="true"')
    expect(html).toContain('Unexpected roles')
  })

  it('settle rows NEVER render the unexpected badge — dispatch-only marker ', async () => {
    // A normal dispatch→settle pair: the settle row's projected `expected`
    // is always false, but it is a completion record — no badge and no
    // "not-applicable" expected seat in its detail body.
    const html = eventsHtml(flowSource([
      { ts: 3_000, kind: 'settle', role: '', planId: null, taskId: null, taskCategory: null, agent: 'a-1', outcome: 'ok', durationMs: 1234 },
      { ts: 2_000, kind: 'dispatch', role: 'fullstack-dev', planId: 'plan-x', taskId: 'T1', taskCategory: 'logic', agent: 'a-1', verdict: 'advisory' },
    ]))
    // No unexpected badge / label anywhere in the pair.
    expect(html).not.toContain('data-event-log-unexpected')
    expect(html).not.toContain('Unexpected roles')
    // The settle row's detail expected seat is not-applicable「—」.
    const settleExpected = html.match(/data-event-log-field="expected"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(settleExpected).toContain('data-event-log-missing="true"')
    // An off-pipeline DISPATCH still renders the badge (kind-guarded).
    const unexpectedHtml = eventsHtml(flowSource([dispatchEvent({ ts: 4, role: 'scout', agent: 's-9' })]))
    expect(unexpectedHtml).toContain('data-event-log-unexpected="true"')
    expect(unexpectedHtml).toContain('Unexpected roles')
  })

  it('a finite but out-of-Date-range ts degrades to「—」— never throws ', async () => {
    // ts = 1e18 is finite (guards.count passes it through the projection)
    // but outside the ECMAScript Date range (±8.64e15 ms): the old
    // formatEventTime threw RangeError and crashed the whole events tab.
    const html = eventsHtml(flowSource([
      { ts: 1e18, kind: 'dispatch', role: 'fullstack-dev', agent: 'a-1' },
    ]))
    expect(html.match(/data-event-log-row-kind="event"/g)).toHaveLength(1)
    // No fabricated clock time on the row…
    expect(html).not.toContain('data-event-log-time=')
    // …and the detail time seat renders「—」(missing).
    const timeField = html.match(/data-event-log-field="time"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(timeField).toContain('data-event-log-missing="true"')
  })

  it('dock migration: zero data-agent-event-dock anchors on the events page (无双份日志, spec §5)', async () => {
    const html = eventsHtml(flowSource([dispatchEvent({ ts: 3, role: 'fullstack-dev', agent: 'a1' })]))
    expect(html).not.toContain('data-agent-event-dock')
    expect(html).not.toContain('data-mstar-flow-events')
    expect(html).not.toContain('data-mstar-page-note')
  })

  it('zh locale localizes the log page copy (partitions + empty notes + field labels)', async () => {
    // fullSource has 0 events (agentFlow null) → detail field labels render
    // only for the violation rows; use a source WITH events too.
    const zhEvents = eventsHtml(flowSource([dispatchEvent({ ts: 3, role: 'fullstack-dev', agent: 'a1' })]), 'zh')
    expect(zhEvents).toContain('Agent 流转事件')
    expect(zhEvents).toContain('违规记录')
    expect(zhEvents).toContain('执行角色')
    expect(zhEvents).toContain('已结算')
    expect(zhEvents).toContain('严重度')
    expect(zhEvents).toContain('代码')
    expect(zhEvents).not.toContain('No records yet')
    const zhEmpty = eventsHtml({
      ...flowSource([]),
      iteration: { ...fullSource.iteration!, gate: { ...fullSource.iteration!.gate, violations: [] } },
    }, 'zh')
    expect(zhEmpty).toContain('暂无记录')
  })
})

/* ---------------------------------------------------------------------------
 * T8 agent canvas (spec panel-tabs §4/§6.2
 * Task 2): the draggable agents tab — pointer-event pan with the
 * `data-canvas-pan` transform anchor, full-roster entity cards (idle muted),
 * and the expected/actual/next AgentEdge lines. The drag math is the exported
 * pure `panDragStart` / `panDragMove` / `panTransform` (no DOM in bun test);
 * the deterministic `initialPan` prop seeds the rendered transform for the
 * SSR-level change assertion.
 * ------------------------------------------------------------------------- */

describe('workflow panel — agent canvas page (spec panel-tabs §4/§6.2)', () => {
  /** Evidence fixture: 3 dispatches across 3 stages + one settle — lit cards
   * (role-keyed). NOTE (design
   * doc §2.2): the same-plan adjacent pairs involve the general bucket
   * (generalPurpose), so the general-endpoint filter drops EVERY actual edge
   * in this fixture — the handoff-render tests live in
   * agent-canvas-layout.spec.tsx with general-free fixtures. */
  const evidenceSource = flowSource([
    dispatchEvent({ ts: 30, role: 'qc-specialist', agent: 'a3', planId: 'plan-x', taskId: 'T3' }),
    settleEvent({ ts: 25, agent: 'a2', outcome: 'ok', role: 'generalPurpose', planId: 'plan-x', taskId: 'T2' }),
    dispatchEvent({ ts: 20, role: 'generalPurpose', agent: 'a2', planId: 'plan-x', taskId: 'T2' }),
    dispatchEvent({ ts: 10, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T1' }),
  ])

  it('data-agent-entity covers the full KNOWN_AGENTS roster — idle (degraded ledger) never hides a known agent', async () => {
    const html = agentsHtml(fullSource) // agentFlow null → degraded
    for (const known of KNOWN_AGENTS) {
      expect(html).toContain(`data-agent-entity="${known.id}"`)
    }
    expect(html.match(/data-agent-entity="/g)).toHaveLength(KNOWN_AGENTS.length)
    // Degraded → every roster member is an idle card (spec §6.2), zero claims.
    expect(html.match(/data-agent-idle="true"/g)).toHaveLength(KNOWN_AGENTS.length)
    expect(html).toContain('data-canvas-note="degraded"')
    expect(html).toContain('data-agent-summary-executing="0"')
    expect(html).toContain('data-agent-summary-pending="0"')
  })

  it('lit cards carry the agent-name title + record fields; idle cards are muted with no fabricated record', async () => {
    const html = agentsHtml(evidenceSource)
    expect(html.match(/data-agent-entity="/g)).toHaveLength(KNOWN_AGENTS.length)
    // 3 lit (fullstack-dev / general / qc-specialist — role-keyed) + 11 idle
    // roster members (spec §6.2 suppression rule; roster 14 — plan f5 T1).
    expect(html.match(/data-agent-idle="true"/g)).toHaveLength(11)
    // Title = the agent name (role id); the session id rides the record line.
    expect(html).toContain('title="fullstack-dev"')
    expect(html).toContain('title="general"') // the generalPurpose dispatch folds into the bucket
    expect(html).toContain('title="qc-specialist"')
    expect(html).toContain('a1 · plan-x#T1')
    // Lit cards: no idle marker, honest statuses + record fields present.
    expect(cardRegion(html, 'fullstack-dev')).not.toContain('data-agent-idle')
    expect(cardRegion(html, 'fullstack-dev')).toContain('data-agent-record')
    expect(cardRegion(html, 'fullstack-dev')).toContain('data-agent-status="running"')
    expect(cardRegion(html, 'general')).toContain('data-agent-status="settled"') // a2's settle pairs the bucket dispatch
    // Idle card (e.g. prompt-engineer — an on-demand roster member): muted
    // marker, NO record line.
    expect(cardRegion(html, 'prompt-engineer')).toContain('data-agent-idle="true"')
    expect(cardRegion(html, 'prompt-engineer')).toContain('data-agent-status="idle"')
    expect(cardRegion(html, 'prompt-engineer')).not.toContain('data-agent-record')
    // Evidence present → no degradation note (honest absence).
    expect(html).not.toContain('data-canvas-note')
    expect(html).toContain('data-agent-summary-executing="2"')
    // Pending = un-evidenced stage roles: review-edit-chain (3) + qa-gate (1)
    // = 4 — sdd-implement is evidenced (fullstack-dev) incl. code-reviewer
    // (plan f5 T1), ops-engineer stays out of the flow (on-demand) and the
    // generalPurpose dispatch is off the pipeline.
    expect(html).toContain('data-agent-summary-pending="4"')
  })

  it('7 lit + 6 idle = 13 entities — the full roster is rendered, never hidden (plan f3 AC-1)', async () => {
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 40, role: 'product-manager', agent: 'p1' }),
      dispatchEvent({ ts: 39, role: 'architect', agent: 'p1' }),
      dispatchEvent({ ts: 38, role: 'writing-specialist', agent: 'p1' }),
      dispatchEvent({ ts: 37, role: 'fullstack-dev', agent: 'p1' }),
      dispatchEvent({ ts: 36, role: 'qc-specialist', agent: 'p1' }),
      dispatchEvent({ ts: 35, role: 'qa-engineer', agent: 'p1' }),
      dispatchEvent({ ts: 34, role: 'generalPurpose', agent: 'p1' }), // → general bucket
    ]))
    // 7 lit (6 in-flow + the general bucket) + 7 idle (fullstack-dev-2,
    // frontend-dev, qc-specialist-2, qc-specialist-3, ops-engineer,
    // prompt-engineer, code-reviewer — the f5 T1 roster addition) = 14.
    expect(html.match(/data-agent-entity="/g)).toHaveLength(KNOWN_AGENTS.length)
    expect(html.match(/data-agent-idle="true"/g)).toHaveLength(7)
    // All 7 lit dispatches are running (no settles).
    expect(html).toContain('data-agent-summary-executing="7"')
    // Every stage evidenced → no pending.
    expect(html).toContain('data-agent-summary-pending="0"')
  })

  it('empty ledger → data-canvas-note="empty"; settle-only ledger → the restored data-canvas-note="settle-only" (the canvas note is projected)', async () => {
    // 0 events → the `empty` anchor (spec §8).
    const emptyHtml = agentsHtml(flowSource([]))
    expect(emptyHtml).toContain('data-canvas-note="empty"')
    expect(emptyHtml).toContain('No actual dispatches yet')
    // Events but NO dispatch rows → the settle-only anchor — the old
    // AgentFlowZone's distinct `data-zone-empty="settle-only"` semantic,
    // restored for the canvas (never folded into `empty`).
    const settleOnly = agentsHtml(flowSource([
      settleEvent({ ts: 8, agent: 'a1', outcome: 'ok' }),
      settleEvent({ ts: 7, agent: 'a2', outcome: 'error' }),
    ]))
    expect(settleOnly).toContain('data-canvas-note="settle-only"')
    expect(settleOnly).toContain('Settle records only (no dispatch evidence)')
    expect(settleOnly).not.toContain('data-canvas-note="empty"')
    expect(settleOnly).not.toContain('data-canvas-note="degraded"')
    // The note rides PROJECTED metadata — a garbage-only ledger
    // (no dispatch evidence) renders settle-only; an anonymous dispatch row
    // IS dispatch evidence, so no note (the old allIdle heuristic would
    // have mislabeled both as settle-only).
    const garbageOnly = agentsHtml(flowSource([42, null, 'garbage', { kind: 'banana' }]))
    expect(garbageOnly).toContain('data-canvas-note="settle-only"')
    expect(garbageOnly).toContain('Settle records only (no dispatch evidence)')
    const anonymousDispatch = agentsHtml(flowSource([{ kind: 'dispatch' }]))
    expect(anonymousDispatch).not.toContain('data-canvas-note')
    // An anonymous dispatch folds into the general bucket → one running card.
    expect(anonymousDispatch).toContain('data-agent-summary-executing="1"')
  })

  it('mounts the Legend on the agents page: ONLY the 3 role-card status entries; the collaboration-edge / layout swatches are gone ', async () => {
    const html = agentsHtml(evidenceSource)
    expect(html).toContain('data-mstar-legend')
    // Task 1 (图例精简): exactly the 3 entity-status entries — the 7
    // collaboration-edge / layout entries (flow-actual / port / group /
    // sub-bucket / supervise / on-demand / unknown) are REMOVED.
    const items = [...html.matchAll(/data-mstar-legend-item="([^"]+)"/g)].map((m) => m[1]!)
    expect(items).toEqual(['agent-running', 'agent-settled', 'agent-idle'])
    for (const key of ['flow-actual', 'port', 'group', 'sub-bucket', 'supervise', 'on-demand', 'unknown']) {
      expect(html).not.toContain(`data-mstar-legend-item="${key}"`)
    }
    expect(html).not.toContain('data-mstar-legend-item="flow-expected"')
    expect(html).not.toContain('data-mstar-legend-item="next"')
    expect(html).not.toContain('data-mstar-legend-item="flow-unexpected"')
    expect(html).not.toContain('data-mstar-legend-item="general"')
    // The surviving entries' labels (en).
    expect(html).toContain('agent running (glow)')
    expect(html).toContain('settled agent (green done frame + ✓; off-tier roles show neither)')
    expect(html).toContain('idle agent (dashed)')
    // The legend labels localize (zh).
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('zh')
    const evidenceView = projectGraph(evidenceSource)
    const zhHtml = renderToStaticMarkup(createElement(AgentCanvasPage, {
      view: evidenceView.agents,
      iteration: evidenceView.iteration,
      t: locale.bind(NS),
    }))
    expect(zhHtml).toContain('执行中实体（发光）')
    expect(zhHtml).toContain('已完成实体（独立绿框 + ✓；off 阶段不显示）')
    expect(zhHtml).toContain('未工作实体（虚线）')
    expect(zhHtml).toContain('图例')
    expect(zhHtml).not.toContain('预期流转边（虚线）')
    expect(zhHtml).not.toContain('next 流转边（动画）')
  })

  it('draws the AgentEdge bezier paths: actual handoffs (general endpoints filtered) + the supervise line — NO expected/next edges (plan f5 T2 + design-system T5)', async () => {
    const html = agentsHtml(evidenceSource)
    // (design doc §2.2): the
    // expected skeleton + the next animation edge are REMOVED — no anchors
    // and no marker defs survive.
    expect(html).not.toContain('data-agent-edge-expected')
    expect(html).not.toContain('data-agent-edge-next')
    expect(html).not.toContain('canvas-arrow-expected')
    expect(html).not.toContain('canvas-arrow-next')
    // The SDD loop back-edge (sdd-implement → general) is GONE, so no
    // `data-agent-edge-loop` anchor renders.
    expect(html).not.toContain('data-agent-edge-loop')
    // actual: same-plan ts-adjacent dispatch pairs, ROLE-keyed, general
    // endpoints FILTERED (Task 5). The evidenceSource pairs all involve the
    // general bucket (generalPurpose) → NO actual edge renders here (the
    // general-free handoff rendering is pinned in agent-canvas-layout.spec.tsx).
    expect(html).not.toContain('data-agent-edge-actual=')
    // The static supervise line still renders (design knowledge) — LIT here:
    // fullstack-dev is an implementor-bucket dispatch (evidence, design doc
    // §2.7) — as a bezier `C` path (not a <line>).
    expect(html).toContain('data-agent-edge-supervise=')
    expect(html).toContain('data-agent-edge-supervise-lit="true"')
    // Degraded ledger draws NO actual edges (no handoff evidence) — no fake claims.
    const degraded = agentsHtml(fullSource)
    expect(degraded).not.toContain('data-agent-edge-actual=')
    expect(degraded).not.toContain('data-agent-edge-next=')
    expect(degraded).not.toContain('data-agent-edge-expected=')
    // Every edge is an SVG path with a bezier `C` command (design doc §2.6).
    const paths = [...html.matchAll(/<path([^>]*)>/g)].map((m) => m[1]!)
    const edgePaths = paths.filter((p) => /data-agent-edge-(?:actual|supervise)=/.test(p))
    expect(edgePaths.length).toBeGreaterThan(0)
    for (const p of edgePaths) {
      expect(p).toContain('d="M ')
      expect(p).toContain(' C ')
    }
  })

  it('the SDD loop edge is NOT rendered in any view — the projection no longer emits it and the render branch is gone (plan f4.2 Task 1 + Task 2, AC-3 "no data-agent-edge-loop anchor")', async () => {
    // Both the degraded (all-idle) roster and an evidence view render NO loop
    // path: the projection's `expectedEdges` emits only the 3 forward
    // skeleton edges (Task 1) AND the render's `if (edge.loop)` SVG branch +
    // loop marker defs are deleted (Task 2) — `data-agent-edge-loop` can
    // never appear.
    expect(agentsHtml(fullSource)).not.toContain('data-agent-edge-loop')
    expect(agentsHtml(evidenceSource)).not.toContain('data-agent-edge-loop')
    expect(agentsHtml(flowSource([dispatchEvent({ ts: 1, role: 'fullstack-dev', agent: 'a1' })]))).not.toContain('data-agent-edge-loop')
  })

  it('data-canvas-pan exposes the pan state as a translate transform (origin default)', async () => {
    const html = agentsHtml(fullSource)
    expect(html).toContain('data-canvas-pan')
    expect(html).toMatch(/data-canvas-pan[^>]*transform:\s*translate\(0px, 0px\)/)
    // The viewport is the pointer surface; the content layer carries the transform.
    expect(html).toContain('data-canvas-viewport')
  })

  it('a pan seed renders the translated content layer — transform change on the anchor (SSR seam)', async () => {
    const html = agentsHtml(fullSource, { x: 40, y: -20 })
    expect(html).toContain('translate(40px, -20px)')
    expect(html).toMatch(/data-canvas-pan[^>]*transform:\s*translate\(40px, -20px\)/)
    expect(html).not.toContain('translate(0px, 0px)')
  })

  it('pointer-event sequence → pan state → transform (pure drag helpers)', async () => {
    // pointerdown at (100, 50) on the origin; moves; pointerup — the pan
    // tracks origin + (pointer − start), freely (no bounds, spec §6.2).
    const drag = panDragStart(PAN_ORIGIN, 100, 50)
    expect(panDragMove(drag, 160, 80)).toEqual({ x: 60, y: 30 })
    expect(panDragMove(drag, 140, 60)).toEqual({ x: 40, y: 10 })
    // A second gesture continues from the current pan (accumulates).
    const second = panDragStart({ x: 40, y: 10 }, 20, 20)
    expect(panDragMove(second, 50, 40)).toEqual({ x: 70, y: 30 })
    expect(panTransform({ x: 40, y: -20 })).toBe('translate(40px, -20px)')
    expect(panTransform(PAN_ORIGIN)).toBe('translate(0px, 0px)')
  })

  it('layoutAgents is deterministic: the 4 flow columns ONLY (no unknown/on-demand/general column — Task 5), every entity boxed', async () => {
    const view = projectGraph(fullSource).agents
    const layout = layoutAgents(view)
    expect(layout.columns.map((c) => c.id)).toEqual([
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
    ])
    for (const entity of view.entities) {
      expect(layout.cards.get(entity.key)).toBeDefined()
    }
    // On-demand idle roles (ops-engineer / prompt-engineer) land INSIDE the
    // sdd-implement column's implementor partition (index 1) — no standalone
    // on-demand column (plan f5 Task 2).
    const sdd = layout.columns[1]!
    for (const key of ['ops-engineer', 'prompt-engineer']) {
      expect(layout.cards.get(key)!.x).toBeGreaterThanOrEqual(sdd.x)
      expect(layout.cards.get(key)!.x).toBeLessThan(sdd.x + sdd.w)
    }
    // The general bucket member sits INSIDE the LAST column (qa-gate), in
    // the unknown sub-partition BELOW the qa-gate card (plan f5 Task 5 —
    // design doc §1.2; the standalone unknown column is gone).
    const last = layout.columns[layout.columns.length - 1]!
    expect(last.id).toBe('autonomous-execute:qa-gate')
    const general = layout.cards.get('general')!
    const qa = layout.cards.get('qa-engineer')!
    expect(general.x).toBeGreaterThanOrEqual(last.x)
    expect(general.x).toBeLessThan(last.x + last.w)
    expect(general.y).toBeGreaterThan(qa.y + qa.h)
    // Same view → identical geometry (SSR stability).
    expect(layoutAgents(view)).toEqual(layout)
  })

  it('total function: no sdd-implement stage column → general AND on-demand entities fall back to the LAST column, never a throw', async () => {
    // A view whose stage skeleton lacks the sdd-implement column (degraded
    // shape — the projection always emits it, but `layoutAgents` stays total):
    // the general-bucket entity AND an on-demand entity (ops-engineer) land
    // in the LAST stage column (the general in its unknown sub-partition, the
    // on-demand in the flow stack) instead of throwing.
    const view: ZoneView['agents'] = {
      stages: [{
        id: 'iteration-start:review-edit-chain',
        phase: 'iteration-start',
        stage: 'review-edit-chain',
        roles: ['product-manager'],
        evidenced: false,
      }],
      degraded: false,
      empty: false,
      note: null,
      entities: [
        {
          key: 'general', agent: null, name: 'general', role: 'general', task: null,
          status: 'idle', idle: true, count: 0, ts: 0, stage: null, zone: 'general', bucket: null, emphasis: null,
        },
        {
          key: 'ops-engineer', agent: null, name: 'ops-engineer', role: 'ops-engineer', task: null,
          status: 'idle', idle: true, count: 0, ts: 0, stage: null, zone: 'on-demand', bucket: 'implementor', emphasis: null,
        },
      ],
      edges: [],
      executing: 0,
      pending: 0,
      activePlanId: null,
      activePlanCount: 0,
    }
    const layout = layoutAgents(view)
    const last = layout.columns[layout.columns.length - 1]!
    expect(last.id).toBe('iteration-start:review-edit-chain')
    for (const key of ['general', 'ops-engineer']) {
      expect(layout.cards.get(key)).toBeDefined()
      expect(layout.cards.get(key)!.x).toBeGreaterThanOrEqual(last.x)
      expect(layout.cards.get(key)!.x).toBeLessThan(last.x + last.w)
    }
  })

  it('a non-roster session id is only a record field — the ROLE keys the card, ONE card per key, honest summary', async () => {
    // dispatch agent = 'explore' (session id, no longer a roster id) with role
    // 'fullstack-dev' — the card is keyed by the ROLE; the session id rides
    // the record line. 1 lit + 13 idle = 14 unique entities (roster 14 — plan
    // f5 T1 adds code-reviewer) and the summary matches the visible cards.
    const html = agentsHtml(flowSource([
      dispatchEvent({ ts: 7, role: 'fullstack-dev', agent: 'explore' }),
    ]))
    expect(html.match(/data-agent-entity="/g)).toHaveLength(KNOWN_AGENTS.length)
    expect(html.match(/data-agent-entity="fullstack-dev"/g)).toHaveLength(1)
    expect(html).not.toContain('data-agent-entity="explore"')
    expect(html.match(/data-agent-idle="true"/g)).toHaveLength(13)
    // The lit card is visible and honest (running, no idle marker, record = session).
    const lit = cardRegion(html, 'fullstack-dev')
    expect(lit).toContain('data-agent-status="running"')
    expect(lit).not.toContain('data-agent-idle')
    expect(lit).toContain('data-agent-record')
    expect(lit).toContain('explore')
    // The idle fullstack-dev twin is gone (evidenced role).
    expect(html).not.toContain('data-agent-entity="fullstack-dev" data-agent-idle')
    // Executing matches the visible running card.
    expect(html).toContain('data-agent-summary-executing="1"')
  })

  it('renders the unknown SUB-PARTITION at the bottom of the last column — NO standalone unknown column; sub-bucket + on-demand-badge anchors ride the cards (plan f5 Task 2 + T5)', async () => {
    const html = agentsHtml(fullSource) // degraded → full idle roster
    // FOUR columns; the
    // rightmost catch-all COLUMN is gone — `data-canvas-column` never carries
    // the 'unknown' / 'on-demand' / 'general' values; the general bucket
    // renders in the last column's bottom sub-partition instead.
    expect(html).not.toContain('data-canvas-column="unknown"')
    expect(html).toContain('data-canvas-column="autonomous-execute:sdd-implement"')
    expect(html).toContain('data-canvas-column="autonomous-execute:qa-gate"')
    expect(html).not.toContain('data-canvas-column="on-demand"')
    expect(html).not.toContain('data-canvas-column="general"')
    // The unknown sub-partition caption (design doc §1.2).
    expect(html).toContain(`data-sub-bucket="${UNKNOWN_COLUMN}"`)
    expect(html).toContain('>unknown / unmatched roles<')
    // Sub-bucket anchors (plan f5 Task 2): the PROJECTED `entity.bucket`
    // rides data-agent-bucket on the sdd-implement cards — implementor
    // (flow + on-demand roles) / reviewer (code-reviewer).
    expect(cardRegion(html, 'code-reviewer')).toContain('data-agent-bucket="reviewer"')
    expect(cardRegion(html, 'fullstack-dev')).toContain('data-agent-bucket="implementor"')
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-bucket="implementor"')
    // The general card (bucket null) carries NO data-agent-bucket — it lives
    // in the unknown sub-partition, identified by data-agent-stage (projected,
    // never guessed).
    expect(cardRegion(html, 'general')).not.toContain('data-agent-bucket')
    expect(cardRegion(html, 'general')).toContain('data-agent-stage="general"')
    // On-demand badge (plan f5 Task 2): zone 'on-demand' cards only —
    // ops-engineer / prompt-engineer carry the badge, flow cards never do.
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-on-demand="true"')
    expect(cardRegion(html, 'prompt-engineer')).toContain('data-agent-on-demand="true"')
    expect(cardRegion(html, 'fullstack-dev')).not.toContain('data-agent-on-demand')
    expect(cardRegion(html, 'code-reviewer')).not.toContain('data-agent-on-demand')
    // On-demand zone cards report the zone on data-agent-stage (projected,
    // never guessed); general-bucket cards report 'general'.
    expect(cardRegion(html, 'ops-engineer')).toContain('data-agent-stage="on-demand"')
    expect(cardRegion(html, 'prompt-engineer')).toContain('data-agent-stage="on-demand"')
    expect(cardRegion(html, 'general')).toContain('data-agent-stage="general"')
    // zh labels localize (the unknown sub-partition caption + the 按需执行
    // badge + the reviewer sub-bucket anchor).
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('zh')
    const fullView = projectGraph(fullSource)
    const zhHtml = renderToStaticMarkup(createElement(AgentCanvasPage, {
      view: fullView.agents,
      iteration: fullView.iteration,
      t: locale.bind(NS),
    }))
    expect(zhHtml).toContain('>unknown / 未匹配角色<')
    expect(zhHtml).toContain('按需执行')
    expect(zhHtml).toContain('data-agent-bucket="reviewer"')
  })
})

/* ---------------------------------------------------------------------------
 * Shared iteration info section: the agents tab renders the SAME
 * IterationInfoSection the tasks tab renders, from the SAME `view.iteration`
 * data — 两个 tab 显示同一迭代信息块 (one implementation, two mounts; the
 * `data-iteration-*` anchor family is unchanged on both).
 * ------------------------------------------------------------------------- */

describe('workflow panel — shared iteration info section ', () => {
  /** Render one tab's content through the real PanelContent mapping. */
  function tabHtml(tab: 'tasks' | 'agents', source: MstarEngineStatusPayload): string {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('en')
    return renderToStaticMarkup(createElement(PanelContent, { tab, source, t: locale.bind(NS) }))
  }

  it('the agents tab renders the SAME IterationInfoSection as the tasks tab — same anchors, same data', async () => {
    const agents = tabHtml('agents', fullSource)
    const tasks = tabHtml('tasks', fullSource)
    // The agents page now carries the shared iteration head (Task 8).
    expect(agents).toContain('data-mstar-page="agents"')
    expect(agents).toContain('data-iteration-head')
    expect(agents).toContain('data-iteration-head-active="true"')
    expect(agents).toContain('data-iteration-head-expanded="true"')
    expect(agents).toContain('data-iteration-head-steps')
    expect(agents).toContain('data-iteration-head-branches')
    // SAME data as the tasks tab: identical id / verdict / step row / branches.
    for (const anchor of [
      'data-iteration-head-id="iter-00000809-dsh-workflow-viz"',
      'data-iteration-head-verdict="pass"',
      'data-step-state="current"',
      'data-branch="spec-integration"',
      'iteration/iter-00000809-dsh-workflow-viz',
    ]) {
      expect(tasks).toContain(anchor)
      expect(agents).toContain(anchor)
    }
    // Exactly ONE head root per page (no duplication within a tab) — React
    // SSR renders the valueless `data-iteration-head` attribute as
    // `data-iteration-head=""`, so the lookahead accepts `=`.
    expect(agents.match(/data-iteration-head(?=["= ])/g)).toHaveLength(1)
    expect(tasks.match(/data-iteration-head(?=["= ])/g)).toHaveLength(1)
  })

  it('inactive iteration → the agents page renders the same collapsed muted head as the tasks page', async () => {
    const agents = tabHtml('agents', noGateSource)
    expect(agents).toContain('data-mstar-page="agents"')
    expect(agents).toContain('data-iteration-head-active="false"')
    expect(agents).toContain('data-iteration-head-expanded="false"')
    expect(agents).toContain('iteration not started')
  })

  it('zh locale: the agents-page iteration section localizes like the tasks page', async () => {
    const locale = newLocale()
    locale.register(NS, { zh, en })
    locale.setLocale('zh')
    const agents = renderToStaticMarkup(createElement(PanelContent, {
      tab: 'agents',
      source: fullSource,
      t: locale.bind(NS),
    }))
    expect(agents).toContain('data-iteration-head-active="true"')
    expect(agents).toContain('迭代启动')
    expect(agents).toContain('分支')
    expect(agents).not.toContain('Autonomous Execute')
  })

  it('the pure helpers keep their contract from the SHARED module (IterationInfoSection — the single implementation)', async () => {
    // The transition table pins the collapse/expand contract (moved verbatim
    // from the old IterationTaskPage head; the anchors are unchanged).
    const t = nextExpandedOnActivation
    expect(t(false, false, true)).toBe(true)
    expect(t(true, false, true)).toBe(true)
    expect(t(true, true, true)).toBe(true)
    expect(t(false, true, true)).toBe(false)
    expect(iterationSplitActive(false, null)).toBe(false)
    expect(iterationSplitActive(true, null)).toBe(false)
    expect(iterationSplitActive(true, { iterationBase: 'a', target: 'b', specIntegration: 'c' })).toBe(true)
  })
})

/* ---------------------------------------------------------------------------
 * T4 client-half acceptance: the panel's data path is the host's `/api`
 * gateway, and its degraded states are explicit.
 *
 * - session isolation: the panel shows ONE session; an answer naming another
 *   session is refused, so session A's request can never render B's data
 *   (the client-side complement of the host's no-cross-session answer);
 * - `unavailable` never renders silently-empty: the degraded render carries
 *   its own anchor + machine-readable reason and NO data surface (no tabs, no
 *   sidebar, no kanban, no counters, no freshness marker).
 * ------------------------------------------------------------------------- */

describe('workflow panel — client half: session isolation + explicit unavailable (T4)', () => {
  it("session A's request can never render session B's data (foreign answer refused)", async () => {
    // The gateway answers A's request with B's snapshot: the panel must refuse
    // it outright — no B payload text, no panel surface.
    const gateway = stubGateway(servedSnapshot(
      { ...fullSource, version: 'B-2.0.4', harnessDir: '/projB/.mstar' },
      { sessionId: 's-B' },
    ))
    const store = createSnapshotStore(snapshotFor(fullSource, ANCHOR_TIME))
    const fixture = panelFixture(panelLocale('en'), store, gateway)
    const html = await settleRender(() => renderPanelPass(fixture))

    expect(html).toContain('data-mstar-panel="unavailable"')
    expect(html).toContain('data-mstar-unavailable-reason="session-mismatch"')
    expect(html).not.toContain('B-2.0.4')
    expect(html).not.toContain('/projB/.mstar')
    expect(html).not.toContain('data-mstar-sidebar')
    expect(html).not.toContain('data-mstar-tab-nav')
  })

  it('unavailable never renders silently-empty: anchor + reason, and no data surface', async () => {
    const gateway = stubGateway(gatewayError('no-route', 'gateway unreachable'))
    const store = createSnapshotStore(snapshotFor(fullSource, ANCHOR_TIME))
    const fixture = panelFixture(panelLocale('en'), store, gateway)
    const html = await settleRender(() => renderPanelPass(fixture))

    expect(html).toContain('data-mstar-panel="unavailable"')
    expect(html).toContain('data-mstar-empty="unavailable"')
    expect(html).toContain('data-mstar-unavailable-reason="transport-error:no-route"')
    expect(html).toContain('Engine-status snapshot unavailable (transport-error:no-route)')
    // No silently-empty data: no kanban columns / plan rows / event log /
    // residual counters, and no freshness marker claiming a snapshot.
    expect(html).not.toContain('data-mstar-kanban')
    expect(html).not.toContain('data-plan-id=')
    expect(html).not.toContain('data-mstar-section="state"')
    expect(html).not.toContain('data-event-log-section=')
    expect(html).not.toContain('data-mstar-freshness')
    // The waiting branch stays a DIFFERENT state (no anchor row at all).
    const waiting = await panelHtml(null)
    expect(waiting).toContain('data-mstar-panel="waiting"')
    expect(waiting).not.toContain('data-mstar-unavailable-reason')
  })

  it('the host degraded reasons surface verbatim in the panel (no snapshot / unknown sv / cwd mismatch)', async () => {
    for (const reason of ['store-absent', 'store-unknown-sv', 'cwd-mismatch', 'session-absent']) {
      const gateway = stubGateway(gatewayOk(unavailableResult(reason)))
      const store = createSnapshotStore(snapshotFor(fullSource, ANCHOR_TIME))
      const fixture = panelFixture(panelLocale('en'), store, gateway)
      const html = await settleRender(() => renderPanelPass(fixture))
      expect(html).toContain(`data-mstar-unavailable-reason="${reason}"`)
      expect(html).toContain(`Engine-status snapshot unavailable (${reason})`)
    }
  })
})
