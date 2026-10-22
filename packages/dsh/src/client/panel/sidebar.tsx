/**
 * Workspace-state digest (plan sidebar §L2.1): the former 300px sidebar
 * column, now IN FLOW at the end of the panel's scroll body — the digest is
 * not a column any more, and its own nested scroller
 * (`data-mstar-sidebar-scroll`) is retired: `[data-mstar-scroll]` is the
 * panel's single scroller and this block is flow content inside it. The
 * bottom meta dock moved to the shell's third zone (PanelView renders it
 * directly), so this component renders ONLY the digest.
 *
 * `data-mstar-sidebar` stays on the digest block (anchor lineage).
 * Degradation: neither workspace authority readable renders the no-state note
 * instead of the digest (never a crash, never a fabricated digest).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelSnapshot } from '../../panel/panel-snapshot.ts'
import type { ZoneView } from './graph/project-graph.ts'
import css from './panel.module.css'
import { StateSection, type MstarSelectionSeat } from './state-section.tsx'

export interface SidebarProps extends MstarSelectionSeat {
  t: TranslateNS<'mstar-panel'>
  /** The projection of the same snapshot the pages render. */
  view: ZoneView
  snapshot: PanelSnapshot
}

export function Sidebar({ t, view, snapshot, selection, pick, select }: SidebarProps) {
  return (
    <aside className={css.sidebar} data-mstar-sidebar>
      {snapshot.workspace.workflow.state !== 'ok' && snapshot.workspace.iteration.state !== 'ok'
        ? <p className={css.empty} data-mstar-empty="no-state">{t('state.none')}</p>
        : (
          <StateSection
            t={t}
            view={view}
            snapshot={snapshot}
            selection={selection}
            pick={pick}
            select={select}
          />
        )}
    </aside>
  )
}
