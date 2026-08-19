/**
 * ProjectRollup (plan `20260819-workflow-dsh-viz` Task 3 — compass v3.0.0
 * AC-4/AC-P3): the ADDITIVE project rollup zone of the tasks page — roadmap
 * milestones + open-residual severity counts from the project layer
 * (`state.project`, produced by the catalog from `projects/<id>/roadmap.md`
 * frontmatter `milestones[]` + `projects/<id>/residuals.json` registers).
 *
 * Additive-only contract (compass AC-4): this zone renders BELOW the kanban
 * inside the tasks scroll body and never touches the four existing ZoneView
 * shapes (iteration stepper / kanban / agent flow / event log) — the
 * projection's `project` field is the only addition.
 *
 * Degradation (same philosophy as TaskBoard): empty `milestones` /
 * `openResiduals` (no roadmaps / no registers / no open entries) render the
 * muted "none" note — never an orange warn box, never a throw.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import css from './zones.module.css'

export interface ProjectRollupProps {
  view: ZoneView['project']
  t: TranslateNS<'mstar-panel'>
}

export function ProjectRollup({ view, t }: ProjectRollupProps) {
  const { milestones, openResiduals } = view
  return (
    <section className={css.zone} data-zone="project">
      <header className={css.tasksHeader} data-zone-header>
        <h2 className={css.zoneHeader}>{t('zone.project.title')}</h2>
      </header>

      <h3 className={css.zoneTitle} data-project-milestones-title>{t('zone.project.milestones')}</h3>
      {milestones.length === 0
        ? <p className={css.zoneEmpty} data-mstar-empty="no-milestones">{t('zone.project.none')}</p>
        : (
          <ul className={css.rollupList} data-project-milestones>
            {milestones.map((milestone, i) => (
              <li key={`${milestone}-${i}`} className={css.rollupItem} data-project-milestone>
                <span className={css.rollupMilestone}>{milestone}</span>
              </li>
            ))}
          </ul>
        )}

      <h3 className={css.zoneTitle} data-project-residuals-title>{t('zone.project.residuals')}</h3>
      {openResiduals.length === 0
        ? <p className={css.zoneEmpty} data-mstar-empty="no-project-residuals">{t('zone.project.none')}</p>
        : (
          <ul className={css.rollupList} data-project-residuals>
            {openResiduals.map((row, i) => (
              <li key={`${row.severity}-${i}`} className={css.rollupItem} data-project-residual>
                <span className={css.severityChip} data-severity={row.severity}>{row.severity}</span>
                <span className={css.rollupCount} data-project-residual-count={row.count}>{row.count}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
