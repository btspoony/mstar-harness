/**
 * Engine project module — project layer (conventions:
 * mstar-plan-conventions/references/artifact-storage-paths.md § project layer;
 * compass v3.0.0 § Scope "Project layer"): roadmap frontmatter
 * validator + project register validator. This module is the only register
 * validator; the register re-hosts the residual entry schema from `status.ts`
 * via import — no copy.
 *
 * Spec sources (each export cites the plan/compass section it enforces):
 * - Roadmap frontmatter schema `{ project_id, title, status:
 *   active|paused|completed, created_at, milestones[]?, residuals_ref }`
 *   (plan Task 4; compass-style frontmatter + engine validator, machine-
 *   checkable). Frontmatter parsing reuses the shared flat-subset parser
 *   `parseCompassFrontmatterText` (iteration.ts) — no new parser dependency.
 * - Goal-item body conventions are documented conventions surfaced as
 *   validator **warnings only** — not a hard gate (compass Non-Goal /
 *   AC-P1). No residual-to-goal-item auto-link this iteration (compass
 *   ruling 2).
 * - Register file `projects/<id>/residuals.json` shape
 *   `{ entries: { [key]: (ResidualEntry & { source_plan, registered_at,
 *   lifecycle_id? })[] } }` (plan Task 4 + QC wave-1 W-E) — entries keyed by
 *   plan id, each value an ARRAY of entries (v1 `residual_findings[plan-id]`
 *   semantics preserved verbatim: a plan may hold 2+ open residuals); entry
 *   validation delegates verbatim to `validateResidual` (status.ts), so the
 *   severity enum + lifecycle semantics are preserved at the new address.
 * - `_DEFAULT_PROJECT` fallback for project-less flows (compass ruling 2).
 * - Project-register consumers (QC wave-1 W-D relocation): `findingsCleanupGate`
 *   (findings-cleanup modes; status-and-residuals.md § Findings cleanup
 *   modes) and `techDebtRollup` (the `metadata.tech_debt_summary` rollup
 *   computed over project registers) live HERE — they operate on project
 *   artifacts, and relocating them breaks the former status.ts ↔ project.ts
 *   module cycle (status.ts no longer imports this module; public names stay
 *   exported from the package index for compile compatibility).
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { readJson, SEVERITY_ORDER, type GateResult, type Severity, type ValidationResult } from "./core.js";
import { parseCompassFrontmatterText } from "./iteration.js";
import { isOpenResidual, normalizeSeverity, validateResidual, type ResidualEntry } from "./status.js";

/** Roadmap file name inside `projects/<id>/` (plan Task 4 — writer contract). */
export const PROJECT_ROADMAP_FILE = "roadmap.md";

/** Project register file name inside `projects/<id>/` (plan Task 4). */
export const PROJECT_REGISTER_FILE = "residuals.json";

/** Fallback project id for project-less flows (plan Task 4 — compass ruling 2). */
export const _DEFAULT_PROJECT = "_default";

/** Roadmap status enum (plan Task 4 — frontmatter schema). */
export const ROADMAP_STATUSES = ["active", "paused", "completed"] as const;

export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

/**
 * Roadmap frontmatter (plan Task 4): machine-checkable subset. All fields
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
 * Register document shape (`projects/<id>/residuals.json`, plan Task 4;
 * QC wave-1 W-E): `entries` keyed by plan id, each value an ARRAY of
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
 * findings are collected as `warnings` and never flip `ok` (plan Task 4 —
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 * Validate a roadmap.md file (plan Task 4): parse the frontmatter with the
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

  // Body conventions (plan Task 4 — documented, warning-only, never a hard
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
 * plan Task 4; QC wave-1 W-E): `{ entries: { [key]: entry[] } }` keyed by
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
        // The register is keyed by plan id (plan Task 4), so a mismatched
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
 * QC wave-1 W-D relocation — the input is the project register
 * `projects/<id>/residuals.json`, entries keyed by plan id with an ARRAY of
 * residuals per plan, and the plan id links the register entries to the
 * snapshot's plan row). Every OPEN entry of the plan is checked.
 * `zero-residual`: only true blocker-defers (`decision: defer` + non-empty
 * `target`) may stay open — fixable findings, `nit`s, and waived/
 * risk-accepted entries are violations. `allow-residual` (default): open
 * residuals are fine unless an unresolved Critical remains. Mode resolution:
 * explicit `opts.mode` → `allow-residual` (the v1
 * `plans[].metadata.findings_cleanup` mirror is deleted — no dual-track).
 */
export function findingsCleanupGate(
  register: ProjectRegisterDoc,
  planId: string,
  opts?: { mode?: FindingsCleanupMode },
): GateResult {
  const mode = opts?.mode ?? "allow-residual";
  const violations: ValidationResult[] = [];
  const entries = isPlainObject(register.entries) ? register.entries[planId] : undefined;
  if (entries === undefined) {
    // No register entries for this plan → no open residuals; the gate passes.
    return { ok: true, violations };
  }
  if (!Array.isArray(entries)) {
    // QC wave-1 S-006: a non-array entry value fails closed — same violation
    // code as validateProjectRegister. `.length` on an object is undefined,
    // so the old length-0 guard did not intercept and `for…of` threw a
    // TypeError; a malformed register must never crash nor pass silently.
    violations.push(
      violation(
        "high",
        "project.register.invalid-entry-list",
        `entries[${JSON.stringify(planId)}] must be an array of residual entries (one entry per residual; v1 multi-finding semantics)`,
      ),
    );
    return { ok: false, violations };
  }
  if (entries.length === 0) {
    return { ok: true, violations };
  }

  for (const entry of entries) {
    // Closed entries are not open residuals — they pass every mode.
    if (!isOpenResidual(entry)) continue;

    const id = typeof entry.id === "string" ? entry.id : "<unnamed>";
    const label = `R#${id}`;
    if (mode === "zero-residual") {
      if (entry.severity === "nit") {
        violations.push(
          violation(
            "medium",
            "findings.zero-residual-nit",
            `${label}: style-only nits must be fixed in-session or dropped \u2014 never left open under zero-residual`,
          ),
        );
      } else if (entry.decision === "risk-accepted" || entry.lifecycle === "waived") {
        violations.push(
          violation(
            "medium",
            "findings.zero-residual-risk-accepted",
            `${label}: waived/risk-accepted findings must be closed/archived, not left open under zero-residual`,
          ),
        );
      } else if (entry.decision === "defer") {
        if (typeof entry.target !== "string" || entry.target.trim() === "") {
          violations.push(
            violation(
              "medium",
              "findings.zero-residual-defer-no-target",
              `${label}: blocker-defer requires a target (next iteration/milestone) under zero-residual`,
            ),
          );
        }
      } else {
        violations.push(
          violation(
            "medium",
            "findings.zero-residual-open-fixable",
            `${label}: fixable finding must not remain open under zero-residual \u2014 fix now or convert to a blocker-defer`,
          ),
        );
      }
    } else if (normalizeSeverity(entry.severity) === "critical") {
      violations.push(
        violation(
          "high",
          "findings.allow-residual-critical",
          `${label}: unresolved critical blocks Approve with residuals`,
        ),
      );
    }
  }

  return { ok: violations.length === 0, violations };
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
 * Compute the tech-debt rollup over the project registers (QC wave-1 W-D
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
