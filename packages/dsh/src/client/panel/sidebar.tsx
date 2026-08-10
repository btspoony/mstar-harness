/**
 * Panel right sidebar (spec panel-layout-graph §1.1): fixed 300px column with
 * its own vertical scroll; the workspace-state digest (plans board / residual
 * counts / branches+policy / leases / knowledge / direction) reorganized from
 * the pre-layout StateSection content. Degradation: `state === null` renders
 * the no-state note instead of the digest (never a crash).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarHarnessState } from '../../types.ts'
import css from './panel.module.css'
import { StateSection } from './state-section.tsx'

export interface SidebarProps {
  t: TranslateNS<'mstar-panel'>
  state: MstarHarnessState | null
}

export function Sidebar({ t, state }: SidebarProps) {
  return (
    <aside className={css.sidebar} data-mstar-sidebar>
      {state === null
        ? <p className={css.empty} data-mstar-empty="no-state">{t('state.none')}</p>
        : <StateSection t={t} state={state} />}
    </aside>
  )
}
