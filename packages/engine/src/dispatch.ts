/**
 * Engine dispatch module — Assignment field validation, default-branch gate,
 * execution-mode → QC seat count, tri identity, anti-recursion precheck.
 *
 * Spec sources (semantic SSOT — the skills stay authoritative; this module
 * implements their deterministic rules without forking semantics):
 * - Assignment field contract (`Execute as` / `Delegation` / `Task category`
 *   present, non-empty; paste-only assignments missing fields are flagged):
 *   `mstar-dispatch-gates` SKILL.md § "调度防串扰（强制）" + § 反模式（派发）
 *   ("Assignment 已写、invoke 为零（paste-only）").
 * - Branch-field exactly-one rule + `<base>` requirement: `mstar-branch-worktree`
 *   SKILL.md § "Assignment 要求（PM）" + § "`<base>` 与叠分支（stacked
 *   branches）" ("若写新建但未写 `<base>`：实现侧应停下问 project-manager…
 *   禁止擅自假设「一定是 main」").
 * - Default-protected-branch gate (`main`/`master` unless an explicit
 *   `Branch policy: direct on <branch> — <reason>` exception exists):
 *   `mstar-branch-worktree` SKILL.md § "Git 功能分支门禁（业务仓库）".
 * - N→seat mapping (sdd→3 tri, inline→1 single, targeted→listed seats) and
 *   tri identity (`qc-specialist` / `qc-specialist-2` / `qc-specialist-3`):
 *   `mstar-dispatch-gates` SKILL.md § "QC tri-review（SDD 强制）" / "QC
 *   单席（例外）" / "QC targeted re-review" + `mstar-roles` SKILL.md
 *   "QC reviewer" 参数表.
 * - Anti-recursion NEVER red line (role binding == `Execute as`): `mstar-dispatch-gates`
 *   SKILL.md § "承接方反递归红线（NEVER / DO NOT；leaf executor 必读）".
 * - Hard-gate enforcement (`Enforcement: hard` flag — per Assignment/compass,
 *   never global; rollback = unset flag): roadmap §8.5 C4 + decision D2.
 */
import { applyEnforcement } from "./core.js";
import type { GateResult, ValidationResult, Severity } from "./core.js";

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
  workingBranch?: string;
  branchPolicy?: string;
};

export type ValidateAssignmentFieldsOptions = {
  /**
   * Whether the assignment produces repo diffs (default `true`). The
   * branch-form exactly-one gate applies to writable assignments only —
   * read-only assignments (explore/scout orientation) legitimately omit
   * branch fields per mstar-branch-worktree ("每个可写 Assignment…").
   */
  writable?: boolean;
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

const REQUIRED_FIELDS: ReadonlyArray<{ key: keyof AssignmentFields; label: string; code: string }> = [
  { key: "executeAs", label: "Execute as", code: "execute-as" },
  { key: "delegation", label: "Delegation", code: "delegation" },
  { key: "taskCategory", label: "Task category", code: "task-category" },
];

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

/**
 * Parse `**Field**: value` (or plain `Field: value`) header lines from an
 * Assignment into the dispatch-relevant fields. Only known field labels are
 * captured; values are trimmed. List-bullet prefixes (`- **Field**: value`)
 * are accepted so the engine parser is the SINGLE grammar for Assignment
 * header fields (the Slice-2 opencode presence parser tolerated bullets;
 * its acceptance is folded into this parser, not forked — qc1 F-002).
 */
export function parseAssignmentFields(assignmentText: string): AssignmentFields {
  const fields: AssignmentFields = {};
  for (const line of assignmentText.split(/\r?\n/)) {
    const match =
      line.match(/^[ \t]*(?:[-*][ \t]+)?\*\*\s*([^*:]+?)\s*\*\*\s*:\s*(.*)$/) ??
      line.match(/^[ \t]*(?:[-*][ \t]+)?([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/);
    if (!match) continue;
    const label = match[1]!.trim();
    const value = match[2]!.trim();
    const known = REQUIRED_FIELDS.find((f) => f.label === label);
    if (known) {
      fields[known.key] = value;
      continue;
    }
    if (label === "Working branch") fields.workingBranch = value;
    else if (label === "Branch policy") fields.branchPolicy = value;
  }
  return fields;
}

/** Where the `Enforcement` flag was declared (roadmap §8.5 C4/D2). */
export type EnforcementSource = "assignment" | "compass" | "none";

/** Parsed hard-enforcement flag. `hard: false` + `source: none` = flag absent. */
export type EnforcementFlag = {
  hard: boolean;
  source: EnforcementSource;
};

/** Assignment form: `**Enforcement**: hard` (bold, optional list bullet). */
const ASSIGNMENT_ENFORCEMENT_BOLD_RE = /^[ \t]*(?:[-*][ \t]+)?\*\*\s*Enforcement\s*\*\*\s*:\s*(.*)$/m;
/** Assignment form: `Enforcement: hard` (plain; distinct from lowercase YAML key). */
const ASSIGNMENT_ENFORCEMENT_PLAIN_RE = /^[ \t]*(?:[-*][ \t]+)?Enforcement\s*:\s*(.*)$/m;
/** Compass form: YAML frontmatter key `enforcement: hard` (lowercase key). */
const COMPASS_ENFORCEMENT_RE = /^enforcement\s*:\s*(.*)$/m;

/** Trim a raw flag value; YAML values may be single/double-quoted (`enforcement: "hard"`). */
function enforcementValue(raw: string): string {
  const value = raw.trim();
  const unquoted = value.replace(/^(['"])(.*)\1$/, "$2");
  return unquoted.trim().toLowerCase();
}

/**
 * Assignment body markers (qc1 F-003 / qc2 F-003): the header region ends at
 * the FIRST of a `# Task`-style heading (any level — SDD task bodies use
 * `## Task N` / `### Task N`), a `---` horizontal-rule separator, or a
 * single-`#` heading (`# Target` / `# Goal` / `# Change`). The `## Assignment`
 * heading itself is NOT a boundary. Quoted Assignment-field examples in the
 * task body AFTER a marker must not be read as header fields.
 */
const ASSIGNMENT_BODY_START_RE = /^(?:#{1,6}[ \t]+Task\b|-{3,}[ \t]*$|#[ \t])/m;

/**
 * Slice an Assignment's header region — the text before the first body
 * marker (see {@link ASSIGNMENT_BODY_START_RE}). Returns the full text when
 * no marker is present. The Assignment enforcement flag is parsed against
 * THIS region only, so an example line `**Enforcement**: hard` quoted in the
 * task body cannot harden the dispatch (qc1 F-003 / qc2 F-003).
 */
export function assignmentHeaderRegion(assignmentText: string): string {
  const marker = assignmentText.match(ASSIGNMENT_BODY_START_RE);
  return marker !== null ? assignmentText.slice(0, marker.index) : assignmentText;
}

/**
 * Parse the `Enforcement: hard` flag (roadmap §8.5 C4 + decision D2 — v2
 * hard gates are OPT-IN per Assignment/compass, never global; rollback =
 * unset flag; inert when the engine is absent).
 *
 * Recognized forms, checked in order:
 * 1. Assignment header `**Enforcement**: hard` / `Enforcement: hard`
 *    (bold or plain, optional list bullet; value case-insensitive).
 * 2. Compass frontmatter YAML key `enforcement: hard` (lowercase key;
 *    value may be quoted, case-insensitive).
 *
 * The Assignment form wins over the compass form when both appear in the
 * input (per-Assignment precedence — a dispatch's own flag is decisive).
 * A present-but-non-hard value (`soft`, empty, malformed) still reports
 * its source so callers can distinguish "explicitly not hard" from
 * "not mentioned" (`source: none`). Never throws.
 *
 * Assignment-form callers MUST pass the header region (see
 * {@link assignmentHeaderRegion}) — this function itself scans the whole
 * input because the compass form is fed raw frontmatter, which has no
 * body markers (qc1 F-003 / qc2 F-003).
 */
export function parseEnforcementFlag(text: string): EnforcementFlag {
  const bold = text.match(ASSIGNMENT_ENFORCEMENT_BOLD_RE);
  if (bold !== null) return { hard: enforcementValue(bold[1]!) === "hard", source: "assignment" };
  const plain = text.match(ASSIGNMENT_ENFORCEMENT_PLAIN_RE);
  if (plain !== null) return { hard: enforcementValue(plain[1]!) === "hard", source: "assignment" };
  const compass = text.match(COMPASS_ENFORCEMENT_RE);
  if (compass !== null) return { hard: enforcementValue(compass[1]!) === "hard", source: "compass" };
  return { hard: false, source: "none" };
}

/**
 * Presence-shape helper: absent → `missing-<code>`, empty → `invalid-<code>`.
 *
 * The three core field violations carry `assignment.presence.*` ALIAS codes:
 * the Slice-2 opencode presence namespace is kept as engine aliases (qc1
 * F-002) — same single parser, one violation per missing field, both
 * namespaces observable on that one violation.
 */
function requireField(violations: ValidationResult[], value: string | undefined, label: string, code: string): void {
  if (value === undefined) {
    const v = violation(
      "high",
      `assignment.field.missing-${code}`,
      `missing required Assignment field: ${label}`,
      `add "**${label}**: <value>" to the Assignment`,
    );
    v.aliases = [`assignment.presence.missing-${code}`];
    violations.push(v);
  } else if (value === "") {
    const v = violation(
      "high",
      `assignment.field.invalid-${code}`,
      `${label} must be non-empty`,
      `fill in "**${label}**: <value>"`,
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
 * regexes (qc1 F-001 / qc3 F-3).
 */
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
 * Parse one `Working branch` value into its form. Create-form token match is
 * case-insensitive (`CREATE <new> from <base>`); values that do not match the
 * exact form (e.g. "created", "create/foo", "create-user-flow") are
 * existing-branch names. Dangling create-form typos — `create <new> from`
 * (trailing `from`, no base) and `create from <base>` (name missing) — are
 * recognized as create-forms so `validateAssignmentFields` can flag them
 * (qc2 S-1 / qc3 F-5, fail-open fixed).
 */
function parseWorkingBranchValue(
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
 * Parse an Assignment's branch forms via the engine's single parser
 * (`parseAssignmentFields` + {@link parseWorkingBranchValue}). Consumed by
 * the CLI `dispatch validate` gate-branch derivation and the opencode hook;
 * also the internal grammar behind `validateAssignmentFields`.
 */
export function parseAssignmentBranchForms(assignmentText: string): AssignmentBranchForms {
  const fields = parseAssignmentFields(assignmentText);
  const forms: AssignmentBranchForms = {};
  if (fields.workingBranch !== undefined && fields.workingBranch !== "") {
    const parsed = parseWorkingBranchValue(fields.workingBranch);
    if (parsed.createForm !== undefined) forms.createForm = parsed.createForm;
    else forms.workingBranch = parsed.workingBranch;
  }
  if (fields.branchPolicy !== undefined && fields.branchPolicy !== "") {
    // Loose prefix capture (gate target) + strict full-form capture (reason).
    // simplify: separator `\s*` on both sides permits zero-width pathological
    // spacing ("direct on main -hotfix — reason" splits into branch "main" +
    // reason "hotfix — reason"); accepted (qc2 S-6) — greedy `\S+` parses
    // realistic hyphenated branch names correctly. Tighten to `\s+(?:[—–]|--|-)\s*`
    // if mis-splits ever surface.
    const direct = fields.branchPolicy.match(/^direct\s+on\s+(\S+)/i);
    if (direct) {
      const strict = fields.branchPolicy.match(/^direct\s+on\s+(\S+)(?:\s*(?:[\u2014\u2013]|--|-)\s*(.+))?$/);
      forms.directOn = { branch: direct[1]!.trim(), reason: strict ? (strict[2] ?? "").trim() : "" };
    }
  }
  return forms;
}

/**
 * Parse the Assignment's `Branch policy: direct on <branch> — <reason>`
 * exception branch. Returns the branch ONLY for the well-formed direct-on
 * form (branch + non-empty reason; separator set [—–]|--|-); undefined when
 * absent or malformed — the default-branch gate recognizes explicit
 * direct-on exceptions only. Single engine grammar shared by CLI + plugin
 * (qc1 F-001).
 */
export function parseBranchPolicyDirectOnBranch(assignmentText: string): string | undefined {
  const directOn = parseAssignmentBranchForms(assignmentText).directOn;
  return directOn !== undefined && directOn.reason !== "" ? directOn.branch : undefined;
}

/**
 * True when the Assignment's `Execute as` role is a read-only orientation
 * role (`scout` / `explore`, case-insensitive). Read-only assignments
 * legitimately omit branch forms (mstar-branch-worktree § "每个可写
 * Assignment…") — callers pass `validateAssignmentFields(text, { writable:
 * false })` and skip the default-branch gate for them (qc3 F-1 / qc2 S-5).
 */
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
 * Writable assignments must carry EXACTLY ONE branch form; `create <new>
 * from <base>` without `<base>` (incl. the dangling `create <new> from`
 * / `create from <base>` typos) and `Branch policy` without branch/reason
 * are flagged. The three core-field violations carry the legacy
 * `assignment.presence.*` codes as aliases (qc1 F-002).
 */
export function validateAssignmentFields(assignmentText: string, opts: ValidateAssignmentFieldsOptions = {}): GateResult {
  const violations: ValidationResult[] = [];
  const fields = parseAssignmentFields(assignmentText);
  const writable = opts.writable !== false;

  for (const { key, label, code } of REQUIRED_FIELDS) {
    requireField(violations, fields[key], label, code);
  }

  if (writable) {
    const workingPresent = fields.workingBranch !== undefined && fields.workingBranch !== "";
    const policyPresent = fields.branchPolicy !== undefined && fields.branchPolicy !== "";
    const formCount = Number(workingPresent) + Number(policyPresent);
    const forms = parseAssignmentBranchForms(assignmentText);

    if (formCount === 0) {
      violations.push(
        violation(
          "high",
          "assignment.field.branch-missing",
          "writable assignment must contain exactly one branch form",
          `add exactly one of: ${BRANCH_FORMS_HINT}`,
        ),
      );
    } else if (formCount > 1) {
      violations.push(
        violation(
          "high",
          "assignment.field.branch-multiple",
          `writable assignment contains ${formCount} branch forms (Working branch + Branch policy) \u2014 exactly one required`,
          `keep exactly one of: ${BRANCH_FORMS_HINT}`,
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
            `create-form Working branch is incomplete: "${fields.workingBranch}" (expected "create <new-branch> from <base>")`,
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
            `unparseable Branch policy: "${fields.branchPolicy}" (expected "direct on <branch> \u2014 <reason>")`,
            "start the field with `direct on <branch>`",
          ),
        );
      } else if (direct.reason === "") {
        violations.push(
          violation(
            "high",
            "assignment.field.branch-policy-missing-reason",
            `Branch policy "direct on ${direct.branch}" is missing the reason`,
            'append "\u2014 <reason>" after the branch name',
          ),
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
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
    // Dedupe the listed reviewer seats before counting (qc2 S-3): the same
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
 * Assert the initial QC wave's reviewer roles are exactly
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
 * `## Assignment` heading marker (shared shape-guard — qc1 F-006): a
 * document carrying this heading is treated as Assignment-shaped and linted
 * even when none of the three core fields is found.
 */
const ASSIGNMENT_HEADING_RE = /^#{1,6}\s+Assignment\s*$/m;

/**
 * Shape-guard match of an Assignment header field, tolerating optional list
 * bullets and `**bold**` markers around the key (`- **Execute as**: x`).
 * The value must be non-empty (`(\S.*)`) — a bare `Delegation:` counts as
 * missing. Shape detection ONLY: field parsing/semantics live in
 * `parseAssignmentFields` / `validateAssignmentFields`.
 */
const ASSIGNMENT_FIELD_RE =
  /^[ \t]*(?:[-*][ \t]+)?\*{0,2}(Execute as|Delegation|Task category)\*{0,2}[ \t]*:[ \t]*(\S.*)$/gm;

/**
 * True when the text looks like an Assignment: carries the `## Assignment`
 * heading or at least one core field line (`Execute as` / `Delegation` /
 * `Task category`). Non-Assignment prompts stay silent — no false positives.
 * This is the SINGLE shape-guard grammar shared by the omp hook and the
 * opencode adapter via {@link composeDispatchGate} (qc1 F-006).
 */
function isAssignmentShaped(assignmentText: string): boolean {
  return ASSIGNMENT_HEADING_RE.test(assignmentText) || assignmentText.match(ASSIGNMENT_FIELD_RE) !== null;
}

/**
 * Options for {@link composeDispatchGate}.
 */
export type ComposeDispatchGateOptions = {
  /**
   * Host role-binding field (omp task entry `agent` / opencode `subagent` /
   * cursor `subagent_type`); the anti-recursion precheck runs only when
   * non-empty.
   */
  agent?: string;
  /**
   * `false` for read-only roles (scout/explore) — skips the branch-form and
   * default-branch gates. Default: `true` (writable).
   */
  writable?: boolean;
};

/**
 * Result of {@link composeDispatchGate}: a GateResult plus the shape verdict
 * and the header-region enforcement flag.
 */
export type ComposeDispatchGateResult = GateResult & {
  /** Assignment-shaped text was recognized (heading or core-field regex). */
  shaped: boolean;
  /** Enforcement parsed from the Assignment HEADER region only (never the body). */
  enforcement: EnforcementFlag;
};

/**
 * Shared host dispatch-gate composition (qc1 F-001/F-006, qc2 F-005/F-007,
 * qc3 F-007/F-008) — the SINGLE dispatch-validation composition consumed by
 * the opencode adapter (`validateDispatchAssignment`), the omp blocking hook
 * (Gate 2) and the `mstar_dispatch_validate` tool:
 *
 * 1. Shape guard: `## Assignment` heading OR any core field line
 *    (`Execute as` / `Delegation` / `Task category`). Text that is not
 *    Assignment-shaped passes silently (`shaped: false`).
 * 2. `validateAssignmentFields` with `writable: false` when `opts.writable
 *    === false` (read-only roles), else the writable default.
 * 3. Anti-recursion precheck when `opts.agent` is non-empty.
 * 4. Default-branch gate for writable text: the branch comes from the
 *    Assignment's own branch forms (create-form name / Working branch /
 *    Branch policy branch), else `$MSTAR_WORKING_BRANCH`; a well-formed
 *    `Branch policy: direct on <branch> — <reason>` exception is honored
 *    only when its branch is the one being checked.
 * 5. Enforcement flag parsed from the Assignment HEADER region only; the
 *    result carries `hardBlocked` via `applyEnforcement`.
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
    if (!isAssignmentShaped(text)) return silent;

    const violations: ValidationResult[] = [];
    const writable = opts.writable !== false;

    // (2) Engine full field validation — read-only roles skip the branch-form gate.
    violations.push(...validateAssignmentFields(text, { writable }).violations);

    // (3) Anti-recursion NEVER red line (engine gate; warn/error in adapters).
    const agent = (opts.agent ?? "").trim();
    if (agent !== "") {
      violations.push(...antiRecursionPrecheck(agent, parseAssignmentFields(text).executeAs ?? "").violations);
    }

    // (4) Default-branch gate for writable text — branch from the
    // Assignment's own forms, else $MSTAR_WORKING_BRANCH (env fallback
    // shared by all adapters, qc1 F-002 / qc2 F-007 / qc3 F-008).
    if (writable) {
      const forms = parseAssignmentBranchForms(text);
      const branch =
        forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch ?? process.env.MSTAR_WORKING_BRANCH;
      if (branch !== undefined && branch.trim() !== "") {
        const directOnException = parseBranchPolicyDirectOnBranch(text) === branch.trim();
        violations.push(...assertDefaultBranchProtected(branch.trim(), { directOnException }).violations);
      }
    }

    // (5) Header region only: an example `**Enforcement**: hard` line quoted
    // in the task body must not harden the dispatch (qc1 F-003 / qc2 F-003).
    const enforcement = parseEnforcementFlag(assignmentHeaderRegion(text));
    const gate: GateResult = { ok: violations.length === 0, violations };
    return { ...applyEnforcement(gate, { hard: enforcement.hard }), shaped: true, enforcement };
  } catch {
    return silent;
  }
}

/**
 * Anti-recursion precheck (NEVER red line, mstar-dispatch-gates § 承接方反递归
 * 红线): a leaf executor MUST NOT invoke a Task/subagent whose role-binding
 * field (`subagent_type` / `agent` / `subagent`) equals its own `Execute as`.
 * Comparison is case-insensitive after trim; an empty binding is not a
 * self-recursion (its presence is the field gate's job, not this precheck).
 */
export function antiRecursionPrecheck(subagentType: string, executeAs: string): GateResult {
  const binding = subagentType.trim().toLowerCase();
  const role = executeAs.trim().toLowerCase();

  if (binding !== "" && binding === role) {
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
