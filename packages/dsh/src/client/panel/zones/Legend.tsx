/**
 * Legend (spec panel-tabs §4/§6.2, plan 20260811-panel-agent-canvas Task 3):
 * mounted on the AgentCanvasPage (the zone-dashboard footer legend is gone
 * with the WorkflowCanvas — spec §6.1). Describes ONLY the role-card status
 * treatments of the agent canvas — plan
 * 20260813-panel-agent-canvas-legend-layout Task 1 (图例精简): the 7
 * collaboration-edge / layout entries (flow-actual / port / group /
 * sub-bucket / supervise / on-demand / unknown) are REMOVED — the legend is
 * the 3 entity card treatments (running glow, settled = the standalone GREEN
 * done frame + ✓ — never on off-tier roles — idle dashed-muted). Pure render
 * of the `t` seat; every label is a `zone.legend.*` locale key.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './zones.module.css'

export interface LegendProps {
  t: TranslateNS<'mstar-panel'>
}

export function Legend({ t }: LegendProps) {
  const items: { key: string; swatch: string; label: string }[] = [
    // Entity statuses (plan 20260811-panel-agent-canvas Task 3 + plan
    // 20260812-panel-f5-design-system Task 8): the card treatments — running
    // (business glow ring), settled (the standalone GREEN done frame + ✓ —
    // never on off-tier roles, user 2026-08-12 feedback #1/#3) and idle
    // (dashed muted card). The 7 collaboration-edge / layout entries are
    // REMOVED (plan 20260813-panel-agent-canvas-legend-layout Task 1 — the
    // legend is the role-card status description only; the canvas itself
    // keeps the edges / ports / partitions, only the legend copy drops them).
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
