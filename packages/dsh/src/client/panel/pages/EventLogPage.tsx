/**
 * Event-log page — tab 3 placeholder (plan 20260811-panel-tabs-shell Task 1):
 * the 事件记录 tab currently renders a muted placeholder; the non-canvas log
 * page (agent-flow events + violations, per-row `<details>` expansion) lands
 * with the event-log plan (spec panel-tabs §5). Task 3 refines the
 * placeholder page; the page contract stays `{ t }` (spec §6.2). Never
 * throws / never guesses — muted copy only.
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
      <p className={css.empty}>{t('page.events.placeholder')}</p>
    </div>
  )
}
