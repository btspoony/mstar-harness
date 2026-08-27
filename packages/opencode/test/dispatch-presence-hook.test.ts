/**
 * OpenCode plugin — non-blocking `beforeDispatch` Assignment validation lint
 * (roadmap §8.5, v1; Slice 3 extension of the Slice 2 presence hook).
 *
 * Spec sources:
 * - `beforeDispatch` host hook + v1 non-blocking warn / never-block
 *   contract: roadmap §8.5 +
 *   D2 (v1 = non-blocking lints; hard gates are v2 opt-in).
 * - Assignment core fields (`Execute as` / `Delegation` / `Task category`
 *   presence): roadmap §4.3 dispatch/gates layer + Slice 2 Global
 *   Constraint; the legacy presence codes (`assignment.presence.*`) stay
 *   observable as ALIASES on the engine's core-field violations (qc1 F-002)
 *   — the local presence parser is removed, one engine parser owns the
 *   grammar.
 * - Full field validation (exactly-one Working-branch form, create-form
 *   `<base>`, Branch policy reason) + default-branch gate: Slice 3 via
 *   `dispatch.validateAssignmentFields` / `dispatch.assertDefaultBranchProtected`,
 *   direct-on exception wiring per the CLI fix ea010f1
 *   (`mstar dispatch validate`); gate branch derived from the Assignment's
 *   own branch forms (qc3 F-2); read-only roles skip both branch gates
 *   (qc3 F-1); the anti-recursion precheck is caller-scoped (issue #156) —
 *   this host cannot observe the dispatching agent, so the leg never runs
 *   here and the NEVER red line stays prompt-level.
 *
 * The exported `validateDispatchAssignment` helper is the hook module; the
 * plugin wiring (`tool.execute.before` on the opencode `task` tool) is
 * exercised end-to-end at the bottom.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MorningStarHarnessPlugin,
  validateDispatchAssignment,
  type StatusLogger,
} from "../src/mstar.js";
import type { GateResult } from "@mstar-harness/engine";

/**
 * Ambient harness pinning (repo-hard composition, issue #156 follow-up):
 * `validateDispatchAssignment` composes the repo-level `.mstarc`/compass
 * `enforcement` below the Assignment header flag, so an ambient HARD repo
 * (e.g. this repository's own `.mstar/` compass when tests run in the main
 * checkout) would flip warn-mode expectations. `MSTAR_HARNESS_DIR` — which
 * `resolveHarnessDir` honors ahead of probing — is pinned to an EMPTY dir
 * for the whole file; the repo-hard composition test overrides it per-test.
 */
const ENV_KEY = "MSTAR_HARNESS_DIR";
const emptyHarnessDir = mkdtempSync(join(tmpdir(), "mstar-dispatch-soft-"));
let previousEnv: string | undefined;
beforeEach(() => {
  previousEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = emptyHarnessDir;
});
afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
});

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
**Plan Path**: .mstar/plans/20260808-example.md
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

/** Dangling create form — trailing `from`, no base (qc2 S-1 / qc3 F-5). */
const createDanglingFrom = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: create feature/x from

Create the branch.
`;

/** Read-only orientation assignment — no branch form is legitimate (qc3 F-1 / qc2 S-5). */
const scoutAssignment = `## Assignment

**Execute as**: scout
**Delegation**: forbidden
**Task category**: deep

Survey the codebase.
`;

/** Not an assignment at all — must stay silent (no false positives). */
const garbageText = `This is not an assignment at all.
Just some prose about the weather and a few bullet points:
- one
- two
No harness structure anywhere.
`;

/** Invalid assignment (missing Execute as) with `**Enforcement**: hard` — must hard-block. */
const hardMissingExecuteAs = `## Assignment

**Enforcement**: hard
**Delegation**: allowed (reviewer)
**Task category**: docs

Review the doc.
`;

/** Fully valid assignment carrying `**Enforcement**: hard` — nothing to block. */
const hardCompleteAssignment = `## Assignment

**Enforcement**: hard
**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/example

Do the thing, evidence-first.
`;

/** Explicit non-hard value — warn-only, never blocks (rollback = unset flag). */
const softEnforcementAssignment = `## Assignment

**Enforcement**: soft
**Delegation**: allowed (reviewer)
**Task category**: docs

Review the doc.
`;

const captureWarnings = (): { warnings: string[]; log: StatusLogger } => {
  const warnings: string[] = [];
  const log: StatusLogger = (level, message) => {
    if (level === "warn") warnings.push(message);
  };
  return { warnings, log };
};

describe("validateDispatchAssignment (warn-only wrapper, full validation)", () => {
  test("complete assignment (core fields + branch form) → no warnings, ok result", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(completeAssignment, { log });
    expect(result!.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("missing Execute as → engine field code + branch-missing warn; presence code is an alias on the field violation", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(missingExecuteAs, { log });
    expect(result!.ok).toBe(false);
    // Single parser: NO stacked presence warning — one violation per missing field.
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("assignment.field.missing-execute-as"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.field.branch-missing"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.presence.missing-execute-as"))).toBe(false);
    const executeAs = result!.violations.find((v) => v.code === "assignment.field.missing-execute-as");
    expect(executeAs?.aliases).toContain("assignment.presence.missing-execute-as");
    expect(warnings.some((w) => w.includes("[high]"))).toBe(true);
    expect(warnings.some((w) => w.includes("(fix:"))).toBe(true);
  });

  test("missing Delegation / Task category → single engine field code each (presence alias on the violation)", () => {
    for (const [fixture, fieldCode, presenceCode] of [
      [missingDelegation, "assignment.field.missing-delegation", "assignment.presence.missing-delegation"],
      [missingTaskCategory, "assignment.field.missing-task-category", "assignment.presence.missing-task-category"],
    ] as const) {
      const { warnings, log } = captureWarnings();
      const result = validateDispatchAssignment(fixture, { log });
      expect(result!.ok).toBe(false);
      expect(warnings.some((w) => w.includes(fieldCode))).toBe(true);
      expect(warnings.some((w) => w.includes(presenceCode))).toBe(false);
      const violation = result!.violations.find((v) => v.code === fieldCode);
      expect(violation?.aliases).toContain(presenceCode);
    }
  });

  test("missing all three → 3 engine field warnings, no stacked presence lines", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(missingAllFields, { log });
    expect(result!.ok).toBe(false);
    // The fixture still carries a Working branch — no branch-missing.
    expect(warnings).toHaveLength(3);
    for (const code of [
      "assignment.field.missing-execute-as",
      "assignment.field.missing-delegation",
      "assignment.field.missing-task-category",
    ]) {
      expect(warnings.some((w) => w.includes(code))).toBe(true);
    }
    // Every core-field violation carries its legacy presence alias.
    for (const v of result!.violations) {
      if (v.code.startsWith("assignment.field.missing-")) {
        expect(v.aliases).toHaveLength(1);
        expect(v.aliases![0]).toMatch(/^assignment\.presence\.missing-/);
      }
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

  test("non-string prompt stays silent (no assignmentText.match abort)", () => {
    // Host tool args are `any`; RegExp.test coerces objects then `.match` throws.
    // Exported helper must fail soft — same abort line the user saw on OpenCode boot.
    const entries: Array<[string, string]> = [];
    const log: StatusLogger = (level, message) => {
      entries.push([level, message]);
    };
    for (const bad of [{ text: "Execute as: x" }, 123, true, ["Execute as: x"], null, undefined] as unknown[]) {
      const result = validateDispatchAssignment(bad as string, { log });
      expect(result).toEqual({ ok: true, violations: [] });
    }
    expect(entries.filter(([, msg]) => msg.includes("assignment validation aborted"))).toEqual([]);
  });

  test("field fragment without heading is linted, not silent", () => {
    // A bare `Execute as:` line is Assignment-shaped — the other two fields
    // still warn (engine field codes only; presence codes are aliases).
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment("Execute as: [unbalanced", { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => w.includes("assignment.field.missing-delegation"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.field.missing-task-category"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.field.branch-missing"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.presence."))).toBe(false);
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

  test("dangling create form ('create feature/x from') → branch-missing-base warn (qc2 S-1 / qc3 F-5)", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(createDanglingFrom, { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("assignment.field.branch-missing-base");
  });

  test("read-only scout assignment without a branch form → no branch-missing warn (qc3 F-1 / qc2 S-5)", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(scoutAssignment, { log });
    expect(result!.ok).toBe(true);
    expect(result!.violations).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("read-only role match is case-insensitive (Execute as: Scout)", () => {
    const { warnings, log } = captureWarnings();
    const text = scoutAssignment.replace("**Execute as**: scout", "**Execute as**: Scout");
    const result = validateDispatchAssignment(text, { log });
    expect(result!.ok).toBe(true);
    expect(warnings).toEqual([]);
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
});

describe("anti-recursion in validateDispatchAssignment (caller-scoped, issue #156)", () => {
  test("spawn target == Execute as (the documented compliant dispatch) → ok, zero violations, silent", () => {
    // The host adapter cannot observe the dispatching agent's identity, so
    // the caller-scoped precheck never runs here — pre-#156 the adapter fed
    // the spawn TARGET (`args.subagent`) as the binding, and target ==
    // `Execute as` self-flagged every compliant dispatch at critical.
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(completeAssignment, { log });
    expect(result!.ok).toBe(true);
    expect(result!.violations).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("missing Execute as → field violation only; no anti-recursion codes exist on this host", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(missingExecuteAs, { log });
    expect(result!.violations.some((v) => v.code.startsWith("dispatch.anti-recursion."))).toBe(false);
    // Field + branch warnings still fire.
    expect(warnings.some((w) => w.includes("assignment.field.missing-execute-as"))).toBe(true);
  });

  test("repo-level hard (`.mstarc`) hardens a flag-less Assignment (dsh resolveDispatchHard parity)", () => {
    const repoHarness = mkdtempSync(join(tmpdir(), "mstar-dispatch-hard-"));
    writeFileSync(join(repoHarness, ".mstarc"), "[config]\nenforcement=hard\n");
    process.env[ENV_KEY] = repoHarness;
    const entries: Array<[string, string]> = [];
    const log: StatusLogger = (level, message) => {
      entries.push([level, message]);
    };
    try {
      // No `Enforcement` header flag on the Assignment — the repo setting
      // alone escalates warn → error + hardBlocked.
      const result = validateDispatchAssignment(missingExecuteAs, { log });
      expect(result!.ok).toBe(false);
      expect(result!.hardBlocked).toBe(true);
      expect(entries.some(([level]) => level === "error")).toBe(true);
      expect(entries.some(([level]) => level === "warn")).toBe(false);
    } finally {
      process.env[ENV_KEY] = emptyHarnessDir;
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

  test("task tool with incomplete assignment warns; complete with a non-matching subagent stays silent", async () => {
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
        (w) => w.includes("[mstar-harness]") && w.includes("assignment.field.missing-execute-as"),
      ),
    ).toBe(true);

    const restore2 = captureConsoleWarn();
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c2" },
        { args: { subagent_type: "reviewer", prompt: completeAssignment } },
      );
    } finally {
      warnings = restore2();
    }
    expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
  });

  test("task tool dispatch with subagent == Execute as (compliant C5 pattern) → silent (issue #156: no self-type false positive)", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];

    // OpenCode `args.subagent` key — the spawn TARGET equal to Execute as is
    // the documented compliant dispatch, not recursion.
    const restore = captureConsoleWarn();
    let warnings: string[];
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c1" },
        { args: { subagent: "fullstack-dev", prompt: completeAssignment } },
      );
    } finally {
      warnings = restore();
    }
    expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);

    // Cursor-style `args.subagent_type` key.
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

  test("task tool with no subagent/subagent_type key + Assignment-shaped prompt → silent (issue #156: no empty-binding pincer)", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];

    const restore = captureConsoleWarn();
    let warnings: string[];
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c1" },
        // No `subagent` / `subagent_type` key — a legal spawn-policy-default
        // dispatch; the binding field carries the target, never the caller.
        { args: { prompt: completeAssignment } },
      );
    } finally {
      warnings = restore();
    }
    expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
  });

  test("task tool with read-only scout prompt → silent (no branch-missing warn)", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];

    const restore = captureConsoleWarn();
    let warnings: string[];
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c1" },
        // Non-matching binding — the scout role itself is not re-invoked.
        { args: { subagent: "reviewer", prompt: scoutAssignment } },
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
        // Non-matching binding so only the branch gate fires.
        { args: { subagent_type: "reviewer", prompt: workingBranchMain } },
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
        { args: { subagent_type: "reviewer", prompt: directOnMainPolicy } },
      );
    } finally {
      warnings = restore2();
    }
    expect(warnings.filter((w) => w.includes("[mstar-harness]"))).toEqual([]);
  });
});

describe("hard mode (Enforcement: hard flag — Slice 5, roadmap §8.5 C4/D2)", () => {
  // Spec: roadmap §8.5 C4 + D2 — v2 hard gates are opt-in per Assignment via
  // `Enforcement: hard`; the hook returns the GateResult with hardBlocked
  // and surfaces error-level logs, NEVER a raw exception; flag absent →
  // warn-only (unchanged); flag inert when the engine is absent.
  const capture = (): { entries: Array<[string, string]>; log: StatusLogger } => {
    const entries: Array<[string, string]> = [];
    const log: StatusLogger = (level, message) => {
      entries.push([level, message]);
    };
    return { entries, log };
  };

  test("invalid assignment + Enforcement: hard → hardBlocked true, error logs, no raw throw", () => {
    const { entries, log } = capture();
    let result: GateResult | null = null;
    expect(() => {
      result = validateDispatchAssignment(hardMissingExecuteAs, { log });
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    expect(result!.hardBlocked).toBe(true);
    // Missing Execute as (branch form absent too — no Working branch field).
    expect(entries.some(([level, text]) => level === "error" && text.includes("assignment.field.missing-execute-as"))).toBe(true);
    // Hard mode must not emit warn-level lines for the same violations.
    expect(entries.some(([level]) => level === "warn")).toBe(false);
    // Skill-text pointer present in the error.
    expect(entries.some(([, text]) => text.includes("Enforcement: hard"))).toBe(true);
  });

  test("invalid assignment + plain-form Enforcement: hard → hardBlocked true", () => {
    const { entries, log } = capture();
    const result = validateDispatchAssignment(hardMissingExecuteAs.replace("**Enforcement**: hard", "Enforcement: hard"), { log });
    expect(result!.ok).toBe(false);
    expect(result!.hardBlocked).toBe(true);
    expect(entries.some(([level]) => level === "error")).toBe(true);
  });

  test("valid assignment + Enforcement: hard → ok, hardBlocked false, silent", () => {
    const { entries, log } = capture();
    const result = validateDispatchAssignment(hardCompleteAssignment, { log });
    expect(result!.ok).toBe(true);
    expect(result!.hardBlocked).toBe(false);
    expect(entries).toEqual([]);
  });

  test("invalid assignment WITHOUT the flag → warn-only, hardBlocked false (unchanged v1 behavior)", () => {
    const { entries, log } = capture();
    const result = validateDispatchAssignment(missingExecuteAs, { log });
    expect(result!.ok).toBe(false);
    expect(result!.hardBlocked).toBe(false);
    expect(entries.some(([level]) => level === "warn")).toBe(true);
    expect(entries.some(([level]) => level === "error")).toBe(false);
  });

  test("Enforcement: soft (explicit non-hard) → warn-only, hardBlocked false", () => {
    const { entries, log } = capture();
    const result = validateDispatchAssignment(softEnforcementAssignment, { log });
    expect(result!.ok).toBe(false);
    expect(result!.hardBlocked).toBe(false);
    expect(entries.some(([level]) => level === "warn")).toBe(true);
    expect(entries.some(([level]) => level === "error")).toBe(false);
  });

  test("hard mode never suppresses the violation codes — the structured result stays complete", () => {
    const { log } = capture();
    const result = validateDispatchAssignment(hardMissingExecuteAs, { log });
    expect(result!.violations.some((v) => v.code === "assignment.field.missing-execute-as")).toBe(true);
    expect(result!.violations.some((v) => v.code === "assignment.field.missing-delegation")).toBe(false);
  });

  test("body example **Enforcement**: hard after `# Change` does NOT harden (qc1 F-003 / qc2 F-003)", () => {
    const { entries, log } = capture();
    const text = `## Assignment

**Delegation**: forbidden
**Task category**: docs

# Change

An example Assignment template line: **Enforcement**: hard
`;
    const result = validateDispatchAssignment(text, { log });
    // Missing Execute as is a real violation — but the flag lives in the
    // BODY, so the gate stays warn-only (no hardBlocked, no error lines).
    expect(result!.ok).toBe(false);
    expect(result!.hardBlocked).toBe(false);
    expect(entries.some(([level]) => level === "warn")).toBe(true);
    expect(entries.some(([level]) => level === "error")).toBe(false);
  });

  test("header **Enforcement**: hard hardens even when the body quotes a soft example", () => {
    const { entries, log } = capture();
    const text = `## Assignment

**Enforcement**: hard
**Delegation**: forbidden
**Task category**: docs

# Change

**Enforcement**: soft (example only)
`;
    const result = validateDispatchAssignment(text, { log });
    expect(result!.ok).toBe(false);
    expect(result!.hardBlocked).toBe(true);
    expect(entries.some(([level]) => level === "error")).toBe(true);
    expect(entries.some(([level]) => level === "warn")).toBe(false);
  });

  test("plugin wiring: task tool with hard assignment logs error-level lines, never throws", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];
    const errors: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c1" },
        { args: { subagent_type: "reviewer", prompt: hardMissingExecuteAs } },
      );
    } finally {
      console.error = original;
    }
    expect(errors.some((e) => e.includes("[mstar-harness]") && e.includes("hard gate"))).toBe(true);
    // The GateResult is not silently discarded: the hook surfaces the
    // hardBlocked state explicitly (host has no refusal channel).
    expect(errors.some((e) => e.includes("hard-gate blocked (hardBlocked=true)"))).toBe(true);
  });

  test("plugin wiring: hard assignment, no subagent key, missing branch form → hardBlocked via branch-missing, never empty-binding (issue #156)", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];
    const errors: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      // No subagent key (legal spawn-policy default) and the Assignment's own
      // `**Enforcement**: hard` header: only the REAL violation (the stripped
      // branch form) may harden the gate — never the empty target binding.
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c1" },
        { args: { prompt: hardCompleteAssignment.replace("**Working branch**: feature/example", "") } },
      );
    } finally {
      console.error = original;
    }
    expect(errors.some((e) => e.includes("assignment.field.branch-missing"))).toBe(true);
    expect(errors.some((e) => e.includes("dispatch.anti-recursion.empty-binding"))).toBe(false);
    expect(errors.some((e) => e.includes("hard-gate blocked (hardBlocked=true)"))).toBe(true);
  });

  test("plugin wiring: fully valid hard assignment with subagent == Execute as → NOT hardBlocked (the #156 pincer, closed)", async () => {
    const plugin = await MorningStarHarnessPlugin();
    const beforeExecute = plugin["tool.execute.before"];
    const errors: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      await beforeExecute!(
        { tool: "task", sessionID: "s1", callID: "c1" },
        { args: { subagent: "fullstack-dev", prompt: hardCompleteAssignment } },
      );
    } finally {
      console.error = original;
    }
    expect(errors.filter((e) => e.includes("[mstar-harness]"))).toEqual([]);
  });
});
