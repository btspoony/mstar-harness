/**
 * IterationTaskPage (spec panel-tabs §3, plan 20260811-panel-tabs-shell
 * Task 2) — the 任务迭代 tab: the SHARED IterationInfoSection (iteration
 * summary + the 5 horizontal iteration steps + branches — the same block the
 * agents tab renders, plan 20260812-panel-f5-design-system Task 8, user
 * 2026-08-12 feedback #4) above the full-width standard kanban. Replaces the
 * WorkflowCanvas zone dashboard on the tasks tab (WorkflowCanvas is removed
 * by the plan close; its zone-level components stay untouched here).
 *
 * The head (collapse/expand, steps row, branches, verdict seats) lives in
 * `IterationInfoSection.tsx` — extracted from this page by Task 8 so BOTH
 * tabs render the SAME iteration info block from the SAME `view.iteration`
 * data (one implementation, two mounts; the anchor family `data-iteration-*`
 * is unchanged).
 *
 * Task area (spec §3/D2): the standard 5-column kanban (Todo / InProgress /
 * InReview / Done / blocked-unknown — Blocked + unknown merged) via the
 * REUSED TaskBoard
 * (`view.tasks`) — the Done overflow stays the projection's PLAN_CAP
 * handling (TaskBoard only surfaces the `+N more` hint). The page fills the
 * content region as a flex column: the head is flex:none (fixed), the tasks
 * area (`data-mstar-tasks-scroll`) is the page's independent vertical scroll
 * body (flex:1, min-height:0, overflow-y:auto) — the kanban spreads
 * full-width and is never compressed into a small box by a canvas height.
 *
 * Degradation (spec §8): the projection never throws — an inactive/missing
 * iteration renders the collapsed muted summary; state/plans missing render
 * the muted 5-column kanban skeleton (TaskBoard) — never an orange warn box.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import { TaskBoard } from '../zones/TaskBoard.tsx'
import { IterationInfoSection } from './IterationInfoSection.tsx'
import css from '../panel.module.css'

export interface IterationTaskPageProps {
  view: ZoneView
  t: TranslateNS<'mstar-panel'>
}

export function IterationTaskPage({ view, t }: IterationTaskPageProps) {
  return (
    <div className={css.iterationPage} data-mstar-page="tasks">
      {/* The SHARED iteration info section (plan 20260812-panel-f5-design-system
          Task 8 — user 2026-08-12 feedback #4): the same block the agents tab
          renders, from the same `view.iteration` data. */}
      <IterationInfoSection iteration={view.iteration} t={t} />

      {/* Task area (spec §3/D2): the full-width standard kanban — the page's
          independent scroll body (never compressed by a canvas height). */}
      <div className={css.iterationTasks} data-mstar-tasks-scroll>
        <TaskBoard view={view.tasks} t={t} />
      </div>
    </div>
  )
}
