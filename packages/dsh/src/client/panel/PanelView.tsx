/**
 * The workflow panel's right-Sidebar seat — the host wrapper around the shared
 * product shell (plan dsh-panel-unification Tasks 2–3).
 *
 * This file owns exactly three things, all seat-specific:
 *
 * - the visibility gate (a collapsed sidebar column renders and polls nothing);
 * - the destination's home: the entry store, keyed by the sidebar tab id, so the
 *   destination survives the body's unmount when another pane tab activates;
 * - the host's "open the full page" affordance, whose handler is the plugin
 *   entry's `ctx.layout.selectPanel` call (`selectMstarPanel`).
 *
 * The transport states, the adapter and the shell all come from `panel-shell.tsx`
 * — the same module the keyed `main` panel mounts, so the two seats cannot drift.
 */

import * as React from 'react'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import css from './panel.module.css'
import type { MstarWorkflowPickerClient } from './workflow-picker-client.ts'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'
import type { UseSessions } from './use-mstar-workflow-picker.ts'
import { createPanelStore, isPanelDestination, type PanelDestination } from './panel-store.ts'
import { PanelSeat, type HostLocaleFace } from './panel-shell.tsx'
import type { HostThemeFace } from './theme.ts'

export type { HostLocaleFace } from './panel-shell.tsx'
export type { HostThemeFace } from './theme.ts'

/** The sidebar body seat's props: runtime share, entry store, `t` seat and the plugin-bound clients. */
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
  /** The store-backed snapshot client, bound by the plugin entry. Absent only in a composition that injects no transport. */
  panelSnapshot?: MstarPanelSnapshotClient
  /** The host's locale runtime, so the product's copy follows the host language. */
  localeFace?: HostLocaleFace
  /** The host's colour scheme, so the product flips its own token block. */
  themeFace?: HostThemeFace
  /** Render the host's enforcement line (session chrome: the sidebar does, the main panel does not). */
  enforcementLine?: boolean
  /**
   * Open this panel in the host's main area (the plugin entry binds
   * `ctx.layout.selectPanel`). Absent in a composition without the layout
   * service — the affordance then does not render, rather than doing nothing.
   */
  openMainPanel?: () => void
}

export function PanelView(props: MstarPanelBodyProps) {
  const { t, useSessions, sessionId, picker, panelSnapshot, localeFace, themeFace, enforcementLine, openMainPanel, useTabInfo, useStore, actions } = props
  const tabInfo = useTabInfo()
  const tabId = tabInfo.tab.id
  const stored = useStore((s) => s.byTab[tabId])
  const destination: PanelDestination = isPanelDestination(stored) ? stored : 'focus'
  // Hooks above, early return below: a collapsed column renders nothing at all.
  if (!tabInfo.tab.visible) return null
  return (
    <div className={css.root} data-mstar-seat="sidebar">
      {openMainPanel === undefined ? null : (
        <div className={css.toolbar}>
          <button type="button" className={css.openMain} data-mstar-open-main="" onClick={openMainPanel}>
            {t('panel.open-full-page')}
          </button>
        </div>
      )}
      <PanelSeat
        visible={tabInfo.tab.visible}
        destination={destination}
        onSelect={(next) => actions.select(tabId, next as PanelDestination)}
        t={t}
        {...(sessionId === undefined ? {} : { sessionId })}
        {...(useSessions === undefined ? {} : { useSessions })}
        {...(picker === undefined ? {} : { picker })}
        {...(panelSnapshot === undefined ? {} : { panelSnapshot })}
        {...(localeFace === undefined ? {} : { localeFace })}
        {...(themeFace === undefined ? {} : { themeFace })}
        {...(enforcementLine === true ? { enforcementLine: true } : {})}
      />
    </div>
  )
}
