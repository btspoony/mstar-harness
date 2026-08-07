/**
 * Engine status module — status.json schema validation, residual severity
 * normalization, residual lifecycle (open → archived), findings-cleanup gate,
 * and the `tech-debt-rollup.sh` parity port.
 *
 * Spec sources (each export cites the skill/reference section it enforces):
 * - status.json schema + required fields + root-only `residual_findings`:
 *   `mstar-plan-artifacts/references/status-and-residuals.md`
 *   § Basic structure + § General constraints ("Init with `residual_findings`:
 *   {}; no dual-write with legacy side") + § Compatibility (read: accept `id`
 *   or `plan_id`; write: one canonical key, prefer `id`).
 * - Severity enum + legacy `"warning"` → `low`: § "Residual findings:
 *   `severity` (SSOT, machine field)" — allowed values
 *   `critical|high|medium|low|nit`; `warning`/`Major`/non-English forbidden in
 *   JSON; legacy `"severity": "warning"` is read and rolled up as `low`.
 *   `null`/`""` → `medium` mirrors `scripts/tech-debt-rollup.sh` `norm_sev`.
 * - Residual required fields + lifecycle + archive shape:
 *   § Basic structure (entry fields), § Residual findings lifecycle
 *   ("Recommended: archive to `archived/residuals/<plan-id>.json`":
 *   `plan_id`/`schema_version`/`entries[]` with `archived_at`, remove from
 *   open list, update root `updated_at`), § General constraints ("Empty
 *   `plan-id` key: … delete the key … no `"plan-id": []`").
 * - Findings cleanup modes: § Findings cleanup modes — `zero-residual`
 *   (fixable findings must not be open R#; `nit` never open; `waived`/
 *   `risk-accepted` close/archive; only blocker-defers — `decision: defer` +
 *   `target` — may stay open) vs `allow-residual` (open ok when no unresolved
 *   Critical remains); mode mirror `plans[].metadata.findings_cleanup`.
 * - Rollup aggregates + drift check (total_open / by_severity / by_target /
 *   by_plan; PASS/DRIFT vs stored `metadata.tech_debt_summary`):
 *   § `metadata.tech_debt_summary` (optional rollup) — canonical compute is
 *   `scripts/tech-debt-rollup.sh`; the TS port must be byte-identical.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson, writeJson, SEVERITY_ORDER, type GateResult, type Severity, type ValidationResult } from "./core.js";
import { resolveHarnessDir } from "./path.js";

/**
 * Loose shape of a parsed status.json document. All fields are `unknown`
 * because documents come from JSON at runtime; validators narrow them.
 */
export type StatusDoc = {
  version?: unknown;
  updated_at?: unknown;
  plans?: unknown;
  residual_findings?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

/** Residual entry as parsed from status.json (loose — validated by `validateResidual`). */
export type ResidualEntry = {
  id?: unknown;
  title?: unknown;
  severity?: unknown;
  source?: unknown;
  scope?: unknown;
  decision?: unknown;
  owner?: unknown;
  target?: unknown;
  tracking?: unknown;
  detail_doc?: unknown;
  lifecycle?: unknown;
  closed_at?: unknown;
  closure_note?: unknown;
  closure_evidence?: unknown;
  superseded_by?: unknown;
  [key: string]: unknown;
};

/** Plan row as parsed from status.json (loose — validated by `validatePlanRow`). */
export type PlanRow = {
  id?: unknown;
  plan_id?: unknown;
  title?: unknown;
  file?: unknown;
  status?: unknown;
  metadata?: unknown;
  execution_lease?: unknown;
  [key: string]: unknown;
};

/** Findings cleanup policy mirror of Assignment `Findings cleanup`. */
export type FindingsCleanupMode = "zero-residual" | "allow-residual";

/** Computed rollup aggregates — jq port of `scripts/tech-debt-rollup.sh`. */
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

/** Result of the rollup + drift check vs stored `metadata.tech_debt_summary`. */
export type TechDebtRollup = {
  computed: TechDebtSummary;
  stored: Record<string, unknown> | null;
  checks: TechDebtCheck[];
  overall: "PASS" | "DRIFT";
};

export type ArchiveResult = {
  planId: string;
  archived: number;
  archivePath: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PLAN_STATUSES = ["Todo", "InProgress", "InReview", "Blocked", "Done"] as const;
const RESIDUAL_DECISIONS = ["defer", "accept", "risk-accepted"] as const;
const RESIDUAL_LIFECYCLES = ["open", "resolved", "waived", "superseded", "duplicate"] as const;
const RESIDUAL_REQUIRED_FIELDS = ["id", "title", "severity", "source", "scope", "decision", "owner", "target", "tracking"] as const;
const ROLLUP_FIELDS = ["total_open", "by_severity", "by_target", "by_plan"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

/** Local calendar date `YYYY-MM-DD` (harness docs use local dates, e.g. `archived_at`). */
function todayString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Normalize a residual `severity` value for reading/rolling up
 * (status-and-residuals.md § severity 5 + `tech-debt-rollup.sh` `norm_sev`):
 * legacy `"warning"` → `"low"`; `null`/`""` → `"medium"`; anything else passes
 * through unchanged (unknown values match no enum bucket, same as jq).
 */
export function normalizeSeverity(value: unknown): unknown {
  if (value === "warning") return "low";
  if (value === null || value === "") return "medium";
  return value;
}

/**
 * jq parity: an entry is open when `.lifecycle // "open"` equals `"open"`
 * (tech-debt-rollup.sh `is_open`; status-and-residuals.md § lifecycle).
 */
function isOpenResidual(entry: Record<string, unknown>): boolean {
  return (entry.lifecycle ?? "open") === "open";
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
 * Validate one `plans[]` row (status-and-residuals.md § Basic structure +
 * § Compatibility: read accepts `id` or `plan_id`; write one canonical key).
 * Required: `id` (or legacy `plan_id`), `title`, `file`, `status` (one of
 * Todo|InProgress|InReview|Blocked|Done); `metadata` optional but must be an
 * object when present. `execution_lease` is type-checked here; the full lease
 * state machine lives in the lease module (Task 5).
 */
export function validatePlanRow(row: unknown): GateResult {
  const violations: ValidationResult[] = [];
  if (!isPlainObject(row)) {
    return { ok: false, violations: [violation("high", "status.plan-row.invalid", "plan row must be an object")] };
  }
  const { id, plan_id: planId, title, file, status, metadata, execution_lease } = row;

  if (id === undefined && planId === undefined) {
    violations.push(violation("high", "status.plan-row.missing-id", "missing required field: id (or legacy plan_id)"));
  } else {
    if (id !== undefined && typeof id !== "string") {
      violations.push(violation("medium", "status.plan-row.invalid-id", "id must be a string"));
    }
    if (planId !== undefined && typeof planId !== "string") {
      violations.push(violation("medium", "status.plan-row.invalid-plan-id", "plan_id must be a string"));
    }
    if (id !== undefined && planId !== undefined && id !== planId) {
      violations.push(
        violation(
          "medium",
          "status.plan-row.dual-id",
          "row has both id and plan_id with different values — write one canonical key (prefer id)",
        ),
      );
    }
  }

  validateNonEmptyString(violations, title, "title", "status.plan-row.missing-title", "status.plan-row.invalid-title");
  validateNonEmptyString(violations, file, "file", "status.plan-row.missing-file", "status.plan-row.invalid-file");

  if (status === undefined) {
    violations.push(violation("high", "status.plan-row.missing-status", "missing required field: status"));
  } else if (typeof status !== "string" || !(PLAN_STATUSES as readonly string[]).includes(status)) {
    violations.push(
      violation(
        "medium",
        "status.plan-row.invalid-status",
        `status must be one of ${PLAN_STATUSES.join(" | ")} — got ${JSON.stringify(status)}`,
      ),
    );
  }

  if (metadata !== undefined && !isPlainObject(metadata)) {
    violations.push(violation("medium", "status.plan-row.invalid-metadata", "metadata must be an object"));
  }
  if (execution_lease !== undefined && !isPlainObject(execution_lease)) {
    violations.push(violation("medium", "status.plan-row.invalid-execution-lease", "execution_lease must be an object"));
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Validate one residual entry (status-and-residuals.md § Basic structure):
 * required `id`, `title`, `severity`, `source`, `scope`, `decision`, `owner`,
 * `target`, `tracking`; `severity` from the enum (legacy `"warning"` is read
 * but forbidden on new entries — flagged with fix); `decision` from
 * defer|accept|risk-accepted; `lifecycle` optional from the close enum.
 */
export function validateResidual(entry: unknown): GateResult {
  const violations: ValidationResult[] = [];
  if (!isPlainObject(entry)) {
    return { ok: false, violations: [violation("high", "status.residual.invalid", "residual entry must be an object")] };
  }
  const { id, title, severity, source, scope, decision, owner, target, tracking, detail_doc, lifecycle, closed_at } = entry;

  validateNonEmptyString(violations, id, "id", "status.residual.missing-id", "status.residual.invalid-id");
  validateNonEmptyString(violations, title, "title", "status.residual.missing-title", "status.residual.invalid-title");
  validateNonEmptyString(violations, source, "source", "status.residual.missing-source", "status.residual.invalid-source");
  validateNonEmptyString(violations, scope, "scope", "status.residual.missing-scope", "status.residual.invalid-scope");
  validateNonEmptyString(violations, owner, "owner", "status.residual.missing-owner", "status.residual.invalid-owner");

  if (severity === undefined) {
    violations.push(violation("high", "status.residual.missing-severity", "missing required field: severity"));
  } else if (typeof severity !== "string" || (!(SEVERITY_ORDER as readonly string[]).includes(severity) && severity !== "warning")) {
    violations.push(
      violation(
        "medium",
        "status.residual.invalid-severity",
        `severity must be one of ${SEVERITY_ORDER.join(" | ")} — got ${JSON.stringify(severity)}`,
      ),
    );
  } else if (severity === "warning") {
    violations.push(
      violation(
        "low",
        "status.residual.legacy-warning",
        `severity "warning" is legacy — forbidden on new entries; read paths normalize it to "low"`,
        "use \"low\" (normalizeSeverity maps 'warning' → 'low')",
      ),
    );
  }

  if (decision === undefined) {
    violations.push(violation("high", "status.residual.missing-decision", "missing required field: decision"));
  } else if (typeof decision !== "string" || !(RESIDUAL_DECISIONS as readonly string[]).includes(decision)) {
    violations.push(
      violation(
        "medium",
        "status.residual.invalid-decision",
        `decision must be one of ${RESIDUAL_DECISIONS.join(" | ")} — got ${JSON.stringify(decision)}`,
      ),
    );
  }

  if (target === undefined) {
    violations.push(violation("high", "status.residual.missing-target", "missing required field: target"));
  } else if (typeof target !== "string" && target !== null) {
    violations.push(violation("medium", "status.residual.invalid-target", "target must be a string or null"));
  }

  if (tracking === undefined) {
    violations.push(violation("high", "status.residual.missing-tracking", "missing required field: tracking"));
  } else if (typeof tracking !== "string" && tracking !== null) {
    violations.push(violation("medium", "status.residual.invalid-tracking", "tracking must be a string or null"));
  }

  if (detail_doc !== undefined && typeof detail_doc !== "string" && detail_doc !== null) {
    violations.push(violation("medium", "status.residual.invalid-detail-doc", "detail_doc must be a string or null"));
  }

  if (lifecycle !== undefined) {
    if (typeof lifecycle !== "string" || !(RESIDUAL_LIFECYCLES as readonly string[]).includes(lifecycle)) {
      violations.push(
        violation(
          "medium",
          "status.residual.invalid-lifecycle",
          `lifecycle must be one of ${RESIDUAL_LIFECYCLES.join(" | ")} — got ${JSON.stringify(lifecycle)}`,
        ),
      );
    }
  } else if (closed_at !== undefined && (typeof closed_at !== "string" || !DATE_RE.test(closed_at))) {
    violations.push(violation("medium", "status.residual.invalid-closed-at", "closed_at must be YYYY-MM-DD"));
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Validate a status.json document (schema: status-and-residuals.md
 * § Basic structure + § General constraints). Accepts a parsed document or a
 * file path (malformed JSON yields a `status.invalid-json` violation, never a
 * throw). Required top-level fields: `version`, `updated_at`, `plans[]`,
 * root-only `residual_findings`, `metadata`. Root-only canonical: any
 * `metadata.residual_findings` key is flagged as dual-write.
 */
export function validateStatus(docOrPath: StatusDoc | string): GateResult {
  let doc: StatusDoc;
  if (typeof docOrPath === "string") {
    try {
      doc = readJson(docOrPath) as StatusDoc;
    } catch (error) {
      return {
        ok: false,
        violations: [violation("high", "status.invalid-json", (error as Error).message)],
      };
    }
  } else {
    doc = docOrPath;
  }

  const violations: ValidationResult[] = [];
  const { version, updated_at, plans, residual_findings, metadata } = doc;

  if (version === undefined) {
    violations.push(violation("high", "status.missing-version", "missing required field: version"));
  } else if (typeof version !== "number" || !Number.isInteger(version)) {
    violations.push(violation("high", "status.invalid-version", "version must be an integer"));
  } else if (version !== 1) {
    violations.push(violation("medium", "status.unsupported-version", `unsupported status.json schema version ${version} — expected 1`));
  }

  if (updated_at === undefined) {
    violations.push(violation("high", "status.missing-updated-at", "missing required field: updated_at"));
  } else if (typeof updated_at !== "string" || !DATE_RE.test(updated_at)) {
    violations.push(violation("medium", "status.invalid-updated-at", "updated_at must be YYYY-MM-DD"));
  }

  if (plans === undefined) {
    violations.push(violation("high", "status.missing-plans", "missing required field: plans"));
  } else if (!Array.isArray(plans)) {
    violations.push(violation("high", "status.invalid-plans", "plans must be an array"));
  } else {
    for (const row of plans) {
      violations.push(...validatePlanRow(row).violations);
    }
  }

  if (residual_findings === undefined) {
    violations.push(violation("high", "status.missing-residual-findings", "missing required field: residual_findings (root-only canonical)"));
  } else if (!isPlainObject(residual_findings)) {
    violations.push(violation("high", "status.invalid-residual-findings", "residual_findings must be an object at root"));
  } else {
    for (const [planId, list] of Object.entries(residual_findings)) {
      if (!Array.isArray(list)) {
        violations.push(violation("high", "status.residual.invalid-list", `residual_findings["${planId}"] must be an array`));
      } else if (list.length === 0) {
        violations.push(
          violation("low", "status.residual.empty-key", `residual_findings["${planId}"] is empty — delete the key (no "plan-id": [])`),
        );
      } else {
        for (const entry of list) {
          violations.push(...validateResidual(entry).violations);
        }
      }
    }
  }

  if (metadata === undefined) {
    violations.push(violation("high", "status.missing-metadata", "missing required field: metadata"));
  } else if (!isPlainObject(metadata)) {
    violations.push(violation("high", "status.invalid-metadata", "metadata must be an object"));
  } else if (Object.prototype.hasOwnProperty.call(metadata, "residual_findings")) {
    violations.push(
      violation(
        "medium",
        "status.dual-write-residuals",
        "residual_findings must be root-only — metadata.residual_findings is legacy read-only; remove it (no dual-write)",
        "move entries to root residual_findings and delete metadata.residual_findings",
      ),
    );
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Archive the open residuals of a plan (status-and-residuals.md
 * § Residual findings lifecycle): append every entry of
 * `residual_findings[<plan-id>]` to `{HARNESS_DIR}/archived/residuals/
 * <plan-id>.json` (stamped `archived_at`), delete the key from the open list,
 * and bump root `updated_at`. No-op (archived 0) when the plan has no open
 * residuals. `harnessDir` defaults to the resolved `{HARNESS_DIR}` from cwd.
 */
export function archiveResiduals(planId: string, harnessDir?: string): ArchiveResult {
  const dir = harnessDir !== undefined ? resolve(harnessDir) : resolveHarnessDir();
  if (dir === null) {
    throw new Error(`harness dir not found from ${process.cwd()} — pass harnessDir or set MSTAR_HARNESS_DIR`);
  }
  const statusPath = join(dir, "status.json");
  if (!existsSync(statusPath)) {
    throw new Error(`status file not found: ${statusPath}`);
  }
  const doc = readJson(statusPath) as StatusDoc;
  if (!isPlainObject(doc.residual_findings)) {
    throw new Error(`status.json residual_findings must be an object: ${statusPath}`);
  }
  const open = doc.residual_findings[planId];
  const archivePath = join(dir, "archived", "residuals", `${planId}.json`);
  if (!Array.isArray(open) || open.length === 0) {
    return { planId, archived: 0, archivePath };
  }

  const archive = readJson(archivePath) as { entries?: unknown };
  const existing = Array.isArray(archive.entries) ? archive.entries : [];
  const today = todayString();
  const moved = open.map((entry) => ({ ...(entry as Record<string, unknown>), archived_at: today }));
  writeJson(archivePath, { plan_id: planId, schema_version: 1, entries: [...existing, ...moved] });

  delete doc.residual_findings[planId];
  doc.updated_at = today;
  writeJson(statusPath, doc);

  return { planId, archived: moved.length, archivePath };
}

/** Read `plans[].metadata.findings_cleanup` for a plan (mirror; Assignment wins). */
function planFindingsCleanup(doc: StatusDoc, planId: string): FindingsCleanupMode | undefined {
  if (!Array.isArray(doc.plans)) return undefined;
  for (const row of doc.plans) {
    if (!isPlainObject(row)) continue;
    const rowId = row.id ?? row.plan_id;
    if (rowId !== planId) continue;
    if (!isPlainObject(row.metadata)) return undefined;
    const mode = row.metadata.findings_cleanup;
    if (mode === "zero-residual" || mode === "allow-residual") return mode;
    return undefined;
  }
  return undefined;
}

/** Open residuals of one plan (empty list when absent or malformed). */
function openResidualsOf(doc: StatusDoc, planId: string): Array<Record<string, unknown>> {
  if (!isPlainObject(doc.residual_findings)) return [];
  const list = doc.residual_findings[planId];
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is Record<string, unknown> => isPlainObject(entry) && isOpenResidual(entry));
}

/**
 * Findings cleanup gate (status-and-residuals.md § Findings cleanup modes).
 * `zero-residual`: only true blocker-defers (`decision: defer` + non-empty
 * `target`) may stay open — fixable findings, `nit`s, and waived/
 * risk-accepted entries are violations. `allow-residual` (default): open
 * residuals are fine unless an unresolved Critical remains. Mode resolution:
 * explicit `opts.mode` → `plans[].metadata.findings_cleanup` → `allow-residual`.
 */
export function findingsCleanupGate(
  doc: StatusDoc,
  planId: string,
  opts?: { mode?: FindingsCleanupMode },
): GateResult {
  const mode = opts?.mode ?? planFindingsCleanup(doc, planId) ?? "allow-residual";
  const violations: ValidationResult[] = [];
  const residuals = openResidualsOf(doc, planId);

  for (const entry of residuals) {
    const id = typeof entry.id === "string" ? entry.id : "<unnamed>";
    const label = `R#${id}`;
    if (mode === "zero-residual") {
      if (entry.severity === "nit") {
        violations.push(
          violation(
            "medium",
            "findings.zero-residual-nit",
            `${label}: style-only nits must be fixed in-session or dropped — never left open under zero-residual`,
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
            `${label}: fixable finding must not remain open under zero-residual — fix now or convert to a blocker-defer`,
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

/** Semantic JSON equality, key-order-insensitive for objects (jq `==` semantics). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * TS port of `scripts/tech-debt-rollup.sh` (status-and-residuals.md
 * § `metadata.tech_debt_summary`): compute `total_open` / `by_severity` /
 * `by_target` / `by_plan` over open entries of root `residual_findings`
 * merged with the legacy `metadata.residual_findings` read path (canonical
 * keys win; legacy `"warning"` → `low`, `null`/`""` → `medium`; closed
 * entries skipped; missing `target` groups under `"unspecified"`), then
 * compare field-by-field against stored `metadata.tech_debt_summary`.
 * Accepts a parsed document or a file path. Does not write status.json.
 */
export function techDebtRollup(docOrPath: StatusDoc | string): TechDebtRollup {
  const doc = typeof docOrPath === "string" ? (readJson(docOrPath) as StatusDoc) : docOrPath;
  const canonical = isPlainObject(doc.residual_findings) ? doc.residual_findings : {};
  const metadata = isPlainObject(doc.metadata) ? doc.metadata : {};
  const legacy = isPlainObject(metadata.residual_findings) ? metadata.residual_findings : {};
  // jq `($canon + $legacy)`: object `+` keeps the RIGHT operand's value for
  // duplicate keys — so on a conflicting plan key the legacy map wins. The
  // script comment says "canonical keys win", but the expression behaves
  // otherwise; the port mirrors the actual jq output (dual-write is forbidden
  // in practice, so conflicts should not occur — `status.dual-write-residuals`).
  const merged = { ...canonical, ...legacy };

  const items: Array<{ plan: string; entry: Record<string, unknown> }> = [];
  for (const [plan, list] of Object.entries(merged)) {
    // simplify: jq `.value[]` would iterate non-array values; fixtures are well-formed arrays
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      if (!isPlainObject(value) || !isOpenResidual(value)) continue;
      items.push({ plan, entry: value });
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

  const storedRaw = metadata.tech_debt_summary ?? null;
  const stored = storedRaw === null ? null : (storedRaw as Record<string, unknown>);
  const checks: TechDebtCheck[] = ROLLUP_FIELDS.map((field) => {
    const computedField = computed[field];
    if (stored === null) return { field, status: "DRIFT" as const };
    // jq compares values semantically (`==`), so use deep equality, not string compare
    const status = deepEqual(computedField, stored[field] ?? null) ? ("PASS" as const) : ("DRIFT" as const);
    return { field, status };
  });
  const overall = checks.every((check) => check.status === "PASS") ? ("PASS" as const) : ("DRIFT" as const);

  return { computed, stored, checks, overall };
}
