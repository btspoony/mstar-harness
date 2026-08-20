/**
 * Engine path module — harness directory discovery, spec/plan/sdd/iteration
 * path composition, v3 workflow/project dir resolution, scaffold
 * generation, canonical `.gitignore` snippet and the plan-writing path
 * gate.
 *
 * Spec source: `skills/mstar-plan-conventions/SKILL.md` § 路径符号 (SSOT),
 * § {HARNESS_DIR} 解析顺序（找到即停）, § {SPECS_DIR} 解析（找到非空目录即停）
 * and § Git 跟踪策略 / § Plan-Writing Path Gate. Resolution order stays
 * `.mstarc` `[config] harness_dir` → `.mstar/` → `.agents/` → `.plans/`/
 * `plans/` per consumer convention; the explicit harness-root override
 * (`MSTAR_HARNESS_DIR` env / `opts.harnessDir`) covers repos whose harness
 * root is not one of the probed names (slice-2 plan finding 2026-08-08) and
 * stays the highest authority (above `.mstarc`).
 *
 * Workspace-root stop boundary (roadmap §7c, plan
 * 20260810-harness-root-boundary): `resolveHarnessDir` NEVER walks above the
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
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readJson, writeJson, type ValidationResult } from "./core.js";
import { loadMstarc, type MstarcConfig } from "./mstarc.js";

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
   * Workspace-root stop boundary (roadmap §7c / plan
   * 20260810-harness-root-boundary). The upward probe keeps walking only
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
 * (qc2 F-001 — path traversal guard): rejects `""`, `.`, `..`, and any
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
      `harness dir not found from ${resolve(startDir)} \u2014 cannot resolve the ${fallback} dir (run \`mstar init\`, pass opts.harnessDir, or set MSTAR_HARNESS_DIR)`,
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
 * Deferred-by-design (qc1 S-3): the startDir-first signature is asymmetric
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
 * `resolveWorkflowDir` (qc1 S-3).
 */
export function resolveProjectDir(
  startDir: string = process.cwd(),
  opts: ResolveHarnessDirOptions = {},
): string {
  return resolveHarnessSubdir(startDir, opts, "projectDir", "projects");
}

/**
 * Empty status.json template — embedded copy of
 * `skills/mstar-plan-artifacts/templates/status.empty.json`
 * (plan-conventions § 初始化 Plan 目录). Plan Task 3 ruling: the template is
 * the **v2 shape** (`version: 2`, `updated_at`, `workflows: []`) so
 * `scaffoldHarness` never emits an un-migrated (v1) tree. Kept as a constant
 * so the engine has no runtime dependency on skill files.
 */
const EMPTY_STATUS_TEMPLATE: Record<string, unknown> = {
  version: 2,
  updated_at: "1970-01-01",
  workflows: [],
};

/** Subdirectories created under `.mstar/` by `scaffoldHarness`. */
const SCAFFOLD_DIRS = ["plans", "iterations", "knowledge", "specs", "sdd"] as const;

/**
 * Initialize the harness directory under `root`: create `.mstar/` with
 * `plans/`, `iterations/`, `knowledge/`, `specs/`, `sdd/` and write
 * `status.json` from the empty template (plan-conventions § 初始化 Plan 目录).
 * Idempotent: an existing non-empty `status.json` is never clobbered.
 * Returns the absolute harness dir.
 */
export function scaffoldHarness(root: string): string {
  const harnessDir = join(resolve(root), ".mstar");
  for (const dir of SCAFFOLD_DIRS) mkdirSync(join(harnessDir, dir), { recursive: true });
  const statusPath = join(harnessDir, "status.json");
  // readJson treats a missing file as `{}`, so a missing (or empty) status.json
  // is replaced with the empty template; anything with content is preserved.
  if (Object.keys(readJson(statusPath)).length === 0) writeJson(statusPath, EMPTY_STATUS_TEMPLATE);
  return harnessDir;
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
 * Validate that `<root>/.gitignore` contains a complete canonical
 * harness ignore set — default-ignore `<dir>/**` plus the tracked
 * re-includes (AGENTS.md, knowledge/, specs/) per plan-conventions
 * § Git 跟踪策略. Rule
 * (chosen alignment): the gate passes when the repo's .gitignore holds ONE
 * complete set for the DETECTED harness kind — `.mstar/` for a `.mstar`
 * harness, `.agents/` for a legacy `.agents` harness; layouts without a
 * canonical snippet (rung-3 `.plans`/`plans`, or no harness yet) accept
 * either complete set. This is deliberately per-kind, unlike the CLI `init`
 * fence which requires BOTH prefixes (flat dual-entry list — packages/cli
 * src/adapters/shared-install.ts HARNESS_PROCESS_GITIGNORE); a repo fenced
 * for one layout still passes here. Extra entries are fine; any missing
 * entry of the required set is a violation. Non-blocking: returns a
 * `ValidationResult` (v1 enforcement depth, roadmap §8.5).
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
  const lines = new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const mstarMissing = GITIGNORE_PROCESS_ENTRIES.filter((entry) => !lines.has(entry));
  const agentsMissing = GITIGNORE_PROCESS_ENTRIES_AGENTS.filter((entry) => !lines.has(entry));
  let missing: readonly string[];
  let label: string;
  if (kind === "agents") {
    missing = agentsMissing;
    label = ".agents/ set";
  } else if (kind === "mstar") {
    missing = mstarMissing;
    label = ".mstar/ set";
  } else {
    // Unknown kind — either complete set passes; report the set needing the
    // fewest additions (completing either one clears the gate).
    label = "either .mstar/ or .agents/ set";
    missing =
      mstarMissing.length === 0 || agentsMissing.length === 0
        ? []
        : mstarMissing.length <= agentsMissing.length
          ? mstarMissing
          : agentsMissing;
  }
  if (missing.length > 0) {
    return {
      ok: false,
      severity: "medium",
      code: "gitignore.missing-entries",
      message: `.gitignore at ${gitignorePath} is missing canonical harness ignore entries (${label}): ${missing.join(", ")}`,
      fix: `append the canonical snippet (emitGitignoreSnippet(${kind ? `"${kind}"` : ""})) to ${gitignorePath}`,
    };
  }
  return {
    ok: true,
    severity: "low",
    code: "gitignore.ok",
    message: `.gitignore at ${gitignorePath} contains a complete canonical harness ignore set \u2014 default-ignore + tracked re-includes (${label})`,
  };
}

/** Detect the gitignore fence kind from a resolved harness dir (basename). */
function detectHarnessKind(harnessDir: string | null): HarnessKind | null {
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
