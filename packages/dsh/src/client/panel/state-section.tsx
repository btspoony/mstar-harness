/**
 * Workspace-state section (spec §2.3): plan status board, residual counts by
 * severity, branch/policy anchors, lease anchors, knowledge digest and the
 * direction one-liner. Pure render with per-field degradation — missing
 * fields render `none` / `unknown`, empty lists render `none`, never crash.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarHarnessState } from '../../types.ts'
import css from './panel.module.css'
import { count, str } from './guards.ts'

export interface StateSectionProps {
  t: TranslateNS<'mstar-panel'>
  state: MstarHarnessState
}

export function StateSection({ t, state }: StateSectionProps) {
  const plans = Array.isArray(state?.plans) ? state.plans : []
  const residuals = Array.isArray(state?.residuals) ? state.residuals : []
  const leases = Array.isArray(state?.leases) ? state.leases : []
  const knowledge = state?.knowledge ?? null
  return (
    <section className={css.section} data-mstar-section="state">
      <h2 className={css.sectionTitle}>{t('state.title')}</h2>

      <h3 className={css.subTitle}>{t('state.plans')}</h3>
      {plans.length === 0
        ? <p className={css.empty} data-mstar-empty="no-plans">{t('state.none')}</p>
        : (
          <ul className={css.planList}>
            {plans.map((plan, i) => (
              <li key={str(plan.id) ?? `plan-${i}`} data-plan-id={str(plan.id) ?? 'unknown'} data-plan-status={str(plan.status) ?? 'unknown'}>
                <span className={css.planStatus} data-status={str(plan.status) ?? 'unknown'}>{str(plan.status) ?? t('panel.unknown')}</span>
                <span className={css.planId}>{str(plan.id) ?? t('panel.unknown')}</span>
              </li>
            ))}
          </ul>
        )}

      <h3 className={css.subTitle}>{t('state.residuals')}</h3>
      {residuals.length === 0
        ? <p className={css.empty} data-mstar-empty="no-residuals">{t('state.none')}</p>
        : (
          <ul className={css.residualList}>
            {residuals.map((residual, i) => (
              <li key={str(residual.severity) ?? `residual-${i}`} data-residual-severity={str(residual.severity) ?? 'unknown'}>
                <span className={css.residualSeverity}>{str(residual.severity) ?? t('panel.unknown')}</span>
                <span className={css.residualCount} data-residual-count={count(residual.count) === null ? 'unknown' : String(residual.count)}>
                  {count(residual.count) === null ? t('panel.unknown') : String(residual.count)}
                </span>
              </li>
            ))}
          </ul>
        )}

      <h3 className={css.subTitle}>{t('state.branches')}</h3>
      <dl className={css.defList}>
        <dt className={css.defTerm}>{t('state.branch.iteration-base')}</dt>
        <dd className={css.defValue} data-field="iteration-base-branch">{str(state?.iterationBaseBranch) ?? t('state.none')}</dd>
        <dt className={css.defTerm}>{t('state.branch.target')}</dt>
        <dd className={css.defValue} data-field="target-branch">{str(state?.targetBranch) ?? t('state.none')}</dd>
        <dt className={css.defTerm}>{t('state.branch.spec-integration')}</dt>
        <dd className={css.defValue} data-field="spec-integration-branch">{str(state?.specIntegrationBranch) ?? t('state.none')}</dd>
      </dl>

      <h3 className={css.subTitle}>{t('state.policy')}</h3>
      <dl className={css.defList}>
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
