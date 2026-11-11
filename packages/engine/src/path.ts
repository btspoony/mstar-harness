/**
 * Engine path module — harness directory discovery, spec/plan/sdd/iteration
 * path composition, v3 workflow/project/review dir resolution, scaffold
 * generation, canonical `.gitignore` snippet and the plan-writing path
 * gate.
 *
 * Spec source: `skills/mstar-conventions/SKILL.md` § 路径符号 (SSOT),
 * § {HARNESS_DIR} 解析顺序（找到即停）, § {SPECS_DIR} 解析（找到非空目录即停）
 * and § Git 跟踪策略 / § Plan-Writing Path Gate. Resolution order stays
 * `.mstarc` `[config] harness_dir` → `.mstar/` → `.agents/` → `.plans/`/
 * `plans/` per consumer convention; the explicit harness-root override
 * (`MSTAR_HARNESS_DIR` env / `opts.harnessDir`) covers repos whose harness
 * root is not one of the probed names (slice-2 plan finding 2026-08-08) and
 * stays the highest authority (above `.mstarc`).
 *
 * Workspace-root stop boundary (roadmap §7c): `resolveHarnessDir` NEVER
 * walks above the
 * workspace root — an optional `opts.workspaceRoot` stops the upward probe
 * (a harness dir above it is never returned; the `~/.mstar` global-collision
 * defect is the special case). The default boundary is the git top-level of
 * `startDir` (sync `git rev-parse --show-cdup`; non-git start falls back
 * to `startDir` itself — probes only itself, never upward; deliberate
 * tightening). Callers with a session-workspace boundary (dsh
 * `HarnessResolver.forWorkspace`) pass `workspaceRoot` explicitly; the engine
 * git-probes only for this single default resolution, never during the walk.
 *
 * The canonical `.gitignore` snippet is embedded so the engine never reads
 * skill files at runtime (roadmap §8.5 standalone rule).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GateResult, ValidationResult } from "./core.js";
// Call-time-only cycle with catalog.ts (which imports this module's resolvers
// and coordination.ts): `catalogRootDir` calls them only when a catalog verb
// runs, and this module calls the catalog verbs only inside
// `scaffoldHarness`, so neither side dereferences the other during module
// evaluation (same pattern as the project.ts / status.ts cycles below).
import { CatalogError, getCatalog, registerCatalogEntity, type CatalogOperation } from "./catalog.js";
import { checkoutRootOrFailure, gitIgnored, gitProbeTimeoutMs, mainWorktreeRoot, realpathNearest } from "./git-probe.js";
import { findMstarc, loadMstarc, MSTARC_FILE, type MstarcConfig, type MstarcStringKey } from "./mstarc.js";
// `project.ts` and `store-db.ts` are used from scaffold call paths only.
import { _DEFAULT_PROJECT } from "./project.js";
import { getArtifactStore } from "./store.js";
import { StoreError, type StoreContext } from "./store-db.js";

/**
 * Options for `resolveHarnessDir`.
 */
export type ResolveHarnessDirOptions = {
  /**
 * Explicit harness root. Resolved against `startDir` when relative.
 * Takes precedence over `MSTAR_HARNESS_DIR` and over default probing.
 * Authoritative: the path is returned even when it does not exist yet
 * (the caller may scaffold it).
 */
  harnessDir?: string;
  /** Ignore the process override when resolving checkout-local tracked results. */
  ignoreEnvOverride?: boolean;
  /**
 * Workspace-root stop boundary (roadmap §7c). The upward probe keeps
 * walking only
 * while `dir` is at or below this root — a harness dir above it is never
 * returned (the `~/.mstar` global-collision defect is the special case).
 * Resolved against `startDir` when relative. When omitted, the default
 * boundary is the git top-level of `startDir` (sync `git rev-parse
 * --show-cdup`; on failure / non-git start it falls back to
 * `startDir` itself — a non-git start probes only itself, never upward;
 * deliberate tightening). The boundary is an explicit caller value: the
 * engine git-probes only for this default resolution, never during the
 * walk.
 */
  workspaceRoot?: string;
  /**
   * Probe only the caller's own checkout: never substitute the main worktree
   * root. Used by callers that ask about the local probe itself (the `local`
   * answer of `mstar path resolve`, `path check`'s tracked-result base), not
   * about process state.
   */
  localProbe?: boolean;
};

/**
 * Resolve `{HARNESS_DIR}` per plan-conventions § {HARNESS_DIR} 解析顺序
 * (find-first-stop): `.mstarc` `[config] harness_dir` → `.mstar/` →
 * `.agents/` → `.plans/`/`plans/`, walking up from `startDir` but NEVER
 * above the workspace root (`opts.workspaceRoot`, default = git top-level
 * of `startDir`). The `.mstarc` layer: the nearest config file at or below
 * the boundary declares `harness_dir`, resolved against the config file's
 * own directory — no dir-existence requirement (callers may scaffold) and
 * no boundary check on the result (explicit layers keep authority; only
 * the config discovery walk is bounded). Harness candidates from probing
 * are dir-existence checks (the empty-dir rule applies to `{SPECS_DIR}`
 * only). An explicit override via `opts.harnessDir` or `MSTAR_HARNESS_DIR`
 * wins over both and short-circuits before any boundary logic.
 *
 * Returns the absolute harness dir, or `null` when no candidate exists
 * within the workspace boundary.
 */
export function resolveHarnessDir(
  startDir: string = process.cwd(),
  opts: ResolveHarnessDirOptions = {},
): string | null {
  const start = resolve(startDir);
  const explicit = opts.harnessDir ?? (opts.ignoreEnvOverride ? undefined : process.env.MSTAR_HARNESS_DIR);
  if (explicit) return resolve(start, explicit);
  // Harness state is process state: every harness root and every `.mstarc` is
  // read from the main worktree. A linked worktree carries a tracked copy of
  // `.mstarc`, and honoring it would make the worktree look like a process
  // root. The probes run only where they can change the answer, and a probe
  // failure is fail-closed: when the caller's checkout is known but the main
  // root is unreadable, no harness root is answered instead of silently
  // adopting the worktree's own. `localProbe` asks about the caller's own
  // checkout instead, and an explicit `opts.workspaceRoot` keeps the caller's
  // own boundary.
  let base = start;
  if (opts.workspaceRoot === undefined && opts.localProbe !== true) {
    // A probe failure (missing git, timeout) is not "not a Git repository":
    // refuse discovery rather than let the worktree's own config pass for the
    // process root.
    const probe = checkoutRootOrFailure(start);
    // "Git could not answer" refuses discovery: the worktree's own config must
    // not pass for the process root. The write gate compensates with its own
    // process-root fallback, so process documents stay gated; a write the
    // worktree makes into its own tree is not covered by that fallback.
    if (probe.failed) return null;
    if (probe.root !== null) {
      const main = mainWorktreeRoot(start);
      if (main === null) return null;
      if (probe.root !== main) base = main;
    }
  }
  const boundary = resolve(base, opts.workspaceRoot ?? defaultWorkspaceRoot(base));
  const rc = loadMstarc(base, boundary);
  if (rc !== null && rc.config.harnessDir) return resolve(rc.dir, rc.config.harnessDir);
  let dir = base;
  for (;;) {
// Stop boundary: never probe a harness dir above the workspace root.
    if (!isAtOrBelow(dir, boundary)) return null;
    for (const candidate of [join(dir, ".mstar"), join(dir, ".agents"), join(dir, ".plans"), join(dir, "plans")]) {
      if (isDirectory(candidate)) return candidate;
    }
    if (dir === boundary) return null; // probed the boundary itself; stop here
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Default workspace-root boundary for `resolveHarnessDir` (roadmap §7c):
 * the git top-level of `startDir`, resolved synchronously via
 * `git rev-parse --show-cdup` (the relative upward path to the work-tree
 * top — lexical, so it stays comparable with the `resolve()`-based walk
 * even when `startDir` sits under a symlinked mount like macOS `/var`,
 * where `--show-toplevel` would answer with the physical `/private/var/...`
 * path). On failure (not a git work tree, or git unavailable) it falls back
 * to `startDir` itself — a non-git start probes only itself and never walks
 * up (deliberate tightening). The boundary is always an explicit caller
 * value in the end: callers (e.g. dsh `HarnessResolver.forWorkspace`) pass
 * `opts.workspaceRoot` directly; this default is the CLI/engine-surface
 * resolution.
 */
function defaultWorkspaceRoot(startDir: string): string {
  try {
    const cdup = execFileSync("git", ["rev-parse", "--show-cdup"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: gitProbeTimeoutMs(),
    }).trim();
    if (!cdup) return startDir; // already at the git top-level
    let boundary = startDir;
 // Windows-normalized separator split — defensive only: this repo has no
 // Windows target, and git emits "/" here (backslashes never occur), so
 // the regex just guards a future caller from feeding `\` separators.
    for (const segment of cdup.split(/[\\/]/)) {
      if (segment && segment !== ".") boundary = dirname(boundary);
    }
    return resolve(boundary);
  } catch {
 // not a git work tree (or git unavailable) — fall through to startDir
  }
  return startDir;
}

/** True when `dir` is `root` itself or a descendant of `root` (lexical). */
function isAtOrBelow(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `.mstarc` sub-directory override for the `{X}_DIR` resolvers: the
 * nearest config at the harness dir or its parent (the repo root — the
 * documented `.mstarc` home) wins; the walk never goes above the harness
 * dir's parent, so an unrelated config further up is never adopted.
 * Returns the declared value resolved against the config file's directory,
 * or `null` when no config / no declaration exists.
 */
function mstarcDirOverride(harnessDir: string, key: MstarcStringKey): string | null {
  const dir = resolve(harnessDir);
  const rc = loadMstarc(dir, dirname(dir));
  const declared = rc?.config[key];
  return declared ? resolve(rc.dir, declared) : null;
}

/** The raw `.mstarc` declaration for `key`: value as written plus config dir. */
function mstarcDeclared(harnessDir: string, key: MstarcStringKey): { dir: string; value: string } | null {
  const dir = resolve(harnessDir);
  const rc = loadMstarc(dir, dirname(dir));
  const value = rc?.config[key];
  return value ? { dir: rc.dir, value } : null;
}

/**
 * Options for `resolveSpecsDir` / `resolveKnowledgeDir` / `resolveAdrDir`.
 */
export type ResolveSpecsDirOptions = {
  /**
   * Default true: when every candidate is absent or empty, create
   * `<repoRoot>/.agents/specs/`. Read-only callers (e.g. `mstar path resolve`)
   * pass `false` to skip the side effect.
   */
  create?: boolean;
  /**
   * The checkout the `.agents/` default belongs to. Defaults to
   * `dirname(harnessDir)`, which is only correct when the harness sits
   * directly under the repository root: a harness passed as
   * `scaffoldHarness(root, { harnessDir: outside })`, or a nested harness,
   * would otherwise create the fallback beside that harness — outside the
   * repository, where no one can commit it. Callers that know the checkout
   * (a Git top level, a scaffold `root`) pass it.
   */
  repoRoot?: string;
};

/**
 * Resolve `{SPECS_DIR}` per plan-conventions § {SPECS_DIR} 解析: a
 * `.mstarc` `[config] specs_dir` declaration is authoritative — returned
 * directly (resolved against the config file's directory; created when
 * `create` is not false; no candidate chain, no empty-dir rule). Otherwise
 * the first non-empty candidate wins — `<repoRoot>/.agents/specs/` →
 * `docs/specs/` → repo-root `specs/` (`repoRoot` is the checkout the
 * `.agents/` default belongs to: `opts.repoRoot` when the caller knows it,
 * else the harness dir's parent), then the legacy read-only `designs/`
 * candidates
 * (`{HARNESS_DIR}/designs/` → repo-root `designs/`, § {SPECS_DIR} 解析
 * Legacy — 兼容读 only, never created by init). The `.agents/` rung is a
 * default, not a claim: it is what a repository without a `.mstarc` gets, so
 * a tracked corpus survives a fully gitignored `.mstar/`; when the harness
 * dir IS `.agents` the candidate list dedupes the repeat. A candidate that
 * exists but holds no files is treated as absent (empty-dir rule,
 * recursive). When all candidates are absent, `<repoRoot>/.agents/specs/`
 * is created and returned (unless `create: false`).
 *
 * `{HARNESS_DIR}/specs/` is a legacy read source only, at the END of the
 * chain: it is never created, never returned as the fallback, and no
 * document presents it as a place specs live. Delete that rung once no
 * repository is expected to carry pre-move specs there.
 */
export function resolveSpecsDir(harnessDir: string, opts: ResolveSpecsDirOptions = {}): string {
  const declared = mstarcDirOverride(harnessDir, "specsDir");
  if (declared !== null) {
    if (opts.create !== false) mkdirSync(declared, { recursive: true });
    return declared;
  }
  const harness = resolve(harnessDir);
  const repoRoot = opts.repoRoot === undefined ? dirname(harness) : resolve(opts.repoRoot);
  const candidates = [
    join(repoRoot, ".agents", "specs"),
    join(repoRoot, "docs", "specs"),
    join(repoRoot, "specs"),
// Legacy 兼容读 (plan-conventions § {SPECS_DIR} 解析 Legacy): read-only —
// init must NOT create designs/; same empty-dir-as-absent rule applies.
    join(harness, "designs"),
    join(repoRoot, "designs"),
// Legacy read-only tail: pre-move specs under the harness root.
    join(harness, "specs"),
  ];
  for (const candidate of new Set(candidates)) {
    if (isDirectory(candidate) && hasFiles(candidate)) return candidate;
  }
  const fallback = join(repoRoot, ".agents", "specs");
  if (opts.create !== false) mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Compose `{PLAN_DIR}` from the harness dir (plan-conventions § 路径符号).
 * A `.mstarc` `[config] plan_dir` declaration wins (resolved against the
 * config file's directory). Legacy layout: when the harness root is a plans
 * dir itself (`.plans/` or `plans/`, resolution rung 3),
 * `{HARNESS_DIR}={PLAN_DIR}` — the same directory is returned.
 */
export function resolvePlanDir(harnessDir: string): string {
  const declared = mstarcDirOverride(harnessDir, "planDir");
  if (declared !== null) return declared;
  const dir = resolve(harnessDir);
  const name = basename(dir);
  if (name === ".plans" || name === "plans") return dir;
  return join(dir, "plans");
}

/**
 * Single safe path component for per-plan path composition
 * (path traversal guard): rejects `""`, `.`, `..`, and any
 * `/` or `\`; allows `[A-Za-z0-9._-]+` only. Throws with a clear message so
 * callers interpolating a plan id into a path (archive files, SDD dirs)
 * can never escape the intended parent directory.
 */
export function assertSafePathComponent(value: string, what: string): void {
  if (value === "" || value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      `${what} must be a single safe path component ([A-Za-z0-9._-]+; not "", ".", "..", or containing "/" or "\\") \u2014 got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Canonicalize `path` for containment checks when the leaf may not exist
 * (A3 nonexistent-leaf rule): canonicalize the nearest existing ancestor
 * (realpath — resolves macOS `/var` → `/private/var` and any symlinked
 * ancestors) and append the not-yet-existing remaining segments lexically.
 * `..`/`.` segments are collapsed lexically by `resolve` before the walk,
 * so the result is the path a later write would actually land at. Pure
 * read-only (stat/realpath only — never creates anything). When nothing up
 * to the filesystem root exists, the lexically resolved input is returned.
 */
export function canonicalizeNearestExisting(path: string): string {
  const abs = resolve(path);
  let dir = abs;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(dir)) {
      try {
        return join(realpathSync(dir), ...tail);
      } catch {
        return abs;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return abs; // reached the filesystem root
    tail.unshift(basename(dir));
    dir = parent;
  }
}

/**
 * Compose `{SDD_DIR}` = `{HARNESS_DIR}/sdd/<plan-id>/` (plan-conventions
 * § 路径符号). A `.mstarc` `[config] sdd_dir` declaration replaces the
 * `sdd` base (the `<plan-id>` segment is still appended). The per-plan
 * directory is created by the sdd workspace flow, not here. `planId` must
 * be a single safe path component (traversal guard) — see
 * `assertSafePathComponent`.
 */
export function resolveSddDir(harnessDir: string, planId: string): string {
  assertSafePathComponent(planId, "planId");
  const base = resolve(harnessDir);
  const declared = mstarcDirOverride(base, "sddDir");
  const sddBase = declared !== null ? declared : join(base, "sdd");
  return join(sddBase, planId);
}

/**
 * Compose `{ITERATION_DIR}` = `{HARNESS_DIR}/iterations/` (plan-conventions
 * § 路径符号). A `.mstarc` `[config] iteration_dir` declaration wins
 * (resolved against the config file's directory).
 */
export function resolveIterationDir(harnessDir: string): string {
  const declared = mstarcDirOverride(harnessDir, "iterationDir");
  if (declared !== null) return declared;
  return join(resolve(harnessDir), "iterations");
}

/**
 * Options for `resolveKnowledgeDir` / `resolveAdrDir`: the same `create` and
 * `repoRoot` contract as `resolveSpecsDir`.
 */
export type ResolveTrackedDirOptions = ResolveSpecsDirOptions;

/**
 * Resolve `{KNOWLEDGE_DIR}`. A `.mstarc` `[config] knowledge_dir`
 * declaration is authoritative (resolved against the config file's
 * directory). Otherwise the first non-empty candidate wins —
 * `<repoRoot>/.agents/knowledge/` (a default, so tracked knowledge survives
 * a fully gitignored `.mstar/`) — with the empty-dir rule applied; when it
 * holds no files the fallback `<repoRoot>/.agents/knowledge/` is created
 * (unless `create: false`). `{HARNESS_DIR}/knowledge/` is a legacy read
 * source only: last in the chain, never created, never the fallback.
 */
export function resolveKnowledgeDir(harnessDir: string, opts: ResolveTrackedDirOptions = {}): string {
  return resolveTrackedDir(harnessDir, opts, "knowledgeDir", "knowledge", [".agents", "knowledge"]);
}

/**
 * Resolve `{ADR_DIR}`. A `.mstarc` `[config] adr_dir` declaration is
 * authoritative (resolved against the config file's directory). Otherwise
 * the first non-empty candidate wins — `<repoRoot>/.agents/adr/` (default) →
 * `<repoRoot>/docs/adr/` — both subject to the empty-dir rule; when neither
 * holds files the fallback `<repoRoot>/.agents/adr/` is created (unless
 * `create: false`). `{HARNESS_DIR}/adr/` is a legacy read source only:
 * last in the chain, never created, never the fallback.
 */
export function resolveAdrDir(harnessDir: string, opts: ResolveTrackedDirOptions = {}): string {
  return resolveTrackedDir(harnessDir, opts, "adrDir", "adr", [".agents", "adr"], ["docs", "adr"]);
}

/**
 * Resolve a tracked-result dir (`specs` / `knowledge` / `adr`) for a caller
 * checkout. Tracked results follow the branch the caller has checked out; a
 * gitignored result stays in the main checkout.
 *
 * The target is first computed as the MAIN checkout sees it — the `.mstarc`
 * declaration (resolved against its own config dir, wherever that lives) or
 * the existing candidate chain. That repo-relative target is then applied to
 * the caller checkout only when the caller belongs to the same repository and
 * Git does not ignore the path there.
 */
export function resolveTrackedResultDir(
  callerCheckoutRoot: string,
  harnessDir: string,
  key: "specsDir" | "knowledgeDir" | "adrDir",
): string {
  const harness = resolve(harnessDir);
  const mainRoot = mainWorktreeRoot(harness) ?? dirname(harness);
  const declared = mstarcDeclared(harness, key);
  // `repoRoot` is the checkout that owns the harness: the `.agents/` default
  // belongs there, not beside a harness that may sit outside it.
  const mainTarget =
    declared === null
      ? key === "specsDir"
        ? resolveSpecsDir(harness, { create: false, repoRoot: mainRoot })
        : key === "knowledgeDir"
          ? resolveKnowledgeDir(harness, { create: false, repoRoot: mainRoot })
          : resolveAdrDir(harness, { create: false, repoRoot: mainRoot })
      : isAbsolute(declared.value)
        ? resolve(declared.value)
        : resolve(declared.dir, declared.value);
  // `/var` vs `/private/var` spellings must not decide membership.
  const rel = relative(realpathNearest(mainRoot), realpathNearest(mainTarget));
  // A target outside the repository (absolute declaration) stays where it is.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return mainTarget;
  // Another repository's checkout must never relocate this repository's
  // results (e.g. `--harness <other-repo>/.mstar` from this checkout).
  const callerMainRoot = mainWorktreeRoot(callerCheckoutRoot);
  if (callerMainRoot === null || realpathNearest(callerMainRoot) !== realpathNearest(mainRoot)) return mainTarget;
  const candidate = join(callerCheckoutRoot, rel);
  // Probe a child path: a directory that does not exist yet still matches the
  // parent's ignore rules, and only the child form reaches rules that match
  // below a directory's own name.
  return gitIgnored(callerCheckoutRoot, join(candidate, ".tracked-result-probe")) === false ? candidate : mainTarget;
}

/**
 * Shared body of the tracked-result resolvers: `.mstarc` override, then the
 * non-empty candidate chain (`<repoRoot>/.agents/<name>` followed by the given
 * repo-root-relative segments), then the legacy read-only
 * `{HARNESS_DIR}/<name>` tail, then the created
 * `<repoRoot>/.agents/<name>` fallback. The legacy rung is read, never
 * created and never the fallback. Candidates are deduped so a `.agents`
 * harness does not test its own directory twice.
 */
function resolveTrackedDir(
  harnessDir: string,
  opts: ResolveTrackedDirOptions,
  key: MstarcStringKey,
  name: string,
  ...extra: readonly (readonly string[])[]
): string {
  const declared = mstarcDirOverride(harnessDir, key);
  if (declared !== null) return declared;
  const harness = resolve(harnessDir);
  const repoRoot = opts.repoRoot === undefined ? dirname(harness) : resolve(opts.repoRoot);
  const preferred = join(repoRoot, ".agents", name);
  const candidates = [
    preferred,
    ...extra.map((segments) => join(repoRoot, ...segments)),
    // Legacy read-only tail: pre-move documents under the harness root.
    join(harness, name),
  ];
  for (const candidate of new Set(candidates)) {
    if (isDirectory(candidate) && hasFiles(candidate)) return candidate;
  }
  if (opts.create !== false) mkdirSync(preferred, { recursive: true });
  return preferred;
}

/**
 * Shared resolution for the v3 workflow-layout dirs (`{WORKFLOW_DIR}` /
 * `{PROJECT_DIR}`): resolve the harness dir from `startDir` first
 * (`resolveHarnessDir` — explicit `opts.harnessDir` / `MSTAR_HARNESS_DIR`
 * override, `.mstarc` `harness_dir`, then the bounded probe), apply the
 * `.mstarc` sub-dir declaration for `key` (same semantics as the other
 * `{X}_DIR` keys: relative values resolve against the config file's
 * directory, absolute allowed, dir need not exist, discovery never passes
 * the harness dir's parent), else compose `{HARNESS_DIR}/<fallback>`.
 * Throws when no harness dir resolves — a silent default would point at a
 * non-harness location.
 */
function resolveHarnessSubdir(
  startDir: string,
  opts: ResolveHarnessDirOptions,
  key: MstarcStringKey,
  fallback: string,
): string {
  const harness = resolveHarnessDir(startDir, opts);
  if (harness === null) {
    throw new Error(
      `harness dir not found from ${resolve(startDir)} \u2014 cannot resolve the ${fallback} dir (run \`mstar harness scaffold\`, pass opts.harnessDir, or set MSTAR_HARNESS_DIR)`,
    );
  }
  const declared = mstarcDirOverride(harness, key);
  return declared !== null ? declared : join(resolve(harness), fallback);
}

/**
 * Resolve `{WORKFLOW_DIR}` — default `{HARNESS_DIR}/workflows/`
 * (v3 workflow lifecycle layout: snapshot.json + notes per workflow id).
 * A `.mstarc` `[config] workflow_dir` declaration wins (resolved against
 * the config file's directory). The dir need not exist — migration/register
 * paths create it on demand.
 *
 * Deferred-by-design : the startDir-first signature is asymmetric
 * with the harnessDir-first sibling resolvers — brief-mandated for the CLI
 * consumer (it probes from the cwd). `resolveReviewDir` is the third v3
 * subdir resolver and keeps the same shape: the asymmetry is contract, not
 * an oversight.
 */
export function resolveWorkflowDir(
  startDir: string = process.cwd(),
  opts: ResolveHarnessDirOptions = {},
): string {
  return resolveHarnessSubdir(startDir, opts, "workflowDir", "workflows");
}

/**
 * Resolve `{PROJECT_DIR}` — default `{HARNESS_DIR}/projects/` (v3 project
 * layer: roadmap.md + residuals register per project id). A `.mstarc`
 * `[config] project_dir` declaration wins (resolved against the config
 * file's directory). Same deferred-by-design signature asymmetry as
 * `resolveWorkflowDir`. */
export function resolveProjectDir(
  startDir: string = process.cwd(),
  opts: ResolveHarnessDirOptions = {},
): string {
  return resolveHarnessSubdir(startDir, opts, "projectDir", "projects");
}

/**
 * Resolve `{REVIEW_DIR}` — default `{HARNESS_DIR}/reviews/`, holding one
 * run directory per codebase audit / PR review (review-report contract
 * § 2). A `.mstarc` `[config] review_dir` declaration wins (resolved
 * against the config file's directory). Same v3 shape as
 * `resolveWorkflowDir`: the dir need not exist — the run writer creates it.
 */
export function resolveReviewDir(
  startDir: string = process.cwd(),
  opts: ResolveHarnessDirOptions = {},
): string {
  return resolveHarnessSubdir(startDir, opts, "reviewDir", "reviews");
}

/**
 * Audit/review run depth — the audit effort level (review-report contract
 * § 2). A category focus (security / perf / tests / branch / next /
 * simplify) never enters a run-directory name.
 */
export type ReviewRunLevel = "quick" | "standard" | "deep";

/**
 * Fully resolved run spec — the codebase round is required here (engine API
 * review-report contract § 3).
 */
export type ReviewRunSpec =
  | { kind: "codebase"; level: ReviewRunLevel; round: number }
  | { kind: "pr"; n: number }
  | { kind: "branch"; slug: string }
  | { kind: "diff"; headSha?: string };

/**
 * Request form of {@link ReviewRunSpec} — the codebase round may be omitted,
 * in which case `resolveReviewRunDir` allocates the next free one.
 */
export type ReviewRunRequest =
  | { kind: "codebase"; level: ReviewRunLevel; round?: number }
  | { kind: "pr"; n: number }
  | { kind: "branch"; slug: string }
  | { kind: "diff"; headSha?: string };

const REVIEW_RUN_LEVELS: readonly ReviewRunLevel[] = ["quick", "standard", "deep"];
const REVIEW_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Short-SHA width for `diff` run names (git's default abbreviation length). */
const REVIEW_SHORT_SHA_WIDTH = 7;

/** Local calendar date `YYYY-MM-DD` (not UTC — the run dir is a human label). */
function reviewToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Guard the `YYYY-MM-DD` run-name date. */
function assertReviewDate(date: string): void {
  if (!REVIEW_DATE_RE.test(date)) {
    throw new Error(`review run dir: date must be YYYY-MM-DD \u2014 got ${JSON.stringify(date)}`);
  }
}

/**
 * Pure run-directory name (review-report contract § 2 — the naming SSOT):
 * `<date>-codebase-<level>-<round>`, `<date>-pr<N>`,
 * `<date>-branch-<slug>`, `<date>-diff[-<short-sha>]`. Throws on an invalid
 * date / level / round, a non-positive PR number, or an unsafe slug / SHA.
 */
export function reviewRunDirName(date: string, spec: ReviewRunSpec): string {
  assertReviewDate(date);
  switch (spec.kind) {
    case "codebase": {
      if (!REVIEW_RUN_LEVELS.includes(spec.level)) {
        throw new Error(`review run dir: level must be quick | standard | deep \u2014 got ${JSON.stringify(spec.level)}`);
      }
      if (!Number.isInteger(spec.round) || spec.round < 1) {
        throw new Error(`review run dir: codebase round must be a positive integer \u2014 got ${JSON.stringify(String(spec.round))}`);
      }
      return `${date}-codebase-${spec.level}-${spec.round}`;
    }
    case "pr":
      if (!Number.isInteger(spec.n) || spec.n < 1) {
        throw new Error(`review run dir: pr n must be a positive integer \u2014 got ${JSON.stringify(String(spec.n))}`);
      }
      return `${date}-pr${spec.n}`;
    case "branch":
      assertSafePathComponent(spec.slug, "review run dir branch slug");
      return `${date}-branch-${spec.slug}`;
    case "diff":
      // Absent OR empty headSha => the bare `-diff` name; never fabricated.
      if (!spec.headSha) return `${date}-diff`;
      assertSafePathComponent(spec.headSha, "review run dir diff head SHA");
      return `${date}-diff-${spec.headSha.slice(0, REVIEW_SHORT_SHA_WIDTH)}`;
  }
}

/**
 * Next free codebase round for `date`+`level`: the highest round already
 * present in `reviewsDir` + 1 (1 when none / the dir does not exist yet).
 * Read-only — nothing is created.
 */
function nextCodebaseRound(reviewsDir: string, date: string, level: ReviewRunLevel): number {
  const name = new RegExp(`^${date}-codebase-${level}-(\\d+)$`);
  let entries: string[];
  try {
    entries = readdirSync(reviewsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else throw error;
  }
  return (
    entries.reduce((max, entry) => {
      const match = name.exec(entry);
      return match === null ? max : Math.max(max, Number(match[1]));
    }, 0) + 1
  );
}

/**
 * Absolute run dir under `reviewsDir` (review-report contract § 2/§ 3):
 * `join(reviewsDir, reviewRunDirName(date, spec))`. An omitted codebase
 * round is allocated from the existing listing (a fresh run; a supplied
 * round reuses that exact directory — a session's own dir). `date`
 * defaults to the local calendar date. Never creates anything: the writer
 * (e.g. `scaffoldAuditReport`) owns `mkdir`.
 */
export function resolveReviewRunDir(opts: { reviewsDir: string; date?: string; spec: ReviewRunRequest }): string {
  const date = opts.date ?? reviewToday();
  assertReviewDate(date);
  const spec = opts.spec;
  const resolved: ReviewRunSpec =
    spec.kind === "codebase"
      ? { kind: "codebase", level: spec.level, round: spec.round ?? nextCodebaseRound(opts.reviewsDir, date, spec.level) }
      : spec;
  return join(opts.reviewsDir, reviewRunDirName(date, resolved));
}


/**
 * Process subdirectories created under the harness dir by `scaffoldHarness`.
 * Tracked result corpora are not in this list: they come from the resolvers
 * (`resolveKnowledgeDir` / `resolveSpecsDir` / `resolveAdrDir`) after the
 * `.mstarc` write, so a declared layout keeps one creation path.
 */
const SCAFFOLD_DIRS = ["plans", "iterations", "sdd", "reviews"] as const;

/** Options for `resolveScaffoldDirs` / `scaffoldHarness`. */
export type ScaffoldOptions = {
  /**
   * Explicit harness dir to scaffold, used verbatim. When present, the
   * `MSTAR_HARNESS_DIR` / `.mstarc` / default-`.mstar` discovery rungs are
   * skipped: a caller that already owns the exact root (e.g. `mstar mcp
   * --harness`) must not have it re-derived from the workspace. The project
   * dir is still derived from it.
   */
  harnessDir?: string;
};

/**
 * Resolve the scaffold target dirs for `root` — the harness dir and the
 * project dir — from the same config source the runtime resolvers use
 * (plan-conventions § {HARNESS_DIR} 解析顺序): explicit `MSTAR_HARNESS_DIR`
 * env wins, then `.mstarc` `[config] harness_dir` (found per find-first-stop
 * within the workspace-root boundary, resolved against the config file's
 * directory), else the default `.mstar/`. The project dir defaults to
 * `{HARNESS_DIR}/projects/` with the `.mstarc` `[config] project_dir`
 * override honored independently (same `mstarcDirOverride` semantics as
 * `resolveProjectDir`). Unlike `resolveHarnessDir`, the probe rung is
 * skipped: scaffold initializes the default `.mstar/` even when a legacy
 * `.agents/` exists (default behavior unchanged without a `.mstarc`).
 *
 * An `options.harnessDir` caller value wins over every discovery rung and is
 * returned as given, so a pinned root cannot be redirected by an inherited
 * environment variable or by the workspace's `.mstarc`.
 */
export function resolveScaffoldDirs(
  root: string,
  options: ScaffoldOptions = {},
): { harnessDir: string; projectDir: string } {
  const start = resolve(root);
  if (options.harnessDir !== undefined) {
    const harnessDir = options.harnessDir;
    const projectDir = mstarcDirOverride(harnessDir, "projectDir") ?? join(harnessDir, "projects");
    return { harnessDir, projectDir };
  }
  const boundary = resolve(start, defaultWorkspaceRoot(start));
  const rc = loadMstarc(start, boundary);
  const explicit = process.env.MSTAR_HARNESS_DIR;
  const harnessDir = explicit
    ? resolve(start, explicit)
    : rc !== null && rc.config.harnessDir
      ? resolve(rc.dir, rc.config.harnessDir)
      : join(start, ".mstar");
  const declaredProjectDir = mstarcDirOverride(harnessDir, "projectDir");
  const projectDir = declaredProjectDir !== null ? declaredProjectDir : join(harnessDir, "projects");
  return { harnessDir, projectDir };
}

/**
 * Initialize harness directories, the tracked result corpora and the
 * `_default` project without creating an execution-status file.
 * `mstar store init` separately creates and activates the execution authority.
 *
 * The layout bootstrap produces is the recommended one: `.mstar/` is a fully
 * local process root, `.mstarc` (tracked) declares the layout, and the
 * tracked corpora live under `.agents/`. Order matters — the three corpus
 * dirs are composed first, and the bootstrap `.mstarc` is then written *from*
 * the directories this run creates. A declaration authored before the run
 * wins outright (`writeBootstrapMstarc` backs off when one is already in
 * scope), so the file never pre-empts a choice the repository already made.
 *
 * Declared wins, greenfield default next, undeclared legacy never adopted.
 * A `.mstarc` key for the corpus is authoritative — the scaffold seeds where
 * that repository already writes — and otherwise the corpora are the
 * greenfield `<scaffoldRoot>/.agents/<kind>` paths, never a resolver
 * candidate: adopting a directory that merely exists would turn it into the
 * declared write target — a legacy `{HARNESS_DIR}/<kind>/` most of all, whose
 * contents a wholesale gitignored `.mstar/` can never carry into a commit.
 * Existing content is read by the resolvers, not re-homed by the scaffold.
 *
 * Idempotent: an existing `.mstarc`, directory, template or README is never
 * rewritten. Returns the absolute resolved harness dir.
 * `options.harnessDir` scaffolds exactly that dir (see `resolveScaffoldDirs`);
 * an omitted override keeps the discovery behavior above.
 * The scaffold does NOT create a legacy `residuals.json` register: the issue
 * store (`store.db`) is the findings authority and the register is migration
 * history.
 */
export async function scaffoldHarness(root: string, options: ScaffoldOptions = {}): Promise<string> {
  const { harnessDir, projectDir } = resolveScaffoldDirs(root, options);
  const harness = resolve(harnessDir);
  // Each corpus: the `.mstarc` declaration when one is in scope, else the
  // greenfield `<root>/.agents/<kind>` default — never a resolver candidate,
  // which would adopt a non-empty directory that merely exists (legacy
  // `{HARNESS_DIR}/<kind>/` above all) and declare *that* as the write target.
  // A bootstrap must never re-home existing content.
  // `root` is the repository the scaffold ran for (the tracked-results owner);
  // the `.agents/` corpora belong there even when `harness_dir` points outside
  // the checkout (an explicit `MSTAR_HARNESS_DIR`, a nested harness).
  const repoRoot = resolve(root);
  const knowledgeDir = mstarcDirOverride(harness, "knowledgeDir") ?? join(repoRoot, ".agents", "knowledge");
  const specsDir = mstarcDirOverride(harness, "specsDir") ?? join(repoRoot, ".agents", "specs");
  const adrDir = mstarcDirOverride(harness, "adrDir") ?? join(repoRoot, ".agents", "adr");
  writeBootstrapMstarc(repoRoot, harness, { knowledge: knowledgeDir, specs: specsDir, adr: adrDir });
  for (const dir of SCAFFOLD_DIRS) mkdirSync(join(harness, dir), { recursive: true });
  // `_default` is the fallback project identity; its directory is a location,
  // not a mandate to create or register a Markdown roadmap.
  const defaultProjectDir = join(projectDir, _DEFAULT_PROJECT);
  mkdirSync(defaultProjectDir, { recursive: true });
  for (const dir of [knowledgeDir, specsDir, adrDir]) mkdirSync(dir, { recursive: true });
  seedAdrTree(adrDir);
  await registerScaffoldCatalog(harness);
  return harnessDir;
}

/**
 * Write the tracked `.mstarc` at the harness dir's parent (the repository
 * root) when absent. `harness_dir` is the resolved harness basename relative
 * to that parent, so the declaration reproduces the layout that was just
 * resolved instead of re-deriving it.
 *
 * A `.mstarc` already in scope from `root` (the file that declared the
 * layout, e.g. `harness_dir=config/.mstar`) is authoritative and never
 * edited, second-guessed or duplicated at a nested parent. The destination
 * is guarded on its own path too: an explicit `harnessDir` whose parent
 * already holds an author-owned `.mstarc` is not visible from `root`, so the
 * write is skipped whenever that file exists.
 */
function writeBootstrapMstarc(
  root: string,
  harnessDir: string,
  corpus: { knowledge: string; specs: string; adr: string },
): void {
  const parent = dirname(harnessDir);
  const rel = relative(root, parent);
  // A harness outside the scaffold root (e.g. `MSTAR_HARNESS_DIR` elsewhere)
  // owns its own declaration: writing one next to it would create a file the
  // caller never named.
  if (rel.startsWith("..") || isAbsolute(rel)) return;
  if (findMstarc(root, root) !== null) return;
  // Each corpus key is written relative to this file's directory, from the
  // directory the scaffold actually creates. A nested harness (`root/runtime/
  // harness`) puts the declaration at `root/runtime/`, where the literal
  // `.agents/knowledge` would resolve to `root/runtime/.agents/knowledge` —
  // a second corpus beside the one created at the repository root.
  const content =
    "; Morning Star harness layout for this repository.\n" +
    "; Values mirror the resolved layout so candidate-chain drift cannot move them.\n" +
    "[config]\n" +
    `harness_dir=${relative(parent, harnessDir)}\n` +
    `knowledge_dir=${relative(parent, corpus.knowledge)}\n` +
    `specs_dir=${relative(parent, corpus.specs)}\n` +
    `adr_dir=${relative(parent, corpus.adr)}\n`;
  mkdirSync(parent, { recursive: true });
  writeIfAbsent(join(parent, MSTARC_FILE), content);
}

/**
 * Seed the ADR tree under the resolved `{ADR_DIR}`: the record contract, the
 * two skeletons and the four bucket directories. Class directories stay
 * absent until the first record of that class — 24 empty directories are
 * noise, and Git does not track empty directories.
 */
function seedAdrTree(adrDir: string): void {
  for (const bucket of ADR_BUCKETS) mkdirSync(join(adrDir, bucket), { recursive: true });
  writeIfAbsent(join(adrDir, "README.md"), ADR_README);
  writeIfAbsent(join(adrDir, "proposed", "TEMPLATE.md"), ADR_TEMPLATE_PROPOSED);
  writeIfAbsent(join(adrDir, "implemented", "TEMPLATE.md"), ADR_TEMPLATE_IMPLEMENTED);
}

/** Write `content` to `file` only when it does not exist yet. */
function writeIfAbsent(file: string, content: string): void {
  if (existsSync(file)) return;
  writeFileSync(file, content, "utf8");
}

/** ADR buckets, in lifecycle order. */
const ADR_BUCKETS = ["proposed", "implemented", "rejected", "archived"] as const;

/**
 * Consumer ADR tree contract (English). An intentional condensation of the
 * corpus ADR contract (`mstar-doc-corpus/references/adr.md`) — the runtime
 * copy states what a consumer needs without the authoring detail — so no
 * equality test guards it: update this text in the same change whenever the
 * contract changes.
 */
const ADR_README = `# Architecture decision records

Every record here is one decision made **among real alternatives**, filed so a reader finds it without an index: the bucket gives the fate, the class the domain, the date sorts the rest.

## Directory shape

\`\`\`
{bucket}/{class}/yyyy-mm-dd-topic.md
\`\`\`

- **Bucket** \u2014 the fate: \`proposed/\`, \`implemented/\`, \`rejected/\`, \`archived/\`.
- **Class** \u2014 the domain: \`feature/\`, \`bug-fix/\`, \`simplification/\`, \`architecture/\`, \`process/\`, \`testing/\`. There is no \`refactor\`: the judge is mechanical \u2014 observable behavior changes \u2192 \`bug-fix\` or \`feature\`; it does not \u2192 \`simplification\`.
- **Class directories are created by the first record** of that class. They are deliberately absent from the empty tree: Git does not track empty directories, and 24 of them are noise.
- **Filename** \u2014 the identity: the record's **original** date plus a lowercase kebab topic. It never changes across a lifecycle move; only the bucket directory moves.

## Skeletons

- \`proposed/TEMPLATE.md\` \u2014 \`Problem\`, \`Proposal\`, \`Alternatives considered\`, \`Acceptance criteria\`, \`Risks\`.
- \`implemented/TEMPLATE.md\` \u2014 \`Problem\`, \`Decision\`, \`Alternatives considered\`, \`Consequences\`. \`Decision\` is present tense, never "we will".
- \`rejected/\` has no third template: it reuses the proposed skeleton's shape with a frozen body.

## Lifecycle

Three moves exist, each landed as one change \u2014 move, rewrite and header together: \`proposed \u2192 implemented\`, \`proposed \u2192 rejected\`, \`implemented \u2192 archived\`. The first line of a record is \`# ADR: <title>\`; the header also carries \`Status: <state> \u2014 <why>\`. For \`proposed/\`, \`implemented/\` and \`rejected/\` the state equals the containing bucket; an archived record keeps \`Status: implemented \u2014 <why>\` and carries an additional \`Archived: yyyy-mm-dd \u2014 <reason>\` line below it. An archive records a reversal of the decision, not a fourth status.
`;

/**
 * Verbatim skeleton from this repository's `docs/adr/proposed/TEMPLATE.md`.
 * Byte-for-byte equal by contract: `path.test.ts` scaffolds into a temp dir
 * and compares this output against that owning file, so an edit to the file
 * must land here in the same change.
 */
const ADR_TEMPLATE_PROPOSED = `# ADR: <title>

Status: proposed \u2014 <one-line why this is proposed>
Date: <yyyy-mm-dd>

## Problem

<What breaks, or re-breaks, without this decision.>

## Proposal

<The change, in present tense.>

## Alternatives considered

<Each option genuinely weighed, and why it lost.>

## Acceptance criteria

<Observable outcomes that would make this implemented.>

## Risks

<What it costs or could break, and the mitigation.>
`;

/**
 * Verbatim skeleton from this repository's `docs/adr/implemented/TEMPLATE.md`.
 * Byte-for-byte equal by contract: `path.test.ts` scaffolds into a temp dir
 * and compares this output against that owning file, so an edit to the file
 * must land here in the same change.
 */
const ADR_TEMPLATE_IMPLEMENTED = `# ADR: <title>

Status: implemented \u2014 <one-line why it was accepted>
Date: <yyyy-mm-dd>

## Problem

<What breaks, or re-breaks, without this decision.>

## Decision

<What the system does now, in present tense.>

## Alternatives considered

<Each option genuinely weighed, and why it lost.>

## Consequences

<What this commits the project to, what it costs, and how each risk is mitigated.>
`;
/**
 * Register the scaffolded `_default` project through the catalog domain
 * boundary. The project directory is the canonical location; the roadmap
 * body is explicit project content and remains outside scaffold ownership.
 *
 * The store context uses the already-resolved scaffold harness directory.
 * Its own plans/ child must not cause a second round of root discovery.
 *
 * Catalog registration is not a scaffold precondition: workspaces without an
 * active store defer registration to store activation. Existing `_default`
 * catalog identity and location win unchanged.
 */
async function registerScaffoldCatalog(harnessDir: string): Promise<void> {
  const context: StoreContext = { harnessDir };
  const operation: CatalogOperation = { operationId: `scaffold:project:${_DEFAULT_PROJECT}`, actor: "scaffold" };
  try {
    await getCatalog(context, { kind: "project", id: _DEFAULT_PROJECT });
    return;
  } catch (error) {
    if (error instanceof CatalogError && error.code === "catalog.not-found") {
      // Continue to first registration.
    } else if (error instanceof StoreError && error.code === "store.not-initialized") {
      return;
    } else if (error instanceof CatalogError && error.code === "store.not-active") {
      return;
    } else {
      throw error;
    }
  }
  try {
    await registerCatalogEntity(
      context,
      {
        kind: "project",
        id: _DEFAULT_PROJECT,
        title: "Default Project",
        description: "Fallback project for project-less harness flows.",
        rootKind: "projects",
        relativePath: _DEFAULT_PROJECT,
      },
      operation,
    );
  } catch (error) {
    if (error instanceof StoreError && error.code === "store.not-initialized") return;
    if (error instanceof CatalogError && error.code === "store.not-active") return;
    throw error;
  }
}


/**
 * Canonical `.mstar/` `.gitignore` snippet — verbatim embedded copy of the
 * skill's canonical snippet (plan-conventions § Git 跟踪策略; the skill is
 * the SSOT, this constant exists so the engine never reads skill files at
 * runtime). The process root is fully local: tracked results live under
 * `.agents/` and the tracked `.mstarc` declares that layout, so no
 * re-include belongs here. `mstar-harness harness scaffold` is its only
 * writer: the installer (`init`) never reads or writes `.gitignore`. Ends
 * with a trailing newline so it can be appended directly.
 */
const GITIGNORE_SNIPPET = `# Morning Star harness: the process root stays local.
# Tracked results live under .agents/ and .mstarc declares the layout.
.mstar/
`;

/**
 * Legacy `.agents/` `.gitignore` snippet — verbatim embedded copy of the
 * skill's legacy equivalent (plan-conventions § Git 跟踪策略 "Legacy
 * `.agents/` 等价"), comments included. Used when the resolved harness kind
 * is `.agents`.
 */
const GITIGNORE_SNIPPET_AGENTS = `# Morning Star harness (.agents/) \u2014 legacy
# Default-ignore everything under .agents/, then re-include the tracked results.
.agents/**
!.agents/AGENTS.md
!.agents/knowledge/
!.agents/knowledge/**
!.agents/specs/
!.agents/specs/**
!.agents/adr/
!.agents/adr/**
`;

/** Harness `.gitignore` fence entries, derived from the `.mstar/` snippet (process root only). */
const GITIGNORE_PROCESS_ENTRIES: readonly string[] = GITIGNORE_SNIPPET.split("\n")
  .filter((line) => line.startsWith(".mstar/") || line.startsWith("!.mstar/"))
  .map((line) => line.trim());

/** Harness `.gitignore` fence entries (ignore + re-include), derived from the legacy `.agents/` snippet. */
const GITIGNORE_PROCESS_ENTRIES_AGENTS: readonly string[] = GITIGNORE_SNIPPET_AGENTS.split("\n")
  .filter((line) => line.startsWith(".agents/") || line.startsWith("!.agents/"))
  .map((line) => line.trim());

/**
 * Harness kind for the gitignore fence — the canonical snippet is per
 * harness layout (plan-conventions § Git 跟踪策略): `.mstar/` (default) and
 * legacy `.agents/`.
 */
export type HarnessKind = "mstar" | "agents";

/**
 * Emit the canonical `.gitignore` snippet for `kind` (plan-conventions
 * § Git 跟踪策略). The `.mstar/` kind ignores the whole process root — tracked
 * results live under `.agents/` and the tracked `.mstarc` declares that
 * layout, so the snippet carries no re-include; the legacy `.agents/` kind
 * keeps its re-includes. When the kind is unknown (omitted), both snippets
 * are emitted so either fence can be applied.
 */
export function emitGitignoreSnippet(kind?: HarnessKind): string {
  if (kind === "agents") return GITIGNORE_SNIPPET_AGENTS;
  if (kind === "mstar") return GITIGNORE_SNIPPET;
  return `${GITIGNORE_SNIPPET}${GITIGNORE_SNIPPET_AGENTS}`;
}

/**
 * Harness-root declaration rule: a trimmed, non-blank, non-comment line
 * matching `^!?/?\.(?:mstar|agents)(?:\/|$)`.
 * Both root spellings count, with or without a leading slash, as does a
 * negation (`!`); `.mstarc` alone does not declare. This is a mechanical
 * line scan — no escaping, glob, precedence or custom-root semantics.
 */
const HARNESS_ROOT_DECLARATION = /^!?\/?\.(?:mstar|agents)(?:\/|$)/;

/**
 * Whether `content` states a harness-root declaration: any trimmed non-blank,
 * non-comment line naming a `.mstar` or `.agents` harness root. Read only —
 * the lines are trimmed for recognition and the input bytes are never
 * rewritten. A declared file is author-owned: the caller must not append,
 * reorder, dedupe or normalize its contents.
 */
export function hasHarnessRootDeclaration(content: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) return false;
      return HARNESS_ROOT_DECLARATION.test(trimmed);
    });
}

/**
 * Validate that `<root>/.gitignore` carries a harness ignore policy. An
 * authored harness-root declaration makes the file author-owned and the gate
 * passes as `gitignore.author-declared` — regardless of the DETECTED harness
 * kind, and without proposing a rewrite, normalization or canonical-completion
 * append. A file with no such declaration is undeclared: it reports the
 * canonical entries it lacks for the detected kind — `.mstar/` for a `.mstar`
 * harness, `.agents/` for a legacy `.agents` harness, the default `.mstar/`
 * set for a layout without a canonical snippet (rung-3 `.plans`/`plans`, or no
 * harness yet) — plus the fix that appends the canonical snippet. A missing
 * file stays `gitignore.missing`. Non-blocking: returns a `ValidationResult`
 * instead of throwing.
 */
export function validateGitignore(root: string): ValidationResult {
  const gitignorePath = join(resolve(root), ".gitignore");
  const kind = detectHarnessKind(resolveHarnessDir(root));
  let content: string;
  try {
    content = readFileSync(gitignorePath, "utf8");
  } catch {
    return {
      ok: false,
      severity: "medium",
      code: "gitignore.missing",
      message: `no .gitignore found at ${gitignorePath}`,
      fix: `append the canonical snippet (emitGitignoreSnippet(${kind ? `"${kind}"` : ""})) to ${gitignorePath}`,
    };
  }
  if (hasHarnessRootDeclaration(content)) {
    return {
      ok: true,
      severity: "low",
      code: "gitignore.author-declared",
      message: `.gitignore at ${gitignorePath} states a harness-root declaration \u2014 the file is author-owned and left untouched`,
    };
  }
  const lines = new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  // Every canonical entry itself states a `.mstar/`/`.agents/` root
  // declaration, so an undeclared file cannot hold any of them: the
  // diagnostic lists the complete set for the detected kind (the default
  // `.mstar/` set when the layout is unknown).
  const canonical = kind === "agents" ? GITIGNORE_PROCESS_ENTRIES_AGENTS : GITIGNORE_PROCESS_ENTRIES;
  const missing = canonical.filter((entry) => !lines.has(entry));
  const label =
    kind === "agents" ? ".agents/ set" : kind === "mstar" ? ".mstar/ set" : "either .mstar/ or .agents/ set";
  return {
    ok: false,
    severity: "medium",
    code: "gitignore.missing-entries",
    message: `.gitignore at ${gitignorePath} is missing canonical harness ignore entries (${label}): ${missing.join(", ")}`,
    fix: `append the canonical snippet (emitGitignoreSnippet(${kind ? `"${kind}"` : ""})) to ${gitignorePath}`,
  };
}

/** Detect the gitignore fence kind from a resolved harness dir (basename). */
export function detectHarnessKind(harnessDir: string | null): HarnessKind | null {
  if (!harnessDir) return null;
  const name = basename(resolve(harnessDir));
  if (name === ".mstar") return "mstar";
  if (name === ".agents") return "agents";
  return null;
}

/**
 * Plan-writing path gate (plan-conventions § Plan-Writing Path Gate +
 * harness-core 护栏): plans must live under `{PLAN_DIR}`; external default
 * plan directories are rejected. When `harnessDir` is `null` (persistent
 * plan tracking not enabled) any plan path is rejected with a fix pointing
 * at `scaffoldHarness`. Non-blocking: returns a `ValidationResult`.
 */
export function assertPlanWritingPath(planPath: string, harnessDir: string | null): ValidationResult {
  const planAbs = resolve(planPath);
  if (!harnessDir) {
    return {
      ok: false,
      severity: "high",
      code: "plan-path.no-harness",
      message: `persistent plan tracking is not enabled \u2014 cannot place plan ${planAbs} under {PLAN_DIR}`,
      fix: "initialize the harness (scaffoldHarness) so plans land in {PLAN_DIR}",
    };
  }
  const planDir = resolvePlanDir(harnessDir);
  const rel = relative(planDir, planAbs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) {
    return {
      ok: false,
      severity: "high",
      code: "plan-path.outside-plan-dir",
      message: `plan file ${planAbs} is outside {PLAN_DIR} (${planDir})`,
      fix: `write the plan under ${planDir}`,
    };
  }
 // Canonical check for an existing plan file: a symlink whose realpath
 // leaves {PLAN_DIR} is an escape even though the lexical path is inside.
 // The plans dir itself may legitimately be a symlink (whole-dir layout),
 // so compare canonical file against canonical plan dir. Missing file
 // (first write) stays lexical-only; unexpected fs errors degrade to the
 // lexical verdict — the gate must never throw.
  if (existsSync(planAbs)) {
    try {
      const canonicalPlan = realpathSync(planAbs);
      const canonicalPlanDir = existsSync(planDir) ? realpathSync(planDir) : resolve(planDir);
      const canonicalRel = relative(canonicalPlanDir, canonicalPlan);
      const canonicalInside =
        canonicalRel === "" || (!canonicalRel.startsWith("..") && !isAbsolute(canonicalRel));
      if (!canonicalInside) {
        return {
          ok: false,
          severity: "high",
          code: "plan-path.symlink-escape",
          message: `plan file ${planAbs} resolves to ${canonicalPlan}, outside {PLAN_DIR} (${canonicalPlanDir})`,
          fix: `write the plan under ${planDir}`,
        };
      }
    } catch {
 // ENOENT raced between existsSync and realpathSync, or an unexpected
 // fs error (EACCES etc.): keep the lexical verdict, never throw.
    }
  }
  return {
    ok: true,
    severity: "low",
    code: "plan-path.ok",
    message: `plan file ${planAbs} lives under {PLAN_DIR} (${planDir})`,
  };
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** True when `dir` contains at least one file, recursively (empty-dir rule). */
function hasFiles(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (hasFiles(join(dir, entry.name))) return true;
      } else if (entry.isFile()) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
