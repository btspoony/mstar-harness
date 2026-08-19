/**
 * Engine status module — status.json schema validation, residual severity
 * normalization, project-register findings-cleanup gate, and the
 * project-register tech-debt rollup.
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
 * - Findings cleanup modes (zero-residual vs allow-residual; blocker-defer
 *   definition; nit/waived rules): § Findings cleanup modes. v3 relocation:
 *   the gate reads the project register (`projects/<id>/residuals.json`,
 *   one entry per plan-id key) instead of the v1 root `residual_findings`;
 *   the plan-metadata `findings_cleanup` mirror is deleted (no dual-track).
 * - Rollup aggregates (total_open / by_severity / by_target / by_plan):
 *   § `metadata.tech_debt_summary` (optional rollup) — canonical compute is
 *   `techDebtRollup` (engine; no CLI form). v3 relocation: the rollup
 *   aggregates project registers under `{PROJECT_DIR}`; the v1 stored-summary
 *   drift check (`metadata.tech_debt_summary`) is deleted — the register is
 *   the source of truth, so `stored` is always null and the retained
 *   `checks`/`overall` fields report DRIFT (export-surface compatibility
 *   until the P2 CLI cutover).
 * - `ValidationResult`/`GateResult` shapes + severity machine SSOT:
 *   `packages/engine/src/core.ts` (roadmap §8.5 C2/C4).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  findingsCleanupGate,
  normalizeSeverity,
  registerWorkflow,
  resolveCompassEnforcement,
  resolveMstarcEnforcement,
  resolveRepoEnforcement,
  techDebtRollup,
  unregisterWorkflow,
  validatePlanRow,
  validateResidual,
  validateStatus,
  validateStatusV2,
} from "../src/status.js";
import { readJson, writeJson } from "../src/core.js";
import type { GateResult, ValidationResult } from "../src/core.js";
import type { FindingsCleanupMode, TechDebtRollup, WorkflowEntry } from "../src/status.js";
import { writeWorkflowSnapshot } from "../src/workflow.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const EMPTY_TEMPLATE = join(FIXTURES, "status.empty.json");
const REAL_SHAPE = join(FIXTURES, "status.real-shape.json");

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

/** Valid v2 status document (plan Task 3 — `{ version: 2, updated_at, workflows[] }`). */
function v2doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    updated_at: "2026-08-19",
    workflows: [],
    ...overrides,
  };
}

/** Valid active workflow entry (`{ id, type, started_at, dir }`, dir harness-relative). */
function wfEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wf-1",
    type: "plan",
    started_at: "2026-08-19T08:00:00Z",
    dir: "workflows/wf-1",
    ...overrides,
  };
}

/** Write a minimal active (running) snapshot at `harnessDir/workflows/<id>/snapshot.json`. */
async function writeRunningSnapshot(harnessDir: string, id: string): Promise<void> {
  await writeWorkflowSnapshot(
    {
      schema_version: 1,
      id,
      type: "plan",
      status: "running",
      started_at: "2026-08-19T08:00:00Z",
      updated_at: "2026-08-19",
      plans: [],
    },
    join(harnessDir, "workflows", id),
  );
}

/** Write a minimal terminal (completed) snapshot at `harnessDir/workflows/<id>/snapshot.json`. */
async function writeTerminalSnapshot(harnessDir: string, id: string): Promise<void> {
  await writeWorkflowSnapshot(
    {
      schema_version: 1,
      id,
      type: "plan",
      status: "completed",
      started_at: "2026-08-19T08:00:00Z",
      ended_at: "2026-08-19T09:00:00Z",
      updated_at: "2026-08-19",
      plans: [],
    },
    join(harnessDir, "workflows", id),
  );
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

describe("validateStatusV2", () => {
  test("v2 empty template validates clean (fixtures/status.empty.json)", () => {
    const result = validateStatusV2(EMPTY_TEMPLATE);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("accepts a parsed object or a file path", () => {
    expect(validateStatusV2(v2doc()).ok).toBe(true);
    expect(validateStatusV2(EMPTY_TEMPLATE).ok).toBe(true);
  });

  test("v2 fixture with active workflow entries validates clean (incl. nested relative dir)", () => {
    const result = validateStatusV2(
      v2doc({
        workflows: [wfEntry(), wfEntry({ id: "iter-1", type: "iteration", dir: "custom/workflows/iter-1" })],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("v1 input (version: 1) errors MIGRATION_REQUIRED carrying the mstar migrate hint", () => {
    const result = validateStatusV2(doc());
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toContain("status.migration-required");
    expect(result.violations.map((v) => v.message + (v.fix ?? "")).join(" ")).toContain("mstar migrate");
  });

  test("v1-shaped input (root plans[]) errors MIGRATION_REQUIRED even with version: 2", () => {
    const result = validateStatusV2(v2doc({ plans: [] }));
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toContain("status.migration-required");
  });

  test("real v1 repo status.json shape errors MIGRATION_REQUIRED with the hint", () => {
    const result = validateStatusV2(REAL_SHAPE);
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toContain("status.migration-required");
    expect(result.violations.map((v) => v.message).join(" ")).toContain("mstar migrate");
  });

  test("missing or non-integer version fails closed as migration-required", () => {
    violationCodes("status.migration-required")(validateStatusV2(v2doc({ version: undefined })));
    violationCodes("status.migration-required")(validateStatusV2(v2doc({ version: "2" })));
    violationCodes("status.migration-required")(validateStatusV2(v2doc({ version: 3 })));
  });

  test("non-object document is a violation, not a throw", () => {
    violationCodes("status.invalid-doc")(validateStatusV2(null));
    violationCodes("status.invalid-doc")(validateStatusV2([]));
  });

  test("required top-level fields: updated_at / workflows", () => {
    violationCodes("status.missing-updated-at")(validateStatusV2(v2doc({ updated_at: undefined })));
    violationCodes("status.missing-workflows")(validateStatusV2(v2doc({ workflows: undefined })));
    violationCodes("status.invalid-workflows")(validateStatusV2(v2doc({ workflows: {} })));
  });

  test("updated_at must be YYYY-MM-DD", () => {
    violationCodes("status.invalid-updated-at")(validateStatusV2(v2doc({ updated_at: "2026-08-08T00:00:00Z" })));
  });

  test("running entry shape violations are red", () => {
    violationCodes("status.workflow.missing-id")(validateStatusV2(v2doc({ workflows: [wfEntry({ id: undefined })] })));
    violationCodes("status.workflow.missing-type")(validateStatusV2(v2doc({ workflows: [wfEntry({ type: undefined })] })));
    violationCodes("status.workflow.invalid-type")(validateStatusV2(v2doc({ workflows: [wfEntry({ type: "sprint" })] })));
    violationCodes("status.workflow.missing-started-at")(validateStatusV2(v2doc({ workflows: [wfEntry({ started_at: undefined })] })));
    violationCodes("status.workflow.missing-dir")(validateStatusV2(v2doc({ workflows: [wfEntry({ dir: undefined })] })));
    violationCodes("status.workflow.invalid-dir")(validateStatusV2(v2doc({ workflows: [wfEntry({ dir: "/abs/path" })] })));
    violationCodes("status.workflow.invalid-dir")(validateStatusV2(v2doc({ workflows: [wfEntry({ dir: "workflows/../escape" })] })));
    violationCodes("status.workflow.invalid-dir")(validateStatusV2(v2doc({ workflows: [wfEntry({ dir: "C:\\abs\\path" })] })));
    violationCodes("status.workflow.duplicate-id")(validateStatusV2(v2doc({ workflows: [wfEntry(), wfEntry()] })));
  });

  test("malformed JSON file yields a violation, not a throw", () => {
    const dir = tmpRoot("status-v2-invalid-json-");
    const file = join(dir, "status.json");
    writeFileSync(file, "{ not json", "utf8");
    const result = validateStatusV2(file);
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toContain("status.invalid-json");
    rmSync(dir, { recursive: true, force: true });
  });

  describe("removal-at-terminal invariant (no listed id resolves to a terminal/missing snapshot)", () => {
    test("path input: listed entry whose snapshot is missing is a violation", () => {
      const dir = tmpRoot("status-v2-snapshot-missing-");
      try {
        const statusPath = join(dir, "status.json");
        writeJson(statusPath, v2doc({ workflows: [wfEntry()] }));
        const result = validateStatusV2(statusPath);
        expect(violationsOf(result)).toContain("status.workflow.snapshot-missing");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("path input: listed entry resolving to a terminal snapshot is a violation", async () => {
      const dir = tmpRoot("status-v2-terminal-");
      try {
        await writeTerminalSnapshot(dir, "wf-1");
        const statusPath = join(dir, "status.json");
        writeJson(statusPath, v2doc({ workflows: [wfEntry()] }));
        const result = validateStatusV2(statusPath);
        expect(violationsOf(result)).toContain("status.workflow.terminal-listed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("path input: listed entry resolving to an active (running) snapshot validates clean", async () => {
      const dir = tmpRoot("status-v2-active-");
      try {
        await writeRunningSnapshot(dir, "wf-1");
        const statusPath = join(dir, "status.json");
        writeJson(statusPath, v2doc({ workflows: [wfEntry()] }));
        const result = validateStatusV2(statusPath);
        expect(result.ok).toBe(true);
        expect(result.violations).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("doc input without harnessDir skips the on-disk invariant check (structure only)", () => {
      const result = validateStatusV2(v2doc({ workflows: [wfEntry()] }));
      expect(result.ok).toBe(true);
    });

    test("explicit harnessDir opts enable the invariant check for doc input", () => {
      const dir = tmpRoot("status-v2-doc-harness-");
      try {
        const result = validateStatusV2(v2doc({ workflows: [wfEntry()] }), { harnessDir: dir });
        expect(violationsOf(result)).toContain("status.workflow.snapshot-missing");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("validateStatus (relocated v2 validator — v1 handling deleted in Task 3, hard cutover)", () => {
  test("the public name is the v2 validator (relocation, not a dual path)", () => {
    expect(validateStatus).toBe(validateStatusV2);
  });

  test("v2 documents validate clean through the relocated name", () => {
    expect(validateStatus(v2doc()).ok).toBe(true);
  });

  test("v1 input fails closed through the relocated name with the migrate hint", () => {
    const result = validateStatus(doc());
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toContain("status.migration-required");
  });
});

describe("registerWorkflow / unregisterWorkflow (root writers under the root-file write lock)", () => {
  const entry: WorkflowEntry = { id: "wf-1", type: "plan", started_at: "2026-08-19T08:00:00Z", dir: "workflows/wf-1" };

  async function harnessWithRunningSnapshot(prefix: string): Promise<string> {
    const dir = tmpRoot(prefix);
    await writeRunningSnapshot(dir, "wf-1");
    return dir;
  }

  test("registerWorkflow creates the v2 root when status.json is missing and appends the entry", async () => {
    const dir = await harnessWithRunningSnapshot("status-register-create-");
    try {
      const statusPath = join(dir, "status.json");
      const doc = await registerWorkflow(statusPath, entry);
      expect(doc.version).toBe(2);
      expect(doc.workflows).toEqual([entry]);
      expect(doc.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const onDisk = readJson(statusPath);
      expect(onDisk.version).toBe(2);
      expect((onDisk.workflows as unknown[]).length).toBe(1);
      expect(validateStatusV2(statusPath).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("registerWorkflow upserts the same id (idempotent, no duplicate entries)", async () => {
    const dir = await harnessWithRunningSnapshot("status-register-upsert-");
    try {
      const statusPath = join(dir, "status.json");
      await registerWorkflow(statusPath, entry);
      await registerWorkflow(statusPath, { ...entry, started_at: "2026-08-19T10:00:00Z" });
      const onDisk = readJson(statusPath);
      expect((onDisk.workflows as unknown[]).length).toBe(1);
      expect((onDisk.workflows as Array<Record<string, unknown>>)[0]).toMatchObject({ started_at: "2026-08-19T10:00:00Z" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("registerWorkflow refuses an entry whose snapshot is missing (invariant at write time, nothing written)", async () => {
    const dir = tmpRoot("status-register-no-snapshot-");
    try {
      const statusPath = join(dir, "status.json");
      await expect(registerWorkflow(statusPath, entry)).rejects.toThrow(/snapshot/);
      expect(existsSync(statusPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("registerWorkflow refuses to modify a v1 root (migration hint, root untouched)", async () => {
    const dir = tmpRoot("status-register-v1-");
    try {
      const statusPath = join(dir, "status.json");
      const v1 = '{\n  "version": 1,\n  "updated_at": "2026-08-08",\n  "plans": [],\n  "residual_findings": {},\n  "metadata": {}\n}\n';
      writeFileSync(statusPath, v1);
      await expect(registerWorkflow(statusPath, entry)).rejects.toThrow(/mstar migrate/);
      expect(readFileSync(statusPath, "utf8")).toBe(v1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("registerWorkflow refuses an invalid entry", async () => {
    const dir = await harnessWithRunningSnapshot("status-register-invalid-entry-");
    try {
      const statusPath = join(dir, "status.json");
      await expect(registerWorkflow(statusPath, { ...entry, type: "sprint" })).rejects.toThrow(/invalid workflow entry/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unregisterWorkflow removes the entry and bumps updated_at", async () => {
    const dir = await harnessWithRunningSnapshot("status-unregister-");
    try {
      const statusPath = join(dir, "status.json");
      await registerWorkflow(statusPath, entry);
      const after = await unregisterWorkflow(statusPath, "wf-1");
      expect(after.workflows).toEqual([]);
      const onDisk = readJson(statusPath);
      expect((onDisk.workflows as unknown[]).length).toBe(0);
      expect(validateStatusV2(statusPath).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unregisterWorkflow is idempotent: removing an absent id is a no-op with no write", async () => {
    const dir = await harnessWithRunningSnapshot("status-unregister-idem-");
    try {
      const statusPath = join(dir, "status.json");
      await registerWorkflow(statusPath, entry);
      const before = readFileSync(statusPath, "utf8");
      const after = await unregisterWorkflow(statusPath, "no-such-id");
      expect((after.workflows as unknown[]).length).toBe(1);
      expect(readFileSync(statusPath, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unregisterWorkflow on a missing root is a no-op that never creates the file", async () => {
    const dir = tmpRoot("status-unregister-missing-");
    try {
      const statusPath = join(dir, "status.json");
      const after = await unregisterWorkflow(statusPath, "wf-1");
      expect(after.workflows).toEqual([]);
      expect(existsSync(statusPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findingsCleanupGate — project register input (v3 relocation)", () => {
  function register(entries: Record<string, unknown>): Record<string, unknown> {
    return { entries };
  }

  function gated(
    residual: Record<string, unknown> | undefined,
    opts?: { mode?: FindingsCleanupMode },
  ): GateResult {
    const reg = register(residual === undefined ? {} : { "plan-a": residual });
    return findingsCleanupGate(reg as Parameters<typeof findingsCleanupGate>[0], "plan-a", opts);
  }

  test("allow-residual (default): open low/medium residuals are fine", () => {
    const result = gated(entry({ decision: "accept" }));
    expect(result.ok).toBe(true);
  });

  test("allow-residual: unresolved critical blocks Approve with residuals", () => {
    violationCodes("findings.allow-residual-critical")(gated(entry({ severity: "critical" })));
  });

  test("zero-residual: true blocker-defer (decision defer + target) passes", () => {
    const result = gated(entry({ decision: "defer", target: "next iteration" }), { mode: "zero-residual" });
    expect(result.ok).toBe(true);
  });

  test("zero-residual: fixable open findings (accept) are blocked", () => {
    violationCodes("findings.zero-residual-open-fixable")(gated(entry({ decision: "accept" }), { mode: "zero-residual" }));
  });

  test("zero-residual: risk-accepted must be closed/archived, not left open", () => {
    violationCodes("findings.zero-residual-risk-accepted")(
      gated(entry({ decision: "risk-accepted" }), { mode: "zero-residual" }),
    );
  });

  test("zero-residual: defer without a target is not a true blocker-defer", () => {
    violationCodes("findings.zero-residual-defer-no-target")(
      gated(entry({ decision: "defer", target: null }), { mode: "zero-residual" }),
    );
  });

  test("zero-residual: style-only nits never stay open", () => {
    violationCodes("findings.zero-residual-nit")(gated(entry({ severity: "nit" }), { mode: "zero-residual" }));
  });

  test("zero-residual: closed entries are ignored", () => {
    const result = gated(
      entry({ lifecycle: "resolved", closed_at: "2026-08-07", closure_note: "fixed" }),
      { mode: "zero-residual" },
    );
    expect(result.ok).toBe(true);
  });

  test("no register entry for the plan → no residuals, gate passes (snapshot plan linkage via plan-id key)", () => {
    const result = gated(undefined, { mode: "zero-residual" });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("explicit mode is the only mode source (plan-metadata findings_cleanup mirror deleted)", () => {
    const result = gated(entry({ decision: "accept" }), { mode: "zero-residual" });
    expect(violationsOf(result)).toContain("findings.zero-residual-open-fixable");
    const allow = gated(entry({ decision: "accept" }), { mode: "allow-residual" });
    expect(allow.ok).toBe(true);
  });
});

describe("techDebtRollup — project register aggregation (v3 relocation)", () => {
  /** Write `projects/<id>/residuals.json` with one entry per plan-id key. */
  function writeRegister(projectDir: string, projectId: string, entries: Record<string, unknown>): void {
    const dir = join(projectDir, projectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "residuals.json"), JSON.stringify({ entries }, null, 2), "utf8");
  }

  test("computed aggregates match jq semantics (warning→low, null/''→medium, closed excluded, unspecified target)", () => {
    const dir = tmpRoot("status-rollup-register-");
    try {
      writeRegister(dir, "_default", {
        "plan-a": entry({ id: "R1", severity: "warning", target: "V1.0" }),
        "plan-b": entry({ id: "R2", severity: null, target: "V1.1" }),
        "plan-c": entry({ id: "R3", severity: "", target: "V1.0" }),
        "plan-d": entry({ id: "R4", severity: "low", target: null }),
        "plan-e": entry({ id: "R5", severity: "medium", lifecycle: "resolved", closed_at: "2026-08-07", closure_note: "x" }),
      });
      const rollup = techDebtRollup(dir);
      expect(rollup.computed).toEqual({
        total_open: 4,
        by_severity: { critical: 0, high: 0, medium: 2, low: 2, nit: 0 },
        by_target: { "V1.0": 2, "V1.1": 1, unspecified: 1 },
        by_plan: { "plan-a": 1, "plan-b": 1, "plan-c": 1, "plan-d": 1 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aggregates across multiple project registers (by_plan keyed by plan id)", () => {
    const dir = tmpRoot("status-rollup-multiproj-");
    try {
      writeRegister(dir, "_default", { "plan-a": entry({ id: "R1", severity: "low" }) });
      writeRegister(dir, "acme", { "plan-b": entry({ id: "R2", severity: "high" }) });
      const rollup = techDebtRollup(dir);
      expect(rollup.computed.total_open).toBe(2);
      expect(rollup.computed.by_plan).toEqual({ "plan-a": 1, "plan-b": 1 });
      expect(rollup.computed.by_severity).toEqual({ critical: 0, high: 1, medium: 0, low: 1, nit: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no registers / missing project dir → empty rollup", () => {
    const dir = tmpRoot("status-rollup-empty-");
    try {
      const rollup = techDebtRollup(join(dir, "does-not-exist"));
      expect(rollup.computed).toEqual({
        total_open: 0,
        by_severity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        by_target: {},
        by_plan: {},
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v1 stored-summary drift check deleted: stored is always null, checks all DRIFT, overall DRIFT", () => {
    // The v1 `metadata.tech_debt_summary` cache is a v1 dead path — the
    // project register is the source of truth. The retained
    // stored/checks/overall fields keep the exported TechDebtRollup shape
    // (compile-compat for the P2 CLI cutover) and always report DRIFT.
    const dir = tmpRoot("status-rollup-drift-");
    try {
      writeRegister(dir, "_default", { "plan-a": entry() });
      const rollup = techDebtRollup(dir);
      expect(rollup.stored).toBeNull();
      expect(rollup.checks.map((c) => c.status)).toEqual(["DRIFT", "DRIFT", "DRIFT", "DRIFT"]);
      expect(rollup.overall).toBe("DRIFT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("entry lifecycle: false counts as OPEN (jq `//` defaults false)", () => {
    const dir = tmpRoot("status-rollup-false-");
    try {
      writeRegister(dir, "_default", { "plan-a": entry({ id: "R1", severity: "low", target: "V1", lifecycle: false }) });
      const rollup = techDebtRollup(dir);
      expect(rollup.computed.total_open).toBe(1);
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
