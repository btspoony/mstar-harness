/**
 * The durable execution binding's clear internals (#530).
 *
 * The slash command that used to host the clear arm is removed (#530), and so
 * is the native command surface that replaced it: the `mstar_execution_clear`
 * tool is the one dsh-native tool left, and it wraps
 * {@link clearExecutionSessionBinding} — the readable-record guard, the
 * nothing-to-clear guard, and the slash clear's `selectedGeneration` read, kept
 * together here so the native clear validates exactly what the slash clear
 * validated.
 */
import { clearExecutionBinding, readExecutionWorkflowSource } from './workflow-selection.ts'
import { readWorkflowSessionBinding } from '../engine-status-store.ts'

/**
 * One clear attempt's terminal answer: `cleared` (the durable slot no longer
 * carries an execution binding), `no-binding` (nothing to clear — the session
 * holds no adopted execution binding), or `refused` with the store's own
 * reason (an unreadable/cwd-mismatched record or a refused write is never
 * reported as a clear).
 */
export type ExecutionClearOutcome =
  | { kind: 'cleared' }
  | { kind: 'no-binding' }
  | { kind: 'refused'; reason: string }

/**
 * Clear the calling session's own durable execution binding — the validation
 * and adoption internals the native `mstar_execution_clear` tool imports,
 * replacing the removed slash command's `clear` arm. The order replicates the
 * slash clear, with one explicit no-op guard the tool turns into its named
 * refusal:
 *
 * 1. the durable record must be READABLE for this exact `(sessionId, cwd)` —
 *    an unreadable or cwd-mismatched record is a refusal, never a blind write
 *    against an untrusted slot;
 * 2. a record WITHOUT a durable `executionBinding` has nothing to clear —
 *    reported instead of writing an empty row;
 * 3. the active-set source read supplies the optional `selectedGeneration`
 *    (the observed store id + epoch) exactly as the slash arm computed it —
 *    absent when the source read is unavailable — so the durable-selection
 *    rung validates the clear against the generation this call observed.
 *
 * `clearExecutionBinding` itself preserves the user selection and merges the
 * exclusion floor by max; a refused write comes back as `refused` with the
 * store's reason.
 */
export async function clearExecutionSessionBinding(
  harnessDir: string,
  sessionId: string,
  cwd: string,
): Promise<ExecutionClearOutcome> {
  const read = readWorkflowSessionBinding(harnessDir, sessionId, cwd)
  if (read.kind !== 'ok') return { kind: 'refused', reason: read.reason }
  if (read.binding === undefined || read.binding.executionBinding === null) return { kind: 'no-binding' }
  const source = await readExecutionWorkflowSource({ harnessDir }, { sessionId, cwd })
  const cleared = clearExecutionBinding(
    harnessDir,
    sessionId,
    cwd,
    source.kind === 'unavailable' || source.storeId === undefined || source.epoch === undefined
      ? undefined
      : { storeId: source.storeId, epoch: source.epoch },
  )
  return cleared ? { kind: 'cleared' } : { kind: 'refused', reason: 'the durable binding write refused the clear' }
}
