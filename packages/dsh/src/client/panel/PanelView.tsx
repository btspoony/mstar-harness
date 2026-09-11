/**
 * Morning Star workflow panel page — the right-Sidebar pane body (the keyed
 * `sidebar.right.pane.tab` seat component, plan sidebar §L1.5): render of the
 * session's engine-status snapshot.
 *
 * Inputs: the sidebar seat's props (`MstarPanelBodyProps` — the seat's
 * runtime share incl. the framework-injected `useTabInfo()` + the session
 * standard kit + the entry store share (`useStore` + baked `select`, backed
 * by the registration's `store` option) + the plugin's engine-status client
 * bound by the plugin entry + the typed `t` seat (`locale: 'mstar-panel'`)).
 * The `useMstarEngineStatus()` hook turns the anchor row + the served
 * snapshot into ONE explicit render state (spec §5) — the render body is a
 * pure function of (state, payload, snapshot `at`, t).
 *
 * Visibility (plan sidebar §L2.6): a docked body is projected only while its
 * sidebar column is expanded and the tab is active —
 * `useTabInfo().tab.visible` — so a collapsed column renders NOTHING (no
 * projection, no DOM). A floating pane is always visible.
 *
 * Layout (plan sidebar §L2.1): the narrow-column shell is a single flex
 * column with exactly three zones — the section nav (`flex: none`), the
 * panel-owned scroll body (`[data-mstar-scroll]`, flex: 1 1 auto ·
 * min-height: 0 · the ONLY `overflow-y: auto` element in the panel; it also
 * carries the `data-mstar-graph` content-container anchor), and the pinned
 * meta dock (`flex: none`). The workspace-state digest renders IN FLOW at the
 * end of the scroll body (the old 300px sibling column and its nested
 * scroller are gone); the freshness footer follows it in the same flow.
 *
 * Section state (plan sidebar §L2.4): the entry store, keyed by
 * `tabInfo.tab.id` (default `'tasks'`, D1) — it survives the body's unmount
 * when another pane tab activates, which `useState` cannot. The render is
 * SSR-stable: an untouched store reads `undefined` → the default tasks page.
 *
 * Empty branches (spec §2): waiting / loading / unavailable / no-harness
 * render no tabs, no digest and no meta dock — each with its OWN anchor and
 * copy, so a degraded read is never mistakable for an empty workspace.
 * Degradation stays total: `projectGraph` never throws; no iteration → the
 * IterationTaskPage's collapsed muted head (spec §8); `state` null / plans
 * missing → muted kanban skeleton.
 */

import * as React from 'react'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MstarEngineStatusPayload } from '../../types.ts'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import css from './panel.module.css'
import type { MstarEngineStatusClient } from './engine-status-client.ts'
import { projectGraph } from './graph/project-graph.ts'
import { PanelMeta } from './panel-meta.tsx'
import { Sidebar } from './sidebar.tsx'
import { TabNav } from './TabNav.tsx'
import { AgentListPage } from './pages/AgentListPage.tsx'
import { EventLogPage } from './pages/EventLogPage.tsx'
import { IterationTaskPage } from './pages/IterationTaskPage.tsx'
import { useMstarEngineStatus, type UseSessions } from './use-mstar-engine-status.ts'
import { createPanelStore, type PanelSection } from './panel-store.ts'

/**
 * The sidebar body seat's props (plan sidebar §L1.5): the seat's runtime
 * share (owner + keyed + the seat's inject face — `useTabInfo()` — + the
 * session standard kit, incl. the ui-chat-merged `useChat`) + the entry
 * store share (plan §L2.4 — the registration's `store` option) + the typed
 * `t` seat from the registration's `locale:` option.
 */
export interface MstarPanelBodyProps
  extends PropsRuntime<'sidebar.right.pane.tab'>,
    PropsStore<ReturnType<typeof createPanelStore>>,
    PropsLocale<'mstar-panel'> {
  /** Namespace-bound translate seat (`locale: 'mstar-panel'`). */
  t: TranslateNS<'mstar-panel'>
  /**
   * Current session identity — the session standard kit's own prop. Declared
   * here (rather than inherited) because this package does not depend on the
   * ui-session adapter that merges the session-kit declarations into
   * `SessionStandardProps`; the seat's session scope always supplies it at
   * runtime.
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
  /** The active panel section (plan sidebar §L1.5 vocabulary — not a sidebar tab record). */
  section: PanelSection
  source: MstarEngineStatusPayload
  t: TranslateNS<'mstar-panel'>
}

/**
 * Section → page mapping (spec §6.2): the only per-section-switching part of
 * the layout. tasks = the IterationTaskPage (spec §3 — Content Head + Steps
 * + the plan board); agents = the AgentListPage (spec §4 — the vertical
 * grouped list, plan sidebar §L3); events = the EventLogPage (spec §5 — the
 * log page with per-row `<details>` expansion).
 */
export function PanelContent({ section, source, t }: PanelContentProps) {
  // The projection is memoized on the SNAPSHOT identity (the payload object is
  // stable between snapshot stores updates) — the pages' downstream
  // `useMemo(..., [view])` memos stay effective instead of re-running on every
  // render against a fresh projection object.
  const view = React.useMemo(() => projectGraph(source), [source])
  if (section === 'agents') {
    // The SHARED iteration info section : the agents page receives the
    // SAME `view.iteration` the tasks page renders (IterationInfoSection).
    return <AgentListPage view={view.agents} iteration={view.iteration} t={t} />
  }
  if (section === 'events') return <EventLogPage view={view} t={t} />
  return <IterationTaskPage view={view} t={t} />
}

export function PanelView({ t, useChat, useSessions, sessionId, engineStatus, useTabInfo, useStore, actions }: MstarPanelBodyProps) {
  const view = useMstarEngineStatus({ useChat, useSessions, sessionId, engineStatus })
  // Visibility gate (plan sidebar §L2.6) + section state (plan §L2.4). All
  // hooks run before every early return (hooks rule) — the empty branches
  // never render the tab nav, and the store read is keyed by the tab record
  // id with the `'tasks'` default applied at the read site (D1, SSR-stable:
  // an untouched store renders the tasks page).
  const tabInfo = useTabInfo()
  const tabId = tabInfo.tab.id
  const section: PanelSection = useStore((s) => s.byTab[tabId]) ?? 'tasks'
  if (!tabInfo.tab.visible) return null
  const selectSection = (next: PanelSection): void => {
    actions.select(tabId, next)
  }
  if (view.state === 'waiting') {
    return (
      <div className={css.emptyRoot} data-mstar-panel="waiting">
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
      <div className={css.emptyRoot} data-mstar-panel="loading">
        <p className={css.empty} data-mstar-empty="loading">{t('empty.loading')}</p>
      </div>
    )
  }
  if (view.state === 'unavailable') {
    return (
      <div className={css.emptyRoot} data-mstar-panel="unavailable">
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
    // No harness → no tabs / no digest / no meta dock (spec §2 — empty branch
    // unchanged): a CENTERED inactive-state card (icon + main copy + hint)
    // with the freshness footer, in the shell's single scroll zone (plan
    // sidebar §L2.1 — the same three-zone language, degraded).
    return (
      <div className={css.root} data-mstar-panel="no-harness">
        <div className={css.scroll} data-mstar-scroll data-mstar-graph>
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
        </div>
      </div>
    )
  }
  // The narrow-column shell (plan sidebar §L2.1): three flex zones under the
  // pane body's definite height (L0.12 — the host's `.paneBody` is already a
  // definite-height box, so no composer-overlay opt-in exists any more). The
  // scroll zone is the panel's ONLY scroller: the active page, the in-flow
  // workspace-state digest and the freshness footer all live inside it; the
  // meta dock is pinned below.
  return (
    <div className={css.root} data-mstar-panel="panel">
      <TabNav active={section} onChange={selectSection} t={t} />
      <div className={css.scroll} data-mstar-scroll data-mstar-graph>
        <PanelContent section={section} source={source} t={t} />
        <Sidebar t={t} state={source.state} source={source} />
        {freshness}
      </div>
      <PanelMeta t={t} source={source} />
    </div>
  )
}
