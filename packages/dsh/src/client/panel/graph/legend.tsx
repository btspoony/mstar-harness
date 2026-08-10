/**
 * Graph legend (spec panel-layout-graph §4 + agent-flow-catalog-graph §2.4):
 * the footer-left readibility aid — phase ring / plan state machine / agent
 * flow pipeline / edge kinds / highlight meanings as swatch + label rows.
 * Pure render of the `t` seat; every label is a `graph.legend.*` locale key.
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
    { key: 'idle', swatch: css.swatchIdle, label: t('graph.legend.state-idle') },
    { key: 'pass', swatch: css.swatchPass, label: t('graph.legend.verdict-pass') },
    { key: 'fail', swatch: css.swatchFail, label: t('graph.legend.verdict-fail') },
    // Agent-flow pipeline (spec agent-flow-catalog-graph §2.4): hollow =
    // expected stage skeleton, filled = actual dispatch evidence, outlined =
    // unexpected (off-pipeline) role events.
    { key: 'flow-expected', swatch: css.swatchFlowExpected, label: t('graph.legend.flow-expected') },
    { key: 'flow-actual', swatch: css.swatchFlowActual, label: t('graph.legend.flow-actual') },
    { key: 'flow-unexpected', swatch: css.swatchFlowUnexpected, label: t('graph.legend.flow-unexpected') },
  ]
  return (
    <div className={css.legend} data-mstar-legend>
      <span className={css.legendTitle}>{t('graph.legend.title')}</span>
      <ul className={css.legendList}>
        {items.map((item) => (
          <li key={item.key} className={css.legendItem} data-mstar-legend-item={item.key}>
            <span className={`${css.legendSwatch} ${item.swatch}`} />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
