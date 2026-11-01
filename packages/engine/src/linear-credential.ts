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
  renameSync(temporary, path);
  return path;
}

/** Remove the stored credential (sign-out). Returns whether anything was there. */
export function clearLinearCredential(): boolean {
  const path = linearCredentialPath();
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
