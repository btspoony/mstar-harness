/**
 * Engine iteration module — compass frontmatter schema, phase-transition
 * gate evaluation, push-cadence probe, iteration index obligations.
 *
 * Spec sources (each export cites the skill/reference section it enforces):
 * - Compass template + frontmatter fields (iteration_id / start_date /
 *   status / iteration_base_branch / target_branch / plans; `end_date` only
 *   at close): `mstar-iteration` SKILL.md §1.3 +
 *   `mstar-iteration/references/iteration-compass-template.md` Fields guide
 *   — `end_date` No (Phase 3 §3.4 only), `status`
 *   `active` | `locked` | `completed`.
 * - Phase transition gates (all compass-registered plans `Done` → Phase 3
 *   required; §3.5 exit checklist all `[x]` + frontmatter `completed` +
 *   `end_date` → Phase 4): `mstar-iteration` SKILL.md Phase transition
 *   gates table.
 * - §3.1 close entry checklist (checkable subset — plans all Done, no
 *   residual_findings open beyond zero-residual blocker-defers for the
 *   iteration's plans, compass frontmatter complete):
 *   `mstar-iteration/references/phase-3-iteration-close.md` §3.1.
 *   Un-checkable items (Acceptance Criteria waiver reasoning,
 *   `## Plans` table prose sync) stay judgment and are NOT asserted here.
 * - §3.5 close exit checklist (checkable subset — frontmatter `status:
 *   completed` + `end_date`, current branch is `spec_integration_branch`,
 *   PR base = `target_branch`): phase-3-iteration-close.md §3.5. The
 *   compound / roadmap / quality-summary items are prose artifacts and stay
 *   judgment.
 * - Push cadence probe (never push while CI is queued/in_progress or an AI
 *   review wave is running): `mstar-iteration` SKILL.md §5.1a +
 *   `mstar-iteration/references/phase-4-5-pr-delivery.md` §5.1a push gate 1
 *   + 2.
 * - Index obligations (one row per iteration in `{ITERATION_DIR}/README.md`,
 *   table header on first creation): `mstar-iteration` SKILL.md §1.4.
 *   Legacy flat `<id>-delivery-compass.md` files are read-compatible only
 *   (§1.3) and are not indexed by this check.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult, Severity, ValidationResult } from "./core.js";
import { isOpenResidual, type StatusDoc } from "./status.js";

const COMPASS_STATUSES = ["active", "locked", "completed"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_STATUS_DONE = "Done";
const COMPASS_FILE = "delivery-compass.md";
const INDEX_README = "README.md";
const INDEX_HEADER = "| Iteration | Path | Description | Status |";

/**
 * Loose shape of a parsed delivery-compass.md frontmatter. All fields are
 * `unknown` because documents come from YAML at runtime; validators narrow
 * them.
 */
export type CompassDoc = {
  iteration_id?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  status?: unknown;
  iteration_base_branch?: unknown;
  target_branch?: unknown;
  plans?: unknown;
  [key: string]: unknown;
};

/** Where the iteration stands per the Phase transition gates table. */
export type PhaseTransition = "phase-2-execute" | "phase-3-close" | "phase-4-pr-delivery";

/**
 * Git probe inputs for the §3.5 exit checklist. The engine never shells out
 * to git; callers (CLI / host hooks) probe and pass values in.
 */
export type PhaseGateOptions = {
  /** `git branch --show-current` of the working checkout (Phase 3 runs on the integration branch). */
  currentBranch?: string;
  /** Expected `spec_integration_branch` (status.json metadata / compass Delivery Branch Policy). */
  specIntegrationBranch?: string;
  /** Resolved PR base branch for Phase 4 (§3.5 exit item 6). */
  prBaseBranch?: string;
};

/**
 * Result of the phase-transition gate evaluation. `entry`/`exit` are the
 * checkable subsets of the §3.1 / §3.5 checklists; `ok`/`violations` are the
 * gate verdict over the triggered transition:
 * - not all plans Done → `phase-2-execute` (keep executing; gate passes).
 * - all plans Done with missing checklist items → `phase-3-close` (Phase 3
 *   required; missing items listed in `violations`).
 * - all plans Done and both checklists clean → `phase-4-pr-delivery`.
 *
 * Note (qc2 F-003): during the Phase-3 window `ok` is false because the
 * §3.4 close items (`status: completed` + `end_date`) are only written at
 * the END of close — the exit checklist gates Phase 4, not the Phase-3
 * entry, so callers (e.g. the CLI, which exits 1) must treat that as "close
 * work pending", not "don't enter Phase 3".
 */
export type PhaseGateResult = {
  transition: PhaseTransition;
  allPlansDone: boolean;
  /** §3.1 close entry checklist — checkable subset (HARD GATE before §3.2). */
  entry: GateResult;
  /** §3.5 close exit checklist — checkable subset (gate to Phase 4). */
  exit: GateResult;
  ok: boolean;
  violations: ValidationResult[];
};

/** Narrowed shape of a valid compass frontmatter (mirrors the zod 4 schema semantics previously used). */
type CompassShape = {
  iteration_id: string;
  start_date: string;
  status: string;
  iteration_base_branch: string;
  target_branch: string;
  plans?: string[];
  end_date?: string;
};

type CompassShapeIssue = {
  path: (string | number)[];
  message: string;
};

type CompassShapeResult =
  | { ok: true; data: CompassShape }
  | { ok: false; issues: CompassShapeIssue[] };

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Hand-rolled compass frontmatter schema validator (zero external runtime
 * deps — replaces the previous zod 4 `z.object(...)` schema with identical
 * observable semantics: required non-empty strings, YYYY-MM-DD dates,
 * status enum, optional array of non-empty plan ids, unknown keys ignored,
 * issues reported in schema key order).
 */
function validateCompassShape(doc: Record<string, unknown>): CompassShapeResult {
  const issues: CompassShapeIssue[] = [];

  const expectString = (key: string, opts: { regex?: RegExp; min?: number } = {}): void => {
    const value = doc[key];
    if (typeof value !== "string") {
      issues.push({ path: [key], message: `expected string, received ${typeName(value)}` });
      return;
    }
    if (opts.min !== undefined && value.length < opts.min) {
      issues.push({ path: [key], message: `string must contain at least ${opts.min} character(s)` });
      return;
    }
    if (opts.regex !== undefined && !opts.regex.test(value)) {
      issues.push({ path: [key], message: `string must match ${opts.regex}` });
    }
  };

  expectString("iteration_id", { min: 1 });
  expectString("start_date", { regex: DATE_RE });

  const status = doc.status;
  if (typeof status !== "string" || !(COMPASS_STATUSES as readonly string[]).includes(status)) {
    issues.push({
      path: ["status"],
      message: `expected one of ${COMPASS_STATUSES.map((s) => `'${s}'`).join(" | ")}, received ${typeName(status)}`,
    });
  }

  expectString("iteration_base_branch", { min: 1 });
  expectString("target_branch", { min: 1 });

  const plans = doc.plans;
  if (plans !== undefined) {
    if (!Array.isArray(plans)) {
      issues.push({ path: ["plans"], message: `expected array, received ${typeName(plans)}` });
    } else {
      plans.forEach((entry, index) => {
        if (typeof entry !== "string") {
          issues.push({ path: ["plans", index], message: `expected string, received ${typeName(entry)}` });
        } else if (entry.length < 1) {
          issues.push({ path: ["plans", index], message: "string must contain at least 1 character(s)" });
        }
      });
    }
  }

  const end_date = doc.end_date;
  if (end_date !== undefined) {
    if (typeof end_date !== "string") {
      issues.push({ path: ["end_date"], message: `expected string, received ${typeName(end_date)}` });
    } else if (!DATE_RE.test(end_date)) {
      issues.push({ path: ["end_date"], message: `string must match ${DATE_RE}` });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    data: {
      iteration_id: doc.iteration_id as string,
      start_date: doc.start_date as string,
      status: status as string,
      iteration_base_branch: doc.iteration_base_branch as string,
      target_branch: doc.target_branch as string,
      ...(plans !== undefined ? { plans: plans as string[] } : {}),
      ...(end_date !== undefined ? { end_date: end_date as string } : {}),
    },
  };
}

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed delivery-compass.md frontmatter (mstar-iteration §1.3 +
 * iteration-compass-template.md Fields guide). `end_date` is required only
 * when `status: completed` (Phase 3 §3.4) and is a violation while the
 * iteration is still `active`/`locked`.
 */
export function validateCompassFrontmatter(doc: unknown): GateResult {
  if (!isPlainObject(doc)) {
    return {
      ok: false,
      violations: [
        violation(
          "medium",
          "COMPASS_INVALID_FIELD",
          "Compass frontmatter must be a YAML object with iteration_id / start_date / status / iteration_base_branch / target_branch (template: mstar-iteration \u00a71.3)",
          "Fix the frontmatter of {ITERATION_DIR}/<iteration-id>/delivery-compass.md",
        ),
      ],
    };
  }
  const parsed = validateCompassShape(doc);
  if (!parsed.ok) {
    return {
      ok: false,
      violations: parsed.issues.map((issue) => {
        const field = issue.path.join(".") || "(root)";
        return violation(
          "medium",
          "COMPASS_INVALID_FIELD",
          `Compass frontmatter field '${field}' is invalid: ${issue.message}`,
          `Fix '${field}' in {ITERATION_DIR}/<iteration-id>/delivery-compass.md frontmatter (template: mstar-iteration \u00a71.3)`,
        );
      }),
    };
  }
  const violations: ValidationResult[] = [];
  const { status, end_date } = parsed.data;
  if (status === "completed" && end_date === undefined) {
    violations.push(
      violation(
        "high",
        "COMPASS_END_DATE_REQUIRED",
        "Compass frontmatter status is 'completed' but end_date is missing \u2014 end_date is required at iteration-close (mstar-iteration \u00a73.4, template Fields guide)",
        "Add `end_date: YYYY-MM-DD` to the frontmatter",
      ),
    );
  }
  if (status !== "completed" && end_date !== undefined) {
    violations.push(
      violation(
        "medium",
        "COMPASS_END_DATE_NOT_ALLOWED",
        `Compass frontmatter sets end_date while status is '${status}' \u2014 end_date is only written at iteration-close (mstar-iteration \u00a73.4)`,
        "Remove end_date until iteration-close",
      ),
    );
  }
  return { ok: violations.length === 0, violations };
}

/** Plan ids registered in compass frontmatter `plans` (non-empty strings only). */
function registeredPlanIds(compassDoc: CompassDoc): string[] {
  if (!Array.isArray(compassDoc.plans)) return [];
  return compassDoc.plans.filter((plan): plan is string => typeof plan === "string" && plan.length > 0);
}

/**
 * Locate the status.json plans[] row for a plan id. Reads accept `id` or
 * `plan_id` (status-and-residuals.md § Compatibility: read accepts both,
 * write prefers `id`).
 */
function findPlanRow(statusDoc: StatusDoc, planId: string): Record<string, unknown> | null {
  if (!Array.isArray(statusDoc.plans)) return null;
  for (const row of statusDoc.plans) {
    if (!isPlainObject(row)) continue;
    const rowId = typeof row.id === "string" ? row.id : typeof row.plan_id === "string" ? row.plan_id : null;
    if (rowId === planId) return row;
  }
  return null;
}

/** §3.1 entry item 1 — every compass-registered plan is `Done` in status.json. */
function entryPlansAllDone(statusDoc: StatusDoc, registered: string[]): ValidationResult[] {
  const violations: ValidationResult[] = [];
  if (registered.length === 0) {
    violations.push(
      violation(
        "medium",
        "COMPASS_NO_PLANS",
        "Compass frontmatter registers no plans \u2014 the all-plans-Done transition cannot be verified (mstar-iteration \u00a71.3 / Phase transition gates)",
        "List the iteration's plan ids in the compass frontmatter `plans`",
      ),
    );
    return violations;
  }
  for (const planId of registered) {
    const row = findPlanRow(statusDoc, planId);
    if (row === null) {
      violations.push(
        violation(
          "high",
          "PLAN_NOT_IN_STATUS",
          `Plan '${planId}' is registered in the compass frontmatter but has no row in status.json plans[] (mstar-iteration \u00a73.1 entry item 1)`,
          "Add the plan row to {HARNESS_DIR}/status.json",
        ),
      );
      continue;
    }
    if (row.status !== PLAN_STATUS_DONE) {
      violations.push(
        violation(
          "high",
          "PLAN_NOT_DONE",
          `Plan '${planId}' status is ${JSON.stringify(row.status)} in status.json \u2014 all compass-registered plans must be 'Done' before iteration-close (mstar-iteration \u00a73.1 entry item 1)`,
        ),
      );
    }
  }
  return violations;
}

/**
 * §3.1 entry item 2 (checkable subset) — residual findings of the
 * iteration's plans must be closed or archived. Openness reuses status.ts
 * `isOpenResidual` (jq `//` parity: missing / null / false lifecycle all
 * count as open — closed/waived/resolved entries are not open). Exception
 * per mstar-plan-artifacts Findings cleanup modes (`zero-residual`):
 * blocker-defers (`decision: "defer"` + non-empty `target`) may stay open;
 * the Durable Roadmap prose itself remains human judgment.
 */
function entryResidualsOpen(statusDoc: StatusDoc, planId: string): ValidationResult[] {
  const violations: ValidationResult[] = [];
  const residualRoot = statusDoc.residual_findings;
  if (residualRoot === undefined || residualRoot === null) return violations;
  if (!isPlainObject(residualRoot)) {
    violations.push(
      violation(
        "medium",
        "RESIDUAL_MALFORMED",
        "status.json residual_findings must be a plan-id \u2192 entries object (mstar-iteration \u00a73.1 entry item 2)",
      ),
    );
    return violations;
  }
  const entries = residualRoot[planId];
  if (entries === undefined) return violations;
  if (!Array.isArray(entries)) {
    violations.push(
      violation(
        "medium",
        "RESIDUAL_MALFORMED",
        `status.json residual_findings['${planId}'] must be an array of residual entries (mstar-iteration \u00a73.1 entry item 2)`,
      ),
    );
    return violations;
  }
  const openIds: string[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry) || !isOpenResidual(entry)) continue;
    // zero-residual exception: blocker-defer (`decision: defer` + non-empty
    // `target`) may stay open at entry; every other open residual blocks.
    const isBlockerDefer =
      entry.decision === "defer" &&
      typeof entry.target === "string" &&
      entry.target.trim() !== "";
    if (isBlockerDefer) continue;
    openIds.push(typeof entry.id === "string" ? entry.id : "<unnamed>");
  }
  if (openIds.length > 0) {
    violations.push(
      violation(
        "high",
        "OPEN_RESIDUALS",
        `Plan '${planId}' has ${openIds.length} open residual finding(s) not exempted as blocker-defers (${openIds.join(", ")}) \u2014 residuals must be closed/archived before iteration-close; only zero-residual blocker-defers (decision: defer + target) may stay open (mstar-iteration \u00a73.1 entry item 2)`,
        "Close or archive the open residuals, or convert them into blocker-defers (decision: defer + non-empty target) per mstar-plan-artifacts Findings cleanup modes",
      ),
    );
  }
  return violations;
}

/** §3.1 entry item 5 (checkable subset) — compass shape satisfies the frontmatter schema. */
function entryFrontmatterComplete(compassDoc: CompassDoc): ValidationResult[] {
  return validateCompassFrontmatter(compassDoc).violations;
}

/** §3.5 exit item 4 — frontmatter `status: completed` + `end_date` (YYYY-MM-DD) present. */
function exitFrontmatterClosed(compassDoc: CompassDoc): ValidationResult[] {
  const violations: ValidationResult[] = [];
  if (compassDoc.status !== "completed") {
    violations.push(
      violation(
        "high",
        "EXIT_STATUS_NOT_COMPLETED",
        `Compass frontmatter status must be 'completed' at close exit \u2014 current: ${JSON.stringify(compassDoc.status)} (mstar-iteration \u00a73.4 / \u00a73.5 exit item 4)`,
      ),
    );
  }
  const endDate = compassDoc.end_date;
  if (typeof endDate !== "string" || !DATE_RE.test(endDate)) {
    violations.push(
      violation(
        "high",
        "EXIT_END_DATE_REQUIRED",
        "Compass frontmatter end_date (YYYY-MM-DD) is required when closing (mstar-iteration \u00a73.4 / \u00a73.5 exit item 4)",
      ),
    );
  }
  return violations;
}

/** §3.5 exit item 5 — the working branch is `spec_integration_branch`. */
function exitBranchCheck(opts: PhaseGateOptions): ValidationResult[] {
  const violations: ValidationResult[] = [];
  const { currentBranch, specIntegrationBranch } = opts;
  if (currentBranch === undefined || specIntegrationBranch === undefined) {
    violations.push(
      violation(
        "medium",
        "EXIT_BRANCH_UNVERIFIABLE",
        "Cannot verify the current branch is spec_integration_branch \u2014 missing currentBranch / specIntegrationBranch probe inputs (mstar-iteration \u00a73.5 exit item 5)",
      ),
    );
  } else if (currentBranch !== specIntegrationBranch) {
    violations.push(
      violation(
        "high",
        "EXIT_BRANCH_MISMATCH",
        `Current branch '${currentBranch}' is not the spec_integration_branch '${specIntegrationBranch}' (mstar-iteration \u00a73.5 exit item 5)`,
      ),
    );
  }
  return violations;
}

/** §3.5 exit item 6 — PR base equals the compass `target_branch`, never an undocumented branch. */
function exitPrBaseCheck(compassDoc: CompassDoc, opts: PhaseGateOptions): ValidationResult[] {
  const violations: ValidationResult[] = [];
  const target = compassDoc.target_branch;
  const { prBaseBranch } = opts;
  if (prBaseBranch === undefined) {
    violations.push(
      violation(
        "medium",
        "EXIT_PR_BASE_UNVERIFIABLE",
        "Cannot verify the PR base \u2014 missing prBaseBranch probe input (mstar-iteration \u00a73.5 exit item 6)",
      ),
    );
  } else if (typeof target !== "string" || prBaseBranch !== target) {
    violations.push(
      violation(
        "high",
        "EXIT_PR_BASE_MISMATCH",
        `PR base '${prBaseBranch}' must equal the compass target_branch '${String(target)}' \u2014 not an undocumented branch (mstar-iteration \u00a73.5 exit item 6)`,
      ),
    );
  }
  return violations;
}

/**
 * Evaluate the Phase transition gates (mstar-iteration Phase transition
 * gates table): all compass-registered plans `Done` (per statusDoc plans[]
 * status) → Phase 3 required, with the checkable subsets of the §3.1 entry
 * and §3.5 exit checklists as missing-item violations.
 *
 * Pure function — git probes (`currentBranch`, `specIntegrationBranch`,
 * `prBaseBranch`) come from the caller via `opts`.
 */
export function evaluatePhaseGate(
  statusDoc: StatusDoc,
  compassDoc: CompassDoc,
  opts: PhaseGateOptions = {},
): PhaseGateResult {
  const registered = registeredPlanIds(compassDoc);
  const entryViolations: ValidationResult[] = [
    ...entryPlansAllDone(statusDoc, registered),
    ...registered.flatMap((planId) => entryResidualsOpen(statusDoc, planId)),
    ...entryFrontmatterComplete(compassDoc),
  ];
  const exitViolations: ValidationResult[] = [
    ...exitFrontmatterClosed(compassDoc),
    ...exitBranchCheck(opts),
    ...exitPrBaseCheck(compassDoc, opts),
  ];
  const allPlansDone =
    registered.length > 0 &&
    registered.every((planId) => {
      const row = findPlanRow(statusDoc, planId);
      return row !== null && row.status === PLAN_STATUS_DONE;
    });
  const entry: GateResult = { ok: entryViolations.length === 0, violations: entryViolations };
  const exit: GateResult = { ok: exitViolations.length === 0, violations: exitViolations };
  let transition: PhaseTransition;
  if (!allPlansDone) transition = "phase-2-execute";
  else if (entry.ok && exit.ok) transition = "phase-4-pr-delivery";
  else transition = "phase-3-close";
  const gateBlocking = allPlansDone ? [...entryViolations, ...exitViolations] : [];
  return {
    transition,
    allPlansDone,
    entry,
    exit,
    ok: gateBlocking.length === 0,
    violations: gateBlocking,
  };
}

/**
 * §5.1a push-cadence probe (HARD): never push the PR head while required CI
 * is still queued/in_progress or an AI/bot review wave is running. Pure
 * function — no external calls; callers probe CI / review state and pass the
 * booleans. Fix locally early, push once the wave settles (§5.1a push gate
 * 1 + 2).
 */
export function pushCadenceProbe(ciRunning: boolean, reviewWaveActive: boolean): GateResult {
  const violations: ValidationResult[] = [];
  if (ciRunning) {
    violations.push(
      violation(
        "high",
        "PUSH_BLOCKED_CI",
        "CI checks are still queued/in_progress on the current head \u2014 do not push until the wave completes (mstar-iteration \u00a75.1a push gate 1)",
        "Wait for CI to settle, then push once with the whole local batch",
      ),
    );
  }
  if (reviewWaveActive) {
    violations.push(
      violation(
        "high",
        "PUSH_BLOCKED_REVIEW_WAVE",
        "An AI/bot review wave is still running on the current head \u2014 do not push until it settles (mstar-iteration \u00a75.1a push gate 2)",
        "Wait for the review wave, then push once",
      ),
    );
  }
  return { ok: violations.length === 0, violations };
}

/**
 * §1.4 index obligations: one row per iteration in `{ITERATION_DIR}/README.md`
 * (table header on first creation). Iterations are discovered as subdirectories
 * of `iterationsDir` containing `delivery-compass.md`. Returns violations for
 * a missing README, a missing header, and missing per-iteration rows.
 */
export function assertIndexRowObligations(iterationsDir: string): GateResult {
  if (!existsSync(iterationsDir)) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "INDEX_ITERATIONS_DIR_MISSING",
          `{ITERATION_DIR} '${iterationsDir}' does not exist (mstar-iteration \u00a71.4)`,
          "Create the iterations directory (path.resolveIterationDir)",
        ),
      ],
    };
  }
  const iterationIds = readdirSync(iterationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(iterationsDir, entry.name, COMPASS_FILE)))
    .map((entry) => entry.name)
    .sort();
  const readmePath = join(iterationsDir, INDEX_README);
  if (!existsSync(readmePath)) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "INDEX_README_MISSING",
          `{ITERATION_DIR}/README.md does not exist \u2014 one row per iteration is required (mstar-iteration \u00a71.4)`,
          `Create {ITERATION_DIR}/README.md with the header '${INDEX_HEADER}' and one row per iteration`,
        ),
      ],
    };
  }
  const violations: ValidationResult[] = [];
  const lines = readFileSync(readmePath, "utf8").split(/\r?\n/);
  if (!lines.some((line) => line.includes(INDEX_HEADER))) {
    violations.push(
      violation(
        "medium",
        "INDEX_HEADER_MISSING",
        `{ITERATION_DIR}/README.md lacks the table header '${INDEX_HEADER}' (mstar-iteration \u00a71.4)`,
        "Add the header row on first creation",
      ),
    );
  }
  const indexed = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^\s*\|\s*`([^`]+)`\s*\|/);
    if (match) indexed.add(match[1]!.trim());
  }
  for (const id of iterationIds) {
    if (!indexed.has(id)) {
      violations.push(
        violation(
          "medium",
          "INDEX_ROW_MISSING",
          `Iteration '${id}' has a delivery-compass.md but no index row in {ITERATION_DIR}/README.md \u2014 one row per iteration (mstar-iteration \u00a71.4)`,
          `Add | \`${id}\` | [\`${id}/\`](${id}/) | <description> | <status> |`,
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Parse the YAML frontmatter of a delivery-compass.md into a flat doc.
 *
 * The compass frontmatter is a flat YAML subset (scalar keys plus one
 * `plans:` list-of-scalars — see `skills/mstar-iteration/references/
 * iteration-compass-template.md` Fields guide); `validateCompassFrontmatter`
 * validates the parsed doc. The engine deliberately has no YAML dependency,
 * so this hand-rolled flat-subset parser lives here — the single shared
 * parser used by the CLI, the omp `mstar_iteration_gate` tool, and the
 * roadmap validator (no fork). Path wrapper over
 * `parseCompassFrontmatterText`.
 *
 * Throws with the file path on structural errors (no fence / unterminated
 * fence / unsupported line) so callers can fail with a precise message.
 */
export function parseCompassFrontmatter(filePath: string): Record<string, unknown> {
  return parseCompassFrontmatterText(readFileSync(filePath, "utf8"), filePath);
}

/**
 * Parse flat-subset YAML frontmatter from raw file content — the single
 * shared parser core behind `parseCompassFrontmatter` (path wrapper) and
 * the roadmap validator (plan `20260819-workflow-engine-core.md` Task 4 —
 * extract/reuse the same parsing, no fork).
 */
export function parseCompassFrontmatterText(content: string, filePath: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error(`no YAML frontmatter fence in ${filePath} (expected first line "---")`);
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error(`unterminated YAML frontmatter in ${filePath} (no closing "---")`);
  }
  const doc: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) continue;
    // `- item` lines (optionally indented) continue the most recent
    // `key:` list (plans:).
    if (listKey !== null && /^\s*-\s+/.test(line)) {
      const item = line.replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, "");
      if (!Array.isArray(doc[listKey])) doc[listKey] = [];
      (doc[listKey] as string[]).push(item);
      continue;
    }
    listKey = null;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) {
      throw new Error(`unsupported frontmatter line in ${filePath}: ${JSON.stringify(line)}`);
    }
    const value = kv[2]!.trim();
    // A flat flow-style array (`plans: []` / `plans: [a, b]`) becomes an
    // array of trimmed string items; anything else stays a scalar (empty
    // value → null, like before).
    doc[kv[1]!] =
      value === "" ? null : /^\[.*\]$/.test(value) ? parseFlowArray(value, filePath) : value.replace(/^["']|["']$/g, "");
    listKey = value === "" ? kv[1] : null;
  }
  return doc;
}

function parseFlowArray(raw: string, filePath: string): string[] {
  const inner = raw.slice(1, -1);
  if (/[[\]]/.test(inner)) {
    throw new Error(
      `nested flow-style array in ${filePath}: ${JSON.stringify(raw)} \u2014 only flat scalar items are supported (e.g. [a, b])`,
    );
  }
  // Quote-aware scan BEFORE the naive split: a comma inside a quoted item
  // (single OR double quotes) must stay part of its item, so `["a, b"]` /
  // `['a, b']` cannot be split unambiguously and are rejected here (a
  // post-split `item.includes(",")` check would be dead — split(",") items
  // can never contain a comma). A different quote char inside a quoted item
  // is a literal character (YAML parity), not a toggle.
  let quote: string | null = null;
  for (const ch of inner) {
    if (ch === '"' || ch === "'") {
      if (quote === null) quote = ch;
      else if (quote === ch) quote = null;
    } else if (ch === "," && quote !== null) {
      throw new Error(
        `ambiguous flow-style array in ${filePath}: ${JSON.stringify(raw)} \u2014 quoted item containing comma cannot be split unambiguously (flat scalar items only)`,
      );
    }
  }
  if (quote !== null) {
    throw new Error(`unterminated ${quote} quote in flow-style array in ${filePath}: ${JSON.stringify(raw)}`);
  }
  const items: string[] = [];
  for (const part of inner.split(",")) {
    const item = part.trim().replace(/^["']|["']$/g, "");
    if (item === "") continue;
    items.push(item);
  }
  return items;
}
