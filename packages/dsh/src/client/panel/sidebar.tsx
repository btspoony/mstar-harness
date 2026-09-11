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
 * Degradation: `state === null` renders the no-state note instead of the
 * digest (never a crash).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarEngineStatusPayload, MstarHarnessState } from '../../types.ts'
import css from './panel.module.css'
import { StateSection } from './state-section.tsx'

export interface SidebarProps {
  t: TranslateNS<'mstar-panel'>
  state: MstarHarnessState | null
  source: MstarEngineStatusPayload
}

export function Sidebar({ t, state, source }: SidebarProps) {
  return (
    <aside className={css.sidebar} data-mstar-sidebar>
      {state === null
        ? <p className={css.empty} data-mstar-empty="no-state">{t('state.none')}</p>
        : <StateSection t={t} state={state} enforcement={source.enforcement} />}
    </aside>
  )
}
