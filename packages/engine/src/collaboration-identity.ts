/**
 * collaboration-identity.ts -- canonical repository identity and the explicit
 * collaboration mode behind user-level collaboration storage.
 *
 * Identity is the origin repository, never a checkout path, Git author,
 * per-store UUID or current branch. The configured Git main checkout supplies
 * the origin and `.mstarc`, so a linked worktree cannot answer as its own
 * repository. Resolution is side-effect free: it opens no database and creates
 * no directory.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { exitStatusOf, gitProbeTimeoutMs, mainWorktreeRoot } from "./git-probe.js";
import { COLLABORATION_SECTION, MSTARC_FILE, parseMstarc } from "./mstarc.js";
import type { StoreContext } from "./store-db.js";

export type CollaborationMode = "local" | "mirror";

export type CollaborationLocation = Readonly<{
  /** Canonical logical identity (`host[/owner...]/repo` or `id:<repo_id>`). */
  repoKey: string;
  mode: CollaborationMode;
  /** Canonical user-level database path; never created by resolution. */
  dbPath: string;
}>;

export type CollaborationIdentityCode =
  | "collaboration.repo-identity-unresolved"
  | "collaboration.config-unreadable"
  | "collaboration.mode-required"
  | "collaboration.mode-invalid"
  | "collaboration.mode-unavailable";

/** Named refusal: a stable code plus the exact supported recovery. */
export class CollaborationIdentityError extends Error {
  readonly code: CollaborationIdentityCode;

  constructor(code: CollaborationIdentityCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CollaborationIdentityError";
    this.code = code;
  }
}

/** Safe origin path segment: no separators, encoding, quotes or dot segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/;
/** Explicit origin-less id: `[a-z0-9][a-z0-9._-]{0,127}`. */
const SAFE_REPO_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DEFAULT_PORT: Record<string, string> = { "https:": "443", "http:": "80", "ssh:": "22" };
/** DNS host: dot-separated non-empty labels; `~` stays reserved for `host~port`. */
const SAFE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

function unresolved(cause: string): never {
  throw new CollaborationIdentityError(
    "collaboration.repo-identity-unresolved",
    `${cause}. Correct the origin or the Git probe, or add a valid [${COLLABORATION_SECTION}] repo_id to ${MSTARC_FILE} for a genuinely origin-less repository, then re-run`,
  );
}

/** Refuse literal and percent-encoded dot segments in a raw origin path. */
function assertNoDotSegments(rawPath: string): void {
  for (const segment of rawPath.split("/")) {
    if (segment === "") continue;
    // why: WHATWG URL decodes `%2e` and drops dot segments before callers see
    // the path, so only the raw spelling can be judged.
    const decoded = segment.replace(/%2e/gi, ".");
    if (decoded === "." || decoded === "..") unresolved("The origin path contains a dot segment");
  }
}

/** Lowercase DNS host without its terminal dot; refusal when it is not a safe one. */
function canonicalHost(raw: string): string {
  const host = raw.replace(/\.$/, "").toLowerCase();
  if (host === "") unresolved("The origin names no host");
  if (host.includes("~")) unresolved("The origin host uses the reserved '~' port delimiter");
  if (!SAFE_HOST.test(host)) unresolved("The origin host is not a safe DNS name");
  return host;
}

/** Split an origin into host (with `~port` for nondefault ports) and path. */
function splitOrigin(raw: string): { host: string; path: string } {
  const value = raw.trim();
  if (value === "") unresolved("The origin remote is empty");
  // why: WHATWG strips or rewrites these before a parsed URL can expose them,
  // so an invalid origin must be judged in its raw spelling.
  if (/[\u0000-\u001f\u007f]/.test(value)) unresolved("The origin contains an ASCII control character");
  // why: WHATWG URL treats a backslash as a path separator for http(s), so a
  // raw backslash can hide `..` from the slash-only raw-path check below.
  if (value.includes("\\")) unresolved("The origin contains a backslash path separator");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme !== null) {
    const protocol = `${scheme[1]!.toLowerCase()}:`;
    if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") {
      unresolved(`The origin transport ${protocol} is not a portable Git remote`);
    }
    // why: `URL.search`/`.hash` are empty for a bare `?` or `#`, so the raw
    // delimiter is the only place that spelling can be refused.
    if (value.includes("?") || value.includes("#")) unresolved("The origin carries a query or fragment");
    // why: WHATWG URL already dropped literal and `%2e` dot segments from
    // `parsed.pathname`, so the raw spelling is the only place to judge them.
    const rawPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(value)?.[1] ?? "";
    assertNoDotSegments(rawPath);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      unresolved("The origin is not a well-formed URL");
    }
    // why: userinfo is dropped by never reading username/password.
    const hostname = canonicalHost(parsed.hostname);
    const port = parsed.port;
    const host = port === "" || port === DEFAULT_PORT[protocol] ? hostname : `${hostname}~${port}`;
    return { host, path: parsed.pathname };
  }
  // SCP SSH spelling: `[user@]host:path`; anything else is not portable.
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp === null) unresolved("The origin is not a portable https, http, ssh or SCP SSH remote");
  return { host: canonicalHost(scp[1]!), path: scp[2]! };
}

/** Owner path below the host, with one terminal `.git` and slashes removed. */
function originPathSegments(path: string, host: string): string[] {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) unresolved("The origin names no repository path");
  const last = segments[segments.length - 1]!;
  if (last.endsWith(".git")) segments[segments.length - 1] = last.slice(0, -".git".length);
  if (segments[segments.length - 1] === "") unresolved("The origin names no repository");
  if (segments.length < 2) unresolved("The origin does not name both an owner and a repository");
  for (const segment of segments) {
    if (segment === "." || segment === "..") unresolved("The origin path contains a dot segment");
    if (!SAFE_SEGMENT.test(segment)) unresolved("The origin path contains an unsafe segment");
  }
  // why: GitHub addresses owners and repositories case-insensitively; other
  // hosts keep case until their behavior is explicitly known.
  return host === "github.com" ? segments.map((segment) => segment.toLowerCase()) : segments;
}

/**
 * The single `origin` URL, `null` when the remote is unconfigured, refusal when
 * Git cannot answer or several fetch origins disagree.
 */
function readOrigin(mainRoot: string): string | null {
  let out: string;
  try {
    out = execFileSync("git", ["-C", mainRoot, "config", "--get-all", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: gitProbeTimeoutMs(),
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch (error) {
    // why: exit 1 is Git's "key unset"; every other failure is unreadable Git,
    // which must never masquerade as an origin-less checkout.
    if (exitStatusOf(error) === 1) return null;
    unresolved("Git could not be read to determine the origin remote");
  }
  // why: Git terminates every value with a newline, so only the trailing
  // artifact is dropped; interior empty lines are configured empty values.
  const lines = out.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const values = lines.map((line) => line.trim());
  if (values.length === 0) unresolved("The origin remote is configured with no URL value");
  if (values.includes("")) unresolved("The origin remote is configured with an empty URL value");
  if (new Set(values).size > 1) unresolved("The origin remote has ambiguous multiple fetch origins");
  return values[0]!;
}

function readConfig(mainRoot: string): { mode?: string; repoId?: string } {
  const file = join(resolve(mainRoot), MSTARC_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code;
    // why: only a genuinely absent file means "no configuration"; every other
    // failure would otherwise be reported as a missing mode the operator
    // cannot fix by adding one.
    if (reason === "ENOENT") return {};
    const cause =
      reason === "EISDIR"
        ? "it is a directory"
        : reason === "ENOTDIR"
          ? "a parent path component is not a directory"
          : reason === "EACCES" || reason === "EPERM"
            ? "it is not readable by this process"
            : `it could not be read (${reason ?? "unknown error"})`;
    throw new CollaborationIdentityError(
      "collaboration.config-unreadable",
      `${file} cannot be read because ${cause}; make it a readable regular file or remove it, then re-run`,
    );
  }
  return parseMstarc(text).collaboration ?? {};
}

function resolveMode(raw: string | undefined): CollaborationMode {
  if (raw === undefined || raw === "") {
    throw new CollaborationIdentityError(
      "collaboration.mode-required",
      (raw === ""
        ? `An empty [${COLLABORATION_SECTION}] mode is configured in ${MSTARC_FILE}; `
        : `No [${COLLABORATION_SECTION}] mode is configured in ${MSTARC_FILE}; `) +
        "add 'mode=local' or 'mode=mirror' and re-run",
    );
  }
  if (raw === "local" || raw === "mirror") return raw;
  if (raw === "remote") {
    throw new CollaborationIdentityError(
      "collaboration.mode-unavailable",
      "'remote' collaboration is not implemented in this build; use 'mode=local' or 'mode=mirror'",
    );
  }
  throw new CollaborationIdentityError(
    "collaboration.mode-invalid",
    `The [${COLLABORATION_SECTION}] mode setting in ${MSTARC_FILE} is not supported; use 'mode=local' or 'mode=mirror' and re-run`,
  );
}

/** Canonical key plus its filesystem directory segments. */
function canonicalIdentity(mainRoot: string, repoId: string | undefined): { repoKey: string; dirs: string[] } {
  const origin = readOrigin(mainRoot);
  if (origin === null) {
    if (repoId === undefined) {
      unresolved("This repository has no origin remote and no explicit [collaboration] repo_id");
    }
    if (!SAFE_REPO_ID.test(repoId)) {
      unresolved("The [collaboration] repo_id is not a safe lower-case identifier");
    }
    return { repoKey: `id:${repoId}`, dirs: ["_id", repoId] };
  }
  const { host, path } = splitOrigin(origin);
  const segments = originPathSegments(path, host);
  return { repoKey: [host, ...segments].join("/"), dirs: [host, ...segments] };
}

/**
 * Basenames reserved for the authority database and its SQLite sidecars. A
 * repository segment that spells one must not become a directory with that
 * name, or one identity's database file would occupy another's storage dir.
 */
const RESERVED_AUTHORITY_BASENAMES: Readonly<Record<string, true>> = {
  "collaboration.db": true,
  "collaboration.db-wal": true,
  "collaboration.db-shm": true,
  "collaboration.db-journal": true,
};

/**
 * Filesystem spelling of one directory segment: percent-encode uppercase ASCII
 * so case-insensitive filesystems keep case-sensitive repositories apart, and
 * percent-encode the head of a reserved basename so it cannot occupy the
 * authority filename namespace. `repoKey` keeps the canonical spelling.
 */
function encodeSegment(segment: string): string {
  // why: `%` cannot appear in an accepted segment, so any encoded spelling is
  // disjoint from every other segment's filesystem name.
  const escaped = RESERVED_AUTHORITY_BASENAMES[segment.toLowerCase()] === true
    ? `%${segment.charCodeAt(0).toString(16).toUpperCase()}${segment.slice(1)}`
    : segment;
  return escaped.replace(/[A-Z]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Canonical collaboration identity, explicit mode and user-level database path
 * for this control harness. Throws `CollaborationIdentityError` on an
 * unresolved identity or mode.
 */
export function resolveCollaborationLocation(
  context: StoreContext,
  options: { userHome?: string } = {},
): CollaborationLocation {
  const mainRoot = mainWorktreeRoot(context.checkoutRoot ?? context.harnessDir);
  if (mainRoot === null) unresolved("Git could not name the main checkout that owns this harness");
  const config = readConfig(mainRoot);
  const identity = canonicalIdentity(mainRoot, config.repoId);
  const mode = resolveMode(config.mode);
  const home = options.userHome ?? homedir();
  return {
    repoKey: identity.repoKey,
    mode,
    dbPath: join(home, ".mstar", "repos", ...identity.dirs.map(encodeSegment), "collaboration.db"),
  };
}
