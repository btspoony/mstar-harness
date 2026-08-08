/**
 * Engine compound module — knowledge-doc frontmatter schema validation,
 * reference existence checks, index-row obligations, and compound-refresh
 * scope guarding.
 *
 * Spec sources (all embedded as constants — no runtime skill-file reads):
 * - mstar-compound/references/schema.yaml: required/optional frontmatter
 *   fields, problem_type enum, severity enum, track rules (bug vs
 *   knowledge), resolution_type enum, tags max 8.
 * - mstar-compound/references/category-mapping.md: problem_type → category
 *   directory mapping (rule 1: category must match the directory name).
 * - mstar-compound SKILL.md Phase 6: every doc gets a row in
 *   `{KNOWLEDGE_DIR}/README.md` (Document / Source Plan / Description /
 *   Status).
 * - mstar-compound-refresh SKILL.md § 产物与操作路径 (scope SSOT): only
 *   `{HARNESS_DIR}/knowledge/**` + `*.md` files, `knowledge/README.md`,
 *   `<repo-root>/CONCEPTS.md` + `{HARNESS_DIR}/status.json`.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GateResult, ValidationResult } from "./core.js";

function violation(severity: ValidationResult["severity"], code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

// ---------------------------------------------------------------------------
// schema.yaml rules (embedded constants)
// ---------------------------------------------------------------------------

/** Required frontmatter fields (schema.yaml required_fields). */
export const KNOWLEDGE_REQUIRED_FIELDS = ["module", "date", "problem_type", "category", "severity"] as const;

/** All problem_type enum values (bug track + knowledge track). */
export const KNOWLEDGE_PROBLEM_TYPES = [
  "build_error",
  "test_failure",
  "runtime_error",
  "performance_issue",
  "database_issue",
  "security_issue",
  "ui_bug",
  "integration_issue",
  "logic_error",
  "config_error",
  "developer_experience",
  "workflow_issue",
  "best_practice",
  "documentation_gap",
  "architecture_pattern",
  "design_pattern",
  "tooling_decision",
  "convention",
  "api_design",
  "testing_pattern",
] as const;

/** Bug-track problem_types (schema.yaml tracks.bug). */
export const KNOWLEDGE_BUG_PROBLEM_TYPES = [
  "build_error",
  "test_failure",
  "runtime_error",
  "performance_issue",
  "database_issue",
  "security_issue",
  "ui_bug",
  "integration_issue",
  "logic_error",
  "config_error",
] as const;

/** Knowledge-track problem_types (schema.yaml tracks.knowledge). */
export const KNOWLEDGE_KNOWLEDGE_PROBLEM_TYPES = [
  "developer_experience",
  "workflow_issue",
  "best_practice",
  "documentation_gap",
  "architecture_pattern",
  "design_pattern",
  "tooling_decision",
  "convention",
  "api_design",
  "testing_pattern",
] as const;

/** Severity enum (schema.yaml required_fields.severity). */
export const KNOWLEDGE_SEVERITIES = ["critical", "high", "medium", "low"] as const;

/** Bug-track resolution_type enum (schema.yaml track_rules.bug). */
export const KNOWLEDGE_RESOLUTION_TYPES = [
  "code_fix",
  "migration",
  "config_change",
  "test_fix",
  "dependency_update",
  "environment_setup",
  "workflow_improvement",
  "documentation_update",
  "tooling_addition",
] as const;

/** problem_type → category directory (category-mapping.md; rule 1: the
 * frontmatter `category` must match the mapped directory name). */
export const KNOWLEDGE_CATEGORY_MAP: Readonly<Record<string, string>> = {
  build_error: "build-errors",
  test_failure: "test-failures",
  runtime_error: "runtime-errors",
  performance_issue: "performance-issues",
  database_issue: "database-issues",
  security_issue: "security-issues",
  ui_bug: "ui-bugs",
  integration_issue: "integration-issues",
  logic_error: "logic-errors",
  config_error: "config-errors",
  best_practice: "best-practices",
  convention: "conventions",
  architecture_pattern: "architecture-patterns",
  design_pattern: "design-patterns",
  tooling_decision: "tooling-decisions",
  testing_pattern: "testing-patterns",
  api_design: "api-design",
  workflow_issue: "workflow-patterns",
  developer_experience: "developer-experience",
  documentation_gap: "documentation",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// YAML-lite frontmatter parsing (maps + lists, comments skipped)
// ---------------------------------------------------------------------------

type YamlScalar = string | number | boolean;
type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

type Line = { indent: number; text: string };

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseScalar(raw: string): YamlScalar {
  const trimmed = raw.trim();
  const quoted = /^"([^"]*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
  if (quoted) return quoted[1];
  const cut = trimmed.split(/\s+#/)[0].trim();
  if (/^-?\d+(?:\.\d+)?$/.test(cut)) return Number(cut);
  if (/^(?:true|false)$/.test(cut)) return cut === "true";
  return cut;
}

function parseMapBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const map: Record<string, YamlValue> = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const match = /^([^:]+):(.*)$/.exec(lines[i].text);
    if (match === null) {
      i++;
      continue;
    }
    const key = parseScalar(match[1].trim()).toString();
    const rest = match[2].trim();
    if (rest === "") {
      const nested = i + 1 < lines.length && lines[i + 1].indent > indent;
      if (nested) {
        const child = parseBlock(lines, i + 1, lines[i + 1].indent);
        map[key] = child.value;
        i = child.next;
      } else {
        map[key] = "";
        i++;
      }
    } else {
      map[key] = parseScalar(rest);
      i++;
    }
  }
  return { value: map, next: i };
}

function parseListBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const list: YamlValue[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("-")) {
    const rest = lines[i].text.slice(1).trim();
    const match = /^([^:]+):(.*)$/.exec(rest);
    if (match !== null && match[2].trim() === "" && i + 1 < lines.length && lines[i + 1].indent > indent) {
      const child = parseBlock(lines, i + 1, lines[i + 1].indent);
      list.push({ [parseScalar(match[1].trim()).toString()]: child.value });
      i = child.next;
    } else if (match !== null) {
      list.push({ [parseScalar(match[1].trim()).toString()]: parseScalar(match[2].trim()) });
      i++;
    } else {
      list.push(parseScalar(rest));
      i++;
    }
  }
  return { value: list, next: i };
}

function parseBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  if (lines[start] !== undefined && lines[start].text.startsWith("-")) return parseListBlock(lines, start, indent);
  return parseMapBlock(lines, start, indent);
}

/** Parse a `---`-fenced YAML frontmatter into a map (scalars, nested maps,
 * block lists, flow lists). Comment lines are skipped. Returns null when no
 * block or no top-level keys are found. */
function parseYamlLite(text: string): Record<string, unknown> | null {
  const body = text.replace(/^\uFEFF/, "");
  const lines = body.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].trim().startsWith("---")) return null;
  const inner: Line[] = [];
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---") break;
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = lines[i].match(/^ */)![0].length;
    inner.push({ indent, text: lines[i].slice(indent) });
  }
  if (inner.length === 0) return null;
  const top = parseBlock(inner, 0, inner[0].indent);
  if (!isMap(top.value)) return null;
  return top.value;
}

// ---------------------------------------------------------------------------
// validateSchemaYaml — schema.yaml + category-mapping.md
// ---------------------------------------------------------------------------

/**
 * Validate a knowledge-doc frontmatter against the schema.yaml contract
 * (embedded constants — no runtime skill-file reads):
 * required fields (module, date, problem_type, category, severity), enum
 * values, track rules (bug track needs symptoms / root_cause /
 * resolution_type), category↔problem_type mapping consistency, and optional
 * fields (plan_id, tags ≤ 8, last_updated, related_components).
 *
 * Violation codes:
 * - `compound.schema.missing-frontmatter` — no `---` block
 * - `compound.schema.missing-field` — required field absent/empty
 * - `compound.schema.invalid-date` / `invalid-problem-type` /
 *   `invalid-severity` / `invalid-resolution-type`
 * - `compound.schema.category-mismatch` — category ≠ mapping for
 *   problem_type (category-mapping.md rule 1)
 * - `compound.schema.missing-track-field` — bug track missing
 *   symptoms/root_cause/resolution_type
 * - `compound.schema.invalid-symptoms` / `invalid-root-cause` /
 *   `invalid-applies-when` / `invalid-plan-id` / `invalid-tags` /
 *   `tags-too-many` / `invalid-last-updated` / `invalid-related-components`
 */
export function validateSchemaYaml(frontmatterText: string): GateResult {
  const violations: ValidationResult[] = [];
  const doc = parseYamlLite(frontmatterText);
  if (doc === null) {
    violations.push(
      violation(
        "medium",
        "compound.schema.missing-frontmatter",
        "no `---` YAML frontmatter block found — knowledge docs must open with the schema.yaml contract (mstar-compound/references/schema.yaml)",
        "add the fenced frontmatter with module, date, problem_type, category, severity",
      ),
    );
    return { ok: false, violations };
  }

  const isStr = (v: unknown): v is string => typeof v === "string";
  const missing = (field: string) =>
    violations.push(
      violation(
        "medium",
        "compound.schema.missing-field",
        `missing required frontmatter field "${field}" (schema.yaml required_fields)`,
        `add \`${field}: <value>\` to the frontmatter`,
      ),
    );

  for (const field of KNOWLEDGE_REQUIRED_FIELDS) {
    if (!(field in doc) || doc[field] === "") missing(field);
  }

  // Non-string values on enum/pattern fields are violations, not silent
  // passes — YAML-lite parses `date: 20260808` as a number, which is not a
  // valid date (qc3 F-003 / qc2 F-007).
  if (doc.date !== undefined && (!isStr(doc.date) || !DATE_RE.test(doc.date))) {
    violations.push(
      violation("medium", "compound.schema.invalid-date", `date "${String(doc.date)}" must be a YYYY-MM-DD string (schema.yaml required_fields.date)`, "use `YYYY-MM-DD`"),
    );
  }

  const problemType = doc.problem_type;
  if (problemType !== undefined && !isStr(problemType)) {
    violations.push(
      violation(
        "medium",
        "compound.schema.invalid-problem-type",
        `problem_type "${String(problemType)}" must be a string — one of the schema.yaml enum values (bug: build_error…config_error; knowledge: developer_experience…testing_pattern)`,
        "pick the narrowest applicable problem_type from schema.yaml",
      ),
    );
  }
  const problemTypeValid = isStr(problemType) && (KNOWLEDGE_PROBLEM_TYPES as readonly string[]).includes(problemType);
  if (isStr(problemType) && !problemTypeValid) {
    violations.push(
      violation(
        "medium",
        "compound.schema.invalid-problem-type",
        `problem_type "${problemType}" is not one of the schema.yaml enum values (bug: build_error…config_error; knowledge: developer_experience…testing_pattern)`,
        "pick the narrowest applicable problem_type from schema.yaml",
      ),
    );
  }
  if (doc.severity !== undefined && !isStr(doc.severity)) {
    violations.push(
      violation("medium", "compound.schema.invalid-severity", `severity "${String(doc.severity)}" must be a string — critical | high | medium | low (schema.yaml required_fields.severity)`, "use one of the four severity values"),
    );
  }
  if (isStr(doc.severity) && !(KNOWLEDGE_SEVERITIES as readonly string[]).includes(doc.severity)) {
    violations.push(
      violation("medium", "compound.schema.invalid-severity", `severity "${doc.severity}" must be critical | high | medium | low (schema.yaml required_fields.severity)`, "use one of the four severity values"),
    );
  }
  if (problemTypeValid && isStr(doc.category)) {
    const expected = KNOWLEDGE_CATEGORY_MAP[problemType as string];
    if (doc.category !== expected) {
      violations.push(
        violation(
          "medium",
          "compound.schema.category-mismatch",
          `category "${doc.category}" does not match problem_type "${problemType}" — category-mapping.md rule 1 maps it to "${expected}"`,
          `set \`category: ${expected}\` (the directory name under {KNOWLEDGE_DIR})`,
        ),
      );
    }
  }

  if (problemTypeValid) {
    const isBug = (KNOWLEDGE_BUG_PROBLEM_TYPES as readonly string[]).includes(problemType as string);
    if (isBug) {
      for (const field of ["symptoms", "root_cause", "resolution_type"]) {
        if (!(field in doc)) {
          violations.push(
            violation(
              "medium",
              "compound.schema.missing-track-field",
              `bug-track doc missing required field "${field}" (schema.yaml track_rules.bug)`,
              `add \`${field}:\` to the frontmatter`,
            ),
          );
        }
      }
      if (doc.symptoms !== undefined && !Array.isArray(doc.symptoms)) {
        violations.push(violation("medium", "compound.schema.invalid-symptoms", "bug-track `symptoms` must be a YAML list (schema.yaml track_rules.bug)", "list the observable symptoms under `symptoms:`"));
      }
      if (doc.root_cause !== undefined && !isStr(doc.root_cause)) {
        violations.push(violation("medium", "compound.schema.invalid-root-cause", "bug-track `root_cause` must be a string (schema.yaml track_rules.bug)", "write the fundamental technical cause as a string"));
      }
      if (isStr(doc.resolution_type) && !(KNOWLEDGE_RESOLUTION_TYPES as readonly string[]).includes(doc.resolution_type)) {
        violations.push(
          violation("medium", "compound.schema.invalid-resolution-type", `resolution_type "${doc.resolution_type}" is not one of the schema.yaml track_rules.bug enum values`, "use code_fix | migration | config_change | test_fix | dependency_update | environment_setup | workflow_improvement | documentation_update | tooling_addition"),
        );
      }
    } else if (doc.applies_when !== undefined && !Array.isArray(doc.applies_when)) {
      violations.push(violation("low", "compound.schema.invalid-applies-when", "knowledge-track `applies_when` must be a YAML list when present (schema.yaml track_rules.knowledge)", "list the conditions under `applies_when:`"));
    }
  }

  if (doc.plan_id !== undefined && !isStr(doc.plan_id)) {
    violations.push(violation("low", "compound.schema.invalid-plan-id", "optional `plan_id` must be a string (schema.yaml optional_fields.plan_id)", "reference the status.json plan id as a string"));
  }
  if (doc.tags !== undefined) {
    if (!Array.isArray(doc.tags)) {
      violations.push(violation("low", "compound.schema.invalid-tags", "optional `tags` must be a YAML list (schema.yaml optional_fields.tags)", "list lowercase, hyphen-separated keywords"));
    } else if (doc.tags.length > 8) {
      violations.push(violation("low", "compound.schema.tags-too-many", `tags has ${doc.tags.length} entries — max 8 (schema.yaml optional_fields.tags.max_items)`, "trim the tag list to at most 8 keywords"));
    }
  }
  if (doc.last_updated !== undefined && (!isStr(doc.last_updated) || !DATE_RE.test(doc.last_updated))) {
    violations.push(violation("low", "compound.schema.invalid-last-updated", `last_updated "${String(doc.last_updated)}" must be YYYY-MM-DD (schema.yaml optional_fields.last_updated)`, "use `YYYY-MM-DD`"));
  }
  if (doc.related_components !== undefined && !Array.isArray(doc.related_components)) {
    violations.push(violation("low", "compound.schema.invalid-related-components", "optional `related_components` must be a YAML list (schema.yaml optional_fields.related_components)", "list the other components involved"));
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// referenceExists — compound-refresh Phase 2
// ---------------------------------------------------------------------------

/** Result of `referenceExists`: gate verdict + number of refs verified. */
export type ReferenceCheckResult = GateResult & { checked: number };

/** Known source/doc/config file extensions — a backticked token ending in
 * one is treated as a file path. */
const REF_EXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|md|markdown|json|jsonc|yaml|yml|toml|ini|cfg|sh|bash|zsh|py|go|rs|rb|java|kt|c|cpp|h|hpp|css|scss|sass|less|html|htm|vue|svelte|sql|graphql|env|example|gitignore|npmrc|lock|txt|svg|png|jpg|jpeg|webp|ico)$/i;
/** `module.symbol` ref shape (e.g. `core.validateStatus`). */
const SYMBOL_REF_RE = /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/;
/** URL / skill:// / file:// style refs — skipped (not repo paths). */
const SCHEME_RE = /^[a-zA-Z][\w+.-]*:\/\//;
/** Trailing `:42` / `:42-58` line refs on a path. */
const LINE_SUFFIX_RE = /:\d+(?:-\d+)?$/;
/** Trailing `#anchor` on a path. */
const ANCHOR_RE = /#[\w.-]+$/;
/** Directories never walked for module files. */
const WALK_SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
// simplify: bounded walk (5000 entries) so symbol heuristics stay cheap on
// large repos; raise the cap if module resolution misses in monorepos.
const MAX_WALK_FILES = 5000;

/**
 * Check that paths/functions referenced in a knowledge doc exist on disk
 * (compound-refresh Phase 2 item 1: "Referenced code still exists?").
 *
 * Backticked refs are classified conservatively:
 * - path-like refs (contain `/` or end in a known file extension) are
 *   resolved against `repoRoot` and must exist — `:line` suffixes and
 *   `#anchors` are stripped first; violation `compound.reference.missing-file`.
 * - `module.symbol` refs use a documented heuristic: a module file named
 *   `<module>.ts|tsx|js|jsx|mjs|cjs` must exist somewhere under `repoRoot`;
 *   violation `compound.reference.module-missing` (low severity — heuristic).
 * - URLs, `{PLACEHOLDER}` refs, globs, absolute paths, and bare symbols are
 *   skipped (not repo-relative, or not resolvable deterministically).
 * `checked` counts unique refs that verified.
 */
export function referenceExists(repoRoot: string, docText: string): ReferenceCheckResult {
  const violations: ValidationResult[] = [];
  let checked = 0;
  const seen = new Set<string>();

  // Collect every distinct backticked ref first, then resolve the distinct
  // module names with ONE bounded walk (O(files) once, not per module).
  const moduleNames = new Set<string>();
  const refs: { ref: string; isSymbol: boolean; module?: string }[] = [];
  for (const match of docText.matchAll(/`([^`\n]+)`/g)) {
    const ref = match[1].trim();
    if (ref === "" || seen.has(ref)) continue;
    seen.add(ref);
    if (
      SCHEME_RE.test(ref) ||
      ref.startsWith("{") ||
      ref.startsWith("#") ||
      ref.includes("*") ||
      ref.includes("?") ||
      ref.startsWith("~") ||
      isAbsolute(ref)
    ) {
      continue;
    }
    if (ref.includes("/") || REF_EXT_RE.test(ref)) {
      // Path-shaped refs first (`core.ts` is a file path, not a
      // `module.symbol` ref — same precedence as the pre-single-walk code).
      refs.push({ ref, isSymbol: false });
    } else if (SYMBOL_REF_RE.test(ref)) {
      const module = ref.split(".")[0];
      moduleNames.add(module);
      refs.push({ ref, isSymbol: true, module });
    }
  }

  const foundModules = new Set<string>();
  if (moduleNames.size > 0) {
    // simplify: bounded walk (5000 entries) so symbol heuristics stay cheap on
    // large repos; raise the cap if module resolution misses in monorepos.
    let walked = 0;
    const stack = [repoRoot];
    while (stack.length > 0 && walked < MAX_WALK_FILES) {
      const dir = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++walked > MAX_WALK_FILES) break;
        if (entry.isDirectory()) {
          if (!WALK_SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        } else if (!entry.isSymbolicLink()) {
          const base = entry.name.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
          if (moduleNames.has(base)) foundModules.add(base);
        }
      }
    }
  }

  for (const { ref, isSymbol, module } of refs) {
    if (!isSymbol || module === undefined) {
      const candidate = ref.replace(LINE_SUFFIX_RE, "").replace(ANCHOR_RE, "");
      if (existsSync(resolve(repoRoot, candidate))) {
        checked++;
      } else {
        violations.push(
          violation(
            "medium",
            "compound.reference.missing-file",
            `referenced path \`${ref}\` does not exist under ${repoRoot} (compound-refresh Phase 2: referenced code still exists?)`,
            "update the doc to reference an existing path, or delete the stale reference",
          ),
        );
      }
    } else if (foundModules.has(module)) {
      checked++;
    } else {
      violations.push(
        violation(
          "low",
          "compound.reference.module-missing",
          `symbol ref \`${ref}\` — heuristic: no ${module}.ts|tsx|js|jsx|mjs|cjs module file found under ${repoRoot} (compound-refresh Phase 2)`,
          "verify the module file exists, or update the reference",
        ),
      );
    }
  }

  return { ok: violations.length === 0, violations, checked };
}

// ---------------------------------------------------------------------------
// assertIndexRows — mstar-compound Phase 6 index obligations
// ---------------------------------------------------------------------------

/** Recursively collect knowledge doc paths (posix separators) under `dir`,
 * excluding `README.md` / `index.md` index files. Symlinks are skipped
 * (`withFileTypes` + `isSymbolicLink`) so a symlink cycle inside the
 * knowledge dir cannot hang the walk — same policy as the CLI lint walk.
 */
function collectKnowledgeDocs(dir: string): string[] {
  const docs: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".md") && entry.name !== "README.md" && entry.name !== "index.md") {
        docs.push(relative(dir, full).split(sep).join("/"));
      }
    }
  }
  return docs.sort();
}

/** Normalize one index-row first-cell reference: link targets, backticks,
 * `./` prefix, and repo-root `knowledge/` prefix. */
function normalizeIndexRef(cell: string): string {
  const link = /\[[^\]]*\]\(([^)]+)\)/.exec(cell);
  let value = link !== null ? link[1] : cell;
  value = value.replace(/`/g, "").replace(/^\.\//, "");
  if (value.startsWith("knowledge/")) value = value.slice("knowledge/".length);
  return value.trim();
}

/**
 * Assert every knowledge doc under `knowledgeDir` has a row in
 * `knowledgeDir/README.md` (mstar-compound SKILL.md Phase 6 index
 * obligations). Row first cells may be plain paths or `[title](path)`
 * links, with optional `./` / `knowledge/` prefixes. `README.md` and
 * `index.md` files are not docs.
 *
 * Violation codes:
 * - `compound.index.missing-readme` — no README.md index
 * - `compound.index.missing-row` — doc with no index row
 */
export function assertIndexRows(knowledgeDir: string): GateResult {
  const violations: ValidationResult[] = [];
  const readmePath = join(knowledgeDir, "README.md");
  if (!existsSync(readmePath)) {
    violations.push(
      violation(
        "medium",
        "compound.index.missing-readme",
        `missing ${readmePath} — the knowledge index is required (mstar-compound Phase 6: every doc gets a README.md row)`,
        "create knowledge/README.md with a Document / Source Plan / Description / Status table",
      ),
    );
    return { ok: false, violations };
  }

  const docs = collectKnowledgeDocs(knowledgeDir);
  const rows = new Set<string>();
  for (const line of readFileSync(readmePath, "utf8").split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 2) continue;
    const normalized = normalizeIndexRef(cells[1]);
    if (normalized !== "") rows.add(normalized);
  }

  for (const doc of docs) {
    if (!rows.has(doc)) {
      violations.push(
        violation(
          "medium",
          "compound.index.missing-row",
          `knowledge doc "${doc}" has no row in knowledge/README.md index (mstar-compound Phase 6 index obligations)`,
          `add a row \`| [<title>](${doc}) | <source plan> | <description> | <status> |\` to knowledge/README.md`,
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// scopeGuard — mstar-compound-refresh scope SSOT
// ---------------------------------------------------------------------------

/**
 * The compound-refresh scope (mstar-compound-refresh SKILL.md §
 * 产物与操作路径): `{HARNESS_DIR}/knowledge/**`, `knowledge/README.md`,
 * `<repo-root>/CONCEPTS.md`, `{HARNESS_DIR}/status.json`.
 */
export function compoundRefreshScope(harnessDir: string, projectRoot: string): string[] {
  return [
    join(harnessDir, "knowledge"),
    join(harnessDir, "knowledge", "README.md"),
    join(projectRoot, "CONCEPTS.md"),
    join(harnessDir, "status.json"),
  ];
}

/** True when the root path looks like a file (extension suffix) — exact
 * match required then, vs. directory containment otherwise. */
function isFileLikeRoot(root: string): boolean {
  return /^[^.]*\.[A-Za-z0-9]{1,10}$/.test(basename(root));
}

/**
 * Guard an operation path against the allowed root set (compound-refresh
 * scope SSOT: only knowledge/**, knowledge/README.md, CONCEPTS.md, and
 * status.json may be written). File-like roots require an exact match;
 * directory roots allow any path beneath them. `..` traversal-out is
 * rejected via `resolve()` normalization.
 *
 * Limitation (documented): the guard is lexical — `resolve()` never follows
 * symlinks, so a symlink inside an allowed root that points outside is not
 * detected. Real enforcement is host-side (the sandbox/approval layer).
 *
 * Violation code: `compound.scope.outside` (medium).
 */
export function scopeGuard(path: string, allowedRoots: readonly string[]): GateResult {
  const resolved = resolve(path);
  for (const root of allowedRoots) {
    const r = resolve(root);
    if (isFileLikeRoot(r)) {
      if (resolved === r) return { ok: true, violations: [] };
    } else if (resolved === r || resolved.startsWith(r + sep)) {
      return { ok: true, violations: [] };
    }
  }
  return {
    ok: false,
    violations: [
      violation(
        "medium",
        "compound.scope.outside",
        `path "${path}" is outside the compound-refresh scope (allowed: ${allowedRoots.join(", ")}) — compound-refresh operates only on {HARNESS_DIR}/knowledge/**, {HARNESS_DIR}/knowledge/README.md, <repo-root>/CONCEPTS.md, {HARNESS_DIR}/status.json (mstar-compound-refresh SKILL.md § 产物与操作路径)`,
        "point the operation at one of the allowed paths",
      ),
    ],
  };
}
