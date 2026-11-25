/**
 * Engine dispatch module — Assignment field validation, default-branch gate,
 * execution-mode → QC seat count, tri identity, anti-recursion precheck.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - Assignment fields live in the document FRONT MATTER (compass D15) —
 *   `parseAssignmentFields` reads snake_case front matter keys only; a
 *   body-quoted template label can neither satisfy nor disable a gate.
 * - Assignment field contract — `execute_as` / `delegation` / `task_category`
 * present with non-empty values; paste-only assignments missing fields are
 * flagged: `mstar-dispatch-gates` SKILL.md § "调度防串扰（强制）" +
 * § "Assignment 顶部反模式块" + § 反模式（派发）("Assignment 已写、invoke
 * 为零（paste-only）").
 * - Branch-field forms — writable Assignment must contain EXACTLY ONE of
 * `working_branch: <existing>` | `working_branch: create <new> from <base>`
 * | `branch_policy: direct on <branch> — <reason>`; `create` without
 * `<base>` is flagged (never assume `main`): `mstar-branch-worktree`
 * SKILL.md § "Assignment 要求（PM）" + § "`<base>` 与叠分支（stacked
 * branches）".
 * - Review/audit round-bounding fields — an Assignment whose `execute_as`
 * names a review seat, or whose `task_category` starts with `audit`, must
 * carry non-empty `budget` and `return_shape` values that are not `N/A`;
 * the cap may only tighten the default: `mstar-harness-core` SKILL.md
 * § "定向执行与验证边界" + `mstar-review-qc` SKILL.md § "席位预算与截断（PM）".
 * - Task budget (implement / ops rounds) — the exact complement of the
 * review/audit rounds (implement/ops, including non-audit docs/Prepare and
 * orientation roles) must carry a non-empty `task_budget` value that is not
 * `N/A` (presence-only; adequacy stays in PM's Prepare check): capacity
 * contract spec § A1–A3.
 * - Default-protected-branch gate — no writable work on `main`/`master`
 * unless the Assignment carries an explicit `branch_policy: direct on
 * <branch> — <reason>` exception: `mstar-branch-worktree` SKILL.md
 * § "Git 功能分支门禁（业务仓库）" § 默认规则.
 * - N→seat mapping — sdd → 3 , inline → 1
 * (qc.md), targeted re-review → listed seats: `mstar-dispatch-gates`
 * SKILL.md § "QC tri-review（SDD 强制）" / "QC 单席（例外）" / "QC
 * targeted re-review" + `mstar-roles` SKILL.md "QC reviewer" 参数表.
 * - Tri identity — initial wave exactly `qc-specialist` / `qc-specialist-2`
 * / `qc-specialist-3`: `mstar-dispatch-gates` SKILL.md § "QC tri-review"
 * + `mstar-roles` SKILL.md QC reviewer 参数表.
 * - Anti-recursion — leaf executor MUST NOT invoke a Task/subagent whose
 * role binding (`subagent_type` / `agent` / `subagent`) equals its own
 * `execute_as` (NEVER red line): `mstar-dispatch-gates` SKILL.md
 * § "承接方反递归红线（NEVER / DO NOT；leaf executor 必读）".
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antiRecursionPrecheck,
  assertDefaultBranchProtected,
  assertTriIdentity,
  assignmentHeaderRegion,
  composeDispatchGate,
  executionModeToN,
  isReadOnlyAssignmentRole,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseAssignmentFieldsFromFrontmatter,
  parseBranchPolicyDirectOnBranch,
  parseEnforcementFlag,
  parseEnforcementFlagFromFrontmatter,
  validateAssignmentFields,
  readAssignmentSource,
} from "../src/dispatch.js";
import { validateDocumentFrontmatter } from "../src/document-schema.js";

/** snake_case keys the fixture builder emits; arrays become YAML block lists. */
type FixtureValue = string | string[] | undefined;

/** Minimal well-formed writable assignment (all required fields + one branch form). */
const VALID_ASSIGNMENT = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/foo
execution_mode: sdd
task_budget: S — one implementer round closing the declared Files and gates
---

## Assignment
`;

/** Override keys may use the snake_case front matter spelling directly. */
function assignment(overrides: Record<string, FixtureValue>): string {
  const base: Record<string, FixtureValue> = {
    execute_as: "fullstack-dev",
    delegation: "forbidden",
    task_category: "logic",
    working_branch: "feature/foo",
  };
  const merged: Record<string, FixtureValue> = { ...base, ...overrides };
  const lines = ["---"];
  for (const [field, value] of Object.entries(merged)) {
    // `undefined` overrides DROP the field — the missing-field probes rely on it.
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${field}: []`);
      } else {
        lines.push(`${field}:`);
        for (const item of value) lines.push(`- ${item}`);
      }
    } else {
      lines.push(`${field}: ${value}`);
    }
  }
  lines.push("---", "", "## Assignment", "");
  return lines.join("\n");
}

/**
 * why: the dispatch gate resolves its control root from `cwd`, so a case that
 * omits one reads whatever checkout is running the suite and flips on that
 * checkout's Git state; a fixture keeps the verdict the case asserts. `harness`
 * adds the `.mstar/` marker the control-root leg requires; `dirty` edits a
 * tracked file so the leg refuses.
 */
function gateFixture(opts: { prefix?: string; harness?: boolean; dirty?: boolean } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), opts.prefix ?? "dispatch-gate-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, ".gitignore"), ".mstar/\n");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  if (opts.harness === true) mkdirSync(join(root, ".mstar"), { recursive: true });
  if (opts.dirty === true) writeFileSync(join(root, "README.md"), "fixture edited\n");
  return root;
}
describe("validateAssignmentFields — required field matrix", () => {
  test("accepts a complete writable assignment", () => {
    const result = validateAssignmentFields(VALID_ASSIGNMENT);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("missing execute_as → assignment.field.execute-as", () => {
    const r = validateAssignmentFields(assignment({ execute_as: undefined }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.execute-as")).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.delegation")).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.task-category")).toBe(false);
  });

  test("missing core fields carry the legacy presence codes as aliases (single parser)", () => {
    const r = validateAssignmentFields(assignment({ execute_as: undefined }));
    const executeAs = r.violations.find((v) => v.code === "assignment.field.execute-as");
    expect(executeAs).toBeDefined();
 // Exactly ONE violation for the missing field — the presence namespace is
 // an alias on it, not a second stacked violation.
    expect(r.violations.filter((v) => v.message.includes("execute_as"))).toHaveLength(1);
    expect(executeAs!.aliases).toContain("assignment.presence.missing-execute-as");
 // Branch-form violations carry no presence alias.
    const branchMissing = r.violations.find((v) => v.code === "assignment.field.branch-missing");
    expect(branchMissing?.aliases).toBeUndefined();
  });

  test("missing delegation → assignment.field.delegation", () => {
    const r = validateAssignmentFields(assignment({ delegation: undefined }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.delegation")).toBe(true);
  });

  test("missing task_category → assignment.field.task-category", () => {
    const r = validateAssignmentFields(assignment({ task_category: undefined }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.task-category")).toBe(true);
  });

  test("empty required values → assignment.field.* (one code per field, missing or empty)", () => {
    const text = `---
execute_as:
delegation: ""
task_category: logic
working_branch: feature/foo
---

## Assignment
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    const executeAs = r.violations.filter((v) => v.code === "assignment.field.execute-as");
    expect(executeAs).toHaveLength(1);
    expect(executeAs[0]!.message).toContain("non-empty");
    const delegation = r.violations.filter((v) => v.code === "assignment.field.delegation");
    expect(delegation).toHaveLength(1);
    expect(delegation[0]!.message).toContain("non-empty");
    expect(r.violations.some((v) => v.code === "assignment.field.task-category")).toBe(false);
  });

  test("paste-only shell (fenced but no fields at all) flags every required field + branch form", () => {
    const r = validateAssignmentFields("---\n---\n\n## Assignment\n\n(empty)\n");
    expect(r.ok).toBe(false);
    const codes = r.violations.map((v) => v.code);
    expect(codes).toContain("assignment.field.execute-as");
    expect(codes).toContain("assignment.field.delegation");
    expect(codes).toContain("assignment.field.task-category");
    expect(codes).toContain("assignment.field.branch-missing");
  });

  test("a body `**Execute as**: x` line is ignored — the front matter is the only field source", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/foo
---

## Assignment

**Execute as**: scout
**Enforcement**: hard
`;
    expect(parseAssignmentFields(text).executeAs).toBe("fullstack-dev");
    expect(parseEnforcementFlag(text).hard).toBe(false);
  });
});

describe("control write host gate", () => {
  test("validates the control checkout, branch forms and target ownership", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-control-")));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      writeFileSync(join(root, ".gitignore"), ".mstar/\n");
      git("add", ".gitignore");
      git("commit", "-qm", "fixture");
      const linked = join(root, "linked");
      git("worktree", "add", "-q", "-b", "feature/test", linked);
      const base: Record<string, FixtureValue> = { write_domain: "control", worktree_path: root, working_branch: "main", control_write_paths: [".mstar/plans/run.md"], task_budget: "one round", enforcement: "hard" };
      expect(composeDispatchGate(assignment(base), { cwd: root }).ok).toBe(true);
      expect(composeDispatchGate(assignment({ ...base, worktree_path: linked }), { cwd: root }).violations.map((v) => v.code)).toContain("dispatch.control-write.worktree-not-control");
      expect(composeDispatchGate(assignment({ ...base, control_write_paths: ["tracked.txt"] }), { cwd: root }).violations.map((v) => v.code)).toContain("dispatch.control-write.target-committable");
      const direct = { ...base, working_branch: undefined, branch_policy: "direct on main — maintenance" };
      expect(validateAssignmentFields(assignment(direct)).ok).toBe(true);
      expect(composeDispatchGate(assignment(direct), { cwd: root }).ok).toBe(true);
      expect(composeDispatchGate(assignment({ ...direct, branch_policy: "direct on other — maintenance" }), { cwd: root }).violations.map((v) => v.code)).toContain("dispatch.control-write.branch-mismatch");
      expect(composeDispatchGate(assignment(base), { cwd: join(root, "missing") }).violations.map((v) => v.code)).toContain("dispatch.control-write.control-root-unresolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("composeDispatchGate — control root tracked-change leg (writable)", () => {
  test("a writable dispatch on a dirty harness control root is refused", () => {
    const root = gateFixture({ prefix: "dispatch-dirty-control-", harness: true, dirty: true });
    try {
      const refused = composeDispatchGate(assignment({ write_domain: "work", task_budget: "one round" }), { cwd: root });
      expect(refused.violations.map((v) => v.code)).toContain("worktree.main.tracked-changes");
      expect(refused.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a writable control-domain dispatch is gated too — the question is domain-independent", () => {
    const root = gateFixture({ prefix: "dispatch-dirty-control-domain-", harness: true, dirty: true });
    try {
      const text = assignment({ write_domain: "control", worktree_path: root, working_branch: "main", control_write_paths: [".mstar/plans/run.md"], task_budget: "one round" });
      const refused = composeDispatchGate(text, { cwd: root });
      expect(refused.violations.map((v) => v.code)).toContain("worktree.main.tracked-changes");
      expect(refused.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("a clean harness control root passes and read-only roles are unaffected", () => {
    const root = gateFixture({ prefix: "dispatch-clean-control-", harness: true });
    try {
      expect(composeDispatchGate(assignment({ write_domain: "work", task_budget: "one round" }), { cwd: root }).ok).toBe(true);
      // invariant: ignored process state never dirties the gate.
      writeFileSync(join(root, ".mstar", "status.json"), "{}\n");
      expect(composeDispatchGate(assignment({ write_domain: "work", task_budget: "one round" }), { cwd: root }).ok).toBe(true);
      // invariant: the read-only leg skips the tracked-change gate even on a dirty root.
      writeFileSync(join(root, "README.md"), "fixture edited\n");
      expect(composeDispatchGate(assignment({ write_domain: "work", task_budget: "one round" }), { cwd: root, writable: false }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("control write assignment fields", () => {
  const base: Record<string, FixtureValue> = {
    write_domain: "control",
    worktree_path: "/control",
    working_branch: "main",
    control_write_paths: [".mstar/plans/run.md"],
    task_budget: "one round",
  };

  test("parses fields and block-list paths from the front matter", () => {
    const fields = parseAssignmentFieldsFromFrontmatter("worktree_path: /control\nwrite_domain: control\ncontrol_write_paths:\n- a\n- b\n- c\n");
    expect(fields.worktreePath).toBe("/control");
    expect(fields.writeDomain).toBe("control");
    expect(fields.controlWritePaths).toEqual(["a", "b", "c"]);
  });

  test("accepts control and work, rejects unknown domains", () => {
    expect(validateAssignmentFields(assignment(base)).ok).toBe(true);
    expect(validateAssignmentFields(assignment({ ...base, write_domain: "work" })).ok).toBe(true);
    const result = validateAssignmentFields(assignment({ ...base, write_domain: "other" }));
    expect(result.violations.some((v) => v.code === "assignment.field.write-domain-unknown" && v.severity === "high" && v.fix)).toBe(true);
  });

  test("requires both control fields and preserves the branch-form gate", () => {
    const missing = validateAssignmentFields(assignment({ ...base, worktree_path: undefined, working_branch: undefined }));
    const codes = missing.violations.map((v) => v.code);
    expect(codes).toContain("assignment.field.control-write-missing-worktree");
    expect(codes).toContain("assignment.field.control-write-missing-branch");
    expect(codes).toContain("assignment.field.branch-missing");
    const missingPaths = validateAssignmentFields(assignment({ ...base, control_write_paths: [] }));
    expect(missingPaths.violations.map((v) => v.code)).toContain("assignment.field.control-write-paths-missing");
    const glob = validateAssignmentFields(assignment({ ...base, control_write_paths: [".mstar/plans/*.md"] }));
    expect(glob.violations.map((v) => v.code)).toContain("assignment.field.control-write-path-invalid");
    const multiple = validateAssignmentFields(assignment({ ...base, branch_policy: "direct on main - reason" }));
    expect(multiple.violations.map((v) => v.code)).toContain("assignment.field.branch-multiple");
  });
});
describe("validateAssignmentFields — branch-form matrix (writable)", () => {
 // Implement/ops rounds must carry the task_budget capacity field (spec § A1)
 // — every otherwise-valid fixture here gains it so the branch-form cases
 // stay the only thing under test.
  const TASK_BUDGET = { task_budget: "S — one focused implementer round" };

  test("working_branch: <existing> is a valid single form", () => {
    const r = validateAssignmentFields(assignment({ working_branch: "feature/foo", ...TASK_BUDGET }));
    expect(r.ok).toBe(true);
  });

  test("working_branch: create <new> from <base> is valid (branch base)", () => {
    const r = validateAssignmentFields(
      assignment({ working_branch: "create feature/part2 from feature/foo", ...TASK_BUDGET }),
    );
    expect(r.ok).toBe(true);
  });

  test("working_branch: create <new> from current is valid (current HEAD base)", () => {
    const r = validateAssignmentFields(
      assignment({ working_branch: "create feature/bar from current", ...TASK_BUDGET }),
    );
    expect(r.ok).toBe(true);
  });

  test("branch_policy: direct on <branch> — <reason> is a valid single form", () => {
    const r = validateAssignmentFields(
      assignment({ working_branch: undefined, branch_policy: "direct on main — team hotfix convention", ...TASK_BUDGET }),
    );
    expect(r.ok).toBe(true);
  });

  test("branch_policy separators (- -- –) are valid single forms", () => {
    for (const sep of ["-", "--", "–"]) {
      const r = validateAssignmentFields(
        assignment({ working_branch: undefined, branch_policy: `direct on main ${sep} team hotfix convention`, ...TASK_BUDGET }),
      );
      expect(r.ok).toBe(true);
    }
  });

  test("empty working_branch does not count as a form (treated as absent)", () => {
    const r = validateAssignmentFields(
      assignment({ working_branch: "", branch_policy: "direct on main — team hotfix convention", ...TASK_BUDGET }),
    );
    expect(r.ok).toBe(true);
  });

  test("no branch form → assignment.field.branch-missing", () => {
    const r = validateAssignmentFields(assignment({ working_branch: undefined }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing")).toBe(true);
  });

  test("working_branch + branch_policy together → assignment.field.branch-multiple", () => {
    const r = validateAssignmentFields(assignment({ branch_policy: "direct on main — hotfix" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-multiple")).toBe(true);
  });

  test("create form without <base> → assignment.field.branch-missing-base", () => {
    const r = validateAssignmentFields(assignment({ working_branch: "create feature/part2" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("create form with dangling 'from' ('create feature/x from') → assignment.field.branch-missing-base", () => {
    const r = validateAssignmentFields(assignment({ working_branch: "create feature/x from" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("create form with 'from' but no name ('create from main') → assignment.field.branch-missing-base", () => {
    const r = validateAssignmentFields(assignment({ working_branch: "create from main" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("create form with dangling words is not a create-form match (treated as existing branch)", () => {
    const r = validateAssignmentFields(
      assignment({ working_branch: "create foo from bar extra", task_budget: "S" }),
    );
    expect(r.ok).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(false);
  });

  test("existing branch names that merely start with 'create' pass as existing-branch forms", () => {
    for (const name of ["created", "create/foo", "create-user-flow"]) {
      const r = validateAssignmentFields(
        assignment({ working_branch: name, task_budget: "S" }),
      );
      expect(r.ok).toBe(true);
      expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(false);
    }
  });

  test("capitalized create form 'Create new-branch from main' is a valid create form", () => {
    const r = validateAssignmentFields(
      assignment({ working_branch: "Create new-branch from main", task_budget: "S" }),
    );
    expect(r.ok).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(false);
  });

  test("uppercase create form without <base> ('CREATE new-branch') → assignment.field.branch-missing-base", () => {
    const r = validateAssignmentFields(assignment({ working_branch: "CREATE new-branch" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("create form 'create foo' without <base> → assignment.field.branch-missing-base", () => {
    const r = validateAssignmentFields(assignment({ working_branch: "create foo" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("branch_policy without reason → assignment.field.branch-policy-missing-reason", () => {
    const r = validateAssignmentFields(assignment({ working_branch: undefined, branch_policy: "direct on main" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-policy-missing-reason")).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-policy-missing-branch")).toBe(false);
  });

  test("branch_policy without branch → assignment.field.branch-policy-missing-branch", () => {
    const r = validateAssignmentFields(assignment({ working_branch: undefined, branch_policy: "direct on" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-policy-missing-branch")).toBe(true);
  });

  test("unparseable branch_policy → assignment.field.branch-policy-missing-branch", () => {
    const r = validateAssignmentFields(assignment({ working_branch: undefined, branch_policy: "merge to main" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-policy-missing-branch")).toBe(true);
  });

  test("writable:false skips the branch-form gate (read-only assignment)", () => {
    const r = validateAssignmentFields(
      assignment({ execute_as: "scout", task_category: "deep", working_branch: undefined, task_budget: "XS — one orientation round" }),
      { writable: false },
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateAssignmentFields — review-seat / audit round bounding gate", () => {
 // The gate is independent of `writable` — review seats are read-only
 // assignments, so every probe here runs with `writable: false` unless it
 // exercises the writable path explicitly.
  const ROUND_FIELD_CODES = ["assignment.field.budget-missing", "assignment.field.return-shape-missing"];
  const roundFieldViolations = (text: string) =>
    validateAssignmentFields(text, { writable: false }).violations.filter((v) =>
      ROUND_FIELD_CODES.includes(v.code),
    );
  const budgetViolations = (text: string) =>
    roundFieldViolations(text).filter((v) => v.code === "assignment.field.budget-missing");
  const returnShapeViolations = (text: string) =>
    roundFieldViolations(text).filter((v) => v.code === "assignment.field.return-shape-missing");
  const COMPLETE_ROUND = {
    budget: "<= 12 file opens / <= 10 minutes",
    return_shape: "verdict + findings; findings: [] when clean",
  };

  test("review seat without budget → assignment.field.budget-missing (high, actionable fix)", () => {
    const r = validateAssignmentFields(assignment({ execute_as: "qc-specialist", ...COMPLETE_ROUND, budget: undefined }));
    expect(r.ok).toBe(false);
    const violation = r.violations.find((v) => v.code === "assignment.field.budget-missing");
    expect(violation).toBeDefined();
    expect(violation!.severity).toBe("high");
    expect(violation!.message).toContain("qc-specialist");
    expect(violation!.message).toContain("the field is absent");
 // The fix must name the front matter key and the tighten-only rule — a PM
 // reading only the violation can repair the Assignment.
    expect(violation!.fix).toContain("budget:");
    expect(violation!.fix).toContain("never loosen it");
  });

  test("review seat missing only return_shape → exactly assignment.field.return-shape-missing", () => {
    const r = validateAssignmentFields(
      assignment({ execute_as: "code-reviewer", ...COMPLETE_ROUND, return_shape: undefined }),
      { writable: false },
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toEqual(["assignment.field.return-shape-missing"]);
    const violation = r.violations[0]!;
    expect(violation.severity).toBe("high");
    expect(violation.message).toContain("code-reviewer");
    expect(violation.message).toContain("the field is absent");
    expect(violation.fix).toContain("return_shape:");
  });

  test("audit task_category gates a non-QC executor, one code per missing field", () => {
    const r = validateAssignmentFields(
      assignment({ execute_as: "architect", task_category: "audit" }),
      { writable: false },
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toEqual([
      "assignment.field.budget-missing",
      "assignment.field.return-shape-missing",
    ]);
    expect(r.violations[0]!.message).toContain("audit round");
    expect(r.violations[0]!.message).toContain("Task category: audit");
  });

  test("audit round passes with both fields; a `secondary` suffix still gates", () => {
    expect(
      validateAssignmentFields(
        assignment({ execute_as: "code-reviewer", task_category: "audit", ...COMPLETE_ROUND }),
      ).ok,
    ).toBe(true);
    expect(
      roundFieldViolations(assignment({ execute_as: "architect", task_category: "audit (secondary)" })),
    ).toHaveLength(2);
 // `audit_secondary` is the same suffix written with an underscore — still a
 // leading `audit` token, because only an ALPHANUMERIC next char excludes it.
    expect(
      roundFieldViolations(assignment({ execute_as: "architect", task_category: "audit_secondary" })),
    ).toHaveLength(2);
 // Only a LEADING `audit` triggers the gate — other categories stay untouched.
    expect(roundFieldViolations(assignment({ execute_as: "architect", task_category: "deep" }))).toHaveLength(0);
    expect(roundFieldViolations(assignment({ execute_as: "architect", task_category: "auditing" }))).toHaveLength(0);
  });

  test("implement round is unaffected by the round-bounding fields", () => {
    expect(validateAssignmentFields(assignment({ working_branch: "feature/impl", task_budget: "S — one focused implementer round" })).ok).toBe(true);
  });

  test("budget satisfies the gate", () => {
    expect(
      validateAssignmentFields(
        assignment({ execute_as: "qc-specialist-2", ...COMPLETE_ROUND }),
      ).ok,
    ).toBe(true);
  });

  test("N/A never satisfies the gate (case-insensitive) — it is an implement / ops value", () => {
    for (const value of ["N/A", "n/a", "N/a"]) {
      const violations = budgetViolations(assignment({ execute_as: "code-reviewer", ...COMPLETE_ROUND, budget: value }));
      expect(violations).toHaveLength(1);
      expect(violations[0]!.message).toContain("N/A");
    }
    const returnShape = assignment({ execute_as: "code-reviewer", ...COMPLETE_ROUND, return_shape: "n/a" });
    expect(returnShapeViolations(returnShape)).toHaveLength(1);
    expect(returnShapeViolations(returnShape)[0]!.message).toContain("N/A");
  });

  test("empty budget value does not satisfy the gate", () => {
    const violations = budgetViolations(assignment({ execute_as: "qc-specialist-3", ...COMPLETE_ROUND, budget: "" }));
    expect(violations).toHaveLength(1);
  });

  test("@mention, case and trailing annotation still resolve to the seat", () => {
    expect(budgetViolations(assignment({ execute_as: "@QC-Specialist" }))).toHaveLength(1);
    expect(
      roundFieldViolations(
        assignment({ execute_as: "qc-specialist-2 (security lens)", ...COMPLETE_ROUND }),
      ),
    ).toHaveLength(0);
  });

  test("every review seat is gated; other roles are unaffected", () => {
    for (const seat of ["qc-specialist", "qc-specialist-2", "qc-specialist-3", "code-reviewer"]) {
      expect(roundFieldViolations(assignment({ execute_as: seat }))).toHaveLength(2);
    }
    for (const role of ["fullstack-dev", "architect", "ops-engineer", "product-manager", "scout"]) {
      expect(roundFieldViolations(assignment({ execute_as: role, task_category: "logic" }))).toHaveLength(0);
    }
  });

  test("read-only review seat is gated (writable:false skips only the branch-form gate)", () => {
    const r = validateAssignmentFields(
      assignment({ execute_as: "qc-specialist", task_category: "review", working_branch: undefined }),
      { writable: false },
    );
    expect(r.violations.map((v) => v.code)).toEqual([
      "assignment.field.budget-missing",
      "assignment.field.return-shape-missing",
    ]);
  });

  test("body-quoted round-bounding keys do not satisfy the gate", () => {
    const text = `---
execute_as: qc-specialist
delegation: forbidden
task_category: review
working_branch: feature/review-seat-machine-gates
---

## Assignment

## Task 1: Review the diff

Reproduce this shape in your own front matter:
budget: <= 12 file opens
return_shape: verdict + findings
`;
    const r = validateAssignmentFields(text, { writable: false });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toEqual([
      "assignment.field.budget-missing",
      "assignment.field.return-shape-missing",
    ]);
  });

  test("body-quoted working_branch does not satisfy the branch-form gate", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — one focused implementer round
---

## Assignment

## Task 1: Implement

working_branch: feature/foo
`;
    expect(validateAssignmentFields(text).violations.map((v) => v.code)).toEqual([
      "assignment.field.branch-missing",
    ]);
  });
});
describe("Task budget assignment gate", () => {
 // Capacity contract spec § A1–A3: the exact complement of the review/audit
 // branch — implement/ops rounds (including non-audit docs/Prepare and
 // orientation roles) must declare `task_budget`, presence-only. Same
 // normalized `role` / `auditRound` values; `writable: false` is NOT a
 // capacity exemption; adequacy stays in PM's Prepare check.
  const BUDGET = "S — one implementer round closing the declared Files and gates";
  const taskBudgetViolations = (text: string, opts: Parameters<typeof validateAssignmentFields>[1] = {}) =>
    validateAssignmentFields(text, opts).violations.filter((v) => v.code === "assignment.field.task-budget-missing");

  test("absent task_budget → assignment.field.task-budget-missing (high, actionable fix)", () => {
    const r = validateAssignmentFields(assignment({}));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toEqual(["assignment.field.task-budget-missing"]);
    const v = r.violations[0]!;
    expect(v.severity).toBe("high");
    expect(v.message).toContain("Task budget");
    expect(v.message).toContain("the field is absent");
    expect(v.fix).toContain("task_budget:");
    expect(v.fix).toContain("A1");
  });

  test("empty task_budget value fails (the field is empty)", () => {
    const violations = taskBudgetViolations(assignment({ task_budget: "" }));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("the field is empty");
  });

  test("N/A never satisfies the gate (case-insensitive)", () => {
    for (const value of ["N/A", "n/a", "N/a"]) {
      const violations = taskBudgetViolations(assignment({ task_budget: value }));
      expect(violations).toHaveLength(1);
      expect(violations[0]!.message).toContain('the value is "N/A"');
    }
  });

  test("a non-empty task_budget satisfies the gate", () => {
    expect(validateAssignmentFields(assignment({ task_budget: BUDGET })).ok).toBe(true);
  });

  test("presence-only: any non-empty non-N/A value passes — adequacy stays in PM's Prepare check", () => {
    expect(validateAssignmentFields(assignment({ task_budget: "when it is done" })).ok).toBe(true);
  });

  test("normalized review role is exempt from the task_budget gate (round-bounding fields still required)", () => {
    const r = validateAssignmentFields(assignment({ execute_as: "@QC-Specialist (security lens)" }));
    expect(r.violations.some((v) => v.code === "assignment.field.task-budget-missing")).toBe(false);
    expect(r.violations.map((v) => v.code)).toEqual([
      "assignment.field.budget-missing",
      "assignment.field.return-shape-missing",
    ]);
  });

  test("audit task_category is exempt from the task_budget gate", () => {
    const r = validateAssignmentFields(assignment({ execute_as: "architect", task_category: "audit" }));
    expect(r.violations.some((v) => v.code === "assignment.field.task-budget-missing")).toBe(false);
    expect(r.violations.map((v) => v.code)).toEqual([
      "assignment.field.budget-missing",
      "assignment.field.return-shape-missing",
    ]);
  });

  test("audit_secondary stays an audit round — exempt", () => {
    const r = validateAssignmentFields(assignment({ execute_as: "architect", task_category: "audit_secondary" }));
    expect(r.violations.some((v) => v.code === "assignment.field.task-budget-missing")).toBe(false);
  });

  test("`auditing` is NOT an audit round — the task_budget gate applies", () => {
    const r = validateAssignmentFields(assignment({ execute_as: "fullstack-dev", task_category: "auditing" }));
    expect(r.violations.map((v) => v.code)).toEqual(["assignment.field.task-budget-missing"]);
  });

  test("non-audit docs round (Prepare/docs specialist) receives the field requirement", () => {
    const r = validateAssignmentFields(assignment({ execute_as: "product-manager", task_category: "docs" }));
    expect(r.violations.map((v) => v.code)).toEqual(["assignment.field.task-budget-missing"]);
  });

  test("read-only orientation role is not exempt; writable:false is not a capacity exemption (A3)", () => {
    const text = assignment({ execute_as: "scout", task_category: "deep", working_branch: undefined });
    expect(validateAssignmentFields(text, { writable: false }).violations.map((v) => v.code)).toEqual([
      "assignment.field.task-budget-missing",
    ]);
    expect(
      validateAssignmentFields(assignment({ execute_as: "scout", task_category: "deep", task_budget: "XS — one orientation round" }), {
        writable: false,
      }).ok,
    ).toBe(true);
  });
});

describe("assertDefaultBranchProtected — default-branch gate", () => {
  test("main is protected without an exception", () => {
    const r = assertDefaultBranchProtected("main");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "dispatch.default-branch.protected")).toBe(true);
  });

  test("master is protected without an exception", () => {
    const r = assertDefaultBranchProtected("master");
    expect(r.ok).toBe(false);
  });

  test("feature branch is not protected", () => {
    expect(assertDefaultBranchProtected("feature/foo").ok).toBe(true);
  });

  test("direct-on exception lifts the gate", () => {
    const r = assertDefaultBranchProtected("main", { directOnException: true });
    expect(r.ok).toBe(true);
  });

  test("custom default-branch list is honored", () => {
    expect(assertDefaultBranchProtected("trunk").ok).toBe(true);
    const r = assertDefaultBranchProtected("trunk", { defaultBranches: ["main", "trunk"] });
    expect(r.ok).toBe(false);
  });

  test("empty branch string does not trip the gate", () => {
    expect(assertDefaultBranchProtected("").ok).toBe(true);
  });
});

describe("executionModeToN — N→seat mapping", () => {
  test("sdd → 3 (tri-review)", () => {
    const r = executionModeToN("sdd");
    expect(r.ok).toBe(true);
    expect(r.n).toBe(3);
  });

  test("inline → 1 (single seat)", () => {
    const r = executionModeToN("inline");
    expect(r.ok).toBe(true);
    expect(r.n).toBe(1);
  });

  test("sdd with trailing context (e.g. 'sdd (Task 1/6)') → 3", () => {
    const r = executionModeToN("sdd (Task 1/6)");
    expect(r.ok).toBe(true);
    expect(r.n).toBe(3);
  });

  test("targeted → listed seat count", () => {
    const seats = ["qc-specialist", "qc-specialist-3"];
    const r = executionModeToN("targeted", { seats });
    expect(r.ok).toBe(true);
    expect(r.n).toBe(2);
  });

  test("targeted with a single seat → 1", () => {
    const r = executionModeToN("targeted", { seats: ["qc-specialist-2"] });
    expect(r.ok).toBe(true);
    expect(r.n).toBe(1);
  });

  test("targeted duplicate seats are deduped before counting : [a,a,b] → 2", () => {
    const r = executionModeToN("targeted", { seats: ["qc-specialist", "qc-specialist", "qc-specialist-3"] });
    expect(r.ok).toBe(true);
    expect(r.n).toBe(2);
  });

  test("targeted all-duplicate seats → 1 distinct seat", () => {
    const r = executionModeToN("targeted", { seats: ["qc-specialist", "qc-specialist", "qc-specialist"] });
    expect(r.ok).toBe(true);
    expect(r.n).toBe(1);
  });

  test("targeted duplicate-heavy list within the 3-seat band → ok (unique ≤ 3)", () => {
    const r = executionModeToN("targeted", {
      seats: ["qc-specialist", "qc-specialist", "qc-specialist-2", "qc-specialist-2", "qc-specialist-3"],
    });
    expect(r.ok).toBe(true);
    expect(r.n).toBe(3);
  });

  test("targeted 4+ DISTINCT seats still → dispatch.execution-mode.too-many-seats", () => {
    const seats = ["qc-specialist", "qc-specialist-2", "qc-specialist-3", "qc-specialist-4"];
    const r = executionModeToN("targeted", { seats });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "dispatch.execution-mode.too-many-seats")).toBe(true);
  });

  test("targeted without seats → dispatch.execution-mode.missing-seats", () => {
    const r = executionModeToN("targeted");
    expect(r.ok).toBe(false);
    expect(r.n).toBeUndefined();
    expect(r.violations.some((v) => v.code === "dispatch.execution-mode.missing-seats")).toBe(true);
  });

  test("targeted with exactly 3 seats → 3 (upper band, full tri)", () => {
    const seats = ["qc-specialist", "qc-specialist-2", "qc-specialist-3"];
    const r = executionModeToN("targeted", { seats });
    expect(r.ok).toBe(true);
    expect(r.n).toBe(3);
  });

  test("targeted with 4+ seats → dispatch.execution-mode.too-many-seats", () => {
    const seats = ["qc-specialist", "qc-specialist-2", "qc-specialist-3", "qc-specialist-4"];
    const r = executionModeToN("targeted", { seats });
    expect(r.ok).toBe(false);
    expect(r.n).toBeUndefined();
    expect(r.violations.some((v) => v.code === "dispatch.execution-mode.too-many-seats")).toBe(true);
  });

  test("unknown mode → dispatch.execution-mode.unknown", () => {
    const r = executionModeToN("parallel");
    expect(r.ok).toBe(false);
    expect(r.n).toBeUndefined();
    expect(r.violations.some((v) => v.code === "dispatch.execution-mode.unknown")).toBe(true);
  });

  test("empty mode → dispatch.execution-mode.missing", () => {
    const r = executionModeToN("");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "dispatch.execution-mode.missing")).toBe(true);
  });
});

describe("assertTriIdentity — tri identity gate", () => {
  const TRI = ["qc-specialist", "qc-specialist-2", "qc-specialist-3"];

  test("exact initial-wave roles pass (any order)", () => {
    expect(assertTriIdentity([...TRI]).ok).toBe(true);
    expect(assertTriIdentity([...TRI].reverse()).ok).toBe(true);
  });

  test("missing seat → dispatch.tri-identity.invalid", () => {
    const r = assertTriIdentity(["qc-specialist", "qc-specialist-2"]);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "dispatch.tri-identity.invalid")).toBe(true);
  });

  test("duplicate seat → dispatch.tri-identity.invalid", () => {
    const r = assertTriIdentity(["qc-specialist", "qc-specialist", "qc-specialist-3"]);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "dispatch.tri-identity.invalid")).toBe(true);
  });

  test("wrong role (e.g. general-purpose reviewer) → dispatch.tri-identity.invalid", () => {
    const r = assertTriIdentity(["qc-specialist", "qc-specialist-2", "reviewer"]);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "dispatch.tri-identity.invalid")).toBe(true);
  });

  test("empty roles → dispatch.tri-identity.invalid", () => {
    const r = assertTriIdentity([]);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "dispatch.tri-identity.invalid")).toBe(true);
  });
});

describe("antiRecursionPrecheck — self-type NEVER red line", () => {
  test("subagent_type == execute_as → critical dispatch.anti-recursion.self-type", () => {
    const r = antiRecursionPrecheck("fullstack-dev", "fullstack-dev");
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.code).toBe("dispatch.anti-recursion.self-type");
    expect(r.violations[0]!.severity).toBe("critical");
  });

  test("matching host role-binding fields (agent / subagent / subagent_type) are flagged", () => {
    expect(antiRecursionPrecheck("qc-specialist", "qc-specialist").ok).toBe(false);
  });

  test("comparison is case-insensitive after trim", () => {
    const r = antiRecursionPrecheck("  Fullstack-Dev ", "fullstack-dev");
    expect(r.ok).toBe(false);
  });

  test("different role binding → ok", () => {
    const r = antiRecursionPrecheck("reviewer", "fullstack-dev");
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test("empty binding → critical dispatch.anti-recursion.empty-binding (fail closed)", () => {
    for (const empty of ["", "   "]) {
      const r = antiRecursionPrecheck(empty, "fullstack-dev");
      expect(r.ok).toBe(false);
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0]!.code).toBe("dispatch.anti-recursion.empty-binding");
      expect(r.violations[0]!.severity).toBe("critical");
    }
  });

  test("set binding + empty execute_as → ok (field presence is validateAssignmentFields' job)", () => {
    expect(antiRecursionPrecheck("fullstack-dev", "").ok).toBe(true);
    expect(antiRecursionPrecheck("fullstack-dev", "   ").ok).toBe(true);
  });
});
describe("parseAssignmentBranchForms — engine single branch-form grammar", () => {
  test("working_branch: <existing> → workingBranch (first token)", () => {
    expect(parseAssignmentBranchForms(assignment({ working_branch: "feature/foo" })).workingBranch).toBe("feature/foo");
  });

  test("existing-branch values with extra words keep the first token", () => {
    expect(parseAssignmentBranchForms(assignment({ working_branch: "feature/foo extra words" })).workingBranch).toBe("feature/foo");
  });

  test("create form → createForm { name, base }", () => {
    const forms = parseAssignmentBranchForms(assignment({ working_branch: "create feature/part2 from main" }));
    expect(forms.createForm).toEqual({ name: "feature/part2", base: "main" });
    expect(forms.workingBranch).toBeUndefined();
  });

  test("create form without base → createForm { name } (base undefined)", () => {
    expect(parseAssignmentBranchForms(assignment({ working_branch: "create feature/x" })).createForm).toEqual({
      name: "feature/x",
      base: undefined,
    });
  });

  test("create-form token match is case-insensitive", () => {
    expect(parseAssignmentBranchForms(assignment({ working_branch: "Create New-Branch from main" })).createForm?.name).toBe("New-Branch");
  });

  test("dangling 'create X from' is a create-form (base empty) — fail-open fixed", () => {
    expect(parseAssignmentBranchForms(assignment({ working_branch: "create feature/x from" })).createForm).toEqual({
      name: "feature/x",
      base: "",
    });
  });

  test("'create from main' is a create-form (name empty)", () => {
    expect(parseAssignmentBranchForms(assignment({ working_branch: "create from main" })).createForm).toEqual({
      name: "",
      base: "main",
    });
  });

  test("branch names merely starting with 'create' stay existing-branch values", () => {
    for (const name of ["created", "create/foo", "create-user-flow"]) {
      const forms = parseAssignmentBranchForms(assignment({ working_branch: name }));
      expect(forms.createForm).toBeUndefined();
      expect(forms.workingBranch).toBe(name);
    }
  });

  test("'create foo from bar extra' is not a create-form (treated as existing branch)", () => {
    const forms = parseAssignmentBranchForms(assignment({ working_branch: "create foo from bar extra" }));
    expect(forms.createForm).toBeUndefined();
    expect(forms.workingBranch).toBe("create");
  });

  test("branch_policy direct on <branch> — <reason> → directOn { branch, reason }", () => {
    const forms = parseAssignmentBranchForms(
      assignment({ working_branch: "", branch_policy: "direct on main — team hotfix convention" }),
    );
    expect(forms.directOn).toEqual({ branch: "main", reason: "team hotfix convention" });
  });

  test("branch_policy separators: -- and - and – all parse the reason", () => {
    for (const sep of ["--", "-", "–"]) {
      const forms = parseAssignmentBranchForms(
        assignment({ working_branch: "", branch_policy: `direct on main ${sep} team hotfix` }),
      );
      expect(forms.directOn).toEqual({ branch: "main", reason: "team hotfix" });
    }
  });

  test("branch_policy without reason → directOn { branch, reason: '' } (loose branch capture)", () => {
    const forms = parseAssignmentBranchForms(assignment({ working_branch: "", branch_policy: "direct on main" }));
    expect(forms.directOn).toEqual({ branch: "main", reason: "" });
  });

  test("branch_policy 'direct on main -' (separator, no reason) → reason empty", () => {
    const forms = parseAssignmentBranchForms(assignment({ working_branch: "", branch_policy: "direct on main -" }));
    expect(forms.directOn).toEqual({ branch: "main", reason: "" });
  });

  test("non-direct-on branch_policy → no directOn", () => {
    expect(parseAssignmentBranchForms(assignment({ working_branch: "", branch_policy: "merge to main" })).directOn).toBeUndefined();
  });

  test("no branch fields → empty forms", () => {
    expect(parseAssignmentBranchForms(assignment({ working_branch: undefined }))).toEqual({});
  });
});

describe("parseBranchPolicyDirectOnBranch — strict direct-on exception (CLI/plugin shared)", () => {
  test("well-formed direct-on with reason → exception branch", () => {
    const text = assignment({ working_branch: "", branch_policy: "direct on main — team hotfix convention" });
    expect(parseBranchPolicyDirectOnBranch(text)).toBe("main");
  });

  test("every separator ([—–]|--|-) yields the exception branch", () => {
    for (const sep of ["—", "–", "--", "-"]) {
      const text = assignment({ working_branch: "", branch_policy: `direct on main ${sep} reason` });
      expect(parseBranchPolicyDirectOnBranch(text)).toBe("main");
    }
  });

  test("no reason → undefined (no exception)", () => {
    expect(parseBranchPolicyDirectOnBranch(assignment({ working_branch: "", branch_policy: "direct on main" }))).toBeUndefined();
  });

  test("dangling separator without reason → undefined", () => {
    expect(parseBranchPolicyDirectOnBranch(assignment({ working_branch: "", branch_policy: "direct on main -" }))).toBeUndefined();
  });

  test("non-direct-on or absent policy → undefined", () => {
    expect(parseBranchPolicyDirectOnBranch(assignment({ working_branch: "", branch_policy: "merge to main" }))).toBeUndefined();
    expect(parseBranchPolicyDirectOnBranch(assignment({ working_branch: "feature/foo" }))).toBeUndefined();
  });

  test("front matter forms win over body-quoted ones (front matter only)", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: main
---

## Assignment

## Task 1: implement

Example: working_branch: feature/body-only
branch_policy: direct on main — hotfix
`;
    expect(parseAssignmentBranchForms(text)).toEqual({ workingBranch: "main" });
    expect(parseBranchPolicyDirectOnBranch(text)).toBeUndefined();
  });
});

describe("isReadOnlyAssignmentRole — scout/explore read-only roles", () => {
  test("scout and explore are read-only (case-insensitive)", () => {
    expect(isReadOnlyAssignmentRole("scout")).toBe(true);
    expect(isReadOnlyAssignmentRole("explore")).toBe(true);
    expect(isReadOnlyAssignmentRole("  Scout ")).toBe(true);
    expect(isReadOnlyAssignmentRole("EXPLORE")).toBe(true);
  });

  test("writable roles and empty values are not read-only", () => {
    expect(isReadOnlyAssignmentRole("fullstack-dev")).toBe(false);
    expect(isReadOnlyAssignmentRole("qc-specialist")).toBe(false);
    expect(isReadOnlyAssignmentRole("")).toBe(false);
  });
});

describe("parseAssignmentFields — front matter field parser (single grammar)", () => {
  test("a complete front matter yields every typed field", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
execution_mode: sdd
working_branch: feature/foo
branch_policy: direct on main — hotfix
worktree_path: /control
write_domain: work
control_write_paths:
- .mstar/plans/run.md
- .mstar/notes/x.jsonl
budget: "<= 12 file opens"
return_shape: verdict + findings
task_budget: S — one implementer round
enforcement: hard
---

## Assignment
`;
    const fields = parseAssignmentFields(text);
    expect(fields).toEqual({
      executeAs: "fullstack-dev",
      delegation: "forbidden",
      taskCategory: "logic",
      executionMode: "sdd",
      workingBranch: "feature/foo",
      branchPolicy: "direct on main — hotfix",
      worktreePath: "/control",
      writeDomain: "work",
      controlWritePaths: [".mstar/plans/run.md", ".mstar/notes/x.jsonl"],
      budget: "<= 12 file opens",
      returnShape: "verdict + findings",
      taskBudget: "S — one implementer round",
    });
  });

  test("execution_mode joins the parsed fields", () => {
    expect(parseAssignmentFieldsFromFrontmatter("execution_mode: targeted\n").executionMode).toBe("targeted");
  });

  test("unrelated prose and unfenced body text produce no fields", () => {
    expect(parseAssignmentFields("This is not an assignment.\nNo fields here.")).toEqual({});
    expect(parseAssignmentFields("")).toEqual({});
  });

  test("F1: an unfenced key-only body is NOT an Assignment — the public path requires a real fence", () => {
    const body = "execute_as: fullstack-dev\ndelegation: forbidden\ntask_category: logic\nworking_branch: feature/foo";
    expect(parseAssignmentFields(body)).toEqual({});
    expect(assignmentHeaderRegion(body)).toBe("");
    expect(parseEnforcementFlag(`${body}\nenforcement: hard\n`)).toEqual({ hard: false, source: "none" });
  });

  test("F1: the explicit extracted-block callers read a fence-stripped block", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/foo
enforcement: hard
---

## Assignment
`;
    // A caller that split the fence itself (`extractFrontmatterAndBody`).
    const block = text.slice(4, text.indexOf("\n---"));
    expect(parseAssignmentFieldsFromFrontmatter(block)).toEqual(parseAssignmentFields(text));
    expect(parseEnforcementFlagFromFrontmatter(block)).toEqual({ hard: true, source: "assignment" });
    // The header-region boundary re-feeds a fenced fragment, so the public
    // document path stays fence-scoped for its host consumers.
    expect(parseAssignmentFields(assignmentHeaderRegion(text))).toEqual(parseAssignmentFields(text));
  });

  test("F3: an unterminated fence declares no fields (the schema refuses the document)", () => {
    const text = "---\nexecute_as: fullstack-dev\ndelegation: forbidden\ntask_category: logic\n";
    expect(parseAssignmentFields(text)).toEqual({});
    expect(parseEnforcementFlag(text)).toEqual({ hard: false, source: "none" });
  });

  test("reads the front matter only — body-quoted keys are ignored", () => {
    const text = `---
execute_as: architect
delegation: forbidden
task_category: logic
working_branch: feature/foo
---

## Assignment

## Task 1: implement

Example Assignment snippet: execute_as: scout
budget: <= 12 file opens
`;
    expect(parseAssignmentFields(text)).toEqual({
      executeAs: "architect",
      delegation: "forbidden",
      taskCategory: "logic",
      workingBranch: "feature/foo",
    });
  });

  test("the header-region boundary re-feeds a fenced fragment (idempotent for host callers)", () => {
    expect(parseAssignmentFields(assignmentHeaderRegion(VALID_ASSIGNMENT))).toEqual(parseAssignmentFields(VALID_ASSIGNMENT));
    expect(assignmentHeaderRegion(assignmentHeaderRegion(VALID_ASSIGNMENT))).toBe(assignmentHeaderRegion(VALID_ASSIGNMENT));
    expect(parseAssignmentFields(VALID_ASSIGNMENT).executeAs).toBe("fullstack-dev");
  });

  test("duplicate keys are a schema refusal — the parser never silently picks one", () => {
    const text = `---
execute_as: fullstack-dev
execute_as: architect
delegation: forbidden
task_category: logic
working_branch: feature/foo
---

## Assignment
`;
    expect(parseAssignmentFields(text).executeAs).toBeUndefined();
    expect(validateDocumentFrontmatter("assignment", text, "assignment").violations.some((v) => v.code === "document.frontmatter.invalid")).toBe(true);
  });

  test("invalid front matter YAML yields no fields and never throws", () => {
    const text = `---
execute_as: fullstack-dev
  bad indentation: [unclosed
---

## Assignment
`;
    expect(() => parseAssignmentFields(text)).not.toThrow();
    expect(parseAssignmentFields(text).executeAs).toBeUndefined();
  });
});

describe("validateDocumentFrontmatter — unknown-field rule (compass D15)", () => {
 // Every field of the canonical PM template is a known optional field,
 // plan_id / iteration_id / workflow_id included; `unknown` fires only for
 // a key outside the documentSchema("assignment") table.
  const BASE = "execute_as: fullstack-dev\ndelegation: forbidden\ntask_category: logic\nworking_branch: feature/x\ntask_budget: S — one round";

  test("canonical template keys including plan_id / iteration_id / workflow_id are all known", () => {
    const text = `---
${BASE}
plan_id: 20261201-synthetic-plan
iteration_id: iter-synthetic
workflow_id: wf-1
execution_mode: sdd
write_domain: work
control_write_paths:
- .mstar/notes/x.jsonl
skill_presets: standard
enforcement: hard
---

## Assignment
`;
    const gate = validateDocumentFrontmatter("assignment", text, "assignment");
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("an invented key → document.frontmatter.unknown", () => {
    const text = `---
${BASE}
invented_key: 1
---

## Assignment
`;
    const gate = validateDocumentFrontmatter("assignment", text, "assignment");
    expect(gate.ok).toBe(false);
    expect(gate.violations.some((v) => v.code === "document.frontmatter.unknown")).toBe(true);
  });

  test("validateAssignmentFields surfaces the same unknown-key violation", () => {
    const text = `---
${BASE}
invented_key: 1
---

## Assignment
`;
    const gate = validateAssignmentFields(text);
    expect(gate.ok).toBe(false);
    expect(gate.violations.some((v) => v.code === "document.frontmatter.unknown")).toBe(true);
  });

  test("validateAssignmentFields surfaces invalid front matter YAML as document.frontmatter.invalid", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
  broken: [unclosed
---

## Assignment
`;
    const gate = validateAssignmentFields(text);
    expect(gate.violations.some((v) => v.code === "document.frontmatter.invalid")).toBe(true);
  });

  test("composeDispatchGate and validateControlWriteAssignment reach the same verdicts on a front matter Assignment", () => {
    const root = gateFixture({ prefix: "dispatch-shared-frontmatter-", harness: true });
    try {
      const composed = composeDispatchGate(VALID_ASSIGNMENT, { cwd: root });
      expect(composed.ok).toBe(true);
      expect(composed.shaped).toBe(true);
      expect(validateAssignmentFields(VALID_ASSIGNMENT).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
describe("parseEnforcementFlag — enforcement: hard flag (Slice 5, roadmap §8.5 C4/D2)", () => {
 // Spec: roadmap §8.5 C4 + decision D2 — v2 hard gates are enabled per
 // Assignment/compass via the lowercase YAML key `enforcement: hard` in the
 // front matter; the flag is never global; rollback = unset flag; flag
 // inert when the engine is absent.
  test("Assignment front matter enforcement: hard → hard, source assignment", () => {
    expect(parseEnforcementFlag(`---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
enforcement: hard
---

## Assignment
`)).toEqual({
      hard: true,
      source: "assignment",
    });
  });

  test("Assignment-shaped block with a soft flag → source assignment, hard false", () => {
    expect(parseEnforcementFlagFromFrontmatter("execute_as: dev\ndelegation: forbidden\ntask_category: logic\nenforcement: soft\n")).toEqual({ hard: false, source: "assignment" });
    expect(parseEnforcementFlagFromFrontmatter("execute_as: dev\ndelegation: forbidden\ntask_category: logic\nenforcement: hard mode\n")).toEqual({ hard: false, source: "assignment" });
    expect(parseEnforcementFlagFromFrontmatter("execute_as: dev\ndelegation: forbidden\ntask_category: logic\nenforcement:\n")).toEqual({ hard: false, source: "assignment" });
  });

  test("Assignment value is case-insensitive (Hard / HARD → hard)", () => {
    for (const value of ["Hard", "HARD", "hArD"]) {
      expect(parseEnforcementFlagFromFrontmatter(`execute_as: dev\ndelegation: forbidden\ntask_category: logic\nenforcement: ${value}\n`)).toEqual({
        hard: true,
        source: "assignment",
      });
    }
  });

  test("compass frontmatter form: enforcement: hard → hard, source compass", () => {
    expect(parseEnforcementFlagFromFrontmatter("enforcement: hard\n")).toEqual({ hard: true, source: "compass" });
  });
  test("F2: the flat compass profile accepts flat-only shapes the document profile refuses", () => {
    const block = "iteration_id: 20260808-demo\nstatus: active\nreview_targets: [a,]\nenforcement: hard\n";
    // The strict document profile refuses the trailing flow-list separator,
    // so the flag vanishes; the flat profile the compass was validated with
    // keeps it.
    expect(parseEnforcementFlagFromFrontmatter(block)).toEqual({ hard: false, source: "none" });
    expect(parseEnforcementFlagFromFrontmatter(block, "flat")).toEqual({ hard: true, source: "compass" });
  });

  test("compass value may be quoted and case-insensitive", () => {
    expect(parseEnforcementFlagFromFrontmatter('enforcement: "hard"\n')).toEqual({ hard: true, source: "compass" });
    expect(parseEnforcementFlagFromFrontmatter("enforcement: 'HARD'\n")).toEqual({ hard: true, source: "compass" });
  });

  test("compass present but not hard (soft / true / empty) → source compass, hard false", () => {
    expect(parseEnforcementFlagFromFrontmatter("enforcement: soft\n")).toEqual({ hard: false, source: "compass" });
    expect(parseEnforcementFlagFromFrontmatter("enforcement: true\n")).toEqual({ hard: false, source: "compass" });
    expect(parseEnforcementFlagFromFrontmatter("enforcement:\n")).toEqual({ hard: false, source: "compass" });
  });

  test("no flag anywhere → { hard: false, source: none }", () => {
    expect(parseEnforcementFlagFromFrontmatter("execute_as: dev\ndelegation: forbidden\ntask_category: logic\n")).toEqual({
      hard: false,
      source: "none",
    });
    expect(parseEnforcementFlagFromFrontmatter("iteration_id: 20260808-demo\nstatus: active\n")).toEqual({
      hard: false,
      source: "none",
    });
    expect(parseEnforcementFlag("")).toEqual({ hard: false, source: "none" });
  });

  test("body prose and markdown enforcement examples never set the flag", () => {
    expect(parseEnforcementFlag("## Assignment\n\n**Execute as**: fullstack-dev\n**Enforcement**: hard\n")).toEqual({
      hard: false,
      source: "none",
    });
    expect(parseEnforcementFlag("Enforcement: hard\n")).toEqual({ hard: false, source: "none" });
  });

  test("compass frontmatter block inside a full compass file is detected", () => {
    const compass = `---
iteration_id: 20260808-demo
status: active
enforcement: hard
---

# Delivery Compass
`;
    expect(parseEnforcementFlag(compass)).toEqual({ hard: true, source: "compass" });
  });

  test("a body-quoted `enforcement: hard` example does not harden (front matter only)", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/example
---

## Assignment

# Change

Example Assignment front matter: enforcement: hard
`;
    expect(parseEnforcementFlag(text)).toEqual({ hard: false, source: "none" });
  });

  test("header enforcement: hard hardens even when a body example quotes a soft flag", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/example
enforcement: hard
---

## Assignment

# Change

enforcement: soft (example only)
`;
    expect(parseEnforcementFlag(text)).toEqual({ hard: true, source: "assignment" });
  });

  test("never throws on hostile input", () => {
    for (const input of ["", "*".repeat(10000), "{{{{[[[[)))) ---- \n<<<<", "enforcement" ]) {
      expect(() => parseEnforcementFlag(input)).not.toThrow();
    }
  });
});

describe("assignmentHeaderRegion — fenced front matter fragment (task boundary)", () => {
 // The export is kept for the host packages Task 5 migrates: it returns the
 // document's front matter as a self-contained FENCED fragment (never any
 // body text), so a host that re-feeds it to the front matter parsers keeps
 // the same fence-scoped read the public document path enforces.
  test("fenced document → the front matter block with its fences, no body", () => {
    const text = `---
execute_as: fullstack-dev
enforcement: hard
---

## Assignment

**Enforcement**: soft (body must not count)
`;
    const region = assignmentHeaderRegion(text);
    expect(region.startsWith("---\n")).toBe(true);
    expect(region.endsWith("\n---")).toBe(true);
    expect(region).toContain("execute_as: fullstack-dev");
    expect(region).toContain("enforcement: hard");
    expect(region).not.toContain("## Assignment");
    expect(region).not.toContain("soft");
  });

  test("body-only text (no fence) → empty slice", () => {
    expect(assignmentHeaderRegion("## Assignment\n\n**Enforcement**: hard\n")).toBe("");
    expect(assignmentHeaderRegion("# Target\nplan body only\n")).toBe("");
  });

  test("unfenced key-only text is body prose → empty slice (F1)", () => {
    expect(assignmentHeaderRegion("execute_as: fullstack-dev\nenforcement: hard")).toBe("");
  });

  test("unterminated fence → fragment without a closing fence (declares nothing)", () => {
    const region = assignmentHeaderRegion("---\nexecute_as: fullstack-dev\nenforcement: hard\n");
    expect(region).toBe("---\nexecute_as: fullstack-dev\nenforcement: hard\n");
    expect(parseAssignmentFields(region)).toEqual({});
  });

  test("idempotent on its own output", () => {
    expect(assignmentHeaderRegion(assignmentHeaderRegion(VALID_ASSIGNMENT))).toBe(assignmentHeaderRegion(VALID_ASSIGNMENT));
  });
});

describe("composeDispatchGate — shared host dispatch-gate composition", () => {
  // why: every shaped writable case below names this clean harness checkout —
  // without one, the control-root leg reads the ambient repository instead.
  const cwd = gateFixture({ prefix: "dispatch-shared-gate-", harness: true });
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

 /** Writable assignment with NO branch form — branch-missing + env-fallback targets. */
  const noBranchText = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — one focused implementer round
---

## Assignment
`;

  test("shaped writable assignment, no caller binding (target-only host) → shaped true, ok, no violations", () => {
    const result = composeDispatchGate(VALID_ASSIGNMENT, { cwd });
    expect(result.shaped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.hardBlocked).toBe(false);
    expect(result.enforcement).toEqual({ hard: false, source: "none" });
  });

  test("issue #156: no caller + no callerRequired → anti-recursion leg SKIPPED (omp/opencode compliant dispatch never self-flags)", () => {
 // The omp/opencode/cursor binding field carries the spawn TARGET, which
 // equals `execute_as` on every compliant dispatch (mstar-host omp.md C5).
 // Without a caller binding the precheck must not run at all.
    const result = composeDispatchGate(VALID_ASSIGNMENT, { cwd });
    expect(result.ok).toBe(true);
    expect(result.violations.some((v) => v.code.startsWith("dispatch.anti-recursion."))).toBe(false);
  });

  test("caller == execute_as → critical dispatch.anti-recursion.self-type", () => {
    const result = composeDispatchGate(VALID_ASSIGNMENT, { caller: "fullstack-dev", cwd });
    expect(result.ok).toBe(false);
    const anti = result.violations.find((v) => v.code === "dispatch.anti-recursion.self-type");
    expect(anti?.severity).toBe("critical");
  });

  test("caller != execute_as → no anti-recursion violation", () => {
    const result = composeDispatchGate(VALID_ASSIGNMENT, { caller: "project-manager", cwd });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("callerRequired + empty/missing caller → critical dispatch.anti-recursion.empty-binding (dsh fail-closed)", () => {
    for (const opts of [{ callerRequired: true } as const, { caller: "   ", callerRequired: true } as const]) {
      const result = composeDispatchGate(VALID_ASSIGNMENT, { ...opts, cwd });
      expect(result.ok).toBe(false);
      const anti = result.violations.find((v) => v.code === "dispatch.anti-recursion.empty-binding");
      expect(anti?.severity).toBe("critical");
    }
  });

  test("callerRequired + set caller → normal self-type semantics (no empty-binding)", () => {
    const result = composeDispatchGate(VALID_ASSIGNMENT, { caller: "project-manager", callerRequired: true, cwd });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("non-shaped text → silent shaped false result (no violations, ok)", () => {
    const result = composeDispatchGate("This is not an assignment at all.\n\nJust a plain task prompt.");
    expect(result).toEqual({
      ok: true,
      violations: [],
      shaped: false,
      enforcement: { hard: false, source: "none" },
    });
  });

  test("F3: an unterminated Assignment fence is refused through schema validation, never silently non-Assignment", () => {
    const result = composeDispatchGate(
      "---\nexecute_as: fullstack-dev\ndelegation: forbidden\ntask_category: logic\nenforcement: hard\n",
      { cwd },
    );
    expect(result.shaped).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("document.frontmatter.absent");
  });

  test("F3: ordinary prompts stay silent even when they open with a `---` rule", () => {
    for (const text of ["---\n\n# Notes\n\nprose\n", "## Assignment\n\n**Execute as**: fullstack-dev\n"]) {
      expect(composeDispatchGate(text, { cwd }).shaped).toBe(false);
    }
  });

  test("front matter without a core key is not shaped (compass-style front matter stays silent)", () => {
    const result = composeDispatchGate("---\niteration_id: iter-x\nstatus: active\n---\n\n# Compass\n", { cwd });
    expect(result.shaped).toBe(false);
  });

  test("writable text without a branch form → branch-missing violation", () => {
    const result = composeDispatchGate(noBranchText, { cwd });
    expect(result.shaped).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "assignment.field.branch-missing")).toBe(true);
  });

  test("read-only (writable: false), no caller → no branch-form, default-branch, or anti-recursion violations", () => {
    const result = composeDispatchGate(noBranchText, { writable: false });
    expect(result.shaped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("read-only (writable: false) + callerRequired + no caller → empty-binding fires (no read-only carve-out)", () => {
    const result = composeDispatchGate(noBranchText, { writable: false, callerRequired: true });
    expect(result.shaped).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === "dispatch.anti-recursion.empty-binding")).toBe(true);
  });

  test("MSTAR_WORKING_BRANCH env fallback supplies the gate branch (set/unset, restored)", () => {
    const previous = process.env.MSTAR_WORKING_BRANCH;
    try {
      process.env.MSTAR_WORKING_BRANCH = "main";
      const result = composeDispatchGate(noBranchText, { cwd });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.code === "dispatch.default-branch.protected")).toBe(true);
      expect(result.violations.some((v) => v.code === "assignment.field.branch-missing")).toBe(true);

      delete process.env.MSTAR_WORKING_BRANCH;
      const without = composeDispatchGate(noBranchText, { cwd });
      expect(without.violations.some((v) => v.code === "dispatch.default-branch.protected")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MSTAR_WORKING_BRANCH;
      else process.env.MSTAR_WORKING_BRANCH = previous;
    }
  });

  test("front matter `enforcement: hard` with violations → enforcement.hard true + hardBlocked true", () => {
    const text = `---
delegation: forbidden
task_category: logic
working_branch: main
enforcement: hard
---

## Assignment
`;
    const result = composeDispatchGate(text, { cwd });
    expect(result.enforcement).toEqual({ hard: true, source: "assignment" });
    expect(result.hardBlocked).toBe(true);
    expect(result.ok).toBe(false);
  });

  test("body-only `enforcement: hard` example → hard false (front matter only)", () => {
    const text = `---
delegation: forbidden
task_category: docs
---

## Assignment

# Change

An example Assignment front matter line: enforcement: hard
`;
    const result = composeDispatchGate(text, { cwd });
    expect(result.enforcement.hard).toBe(false);
    expect(result.hardBlocked).toBe(false);
    expect(result.ok).toBe(false); // missing execute_as still a real violation
  });

  test("valid assignment + enforcement: hard → ok, hardBlocked false", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/foo
task_budget: S — one focused implementer round
enforcement: hard
---

## Assignment
`;
    const result = composeDispatchGate(text, { caller: "project-manager", cwd });
    expect(result.enforcement).toEqual({ hard: true, source: "assignment" });
    expect(result.ok).toBe(true);
    expect(result.hardBlocked).toBe(false);
  });

  test("body-quoted branch form neither satisfies the branch gate nor redirects the default-branch gate", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: main
---

## Assignment

## Task 1: implement

Example: working_branch: feature/body-only
`;
    const result = composeDispatchGate(text, { caller: "project-manager", cwd });
    expect(result.ok).toBe(false);
    // The FRONT MATTER form (`main`) is the branch the gate checks; had the
    // body example been read, the gate would have checked `feature/body-only`
    // and silently allowed work on the default branch.
    expect(result.violations.some((v) => v.code === "dispatch.default-branch.protected")).toBe(true);
  });

  test("body-quoted `execute_as` cannot mask a self-dispatch (front matter only)", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/foo
---

## Assignment

## Task 1: implement

Example Assignment front matter: execute_as: scout
`;
    const result = composeDispatchGate(text, { caller: "fullstack-dev", cwd });
    expect(result.violations.some((v) => v.code === "dispatch.anti-recursion.self-type")).toBe(true);
  });
});
describe("readAssignmentSource — one Assignment source resolver (compass D14)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-source-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** The control harness root of this fixture; the four homes resolve under it. */
  const harnessDir = join(root, ".mstar");

  /** The assignment front matter body every pointer target below carries. */
  const FILE_ASSIGNMENT = VALID_ASSIGNMENT.replace("feature/foo", "feature/from-file");

  function writeHomeFile(home: string[]): string {
    const dir = join(root, ...home);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "assignment.md");
    writeFileSync(file, FILE_ASSIGNMENT);
    return file;
  }

  // The three write homes (`<base>/<one segment>/assignments`) plus the
  // read-only flat harness home `{HARNESS_DIR}/assignments`.
  const homeCases: Array<{ name: string; segments: string[] }> = [
    { name: "sdd write home", segments: [".mstar", "sdd", "plan-1", "assignments"] },
    { name: "iteration write home", segments: [".mstar", "iterations", "iter-1", "assignments"] },
    { name: "workflow write home", segments: [".mstar", "workflows", "wf-1", "assignments"] },
    { name: "harness read-only flat home", segments: [".mstar", "assignments"] },
  ];

  for (const home of homeCases) {
    test(`pointer inside the ${home.name} reads the file`, () => {
      const file = writeHomeFile(home.segments);
      const result = readAssignmentSource(`Assignment file: ${file}\n`, { harnessDir });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.text).toBe(FILE_ASSIGNMENT);
      expect(result.path).toBe(file);
    });
  }

  test("pointer outside every home refuses dispatch.assignment.path with both recoveries", () => {
    const file = join(root, "outside.md");
    writeFileSync(file, FILE_ASSIGNMENT);
    const result = readAssignmentSource(`Assignment file: ${file}\n`, { harnessDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("dispatch.assignment.path");
    expect(result.message).toContain(file);
    expect(result.fix).toContain("accepted assignment home");
    expect(result.fix).toContain("inline");
  });

  test("missing file inside a home refuses naming the path", () => {
    const dir = join(root, ".mstar", "sdd", "plan-2", "assignments");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "does-not-exist.md");
    const result = readAssignmentSource(`Assignment file: ${file}\n`, { harnessDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("dispatch.assignment.path");
    expect(result.message).toContain(file);
  });

  test("inline front matter passes through without filesystem access", () => {
    const result = readAssignmentSource(VALID_ASSIGNMENT, { harnessDir: join(root, "no-such-harness-dir") });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toBe(VALID_ASSIGNMENT);
    expect(result.path).toBeUndefined();
  });

  test("a pointer plus an inline body refuses as ambiguous", () => {
    const file = writeHomeFile([".mstar", "assignments"]);
    const text = `${VALID_ASSIGNMENT}\nAssignment file: ${file}\n`;
    const result = readAssignmentSource(text, { harnessDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("dispatch.assignment.ambiguous");
  });

  test("a relative pointer refuses dispatch.assignment.path", () => {
    const result = readAssignmentSource("Assignment file: sdd/plan-1/assignments/x.md\n", { harnessDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("dispatch.assignment.path");
  });

  test("a symlink inside the home landing outside refuses dispatch.assignment.path", () => {
    const outside = join(root, "symlink-target.md");
    writeFileSync(outside, FILE_ASSIGNMENT);
    const dir = join(root, ".mstar", "sdd", "plan-3", "assignments");
    mkdirSync(dir, { recursive: true });
    const link = join(dir, "link.md");
    symlinkSync(outside, link);
    const result = readAssignmentSource(`Assignment file: ${link}\n`, { harnessDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("dispatch.assignment.path");
  });

  test("a null harness root refuses the pointer with the inline recovery — containment never skips", () => {
    const file = writeHomeFile([".mstar", "sdd", "plan-4", "assignments"]);
    const result = readAssignmentSource(`Assignment file: ${file}\n`, { harnessDir: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("dispatch.assignment.path");
    expect(result.fix).toContain("inline");
  });

  test("a pointer at a write-home base but NOT under <base>/<segment>/assignments refuses", () => {
    const dir = join(root, ".mstar", "sdd");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "loose.md");
    writeFileSync(file, FILE_ASSIGNMENT);
    const result = readAssignmentSource(`Assignment file: ${file}\n`, { harnessDir });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("dispatch.assignment.path");
  });
});
