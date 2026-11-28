import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const SELECTOR_OBSERVATION_FILE = "collaboration-selector-observation.json";

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

/**
 * invariant: What a checked selector commit selected: its object ID, generation, phase, projects,
 * and the validated predecessor/cutover evidence a draining or lineage consumer reconciles with.
 */
export type CollaborationSelection = Readonly<{
  commit: string;
  generation: number;
  phase: "active" | "draining";
  projects: readonly CollaborationSelectorProject[];
  previous: CollaborationSelectorPrevious | null;
  cutover: CollaborationSelectorCutover | null;
}>;

export type CollaborationLocation = Readonly<{
  repoKey: string;
  mode: CollaborationMode;
  dbPath: string;
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

const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/;
const SAFE_REPO_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DEFAULT_PORT: Record<string, string> = { "https:": "443", "http:": "80", "ssh:": "22" };
const SAFE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

function unresolved(cause: string): never {
  throw new CollaborationIdentityError(
    "collaboration.repo-identity-unresolved",
    `${cause}. Correct the origin or the Git probe, or add a valid [${COLLABORATION_SECTION}] repo_id to ${MSTARC_FILE} for a genuinely origin-less repository, then re-run`,
  );
}

function assertNoDotSegments(rawPath: string): void {
  for (const segment of rawPath.split("/")) {
    if (segment === "") continue;
    const decoded = segment.replace(/%2e/gi, ".");
    if (decoded === "." || decoded === "..") unresolved("The origin path contains a dot segment");
  }
}

function canonicalHost(raw: string): string {
  const host = raw.replace(/\.$/, "").toLowerCase();
  if (host === "") unresolved("The origin names no host");
  if (host.includes("~")) unresolved("The origin host uses the reserved '~' port delimiter");
  if (!SAFE_HOST.test(host)) unresolved("The origin host is not a safe DNS name");
  return host;
}

function splitOrigin(raw: string): { host: string; path: string } {
  const value = raw.trim();
  if (value === "") unresolved("The origin remote is empty");
  if (/[\u0000-\u001f\u007f]/.test(value)) unresolved("The origin contains an ASCII control character");
  if (value.includes("\\")) unresolved("The origin contains a backslash path separator");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme !== null) {
    const protocol = `${scheme[1]!.toLowerCase()}:`;
    if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") {
      unresolved(`The origin transport ${protocol} is not a portable Git remote`);
    }
    if (value.includes("?") || value.includes("#")) unresolved("The origin carries a query or fragment");
    const rawPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(value)?.[1] ?? "";
    assertNoDotSegments(rawPath);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      unresolved("The origin is not a well-formed URL");
    }
    const hostname = canonicalHost(parsed.hostname);
    const port = parsed.port;
    const host = port === "" || port === DEFAULT_PORT[protocol] ? hostname : `${hostname}~${port}`;
    return { host, path: parsed.pathname };
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp === null) unresolved("The origin is not a portable https, http, ssh or SCP SSH remote");
  return { host: canonicalHost(scp[1]!), path: scp[2]! };
}

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
  return host === "github.com" ? segments.map((segment) => segment.toLowerCase()) : segments;
}

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
    if (exitStatusOf(error) === 1) return null;
    unresolved("Git could not be read to determine the origin remote");
  }
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
    stats = lstatSync(file);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code;
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

function gitProbe(mainRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", mainRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: gitProbeTimeoutMs(),
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

function lookupSelector(mainRoot: string): string | null {
  let out: string;
  try {
    out = gitProbe(mainRoot, ["ls-remote", "origin", AUTHORITY_REF]);
  } catch {
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

function selectorPayload(mainRoot: string, commit: string): unknown {
  try {
    gitProbe(mainRoot, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", commit]);
  } catch {
    selectorUnavailable(`Git could not fetch selector commit ${commit} from the origin remote`);
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

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const LINEAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CANONICAL_SHA256 = /^[0-9a-f]{64}$/;

function providerId(value: unknown): value is string {
  return typeof value === "string" && LINEAR_ID.test(value);
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    selectorUnavailable(`The selector's ${name} is not a positive safe integer`);
  }
  return value;
}

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

function parseSelectorPrevious(raw: unknown, generation: number): CollaborationSelectorPrevious | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) selectorUnavailable("The selector's previous is not an object");
  const previous = raw as Record<string, unknown>;
  if (typeof previous.selectorCommit !== "string" || !GIT_OBJECT_ID.test(previous.selectorCommit)) {
    selectorUnavailable("The selector's previous selectorCommit is not a Git object ID");
  }
  const prior = positiveInteger(previous.generation, "previous generation");
  if (prior >= generation) selectorUnavailable("The selector's generation does not advance its previous generation");
  if (previous.mode !== "local" && previous.mode !== "mirror" && previous.mode !== "remote") {
    selectorUnavailable("The selector's previous mode is not supported");
  }
  return { selectorCommit: previous.selectorCommit, generation: prior, mode: previous.mode };
}

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
  if (typeof cutover.verifiedTargetDigest !== "string" || !CANONICAL_SHA256.test(cutover.verifiedTargetDigest)) {
    selectorUnavailable("The selector's cutover verified target digest is not a canonical SHA-256");
  }
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

function parseSelector(
  raw: unknown,
  repoKey: string,
  mode: CollaborationMode,
  declaredMode: string | undefined,
): CollaborationSelector {
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
    selectorStale(
      `The published selector selects ${selectorMode} while ${MSTARC_FILE} ` +
        (declaredMode === undefined ? `declares no mode, which defaults to ${mode}` : `selects ${mode}`) +
        `; declare 'mode=${selectorMode}' in [${COLLABORATION_SECTION}] to follow the published selector`,
    );
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

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type SelectorObservation = Readonly<{ repoKey: string; selectorCommit: string; generation?: number }>;

function observedSelector(context: StoreContext): SelectorObservation | null {
  const path = join(context.harnessDir, SELECTOR_OBSERVATION_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    selectorStale(`The selector observation at ${path} exists but cannot be read (${code || "unknown"})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const generation = body.generation;
  const valid =
    typeof body.repoKey === "string" &&
    body.repoKey !== "" &&
    typeof body.selectorCommit === "string" &&
    GIT_OBJECT_ID.test(body.selectorCommit) &&
    (generation === undefined ||
      (typeof generation === "number" && Number.isSafeInteger(generation) && generation > 0));
  if (!valid) selectorStale(`The selector observation at ${path} is malformed`);
  return {
    repoKey: body.repoKey as string,
    selectorCommit: body.selectorCommit as string,
    ...(generation === undefined ? {} : { generation: generation as number }),
  };
}

function recordObservedSelector(context: StoreContext, seen: SelectorObservation): void {
  const path = join(context.harnessDir, SELECTOR_OBSERVATION_FILE);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ version: 1, ...seen }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    selectorUnavailable(
      `Git read selector commit ${seen.selectorCommit}, but this checkout could not record that observation beside its harness`,
    );
  } finally {
    rmSync(tmp, { force: true });
  }
}

function remoteBindingRecorded(context: StoreContext): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(context.harnessDir, COLLABORATION_BINDING_FILE), "utf8"));
    return typeof raw === "object" && raw !== null && "version" in raw && raw.version === 3;
  } catch {
    return false;
  }
}

function resolvePublishedSelector(
  context: StoreContext,
  mainRoot: string,
  repoKey: string,
  mode: CollaborationMode,
  declaredMode: string | undefined,
): CollaborationSelection | null {
  const commit = lookupSelector(mainRoot);
  if (commit === null) {
    const seen = observedSelector(context);
    if (seen !== null && seen.repoKey === repoKey) {
      selectorStale(
        `This checkout observed selector ${seen.selectorCommit}` +
          `${seen.generation === undefined ? "" : ` (generation ${seen.generation})`}, but the origin now publishes no ${AUTHORITY_REF}`,
      );
    }
    if (remoteBindingRecorded(context)) {
      selectorStale(`This checkout is recorded as bound to a remote selector, but the origin publishes no ${AUTHORITY_REF}`);
    }
    return null;
  }
  let payload: unknown;
  try {
    payload = selectorPayload(mainRoot, commit);
  } catch (error) {
    recordObservedSelector(context, { repoKey, selectorCommit: commit });
    throw error;
  }
  const confirmed = lookupSelector(mainRoot);
  if (confirmed !== commit) selectorUnavailable(`The origin's ${AUTHORITY_REF} changed while it was being read`);
  let selector: CollaborationSelector;
  try {
    selector = parseSelector(payload, repoKey, mode, declaredMode);
  } catch (error) {
    recordObservedSelector(context, { repoKey, selectorCommit: commit });
    throw error;
  }
  recordObservedSelector(context, {
    repoKey,
    selectorCommit: commit,
    generation: selector.generation,
  });
  return {
    commit,
    generation: selector.generation,
    phase: selector.phase,
    projects: selector.projects,
    previous: selector.previous,
    cutover: selector.cutover,
  };
}

function resolveMode(raw: string | undefined): CollaborationMode {
  if (raw === undefined) return "local";
  if (raw === "") {
    throw new CollaborationIdentityError(
      "collaboration.mode-required",
      `An empty [${COLLABORATION_SECTION}] mode is configured in ${MSTARC_FILE}; ` +
        "remove the line to keep the local default, or write 'mode=local', 'mode=mirror' or 'mode=remote' and re-run",
    );
  }
  if (raw === "local" || raw === "mirror" || raw === "remote") return raw;
  throw new CollaborationIdentityError(
    "collaboration.mode-invalid",
    `The [${COLLABORATION_SECTION}] mode setting in ${MSTARC_FILE} is not supported; use 'mode=local', 'mode=mirror' ` +
      `or 'mode=remote' and re-run`,
  );
}

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

const RESERVED_AUTHORITY_BASENAMES: Readonly<Record<string, true>> = {
  "collaboration.db": true,
  "collaboration.db-wal": true,
  "collaboration.db-shm": true,
  "collaboration.db-journal": true,
};

function encodeSegment(segment: string): string {
  const escaped = RESERVED_AUTHORITY_BASENAMES[segment.toLowerCase()] === true
    ? `%${segment.charCodeAt(0).toString(16).toUpperCase()}${segment.slice(1)}`
    : segment;
  return escaped.replace(/[A-Z]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function laneDbPath(home: string, dirs: readonly string[]): string {
  return join(home, ".mstar", "repos", ...dirs.map(encodeSegment), "collaboration.db");
}

function laneDirsOf(repoKey: string): string[] {
  if (repoKey.startsWith("id:")) {
    const repoId = repoKey.slice("id:".length);
    if (!SAFE_REPO_ID.test(repoId)) {
      unresolved(`The repository key ${JSON.stringify(repoKey)} is not a canonical 'id:<repo_id>' key`);
    }
    return ["_id", repoId];
  }
  const segments = repoKey.split("/");
  if (segments.length < 3) {
    unresolved(`The repository key ${JSON.stringify(repoKey)} is not a canonical 'host/owner/repo' key`);
  }
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment)) {
      unresolved(`The repository key ${JSON.stringify(repoKey)} carries an unsafe path segment`);
    }
  }
  return segments;
}

/**
 * invariant: The lane one canonical repository key names, resolved WITHOUT a checkout. A
 * cross-authority destination is addressed by its `repoKey`, so its database path must derive
 * from the key alone; `mode` stays the caller's, because a key never carries one. A key that is
 * not a canonical spelling is refused rather than path-joined, so an operator-supplied authority
 * can never name a location outside the private storage tree.
 */
export function collaborationLocationOfRepoKey(
  repoKey: string,
  mode: CollaborationMode,
  options: { userHome?: string } = {},
): CollaborationLocation {
  return { repoKey, mode, dbPath: laneDbPath(options.userHome ?? homedir(), laneDirsOf(repoKey)) };
}

/**
 * invariant: The commit-boundary selector fence for one mutation. The caller already
 * resolved a selection before it opened a writer; a Git ref can move while the
 * writer waits for the database lock, so the checked commit (and the configured
 * mode) are re-proved immediately before commit. A selector payload is immutable
 * at its commit, so one live ref lookup is the whole recheck; a moved, vanished
 * or newly published ref refuses instead of letting the mutation land under a
 * selection this process no longer holds. This does not make Git and SQLite
 * atomic: it only refuses the stale window it can observe.
 */
export function assertSelectionUnchanged(context: StoreContext, location: CollaborationLocation): void {
  const mainRoot = mainWorktreeRoot(context.checkoutRoot ?? context.harnessDir);
  if (mainRoot === null) unresolved("Git could not name the main checkout that owns this harness");
  if (resolveMode(readConfig(mainRoot).mode) !== location.mode) {
    selectorStale(
      `The ${MSTARC_FILE} collaboration mode changed while this mutation was being prepared (resolved ${location.mode})`,
    );
  }
  if (readOrigin(mainRoot) === null) {
    if (location.selection !== undefined) selectorStale("an origin-less scope cannot hold a checked selector");
    return;
  }
  const live = lookupSelector(mainRoot);
  if (location.selection !== undefined) {
    if (live !== location.selection.commit) {
      selectorStale(
        `The origin's ${AUTHORITY_REF} no longer names the checked commit ${location.selection.commit} ` +
          `(${live === null ? "the ref was deleted" : `it now names ${live}`})`,
      );
    }
    return;
  }
  if (live === null) {
    const seen = observedSelector(context);
    if (seen !== null && seen.repoKey === location.repoKey) {
      selectorStale(
        `This checkout observed selector ${seen.selectorCommit}` +
          `${seen.generation === undefined ? "" : ` (generation ${seen.generation})`}, but the origin now publishes no ${AUTHORITY_REF}`,
      );
    }
    if (remoteBindingRecorded(context)) {
      selectorStale(`This checkout is recorded as bound to a remote selector, but the origin publishes no ${AUTHORITY_REF}`);
    }
    return;
  }
  selectorStale(
    `The origin's ${AUTHORITY_REF} now names ${live}, but this mutation was admitted under a confirmed absence of it`,
  );
}

/**
 * Canonical collaboration identity, mode and user-level database path for
 * this control harness. An absent mode selects `local`; `mirror` and `remote`
 * are declared. Every origin-backed checkout proves its selection
 * from the origin's protected selector ref first: a local/mirror checkout keeps
 * its own lane only when that live lookup confirms no selector. A `remote` mode
 * requires the checked selection; a local/mirror mode that admits beside an
 * ACTIVE local/mirror selector retains that exact commit for its write fence.
 * Throws `CollaborationIdentityError`
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
  let selection: CollaborationSelection | undefined;
  if (identity.origin === null) {
    if (mode === "remote") {
      selectorUnavailable("This repository has no origin remote, so it cannot enroll in remote collaboration");
    }
  } else {
    const published = resolvePublishedSelector(context, mainRoot, identity.repoKey, mode, config.mode);
    if (mode === "remote") {
      if (published === null) selectorUnavailable(`The origin remote publishes no ${AUTHORITY_REF}`);
      selection = published;
    } else if (published !== null) {
      if (published.phase === "draining") {
        selectorStale(
          `The origin publishes a draining ${AUTHORITY_REF} for this repository, so no local or mirror authority is selected`,
        );
      }
      selection = published;
    }
  }
  const home = options.userHome ?? homedir();
  return {
    repoKey: identity.repoKey,
    mode,
    dbPath: laneDbPath(home, identity.dirs),
    ...(selection === undefined ? {} : { selection }),
  };
}
