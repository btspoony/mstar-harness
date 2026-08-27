/**
 * Engine dispatch module — Assignment field validation, default-branch gate,
 * execution-mode → QC seat count, tri identity, anti-recursion precheck.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - Assignment field contract — `Execute as` / `Delegation` / `Task category`
 *   present with non-empty values; paste-only assignments missing fields are
 *   flagged: `mstar-dispatch-gates` SKILL.md § "调度防串扰（强制）" +
 *   § "Assignment 顶部反模式块" + § 反模式（派发）("Assignment 已写、invoke
 *   为零（paste-only）").
 * - Branch-field forms — writable Assignment must contain EXACTLY ONE of
 *   `Working branch: <existing>` | `Working branch: create <new> from <base>`
 *   | `Branch policy: direct on <branch> — <reason>`; `create` without
 *   `<base>` is flagged (never assume `main`): `mstar-branch-worktree`
 *   SKILL.md § "Assignment 要求（PM）" + § "`<base>` 与叠分支（stacked
 *   branches）".
 * - Default-protected-branch gate — no writable work on `main`/`master`
 *   unless the Assignment carries an explicit `Branch policy: direct on
 *   <branch> — <reason>` exception: `mstar-branch-worktree` SKILL.md
 *   § "Git 功能分支门禁（业务仓库）" § 默认规则.
 * - N→seat mapping — sdd → 3 (qc1..qc3 + consolidated), inline → 1
 *   (qc.md), targeted re-review → listed seats: `mstar-dispatch-gates`
 *   SKILL.md § "QC tri-review（SDD 强制）" / "QC 单席（例外）" / "QC
 *   targeted re-review" + `mstar-roles` SKILL.md "QC reviewer" 参数表.
 * - Tri identity — initial wave exactly `qc-specialist` / `qc-specialist-2`
 *   / `qc-specialist-3`: `mstar-dispatch-gates` SKILL.md § "QC tri-review"
 *   + `mstar-roles` SKILL.md QC reviewer 参数表.
 * - Anti-recursion — leaf executor MUST NOT invoke a Task/subagent whose
 *   role binding (`subagent_type` / `agent` / `subagent`) equals its own
 *   `Execute as` (NEVER red line): `mstar-dispatch-gates` SKILL.md
 *   § "承接方反递归红线（NEVER / DO NOT；leaf executor 必读）".
 */
import { describe, expect, test } from "bun:test";
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
  parseBranchPolicyDirectOnBranch,
  parseEnforcementFlag,
  validateAssignmentFields,
} from "../src/dispatch.js";

/** Minimal well-formed writable assignment (all required fields + one branch form). */
const VALID_ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/foo
**Plan Path**: .mstar/plans/20260808-example.md
`;

function assignment(overrides: Record<string, string>): string {
  const base: Record<string, string> = {
    "Execute as": "fullstack-dev",
    Delegation: "forbidden",
    "Task category": "logic",
    "Working branch": "feature/foo",
  };
  const merged = { ...base, ...overrides };
  const lines = ["## Assignment", ""];
  for (const [field, value] of Object.entries(merged)) {
    lines.push(`**${field}**: ${value}`);
  }
  return lines.join("\n") + "\n";
}

describe("validateAssignmentFields — required field matrix", () => {
  test("accepts a complete writable assignment", () => {
    const result = validateAssignmentFields(VALID_ASSIGNMENT);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("accepts plain (non-bold) header field form", () => {
    const text = `## Assignment

Execute as: fullstack-dev
Delegation: forbidden
Task category: logic
Working branch: feature/foo
`;
    const result = validateAssignmentFields(text);
    expect(result.ok).toBe(true);
  });

  test("missing Execute as → assignment.field.missing-execute-as", () => {
    const text = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/foo
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.missing-execute-as")).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.missing-delegation")).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.missing-task-category")).toBe(false);
  });

  test("missing core fields carry the legacy presence codes as aliases (single parser, qc1 F-002)", () => {
    const text = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/foo
`;
    const r = validateAssignmentFields(text);
    const executeAs = r.violations.find((v) => v.code === "assignment.field.missing-execute-as");
    expect(executeAs).toBeDefined();
    // Exactly ONE violation for the missing field — the presence namespace is
    // an alias on it, not a second stacked violation.
    expect(r.violations.filter((v) => v.message.includes("Execute as"))).toHaveLength(1);
    expect(executeAs!.aliases).toContain("assignment.presence.missing-execute-as");
    // Branch-form violations carry no presence alias.
    const branchMissing = r.violations.find((v) => v.code === "assignment.field.branch-missing");
    expect(branchMissing?.aliases).toBeUndefined();
  });

  test("list-bullet header fields are accepted (presence-parser acceptance folded into the single engine parser)", () => {
    const text = `## Assignment

- **Execute as**: fullstack-dev
- **Delegation**: forbidden
- **Task category**: logic
- **Working branch**: feature/foo
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(true);
  });

  test("missing Delegation → assignment.field.missing-delegation", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Task category**: logic
**Working branch**: feature/foo
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.missing-delegation")).toBe(true);
  });

  test("missing Task category → assignment.field.missing-task-category", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Working branch**: feature/foo
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.missing-task-category")).toBe(true);
  });

  test("empty required values → assignment.field.invalid-* (presence shape)", () => {
    const text = `## Assignment

**Execute as**:
**Delegation**: 
**Task category**: logic
**Working branch**: feature/foo
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.invalid-execute-as")).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.invalid-delegation")).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.missing-task-category")).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.invalid-task-category")).toBe(false);
  });

  test("paste-only shell (no fields at all) flags every required field + branch form", () => {
    const r = validateAssignmentFields("## Assignment\n\n(empty)");
    expect(r.ok).toBe(false);
    const codes = r.violations.map((v) => v.code);
    expect(codes).toContain("assignment.field.missing-execute-as");
    expect(codes).toContain("assignment.field.missing-delegation");
    expect(codes).toContain("assignment.field.missing-task-category");
    expect(codes).toContain("assignment.field.branch-missing");
  });
});

describe("validateAssignmentFields — branch-form matrix (writable)", () => {
  test("Working branch: <existing> is a valid single form", () => {
    const r = validateAssignmentFields(assignment({ "Working branch": "feature/foo" }));
    expect(r.ok).toBe(true);
  });

  test("Working branch: create <new> from <base> is valid (branch base)", () => {
    const r = validateAssignmentFields(
      assignment({ "Working branch": "create feature/part2 from feature/foo" }),
    );
    expect(r.ok).toBe(true);
  });

  test("Working branch: create <new> from current is valid (current HEAD base)", () => {
    const r = validateAssignmentFields(
      assignment({ "Working branch": "create feature/bar from current" }),
    );
    expect(r.ok).toBe(true);
  });

  test("Branch policy: direct on <branch> — <reason> is a valid single form", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Branch policy**: direct on main — team hotfix convention
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(true);
  });

  test("Branch policy: direct on <branch> - <reason> (ASCII hyphen) is a valid single form", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Branch policy**: direct on main - team hotfix convention
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(true);
  });

  test("Branch policy: direct on <branch> -- <reason> (ASCII double hyphen) is a valid single form", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Branch policy**: direct on main -- team hotfix convention
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(true);
  });

  test("Branch policy: direct on <branch> – <reason> (en dash) is a valid single form", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Branch policy**: direct on main – team hotfix convention
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(true);
  });

  test("empty Working branch does not count as a form (treated as absent)", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: 
**Branch policy**: direct on main — team hotfix convention
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(true);
  });

  test("no branch form → assignment.field.branch-missing", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing")).toBe(true);
  });

  test("Working branch + Branch policy together → assignment.field.branch-multiple", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/foo
**Branch policy**: direct on main — hotfix
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-multiple")).toBe(true);
  });

  test("create form without <base> → assignment.field.branch-missing-base", () => {
    const r = validateAssignmentFields(assignment({ "Working branch": "create feature/part2" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("create form with dangling 'from' ('create feature/x from') → assignment.field.branch-missing-base (qc2 S-1 / qc3 F-5)", () => {
    const r = validateAssignmentFields(assignment({ "Working branch": "create feature/x from" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("create form with 'from' but no name ('create from main') → assignment.field.branch-missing-base", () => {
    const r = validateAssignmentFields(assignment({ "Working branch": "create from main" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("create form with dangling words is not a create-form match (treated as existing branch)", () => {
    const r = validateAssignmentFields(assignment({ "Working branch": "create foo from bar extra" }));
    expect(r.ok).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(false);
  });

  test("existing branch names that merely start with 'create' pass as existing-branch forms", () => {
    for (const name of ["created", "create/foo", "create-user-flow"]) {
      const r = validateAssignmentFields(assignment({ "Working branch": name }));
      expect(r.ok).toBe(true);
      expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(false);
    }
  });

  test("capitalized create form 'Create new-branch from main' is a valid create form", () => {
    const r = validateAssignmentFields(assignment({ "Working branch": "Create new-branch from main" }));
    expect(r.ok).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(false);
  });

  test("uppercase create form without <base> ('CREATE new-branch') → assignment.field.branch-missing-base", () => {
    const r = validateAssignmentFields(assignment({ "Working branch": "CREATE new-branch" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("create form 'create foo' without <base> → assignment.field.branch-missing-base", () => {
    const r = validateAssignmentFields(assignment({ "Working branch": "create foo" }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-missing-base")).toBe(true);
  });

  test("Branch policy without reason → assignment.field.branch-policy-missing-reason", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Branch policy**: direct on main
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-policy-missing-reason")).toBe(true);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-policy-missing-branch")).toBe(false);
  });

  test("Branch policy without branch → assignment.field.branch-policy-missing-branch", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Branch policy**: direct on
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-policy-missing-branch")).toBe(true);
  });

  test("unparseable Branch policy → assignment.field.branch-policy-missing-branch", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Branch policy**: merge to main
`;
    const r = validateAssignmentFields(text);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "assignment.field.branch-policy-missing-branch")).toBe(true);
  });

  test("writable:false skips the branch-form gate (read-only assignment)", () => {
    const text = `## Assignment

**Execute as**: scout
**Delegation**: forbidden
**Task category**: deep
`;
    const r = validateAssignmentFields(text, { writable: false });
    expect(r.ok).toBe(true);
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

  test("targeted duplicate seats are deduped before counting (qc2 S-3): [a,a,b] → 2", () => {
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
  test("subagent_type == Execute as → critical dispatch.anti-recursion.self-type", () => {
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

  test("set binding + empty Execute as → ok (field presence is validateAssignmentFields' job)", () => {
    expect(antiRecursionPrecheck("fullstack-dev", "").ok).toBe(true);
    expect(antiRecursionPrecheck("fullstack-dev", "   ").ok).toBe(true);
  });
});

describe("parseAssignmentBranchForms — engine single branch-form grammar (qc1 F-001 / qc3 F-3)", () => {
  test("Working branch: <existing> → workingBranch (first token)", () => {
    expect(parseAssignmentBranchForms(assignment({ "Working branch": "feature/foo" })).workingBranch).toBe("feature/foo");
  });

  test("existing-branch values with extra words keep the first token", () => {
    expect(parseAssignmentBranchForms(assignment({ "Working branch": "feature/foo extra words" })).workingBranch).toBe("feature/foo");
  });

  test("create form → createForm { name, base }", () => {
    const forms = parseAssignmentBranchForms(assignment({ "Working branch": "create feature/part2 from main" }));
    expect(forms.createForm).toEqual({ name: "feature/part2", base: "main" });
    expect(forms.workingBranch).toBeUndefined();
  });

  test("create form without base → createForm { name } (base undefined)", () => {
    expect(parseAssignmentBranchForms(assignment({ "Working branch": "create feature/x" })).createForm).toEqual({
      name: "feature/x",
      base: undefined,
    });
  });

  test("create-form token match is case-insensitive", () => {
    expect(parseAssignmentBranchForms(assignment({ "Working branch": "Create New-Branch from main" })).createForm?.name).toBe("New-Branch");
  });

  test("dangling 'create X from' is a create-form (base empty) — fail-open fixed", () => {
    expect(parseAssignmentBranchForms(assignment({ "Working branch": "create feature/x from" })).createForm).toEqual({
      name: "feature/x",
      base: "",
    });
  });

  test("'create from main' is a create-form (name empty)", () => {
    expect(parseAssignmentBranchForms(assignment({ "Working branch": "create from main" })).createForm).toEqual({
      name: "",
      base: "main",
    });
  });

  test("branch names merely starting with 'create' stay existing-branch values", () => {
    for (const name of ["created", "create/foo", "create-user-flow"]) {
      const forms = parseAssignmentBranchForms(assignment({ "Working branch": name }));
      expect(forms.createForm).toBeUndefined();
      expect(forms.workingBranch).toBe(name);
    }
  });

  test("'create foo from bar extra' is not a create-form (treated as existing branch)", () => {
    const forms = parseAssignmentBranchForms(assignment({ "Working branch": "create foo from bar extra" }));
    expect(forms.createForm).toBeUndefined();
    expect(forms.workingBranch).toBe("create");
  });

  test("Branch policy direct on <branch> — <reason> → directOn { branch, reason }", () => {
    const forms = parseAssignmentBranchForms(
      assignment({ "Working branch": "", "Branch policy": "direct on main — team hotfix convention" }),
    );
    expect(forms.directOn).toEqual({ branch: "main", reason: "team hotfix convention" });
  });

  test("Branch policy separators: -- and - and – all parse the reason", () => {
    for (const sep of ["--", "-", "–"]) {
      const forms = parseAssignmentBranchForms(
        assignment({ "Working branch": "", "Branch policy": `direct on main ${sep} team hotfix` }),
      );
      expect(forms.directOn).toEqual({ branch: "main", reason: "team hotfix" });
    }
  });

  test("Branch policy without reason → directOn { branch, reason: '' } (loose branch capture)", () => {
    const forms = parseAssignmentBranchForms(assignment({ "Working branch": "", "Branch policy": "direct on main" }));
    expect(forms.directOn).toEqual({ branch: "main", reason: "" });
  });

  test("Branch policy 'direct on main -' (separator, no reason) → reason empty", () => {
    const forms = parseAssignmentBranchForms(assignment({ "Working branch": "", "Branch policy": "direct on main -" }));
    expect(forms.directOn).toEqual({ branch: "main", reason: "" });
  });

  test("non-direct-on Branch policy → no directOn", () => {
    expect(parseAssignmentBranchForms(assignment({ "Working branch": "", "Branch policy": "merge to main" })).directOn).toBeUndefined();
  });

  test("no branch fields → empty forms", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
`;
    expect(parseAssignmentBranchForms(text)).toEqual({});
  });

  test("list-bullet field lines parse (single grammar with the presence parser's bullet acceptance)", () => {
    const text = `## Assignment

- **Working branch**: create feature/x from main
- **Branch policy**: direct on main — hotfix
`;
    const forms = parseAssignmentBranchForms(text);
    expect(forms.createForm).toEqual({ name: "feature/x", base: "main" });
    expect(forms.directOn).toEqual({ branch: "main", reason: "hotfix" });
  });
});

describe("parseBranchPolicyDirectOnBranch — strict direct-on exception (CLI/plugin shared)", () => {
  test("well-formed direct-on with reason → exception branch", () => {
    const text = assignment({ "Working branch": "", "Branch policy": "direct on main — team hotfix convention" });
    expect(parseBranchPolicyDirectOnBranch(text)).toBe("main");
  });

  test("every separator ([—–]|--|-) yields the exception branch", () => {
    for (const sep of ["—", "–", "--", "-"]) {
      const text = assignment({ "Working branch": "", "Branch policy": `direct on main ${sep} reason` });
      expect(parseBranchPolicyDirectOnBranch(text)).toBe("main");
    }
  });

  test("no reason → undefined (no exception)", () => {
    expect(parseBranchPolicyDirectOnBranch(assignment({ "Working branch": "", "Branch policy": "direct on main" }))).toBeUndefined();
  });

  test("dangling separator without reason → undefined", () => {
    expect(parseBranchPolicyDirectOnBranch(assignment({ "Working branch": "", "Branch policy": "direct on main -" }))).toBeUndefined();
  });

  test("non-direct-on or absent policy → undefined", () => {
    expect(parseBranchPolicyDirectOnBranch(assignment({ "Working branch": "", "Branch policy": "merge to main" }))).toBeUndefined();
    expect(parseBranchPolicyDirectOnBranch(assignment({ "Working branch": "feature/foo" }))).toBeUndefined();
  });
});

describe("isReadOnlyAssignmentRole — scout/explore read-only roles (qc3 F-1 / qc2 S-5)", () => {
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

describe("parseAssignmentFields — exported engine field parser (single grammar)", () => {
  test("parses bold, plain, and bullet field forms", () => {
    const text = `## Assignment

- **Execute as**: fullstack-dev
Delegation: forbidden
**Task category**: logic
- Working branch: feature/foo
**Branch policy**: direct on main — hotfix
`;
    const fields = parseAssignmentFields(text);
    expect(fields).toEqual({
      executeAs: "fullstack-dev",
      delegation: "forbidden",
      taskCategory: "logic",
      workingBranch: "feature/foo",
      branchPolicy: "direct on main — hotfix",
    });
  });

  test("last duplicate field line wins", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Execute as**: architect
`;
    expect(parseAssignmentFields(text).executeAs).toBe("architect");
  });

  test("unrelated prose does not produce fields", () => {
    expect(parseAssignmentFields("This is not an assignment.\n- one: two\nNo fields.")).toEqual({});
  });
});

describe("parseEnforcementFlag — Enforcement: hard flag (Slice 5, roadmap §8.5 C4/D2)", () => {
  // Spec: roadmap §8.5 C4 + decision D2 — v2 hard gates are enabled per
  // Assignment/compass via `Enforcement: hard` (Assignment header, bold or
  // plain) or compass frontmatter `enforcement: hard`; the flag is never
  // global; rollback = unset flag; flag inert when the engine is absent.
  test("Assignment bold form: **Enforcement**: hard → hard, source assignment", () => {
    expect(parseEnforcementFlag(`## Assignment\n\n**Execute as**: fullstack-dev\n**Enforcement**: hard\n`)).toEqual({
      hard: true,
      source: "assignment",
    });
  });

  test("Assignment plain form: Enforcement: hard → hard, source assignment", () => {
    expect(parseEnforcementFlag("Enforcement: hard\n")).toEqual({ hard: true, source: "assignment" });
  });

  test("Assignment list-bullet + bold form → hard, source assignment", () => {
    expect(parseEnforcementFlag("- **Enforcement**: hard\n")).toEqual({ hard: true, source: "assignment" });
  });

  test("Assignment value is case-insensitive (Hard / HARD → hard)", () => {
    for (const value of ["Hard", "HARD", "hArD"]) {
      expect(parseEnforcementFlag(`**Enforcement**: ${value}\n`)).toEqual({
        hard: true,
        source: "assignment",
      });
    }
  });

  test("Assignment present but NOT hard (soft / empty / malformed value) → source assignment, hard false", () => {
    expect(parseEnforcementFlag("**Enforcement**: soft\n")).toEqual({ hard: false, source: "assignment" });
    expect(parseEnforcementFlag("**Enforcement**: warn\n")).toEqual({ hard: false, source: "assignment" });
    expect(parseEnforcementFlag("**Enforcement**: hard mode\n")).toEqual({ hard: false, source: "assignment" });
    expect(parseEnforcementFlag("**Enforcement**:\n")).toEqual({ hard: false, source: "assignment" });
  });

  test("compass frontmatter form: enforcement: hard → hard, source compass", () => {
    expect(parseEnforcementFlag("enforcement: hard\n")).toEqual({ hard: true, source: "compass" });
  });

  test("compass value may be quoted and case-insensitive", () => {
    expect(parseEnforcementFlag('enforcement: "hard"\n')).toEqual({ hard: true, source: "compass" });
    expect(parseEnforcementFlag("enforcement: 'HARD'\n")).toEqual({ hard: true, source: "compass" });
  });

  test("compass present but not hard (soft / true / empty) → source compass, hard false", () => {
    expect(parseEnforcementFlag("enforcement: soft\n")).toEqual({ hard: false, source: "compass" });
    expect(parseEnforcementFlag("enforcement: true\n")).toEqual({ hard: false, source: "compass" });
    expect(parseEnforcementFlag("enforcement:\n")).toEqual({ hard: false, source: "compass" });
  });

  test("no flag anywhere → { hard: false, source: none }", () => {
    expect(parseEnforcementFlag("## Assignment\n\n**Execute as**: fullstack-dev\n")).toEqual({
      hard: false,
      source: "none",
    });
    expect(parseEnforcementFlag("iteration_id: 20260808-demo\nstatus: active\n")).toEqual({
      hard: false,
      source: "none",
    });
    expect(parseEnforcementFlag("")).toEqual({ hard: false, source: "none" });
  });

  test("Assignment form wins over compass form when both appear (per-Assignment precedence)", () => {
    expect(parseEnforcementFlag("enforcement: hard\n\n**Enforcement**: soft\n")).toEqual({
      hard: false,
      source: "assignment",
    });
    expect(parseEnforcementFlag("**Enforcement**: hard\nenforcement: soft\n")).toEqual({
      hard: true,
      source: "assignment",
    });
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

  test("never throws on hostile input", () => {
    for (const input of ["", "*".repeat(10000), "{{{{[[[[)))) ---- \n<<<<", "enforcement" ]) {
      expect(() => parseEnforcementFlag(input)).not.toThrow();
    }
  });
});

describe("assignmentHeaderRegion — Assignment header-only scope (qc1 F-003 / qc2 F-003)", () => {
  // Spec: the Assignment enforcement flag is read from the HEADER region
  // only — the text before the first body marker (`# Task`-style heading,
  // `---` separator, or single-`#` heading). An example
  // `**Enforcement**: hard` line quoted in the task body must not harden.
  test("no body marker → the full text is the header region", () => {
    const text = "## Assignment\n\n**Execute as**: fullstack-dev\n**Enforcement**: hard\n";
    expect(assignmentHeaderRegion(text)).toBe(text);
  });

  test("cuts at the first `# ` heading (`# Change` etc.)", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Enforcement**: hard

# Change

Example: **Enforcement**: soft (body must not count)
`;
    const region = assignmentHeaderRegion(text);
    expect(region).toContain("**Enforcement**: hard");
    expect(region).not.toContain("# Change");
    expect(region).not.toContain("Example:");
  });

  test("cuts at the first `## Task` / `### Task` heading (SDD task bodies)", () => {
    for (const heading of ["## Task 1: Implement", "### Task 1 — Implement"]) {
      const text = `## Assignment

**Enforcement**: hard

${heading}

**Enforcement**: soft
`;
      const region = assignmentHeaderRegion(text);
      expect(region).toContain("**Enforcement**: hard");
      expect(region).not.toContain(heading);
      expect(region).not.toContain("soft");
    }
  });

  test("cuts at a `---` horizontal-rule separator", () => {
    const text = `## Assignment

**Enforcement**: hard

---

**Enforcement**: soft
`;
    const region = assignmentHeaderRegion(text);
    expect(region).toContain("**Enforcement**: hard");
    expect(region).not.toContain("---");
    expect(region).not.toContain("soft");
  });

  test("the `## Assignment` heading itself is NOT a boundary", () => {
    const text = `## Assignment

**Enforcement**: hard
`;
    expect(assignmentHeaderRegion(text)).toBe(text);
  });

  test("body marker at the very start → empty header region", () => {
    expect(assignmentHeaderRegion("# Target\nplan body only\n")).toBe("");
  });

  test("body example line **Enforcement**: hard does NOT harden (header region only)", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/example

# Change

Example Assignment snippet: **Enforcement**: hard
`;
    expect(parseEnforcementFlag(assignmentHeaderRegion(text))).toEqual({ hard: false, source: "none" });
  });

  test("header **Enforcement**: hard hardens even when a body example quotes a soft flag", () => {
    const text = `## Assignment

**Enforcement**: hard
**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/example

# Change

**Enforcement**: soft (example only)
`;
    expect(parseEnforcementFlag(assignmentHeaderRegion(text))).toEqual({ hard: true, source: "assignment" });
  });
});

describe("composeDispatchGate — shared host dispatch-gate composition (qc1 F-001/F-006, qc2 F-005/F-007, qc3 F-007/F-008)", () => {
  /** Writable assignment with NO branch form — branch-missing + env-fallback targets. */
  const noBranchText = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
`;

  test("shaped writable assignment, no caller binding (target-only host) → shaped true, ok, no violations", () => {
    const result = composeDispatchGate(VALID_ASSIGNMENT);
    expect(result.shaped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.hardBlocked).toBe(false);
    expect(result.enforcement).toEqual({ hard: false, source: "none" });
  });

  test("issue #156: no caller + no callerRequired → anti-recursion leg SKIPPED (omp/opencode compliant dispatch never self-flags)", () => {
    // The omp/opencode/cursor binding field carries the spawn TARGET, which
    // equals `Execute as` on every compliant dispatch (mstar-host omp.md C5).
    // Without a caller binding the precheck must not run at all.
    const result = composeDispatchGate(VALID_ASSIGNMENT);
    expect(result.ok).toBe(true);
    expect(result.violations.some((v) => v.code.startsWith("dispatch.anti-recursion."))).toBe(false);
  });

  test("caller == Execute as → critical dispatch.anti-recursion.self-type", () => {
    const result = composeDispatchGate(VALID_ASSIGNMENT, { caller: "fullstack-dev" });
    expect(result.ok).toBe(false);
    const anti = result.violations.find((v) => v.code === "dispatch.anti-recursion.self-type");
    expect(anti?.severity).toBe("critical");
  });

  test("caller != Execute as → no anti-recursion violation", () => {
    const result = composeDispatchGate(VALID_ASSIGNMENT, { caller: "project-manager" });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("callerRequired + empty/missing caller → critical dispatch.anti-recursion.empty-binding (dsh fail-closed)", () => {
    for (const opts of [{ callerRequired: true } as const, { caller: "   ", callerRequired: true } as const]) {
      const result = composeDispatchGate(VALID_ASSIGNMENT, opts);
      expect(result.ok).toBe(false);
      const anti = result.violations.find((v) => v.code === "dispatch.anti-recursion.empty-binding");
      expect(anti?.severity).toBe("critical");
    }
  });

  test("callerRequired + set caller → normal self-type semantics (no empty-binding)", () => {
    const result = composeDispatchGate(VALID_ASSIGNMENT, { caller: "project-manager", callerRequired: true });
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

  test("writable text without a branch form → branch-missing violation", () => {
    const result = composeDispatchGate(noBranchText);
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
      const result = composeDispatchGate(noBranchText);
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.code === "dispatch.default-branch.protected")).toBe(true);
      expect(result.violations.some((v) => v.code === "assignment.field.branch-missing")).toBe(true);

      delete process.env.MSTAR_WORKING_BRANCH;
      const without = composeDispatchGate(noBranchText);
      expect(without.violations.some((v) => v.code === "dispatch.default-branch.protected")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MSTAR_WORKING_BRANCH;
      else process.env.MSTAR_WORKING_BRANCH = previous;
    }
  });

  test("header `Enforcement: hard` with violations → enforcement.hard true + hardBlocked true", () => {
    const text = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: main
**Enforcement**: hard
`;
    const result = composeDispatchGate(text);
    expect(result.enforcement).toEqual({ hard: true, source: "assignment" });
    expect(result.hardBlocked).toBe(true);
    expect(result.ok).toBe(false);
  });

  test("body-only `Enforcement: hard` example → hard false (header region only)", () => {
    const text = `## Assignment

**Delegation**: forbidden
**Task category**: docs

# Change

An example Assignment template line: **Enforcement**: hard
`;
    const result = composeDispatchGate(text);
    expect(result.enforcement.hard).toBe(false);
    expect(result.hardBlocked).toBe(false);
    expect(result.ok).toBe(false); // missing Execute as still a real violation
  });

  test("valid assignment + header Enforcement: hard → ok, hardBlocked false", () => {
    const text = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/foo
**Enforcement**: hard
`;
    const result = composeDispatchGate(text, { caller: "project-manager" });
    expect(result.enforcement).toEqual({ hard: true, source: "assignment" });
    expect(result.ok).toBe(true);
    expect(result.hardBlocked).toBe(false);
  });
});
