/**
 * IterationZone (plan 20260810-panel-canvas-zones Task 3, spec panel-zones
 * §3) — the iteration dashboard: the Step 1–5 stepper + Step N badge +
 * current/next/idle state chips + the current-step verdict badge, the zone
 * header (iteration id + active/inactive note + `Step N/5` label), and the
 * branch panel (iteration base / target / spec integration — rendered ONLY
 * while the iteration is active, spec §3; the sidebar's branches section was
 * removed in plan 1).
 *
 * State honesty (spec §3): the schema knows only current/next/idle — the
 * stepper renders NO "completed" checkmarks. The connector segment leading
 * INTO the current step is lit (the path is walked up to now), the rest stay
 * dim.
 *
 * Degradation (spec §8): `active: false` (iteration missing / transition
 * unresolvable) renders the 5 idle steps + the muted "迭代未激活" note with the
 * whole zone dimmed (`data-iteration-active="false"` — a dimmed zone, never
 * an orange warn frame); garbage fields never crash (the projection is the
 * total-function boundary; this render trusts the typed `ZoneView` and only
 * branches on the type's legit nulls).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import css from './zones.module.css'

export interface IterationZoneProps {
  view: ZoneView['iteration']
  t: TranslateNS<'mstar-panel'>
}

/** State-chip label seat (spec §3 — current/next/idle, localized). */
const STATE_LABEL = {
  current: 'zone.iteration.step.current',
  next: 'zone.iteration.step.next',
  idle: 'zone.iteration.step.idle',
} as const

/** The three branch anchors (spec §3 — `state.iterationBaseBranch` etc.). */
const BRANCH_ROWS: readonly { kind: 'iteration-base' | 'target' | 'spec-integration'; label: 'zone.branches.iteration-base' | 'zone.branches.target' | 'zone.branches.spec-integration'; value: 'iterationBase' | 'target' | 'specIntegration' }[] = [
  { kind: 'iteration-base', label: 'zone.branches.iteration-base', value: 'iterationBase' },
  { kind: 'target', label: 'zone.branches.target', value: 'target' },
  { kind: 'spec-integration', label: 'zone.branches.spec-integration', value: 'specIntegration' },
]

export function IterationZone({ view, t }: IterationZoneProps) {
  const active = view.active
  const currentStep = view.currentStep
  const steps = view.steps

  // Current-step verdict badge label (PASS/FAIL, 'unknown' on a degraded ok).
  const verdictLabel = (verdict: ZoneView['iteration']['verdict']): string =>
    verdict === 'pass' ? t('graph.pass') : verdict === 'fail' ? t('graph.fail') : t('panel.unknown')

  return (
    <section
      className={active ? `${css.zone} ${css.iterationActive}` : `${css.zone} ${css.zoneDisabled}`}
      data-zone="iteration"
      data-iteration-active={active ? 'true' : 'false'}
    >
      <header className={css.iterationHeader} data-iteration-header>
        <h2 className={css.zoneHeader} data-zone-header>{t('zone.iteration.title')}</h2>
        {active ? (
          <div className={css.iterationMeta}>
            <span className={css.iterationId} data-iteration-id={view.iterationId ?? t('panel.unknown')}>{view.iterationId ?? t('panel.unknown')}</span>
            <span className={css.iterationActiveNote} data-iteration-active-note>{t('zone.iteration.active')}</span>
            {currentStep !== null && (
              <span
                className={css.iterationStepLabel}
                data-iteration-step-label={t('zone.iteration.step-label', { n: String(currentStep), total: String(steps.length) })}
              >
                {t('zone.iteration.step-label', { n: String(currentStep), total: String(steps.length) })}
              </span>
            )}
          </div>
        ) : (
          <p className={css.iterationInactiveNote} data-iteration-inactive-note>{t('zone.iteration.inactive')}</p>
        )}
      </header>

      {/* Step 1–5 stepper (spec §3): vertical list, PHASE_IDS order, badge +
          phase name + state chip; the connector before the current step is lit. */}
      <ol className={css.stepper} data-mstar-iteration-steps>
        {steps.map((step, i) => (
          <li key={step.id} className={css.stepItem} data-step={step.step} data-step-state={step.state}>
            <div className={css.stepRail}>
              <span className={css.stepBadge} data-step-badge>{t('zone.iteration.step-badge', { n: String(step.step) })}</span>
              {i < steps.length - 1 && (
                <span
                  className={active && currentStep !== null && i === currentStep - 2 ? css.stepConnectorLit : css.stepConnector}
                  data-step-connector
                  data-step-connector-state={active && currentStep !== null && i === currentStep - 2 ? 'lit' : 'dim'}
                  aria-hidden="true"
                />
              )}
            </div>
            <div className={css.stepBody}>
              <span className={css.stepPhase} data-step-phase>{t(`zone.phase.${step.id}`)}</span>
              <span className={css.stepChip} data-step-chip>{t(STATE_LABEL[step.state])}</span>
              {step.state === 'current' && (
                <span className={css.verdictBadge} data-iteration-verdict={step.verdict}>{verdictLabel(step.verdict)}</span>
              )}
            </div>
          </li>
        ))}
      </ol>

      {/* Branch panel (spec §3/§5): the sidebar's branches moved here — rendered
          ONLY while active (branches are null while inactive, spec §3). */}
      {active && view.branches !== null && (
        <div className={css.branches} data-iteration-branches>
          <h3 className={css.branchesTitle} data-branches-title>{t('zone.branches.title')}</h3>
          <ul className={css.branchList}>
            {BRANCH_ROWS.map((row) => (
              <li key={row.kind} className={css.branchRow} data-branch={row.kind}>
                <span className={css.branchLabel}>{t(row.label)}</span>
                <code className={css.branchValue} data-branch-value>{view.branches?.[row.value] ?? '—'}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
