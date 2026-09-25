/**
 * ProjectRollup: roadmap milestones + open-residual severity counts from the
 * store-backed project authority and issue store.
 *
 * Roadmap absence and read failure are disclosed separately from a present
 * roadmap with no milestones. All content is rendered as text.
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
  const { milestones, openResiduals, roadmapSource } = view
  return (
    <section className={css.zone} data-zone="project" data-roadmap-source={roadmapSource.kind}>
      <header className={css.tasksHeader} data-zone-header>
        <h2 className={css.zoneHeader}>{t('zone.project.title')}</h2>
      </header>

      <h3 className={css.zoneTitle} data-project-milestones-title>{t('zone.project.milestones')}</h3>
      {roadmapSource.kind === 'unavailable'
        ? <p className={css.zoneEmpty} data-mstar-roadmap="unavailable">{t('zone.project.roadmap.unavailable', { reason: roadmapSource.diagnostic ?? t('panel.unknown') })}</p>
        : roadmapSource.kind === 'absent'
          ? roadmapSource.absentProjectIds.length === 0
            ? <p className={css.zoneEmpty} data-mstar-roadmap="absent">{t('zone.project.none')}</p>
            : <p className={css.zoneEmpty} data-mstar-roadmap="absent">{t('zone.project.roadmap.partial', { projects: roadmapSource.absentProjectIds.join(', ') })}</p>
          : milestones.length === 0
            ? <p className={css.zoneEmpty} data-mstar-roadmap="empty">{t('zone.project.roadmap.empty')}</p>
            : (
              <ul className={css.rollupList} data-project-milestones>
                {milestones.map((milestone, i) => (
                  <li key={`${milestone}-${i}`} className={css.rollupItem} data-project-milestone>
                    <span className={css.rollupMilestone}>{milestone}</span>
                  </li>
                ))}
              </ul>
            )}
      {roadmapSource.kind === 'present' && roadmapSource.absentProjectIds.length > 0
        ? <p className={css.zoneEmpty} data-mstar-roadmap-partial={roadmapSource.absentProjectIds.join(',')}>
          {t('zone.project.roadmap.partial', { projects: roadmapSource.absentProjectIds.join(', ') })}
        </p>
        : null}

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
