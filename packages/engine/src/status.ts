/**
 * Engine status module — status.json schema validation, residual severity
 * normalization, residual lifecycle (open → archived), and the root-file
 * v2 writers.
 *
 * QC wave-1 W-D relocation: `findingsCleanupGate` and `techDebtRollup`
 * moved to `project.ts` (they operate on project-register artifacts) —
 * this module no longer imports `./project.js`, breaking the former
 * `status.ts ↔ project.ts` module cycle. Public names remain exported via
 * the package index (`index.ts`).
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
 *   `null`/`""` → `medium` (rollup `norm_sev` semantics).
 * - Residual required fields + lifecycle + archive shape:
 *   § Basic structure (entry fields), § Residual findings lifecycle
 *   ("Recommended: archive to `archived/residuals/<plan-id>.json`":
 *   `plan_id`/`schema_version`/`entries[]` with `archived_at`, remove from
 *   open list, update root `updated_at`), § General constraints ("Empty
 *   `plan-id` key: … delete the key … no `"plan-id": []`").
 * - v2 root + migration detection: v1-shaped documents — root `plans[]` OR
 *   root `residual_findings` (QC wave-1 W-C: v1-disguise hole) — fail
 *   closed with `status.migration-required` even when `version: 2`.
 * - Rollup aggregates: canonical compute is `techDebtRollup` in `project.ts`
 *   (CLI form: `mstar status tech-debt [path]`).
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { readJson, writeJson, SEVERITY_ORDER, type GateResult, type Severity, type ValidationResult } from "./core.js";
import { resolveIterationDir } from "./path.js";
import { withStatusWriteLock } from "./lease.js";
import { parseEnforcementFlag, type EnforcementFlag } from "./dispatch.js";
import { loadMstarc } from "./mstarc.js";
// Call-time-only cycle with workflow.ts (workflow.ts imports validatePlanRow
// from this module): neither module dereferences the other's bindings during
// module evaluation, so the ESM live-binding cycle is safe.
import {
  WORKFLOW_LIFECYCLE_TYPES,
  WORKFLOW_SNAPSHOT_FILE,
  WORKFLOW_TERMINAL_STATUSES,
  type WorkflowLifecycleType,
} from "./workflow.js";

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

/**
 * v2 root status document (`{HARNESS_DIR}/status.json`, plan Task 3 — hard
 * cutover): `version`, `updated_at`, `workflows[]` only. The list holds
 * ACTIVE (non-terminal) lifecycles; terminal writers unregister AFTER the
 * snapshot write (removal-at-terminal).
 */
export type StatusV2Doc = {
  version: 2;
  updated_at: string;
  workflows: WorkflowEntry[];
};

/** One active lifecycle entry of the v2 root `workflows[]` list. */
export type WorkflowEntry = {
  id: string;
  type: WorkflowLifecycleType;
  started_at: string;
  /** Harness-relative snapshot dir (e.g. `workflows/<id>`), never absolute. */
  dir: string;
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PLAN_STATUSES = ["Todo", "InProgress", "InReview", "Blocked", "Done"] as const;
const RESIDUAL_DECISIONS = ["defer", "accept", "risk-accepted"] as const;
const RESIDUAL_LIFECYCLES = ["open", "resolved", "waived", "superseded", "duplicate"] as const;
const RESIDUAL_REQUIRED_FIELDS = ["id", "title", "severity", "source", "scope", "decision", "owner", "target", "tracking"] as const;

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
 * (status-and-residuals.md § severity 5 + rollup `norm_sev`):
 * legacy `"warning"` → `"low"`; `null`/`""` → `"medium"`; anything else passes
 * through unchanged (unknown values match no enum bucket, same as jq).
 */
export function normalizeSeverity(value: unknown): unknown {
  if (value === "warning") return "low";
  if (value === null || value === "") return "medium";
  return value;
}

/**
 * jq semantics: an entry is open when `.lifecycle // "open"` equals `"open"`
 * (rollup `is_open`; status-and-residuals.md § lifecycle).
 * The jq alternative operator `//` yields the default for `false` AND
 * `null` (not just null) — `lifecycle: false` therefore counts as open.
 * Exported for consumers that need the shared open semantics (e.g. the
 * iteration phase-gate entry check) instead of a local re-implementation.
 */
export function isOpenResidual(entry: Record<string, unknown>): boolean {
  const lifecycle = entry.lifecycle;
  const effective = lifecycle === false || lifecycle === null || lifecycle === undefined ? "open" : lifecycle;
  return effective === "open";
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
    // Non-empty check applies to whichever key(s) are present — the absent-key
    // case is the missing-id violation above (legacy plan_id-only rows pass).
    if (id !== undefined) {
      validateNonEmptyString(violations, id, "id", "status.plan-row.missing-id", "status.plan-row.invalid-id");
    }
    if (planId !== undefined) {
      validateNonEmptyString(
        violations,
        planId,
        "plan_id",
        "status.plan-row.missing-plan-id",
        "status.plan-row.invalid-plan-id",
      );
    }
    if (id !== undefined && planId !== undefined && id !== planId) {
      violations.push(
        violation(
          "medium",
          "status.plan-row.dual-id",
          "row has both id and plan_id with different values \u2014 write one canonical key (prefer id)",
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
        `status must be one of ${PLAN_STATUSES.join(" | ")} \u2014 got ${JSON.stringify(status)}`,
      ),
    );
  }

  if (metadata !== undefined && !isPlainObject(metadata)) {
    violations.push(violation("medium", "status.plan-row.invalid-metadata", "metadata must be an object"));
  }
  if (execution_lease !== undefined && !isPlainObject(execution_lease)) {
    violations.push(violation("medium", "status.plan-row.invalid-execution-lease", "execution_lease must be an object"));
  }
  if (status === "Done" && execution_lease !== undefined) {
    violations.push(
      violation(
        "medium",
        "status.plan-row.done-with-lease",
        "plan status Done must not carry an execution_lease \u2014 the Done authority deletes the lease in the same complete-file update as status: \"Done\" (status-and-residuals.md \u00a7 Hold, release, and override)",
        "delete plans[].execution_lease in the same update that sets status: \"Done\"",
      ),
    );
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
        `severity must be one of ${SEVERITY_ORDER.join(" | ")} \u2014 got ${JSON.stringify(severity)}`,
      ),
    );
  } else if (severity === "warning") {
    violations.push(
      violation(
        "low",
        "status.residual.legacy-warning",
        `severity "warning" is legacy \u2014 forbidden on new entries; read paths normalize it to "low"`,
        "use \"low\" (normalizeSeverity maps 'warning' \u2192 'low')",
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
        `decision must be one of ${RESIDUAL_DECISIONS.join(" | ")} \u2014 got ${JSON.stringify(decision)}`,
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

  // closed_at format is enforced whenever the field is present, regardless of
  // lifecycle (status-and-residuals.md § Residual findings lifecycle — the
  // close protocol sets `closed_at` (YYYY-MM-DD) + `closure_note`).
  if (closed_at !== undefined && (typeof closed_at !== "string" || !DATE_RE.test(closed_at))) {
    violations.push(violation("medium", "status.residual.invalid-closed-at", "closed_at must be YYYY-MM-DD"));
  }

  if (lifecycle !== undefined) {
    if (typeof lifecycle !== "string" || !(RESIDUAL_LIFECYCLES as readonly string[]).includes(lifecycle)) {
      violations.push(
        violation(
          "medium",
          "status.residual.invalid-lifecycle",
          `lifecycle must be one of ${RESIDUAL_LIFECYCLES.join(" | ")} \u2014 got ${JSON.stringify(lifecycle)}`,
        ),
      );
    } else if (lifecycle !== "open") {
      // Closed-lifecycle completeness (status-and-residuals.md § Residual
      // findings lifecycle: "On close: set closed_at (YYYY-MM-DD) and
      // closure_note; recommend closure_evidence").
      if (closed_at === undefined) {
        violations.push(
          violation(
            "high",
            "status.residual.closed-missing-closed-at",
            `lifecycle "${lifecycle}" requires closed_at (YYYY-MM-DD)`,
            'set closed_at (e.g. "2026-08-08")',
          ),
        );
      }
      if (entry.closure_note === undefined) {
        violations.push(
          violation(
            "medium",
            "status.residual.closed-missing-closure-note",
            `lifecycle "${lifecycle}" requires closure_note (what changed; how verified)`,
            "add closure_note explaining the close",
          ),
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * True when `dir` is a harness-relative path: not absolute (POSIX `/`,
 * Windows `C:\`), and no `..` segment can escape the harness dir. The v2
 * root `workflows[].dir` is resolved against `{HARNESS_DIR}` by
 * `validateStatusV2` and the root writers, so traversal must fail closed.
 */
function isHarnessRelativePath(dir: string): boolean {
  if (dir.startsWith("/") || dir.startsWith("\\")) return false;
  if (/^[A-Za-z]:[\\/]/.test(dir)) return false;
  return !dir.split(/[\\/]+/).includes("..");
}

/**
 * Validate one v2 root `workflows[]` entry (plan Task 3): required `id`,
 * `type` (plan | iteration), `started_at`, `dir` — harness-relative, never
 * absolute and never containing `..`. The removal-at-terminal invariant
 * (snapshot exists and is non-terminal) is checked at document level by
 * `validateStatusV2` when a harness dir is known.
 */
export function validateWorkflowEntry(entry: unknown): GateResult {
  const violations: ValidationResult[] = [];
  if (!isPlainObject(entry)) {
    return {
      ok: false,
      violations: [violation("high", "status.workflow.invalid", "workflow entry must be an object")],
    };
  }

  validateNonEmptyString(violations, entry.id, "id", "status.workflow.missing-id", "status.workflow.invalid-id");

  if (entry.type === undefined) {
    violations.push(violation("high", "status.workflow.missing-type", "missing required field: type"));
  } else if (typeof entry.type !== "string" || !(WORKFLOW_LIFECYCLE_TYPES as readonly string[]).includes(entry.type)) {
    violations.push(
      violation(
        "medium",
        "status.workflow.invalid-type",
        `type must be one of ${WORKFLOW_LIFECYCLE_TYPES.join(" | ")} \u2014 got ${JSON.stringify(entry.type)}`,
      ),
    );
  }

  validateNonEmptyString(
    violations,
    entry.started_at,
    "started_at",
    "status.workflow.missing-started-at",
    "status.workflow.invalid-started-at",
  );

  if (entry.dir === undefined) {
    violations.push(violation("high", "status.workflow.missing-dir", "missing required field: dir"));
  } else if (typeof entry.dir !== "string" || entry.dir.trim() === "") {
    violations.push(violation("medium", "status.workflow.invalid-dir", "dir must be a non-empty string"));
  } else if (!isHarnessRelativePath(entry.dir)) {
    violations.push(
      violation(
        "medium",
        "status.workflow.invalid-dir",
        `dir must be a harness-relative path (no absolute paths, no ".." segments) \u2014 got ${JSON.stringify(entry.dir)}`,
      ),
    );
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Validate a v2 status.json document (plan Task 3 — hard cutover). Accepts a
 * parsed document or a file path (malformed JSON yields a
 * `status.invalid-json` violation, never a throw). v1 or unknown-version
 * inputs — including v1-shaped documents carrying a root `plans[]` — fail
 * closed with an explicit `status.migration-required` violation carrying the
 * `mstar migrate` hint; there is no v1 read path anymore (v1 `validateStatus`
 * was deleted in the same task).
 *
 * Required: `version: 2`, `updated_at` (YYYY-MM-DD, same convention as the
 * v1 root), `workflows[]` of active entries (each validated by
 * `validateWorkflowEntry`, duplicate ids rejected).
 *
 * Removal-at-terminal invariant: when a harness dir is known (path input, or
 * `opts.harnessDir` for doc input), every listed entry's snapshot at
 * `{HARNESS_DIR}/<dir>/snapshot.json` must exist and be non-terminal — the
 * root holds active lifecycles only, and terminal writers unregister AFTER
 * the snapshot write. The snapshot must also PHYSICALLY live under the
 * harness: a symlinked `workflows/<id>/` (or snapshot file) resolving
 * outside the harness dir is rejected fail-closed (QC wave-1 S-f). Doc
 * input without a harness dir is structure-only.
 */
export function validateStatusV2(
  docOrPath: StatusV2Doc | string,
  opts: { harnessDir?: string } = {},
): GateResult {
  let doc: unknown;
  let harnessDir: string | undefined = opts.harnessDir;
  if (typeof docOrPath === "string") {
    try {
      doc = readJson(docOrPath);
      harnessDir = dirname(resolve(docOrPath));
    } catch (error) {
      return {
        ok: false,
        violations: [violation("high", "status.invalid-json", (error as Error).message)],
      };
    }
  } else {
    doc = docOrPath;
  }

  if (!isPlainObject(doc)) {
    return { ok: false, violations: [violation("high", "status.invalid-doc", "status document must be an object")] };
  }

  // Hard cutover (plan Task 3): a root file with `version !== 2` is the
  // migration-detection input — fail closed, never a silent pass or a dual
  // read. v1-shaped documents (root `plans[]`) are rejected the same way
  // even when the version field is missing or already says 2.
  if (doc.version !== 2) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "status.migration-required",
          `status.json schema version 2 required \u2014 got ${JSON.stringify(doc.version)} (v1 or unknown version); run \`mstar migrate\` to convert the tree`,
          "run `mstar migrate`",
        ),
      ],
    };
  }
  if (Array.isArray(doc.plans)) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "status.migration-required",
          "v1-shaped status.json (root plans[]) is not a v2 document \u2014 run `mstar migrate` to convert the tree",
          "run `mstar migrate`",
        ),
      ],
    };
  }
  // QC wave-1 W-C: the v1-disguise check covers `plans[]` AND the other v1
  // root surface — `residual_findings` (keyed by plan id, arrays of
  // entries). A `version: 2` doc carrying it is stale v1 data masquerading
  // as migrated (the v2 root holds `workflows[]` only); presence of the key
  // at all — even `{}` — is v1-shaped (v1 init template), so fail closed.
  if (doc.residual_findings !== undefined) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "status.migration-required",
          "v1-shaped status.json (root residual_findings) is not a v2 document \u2014 run `mstar migrate` to convert the tree",
          "run `mstar migrate`",
        ),
      ],
    };
  }

  const violations: ValidationResult[] = [];

  if (doc.updated_at === undefined) {
    violations.push(violation("high", "status.missing-updated-at", "missing required field: updated_at"));
  } else if (typeof doc.updated_at !== "string" || !DATE_RE.test(doc.updated_at)) {
    violations.push(violation("medium", "status.invalid-updated-at", "updated_at must be YYYY-MM-DD"));
  }

  if (doc.workflows === undefined) {
    violations.push(violation("high", "status.missing-workflows", "missing required field: workflows"));
  } else if (!Array.isArray(doc.workflows)) {
    violations.push(violation("high", "status.invalid-workflows", "workflows must be an array"));
  } else {
    const seen = new Set<string>();
    for (const entry of doc.workflows) {
      violations.push(...validateWorkflowEntry(entry).violations);
      if (isPlainObject(entry) && typeof entry.id === "string") {
        if (seen.has(entry.id)) {
          violations.push(
            violation("medium", "status.workflow.duplicate-id", `duplicate workflow id in workflows[]: ${JSON.stringify(entry.id)}`),
          );
        }
        seen.add(entry.id);
      }
    }
  }

  // Removal-at-terminal invariant (plan Task 3): the list holds active
  // lifecycles only — no listed id may resolve to a terminal or missing
  // snapshot. Skipped when no harness dir is known (structure-only input).
  if (harnessDir !== undefined && Array.isArray(doc.workflows)) {
    // QC wave-1 S-f (qc2 F-005): symlink hardening — the invariant must
    // read a snapshot that PHYSICALLY lives under the harness. The lexical
    // path is harness-relative, but a symlinked `workflows/<id>/` (or
    // snapshot file) can point outside; `realpathSync` resolves the chain
    // and the resolved path must stay under the resolved harness root.
    // Resolving the harness root once also normalizes the comparison when
    // the harness dir itself is reached through a symlink (e.g. /tmp).
    let realHarnessDir: string | null = null;
    try {
      realHarnessDir = realpathSync(harnessDir);
    } catch {
      // Harness dir missing — every snapshot check below reports missing;
      // the physical-location check is moot.
    }
    for (const entry of doc.workflows) {
      if (!isPlainObject(entry) || typeof entry.dir !== "string") continue;
      const relSnapshot = join(entry.dir, WORKFLOW_SNAPSHOT_FILE);
      const snapshotPath = join(harnessDir, relSnapshot);
      const label = typeof entry.id === "string" ? entry.id : relSnapshot;
      // realpathSync doubles as the existence probe (a missing file or a
      // dangling symlink throws) and the physical-location probe.
      let physical: string;
      try {
        physical = realpathSync(snapshotPath);
      } catch {
        violations.push(
          violation(
            "high",
            "status.workflow.snapshot-missing",
            `workflows[] lists ${JSON.stringify(label)} but its snapshot does not exist at ${JSON.stringify(relSnapshot)} \u2014 the root holds active lifecycles only; unregister the id when its snapshot is removed`,
          ),
        );
        continue;
      }
      if (realHarnessDir !== null && physical !== realHarnessDir && !physical.startsWith(`${realHarnessDir}${sep}`)) {
        violations.push(
          violation(
            "high",
            "status.workflow.snapshot-outside-harness",
            `workflows[] lists ${JSON.stringify(label)} but its snapshot resolves outside the harness dir (${JSON.stringify(physical)}) \u2014 symlinked snapshot paths are rejected; the snapshot must physically live under ${JSON.stringify(harnessDir)}`,
          ),
        );
        continue;
      }
      let snapshot: Record<string, unknown>;
      try {
        snapshot = readJson(snapshotPath);
      } catch (error) {
        violations.push(
          violation(
            "high",
            "status.workflow.snapshot-invalid",
            `snapshot at ${JSON.stringify(relSnapshot)} is not valid JSON: ${(error as Error).message}`,
          ),
        );
        continue;
      }
      if (typeof snapshot.status === "string" && (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(snapshot.status)) {
        violations.push(
          violation(
            "high",
            "status.workflow.terminal-listed",
            `workflows[] lists ${JSON.stringify(label)} whose snapshot status is terminal (${snapshot.status}) \u2014 removal-at-terminal: terminal writers unregister AFTER the snapshot write`,
          ),
        );
      }
      // QC wave-1 S-c: the root entry denormalizes `type`/`started_at` from
      // the snapshot — cross-check them when the harness dir is known so a
      // stale root copy cannot drift silently from its snapshot.
      if (typeof entry.type === "string" && typeof snapshot.type === "string" && entry.type !== snapshot.type) {
        violations.push(
          violation(
            "medium",
            "status.workflow.mismatched-type",
            `workflows[] entry ${JSON.stringify(label)} type ${JSON.stringify(entry.type)} does not match its snapshot type ${JSON.stringify(snapshot.type)} \u2014 the root entry mirrors the snapshot; align them`,
          ),
        );
      }
      if (typeof entry.started_at === "string" && typeof snapshot.started_at === "string" && entry.started_at !== snapshot.started_at) {
        violations.push(
          violation(
            "medium",
            "status.workflow.mismatched-started-at",
            `workflows[] entry ${JSON.stringify(label)} started_at ${JSON.stringify(entry.started_at)} does not match its snapshot started_at ${JSON.stringify(snapshot.started_at)} \u2014 workflow ${JSON.stringify(label)} collided with another writer (e.g. a concurrent/re-run \`audit promote\` with the same workflow id rewrote the snapshot); the root entry mirrors the snapshot \u2014 align them or remove the colliding workflow`,
          ),
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Relocated v2 root validator (plan Task 3 — hard cutover, no dual path):
 * the v1 `validateStatus` implementation was deleted in the same task that
 * introduced the v2 surface; the public export name survives so external
 * consumers (CLI, host hooks — cut over in P2) keep compiling and now fail
 * closed on v1 input with the `mstar migrate` hint.
 */
export const validateStatus = validateStatusV2;

/**
 * Register one active workflow entry in the v2 root file (plan Task 3).
 * Idempotent upsert by entry `id` under the root-file `withStatusWriteLock`,
 * bumping root `updated_at`. A missing/empty root file is initialized from
 * the v2 template (never a v1 tree); a v1 root is refused with the
 * `mstar migrate` hint (no silent mutation of an un-migrated tree).
 *
 * The final document is validated with `validateStatusV2` (including the
 * removal-at-terminal snapshot invariant against `dirname(root)`) before the
 * write — an entry whose snapshot is missing or terminal is refused and
 * nothing is written.
 */
export async function registerWorkflow(root: string, entry: WorkflowEntry): Promise<StatusV2Doc> {
  const entryGate = validateWorkflowEntry(entry);
  if (!entryGate.ok) {
    throw new Error(
      `refusing to register invalid workflow entry: ${entryGate.violations.map((v) => v.message).join("; ")}`,
    );
  }
  const statusPath = resolve(root);
  const harnessDir = dirname(statusPath);
  return withStatusWriteLock(statusPath, () => {
    // simplify: full-doc validation (incl. per-snapshot reads of the whole
    // active set) under the root lock is O(active workflows) per root write.
    // Realistic active-set size is 1–3 (microseconds); correctness-preserving.
    // Upgrade path: scope the on-disk invariant to the touched entry (qc3 S-002).
    const current = readJson(statusPath) as Record<string, unknown>;
    const fresh = Object.keys(current).length === 0;
    const doc: StatusV2Doc = fresh
      ? { version: 2, updated_at: todayString(), workflows: [] }
      : (current as StatusV2Doc);
    if (!fresh && !Array.isArray(doc.workflows)) {
      throw new Error(
        "refusing to modify status.json: workflows must be an array \u2014 a v1 root must be migrated first (run `mstar migrate`)",
      );
    }
    const existing = doc.workflows.findIndex((wf) => wf.id === entry.id);
    if (existing >= 0) {
      doc.workflows[existing] = entry;
    } else {
      doc.workflows.push(entry);
    }
    doc.updated_at = todayString();
    const gate = validateStatusV2(doc, { harnessDir });
    if (!gate.ok) {
      throw new Error(`refusing to write invalid status.json: ${gate.violations.map((v) => v.message).join("; ")}`);
    }
    writeJson(statusPath, doc as unknown as Record<string, unknown>);
    return doc;
  });
}

/**
 * Remove one workflow entry from the v2 root file (plan Task 3). Idempotent:
 * removing an absent id is a no-op with no write; a missing/empty root file
 * is a no-op that never creates the file. Runs under the root-file
 * `withStatusWriteLock`, bumping root `updated_at` only when an entry was
 * actually removed. The final document is validated (removal-at-terminal
 * invariant included) before the write — a v1 root is refused with the
 * `mstar migrate` hint.
 */
export async function unregisterWorkflow(root: string, id: string): Promise<StatusV2Doc> {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("refusing to unregister workflow: id must be a non-empty string");
  }
  const statusPath = resolve(root);
  const harnessDir = dirname(statusPath);
  return withStatusWriteLock(statusPath, () => {
    // simplify: same O(active) full-doc validation as registerWorkflow (qc3 S-002).
    const current = readJson(statusPath) as Record<string, unknown>;
    if (Object.keys(current).length === 0) {
      // Nothing to remove — return the empty v2 shape without touching the file.
      return { version: 2, updated_at: todayString(), workflows: [] };
    }
    const doc = current as StatusV2Doc;
    if (!Array.isArray(doc.workflows)) {
      throw new Error(
        "refusing to modify status.json: workflows must be an array \u2014 a v1 root must be migrated first (run `mstar migrate`)",
      );
    }
    const remaining = doc.workflows.filter((wf) => wf.id !== id);
    if (remaining.length === doc.workflows.length) {
      return doc; // idempotent no-op — nothing removed, no write
    }
    doc.workflows = remaining;
    doc.updated_at = todayString();
    const gate = validateStatusV2(doc, { harnessDir });
    if (!gate.ok) {
      throw new Error(`refusing to write invalid status.json: ${gate.violations.map((v) => v.message).join("; ")}`);
    }
    writeJson(statusPath, doc as unknown as Record<string, unknown>);
    return doc;
  });
}

/**
 * Resolve the repo-level hard-enforcement flag from the iteration compass
 * (roadmap §8.5 C4/D2): `{ITERATION_DIR}/<id>/delivery-compass.md` files are
 * scanned; only compasses still steering the repo count — frontmatter
 * `status: active` or `status: locked` — and the FIRST such compass whose
 * frontmatter declares `enforcement: hard` hardens the gate in this repo.
 * A COMPLETED (or status-less/archived) iteration's compass NEVER hardens:
 * D2 rollback = unset the flag in the ACTIVE compass, and that must work
 * while older completed compasses still declare hard (qc1 F-001 / qc2 F-002).
 * A counting compass declaring a non-hard value, or no compass at all,
 * leaves the flag unset (`source: none`) — hard gates are never the default
 * and the flag is inert when the engine is absent. Frontmatter is
 * `---`-fenced; hard declarations in the compass BODY do not count (the
 * frontmatter is the schema surface — see iteration.compassSchema).
 */
export function resolveCompassEnforcement(harnessDir: string): EnforcementFlag {
  const iterationsDir = resolveIterationDir(harnessDir);
  if (!existsSync(iterationsDir)) return { hard: false, source: "none" };
  let entries;
  try {
    entries = readdirSync(iterationsDir, { withFileTypes: true });
  } catch {
    return { hard: false, source: "none" };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const compassPath = join(iterationsDir, entry.name, "delivery-compass.md");
    if (!existsSync(compassPath)) continue;
    let content: string;
    try {
      content = readFileSync(compassPath, "utf8");
    } catch {
      continue;
    }
    // Frontmatter only: leading `---` fence through the closing fence.
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fm = frontmatter !== null ? frontmatter[1]! : "";
    // Sticky-hard guard (qc1 F-001 / qc2 F-002): only `status: active` /
    // `status: locked` compasses count toward hardening. Completed and
    // status-less compasses are skipped — fail-soft (an archive must never
    // keep the repo hardened).
    if (!/^status[ \t]*:[ \t]*(?:active|locked)[ \t]*$/m.test(fm)) continue;
    const flag = parseEnforcementFlag(fm);
    if (flag.hard) return flag;
  }
  return { hard: false, source: "none" };
}

/**
 * Resolve the repo-declared hard-enforcement flag from `.mstarc`
 * `[config] enforcement` (plan-conventions § `.mstarc` 格式): the nearest
 * config at the harness dir or its parent (the repo root) wins —
 * `hard` → hard, `soft` → soft, absent/invalid value → `none`. Same
 * discovery scope as the sub-directory keys; a config above the repo
 * root is never adopted.
 */
export function resolveMstarcEnforcement(harnessDir: string): EnforcementFlag {
  const dir = resolve(harnessDir);
  const rc = loadMstarc(dir, dirname(dir));
  const value = rc?.config.enforcement;
  if (value === "hard") return { hard: true, source: "mstarc" };
  if (value === "soft") return { hard: false, source: "mstarc" };
  return { hard: false, source: "none" };
}

/**
 * Repo-level hard-enforcement flag: `.mstarc` `[config] enforcement` wins,
 * else the iteration compass frontmatter (`resolveCompassEnforcement`),
 * else warn-only. Hosts compose this BELOW their explicit Config override
 * and the per-dispatch Assignment flag (precedence: Config > Assignment
 * flag > repo `.mstarc` > compass > warn-only) — `.mstarc` `soft` is a
 * local rollback against a hard compass, `.mstarc` `hard` hardens
 * flag-less dispatches and gates.
 */
export function resolveRepoEnforcement(harnessDir: string): EnforcementFlag {
  const rc = resolveMstarcEnforcement(harnessDir);
  if (rc.source !== "none") return rc;
  return resolveCompassEnforcement(harnessDir);
}
