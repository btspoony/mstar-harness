/**
 * IterationZone — PLACEHOLDER (plan 20260810-panel-canvas-zones Task 2): the
 * zone frame + header + muted empty state. The Step 1–5 stepper, Step N
 * badge, verdict and the branch panel land in Task 3 (`IterationZone` is
 * filled there) — the placeholder must render without crashing for any
 * `ZoneView['iteration']` projection (spec §8 degradation).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import css from './zones.module.css'

export interface IterationZoneProps {
  view: ZoneView['iteration']
  t: TranslateNS<'mstar-panel'>
}

export function IterationZone({ t }: IterationZoneProps) {
  return (
    <section className={css.zone} data-zone="iteration">
      <h2 className={css.zoneHeader} data-zone-header>{t('zone.iteration.title')}</h2>
      <p className={css.zoneEmpty} data-zone-empty>{t('zone.iteration.placeholder')}</p>
    </section>
  )
}
