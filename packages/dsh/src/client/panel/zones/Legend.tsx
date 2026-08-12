/**
 * Legend (spec panel-tabs §4/§6.2, plan 20260811-panel-agent-canvas Task 3):
 * mounted on the AgentCanvasPage (the zone-dashboard footer legend is gone
 * with the WorkflowCanvas — spec §6.1). Describes the agent canvas: the
 * collaboration edges (expected dim-dashed skeleton / actual business handoff
 * / the general bucket — plan 20260811-panel-f3-agent-general, the former
 * 'unexpected' entry, rendered at the bottom of the sdd-implement column —
 * plan 20260811-panel-f4-agent-view Task 2 / animated next edge) and the
 * entity card treatments (running glow, settled ✓, idle dashed-muted). Pure
 * render of the `t` seat; every label is a `zone.legend.*` locale key.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './zones.module.css'

export interface LegendProps {
  t: TranslateNS<'mstar-panel'>
}

export function Legend({ t }: LegendProps) {
  const items: { key: string; swatch: string; label: string }[] = [
    // Collaboration edges on the agent canvas (spec §4 — AgentEdge model):
    // expected = dim dashed stage→stage skeleton line, actual = business
    // solid entity→entity handoff line, general = the general bucket (SDD
    // per-task reviewers / unmatched / anonymous dispatches) — rendered at
    // the BOTTOM of the sdd-implement column, no general column (plan f4.2
    // Task 2), next = the ANIMATED business dash-flow edge.
    { key: 'flow-expected', swatch: css.swatchFlowExpected, label: t('zone.legend.flow-expected') },
    { key: 'flow-actual', swatch: css.swatchFlowActual, label: t('zone.legend.flow-actual') },
    { key: 'general', swatch: css.swatchGeneral, label: t('zone.legend.general') },
    // On-demand zone (plan 20260811-panel-f2-quickfix Item 3): ops-engineer /
    // prompt-engineer — their own column, distinct from the general bucket.
    { key: 'on-demand', swatch: css.swatchOnDemand, label: t('zone.legend.on-demand') },
    // Entity statuses (plan Task 3): the card treatments — running (business
    // glow ring), settled (success ✓) and idle (dashed muted card).
    { key: 'agent-running', swatch: css.swatchAgentRunning, label: t('zone.legend.agent-running') },
    { key: 'agent-settled', swatch: css.swatchAgentSettled, label: t('zone.legend.agent-settled') },
    { key: 'agent-idle', swatch: css.swatchAgentIdle, label: t('zone.legend.agent-idle') },
    // Next-flow edge: the animated business dash arrow from the latest
    // running entity to the next expected stage.
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
