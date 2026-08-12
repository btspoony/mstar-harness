/**
 * IterationInfoSection (spec panel-tabs §3, plan 20260812-panel-f5-design-system
 * Task 8 — the SHARED iteration info block, user 2026-08-12 feedback #4): the
 * Content Head — iteration summary (the collapsible toggle row) + the 5
 * horizontal iteration steps + the branches panel — rendered by BOTH tabs
 * from the SAME `view.iteration` data (the tasks tab inside IterationTaskPage
 * above the kanban, the agents tab inside AgentCanvasPage above the canvas).
 * One implementation, two mounts — 任务迭代与代理执行共用同一迭代信息块.
 *
 * The component is extracted VERBATIM from the former inline head of
 * IterationTaskPage (its history, contracts and anchors stay unchanged):
 *
 * - Content Head (spec §3): the iteration info (iterationId / gate verdict /
 *   status note) rides the summary row, which IS the toggle (a native button
 *   with aria-expanded + aria-controls pointing at the body — QC wave). The
 *   expanded body renders the Steps HORIZONTALLY as 5 EQUAL full-width unit
 *   blocks (plan 20260811-panel-f2-quickfix Item 1 — badge/phase/chip
 *   centered, --mstar-space-* gap; no connector bars) with the current step
 *   highlighted on the block itself (the same honesty as the zone stepper:
 *   no "completed" checkmarks) plus the branch panel (rendered ONLY while the
 *   iteration is active, spec §3). Plan 20260811-panel-f4-iteration-zone
 *   Task 2 (spec panel-f4 §2.3 R8/R9): the expanded body is a LEFT-RIGHT
 *   SPLIT — branches (small half, DOM-first) + steps (large half), with the
 *   `data-iteration-head-split` container present only while branches render;
 *   each step reserves the fixed-height verdict seat (`data-step-verdict-seat`)
 *   and the PASS/FAIL badge renders only for a current step with a real gate
 *   verdict (`state === 'current' && verdict !== 'unknown'` — Phase 1 renders
 *   no badge), so the centered content groups align across steps.
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
 * Degradation (spec §8): the projection never throws — an inactive/missing
 * iteration renders the collapsed muted summary; the head is a pure render of
 * the projected `iteration` object (never guesses values).
 */

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import css from '../panel.module.css'

export interface IterationInfoSectionProps {
  /** The projected iteration zone (spec §3 — the SAME data both tabs show). */
  iteration: ZoneView['iteration']
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

/** Step-state chip label seat (spec §3 + plan 20260812-panel-f5-iteration-zone-fix
 * Task 2 — current/next/done/idle, localized; `done` rides the projection's
 * explicit four-state machine, Task 1). */
const STATE_LABEL = {
  current: 'zone.iteration.step.current',
  next: 'zone.iteration.step.next',
  done: 'zone.iteration.step.done',
  idle: 'zone.iteration.step.idle',
} as const

/**
 * The split-layout wrapper decision (spec panel-f4 §2.3 R8, plan f4.3 Task 2
 * — exported pure for the render tests, the `nextExpandedOnActivation`
 * precedent): the `data-iteration-head-split` container renders ONLY while
 * the branch panel renders (`active && branches !== null`); otherwise the
 * expanded body renders the steps row ALONE — the expanded-inactive fallback
 * (a user manually expands an inactive head → the 5-step idle skeleton
 * without the split). The `active + branches null` arm is projection-
 * unreachable (branches are always projected non-null while active), but the
 * predicate keeps the decision a single, testable source of truth.
 */
export function iterationSplitActive(active: boolean, branches: ZoneView['iteration']['branches']): boolean {
  return active && branches !== null
}

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

export function IterationInfoSection({ iteration, t }: IterationInfoSectionProps) {
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

  // The horizontal steps row (spec §3) — shared by the split layout (steps
  // right) and the no-branches fallback (steps alone). Each step reserves the
  // fixed-height verdict seat (spec panel-f4 §2.3 R9, plan f4.3 Task 2): the
  // conditional PASS/FAIL badge fills the seat on the current step only, so
  // every step item has the SAME children (badge/phase/chip/seat) and the
  // centered content groups align identically — the old in-flow badge (an
  // extra child on the current step) shifted that block. The badge renders
  // ONLY for a current step carrying a REAL gate verdict — Phase 1 (Step 1
  // current, verdict 'unknown') renders NO badge (spec R9).
  const stepsRow = (
    <ol className={css.iterationStepsRow} data-iteration-head-steps>
      {iteration.steps.map((step) => (
        <li key={step.step} className={css.iterationStepItem} data-step={step.step} data-step-state={step.state}>
          <span className={css.iterationStepBadge} data-step-badge>
            {t('zone.iteration.step-badge', { n: String(step.step) })}
          </span>
          <span className={css.iterationStepPhase} data-step-phase>{t(`zone.phase.${step.id}`)}</span>
          <span className={css.iterationStepChip} data-step-chip>{t(STATE_LABEL[step.state])}</span>
          <span className={css.iterationVerdictSeat} data-step-verdict-seat>
            {step.state === 'current' && step.verdict !== 'unknown' && (
              <span className={css.iterationVerdict} data-iteration-verdict={step.verdict}>
                {verdictLabel(step.verdict)}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  )

  return (
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
        aria-controls="iteration-head-body"
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
        <div className={css.iterationHeadBody} id="iteration-head-body" data-iteration-head-body>
          {/* Steps, HORIZONTAL (spec §3 + plan 20260811-panel-f2-quickfix
              Item 1): PHASE_IDS order — 5 EQUAL full-width unit blocks
              (flex 1 1 0, centered content, --mstar-space-* gap; the old
              connector bars are removed, the gap replaces them), the
              current step highlighted on the block itself (honest — the
              schema knows only current/next/done/idle). */}
          {iterationSplitActive(active, iteration.branches) ? (
            /* LEFT-RIGHT split (spec panel-f4 §2.3 R8, plan f4.3 Task 2):
               branches LEFT (small half) + steps RIGHT (large half). DOM
               order: branches BEFORE steps — a plain flex row puts branches
               on the left. The split container exists ONLY while the
               branches panel renders (`iterationSplitActive` — active +
               branches non-null); inactive / branches-null → the steps row
               alone (existing semantics, the expanded-inactive fallback). */
            <div className={css.iterationHeadSplit} data-iteration-head-split>
              {/* Branch panel (spec §3): rendered ONLY while the iteration
                  is active (branches are null while inactive, spec §3). */}
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
              {stepsRow}
            </div>
          ) : (
            stepsRow
          )}
        </div>
      )}
    </section>
  )
}
