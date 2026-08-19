/**
 * `.mstarc` — repo-local Morning Star harness config file (gitignored by
 * default, plan-conventions § Git 跟踪策略). INI-shaped; the `[config]`
 * section declares the harness directory symbols:
 *
 *   [config]
 *   harness_dir=.custom_dir
 *   plan_dir=planning
 *   specs_dir=specs/custom
 *
 * Supported keys (each resolves against the `.mstarc` file's own
 * directory; absolute paths allowed):
 *
 * | key            | symbol            | engine reader                    |
 * |----------------|-------------------|----------------------------------|
 * | `harness_dir`  | `{HARNESS_DIR}`   | `resolveHarnessDir`              |
 * | `plan_dir`     | `{PLAN_DIR}`      | `resolvePlanDir`                 |
 * | `sdd_dir`      | `{SDD_DIR}` base  | `resolveSddDir` (per-plan join)  |
 * | `iteration_dir`| `{ITERATION_DIR}` | `resolveIterationDir`            |
 * | `knowledge_dir`| `{KNOWLEDGE_DIR}` | `resolveKnowledgeDir`            |
 * | `specs_dir`    | `{SPECS_DIR}`     | `resolveSpecsDir` (authoritative)|
 * | `workflow_dir` | `{WORKFLOW_DIR}`  | `resolveWorkflowDir`            |
 * | `project_dir`  | `{PROJECT_DIR}`   | `resolveProjectDir`             |
 * | `enforcement`  | hard-gate policy  | `resolveRepoEnforcement`        |
 *
 * Resolution precedence (plan-conventions § {HARNESS_DIR} 解析顺序):
 * explicit `opts.harnessDir` / `MSTAR_HARNESS_DIR` wins, then `.mstarc`,
 * then the probe. Sub-directory keys are honored by the engine resolvers
 * when the nearest `.mstarc` sits at the harness dir or its parent (the
 * repo root — the documented `.mstarc` home). `enforcement` follows the
 * same discovery: `hard` / `soft` (anything else is ignored) — the
 * repo-declared hard-gate policy, composed below the explicit Config /
 * Assignment flag and above the iteration compass.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Canonical config file name. */
export const MSTARC_FILE = ".mstarc";
/** INI section holding the harness config. */
export const MSTARC_SECTION = "config";
/** `[config]` key declaring the harness root. */
export const MSTARC_HARNESS_DIR_KEY = "harness_dir";
/** `[config]` key declaring `{PLAN_DIR}`. */
export const MSTARC_PLAN_DIR_KEY = "plan_dir";
/** `[config]` key declaring the `{SDD_DIR}` per-plan base. */
export const MSTARC_SDD_DIR_KEY = "sdd_dir";
/** `[config]` key declaring `{ITERATION_DIR}`. */
export const MSTARC_ITERATION_DIR_KEY = "iteration_dir";
/** `[config]` key declaring `{KNOWLEDGE_DIR}`. */
export const MSTARC_KNOWLEDGE_DIR_KEY = "knowledge_dir";
/** `[config]` key declaring `{SPECS_DIR}`. */
export const MSTARC_SPECS_DIR_KEY = "specs_dir";
/** `[config]` key declaring `{WORKFLOW_DIR}` (v3 workflow lifecycle layout). */
export const MSTARC_WORKFLOW_DIR_KEY = "workflow_dir";
/** `[config]` key declaring `{PROJECT_DIR}` (v3 project roadmap/register). */
export const MSTARC_PROJECT_DIR_KEY = "project_dir";
/** `[config]` key declaring the repo hard-gate policy (`hard` / `soft`). */
export const MSTARC_ENFORCEMENT_KEY = "enforcement";

/** Parsed `.mstarc` harness config (unknown sections/keys are ignored). */
export type MstarcConfig = {
  /** Declared harness root, relative to the `.mstarc` directory or absolute. */
  harnessDir?: string;
  /** Declared `{PLAN_DIR}`. */
  planDir?: string;
  /** Declared `{SDD_DIR}` base (the per-plan dir joins `<plan-id>`). */
  sddDir?: string;
  /** Declared `{ITERATION_DIR}`. */
  iterationDir?: string;
  /** Declared `{KNOWLEDGE_DIR}`. */
  knowledgeDir?: string;
  /** Declared `{SPECS_DIR}` (authoritative — skips the candidate chain). */
  specsDir?: string;
  /** Declared `{WORKFLOW_DIR}` (v3 workflow snapshots live under it). */
  workflowDir?: string;
  /** Declared `{PROJECT_DIR}` (v3 project roadmap + register live under it). */
  projectDir?: string;
  /** Declared hard-gate policy — `hard` or `soft` (anything else ignored). */
  enforcement?: "hard" | "soft";
};

/** `[config]` key → config field mapping (unknown keys ignored). */
const CONFIG_KEYS: Record<string, keyof MstarcConfig> = {
  [MSTARC_HARNESS_DIR_KEY]: "harnessDir",
  [MSTARC_PLAN_DIR_KEY]: "planDir",
  [MSTARC_SDD_DIR_KEY]: "sddDir",
  [MSTARC_ITERATION_DIR_KEY]: "iterationDir",
  [MSTARC_KNOWLEDGE_DIR_KEY]: "knowledgeDir",
  [MSTARC_SPECS_DIR_KEY]: "specsDir",
  [MSTARC_WORKFLOW_DIR_KEY]: "workflowDir",
  [MSTARC_PROJECT_DIR_KEY]: "projectDir",
  [MSTARC_ENFORCEMENT_KEY]: "enforcement",
};

/**
 * Parse `.mstarc` text — minimal INI subset: `#`/`;` comments, `[section]`
 * headers, `key=value` pairs (trimmed). Only the `[config]` section is
 * read; unknown keys are ignored (forward compatibility). The last
 * occurrence of a key wins; an empty value is treated as unset.
 */
export function parseMstarc(text: string): MstarcConfig {
  let section: string | null = null;
  const out: MstarcConfig = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1].trim();
      continue;
    }
    if (section !== MSTARC_SECTION) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const field = CONFIG_KEYS[line.slice(0, eq).trim()];
    if (field === undefined) continue;
    const value = line.slice(eq + 1).trim();
    if (value === "") continue;
    // `enforcement` accepts only `hard` / `soft` — anything else is ignored
    // (the resolver treats it as unset; documented in plan-conventions).
    if (field === "enforcement" && value !== "hard" && value !== "soft") continue;
    (out as Record<string, string>)[field] = value;
  }
  return out;
}

/** True when `file` is an existing regular file. */
function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the nearest `.mstarc` walking up from `startDir`, never above
 * `boundary` (find-first-stop, mirroring the `{HARNESS_DIR}` probe stop
 * rule — plan-conventions § {HARNESS_DIR} 解析顺序: a config above the
 * workspace root is never adopted, same class as the `~/.mstar`
 * global-collision defect). Returns the absolute file path, or `null`.
 */
export function findMstarc(startDir: string, boundary: string): string | null {
  let dir = resolve(startDir);
  const bound = resolve(boundary);
  for (;;) {
    if (!isAtOrBelow(dir, bound)) return null;
    const candidate = join(dir, MSTARC_FILE);
    if (isFile(candidate)) return candidate;
    if (dir === bound) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A discovered `.mstarc` plus its parsed config. */
export type LoadedMstarc = {
  /** Absolute path of the `.mstarc` file. */
  file: string;
  /** Directory containing the `.mstarc` file — base for relative values. */
  dir: string;
  /** Parsed `[config]` contents. */
  config: MstarcConfig;
};

/**
 * Find + parse the nearest `.mstarc` at or below `boundary` from
 * `startDir`. Returns `null` when no config exists in scope.
 */
export function loadMstarc(startDir: string, boundary: string): LoadedMstarc | null {
  const file = findMstarc(startDir, boundary);
  if (file === null) return null;
  return { file, dir: dirname(file), config: parseMstarc(readFileSync(file, "utf8")) };
}

/** True when `dir` is `root` itself or a descendant of `root` (lexical). */
function isAtOrBelow(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
