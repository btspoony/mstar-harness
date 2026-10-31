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
/** `[linear]` — provider connection settings (never a Linear project name). */
export const LINEAR_SECTION = "linear";
/** `[linear.mapping]` — optional per-value correspondence override. */
export const LINEAR_MAPPING_SECTION = "linear.mapping";
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
/** `[config]` key declaring `{REVIEW_DIR}` (codebase-audit / PR-review run reports). */
export const MSTARC_REVIEW_DIR_KEY = "review_dir";
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
  /** Declared `{REVIEW_DIR}` (review run reports live under it). */
  reviewDir?: string;
  /** Declared hard-gate policy — `hard` or `soft` (anything else ignored). */
  enforcement?: "hard" | "soft";
  /** Raw Jev mode; interpretation belongs to the judgment runtime. */
  jevMode?: string;
  /** Raw Jev transport; interpretation belongs to the judgment runtime. */
  jevTransport?: string;
  /** Raw `[linear]` connection keys (unvalidated; see `parseLinearBinding`). */
  linear?: Record<string, string>;
  /** Raw `[linear.mapping]` override keys (unvalidated). */
  linearMapping?: Record<string, string>;
};

/** String-valued `[config]` keys — the resolvers' override surface; the
 * additive linear sections are records, never directory overrides. */
export type MstarcStringKey = {
  [K in keyof MstarcConfig]-?: MstarcConfig[K] extends string | undefined ? K : never;
}[keyof MstarcConfig];

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
  [MSTARC_REVIEW_DIR_KEY]: "reviewDir",
  [MSTARC_ENFORCEMENT_KEY]: "enforcement",
  jev_mode: "jevMode",
  jev_transport: "jevTransport",
};

/**
 * Parse `.mstarc` text — minimal INI subset: `#`/`;` comments, `[section]`
 * headers, `key=value` pairs (trimmed). Only the `[config]` section is
 * read; unknown keys are ignored (forward compatibility). The last
 * occurrence of a key wins; empty values are unset, with Jev keys clearing
 * any earlier value.
 */
export function parseMstarc(text: string): MstarcConfig {
  let section: string | null = null;
  const out: MstarcConfig = {};
  const linear: Record<string, string> = {};
  const linearMapping: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1].trim();
      continue;
    }
    // Additive linear sections (binding-config plan): collected alongside
    // `[config]`; unknown sections stay ignored (forward compatibility).
    if (section === LINEAR_SECTION || section === LINEAR_MAPPING_SECTION) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === "" || value === "") continue;
      (section === LINEAR_SECTION ? linear : linearMapping)[key] = value;
      continue;
    }
    if (section !== MSTARC_SECTION) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const field = CONFIG_KEYS[line.slice(0, eq).trim()];
    if (field === undefined) continue;
    const value = line.slice(eq + 1).trim();
    if (value === "") {
      if (field === "jevMode" || field === "jevTransport") delete out[field];
      continue;
    }
    // `enforcement` accepts only `hard` / `soft` — anything else is ignored
    // (the resolver treats it as unset; documented in plan-conventions).
    if (field === "enforcement" && value !== "hard" && value !== "soft") continue;
    (out as Record<string, string>)[field] = value;
  }
  if (Object.keys(linear).length > 0) out.linear = linear;
  if (Object.keys(linearMapping).length > 0) out.linearMapping = linearMapping;
  return out;
}

/** Provider correspondence facet for one engine value. */
export type LinearFacetMapping = {
  disposition: Record<string, string>;
  kind: Record<string, string>;
  severity: Record<string, string>;
};

/** Validated `[linear]` connection block (the only form consumers may use). */
export type LinearBinding = {
  enabled: boolean;
  mode: "mirror";
  workspace: string;
  team: string;
  /** Resolved correspondence: defaults overlaid by `[linear.mapping]`. */
  mapping: LinearFacetMapping;
};

/** Refusal for an invalid `[linear]` block (house dotted-lowercase codes). */
export type LinearBindingRefusal = {
  ok: false;
  code: "linear.mode-refused" | "linear.binding-incomplete" | "linear.binding-invalid";
  message: string;
};

/** Built-in default correspondence — identity per facet (lossy by design). */
export function defaultLinearMapping(): LinearFacetMapping {
  return { disposition: {}, kind: {}, severity: {} };
}

const LINEAR_MAPPING_FACETS = ["disposition", "kind", "severity"] as const;

/** Accepted boolean spellings (case-insensitive); anything else is refused. */
export const BOOLEAN_TRUE = ["true", "1", "yes", "on"] as const;
export const BOOLEAN_FALSE = ["false", "0", "no", "off"] as const;

/** Read one INI boolean, or `null` when the value is not a boolean spelling. */
function parseBoolean(raw: string | undefined): boolean | null {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if ((BOOLEAN_TRUE as readonly string[]).includes(value)) return true;
  if ((BOOLEAN_FALSE as readonly string[]).includes(value)) return false;
  return null;
}

/**
 * Validate the raw `[linear]` / `[linear.mapping]` sections collected by
 * `parseMstarc`. An absent `[linear]` section yields `ok: true` with
 * `enabled: false` (binding is opt-in). Refusals name the offending key;
 * unknown `[linear.mapping]` keys are ignored (same forward-compatibility
 * rule as unknown `[config]` keys).
 */
export function parseLinearBinding(
  linear: Record<string, string> | undefined,
  mapping: Record<string, string> | undefined,
): { ok: true; binding: LinearBinding } | LinearBindingRefusal {
  if (linear === undefined) {
    return { ok: true, binding: { enabled: false, mode: "mirror", workspace: "", team: "", mapping: defaultLinearMapping() } };
  }
  const mode = linear.mode ?? "mirror";
  if (mode !== "mirror") {
    return {
      ok: false,
      code: "linear.mode-refused",
      message: `linear.mode-refused: [linear] mode "${mode}" is not supported; only "mirror" is accepted this iteration`,
    };
  }
  const parsedEnabled = parseBoolean(linear.enabled);
  if (parsedEnabled === null) {
    // A value nobody can read is refused by name: silently treating `TRUE` or
    // `1` as "off" would misdiagnose a deliberately enabled binding.
    return {
      ok: false,
      code: "linear.binding-invalid",
      message: `linear.binding-invalid: [linear] enabled="${linear.enabled}" is not a boolean; accepted spellings are ${BOOLEAN_TRUE.join(", ")} / ${BOOLEAN_FALSE.join(", ")} (case-insensitive)`,
    };
  }
  const enabled = parsedEnabled;
  const workspace = linear.workspace ?? "";
  const team = linear.team ?? "";
  if (enabled && (workspace === "" || team === "")) {
    const missing = [workspace === "" ? "workspace" : null, team === "" ? "team" : null].filter(Boolean).join(", ");
    return {
      ok: false,
      code: "linear.binding-incomplete",
      message: `linear.binding-incomplete: enabled=true requires [linear] ${missing} to be set`,
    };
  }
  const facet = (): LinearFacetMapping => ({ disposition: {}, kind: {}, severity: {} });
  const resolved = facet();
  for (const [key, value] of Object.entries(mapping ?? {})) {
    const dot = key.indexOf(".");
    const prefix = dot === -1 ? "" : key.slice(0, dot);
    if (!(LINEAR_MAPPING_FACETS as readonly string[]).includes(prefix)) continue;
    resolved[prefix as keyof LinearFacetMapping][key.slice(dot + 1)] = value;
  }
  return { ok: true, binding: { enabled, mode: "mirror", workspace, team, mapping: resolved } };
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

/**
 * The repo's own `[linear]` connection block, or a NAMED absence (§ F4).
 *
 * The `.mstarc` home is the repo root — the harness dir's parent. This reader
 * NEVER walks up: a parent directory's `.mstarc` (in a worktree layout, another
 * repo's binding) must not become this repo's connection identity, so a config
 * that is not the repo's own is treated as absent rather than discovered.
 */
export type RepoLinearBinding =
  | { kind: "bound"; file: string; binding: LinearBinding }
  | { kind: "absent"; code: "linear.binding-absent"; message: string }
  | { kind: "invalid"; code: LinearBindingRefusal["code"]; message: string };

/** `[linear]` from `<repo-root>/.mstarc` only; never a parent's configuration. */
export function readRepoLinearBinding(harnessDir: string): RepoLinearBinding {
  const repoRoot = dirname(resolve(harnessDir));
  const file = join(repoRoot, MSTARC_FILE);
  if (!isFile(file)) {
    return {
      kind: "absent",
      code: "linear.binding-absent",
      message: `linear.binding-absent: no ${MSTARC_FILE} at the repo root ${repoRoot}; a parent directory's configuration is never inherited`,
    };
  }
  const config = parseMstarc(readFileSync(file, "utf8"));
  if (config.linear === undefined) {
    return {
      kind: "absent",
      code: "linear.binding-absent",
      message: `linear.binding-absent: ${file} declares no [${LINEAR_SECTION}] connection block`,
    };
  }
  const parsed = parseLinearBinding(config.linear, config.linearMapping);
  if (!parsed.ok) return { kind: "invalid", code: parsed.code, message: parsed.message };
  return { kind: "bound", file, binding: parsed.binding };
}
