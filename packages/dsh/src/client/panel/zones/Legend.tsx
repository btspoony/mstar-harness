/**
 * Legend (spec panel-tabs §4/§6.2, plan 20260811-panel-agent-canvas Task 3):
 * mounted on the AgentCanvasPage (the zone-dashboard footer legend is gone
 * with the WorkflowCanvas — spec §6.1). Describes the agent canvas: the
 * collaboration edges (actual business handoff curve / the bidirectional
 * supervise line — plan 20260812-panel-f5-agent-layout Task 2:
 * implementor ↔ sdd-reviewer mutual supervision / the card PORT anchors —
 * plan 20260812-panel-f5-design-system Task 5: 4 hover-visible edge-midpoint
 * ports; the expected skeleton and the animated next edge entries are
 * REMOVED with the edges, design doc §2.8), the layout (the sdd-implement
 * sub-buckets implementor / sdd-reviewer, the on-demand badge inside the
 * implementor partition, the unknown sub-partition at the bottom of the LAST
 * column for the general bucket — the former separate 'unknown column'
 * wording is repurposed, design doc §1.2) and the entity card treatments
 * (running glow, settled ✓, idle dashed-muted). Pure render of the `t` seat;
 * every label is a `zone.legend.*` locale key.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './zones.module.css'

export interface LegendProps {
  t: TranslateNS<'mstar-panel'>
}

export function Legend({ t }: LegendProps) {
  const items: { key: string; swatch: string; label: string }[] = [
    // Collaboration edges on the agent canvas (spec §4 — AgentEdge model,
    // plan 20260812-panel-f5-design-system Task 5 — design doc §2.8): actual
    // = business bezier handoff curve + the card PORT anchors (hover-visible
    // 4 edge-midpoint dots; the lines end at the standoff point 10px off the
    // port). The expected skeleton / next animation entries are REMOVED with
    // the edges (user 2026-08-12 feedback #1/#5).
    { key: 'flow-actual', swatch: css.swatchFlowActual, label: t('zone.legend.flow-actual') },
    { key: 'port', swatch: css.swatchPort, label: t('zone.legend.port') },
    // Layout (plan 20260812-panel-f5-agent-layout Task 2 + plan
    // 20260812-panel-f5-design-system Task 5): the sdd-implement sub-buckets
    // (implementor above / sdd-reviewer below), the bidirectional supervise
    // line (side-gap vertical anchor), the on-demand badge
    // (implementor-sub-bucket roles — ops-engineer / prompt-engineer, the
    // standalone on-demand column is gone) and the unknown SUB-PARTITION at
    // the bottom of the last column (the general bucket — unmatched /
    // anonymous dispatches; the standalone unknown column is gone too).
    { key: 'sub-bucket', swatch: css.swatchSubBucket, label: t('zone.legend.sub-bucket') },
    { key: 'supervise', swatch: css.swatchSupervise, label: t('zone.legend.supervise') },
    { key: 'on-demand', swatch: css.swatchOnDemand, label: t('zone.legend.on-demand') },
    { key: 'unknown', swatch: css.swatchUnknown, label: t('zone.legend.unknown') },
    // Entity statuses (plan Task 3): the card treatments — running (business
    // glow ring), settled (success ✓) and idle (dashed muted card).
    { key: 'agent-running', swatch: css.swatchAgentRunning, label: t('zone.legend.agent-running') },
    { key: 'agent-settled', swatch: css.swatchAgentSettled, label: t('zone.legend.agent-settled') },
    { key: 'agent-idle', swatch: css.swatchAgentIdle, label: t('zone.legend.agent-idle') },
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
