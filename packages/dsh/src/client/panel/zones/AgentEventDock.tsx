/**
 * AgentEventDock (spec panel-zones §2, v3): the agent-flow event strip as a
 * canvas-corner fixed region — absolute at the canvas bottom-left, mounted
 * ONLY when `events.length > 0` (the parent gates the mount; the component
 * also guards internally so a misused empty dock never renders — total
 * function). Hidden entirely (no placeholder box) when there are no events.
 *
 * Content (moved from the react-flow footer strip, spec §2): ≤50 event rows
 * (role → planId#taskId, ts, status-colored label + dot, agent, settled ✓)
 * with unexpected dispatch events re-listed in their own warn section.
 * Event ids are window-relative (`${ts}-${kind}-${index}`, T1 projection) —
 * NEVER a durable key; React keys only need intra-render stability.
 *
 * T3 (plan 20260810-panel-agent-flow-zone): the dock is collapsible — the
 * frame is a native <details> (open by default, so events show on mount) with
 * the header row as its <summary>: clicking the header toggles the list
 * without JS, and the disclosure marker is hidden in CSS (the header already
 * reads as the title/count row). No-JS, keyboard-accessible, SSR-stable.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FlowEventView } from '../graph/project-graph.ts'
import css from './zones.module.css'

export interface AgentEventDockProps {
  events: readonly FlowEventView[]
  unexpected: readonly FlowEventView[]
  t: TranslateNS<'mstar-panel'>
}

/** Status label for one event row (spec §2.4 key set). */
function flowStatusLabel(status: FlowEventView['status'], t: TranslateNS<'mstar-panel'>): string {
  switch (status) {
    case 'dispatched': return t('flow.in-flight')
    case 'advisory': return t('flow.advisory')
    case 'denied': return t('flow.denied')
    case 'ok': return t('flow.settled-ok')
    case 'error': return t('flow.error')
    default: return t('panel.unknown')
  }
}

/** Status chip color class (dispatch → business/warn/error; settle → success/error). */
function flowStatusClass(status: FlowEventView['status']): string {
  switch (status) {
    case 'dispatched': return css.flowStatusDispatched
    case 'advisory': return css.flowStatusAdvisory
    case 'denied': return css.flowStatusDenied
    case 'ok': return css.flowStatusOk
    case 'error': return css.flowStatusError
    default: return css.flowStatusUnknown
  }
}

/** Local HH:MM clock time; ts 0 (missing) renders empty — never a fabricated time. */
function formatEventTime(ts: number): string {
  if (ts <= 0) return ''
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** `planId#taskId` best-effort target cell (spec §2.4: role → planId#taskId). */
function flowEventTarget(event: FlowEventView): string {
  if (event.planId !== null && event.taskId !== null) return `${event.planId}#${event.taskId}`
  if (event.planId !== null) return event.planId
  if (event.taskId !== null) return `#${event.taskId}`
  return ''
}

/** One agent-flow event row (shared by the main list and the unexpected re-list). */
function FlowEventRow({ event, t }: { event: FlowEventView; t: TranslateNS<'mstar-panel'> }) {
  const statusLabel = flowStatusLabel(event.status, t)
  const target = flowEventTarget(event)
  const time = formatEventTime(event.ts)
  return (
    <li
      className={css.flowEventRow}
      data-graph-flow-event={event.id}
      data-graph-flow-event-kind={event.kind}
      data-graph-flow-event-status={event.status}
      data-graph-flow-event-expected={event.expected}
      data-graph-flow-event-settled={event.settled}
    >
      <span className={css.flowEventRole}>
        {event.kind === 'settle'
          // Settle rows carry no role (T1 sets '') — the glyph marks the
          // completion record itself; the outcome is the status chip.
          ? <span className={css.flowSettleGlyph} aria-hidden="true">✓</span>
          : event.role !== '' ? event.role : t('panel.unknown')}
      </span>
      {target !== '' && <span className={css.flowEventTarget}>{target}</span>}
      {time !== '' && <span className={css.flowEventTime}>{time}</span>}
      <span
        className={`${css.flowStatus} ${flowStatusClass(event.status)}`}
        data-flow-status={event.status}
      >
        <span className={css.flowStatusDot} aria-hidden="true" />
        {statusLabel}
      </span>
      {event.kind === 'dispatch' && event.settled && (
        <span className={css.flowSettledMark} aria-hidden="true">✓</span>
      )}
      {event.agent !== null && <span className={css.flowEventAgent}>{event.agent}</span>}
      {event.durationMs !== null && <span className={css.flowEventDuration}>{event.durationMs}ms</span>}
    </li>
  )
}

export function AgentEventDock({ events, unexpected, t }: AgentEventDockProps) {
  // v3: the dock is mounted only when events exist — never a placeholder box.
  // T3: <details open> — the header row is the toggle; events show by default.
  if (events.length === 0) return null
  return (
    <details className={css.dock} data-agent-event-dock data-agent-event-count={events.length} open>
      <summary className={css.dockHeader}>
        <span className={css.dockTitle}>{t('flow.title')}</span>
        <span className={css.dockCount}>{t('flow.event-count', { count: String(events.length) })}</span>
        {unexpected.length > 0 && (
          <span className={css.dockUnexpectedBadge} data-agent-event-unexpected-count={unexpected.length}>
            {t('flow.unexpected')} · {unexpected.length}
          </span>
        )}
      </summary>
      <ul className={css.flowEventList} data-mstar-flow-events>
        {events.map((event) => (
          <FlowEventRow key={event.id} event={event} t={t} />
        ))}
      </ul>
      {unexpected.length > 0 && (
        <div className={css.flowUnexpectedSection} data-mstar-flow-unexpected>
          <span className={css.flowUnexpectedHeading}>{t('flow.unexpected')}</span>
          <ul className={css.flowEventList}>
            {unexpected.map((event) => (
              <FlowEventRow key={event.id} event={event} t={t} />
            ))}
          </ul>
        </div>
      )}
    </details>
  )
}
