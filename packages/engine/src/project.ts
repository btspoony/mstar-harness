/**
 * Engine project module — project layer (conventions:
 * mstar-conventions/references/artifact-storage-paths.md § project layer;
 * roadmap frontmatter
 * validator + project register validator. This module is the only register
 * validator; the register re-hosts the residual entry schema from `status.ts`
 * via import — no copy.
 *
 * Spec sources (each export cites the plan/compass section it enforces):
 * - Roadmap frontmatter schema `{ project_id, title, status:
 * active|paused|completed, created_at, milestones[]?, residuals_ref }`
 * (; compass-style frontmatter + engine validator, machine-
 * checkable). Frontmatter parsing reuses the shared flat-subset parser
 * `parseCompassFrontmatterText` (iteration.ts) — no new parser dependency.
 * - Goal-item body conventions are documented conventions surfaced as
 * validator **warnings only** — not a hard gate (compass Non-Goal /
 * AC-P1). No residual-to-goal-item auto-link this iteration (compass
 * ruling 2).
 * - Register file `projects/<id>/residuals.json` shape
 * `{ entries: { [key]: (ResidualEntry & { source_plan, registered_at,
 * lifecycle_id? })[] } }` ( ) — entries keyed by
 * plan id, each value an ARRAY of entries (v1 `residual_findings[plan-id]`
 * semantics preserved verbatim: a plan may hold 2+ open residuals); entry
 * validation delegates verbatim to `validateResidual` (status.ts), so the
 * severity enum + lifecycle semantics are preserved at the new address.
 * - `_DEFAULT_PROJECT` fallback for project-less flows (compass ruling 2).
 * - Theme-scoped research corpus `projects/<id>/references/`: engine owns
 * `PROJECT_REFERENCES_DIR` + `listProjectReferenceFiles` — directory
 * metadata only (`readdirSync` with `withFileTypes`), never file bodies,
 * never a markdown schema; placement semantics are skills prose, not
 * engine validation.
 * - Project-register consumers: `findingsCleanupGate` (findings-cleanup
 * modes; issue-governance cutover G2a — it consumes the authoritative open
 * issues linked to the plan in `store.db`, never the legacy register) lives
 * HERE, and `techDebtRollup` (the legacy register rollup, conversion owned by
 * the CLI cutover task) also lives here; relocating them breaks the former
 * status.ts ↔ project.ts module cycle (status.ts no longer imports this
 * module; public names stay exported from the package index for compile
 * compatibility).
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { readJson, SEVERITY_ORDER, type GateResult, type Severity, type ValidationResult } from "./core.js";
import { parseCompassFrontmatterText } from "./iteration.js";
import { isPlainObject } from "./coordination-write.js";
import { openStore, type StoreContext } from "./store-db.js";
import { IssueError } from "./issue.js";
import {
  isOpenResidual,
  normalizeSeverity,
  validateResidual,
  type ResidualEntry,
} from "./status.js";

/** Roadmap file name inside `projects/<id>/` ( — writer contract). */
export const PROJECT_ROADMAP_FILE = "roadmap.md";

/** Theme-scoped research directory name inside `projects/<id>/`. */
export const PROJECT_REFERENCES_DIR = "references";

/** Project register file name inside `projects/<id>/` (). */
export const PROJECT_REGISTER_FILE = "residuals.json";

/** Fallback project id for project-less flows ( — compass ruling 2). */
export const _DEFAULT_PROJECT = "_default";

/** Roadmap status enum ( — frontmatter schema). */
export const ROADMAP_STATUSES = ["active", "paused", "completed"] as const;

export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

/**
 * Roadmap frontmatter (): machine-checkable subset. All fields
 * are `unknown` because documents come from YAML at runtime; the validator
 * narrows them. `milestones` / `residuals_ref` are optional; goal-item body
 * conventions are warnings only.
 */
export type RoadmapFrontmatter = {
  project_id?: unknown;
  title?: unknown;
  status?: unknown;
  created_at?: unknown;
  milestones?: unknown;
  residuals_ref?: unknown;
  [key: string]: unknown;
};

/** One register entry: the v1 residual entry verbatim + register provenance. */
export type ProjectRegisterEntry = ResidualEntry & {
  source_plan: string;
  registered_at: string;
  lifecycle_id?: string;
};

/**
 * Register document shape (`projects/<id>/residuals.json`(;
 * `entries` keyed by plan id, each value an ARRAY of
 * register entries — v1 `residual_findings[plan-id] = entries[]`
 * multi-finding semantics preserved verbatim (a plan can hold 2+ open
 * residuals). `migration_notes[]` (the old single-entry collapse record)
 * is gone: no entries are ever skipped.
 */
export type ProjectRegisterDoc = {
  entries?: Record<string, ProjectRegisterEntry[]>;
  [key: string]: unknown;
};

/**
 * Roadmap validation result: schema violations decide `ok`; body-convention
 * findings are collected as `warnings` and never flip `ok` ( —
 * goal-item body is not a hard gate).
 */
export type RoadmapValidation = GateResult & { warnings: ValidationResult[] };

/** Findings cleanup policy mirror of Assignment `Findings cleanup`. */
export type FindingsCleanupMode = "zero-residual" | "allow-residual";

/** Computed rollup aggregates (jq semantics). */
export type TechDebtSummary = {
  total_open: number;
  by_severity: Record<string, number>;
  by_target: Record<string, number>;
  by_plan: Record<string, number>;
};

export type TechDebtCheck = {
  field: "total_open" | "by_severity" | "by_target" | "by_plan";
  status: "PASS" | "DRIFT";
};

/**
 * Result of the project-register rollup. `stored`/`checks`/`overall` are
 * retained for export-surface compatibility (the P2 CLI cutover): the v1
 * stored-summary drift check (`metadata.tech_debt_summary`) is deleted in
 * the v3 cutover — the project register is the source of truth, so `stored`
 * is always null and every check reports DRIFT.
 */
export type TechDebtRollup = {
  computed: TechDebtSummary;
  stored: Record<string, unknown> | null;
  checks: TechDebtCheck[];
  overall: "PASS" | "DRIFT";
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROLLUP_FIELDS = ["total_open", "by_severity", "by_target", "by_plan"] as const;

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

function validateNonEmptyString(
  violations: ValidationResult[],
  value: unknown,
  field: string,
  missingCode: string,
  invalidCode: string,
): void {
  if (value === undefined) {
    violations.push(violation("high", missingCode, `missing required field: ${field}`));
  } else if (typeof value !== "string" || value.trim() === "") {
    violations.push(violation("medium", invalidCode, `${field} must be a non-empty string`));
  }
}

/**
 * Validate a roadmap.md file (): parse the frontmatter with the
 * shared flat-subset parser and check the schema
 * `{ project_id, title, status: active|paused|completed, created_at,
 * milestones[]?, residuals_ref? }`. A roadmap file whose body follows the
 * documented conventions (a `## Direction` section + goal items as markdown
 * task-list items) is fully green; convention misses are `warnings` only
 * and never flip `ok` (compass Non-Goal / AC-P1).
 */
export function validateRoadmap(filePath: string): RoadmapValidation {
  const violations: ValidationResult[] = [];

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return {
      ok: false,
      violations: [violation("high", "project.roadmap.unreadable", `cannot read roadmap file: ${filePath}`)],
      warnings: [],
    };
  }

  let doc: Record<string, unknown>;
  try {
    doc = parseCompassFrontmatterText(content, filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : `invalid roadmap frontmatter in ${filePath}`;
    return { ok: false, violations: [violation("high", "project.roadmap.invalid-frontmatter", message)], warnings: [] };
  }

  validateNonEmptyString(
    violations,
    doc.project_id,
    "project_id",
    "project.roadmap.missing-project-id",
    "project.roadmap.invalid-project-id",
  );
  validateNonEmptyString(violations, doc.title, "title", "project.roadmap.missing-title", "project.roadmap.invalid-title");

  if (doc.status === undefined) {
    violations.push(violation("high", "project.roadmap.missing-status", "missing required field: status"));
  } else if (typeof doc.status !== "string" || !(ROADMAP_STATUSES as readonly string[]).includes(doc.status)) {
    violations.push(
      violation(
        "medium",
        "project.roadmap.invalid-status",
        `status must be one of ${ROADMAP_STATUSES.join(" | ")} \u2014 got ${JSON.stringify(doc.status)}`,
      ),
    );
  }

  if (doc.created_at === undefined) {
    violations.push(violation("high", "project.roadmap.missing-created-at", "missing required field: created_at"));
  } else if (typeof doc.created_at !== "string" || !DATE_RE.test(doc.created_at)) {
    violations.push(violation("medium", "project.roadmap.invalid-created-at", "created_at must be YYYY-MM-DD"));
  }

 // milestones is optional; an empty `milestones:` parses as null (same as
 // absent). Otherwise it must be a list of non-empty strings.
  if (doc.milestones !== undefined && doc.milestones !== null) {
    if (!Array.isArray(doc.milestones)) {
      violations.push(violation("medium", "project.roadmap.invalid-milestones", "milestones must be a list of milestone names"));
    } else {
      for (const item of doc.milestones) {
        if (typeof item !== "string" || item.trim() === "") {
          violations.push(
            violation("medium", "project.roadmap.invalid-milestones", "milestones items must be non-empty strings"),
          );
          break;
        }
      }
    }
  }

  if (doc.residuals_ref !== undefined && doc.residuals_ref !== null) {
    if (typeof doc.residuals_ref !== "string" || doc.residuals_ref.trim() === "") {
      violations.push(violation("medium", "project.roadmap.invalid-residuals-ref", "residuals_ref must be a non-empty string"));
    }
  }

 // Body conventions ( — documented, warning-only, never a hard
 // gate): the body SHOULD state the direction in a `## Direction` section
 // and list goal items as markdown task-list items (`- [ ]` planned /
 // in-flight, `- [x]` delivered). No residual-to-goal auto-link this
 // iteration — goal items carry no register ids.
  const warnings: ValidationResult[] = [];
  const fenceEnd = linesIndexOfClosingFence(content);
  const body = content.split(/\r?\n/).slice(fenceEnd + 1).join("\n");

  if (!/^##\s+Direction\s*$/m.test(body)) {
    warnings.push(
      violation(
        "low",
        "project.roadmap.body.missing-direction",
        "roadmap body has no `## Direction` section (documented body convention) \u2014 state the project direction there",
      ),
    );
  }
  if (!/^\s*[-*]\s+\[[xX ]\]/m.test(body)) {
    warnings.push(
      violation(
        "low",
        "project.roadmap.body.no-goal-items",
        "roadmap body has no goal-item task list (documented body convention) \u2014 list goals as `- [ ]` / `- [x]` markdown task items",
      ),
    );
  }

  return { ok: violations.length === 0, violations, warnings };
}

/** Index of the closing frontmatter fence (`---` after the opening fence). */
function linesIndexOfClosingFence(content: string): number {
  return content.split(/\r?\n/).indexOf("---", 1);
}

/**
 * Validate a project register document (`projects/<id>/residuals.json`,
 *  `{ entries: { [key]: entry[] } }` keyed by
 * plan id, each value an ARRAY of entries (v1 `residual_findings[plan-id]`
 * multi-finding semantics preserved — a plan may hold 2+ open residuals).
 * Each entry is validated by the v1 `validateResidual` verbatim (severity
 * enum + lifecycle semantics preserved — the register re-hosts, never
 * copies) plus the register provenance fields `source_plan` (must match its
 * entries key) and `registered_at` (YYYY-MM-DD), and the optional
 * `lifecycle_id`.
 */
export function validateProjectRegister(doc: unknown): GateResult {
  const violations: ValidationResult[] = [];
  if (!isPlainObject(doc)) {
    return {
      ok: false,
      violations: [violation("high", "project.register.invalid", "project register must be an object")],
    };
  }

  if (doc.entries === undefined) {
    violations.push(violation("high", "project.register.missing-entries", "missing required field: entries"));
  } else if (!isPlainObject(doc.entries)) {
    violations.push(violation("high", "project.register.invalid-entries", "entries must be an object keyed by plan id"));
  } else {
    for (const [key, entries] of Object.entries(doc.entries)) {
      if (key.trim() === "") {
        violations.push(violation("medium", "project.register.invalid-key", "entries keys must be non-empty plan ids"));
      }
      if (!Array.isArray(entries)) {
        violations.push(
          violation(
            "high",
            "project.register.invalid-entry-list",
            `entries[${JSON.stringify(key)}] must be an array of residual entries (one entry per residual; v1 multi-finding semantics)`,
          ),
        );
        continue;
      }
      for (const entry of entries) {
 // Residual entry shape/semantics verbatim (severity enum + lifecycle
 // states — the register re-hosts them at the new address).
        violations.push(...validateResidual(entry).violations);
        if (!isPlainObject(entry)) continue;

        validateNonEmptyString(
          violations,
          entry.source_plan,
          "source_plan",
          "project.register.missing-source-plan",
          "project.register.invalid-source-plan",
        );
        if (entry.registered_at === undefined) {
          violations.push(violation("high", "project.register.missing-registered-at", "missing required field: registered_at"));
        } else if (typeof entry.registered_at !== "string" || !DATE_RE.test(entry.registered_at)) {
          violations.push(violation("medium", "project.register.invalid-registered-at", "registered_at must be YYYY-MM-DD"));
        }
        if (entry.lifecycle_id !== undefined && (typeof entry.lifecycle_id !== "string" || entry.lifecycle_id.trim() === "")) {
          violations.push(violation("medium", "project.register.invalid-lifecycle-id", "lifecycle_id must be a non-empty string"));
        }
 // The register is keyed by plan id (), so a mismatched
 // source_plan is corrupted provenance.
        if (typeof entry.source_plan === "string" && entry.source_plan.trim() !== "" && entry.source_plan !== key) {
          violations.push(
            violation(
              "medium",
              "project.register.mismatched-source-plan",
              `source_plan ${JSON.stringify(entry.source_plan)} does not match the entries key ${JSON.stringify(key)} \u2014 entries are keyed by plan id`,
            ),
          );
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Findings cleanup gate (status-and-residuals.md § Findings cleanup modes;
 * issue-governance cutover G2a): the authoritative input is the issue store
 * (`store.db`) — every OPEN issue linked to the plan through `provenance`
 * (`kind='plan'`, `target=<plan-id>`, written by the core `linkIssue` verb).
 * The legacy register is never consulted at runtime; `validateProjectRegister`
 * remains a migration-only validator.
 *
 * `zero-residual`: every open linked issue is a violation — a disposition is a
 * separate authorized act (contract §4), so an open issue cannot ride along.
 * `allow-residual` (default): open issues are fine unless an unresolved
 * Critical remains.
 *
 * Fail-closed: the authority must be readable AND active, or the gate throws
 * — a missing (`store.not-initialized`), corrupt (`store.corrupt`) or staged
 * (`store.not-active`) store is never read as "no findings".
 */
export async function findingsCleanupGate(
  context: StoreContext,
  planId: string,
  opts?: { mode?: FindingsCleanupMode },
): Promise<GateResult> {
  if (typeof planId !== "string" || planId.trim() === "") {
    throw new Error("findingsCleanupGate requires a non-empty plan id");
  }
  const mode = opts?.mode ?? "allow-residual";
  const handle = await openStore(context, "read");
  try {
    const db = handle.db;
    const meta = db.prepare("select authority_state as authorityState from store_meta where id = 1").get() as
      | { authorityState?: unknown }
      | undefined;
    if (!meta || meta.authorityState !== "active") {
      throw new IssueError(
        "store.not-active",
        `The issue store is ${meta && typeof meta.authorityState === "string" ? meta.authorityState : "unreadable"}; findings authority requires an active store.`,
      );
    }
    const rows = db
      .prepare(
        "select issues.id as id, issues.severity as severity from issues " +
          "join provenance on provenance.issue_id = issues.id and provenance.kind = 'plan' and provenance.target = ? " +
          "where issues.disposition = 'open' order by issues.id asc",
      )
      .all(planId) as Array<{ id: string; severity: string }>;
    const violations: ValidationResult[] = [];
    for (const row of rows) {
      const label = row.id;
      if (normalizeSeverity(row.severity) === "critical") {
        violations.push(
          mode === "zero-residual"
            ? violation(
                "high",
                "findings.zero-residual-critical",
                `${label}: unresolved critical blocks approval under zero-residual \u2014 fix now or close via explicit risk acceptance`,
              )
            : violation("high", "findings.allow-residual-critical", `${label}: unresolved critical blocks Approve with residuals`),
        );
      } else if (mode === "zero-residual") {
        violations.push(
          violation(
            "medium",
            "findings.zero-residual-open-issue",
            `${label}: an open issue cannot remain under zero-residual \u2014 close it through the authorized disposition path before handoff`,
          ),
        );
      }
    }
    return { ok: violations.length === 0, violations };
  } finally {
    handle.close();
  }
}

/** Count values into a string-keyed map, keys sorted ascending (jq group_by order for strings). */
function groupCount(values: unknown[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
 // jq group_by sorts by element value; TS map keys are strings — equivalent
 // for string targets (the fixture contract); mixed numbers would differ.
    const key = typeof value === "string" ? value : String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Compute the tech-debt rollup over the project registers
 * relocation — status-and-residuals.md § `metadata.tech_debt_summary`
 * semantics preserved at the project layer): `total_open` / `by_severity` /
 * `by_target` / `by_plan` over open entries of every
 * `projects/<id>/residuals.json` register under `projectDir` (legacy
 * `"warning"` → `low`, `null`/`""` → `medium`; closed entries skipped;
 * missing `target` groups under `"unspecified"`; `by_plan` keyed by plan id —
 * the snapshot plan linkage; register values are ARRAYS per plan id, so
 * every open entry of a plan counts).
 *
 * The v1 stored-summary drift check (`metadata.tech_debt_summary`) is a v1
 * dead path — the register is the source of truth, so `stored` is always
 * null and the retained `checks`/`overall` fields report DRIFT
 * (export-surface compatibility until the P2 CLI cutover). Does not write
 * anything.
 */
export function techDebtRollup(projectDir: string): TechDebtRollup {
  const items: Array<{ plan: string; entry: Record<string, unknown> }> = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(projectDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const project of entries) {
    if (!project.isDirectory()) continue;
    const registerPath = join(projectDir, project.name, PROJECT_REGISTER_FILE);
    if (!existsSync(registerPath)) continue;
    let register: unknown;
    try {
      register = readJson(registerPath);
    } catch {
      continue; // malformed register files are skipped — the register validator is the schema gate
    }
    if (!isPlainObject(register) || !isPlainObject(register.entries)) continue;
    for (const [plan, planEntries] of Object.entries(register.entries)) {
      if (!Array.isArray(planEntries)) continue;
      for (const entry of planEntries) {
        if (!isPlainObject(entry) || !isOpenResidual(entry)) continue;
        items.push({ plan, entry });
      }
    }
  }

  const bySeverity: Record<string, number> = {};
  for (const severity of SEVERITY_ORDER) {
    bySeverity[severity] = items.filter(({ entry }) => normalizeSeverity(entry.severity) === severity).length;
  }

  const computed: TechDebtSummary = {
    total_open: items.length,
    by_severity: bySeverity,
    by_target: groupCount(items.map(({ entry }) => entry.target ?? "unspecified")),
    by_plan: groupCount(items.map(({ plan }) => plan)),
  };

  const stored = null;
  const checks: TechDebtCheck[] = ROLLUP_FIELDS.map((field) => ({ field, status: "DRIFT" as const }));
  const overall = "DRIFT" as const;

  return { computed, stored, checks, overall };
}

/**
 * List theme-scoped research files under `<projectDir>/references/`
 * (compass ruling 1): top-level
 * files plus files exactly one subdirectory deep; deeper nesting ignored;
 * directories never listed; regular files only (`Dirent.isFile()`). Returns
 * paths relative to the references root with `/` separators, sorted by code
 * unit. Strays named exactly `roadmap.md` / `residuals.json` at the
 * references **root** are excluded — project-layer filenames are never
 * research rows. `projectDir` is the **per-project** directory (the caller
 * resolves `join(resolveProjectDir(startDir), projectId)`; `_DEFAULT_PROJECT`
 * is the fallback id), never the projects root. Missing or unreadable
 * `references/` → `[]`; never throws; never opens a file body.
 */
export function listProjectReferenceFiles(projectDir: string): string[] {
  const root = join(projectDir, PROJECT_REFERENCES_DIR);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === PROJECT_ROADMAP_FILE || entry.name === PROJECT_REGISTER_FILE) continue;
    if (entry.isFile()) {
      files.push(entry.name);
    } else if (entry.isDirectory()) {
      let nested: Dirent[];
      try {
        nested = readdirSync(join(root, entry.name), { withFileTypes: true });
      } catch {
        continue; // unreadable subdirectory contributes nothing
      }
      for (const child of nested) {
        if (child.isFile()) files.push(`${entry.name}/${child.name}`);
      }
    }
  }
  return files.sort();
}
