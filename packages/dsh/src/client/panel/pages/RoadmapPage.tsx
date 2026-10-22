/**
 * RoadmapPage — the 项目路线图 tab: the roadmap authority's direction, its
 * goals and the milestone ↔ issue membership, read from the store on every
 * poll tick.
 *
 * THE FOUR ABSENCE STATES ARE DIFFERENT RENDERS (never one "empty" branch),
 * each with its own anchor:
 * - `data-roadmap-state="not-applicable"` — no project resolved; nothing was
 *   read (`data-roadmap-not-applicable`);
 * - `data-roadmap-state="absent"` — a project resolved, the authority has no
 *   roadmap row (`data-roadmap-absent`);
 * - `data-roadmap-state="no-milestones"` — a roadmap present with zero
 *   milestone rows (`data-roadmap-empty="no-milestones"`);
 * - `data-roadmap-state="unavailable"` — the read failed; the store's own
 *   reason is rendered verbatim (`data-roadmap-unavailable` +
 *   `data-roadmap-reason`).
 * A roadmap with milestones renders `data-roadmap-state="ok"`.
 *
 * Degradation is total: every field is guarded by the projection ('' / null →
 * the muted 「—」 seat), so a content-less roadmap still renders its milestone
 * rows and the goal list collapses to its own muted note.
 *
 * Layout: flow content in the panel's single scroll body (no page-owned
 * scroller); one column, wrapped with `overflow-wrap` — never a horizontal
 * scrollbar in the narrow sidebar.
 */

import * as React from 'react'
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RoadmapZoneView } from '../graph/project-graph.ts'
import css from './roadmap.module.css'

export interface RoadmapPageProps {
  view: RoadmapZoneView
  t: TranslateNS<'mstar-panel'>
}

/** The page's own state label — one of the four absence states or `ok`. */
function stateOf(view: RoadmapZoneView): 'ok' | 'not-applicable' | 'absent' | 'no-milestones' | 'unavailable' {
  if (view.state === 'unavailable') return 'unavailable'
  if (view.state === 'not-applicable') return 'not-applicable'
  if (!view.present) return 'absent'
  return view.milestones.length === 0 ? 'no-milestones' : 'ok'
}

export function RoadmapPage({ view, t }: RoadmapPageProps) {
  const state = stateOf(view)
  const [directionOpen, setDirectionOpen] = useState(false)
  const direction = view.direction ?? ''

  return (
    <div className={css.page} data-mstar-page="roadmap" data-roadmap-state={state}>
      <header className={css.header} data-roadmap-header>
        <h2 className={css.title}>{t('roadmap.title')}</h2>
      </header>

      {state === 'unavailable' && (
        <p className={css.note} data-roadmap-unavailable data-roadmap-reason={view.reason ?? ''}>
          {t('roadmap.unavailable', { reason: view.reason ?? t('panel.unknown') })}
        </p>
      )}
      {state === 'not-applicable' && (
        <p className={css.note} data-roadmap-not-applicable>
          {t('roadmap.not-applicable')}
        </p>
      )}
      {state === 'absent' && (
        <p className={css.note} data-roadmap-absent>{t('roadmap.absent')}</p>
      )}

      {state === 'ok' && (
        <>
          <section className={css.block} data-roadmap-direction-block>
            <h3 className={css.blockTitle}>{t('roadmap.direction')}</h3>
            {direction === ''
              ? <p className={css.note} data-roadmap-direction-missing>{t('state.none')}</p>
              : (
                <>
                  <p
                    className={directionOpen ? css.direction : `${css.direction} ${css.clamp}`}
                    data-roadmap-direction
                    data-roadmap-direction-clamped={directionOpen ? 'false' : 'true'}
                  >
                    {direction}
                  </p>
                  <button
                    type="button"
                    className={css.toggle}
                    data-roadmap-direction-toggle={directionOpen ? 'collapse' : 'expand'}
                    aria-expanded={directionOpen}
                    onClick={() => setDirectionOpen((open) => !open)}
                  >
                    {directionOpen ? t('roadmap.collapse') : t('roadmap.expand')}
                  </button>
                </>
              )}
          </section>

          <section className={css.block} data-roadmap-goals-block>
            <h3 className={css.blockTitle}>{t('roadmap.goals')}</h3>
            {view.goals.length === 0
              ? <p className={css.note} data-roadmap-empty="no-goals">{t('state.none')}</p>
              : (
                <ul className={css.goals} data-roadmap-goals>
                  {view.goals.map((goal, i) => (
                    <li
                      key={`${goal.ordinal}-${i}`}
                      className={css.goal}
                      // Nesting is a display indent, driven by the goal's parent
                      // ordinal — never a fabricated hierarchy.
                      style={{ paddingInlineStart: `calc(var(--mstar-space-3) * ${goal.parentOrdinal === null ? 0 : 1})` }}
                      data-roadmap-goal={goal.ordinal}
                      data-roadmap-goal-checked={goal.checked ? 'true' : 'false'}
                    >
                      <span className={css.check} aria-hidden="true">{goal.checked ? '☑' : '☐'}</span>
                      <span className={css.goalTitle}>{goal.title === '' ? t('panel.unknown') : goal.title}</span>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section className={css.block} data-roadmap-milestones-block>
            <h3 className={css.blockTitle}>{t('roadmap.milestones')}</h3>
            {view.milestones.length === 0
              ? <p className={css.note} data-roadmap-empty="no-milestones">{t('roadmap.no-milestones')}</p>
              : (
                <ul className={css.milestones} data-roadmap-milestones>
                  {view.milestones.map((milestone, i) => (
                    <li className={css.milestone} key={`${milestone.name}-${i}`} data-roadmap-milestone={i}>
                      <div className={css.milestoneHead}>
                        <span className={css.milestoneName}>{milestone.name === '' ? t('panel.unknown') : milestone.name}</span>
                        <span className={css.milestoneTarget} data-roadmap-milestone-target={milestone.target ?? ''}>
                          {milestone.target ?? '—'}
                        </span>
                        <span className={css.milestoneStatus} data-roadmap-milestone-status={milestone.status ?? ''}>
                          {milestone.status ?? t('panel.unknown')}
                        </span>
                      </div>
                      {milestone.issues.length === 0
                        ? <p className={css.note} data-roadmap-milestone-empty>{t('roadmap.milestone.no-issues')}</p>
                        : (
                          <ul className={css.issues} data-roadmap-milestone-issues>
                            {milestone.issues.map((issue) => (
                              <li className={css.issue} key={issue.id} data-roadmap-issue={issue.id}>
                                <code className={css.issueId}>{issue.id}</code>
                                <span className={css.severity} data-roadmap-issue-severity={issue.severity}>
                                  {issue.severity === '' ? t('panel.unknown') : issue.severity}
                                </span>
                                <span className={css.issueTitle}>{issue.title === '' ? t('panel.unknown') : issue.title}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                    </li>
                  ))}
                </ul>
              )}
            {view.unassignedIssues > 0 && (
              <p className={css.unassigned} data-roadmap-unassigned={view.unassignedIssues}>
                {t('roadmap.unassigned', { count: String(view.unassignedIssues) })}
              </p>
            )}
          </section>
        </>
      )}

      {state === 'no-milestones' && (
        <>
          <p className={css.note} data-roadmap-empty="no-milestones">{t('roadmap.no-milestones')}</p>
          {direction !== '' && <p className={css.direction} data-roadmap-direction>{direction}</p>}
        </>
      )}
    </div>
  )
}
