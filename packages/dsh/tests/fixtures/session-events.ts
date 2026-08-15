/**
 * Pure test-data builders for the four durable `tool-workflow/*` session-event
 * payloads, plus malformed variants mirroring the upstream invariant contract.
 *
 * Source of record (read-only, deepseek-harness):
 * - Data shapes verbatim: `packages/workflow/tool-workflow/src/types.ts:13-39`
 *   (event-name map `:41-64`).
 * - Append/recorder semantics: `packages/workflow/tool-workflow/src/index.ts:73-131`
 *   (top-level-only recording, `exec.parent === undefined` at `:291`).
 * - Invariant contract mirrored by the malformed variants:
 *   `packages/workflow/tool-workflow/src/invariant.ts:76-129`.
 * - Member identities: `packages/workflow/workflow/src/types.ts:97-116`
 *   (`seq` is the 1-based `agent()` call sequence within the run; distinct from the
 *   session-log envelope `seq`).
 *
 * These builders return the event **data** payloads only (`event.data` level).
 * The envelope fields (`seq`, `time`) are assigned by the session log at append
 * time (`session.append` — `packages/core/session/src/index.ts:627-633`), so a
 * data builder cannot own them. Callers append the data into a session log:
 * `session.append('tool-workflow/run-start', runStart())`.
 *
 * Zero dependencies by design (Global Constraint: no new runtime deps):
 * `@deepseek-ai/dsh-tool-workflow` / `@deepseek-ai/dsh-workflow` are not resolvable
 * from this repo's node_modules, so the shapes are mirrored structurally here —
 * `runId`/`childId` stay plain `string` (upstream brands them `WorkflowRunId` /
 * `SessionId`); consumers read the payload structurally either way.
 */

/** Member settlement outcome (`workflow/src/types.ts:110`). */
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

/** Terminal run reason (`workflow/src/types.ts:63`). */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

/** `tool-workflow/run-start` payload — opens one durable top-level run record. */
export interface ToolWorkflowRunStartData {
  readonly runId: string
  readonly name: string
}

/** `tool-workflow/agent-start` payload — records one published workflow member. */
export interface ToolWorkflowAgentStartData {
  readonly runId: string
  /** 1-based `agent()` call sequence within the run (NOT the session-log seq). */
  readonly seq: number
  readonly label: string
  /** Omitted when absent (lossless-JSON discipline, upstream `index.ts:102`). */
  readonly phase?: string
  readonly childId: string
}

/** `tool-workflow/agent-end` payload — settles one started member (no label/childId). */
export interface ToolWorkflowAgentEndData {
  readonly runId: string
  readonly seq: number
  readonly outcome: WorkflowAgentOutcome
}

/** `tool-workflow/run-end` payload — closes one run after quiescence. */
export interface ToolWorkflowRunEndData {
  readonly runId: string
  readonly stopReason: WorkflowStopReason
}

/** The four package-owned event names (`tool-workflow/src/types.ts:41-64`). */
export type ToolWorkflowEventType =
  | 'tool-workflow/run-start'
  | 'tool-workflow/agent-start'
  | 'tool-workflow/agent-end'
  | 'tool-workflow/run-end'

/** Default run identity (upstream test convention, e.g. `tool-workflow.spec.ts:149`). */
export const DEFAULT_RUN_ID = 'run-1'
/** Default display name. */
export const DEFAULT_RUN_NAME = 'audit'
/** Default member display label. */
export const DEFAULT_LABEL = 'worker'
/** Default child session identity (upstream test convention `child-1`). */
export const DEFAULT_CHILD_ID = 'child-1'

/**
 * Build well-formed `tool-workflow/run-start` data.
 * @param init - overrides; both fields default so `runStart()` is always valid.
 */
export function runStart(
  init: { runId?: string; name?: string } = {},
): ToolWorkflowRunStartData {
  return {
    runId: init.runId ?? DEFAULT_RUN_ID,
    name: init.name ?? DEFAULT_RUN_NAME,
  }
}

/**
 * Build well-formed `tool-workflow/agent-start` data.
 * `phase` is omitted when not provided (upstream omission discipline).
 * @param init - overrides; every field defaults so `agentStart()` is always valid.
 */
export function agentStart(
  init: { runId?: string; seq?: number; label?: string; phase?: string; childId?: string } = {},
): ToolWorkflowAgentStartData {
  return {
    runId: init.runId ?? DEFAULT_RUN_ID,
    seq: init.seq ?? 1,
    label: init.label ?? DEFAULT_LABEL,
    ...init.phase === undefined ? {} : { phase: init.phase },
    childId: init.childId ?? DEFAULT_CHILD_ID,
  }
}

/**
 * Build well-formed `tool-workflow/agent-end` data.
 * @param init - overrides; `seq`/`outcome` default so `agentEnd()` is always valid.
 */
export function agentEnd(
  init: { runId?: string; seq?: number; outcome?: WorkflowAgentOutcome } = {},
): ToolWorkflowAgentEndData {
  return {
    runId: init.runId ?? DEFAULT_RUN_ID,
    seq: init.seq ?? 1,
    outcome: init.outcome ?? 'completed',
  }
}

/**
 * Build well-formed `tool-workflow/run-end` data.
 * @param init - overrides; `stopReason` defaults so `runEnd()` is always valid.
 */
export function runEnd(
  init: { runId?: string; stopReason?: WorkflowStopReason } = {},
): ToolWorkflowRunEndData {
  return {
    runId: init.runId ?? DEFAULT_RUN_ID,
    stopReason: init.stopReason ?? 'completed',
  }
}

// ---------------------------------------------------------------------------
// Malformed variants — each payload violates the upstream invariant contract
// (`tool-workflow/src/invariant.ts`) when placed in its documented context:
// - missing runId        → `stringId` fails (`${type} runId must be a non-empty
//   string`, invariant.ts:78)
//
// Positional invariants (duplicate member seq, post-end updates) are the
// upstream consumer's job — the ledger persists what it sees (plan Global
// Constraints; qc2 S-5) — so no fixtures model them; the original
// duplicateSeq/postEnd builders were unused and removed.
// ---------------------------------------------------------------------------

/** `run-start` data with the `runId` field omitted entirely. */
export function runStartMissingRunId(
  init: { name?: string } = {},
): ToolWorkflowRunStartData {
  return { name: init.name ?? DEFAULT_RUN_NAME } as ToolWorkflowRunStartData
}

/** `agent-start` data with the `runId` field omitted entirely. */
export function agentStartMissingRunId(
  init: { seq?: number; label?: string; phase?: string; childId?: string } = {},
): ToolWorkflowAgentStartData {
  return {
    seq: init.seq ?? 1,
    label: init.label ?? DEFAULT_LABEL,
    ...init.phase === undefined ? {} : { phase: init.phase },
    childId: init.childId ?? DEFAULT_CHILD_ID,
  } as ToolWorkflowAgentStartData
}

/** `agent-end` data with the `runId` field omitted entirely. */
export function agentEndMissingRunId(
  init: { seq?: number; outcome?: WorkflowAgentOutcome } = {},
): ToolWorkflowAgentEndData {
  return {
    seq: init.seq ?? 1,
    outcome: init.outcome ?? 'completed',
  } as ToolWorkflowAgentEndData
}

/** `run-end` data with the `runId` field omitted entirely. */
export function runEndMissingRunId(
  init: { stopReason?: WorkflowStopReason } = {},
): ToolWorkflowRunEndData {
  return { stopReason: init.stopReason ?? 'completed' } as ToolWorkflowRunEndData
}
