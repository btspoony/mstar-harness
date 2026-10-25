/**
 * The workflow panel's keyed `main` seat — the full-page host for the SAME
 * product the right-Sidebar tab renders (plan dsh-panel-unification Task 3).
 *
 * It is deliberately thin: `panel-shell.tsx` carries the transport states, the
 * adapter and the shell, so this seat adds only what the main area alone owns —
 * a root that takes the host's main-area height, and the destination in
 * component state (a main panel is not unmounted by the sidebar's pane tabs, so
 * it needs no framework entry store).
 *
 * NOT here, by rule: window chrome. The host renders the panel inside its own
 * main area, so this seat draws no titlebar, no close control and no frame; the
 * product's own one-line page heading is the only heading, and it belongs to the
 * shared screen. The Sidebar's top edge stays the host tab strip.
 */

import * as React from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import css from './panel.module.css'
import type { MstarWorkflowPickerClient } from './workflow-picker-client.ts'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'
import type { UseSessions } from './use-mstar-workflow-picker.ts'
import { isPanelDestination, type PanelDestination } from './panel-store.ts'
import { PanelSeat, type HostLocaleFace } from './panel-shell.tsx'
import type { HostThemeFace } from './theme.ts'

/** The keyed main seat's props: the typed `t` seat plus the plugin-bound clients (no entry store, no tab info). */
export interface MstarMainPanelProps extends PropsLocale<'mstar-panel'> {
  /** Namespace-bound translate seat (`locale: 'mstar-panel'`). */
  t: TranslateNS<'mstar-panel'>
  /** Current session identity — the session standard kit's own prop. */
  sessionId?: SessionId
  /** Host session-list selector hook (the global standard seat). */
  useSessions?: UseSessions
  /** The workflow-pick client (the picker's WRITE; the read is `panelSnapshot`). */
  picker?: MstarWorkflowPickerClient
  /** The store-backed snapshot client, bound by the plugin entry. */
  panelSnapshot?: MstarPanelSnapshotClient
  /** The host's locale runtime, so the product's copy follows the host language. */
  localeFace?: HostLocaleFace
  /** The host's colour scheme, so the product flips its own token block. */
  themeFace?: HostThemeFace
}

export function MainPanelView(props: MstarMainPanelProps) {
  const { t, sessionId, useSessions, picker, panelSnapshot, localeFace, themeFace } = props
  const [destination, setDestination] = React.useState<PanelDestination>('focus')
  return (
    <div className={css.main} data-mstar-seat="main">
      <PanelSeat
        visible
        destination={destination}
        onSelect={(next) => {
          // The shared nav's ids are the destination vocabulary; anything else
          // leaves the current destination untouched (never a blank page).
          if (isPanelDestination(next)) setDestination(next)
        }}
        t={t}
        sessionFreeMainPanel
        {...(sessionId === undefined ? {} : { sessionId })}
        {...(useSessions === undefined ? {} : { useSessions })}
        {...(picker === undefined ? {} : { picker })}
        {...(panelSnapshot === undefined ? {} : { panelSnapshot })}
        {...(localeFace === undefined ? {} : { localeFace })}
        {...(themeFace === undefined ? {} : { themeFace })}
      />
    </div>
  )
}
