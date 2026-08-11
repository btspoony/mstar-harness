/**
 * Event-log page — tab 3 placeholder (plan 20260811-panel-tabs-shell Task 3):
 * the 事件记录 tab renders a muted placeholder (spec panel-tabs §5/§8 — the
 * degradation matrix keeps the tab quiet until the real page lands): the
 * non-canvas log page (agent-flow events + violations, per-row `<details>`
 * expansion) ships with the event-log plan. The page contract stays `{ t }`
 * (spec §6.2); anchors: `data-mstar-page="events"` + the muted note
 * `data-mstar-page-note` (the browser harness probes its caption-color muted
 * rendering). Never throws / never guesses — muted copy only.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from '../panel.module.css'

export interface EventLogPageProps {
  t: TranslateNS<'mstar-panel'>
}

export function EventLogPage({ t }: EventLogPageProps) {
  return (
    <div className={css.page} data-mstar-page="events">
      <p className={css.pageNote} data-mstar-page-note>{t('page.events.placeholder')}</p>
    </div>
  )
}
