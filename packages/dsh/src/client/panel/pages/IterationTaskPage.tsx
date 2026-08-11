/**
 * IterationTaskPage (spec panel-tabs §3, plan 20260811-panel-tabs-shell
 * Task 2) — the 任务迭代 tab: the Content Head (iteration summary + the 5
 * horizontal iteration steps, collapsible) above the full-width standard
 * kanban. Replaces the WorkflowCanvas zone dashboard on the tasks tab
 * (WorkflowCanvas is removed by the plan close; its zone-level components
 * stay untouched here).
 *
 * Content Head (spec §3): the iteration info (iterationId / gate verdict /
 * status note) rides the summary row, which IS the toggle (a native button
 * with aria-expanded). The expanded body renders the Steps HORIZONTALLY
 * (PHASE_IDS order — the current step highlighted, the connector segment
 * leading INTO the current step lit; the same honesty as the zone stepper:
 * no "completed" checkmarks) plus the branch panel (rendered ONLY while the
 * iteration is active, spec §3).
 *
 * Collapse/expand (spec §3 / Task 2 brief): a local `useState` defaulted to
 * the iteration state — `active === false` → collapsed to a one-line summary
 * (iterationId/verdict + the muted "not started" note, expandable to the idle
 * 5-step skeleton); `active === true` → expanded. SSR-stable: the default is
 * data-derived, so `renderToStaticMarkup` renders a deterministic state per
 * row that tests can pin statically. Live re-sync (Task 2 review
 * Important-1): a useEffect re-expands the head when the SAME mounted
 * instance sees `active` flip false→true on a catalog update (started
 * iterations must show the expanded steps, spec §3); the transition is
 * one-way — user collapse while already active is never overridden.
 *
 * Task area (spec §3/D2): the standard 6-column kanban (Todo / InProgress /
 * InReview / Done / Blocked / unknown) via the REUSED TaskBoard
 * (`view.tasks`) — the Done overflow stays the projection's PLAN_CAP
 * handling (TaskBoard only surfaces the `+N more` hint). The page fills the
 * content region as a flex column: the head is flex:none (fixed), the tasks
 * area (`data-mstar-tasks-scroll`) is the page's independent vertical scroll
 * body (flex:1, min-height:0, overflow-y:auto) — the kanban spreads
 * full-width and is never compressed into a small box by a canvas height.
 *
 * Degradation (spec §8): the projection never throws — an inactive/missing
 * iteration renders the collapsed muted summary; state/plans missing render
 * the muted 6-column kanban skeleton (TaskBoard) — never an orange warn box.
 */

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import { TaskBoard } from '../zones/TaskBoard.tsx'
import css from '../panel.module.css'

export interface IterationTaskPageProps {
  view: ZoneView
  t: TranslateNS<'mstar-panel'>
}

/**
 * Activation re-sync (Task 2 review Important-1): the collapse/expand state
 * must follow a LIVE `active` flip on the SAME mounted instance — spec §3
 * says 启动迭代才展开 (an active iteration shows the expanded steps), and a
 * fresh catalog row can flip `iteration.active` false→true without a remount.
 * The transition is one-way: only the INACTIVE → ACTIVE edge forces expand;
 * a user collapse while already active is never overridden, and a live
 * true→false deactivation keeps the user's current view (the muted
 * "not started" note + collapsed affordance still render per `active`).
 *
 * Pure transition (exported for the render-test transition table): the head
 * expands iff the iteration just became active; otherwise the user's state
 * wins.
 */
export function nextExpandedOnActivation(prev: boolean, prevActive: boolean, nextActive: boolean): boolean {
  return !prevActive && nextActive ? true : prev
}

/** Step-state chip label seat (spec §3 — current/next/idle, localized). */
const STATE_LABEL = {
  current: 'zone.iteration.step.current',
  next: 'zone.iteration.step.next',
  idle: 'zone.iteration.step.idle',
} as const

/** The three branch anchors (spec §3 — `state.iterationBaseBranch` etc.). */
const BRANCH_ROWS: readonly {
  kind: 'iteration-base' | 'target' | 'spec-integration'
  label: 'zone.branches.iteration-base' | 'zone.branches.target' | 'zone.branches.spec-integration'
  value: 'iterationBase' | 'target' | 'specIntegration'
}[] = [
  { kind: 'iteration-base', label: 'zone.branches.iteration-base', value: 'iterationBase' },
  { kind: 'target', label: 'zone.branches.target', value: 'target' },
  { kind: 'spec-integration', label: 'zone.branches.spec-integration', value: 'specIntegration' },
]

export function IterationTaskPage({ view, t }: IterationTaskPageProps) {
  const iteration = view.iteration
  const active = iteration.active
  // Collapse/expand (spec §3): local state defaulted to the iteration state —
  // inactive → collapsed one-liner, active → expanded full steps. The initial
  // value is data-derived, so SSR renders a deterministic default per row.
  const [expanded, setExpanded] = useState(active)
  // Activation re-sync (Task 2 review Important-1): a live catalog update can
  // flip `active` false→true on the SAME mounted instance (e.g. the harness
  // row re-emitted after 迭代启动) — the head must then expand per spec §3.
  // The ref tracks the PREVIOUS prop (not the user state), so only the
  // false→true edge forces expand; user collapse while already active is
  // preserved. Effects don't run under renderToStaticMarkup, so SSR keeps the
  // deterministic `useState(active)` default.
  const activeRef = useRef(active)
  useEffect(() => {
    setExpanded((prev) => nextExpandedOnActivation(prev, activeRef.current, active))
    activeRef.current = active
  }, [active])

  // Current-step verdict label (PASS/FAIL, 'unknown' on a degraded ok).
  const verdictLabel = (verdict: ZoneView['iteration']['verdict']): string =>
    verdict === 'pass' ? t('graph.pass') : verdict === 'fail' ? t('graph.fail') : t('panel.unknown')
  const idLabel = iteration.iterationId ?? t('panel.unknown')
  const statusLabel = active && iteration.currentStep !== null
    ? t('zone.iteration.step-label', { n: String(iteration.currentStep), total: String(iteration.steps.length) })
    : t('page.iteration.not-started')

  return (
    <div className={css.iterationPage} data-mstar-page="tasks">
      <section
        className={css.iterationHead}
        data-iteration-head
        data-iteration-head-active={active ? 'true' : 'false'}
        data-iteration-head-expanded={expanded ? 'true' : 'false'}
      >
        {/* The summary row IS the toggle (spec §3): one line when collapsed —
            iterationId / verdict / status note (+ expand hint); the same
            button collapses an expanded head again. */}
        <button
          type="button"
          className={css.iterationSummary}
          data-iteration-head-toggle
          data-iteration-head-summary
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className={css.iterationSummaryId} data-iteration-head-id={idLabel}>
            {idLabel}
          </span>
          <span className={css.iterationSummaryVerdict} data-iteration-head-verdict={iteration.verdict}>
            {verdictLabel(iteration.verdict)}
          </span>
          <span
            className={active ? css.iterationSummaryStatus : css.iterationSummaryStatusMuted}
            data-iteration-head-status={statusLabel}
          >
            {statusLabel}
          </span>
          <span className={css.iterationSummaryHint} data-iteration-head-hint>
            {t(expanded ? 'page.iteration.collapse' : 'page.iteration.expand')}
          </span>
        </button>

        {expanded && (
          <div className={css.iterationHeadBody} data-iteration-head-body>
            {/* Steps, HORIZONTAL (spec §3): PHASE_IDS order, the current step
                highlighted; the connector leading INTO the current step is
                lit (honest — the schema knows only current/next/idle). */}
            <ol className={css.iterationStepsRow} data-iteration-head-steps>
              {iteration.steps.map((step, i) => (
                <React.Fragment key={step.id}>
                  <li className={css.iterationStepItem} data-step={step.step} data-step-state={step.state}>
                    <span className={css.iterationStepBadge} data-step-badge>
                      {t('zone.iteration.step-badge', { n: String(step.step) })}
                    </span>
                    <span className={css.iterationStepPhase} data-step-phase>{t(`zone.phase.${step.id}`)}</span>
                    <span className={css.iterationStepChip} data-step-chip>{t(STATE_LABEL[step.state])}</span>
                    {step.state === 'current' && (
                      <span className={css.iterationVerdict} data-iteration-verdict={step.verdict}>
                        {verdictLabel(step.verdict)}
                      </span>
                    )}
                  </li>
                  {i < iteration.steps.length - 1 && (
                    <li
                      className={active && iteration.currentStep !== null && i === iteration.currentStep - 2
                        ? css.iterationStepConnectorLit
                        : css.iterationStepConnector}
                      data-step-connector
                      data-step-connector-state={active && iteration.currentStep !== null && i === iteration.currentStep - 2 ? 'lit' : 'dim'}
                      aria-hidden="true"
                    />
                  )}
                </React.Fragment>
              ))}
            </ol>

            {/* Branch panel (spec §3): rendered ONLY while the iteration is
                active (branches are null while inactive, spec §3). */}
            {active && iteration.branches !== null && (
              <div className={css.iterationBranches} data-iteration-head-branches>
                <h3 className={css.iterationBranchesTitle} data-branches-title>{t('zone.branches.title')}</h3>
                <ul className={css.iterationBranchList}>
                  {BRANCH_ROWS.map((row) => (
                    <li key={row.kind} className={css.iterationBranchRow} data-branch={row.kind}>
                      <span className={css.iterationBranchLabel}>{t(row.label)}</span>
                      <code className={css.iterationBranchValue} data-branch-value>
                        {iteration.branches?.[row.value] ?? '—'}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Task area (spec §3/D2): the full-width standard kanban — the page's
          independent scroll body (never compressed by a canvas height). */}
      <div className={css.iterationTasks} data-mstar-tasks-scroll>
        <TaskBoard view={view.tasks} t={t} />
      </div>
    </div>
  )
}
