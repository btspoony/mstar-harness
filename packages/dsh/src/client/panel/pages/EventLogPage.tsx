/**
 * EventLogPage (spec panel-tabs §5, plan 20260811-panel-event-log Task 2) —
 * the 事件记录 tab: a NON-canvas log page. Two partitions (spec §5):
 * Agent 流转事件 (`view.events` ≤50 latest-first — unexpected dispatches
 * fold in via the `expected` flag, NEVER double-appended; the unexpected
 * badge is DISPATCH-only — settle rows are completion records whose
 * projected `expected` is always false, they never flag as unexpected,
 * F-001) and 违规记录
 * (`view.violations`). Every row is an expandable native `<details>` (no-JS,
 * keyboard-accessible, SSR-stable) whose body shows the FULL catalog fields;
 * a missing field renders「—」— never a guessed value (spec §5/§8).
 *
 * Dock migration decision (spec §5 — 无双份日志): the AgentEventDock is
 * REMOVED, not degraded. The dock's content (row layout + status chips)
 * moved into this page, and its host (the WorkflowCanvas canvas-corner)
 * died with the tabs-shell plan — a dock-side "jump to 事件记录" entry would
 * only duplicate the header TabNav, which already IS the jump to this tab.
 * Zero `data-agent-event-dock` anchors remain repo-wide (Task 2 完成判据).
 *
 * Row data: `eventLogEntries(view)` (Task 1 — pure assembly; every field
 * degrades individually). The `<details>` body backfills the FULL source
 * fields (planId / taskId / taskCategory — not carried by the floor
 * `EventLogEntry`) through a one-time id → `FlowEventView` map (T1-Min-3:
 * the assembly function stays pure/unchanged; an unmatched id degrades the
 * backfilled fields to「—」like any missing value).
 *
 * Anchors (spec §6.4 — the `data-event-log-*` family): the page root
 * `data-mstar-page="events"`; `data-event-log-section` (+ `-section-count`)
 * for the partitions; `data-event-log-row-kind` / `-row-id` per row;
 * `data-event-log-details` per expandable row; `data-event-log-field` (+
 * `data-event-log-missing="true"`) per detail-body field; `data-event-log-empty`
 * (both-empty) / `data-event-log-empty-section` (mixed empty) for the muted
 * empty states — never an orange warn frame (spec §8).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FlowEventView, ZoneView } from '../graph/project-graph.ts'
import {
  eventLogEntries,
  type EventLogEventEntry,
  type EventLogViolationEntry,
} from '../graph/event-log.ts'
import css from './event-log.module.css'

export interface EventLogPageProps {
  /** The projected zone view — the events/violations slices + source rows. */
  view: ZoneView
  t: TranslateNS<'mstar-panel'>
}

/** Status label for one event row (spec §2.4 key set — moved from the retired dock). */
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
    case 'dispatched': return css.statusDispatched
    case 'advisory': return css.statusAdvisory
    case 'denied': return css.statusDenied
    case 'ok': return css.statusOk
    case 'error': return css.statusError
    default: return css.statusUnknown
  }
}

/** True when ts is a usable Date time value: finite, positive, and inside the
 * ECMAScript Date range (±8.64e15 ms) — outside it `new Date` throws
 * RangeError (spec §8 total-function discipline: the render NEVER throws). */
function isRenderableTime(ts: number): boolean {
  return Number.isFinite(ts) && ts > 0 && Math.abs(ts) <= 8.64e15
}

/** Local HH:MM clock time; ts 0 (missing) or out-of-Date-range renders empty — never a fabricated time. */
function formatEventTime(ts: number): string {
  if (!isRenderableTime(ts)) return ''
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** Local HH:MM:SS clock time for the detail body; ts 0 → '' (the caller shows「—」). */
function formatEventTimeFull(ts: number): string {
  if (!isRenderableTime(ts)) return ''
  return new Date(ts).toLocaleTimeString('en-GB')
}

/** Display value: a missing ('' ) field renders「—」(spec §5 — never a guessed value). */
function orDash(value: string): string {
  return value === '' ? '—' : value
}

/** One label/value row of the expanded detail body (missing → muted「—」). */
function DetailField({ field, label, value }: { field: string; label: string; value: string }) {
  const missing = value === ''
  return (
    <div className={css.detailField} data-event-log-field={field} data-event-log-missing={missing ? 'true' : 'false'}>
      <span className={css.detailLabel}>{label}</span>
      <span className={missing ? `${css.detailValue} ${css.detailValueMissing}` : css.detailValue}>
        {missing ? '—' : value}
      </span>
    </div>
  )
}

/** The expanded body of one event row: the FULL catalog fields (T1-Min-3 backfill). */
function EventDetailsBody({
  entry,
  source,
  t,
}: {
  entry: EventLogEventEntry
  source: FlowEventView | undefined
  t: TranslateNS<'mstar-panel'>
}) {
  return (
    <div className={css.detailBody} data-event-log-detail-body>
      <DetailField field="role" label={t('event-log.field.role')} value={entry.role} />
      <DetailField field="agent" label={t('event-log.field.agent')} value={entry.agent} />
      <DetailField field="stage" label={t('event-log.field.stage')} value={entry.stage} />
      <DetailField field="plan" label={t('event-log.field.plan')} value={source?.planId ?? ''} />
      <DetailField field="task" label={t('event-log.field.task')} value={source?.taskId ?? ''} />
      <DetailField field="category" label={t('event-log.field.category')} value={source?.taskCategory ?? ''} />
      <DetailField field="time" label={t('event-log.field.time')} value={source === undefined ? '' : formatEventTimeFull(source.ts)} />
      <DetailField
        field="kind"
        label={t('event-log.field.kind')}
        value={entry.eventKind === 'dispatch' ? t('event-log.kind.dispatch') : t('event-log.kind.settle')}
      />
      <DetailField field="status" label={t('event-log.field.status')} value={flowStatusLabel(entry.status, t)} />
      <DetailField
        field="expected"
        label={t('event-log.field.expected')}
        // F-001 (QC wave): a SETTLE row is a completion record — the
        // expected-role seat is not applicable there (the projection always
        // sets `expected: false` on settles), so it renders「—」like the
        // `settled` seat (T2-Min-2 precedent); only a DISPATCH row renders
        // the honest yes/no.
        value={entry.eventKind === 'settle' ? '' : entry.expected ? t('event-log.yes') : t('event-log.no')}
      />
      <DetailField
        field="settled"
        label={t('event-log.field.settled')}
        // T2-Min-2: a SETTLE row IS the completion record — the field is not
        // applicable there, so it renders「—」like any missing value (a flat
        // 'no' would misread as "not settled"); a dispatch row renders the
        // honest yes/no.
        value={entry.eventKind === 'settle' ? '' : entry.settled ? t('event-log.yes') : t('event-log.no')}
      />
      <DetailField field="duration" label={t('event-log.field.duration')} value={entry.durationMs === null ? '' : `${entry.durationMs}ms`} />
    </div>
  )
}

/** One agent-flow event row: the summary IS the `<details>` toggle (spec §5). */
function EventLogEventRow({
  entry,
  source,
  t,
}: {
  entry: EventLogEventEntry
  source: FlowEventView | undefined
  t: TranslateNS<'mstar-panel'>
}) {
  const time = formatEventTime(entry.ts)
  return (
    <li className={css.eventRow} data-event-log-row-kind="event" data-event-log-row-id={entry.id} data-event-log-expected={entry.expected ? 'true' : 'false'}>
      <details className={css.eventDetails} data-event-log-details>
        <summary className={css.eventSummary} data-event-log-summary>
          <span className={css.eventRole}>
            {entry.eventKind === 'settle'
              // Settle rows carry no role (T1 sets '') — the glyph marks the
              // completion record itself; the outcome is the status chip.
              ? <span className={css.settleGlyph} aria-hidden="true">✓</span>
              : entry.role !== '' ? entry.role : t('panel.unknown')}
          </span>
          {entry.stage !== '' && <span className={css.eventStage} data-event-log-stage={entry.stage}>{entry.stage}</span>}
          {entry.task !== '' && <span className={css.eventTarget} data-event-log-target={entry.task}>{entry.task}</span>}
          {time !== '' && <span className={css.eventTime} data-event-log-time={time}>{time}</span>}
          <span className={`${css.statusChip} ${flowStatusClass(entry.status)}`} data-event-log-status={entry.status}>
            <span className={css.statusDot} aria-hidden="true" />
            {flowStatusLabel(entry.status, t)}
          </span>
          {entry.eventKind === 'dispatch' && entry.settled && (
            <span className={css.settledMark} data-event-log-settled="true" aria-hidden="true">✓</span>
          )}
          {entry.agent !== '' && <span className={css.eventAgent} data-event-log-agent={entry.agent}>{entry.agent}</span>}
          {entry.durationMs !== null && <span className={css.eventDuration} data-event-log-duration={entry.durationMs}>{entry.durationMs}ms</span>}
          {/* F-001 (QC wave): the unexpected badge is a DISPATCH-only marker —
              a settle row is a completion record whose projected `expected`
              is always false (never flag as unexpected, spec §5). */}
          {entry.eventKind === 'dispatch' && !entry.expected && (
            <span className={css.unexpectedBadge} data-event-log-unexpected="true">{t('flow.unexpected')}</span>
          )}
        </summary>
        <EventDetailsBody entry={entry} source={source} t={t} />
      </details>
    </li>
  )
}

/** One gate violation row — also an expandable `<details>` (spec §5). */
function ViolationRow({ entry, t }: { entry: EventLogViolationEntry; t: TranslateNS<'mstar-panel'> }) {
  const severity = entry.severity !== '' ? entry.severity : 'unknown'
  return (
    <li className={css.violationRow} data-event-log-row-kind="violation" data-event-log-row-id={entry.id}>
      <details className={css.eventDetails} data-event-log-details>
        <summary className={css.violationSummary} data-event-log-summary>
          <span className={css.severityChip} data-event-log-severity={severity}>
            {entry.severity !== '' ? entry.severity : t('panel.unknown')}
          </span>
          {entry.code !== '' && <code className={css.violationCode} data-event-log-code={entry.code}>{entry.code}</code>}
          <span className={css.violationMessage} data-event-log-message={entry.message}>
            {orDash(entry.message)}
          </span>
        </summary>
        <div className={css.detailBody} data-event-log-detail-body>
          <DetailField field="severity" label={t('event-log.field.severity')} value={entry.severity} />
          <DetailField field="code" label={t('event-log.field.code')} value={entry.code} />
          <DetailField field="message" label={t('event-log.field.message')} value={entry.message} />
        </div>
      </details>
    </li>
  )
}

export function EventLogPage({ view, t }: EventLogPageProps) {
  const entries = eventLogEntries(view)
  const eventEntries = entries.filter((e): e is EventLogEventEntry => e.kind === 'event')
  const violationEntries = entries.filter((e): e is EventLogViolationEntry => e.kind === 'violation')
  // T1-Min-3 backfill map: id → the projected source row (planId/taskId/
  // taskCategory live on `FlowEventView`, not on the floor entry).
  const eventById = new Map(view.events.map((event) => [event.id, event]))

  // Empty states (spec §8): both partitions empty → ONE muted「暂无记录」
  // note; a mixed empty state degrades each partition independently.
  if (eventEntries.length === 0 && violationEntries.length === 0) {
    return (
      <div className={css.eventLogPage} data-mstar-page="events">
        <p className={css.empty} data-event-log-empty>{t('event-log.empty')}</p>
      </div>
    )
  }
  return (
    <div className={css.eventLogPage} data-mstar-page="events">
      <section className={css.section} data-event-log-section="events" data-event-log-section-count={eventEntries.length}>
        <h2 className={css.sectionTitle} data-event-log-section-title>{t('event-log.section.events')}</h2>
        {eventEntries.length === 0 ? (
          <p className={css.empty} data-event-log-empty-section="events">{t('event-log.empty.events')}</p>
        ) : (
          <ul className={css.rowList} data-event-log-list="events">
            {eventEntries.map((entry) => (
              <EventLogEventRow key={entry.id} entry={entry} source={eventById.get(entry.id)} t={t} />
            ))}
          </ul>
        )}
      </section>
      <section
        className={css.section}
        data-event-log-section="violations"
        data-event-log-section-count={violationEntries.length}
      >
        <h2 className={css.sectionTitle} data-event-log-section-title>{t('event-log.section.violations')}</h2>
        {violationEntries.length === 0 ? (
          <p className={css.empty} data-event-log-empty-section="violations">{t('event-log.empty.violations')}</p>
        ) : (
          <ul className={css.rowList} data-event-log-list="violations">
            {violationEntries.map((entry) => (
              <ViolationRow key={entry.id} entry={entry} t={t} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
