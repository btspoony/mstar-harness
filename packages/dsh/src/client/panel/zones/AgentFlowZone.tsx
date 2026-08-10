/**
 * AgentFlowZone — PLACEHOLDER (plan 20260810-panel-canvas-zones Task 2): the
 * zone frame + header + muted empty state. The agent entity cards, stage
 * lit/count and flow arrows land in plan 20260810-panel-agent-flow-zone
 * (spec §4 — "plan 3 完整；plan 2 先交付骨架").
 *
 * The muted empty note is evidence-aware per spec §8 (the T1 projection
 * already exposes the flags): `degraded` → "agentFlow 证据缺失"; `empty` (0
 * events) → "暂无实际派发"; otherwise the generic pending placeholder. All
 * muted, never an orange warn box; never a crash.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import css from './zones.module.css'

export interface AgentFlowZoneProps {
  view: ZoneView['agents']
  t: TranslateNS<'mstar-panel'>
}

export function AgentFlowZone({ view, t }: AgentFlowZoneProps) {
  const note = view.degraded ? t('flow.degraded') : view.empty ? t('flow.empty') : t('zone.agents.placeholder')
  return (
    <section className={css.zone} data-zone="agents">
      <h2 className={css.zoneHeader} data-zone-header>{t('zone.agents.title')}</h2>
      <p className={css.zoneEmpty} data-zone-empty>{note}</p>
    </section>
  )
}
