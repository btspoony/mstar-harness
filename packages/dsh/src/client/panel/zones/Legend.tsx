/**
 * Legend (spec panel-zones §2/§7, plan 20260811-panel-tabs-shell Task 3):
 * the zone-dashboard footer legend is gone with the WorkflowCanvas (the
 * iteration/tasks/verdict zone-level items were removed here — spec §6.1
 * "zone 级 legend 项随 WorkflowCanvas 收敛/移除"); the component file is
 * retained for the downstream agent-canvas plan, which re-mounts it with the
 * agent-pipeline items below (expected·actual·unexpected flow edges, entity
 * statuses, next edge — plus the idle / collaboration swatches it adds).
 * Pure render of the `t` seat; every label is a `zone.legend.*` locale key.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './zones.module.css'

export interface LegendProps {
  t: TranslateNS<'mstar-panel'>
}

export function Legend({ t }: LegendProps) {
  const items: { key: string; swatch: string; label: string }[] = [
    // Agent-pipeline states (spec §4): hollow = expected stage skeleton,
    // filled = actual dispatch evidence, outlined = unexpected role events.
    { key: 'flow-expected', swatch: css.swatchFlowExpected, label: t('zone.legend.flow-expected') },
    { key: 'flow-actual', swatch: css.swatchFlowActual, label: t('zone.legend.flow-actual') },
    { key: 'flow-unexpected', swatch: css.swatchFlowUnexpected, label: t('zone.legend.flow-unexpected') },
    // Entity statuses (plan 3 T3): the status-dot treatments of the entity
    // cards — running (business glow dot) and settled (success ✓).
    { key: 'agent-running', swatch: css.swatchAgentRunning, label: t('zone.legend.agent-running') },
    { key: 'agent-settled', swatch: css.swatchAgentSettled, label: t('zone.legend.agent-settled') },
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
