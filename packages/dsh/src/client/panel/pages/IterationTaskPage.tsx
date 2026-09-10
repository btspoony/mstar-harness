/**
 * IterationTaskPage (spec panel-tabs §3
 * — the 任务迭代 tab: the SHARED IterationInfoSection (iteration
 * summary + the vertical 5-step stepper + branches — the same block the
 * agents tab renders, user
 * 2026-08-12 feedback #4) above the stacked plan board. Replaces the
 * WorkflowCanvas zone dashboard on the tasks tab (WorkflowCanvas is removed
 * by the plan close; its zone-level components stay untouched here).
 *
 * The head (collapse/expand, vertical steps, branches, verdict seats) lives
 * in `IterationInfoSection.tsx` — extracted from this page by Task 8 so BOTH
 * tabs render the SAME iteration info block from the SAME `view.iteration`
 * data (one implementation, two mounts; the anchor family `data-iteration-*`
 * is unchanged).
 *
 * Task area (plan sidebar §L4.2): the standard 5-group board (Todo /
 * InProgress / InReview / Done / blocked-unknown — Blocked + unknown merged)
 * via the REUSED TaskBoard (`view.tasks`) — the Done overflow stays the
 * projection's PLAN_CAP handling (TaskBoard only surfaces the `+N more`
 * hint). The page is FLOW CONTENT inside the panel's single scroll body
 * (`[data-mstar-scroll]`, plan sidebar §L2.2 — the page-owned scroll body is
 * retired): the board stacks as five groups, then the project rollup, then
 * the in-flow digest.
 *
 * Degradation (spec §8): the projection never throws — an inactive/missing
 * iteration renders the collapsed muted summary; state/plans missing render
 * the muted 5-group kanban skeleton (TaskBoard) — never an orange warn box.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import { TaskBoard } from '../zones/TaskBoard.tsx'
import { ProjectRollup } from '../zones/ProjectRollup.tsx'
import { IterationInfoSection } from './IterationInfoSection.tsx'
import css from '../panel.module.css'

export interface IterationTaskPageProps {
  view: ZoneView
  t: TranslateNS<'mstar-panel'>
}

export function IterationTaskPage({ view, t }: IterationTaskPageProps) {
  return (
    <div className={css.iterationPage} data-mstar-page="tasks">
      {/* The SHARED iteration info section (): the same block the agents tab
          renders, from the same `view.iteration` data. */}
      <IterationInfoSection iteration={view.iteration} t={t} />

      {/* Task area (plan sidebar §L2.2/§L4.2): the stacked board + the
          project rollup, flow content inside the panel's single scroll
          body (the page's own scroll wrapper is retired). */}
      <div className={css.iterationTasks}>
        <TaskBoard view={view.tasks} t={t} />

        {/* The ADDITIVE project rollup zone (compass AC-4): roadmap milestones + open residuals from
            the project layer, below the board in the same scroll flow. The
            four existing ZoneView shapes are untouched. */}
        <ProjectRollup view={view.project} t={t} />
      </div>
    </div>
  )
}
