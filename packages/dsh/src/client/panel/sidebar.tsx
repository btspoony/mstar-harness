/**
 * Panel right sidebar (spec panel-zones §5): fixed 300px column, full height,
 * flex column — the workspace-state digest scrolls in its own region
 * (`flex: 1; min-height: 0; overflow-y: auto`), while the bottom meta dock
 * (version + harness dir) stays pinned and does NOT scroll with the digest.
 * Degradation: `state === null` renders the no-state note instead of the
 * digest (never a crash); the meta dock still renders from the source.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarEngineStatusSource, MstarHarnessState } from '../../types.ts'
import css from './panel.module.css'
import { PanelMeta } from './panel-meta.tsx'
import { StateSection } from './state-section.tsx'

export interface SidebarProps {
  t: TranslateNS<'mstar-panel'>
  state: MstarHarnessState | null
  source: MstarEngineStatusSource
}

export function Sidebar({ t, state, source }: SidebarProps) {
  return (
    <aside className={css.sidebar} data-mstar-sidebar>
      <div className={css.sidebarScroll} data-mstar-sidebar-scroll>
        {state === null
          ? <p className={css.empty} data-mstar-empty="no-state">{t('state.none')}</p>
          : <StateSection t={t} state={state} enforcement={source.enforcement} />}
      </div>
      <PanelMeta t={t} source={source} />
    </aside>
  )
}
