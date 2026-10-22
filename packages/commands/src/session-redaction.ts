/**
 * Session-id redaction for a public authority read.
 *
 * On an opted-in MCP connection a caller-declared `sessionId` selects that
 * session's own coordinator binding, so a live id is a bearer credential for
 * coordinator-scoped writes. `status validate` needs no identity to run, so any
 * id it echoes turns one unauthenticated read into a working identity.
 *
 * Redacting one key is not enough: the same logical value travels under several
 * names in the same payload — `sessionId` on a coordinator ref, `prepared_by`
 * on a plan's coordination block, `session_id` / `prior_session_id` /
 * `stopped_session_ids[]` on an identity recovery, `actor_session_id` on a
 * terminal adoption, and `holder` on an integration merge lease (the engine
 * compares it with the bound session id, so it IS that coordinator's id). This
 * walks the whole payload and rewrites every one of them, keeping the
 * surrounding facts (role, epoch, revision, actor name) so the read stays
 * useful.
 */
export const REDACTED_SESSION_ID = "[redacted]";

/** Field names that carry one session id. */
const SESSION_ID_FIELDS = new Set([
  "sessionId",
  "session_id",
  "prepared_by",
  "completed_by",
  "actor_session_id",
  "prior_session_id",
  // `IntegrationMergeLease.holder` is compared with the bound session id
  // (`execution-coordination.ts`), so it is that coordinator's id, not a name.
  "holder",
]);

/** Field names that carry a list of session ids. */
const SESSION_ID_ARRAY_FIELDS = new Set(["stopped_session_ids"]);

/** Rewrite every session-id field in `value`, leaving the rest of the shape intact. */
export function redactSessionIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSessionIds);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (SESSION_ID_FIELDS.has(key) && typeof entry === "string" && entry.trim() !== "") {
      out[key] = REDACTED_SESSION_ID;
      continue;
    }
    if (SESSION_ID_ARRAY_FIELDS.has(key) && Array.isArray(entry)) {
      out[key] = entry.map(() => REDACTED_SESSION_ID);
      continue;
    }
    out[key] = redactSessionIds(entry);
  }
  return out;
}
