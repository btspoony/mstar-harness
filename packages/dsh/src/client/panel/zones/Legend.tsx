/**
 * Zone legend (spec panel-zones §2/§7): the footer-left readability aid —
 * zone-semantic swatch + label rows (iteration zone / current step / disabled
 * iteration / task kanban / verdicts / agent-pipeline expected·actual·
 * unexpected). Replaces the react-flow legend (edge-forward/loop/connector
 * items are gone with the graph library). Pure render of the `t` seat; every
 * label is a `zone.legend.*` locale key.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './zones.module.css'

export interface LegendProps {
  t: TranslateNS<'mstar-panel'>
}

export function Legend({ t }: LegendProps) {
  const items: { key: string; swatch: string; label: string }[] = [
    { key: 'iteration', swatch: css.swatchIteration, label: t('zone.legend.iteration') },
    { key: 'current', swatch: css.swatchCurrent, label: t('zone.legend.current') },
    { key: 'disabled', swatch: css.swatchDisabled, label: t('zone.legend.disabled') },
    { key: 'tasks', swatch: css.swatchTasks, label: t('zone.legend.tasks') },
    { key: 'verdict-pass', swatch: css.swatchPass, label: t('zone.legend.verdict-pass') },
    { key: 'verdict-fail', swatch: css.swatchFail, label: t('zone.legend.verdict-fail') },
    // Agent-pipeline states (spec §4): hollow = expected stage skeleton,
    // filled = actual dispatch evidence, outlined = unexpected role events.
    { key: 'flow-expected', swatch: css.swatchFlowExpected, label: t('zone.legend.flow-expected') },
    { key: 'flow-actual', swatch: css.swatchFlowActual, label: t('zone.legend.flow-actual') },
    { key: 'flow-unexpected', swatch: css.swatchFlowUnexpected, label: t('zone.legend.flow-unexpected') },
    // Next-flow edge (plan 3): the animated business dash arrow from the
    // latest running entity to the next expected stage — declared now so the
    // legend stays complete when the agent-flow zone lands.
    { key: 'next', swatch: css.swatchNext, label: t('zone.legend.next') },
  ]
  return (
    <div className={css.legend} data-mstar-legend>
      <span className={css.legendTitle}>{t('zone.legend.title')}</span>
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
