/**
 * Engine iteration module — compass frontmatter schema, phase-transition
 * gate evaluation, push-cadence probe, iteration index obligations.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - Compass template + frontmatter fields (iteration_id / start_date /
 *   status / iteration_base_branch / target_branch / plans; `end_date` only
 *   at close): `skills/mstar-iteration/SKILL.md` §1.3 +
 *   `skills/mstar-iteration/references/iteration-compass-template.md`
 *   (Fields guide: `end_date` — No — Phase 3 §3.4 only; `status` values
 *   `active` | `locked` | `completed`).
 * - Phase transition gates (all compass-registered plans `Done` → Phase 3
 *   required; §3.5 exit checklist all `[x]` + frontmatter `completed` +
 *   `end_date` → Phase 4): `skills/mstar-iteration/SKILL.md` Phase
 *   transition gates table.
 * - §3.1 close entry checklist (checkable subset: plans all Done, no open
 *   residual_findings for the iteration's plans, compass frontmatter
 *   complete): `skills/mstar-iteration/references/phase-3-iteration-close.md`
 *   §3.1.
 * - §3.5 close exit checklist (checkable subset: frontmatter `status:
 *   completed` + `end_date` present, current branch is
 *   `spec_integration_branch`, PR base = `target_branch`):
 *   `skills/mstar-iteration/references/phase-3-iteration-close.md` §3.5.
 * - Push cadence probe (never push while CI is queued/in_progress or an AI
 *   review wave is running): `skills/mstar-iteration/SKILL.md` §5.1a +
 *   `skills/mstar-iteration/references/phase-4-5-pr-delivery.md` §5.1a
 *   (push gate 1 + 2).
 * - Index obligations (one row per iteration in `{ITERATION_DIR}/README.md`,
 *   table header on first creation): `skills/mstar-iteration/SKILL.md`
 *   §1.4.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertIndexRowObligations,
  evaluatePhaseGate,
  parseCompassFrontmatter,
  pushCadenceProbe,
  validateCompassFrontmatter,
  type CompassDoc,
} from "../src/iteration.js";
import { isOpenResidual, type StatusDoc } from "../src/status.js";
import { readJson } from "../src/core.js";

const REAL_STATUS_PATH = join(import.meta.dir, "fixtures", "status.real-shape.json");

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeReadme(dir: string, rows: string[]): void {
  const lines = ["# Iterations Index", "", "| Iteration | Path | Description | Status |", "|-----------|------|-------------|--------|", ...rows, ""];
  writeFileSync(join(dir, "README.md"), lines.join("\n"), "utf8");
}

function compass(overrides: Record<string, unknown> = {}): CompassDoc {
  return {
    iteration_id: "v9.9.9",
    start_date: "2026-08-08",
    status: "locked",
    iteration_base_branch: "main",
    target_branch: "main",
    plans: ["plan-a", "plan-b"],
    ...overrides,
  };
}

function statusDoc(planStates: Record<string, string>): StatusDoc {
  return {
    version: 1,
    updated_at: "2026-08-08",
    plans: Object.entries(planStates).map(([plan_id, status]) => ({ plan_id, status })),
  };
}

function withResiduals(base: StatusDoc, residuals: Record<string, unknown[]>): StatusDoc {
  return { ...base, residual_findings: residuals };
}

describe("validateCompassFrontmatter — compass schema (mstar-iteration §1.3 + iteration-compass-template.md Fields guide)", () => {
  test("valid minimal active compass passes (no plans, no end_date)", () => {
    const result = validateCompassFrontmatter({
      iteration_id: "v1.0",
      start_date: "2026-08-08",
      status: "active",
      iteration_base_branch: "main",
      target_branch: "main",
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("real v2.0.0 delivery-compass.md frontmatter shape (fixture) passes", () => {
    const fixture = readJson(join(import.meta.dir, "fixtures", "compass.real-frontmatter.json"));
    const result = validateCompassFrontmatter(fixture);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("missing or empty iteration_id fails", () => {
    const missing = validateCompassFrontmatter(compass({ iteration_id: undefined }));
    expect(missing.ok).toBe(false);
    expect(missing.violations.some((v) => v.message.includes("iteration_id"))).toBe(true);
    const empty = validateCompassFrontmatter(compass({ iteration_id: "" }));
    expect(empty.ok).toBe(false);
    expect(empty.violations.some((v) => v.message.includes("iteration_id"))).toBe(true);
  });

  test("start_date must be YYYY-MM-DD", () => {
    for (const bad of ["2026-08-8", "2026/08/08", "not-a-date", ""]) {
      const result = validateCompassFrontmatter(compass({ start_date: bad }));
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.message.includes("start_date"))).toBe(true);
    }
    expect(validateCompassFrontmatter(compass({ start_date: undefined })).ok).toBe(false);
  });

  test("status must be one of active | locked | completed", () => {
    for (const bad of ["in-progress", "Done", "active "]) {
      const result = validateCompassFrontmatter(compass({ status: bad }));
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.message.includes("status"))).toBe(true);
    }
    for (const good of ["active", "locked"]) {
      expect(validateCompassFrontmatter(compass({ status: good })).ok).toBe(true);
    }
    // `completed` is a legal status value; it also needs end_date (Phase 3 §3.4)
    expect(validateCompassFrontmatter(compass({ status: "completed", end_date: "2026-08-10" })).ok).toBe(true);
  });

  test("iteration_base_branch and target_branch are required non-empty", () => {
    const base = validateCompassFrontmatter(compass({ iteration_base_branch: "" }));
    expect(base.ok).toBe(false);
    expect(base.violations.some((v) => v.message.includes("iteration_base_branch"))).toBe(true);
    const target = validateCompassFrontmatter(compass({ target_branch: undefined }));
    expect(target.ok).toBe(false);
    expect(target.violations.some((v) => v.message.includes("target_branch"))).toBe(true);
  });

  test("plans is an optional array of non-empty strings", () => {
    expect(validateCompassFrontmatter(compass({ plans: undefined })).ok).toBe(true);
    expect(validateCompassFrontmatter(compass({ plans: [] })).ok).toBe(true);
    const notArray = validateCompassFrontmatter(compass({ plans: "plan-a" }));
    expect(notArray.ok).toBe(false);
    expect(notArray.violations.some((v) => v.message.includes("plans"))).toBe(true);
    const numericEntry = validateCompassFrontmatter(compass({ plans: ["plan-a", 42] }));
    expect(numericEntry.ok).toBe(false);
    expect(numericEntry.violations.some((v) => v.message.includes("plans"))).toBe(true);
    const emptyEntry = validateCompassFrontmatter(compass({ plans: ["plan-a", ""] }));
    expect(emptyEntry.ok).toBe(false);
    expect(emptyEntry.violations.some((v) => v.message.includes("plans"))).toBe(true);
  });

  test("end_date REQUIRED when status is completed (template Fields guide: Phase 3 §3.4 only)", () => {
    const missing = validateCompassFrontmatter(compass({ status: "completed" }));
    expect(missing.ok).toBe(false);
    expect(missing.violations.some((v) => v.code === "COMPASS_END_DATE_REQUIRED")).toBe(true);
    const present = validateCompassFrontmatter(compass({ status: "completed", end_date: "2026-08-10" }));
    expect(present.ok).toBe(true);
    const malformed = validateCompassFrontmatter(compass({ status: "completed", end_date: "2026/08/10" }));
    expect(malformed.ok).toBe(false);
    expect(malformed.violations.some((v) => v.message.includes("end_date"))).toBe(true);
  });

  test("end_date forbidden while status is active or locked (only written at iteration-close)", () => {
    for (const status of ["active", "locked"]) {
      const result = validateCompassFrontmatter(compass({ status, end_date: "2026-08-10" }));
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.code === "COMPASS_END_DATE_NOT_ALLOWED")).toBe(true);
    }
  });

  test("non-object documents fail; extra unknown fields are ignored", () => {
    for (const bad of [null, "v2.0.0", [1, 2]]) {
      const result = validateCompassFrontmatter(bad);
      expect(result.ok).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    }
    const extra = validateCompassFrontmatter(compass({ enforcement: "hard", custom_field: 1 }));
    expect(extra.ok).toBe(true);
  });
});

describe("evaluatePhaseGate — phase transitions (mstar-iteration Phase transition gates table)", () => {
  test("all compass plans Todo → phase-2-execute, gate passes (continue executing)", () => {
    const result = evaluatePhaseGate(statusDoc({ "plan-a": "Todo", "plan-b": "Todo" }), compass());
    expect(result.allPlansDone).toBe(false);
    expect(result.transition).toBe("phase-2-execute");
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("mixed Done/Todo → phase-2-execute", () => {
    const result = evaluatePhaseGate(statusDoc({ "plan-a": "Done", "plan-b": "InProgress" }), compass());
    expect(result.allPlansDone).toBe(false);
    expect(result.transition).toBe("phase-2-execute");
    expect(result.ok).toBe(true);
  });

  test("compass-registered plan missing from status.json plans[] is not Done (entry §3.1 item 1)", () => {
    const result = evaluatePhaseGate(statusDoc({ "plan-a": "Done" }), compass());
    expect(result.allPlansDone).toBe(false);
    expect(result.transition).toBe("phase-2-execute");
    expect(result.entry.violations.some((v) => v.code === "PLAN_NOT_IN_STATUS" && v.message.includes("plan-b"))).toBe(true);
  });

  test("id-only plan rows (no plan_id) are found — status-and-residuals.md § Compatibility read accepts id or plan_id", () => {
    const doc: StatusDoc = {
      version: 1,
      updated_at: "2026-08-08",
      plans: [
        { id: "plan-a", status: "Done" },
        { id: "plan-b", status: "Done" },
      ],
    };
    const result = evaluatePhaseGate(doc, compass());
    expect(result.allPlansDone).toBe(true);
    expect(result.entry.violations.some((v) => v.code === "PLAN_NOT_IN_STATUS")).toBe(false);
    expect(result.entry.violations.some((v) => v.code === "PLAN_NOT_DONE")).toBe(false);
    expect(result.transition).toBe("phase-3-close");
  });

  test("all plans Done + clean residuals + complete frontmatter → phase-3-close required, entry gate clean", () => {
    const result = evaluatePhaseGate(statusDoc({ "plan-a": "Done", "plan-b": "Done" }), compass());
    expect(result.allPlansDone).toBe(true);
    expect(result.transition).toBe("phase-3-close");
    expect(result.entry.ok).toBe(true);
    // exit still missing: frontmatter not completed yet
    expect(result.exit.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("all plans Done but open residuals for an iteration plan → entry violation (entry §3.1 item 2)", () => {
    const doc = withResiduals(statusDoc({ "plan-a": "Done", "plan-b": "Done" }), {
      "plan-a": [
        { id: "R1", title: "leak", severity: "high", lifecycle: "open" },
        { id: "R2", title: "lint", severity: "low" },
      ],
    });
    const result = evaluatePhaseGate(doc, compass());
    expect(result.allPlansDone).toBe(true);
    const violation = result.entry.violations.find((v) => v.code === "OPEN_RESIDUALS");
    expect(violation).toBeDefined();
    expect(violation!.message).toContain("plan-a");
    expect(violation!.message).toContain("R1");
    expect(violation!.message).toContain("R2");
  });

  test("resolved/waived residuals do not block entry", () => {
    const doc = withResiduals(statusDoc({ "plan-a": "Done", "plan-b": "Done" }), {
      "plan-a": [
        { id: "R1", title: "done", severity: "high", lifecycle: "resolved" },
        { id: "R2", title: "waived", severity: "medium", lifecycle: "waived" },
      ],
    });
    const result = evaluatePhaseGate(doc, compass());
    expect(result.entry.ok).toBe(true);
  });

  test("lifecycle null/false count as open — jq `//` parity with status.ts isOpenResidual (entry §3.1 item 2)", () => {
    // status.ts isOpenResidual mirrors `.lifecycle // "open"`: undefined,
    // null AND false all default to "open" (jq `//` treats false as falsy).
    for (const lifecycle of [undefined, null, false, "open"]) {
      expect(isOpenResidual({ lifecycle })).toBe(true);
    }
    for (const lifecycle of ["resolved", "waived", "superseded", "duplicate", "closed"]) {
      expect(isOpenResidual({ lifecycle })).toBe(false);
    }
    const doc = withResiduals(statusDoc({ "plan-a": "Done", "plan-b": "Done" }), {
      "plan-a": [
        { id: "R-null", title: "null lifecycle", severity: "low", lifecycle: null },
        { id: "R-false", title: "false lifecycle", severity: "low", lifecycle: false },
      ],
    });
    const result = evaluatePhaseGate(doc, compass());
    expect(result.entry.ok).toBe(false);
    const violation = result.entry.violations.find((v) => v.code === "OPEN_RESIDUALS");
    expect(violation).toBeDefined();
    expect(violation!.message).toContain("R-null");
    expect(violation!.message).toContain("R-false");
  });

  test("zero-residual blocker-defers (decision: defer + non-empty target) are allowed at entry", () => {
    const doc = withResiduals(statusDoc({ "plan-a": "Done", "plan-b": "Done" }), {
      "plan-a": [
        { id: "R1", title: "external dependency", severity: "medium", decision: "defer", target: "v2.1.0", lifecycle: "open" },
        { id: "R2", title: "roadmap slice", severity: "low", decision: "defer", target: "Next iteration" },
      ],
    });
    const result = evaluatePhaseGate(doc, compass());
    expect(result.entry.ok).toBe(true);
    expect(result.entry.violations.some((v) => v.code === "OPEN_RESIDUALS")).toBe(false);
  });

  test("defer without roadmap target / risk-accepted / fixable opens still block entry (zero-residual rules)", () => {
    const doc = withResiduals(statusDoc({ "plan-a": "Done", "plan-b": "Done" }), {
      "plan-a": [
        { id: "R1", title: "defer without target", severity: "medium", decision: "defer" },
        { id: "R2", title: "risk accepted", severity: "medium", decision: "risk-accepted" },
        { id: "R3", title: "fixable open", severity: "high" },
      ],
    });
    const result = evaluatePhaseGate(doc, compass());
    expect(result.entry.ok).toBe(false);
    const violation = result.entry.violations.find((v) => v.code === "OPEN_RESIDUALS");
    expect(violation).toBeDefined();
    expect(violation!.message).toContain("R1");
    expect(violation!.message).toContain("R2");
    expect(violation!.message).toContain("R3");
  });

  test("incomplete compass frontmatter fails entry (entry §3.1 item 5 checkable subset)", () => {
    const result = evaluatePhaseGate(
      statusDoc({ "plan-a": "Done", "plan-b": "Done" }),
      compass({ target_branch: "" }),
    );
    expect(result.entry.ok).toBe(false);
    expect(result.entry.violations.some((v) => v.message.includes("target_branch"))).toBe(true);
  });

  test("compass frontmatter with no plans cannot verify the transition (COMPASS_NO_PLANS)", () => {
    const result = evaluatePhaseGate(statusDoc({}), compass({ plans: [] }));
    expect(result.allPlansDone).toBe(false);
    expect(result.transition).toBe("phase-2-execute");
    expect(result.entry.violations.some((v) => v.code === "COMPASS_NO_PLANS")).toBe(true);
  });

  test("exit checklist: frontmatter must be completed + end_date (exit §3.5 item 4)", () => {
    const result = evaluatePhaseGate(
      statusDoc({ "plan-a": "Done", "plan-b": "Done" }),
      compass({ status: "active" }),
    );
    expect(result.exit.violations.some((v) => v.code === "EXIT_STATUS_NOT_COMPLETED")).toBe(true);
    expect(result.exit.violations.some((v) => v.code === "EXIT_END_DATE_REQUIRED")).toBe(true);
  });

  test("exit checklist: current branch must be spec_integration_branch (exit §3.5 item 5)", () => {
    const result = evaluatePhaseGate(
      statusDoc({ "plan-a": "Done", "plan-b": "Done" }),
      compass({ status: "completed", end_date: "2026-08-10" }),
      { currentBranch: "feature/oops", specIntegrationBranch: "iteration/v9.9.9" },
    );
    expect(result.exit.violations.some((v) => v.code === "EXIT_BRANCH_MISMATCH")).toBe(true);
    const okBranch = evaluatePhaseGate(
      statusDoc({ "plan-a": "Done", "plan-b": "Done" }),
      compass({ status: "completed", end_date: "2026-08-10" }),
      { currentBranch: "iteration/v9.9.9", specIntegrationBranch: "iteration/v9.9.9" },
    );
    expect(okBranch.exit.violations.some((v) => v.code === "EXIT_BRANCH_MISMATCH")).toBe(false);
  });

  test("exit checklist: PR base must equal compass target_branch, not an undocumented main (exit §3.5 item 6)", () => {
    const result = evaluatePhaseGate(
      statusDoc({ "plan-a": "Done", "plan-b": "Done" }),
      compass({ status: "completed", end_date: "2026-08-10", target_branch: "main" }),
      { prBaseBranch: "develop" },
    );
    expect(result.exit.violations.some((v) => v.code === "EXIT_PR_BASE_MISMATCH")).toBe(true);
    // documented main target: PR base main == target_branch main passes
    const okBase = evaluatePhaseGate(
      statusDoc({ "plan-a": "Done", "plan-b": "Done" }),
      compass({ status: "completed", end_date: "2026-08-10", target_branch: "main" }),
      { prBaseBranch: "main" },
    );
    expect(okBase.exit.violations.some((v) => v.code === "EXIT_PR_BASE_MISMATCH")).toBe(false);
  });

  test("missing git probe inputs make the exit branch/PR-base checks unverifiable", () => {
    const result = evaluatePhaseGate(
      statusDoc({ "plan-a": "Done", "plan-b": "Done" }),
      compass({ status: "completed", end_date: "2026-08-10" }),
    );
    expect(result.exit.violations.some((v) => v.code === "EXIT_BRANCH_UNVERIFIABLE")).toBe(true);
    expect(result.exit.violations.some((v) => v.code === "EXIT_PR_BASE_UNVERIFIABLE")).toBe(true);
  });

  test("entry + exit checkable subsets all green → phase-4-pr-delivery (transition table → Phase 4)", () => {
    const result = evaluatePhaseGate(
      statusDoc({ "plan-a": "Done", "plan-b": "Done" }),
      compass({ status: "completed", end_date: "2026-08-10" }),
      {
        currentBranch: "iteration/v9.9.9",
        specIntegrationBranch: "iteration/v9.9.9",
        prBaseBranch: "main",
      },
    );
    expect(result.transition).toBe("phase-4-pr-delivery");
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.entry.ok).toBe(true);
    expect(result.exit.ok).toBe(true);
  });

  test("compass frontmatter + status shape fixtures → phase-2-execute (registered slice plans not Done)", () => {
    const compassFixture = readJson(join(import.meta.dir, "fixtures", "compass.real-frontmatter.json"));
    const statusFixture = readJson(REAL_STATUS_PATH);
    const result = evaluatePhaseGate(statusFixture as StatusDoc, compassFixture as CompassDoc);
    expect(result.allPlansDone).toBe(false);
    expect(result.transition).toBe("phase-2-execute");
    const missing = result.entry.violations.filter((v) => v.code === "PLAN_NOT_IN_STATUS");
    expect(missing.length).toBe(4);
    expect(missing.every((v) => v.message.includes("20260808-slice"))).toBe(true);
    // slice1 IS in the real status shape, but still InProgress → not Done
    const notDone = result.entry.violations.find((v) => v.code === "PLAN_NOT_DONE");
    expect(notDone).toBeDefined();
    expect(notDone!.message).toContain("20260808-slice1-engine-foundation");
  });
});

describe("pushCadenceProbe — §5.1a push gate (never push while CI or AI review wave is running)", () => {
  test("CI idle and no review wave → push allowed", () => {
    const result = pushCadenceProbe(false, false);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("CI still queued/in_progress → push blocked", () => {
    const result = pushCadenceProbe(true, false);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "PUSH_BLOCKED_CI")).toBe(true);
    expect(result.violations.some((v) => v.code === "PUSH_BLOCKED_REVIEW_WAVE")).toBe(false);
  });

  test("AI review wave active → push blocked", () => {
    const result = pushCadenceProbe(false, true);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "PUSH_BLOCKED_REVIEW_WAVE")).toBe(true);
    expect(result.violations.some((v) => v.code === "PUSH_BLOCKED_CI")).toBe(false);
  });

  test("both CI and review wave running → blocked with both violations", () => {
    const result = pushCadenceProbe(true, true);
    expect(result.ok).toBe(false);
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain("PUSH_BLOCKED_CI");
    expect(codes).toContain("PUSH_BLOCKED_REVIEW_WAVE");
  });
});

describe("assertIndexRowObligations — one row per iteration (mstar-iteration §1.4)", () => {
  test("README with header and rows for every iteration dir → pass", () => {
    const dir = tmpRoot("mstar-index-");
    try {
      mkdirSync(join(dir, "v1.0.0"), { recursive: true });
      writeFileSync(join(dir, "v1.0.0", "delivery-compass.md"), "---\niteration_id: v1.0.0\n---\n", "utf8");
      mkdirSync(join(dir, "v2.0.0"), { recursive: true });
      writeFileSync(join(dir, "v2.0.0", "delivery-compass.md"), "---\niteration_id: v2.0.0\n---\n", "utf8");
      writeReadme(dir, [
        "| `v1.0.0` | [`v1.0.0/`](v1.0.0/) | First | `completed` |",
        "| `v2.0.0` | [`v2.0.0/`](v2.0.0/) | Second | `active` |",
      ]);
      const result = assertIndexRowObligations(dir);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("README.md missing entirely → INDEX_README_MISSING", () => {
    const dir = tmpRoot("mstar-index-");
    try {
      mkdirSync(join(dir, "v1.0.0"), { recursive: true });
      writeFileSync(join(dir, "v1.0.0", "delivery-compass.md"), "---\n", "utf8");
      const result = assertIndexRowObligations(dir);
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.code === "INDEX_README_MISSING")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("iteration dir without an index row → INDEX_ROW_MISSING", () => {
    const dir = tmpRoot("mstar-index-");
    try {
      mkdirSync(join(dir, "v1.0.0"), { recursive: true });
      writeFileSync(join(dir, "v1.0.0", "delivery-compass.md"), "---\n", "utf8");
      writeReadme(dir, []);
      const result = assertIndexRowObligations(dir);
      expect(result.ok).toBe(false);
      const violation = result.violations.find((v) => v.code === "INDEX_ROW_MISSING");
      expect(violation).toBeDefined();
      expect(violation!.message).toContain("v1.0.0");
      expect(result.violations.some((v) => v.code === "INDEX_HEADER_MISSING")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("README without the table header → INDEX_HEADER_MISSING", () => {
    const dir = tmpRoot("mstar-index-");
    try {
      mkdirSync(join(dir, "v1.0.0"), { recursive: true });
      writeFileSync(join(dir, "v1.0.0", "delivery-compass.md"), "---\n", "utf8");
      writeFileSync(join(dir, "README.md"), "# Iterations Index\n", "utf8");
      const result = assertIndexRowObligations(dir);
      expect(result.violations.some((v) => v.code === "INDEX_HEADER_MISSING")).toBe(true);
      expect(result.violations.some((v) => v.code === "INDEX_ROW_MISSING")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("subdirs without delivery-compass.md are not counted as iterations", () => {
    const dir = tmpRoot("mstar-index-");
    try {
      mkdirSync(join(dir, "guides"), { recursive: true });
      mkdirSync(join(dir, "v1.0.0"), { recursive: true });
      writeFileSync(join(dir, "v1.0.0", "delivery-compass.md"), "---\n", "utf8");
      writeReadme(dir, ["| `v1.0.0` | [`v1.0.0/`](v1.0.0/) | First | `active` |"]);
      const result = assertIndexRowObligations(dir);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("iterations dir itself missing → INDEX_ITERATIONS_DIR_MISSING", () => {
    const result = assertIndexRowObligations(join(tmpRoot("mstar-index-"), "does-not-exist"));
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "INDEX_ITERATIONS_DIR_MISSING")).toBe(true);
  });
});

describe("parseCompassFrontmatter — flat YAML frontmatter parser (shared CLI + omp tool)", () => {
  test("real delivery-compass.md frontmatter round-trips to a flat doc (scalar keys + plans block list)", () => {
    const dir = tmpRoot("mstar-compass-");
    try {
      const file = join(dir, "delivery-compass.md");
      writeFileSync(
        file,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans:
  - plan-a
  - plan-b
---

# v9.9.9 Delivery Compass
`,
        "utf8",
      );
      expect(parseCompassFrontmatter(file)).toEqual({
        iteration_id: "v9.9.9",
        start_date: "2026-08-01",
        status: "active",
        iteration_base_branch: "main",
        target_branch: "main",
        plans: ["plan-a", "plan-b"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flow-style plans array and quoted values round-trip", () => {
    const dir = tmpRoot("mstar-compass-");
    try {
      const file = join(dir, "delivery-compass.md");
      writeFileSync(
        file,
        `---
iteration_id: "v1.0.0"
status: locked
plans: [plan-a, plan-b]
---`,
        "utf8",
      );
      expect(parseCompassFrontmatter(file)).toEqual({
        iteration_id: "v1.0.0",
        status: "locked",
        plans: ["plan-a", "plan-b"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unterminated frontmatter fence → throws with the file path", () => {
    const dir = tmpRoot("mstar-compass-");
    try {
      const file = join(dir, "delivery-compass.md");
      writeFileSync(file, "---\niteration_id: v9.9.9\nstatus: active\n", "utf8");
      expect(() => parseCompassFrontmatter(file)).toThrow(`unterminated YAML frontmatter in ${file}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing frontmatter fence → throws with the file path", () => {
    const dir = tmpRoot("mstar-compass-");
    try {
      const file = join(dir, "delivery-compass.md");
      writeFileSync(file, "# v9.9.9 Delivery Compass\n", "utf8");
      expect(() => parseCompassFrontmatter(file)).toThrow(`no YAML frontmatter fence in ${file}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
