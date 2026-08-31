/**
 * Morning Star workflow panel page — the `conversation.view` tab component
 * (spec §4.2): pure render of the latest `mstar-engine-status` catalog row.
 *
 * Inputs: the session standard kit (`ConvViewProps`) and the typed `t` seat
 * (`locale: 'mstar-panel'`). The catalog row + message time come from the
 * `useMstarEngineStatus()` hook riding the kit's `useChat` selector (spec
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
 * replacing the muted placeholder + the AgentFlowZone); the events tab
 * renders the EventLogPage (spec §5 — the non-canvas log page with per-row
 * `<details>` expansion, landed with the event-log plan Task 2, replacing
 * the muted placeholder AND the AgentEventDock — 无双份日志).
 *
 * Empty branches (spec §2): waiting / no-harness render no tabs / no
 * sidebar. Waiting keeps the muted hint; the no-harness branch renders a
 * CENTERED inactive-state card (icon + title + hint, plan
 * 20260812-panel-f5-agent-layout T3 — replaces the left-aligned hint) with
 * the freshness footer; the no-harness main keeps `data-mstar-graph` on its
 * content container. Degradation stays total: `projectGraph` never throws;
 * no iteration → the IterationTaskPage's collapsed muted head (spec §8);
 * `state` null / plans missing → muted kanban skeleton.
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
 * the real EventLogPage (spec §5 — non-canvas log page: Agent 流转事件 +
 * 违规记录 partitions with per-row `<details>` expansion, landed with the
 * event-log plan Task 2; it replaced the muted placeholder AND the
 * AgentEventDock — 无双份日志, the dock is removed with this plan).
 */
export function PanelContent({ tab, source, t }: PanelContentProps) {
  if (tab === 'agents') {
    // The SHARED iteration info section (plan 20260812-panel-f5-design-system
    // Task 8 — user 2026-08-12 feedback #4): the agents page receives the
    // SAME `view.iteration` the tasks page renders (IterationInfoSection).
    const view = projectGraph(source)
    return <AgentCanvasPage view={view.agents} iteration={view.iteration} t={t} />
  }
  if (tab === 'events') return <EventLogPage view={projectGraph(source)} t={t} />
  return <IterationTaskPage view={projectGraph(source)} t={t} />
}

export function PanelView({ t, useChat }: MstarPanelViewProps) {
  const { source, lastUpdated } = useMstarEngineStatus(useChat)
  // Tab state (spec §6.2): local, default 'tasks' (D1), no routing. Called
  // before every early return (hooks rule) — the empty branches never render
  // the tab nav.
  const [tab, setTab] = useState<PanelTab>('tasks')
  if (source === null || source === undefined) {
    return (
      <div className={css.emptyRoot} data-mstar-panel="waiting" data-conversation-composer-overlay="">
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
    // a CENTERED inactive-state card (icon + main copy + hint) with the
    // freshness footer, in a single-column root (plan
    // 20260812-panel-f5-agent-layout T3 — replaces the left-aligned hint).
    // The `data-mstar-graph` anchor stays on the main container (its layout
    // contract slot).
    return (
      <div className={css.root} data-mstar-panel="no-harness" data-conversation-composer-overlay="">
        <main className={css.main} data-mstar-graph>
          <div className={css.noHarnessCard} data-mstar-empty-card>
            <svg
              className={css.noHarnessIcon}
              data-mstar-empty-icon
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {/* Muted folder glyph — the harness directory is not detected. */}
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <path d="M9.7 9.4a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1 .8-1 1.5" />
              <circle cx="12" cy="16.4" r="0.6" />
            </svg>
            <p className={css.noHarnessTitle} data-mstar-empty="no-harness">{t('empty.no-harness')}</p>
            <p className={css.noHarnessHint}>{t('empty.no-harness-hint')}</p>
          </div>
          {freshness}
        </main>
      </div>
    )
  }
  // Full-tab height (spec panel-tabs §2, plan 20260813-panel-quick-fixes Task
  // 4): the host only gives a view a definite height when the view opts into
  // the composer overlay. The `data-conversation-composer-overlay` attribute
  // flips the host's `.viewArea` wrapper from flow content (`min-height: auto;
  // flex: 1 0 auto` — which makes `.root`'s `height: 100%` resolve to auto and
  // the WHOLE page scroll) to a fixed-height container (`flex: 1 1 0;
  // min-height: 0; overflow: hidden`). Only then does the panel's own height
  // chain (`height: 100%` → `.main` → `.content` → `.eventLogPage` →
  // `.rowList`) constrain, so each partition scrolls internally. The waiting
  // and no-harness roots carry the SAME opt-in so `height: 100%` also centers
  // their content and the composer position never jumps on transition.
  return (
    <div className={css.root} data-mstar-panel="panel" data-conversation-composer-overlay="">
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
