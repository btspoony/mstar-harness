/**
 * Engine status module — status.json schema validation, residual severity
 * normalization, residual lifecycle (open → archived), findings-cleanup gate,
 * and the `metadata.tech_debt_summary` rollup.
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
 *   `null`/`""` → `medium` (rollup `norm_sev` semantics).
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
 *   `techDebtRollup` (engine; no CLI form). Golden-fixture parity: outputs
 *   captured from the former bash rollup oracle (byte-proven in slice 2)
 *   are stored under `fixtures/rollup.*.golden.txt`.
 * - `ValidationResult`/`GateResult` shapes + severity machine SSOT:
 *   `packages/engine/src/core.ts` (roadmap §8.5 C2/C4).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  archiveResiduals,
  findingsCleanupGate,
  normalizeSeverity,
  resolveCompassEnforcement,
  resolveMstarcEnforcement,
  resolveRepoEnforcement,
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

// Golden fixtures: outputs captured from the former bash rollup oracle
// (byte-proven in slice 2, scripts removed in slice 5).
const ROLLUP_MULTIPLANS_GOLDEN = join(FIXTURES, "rollup.multiplans.golden.txt");
const ROLLUP_CONFLICT_GOLDEN = join(FIXTURES, "rollup.conflict.golden.txt");
const ROLLUP_DRIFT_GOLDEN = join(FIXTURES, "rollup.drift.golden.txt");
const ROLLUP_ZERO_GOLDEN = join(FIXTURES, "rollup.zero.golden.txt");
const ROLLUP_FALSE_LIFECYCLE_GOLDEN = join(FIXTURES, "rollup.false-lifecycle.golden.txt");

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

/** Rendered rollup output format (matches the former bash script's echo formatting). */
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
      // Mirrors the jq `-c ".$field // null"` comparison: `false` renders as
      // null (jq alternative operator), 0 stays 0 (truthy in jq).
      const storedField = rollup.stored[check.field];
      const storedCompared = storedField === false ? null : (storedField ?? null);
      lines.push(`DRIFT: ${check.field}`);
      lines.push(`  computed: ${computed}`);
      lines.push(`  stored:   ${JSON.stringify(storedCompared)}`);
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

describe("normalizeSeverity (legacy read path)", () => {
  test("legacy 'warning' normalizes to 'low' (status-and-residuals § severity 5)", () => {
    expect(normalizeSeverity("warning")).toBe("low");
  });

  test("null and empty-string normalize to 'medium' (rollup norm_sev)", () => {
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

  test("empty-string id / plan_id are violations (non-empty required)", () => {
    // Spec: qc2 F-010 — id/plan_id must be non-empty strings, same as
    // title/file (validateNonEmptyString).
    violationCodes("status.plan-row.invalid-id")(validatePlanRow(row({ id: "  " })));
    violationCodes("status.plan-row.invalid-plan-id")(validatePlanRow(row({ plan_id: "" })));
    const { id: _drop, ...rest } = row({ plan_id: "" });
    void _drop;
    violationCodes("status.plan-row.invalid-plan-id")(validatePlanRow(rest));
  });

  test("cross-field invariant: status Done must not carry an execution_lease", () => {
    // Spec: qc2 F-010 — the lease protocol says Done-with-lease never exists;
    // the Done authority deletes the lease in the same update as status Done.
    const gate = validatePlanRow(
      row({ status: "Done", execution_lease: { holder: "h", claimed_at: "2026-08-08", worktree_path: "/wt", working_branch: "b" } }),
    );
    expect(gate.ok).toBe(false);
    expect(violationsOf(gate)).toContain("status.plan-row.done-with-lease");
    expect(validatePlanRow(row({ status: "Done" })).ok).toBe(true);
  });
});

describe("validateResidual", () => {
  test("valid open entry passes", () => {
    expect(validateResidual(entry()).violations).toEqual([]);
  });

  test("non-object residual entry is rejected (string / number / null / array)", () => {
    // Locks existing fail-loud behavior (status.ts:266-268) — no silent
    // pass-through for entries that cannot even be inspected.
    for (const value of ["R1", 42, null, ["R1"]]) {
      const result = validateResidual(value);
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toContain("status.residual.invalid");
    }
  });

  test("required field with a non-string type is rejected (id: 42 → invalid-id)", () => {
    violationCodes("status.residual.invalid-id")(validateResidual(entry({ id: 42 })));
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

  test("closed_at format is enforced even when lifecycle is present (qc2 F-009)", () => {
    violationCodes("status.residual.invalid-closed-at")(
      validateResidual(entry({ lifecycle: "resolved", closed_at: "not-a-date", closure_note: "x" })),
    );
    violationCodes("status.residual.invalid-closed-at")(
      validateResidual(entry({ lifecycle: "open", closed_at: "2026/08/07" })),
    );
  });

  test("closed lifecycles require closed_at + closure_note (status-and-residuals.md § lifecycle)", () => {
    // Spec: "On close: set closed_at (YYYY-MM-DD) and closure_note" — every
    // closed lifecycle (resolved/waived/superseded/duplicate) must be complete.
    for (const lifecycle of ["resolved", "waived", "superseded", "duplicate"]) {
      const incomplete = validateResidual(entry({ lifecycle }));
      expect(incomplete.ok).toBe(false);
      expect(violationsOf(incomplete)).toContain("status.residual.closed-missing-closed-at");
      expect(violationsOf(incomplete)).toContain("status.residual.closed-missing-closure-note");
    }
    const closedWithAtOnly = validateResidual(entry({ lifecycle: "resolved", closed_at: "2026-08-07" }));
    expect(violationsOf(closedWithAtOnly)).toContain("status.residual.closed-missing-closure-note");
    expect(violationsOf(closedWithAtOnly)).not.toContain("status.residual.closed-missing-closed-at");
    // An open entry never needs close fields.
    expect(validateResidual(entry({ lifecycle: "open" })).ok).toBe(true);
  });
});

describe("validateStatus", () => {
  test("status.empty.json template validates clean (templates/status.empty.json)", () => {
    const result = validateStatus(EMPTY_TEMPLATE);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("real repo status.json shape validates clean (legacy plan_id rows, mixed metadata, detail_doc null)", () => {
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

  test("non-object residual entry inside residual_findings aggregates into the gate result", () => {
    // Full-path gate: every list entry routes through validateResidual
    // (status.ts:435-437), so a non-object entry is rejected at doc level too.
    const result = validateStatus(doc({ residual_findings: { "plan-a": ["oops"] } }));
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toContain("status.residual.invalid");
  });
});

describe("archiveResiduals", () => {
  test("moves open residuals to archived/residuals/<plan-id>.json and removes them from the open list", async () => {
    const dir = tmpRoot("status-archive-");
    const statusPath = join(dir, "status.json");
    const before = doc({
      updated_at: "2026-08-01",
      residual_findings: {
        "plan-a": [entry({ id: "R1" }), entry({ id: "R2", severity: "nit", decision: "accept" })],
      },
    });
    writeFileSync(statusPath, JSON.stringify(before, null, 2), "utf8");

    const result = await archiveResiduals("plan-a", dir);
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

  test("appends to an existing archive file", async () => {
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

    await archiveResiduals("plan-a", dir);
    const archive = JSON.parse(readFileSync(archivePath, "utf8")) as { entries: unknown[] };
    expect(archive.entries).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no-op when the plan has no open residuals (no archive file created)", async () => {
    const dir = tmpRoot("status-archive-empty-");
    writeFileSync(join(dir, "status.json"), JSON.stringify(doc(), null, 2), "utf8");
    const result = await archiveResiduals("plan-a", dir);
    expect(result.archived).toBe(0);
    expect(existsSync(result.archivePath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws when status.json is missing", async () => {
    const dir = tmpRoot("status-archive-missing-");
    await expect(archiveResiduals("plan-a", dir)).rejects.toThrow(/status file not found/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects plan ids that are not a single safe path component (traversal guard)", async () => {
    const dir = tmpRoot("status-archive-traversal-");
    writeFileSync(join(dir, "status.json"), JSON.stringify(doc(), null, 2), "utf8");
    for (const bad of ["", ".", "..", "../escape", "a/b", "a\\b", "a/../../tmp/pwn", "..%2f"]) {
      await expect(archiveResiduals(bad, dir)).rejects.toThrow(/single safe path component/);
    }
    // Nothing escaped the harness dir: no archived/ tree with traversal names.
    expect(existsSync(join(dir, "archived"))).toBe(false);
    expect(existsSync(join(dir, "..", "escape.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("two concurrent archive runs serialize (no lost update, no duplicate entries)", async () => {
    // Spec: qc2 F-004 / qc3 F-2 — the status.json read-modify-write runs under
    // withStatusWriteLock; two writers serialize and the second is a no-op.
    const dir = tmpRoot("status-archive-race-");
    const statusPath = join(dir, "status.json");
    writeFileSync(
      statusPath,
      JSON.stringify(doc({ residual_findings: { "plan-a": [entry({ id: "R1" }), entry({ id: "R2" })] } }), null, 2),
      "utf8",
    );

    const [a, b] = await Promise.all([archiveResiduals("plan-a", dir), archiveResiduals("plan-a", dir)]);
    expect(a.archived + b.archived).toBe(2);
    const archive = JSON.parse(readFileSync(join(dir, "archived", "residuals", "plan-a.json"), "utf8")) as {
      entries: unknown[];
    };
    expect(archive.entries).toHaveLength(2);
    const after = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
    expect(after.residual_findings).not.toHaveProperty("plan-a");
    expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dedups on append: ids already in the archive file are skipped", async () => {
    const dir = tmpRoot("status-archive-dedup-");
    const statusPath = join(dir, "status.json");
    writeFileSync(
      statusPath,
      JSON.stringify(
        doc({ residual_findings: { "plan-a": [entry({ id: "R1" }), entry({ id: "R2" })] } }),
        null,
        2,
      ),
      "utf8",
    );
    const archiveDir = join(dir, "archived", "residuals");
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, "plan-a.json");
    const existing = { plan_id: "plan-a", schema_version: 1, entries: [entry({ id: "R1", archived_at: "2026-07-01" })] };
    writeFileSync(archivePath, JSON.stringify(existing, null, 2), "utf8");

    const result = await archiveResiduals("plan-a", dir);
    expect(result.archived).toBe(1); // only R2 is new — R1 already archived
    const archive = JSON.parse(readFileSync(archivePath, "utf8")) as { entries: Array<{ id: string }> };
    expect(archive.entries.map((e) => e.id)).toEqual(["R1", "R2"]);
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
  });

  test("GOLDEN: TS rollup output matches the stored bash-oracle fixture on the multi-plan fixture", () => {
    const golden = readFileSync(ROLLUP_MULTIPLANS_GOLDEN, "utf8");
    const ts = renderRollupOutput(techDebtRollup(ROLLUP_FIXTURE));
    expect(ts).toBe(golden);
  });

  test("GOLDEN: DRIFT output matches the stored bash-oracle fixture on a drifted fixture", () => {
    const dir = tmpRoot("status-rollup-drift-");
    const drifted = JSON.parse(readFileSync(ROLLUP_FIXTURE, "utf8")) as {
      metadata: { tech_debt_summary: { by_severity: Record<string, number> } };
    };
    drifted.metadata.tech_debt_summary.by_severity.medium = 99;
    const driftPath = join(dir, "status.json");
    writeFileSync(driftPath, JSON.stringify(drifted, null, 2), "utf8");

    const ts = techDebtRollup(driftPath);
    expect(ts.overall).toBe("DRIFT");
    expect(ts.checks.find((c) => c.field === "by_severity")?.status).toBe("DRIFT");
    expect(renderRollupOutput(ts)).toBe(readFileSync(ROLLUP_DRIFT_GOLDEN, "utf8"));
    rmSync(dir, { recursive: true, force: true });
  });

  test(
    "GOLDEN: canonical+legacy merge precedence matches the stored bash-oracle fixture on a conflict fixture",
    () => {
      const conflictFixture = join(FIXTURES, "status.rollup-conflict.json");
      const ts = techDebtRollup(conflictFixture);
      // jq `$canon + $legacy` keeps the legacy value on conflicting plan keys
      expect(ts.computed.total_open).toBe(3);
      expect(ts.overall).toBe("PASS");
      expect(renderRollupOutput(ts)).toBe(readFileSync(ROLLUP_CONFLICT_GOLDEN, "utf8"));
    },
  );

  test("GOLDEN: stored total_open: 0 (correct empty state) matches the stored bash-oracle fixture (jq `//` keeps 0)", () => {
    // qc2 F-008 — jq's alternative operator maps only `false`/`null` to the
    // default; `0` is truthy in jq, so a stored total_open of 0 must compare
    // equal to the computed 0 (the golden was captured from the bash oracle).
    const dir = tmpRoot("status-rollup-zero-");
    try {
      const zeroSummary = {
        total_open: 0,
        by_severity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        by_target: {},
        by_plan: {},
      };
      const zeroFixture = doc({ metadata: { tech_debt_summary: zeroSummary } });
      const statusPath = join(dir, "status.json");
      writeFileSync(statusPath, JSON.stringify(zeroFixture, null, 2), "utf8");

      const ts = techDebtRollup(statusPath);
      expect(ts.checks.every((c) => c.status === "PASS")).toBe(true);
      expect(ts.overall).toBe("PASS");
      expect(renderRollupOutput(ts)).toBe(readFileSync(ROLLUP_ZERO_GOLDEN, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GOLDEN: entry lifecycle: false counts as OPEN and DRIFTs like the stored bash-oracle fixture (jq `//` defaults false)", () => {
    // qc2 F-008 — `.lifecycle // "open"` yields "open" for `false` (jq maps
    // false AND null to the default), so an entry with `lifecycle: false`
    // contributes to total_open; the stored summary omitting it DRIFTs
    // identically (golden captured from the bash oracle).
    const dir = tmpRoot("status-rollup-false-");
    try {
      const falseLifecycle = doc({
        residual_findings: { "plan-a": [entry({ id: "R1", severity: "low", target: "V1", lifecycle: false })] },
        metadata: {
          tech_debt_summary: {
            total_open: 0,
            by_severity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
            by_target: {},
            by_plan: {},
          },
        },
      });
      const statusPath = join(dir, "status.json");
      writeFileSync(statusPath, JSON.stringify(falseLifecycle, null, 2), "utf8");

      const ts = techDebtRollup(statusPath);
      expect(ts.computed.total_open).toBe(1); // lifecycle: false is open, like jq
      expect(ts.overall).toBe("DRIFT");
      expect(ts.checks.find((c) => c.field === "total_open")?.status).toBe("DRIFT");
      expect(renderRollupOutput(ts)).toBe(readFileSync(ROLLUP_FALSE_LIFECYCLE_GOLDEN, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveCompassEnforcement — repo compass enforcement: hard (Slice 5, roadmap §8.5 D2)", () => {
  // Spec: roadmap §8.5 C4/D2 — hard gates are enabled per Assignment/compass;
  // compass frontmatter `enforcement: hard` hardens the status-write gate in
  // that repo, but ONLY for compasses still steering it (`status: active` or
  // `status: locked`) — a COMPLETED iteration's hard compass must not keep
  // the repo hardened (qc1 F-001 / qc2 F-002); no counting compass / non-hard
  // value → warn-only (flag inert).
  const makeCompass = (harnessDir: string, iterationId: string, frontmatter: string): string => {
    const dir = join(harnessDir, "iterations", iterationId);
    mkdirSync(dir, { recursive: true });
    const compassPath = join(dir, "delivery-compass.md");
    writeFileSync(compassPath, `---\n${frontmatter}---\n\n# Delivery Compass\n`, "utf8");
    return compassPath;
  };

  test("no harness/iterations dir → { hard: false, source: none }", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      expect(resolveCompassEnforcement(join(root, "no-harness"))).toEqual({ hard: false, source: "none" });
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compass frontmatter enforcement: hard → { hard: true, source: compass }", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      makeCompass(harness, "20260808-demo", "iteration_id: 20260808-demo\nstatus: active\nenforcement: hard\n");
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: true, source: "compass" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compass without enforcement → none (warn-only)", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      makeCompass(harness, "20260808-demo", "iteration_id: 20260808-demo\nstatus: active\n");
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compass enforcement: soft → none (flag inert unless hard)", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      makeCompass(harness, "20260808-demo", "iteration_id: 20260808-demo\nstatus: active\nenforcement: soft\n");
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("iterations dir without any delivery-compass.md → none", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(join(harness, "iterations", "20260808-demo"), { recursive: true });
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("multiple iterations — only ACTIVE/LOCKED compasses count: completed hard is ignored, active hard wins", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      // A COMPLETED iteration declaring hard must NOT harden by itself —
      // the active iteration's flag is the only one that counts (qc1 F-001).
      makeCompass(harness, "20260701-a", "iteration_id: 20260701-a\nstatus: completed\nenforcement: hard\n");
      makeCompass(harness, "20260808-b", "iteration_id: 20260808-b\nstatus: active\nenforcement: hard\n");
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: true, source: "compass" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("completed compass with enforcement: hard → none (D2 rollback works across iterations)", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      makeCompass(harness, "20260601-old", "iteration_id: 20260601-old\nstatus: completed\nenforcement: hard\n");
      makeCompass(harness, "20260701-older", "iteration_id: 20260701-older\nstatus: completed\nenforcement: hard\n");
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("active + completed — the ACTIVE compass wins: completed hard + active soft → none", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      makeCompass(harness, "20260601-old", "iteration_id: 20260601-old\nstatus: completed\nenforcement: hard\n");
      makeCompass(harness, "20260808-now", "iteration_id: 20260808-now\nstatus: active\nenforcement: soft\n");
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("locked compass with enforcement: hard → hard (locked still steers the repo)", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      makeCompass(harness, "20260808-locked", "iteration_id: 20260808-locked\nstatus: locked\nenforcement: hard\n");
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: true, source: "compass" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status-less compass with enforcement: hard → none (fail-soft — no status, no hardening)", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      makeCompass(harness, "20260808-demo", "iteration_id: 20260808-demo\nenforcement: hard\n");
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hard declaration in compass body prose is not honored — frontmatter only", () => {
    const root = tmpRoot("mstar-compass-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      const dir = join(harness, "iterations", "20260808-demo");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "delivery-compass.md"),
        "---\niteration_id: 20260808-demo\nstatus: active\n---\n\nenforcement: hard\n",
        "utf8",
      );
      expect(resolveCompassEnforcement(harness)).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveMstarcEnforcement / resolveRepoEnforcement — `.mstarc` [config] enforcement (plan-conventions § `.mstarc` 格式)", () => {
  test("enforcement=hard → { hard: true, source: mstarc } from a repo-root .mstarc", () => {
    const root = tmpRoot("mstar-rc-enf-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nenforcement=hard\n");
      expect(resolveMstarcEnforcement(join(root, ".mstar"))).toEqual({ hard: true, source: "mstarc" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("enforcement=soft → { hard: false, source: mstarc } (local rollback)", () => {
    const root = tmpRoot("mstar-rc-enf-");
    try {
      writeFileSync(join(root, ".mstarc"), "[config]\nenforcement=soft\n");
      expect(resolveMstarcEnforcement(join(root, ".mstar"))).toEqual({ hard: false, source: "mstarc" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no .mstarc / no enforcement key → none", () => {
    const root = tmpRoot("mstar-rc-enf-");
    try {
      expect(resolveMstarcEnforcement(join(root, ".mstar"))).toEqual({ hard: false, source: "none" });
      writeFileSync(join(root, ".mstarc"), "[config]\nplan_dir=plans\n");
      expect(resolveMstarcEnforcement(join(root, ".mstar"))).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a .mstarc above the repo root is never adopted", () => {
    const root = tmpRoot("mstar-rc-enf-");
    try {
      mkdirSync(join(root, "proj"), { recursive: true });
      writeFileSync(join(root, ".mstarc"), "[config]\nenforcement=hard\n");
      expect(resolveMstarcEnforcement(join(root, "proj", ".mstar"))).toEqual({ hard: false, source: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveRepoEnforcement: .mstarc beats a hard compass; compass applies when no .mstarc", () => {
    const root = tmpRoot("mstar-rc-enf-");
    try {
      const harness = join(root, "h");
      mkdirSync(harness, { recursive: true });
      const compassDir = join(harness, "iterations", "20260808-demo");
      mkdirSync(compassDir, { recursive: true });
      writeFileSync(
        join(compassDir, "delivery-compass.md"),
        "---\niteration_id: 20260808-demo\nstatus: active\nenforcement: hard\n---\n",
        "utf8",
      );
      // No .mstarc → the hard compass hardens.
      expect(resolveRepoEnforcement(harness)).toEqual({ hard: true, source: "compass" });
      // .mstarc soft rolls the hard compass back.
      writeFileSync(join(root, ".mstarc"), "[config]\nenforcement=soft\n");
      expect(resolveRepoEnforcement(harness)).toEqual({ hard: false, source: "mstarc" });
      // .mstarc hard hardens without any compass.
      writeFileSync(join(root, ".mstarc"), "[config]\nenforcement=hard\n");
      expect(resolveRepoEnforcement(harness)).toEqual({ hard: true, source: "mstarc" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
