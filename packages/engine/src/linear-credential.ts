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
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * `credential.json.lock` — the only file that orders a refresh's commit against
 * a sign-out. Its mere existence is the mutex: `open(..., "wx")` is an atomic
 * create-or-fail across processes.
 */
export function linearCredentialLockPath(): string {
  return `${linearCredentialPath()}.lock`;
}

/**
 * A lock older than this is presumed to belong to a process that died while
 * holding it. Taking it over is the only alternative to blocking every later
 * write forever.
 */
const LOCK_STALE_MS = 5_000;
const LOCK_POLL_MS = 10;

/** Synchronous sleep: the writers here are synchronous by contract. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` as ONE cross-process critical section over the credential file.
 *
 * Reached by every writer and by the delete, so a check-then-commit inside it
 * cannot be interleaved by `mstar linear logout` in another process. Not
 * re-entrant on purpose: a nested call would recreate the very window this
 * closes, so the internal writes below are lock-free helpers.
 *
 * A holder that dies leaves the file behind; past `LOCK_STALE_MS` the lock is
 * taken over rather than waited on forever. Two waiters can both take over a
 * stale lock in the same instant, which is why the age has to be far longer
 * than any live holder's critical section (a read and a rename).
 *
 * shortcut: takeover races a holder stalled past LOCK_STALE_MS; upgrade if the
 * critical section ever does I/O or a network call.
 */
export function withLinearCredentialLock<T>(fn: () => T): T {
  const lock = linearCredentialLockPath();
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (ageOf(lock) > LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Milliseconds since the lock appeared; Infinity when it vanished under us. */
function ageOf(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Write the credential atomically with restrictive permissions. A failure here
 * leaves the previous file untouched: a half-written credential is worse than a
 * stale one, because the stale one can still refresh itself.
 */
function writeUnlocked(credential: LinearCredential): string {
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

export function writeLinearCredential(credential: LinearCredential): string {
  return withLinearCredentialLock(() => writeUnlocked(credential));
}

/**
 * Decide and commit as one critical section, so a sign-out that lands during a
 * refresh is never overwritten. `decide` sees the file as it is INSIDE the
 * lock: either the delete already happened (state is `absent`, decline) or the
 * rename happens first and the delete then removes it — both end absent.
 *
 * Returns the written path, or `null` when `decide` declined.
 */
export function commitLinearCredential(
  decide: (state: LinearCredentialState) => LinearCredential | null,
  now: number = Date.now(),
): string | null {
  return withLinearCredentialLock(() => {
    const next = decide(readLinearCredential(now));
    return next === null ? null : writeUnlocked(next);
  });
}

/** Remove the stored credential (sign-out). Returns whether anything was there. */
export function clearLinearCredential(): boolean {
  return withLinearCredentialLock(() => {
    const path = linearCredentialPath();
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  });
}
