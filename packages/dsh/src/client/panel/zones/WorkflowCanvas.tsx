/**
 * WorkflowCanvas (spec panel-zones §2) — replaces the react-flow GraphCanvas
 * with a pure HTML/CSS zone dashboard:
 *
 * - flex column: the zone scroll container (the ONLY scroll body — zones
 *   overflow internally, the page / main never scroll) + the bottom fixed
 *   footer bar (legend left, gate summary right — flex:none, fixed height,
 *   never scrolls with the zones) + the canvas-corner AgentEventDock
 *   (absolute bottom-left, mounted only when events exist — v3).
 * - the three zones render as a CSS grid: iteration fixed left / tasks flex
 *   center / agents fixed right (~380px), stacked vertically below 1200px
 *   (the zones grid media query, spec §2).
 *
 * Degradation stays total (spec §8): `projectGraph` never throws, the zone
 * placeholders render muted empty states, and the footer/dock degrade per
 * field — never an orange warn box, never a crash.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZoneView } from '../graph/project-graph.ts'
import css from './zones.module.css'
import { AgentEventDock } from './AgentEventDock.tsx'
import { AgentFlowZone } from './AgentFlowZone.tsx'
import { IterationZone } from './IterationZone.tsx'
import { Legend } from './Legend.tsx'
import { TaskBoard } from './TaskBoard.tsx'

export interface WorkflowCanvasProps {
  view: ZoneView
  t: TranslateNS<'mstar-panel'>
}

export function WorkflowCanvas({ view, t }: WorkflowCanvasProps) {
  // Footer gate summary (spec §2): the current-step verdict badge + the
  // collapsible violations list (str()-guarded rows from the projection).
  const verdict = view.verdict
  const verdictLabel = verdict === 'pass'
    ? t('graph.pass')
    : verdict === 'fail'
      ? `${t('graph.fail')} (${view.iteration.violationCount ?? 0})`
      : t('panel.unknown')
  return (
    <div className={css.canvas} data-mstar-canvas>
      <div className={css.scroll} data-mstar-canvas-scroll>
        <div className={css.zones}>
          <IterationZone view={view.iteration} t={t} />
          <TaskBoard view={view.tasks} t={t} />
          <AgentFlowZone view={view.agents} t={t} />
        </div>
      </div>
      <footer className={css.footer} data-mstar-graph-footer>
        <Legend t={t} />
        <div className={css.gateSummary} data-mstar-gate-summary>
          <span
            className={verdict === 'fail' ? css.summaryFail : verdict === 'pass' ? css.summaryPass : css.summaryUnknown}
            data-graph-verdict={verdict}
          >
            {verdictLabel}
          </span>
          <details className={css.violationsDetails} data-graph-violations-count={view.violations.length}>
            <summary>
              {view.violations.length > 0
                ? t('graph.violations', { count: String(view.violations.length) })
                : t('graph.no-violations')}
            </summary>
            {view.violations.length > 0 && (
              <ul className={css.violationList} data-mstar-violations>
                {view.violations.map((v, i) => (
                  <li
                    key={v.code !== '' ? v.code : `violation-${i}`}
                    data-violation-code={v.code || 'unknown'}
                    data-severity={v.severity || 'unknown'}
                  >
                    <code className={css.violationCode}>{v.code || t('panel.unknown')}</code>
                    <span className={css.violationMessage}>{v.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      </footer>
      {/* AgentEventDock (v3): canvas bottom-left fixed corner — mounted ONLY
          when events exist; hidden entirely (no placeholder) at 0 events. */}
      {view.events.length > 0 && <AgentEventDock events={view.events} unexpected={view.unexpected} t={t} />}
    </div>
  )
}
