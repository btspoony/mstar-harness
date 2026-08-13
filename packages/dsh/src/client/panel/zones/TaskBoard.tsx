/**
 * TaskBoard (plan 20260810-panel-canvas-zones Task 4, spec panel-zones §3;
 * plan 20260813-panel-quick-fixes Task 1) — the tasks-zone kanban: the 5
 * PLAN_STATE_IDS columns (Todo / InProgress / InReview / Done /
 * blocked-unknown, in the projection's constant order), each with a localized
 * state-name header + count badge, plan cards (mono ellipsized id + status
 * chip — the `data-plan-id` / `data-plan-status` anchors shared with the
 * sidebar plan board), the dim inter-column flow arrows (spec §2.4:
 * Todo→InProgress→InReview→Done plus the InProgress↔Blocked back-edge, now
 * docking at the merged blocked-unknown column), the per-column 「更多」
 * expand affordance, and the muted "no plans" empty state.
 *
 * The projection KEEPS every row (`column.plans` = the full column) and
 * reports `column.capped` (PLAN_CAP) when a column overflows. This render
 * shows the first PLAN_CAP rows by default and, for an overflowing column, a
 * clickable 「更多」 button (`data-kanban-more`) that toggles an expanded
 * state to reveal ALL rows (plus a 「收起」 to collapse back). PLAN_CAP is
 * reused from `plan-sort.ts` (spec §3, reused not copied); only the Done
 * column is sorted (the projection applies `sortPlans`), every other column
 * keeps input order.
 *
 * Degradation (spec §8): state null / plans missing project to the same
 * 5-column skeleton with count 0 — the board renders it with a muted
 * "no plans" note (`data-zone-empty="no-plans"`), NEVER an orange warn box.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { KanbanColumnView, ZoneView } from '../graph/project-graph.ts'
import type { PlanStateId } from '../graph/schema.ts'
import type { PanelKey } from '../locale.ts'
import { PLAN_CAP } from '../plan-sort.ts'
import css from './zones.module.css'

export interface TaskBoardProps {
  view: ZoneView['tasks']
  t: TranslateNS<'mstar-panel'>
}

/** Column-header label seat (spec §3 — the 5 PLAN_STATE_IDS names, localized). */
const COLUMN_TITLE: Readonly<Record<PlanStateId, PanelKey>> = {
  Todo: 'zone.state.Todo',
  InProgress: 'zone.state.InProgress',
  InReview: 'zone.state.InReview',
  Done: 'zone.state.Done',
  'blocked-unknown': 'zone.state.blocked-unknown',
}

/**
 * The inter-column transition arrows (spec §2.4 + the Task 4 brief): the main
 * chain Todo→InProgress→InReview→Done plus the InProgress↔Blocked back-edge
 * (now docking at the merged blocked-unknown column), rendered dim in the gap
 * BEFORE the target column. Mirrors the PLAN_STATE_EDGES transitions
 * (schema.ts).
 */
const COLUMN_ARROWS: readonly { before: PlanStateId; label: string; glyph: '→' | '⇄' }[] = [
  { before: 'InProgress', label: 'Todo-InProgress', glyph: '→' },
  { before: 'InReview', label: 'InProgress-InReview', glyph: '→' },
  { before: 'Done', label: 'InReview-Done', glyph: '→' },
  { before: 'blocked-unknown', label: 'InProgress-Blocked', glyph: '⇄' },
]

/** The dim arrow rendered before the given column, if any (decorative — aria-hidden). */
function leadingArrow(id: PlanStateId): { label: string; glyph: '→' | '⇄' } | null {
  return COLUMN_ARROWS.find((a) => a.before === id) ?? null
}

/** Toggle a column id in the expanded set (pure — the click path is unit-tested). */
export function toggleKanbanExpanded(expanded: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(expanded)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** The rows a column shows: PLAN_CAP by default, ALL when expanded. */
export function visibleKanbanPlans(column: KanbanColumnView, expanded: boolean): { id: string; status: string }[] {
  return expanded ? column.plans : column.plans.slice(0, PLAN_CAP)
}

export function TaskBoard({ view, t }: TaskBoardProps) {
  const columns = view.columns
  const empty = view.total === 0
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set())

  const toggle = (id: string) => setExpanded((prev) => toggleKanbanExpanded(prev, id))

  return (
    <section className={css.zone} data-zone="tasks">
      <header className={css.tasksHeader} data-zone-header>
        <h2 className={css.zoneHeader}>{t('zone.tasks.title')}</h2>
        <span className={css.tasksTotal} data-tasks-total={view.total}>
          {t('zone.tasks.total', { count: String(view.total) })}
        </span>
      </header>

      {/* Muted empty note (spec §8): state null / plans missing / no plans →
          the 5-column skeleton (count 0) below plus this note — never orange. */}
      {empty && (
        <p className={css.zoneEmpty} data-zone-empty="no-plans">{t('zone.tasks.no-plans')}</p>
      )}

      <div className={css.kanban} data-mstar-kanban>
        {columns.map((column, i) => {
          const arrow = i > 0 ? leadingArrow(column.id) : null
          const isExpanded = expanded.has(column.id)
          const shown = visibleKanbanPlans(column, isExpanded)
          // Hidden rows = full count − displayed rows (0 unless capped & collapsed).
          const overflow = column.capped === null ? 0 : column.count - column.capped
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
                <ul className={css.kanbanCards} id={`kanban-cards-${column.id}`}>
                  {shown.map((plan, j) => (
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
                  {/* Overflow toggle (Task 1): the clickable 「更多」/「收起」 —
                      only for a capped column (expanded or not). */}
                  {overflow > 0 && (
                    <li className={css.kanbanMore}>
                      <button
                        type="button"
                        className={css.kanbanMoreButton}
                        data-kanban-more={isExpanded ? 'collapse' : 'expand'}
                        aria-expanded={isExpanded}
                        aria-controls={`kanban-cards-${column.id}`}
                        onClick={() => toggle(column.id)}
                      >
                        {isExpanded
                          ? t('zone.tasks.collapse')
                          : t('zone.tasks.more', { count: String(overflow) })}
                      </button>
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
