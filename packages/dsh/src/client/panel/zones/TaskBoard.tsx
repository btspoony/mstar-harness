/**
 * TaskBoard — PLACEHOLDER (plan 20260810-panel-canvas-zones Task 2): the zone
 * frame + header + muted empty state. The 6 kanban columns, count badges,
 * plan cards, Done cap and the flow arrows land in Task 4 — the placeholder
 * must render without crashing for any `ZoneView['tasks']` projection (spec
 * §8 degradation: state null / plans missing → same muted frame).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import css from './zones.module.css'

export interface TaskBoardProps {
  view: ZoneView['tasks']
  t: TranslateNS<'mstar-panel'>
}

export function TaskBoard({ t }: TaskBoardProps) {
  return (
    <section className={css.zone} data-zone="tasks">
      <h2 className={css.zoneHeader} data-zone-header>{t('zone.tasks.title')}</h2>
      <p className={css.zoneEmpty} data-zone-empty>{t('zone.tasks.placeholder')}</p>
    </section>
  )
}
