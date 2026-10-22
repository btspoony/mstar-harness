/**
 * EventLogPage — the 事件记录 tab: ONE flow.
 *
 * The former two-partition split (Agent 流转事件 + 违规记录, each with its own
 * scroller and empty card) is RETIRED. The projection already merged the
 * agent-flow ledger and the gate violations into a single time-descending
 * list, and this page renders it as one list: each row carries a kind badge
 * (流转 / 结算 / 违规) followed by the role, the summary and the time. The body
 * of every row stays an expandable native `<details>` (no-JS, keyboard
 * accessible, SSR-stable) showing the full fields — a missing value renders
 * 「—」, never a guessed one.
 *
 * Degradation is explicit: a MISSING ledger (`degraded.ledger`) renders the
 * "ledger unavailable" note, distinct from the "recording started, no events"
 * state of a present-but-empty ledger. Neither is a fabricated empty list.
 *
 * Layout: flow content in the panel's single scroll body — rows grow the
 * scroll instead of owning a scrollbar, and the row head wraps rather than
 * scrolling sideways in the narrow column.
 *
 * Anchors: the page root `data-mstar-page="events"`; `data-event-log-row`
 * (+ `-kind` / `-id`) per row; `data-event-log-details` per expandable row;
 * `data-event-log-field` (+ `data-event-log-missing="true"`) per detail-body
 * field; `data-event-log-empty` / `data-event-log-ledger` for the two empty
 * states.
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FlowEventStatus, FlowEventView, ZoneView } from '../graph/project-graph.ts'
import { eventLogEntries, isWorkflowKind, type EventLogEntry } from '../graph/event-log.ts'
import css from './event-log.module.css'

export interface EventLogPageProps {
  /** The projected zone view — the merged `events` flow. */
  view: ZoneView
  t: TranslateNS<'mstar-panel'>
}

/** Status label of one row. */
function statusLabel(status: FlowEventStatus, t: TranslateNS<'mstar-panel'>): string {
  switch (status) {
    case 'dispatched': return t('flow.in-flight')
    case 'advisory': return t('flow.advisory')
    case 'denied': return t('flow.denied')
    case 'ok': return t('flow.settled-ok')
    case 'error': return t('flow.error')
    default: return t('panel.unknown')
  }
}

/** Status chip class (dispatch → business/warn/error; settle → success/error). */
function statusClass(status: FlowEventStatus): string {
  switch (status) {
    case 'dispatched': return css.statusDispatched
    case 'advisory': return css.statusAdvisory
    case 'denied': return css.statusDenied
    case 'ok': return css.statusOk
    case 'error': return css.statusError
    default: return css.statusUnknown
  }
}

/** The kind badge label (the merged 流转 / 结算 / 违规 vocabulary). */
function kindLabel(kind: FlowEventView['kind'], t: TranslateNS<'mstar-panel'>): string {
  if (kind === 'settle') return t('event-log.kind.settle')
  if (kind === 'violation') return t('event-log.kind.violation')
  return t('event-log.kind.dispatch')
}

/** One detail-body field: a missing value renders the muted 「—」 seat. */
function Field({ label, value, testId }: { label: string; value: string; testId: string }) {
  const missing = value === ''
  return (
    <div className={css.detailField}>
      <span className={css.detailLabel}>{label}</span>
      <span
        className={missing ? [css.detailValue, css.detailValueMissing].filter(Boolean).join(' ') : css.detailValue}
        data-event-log-field={testId}
        {...(missing ? { 'data-event-log-missing': 'true' } : {})}
      >
        {missing ? '—' : value}
      </span>
    </div>
  )
}

/** One event row. */
function EventRow({ entry, t }: { entry: EventLogEntry; t: TranslateNS<'mstar-panel'> }) {
  const time = entry.ts > 0 ? new Date(entry.ts).toLocaleTimeString('en-GB') : ''
  return (
    <li
      className={css.eventDetails}
      data-event-log-row={entry.id}
      data-event-log-row-kind={entry.kind}
      data-event-log-row-id={entry.id}
    >
      <details className={css.eventDetails} data-event-log-details={entry.id}>
        <summary className={css.eventSummary}>
          <span className={css.statusChip} data-event-log-kind={entry.kind}>{kindLabel(entry.kind, t)}</span>
          <span className={css.eventRole} data-event-log-role={entry.role}>{entry.role === '' ? '—' : entry.role}</span>
          <span className={css.eventTarget} data-event-log-target={entry.task}>
            {entry.task === '' ? '—' : entry.task}
          </span>
          {entry.kind !== 'violation' && (
            <span className={[css.statusChip, statusClass(entry.status)].filter(Boolean).join(' ')} data-event-log-status={entry.status}>
              {statusLabel(entry.status, t)}
            </span>
          )}
          {entry.settled && (
            <span className={css.settledMark} data-event-log-settled="true" aria-label={t('event-log.field.settled')}>✓</span>
          )}
          <span className={css.eventTime} data-event-log-time={time}>{time === '' ? '—' : time}</span>
        </summary>
        <div className={css.detailBody}>
          {entry.ledgerKind !== '' && (
            <Field label={t('event-log.field.kind')} value={entry.ledgerKind} testId="kind" />
          )}
          {entry.kind === 'violation'
            ? (
              <>
                <Field label={t('event-log.field.severity')} value={entry.severity ?? ''} testId="severity" />
                <Field label={t('event-log.field.code')} value={entry.code ?? ''} testId="code" />
                <Field label={t('event-log.field.message')} value={entry.message ?? ''} testId="message" />
              </>
            )
            : (
              <>
                <Field label={t('event-log.field.agent')} value={entry.agent ?? ''} testId="agent" />
                <Field label={t('event-log.field.plan')} value={entry.planId ?? ''} testId="plan" />
                <Field label={t('event-log.field.task')} value={entry.taskId ?? ''} testId="task" />
                <Field label={t('event-log.field.category')} value={entry.taskCategory ?? ''} testId="category" />
                <Field label={t('event-log.field.status')} value={statusLabel(entry.status, t)} testId="status" />
                <Field
                  label={t('event-log.field.settled')}
                  value={entry.settled ? t('event-log.yes') : t('event-log.no')}
                  testId="settled"
                />
                <Field
                  label={t('event-log.field.duration')}
                  value={entry.durationMs === null ? '' : `${entry.durationMs} ms`}
                  testId="duration"
                />
                {isWorkflowKind(entry.ledgerKind) && (
                  <>
                    <Field label={t('event-log.field.run-id')} value={entry.runId ?? ''} testId="run-id" />
                    <Field label={t('event-log.field.name')} value={entry.name ?? ''} testId="name" />
                    <Field
                      label={t('event-log.field.members')}
                      value={entry.memberCount === undefined ? '' : String(entry.memberCount)}
                      testId="members"
                    />
                    <Field label={t('event-log.field.stop-reason')} value={entry.stopReason ?? ''} testId="stop-reason" />
                  </>
                )}
                {entry.childId !== undefined && entry.childId !== '' && (
                  <Field label={t('event-log.field.child-id')} value={entry.childId} testId="child-id" />
                )}
                {entry.reason !== undefined && entry.reason !== '' && (
                  <Field label={t('event-log.field.reason')} value={entry.reason} testId="reason" />
                )}
              </>
            )}
        </div>
      </details>
    </li>
  )
}

export function EventLogPage({ view, t }: EventLogPageProps) {
  const entries = eventLogEntries(view)
  return (
    <div className={css.eventLogPage} data-mstar-page="events">
      <header className={css.section}>
        <h2 className={css.sectionTitle} data-event-log-title>{t('event-log.title')}</h2>
      </header>
      {/* A MISSING ledger is ALWAYS disclosed, even when gate violations still
          render — the page never implies the flow is complete. */}
      {view.degraded.ledger && (
        <p className={css.empty} data-event-log-ledger="unavailable">{t('event-log.ledger-unavailable')}</p>
      )}
      {entries.length === 0
        ? (view.degraded.ledger
          ? null
          : <p className={css.empty} data-event-log-empty="no-events">{t('event-log.empty')}</p>)
        : (
          <ul className={css.rowList} data-event-log-flow>
            {entries.map((entry) => <EventRow key={entry.id} entry={entry} t={t} />)}
          </ul>
        )}
    </div>
  )
}
