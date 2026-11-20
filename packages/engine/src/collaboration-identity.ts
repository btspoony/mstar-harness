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

function unresolved(cause: string): never {
  throw new CollaborationIdentityError(
    "collaboration.repo-identity-unresolved",
    `${cause}. Correct the origin or the Git probe, or add a valid [${COLLABORATION_SECTION}] repo_id to ${MSTARC_FILE} for a genuinely origin-less repository, then re-run`,
  );
}

/** Split an origin into host (with `~port` for nondefault ports) and path. */
function splitOrigin(raw: string): { host: string; path: string } {
  const value = raw.trim();
  if (value === "") unresolved("The origin remote is empty");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme !== null) {
    const protocol = `${scheme[1]!.toLowerCase()}:`;
    if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") {
      unresolved(`The origin transport ${protocol} is not a portable Git remote`);
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      unresolved("The origin is not a well-formed URL");
    }
    if (parsed.search !== "" || parsed.hash !== "") unresolved("The origin carries a query or fragment");
    // why: userinfo is dropped by never reading username/password.
    const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
    if (hostname === "") unresolved("The origin names no host");
    const port = parsed.port;
    const host = port === "" || port === DEFAULT_PORT[protocol] ? hostname : `${hostname}~${port}`;
    return { host, path: parsed.pathname };
  }
  // SCP SSH spelling: `[user@]host:path`; anything else is not portable.
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp === null) unresolved("The origin is not a portable https, http, ssh or SCP SSH remote");
  const hostname = scp[1]!.replace(/\.$/, "").toLowerCase();
  if (hostname === "") unresolved("The origin names no host");
  return { host: hostname, path: scp[2]! };
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
  try {
    const out = execFileSync("git", ["-C", mainRoot, "config", "--get-all", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: gitProbeTimeoutMs(),
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const values = out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (values.length === 0) return null;
    if (new Set(values).size > 1) unresolved("The origin remote has ambiguous multiple fetch origins");
    return values[0]!;
  } catch (error) {
    // why: exit 1 is Git's "key unset"; every other failure is unreadable Git,
    // which must never masquerade as an origin-less checkout.
    if (exitStatusOf(error) === 1) return null;
    unresolved("Git could not be read to determine the origin remote");
  }
}

function readConfig(mainRoot: string): { mode?: string; repoId?: string } {
  let text: string;
  try {
    text = readFileSync(join(resolve(mainRoot), MSTARC_FILE), "utf8");
  } catch {
    return {};
  }
  return parseMstarc(text).collaboration ?? {};
}

function resolveMode(raw: string | undefined): CollaborationMode {
  if (raw === undefined) {
    throw new CollaborationIdentityError(
      "collaboration.mode-required",
      `No [${COLLABORATION_SECTION}] mode is configured in ${MSTARC_FILE}; add 'mode=local' or 'mode=mirror' and re-run`,
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
    "'" + raw + "' is not a supported collaboration mode; use 'mode=local' or 'mode=mirror'",
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

/** Percent-encode uppercase ASCII so case-insensitive filesystems keep the keys apart. */
function encodeSegment(segment: string): string {
  return segment.replace(/[A-Z]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
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
