/**
 * Morning Star workflow panel page — the right-Sidebar pane body (the keyed
 * `sidebar.right.pane.tab` seat component).
 *
 * DATA PATH: `useMstarPanelSnapshot()` polls the host's `mstar/panelSnapshot`
 * endpoint while the tab is visible and returns the closed `MstarPanelView`
 * union (`waiting` / `loading` / `ok` / `unavailable`). The panel renders a
 * store-backed `PanelSnapshot`; `projectGraph` projects it into the zone view
 * model the pages consume. Nothing here reads the emission relay any more.
 *
 * Picker: the workflow selection control's WRITE rides its own client
 * (`useMstarWorkflowPicker`) and contributes only `pick` / `select` to the
 * digest. The selection it renders comes from the snapshot's
 * `retained.selection`, rebuilt by the host from the same durable binding.
 *
 * Visibility (plan sidebar §L2.6): a docked body is projected only while its
 * sidebar column is expanded and the tab is active — `useTabInfo().tab.visible`
 * — so a collapsed column renders NOTHING and polls NOTHING.
 *
 * Layout (plan sidebar §L2.1): the narrow-column shell is a single flex column
 * with exactly three zones — the section nav (`flex: none`), the panel-owned
 * scroll body (`[data-mstar-scroll]`, the ONLY `overflow-y: auto` element), and
 * the pinned meta dock (`flex: none`). The workspace digest renders IN FLOW at
 * the end of the scroll body; the freshness footer follows it.
 *
 * Section state: the entry store, keyed by `tabInfo.tab.id` (default
 * `'tasks'`) — it survives the body's unmount when another pane tab activates.
 *
 * Empty branches: waiting / loading (with no previous snapshot) / unavailable /
 * no-harness render no tabs, no digest and no meta dock — each with its OWN
 * anchor and copy, so a degraded read is never mistakable for an empty
 * workspace. A refresh keeps painting the last good snapshot (`loading.previous`).
 */

import * as React from 'react'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import css from './panel.module.css'
import type { MstarWorkflowPickerClient } from './workflow-picker-client.ts'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'
import type { PanelSnapshot } from '../../panel/panel-snapshot.ts'
import { projectGraph, type ZoneView } from './graph/project-graph.ts'
import { PanelMeta } from './panel-meta.tsx'
import { Sidebar } from './sidebar.tsx'
import { TabNav } from './TabNav.tsx'
import { EventLogPage } from './pages/EventLogPage.tsx'
import { IterationTaskPage } from './pages/IterationTaskPage.tsx'
import { RoadmapPage } from './pages/RoadmapPage.tsx'
import { useMstarPanelSnapshot } from './use-mstar-panel-snapshot.ts'
import { useMstarWorkflowPicker, type UseSessions } from './use-mstar-workflow-picker.ts'
import { createPanelStore, type PanelSection } from './panel-store.ts'

/**
 * The sidebar body seat's props: the seat's runtime share (`useTabInfo()` + the
 * session standard kit) + the entry store share + the typed `t` seat + the two
 * plugin-bound clients.
 */
export interface MstarPanelBodyProps
  extends PropsRuntime<'sidebar.right.pane.tab'>,
    PropsStore<ReturnType<typeof createPanelStore>>,
    PropsLocale<'mstar-panel'> {
  /** Namespace-bound translate seat (`locale: 'mstar-panel'`). */
  t: TranslateNS<'mstar-panel'>
  /** Current session identity — the session standard kit's own prop. */
  sessionId?: SessionId
  /** Host session-list selector hook (the global standard seat). */
  useSessions?: UseSessions
  /** The workflow-pick client (the picker's WRITE; the read is `panelSnapshot`). */
  picker?: MstarWorkflowPickerClient
  /**
   * The store-backed snapshot client (bound to the client `connection` service
   * by the plugin entry). The panel polls it while the tab is visible; absent
   * only in a composition that injects no transport (then `waiting`).
   */
  panelSnapshot?: MstarPanelSnapshotClient
}

/**
 * Freshness timestamp: local HH:MM:SS of the SERVED snapshot's `at` — the
 * marker is the snapshot's own timestamp, never "live". An unparseable stamp
 * renders no marker at all rather than an `Invalid Date`.
 */
function formatSnapshotTime(at: string): string | null {
  const ms = Date.parse(at)
  return Number.isNaN(ms) ? null : new Date(ms).toLocaleTimeString('en-GB')
}

export interface PanelContentProps {
  section: PanelSection
  /** The projection of the polled snapshot (built once by the shell). */
  view: ZoneView
  t: TranslateNS<'mstar-panel'>
}

/**
 * Section → page mapping: tasks = the iteration head + plan board + project
 * rollup; roadmap = the 项目路线图 page; events = the single merged flow.
 */
export function PanelContent({ section, view, t }: PanelContentProps) {
  if (section === 'roadmap') return <RoadmapPage view={view.roadmap} t={t} />
  if (section === 'events') return <EventLogPage view={view} t={t} />
  return <IterationTaskPage view={view} t={t} />
}

/** The session's workspace directory (the host cross-checks it against the session). */
function sessionCwd(useSessions: UseSessions | undefined, sessionId: SessionId | undefined): string | null {
  if (useSessions === undefined || sessionId === undefined) return null
  const cwd = useSessions((s) => s.byId[sessionId]?.cwd ?? null)
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * The "no harness" card: a CENTERED inactive-state card (glyph + main copy +
 * hint) for the one situation where there is nothing to read — the workspace
 * declares no resolvable `{HARNESS_DIR}`. Rendered by BOTH the `no-harness`
 * view state (no snapshot) and an `ok` snapshot that reports no harness
 * directory, so the two paths can never drift apart.
 */
function NoHarnessCard({ t }: { t: TranslateNS<'mstar-panel'> }) {
  return (
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
        <path d="M9.7 9.4a2.4 2 0 1 1 3.4 2.2c-.7.3-1 .8-1 1.5" />
        <circle cx="12" cy="16.4" r="0.6" />
      </svg>
      <p className={css.noHarnessTitle} data-mstar-empty="no-harness">{t('empty.no-harness')}</p>
      <p className={css.noHarnessHint}>{t('empty.no-harness-hint')}</p>
    </div>
  )
}

export function PanelView(props: MstarPanelBodyProps) {
  const { t, useSessions, sessionId, picker, panelSnapshot, useTabInfo, useStore, actions } = props
  const tabInfo = useTabInfo()
  const tabId = tabInfo.tab.id
  const section: PanelSection = useStore((s) => s.byTab[tabId]) ?? 'tasks'
  const cwd = sessionCwd(useSessions, sessionId)
  const snapshotView = useMstarPanelSnapshot({
    visible: tabInfo.tab.visible,
    client: panelSnapshot,
    sessionId: sessionId === undefined ? null : String(sessionId),
    cwd,
  })
  // The picker's WRITE half only: what it contributes is the commit state
  // (`pick`) and `select`. The SELECTION it displays rides the snapshot below.
  const { pick, select } = useMstarWorkflowPicker({ useSessions, sessionId, picker })
  // Every hook runs before the early returns below (hooks rule). A refresh keeps
  // painting the last good snapshot (`loading.previous`); only the FIRST read
  // has none.
  const snapshot = snapshotView.state === 'ok'
    ? snapshotView.snapshot
    : snapshotView.state === 'loading' ? snapshotView.previous : null
  // One projection per snapshot identity: the pages' downstream `useMemo(...,
  // [view])` memos stay effective instead of re-running on every render.
  const view = React.useMemo<ZoneView>(() => projectGraph(snapshot), [snapshot])

  if (!tabInfo.tab.visible) return null
  const selectSection = (next: PanelSection): void => {
    actions.select(tabId, next)
  }
  if (snapshotView.state === 'waiting') {
    return (
      <div className={css.emptyRoot} data-mstar-panel="waiting">
        <p className={css.empty} data-mstar-empty="waiting">{t('empty.waiting')}</p>
      </div>
    )
  }
  if (snapshotView.state === 'no-harness') {
    // No harness root resolved: its own state and card — never a wire reason.
    return (
      <div className={css.root} data-mstar-panel="no-harness">
        <div className={css.scroll} data-mstar-scroll data-mstar-graph>
          <NoHarnessCard t={t} />
        </div>
      </div>
    )
  }
  if (snapshotView.state === 'unavailable') {
    return (
      <div className={css.emptyRoot} data-mstar-panel="unavailable">
        <p className={css.empty} data-mstar-empty="unavailable" data-mstar-unavailable-reason={snapshotView.reason}>
          {t('empty.unavailable', { reason: snapshotView.reason })}
        </p>
      </div>
    )
  }
  if (snapshot === null) {
    return (
      <div className={css.emptyRoot} data-mstar-panel="loading">
        <p className={css.empty} data-mstar-empty="loading">{t('empty.loading')}</p>
      </div>
    )
  }
  const snapshotTime = formatSnapshotTime(snapshot.at)
  // The retained catalog facts are a SECOND freshness domain: their age is the
  // payload's build instant, shown separately so a stale catalog fact is never
  // mistaken for a stale store read (or vice versa).
  const retainedAt = snapshot.retained.at
  const retainedTime = retainedAt === null ? null : formatSnapshotTime(retainedAt)
  const freshness = (
    <footer className={css.freshness} data-mstar-freshness>
      {snapshotTime === null
        ? null
        : (
          <span data-mstar-freshness-at={snapshot.at}>
            {t('freshness.last-updated', { time: snapshotTime })}
          </span>
        )}
      {retainedAt === null || retainedTime === null
        ? null
        : (
          <span data-mstar-freshness-retained={retainedAt}>
            {t('freshness.retained', { time: retainedTime })}
          </span>
        )}
      <span>{t('freshness.refresh-note')}</span>
    </footer>
  )
  if (snapshot.harnessDir === null) {
    // An `ok` snapshot whose harness directory is absent still renders the
    // dedicated card (the store normally answers the `no-harness` kind instead).
    return (
      <div className={css.root} data-mstar-panel="no-harness">
        <div className={css.scroll} data-mstar-scroll data-mstar-graph>
          <NoHarnessCard t={t} />
          {freshness}
        </div>
      </div>
    )
  }

  // The narrow-column shell: three flex zones under the pane body's definite
  // height. The scroll zone is the panel's ONLY scroller: the active page, the
  // in-flow workspace-state digest and the freshness footer all live inside it;
  // the meta dock is pinned below.
  return (
    <div className={css.root} data-mstar-panel="panel">
      <TabNav active={section} onChange={selectSection} t={t} />
      <div className={css.scroll} data-mstar-scroll data-mstar-graph>
        <PanelContent section={section} view={view} t={t} />
        <Sidebar
          t={t}
          view={view}
          snapshot={snapshot}
          selection={snapshot.retained.selection}
          pick={pick}
          select={select}
        />
        {freshness}
      </div>
      <PanelMeta t={t} snapshot={snapshot} />
    </div>
  )
}
