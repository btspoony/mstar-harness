/**
 * Graph legend (spec panel-layout-graph §4): the footer-left readibility aid —
 * phase ring / plan state machine / edge kinds / highlight meanings as
 * swatch + label rows. Pure render of the `t` seat; every label is a
 * `graph.legend.*` locale key.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './graph.module.css'

export interface LegendProps {
  t: TranslateNS<'mstar-panel'>
}

export function Legend({ t }: LegendProps) {
  const items: { key: string; swatch: string; label: string }[] = [
    { key: 'phases', swatch: css.swatchPhase, label: t('graph.legend.phases') },
    { key: 'states', swatch: css.swatchState, label: t('graph.legend.plan-states') },
    { key: 'forward', swatch: css.swatchForward, label: t('graph.legend.edge-forward') },
    { key: 'loop', swatch: css.swatchLoop, label: t('graph.legend.edge-loop') },
    { key: 'connector', swatch: css.swatchConnector, label: t('graph.legend.edge-connector') },
    { key: 'current', swatch: css.swatchCurrent, label: t('graph.legend.state-current') },
    { key: 'next', swatch: css.swatchNext, label: t('graph.legend.state-next') },
    { key: 'pass', swatch: css.swatchPass, label: t('graph.legend.verdict-pass') },
    { key: 'fail', swatch: css.swatchFail, label: t('graph.legend.verdict-fail') },
  ]
  return (
    <div className={css.legend} data-mstar-legend>
      <span className={css.legendTitle}>{t('graph.legend.title')}</span>
      <ul className={css.legendList}>
        {items.map((item) => (
          <li key={item.key} className={css.legendItem}>
            <span className={`${css.legendSwatch} ${item.swatch}`} />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
