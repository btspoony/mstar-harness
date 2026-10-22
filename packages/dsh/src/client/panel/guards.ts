/**
 * Field-level degradation guards for the payloads the panel renders (spec §2.4):
 * the client does not exhaustively validate the union — it narrows, then
 * degrades per field. Unknown/missing values render as `unknown`, never as
 * guessed values.
 *
 * This module ALSO carries the one place that validates the picker's untrusted
 * wire answer exhaustively: {@link parseSelectWorkflowResult} turns the
 * `/api/mstar/selectWorkflow` envelope into the panel's explicit state, so a
 * malformed or foreign answer degrades to `unavailable` — never to a
 * half-parsed acknowledgement.
 */

/** String field: non-empty string, else null (missing → `unknown`). */
export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Boolean field: real boolean, else null. */
export function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** Count field: finite number, else null. */
export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Plain-object record (null and arrays are not records), else null. */
export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** One workflow-pick acknowledgement (the `selectWorkflow` wire result). */
export type MstarSelectWorkflowFetch =
  | { readonly status: 'selected'; readonly sessionId: string; readonly workflowId: string }
  | { readonly status: 'unavailable'; readonly reason: string }

/**
 * Validate one `/api/mstar/selectWorkflow` response into the picker's state.
 *
 * The whole envelope is untrusted: the transport result, the endpoint result and
 * the acknowledged identity are all checked. A success MUST name the session AND the workflow this client asked
 * for — a foreign acknowledgement is refused rather than rendered as this
 * session's pick.
 *
 * @param raw - the value returned by `connection.rpc.call` (untrusted).
 * @param sessionId - the session this client ASKED for.
 * @param workflowId - the workflow id this client asked to select.
 * @returns the acknowledged pick, or the explicit unavailable state.
 */
export function parseSelectWorkflowResult(
  raw: unknown,
  sessionId: string,
  workflowId: string,
): MstarSelectWorkflowFetch {
  const envelope = record(raw)
  if (envelope === null) return { status: 'unavailable', reason: 'malformed-response' }
  if (envelope.ok !== true) {
    const error = record(envelope.error)
    const code = str(error?.code)
    return { status: 'unavailable', reason: code === null ? 'transport-error' : `transport-error:${code}` }
  }
  const value = record(envelope.value)
  if (value === null) return { status: 'unavailable', reason: 'malformed-response' }
  if (value.status === 'unavailable') {
    return { status: 'unavailable', reason: str(value.reason) ?? 'unavailable' }
  }
  if (value.status !== 'selected') return { status: 'unavailable', reason: 'malformed-response' }
  const acknowledgedSession = str(value.sessionId)
  const acknowledgedWorkflow = str(value.workflowId)
  if (acknowledgedSession !== sessionId) return { status: 'unavailable', reason: 'session-mismatch' }
  if (acknowledgedWorkflow !== workflowId) return { status: 'unavailable', reason: 'workflow-mismatch' }
  return { status: 'selected', sessionId, workflowId }
}
