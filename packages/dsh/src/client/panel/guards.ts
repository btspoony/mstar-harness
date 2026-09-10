/**
 * Field-level degradation guards for the runtime `mstar-engine-status` payload
 * (spec §2.4): the client does not exhaustively validate the union — it
 * narrows, then degrades per field. Unknown/missing values render as
 * `unknown`, never as guessed values.
 *
 * This module ALSO carries the one place that validates untrusted input
 * exhaustively: {@link parseEngineStatusResult}, which turns the
 * `/api/mstar/engineStatus` wire envelope into the panel's explicit state. The
 * payload is a remote answer the panel never authored, so a malformed
 * envelope degrades to `unavailable` — never to a half-parsed view.
 */

import type { MstarEngineStatusPayload } from '../../types.ts'

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

/**
 * The engine-status state the panel renders from: either the host's stored
 * snapshot emission, or the explicit reason the snapshot is unavailable.
 * There is deliberately no third "empty" shape — a degraded read is ALWAYS an
 * `unavailable` carrying a reason, never a silently-empty payload.
 */
export type MstarEngineStatusFetch =
  | {
    readonly status: 'ok'
    /** The exact catalog payload the host stored for this session. */
    readonly payload: MstarEngineStatusPayload
    /** ISO timestamp of the served snapshot — the panel's freshness marker. */
    readonly at: string
    /** The agent turn the row was emitted for. */
    readonly turn: number
  }
  | { readonly status: 'unavailable'; readonly reason: string }

/** The explicit degraded state (one constructor — one shape everywhere). */
function unavailable(reason: string): MstarEngineStatusFetch {
  return { status: 'unavailable', reason }
}

/**
 * Validate one `/api/mstar/engineStatus` response into the panel's state.
 *
 * The whole envelope is untrusted: the transport result (`{ok, value}` /
 * `{ok: false, error}`), the endpoint result (`status` + its fields) and the
 * payload object. Every branch that cannot be read in full answers the
 * explicit `unavailable` state with a machine-readable reason; the host's own
 * `unavailable` reason is surfaced verbatim.
 *
 * @param raw - the value returned by `connection.rpc.call` (untrusted).
 * @param sessionId - the session this client ASKED for; a response naming any
 *   other session is refused (`session-mismatch`) — one session's request can
 *   never render another session's data.
 * @returns the validated snapshot state, or the explicit unavailable state.
 */
export function parseEngineStatusResult(raw: unknown, sessionId: string): MstarEngineStatusFetch {
  const envelope = record(raw)
  if (envelope === null) return unavailable('malformed-response')

  if (envelope.ok !== true) {
    const error = record(envelope.error)
    const code = str(error?.code)
    return unavailable(code === null ? 'transport-error' : `transport-error:${code}`)
  }

  const value = record(envelope.value)
  if (value === null) return unavailable('malformed-response')

  if (value.status === 'unavailable') return unavailable(str(value.reason) ?? 'unavailable')
  if (value.status !== 'ok') return unavailable('malformed-response')

  // The answer must name the session that was asked for — a foreign id is
  // refused rather than rendered under this session's panel.
  if (value.sessionId !== sessionId) return unavailable('session-mismatch')

  const at = str(value.at)
  if (at === null) return unavailable('malformed-snapshot')
  const turn = count(value.turn)
  if (turn === null) return unavailable('malformed-snapshot')

  const payload = record(value.payload)
  if (payload === null) return unavailable('malformed-payload')

  // The payload itself is handed over as read: its members degrade per field
  // at render time (`str`/`bool`/`count`/`Array.isArray`), so a payload
  // missing a member renders `unknown` for that member — the established
  // field-level degradation contract (spec §2.4).
  return { status: 'ok', payload: payload as unknown as MstarEngineStatusPayload, at, turn }
}
