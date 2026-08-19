/**
 * Engine project module — project layer (plan `20260819-workflow-engine-core.md`
 * Task 4; compass v3.0.0 § Scope "Project layer"): roadmap frontmatter
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
 *   `{ entries: { [key]: ResidualEntry & { source_plan, registered_at,
 *   lifecycle_id? } } }` (plan Task 4) — entries keyed by plan id; entry
 *   validation delegates verbatim to `validateResidual` (status.ts), so the
 *   severity enum + lifecycle semantics are preserved at the new address.
 * - `_DEFAULT_PROJECT` fallback for project-less flows (compass ruling 2).
 */
import { readFileSync } from "node:fs";
import type { GateResult, Severity, ValidationResult } from "./core.js";
import { parseCompassFrontmatterText } from "./iteration.js";
import { validateResidual, type ResidualEntry } from "./status.js";

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

/** Register document shape (`projects/<id>/residuals.json`, plan Task 4). */
export type ProjectRegisterDoc = {
  entries?: Record<string, ProjectRegisterEntry>;
  [key: string]: unknown;
};

/**
 * Roadmap validation result: schema violations decide `ok`; body-convention
 * findings are collected as `warnings` and never flip `ok` (plan Task 4 —
 * goal-item body is not a hard gate).
 */
export type RoadmapValidation = GateResult & { warnings: ValidationResult[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
 * plan Task 4): `{ entries: { [key]: entry } }` keyed by plan id. Each
 * entry is validated by the v1 `validateResidual` verbatim (severity enum +
 * lifecycle semantics preserved — the register re-hosts, never copies) plus
 * the register provenance fields `source_plan` (must match its entries key)
 * and `registered_at` (YYYY-MM-DD), and the optional `lifecycle_id`.
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
    for (const [key, entry] of Object.entries(doc.entries)) {
      if (key.trim() === "") {
        violations.push(violation("medium", "project.register.invalid-key", "entries keys must be non-empty plan ids"));
      }
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

  return { ok: violations.length === 0, violations };
}
