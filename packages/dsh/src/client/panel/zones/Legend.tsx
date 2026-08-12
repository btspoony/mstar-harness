/**
 * Legend (spec panel-tabs §4/§6.2, plan 20260811-panel-agent-canvas Task 3):
 * mounted on the AgentCanvasPage (the zone-dashboard footer legend is gone
 * with the WorkflowCanvas — spec §6.1). Describes the agent canvas: the
 * collaboration edges (expected dim-dashed skeleton / actual business handoff
 * / the bidirectional supervise line — plan 20260812-panel-f5-agent-layout
 * Task 2: implementor ↔ sdd-reviewer mutual supervision / the animated next
 * edge), the layout (the sdd-implement sub-buckets implementor / sdd-reviewer,
 * the on-demand badge inside the implementor partition, the rightmost unknown
 * column for the general bucket — the former separate 'general' entry is
 * replaced by 'unknown') and the entity card treatments (running glow,
 * settled ✓, idle dashed-muted). Pure render of the `t` seat; every label is
 * a `zone.legend.*` locale key.
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
    // solid entity→entity handoff line, next = the ANIMATED business
    // dash-flow edge.
    { key: 'flow-expected', swatch: css.swatchFlowExpected, label: t('zone.legend.flow-expected') },
    { key: 'flow-actual', swatch: css.swatchFlowActual, label: t('zone.legend.flow-actual') },
    // Layout (plan 20260812-panel-f5-agent-layout Task 2): the sdd-implement
    // sub-buckets (implementor above / sdd-reviewer below), the bidirectional
    // supervise line, the on-demand badge (implementor-sub-bucket roles —
    // ops-engineer / prompt-engineer, the standalone on-demand column is
    // gone) and the rightmost unknown column (the general bucket — unmatched
    // / anonymous dispatches; replaces the former separate 'general' entry).
    { key: 'sub-bucket', swatch: css.swatchSubBucket, label: t('zone.legend.sub-bucket') },
    { key: 'supervise', swatch: css.swatchSupervise, label: t('zone.legend.supervise') },
    { key: 'on-demand', swatch: css.swatchOnDemand, label: t('zone.legend.on-demand') },
    { key: 'unknown', swatch: css.swatchUnknown, label: t('zone.legend.unknown') },
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
