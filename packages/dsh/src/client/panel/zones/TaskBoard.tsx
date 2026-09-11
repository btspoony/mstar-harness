/**
 * TaskBoard  — the tasks-zone kanban: the 5
 * PLAN_STATE_IDS groups (Todo / InProgress / InReview / Done /
 * blocked-unknown, in the projection's constant order) STACKED in flow (plan
 * sidebar §L4.2 — the horizontal 5-column row cannot fit the 300px column),
 * each with a header row carrying the flow glyph (the
 * `data-kanban-arrow` labels + the `⇄` back-edge glyph: Todo→InProgress→
 * InReview→Done plus the InProgress↔Blocked back-edge, docking at the merged
 * blocked-unknown group), the localized state-name + count badge, plan cards
 * (mono ellipsized id + status chip — the `data-plan-id` /
 * `data-plan-status` anchors shared with the sidebar plan board), and the
 * per-group 「更多」 expand affordance. The board rides the shell's shared
 * `.groupGrid` class, so the ≥720px container spread reaches the groups
 * (plan sidebar §L4.3 — one wide rule, not a second layout).
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
 * 5-group skeleton with count 0 — the board renders it with a muted
 * "no plans" note (`data-zone-empty="no-plans"`), NEVER an orange warn box.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { KanbanColumnView, ZoneView } from '../graph/project-graph.ts'
import type { PlanStateId } from '../graph/schema.ts'
import type { PanelKey } from '../locale.ts'
import { PLAN_CAP } from '../plan-sort.ts'
import panelCss from '../panel.module.css'
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
 * The inter-group transition glyphs (spec §2.4 + the Task 4 brief): the main
 * chain Todo→InProgress→InReview→Done plus the InProgress↔Blocked back-edge,
 * each docking in its TARGET group's header row (the stacked groups have no
 * inter-column gaps). Mirrors the PLAN_STATE_EDGES transitions (schema.ts).
 */
const COLUMN_ARROWS: readonly { before: PlanStateId; label: string; glyph: '→' | '⇄' }[] = [
  { before: 'InProgress', label: 'Todo-InProgress', glyph: '→' },
  { before: 'InReview', label: 'InProgress-InReview', glyph: '→' },
  { before: 'Done', label: 'InReview-Done', glyph: '→' },
  { before: 'blocked-unknown', label: 'InProgress-Blocked', glyph: '⇄' },
]

/** The dim flow glyph docking at the given group's header, if any (decorative — aria-hidden). */
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

      {/* The stacked groups ride the shell's shared group grid (plan sidebar
          §L4.2/§L4.3): one column below 720px, the ≥720px container spread
          via `.groupGrid` — the wide rule is shared, not duplicated. */}
      <div className={`${css.kanban} ${panelCss.groupGrid}`} data-mstar-kanban>
        {columns.map((column) => {
          const arrow = leadingArrow(column.id)
          const isExpanded = expanded.has(column.id)
          const shown = visibleKanbanPlans(column, isExpanded)
          // Hidden rows = full count − displayed rows (0 unless capped & collapsed).
          const overflow = column.capped === null ? 0 : column.count - column.capped
          return (
            <div className={css.kanbanColumn} key={column.id} data-kanban-column={column.id}>
              <header className={css.kanbanColumnHeader}>
                {arrow !== null && (
                  <span className={css.kanbanArrow} data-kanban-arrow={arrow.label} aria-hidden="true">{arrow.glyph}</span>
                )}
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
                {/* Overflow toggle : the clickable 「更多」/「收起」 —
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
          )
        })}
      </div>
    </section>
  )
}
