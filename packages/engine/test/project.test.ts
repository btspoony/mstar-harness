/** see packages/engine/test/project.test.ts - Engine project module — project register validator. Spec sources (each test cites the plan/brief section it enforces): - Register file `projects/<id>/residuals.json` shape `{ entries: { [key]: ResidualEntry & { source_plan, registered_at, lifecycle_id? } } }` (). Entry validation delegates verbatim to `validateResidual` (status.ts) — severity enum + lifecycle semantics preserved at the new address, no copy. The validator is MIGRATION-ONLY (issue-governance cutover G2a): the register is historical input to the staged import, never a runtime findings authority, so this file no longer covers register writes — the issue store owns them (issue-cutover.test.ts). - `_DEFAULT_PROJECT` fallback constant + PROJECT_FILE names (; compass ruling 2 — `projects/_default/` fallback for project-less flows). */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateResult } from "../src/core.js";
import {
  PROJECT_REFERENCES_DIR,
  PROJECT_REGISTER_FILE,
  _DEFAULT_PROJECT,
  listProjectReferenceFiles,
  validateProjectRegister,
} from "../src/project.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function violationsOf(result: GateResult): string[] {
  return result.violations.map((v) => v.code);
}

function expectViolations(result: GateResult, ...codes: string[]): void {
  expect(result.ok).toBe(false);
  for (const code of codes) expect(violationsOf(result)).toContain(code);
}

/** Verbatim v1 residual entry shape (validated by `validateResidual` unchanged). */
function residualEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "R-1",
    title: "Hard cutover leaves v1 tree unreadable without migrate hint",
    severity: "high",
    source: "iteration-20260819-workflow-engine-core",
    scope: "engine",
    decision: "accept",
    owner: "@fullstack-dev",
    target: null,
    tracking: "20260819-workflow-engine-core",
    lifecycle: "open",
    source_plan: "20260819-workflow-engine-core",
    registered_at: "2026-08-19",
    ...overrides,
  };
}

/** Valid project register fixture — entries keyed by plan id, each value an ARRAY . */
function registerDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entries: {
      "20260819-workflow-engine-core": [residualEntry()],
      "20260808-slice1-engine-foundation": [
        residualEntry({
          id: "R-2",
          severity: "low",
          source_plan: "20260808-slice1-engine-foundation",
          lifecycle: "resolved",
          closed_at: "2026-08-08",
          closure_note: "resolved by the v3 engine core slice",
        }),
      ],
    },
    ...overrides,
  };
}

describe("validateProjectRegister — register entries keyed by plan-id ()", () => {
  test("valid register with mixed severities and a closed lifecycle passes", () => {
    const result = validateProjectRegister(registerDoc());
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("non-object document is rejected", () => {
    expectViolations(validateProjectRegister(null), "project.register.invalid");
    expectViolations(validateProjectRegister("nope"), "project.register.invalid");
    expectViolations(validateProjectRegister([]), "project.register.invalid");
  });

  test("entries is required and must be an object", () => {
    const { entries: _dropped, ...noEntries } = registerDoc();
    expectViolations(validateProjectRegister(noEntries), "project.register.missing-entries");
    expectViolations(validateProjectRegister({ entries: [] }), "project.register.invalid-entries");
  });

  test("an empty plan-id key is rejected", () => {
    expectViolations(
      validateProjectRegister({ entries: { "": [residualEntry()] } }),
      "project.register.invalid-key",
    );
  });

  test("entry severity enum is preserved verbatim via validateResidual (no copy)", () => {
    const bad = registerDoc({
      entries: { "20260819-workflow-engine-core": [residualEntry({ severity: "warning" })] },
    });
    expectViolations(validateProjectRegister(bad), "status.residual.legacy-warning");

    const unknown = registerDoc({
      entries: { "20260819-workflow-engine-core": [residualEntry({ severity: "blocker" })] },
    });
    expectViolations(validateProjectRegister(unknown), "status.residual.invalid-severity");

    const missing = registerDoc({
      entries: {
        "20260819-workflow-engine-core": [residualEntry({ severity: undefined })],
      },
    });
    expectViolations(validateProjectRegister(missing), "status.residual.missing-severity");
  });

  test("entry lifecycle semantics are preserved verbatim (closed requires closed_at + closure_note)", () => {
    const closedMissingNote = registerDoc({
      entries: {
        "20260819-workflow-engine-core": [
          residualEntry({
            lifecycle: "resolved",
            closed_at: "2026-08-19",
            closure_note: undefined,
          }),
        ],
      },
    });
    expectViolations(validateProjectRegister(closedMissingNote), "status.residual.closed-missing-closure-note");

    const closedMissingDate = registerDoc({
      entries: {
        "20260819-workflow-engine-core": [residualEntry({ lifecycle: "resolved" })],
      },
    });
    expectViolations(validateProjectRegister(closedMissingDate), "status.residual.closed-missing-closed-at");

    const badLifecycle = registerDoc({
      entries: {
        "20260819-workflow-engine-core": [residualEntry({ lifecycle: "archived" })],
      },
    });
    expectViolations(validateProjectRegister(badLifecycle), "status.residual.invalid-lifecycle");
  });

  test("source_plan is required and must be a non-empty string", () => {
    const noSource = registerDoc({
      entries: {
        "20260819-workflow-engine-core": [residualEntry({ source_plan: undefined })],
      },
    });
    expectViolations(validateProjectRegister(noSource), "project.register.missing-source-plan");

    const badSource = registerDoc({
      entries: { "20260819-workflow-engine-core": [residualEntry({ source_plan: "" })] },
    });
    expectViolations(validateProjectRegister(badSource), "project.register.invalid-source-plan");
  });

  test("registered_at is required and must be YYYY-MM-DD", () => {
    const noDate = registerDoc({
      entries: {
        "20260819-workflow-engine-core": [residualEntry({ registered_at: undefined })],
      },
    });
    expectViolations(validateProjectRegister(noDate), "project.register.missing-registered-at");

    const badDate = registerDoc({
      entries: { "20260819-workflow-engine-core": [residualEntry({ registered_at: "2026-08" })] },
    });
    expectViolations(validateProjectRegister(badDate), "project.register.invalid-registered-at");
  });

  test("source_plan must match its entries key (register keyed by plan id)", () => {
    const mismatched = registerDoc({
      entries: { "20260819-workflow-engine-core": [residualEntry({ source_plan: "20260808-slice1-engine-foundation" })] },
    });
    expectViolations(validateProjectRegister(mismatched), "project.register.mismatched-source-plan");
  });

  test("lifecycle_id is optional and must be a non-empty string", () => {
    const withLifecycle = registerDoc({
      entries: {
        "20260819-workflow-engine-core": [residualEntry({ lifecycle_id: "20260819-workflow-engine-core" })],
      },
    });
    expect(validateProjectRegister(withLifecycle).ok).toBe(true);

    const badLifecycleId = registerDoc({
      entries: { "20260819-workflow-engine-core": [residualEntry({ lifecycle_id: 7 })] },
    });
    expectViolations(validateProjectRegister(badLifecycleId), "project.register.invalid-lifecycle-id");
  });

  test("entries values must be arrays(array schema)", () => {
    const single = registerDoc({
      entries: { "20260819-workflow-engine-core": residualEntry() },
    });
    expectViolations(validateProjectRegister(single), "project.register.invalid-entry-list");

    const nonArray = registerDoc({
      entries: { "20260819-workflow-engine-core": "nope" },
    });
    expectViolations(validateProjectRegister(nonArray), "project.register.invalid-entry-list");
  });

  test("a register entry that is not an object is rejected (inside the array)", () => {
    expectViolations(
      validateProjectRegister({ entries: { "20260819-workflow-engine-core": ["nope"] } }),
      "status.residual.invalid",
    );
  });

  test("a plan key may hold multiple entries (v1 multi-finding semantics preserved)", () => {
    const multi = registerDoc({
      entries: {
        "20260819-workflow-engine-core": [
          residualEntry({ id: "R-1" }),
          residualEntry({ id: "R-2", severity: "high", decision: "risk-accepted" }),
        ],
      },
    });
    expect(validateProjectRegister(multi).ok).toBe(true);
 // A bad entry anywhere in the array is caught.
    const badSecond = registerDoc({
      entries: {
        "20260819-workflow-engine-core": [
          residualEntry({ id: "R-1" }),
          residualEntry({ id: "R-2", severity: "blocker" }),
        ],
      },
    });
    expectViolations(validateProjectRegister(badSecond), "status.residual.invalid-severity");
  });
});

describe("project file names + _default fallback constants ()", () => {
  test("PROJECT_REGISTER_FILE names the project layer register file", () => {
    expect(PROJECT_REGISTER_FILE).toBe("residuals.json");
  });

  test("_DEFAULT_PROJECT is the project-less fallback id", () => {
    expect(_DEFAULT_PROJECT).toBe("_default");
  });
});

describe("listProjectReferenceFiles — theme-scoped research listing ", () => {
  test("PROJECT_REFERENCES_DIR names the references subdirectory", () => {
    expect(PROJECT_REFERENCES_DIR).toBe("references");
  });

  test("missing or non-directory references/ -> [] and never throws", () => {
    const empty = tmpRoot("mstar-refs-empty-");
    try {
      expect(listProjectReferenceFiles(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const asFile = tmpRoot("mstar-refs-file-");
    writeFileSync(join(asFile, "references"), "not a directory");
    try {
      expect(listProjectReferenceFiles(asFile)).toEqual([]);
    } finally {
      rmSync(asFile, { recursive: true, force: true });
    }
  });

  test("lists root files + one-level subdirectory files, sorted by code unit", () => {
    const root = tmpRoot("mstar-refs-tree-");
    const refs = join(root, "references");
    mkdirSync(join(refs, "dsh-skills-survey"), { recursive: true });
    mkdirSync(join(refs, "deep", "nested"), { recursive: true });
    writeFileSync(join(refs, "z-last.md"), "x");
    writeFileSync(join(refs, "a-first.md"), "x");
    writeFileSync(join(refs, "dsh-skills-survey", "README.md"), "x");
    writeFileSync(join(refs, "dsh-skills-survey", "inventory.md"), "x");
    writeFileSync(join(refs, "deep", "level2.md"), "x");
    writeFileSync(join(refs, "deep", "nested", "ignored.md"), "x"); // two levels deep — ignored
    try {
      expect(listProjectReferenceFiles(root)).toEqual([
        "a-first.md",
        "deep/level2.md",
        "dsh-skills-survey/README.md",
        "dsh-skills-survey/inventory.md",
        "z-last.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips a residuals.json stray at the references root, keeps the same name one level deep", () => {
    const root = tmpRoot("mstar-refs-strays-");
    const refs = join(root, "references");
    mkdirSync(join(refs, "notes"), { recursive: true });
    writeFileSync(join(refs, "residuals.json"), "x");
    writeFileSync(join(refs, "survey.md"), "x");
    writeFileSync(join(refs, "notes", "residuals.json"), "x");
    try {
      expect(listProjectReferenceFiles(root)).toEqual(["notes/residuals.json", "survey.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

