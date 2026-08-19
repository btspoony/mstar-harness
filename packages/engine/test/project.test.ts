/**
 * Engine project module — roadmap frontmatter validator + project register
 * validator (plan `20260819-workflow-engine-core.md` Task 4).
 *
 * Spec sources (each test cites the plan/brief section it enforces):
 * - Roadmap frontmatter schema `{ project_id, title, status:
 *   active|paused|completed, created_at, milestones[]?, residuals_ref }`
 *   (plan Task 4; compass v3.0.0 § Scope "Project layer": compass-style
 *   frontmatter + engine validator). Body conventions (direction section +
 *   goal-item task list) are documented conventions surfaced as validator
 *   **warnings only** — not a hard gate (compass Non-Goal / AC-P1).
 * - Register file `projects/<id>/residuals.json` shape
 *   `{ entries: { [key]: ResidualEntry & { source_plan, registered_at,
 *   lifecycle_id? } } }` (plan Task 4). Entry validation delegates verbatim
 *   to `validateResidual` (status.ts) — severity enum + lifecycle semantics
 *   preserved at the new address, no copy.
 * - `_DEFAULT_PROJECT` fallback constant + PROJECT_FILE names (plan Task 4;
 *   compass ruling 2 — `projects/_default/` fallback for project-less
 *   flows).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateResult } from "../src/core.js";
import {
  PROJECT_REGISTER_FILE,
  PROJECT_ROADMAP_FILE,
  ROADMAP_STATUSES,
  _DEFAULT_PROJECT,
  validateProjectRegister,
  validateRoadmap,
} from "../src/project.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeRoadmap(dir: string, name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

function violationsOf(result: GateResult): string[] {
  return result.violations.map((v) => v.code);
}

function expectViolations(result: GateResult, ...codes: string[]): void {
  expect(result.ok).toBe(false);
  for (const code of codes) expect(violationsOf(result)).toContain(code);
}

/** Valid roadmap.md fixture — compass-style frontmatter + documented body conventions. */
const VALID_ROADMAP = `---
project_id: mstar-harness
title: Morning Star harness program roadmap
status: active
created_at: 2026-08-19
milestones: [engine-core, migrate-dogfood]
residuals_ref: projects/_default/residuals.json
---

## Direction

Ship the v3 workflow-lifecycle layout (workflows/ + projects/).

## Goal Items

- [x] Resolvers and .mstarc keys land
- [ ] Validators are exported and green on fixtures
- [ ] Migration seeds the register and roadmap
`;

function roadmapPath(overrides: string = ""): string {
  const root = tmpRoot("mstar-roadmap-");
  const file = writeRoadmap(root, "roadmap.md", overrides === "" ? VALID_ROADMAP : overrides);
  return file;
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

/** Valid project register fixture — entries keyed by plan id, each value an ARRAY (QC wave-1 W-E). */
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

describe("validateRoadmap — frontmatter schema (plan Task 4)", () => {
  test("valid roadmap fixture passes with zero violations and zero warnings", () => {
    const file = roadmapPath();
    try {
      const result = validateRoadmap(file);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(join(file, ".."), { recursive: true, force: true });
    }
  });

  test("missing file / unreadable path is rejected", () => {
    const result = validateRoadmap("/nonexistent/roadmap.md");
    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual([]);
    expectViolations(result, "project.roadmap.unreadable");
  });

  test("missing frontmatter fence / unterminated fence / unsupported line are rejected", () => {
    const root = tmpRoot("mstar-roadmap-");
    try {
      const noFence = writeRoadmap(root, "no-fence.md", "# Roadmap\nno frontmatter here\n");
      expectViolations(validateRoadmap(noFence), "project.roadmap.invalid-frontmatter");

      const unterminated = writeRoadmap(root, "unterminated.md", "---\nproject_id: x\n");
      expectViolations(validateRoadmap(unterminated), "project.roadmap.invalid-frontmatter");

      const unsupported = writeRoadmap(root, "unsupported.md", "---\nproject_id: x\n- dangling\n---\n");
      expectViolations(validateRoadmap(unsupported), "project.roadmap.invalid-frontmatter");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("project_id is required and must be a non-empty string", () => {
    const root = tmpRoot("mstar-roadmap-");
    try {
      const noId = writeRoadmap(
        root,
        "no-id.md",
        "---\ntitle: t\nstatus: active\ncreated_at: 2026-08-19\n---\n",
      );
      expectViolations(validateRoadmap(noId), "project.roadmap.missing-project-id");

      const badId = writeRoadmap(
        root,
        "bad-id.md",
        "---\nproject_id: \"\"\ntitle: t\nstatus: active\ncreated_at: 2026-08-19\n---\n",
      );
      expectViolations(validateRoadmap(badId), "project.roadmap.invalid-project-id");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("title is required and must be a non-empty string", () => {
    const root = tmpRoot("mstar-roadmap-");
    try {
      const noTitle = writeRoadmap(
        root,
        "no-title.md",
        "---\nproject_id: p\nstatus: active\ncreated_at: 2026-08-19\n---\n",
      );
      expectViolations(validateRoadmap(noTitle), "project.roadmap.missing-title");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status is required and must be active | paused | completed", () => {
    const root = tmpRoot("mstar-roadmap-");
    try {
      const noStatus = writeRoadmap(
        root,
        "no-status.md",
        "---\nproject_id: p\ntitle: t\ncreated_at: 2026-08-19\n---\n",
      );
      expectViolations(validateRoadmap(noStatus), "project.roadmap.missing-status");

      const badStatus = writeRoadmap(
        root,
        "bad-status.md",
        "---\nproject_id: p\ntitle: t\nstatus: archived\ncreated_at: 2026-08-19\n---\n",
      );
      expectViolations(validateRoadmap(badStatus), "project.roadmap.invalid-status");

      for (const status of ROADMAP_STATUSES) {
        const file = writeRoadmap(
          root,
          `status-${status}.md`,
          `---\nproject_id: p\ntitle: t\nstatus: ${status}\ncreated_at: 2026-08-19\n---\n`,
        );
        expect(validateRoadmap(file).ok).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("created_at is required and must be YYYY-MM-DD", () => {
    const root = tmpRoot("mstar-roadmap-");
    try {
      const noCreated = writeRoadmap(
        root,
        "no-created.md",
        "---\nproject_id: p\ntitle: t\nstatus: active\n---\n",
      );
      expectViolations(validateRoadmap(noCreated), "project.roadmap.missing-created-at");

      const badCreated = writeRoadmap(
        root,
        "bad-created.md",
        "---\nproject_id: p\ntitle: t\nstatus: active\ncreated_at: 2026/08/19\n---\n",
      );
      expectViolations(validateRoadmap(badCreated), "project.roadmap.invalid-created-at");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("milestones is optional and must be a list of non-empty strings", () => {
    const root = tmpRoot("mstar-roadmap-");
    try {
      const without = writeRoadmap(
        root,
        "no-milestones.md",
        "---\nproject_id: p\ntitle: t\nstatus: active\ncreated_at: 2026-08-19\n---\n",
      );
      expect(validateRoadmap(without).ok).toBe(true);

      const flowList = writeRoadmap(
        root,
        "flow-milestones.md",
        "---\nproject_id: p\ntitle: t\nstatus: active\ncreated_at: 2026-08-19\nmilestones: [engine-core, migrate]\n---\n",
      );
      expect(validateRoadmap(flowList).ok).toBe(true);

      const blockList = writeRoadmap(
        root,
        "block-milestones.md",
        "---\nproject_id: p\ntitle: t\nstatus: active\ncreated_at: 2026-08-19\nmilestones:\n- engine-core\n- migrate\n---\n",
      );
      expect(validateRoadmap(blockList).ok).toBe(true);

      const scalar = writeRoadmap(
        root,
        "scalar-milestones.md",
        "---\nproject_id: p\ntitle: t\nstatus: active\ncreated_at: 2026-08-19\nmilestones: engine-core\n---\n",
      );
      expectViolations(validateRoadmap(scalar), "project.roadmap.invalid-milestones");

      const emptyItem = writeRoadmap(
        root,
        "empty-item-milestones.md",
        "---\nproject_id: p\ntitle: t\nstatus: active\ncreated_at: 2026-08-19\nmilestones:\n- \n---\n",
      );
      expectViolations(validateRoadmap(emptyItem), "project.roadmap.invalid-milestones");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("residuals_ref is optional and must be a non-empty string", () => {
    const root = tmpRoot("mstar-roadmap-");
    try {
      const noRef = writeRoadmap(
        root,
        "no-ref.md",
        "---\nproject_id: p\ntitle: t\nstatus: active\ncreated_at: 2026-08-19\n---\n",
      );
      expect(validateRoadmap(noRef).ok).toBe(true);

      const badRef = writeRoadmap(
        root,
        "bad-ref.md",
        "---\nproject_id: p\ntitle: t\nstatus: active\ncreated_at: 2026-08-19\nresiduals_ref: \"   \"\n---\n",
      );
      expectViolations(validateRoadmap(badRef), "project.roadmap.invalid-residuals-ref");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("validateRoadmap — goal-item body conventions are warnings, not a hard gate (compass Non-Goal / AC-P1)", () => {
  test("a roadmap without a ## Direction section carries the convention warning but stays ok", () => {
    const root = tmpRoot("mstar-roadmap-");
    try {
      const file = writeRoadmap(
        root,
        "no-direction.md",
        `---
project_id: p
title: t
status: active
created_at: 2026-08-19
---

## Goal Items

- [ ] Some goal
`,
      );
      const result = validateRoadmap(file);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.warnings.map((w) => w.code)).toContain("project.roadmap.body.missing-direction");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a roadmap without goal-item task entries carries the warning but stays ok", () => {
    const root = tmpRoot("mstar-roadmap-");
    try {
      const file = writeRoadmap(
        root,
        "no-goals.md",
        `---
project_id: p
title: t
status: active
created_at: 2026-08-19
---

## Direction

Ship the layout.
`,
      );
      const result = validateRoadmap(file);
      expect(result.ok).toBe(true);
      expect(result.warnings.map((w) => w.code)).toContain("project.roadmap.body.no-goal-items");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("validateProjectRegister — register entries keyed by plan-id (plan Task 4)", () => {
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

  test("entries values must be arrays (QC wave-1 W-E array schema)", () => {
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

describe("project file names + _default fallback constants (plan Task 4)", () => {
  test("PROJECT_ROADMAP_FILE / PROJECT_REGISTER_FILE name the project layer files", () => {
    expect(PROJECT_ROADMAP_FILE).toBe("roadmap.md");
    expect(PROJECT_REGISTER_FILE).toBe("residuals.json");
  });

  test("_DEFAULT_PROJECT is the project-less fallback id", () => {
    expect(_DEFAULT_PROJECT).toBe("_default");
  });
});
