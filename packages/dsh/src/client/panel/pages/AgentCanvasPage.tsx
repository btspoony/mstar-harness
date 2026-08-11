/**
 * Agent-run page — tab 2 placeholder (plan 20260811-panel-tabs-shell Task 1):
 * the 代理执行 tab currently renders a muted placeholder; the draggable agent
 * canvas (all-roster entities + idle states + AgentEdge collaboration edges)
 * lands with the agent-canvas plan (spec panel-tabs §4). Task 3 refines the
 * placeholder page; the page contract stays `{ t }` (spec §6.2). Never
 * throws / never guesses — muted copy only.
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
      <p className={css.empty}>{t('page.agents.placeholder')}</p>
    </div>
  )
}
