/**
 * Iteration phase-gate section (spec §2.2): transition, all-plans-done,
 * gate verdict (entry/exit), status/compass anchors and the violation list.
 * Pure render with per-field degradation — unknown/missing → `unknown`.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarIterationGateView } from '../../types.ts'
import css from './panel.module.css'
import { bool, str } from './guards.ts'

export interface IterationSectionProps {
  t: TranslateNS<'mstar-panel'>
  iteration: MstarIterationGateView
}

/** Phase verdict: PASS / FAIL (n) / unknown. */
function phaseVerdict(
  t: TranslateNS<'mstar-panel'>,
  phase: { ok?: unknown; violations?: unknown } | null | undefined,
): string {
  const ok = bool(phase?.ok)
  if (ok === null) return t('panel.unknown')
  if (ok) return t('iteration.pass')
  const violations = Array.isArray(phase?.violations) ? phase.violations : []
  return `${t('iteration.fail')} (${violations.length})`
}

export function IterationSection({ t, iteration }: IterationSectionProps) {
  const gate = iteration.gate
  const violations = Array.isArray(gate?.violations) ? gate.violations : []
  const verdict = bool(gate?.ok) === null
    ? t('panel.unknown')
    : gate?.ok
      ? t('iteration.pass')
      : t('iteration.fail')
  return (
    <section className={css.section} data-mstar-section="iteration">
      <h2 className={css.sectionTitle}>{t('iteration.title')}</h2>
      <dl className={css.defList}>
        <dt className={css.defTerm}>{t('iteration.id')}</dt>
        <dd className={css.defValue}>{str(iteration.iterationId) ?? t('panel.unknown')}</dd>
        <dt className={css.defTerm}>{t('iteration.transition')}</dt>
        <dd className={css.defValue} data-field="transition">{str(gate?.transition) ?? t('panel.unknown')}</dd>
        <dt className={css.defTerm}>{t('iteration.plans-done')}</dt>
        <dd className={css.defValue} data-field="all-plans-done">
          {bool(gate?.all_plans_done) === null ? t('panel.unknown') : String(gate?.all_plans_done)}
        </dd>
        <dt className={css.defTerm}>{t('iteration.gate')}</dt>
        <dd className={css.defValue} data-gate-verdict={verdict}>{verdict}</dd>
        <dt className={css.defTerm}>{t('iteration.entry')}</dt>
        <dd className={css.defValue} data-gate-phase="entry">{phaseVerdict(t, gate?.entry)}</dd>
        <dt className={css.defTerm}>{t('iteration.exit')}</dt>
        <dd className={css.defValue} data-gate-phase="exit">{phaseVerdict(t, gate?.exit)}</dd>
        <dt className={css.defTerm}>{t('iteration.status-path')}</dt>
        <dd className={css.defValue} data-field="status-path">{str(iteration.statusPath) ?? t('panel.unknown')}</dd>
        <dt className={css.defTerm}>{t('iteration.compass-path')}</dt>
        <dd className={css.defValue} data-field="compass-path">{str(iteration.compassPath) ?? t('panel.unknown')}</dd>
      </dl>
      <h3 className={css.subTitle}>{t('iteration.violations', { count: String(violations.length) })}</h3>
      {violations.length === 0
        ? <p className={css.empty} data-mstar-empty="no-violations">{t('iteration.no-violations')}</p>
        : (
          <ul className={css.violationList}>
            {violations.map(violation => (
              <li
                key={str(violation.code) ?? 'violation'}
                data-violation-code={str(violation.code) ?? 'unknown'}
                data-severity={str(violation.severity) ?? 'unknown'}
              >
                <code className={css.violationCode}>{str(violation.code) ?? t('panel.unknown')}</code>
                <span className={css.violationMessage}>{str(violation.message) ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
