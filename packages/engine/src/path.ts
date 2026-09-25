/**
 * Engine path module — harness directory discovery, spec/plan/sdd/iteration
 * path composition, v3 workflow/project dir resolution, scaffold
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
 * All skill-derived artifacts (status.json empty template, gitignore snippet)
 * are embedded constants: the engine never reads skill files at runtime
 * (roadmap §8.5 standalone rule).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GateResult, ValidationResult } from "./core.js";
// Call-time-only cycle with catalog.ts (which imports this module's resolvers
// and coordination.ts): `catalogRootDir` calls them only when a catalog verb
// runs, and this module calls the catalog verbs only inside
// `scaffoldHarness`, so neither side dereferences the other during module
// evaluation (same pattern as the project.ts / status.ts cycles below).
import { CatalogError, getCatalog, registerCatalogEntity, type CatalogOperation } from "./catalog.js";
import { loadMstarc, type MstarcConfig } from "./mstarc.js";
// Call-time-only cycles with project.ts / status.ts (both → path.ts): none of
// the cycle members dereferences the other's bindings during module
// evaluation — the constants and the validators are used only inside
// scaffoldHarness — so the ESM live-binding cycle is safe (same pattern as
// the status.ts ↔ workflow.ts cycle documented in status.ts).
import { _DEFAULT_PROJECT } from "./project.js";
import { validateStatusV2, type StatusV2Doc } from "./status.js";
import { withStatusWriteLock } from "./lease.js";
import { assertFsStorePath, getArtifactStore, type ArtifactRef, type ArtifactStore } from "./store.js";
import { StoreError, type StoreContext } from "./store-db.js";
import { CoordinationError, isPlainObject, readArtifactBytes, sha256Bytes, withProtectedWrite } from "./coordination-write.js";

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
  const explicit = opts.harnessDir ?? process.env.MSTAR_HARNESS_DIR;
  if (explicit) return resolve(start, explicit);
  const boundary = resolve(start, opts.workspaceRoot ?? defaultWorkspaceRoot(start));
  const rc = loadMstarc(start, boundary);
  if (rc !== null && rc.config.harnessDir) return resolve(rc.dir, rc.config.harnessDir);
  let dir = start;
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
function mstarcDirOverride(harnessDir: string, key: keyof MstarcConfig): string | null {
  const dir = resolve(harnessDir);
  const rc = loadMstarc(dir, dirname(dir));
  const declared = rc?.config[key];
  return declared ? resolve(rc.dir, declared) : null;
}

/**
 * Options for `resolveSpecsDir`.
 */
export type ResolveSpecsDirOptions = {
  /**
 * Default true: when every candidate is absent or empty, create
 * `{HARNESS_DIR}/specs/` (plan-conventions § 创建默认). Read-only callers
 * (e.g. `mstar path resolve`) pass `false` to skip the side effect.
 */
  create?: boolean;
};

/**
 * Resolve `{SPECS_DIR}` per plan-conventions § {SPECS_DIR} 解析: a
 * `.mstarc` `[config] specs_dir` declaration is authoritative — returned
 * directly (resolved against the config file's directory; created when
 * `create` is not false; no candidate chain, no empty-dir rule). Otherwise
 * the first non-empty candidate wins — `{HARNESS_DIR}/specs/` →
 * `docs/specs/` → repo-root `specs/` (repo root = parent of the harness
 * dir), then the legacy read-only `designs/` candidates
 * (`{HARNESS_DIR}/designs/` → repo-root `designs/`, § {SPECS_DIR} 解析
 * Legacy — 兼容读 only, never created by init). A candidate that exists
 * but holds no files is treated as absent (empty-dir rule, recursive).
 * When all candidates are absent, `{HARNESS_DIR}/specs/` is created and
 * returned (unless `create: false`).
 */
export function resolveSpecsDir(harnessDir: string, opts: ResolveSpecsDirOptions = {}): string {
  const declared = mstarcDirOverride(harnessDir, "specsDir");
  if (declared !== null) {
    if (opts.create !== false) mkdirSync(declared, { recursive: true });
    return declared;
  }
  const harness = resolve(harnessDir);
  const repoRoot = dirname(harness);
  const candidates = [
    join(harness, "specs"),
    join(repoRoot, "docs", "specs"),
    join(repoRoot, "specs"),
 // Legacy 兼容读 (plan-conventions § {SPECS_DIR} 解析 Legacy): read-only —
 // init must NOT create designs/; same empty-dir-as-absent rule applies.
    join(harness, "designs"),
    join(repoRoot, "designs"),
  ];
  for (const candidate of candidates) {
    if (isDirectory(candidate) && hasFiles(candidate)) return candidate;
  }
  const fallback = join(harness, "specs");
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
 * Compose `{KNOWLEDGE_DIR}` = `{HARNESS_DIR}/knowledge/` (plan-conventions
 * § 路径符号). A `.mstarc` `[config] knowledge_dir` declaration wins
 * (resolved against the config file's directory).
 */
export function resolveKnowledgeDir(harnessDir: string): string {
  const declared = mstarcDirOverride(harnessDir, "knowledgeDir");
  if (declared !== null) return declared;
  return join(resolve(harnessDir), "knowledge");
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
  key: keyof MstarcConfig,
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
 * the config file's directory). The dir need not exist — writers
 * (`writeWorkflowSnapshot` / register paths) create it on demand.
 *
 * Deferred-by-design : the startDir-first signature is asymmetric
 * with the harnessDir-first sibling resolvers — brief-mandated for the CLI
 * consumer (it probes from the cwd). Revisit with a harness-dir-first
 * variant when a third v3 subdir resolver appears.
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
 * Empty status.json template — embedded copy of
 * `skills/mstar-artifacts/templates/status.empty.json`
 * (plan-conventions § 初始化 Plan 目录). Ruling: the template is
 * the **v2 shape** (`version: 2`, `updated_at`, `workflows: []`) so
 * `scaffoldHarness` never emits an un-migrated (v1) tree. Kept as a constant
 * so the engine has no runtime dependency on skill files.
 */
const EMPTY_STATUS_TEMPLATE: Record<string, unknown> = {
  version: 2,
  updated_at: "1970-01-01",
  workflows: [],
};

/** Subdirectories created under the harness dir by `scaffoldHarness`. */
const SCAFFOLD_DIRS = ["plans", "iterations", "knowledge", "specs", "sdd"] as const;

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
 */
export function resolveScaffoldDirs(root: string): { harnessDir: string; projectDir: string } {
  const start = resolve(root);
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
 * Initialize the harness directory under `root`: create the resolved
 * harness dir (default `.mstar/`, or the `.mstarc`-declared `harness_dir`
 * / `MSTAR_HARNESS_DIR` override — see `resolveScaffoldDirs`) with
 * `plans/`, `iterations/`, `knowledge/`, `specs/`, `sdd/`, write
 * `status.json` from the empty template, and prebuild the v3 project layer
 * `_default/` under the resolved project dir and register its identity at
 * that directory. Project Markdown content and authority remain explicit
 * later registrations (plan-conventions § 初始化 Plan 目录;
 * mstar-project-governance § `_default` 回退).
 * Idempotent: existing project content and catalog identity/location are
 * never rewritten or relocated. Returns the absolute resolved harness dir.
 *
 * The scaffold does NOT create a legacy `residuals.json` register
 * (issue-governance cutover G2a): the issue store (`store.db`) is the
 * findings authority and the register is migration history — a scaffold must
 * never recreate the retired authority. The one coordination document
 * (`status.json`) is written create-only through the active `ArtifactStore`
 * inside the private protected-write context, serialized on the target's
 * `withStatusWriteLock` (spec §C4): a concurrent writer's bytes are never
 * replaced, and an existing empty/malformed document fails validation instead
 * of being silently reinitialized. Callers whose target root differs from the
 * active store's root MUST `setArtifactStore(createFsStore(<harnessRoot>))`
 * first (same contract as the other routed writers). No scoped session or
 * coordination record is created here.
 */
export async function scaffoldHarness(root: string): Promise<string> {
  const { harnessDir, projectDir } = resolveScaffoldDirs(root);
  for (const dir of SCAFFOLD_DIRS) mkdirSync(join(harnessDir, dir), { recursive: true });
  const store = getArtifactStore();
  await scaffoldProtectedDoc(
    store,
    { kind: "status", key: "root" },
    join(harnessDir, "status.json"),
    EMPTY_STATUS_TEMPLATE,
    (payload) =>
      isPlainObject(payload)
        ? validateStatusV2(payload as StatusV2Doc, { harnessDir })
        : {
            ok: false,
            violations: [
              { ok: false, severity: "high", code: "scaffold.status-shape", message: "status.json must be a JSON object" },
            ],
          },
  );
  // `_default` is the fallback project identity; its directory is a location,
  // not a mandate to create or register a Markdown roadmap.
  const defaultProjectDir = join(projectDir, _DEFAULT_PROJECT);
  mkdirSync(defaultProjectDir, { recursive: true });
  await registerScaffoldCatalog(root);
  return harnessDir;
}
/**
 * Register the scaffolded `_default` project through the catalog domain
 * boundary. The project directory is the canonical location; the roadmap
 * body is explicit project content and remains outside scaffold ownership.
 *
 * The store context is the scaffold ROOT (what the caller passed), not the
 * resolved harness dir: `storeDbPath` re-resolves its context, and a harness
 * dir that already owns a `plans/` child would resolve to `plans/store.db` —
 * the scaffold root resolves to the harness marker itself, stably, which is
 * the same store the documented `{HARNESS_DIR}` resolution names.
 *
 * Catalog registration is not a scaffold precondition: workspaces without an
 * active store defer registration to store activation. Existing `_default`
 * catalog identity and location win unchanged.
 */
async function registerScaffoldCatalog(root: string): Promise<void> {
  const context: StoreContext = { harnessDir: root };
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
 * Create one bootstrap document create-only (spec §C4): the target is written
 * from `template` ONLY when it is absent. Existing state is never replaced —
 * an existing empty or malformed document fails validation instead of being
 * silently reinitialized, so a concurrent writer's bytes always survive.
 *
 * The write is serialized on the target's `withStatusWriteLock` and runs
 * inside the private protected-write context, because `status.json` /
 * `residuals.json` are coordination documents the `FsStore` boundary refuses
 * to write outside it. No scoped session or coordination record is created.
 */
async function scaffoldProtectedDoc(
  store: ArtifactStore,
  ref: ArtifactRef,
  target: string,
  template: Record<string, unknown>,
  validate: (payload: unknown) => GateResult,
): Promise<void> {
  assertFsStorePath(store, ref, target);
// The lockdir lands inside the target's dirname — create it up front so a
// first-time harness/project dir does not fail acquisition with ENOENT.
  mkdirSync(dirname(target), { recursive: true });
  await withStatusWriteLock(target, async () => {
    const existing = readArtifactBytes(target);
    if (existing === undefined) {
      await withProtectedWrite(target, "put", () => store.put({ ...ref, payload: template }));
      return;
    }
    const gate = validate(existing.payload);
    if (!gate.ok) {
      throw new CoordinationError(
        "coordination.invalid-input",
        `refusing to scaffold ${target}: the document already exists but is invalid (${gate.violations
          .map((violation) => violation.message)
          .join("; ")}) \u2014 scaffold never replaces existing state`,
        { path: target },
      );
    }
  });
}

/**
 * Canonical `.mstar/` `.gitignore` snippet — verbatim embedded copy of the
 * skill's canonical snippet (plan-conventions § Git 跟踪策略; the skill is
 * the SSOT, this constant exists so the engine never reads skill files at
 * runtime). The CLI `init` fence (packages/cli/src/adapters/shared-install.ts
 * HARNESS_PROCESS_GITIGNORE) mirrors these entries verbatim. Ends with a
 * trailing newline so it can be appended directly.
 */
const GITIGNORE_SNIPPET = `# Morning Star harness (.mstar/)
# Principle: process stays local; results are shared with the team.
# Default-ignore everything under .mstar/, then re-include the tracked results.
.mstar/**
!.mstar/AGENTS.md
!.mstar/knowledge/
!.mstar/knowledge/**
!.mstar/specs/
!.mstar/specs/**
# .mstarc \u2014 repo-local harness config (may declare [config] harness_dir=<name>)
.mstarc
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
`;

/** Harness `.gitignore` fence entries (ignore + re-include), derived from the `.mstar/` snippet. */
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
 * § Git 跟踪策略): default-ignore the whole harness dir (`<dir>/**`) and
 * re-include only the tracked results (AGENTS.md, knowledge/, specs/).
 * When the kind is unknown (omitted), both snippets are emitted so either
 * fence can be applied.
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
