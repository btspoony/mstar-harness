/**
 * TaskBoard (plan 20260810-panel-canvas-zones Task 4, spec panel-zones §3) —
 * the tasks-zone kanban: the 6 PLAN_STATE_IDS columns (Todo / InProgress /
 * InReview / Done / Blocked / unknown, in the projection's constant order),
 * each with a localized state-name header + count badge, plan cards (mono
 * ellipsized id + status chip — the `data-plan-id` / `data-plan-status`
 * anchors shared with the sidebar plan board), the dim inter-column flow
 * arrows (spec §2.4: Todo→InProgress→InReview→Done plus the
 * InProgress↔Blocked back-edge), the Done-column overflow hint, and the
 * muted "no plans" empty state.
 *
 * The Done cap is NOT re-implemented here: the projection already applies the
 * shared plan-sort key (`plan-sort.ts` — `sortPlans` + `PLAN_CAP`, spec §3,
 * reused not copied) and hands over `column.plans` (≤5) + `column.capped`
 * (PLAN_CAP when the column overflowed). This render only shows the `+N more`
 * hint when `capped` is set — non-Done columns are never sorted or capped
 * (input order preserved).
 *
 * Degradation (spec §8): state null / plans missing project to the same
 * 6-column skeleton with count 0 — the board renders it with a muted
 * "no plans" note (`data-zone-empty="no-plans"`), NEVER an orange warn box.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import type { PlanStateId } from '../graph/schema.ts'
import type { PanelKey } from '../locale.ts'
import css from './zones.module.css'

export interface TaskBoardProps {
  view: ZoneView['tasks']
  t: TranslateNS<'mstar-panel'>
}

/** Column-header label seat (spec §3 — the 6 PLAN_STATE_IDS names, localized). */
const COLUMN_TITLE: Readonly<Record<PlanStateId, PanelKey>> = {
  Todo: 'zone.state.Todo',
  InProgress: 'zone.state.InProgress',
  InReview: 'zone.state.InReview',
  Done: 'zone.state.Done',
  Blocked: 'zone.state.Blocked',
  unknown: 'zone.state.unknown',
}

/**
 * The inter-column transition arrows (spec §2.4 + the Task 4 brief): the main
 * chain Todo→InProgress→InReview→Done plus the InProgress↔Blocked back-edge,
 * rendered dim in the gap BEFORE the target column. PLAN_STATE_IDS places
 * Blocked after Done, so the non-adjacent ⇄ pair docks at the Blocked
 * column's leading gap (between Done and Blocked). Mirrors the five
 * PLAN_STATE_EDGES transitions (schema.ts).
 */
const COLUMN_ARROWS: readonly { before: PlanStateId; label: string; glyph: '→' | '⇄' }[] = [
  { before: 'InProgress', label: 'Todo-InProgress', glyph: '→' },
  { before: 'InReview', label: 'InProgress-InReview', glyph: '→' },
  { before: 'Done', label: 'InReview-Done', glyph: '→' },
  { before: 'Blocked', label: 'InProgress-Blocked', glyph: '⇄' },
]

/** The dim arrow rendered before the given column, if any (decorative — aria-hidden). */
function leadingArrow(id: PlanStateId): { label: string; glyph: '→' | '⇄' } | null {
  return COLUMN_ARROWS.find((a) => a.before === id) ?? null
}

export function TaskBoard({ view, t }: TaskBoardProps) {
  const columns = view.columns
  const empty = view.total === 0
  return (
    <section className={css.zone} data-zone="tasks">
      <header className={css.tasksHeader} data-zone-header>
        <h2 className={css.zoneHeader}>{t('zone.tasks.title')}</h2>
        <span className={css.tasksTotal} data-tasks-total={view.total}>
          {t('zone.tasks.total', { count: String(view.total) })}
        </span>
      </header>

      {/* Muted empty note (spec §8): state null / plans missing / no plans →
          the 6-column skeleton (count 0) below plus this note — never orange. */}
      {empty && (
        <p className={css.zoneEmpty} data-zone-empty="no-plans">{t('zone.tasks.no-plans')}</p>
      )}

      <div className={css.kanban} data-mstar-kanban>
        {columns.map((column, i) => {
          const arrow = i > 0 ? leadingArrow(column.id) : null
          return (
            <React.Fragment key={column.id}>
              {arrow !== null && (
                <span className={css.kanbanArrow} data-kanban-arrow={arrow.label} aria-hidden="true">{arrow.glyph}</span>
              )}
              <div className={css.kanbanColumn} data-kanban-column={column.id}>
                <header className={css.kanbanColumnHeader}>
                  <span className={css.kanbanColumnTitle}>{t(COLUMN_TITLE[column.id])}</span>
                  <span className={css.kanbanCount} data-kanban-count={column.count}>{column.count}</span>
                </header>
                <ul className={css.kanbanCards}>
                  {column.plans.map((plan, j) => (
                    <li
                      key={plan.id === '' ? `card-${j}` : plan.id}
                      className={css.planCard}
                      data-plan-id={plan.id}
                      data-plan-status={plan.status}
                    >
                      <code className={css.planCardId}>{plan.id}</code>
                      <span className={css.planCardStatus} data-status={plan.status}>{plan.status}</span>
                    </li>
                  ))}
                  {/* Done cap (spec §3): the projection sorted + capped at
                      PLAN_CAP — the hint surfaces the hidden count. */}
                  {column.capped !== null && column.count > column.plans.length && (
                    <li className={css.kanbanMore} data-kanban-truncated={String(column.count - column.plans.length)}>
                      {t('zone.tasks.more', { count: String(column.count - column.plans.length) })}
                    </li>
                  )}
                </ul>
              </div>
            </React.Fragment>
          )
        })}
      </div>
    </section>
  )
}
