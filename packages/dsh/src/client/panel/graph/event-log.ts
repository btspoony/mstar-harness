/**
 * Event-log entry assembly: `eventLogEntries(view)` turns the projected event
 * flow into display-ready rows for the 事件记录 tab (`EventLogPage`).
 *
 * ONE flow (the former two-partition split is retired): the projection already
 * merged the agent-flow ledger and the gate violations into a single
 * time-descending list whose rows carry the merged badge kind
 * (`dispatch` / `settle` / `violation`). This module adds only what the RENDER
 * needs and the projection does not own: the `planId#taskId` display tag.
 *
 * Total function: NEVER throws, NEVER fabricates. Every field degrades
 * individually — a missing value stays `null` / `''` / `0`, and the render
 * shows「—」for those.
 */

import type { FlowEventKind, FlowEventView, ZoneView } from './project-graph.ts'

/** One display-ready event-log row: the projected event plus its display tag. */
export interface EventLogEntry extends FlowEventView {
  /** `planId#taskId` display tag (deterministic fallbacks); '' when neither is present. */
  task: string
}

/** The three ledger kinds that describe a workflow run's lifecycle. */
export function isWorkflowKind(kind: string): boolean {
  return kind === 'workflow-run' || kind === 'workflow-agent' || kind === 'workflow-run-end'
}

/** Best-effort task tag: `planId#taskId`, then `planId`, then `#taskId`, else ''. */
function taskTag(event: FlowEventView): string {
  if (event.planId !== null && event.taskId !== null) return `${event.planId}#${event.taskId}`
  if (event.planId !== null) return event.planId
  if (event.taskId !== null) return `#${event.taskId}`
  return ''
}

/** The badge label key of one row kind (the page's 流转 / 结算 / 违规 seat). */
export type EventLogKind = FlowEventKind

/**
 * Assemble the log rows: the projected flow in its own order (time
 * descending, violations last — they carry no timestamp), each with its task
 * tag. An empty projection produces no rows; the page renders its own muted
 * empty state.
 */
export function eventLogEntries(view: ZoneView): EventLogEntry[] {
  return view.events.map((event) => ({ ...event, task: taskTag(event) }))
}
