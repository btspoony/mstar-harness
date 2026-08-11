/**
 * Agent-run page — tab 2 placeholder (plan 20260811-panel-tabs-shell Task 3):
 * the 代理执行 tab renders a muted placeholder (spec panel-tabs §4/§8 — the
 * degradation matrix keeps the tab quiet until the real page lands): the
 * draggable agent canvas (all-roster entities + idle states + AgentEdge
 * collaboration edges) ships with the agent-canvas plan. The page contract
 * stays `{ t }` (spec §6.2); anchors: `data-mstar-page="agents"` + the muted
 * note `data-mstar-page-note` (the browser harness probes its caption-color
 * muted rendering). Never throws / never guesses — muted copy only.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from '../panel.module.css'

export interface AgentCanvasPageProps {
  t: TranslateNS<'mstar-panel'>
}

export function AgentCanvasPage({ t }: AgentCanvasPageProps) {
  return (
    <div className={css.page} data-mstar-page="agents">
      <p className={css.pageNote} data-mstar-page-note>{t('page.agents.placeholder')}</p>
    </div>
  )
}
