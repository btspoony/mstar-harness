/**
 * The ONE session → workspace resolution the two `mstar` wire services share
 * (`engine-status-endpoint.ts` and `panel/panel-snapshot-endpoint.ts`).
 *
 * Both services answer a client that asserts `(sessionId, cwd)`, and neither
 * may trust the claim as an address: the workspace is resolved SERVER-side from
 * the host's own session surfaces, and the claim is only compared against it.
 * Keeping the resolution here means the two services cannot start disagreeing
 * about which surface wins, or about what an unusable session is called.
 *
 * `source` records WHICH surface answered: `live` (`Session.header.cwd`),
 * `persisted` (`SessionInspection.meta.cwd`) or `boot` (neither declared a
 * workspace, so the plugin reads the workspace the host was launched in — a
 * fact about the plugin's own launch, never the caller's claim).
 *
 * Module boundary: no barrel — the two endpoint modules import by explicit
 * relative path.
 */

import { isAbsolute } from 'node:path'

/** A non-empty string, or undefined. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The `SessionHeader` of either session surface, or undefined.
 *
 * The two surfaces carry it under DIFFERENT keys, read from the host's own types:
 * a live `Session` exposes `header: SessionHeader`
 * (`@deepseek-ai/dsh-session` `Session.header`), while a persisted inspection
 * exposes `meta: SessionHeader` (`@deepseek-ai/dsh-session-persistence`
 * `SessionInspection extends SessionStorageMetadata { meta: SessionHeader }`).
 * Reading only `header` made every cold session answer `session-cwd-absent`
 * while its workspace was right there.
 */
export function sessionHeaderOf(value: unknown): { cwd?: unknown } | undefined {
  const row = value as { header?: unknown; meta?: unknown } | null | undefined
  const header = row?.header ?? row?.meta
  return header !== null && typeof header === 'object' ? (header as { cwd?: unknown }) : undefined
}

/** The session's workspace directory from either surface (`header.cwd` / `meta.cwd`). */
export function headerCwdOf(value: unknown): string | undefined {
  return nonEmptyString(sessionHeaderOf(value)?.cwd)
}

/**
 * Refuse a client-asserted path that is not a plain absolute path: a relative
 * path would be resolved against the host process cwd (never the caller's), and
 * a `..` segment or NUL byte is a traversal probe, not a workspace.
 */
export function isRefusedPath(cwd: string): boolean {
  if (cwd.includes('\0')) return true
  if (!isAbsolute(cwd)) return true
  return cwd.split(/[\\/]+/).includes('..')
}

/** The resolved session cwd, or the explicit reason the session is unusable. */
export type SessionCwdResolution =
  | { readonly kind: 'ok'; readonly cwd: string; readonly source: 'live' | 'persisted' | 'boot' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** The live session and its persisted-inspection readers, as the host exposes them. */
export interface SessionCwdReaders {
  /** `ctx.sessions.get(id)` — the live session, when the service is mounted. */
  readonly liveSession: (sessionId: string) => unknown
  /** `ctx.sessionController.inspect(id)` — the persisted (cold) read, or undefined when unmounted. */
  readonly inspect: ((sessionId: string) => Promise<unknown>) | undefined
  /** The workspace the host was launched in (`process.cwd()`). */
  readonly bootCwd: () => string | undefined
}

/**
 * Resolve the workspace of one session, in order: the LIVE session's header,
 * then the persisted inspection for a session that is not attached, then — only
 * when BOTH surfaces are genuinely silent — the workspace this host was launched
 * in. Every unusable state keeps its own explicit reason; a shared reason would
 * make the two services' clients decode one word for two different facts.
 */
export async function resolveSessionCwdOf(readers: SessionCwdReaders, sessionId: string): Promise<SessionCwdResolution> {
  const live = readers.liveSession(sessionId)
  const liveCwd = headerCwdOf(live)
  if (liveCwd !== undefined) return { kind: 'ok', cwd: liveCwd, source: 'live' }

  const inspect = readers.inspect
  if (inspect === undefined) {
    return { kind: 'unavailable', reason: live === undefined ? 'session-absent' : 'session-cwd-absent' }
  }
  let inspection: unknown
  try {
    inspection = await inspect(sessionId)
  } catch {
    return { kind: 'unavailable', reason: 'session-inspect-failed' }
  }
  const persistedCwd = headerCwdOf(inspection)
  if (persistedCwd !== undefined) return { kind: 'ok', cwd: persistedCwd, source: 'persisted' }
  // Both surfaces silent: read the workspace the host was launched in. It is
  // not a guess about the session — it is the only workspace the plugin can
  // observe without a new host API, and the claim is compared, never adopted.
  const boot = nonEmptyString(readers.bootCwd())
  if (boot !== undefined) return { kind: 'ok', cwd: boot, source: 'boot' }
  return { kind: 'unavailable', reason: 'session-cwd-absent' }
}
