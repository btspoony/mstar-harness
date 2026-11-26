/**
 * Engine dispatch module — Assignment field validation, default-branch gate,
 * execution-mode → QC seat count, tri identity, anti-recursion precheck.
 *
 * Spec sources (semantic SSOT — the skills stay authoritative; this module
 * implements their deterministic rules without forking semantics):
 * - Assignment field contract (`Execute as` / `Delegation` / `Task category`
 * present, non-empty; paste-only assignments missing fields are flagged):
 * `mstar-dispatch-gates` SKILL.md § "调度防串扰（强制）" + § 反模式（派发）
 * ("Assignment 已写、invoke 为零（paste-only）").
 * - Assignment fields live in the document FRONT MATTER (compass D15 —
 *   the canonical PM template declares snake_case keys; the parsers slice
 *   the front matter themselves, so a template label quoted in the task
 *   body can never satisfy — or disable — the gate.
 * - Branch-field exactly-one rule + `<base>` requirement: `mstar-branch-worktree`
 * SKILL.md § "Assignment 要求（PM）" + § "`<base>` 与叠分支（stacked
 * branches）" ("若写新建但未写 `<base>`：实现侧应停下问 project-manager…
 * 禁止擅自假设「一定是 main」").
 * - Default-protected-branch gate (`main`/`master` unless an explicit
 * `Branch policy: direct on <branch> — <reason>` exception exists):
 * `mstar-branch-worktree` SKILL.md § "Git 功能分支门禁（业务仓库）".
 * - N→seat mapping (sdd→3 tri, inline→1 single, targeted→listed seats) and
 * tri identity (`qc-specialist` / `qc-specialist-2` / `qc-specialist-3`):
 * `mstar-dispatch-gates` SKILL.md § "QC tri-review（SDD 强制）" / "QC
 * 单席（例外）" / "QC targeted re-review" + `mstar-roles` SKILL.md
 * "QC reviewer" 参数表.
 * - Review/audit round-bounding fields (`Budget` + `Return shape`, presence
 * only, neither `N/A`): a dispatch whose `Execute as` names a review seat — or
 * whose `Task category` starts with `audit` (an audit round may name an
 * executor outside the QC seat set) — must carry
 * `Budget (review / QC seats)` and `Return shape (review / QC seats)`; the cap
 * may only tighten the default, never loosen it:
 * `mstar-harness-core` SKILL.md § "定向执行与验证边界" ("只读审查席位有界")
 * + `mstar-review-qc` SKILL.md § "席位预算与截断（PM）" + the PM Assignment
 * template in dispatch-and-assignment.md (both labels required on review / QC
 * rounds, `N/A` otherwise).
 * - Anti-recursion NEVER red line (dispatching agent's OWN role == the
 * dispatch's `Execute as`): `mstar-dispatch-gates` SKILL.md § "承接方反递归红线
 * （NEVER / DO NOT；leaf executor 必读）". The precheck compares the CALLER
 * identity against the target role; hosts that can only observe the spawn
 * TARGET (omp `agent` / opencode `subagent` / cursor `subagent_type` carry
 * the target, never the caller) cannot run it — see
 * {@link ComposeDispatchGateOptions.caller}.
 * - Hard-gate enforcement (`Enforcement: hard` flag — per Assignment/compass,
 * never global; rollback = unset flag): roadmap §8.5 C4 + decision D2.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { assignmentSourceHomes, canonicalizeNearestExisting } from "./path.js";
import { probePathOwnership } from "./path-check.js";
import { assertControlClean, hasHarnessRoot, readMainWorktree } from "./worktree.js";
import { applyEnforcement } from "./core.js";
import type { GateResult, ValidationResult, Severity } from "./core.js";
import { DocumentFrontmatterError, extractFrontmatterAndBody, parseDocumentFrontmatterEntries, type FrontmatterEntry, type FrontmatterProfile } from "./document-frontmatter.js";
import { validateDocumentFrontmatterExtraction } from "./document-schema.js";

/**
 * The three accepted branch forms (mstar-branch-worktree § "Assignment 要求"):
 * `Working branch: <existing>` | `Working branch: create <new> from <base>`
 * | `Branch policy: direct on <branch> — <reason>`. Exactly one is required
 * for writable assignments.
 */
const BRANCH_FORMS_HINT =
  '"Working branch: <existing>" | "Working branch: create <new> from <base>" | "Branch policy: direct on <branch> \u2014 <reason>"';

/** Parsed Assignment header fields relevant to dispatch validation. */
export type AssignmentFields = {
  executeAs?: string;
  delegation?: string;
  taskCategory?: string;
  /**
   * `execution_mode` — sdd / inline / targeted (presence captured here; the N mapping is {@link executionModeToN}).
   * see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
   */
  /**
   * Parallel `working_branch` declarations (dsh parallel tracks): a string
   * list accepted alongside the scalar form. The scalar `workingBranch`
   * keeps the single value; when the key is a list the scalar is undefined
   * and every branch lives here. Never set for scalar input.
   * see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
   */
  workingBranches?: string[];
  /**
   * Parallel `worktree_path` declarations — same shape rule as {@link AssignmentFields.workingBranches}.
   * see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
   */
  worktreePaths?: string[];
  executionMode?: string;
  workingBranch?: string;
  worktreePath?: string;
  writeDomain?: string;
  controlWritePaths?: string[];
  branchPolicy?: string;
  /**
   * `Budget (review / QC seats)` round cap. Required (present, non-empty,
   * not `N/A`) on review-seat and audit rounds — see
   * {@link REVIEW_SEAT_ROLES}. The value is prose (file opens / wall clock);
   * it is never parsed numerically.
   */
  budget?: string;
  /**
   * `Return shape (review / QC seats)` — what the seat returns and how it
   * stops. Same presence-only rule as {@link AssignmentFields.budget}, one
   * violation code per field so the PM sees exactly which label is missing.
   */
  returnShape?: string;
  /**
   * `Task budget (implement / ops rounds)` — the declared capacity of ONE
   * implementer round closing the task's declared Files list and verification
   * gates (capacity contract spec § A1/A2; the value cites the task's
   * `Effort (agent-oriented)` band). Required, presence-only, on the exact
   * complement of the review/audit rounds — implement/ops rounds including
   * non-audit docs/Prepare specialists and orientation roles. The value is
   * prose; it is never parsed numerically (adequacy stays in PM's Prepare
   * check).
   */
  taskBudget?: string;
};
export type ValidateAssignmentFieldsOptions = {
  /**
 * Whether the assignment produces repo diffs (default `true`). The
 * branch-form exactly-one gate applies to writable assignments only —
 * read-only assignments (explore/scout orientation) legitimately omit
 * branch fields per mstar-branch-worktree ("每个可写 Assignment…").
 */
  writable?: boolean;

  /**
   * True when the text came from a RESOLVED assignment file carrier (compass
   * D14 pointer): an explicit pointer commits to the Assignment contract, so
   * validation must run even when the document carries no recognizable core
   * key — a silent non-Assignment pass is reserved for inline prompts.
   * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
   */
  fileCarrier?: boolean;
  /**
   * Already-parsed front matter entries of this document (map form of
   * `parseDocumentFrontmatterEntries`; `null` for invalid YAML): reuse one
   * parse per decision instead of reparsing. Public text-API behavior is
   * unchanged when omitted.
   * see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
   */
  entries?: Map<string, FrontmatterEntry> | null;
  /**
   * The structured refusal of the caller's parse ({@link DocumentFrontmatterError}
   * from {@link assignmentFrontmatterParse}), carried with `entries: null`
   * so a malformed block is parsed ONCE per decision: the schema layer
   * reports the exact line-numbered cause from this diagnostic instead of
   * re-parsing the rejected block. `null` (a non-structured failure) falls
   * back to the schema layer's own parse. Omitted → the schema layer
   * re-parses a rejected block, as before.
   * see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
   */
  parseError?: DocumentFrontmatterError | null;
};

/** Options for {@link assertDefaultBranchProtected}. */
export type DefaultBranchOptions = {
 /** Protected default branch names (project convention; default `main`/`master`). */
  defaultBranches?: readonly string[];
 /** True when the Assignment carries an explicit `Branch policy: direct on …` exception. */
  directOnException?: boolean;
};

/** Options for {@link executionModeToN}. */
export type ExecutionModeToNOptions = {
 /** Listed reviewer seats for `targeted` re-review (`QC re-review: targeted — reviewers: …`). */
  seats?: readonly string[];
};

/** Result of {@link executionModeToN}: a GateResult carrying `n` on success. */
export type ExecutionModeToNResult = GateResult & { n?: number };

const REQUIRED_FIELDS: ReadonlyArray<{ key: "executeAs" | "delegation" | "taskCategory"; label: string; code: string }> = [
  { key: "executeAs", label: "execute_as", code: "execute-as" },
  { key: "delegation", label: "delegation", code: "delegation" },
  { key: "taskCategory", label: "task_category", code: "task-category" },
];

/**
 * Review seats whose dispatch must declare the round-bounding fields
 * (mstar-harness-core § "定向执行与验证边界" — "只读审查席位有界"; the cap may
 * only tighten the default). `code-reviewer` is the L2 task-review seat and
 * carries the same bounded-round rule as the three QC seats. An `audit`
 * `Task category` triggers the same fields independently. */
export const REVIEW_SEAT_ROLES: readonly string[] = ["qc-specialist", "qc-specialist-2", "qc-specialist-3", "code-reviewer"];

/**
 * Audit-category classification shared with the document schema: the raw
 * `Task category` token is read case-insensitively after stripping leading
 * markdown decoration, tolerating a suffix (`audit`, `audit (secondary)`,
 * `audit_secondary`) but not a longer word (`auditing`). `Task category:
 * audit` is an independent review-round trigger: mstar-harness-core maps
 * `audit` to `@code-reviewer`, but nothing forces the pairing, so an audit
 * round whose `Execute as` is outside the seat set would otherwise escape
 * the round-bounding gate.
 */
export function isAuditTaskCategory(rawCategory: string): boolean {
  const category = rawCategory.replace(/^[*_`"'\s]+/, "").toLowerCase();
  return /^audit(?![A-Za-z0-9])/.test(category);
}

/**
 * Normalize one `Execute as` token the way the round-bounding rules read it:
 * strip a leading `@` mention, compare case-insensitively, take the first
 * whitespace token — `@QC-Specialist-2 (security lens)` resolves to the
 * seat. Shared by `validateAssignmentFields` and the document schema; no
 * second normalization copy lives in the schema.
 */
export function normalizeAssignmentRole(rawRole: string): string {
  return rawRole.trim().replace(/^@/, "").toLowerCase().split(/\s+/)[0] ?? "";
}

/**
 * The combined review/audit round classification, owned here and consumed
 * by both `validateAssignmentFields` and the document schema: the
 * normalized role, whether it names a review seat, whether the task
 * category independently triggers an audit round — and `roundBounded`,
 * the final shared decision of whether the round-bounding fields are
 * required. The schema keeps only its field table; every part of the
 * decision has exactly one copy.
 */
export function classifyReviewOrAuditRound(rawRole: string, rawCategory: string): {
  role: string;
  reviewSeat: boolean;
  auditRound: boolean;
  roundBounded: boolean;
} {
  const role = normalizeAssignmentRole(rawRole);
  const reviewSeat = REVIEW_SEAT_ROLES.includes(role);
  const auditRound = isAuditTaskCategory(rawCategory);
  return {
    role,
    reviewSeat,
    auditRound,
    roundBounded: reviewSeat || auditRound,
  };
}

/**
 * Retired body-label forms of the front matter round-bounding keys.
 * `parseAssignmentFields` reads the snake_case front matter keys
 * (`budget` / `return_shape` / `task_budget`) only — these label constants
 * no longer feed any parse, but the export shape is kept for the host
 * packages Task 5 migrates; they must not be widened or re-parsed.
 * shortcut: dead vocabulary kept for export-shape parity,
 * upgrade: the host packages finish the Task 5 migration.
 */
export const BUDGET_LABELS: readonly string[] = ["Budget (review / QC seats)", "Budget"];

/** Labels carrying the review-seat `Return shape` (same parenthesized + bare pair). */
export const RETURN_SHAPE_LABELS: readonly string[] = ["Return shape (review / QC seats)", "Return shape"];

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

/** Why a round-bounding field is unusable: absent, empty, or declared `N/A`. */
function describeAbsence(value: string | undefined): string | undefined {
  return value === undefined
    ? "the field is absent"
    : value === ""
      ? "the field is empty"
      : value.trim().toLowerCase() === "n/a"
        ? 'the value is "N/A"'
        : undefined;
}

/** Shape-guard match of an Assignment core front matter key. The declaration
 * form is the snake_case scalar key (`execute_as: x`) — a body-quoted
 * `**Execute as**: x` template line is NEVER a declaration. Shape
 * detection ONLY: field parsing/semantics live in `parseAssignmentFields` /
 * `validateAssignmentFields`. Declared before its first use because both the
 * shape guard and the extracted-block enforcement read share it.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
const ASSIGNMENT_FIELD_RE = /^[ \t]*(?:execute_as|delegation|task_category)\s*:/m;

/**
 * The ONE front matter scope of an Assignment DOCUMENT: the block inside a
 * complete `---` fence. Unfenced text is body prose and declares nothing —
 * a prompt whose lines merely look like `key: value` is not an Assignment,
 * and no reader infers "already extracted" from the text. `unterminated`
 * marks an opening fence that never closed: that block declares no field
 * (fail-closed) while still counting as Assignment evidence, so the schema
 * refuses it (`document.frontmatter.absent`) instead of an ordinary prompt
 * silently passing as a non-Assignment. Callers holding a block that was
 * split elsewhere use the explicit `*FromFrontmatter` functions instead.
 * see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
 */
function assignmentFrontmatter(text: string): { yaml: string; unterminated: boolean } {
  const extraction = extractFrontmatterAndBody(text);
  if (extraction.fenced) return { yaml: extraction.frontmatter, unterminated: false };
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { yaml: "", unterminated: false };
  return { yaml: text.slice(text.indexOf("\n") + 1), unterminated: true };
}

/**
 * Parse front matter entries, never throwing: invalid YAML yields no entries.
 * see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
 */
function safeEntries(yaml: string, profile: FrontmatterProfile = "document"): Map<string, FrontmatterEntry> | null {
  try {
    return parseDocumentFrontmatterEntries(yaml, "assignment", profile);
  } catch {
    return null;
  }
}

/**
 * Scalar content of one entry as the field string; non-scalars yield undefined.
 * see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
 */
function scalarOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return undefined;
}

/**
 * Parse an Assignment's FRONT MATTER into the dispatch-relevant fields
 * (compass D15 — the canonical PM template declares fields in snake_case
 * front matter keys; `parseAssignmentFields` reads the front matter ONLY).
 * snake_case keys map onto the existing typed fields: `execute_as` →
 * `executeAs`, `working_branch` → `workingBranch`, `control_write_paths`
 * (a block list) → `controlWritePaths`, and so on; `execution_mode` joins
 * the type as `executionMode`. Blank scalars yield the empty string
 * (`key:` / `key: ""` — the field is PRESENT but empty, the shape
 * `validateAssignmentFields` flags as invalid); absent keys yield
 * `undefined`.
 *
 * The function scopes its OWN input: it reads the front matter of whatever
 * DOCUMENT it is handed, so any caller (host gate, CLI, plugin) may pass the
 * whole dispatch/prompt — a field quoted in the task body can never be read
 * as a field. Only a complete fence declares fields: unfenced `key: value`
 * body text and an unterminated fence yield no fields (that document is
 * refused by {@link validateAssignmentFields} instead). A caller that
 * already split the fence passes the block to {@link
 * parseAssignmentFieldsFromFrontmatter}. Never throws: invalid front matter
 * YAML yields no fields. */
export function parseAssignmentFields(assignmentText: string): AssignmentFields {
  const { yaml, unterminated } = assignmentFrontmatter(assignmentText);
  return unterminated ? {} : parseAssignmentFieldsFromFrontmatter(yaml);
}

/**
 * Parse the fields of an ALREADY-EXTRACTED front matter block (the text
 * between the fences, fences excluded) — the explicit form for callers that
 * discovered the fence boundary themselves (`assignmentHeaderRegion`
 * consumers, host loaders). A document must go through {@link
 * parseAssignmentFields} so body text can never declare a field. Never
 * throws: invalid block YAML yields no fields. */
export function parseAssignmentFieldsFromFrontmatter(frontmatter: string | Map<string, FrontmatterEntry> | null): AssignmentFields {
  const fields: AssignmentFields = {};
  const entries = typeof frontmatter === "string" ? safeEntries(frontmatter) : frontmatter;
  if (entries === null) return fields;
  const scalar = (key: string): string | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    const value = scalarOf(entry.value);
    if (value !== undefined) return value;
    // A bare `key:` / blank scalar is present-but-empty.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    if (entry.value === null || (typeof entry.value === "object" && entry.value !== null && !Array.isArray(entry.value) && Object.keys(entry.value as object).length === 0)) return "";
    return undefined;
  };
  fields.executeAs = scalar("execute_as");
  fields.delegation = scalar("delegation");
  fields.taskCategory = scalar("task_category");
  fields.executionMode = scalar("execution_mode");
  fields.workingBranch = scalar("working_branch");
  fields.branchPolicy = scalar("branch_policy");
  fields.worktreePath = scalar("worktree_path");
  fields.writeDomain = scalar("write_domain");
  const writePaths = entries.get("control_write_paths");
  if (writePaths !== undefined) {
    if (Array.isArray(writePaths.value)) {
      fields.controlWritePaths = writePaths.value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    } else {
      const single = scalarOf(writePaths.value);
      if (single !== undefined) fields.controlWritePaths = single === "" ? [] : [single];
    }
  }
  fields.budget = scalar("budget");
  fields.returnShape = scalar("return_shape");
  fields.taskBudget = scalar("task_budget");
  // Parallel-track declarations (dsh): a `working_branch` / `worktree_path`
  // string list (flow array or `- item` block list) is the schema-owned
  // parallel shape — the scalar field stays for the single value, the flat
  // string list is projected here. Non-string items drop out.
  // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
  const branchesEntry = entries.get("working_branch");
  if (Array.isArray(branchesEntry?.value)) {
    fields.workingBranches = branchesEntry.value.filter((item): item is string => typeof item === "string");
  }
  const worktreesEntry = entries.get("worktree_path");
  if (Array.isArray(worktreesEntry?.value)) {
    fields.worktreePaths = worktreesEntry.value.filter((item): item is string => typeof item === "string");
  }
  return fields;
}

/**
 * The ONE non-throwing front matter parse of an Assignment document, with its
 * refusal kept: `entries` is the value a host hands back to
 * {@link composeDispatchGate} as `entries` so a decision parses the same
 * resolved document ONCE (host role/plan reads reuse it too, via
 * {@link parseAssignmentFieldsFromFrontmatter}); `parseError` is the
 * structured {@link DocumentFrontmatterError} behind `entries: null` — the
 * host threads BOTH into the composition (`entries` + `parseError`), so the
 * schema layer reports the exact line-numbered cause without re-parsing the
 * block. A successful parse carries `parseError: null`; a non-structured
 * failure (defensive) carries `null` and the schema layer falls back to its
 * own parse.
 */
export type AssignmentFrontmatterParse = {
  entries: Map<string, FrontmatterEntry> | null;
  parseError: DocumentFrontmatterError | null;
};

export function assignmentFrontmatterParse(text: string): AssignmentFrontmatterParse {
  const { yaml } = assignmentFrontmatter(text);
  try {
    return { entries: parseDocumentFrontmatterEntries(yaml, "assignment"), parseError: null };
  } catch (error) {
    return { entries: null, parseError: error instanceof DocumentFrontmatterError ? error : null };
  }
}

/**
 * One non-throwing YAML parse of the document's front matter — the value a
 * host hands back to {@link composeDispatchGate} as `entries` so a decision
 * parses the same resolved document ONCE (host role/plan reads reuse it too,
 * via {@link parseAssignmentFieldsFromFrontmatter}). `null` means the block
 * does not parse; hosts that keep the refusal hand it over as
 * `parseError` (see {@link assignmentFrontmatterParse}), and a host without
 * one leaves the schema layer owning the line-numbered re-read.
 */
export function assignmentFrontmatterEntries(text: string): Map<string, FrontmatterEntry> | null {
  return assignmentFrontmatterParse(text).entries;
}

/** Where the `Enforcement` flag was declared (roadmap §8.5 C4/D2). */
export type EnforcementSource = "assignment" | "compass" | "mstarc" | "none";

/** Parsed hard-enforcement flag. `hard: false` + `source: none` = flag absent. */
export type EnforcementFlag = {
  hard: boolean;
  source: EnforcementSource;
};

/**
 * The Assignment document's front matter as a SELF-CONTAINED fenced
 * fragment — the host-package boundary kept until Task 5 migrates those
 * callers (`packages/dsh` re-feeds the result to the front matter parsers).
 * The fences are part of the fragment on purpose: the public parsers accept
 * only a fenced document, so a host that slices once and re-parses keeps the
 * same fence-scoped read instead of a body-text guess. A document without
 * front matter yields `""` (unfenced key lines are body prose); an
 * unterminated fence yields the fragment without a closing fence, which
 * declares nothing.
 */
export function assignmentHeaderRegion(assignmentText: string): string {
  const { yaml, unterminated } = assignmentFrontmatter(assignmentText);
  if (yaml === "") return "";
  return unterminated ? `---\n${yaml}` : `---\n${yaml}\n---`;
}

/**
 * Parse the `enforcement: hard` flag (roadmap §8.5 C4 + decision D2 — v2
 * hard gates are OPT-IN per Assignment/compass, never global; rollback =
 * unset flag; inert when the engine is absent). The flag is the lowercase
 * YAML key read from the FRONT MATTER block: for an Assignment from the
 * assignment front matter (source `assignment`); the compass form —
 * lowercase `enforcement` key in a front matter block that carries no
 * Assignment core keys — keeps source `compass`. The value may be quoted
 * and is case-insensitive (`enforcement: "HARD"`). A present-but-non-hard
 * value (`soft`, empty, malformed) still reports its source so callers
 * distinguish "explicitly not hard" from "not mentioned" (`source: none`).
 * Only a fenced DOCUMENT declares the flag: unfenced `enforcement: hard`
 * body text and an unterminated fence yield the absent flag. A caller that
 * already split the fence passes the block to {@link
 * parseEnforcementFlagFromFrontmatter}. Never throws. */
export function parseEnforcementFlag(text: string): EnforcementFlag {
  const { yaml, unterminated } = assignmentFrontmatter(text);
  return unterminated ? { hard: false, source: "none" } : parseEnforcementFlagFromFrontmatter(yaml);
}

/**
 * Parse the `enforcement: hard` flag from an ALREADY-EXTRACTED front matter
 * block (fences excluded) — the explicit form for callers that split the
 * fence themselves, e.g. the compass reader. The shared front matter reader
 * decides the key, so a YAML comment or a quoted value never hides the flag.
 * Source attribution is decided by the block's own content: a block carrying
 * an Assignment core key is `assignment`, anything else `compass`. The
 * caller passes the same profile it validated the block with — a compass
 * block read under the `flat` contract must not lose its flag to the
 * stricter `document` profile. Never throws.
 */
export function parseEnforcementFlagFromFrontmatter(frontmatter: string | Map<string, FrontmatterEntry> | null, profile: FrontmatterProfile = "document"): EnforcementFlag {
  const entries = typeof frontmatter === "string" ? safeEntries(frontmatter, profile) : frontmatter;
  if (entries === null) return { hard: false, source: "none" };
  const entry = entries.get("enforcement");
  if (entry === undefined) return { hard: false, source: "none" };
  const value = scalarOf(entry.value) ?? "";
  // The parsed entries are the single source of the source attribution:
  // invalid YAML already returned above, so a key presence check is exactly
  // the `ASSIGNMENT_FIELD_RE` line match without a second regex pass.
  // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
  const source: EnforcementSource =
    entries.has("execute_as") || entries.has("delegation") || entries.has("task_category") ? "assignment" : "compass";
  return { hard: value.toLowerCase() === "hard", source };
}

/**
 * Presence-shape helper: absent → `missing-<code>`, empty → `invalid-<code>`.
 *
 * The three core field violations carry `assignment.presence.*` ALIAS codes:
 * the Slice-2 opencode presence namespace is kept as engine aliases) — same single parser, one violation per missing field, both
 * namespaces observable on that one violation.
 */
function requireField(violations: ValidationResult[], value: string | undefined, label: string, code: string): void {
  if (value === undefined) {
    const v = violation(
      "high",
      `assignment.field.${code}`,
      `missing required Assignment field: ${label}`,
      `add "${label}: <value>" to the Assignment front matter`,
    );
    v.aliases = [`assignment.presence.missing-${code}`];
    violations.push(v);
  } else if (value === "") {
    const v = violation(
      "high",
      `assignment.field.${code}`,
      `${label} must be non-empty`,
      `fill in "${label}: <value>" in the Assignment front matter`,
    );
    v.aliases = [`assignment.presence.missing-${code}`];
    violations.push(v);
  }
}

/**
 * Parsed branch forms of an Assignment (mstar-branch-worktree § "Assignment
 * 要求"): `Working branch: <existing>` | `Working branch: create <new> from
 * <base>` | `Branch policy: direct on <branch> — <reason>`. Exactly one is
 * required for writable assignments. This is the engine's SINGLE branch-form
 * grammar — CLI and host hooks consume it instead of re-implementing the
 * regexes. */
export type AssignmentBranchForms = {
  /**
 * `Working branch: <existing>` — the value's first token (create-form
 * values are excluded and land in {@link createForm} instead).
 */
  workingBranch?: string;
 /** `Working branch: create <new> from <base>` — created branch name (+ base when written). */
  createForm?: { name: string; base?: string };
  /**
 * `Branch policy: direct on <branch> — <reason>` — branch captured by the
 * loose `direct on <branch>` prefix; `reason` is the strict-form reason
 * ("" when the value is not a well-formed direct-on form, i.e. no
 * separator + non-empty reason — mirror of `validateAssignmentFields`).
 */
  directOn?: { branch: string; reason: string };
};

/**
 * Parse one `Working branch` VALUE (not a document) into its form — the
 * Assignment reader's own grammar, exported for callers that hold the value
 * alone and have no front matter to scope (the prepare claim). Create-form
 * token match is case-insensitive (`CREATE <new> from <base>`); values that
 * do not match the exact form (e.g. "created", "create/foo",
 * "create-user-flow") are existing-branch names. Dangling create-form typos —
 * `create <new> from` (trailing `from`, no base) and `create from <base>`
 * (name missing) — are recognized as create-forms so
 * `validateAssignmentFields` can flag them (fail-open fixed).
 */
export function parseWorkingBranchValue(
  value: string,
): { workingBranch?: string; createForm?: { name: string; base?: string } } {
  if (value === "") return {};
  const create = value.match(/^create\s+(\S+)(?:\s+from\s+(\S+))?$/i);
  if (create) return { createForm: { name: create[1]!, base: create[2] } };
 // Dangling `from` with no `<base>`: "create feature/x from".
  const danglingFrom = value.match(/^create\s+(\S+)\s+from$/i);
  if (danglingFrom) return { createForm: { name: danglingFrom[1]!, base: "" } };
 // `from` with no `<new>` name: "create from main".
  const missingName = value.match(/^create\s+from\s+(\S+)$/i);
  if (missingName) return { createForm: { name: "", base: missingName[1]! } };
  return { workingBranch: value.split(/\s+/)[0]! };
}

/**
 * Branch forms derived from ALREADY-PARSED assignment fields — the shared
 * grammar behind {@link parseAssignmentBranchForms} and every composed
 * decision (one parse per decision: no text re-scan here).
 * see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
 */
function branchFormsFromFields(fields: AssignmentFields): AssignmentBranchForms {
  const forms: AssignmentBranchForms = {};
  // Parallel tracks: the scalar field is undefined when the key is a list;
  // the first list entry feeds the create-form/direct-on shape checks while
  // presence validation reads `workingBranches` directly (the list is the
  // schema-owned parallel shape, never a branch-multiple violation).
  // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
  const branchValue = fields.workingBranch ?? (fields.workingBranches !== undefined && fields.workingBranches.length > 0 ? fields.workingBranches[0] : undefined);
  if (branchValue !== undefined && branchValue !== "") {
    const parsed = parseWorkingBranchValue(branchValue);
    if (parsed.createForm !== undefined) forms.createForm = parsed.createForm;
    else forms.workingBranch = parsed.workingBranch;
  }
  if (fields.branchPolicy !== undefined && fields.branchPolicy !== "") {
 // Loose prefix capture (gate target) + strict full-form capture (reason).
 // simplify: separator `\s*` on both sides permits zero-width pathological spacing ("direct on main -hotfix — reason" splits into branch "main" + reason "hotfix — reason"), accepted because greedy `\S+` parses realistic hyphenated branch names correctly, upgrade: tighten to `\s+(?:[—–]|--|-)\s*` if mis-splits ever surface.
    const direct = fields.branchPolicy.match(/^direct\s+on\s+(\S+)/i);
    if (direct) {
      const strict = fields.branchPolicy.match(/^direct\s+on\s+(\S+)(?:\s*(?:[\u2014\u2013]|--|-)\s*(.+))?$/);
      forms.directOn = { branch: direct[1]!.trim(), reason: strict ? (strict[2] ?? "").trim() : "" };
    }
  }
  return forms;
}

/**
 * Parse an Assignment's branch forms via the engine's single parser
 * (`parseAssignmentFields` + {@link parseWorkingBranchValue}). Consumed by
 * the CLI `dispatch validate` gate-branch derivation and the opencode hook;
 * also the internal grammar behind `validateAssignmentFields`. Input may be
 * the whole dispatch — the header scope is inherited from
 * {@link parseAssignmentFields}. */
export function parseAssignmentBranchForms(assignmentText: string): AssignmentBranchForms {
  return branchFormsFromFields(parseAssignmentFields(assignmentText));
}

/**
 * The branch forms of ALREADY-parsed fields — {@link parseAssignmentBranchForms}
 * without a second parse, for a caller that hoisted the decision's one parse.
 * @param fields - fields from `parseAssignmentFields` / `parseAssignmentFieldsFromFrontmatter`.
 */
export function assignmentBranchFormsOf(fields: AssignmentFields): AssignmentBranchForms {
  return branchFormsFromFields(fields);
}
/**
 * Parse the Assignment's `Branch policy: direct on <branch> — <reason>`
 * exception branch. Returns the branch ONLY for the well-formed direct-on
 * form (branch + non-empty reason; separator set [—–]|--|-); undefined when
 * absent or malformed — the default-branch gate recognizes explicit
 * direct-on exceptions only. Single engine grammar shared by CLI + plugin
 * (the header scope is inherited from {@link parseAssignmentBranchForms}, so
 * a whole dispatch may be passed). */
export function parseBranchPolicyDirectOnBranch(assignmentText: string): string | undefined {
  const directOn = parseAssignmentBranchForms(assignmentText).directOn;
  return directOn !== undefined && directOn.reason !== "" ? directOn.branch : undefined;
}

/**
 * True when the Assignment's `Execute as` role is a read-only orientation
 * role (`scout` / `explore`, case-insensitive). Read-only assignments
 * legitimately omit branch forms (mstar-branch-worktree § "每个可写
 * Assignment…") — callers pass `validateAssignmentFields(text, { writable:
 * false })` and skip the default-branch gate for them. */
export function isReadOnlyAssignmentRole(roleId: string): boolean {
  const role = roleId.trim().toLowerCase();
  return role === "scout" || role === "explore";
}

/**
 * Validate an Assignment's header fields (mstar-dispatch-gates Assignment
 * field contract + mstar-branch-worktree branch-form contract).
 *
 * Required: `Execute as` / `Delegation` / `Task category` present with
 * non-empty values (paste-only shells are caught here — every field missing).
 * Review-seat and audit rounds must additionally declare both round-bounding
 * fields, `Budget (review / QC seats)` and `Return shape (review / QC
 * seats)` (one violation code per missing label). The complement — every
 * implement/ops round, including non-audit docs/Prepare and orientation
 * roles — must declare `Task budget (implement / ops rounds)`, presence-only.
 * Writable assignments must
 * carry EXACTLY ONE branch form; `create <new>`
 * from <base>` without `<base>` (incl. the dangling `create <new> from`
 * / `create from <base>` typos) and `Branch policy` without branch/reason
 * are flagged. The three core-field violations carry the legacy
 * `assignment.presence.*` codes as aliases.
 *
 * Every read is scoped to the document FRONT MATTER — the scope is
 * applied by the field parsers themselves ({@link parseAssignmentFields} /
 * {@link parseAssignmentBranchForms}), never the task body — the same rule
 * {@link parseEnforcementFlag} follows at the compose gate. Dispatch text
 * routinely quotes the template labels (template blocks, `## Task` bodies,
 * the `**Task**:` line's own prose), and a quoted front matter key in the
 * body must not satisfy a gate the Assignment front matter left open. */
export function validateAssignmentFields(assignmentText: string, opts: ValidateAssignmentFieldsOptions = {}): GateResult {
  // Pointer provenance: an explicit `Assignment file:` carrier commits to
  // the Assignment contract — a readable but unshaped file is ONE invalid
  // Assignment with the front matter recovery, never a silent non-Assignment
  // pass and never a pile of field violations against a document that
  // declared no field at all.
  // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
  if (opts.fileCarrier === true && !isAssignmentShaped(assignmentText)) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "dispatch.assignment.shape",
          "the assignment file does not declare Assignment front matter \u2014 a file named by an `Assignment file:` pointer must be an Assignment document",
          "rewrite the assignment file as a front-matter document (a `---`-fenced YAML block declaring the snake_case keys, e.g. execute_as / delegation / task_category), or pass the assignment inline instead of a pointer",
        ),
      ],
    };
  }
  const violations: ValidationResult[] = [];
  // The document schema owns structural/declaration failures (unknown keys,
  // enum and type shape, duplicate keys, YAML parse refusals, the absent
  // fence); the gates below add the dispatch-semantics layer on top of the
  // same front matter read. Schema `missing`/branch-declaration rows are
  // dropped — dispatch reports those exact conditions with its own codes
  // (requireField / the branch-form gates), so a merge would double-count.
  // One parse per decision: when the caller passes already-parsed entries
  // the schema layer reuses them (no second front-matter parse); invalid
  // YAML (entries `null`) re-runs the schema parse so the refusal reports.
  // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
  const extraction = extractFrontmatterAndBody(assignmentText);
  violations.push(
    ...validateDocumentFrontmatterExtraction("assignment", extraction, "assignment", opts.entries === undefined && opts.parseError === undefined ? {} : { entries: opts.entries, parseError: opts.parseError }).violations.filter(
      (schemaViolation) => schemaViolation.code !== "document.frontmatter.missing" && !schemaViolation.message.includes("invalid branch declaration"),
    ),
  );
  const fields = opts.entries !== undefined ? parseAssignmentFieldsFromFrontmatter(opts.entries) : parseAssignmentFields(assignmentText);
  const writable = opts.writable !== false;
  for (const { key, label, code } of REQUIRED_FIELDS) {
    requireField(violations, fields[key], label, code);
  }
  if (fields.writeDomain !== undefined && fields.writeDomain !== "control" && fields.writeDomain !== "work") {
    violations.push(violation("high", "assignment.field.write-domain-unknown",
      `unknown Write domain: ${JSON.stringify(fields.writeDomain)}`, 'set "write_domain: control" or "write_domain: work" in the Assignment front matter'));
  }
  if (fields.writeDomain === "control") {
    // A control write inspects ONE checkout: with a parallel `worktree_path` /
    // `working_branch` LIST there is no single declared checkout for
    // `validateControlWriteAssignment` to compare against the Git-derived
    // control root, and every relative target would go unverified. Refuse the
    // list instead of counting it as presence — `terminal`, because the
    // checkout equality and target ownership cannot be proven from this
    // document at all (soft enforcement must not admit the write). List
    // PRESENCE is the shape: an empty list declares no checkout either, so its
    // contents cannot decide the question.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    if (fields.worktreePaths !== undefined || fields.workingBranches !== undefined) {
      violations.push({
        ...violation("high", "assignment.field.control-write-parallel-tracks",
          "a control-domain Assignment writes ONE checkout \u2014 a parallel working_branch / worktree_path list leaves the control checkout and every relative write target unverifiable",
          'declare scalar "worktree_path: <control checkout>" and "working_branch: <its branch>", or dispatch each parallel track as its own work-domain Assignment'),
        terminal: true,
      });
    } else {
      if (describeAbsence(fields.worktreePath) !== undefined) {
        violations.push(violation("high", "assignment.field.control-write-missing-worktree",
          "control-domain assignment requires Worktree path", 'add "worktree_path: <control checkout path>" to the Assignment front matter'));
      }
      if (describeAbsence(fields.workingBranch) !== undefined && describeAbsence(fields.branchPolicy) !== undefined) {
        violations.push(violation("high", "assignment.field.control-write-missing-branch",
          "control-domain assignment requires a branch form", `add exactly one of the front matter keys working_branch / branch_policy: ${BRANCH_FORMS_HINT}`));
      }
    }
    if (!fields.controlWritePaths?.length) {
      violations.push(violation("high", "assignment.field.control-write-paths-missing",
        "control-domain assignment requires Control write paths", 'add a control_write_paths: block list to the Assignment front matter'));
    }
    for (const target of fields.controlWritePaths ?? []) {
      if (/[*?[\]{}]/.test(target)) {
        violations.push(violation("high", "assignment.field.control-write-path-invalid",
          `Control write paths does not accept globs: ${target}`, "list concrete paths in control_write_paths"));
      }
    }
  }

// Review/audit rounds are bounded (mstar-harness-core § 定向执行与验证边界);
// `Budget` and `Return shape` are the PM's declared cap and stop condition and
// the only machine-decidable part is their EXISTENCE — the values are prose,
// never parsed numerically. The role token strips a leading `@` mention,
// compares case-insensitively and takes the first whitespace token, so
// `@QC-Specialist-2 (security lens)` still resolves to the seat. `Task
// category: audit` is an independent trigger: mstar-harness-core maps `audit`
// to `@code-reviewer`, but nothing forces the pairing, so an audit round whose
// `Execute as` is outside the seat set would otherwise escape the gate. The
// category token is read case-insensitively, tolerating a suffix (`audit`,
// `audit (secondary)`, `audit_secondary`) but not a longer word (`auditing`).
  const { role, reviewSeat, roundBounded } = classifyReviewOrAuditRound(fields.executeAs ?? "", fields.taskCategory ?? "");
  const category = (fields.taskCategory ?? "").replace(/^[*_`"'\s]+/, "").toLowerCase();
  if (roundBounded) {
    const subject = reviewSeat ? `review seat "${role}"` : `audit round (Task category: ${category})`;
    // One code per field — the PM reads which label is missing off the code.
    const boundingFields = [
      {
        code: "assignment.field.budget-missing",
        label: "Budget",
// The fix quotes the spec section title verbatim (Chinese). Code literals
// stay pure-ASCII `\uXXXX` escapes per the ASCII literal lint (bun 1.2.17
// misdecodes raw multi-byte UTF-8 in the CLI bundle); the runtime string is
// identical. Section title: mstar-harness-core § 定向执行与验证边界.
        fix: `add "budget: <cap> \u2014 may only tighten the default in mstar-harness-core \u00a7 \u5b9a\u5411\u6267\u884c\u4e0e\u9a8c\u8bc1\u8fb9\u754c, never loosen it" to the Assignment front matter`,
        value: fields.budget,
      },
      {
        code: "assignment.field.return-shape-missing",
        label: "Return shape",
        fix: `add "return_shape: <what the seat returns and how it stops \u2014 verdict + findings shape; a clean round returns findings: [] explicitly>" to the Assignment front matter`,
        value: fields.returnShape,
      },
    ] as const;
    for (const field of boundingFields) {
      const missing = describeAbsence(field.value);
      if (missing === undefined) continue;
      violations.push(
        violation("high", field.code, `${subject} must declare a round ${field.label} \u2014 ${missing}`, field.fix),
      );
    }
  }

  // Implement/ops rounds declare capacity (capacity contract spec § A1–A3): the
  // exact complement of the review/audit branch above — the SAME normalized
  // `role` / `auditRound` values, no second role whitelist and no lifecycle
  // phase field. Non-audit docs/Prepare specialists and orientation roles sit
  // here too, and `writable: false` only waives the branch-form gate, never
  // this field. Presence-only: absent, empty or `N/A` fails; numeric/semantic
  // adequacy stays in PM's Prepare check.
  if (!roundBounded) {
    const missing = describeAbsence(fields.taskBudget);
    if (missing !== undefined) {
      violations.push(
        violation(
          "high",
          "assignment.field.task-budget-missing",
          `implement/ops round "${role}" must declare a Task budget \u2014 ${missing}`,
          'add "task_budget: <one implementer round closing the task\'s declared Files list and verification gates> \u2014 capacity contract spec \u00a7 A1/A2" to the Assignment front matter',
        ),
      );
    }
  }

  if (writable) {
    // The schema-owned parallel shape: `working_branch` as a string list —
    // presence comes from the projected list while the scalar stays the
    // single value; the list is never a second branch form.
    // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
    const listPresent = fields.workingBranches !== undefined && fields.workingBranches.some((branch) => branch.trim() !== "");
    const workingPresent = (fields.workingBranch !== undefined && fields.workingBranch !== "") || listPresent;
    const policyPresent = fields.branchPolicy !== undefined && fields.branchPolicy !== "";
    const formCount = Number(workingPresent) + Number(policyPresent);
    const forms = branchFormsFromFields(fields);

    if (formCount === 0) {
      violations.push(
        violation(
          "high",
          "assignment.field.branch-missing",
          "writable assignment must contain exactly one branch form",
          `add exactly one of the front matter keys working_branch / branch_policy: ${BRANCH_FORMS_HINT}`,
        ),
      );
    } else if (formCount > 1) {
      violations.push(
        violation(
          "high",
          "assignment.field.branch-multiple",
          `writable assignment contains ${formCount} branch forms (working_branch + branch_policy) \u2014 exactly one required`,
          `keep exactly one of the front matter keys working_branch / branch_policy: ${BRANCH_FORMS_HINT}`,
        ),
      );
    } else if (workingPresent) {
 // `create <new-branch> from <base>` — <base> is mandatory, never assume
 // `main`. Case-insensitive create-form token match; values that do not
 // match the exact form (e.g. "created", "create/foo", "create-user-flow")
 // are existing-branch names and pass.
      const create = forms.createForm;
      if (create !== undefined && (create.base === undefined || create.base.trim() === "" || create.name.trim() === "")) {
        violations.push(
          violation(
            "high",
            "assignment.field.branch-missing-base",
            `create-form working_branch is incomplete: "${fields.workingBranch}" (expected "create <new-branch> from <base>")`,
            "write both the new branch name and the ancestor branch after `from` (main / existing feature branch / remote-tracking branch / `current`)",
          ),
        );
      }
    } else if (policyPresent) {
      const direct = forms.directOn;
      if (direct === undefined) {
        violations.push(
          violation(
            "high",
            "assignment.field.branch-policy-missing-branch",
            `unparseable branch_policy: "${fields.branchPolicy}" (expected "direct on <branch> \u2014 <reason>")`,
            "start the field with `direct on <branch>`",
          ),
        );
      } else if (direct.reason === "") {
        violations.push(
          violation(
            "high",
            "assignment.field.branch-policy-missing-reason",
            `branch_policy "direct on ${direct.branch}" is missing the reason`,
            'append "\u2014 <reason>" after the branch name',
          ),
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Verify control-domain writes against the Git-derived main checkout. */
export function validateControlWriteAssignment(
  text: string,
  opts: { cwd?: string; assignmentDir?: string; controlRoot?: string; fields?: AssignmentFields; forms?: AssignmentBranchForms } = {},
): ValidationResult[] {
  const cwd = opts.cwd ?? process.cwd();
  const unresolved = violation("high", "dispatch.control-write.control-root-unresolved",
    `cannot resolve the control checkout from ${cwd}`,
    "run mstar dispatch validate from a checkout of this repository");
  try {
    const main = readMainWorktree(opts.controlRoot ?? cwd);
    if (main === null) return [unresolved];
    const controlRoot = canonicalizeNearestExisting(main.root);
    if (opts.controlRoot !== undefined && canonicalizeNearestExisting(opts.controlRoot) !== controlRoot) return [unresolved];
    const fields = opts.fields ?? parseAssignmentFields(text);
    const forms = opts.forms ?? parseAssignmentBranchForms(text);
    const branch = forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch;
    const violations: ValidationResult[] = [];
    const worktree = fields.worktreePath && fields.worktreePath !== "N/A"
      ? resolve(opts.assignmentDir ?? cwd, fields.worktreePath)
      : undefined;
    if (worktree !== undefined && canonicalizeNearestExisting(worktree) !== controlRoot) {
      violations.push(violation("high", "dispatch.control-write.worktree-not-control",
        `Worktree path "${fields.worktreePath}" is not the control checkout ${controlRoot}`,
        `set "Worktree path: ${controlRoot}" in the Assignment`));
    }
    if (branch && branch !== "N/A" && branch !== main.branch) {
      violations.push(violation("high", "dispatch.control-write.branch-mismatch",
        `Assignment branch "${branch}" does not match the control checkout branch "${main.branch || "(detached)"}"`,
        main.branch ? `set "Working branch: ${main.branch}" in the Assignment` : "attach the control checkout to a branch, then set Working branch to that branch"));
    }
    for (const declared of fields.controlWritePaths ?? []) {
      if (/[*?[\]{}]/.test(declared) || (!isAbsolute(declared) && worktree === undefined)) continue;
      const target = resolve(worktree ?? controlRoot, declared);
      // Control-domain codes reuse the probe's ignored/checkoutRoot facts without
      // re-probing; callerCheckoutRoot is omitted because the caller's checkout
      // is not the authority for process state.
      const directoryOnly = declared.endsWith("/");
      const ownership = probePathOwnership({ path: target, kind: directoryOnly ? "directory" : "file" }, controlRoot);
      // A slash-less target may name a file or a directory; only a location ignored in both shapes is safe to write.
      const directory = directoryOnly ? ownership : probePathOwnership({ path: target, kind: "directory" }, controlRoot);
      if (ownership.ignored === false || directory.ignored === false) {
        violations.push(violation("high", "dispatch.control-write.target-committable",
          `control write target ${target} is not Git-ignored and content there would be committed`,
          "declare only gitignored process targets, or dispatch the change on a work branch with Write domain: work"));
      }
      if (ownership.ignored === null || directory.ignored === null) {
        violations.push(violation("medium", "dispatch.control-write.target-unverifiable",
          `cannot verify the Git ignore status of control write target ${target}`,
          `run git -C "${controlRoot}" check-ignore -v -- "${target}" "${target}/", then rerun mstar dispatch validate`));
      }
      if (ownership.checkoutRoot === null || canonicalizeNearestExisting(ownership.checkoutRoot) !== controlRoot) {
        violations.push(violation("high", "dispatch.control-write.target-outside-control",
          `control write target ${target} is not in the control checkout ${controlRoot}`,
          `set Control write paths to targets inside ${controlRoot}`));
      }
    }
    return violations;
  } catch {
    return [unresolved];
  }
}

/**
 * Flag writable work on a default protected branch (`main`/`master` per
 * project convention) unless an explicit direct-on exception is present
 * (mstar-branch-worktree § "Git 功能分支门禁"). `directOnException` mirrors
 * the Assignment carrying `Branch policy: direct on <branch> — <reason>`.
 */
export function assertDefaultBranchProtected(branch: string, opts: DefaultBranchOptions = {}): GateResult {
  const defaultBranches = opts.defaultBranches ?? ["main", "master"];
  const violations: ValidationResult[] = [];
  const normalized = branch.trim();

  if (normalized !== "" && defaultBranches.includes(normalized) && opts.directOnException !== true) {
    violations.push(
      violation(
        "high",
        "dispatch.default-branch.protected",
        `writable work on default protected branch "${normalized}" requires an explicit direct-on exception`,
        `add "Branch policy: direct on ${normalized} \u2014 <reason>" to the Assignment, or use a feature branch`,
      ),
    );
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Map an Assignment `Execution mode` to its QC seat count N
 * (mstar-dispatch-gates § QC tri / 单席 / targeted): `sdd` → 3 (tri),
 * `inline` → 1, `targeted` → the listed reviewer seats. Unknown or missing
 * modes are violations.
 */
export function executionModeToN(executionMode: string, opts: ExecutionModeToNOptions = {}): ExecutionModeToNResult {
  const violations: ValidationResult[] = [];
  const mode = executionMode.trim().toLowerCase().split(/\s+/)[0] ?? "";
  let n: number | undefined;

  if (mode === "") {
    violations.push(
      violation("high", "dispatch.execution-mode.missing", "missing required Assignment field: Execution mode", 'add "**Execution mode**: sdd | inline | targeted"'),
    );
  } else if (mode === "sdd") {
    n = 3;
  } else if (mode === "inline") {
    n = 1;
  } else if (mode === "targeted") {
 // Dedupe the listed reviewer seats before counting : the same
 // seat listed twice is still one dispatch seat — N = distinct seats.
    const seats = [...new Set((opts.seats ?? []).map((s) => s.trim()).filter((s) => s !== ""))];
    if (seats.length === 0) {
      violations.push(
        violation(
          "high",
          "dispatch.execution-mode.missing-seats",
          'execution mode "targeted" requires listed reviewer seats',
          'add "QC re-review: targeted \u2014 reviewers: <role-id>, \u2026" to the Assignment and pass the seats',
        ),
      );
    } else if (seats.length > 3) {
      violations.push(
        violation(
          "high",
          "dispatch.execution-mode.too-many-seats",
          `execution mode "targeted" lists ${seats.length} reviewer seats \u2014 at most 3 (targeted re-review seats are the tri seats, N = 1\u20133)`,
          "list at most three reviewer seats for the targeted re-review",
        ),
      );
    } else {
      n = seats.length;
    }
  } else {
    violations.push(
      violation(
        "high",
        "dispatch.execution-mode.unknown",
        `unknown execution mode "${executionMode.trim()}" (expected sdd | inline | targeted)`,
        "fix the Execution mode field",
      ),
    );
  }

  return n === undefined ? { ok: false, violations } : { ok: true, violations, n };
}

/**
 * Assert the initial review wave's reviewer roles are exactly
 * `qc-specialist` / `qc-specialist-2` / `qc-specialist-3`
 * (mstar-dispatch-gates § QC tri-review; mstar-roles QC reviewer 参数表).
 * Any other composition — missing seat, duplicate, or foreign role — fails.
 */
export function assertTriIdentity(reviewerRoles: readonly string[]): GateResult {
  const tri = ["qc-specialist", "qc-specialist-2", "qc-specialist-3"] as const;
  const roles = reviewerRoles.map((r) => r.trim().toLowerCase()).filter((r) => r !== "");
  const valid =
    roles.length === tri.length &&
    new Set(roles).size === tri.length &&
    roles.every((r) => (tri as readonly string[]).includes(r));

  if (valid) return { ok: true, violations: [] };
  const got = roles.length > 0 ? roles.join(", ") : "(none)";
  return {
    ok: false,
    violations: [
      violation(
        "high",
        "dispatch.tri-identity.invalid",
        `tri-review initial wave must be exactly qc-specialist / qc-specialist-2 / qc-specialist-3, got: ${got}`,
        "dispatch qc-specialist, qc-specialist-2 and qc-specialist-3 for the initial wave",
      ),
    ],
  };
}
/**
 * True when the document declares Assignment front matter: a front matter
 * block carrying at least one core field key (`execute_as` / `delegation` /
 * `task_category`). This is the SINGLE shape-guard grammar shared by the
 * omp hook and the opencode adapter via {@link composeDispatchGate}, and it
 * is a front matter check — non-Assignment prompts (no opening fence, or
 * front matter without a core key) stay silent with no false positives,
 * including a prompt that merely quotes the Assignment template in its
 * body. The key PATTERN is the shape evidence, not the parse result, so
 * invalid front matter YAML that still carries the key line is shaped
 * (fail-closed: the schema layer then reports the parse refusal) — and an
 * opening fence that never closes counts as evidence too, so the malformed
 * document reaches schema validation (`document.frontmatter.absent`)
 * instead of passing for an ordinary prompt.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
function isAssignmentShaped(assignmentText: string): boolean {
  const { yaml } = assignmentFrontmatter(assignmentText);
  if (yaml === "") return false;
  return ASSIGNMENT_FIELD_RE.test(yaml);
}

/**
 * Shape-guard match of a retired body-label core field in ANY of its three
 * forms — a plain `Execute as:` line, a bold `**Execute as**:` line, or a
 * list-prefixed `- **Execute as**:` line (indentation and a numeric or
 * bullet list marker are formatting, never the field). Detection ONLY:
 * it never reads a field value. The ONE engine-owned copy of the retired
 * grammar (compass D16); hosts and the CLI call this instead of keeping
 * their own regex copies.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
function legacyLabelKey(line: string): string | undefined {
  const match = /^[ \t]*(?:(?:\d+[.)]|[-+*])[ \t]+)?(?:\*\*[ \t]*)?(Execute as|Delegation|Task category|Working branch|Branch policy|Execution mode|Write domain|Worktree path)[ \t]*(?:\*\*)?[ \t]*:/.exec(line);
  return match?.[1];
}

/**
 * D16 shape detection: true when the document carries its fields in the
 * RETIRED body-label grammar — at least TWO distinct core labels, so a
 * single bolded field line in ordinary prose never shapes a document as
 * an Assignment; the `## Assignment` heading is irrelevant either way. A
 * fenced front matter document is never legacy-shaped. The ONE engine
 * export of this recognition — shape-only, prose-safe semantics; it never
 * reads field values.
 */
export function legacyAssignmentShape(text: string): boolean {
  if (/^---[ \t]*\r?\n/.test(text)) return false;
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const key = legacyLabelKey(line);
    if (key !== undefined) found.add(key);
    if (found.size >= 2) return true;
  }
  return false;
}

/**
 * Build the ONE D16 legacy-format refusal violation (compass D16; front
 * matter is the only field contract). The fix names BOTH recoveries — the
 * front matter rewrite and the `Assignment file:` pointer — and the pointer
 * must target a REWRITTEN front-matter assignment, not the same invalid
 * bytes. Hosts and the CLI call this builder instead of formatting their
 * own copies.
 *
 * `terminal`: a retired-format document declares no front matter, so there
 * is no declaration a gate can verify — the refusal is a veto on every
 * host that CAN refuse, independent of the soft/hard setting (advisory
 * only where the host has no refusal channel at all, `I-001258`).
 */
export function legacyFormatViolation(): ValidationResult {
  return {
    ...violation(
      "high",
      "dispatch.assignment.legacy-format",
      "the Assignment carries its fields as `**Label**` body lines \u2014 the retired format; front matter is the only field contract",
      "rewrite the assignment as a front-matter document (a `---`-fenced YAML block declaring the snake_case keys, e.g. execute_as / working_branch), or pass it as an `Assignment file: <abs>` pointer under an accepted assignment home pointing at the rewritten document",
    ),
    terminal: true,
  };
}

/**
 * Options for {@link composeDispatchGate}.
 */
export type ComposeDispatchGateOptions = {
  /**
 * Dispatching agent's OWN harness role (dsh `Config.dispatchBinding`).
 * When non-empty, the anti-recursion precheck compares it against the
 * Assignment's `Execute as` — equality is self-recursion
 * (`dispatch.anti-recursion.self-type`, critical). Leave unset on hosts
 * whose tool-call event cannot report the dispatching agent's identity
 * (omp/opencode/cursor): the precheck is skipped there and the NEVER red
 * line stays prompt-level (mstar-dispatch-gates).
 */
  caller?: string;
  /**
 * True on hosts whose contract declares the caller binding mandatory
 * (dsh): an empty/missing `caller` then fails closed with
 * `dispatch.anti-recursion.empty-binding` (critical) — the host could
 * have declared the binding, so an absent one proves nothing and the
 * dispatch must not proceed as if the NEVER red line held. Default
 * `false`: the precheck is skipped entirely when `caller` is empty.
 */
  callerRequired?: boolean;
  /**
 * `false` for read-only roles (scout/explore) — skips the branch-form and
 * default-branch gates. Default: `true` (writable).
 */
  writable?: boolean;
  /** Checkout from which to discover the control worktree. */
  cwd?: string;
  /**
   * Pointer provenance (compass D14): `true` when `text` is the content of
   * a resolved `Assignment file:` carrier (`AssignmentSourceResult.path`
   * was set). A file carrier commits to the Assignment contract — empty or
   * unrelated file content validates as an invalid Assignment with the
   * front matter recovery; the silent non-Assignment pass is reserved for
   * genuinely unshaped inline prompts.
   * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
   */
  fileCarrier?: boolean;
  /**
   * The caller's OWN parse of this document ({@link assignmentFrontmatterEntries}),
   * reused by shape validation, field parsing, the branch-form read and the
   * enforcement read — a host decision parses its resolved document once.
   * `null` (unparseable block) is not a reuse by itself: with
   * {@link ComposeDispatchGateOptions.parseError} absent the schema layer
   * reports its own line-numbered refusal; with the parse's structured
   * diagnostic handed over the schema layer reuses it and does not re-parse.
   * Omitted → the composition parses.
   * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
   */
  entries?: Map<string, FrontmatterEntry> | null;
  /**
   * The structured refusal of the CALLER's parse ({@link DocumentFrontmatterError}
   * from {@link assignmentFrontmatterParse}), carried with `entries: null` so
   * a malformed block is parsed ONCE per decision: the schema layer reports
   * the exact line-numbered cause from this diagnostic instead of re-parsing
   * the rejected block. `null` (a non-structured failure) falls back to the
   * schema layer's own parse. Omitted (hosts that do not thread it) → the
   * schema layer re-parses a rejected block, as before.
   * see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
   */
  parseError?: DocumentFrontmatterError | null;
  /**
   * Source-relative base for a `worktree_path` declared by a POINTED file
   * (that file's own directory, CLI parity, compass D14). Deliberately
   * separate from {@link cwd}: `cwd` still anchors Git control discovery, so
   * an assignment home outside the repository never changes which checkout
   * the gate inspects.
   * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
   */
  assignmentDir?: string;
};

/**
 * Result of {@link composeDispatchGate}: a GateResult plus the shape verdict
 * and the header-region enforcement flag.
 */
export type ComposeDispatchGateResult = GateResult & {
 /**
  * Assignment shape was recognized: front matter carrying a core key, or the
  * retired body-label grammar (which the composition then refuses).
  * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
  */
  shaped: boolean;
 /**
  * Enforcement parsed from the Assignment front matter only (never the body).
  * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
  */
  enforcement: EnforcementFlag;
};

/**
 * Shared host dispatch-gate composition — the SINGLE dispatch-validation composition consumed by
 * the opencode adapter (`validateDispatchAssignment`) and the omp blocking
 * hook (Gate 2):
 *
 * 1. Shape guard: a front matter block carrying a core field key
 * (`execute_as` / `delegation` / `task_category`) — a complete fence, or an
 * unterminated one, which then reaches schema validation and is refused.
 * Text without Assignment front matter passes silently (`shaped: false`).
 * 2. `validateAssignmentFields` with `writable: false` when `opts.writable
 * === false` (read-only roles), else the writable default.
 * 3. Anti-recursion precheck — CALLER semantics (issue #156): runs only
 * when the host supplies its own role binding (`caller`), or fails
 * closed on an empty one when the host contract requires it
 * (`callerRequired`, dsh). A caller equal to `Execute as` is the
 * `dispatch.anti-recursion.self-type` critical; a required-but-empty
 * caller is `dispatch.anti-recursion.empty-binding`. Target-only hosts
 * (omp/opencode/cursor) skip the leg — their binding field carries the
 * spawn TARGET, which equals `Execute as` on every compliant dispatch.
 * 4. Default-branch gate for writable text: the branch comes from the
 * Assignment's own branch forms (create-form name / Working branch /
 * Branch policy branch), else `$MSTAR_WORKING_BRANCH`; a well-formed
 * `Branch policy: direct on <branch> — <reason>` exception is honored
 * only when its branch is the one being checked.
 * 5. Enforcement flag parsed from the Assignment front matter only; the
 * result carries `hardBlocked` via `applyEnforcement`.
 *
 * Never throws on text errors: unexpected failures degrade to the same
 * silent non-shaped result.
 */
export function composeDispatchGate(text: string, opts: ComposeDispatchGateOptions = {}): ComposeDispatchGateResult {
  const silent: ComposeDispatchGateResult = {
    ok: true,
    violations: [],
    shaped: false,
    enforcement: { hard: false, source: "none" },
  };
  try {
    const fileCarrier = opts.fileCarrier === true;
    // D16 — the retired body-label grammar is refused HERE, once, for every
    // host: the document declares no front matter, so the refusal is
    // terminal (no verified declaration exists) and soft enforcement never
    // downgrades it. Its `document.frontmatter.absent` sibling below
    // describes the same defect, so that row is superseded.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    const legacy = legacyAssignmentShape(text);
    // Shape: Assignment front matter carrying a core key, OR the retired
    // body-label grammar — the latter must reach its refusal, never pass as
    // an ordinary prompt.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    const shaped = legacy || isAssignmentShaped(text);
    if (!shaped && !fileCarrier) return silent;

    const violations: ValidationResult[] = legacy ? [legacyFormatViolation()] : [];
    const writable = opts.writable !== false;

    // One parse per decision: the document front matter is parsed ONCE — by
    // the caller when it hands its own parse in (`entries`), else here — and
    // the entries are reused by schema validation, field parsing, the
    // enforcement read and every gate below, never reparsed per leg.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    const { yaml } = assignmentFrontmatter(text);
    const entries = opts.entries !== undefined ? opts.entries : safeEntries(yaml);
    const fields = parseAssignmentFieldsFromFrontmatter(entries);
    const forms = branchFormsFromFields(fields);

 // (2) Engine full field validation — read-only roles skip the branch-form gate.
    // Every field/branch read below (and in the validator) is front
    // matter-scoped by the parsers themselves (`parseAssignmentFields` /
    // `parseAssignmentBranchForms` slice the front matter), so passing the
    // whole dispatch here is safe by construction: a field quoted in the
    // task body can neither satisfy nor disable a gate. `fileCarrier` marks
    // a resolved `Assignment file:` carrier: its content must validate as an
    // Assignment even when no core key is recognized.
 // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    violations.push(
      ...validateAssignmentFields(text, { writable, fileCarrier, entries, parseError: opts.parseError }).violations.filter(
        (schemaViolation) => !(legacy && schemaViolation.code === "document.frontmatter.absent"),
      ),
    );

 // (3) Anti-recursion NEVER red line — CALLER identity vs the dispatch's
 // `Execute as` (issue #156: the spawn-target binding omp/opencode/cursor
 // carry can never run this check soundly — target == `Execute as` is the
 // documented compliant pattern, so those hosts skip the leg). Runs when
 // the host supplies its own role (`caller`), or fails closed when the
 // host contract makes that binding mandatory (`callerRequired`, dsh).
    const caller = opts.caller ?? "";
    if (caller.trim() !== "" || opts.callerRequired === true) {
      violations.push(...antiRecursionPrecheck(caller, fields.executeAs ?? "").violations);
    }

 // (4) Default-branch gate for writable text — branch from the
 // Assignment's own forms, else $MSTAR_WORKING_BRANCH (env fallback
 // shared by all adapters / ).
    if (writable && fields.writeDomain === "control") {
      violations.push(...validateControlWriteAssignment(text, { cwd: opts.cwd, assignmentDir: opts.assignmentDir, fields, forms }));
    } else if (writable) {
      const branch =
        forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch ?? process.env.MSTAR_WORKING_BRANCH;
      if (branch !== undefined && branch.trim() !== "") {
        const directOnException = forms.directOn !== undefined && forms.directOn.reason !== "" && forms.directOn.branch === branch.trim();
        violations.push(...assertDefaultBranchProtected(branch.trim(), { directOnException }).violations);
      }
    }

    // why: (4b) the control root tracked-change gate covers EVERY writable dispatch, not only
    // the work domain: the question ("does the process-SSOT checkout hold
    // committable changes?") is domain-independent. A repository with no harness
    // has no control-root contract, so the leg skips rather than refuses; an
    // unresolved control root keeps the existing behaviour (no second code on
    // top of the control-domain refusal that domain already emits).
    if (writable) {
      const main = readMainWorktree(opts.cwd ?? process.cwd());
      if (main !== null && hasHarnessRoot(main.root)) {
        violations.push(...assertControlClean({ controlRoot: main }).violations);
      }
    }

 // (5) Front matter only: an example `enforcement: hard` key quoted in the
     // task body must not harden the dispatch. The enforcement read reuses
     // the decision's single parse (entries) instead of reparsing the text.
 // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    const enforcement = parseEnforcementFlagFromFrontmatter(entries);
    const gate: GateResult = { ok: violations.length === 0, violations };
    return { ...applyEnforcement(gate, { hard: enforcement.hard }), shaped, enforcement };
  } catch {
    return silent;
  }
}

/**
 * Anti-recursion precheck (NEVER red line, mstar-dispatch-gates § 承接方反递归
 * 红线): a leaf executor MUST NOT dispatch a Task/subagent whose target role
 * (the new Assignment's `Execute as`) equals its OWN role. `subagentType`
 * is therefore the DISPATCHING agent's own role binding (dsh
 * `Config.dispatchBinding`) — never the spawn-target field (omp `agent` /
 * opencode `subagent`), which equals `Execute as` on every compliant
 * dispatch (issue #156). Comparison is case-insensitive after trim. An
 * EMPTY binding fails closed (`dispatch.anti-recursion.empty-binding`,
 * critical): the host cannot report which agent is calling, so
 * anti-recursion cannot be proven — the dispatch must not proceed as if
 * the NEVER red line held. An empty `executeAs` with a set binding stays
 * ok (field presence is `validateAssignmentFields`' job, not this
 * precheck).
 */
export function antiRecursionPrecheck(subagentType: string, executeAs: string): GateResult {
  const binding = subagentType.trim().toLowerCase();
  const role = executeAs.trim().toLowerCase();

  if (binding === "") {
    return {
      ok: false,
      violations: [
        violation(
          "critical",
          "dispatch.anti-recursion.empty-binding",
          `empty caller role binding \u2014 the host cannot report which agent is calling, so anti-recursion cannot be proven (a dispatch could silently recurse)`,
          "declare the dispatching agent's own role binding (dsh Config `dispatchBinding`) before dispatching",
        ),
      ],
    };
  }
  if (binding === role) {
    return {
      ok: false,
      violations: [
        violation(
          "critical",
          "dispatch.anti-recursion.self-type",
          `recursive dispatch refused: role binding "${subagentType}" equals Execute as "${executeAs}" (leaf executors must not re-invoke their own role)`,
          "complete the work in this session, or return Blocked to project-manager",
        ),
      ],
    };
  }
  return { ok: true, violations: [] };
}
/**
 * Result of {@link readAssignmentSource}: on success the Assignment text plus
 * the resolved pointer path when a file supplied it; on refusal a single
 * violation-shaped record — `dispatch.assignment.path` (unreadable,
 * out-of-home, relative, or unrooted pointer) or
 * `dispatch.assignment.ambiguous` (pointer plus an inline body).
 */
export type AssignmentSourceResult =
  | { ok: true; text: string; path?: string }
  | (ValidationResult & { ok: false });

/**
 * The ONE pointer-line grammar: `Assignment file: <abs>` on a line of its own.
 * A pointer INVOKES the file-source semantics only as the input's first
 * non-blank line — any later occurrence is a mention (prose, a quoted block,
 * a fenced example) inside an inline document, so it carries no semantics.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
const ASSIGNMENT_POINTER_RE = /^[ \t]*Assignment file:[ \t]*(\S[^\r\n]*?)[ \t]*$/;

/**
 * Shared recovery text of the two refusals: home placement OR the inline form.
 * see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
 */
const ASSIGNMENT_SOURCE_RECOVERY =
  "move the assignment file under an accepted assignment home (`<base>/<identity>/assignments` of the sdd, iteration or workflow base, or `{HARNESS_DIR}/assignments`), or pass the assignment inline as a front-matter document instead of a pointer";

function assignmentSourceRefusal(code: string, message: string, fix: string): AssignmentSourceResult {
  // Terminal by contract: a source-resolution refusal means there is no
  // verified assignment to dispatch on, so it is a veto for every caller
  // independent of enforcement settings — no enforcement hardening step is
  // needed and none may soften it.
  // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
  return { ok: false, severity: "critical", code, message, fix, terminal: true };
}

/**
 * True when the canonical `file` sits inside the assignment `home`
 * (compass D14). Containment is computed with `path.relative(root, file)`
 * — never string concatenation, which breaks when the canonical root is
 * the filesystem root itself (root + sep would be `//`). A `..`-prefixed
 * or absolute relative result is outside. The read-only harness home is
 * complete (`{HARNESS_DIR}/assignments`); a write home root is the bare
 * base, so the file must additionally sit under `<base>/<one
 * segment>/assignments` — a file directly in the base (or in a stray
 * sibling tree) is not an assignment source.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
function assignmentHomeContains(file: string, home: { root: string; write: boolean }): boolean {
  const root = canonicalizeNearestExisting(home.root);
  const relativePath = relative(root, file);
  // Reader/writer agreement: only the exact parent segment escapes the home.
  // The writer (`assertSafePathComponent`) accepts a one-segment identity
  // beginning with two dots (`..draft`) as long as it is not the exact `..`
  // segment, so the reader rejects only `..` itself or `..` followed by the
  // platform separator — never an ordinary leading-dot child name.
  // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return false;
  if (!home.write) return true;
  const segments = relativePath.split(sep);
  return segments.length >= 3 && segments[1] === "assignments";
}

/**
 * Resolve one Assignment source (compass D14 — the single resolver every
 * consumer shares). An inline front-matter document passes through verbatim
 * without any filesystem access. A pointer line `Assignment file: <abs>` as
 * the FIRST non-blank line is the whole input: any non-whitespace content
 * alongside it refuses `dispatch.assignment.ambiguous`. A pointer line
 * anywhere else is a mention inside an inline document (prose, a quoted
 * block, a fenced example) and carries no semantics. The pointer must be
 * absolute and, after canonicalization with `canonicalizeNearestExisting`
 * (a symlink landing outside the home is outside), contained in one of the
 * four homes from `assignmentSourceHomes` — a `null` harness root refuses
 * `dispatch.assignment.path` rather than skipping containment. An
 * unreadable or out-of-home pointer refuses `dispatch.assignment.path` with
 * both recoveries (place under an accepted home OR pass the assignment
 * inline).
 */
export function readAssignmentSource(text: string, opts: { harnessDir: string | null }): AssignmentSourceResult {
  // The pointer form is the input's FIRST non-blank line; a pointer line
  // further down is a mention inside an inline document and stays inert.
  // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  const pointerMatch = first === -1 ? null : ASSIGNMENT_POINTER_RE.exec(lines[first]!);
  if (pointerMatch === null) return { ok: true, text };
  // Pointer plus anything else is two sources in one dispatch: refuse.
  // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
  if (lines.slice(first + 1).some((line) => line.trim() !== "")) {
    return assignmentSourceRefusal(
      "dispatch.assignment.ambiguous",
      `assignment source is ambiguous: an \`Assignment file:\` pointer appears alongside an inline assignment document`,
      "choose ONE source form \u2014 drop the inline body and keep the pointer, or drop the pointer and pass the assignment inline (a pointer line quoted inside ordinary inline content is inert and needs no action)",
    );
  }
  const pointer = pointerMatch[1]!;
  if (!isAbsolute(pointer)) {
    return assignmentSourceRefusal(
      "dispatch.assignment.path",
      `assignment pointer must be an absolute path \u2014 got ${JSON.stringify(pointer)}`,
      ASSIGNMENT_SOURCE_RECOVERY,
    );
  }
  if (opts.harnessDir === null) {
    return assignmentSourceRefusal(
      "dispatch.assignment.path",
      `assignment pointer ${pointer} cannot be containment-checked: the control harness root is unavailable`,
      "pass the assignment inline as a front-matter document instead of a pointer, or restore the control harness root",
    );
  }
  const file = canonicalizeNearestExisting(pointer);
  if (!assignmentSourceHomes(opts.harnessDir).some((home) => assignmentHomeContains(file, home))) {
    return assignmentSourceRefusal(
      "dispatch.assignment.path",
      `assignment pointer ${pointer} resolves outside every accepted assignment home \u2014 got ${file}`,
      ASSIGNMENT_SOURCE_RECOVERY,
    );
  }
  // Regular-file guard before any byte read (check-then-use closure): open
  // the canonical path once with O_NOFOLLOW — a FIFO would otherwise block
  // the synchronous dispatch path forever and a post-containment symlink
  // swap would escape the check. fstat the OPEN descriptor (the same inode
  // the bytes come from): a non-regular target refuses with the path
  // recovery; the descriptor is closed on every outcome.
  // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
  let content: string;
  let fd: number | undefined;
  try {
    // O_NONBLOCK matters for the guard itself: a plain O_RDONLY open of a
    // FIFO blocks waiting for a writer, so the type check would never run.
    // O_NOFOLLOW is POSIX-only; on Windows the canonical path already
    // resolved every link, and non-regular targets still fail fstat.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    fd = openSync(file, flags);
    if (!fstatSync(fd).isFile()) {
      return assignmentSourceRefusal(
        "dispatch.assignment.path",
        `assignment pointer ${pointer} does not resolve to a regular file \u2014 got ${file}`,
        ASSIGNMENT_SOURCE_RECOVERY,
      );
    }
    content = readFileSync(fd, "utf8");
  } catch (error) {
    return assignmentSourceRefusal(
      "dispatch.assignment.path",
      `assignment file ${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
      ASSIGNMENT_SOURCE_RECOVERY,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { ok: true, text: content, path: file };
}
