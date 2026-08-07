/**
 * OpenCode plugin — non-blocking `beforeDispatch` Assignment presence lint
 * (roadmap §8.5, v1).
 *
 * Spec sources:
 * - `beforeDispatch` host hook + v1 non-blocking warn / never-block
 *   contract: `.harness/references/skill-programmatic-roadmap.md` §8.5 +
 *   D2 (v1 = non-blocking lints; hard gates are v2 opt-in).
 * - Assignment core fields (`Execute as` / `Delegation` / `Task category`
 *   presence): roadmap §4.3 dispatch/gates layer + Slice 2 Global
 *   Constraint (field-presence ONLY via `engine/core` types; full
 *   Assignment validation lands in Slice 3 via
 *   `dispatch.validateAssignmentFields` — no `engine/dispatch` import).
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

describe("validateDispatchAssignment (warn-only wrapper)", () => {
  test("complete assignment → no warnings, ok result", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(completeAssignment, { log });
    expect(result!.ok).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("missing Execute as → one warn containing code and fix", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(missingExecuteAs, { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("assignment.presence.missing-execute-as");
    expect(warnings[0]).toContain("[high]");
    expect(warnings[0]).toContain("(fix:");
  });

  test("missing all three → 3 warnings", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(missingAllFields, { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(3);
    for (const code of [
      "assignment.presence.missing-execute-as",
      "assignment.presence.missing-delegation",
      "assignment.presence.missing-task-category",
    ]) {
      expect(warnings.some((w) => w.includes(code))).toBe(true);
    }
  });

  test("garbage text → no warnings, ok result", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(garbageText, { log });
    expect(result!.ok).toBe(true);
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
    // still warn (presence lint), unlike true garbage.
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment("Execute as: [unbalanced", { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("assignment.presence.missing-delegation"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.presence.missing-task-category"))).toBe(true);
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
    await beforeExecute!(
      { tool: "task", sessionID: "s1", callID: "c1" },
      { args: { subagent_type: "fullstack-dev", prompt: missingExecuteAs } },
    );
    let warnings = restore();
    expect(
      warnings.some(
        (w) => w.includes("[mstar-harness]") && w.includes("assignment.presence.missing-execute-as"),
      ),
    ).toBe(true);

    const restore2 = captureConsoleWarn();
    await beforeExecute!(
      { tool: "task", sessionID: "s1", callID: "c2" },
      { args: { subagent_type: "fullstack-dev", prompt: completeAssignment } },
    );
    warnings = restore2();
    expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
  });

  test("task tool without a prompt arg, or garbage prompt, never warns or throws", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];

    const restore = captureConsoleWarn();
    await beforeExecute!({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { subagent_type: "fullstack-dev" } });
    await beforeExecute!(
      { tool: "task", sessionID: "s1", callID: "c2" },
      { args: { subagent_type: "fullstack-dev", prompt: garbageText } },
    );
    const warnings = restore();
    expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
  });
});
