/**
 * Engine status module — status.json schema validation, residual severity
 * normalization, residual lifecycle (open → archived), findings-cleanup gate,
 * and the `tech-debt-rollup.sh` parity port.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - status.json schema + required fields + root-only `residual_findings`
 *   (reject dual-write under `metadata.residual_findings`):
 *   `skills/mstar-plan-artifacts/references/status-and-residuals.md`
 *   § Basic structure + § General constraints ("Init with `residual_findings`:
 *   {}; no dual-write with legacy side") + § Common queries (legacy read path).
 * - Severity enum + legacy `"warning"` → `low` normalization (read + rollup):
 *   § "Residual findings: `severity` (SSOT, machine field)" — allowed values
 *   `critical|high|medium|low|nit`; `warning`/`Major`/non-English forbidden in
 *   JSON; legacy `"severity": "warning"` is read and rolled up as `low`.
 *   `null`/`""` → `medium` mirrors `scripts/tech-debt-rollup.sh` `norm_sev`.
 * - Residual lifecycle + archive shape (plan_id, schema_version, entries[],
 *   `archived_at`; remove from open list; update root `updated_at`; delete
 *   empty plan-id keys):
 *   § Residual findings lifecycle (close, archive, remove) — "Recommended:
 *   archive to `archived/residuals/<plan-id>.json`" + § General constraints
 *   ("Empty `plan-id` key: … delete the key … no `"plan-id": []`").
 * - Findings cleanup modes (zero-residual vs allow-residual; blocker-defer
 *   definition; nit/waived rules): § Findings cleanup modes.
 * - Rollup aggregates + drift check (total_open / by_severity / by_target /
 *   by_plan; PASS/DRIFT vs stored `metadata.tech_debt_summary`):
 *   § `metadata.tech_debt_summary` (optional rollup) — canonical compute is
 *   `scripts/tech-debt-rollup.sh`; the TS port must be byte-identical.
 * - `ValidationResult`/`GateResult` shapes + severity machine SSOT:
 *   `packages/engine/src/core.ts` (roadmap §8.5 C2/C4).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  archiveResiduals,
  findingsCleanupGate,
  normalizeSeverity,
  techDebtRollup,
  validatePlanRow,
  validateResidual,
  validateStatus,
} from "../src/status.js";
import type { GateResult, ValidationResult } from "../src/core.js";
import type { FindingsCleanupMode, TechDebtRollup } from "../src/status.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const EMPTY_TEMPLATE = join(FIXTURES, "status.empty.json");
const REAL_SHAPE = join(FIXTURES, "status.real-shape.json");
const ROLLUP_FIXTURE = join(FIXTURES, "status.rollup-multiplans.json");
const SCRAMBLED_FIXTURE = join(FIXTURES, "status.rollup-scrambled.json");

/**
 * Bash parity oracle — `skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh`
 * in the monorepo root. No machine-local paths: the env override
 * (`MSTAR_PLAN_ARTIFACTS_SCRIPT`) wins, else walk up from this test dir to the
 * repo root. Returns null when the script is unreachable (parity tests then
 * fail loudly — see `bashRollup`).
 */
function resolveRollupScript(): string | null {
  const fromEnv = process.env.MSTAR_PLAN_ARTIFACTS_SCRIPT;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  let dir = import.meta.dir;
  for (;;) {
    const candidate = join(dir, "skills", "mstar-plan-artifacts", "scripts", "tech-debt-rollup.sh");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const ROLLUP_SCRIPT = resolveRollupScript();

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function violationsOf(result: GateResult): string[] {
  return result.violations.map((v) => v.code);
}

function violationCodes(...expected: string[]): (result: GateResult) => void {
  return (result: GateResult) => {
    expect(result.ok).toBe(false);
    for (const code of expected) expect(violationsOf(result)).toContain(code);
  };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "R1",
    title: "Finding title",
    severity: "low",
    source: "QC-#1 qc1.md F-001 @ <review-range>",
    scope: "src/example.ts",
    decision: "defer",
    owner: "@fullstack-dev",
    target: "Before plan 02",
    tracking: null,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "plan-a",
    title: "Plan title",
    file: ".mstar/plans/plan-a.md",
    status: "Todo",
    ...overrides,
  };
}

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    updated_at: "2026-08-08",
    plans: [],
    residual_findings: {},
    metadata: {},
    ...overrides,
  };
}

/** Mirror of the bash script's echo formatting (see `scripts/tech-debt-rollup.sh`). */
function renderRollupOutput(rollup: TechDebtRollup): string {
  const lines: string[] = [];
  lines.push("=== tech_debt_summary (computed from open residual_findings) ===");
  lines.push(JSON.stringify(rollup.computed, null, 2));
  lines.push("");
  lines.push("=== stored metadata.tech_debt_summary ===");
  lines.push(rollup.stored === null ? "(none)" : JSON.stringify(rollup.stored, null, 2));
  lines.push("");
  lines.push("=== consistency check ===");
  for (const check of rollup.checks) {
    const computed = JSON.stringify(rollup.computed[check.field]);
    if (rollup.stored === null) {
      lines.push(`DRIFT: no stored tech_debt_summary (computed ${check.field} = ${computed})`);
    } else if (check.status === "PASS") {
      lines.push(`PASS: ${check.field}`);
    } else {
      lines.push(`DRIFT: ${check.field}`);
      lines.push(`  computed: ${computed}`);
      lines.push(`  stored:   ${JSON.stringify(rollup.stored[check.field] ?? null)}`);
    }
  }
  lines.push("");
  lines.push(
    rollup.overall === "PASS"
      ? "OVERALL: PASS"
      : "OVERALL: DRIFT — refresh metadata.tech_debt_summary in status.json",
  );
  return `${lines.join("\n")}\n`;
}

function bashRollup(statusPath: string): { stdout: string; exitCode: number } {
  if (ROLLUP_SCRIPT === null) {
    throw new Error(
      "parity test requires the bash oracle scripts/tech-debt-rollup.sh — the monorepo root walk found " +
        "nothing; set MSTAR_PLAN_ARTIFACTS_SCRIPT to its path",
    );
  }
  const result = spawnSync("bash", [ROLLUP_SCRIPT, statusPath], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error; // e.g. ENOENT when bash is not installed
  return { stdout: result.stdout ?? "", exitCode: result.status ?? -1 };
}

describe("normalizeSeverity (legacy read path)", () => {
  test("legacy 'warning' normalizes to 'low' (status-and-residuals § severity 5)", () => {
    expect(normalizeSeverity("warning")).toBe("low");
  });

  test("null and empty-string normalize to 'medium' (tech-debt-rollup.sh norm_sev)", () => {
    expect(normalizeSeverity(null)).toBe("medium");
    expect(normalizeSeverity("")).toBe("medium");
  });

  test("enum values pass through unchanged", () => {
    for (const severity of ["critical", "high", "medium", "low", "nit"]) {
      expect(normalizeSeverity(severity)).toBe(severity);
    }
  });

  test("unknown values pass through unchanged (jq parity — nothing to map them to)", () => {
    expect(normalizeSeverity("Major")).toBe("Major");
  });
});

describe("validatePlanRow", () => {
  test("valid minimal row (canonical id key) passes", () => {
    expect(validatePlanRow(row()).violations).toEqual([]);
  });

  test("legacy plan_id-only row passes (read compatibility: id or plan_id)", () => {
    const { id: _drop, plan_id: planId, ...rest } = { ...row(), plan_id: "plan-a" };
    void _drop;
    expect(validatePlanRow({ plan_id: planId, ...rest }).violations).toEqual([]);
  });

  test("dual id + plan_id with the same value passes (one canonical value)", () => {
    expect(validatePlanRow(row({ plan_id: "plan-a" })).violations).toEqual([]);
  });

  test("row without id and plan_id is a violation", () => {
    const { id: _drop, ...rest } = row();
    void _drop;
    violationCodes("status.plan-row.missing-id")(validatePlanRow(rest));
  });

  test("differing id and plan_id is a violation (write one canonical key)", () => {
    violationCodes("status.plan-row.dual-id")(validatePlanRow(row({ plan_id: "other-plan" })));
  });

  test("missing title / file are violations", () => {
    const { title: _t, ...noTitle } = row();
    const { file: _f, ...noFile } = row();
    void _t;
    void _f;
    violationCodes("status.plan-row.missing-title")(validatePlanRow(noTitle));
    violationCodes("status.plan-row.missing-file")(validatePlanRow(noFile));
  });

  test("status outside Todo|InProgress|InReview|Blocked|Done is a violation", () => {
    violationCodes("status.plan-row.invalid-status")(validatePlanRow(row({ status: "Finished" })));
  });

  test("non-object metadata / execution_lease are violations", () => {
    violationCodes("status.plan-row.invalid-metadata")(validatePlanRow(row({ metadata: [] })));
    violationCodes("status.plan-row.invalid-execution-lease")(
      validatePlanRow(row({ execution_lease: "cursor:abc" })),
    );
  });
});

describe("validateResidual", () => {
  test("valid open entry passes", () => {
    expect(validateResidual(entry()).violations).toEqual([]);
  });

  test("each required field is enforced (id/title/severity/source/scope/decision/owner/target/tracking)", () => {
    for (const field of ["id", "title", "severity", "source", "scope", "decision", "owner", "target", "tracking"]) {
      const { [field]: _drop, ...rest } = entry();
      void _drop;
      const result = validateResidual(rest);
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toContain(`status.residual.missing-${field}`);
    }
  });

  test("legacy 'warning' severity is flagged with fix → low (forbidden on new entries)", () => {
    const result = validateResidual(entry({ severity: "warning" }));
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.code === "status.residual.legacy-warning");
    expect(violation).toBeDefined();
    expect(violation?.fix).toContain("low");
  });

  test("unknown severity value is a violation (only the five enum values + legacy warning)", () => {
    violationCodes("status.residual.invalid-severity")(validateResidual(entry({ severity: "Major" })));
    violationCodes("status.residual.invalid-severity")(validateResidual(entry({ severity: null })));
  });

  test("decision outside defer|accept|risk-accepted is a violation", () => {
    violationCodes("status.residual.invalid-decision")(validateResidual(entry({ decision: "maybe" })));
  });

  test("lifecycle outside open|resolved|waived|superseded|duplicate is a violation", () => {
    violationCodes("status.residual.invalid-lifecycle")(validateResidual(entry({ lifecycle: "closed" })));
  });

  test("closed entry (lifecycle + closed_at + closure_note) passes", () => {
    expect(
      validateResidual(
        entry({ lifecycle: "resolved", closed_at: "2026-08-07", closure_note: "fixed and verified" }),
      ).violations,
    ).toEqual([]);
  });
});

describe("validateStatus", () => {
  test("status.empty.json template validates clean (templates/status.empty.json)", () => {
    const result = validateStatus(EMPTY_TEMPLATE);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("real repo .harness/status.json shape validates clean (legacy plan_id rows, mixed metadata, detail_doc null)", () => {
    const result = validateStatus(REAL_SHAPE);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("accepts a parsed object or a file path", () => {
    expect(validateStatus(doc()).ok).toBe(true);
    expect(validateStatus(EMPTY_TEMPLATE).ok).toBe(true);
  });

  test("required top-level fields: version / updated_at / plans / residual_findings / metadata", () => {
    violationCodes("status.missing-version")(validateStatus(doc({ version: undefined })));
    violationCodes("status.missing-updated-at")(validateStatus(doc({ updated_at: undefined })));
    violationCodes("status.missing-plans")(validateStatus(doc({ plans: undefined })));
    violationCodes("status.missing-residual-findings")(validateStatus(doc({ residual_findings: undefined })));
    violationCodes("status.missing-metadata")(validateStatus(doc({ metadata: undefined })));
  });

  test("wrong types for top-level fields are violations", () => {
    violationCodes("status.invalid-plans")(validateStatus(doc({ plans: {} })));
    violationCodes("status.invalid-residual-findings")(validateStatus(doc({ residual_findings: [] })));
    violationCodes("status.invalid-metadata")(validateStatus(doc({ metadata: [] })));
  });

  test("unsupported schema version is a violation (current schema is v1)", () => {
    violationCodes("status.unsupported-version")(validateStatus(doc({ version: 2 })));
    violationCodes("status.invalid-version")(validateStatus(doc({ version: "1" })));
  });

  test("updated_at must be YYYY-MM-DD", () => {
    violationCodes("status.invalid-updated-at")(validateStatus(doc({ updated_at: "2026-08-08T00:00:00Z" })));
  });

  test("dual-write: metadata.residual_findings is rejected (root-only canonical)", () => {
    violationCodes("status.dual-write-residuals")(
      validateStatus(doc({ residual_findings: { "plan-a": [entry()] }, metadata: { residual_findings: { "plan-a": [entry()] } } })),
    );
  });

  test("empty plan-id key is flagged (delete the key, no 'plan-id': [])", () => {
    violationCodes("status.residual.empty-key")(
      validateStatus(doc({ residual_findings: { "plan-a": [] } })),
    );
  });

  test("malformed JSON file yields a violation, not a throw", () => {
    const dir = tmpRoot("status-invalid-json-");
    const file = join(dir, "status.json");
    writeFileSync(file, "{ not json", "utf8");
    const result = validateStatus(file);
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toContain("status.invalid-json");
    rmSync(dir, { recursive: true, force: true });
  });

  test("plan-row and residual violations aggregate into the gate result", () => {
    const result = validateStatus(
      doc({
        plans: [row({ status: "Finished" })],
        residual_findings: { "plan-a": [entry({ severity: "Major" })] },
      }),
    );
    expect(violationsOf(result)).toContain("status.plan-row.invalid-status");
    expect(violationsOf(result)).toContain("status.residual.invalid-severity");
  });
});

describe("archiveResiduals", () => {
  test("moves open residuals to archived/residuals/<plan-id>.json and removes them from the open list", () => {
    const dir = tmpRoot("status-archive-");
    const statusPath = join(dir, "status.json");
    const before = doc({
      updated_at: "2026-08-01",
      residual_findings: {
        "plan-a": [entry({ id: "R1" }), entry({ id: "R2", severity: "nit", decision: "accept" })],
      },
    });
    writeFileSync(statusPath, JSON.stringify(before, null, 2), "utf8");

    const result = archiveResiduals("plan-a", dir);
    expect(result.archived).toBe(2);
    expect(result.archivePath).toBe(join(dir, "archived", "residuals", "plan-a.json"));

    const archive = JSON.parse(readFileSync(result.archivePath, "utf8")) as Record<string, unknown>;
    expect(archive.plan_id).toBe("plan-a");
    expect(archive.schema_version).toBe(1);
    const entries = archive.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    // NOTE: read values before toMatchObject — bun replaces matched properties
    // with the asymmetric matcher object, polluting later reads of the same ref.
    const archivedAt = entries[0].archived_at;
    expect(typeof archivedAt).toBe("string");
    expect(entries[0]).toMatchObject({ id: "R1" });
    expect(entries[1]).toMatchObject({ id: "R2" });

    const after = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
    expect(after.residual_findings).not.toHaveProperty("plan-a");
    expect(after.updated_at).toBe(archivedAt);
    rmSync(dir, { recursive: true, force: true });
  });

  test("appends to an existing archive file", () => {
    const dir = tmpRoot("status-archive-append-");
    const statusPath = join(dir, "status.json");
    writeFileSync(
      statusPath,
      JSON.stringify(doc({ residual_findings: { "plan-a": [entry({ id: "R9" })] } }), null, 2),
      "utf8",
    );
    const archiveDir = join(dir, "archived", "residuals");
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, "plan-a.json");
    const existing = { plan_id: "plan-a", schema_version: 1, entries: [entry({ id: "R1", archived_at: "2026-07-01" })] };
    writeFileSync(archivePath, JSON.stringify(existing, null, 2), "utf8");

    archiveResiduals("plan-a", dir);
    const archive = JSON.parse(readFileSync(archivePath, "utf8")) as { entries: unknown[] };
    expect(archive.entries).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no-op when the plan has no open residuals (no archive file created)", () => {
    const dir = tmpRoot("status-archive-empty-");
    writeFileSync(join(dir, "status.json"), JSON.stringify(doc(), null, 2), "utf8");
    const result = archiveResiduals("plan-a", dir);
    expect(result.archived).toBe(0);
    expect(existsSync(result.archivePath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when status.json is missing", () => {
    const dir = tmpRoot("status-archive-missing-");
    expect(() => archiveResiduals("plan-a", dir)).toThrow(/status file not found/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("findingsCleanupGate", () => {
  function gated(
    entries: Array<Record<string, unknown>>,
    opts?: { mode?: FindingsCleanupMode; planMetadata?: Record<string, unknown> },
  ): GateResult {
    const plan = row(
      opts?.planMetadata === undefined ? {} : { metadata: opts.planMetadata },
    ) as Record<string, unknown>;
    return findingsCleanupGate(
      doc({ plans: [plan], residual_findings: { "plan-a": entries } }) as Parameters<typeof findingsCleanupGate>[0],
      "plan-a",
      opts,
    );
  }

  test("allow-residual (default): open low/medium residuals are fine", () => {
    const result = gated([entry({ decision: "accept" }), entry({ id: "R2", severity: "medium" })]);
    expect(result.ok).toBe(true);
  });

  test("allow-residual: unresolved critical blocks Approve with residuals", () => {
    violationCodes("findings.allow-residual-critical")(gated([entry({ severity: "critical" })]));
  });

  test("zero-residual: true blocker-defer (decision defer + target) passes", () => {
    const result = gated([entry({ decision: "defer", target: "next iteration" })], { mode: "zero-residual" });
    expect(result.ok).toBe(true);
  });

  test("zero-residual: fixable open findings (accept) are blocked", () => {
    violationCodes("findings.zero-residual-open-fixable")(gated([entry({ decision: "accept" })], { mode: "zero-residual" }));
  });

  test("zero-residual: risk-accepted must be closed/archived, not left open", () => {
    violationCodes("findings.zero-residual-risk-accepted")(
      gated([entry({ decision: "risk-accepted" })], { mode: "zero-residual" }),
    );
  });

  test("zero-residual: defer without a target is not a true blocker-defer", () => {
    violationCodes("findings.zero-residual-defer-no-target")(
      gated([entry({ decision: "defer", target: null })], { mode: "zero-residual" }),
    );
  });

  test("zero-residual: style-only nits never stay open", () => {
    violationCodes("findings.zero-residual-nit")(gated([entry({ severity: "nit" })], { mode: "zero-residual" }));
  });

  test("zero-residual: closed entries are ignored", () => {
    const result = gated(
      [entry({ lifecycle: "resolved", closed_at: "2026-08-07", closure_note: "fixed" })],
      { mode: "zero-residual" },
    );
    expect(result.ok).toBe(true);
  });

  test("mode resolves from plans[].metadata.findings_cleanup when not passed explicitly", () => {
    const result = gated([entry({ decision: "accept" })], { planMetadata: { findings_cleanup: "zero-residual" } });
    expect(violationsOf(result)).toContain("findings.zero-residual-open-fixable");
  });

  test("explicit mode wins over plan metadata", () => {
    const result = gated([entry({ decision: "accept" })], {
      mode: "allow-residual",
      planMetadata: { findings_cleanup: "zero-residual" },
    });
    expect(result.ok).toBe(true);
  });
});

describe("techDebtRollup", () => {
  test("computed aggregates match jq semantics (warning→low, null/''→medium, closed excluded, unspecified target)", () => {
    const rollup = techDebtRollup(ROLLUP_FIXTURE);
    expect(rollup.computed).toEqual({
      total_open: 5,
      by_severity: { critical: 0, high: 0, medium: 3, low: 2, nit: 0 },
      by_target: { "V1.0": 2, "V1.1": 2, unspecified: 1 },
      by_plan: { "plan-a": 3, "plan-b": 2 },
    });
  });

  test("legacy metadata.residual_findings merge follows jq `$canon + $legacy` precedence (legacy wins per plan key)", () => {
    const rollup = techDebtRollup(
      doc({
        residual_findings: { "plan-a": [entry({ id: "R1", severity: "low" })] },
        metadata: {
          residual_findings: {
            // conflicting key: jq object `+` keeps the right operand (legacy) value
            "plan-a": [entry({ id: "R1", severity: "high" }), entry({ id: "R2", severity: "high" })],
            "plan-b": [entry({ id: "R1", severity: "nit" })],
          },
        },
      }),
    );
    expect(rollup.computed.total_open).toBe(3);
    expect(rollup.computed.by_severity).toEqual({ critical: 0, high: 2, medium: 0, low: 0, nit: 1 });
    expect(rollup.computed.by_plan).toEqual({ "plan-a": 2, "plan-b": 1 });
  });

  test("stored summary matching computed → all PASS, OVERALL PASS", () => {
    const rollup = techDebtRollup(ROLLUP_FIXTURE);
    expect(rollup.checks.map((c) => c.status)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    expect(rollup.overall).toBe("PASS");
  });

  test("no stored summary → every field DRIFT, OVERALL DRIFT", () => {
    const rollup = techDebtRollup(doc({ residual_findings: { "plan-a": [entry()] } }));
    expect(rollup.stored).toBeNull();
    expect(rollup.checks.map((c) => c.status)).toEqual(["DRIFT", "DRIFT", "DRIFT", "DRIFT"]);
    expect(rollup.overall).toBe("DRIFT");
  });

  test("field-level DRIFT when stored summary disagrees", () => {
    const withStored = doc({
      residual_findings: { "plan-a": [entry()] },
      metadata: {
        tech_debt_summary: {
          total_open: 1,
          by_severity: { critical: 0, high: 0, medium: 0, low: 1, nit: 0 },
          // stored by_target disagrees: computed is { "Before plan 02": 1 }
          by_target: { unspecified: 1 },
          by_plan: { "plan-a": 1 },
        },
      },
    });
    const rollup = techDebtRollup(withStored);
    expect(rollup.checks.map((c) => `${c.field}:${c.status}`)).toEqual([
      "total_open:PASS",
      "by_severity:PASS",
      "by_target:DRIFT",
      "by_plan:PASS",
    ]);
    expect(rollup.overall).toBe("DRIFT");
  });

  test("stored summary with scrambled key order → DRIFT (bash compare_field string-compares jq -c output, key order matters)", () => {
    // Same values as ROLLUP_FIXTURE, but every stored object's keys are in a
    // different order than jq -c emits — deep equality would PASS; the string
    // compare (like bash compare_field) must DRIFT on by_severity/by_target/by_plan.
    const rollup = techDebtRollup(SCRAMBLED_FIXTURE);
    expect(rollup.checks.map((c) => `${c.field}:${c.status}`)).toEqual([
      "total_open:PASS",
      "by_severity:DRIFT",
      "by_target:DRIFT",
      "by_plan:DRIFT",
    ]);
    expect(rollup.overall).toBe("DRIFT");
    // bash oracle agrees: jq -c string compare exits 1 on the same fixture
    expect(bashRollup(SCRAMBLED_FIXTURE).exitCode).toBe(1);
  });

  test("PARITY: TS rollup output is byte-identical to tech-debt-rollup.sh on the multi-plan fixture", () => {
    const bash = bashRollup(ROLLUP_FIXTURE);
    expect(bash.exitCode).toBe(0);
    expect(renderRollupOutput(techDebtRollup(ROLLUP_FIXTURE))).toBe(bash.stdout);
  });

  test("PARITY: DRIFT output is byte-identical to tech-debt-rollup.sh on a drifted fixture", () => {
    const dir = tmpRoot("status-rollup-drift-");
    const drifted = JSON.parse(readFileSync(ROLLUP_FIXTURE, "utf8")) as {
      metadata: { tech_debt_summary: { by_severity: Record<string, number> } };
    };
    drifted.metadata.tech_debt_summary.by_severity.medium = 99;
    const driftPath = join(dir, "status.json");
    writeFileSync(driftPath, JSON.stringify(drifted, null, 2), "utf8");

    const bash = bashRollup(driftPath);
    expect(bash.exitCode).toBe(1);
    const ts = techDebtRollup(driftPath);
    expect(ts.overall).toBe("DRIFT");
    expect(ts.checks.find((c) => c.field === "by_severity")?.status).toBe("DRIFT");
    expect(renderRollupOutput(ts)).toBe(bash.stdout);
    rmSync(dir, { recursive: true, force: true });
  });

  test(
    "PARITY: canonical+legacy merge precedence is byte-identical to tech-debt-rollup.sh on a conflict fixture",
    () => {
      const conflictFixture = join(FIXTURES, "status.rollup-conflict.json");
      const bash = bashRollup(conflictFixture);
      expect(bash.exitCode).toBe(0);
      const ts = techDebtRollup(conflictFixture);
      // jq `$canon + $legacy` keeps the legacy value on conflicting plan keys
      expect(ts.computed.total_open).toBe(3);
      expect(ts.overall).toBe("PASS");
      expect(renderRollupOutput(ts)).toBe(bash.stdout);
    },
  );
});
