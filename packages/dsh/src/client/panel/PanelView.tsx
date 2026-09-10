/**
 * Morning Star workflow panel page — the `conversation.view` tab component
 * (spec §4.2): render of the session's engine-status snapshot.
 *
 * Inputs: the session standard kit (`ConvViewProps` + the session-list seat),
 * the plugin's engine-status client (bound to the client `connection` service
 * by the plugin entry) and the typed `t` seat (`locale: 'mstar-panel'`). The
 * `useMstarEngineStatus()` hook turns the anchor row + the served snapshot
 * into ONE explicit render state (spec §5) — the render body is a pure
 * function of (state, payload, snapshot `at`, t).
 *
 * Layout (spec panel-tabs §2): root grid
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
 * Head + Steps 横排/收拢 + full-width kanban, spec §3 —
 * replacing the WorkflowCanvas zone dashboard); the agents tab renders the
 * draggable AgentCanvasPage (spec §4 — replacing the muted placeholder + the AgentFlowZone); the events tab
 * renders the EventLogPage (spec §5 — the non-canvas log page with per-row
 * `<details>` expansion, replacing
 * the muted placeholder AND the AgentEventDock — 无双份日志).
 *
 * Empty branches (spec §2): waiting / loading / unavailable / no-harness render
 * no tabs and no sidebar — each with its OWN anchor and copy, so a degraded
 * read is never mistakable for an empty workspace. Waiting keeps the muted
 * hint; loading states the pending read; unavailable carries the
 * machine-readable reason; the no-harness branch renders a CENTERED
 * inactive-state card (icon + title + hint) with the freshness footer, and its
 * main keeps `data-mstar-graph` on the content container. Degradation stays
 * total: `projectGraph` never throws; no iteration → the IterationTaskPage's
 * collapsed muted head (spec §8); `state` null / plans missing → muted kanban
 * skeleton.
 */

import * as React from 'react'
import { useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MstarEngineStatusPayload } from '../../types.ts'
import css from './panel.module.css'
import type { MstarEngineStatusClient } from './engine-status-client.ts'
import { projectGraph } from './graph/project-graph.ts'
import { Sidebar } from './sidebar.tsx'
import { TabNav, type PanelTab } from './TabNav.tsx'
import { AgentCanvasPage } from './pages/AgentCanvasPage.tsx'
import { EventLogPage } from './pages/EventLogPage.tsx'
import { IterationTaskPage } from './pages/IterationTaskPage.tsx'
import { useMstarEngineStatus, type UseSessions } from './use-mstar-engine-status.ts'

export interface MstarPanelViewProps extends ConvViewProps {
  /** Namespace-bound translate seat (`locale: 'mstar-panel'`). */
  t: TranslateNS<'mstar-panel'>
  /**
   * Current session identity — the session standard kit's own prop. Declared
   * here (rather than inherited) because this package does not depend on the
   * ui-session adapter that merges the session-kit declarations into
   * `ConvViewProps`; the view ring always supplies it at runtime.
   */
  sessionId?: SessionId
  /** Host session-list selector hook (the global standard seat, same reason). */
  useSessions?: UseSessions
  /**
   * The plugin's engine-status client (bound to the client `connection`
   * service by the plugin entry). Absent only in a composition that injects
   * no transport — the panel then reports the explicit `unavailable` state.
   */
  engineStatus?: MstarEngineStatusClient
}

/**
 * Freshness timestamp: local HH:MM:SS of the SERVED snapshot's `at` (spec §5
 * — the marker is the snapshot's own timestamp, never "live"). An unparseable
 * stamp renders no marker at all rather than an `Invalid Date`.
 */
function formatSnapshotTime(at: string): string | null {
  const ms = Date.parse(at)
  return Number.isNaN(ms) ? null : new Date(ms).toLocaleTimeString('en-GB')
}

export interface PanelContentProps {
  tab: PanelTab
  source: MstarEngineStatusPayload
  t: TranslateNS<'mstar-panel'>
}

/**
 * Tab → page mapping (spec §6.2): the only per-tab-switching part of the
 * layout. tasks = the IterationTaskPage (spec §3 — Content Head + Steps
 * 横排/收拢 + full-width kanban, it replaced the
 * WorkflowCanvas zone dashboard, whose file is removed by the plan close);
 * agents = the draggable AgentCanvasPage (spec §4 — full KNOWN_AGENTS roster
 * + idle states + AgentEdge collaboration edges; it replaced the muted placeholder and the AgentFlowZone); events =
 * the real EventLogPage (spec §5 — non-canvas log page: Agent 流转事件 +
 * 违规记录 partitions with per-row `<details>` expansion; it replaced the muted placeholder AND the
 * AgentEventDock — 无双份日志, the dock is removed with this plan).
 */
export function PanelContent({ tab, source, t }: PanelContentProps) {
  if (tab === 'agents') {
    // The SHARED iteration info section : the agents page receives the
    // SAME `view.iteration` the tasks page renders (IterationInfoSection).
    const view = projectGraph(source)
    return <AgentCanvasPage view={view.agents} iteration={view.iteration} t={t} />
  }
  if (tab === 'events') return <EventLogPage view={projectGraph(source)} t={t} />
  return <IterationTaskPage view={projectGraph(source)} t={t} />
}

export function PanelView({ t, useChat, useSessions, sessionId, engineStatus }: MstarPanelViewProps) {
  const view = useMstarEngineStatus({ useChat, useSessions, sessionId, engineStatus })
  // Tab state (spec §6.2): local, default 'tasks' (D1), no routing. Called
  // before every early return (hooks rule) — the empty branches never render
  // the tab nav.
  const [tab, setTab] = useState<PanelTab>('tasks')
  if (view.state === 'waiting') {
    return (
      <div className={css.emptyRoot} data-mstar-panel="waiting" data-conversation-composer-overlay="">
        <p className={css.empty} data-mstar-empty="waiting">{t('empty.waiting')}</p>
      </div>
    )
  }
  // Degraded and pending branches are EXPLICIT states (spec §5): a session
  // whose snapshot cannot be read never renders an empty plans list, an empty
  // event log or a zeroed counter as if it were data — and never renders
  // silently either (each carries its own anchor + copy).
  if (view.state === 'loading') {
    return (
      <div className={css.emptyRoot} data-mstar-panel="loading" data-conversation-composer-overlay="">
        <p className={css.empty} data-mstar-empty="loading">{t('empty.loading')}</p>
      </div>
    )
  }
  if (view.state === 'unavailable') {
    return (
      <div className={css.emptyRoot} data-mstar-panel="unavailable" data-conversation-composer-overlay="">
        <p className={css.empty} data-mstar-empty="unavailable" data-mstar-unavailable-reason={view.reason}>
          {t('empty.unavailable', { reason: view.reason })}
        </p>
      </div>
    )
  }
  const source = view.payload
  const snapshotTime = formatSnapshotTime(view.at)
  const noHarness = source.harnessDir === null && source.state === null && source.iteration == null
  const freshness = (
    <footer className={css.freshness} data-mstar-freshness>
      {snapshotTime === null
        ? null
        : (
          // The served snapshot's OWN emission identity: its timestamp and the
          // agent turn it was written for. Both are the host's records, so the
          // footer stays TRUE when the CURRENT turn's write failed and the
          // stored entry is an earlier one: it never claims to be live, and it
          // never claims to be "the last emission" either.
          <span data-mstar-freshness-at={view.at} data-mstar-freshness-turn={String(view.turn)}>
            {t('freshness.last-updated', { time: snapshotTime, turn: String(view.turn) })}
          </span>
        )}
      <span>{t('freshness.refresh-note')}</span>
    </footer>
  )
  if (noHarness) {
    // No harness → no tabs / no sidebar (spec §2 — empty branch unchanged):
    // a CENTERED inactive-state card (icon + main copy + hint) with the
    // freshness footer, in a single-column root (plan
    //  T3 — replaces the left-aligned hint).
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
  // Full-tab height (spec panel-tabs §2 Task
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
