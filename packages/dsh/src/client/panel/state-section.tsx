/**
 * Workspace-state section (spec panel-zones §5): plan board (≤5 in spec §3
 * time-desc order + `+N more`), open residual findings (≤10 — R# + severity
 * chip + title/planId + overflow hint), policy anchors with enforcement
 * FIRST (from `source.enforcement` — top level, not state), lease anchors,
 * knowledge digest and the direction one-liner. Pure render with per-field
 * degradation — missing fields render `none` / `unknown`, empty lists render
 * `none`, never crash.
 *
 * The branches block was removed from the sidebar in this task (moved to the
 * iteration zone, plan 20260810-panel-canvas-zones); the branch anchor fields
 * stay in the catalog source (the iteration zone consumes them).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarEngineStatusSource, MstarHarnessState } from '../../types.ts'
import css from './panel.module.css'
import { bool, count, str } from './guards.ts'
import { FINDINGS_CAP, PLAN_CAP, sortPlans } from './plan-sort.ts'

export interface StateSectionProps {
  t: TranslateNS<'mstar-panel'>
  state: MstarHarnessState
  /** Top-level enforcement flag (spec §2.1) — NOT part of the state digest. */
  enforcement: MstarEngineStatusSource['enforcement']
}

/** Enforcement flag label: hard/soft (+ provenance source), unknown when missing (spec §2.1). */
function enforcementLabel(
  t: TranslateNS<'mstar-panel'>,
  enforcement: MstarEngineStatusSource['enforcement'],
): string {
  if (enforcement === null || enforcement === undefined || typeof enforcement !== 'object') {
    return t('panel.unknown')
  }
  const hard = bool((enforcement as { hard?: unknown }).hard)
  const source = str((enforcement as { source?: unknown }).source)
  const flag = hard === null ? t('panel.unknown') : hard ? t('state.enforcement.hard') : t('state.enforcement.soft')
  return source === null ? flag : `${flag} (${source})`
}

export function StateSection({ t, state, enforcement }: StateSectionProps) {
  const plans = Array.isArray(state?.plans) ? state.plans : []
  // Spec §3 order (doneAt digitized DESC → id-date DESC → id lex DESC), cap 5.
  const sortedPlans = sortPlans(plans)
  const visiblePlans = sortedPlans.slice(0, PLAN_CAP)
  const hiddenPlans = sortedPlans.length - visiblePlans.length
  // Open residual findings detail (catalog already severity-orders + caps at
  // 10 — the render cap is defensive parity); null (root key unreadable) and
  // [] (no open entries) both degrade to `none`.
  const findings = Array.isArray(state?.residualFindings) ? state.residualFindings : null
  const visibleFindings = findings === null ? null : findings.slice(0, FINDINGS_CAP)
  const hiddenFindings = findings === null ? 0 : Math.max(0, findings.length - FINDINGS_CAP)
  const leases = Array.isArray(state?.leases) ? state.leases : []
  const knowledge = state?.knowledge ?? null
  return (
    <section className={css.section} data-mstar-section="state">
      <h2 className={css.sectionTitle}>{t('state.title')}</h2>

      <h3 className={css.subTitle}>{t('state.plans')}</h3>
      {visiblePlans.length === 0
        ? <p className={css.empty} data-mstar-empty="no-plans">{t('state.none')}</p>
        : (
          <ul className={css.planList}>
            {visiblePlans.map((plan, i) => (
              <li key={str(plan.id) ?? `plan-${i}`} data-plan-id={str(plan.id) ?? 'unknown'} data-plan-status={str(plan.status) ?? 'unknown'}>
                <span className={css.planStatus} data-status={str(plan.status) ?? 'unknown'}>{str(plan.status) ?? t('panel.unknown')}</span>
                <span className={css.planId}>{str(plan.id) ?? t('panel.unknown')}</span>
              </li>
            ))}
          </ul>
        )}
      {hiddenPlans > 0
        ? <p className={css.truncated} data-plan-truncated>{t('state.plans.more', { count: String(hiddenPlans) })}</p>
        : null}

      <h3 className={css.subTitle}>{t('state.residuals')}</h3>
      {visibleFindings === null || visibleFindings.length === 0
        ? <p className={css.empty} data-mstar-empty="no-residuals">{t('state.none')}</p>
        : (
          <ul className={css.residualList}>
            {visibleFindings.map((finding, i) => (
              <li
                key={str(finding.id) ?? `finding-${i}`}
                data-residual-finding
                data-residual-finding-id={str(finding.id) ?? 'unknown'}
                data-residual-finding-severity={str(finding.severity) ?? 'unknown'}
                data-residual-finding-plan={str(finding.planId) ?? 'unknown'}
              >
                <span className={css.findingSeverity} data-severity={str(finding.severity) ?? 'unknown'}>{str(finding.severity) ?? t('panel.unknown')}</span>
                <span className={css.findingTitle}>{str(finding.title) ?? t('panel.unknown')}</span>
                {str(finding.planId) !== null ? <span className={css.findingPlan}>{finding.planId}</span> : null}
              </li>
            ))}
          </ul>
        )}
      {hiddenFindings > 0
        ? <p className={css.truncated} data-residual-truncated>{t('state.residual.more', { count: String(hiddenFindings) })}</p>
        : null}

      <h3 className={css.subTitle}>{t('state.policy')}</h3>
      <dl className={css.defList}>
        <dt className={css.defTerm}>{t('state.enforcement')}</dt>
        <dd className={css.defValue} data-field="enforcement">{enforcementLabel(t, enforcement)}</dd>
        <dt className={css.defTerm}>{t('state.policy.push')}</dt>
        <dd className={css.defValue} data-field="push-policy">{str(state?.pushPolicy) ?? t('state.none')}</dd>
        <dt className={css.defTerm}>{t('state.policy.worktree')}</dt>
        <dd className={css.defValue} data-field="worktree-mode">{str(state?.worktreeMode) ?? t('state.none')}</dd>
        <dt className={css.defTerm}>{t('state.policy.control-worktree')}</dt>
        <dd className={css.defValue} data-field="control-worktree-path">{str(state?.controlWorktreePath) ?? t('state.none')}</dd>
      </dl>

      <h3 className={css.subTitle}>{t('state.leases')}</h3>
      {leases.length === 0
        ? <p className={css.empty} data-mstar-empty="no-leases">{t('state.none')}</p>
        : (
          <ul className={css.leaseList}>
            {leases.map((lease, i) => (
              <li key={str(lease.planId) ?? `lease-${i}`} data-lease-plan={str(lease.planId) ?? 'unknown'}>
                <span className={css.leasePlan}>{str(lease.planId) ?? t('panel.unknown')}</span>
                <span className={css.leaseHolder}>{str(lease.holder) ?? t('panel.unknown')}</span>
                {str(lease.worktreePath) !== null
                  ? <span className={css.leaseWorktree}>{lease.worktreePath}</span>
                  : null}
              </li>
            ))}
          </ul>
        )}

      <h3 className={css.subTitle}>{t('state.knowledge')}</h3>
      {knowledge === null
        ? <p className={css.empty} data-mstar-empty="no-knowledge">{t('state.none')}</p>
        : (
          <p className={css.knowledge} data-knowledge-docs={count(knowledge.docCount) === null ? 'unknown' : String(knowledge.docCount)}>
            <span>{t('state.knowledge.docs', { count: count(knowledge.docCount) === null ? t('panel.unknown') : String(knowledge.docCount) })}</span>
            {Array.isArray(knowledge.categories) && knowledge.categories.length > 0
              ? <span className={css.knowledgeCategories}>
                {knowledge.categories.filter((category): category is string => typeof category === 'string').join(' · ')}
              </span>
              : null}
          </p>
        )}

      <h3 className={css.subTitle}>{t('state.direction')}</h3>
      <p className={css.direction} data-direction>{str(state?.direction) ?? t('state.none')}</p>
    </section>
  )
}
