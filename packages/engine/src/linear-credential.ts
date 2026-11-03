/**
 * The Linear credential this machine holds.
 *
 * Stored OUTSIDE any repository — a token is host state, not project state — and
 * read by the provider so a session does not re-authorize every time. The file
 * is `0600`, the directory `0700`: the access token is a bearer credential for
 * the whole workspace.
 *
 * The shape mirrors what the authorization server returns: `access_token`,
 * `refresh_token`, and the instant the access token stops being usable. Nothing
 * here decides *whether* a credential is good enough for a call; it only reports
 * what is on disk and whether a refresh is due, so the caller can act instead of
 * discovering a 401 mid-import.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LinearCredential = {
  accessToken: string;
  refreshToken: string | null;
  /**
   * The dynamically registered client this credential belongs to. A refresh
   * exchange must present it, and it is not derivable from the token, so losing
   * it made a stored refresh token unusable.
   */
  clientId: string | null;
  /** Epoch milliseconds. */
  expiresAt: number | null;
  scope: string | null;
};

export type LinearCredentialState =
  | { kind: "absent" }
  | { kind: "unreadable"; path: string; reason: string }
  | { kind: "present"; path: string; credential: LinearCredential; refreshDue: boolean };

/** How long before expiry a credential is treated as due for refresh. */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * `$XDG_CONFIG_HOME/mstar/linear/credential.json`, else `~/.config/...`.
 * `MSTAR_LINEAR_CREDENTIAL` overrides the whole path (tests, unusual hosts).
 */
export function linearCredentialPath(): string {
  const explicit = process.env.MSTAR_LINEAR_CREDENTIAL;
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "mstar", "linear", "credential.json");
}

function parse(raw: string): LinearCredential | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken.trim() === "") return null;
  const refreshToken = typeof record.refresh_token === "string" && record.refresh_token.trim() !== "" ? record.refresh_token : null;
  const expiresAt = typeof record.expires_at === "number" && Number.isFinite(record.expires_at) ? record.expires_at : null;
  const scope = typeof record.scope === "string" ? record.scope : null;
  const clientId = typeof record.client_id === "string" && record.client_id !== "" ? record.client_id : null;
  return { accessToken, refreshToken, expiresAt, scope, clientId };
}

/** What is on disk right now, and whether a refresh is due. Never throws. */
export function readLinearCredential(now: number = Date.now()): LinearCredentialState {
  const path = linearCredentialPath();
  if (!existsSync(path)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { kind: "unreadable", path, reason: error instanceof Error ? error.message : String(error) };
  }
  const credential = parse(raw);
  if (credential === null) {
    return { kind: "unreadable", path, reason: "the file does not hold an access_token; re-authorize to replace it" };
  }
  const refreshDue = credential.expiresAt !== null && now >= credential.expiresAt - REFRESH_WINDOW_MS;
  return { kind: "present", path, credential, refreshDue };
}

/**
 * Write the credential atomically with restrictive permissions. A failure here
 * leaves the previous file untouched: a half-written credential is worse than a
 * stale one, because the stale one can still refresh itself.
 */
export function writeLinearCredential(credential: LinearCredential): string {
  const path = linearCredentialPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = {
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    client_id: credential.clientId,
    expires_at: credential.expiresAt,
    scope: credential.scope,
  };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  try {
    renameSync(temporary, path);
  } catch (error) {
    // The temp file is a complete, valid second copy of the token, and
    // `clearLinearCredential` only knows `path`: leaving it behind would survive
    // sign-out. Cleanup must not mask the rename's own cause.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The copy stays; the rename failure below is still the reported cause.
    }
    throw error;
  }
  return path;
}

/**
 * Whether the file changed under an in-flight refresh in a way that attempt
 * must not overwrite — another process stored a newer grant to adopt, or the
 * operator removed the credential (`mstar linear logout`) and deleting it is
 * the newest intent. An unreadable file is overwritten: its credential is
 * unusable, and the fresh grant is the recovery.
 *
 * One implementation for every writer: the dsh refresh loop and the CLI's
 * `resolveStoredToken` both decide inside {@link commitLinearCredential}, and a
 * second copy of this rule is how a re-auth landed by `mstar linear auth` gets
 * replaced by an older lineage's refreshed token (including its narrower scope).
 *
 * `base` is the credential the attempt started from, read before its round trip.
 */
export function supersededBy(state: LinearCredentialState, base: LinearCredential): boolean {
  if (state.kind === "absent") return true;
  if (state.kind !== "present") return false;
  const candidate = state.credential;
  if (candidate.accessToken === base.accessToken) return false;
  if (candidate.clientId !== base.clientId) return true;
  return candidate.expiresAt !== null && (base.expiresAt === null || candidate.expiresAt > base.expiresAt);
}

/**
 * Check the file, then commit what `decide` returned. `decide` sees the file as
 * it is at this instant, so a sign-out or a re-authorization that landed during
 * the refresh's round trip — the long, network-width window — is seen and the
 * stale grant is declined.
 *
 * Accepted limitation, not a bug to rediscover: this check and the rename below
 * are two statements, so a `logout` or reauthorization landing inside that
 * microsecond window, after `decide` read the file and before the rename, can
 * be overwritten by the refresh it raced. The consequence is a stale grant that
 * the operator clears by signing out again. A hand-rolled cross-process lock
 * closed that window and was removed because each attempt to make it safe
 * widened it (three-writer races, a dangling-symlink spin, probabilistic
 * regressions) — a larger hazard than the window it removed.
 *
 * `decide` must only read: it has no side effects, so a write there cannot
 * interleave with the rename this function performs.
 *
 * Returns the written path, or `null` when `decide` declined.
 */
export function commitLinearCredential(
  decide: (state: LinearCredentialState) => LinearCredential | null,
  now: number = Date.now(),
): string | null {
  const next = decide(readLinearCredential(now));
  return next === null ? null : writeLinearCredential(next);
}

/** Remove the stored credential (sign-out). Returns whether anything was there. */
export function clearLinearCredential(): boolean {
  const path = linearCredentialPath();
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
