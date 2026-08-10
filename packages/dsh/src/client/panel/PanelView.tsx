/**
 * Morning Star workflow panel page — the `conversation.view` tab component
 * (spec §4.2): pure render of the latest `mstar-engine-status` catalog row.
 *
 * Inputs: the session standard kit (`ConvViewProps`) and the typed `t` seat
 * (`locale: 'mstar-panel'`). The catalog row + message time come from the
 * `useMstarEngineStatus()` hook riding the kit's `useSession` selector (spec
 * §5) — the render body is a pure function of (source, lastUpdated, t).
 *
 * Layout (spec panel-zones §2): root grid `"main sidebar"` fills the Tab
 * (height 100%, overflow hidden — the page never scrolls); main = the graph
 * region (zone skeleton filled by plan 20260810-panel-canvas-zones) +
 * freshness footer, sidebar = workspace-state digest with the bottom fixed
 * meta dock (version + harness dir). Below 860px the sidebar stacks under
 * the main area.
 *
 * Graph mount gating (spec §2.5, T1 review minor-1): the canvas mounts ONLY
 * in the harness-present branch — the `data-mstar-graph` anchor also exists
 * on the no-harness hint container, but no GraphCanvas is rendered there.
 * Degradation stays total: `projectGraph` never throws; no iteration →
 * schema ring + no-compass note; `state` null / plans missing → machine
 * skeleton + notes. The no-session case is shell-handled by the
 * strict-session view ring.
 */

import * as React from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './panel.module.css'
import { GraphCanvas } from './graph/GraphCanvas.tsx'
import { projectGraph } from './graph/project-graph.ts'
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
    // No harness → no graph region (spec §2.5): hint + freshness in a
    // single-column root. The `data-mstar-graph` anchor is present for the
    // layout contract, but the GraphCanvas mount is gated to the
    // harness-present branch below.
    return (
      <div className={css.root} data-mstar-panel="no-harness">
        <main className={css.main} data-mstar-graph>
          <p className={css.empty} data-mstar-empty="no-harness">{t('empty.no-harness')}</p>
          {freshness}
        </main>
      </div>
    )
  }
  return (
    <div className={css.root} data-mstar-panel="panel">
      <main className={css.main} data-mstar-graph>
        <div className={css.graph}>
          <GraphCanvas view={projectGraph(source)} t={t} />
        </div>
        {freshness}
      </main>
      <Sidebar t={t} state={source.state} source={source} />
    </div>
  )
}
