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
 * HERE. The legacy register rollup (`techDebtRollup`) is deleted (plan QC fix
 * wave FW-5): the register authority is retired and the findings rollup
 * computes from the issue store (`readIssueRollup`), so the register-walking
 * reader had no supported caller left. status.ts no longer imports this
 * module (the former module cycle stays broken).
 */
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { type GateResult, type Severity, type ValidationResult } from "./core.js";
import { validateRoadmapContent, ROADMAP_STATUSES, type RoadmapValidation } from "./roadmap-content.js";
export type { RoadmapValidation } from "./roadmap-content.js";
export { ROADMAP_STATUSES };
import { isPlainObject } from "./coordination-write.js";
import { openStore, type StoreContext } from "./store-db.js";
import { IssueError } from "./issue.js";
import {
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


/** Findings cleanup policy mirror of Assignment `Findings cleanup`. */
export type FindingsCleanupMode = "zero-residual" | "allow-residual";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

/** Validate a roadmap file by delegating to the shared content validator. */
export function validateRoadmap(filePath: string): RoadmapValidation {
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
  return validateRoadmapContent(content, filePath);
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
