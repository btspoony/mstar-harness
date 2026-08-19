/**
 * `.mstarc` — repo-local Morning Star harness config file (gitignored by
 * default, plan-conventions § Git 跟踪策略). INI-shaped; the only
 * meaningful section today is `[config]`:
 *
 *   [config]
 *   harness_dir=.custom_dir
 *
 * `harness_dir` declares the harness root — resolved against the `.mstarc`
 * file's own directory (absolute paths allowed). Repos whose harness root
 * is not a probed name (`.mstar/` → `.agents/` → `.plans/`/`plans/`) can
 * declare it programmatically instead of per-session env/CLI plumbing.
 *
 * Resolution precedence (plan-conventions § {HARNESS_DIR} 解析顺序):
 * explicit `opts.harnessDir` / `MSTAR_HARNESS_DIR` wins, then `.mstarc`,
 * then the probe.
 */
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Canonical config file name. */
export const MSTARC_FILE = ".mstarc";
/** INI section holding the harness config. */
export const MSTARC_SECTION = "config";
/** `[config]` key declaring the harness root. */
export const MSTARC_HARNESS_DIR_KEY = "harness_dir";

/** Parsed `.mstarc` harness config (unknown sections/keys are ignored). */
export type MstarcConfig = {
  /** Declared harness root, relative to the `.mstarc` directory or absolute. */
  harnessDir?: string;
};

/**
 * Parse `.mstarc` text — minimal INI subset: `#`/`;` comments, `[section]`
 * headers, `key=value` pairs (trimmed). Only the `[config]` section is
 * read; unknown keys are ignored (forward compatibility). The last
 * `harness_dir` wins; an empty value is treated as unset.
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
    if (line.slice(0, eq).trim() !== MSTARC_HARNESS_DIR_KEY) continue;
    const value = line.slice(eq + 1).trim();
    if (value !== "") out.harnessDir = value;
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

/** True when `dir` is `root` itself or a descendant of `root` (lexical). */
function isAtOrBelow(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
