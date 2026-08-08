/**
 * OpenCode plugin — non-blocking `beforeDispatch` Assignment validation lint
 * (roadmap §8.5, v1; Slice 3 extension of the Slice 2 presence hook).
 *
 * Spec sources:
 * - `beforeDispatch` host hook + v1 non-blocking warn / never-block
 *   contract: `.harness/references/skill-programmatic-roadmap.md` §8.5 +
 *   D2 (v1 = non-blocking lints; hard gates are v2 opt-in).
 * - Assignment core fields (`Execute as` / `Delegation` / `Task category`
 *   presence): roadmap §4.3 dispatch/gates layer + Slice 2 Global
 *   Constraint; presence codes (`assignment.presence.*`) stay observable
 *   for backward compat.
 * - Full field validation (exactly-one Working-branch form, create-form
 *   `<base>`, Branch policy reason) + default-branch gate: Slice 3 via
 *   `dispatch.validateAssignmentFields` / `dispatch.assertDefaultBranchProtected`,
 *   direct-on exception wiring per the CLI fix ea010f1
 *   (`mstar dispatch validate`).
 *
 * The exported `validateAssignmentPresence` / `validateDispatchAssignment`
 * helpers are the hook module; the plugin wiring (`tool.execute.before` on
 * the opencode `task` tool) is exercised end-to-end at the bottom.
 */
import { describe, expect, test } from "bun:test";
import {
  MorningStarHarnessPlugin,
  validateAssignmentPresence,
  validateDispatchAssignment,
  type StatusLogger,
} from "../src/mstar.js";

const completeAssignment = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/example

Do the thing, evidence-first.
`;

const missingExecuteAs = `## Assignment

**Delegation**: allowed (reviewer)
**Task category**: docs

Review the doc.
`;

const missingDelegation = `## Assignment

**Execute as**: architect
**Task category**: audit

Survey the codebase.
`;

const missingTaskCategory = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden

Ship the module.
`;

/** Assignment-shaped (heading present) but none of the three core fields. */
const missingAllFields = `## Assignment

**Working branch**: feature/example
**Plan Path**: .harness/plans/20260808-slice2-sdd-iteration.md
`;

/** Core fields but no branch form — engine `branch-missing` (writable default). */
const noBranchForm = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic

Do the thing.
`;

/** Existing-branch form on a default protected branch without an exception. */
const workingBranchMain = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: main

Ship directly on main.
`;

/** `Branch policy: direct on main — <reason>` — the exception matches the gate branch. */
const directOnMainPolicy = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: allowed (hotfix)
**Task category**: logic
**Branch policy**: direct on main — urgent user-authorized hotfix

Ship the hotfix.
`;

/**
 * The exception names a DIFFERENT branch than the one being checked —
 * the direct-on exception must not be honored for `main` (CLI ea010f1
 * semantics: `parseBranchPolicyDirectOnBranch(text) === checked branch`).
 */
const exceptionBranchMismatch = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: main
**Branch policy**: direct on main-tmp — other work

Conflicting branch forms.
`;

/** Create-form Working branch without `<base>` — engine `branch-missing-base`. */
const createWithoutBase = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: create feature/x

Create the branch.
`;

/** Not an assignment at all — must stay silent (no false positives). */
const garbageText = `This is not an assignment at all.
Just some prose about the weather and a few bullet points:
- one
- two
No harness structure anywhere.
`;

const captureWarnings = (): { warnings: string[]; log: StatusLogger } => {
  const warnings: string[] = [];
  const log: StatusLogger = (level, message) => {
    if (level === "warn") warnings.push(message);
  };
  return { warnings, log };
};

describe("validateAssignmentPresence (exported hook module)", () => {
  test("complete assignment → ok, no violations", () => {
    const result = validateAssignmentPresence(completeAssignment);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("missing Execute as → high violation with presence code", () => {
    const result = validateAssignmentPresence(missingExecuteAs);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    const violation = result.violations[0];
    expect(violation.code).toBe("assignment.presence.missing-execute-as");
    expect(violation.severity).toBe("high");
    expect(violation.message).toContain("Execute as");
    expect(violation.fix).toBeTruthy();
  });

  test("missing Delegation → medium violation with presence code", () => {
    const result = validateAssignmentPresence(missingDelegation);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    const violation = result.violations[0];
    expect(violation.code).toBe("assignment.presence.missing-delegation");
    expect(violation.severity).toBe("medium");
  });

  test("missing Task category → medium violation with presence code", () => {
    const result = validateAssignmentPresence(missingTaskCategory);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    const violation = result.violations[0];
    expect(violation.code).toBe("assignment.presence.missing-task-category");
    expect(violation.severity).toBe("medium");
  });

  test("assignment-shaped text missing all three → exactly 3 violations", () => {
    const result = validateAssignmentPresence(missingAllFields);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(3);
    const codes = result.violations.map((v) => v.code).sort();
    expect(codes).toEqual([
      "assignment.presence.missing-delegation",
      "assignment.presence.missing-execute-as",
      "assignment.presence.missing-task-category",
    ]);
  });

  test("garbage text → ok, no violations (no false positives)", () => {
    const result = validateAssignmentPresence(garbageText);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("empty and header-only text → silent, never throws", () => {
    expect(validateAssignmentPresence("").ok).toBe(true);
    expect(validateAssignmentPresence("no fields here").ok).toBe(true);
    // Heading present → assignment-shaped even with no fields.
    const headingOnly = validateAssignmentPresence("## Assignment\n\nnothing else");
    expect(headingOnly.ok).toBe(false);
    expect(headingOnly.violations).toHaveLength(3);
  });

  test("non-bold plain field lines are recognized (presence only)", () => {
    const plain = `## Assignment\nExecute as: fullstack-dev\nDelegation: forbidden\nTask category: logic\n`;
    expect(validateAssignmentPresence(plain).ok).toBe(true);
    // Empty value counts as missing.
    const emptyValue = `## Assignment\nExecute as: fullstack-dev\nDelegation:\nTask category: logic\n`;
    const result = validateAssignmentPresence(emptyValue);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(["assignment.presence.missing-delegation"]);
  });
});

describe("validateDispatchAssignment (warn-only wrapper, full validation)", () => {
  test("complete assignment (core fields + branch form) → no warnings, ok result", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(completeAssignment, { log });
    expect(result!.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("missing Execute as → presence code + engine field code + branch-missing warns", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(missingExecuteAs, { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(3);
    // Backward-compat presence code stays observable.
    expect(warnings.some((w) => w.includes("assignment.presence.missing-execute-as"))).toBe(true);
    // Engine full-validation codes now also fire.
    expect(warnings.some((w) => w.includes("assignment.field.missing-execute-as"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.field.branch-missing"))).toBe(true);
    expect(warnings.some((w) => w.includes("[high]"))).toBe(true);
    expect(warnings.some((w) => w.includes("(fix:"))).toBe(true);
  });

  test("missing Delegation / Task category → presence + field codes warn", () => {
    for (const [fixture, presenceCode, fieldCode] of [
      [missingDelegation, "assignment.presence.missing-delegation", "assignment.field.missing-delegation"],
      [missingTaskCategory, "assignment.presence.missing-task-category", "assignment.field.missing-task-category"],
    ] as const) {
      const { warnings, log } = captureWarnings();
      const result = validateDispatchAssignment(fixture, { log });
      expect(result!.ok).toBe(false);
      expect(warnings.some((w) => w.includes(presenceCode))).toBe(true);
      expect(warnings.some((w) => w.includes(fieldCode))).toBe(true);
    }
  });

  test("missing all three → 3 presence + 3 engine field warnings", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(missingAllFields, { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(6);
    for (const code of [
      "assignment.presence.missing-execute-as",
      "assignment.presence.missing-delegation",
      "assignment.presence.missing-task-category",
      "assignment.field.missing-execute-as",
      "assignment.field.missing-delegation",
      "assignment.field.missing-task-category",
    ]) {
      expect(warnings.some((w) => w.includes(code))).toBe(true);
    }
  });

  test("garbage text → no warnings, ok result", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(garbageText, { log });
    expect(result!.ok).toBe(true);
    expect(result!.violations).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("never throws on hostile input", () => {
    const { warnings, log } = captureWarnings();
    expect(() => validateDispatchAssignment("", { log })).not.toThrow();
    expect(() => validateDispatchAssignment("*".repeat(10000), { log })).not.toThrow();
    expect(() => validateDispatchAssignment("{{{{[[[[)))) ---- \n<<<<", { log })).not.toThrow();
    expect(warnings).toEqual([]);
  });

  test("field fragment without heading is linted, not silent", () => {
    // A bare `Execute as:` line is Assignment-shaped — the other two fields
    // still warn (presence + engine), unlike true garbage.
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment("Execute as: [unbalanced", { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(5);
    expect(warnings.some((w) => w.includes("assignment.presence.missing-delegation"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.presence.missing-task-category"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.field.missing-delegation"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.field.branch-missing"))).toBe(true);
  });
});

describe("validateDispatchAssignment full-validation matrix (Slice 3)", () => {
  test("branch-missing: core fields without any branch form warn", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(noBranchForm, { log });
    expect(result!.ok).toBe(false);
    expect(warnings.some((w) => w.includes("assignment.field.branch-missing"))).toBe(true);
    expect(warnings.some((w) => w.includes("exactly one"))).toBe(true);
  });

  test("create-without-base: create form without <base> warns", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(createWithoutBase, { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("assignment.field.branch-missing-base");
    // The created branch (feature/x) itself is not default-protected — no gate warn.
    expect(warnings[0]).not.toContain("dispatch.default-branch.protected");
  });

  test("directOnException match: Branch policy direct on main — reason → no gate warn", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(directOnMainPolicy, { log });
    expect(result!.ok).toBe(true);
    expect(result!.violations).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("directOnException mismatch: exception on another branch does not unprotect main", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(exceptionBranchMismatch, { log });
    expect(result!.ok).toBe(false);
    // Branch-policy branch differs from the checked Working branch → protected.
    expect(warnings.some((w) => w.includes("dispatch.default-branch.protected"))).toBe(true);
    // Both branch forms present → branch-multiple too.
    expect(warnings.some((w) => w.includes("assignment.field.branch-multiple"))).toBe(true);
  });

  test("Working branch: main without an exception → protected warn", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(workingBranchMain, { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dispatch.default-branch.protected");
    expect(warnings[0]).toContain('"main"');
    expect(warnings[0]).toContain("(fix:");
  });

  test("Working branch on a feature branch → no protected warn", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(completeAssignment, { log });
    expect(result!.ok).toBe(true);
    expect(warnings.some((w) => w.includes("dispatch.default-branch.protected"))).toBe(false);
  });

  test("env fallback: MSTAR_WORKING_BRANCH=main supplies the gate branch", () => {
    const previous = process.env.MSTAR_WORKING_BRANCH;
    try {
      process.env.MSTAR_WORKING_BRANCH = "main";
      const { warnings, log } = captureWarnings();
      const result = validateDispatchAssignment(noBranchForm, { log });
      expect(result!.ok).toBe(false);
      expect(warnings.some((w) => w.includes("dispatch.default-branch.protected"))).toBe(true);
      expect(warnings.some((w) => w.includes("assignment.field.branch-missing"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MSTAR_WORKING_BRANCH;
      else process.env.MSTAR_WORKING_BRANCH = previous;
    }
  });

  test("directOnException match via env: policy on main + env main → no protected warn", () => {
    const previous = process.env.MSTAR_WORKING_BRANCH;
    try {
      process.env.MSTAR_WORKING_BRANCH = "main";
      const { warnings, log } = captureWarnings();
      const result = validateDispatchAssignment(directOnMainPolicy, { log });
      expect(result!.ok).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MSTAR_WORKING_BRANCH;
      else process.env.MSTAR_WORKING_BRANCH = previous;
    }
  });
});

describe("plugin wiring (tool.execute.before)", () => {
  const captureConsoleWarn = (): (() => string[]) => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    return () => {
      console.warn = original;
      return warnings;
    };
  };

  test("task tool with incomplete assignment warns; complete stays silent", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];
    expect(beforeExecute).toBeDefined();

    const restore = captureConsoleWarn();
    let warnings: string[];
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c1" },
        { args: { subagent_type: "fullstack-dev", prompt: missingExecuteAs } },
      );
    } finally {
      // Restore even if beforeExecute throws (qc3 S-4): a left-patched
      // console.warn would pollute every later capture in this file.
      warnings = restore();
    }
    expect(
      warnings.some(
        (w) => w.includes("[mstar-harness]") && w.includes("assignment.presence.missing-execute-as"),
      ),
    ).toBe(true);

    const restore2 = captureConsoleWarn();
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c2" },
        { args: { subagent_type: "fullstack-dev", prompt: completeAssignment } },
      );
    } finally {
      warnings = restore2();
    }
    expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
  });

  test("task tool without a prompt arg, or garbage prompt, never warns or throws", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];

    const restore = captureConsoleWarn();
    let warnings: string[];
    try {
      await beforeExecute!({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { subagent_type: "fullstack-dev" } });
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c2" },
        { args: { subagent_type: "fullstack-dev", prompt: garbageText } },
      );
    } finally {
      warnings = restore();
    }
    expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
  });

  test("task tool with default-protected Working branch warns; direct-on exception stays silent", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];

    const restore = captureConsoleWarn();
    let warnings: string[];
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c1" },
        { args: { subagent_type: "fullstack-dev", prompt: workingBranchMain } },
      );
    } finally {
      warnings = restore();
    }
    expect(
      warnings.some(
        (w) => w.includes("[mstar-harness]") && w.includes("dispatch.default-branch.protected"),
      ),
    ).toBe(true);

    const restore2 = captureConsoleWarn();
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c2" },
        { args: { subagent_type: "fullstack-dev", prompt: directOnMainPolicy } },
      );
    } finally {
      warnings = restore2();
    }
    expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
  });
});
