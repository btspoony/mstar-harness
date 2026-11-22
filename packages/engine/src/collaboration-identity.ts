/**
 * invariant: collaboration-identity.ts -- canonical repository identity and the explicit
 * collaboration mode behind user-level collaboration storage.
 *
 * Identity is the origin repository, never a checkout path, Git author,
 * per-store UUID or current branch. The configured Git main checkout supplies
 * the origin and `.mstarc`, so a linked worktree cannot answer as its own
 * repository. Resolution is side-effect free: it opens no database and creates
 * no directory.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { exitStatusOf, gitProbeTimeoutMs, mainWorktreeRoot } from "./git-probe.js";
import { COLLABORATION_SECTION, MSTARC_FILE, parseMstarc } from "./mstarc.js";
import type { StoreContext } from "./store-db.js";

export type CollaborationMode = "local" | "mirror" | "remote";

/** note: The protected ref whose commit publishes the reviewed collaboration selector. */
export const AUTHORITY_REF = "refs/heads/mstar-collaboration-authority";
/** note: The selector payload's root file inside that commit's tree. */
export const AUTHORITY_FILE = "authority.json";
/**
 * note: The checkout's recorded binding beside its harness. The store owns its payload;
 * selection reads only whether a remote (v3) record exists, as evidence that the
 * repository once published a selector — never as authority.
 */
export const COLLABORATION_BINDING_FILE = "collaboration-binding.json";

/** note: One selected project: the local key and the dedicated provider project it is bound to. */
export type CollaborationSelectorProject = Readonly<{
  localProjectId: string;
  provider: "linear";
  workspaceId: string;
  teamId: string;
  projectId: string;
  journalIssueId: string;
  writerId: string;
}>;

/** note: The prior active generation a transition supersedes. */
export type CollaborationSelectorPrevious = Readonly<{
  selectorCommit: string;
  generation: number;
  mode: CollaborationMode;
}>;

/** note: The reviewed transition block of a published selector. */
export type CollaborationSelectorCutover = Readonly<{
  operator: string;
  reviewedAt: string;
  sourceFenced: boolean;
  pendingOperationIds: readonly string[];
  verifiedTargetDigest: string;
}>;

/** note: The reviewed `authority.json` payload published by one selector commit. */
export type CollaborationSelector = Readonly<{
  version: 1;
  repoKey: string;
  generation: number;
  mode: CollaborationMode;
  phase: "active" | "draining";
  projects: readonly CollaborationSelectorProject[];
  previous: CollaborationSelectorPrevious | null;
  cutover: CollaborationSelectorCutover | null;
}>;

/** invariant: What a checked selector commit selected: its object ID, generation, phase and projects. */
export type CollaborationSelection = Readonly<{
  commit: string;
  generation: number;
  phase: "active" | "draining";
  projects: readonly CollaborationSelectorProject[];
}>;

export type CollaborationLocation = Readonly<{
  /** note: Canonical logical identity (`host[/owner...]/repo` or `id:<repo_id>`). */
  repoKey: string;
  mode: CollaborationMode;
  /** invariant: Canonical user-level database path; never created by resolution. */
  dbPath: string;
  /**
   * invariant: The trusted selector behind a `remote` mode, read from its checked Git commit.
   * Absent for local/mirror, whose selection is `.mstarc` plus the repository key.
   */
  selection?: CollaborationSelection;
}>;

export type CollaborationIdentityCode =
  | "collaboration.repo-identity-unresolved"
  | "collaboration.config-unreadable"
  | "collaboration.mode-required"
  | "collaboration.mode-invalid"
  | "collaboration.stale-binding"
  | "remote.selector-unavailable";

/** Named refusal: a stable code plus the exact supported recovery. */
export class CollaborationIdentityError extends Error {
  readonly code: CollaborationIdentityCode;

  constructor(code: CollaborationIdentityCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CollaborationIdentityError";
    this.code = code;
  }
}

/** note: Safe origin path segment: no separators, encoding, quotes or dot segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/;
/** note: Explicit origin-less id: `[a-z0-9][a-z0-9._-]{0,127}`. */
const SAFE_REPO_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DEFAULT_PORT: Record<string, string> = { "https:": "443", "http:": "80", "ssh:": "22" };
/** note: DNS host: dot-separated non-empty labels; `~` stays reserved for `host~port`. */
const SAFE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

function unresolved(cause: string): never {
  throw new CollaborationIdentityError(
    "collaboration.repo-identity-unresolved",
    `${cause}. Correct the origin or the Git probe, or add a valid [${COLLABORATION_SECTION}] repo_id to ${MSTARC_FILE} for a genuinely origin-less repository, then re-run`,
  );
}

/** invariant: Refuse literal and percent-encoded dot segments in a raw origin path. */
function assertNoDotSegments(rawPath: string): void {
  for (const segment of rawPath.split("/")) {
    if (segment === "") continue;
    // why: WHATWG URL decodes `%2e` and drops dot segments before callers see
    // the path, so only the raw spelling can be judged.
    const decoded = segment.replace(/%2e/gi, ".");
    if (decoded === "." || decoded === "..") unresolved("The origin path contains a dot segment");
  }
}

/** note: Lowercase DNS host without its terminal dot; refusal when it is not a safe one. */
function canonicalHost(raw: string): string {
  const host = raw.replace(/\.$/, "").toLowerCase();
  if (host === "") unresolved("The origin names no host");
  if (host.includes("~")) unresolved("The origin host uses the reserved '~' port delimiter");
  if (!SAFE_HOST.test(host)) unresolved("The origin host is not a safe DNS name");
  return host;
}

/** note: Split an origin into host (with `~port` for nondefault ports) and path. */
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
  // note: SCP SSH spelling: `[user@]host:path`; anything else is not portable.
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp === null) unresolved("The origin is not a portable https, http, ssh or SCP SSH remote");
  return { host: canonicalHost(scp[1]!), path: scp[2]! };
}

/** note: Owner path below the host, with one terminal `.git` and slashes removed. */
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
 * invariant: The single `origin` URL, `null` when the remote is unconfigured, refusal when
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

function configUnreadable(file: string, cause: string): never {
  throw new CollaborationIdentityError(
    "collaboration.config-unreadable",
    `${file} cannot be read because ${cause}; make it a readable regular file or remove it, then re-run`,
  );
}

function readConfig(mainRoot: string): { mode?: string; repoId?: string } {
  const file = join(resolve(mainRoot), MSTARC_FILE);
  let stats: Stats;
  try {
    // why: `lstat` reports the directory entry itself, so a dangling symlink is
    // a present entry rather than the absent file `readFileSync` would report.
    stats = lstatSync(file);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code;
    // why: only a missing directory entry means "no configuration"; every other
    // failure is a cause that adding a mode cannot fix.
    if (reason === "ENOENT") return {};
    configUnreadable(
      file,
      reason === "ENOTDIR"
        ? "a parent path component is not a directory"
        : `it could not be inspected (${reason ?? "unknown error"})`,
    );
  }
  if (stats.isSymbolicLink()) configUnreadable(file, "it is a symbolic link");
  if (!stats.isFile()) configUnreadable(file, stats.isDirectory() ? "it is a directory" : "it is not a regular file");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code;
    configUnreadable(
      file,
      reason === "EACCES" || reason === "EPERM"
        ? "it is not readable by this process"
        : `it could not be read (${reason ?? "unknown error"})`,
    );
  }
  return parseMstarc(text).collaboration ?? {};
}

/** note: A Git probe over this checkout with the shared timeout and locale. */
function gitProbe(mainRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", mainRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: gitProbeTimeoutMs(),
    // why: The selector lookup is the only network probe here, and a credential prompt
    // would hold the caller instead of refusing the selection.
    env: { ...process.env, LC_ALL: "C", LANG: "C", GIT_TERMINAL_PROMPT: "0" },
  });
}

function selectorUnavailable(cause: string): never {
  throw new CollaborationIdentityError(
    "remote.selector-unavailable",
    `${cause}. A remote selection is proven only by a live lookup of ${AUTHORITY_REF} at the canonical origin, so no ` +
      `authority was selected: restore access to that remote (publishing the reviewed selector when it is genuinely ` +
      `missing), then re-run`,
  );
}

function selectorStale(cause: string): never {
  throw new CollaborationIdentityError(
    "collaboration.stale-binding",
    `${cause}. Inspect the published selector and this checkout's binding with mstar path resolve, then complete the ` +
      `reviewed remote bind for this checkout; nothing was read as collaboration authority`,
  );
}

/** note: The object ID the origin's selector ref names now, or `null` when a live lookup confirms absence. */
function lookupSelector(mainRoot: string): string | null {
  let out: string;
  try {
    out = gitProbe(mainRoot, ["ls-remote", "origin", AUTHORITY_REF]);
  } catch {
    // invariant: A failed lookup is never absence: without an answer no authority may be selected.
    selectorUnavailable("Git could not check the collaboration selector at the origin remote");
  }
  const rows = out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (rows.length === 0) return null;
  const [sha, ref] = (rows[0] ?? "").split("\t");
  if (rows.length !== 1 || ref !== AUTHORITY_REF || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha ?? "")) {
    selectorUnavailable("The origin answered the selector lookup with an unreadable ref");
  }
  return sha!;
}

/** invariant: Read the selector from its fetched commit object, never the checkout, a tracking ref or a cache. */
function selectorPayload(mainRoot: string, commit: string): unknown {
  try {
    gitProbe(mainRoot, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", commit]);
  } catch {
    // why: A clone usually holds the object already; only the transfer is optional, the proof is not.
    try {
      gitProbe(mainRoot, ["cat-file", "-e", `${commit}^{commit}`]);
    } catch {
      selectorUnavailable(`Git could not fetch selector commit ${commit} from the origin remote`);
    }
  }
  let text: string;
  try {
    text = gitProbe(mainRoot, ["cat-file", "blob", `${commit}:${AUTHORITY_FILE}`]);
  } catch {
    selectorUnavailable(`Selector commit ${commit} has no readable root ${AUTHORITY_FILE}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    selectorUnavailable(`The selector ${AUTHORITY_FILE} in commit ${commit} is not JSON`);
  }
}

/** note: A nonempty string field of the payload. */
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * invariant: Provider identifiers are the immutable Linear object IDs, never a label, a URL or
 * an issue identifier such as `ENG-42`.
 */
function providerId(value: unknown): value is string {
  return nonEmpty(value) && !value.includes("://") && !/^[A-Z][A-Z0-9]*-\d+$/.test(value);
}

/** note: The payload's positive safe integer fields: generations and the private epoch. */
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    selectorUnavailable(`The selector's ${name} is not a positive safe integer`);
  }
  return value;
}

/** note: The selector's selected projects: empty for local/mirror, a unique nonempty list for remote. */
function parseSelectorProjects(raw: unknown, mode: CollaborationMode): readonly CollaborationSelectorProject[] {
  if (!Array.isArray(raw)) selectorUnavailable("The selector's projects is not a list");
  if (mode !== "remote") {
    if (raw.length !== 0) selectorUnavailable(`The selector's ${mode} mode lists provider projects`);
    return [];
  }
  if (raw.length === 0) selectorUnavailable("The selector's remote mode selects no project");
  const localKeys = new Set<string>();
  const providerKeys = new Set<string>();
  return raw.map((entry): CollaborationSelectorProject => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      selectorUnavailable("A selected project is not an object");
    }
    const project = entry as Record<string, unknown>;
    if (!nonEmpty(project.localProjectId)) selectorUnavailable("A selected project has no local project id");
    if (project.provider !== "linear") selectorUnavailable("A selected project's provider is not linear");
    for (const key of ["workspaceId", "teamId", "projectId", "journalIssueId", "writerId"]) {
      if (!providerId(project[key])) selectorUnavailable(`A selected project's ${key} is not an immutable provider id`);
    }
    if (localKeys.has(project.localProjectId)) selectorUnavailable("The selector lists one local project twice");
    localKeys.add(project.localProjectId);
    const providerKey = [project.workspaceId, project.teamId, project.projectId].join("\u0000");
    if (providerKeys.has(providerKey)) selectorUnavailable("The selector binds one provider project twice");
    providerKeys.add(providerKey);
    return {
      localProjectId: project.localProjectId,
      provider: "linear",
      workspaceId: project.workspaceId as string,
      teamId: project.teamId as string,
      projectId: project.projectId as string,
      journalIssueId: project.journalIssueId as string,
      writerId: project.writerId as string,
    };
  });
}

/** note: The prior active generation, which every later generation must strictly exceed. */
function parseSelectorPrevious(raw: unknown, generation: number): CollaborationSelectorPrevious | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) selectorUnavailable("The selector's previous is not an object");
  const previous = raw as Record<string, unknown>;
  if (typeof previous.selectorCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(previous.selectorCommit)) {
    selectorUnavailable("The selector's previous selectorCommit is not a Git object ID");
  }
  const prior = positiveInteger(previous.generation, "previous generation");
  if (prior >= generation) selectorUnavailable("The selector's generation does not advance its previous generation");
  if (previous.mode !== "local" && previous.mode !== "mirror" && previous.mode !== "remote") {
    selectorUnavailable("The selector's previous mode is not supported");
  }
  return { selectorCommit: previous.selectorCommit, generation: prior, mode: previous.mode };
}

/** note: The reviewed transition block; absent only on an initial selector, and mandatory once a generation advances. */
function parseSelectorCutover(
  raw: unknown,
  previous: CollaborationSelectorPrevious | null,
  phase: "active" | "draining",
): CollaborationSelectorCutover | null {
  if (raw === null) {
    if (previous !== null) selectorUnavailable("The selector advances a generation without its cutover record");
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) selectorUnavailable("The selector's cutover is not an object");
  const cutover = raw as Record<string, unknown>;
  if (previous === null) selectorUnavailable("The selector carries a cutover for an initial generation");
  if (!nonEmpty(cutover.operator)) selectorUnavailable("The selector's cutover names no operator");
  if (!nonEmpty(cutover.reviewedAt)) selectorUnavailable("The selector's cutover has no review time");
  if (typeof cutover.sourceFenced !== "boolean") selectorUnavailable("The selector's cutover sourceFenced is not a boolean");
  if (!Array.isArray(cutover.pendingOperationIds) || !cutover.pendingOperationIds.every(nonEmpty)) {
    selectorUnavailable("The selector's cutover pendingOperationIds is not a list of operation ids");
  }
  if (!nonEmpty(cutover.verifiedTargetDigest)) selectorUnavailable("The selector's cutover has no verified target digest");
  if (phase === "active" && cutover.sourceFenced !== true) {
    selectorStale("The selector is active but its cutover is not source-fenced");
  }
  if (phase === "active" && cutover.pendingOperationIds.length !== 0) {
    selectorStale("The selector is active while its cutover still lists pending operations");
  }
  return {
    operator: cutover.operator,
    reviewedAt: cutover.reviewedAt,
    sourceFenced: cutover.sourceFenced,
    pendingOperationIds: cutover.pendingOperationIds as readonly string[],
    verifiedTargetDigest: cutover.verifiedTargetDigest,
  };
}

/** invariant: A selector is trusted only when it names this repository and this `.mstarc` mode, and is internally consistent. */
function parseSelector(raw: unknown, repoKey: string, mode: CollaborationMode): CollaborationSelector {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) selectorUnavailable("The selector payload is not an object");
  const body = raw as Record<string, unknown>;
  if (body.version !== 1) selectorUnavailable("The selector payload's version is not supported");
  if (body.repoKey !== repoKey) {
    selectorStale(`The published selector belongs to repository ${String(body.repoKey)}, not this checkout's ${repoKey}`);
  }
  const generation = positiveInteger(body.generation, "generation");
  const selectorMode = body.mode;
  if (selectorMode !== "local" && selectorMode !== "mirror" && selectorMode !== "remote") {
    selectorUnavailable("The selector's mode is not supported");
  }
  if (selectorMode !== mode) {
    selectorStale(`The published selector selects ${selectorMode} while ${MSTARC_FILE} selects ${mode}`);
  }
  if (body.phase !== "active" && body.phase !== "draining") {
    selectorUnavailable("The selector's phase is not active or draining");
  }
  const projects = parseSelectorProjects(body.projects, selectorMode);
  const previous = parseSelectorPrevious(body.previous, generation);
  const cutover = parseSelectorCutover(body.cutover, previous, body.phase);
  return {
    version: 1,
    repoKey,
    generation,
    mode: selectorMode,
    phase: body.phase,
    projects,
    previous,
    cutover,
  };
}

/** note: A recorded v3 checkout binding is evidence a selector was published once; it selects nothing. */
function remoteBindingRecorded(context: StoreContext): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(context.harnessDir, COLLABORATION_BINDING_FILE), "utf8"));
    return typeof raw === "object" && raw !== null && "version" in raw && raw.version === 3;
  } catch {
    // note: Unreadable or absent: the store's binding reader owns that verdict.
    return false;
  }
}

/**
 * invariant: Remote selection: the origin's live selector lookup, its fetched commit, a second
 * lookup proving that commit is still the ref's, and the payload read from that commit.
 */
function resolveRemoteSelection(
  context: StoreContext,
  mainRoot: string,
  origin: string | null,
  repoKey: string,
): CollaborationSelection {
  if (origin === null) {
    // invariant: An origin-less scope stays local/mirror: remote needs an origin to publish a selector.
    selectorUnavailable("This repository has no origin remote, so it cannot enroll in remote collaboration");
  }
  const commit = lookupSelector(mainRoot);
  if (commit === null) {
    if (remoteBindingRecorded(context)) {
      selectorStale(`This checkout is recorded as bound to a remote selector, but the origin publishes no ${AUTHORITY_REF}`);
    }
    selectorUnavailable(`The origin remote publishes no ${AUTHORITY_REF}`);
  }
  const selector = parseSelector(selectorPayload(mainRoot, commit), repoKey, "remote");
  // invariant: The commit is read only if the ref still names it: a selector that moved mid-read selects nothing.
  const confirmed = lookupSelector(mainRoot);
  if (confirmed !== commit) selectorUnavailable(`The origin's ${AUTHORITY_REF} changed while it was being read`);
  return { commit, generation: selector.generation, phase: selector.phase, projects: selector.projects };
}

function resolveMode(raw: string | undefined): CollaborationMode {
  if (raw === undefined || raw === "") {
    throw new CollaborationIdentityError(
      "collaboration.mode-required",
      (raw === ""
        ? `An empty [${COLLABORATION_SECTION}] mode is configured in ${MSTARC_FILE}; `
        : `No [${COLLABORATION_SECTION}] mode is configured in ${MSTARC_FILE}; `) +
        "add 'mode=local', 'mode=mirror' or 'mode=remote' and re-run",
    );
  }
  if (raw === "local" || raw === "mirror" || raw === "remote") return raw;
  throw new CollaborationIdentityError(
    "collaboration.mode-invalid",
    `The [${COLLABORATION_SECTION}] mode setting in ${MSTARC_FILE} is not supported; use 'mode=local', 'mode=mirror' ` +
      `or 'mode=remote' and re-run`,
  );
}

/** note: Canonical key, its filesystem directory segments, and the origin the key was read from. */
function canonicalIdentity(
  mainRoot: string,
  repoId: string | undefined,
): { repoKey: string; dirs: string[]; origin: string | null } {
  const origin = readOrigin(mainRoot);
  if (origin === null) {
    if (repoId === undefined) {
      unresolved("This repository has no origin remote and no explicit [collaboration] repo_id");
    }
    if (!SAFE_REPO_ID.test(repoId)) {
      unresolved("The [collaboration] repo_id is not a safe lower-case identifier");
    }
    return { repoKey: `id:${repoId}`, dirs: ["_id", repoId], origin };
  }
  const { host, path } = splitOrigin(origin);
  const segments = originPathSegments(path, host);
  return { repoKey: [host, ...segments].join("/"), dirs: [host, ...segments], origin };
}

/**
 * invariant: Basenames reserved for the authority database and its SQLite sidecars. A
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
 * invariant: Filesystem spelling of one directory segment: percent-encode uppercase ASCII
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
 * for this control harness. A `remote` mode additionally proves its selection
 * from the origin's protected selector ref. Throws `CollaborationIdentityError`
 * on an unresolved identity or mode, an unchecked selector, or a selector that
 * disagrees with this checkout.
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
  const selection =
    mode === "remote" ? resolveRemoteSelection(context, mainRoot, identity.origin, identity.repoKey) : undefined;
  const home = options.userHome ?? homedir();
  return {
    repoKey: identity.repoKey,
    mode,
    dbPath: join(home, ".mstar", "repos", ...identity.dirs.map(encodeSegment), "collaboration.db"),
    ...(selection === undefined ? {} : { selection }),
  };
}
