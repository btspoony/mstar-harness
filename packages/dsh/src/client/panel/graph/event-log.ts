/**
 * Event-log entry assembly (spec panel-tabs §5 — plan 20260811-panel-event-log
 * Task 1): `eventLogEntries(view)` turns the projected `ZoneView` slices
 * (`events` / `violations`) into display-ready log entries for the 事件记录
 * tab (`EventLogPage`, Task 2). A pure function over the projection output —
 * the projection interfaces (`ZoneView` / `FlowEventView` / `GraphViolation`)
 * are consumed unchanged, ZERO projection changes.
 *
 * Total function (spec §8 discipline): NEVER throws, NEVER fabricates. Every
 * field degrades individually — a missing value becomes '' (string fields),
 * `0` (`ts`) or `null` (`durationMs`), mirroring the `guards.ts` contract;
 * the render side shows「—」for those (spec §5 — never a guessed value).
 *
 * Shape: one array, two entry kinds (spec §5 partitions):
 * - `event` rows — `view.events` in projection order (latest-first; the ≤50
 *   window is `classifyFlowRows`' FLOW_EVENT_WINDOW, consumed NOT
 *   re-implemented). Off-pipeline (unexpected) DISPATCHES fold in via
 *   `expected: false`: `view.unexpected` is a RE-LIST of rows already inside
 *   `view.events`, so reading it here would double-append — the page decides
 *   how to section/badge them.
 * - `violation` rows — `view.violations` (gate violations, str()-guarded)
 *   after the event rows; the page renders them in their own 违规记录
 *   partition.
 */

import type { FlowEventStatus, FlowEventView, ZoneView } from './project-graph.ts'

/** One agent-flow event row: the log's 流转事件 partition (spec §5). */
export interface EventLogEventEntry {
  /** Entry discriminator — this row is an agent-flow event. */
  kind: 'event'
  /** Stable per-projection id (reuses the projected event's window id — React key). */
  id: string
  /** 'dispatch' | 'settle' — the page distinguishes settle rows (✓ glyph, no role). */
  eventKind: FlowEventView['kind']
  /** `Execute as`; '' for settle rows and missing roles (never fabricated). */
  role: string
  /** Session id; '' when missing (render shows「—」). */
  agent: string
  /** `${phase}:${stage}` when the role matched an expected stage; '' otherwise. */
  stage: string
  /** planId#taskId best-effort tag (planId / #taskId fallbacks); '' when neither present. */
  task: string
  /** Event timestamp; 0 when missing (render shows '' — never a guessed time). */
  ts: number
  /** Dispatch → dispatched|advisory|denied; settle → ok|error|denied (token-colored). */
  status: FlowEventStatus
  /** Dispatch with a paired settle (best-effort); settle rows are never "settled". */
  settled: boolean
  /** Settle duration in ms; null when missing/illegal (render shows「—」). */
  durationMs: number | null
  /** role ∈ EXPECTED_ROLE_FLOW union — false = off-pipeline (unexpected) dispatch. */
  expected: boolean
}

/** One gate violation row: the log's 违规记录 partition (spec §5). */
export interface EventLogViolationEntry {
  /** Entry discriminator — this row is a gate violation. */
  kind: 'violation'
  /** Stable per-projection id (`violation-${index}` — React key). */
  id: string
  /** str()-guarded severity; '' when missing. */
  severity: string
  /** str()-guarded code; '' when missing. */
  code: string
  /** str()-guarded message; '' when missing. */
  message: string
}

/** One display-ready event-log row: an agent-flow event or a gate violation. */
export type EventLogEntry = EventLogEventEntry | EventLogViolationEntry

/** Best-effort task tag (spec §2.4 — the same fallback chain as the retired dock). */
function taskTag(event: FlowEventView): string {
  if (event.planId !== null && event.taskId !== null) return `${event.planId}#${event.taskId}`
  if (event.planId !== null) return event.planId
  if (event.taskId !== null) return `#${event.taskId}`
  return ''
}

/** One event row: every field degrades individually (missing → ''/0/null). */
function eventEntryOf(event: FlowEventView): EventLogEventEntry {
  return {
    kind: 'event',
    id: event.id,
    eventKind: event.kind,
    role: event.role,
    agent: event.agent ?? '',
    stage: event.stage === null ? '' : `${event.stage.phase}:${event.stage.stage}`,
    task: taskTag(event),
    ts: event.ts,
    status: event.status,
    settled: event.settled,
    durationMs: event.durationMs,
    expected: event.expected,
  }
}

/**
 * Assemble the event-log rows (spec §5): `view.events` (latest-first, ≤50 —
 * the projection's window, NOT re-windowed here) mapped to `event` entries,
 * then `view.violations` mapped to `violation` entries. Empty slices produce
 * no rows — the mixed empty states (0 events + violations, events + 0
 * violations) fall out naturally; the page renders the muted「暂无记录」empty
 * state when the whole array is empty (spec §8).
 */
export function eventLogEntries(view: ZoneView): EventLogEntry[] {
  const entries: EventLogEntry[] = view.events.map(eventEntryOf)
  view.violations.forEach((violation, i) => {
    entries.push({
      kind: 'violation',
      id: `violation-${i}`,
      severity: violation.severity,
      code: violation.code,
      message: violation.message,
    })
  })
  return entries
}
