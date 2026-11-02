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
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
/**
 * A stale lock whose stamp names a LIVE process is normally left alone: a
 * holder stopped past `LOCK_STALE_MS` (SIGSTOP, a debugger, laptop sleep) is
 * still inside the critical section, and taking its lock would admit a second
 * writer. Past this much longer bound the pid is either wedged or recycled, so
 * the lock is taken over instead of blocking every writer forever.
 */
const LOCK_WEDGED_MS = 60_000;
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
 * The lock is OWNED: it carries `{pid, token}` from the instant it is created,
 * so the file on disk says whose acquisition it is. That identity is what makes
 * recovery safe — a waiter may remove only the stale lock it actually observed,
 * and a holder may remove only its own. Without it, a takeover deletes by path,
 * which can strip a lock another process just created and let two writers into
 * the "one" critical section.
 *
 * A holder that dies leaves the file behind; past `LOCK_STALE_MS` the lock is
 * taken over rather than waited on forever — but only when the process named in
 * the stamp is gone (or has been wedged past `LOCK_WEDGED_MS`). The age alone
 * must never be the takeover test: a live holder merely stalled past the bound
 * is still inside the critical section.
 *
 * shortcut: takeover is not atomic with the stale check, so two waiters can
 * both decide to remove. The compare-and-delete keeps that harmless — only the
 * first removal matches the observed stamp, and the loser re-reads and loses its
 * own `wx` create to the winner. Upgrade if the lock ever guards I/O or a
 * network call.
 */
export function withLinearCredentialLock<T>(fn: () => T): T {
  const lock = linearCredentialLockPath();
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  // One write, one stamp: `wx` is create-or-fail, so the lock is never visible
  // unstamped, and the token is unique to this acquisition.
  const stamp = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (;;) {
    try {
      writeFileSync(lock, stamp, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!takeOverIfStale(lock)) sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    releaseOwnLock(lock, stamp);
  }
}

/** The lock's current content, or `null` when it is not there to read. */
function readLock(lock: string): string | null {
  try {
    return readFileSync(lock, "utf8");
  } catch {
    return null;
  }
}

/**
 * Remove the lock only if it is still the stale one this waiter observed.
 * Returns whether something was removed, so the caller can retry its own
 * acquisition immediately instead of sleeping out the poll interval.
 *
 * Compare-and-delete, never delete-by-path: the stamp is unique per
 * acquisition, so equal content means the same lock instance. A lock that
 * replaced the stale one in the meantime carries a different stamp and is left
 * to its holder.
 *
 * A lock whose stamp names a LIVE process is never taken over. That is the
 * stalled-holder half of the cascade: a holder stopped past the bound (SIGSTOP,
 * a debugger, laptop sleep) is still inside the critical section, so removing
 * its lock would put two writers there at once. A dead or unreadable stamp —
 * a crashed holder, or a lock written by an older build — stays recoverable, so
 * the mutex is never left behind for good.
 */
function takeOverIfStale(lock: string): boolean {
  const observed = readLock(lock);
  if (observed === null) return true;
  const age = ageOf(lock);
  if (age <= LOCK_STALE_MS) return false;
  // A live holder is only displaced once its lock is far past the stale bound:
  // by then the pid is either wedged or recycled, and refusing forever would be
  // the permanent block this takeover exists to prevent.
  if (age <= LOCK_WEDGED_MS && stampHolderIsLive(observed)) return false;
  if (readLock(lock) !== observed) return false;
  rmSync(lock, { force: true });
  return true;
}

/** Whether the pid inside a stamp is a process this machine still has. */
function stampHolderIsLive(stamp: string): boolean {
  let pid: number;
  try {
    const parsed: unknown = JSON.parse(stamp);
    if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) return false;
    const value = parsed.pid;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return false;
    pid = value;
  } catch {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user. Any other code
    // (ESRCH) means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove the lock this process created, and nothing else. A waiter that judged
 * this acquisition expired has already replaced it; stripping that replacement
 * is how one stalled holder used to admit a third writer.
 */
function releaseOwnLock(lock: string, stamp: string): void {
  if (readLock(lock) === stamp) rmSync(lock, { force: true });
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
