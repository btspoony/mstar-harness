/**
 * OpenCode plugin — non-blocking `beforeDispatch` Assignment validation lint
 * (roadmap §8.5, v1; Slice 3 extension of the Slice 2 presence hook).
 *
 * Spec sources:
 * - `beforeDispatch` host hook + v1 non-blocking warn / never-block
 * contract: roadmap §8.5 +
 * D2 (v1 = non-blocking lints; hard gates are v2 opt-in).
 * - Assignment core fields (`Execute as` / `Delegation` / `Task category`
 * presence): roadmap §4.3 dispatch/gates layer + Slice 2 Global
 * Constraint; the legacy presence codes (`assignment.presence.*`) stay
 * observable as ALIASES on the engine's core-field violations 
 * — the local presence parser is removed, one engine parser owns the
 * grammar.
 * - Full field validation (exactly-one Working-branch form, create-form
 * `<base>`, Branch policy reason) + default-branch gate: Slice 3 via
 * `dispatch.validateAssignmentFields` / `dispatch.assertDefaultBranchProtected`,
 * direct-on exception wiring per the CLI fix ea010f1
 * (`mstar dispatch validate`); gate branch derived from the Assignment's
 * own branch forms ; read-only roles skip both branch gates
 * ; the anti-recursion precheck is caller-scoped (issue #156) —
 * this host cannot observe the dispatching agent, so the leg never runs
 * here and the NEVER red line stays prompt-level.
 *
 * The exported `validateDispatchAssignment` helper is the hook module; the
 * plugin wiring (`tool.execute.before` on the opencode `task` tool) is
 * exercised end-to-end at the bottom.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MorningStarHarnessPlugin,
  validateDispatchAssignment,
  type StatusLogger,
} from "../src/mstar.js";
import type { GateResult } from "@mstar-harness/engine";

/**
 * Ambient harness isolation (repo-hard composition, issue #156 follow-up):
 * `validateDispatchAssignment` composes the repo-level `.mstarc`/compass
 * `enforcement` below the Assignment header flag AND reads the control-root
 * cleanliness of the Git main worktree of the process cwd, so running in
 * this repository's own checkout would flip the expectations. The process
 * is pinned into a committed fixture repo (clean status, soft enforcement)
 * for the whole file; the repo-hard composition test swaps the fixture's
 * `.mstarc` per-test.
 */
const fixtureRepo = mkdtempSync(join(tmpdir(), "mstar-dispatch-soft-"));
execFileSync("git", ["init", "-q"], { cwd: fixtureRepo, stdio: "ignore" });
mkdirSync(join(fixtureRepo, ".mstar"), { recursive: true });
writeFileSync(join(fixtureRepo, ".mstar", ".gitkeep"), "");
for (const args of [
  ["config", "user.email", "fixture@example.invalid"],
  ["config", "user.name", "fixture"],
  ["add", ".mstar"],
]) execFileSync("git", args, { cwd: fixtureRepo, stdio: "ignore" });
execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: fixtureRepo, stdio: "ignore" });
let previousCwd: string | undefined;
beforeAll(() => {
  previousCwd = process.cwd();
  process.chdir(fixtureRepo);
});
afterAll(() => {
  if (previousCwd !== undefined) process.chdir(previousCwd);
  rmSync(fixtureRepo, { recursive: true, force: true });
});

const completeAssignment = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/example
task_budget: S — one focused implementer round
---

## Assignment

Do the thing, evidence-first.
`;

const missingExecuteAs = `---
execute_as: fullstack-dev
delegation: allowed (reviewer)
task_category: docs
---

## Assignment

Review the doc.
`.replace("execute_as: fullstack-dev\n", "");

const missingDelegation = `---
execute_as: architect
task_category: audit
working_branch: feature/example
task_budget: XS — one survey round
---

## Assignment

Survey the codebase.
`;

const missingTaskCategory = `---
execute_as: fullstack-dev
delegation: forbidden
working_branch: feature/example
task_budget: XS — one implementer round
---

## Assignment

Ship the module.
`;

/** Assignment-shaped (core key present but empty) — the remaining core
 * fields are missing, the working branch keeps the branch-form gates quiet. */
const missingAllFields = `---
execute_as:
working_branch: feature/example
plan_path: .mstar/plans/20260808-example.md
---

## Assignment
`;

/** Core fields but no branch form — engine `branch-missing` (writable default). */
const noBranchForm = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: XS — one implementer round
---

## Assignment

Do the thing.
`;

/** Existing-branch form on a default protected branch without an exception. */
const workingBranchMain = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: main
---

## Assignment

Ship directly on main.
`;

/** `Branch policy: direct on main — <reason>` — the exception matches the gate branch. */
const directOnMainPolicy = `---
execute_as: fullstack-dev
delegation: allowed (hotfix)
task_category: logic
branch_policy: direct on main — urgent user-authorized hotfix
task_budget: S — one focused implementer round
---

## Assignment

Ship the hotfix.
`;

/**
 * The exception names a DIFFERENT branch than the one being checked —
 * the direct-on exception must not be honored for `main` (CLI ea010f1
 * semantics: `parseBranchPolicyDirectOnBranch(text) === checked branch`).
 */
const exceptionBranchMismatch = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: main
branch_policy: direct on main-tmp — other work
task_budget: XS — one implementer round
---

## Assignment

Conflicting branch forms.
`;

/** Create-form Working branch without `<base>` — engine `branch-missing-base`. */
const createWithoutBase = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: create feature/x
---

## Assignment

Create the branch.
`;

/** Dangling create form — trailing `from`, no base */const createDanglingFrom = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: create feature/x from
---

## Assignment

Create the branch.
`;

/** Read-only orientation assignment — no branch form is legitimate */const scoutAssignment = `---
execute_as: scout
delegation: forbidden
task_category: deep
task_budget: XS — one orientation round
---

## Assignment

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
const hardMissingExecuteAs = `---
enforcement: hard
execute_as: fullstack-dev
delegation: allowed (reviewer)
task_category: docs
task_budget: XS — one docs round
working_branch: feature/example
---

## Assignment

Review the doc.
`.replace("execute_as: fullstack-dev\n", "");

/** Fully valid assignment carrying `**Enforcement**: hard` — nothing to block. */
const hardCompleteAssignment = `---
enforcement: hard
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/example
task_budget: S — one focused implementer round
---

## Assignment

Do the thing, evidence-first.
`;

/** Explicit non-hard value — warn-only, never blocks (rollback = unset flag). */
/** Explicit non-hard value — warn-only, never blocks (rollback = unset flag).
 * `soft` is not an accepted `enforcement` enum value (hard-only contract), so
 * the soft case is modeled by an unenforceable stray key pair — the engine
 * reads the flag as present-but-non-hard and the schema rows stay advisory. */
const softEnforcementAssignment = `---
enforcement: soft
execute_as: fullstack-dev
delegation: allowed (reviewer)
task_category: docs
task_budget: XS — one docs round
working_branch: feature/example
---

## Assignment

Review the doc.
`.replace("execute_as: fullstack-dev\n", "");

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
 // 2 field/branch violations + the new task-budget gate = 3.
    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => w.includes("assignment.field.execute-as"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.field.branch-missing"))).toBe(true);
    expect(warnings.some((w) => w.includes("assignment.presence.missing-execute-as"))).toBe(false);
    const executeAs = result!.violations.find((v) => v.code === "assignment.field.execute-as");
    expect(executeAs?.aliases).toContain("assignment.presence.missing-execute-as");
    expect(warnings.some((w) => w.includes("[high]"))).toBe(true);
    expect(warnings.some((w) => w.includes("(fix:"))).toBe(true);
  });

  test("missing Delegation / Task category → single engine field code each (presence alias on the violation)", () => {
    for (const [fixture, fieldCode, presenceCode] of [
      [missingDelegation, "assignment.field.delegation", "assignment.presence.missing-delegation"],
      [missingTaskCategory, "assignment.field.task-category", "assignment.presence.missing-task-category"],
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

  test("missing all three → 4 field warnings (3 core fields + task-budget), no stacked presence lines", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(missingAllFields, { log });
    expect(result!.ok).toBe(false);
 // The fixture still carries a Working branch — no branch-missing.
    expect(warnings).toHaveLength(4);
    for (const code of [
      "assignment.field.execute-as",
      "assignment.field.delegation",
      "assignment.field.task-category",
    ]) {
      expect(warnings.some((w) => w.includes(code))).toBe(true);
    }
 // Every core-field violation carries its legacy presence alias: select
 // the three actual field codes (not the retired `missing-` infix), find
 // each violation, and assert all three were checked.
    const checked: string[] = [];
    for (const [fieldCode, presenceCode] of [
      ["assignment.field.execute-as", "assignment.presence.missing-execute-as"],
      ["assignment.field.delegation", "assignment.presence.missing-delegation"],
      ["assignment.field.task-category", "assignment.presence.missing-task-category"],
    ] as const) {
      const violation = result!.violations.find((v) => v.code === fieldCode);
      expect(violation).toBeDefined();
      expect(violation?.aliases).toContain(presenceCode);
      checked.push(fieldCode);
    }
    expect(checked).toEqual([
      "assignment.field.execute-as",
      "assignment.field.delegation",
      "assignment.field.task-category",
    ]);
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

  test("unterminated front matter with a core key is linted, not silent", () => {
 // An unterminated fence counts as Assignment evidence (fail-closed shape
 // guard): the schema absent-fence row and the missing-field rows warn;
 // unfenced key: value body text (the retired grammar) is D16 instead.
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment("---\nexecute_as: fullstack-dev\ntask_budget: XS — one implementer round\n", { log });
    expect(result!.ok).toBe(false);
    expect(warnings.some((w) => w.includes("document.frontmatter.absent"))).toBe(true);
  });

  test("a bare unfenced key: value body text is NOT an Assignment declaration", () => {
 // Unfenced `execute_as: x` body prose declares nothing (front matter is the
 // only field contract); a single label is not legacy-shaped either — the
 // prompt passes silently.
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment("execute_as: fullstack-dev\n", { log });
    expect(result!.ok).toBe(true);
    expect(warnings).toEqual([]);
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
 // Task-budget + branch-missing-base: the implement fixture lacks the capacity field.
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("assignment.field.branch-missing-base"))).toBe(true);
 // The created branch (feature/x) itself is not default-protected — no gate warn.
    expect(warnings.some((w) => w.includes("dispatch.default-branch.protected"))).toBe(false);
  });

  test("dangling create form ('create feature/x from') → branch-missing-base warn", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(createDanglingFrom, { log });
    expect(result!.ok).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("assignment.field.branch-missing-base"))).toBe(true);
  });

  test("read-only scout assignment without a branch form → no branch-missing warn", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(scoutAssignment, { log });
    expect(result!.ok).toBe(true);
    expect(result!.violations).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("read-only role match is case-insensitive (Execute as: Scout)", () => {
    const { warnings, log } = captureWarnings();
    const text = scoutAssignment.replace("execute_as: scout", "execute_as: Scout");
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
 // Task-budget + protected-branch: the implement fixture lacks the capacity field.
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("dispatch.default-branch.protected"))).toBe(true);
    expect(warnings.some((w) => w.includes('"main"'))).toBe(true);
    expect(warnings.some((w) => w.includes("(fix:"))).toBe(true);
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
    expect(warnings.some((w) => w.includes("assignment.field.execute-as"))).toBe(true);
  });

  test("repo-level hard (`.mstarc`) hardens a flag-less Assignment (dsh resolveDispatchHard parity)", () => {
    // why: The fixed root is the Git main worktree's `.mstar`: declare hard in the
    // chdir'd fixture repo's `.mstarc`, and commit it so the control-root
    // cleanliness gate keeps answering clean.
    writeFileSync(join(fixtureRepo, ".mstarc"), "[config]\nenforcement=hard\n");
    execFileSync("git", ["add", ".mstarc"], { cwd: fixtureRepo, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "hard"], { cwd: fixtureRepo, stdio: "ignore" });
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
      rmSync(join(fixtureRepo, ".mstarc"));
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-aqm", "soft again"], { cwd: fixtureRepo, stdio: "ignore" });
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
 // Restore even if beforeExecute throws : a left-patched
 // console.warn would pollute every later capture in this file.
      warnings = restore();
    }
    expect(
      warnings.some(
        (w) => w.includes("[mstar-harness]") && w.includes("assignment.field.execute-as"),
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
    expect(entries.some(([level, text]) => level === "error" && text.includes("assignment.field.execute-as"))).toBe(true);
 // Hard mode must not emit warn-level lines for the same violations.
    expect(entries.some(([level]) => level === "warn")).toBe(false);
 // Skill-text pointer present in the error.
    expect(entries.some(([, text]) => text.includes("Enforcement: hard"))).toBe(true);
  });

  test("invalid assignment + plain-form enforcement: hard → hardBlocked true", () => {
    const { entries, log } = capture();
    const result = validateDispatchAssignment(hardMissingExecuteAs.replace("enforcement: hard", 'enforcement: "hard"'), { log });
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
    expect(result!.violations.some((v) => v.code === "assignment.field.execute-as")).toBe(true);
    expect(result!.violations.some((v) => v.code === "assignment.field.delegation")).toBe(false);
  });

  test("body example **Enforcement**: hard after `# Change` does NOT harden", () => {
    const { entries, log } = capture();
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: docs
task_budget: XS — one docs round
working_branch: feature/example
---

## Assignment

# Change

An example Assignment template line: **Enforcement**: hard
`.replace("execute_as: fullstack-dev\n", "");
    const result = validateDispatchAssignment(text, { log });
 // Missing Execute as is a real violation — but the flag lives in the
 // BODY, so the gate stays warn-only (no hardBlocked, no error lines).
    expect(result!.ok).toBe(false);
    expect(result!.hardBlocked).toBe(false);
    expect(entries.some(([level]) => level === "warn")).toBe(true);
    expect(entries.some(([level]) => level === "error")).toBe(false);
  });

  test("front matter enforcement: hard hardens even when the body quotes a soft example", () => {
    const { entries, log } = capture();
    const text = `---
enforcement: hard
execute_as: fullstack-dev
delegation: forbidden
task_category: docs
task_budget: XS — one docs round
working_branch: feature/example
---

## Assignment

# Change

**Enforcement**: soft (example only)
`.replace("execute_as: fullstack-dev\n", "");
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
        { args: { prompt: hardCompleteAssignment.replace("working_branch: feature/example", "") } },
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

/** The retired body-label format of the complete assignment — same fields as
 * `**Label**` body lines (the format front matter replaced). */
const LEGACY_BODY_LABEL = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/example
**Task budget (implement / ops rounds)**: S — one focused implementer round

Do the thing, evidence-first.
`;

describe("D14/D16 assignment source (pointer parity and legacy refusal)", () => {
  test("a pointer under an accepted assignment home produces the SAME decision as the inline form", () => {
    const inlineLog = captureWarnings();
    validateDispatchAssignment(noBranchForm, { log: inlineLog.log });

    mkdirSync(join(fixtureRepo, ".mstar", "assignments"), { recursive: true });
    const file = join(fixtureRepo, ".mstar", "assignments", "pointer-target.md");
    writeFileSync(file, noBranchForm);
    const pointerLog = captureWarnings();
    const result = validateDispatchAssignment(`Assignment file: ${file}`, { log: pointerLog.log });

    expect(result!.ok).toBe(false);
    const inlineCodes = inlineLog.warnings.map((w) => w.match(/(assignment\.[\w.-]+|dispatch\.[\w.-]+)/)?.[1]).sort();
    const pointerCodes = pointerLog.warnings.map((w) => w.match(/(assignment\.[\w.-]+|dispatch\.[\w.-]+)/)?.[1]).sort();
    expect(pointerCodes).toEqual(inlineCodes);
    expect(pointerCodes).toContain("assignment.field.branch-missing");
  });

  test("an out-of-home pointer refuses dispatch.assignment.path — fail-closed hardBlocked under SOFT repo enforcement", () => {
    const entries: Array<[string, string]> = [];
    const log: StatusLogger = (level, message) => {
      entries.push([level, message]);
    };
    const outside = join(fixtureRepo, "outside-assignment.md");
    writeFileSync(outside, completeAssignment);
 // Critical source-resolution refusal: hard independent of document/repo
 // enforcement (the fixture tree is soft) — error-level lines, no warn lines.
    const result = validateDispatchAssignment(`Assignment file: ${outside}`, { log });
    expect(result!.ok).toBe(false);
    expect(result!.violations.some((v) => v.code === "dispatch.assignment.path")).toBe(true);
    expect(result!.hardBlocked).toBe(true);
    expect(entries.some(([level, msg]) => level === "error" && msg.includes("dispatch.assignment.path"))).toBe(true);
    expect(entries.some(([level]) => level === "warn")).toBe(false);
  });

  test("a null control harness root refuses the pointer — fail-closed hardBlocked", () => {
 // A bare non-git directory: no checkout, no `.mstar` — the resolver cannot
 // answer a root, so the pointer can never be containment-checked. Fail-closed
 // hard enforcement applies independently of any document or repo flag.
    const bare = mkdtempSync(join(tmpdir(), "mstar-null-root-"));
    writeFileSync(join(bare, "a.md"), completeAssignment);
    process.chdir(bare);
    const entries: Array<[string, string]> = [];
    const log: StatusLogger = (level, message) => {
      entries.push([level, message]);
    };
    try {
      const result = validateDispatchAssignment(`Assignment file: ${join(bare, "a.md")}`, { log });
      expect(result!.ok).toBe(false);
      expect(result!.violations.some((v) => v.code === "dispatch.assignment.path")).toBe(true);
      expect(result!.violations.some((v) => v.message.includes("control harness root"))).toBe(true);
      expect(result!.hardBlocked).toBe(true);
      expect(entries.some(([level, msg]) => level === "error" && msg.includes("dispatch.assignment.path"))).toBe(true);
    } finally {
      process.chdir(fixtureRepo);
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("an unreadable pointer under an accepted home refuses fail-closed", () => {
    const entries: Array<[string, string]> = [];
    const log: StatusLogger = (level, message) => {
      entries.push([level, message]);
    };
    mkdirSync(join(fixtureRepo, ".mstar", "assignments"), { recursive: true });
    const missing = join(fixtureRepo, ".mstar", "assignments", "absent-file.md");
    const result = validateDispatchAssignment(`Assignment file: ${missing}`, { log });
    expect(result!.ok).toBe(false);
    expect(result!.violations.some((v) => v.code === "dispatch.assignment.path")).toBe(true);
    expect(result!.hardBlocked).toBe(true);
    expect(entries.some(([level, msg]) => level === "error" && msg.includes("dispatch.assignment.path"))).toBe(true);
  });

  test("a body-label prompt refuses dispatch.assignment.legacy-format with both recoveries", () => {
    const { warnings, log } = captureWarnings();
    const result = validateDispatchAssignment(LEGACY_BODY_LABEL, { log });
    expect(result!.ok).toBe(false);
    const legacy = result!.violations.find((v) => v.code === "dispatch.assignment.legacy-format");
    expect(legacy).toBeDefined();
    expect(legacy!.fix).toContain("front-matter document");
    expect(legacy!.fix).toContain("Assignment file:");
    // The schema's generic absent-fence row is superseded — one defect, one message.
    expect(result!.violations.some((v) => v.code === "document.frontmatter.absent")).toBe(false);
    expect(warnings.some((w) => w.includes("dispatch.assignment.legacy-format"))).toBe(true);
  });

  test("a pointer resolving to a legacy body-label file refuses dispatch.assignment.legacy-format too", () => {
    mkdirSync(join(fixtureRepo, ".mstar", "assignments"), { recursive: true });
    const file = join(fixtureRepo, ".mstar", "assignments", "legacy-pointer.md");
    writeFileSync(file, LEGACY_BODY_LABEL);
    const { log } = captureWarnings();
    const result = validateDispatchAssignment(`Assignment file: ${file}`, { log });
    expect(result!.violations.some((v) => v.code === "dispatch.assignment.legacy-format")).toBe(true);
  });

  test("the legacy refusal hardens under repo-level enforcement", () => {
    writeFileSync(join(fixtureRepo, ".mstarc"), "[config]\nenforcement=hard\n");
    execFileSync("git", ["add", ".mstarc"], { cwd: fixtureRepo, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "hard"], { cwd: fixtureRepo, stdio: "ignore" });
    const entries: Array<[string, string]> = [];
    const log: StatusLogger = (level, message) => {
      entries.push([level, message]);
    };
    try {
      const result = validateDispatchAssignment(LEGACY_BODY_LABEL, { log });
      expect(result!.ok).toBe(false);
      expect(result!.hardBlocked).toBe(true);
      expect(entries.some(([level]) => level === "error")).toBe(true);
    } finally {
      rmSync(join(fixtureRepo, ".mstarc"));
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-aqm", "soft again"], { cwd: fixtureRepo, stdio: "ignore" });
    }
  });
});
