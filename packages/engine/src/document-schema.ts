/**
 * Document schema validator — plan / assignment / sdd-brief / pm-acceptance
 * front matter declared in the harness plan documents (compass D15/D17).
 *
 * - Field tables and conditional budget rule: the schema plan brief;
 *   assignment semantics mirror `dispatch.ts` `validateAssignmentFields`
 *   (the exported `REVIEW_SEAT_ROLES`, the audit-category trigger, the
 *   exactly-one branch form, control-write glob refusal).
 * - Unknown-field rule (compass D15): every field of the canonical PM
 *   assignment template is a known optional field
 *   (`skills/mstar-roles/references/project-manager/dispatch-and-assignment.md`
 *   `Assignment Template (Canonical)`); `document.frontmatter.unknown` fires
 *   only for a key outside that list.
 * - Violation codes: `document.frontmatter.missing` / `.unknown` /
 *   `.invalid` / `.absent`; severity missing/invalid/unknown = high.
 */
import {
  DocumentFrontmatterError,
  extractFrontmatterAndBody,
  parseDocumentFrontmatterEntries,
  type FrontmatterEntry,
} from "./document-frontmatter.js";
import { classifyReviewOrAuditRound, isReadOnlyAssignmentRole } from "./dispatch.js";
import { WORKFLOW_DELIVERY_KINDS } from "./workflow.js";
import type { GateResult, ValidationResult } from "./core.js";

export type DocumentKind = "plan" | "assignment" | "sdd-brief" | "pm-acceptance";

export type DocumentFieldType = "string" | "integer" | "list" | "iso-datetime";

/** One schema field row. `enum` lists the accepted scalar values; `type`
 * pins the structural value shape; `requiredWhen` marks a conditionally
 * required row that must also appear in `optional`/`required` per its
 * trigger (assignment `budget` / `return_shape` / `task_budget`). */
export type DocumentField = {
  name: string;
  type?: DocumentFieldType;
  enum?: readonly string[];
  requiredWhen?: (values: Record<string, unknown>) => boolean;
};

export type DocumentSchema = {
  kind: DocumentKind;
  required: readonly DocumentField[];
  optional: readonly DocumentField[];
};

const PLAN_SCHEMA: DocumentSchema = {
  kind: "plan",
  required: [
    { name: "plan_id" },
    { name: "execution", enum: ["sdd", "inline"] },
    { name: "working_branch" },
    { name: "main_worktree_branch" },
    { name: "delivery_kind", enum: WORKFLOW_DELIVERY_KINDS },
    { name: "status", enum: ["Todo", "InProgress", "InReview", "Done", "Blocked"] },
  ],
  optional: [{ name: "title" }],
};

/** Review/audit trigger: the dispatch-owned final round-bounding decision
 * ({@link classifyReviewOrAuditRound} `roundBounded`) — the role
 * normalization, both component checks and the final decision each have
 * exactly one copy; the schema keeps only its field table. */
function isReviewOrAuditRound(values: Record<string, unknown>): boolean {
  return classifyReviewOrAuditRound(
    typeof values.execute_as === "string" ? values.execute_as : "",
    typeof values.task_category === "string" ? values.task_category : "",
  ).roundBounded;
}

const ASSIGNMENT_SCHEMA: DocumentSchema = {
  kind: "assignment",
  required: [
    { name: "execute_as" },
    { name: "delegation" },
    { name: "task_category" },
    { name: "budget", requiredWhen: isReviewOrAuditRound },
    { name: "return_shape", requiredWhen: isReviewOrAuditRound },
    { name: "task_budget", requiredWhen: (values) => !isReviewOrAuditRound(values) },
  ],
  optional: [
    { name: "execution_mode" },
    { name: "sdd_implementer_session" },
    { name: "sdd_dir" },
    { name: "sdd_context_file" },
    { name: "skill_presets" },
    { name: "qc_mode" },
    { name: "review_package_path" },
    { name: "qc_report_path" },
    { name: "who_runs_this_turn" },
    { name: "primary" },
    { name: "dev_routing" },
    { name: "parallelism" },
    { name: "additional_gates" },
    { name: "phase_gate_checklist" },
    { name: "working_branch" },
    { name: "branch_policy" },
    { name: "control_harness_root" },
    { name: "review_cwd" },
    { name: "review_range" },
    { name: "diff_basis" },
    { name: "worktree_path" },
    { name: "write_domain", enum: ["control", "work"] },
    { name: "control_write_paths", type: "list" },
    { name: "main_worktree_branch" },
    { name: "acceptance_gate" },
    { name: "acceptance_gate_reason" },
    { name: "findings_cleanup" },
    { name: "why_this_agent" },
    { name: "pm_task_board_coverage" },
    { name: "roadmap_deferred_scope" },
    { name: "task" },
    { name: "inputs" },
    { name: "severity_bar" },
    { name: "input_provenance" },
    { name: "deliverables" },
    { name: "acceptance_criteria" },
    { name: "evidence_required" },
    { name: "constraints" },
    { name: "effort" },
    { name: "plan_scope" },
    { name: "checkpoint_comment_rule" },
    { name: "why_batching_is_safe" },
    { name: "scope" },
    { name: "orchestration_guard" },
    { name: "plan_path" },
    { name: "report_format" },
    { name: "execution_evidence" },
    { name: "enforcement", enum: ["hard"] },
    { name: "plan_id" },
    { name: "iteration_id" },
    { name: "workflow_id" },
  ],
};

const BRIEF_SCHEMA: DocumentSchema = {
  kind: "sdd-brief",
  required: [{ name: "plan_id" }, { name: "task", type: "integer" }],
  optional: [{ name: "files", type: "list" }],
};

const ACCEPTANCE_SCHEMA: DocumentSchema = {
  kind: "pm-acceptance",
  required: [
    { name: "plan_id" },
    { name: "gate", enum: ["pm-acceptance"] },
    { name: "verdict", enum: ["Approve", "Approve with residuals", "Request Changes", "Needs Discussion"] },
    { name: "generated_at", type: "iso-datetime" },
  ],
  optional: [],
};

const SCHEMAS: Record<DocumentKind, DocumentSchema> = {
  plan: PLAN_SCHEMA,
  assignment: ASSIGNMENT_SCHEMA,
  "sdd-brief": BRIEF_SCHEMA,
  "pm-acceptance": ACCEPTANCE_SCHEMA,
};

/** The field table for one document kind: required and optional rows with
 * their enum / type declarations. */
export function documentSchema(kind: DocumentKind): DocumentSchema {
  return SCHEMAS[kind];
}

function violation(severity: ValidationResult["severity"], code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, ...(fix !== undefined ? { fix } : {}) };
}

/** Strict ISO-8601 date-time shape: `YYYY-MM-DDTHH:mm:ss` with an optional
 * fractional-seconds part (`.fff…`) before the required `Z` or a `+HH:mm` /
 * `-HH:mm` offset. No normalization — the calendar day, the time ranges and
 * the offset range are validated against a real calendar. */
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoDateTime(value: string): boolean {
  const match = value.match(ISO_DATETIME_RE);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[7]!;
  if (month < 1 || month > 12) return false;
  const monthLength = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > monthLength) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

/**
 * Validate one document's front matter against its kind schema. `content` is
 * the whole document text (fences included); `source` is a diagnostic label
 * naming the document in violation messages.
 *
 * Codes: `document.frontmatter.absent` (no closed fence), `.missing` (a
 * required or conditionally required key absent), `.unknown` (a key outside
 * the kind's known field list — for assignment the canonical PM template),
 * `.invalid` (enum / type / structural violation, a duplicate key or any
 * other parser refusal). Missing/invalid/unknown are high severity.
 */
export function validateDocumentFrontmatter(kind: DocumentKind, content: string, source: string): GateResult {
  const schema = documentSchema(kind);
  const violations: ValidationResult[] = [];
  const { frontmatter, fenced } = extractFrontmatterAndBody(content);
  if (!fenced) {
    return {
      ok: false,
      violations: [violation("high", "document.frontmatter.absent",
        `${source}:1: no front matter fence \u2014 the document must open with a "---" line closed by a second "---" line`)],
    };
  }

  let entries: Map<string, FrontmatterEntry>;
  try {
    entries = parseDocumentFrontmatterEntries(frontmatter, source);
  } catch (error) {
    if (error instanceof DocumentFrontmatterError) {
      violations.push(violation("high", "document.frontmatter.invalid",
        `${source}:${error.line}: invalid front matter at line ${error.line}: ${error.message}`, error.fix));
    } else {
      violations.push(violation("high", "document.frontmatter.invalid",
        `${source}: invalid front matter: ${(error as Error).message}`));
    }
    return { ok: false, violations };
  }

  const values: Record<string, unknown> = {};
  for (const [key, entry] of entries) values[key] = entry.value;

  const known = new Set([...schema.required, ...schema.optional].map((f) => f.name));

  for (const [key, entry] of entries) {
    if (!known.has(key)) {
      violations.push(violation("high", "document.frontmatter.unknown",
        `${source}:${entry.line}: unknown field ${key} \u2014 not a field of the ${kind} schema`,
        `remove ${key} or use a known ${kind} field`));
    }
  }

  for (const field of schema.required) {
    // Usable content for a required textual field: a non-blank scalar —
    // the raw scalar text is the carrier, so a numeric-looking value
    // (`main_worktree_branch: 5.0`) still counts. A list is never usable
    // scalar content (even non-empty): it is present-but-invalid shape.
    // `""`, whitespace, `{}` and `[]` count as missing exactly as the key's
    // absence; a map refuses as invalid content. The round-bounding fields
    // (`budget` / `return_shape` / `task_budget`) carry dispatch's
    // presence-only absence rule: `N/A` counts as missing exactly as
    // dispatch classifies it.
    const required = field.requiredWhen !== undefined ? field.requiredWhen(values) : true;
    if (!required) continue;
    if (!entries.has(field.name)) {
      violations.push(violation("high", "document.frontmatter.missing",
        `${source}:1: missing required field ${field.name}`,
        `add a ${field.name}: line to the front matter`));
      continue;
    }
    const requiredEntry = entries.get(field.name)!;
    const value = requiredEntry.value;
    // Enum-typed fields refuse the same shape through the enum check below
    // (one violation per failure, naming the accepted values) — the
    // scalar-content refusal applies to plain textual fields only.
    if (field.enum === undefined && Array.isArray(value) && value.length > 0) {
      violations.push(violation("high", "document.frontmatter.invalid",
        `${source}:${requiredEntry.line}: invalid ${field.name} \u2014 accepted values: a non-blank scalar, not a list`,
        `write ${field.name} as a single scalar value`));
      continue;
    }
    if (field.enum === undefined
      && typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value as object).length > 0) {
      violations.push(violation("high", "document.frontmatter.invalid",
        `${source}:${requiredEntry.line}: invalid ${field.name} \u2014 accepted values: a non-blank scalar, not a nested map`,
        `write ${field.name} as a single scalar value`));
      continue;
    }
    let blankOrEmpty: boolean;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      blankOrEmpty = String(value).trim() === "";
    } else if (Array.isArray(value)) {
      blankOrEmpty = value.length === 0;
    } else {
      // `null` counts as missing; a non-empty map is present-but-invalid
      // shape (handled above), never missing.
      blankOrEmpty = value === null || Object.keys(value as object).length === 0;
    }
    if (!blankOrEmpty && (field.name === "task_budget" || field.name === "budget" || field.name === "return_shape")
      && typeof value === "string" && value.trim().toLowerCase() === "n/a") {
      blankOrEmpty = true;
    }
    if (blankOrEmpty) {
      violations.push(violation("high", "document.frontmatter.missing",
        `${source}:${requiredEntry.line}: missing required field ${field.name}`,
        `replace the ${field.name}: line with usable content \u2014 adding a second ${field.name} key is refused as a duplicate`));
    }
  }

  // A required field already reported missing/invalid above is not re-fired
  // as a second invalid violation — one violation per field failure.
  const alreadyReported = new Set(
    violations.map((v) => v.message.match(/(?:missing required field|invalid) ([A-Za-z_]+)/)?.[1]).filter(Boolean),
  );
  for (const field of [...schema.required, ...schema.optional]) {
    const entry = entries.get(field.name);
    if (entry === undefined || alreadyReported.has(field.name)) continue;
    if (field.enum !== undefined && (typeof entry.value !== "string" || !field.enum.includes(entry.value))) {
      violations.push(violation("high", "document.frontmatter.invalid",
        `${source}:${entry.line}: invalid ${field.name} ${JSON.stringify(entry.value)} \u2014 accepted values: ${field.enum.join(" | ")}`,
        `set ${field.name} to one of: ${field.enum.join(", ")}`));
      continue;
    }
    if (field.type === "integer" && !(typeof entry.value === "number" && Number.isInteger(entry.value))) {
      violations.push(violation("high", "document.frontmatter.invalid",
        `${source}:${entry.line}: invalid ${field.name} ${JSON.stringify(entry.value)} \u2014 accepted values: integer`,
        `set ${field.name} to an integer`));
    } else if (field.type === "list" && !Array.isArray(entry.value)) {
      violations.push(violation("high", "document.frontmatter.invalid",
        `${source}:${entry.line}: invalid ${field.name} \u2014 accepted values: a list of paths`,
        `write ${field.name} as a "- item" block list or a [a, b] flow array`));
    } else if (field.type === "iso-datetime") {
      const valid = typeof entry.value === "string" && isIsoDateTime(entry.value);
      if (!valid) {
        violations.push(violation("high", "document.frontmatter.invalid",
          `${source}:${entry.line}: invalid ${field.name} ${JSON.stringify(entry.value)} \u2014 accepted values: ISO-8601 date-time YYYY-MM-DDTHH:mm:ssZ, optionally with a fractional-seconds part, or with a +HH:mm / -HH:mm offset`,
          `set ${field.name} to an ISO-8601 date-time such as 2026-11-26T08:00:00Z`));
      }
    }
  }

  if (kind === "assignment") {
    const branchEntry = entries.get("working_branch");
    const policyEntry = entries.get("branch_policy");
    const hasBranch = branchEntry !== undefined && typeof branchEntry.value === "string" && branchEntry.value.trim() !== "";
    const hasPolicy = policyEntry !== undefined && typeof policyEntry.value === "string" && policyEntry.value.trim() !== "";
    if (hasBranch && hasPolicy) {
      violations.push(violation("high", "document.frontmatter.invalid",
        `${source}:${policyEntry!.line}: invalid branch declaration \u2014 accepted values: exactly one of working_branch or branch_policy, not both`,
        "remove one of working_branch / branch_policy"));
    }
    const controlWritePaths = entries.get("control_write_paths");
    const roleValue = entries.get("execute_as")?.value;
    const role = typeof roleValue === "string" ? roleValue.trim().replace(/^@/, "").split(/\s+/)[0] ?? "" : "";
    const writable = !isReadOnlyAssignmentRole(role);
    if (writable && !hasBranch && !hasPolicy) {
      const line = branchEntry?.line ?? policyEntry?.line ?? 1;
      violations.push(violation("high", "document.frontmatter.invalid",
        `${source}:${line}: invalid branch declaration \u2014 accepted values: exactly one of working_branch or branch_policy; a writable assignment carries one non-empty declaration`,
        "add exactly one of working_branch or branch_policy with a non-empty value"));
    }
    if (Array.isArray(controlWritePaths?.value)) {
      for (const target of controlWritePaths.value) {
        if (typeof target === "string" && /[*?[\]{}]/.test(target)) {
          violations.push(violation("high", "document.frontmatter.invalid",
            `${source}:${controlWritePaths.line}: invalid control_write_paths entry ${JSON.stringify(target)} \u2014 accepted values: concrete paths, no globs`,
            "list concrete paths in control_write_paths"));
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
