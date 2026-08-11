/**
 * Morning Star workflow panel page — the `conversation.view` tab component
 * (spec §4.2): pure render of the latest `mstar-engine-status` catalog row.
 *
 * Inputs: the session standard kit (`ConvViewProps`) and the typed `t` seat
 * (`locale: 'mstar-panel'`). The catalog row + message time come from the
 * `useMstarEngineStatus()` hook riding the kit's `useSession` selector (spec
 * §5) — the render body is a pure function of (source, lastUpdated, t).
 *
 * Layout (spec panel-tabs §2, plan 20260811-panel-tabs-shell): root grid
 * `"main sidebar"` fills the Tab (height 100%, overflow hidden — the page
 * never scrolls); the right sidebar is RESIDENT (all tabs share it, its props
 * `{ t, state, source }` unchanged); main = the fixed header nav (TabNav, 3
 * MenuTabs) + the content region (switches per tab) + the freshness footer.
 * The `data-mstar-graph` anchor now marks the CONTENT container (spec §6.1 —
 * previously the canvas container), so tests pin the layout contract, not the
 * per-tab page internals.
 *
 * Tab state (spec §6.2): local `useState<PanelTab>` (default 'tasks', D1, no
 * routing) — `renderToStaticMarkup` renders the default tasks page, keeping
 * SSR assertions stable. The tasks tab renders the IterationTaskPage (Content
 * Head + Steps 横排/收拢 + full-width kanban, spec §3 — landed with Task 2,
 * replacing the WorkflowCanvas zone dashboard); the agents tab renders the
 * draggable AgentCanvasPage (spec §4 — landed with the agent-canvas plan,
 * replacing the muted placeholder + the AgentFlowZone); the events tab stays
 * the muted placeholder page (the real page lands with the event-log plan).
 *
 * Empty branches (spec §2): waiting / no-harness stay exactly as the zone
 * dashboard baseline — no tabs, no sidebar (hint + freshness only); the
 * no-harness main keeps `data-mstar-graph` on its hint container. Degradation
 * stays total: `projectGraph` never throws; no iteration → the IterationTaskPage's
 * collapsed muted head (spec §8); `state` null / plans missing → muted kanban
 * skeleton.
 */

import * as React from 'react'
import { useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarEngineStatusSource } from '../../types.ts'
import css from './panel.module.css'
import { projectGraph } from './graph/project-graph.ts'
import { Sidebar } from './sidebar.tsx'
import { TabNav, type PanelTab } from './TabNav.tsx'
import { AgentCanvasPage } from './pages/AgentCanvasPage.tsx'
import { EventLogPage } from './pages/EventLogPage.tsx'
import { IterationTaskPage } from './pages/IterationTaskPage.tsx'
import { useMstarEngineStatus } from './use-mstar-engine-status.ts'

export interface MstarPanelViewProps extends ConvViewProps {
  /** Namespace-bound translate seat (`locale: 'mstar-panel'`). */
  t: TranslateNS<'mstar-panel'>
}

/** Freshness timestamp: local HH:MM:SS (spec §5). */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB')
}

export interface PanelContentProps {
  tab: PanelTab
  source: MstarEngineStatusSource
  t: TranslateNS<'mstar-panel'>
}

/**
 * Tab → page mapping (spec §6.2): the only per-tab-switching part of the
 * layout. tasks = the IterationTaskPage (spec §3 — Content Head + Steps
 * 横排/收拢 + full-width kanban, landed with Task 2; it replaced the
 * WorkflowCanvas zone dashboard, whose file is removed by the plan close);
 * agents = the draggable AgentCanvasPage (spec §4 — full KNOWN_AGENTS roster
 * + idle states + AgentEdge collaboration edges, landed with the agent-canvas
 * plan; it replaced the muted placeholder and the AgentFlowZone); events =
 * the muted placeholder page (the real log page lands with the event-log plan).
 */
export function PanelContent({ tab, source, t }: PanelContentProps) {
  if (tab === 'agents') return <AgentCanvasPage view={projectGraph(source).agents} t={t} />
  if (tab === 'events') return <EventLogPage t={t} />
  return <IterationTaskPage view={projectGraph(source)} t={t} />
}

export function PanelView({ t, useSession }: MstarPanelViewProps) {
  const { source, lastUpdated } = useMstarEngineStatus(useSession)
  // Tab state (spec §6.2): local, default 'tasks' (D1), no routing. Called
  // before every early return (hooks rule) — the empty branches never render
  // the tab nav.
  const [tab, setTab] = useState<PanelTab>('tasks')
  if (source === null || source === undefined) {
    return (
      <div className={css.emptyRoot} data-mstar-panel="waiting">
        <p className={css.empty} data-mstar-empty="waiting">{t('empty.waiting')}</p>
      </div>
    )
  }
  const noHarness = source.harnessDir === null && source.state === null && source.iteration == null
  const freshness = (
    <footer className={css.freshness} data-mstar-freshness>
      {typeof lastUpdated === 'number'
        ? <span>{t('freshness.last-updated', { time: formatTime(lastUpdated) })}</span>
        : null}
      <span>{t('freshness.refresh-note')}</span>
    </footer>
  )
  if (noHarness) {
    // No harness → no tabs / no sidebar (spec §2 — empty branch unchanged):
    // hint + freshness in a single-column root. The `data-mstar-graph` anchor
    // stays on the hint container (its layout contract slot).
    return (
      <div className={css.root} data-mstar-panel="no-harness">
        <main className={css.main} data-mstar-graph>
          <p className={css.empty} data-mstar-empty="no-harness">{t('empty.no-harness')}</p>
          {freshness}
        </main>
      </div>
    )
  }
  return (
    <div className={css.root} data-mstar-panel="panel">
      <main className={css.main}>
        <TabNav active={tab} onChange={setTab} t={t} />
        <div className={css.content} data-mstar-graph>
          <PanelContent tab={tab} source={source} t={t} />
        </div>
        {freshness}
      </main>
      <Sidebar t={t} state={source.state} source={source} />
    </div>
  )
}
