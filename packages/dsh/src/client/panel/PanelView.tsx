/**
 * Morning Star workflow panel page — the `conversation.view` tab component
 * (spec §4.2): pure render of the latest `mstar-engine-status` catalog row.
 *
 * Inputs: the session standard kit (`ConvViewProps`) and the typed `t` seat
 * (`locale: 'mstar-panel'`). The catalog row + message time come from the
 * `useMstarEngineStatus()` hook riding the kit's `useSession` selector (spec
 * §5) — the render body is a pure function of (source, lastUpdated, t).
 *
 * Layout (spec panel-layout-graph §1.1): root grid `"header header" /
 * "main sidebar"` — header = 3 evenly-spread basics (version / harness dir /
 * enforcement), main = graph region (placeholder for the Task 2 react-flow
 * loop; currently hosts the iteration gate detail), sidebar = workspace-state
 * digest (plans / residuals / branches+policy / leases / knowledge /
 * direction). Below 860px the sidebar stacks under the main area.
 *
 * Empty states (spec §3): no catalog row → waiting hint; harness missing
 * (`harnessDir` null + `state` null + no `iteration`, absent or null) →
 * no-harness hint while the header still renders; gate missing (`iteration`
 * absent or null) → no-compass note while the sidebar still renders. The
 * no-session case is shell-handled by the strict-session view ring.
 */

import * as React from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './panel.module.css'
import { IterationSection } from './iteration-section.tsx'
import { PanelHeader } from './panel-header.tsx'
import { Sidebar } from './sidebar.tsx'
import { useMstarEngineStatus } from './use-mstar-engine-status.ts'

export interface MstarPanelViewProps extends ConvViewProps {
  /** Namespace-bound translate seat (`locale: 'mstar-panel'`). */
  t: TranslateNS<'mstar-panel'>
}

/** Freshness timestamp: local HH:MM:SS (spec §5). */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB')
}

export function PanelView({ t, useSession }: MstarPanelViewProps) {
  const { source, lastUpdated } = useMstarEngineStatus(useSession)
  if (source === null || source === undefined) {
    return (
      <div className={css.emptyRoot} data-mstar-panel="waiting">
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
    // No harness → no graph region (spec §2.5): header + hint in a single-column root.
    return (
      <div className={css.root} data-mstar-panel="no-harness">
        <PanelHeader t={t} source={source} />
        <main className={css.main} data-mstar-graph>
          <p className={css.empty} data-mstar-empty="no-harness">{t('empty.no-harness')}</p>
          {freshness}
        </main>
      </div>
    )
  }
  return (
    <div className={css.root} data-mstar-panel="panel">
      <PanelHeader t={t} source={source} />
      <main className={css.main} data-mstar-graph>
        <div className={css.graph}>
          {source.iteration == null
            ? <p className={css.empty} data-mstar-empty="no-gate">{t('iteration.no-compass')}</p>
            : (
              // Graph area placeholder — Task 2 swaps this frame for GraphCanvas.
              <div className={css.graphPlaceholder} data-mstar-graph-placeholder>
                <p className={css.graphPlaceholderNote}>{t('graph.placeholder')}</p>
                <IterationSection t={t} iteration={source.iteration} />
              </div>
            )}
        </div>
        {freshness}
      </main>
      <Sidebar t={t} state={source.state} />
    </div>
  )
}
