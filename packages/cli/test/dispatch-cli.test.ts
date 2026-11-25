/**
 * CLI `mstar dispatch validate <assignment-file>` — thin engine-backed
 * wrapper over `readAssignmentSource` + `validateAssignmentFields` +
 * `assertDefaultBranchProtected` (mstar-dispatch-gates Assignment field
 * contract; mstar-branch-worktree branch-form + default-protected-branch
 * gates).
 *
 * Exit codes: 0 = OK, 1 = violations / file errors, 2 = usage (missing
 * <assignment-file> arg, slice-2 in-handler convention). The default-branch
 * gate branch is DERIVED FROM THE ASSIGNMENT (create-form name / Working
 * branch / Branch policy branch — qc2 W-1 ); `--branch` and
 * `$MSTAR_WORKING_BRANCH` are context fallbacks for assignments without a
 * branch form. Read-only roles (scout/explore) skip both branch gates.
 * A well-formed `branch_policy: direct on <branch> — <reason>` exception is
 * honored only when its branch matches the checked branch.
 *
 * Fields live ONLY in the assignment's `---`-fenced YAML front matter
 * (snake_case keys, compass D15); the retired `**Label**` body-line format
 * refuses `dispatch.assignment.legacy-format` (D16). The file's own content
 * may instead be a single `Assignment file: <abs>` pointer, resolved under an
 * accepted assignment home (compass D14).
 *
 * Each case runs the real CLI as a subprocess against a temp assignment
 * fixture and asserts the exit code + reported violation codes.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type RunResult } from "./harness";
import { expectUsageDiagnostic } from "./support/cli-assertions";

function expectEnvelope(result: RunResult, status: string, code?: string): Record<string, unknown> {
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(envelope.status).toBe(status);
  expect(envelope.exitCode).toBe(result.exitCode);
  if (code !== undefined) expect(envelope.code).toBe(code);
  if (status === "ok") expect(envelope.data).toEqual({ ok: true, violations: [] });
  return envelope;
}

function violationCodes(result: RunResult): string[] {
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(envelope.status).toBe(result.exitCode === 0 ? "ok" : "refused");
  const resultData = (envelope.details ?? envelope.data) as { violations?: { code: string }[] } | undefined;
  return resultData?.violations?.map(({ code }) => code) ?? [];
}


/** Write an assignment fixture and return its path. */
function withAssignment(assignmentText: string, fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mstar-dispatch-cli-"));
  const file = join(dir, "assignment.md");
  writeFileSync(file, assignmentText);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Minimal well-formed writable assignment (same shape as the engine fixture). */
const VALID_ASSIGNMENT = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/foo
task_budget: S — one implementer round closing the declared Files and gates
---

## Assignment
`;

/** One front matter override value: a scalar, a block list, or `undefined`
 * to DROP the key (missing-field probes rely on the drop). */
type FixtureValue = string | string[] | undefined;

function assignment(overrides: Record<string, FixtureValue> = {}): string {
  const base: Record<string, FixtureValue> = {
    execute_as: "fullstack-dev",
    delegation: "forbidden",
    task_category: "logic",
    working_branch: "feature/foo",
    // Implement/ops rounds must carry the Task budget capacity field
    // (capacity contract spec § A1) — every fixture built here is a
    // non-review/non-audit round.
    task_budget: "S — one focused implementer round",
  };
  const merged: Record<string, FixtureValue> = { ...base, ...overrides };
  const lines = ["---"];
  for (const [field, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    // `control_write_paths` is the one list-typed key: its caller spelling is
    // comma-separated, and the front matter type is a YAML block list.
    const items = Array.isArray(value)
      ? value
      : field === "control_write_paths"
        ? value.split(",").map((item) => item.trim()).filter(Boolean)
        : value;
    if (Array.isArray(items)) {
      if (items.length === 0) lines.push(`${field}: []`);
      else {
        lines.push(`${field}:`);
        for (const item of items) lines.push(`- ${item}`);
      }
    } else {
      lines.push(`${field}: ${items}`);
    }
  }
  lines.push("---", "", "## Assignment", "");
  return lines.join("\n");
}

describe("mstar dispatch validate — Assignment field + default-branch gate", () => {
  test("the shared runner spawns MSTAR_CLI_ENTRY when set, else the source entry", () => {
    // A built-entry path that cannot execute: the spawn reaches the selector
    // and fails on the named entry, so the child's own argv is never the
    // source entry a hardcoded runner would have launched.
    const prior = process.env.MSTAR_CLI_ENTRY;
    process.env.MSTAR_CLI_ENTRY = join(tmpdir(), "no-such-built-entry.js");
    try {
      withAssignment(VALID_ASSIGNMENT, (file) => {
        const result = runCli(["dispatch", "validate", file]);
        expect(result.exitCode).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain("no-such-built-entry.js");
      });
    } finally {
      if (prior === undefined) delete process.env.MSTAR_CLI_ENTRY;
      else process.env.MSTAR_CLI_ENTRY = prior;
    }
  });

  test("valid front matter assignment → OK, exit 0", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
      expectEnvelope(result, "ok", "dispatch.validate.ok");
      expect(result.stderr).toBe("");
    });
  });

  test("otherwise-valid implement assignment without task_budget → assignment.field.task-budget-missing, exit 1", () => {
    withAssignment(assignment({ task_budget: undefined }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("assignment.field.task-budget-missing");
    });
  });

  test("missing execute_as → assignment.field.execute-as, exit 1", () => {
    withAssignment(assignment({ execute_as: undefined }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("assignment.field.execute-as");
    });
  });

  test("missing working_branch → assignment.field.branch-missing, exit 1", () => {
    withAssignment(assignment({ working_branch: undefined }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("assignment.field.branch-missing");
    });
  });

  test("create-form working_branch without <base> → assignment.field.branch-missing-base, exit 1", () => {
    withAssignment(assignment({ working_branch: "create feature/new" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("assignment.field.branch-missing-base");
    });
  });

  test("dangling create form 'create feature/x from' → assignment.field.branch-missing-base, exit 1", () => {
    withAssignment(assignment({ working_branch: "create feature/x from" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("assignment.field.branch-missing-base");
    });
  });

  test("a body-label document refuses dispatch.assignment.legacy-format (D16) with the front matter recovery, exit 1", () => {
    const bodyLabel = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/foo
**Task budget (implement / ops rounds)**: S — one implementer round
`;
    withAssignment(bodyLabel, (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      const envelope = expectEnvelope(result, "refused", "dispatch.assignment.legacy-format");
      expect(violationCodes(result)).toContain("dispatch.assignment.legacy-format");
      // The recovery names the supported front matter form, not a generic block.
      expect(`${envelope.message} ${envelope.recovery}`).toContain("front matter");
    });
  });

  // --- gate-branch derivation : the checked branch comes
  // from the Assignment's own branch forms ---

  test("working_branch: main (no exception) → dispatch.default-branch.protected, exit 1 — derived from the Assignment", () => {
    withAssignment(assignment({ working_branch: "main" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("dispatch.default-branch.protected");
    });
  });

  test("create form 'create feature/x from main' (no --branch) → exit 0 — checked branch is feature/x, not main", () => {
    withAssignment(assignment({ working_branch: "create feature/x from main" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
      expectEnvelope(result, "ok", "dispatch.validate.ok");
      expect(violationCodes(result)).not.toContain("dispatch.default-branch.protected");
    });
  });

  test("legal 'create feature/x from main' + --branch main → exit 1 — the explicit flag conflicts with the Assignment's declared branch", () => {
    withAssignment(assignment({ working_branch: "create feature/x from main" }), (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
      // The Assignment's declared branch (the create form's target `feature/x`)
      // is the checked branch; an explicit `--branch` that disagrees is a
      // conflict, never a silent override of the declared form.
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("dispatch.branch.conflict");
    });
  });

  test("--branch agrees with working_branch → exit 0 (reconciled, not a conflict)", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "feature/foo"]);
      expect(result.exitCode).toBe(0);
      expectEnvelope(result, "ok", "dispatch.validate.ok");
    });
  });

  test("Assignment branch form wins over --branch (feature/foo + --branch main → the conflict is the refusal)", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
      // Precedence is still the Assignment's: `feature/foo` is the branch that
      // gets checked, so `--branch main` is not treated as working on main —
      // it is a disagreement with the declared form and refuses as one.
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("dispatch.branch.conflict");
      expect(violationCodes(result)).not.toContain("dispatch.default-branch.protected");
    });
  });

  test("Assignment branch form wins over MSTAR_WORKING_BRANCH env (feature/foo + env main → exit 0)", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file], { env: { MSTAR_WORKING_BRANCH: "main" } });
      expect(result.exitCode).toBe(0);
      expectEnvelope(result, "ok", "dispatch.validate.ok");
    });
  });

  test("branch_policy direct on main — reason (no --branch) → exit 0 — derived exception branch matches the exception", () => {
    withAssignment(
      assignment({ working_branch: undefined, branch_policy: "direct on main -- team hotfix convention" }),
      (file) => {
        const result = runCli(["dispatch", "validate", file]);
        expect(result.exitCode).toBe(0);
        expectEnvelope(result, "ok", "dispatch.validate.ok");
      },
    );
  });

  test("branch_policy direct on main + --branch main → exit 0 (direct-on exception honored)", () => {
    withAssignment(
      assignment({ working_branch: undefined, branch_policy: "direct on main -- team hotfix convention" }),
      (file) => {
        const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
        expect(result.exitCode).toBe(0);
        expectEnvelope(result, "ok", "dispatch.validate.ok");
        expect(violationCodes(result)).not.toContain("dispatch.default-branch.protected");
      },
    );
  });

  test("branch_policy without reason → assignment.field.branch-policy-missing-reason + protected, exit 1 (no exception)", () => {
    withAssignment(assignment({ working_branch: undefined, branch_policy: "direct on main" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toEqual(expect.arrayContaining(["assignment.field.branch-policy-missing-reason", "dispatch.default-branch.protected"]));
    });
  });

  test("working_branch main + branch_policy direct on main-tmp — reason → protected, exit 1 (exception branch mismatch)", () => {
    withAssignment(
      assignment({ working_branch: "main", branch_policy: "direct on main-tmp -- other work" }),
      (file) => {
        const result = runCli(["dispatch", "validate", file]);
        expect(result.exitCode).toBe(1);
        expect(violationCodes(result)).toContain("dispatch.default-branch.protected");
      },
    );
  });

  test("--branch main without an assignment branch form → dispatch.default-branch.protected, exit 1 (context fallback)", () => {
    withAssignment(assignment({ working_branch: undefined }), (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toEqual(expect.arrayContaining(["assignment.field.branch-missing", "dispatch.default-branch.protected"]));
    });
  });

  test("MSTAR_WORKING_BRANCH=main env fallback without an assignment branch form → protected, exit 1", () => {
    withAssignment(assignment({ working_branch: undefined }), (file) => {
      const result = runCli(["dispatch", "validate", file], { env: { MSTAR_WORKING_BRANCH: "main" } });
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toEqual(expect.arrayContaining(["assignment.field.branch-missing", "dispatch.default-branch.protected"]));
    });
  });

  test("--branch feature/x → exit 1 with only branch-missing (default-branch gate passes)", () => {
    withAssignment(assignment({ working_branch: undefined }), (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "feature/x"]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toEqual(["assignment.field.branch-missing"]);
    });
  });

  // --- read-only roles : scout/explore skip both branch
  // gates, so the preflight passes read-only Assignments without branch forms

  test("scout assignment without working_branch → exit 0 (read-only skips the branch gates)", () => {
    const scout = `---
execute_as: scout
delegation: forbidden
task_category: deep
task_budget: XS — one orientation round
---

## Assignment
`;
    withAssignment(scout, (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
      expectEnvelope(result, "ok", "dispatch.validate.ok");
      expect(result.stderr).toBe("");
    });
  });

  test("scout assignment without working_branch + --branch main → exit 0 (no gate on read-only work)", () => {
    const scout = `---
execute_as: scout
delegation: forbidden
task_category: deep
task_budget: XS — one orientation round
---

## Assignment
`;
    withAssignment(scout, (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
      expect(result.exitCode).toBe(0);
    });
  });

  test("read-only role match is case-insensitive (execute_as: Scout)", () => {
    const scout = `---
execute_as: Scout
delegation: forbidden
task_category: deep
task_budget: XS — one orientation round
---

## Assignment
`;
    withAssignment(scout, (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
    });
  });

  test("body-only field lines do not declare fields (front matter only)", () => {
    const bodyOnly = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — one implementer round
---

## Assignment

## Task 1: implement

**Working branch**: feature/foo
`;
    withAssignment(bodyOnly, (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("assignment.field.branch-missing");
    });
  });

  test("a body-only read-only role does not disable the writable gate", () => {
    const text = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — one implementer round
---

## Assignment

## Task 1: recon

**Execute as**: scout
`;
    withAssignment(text, (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("assignment.field.branch-missing");
    });
  });

  test("missing <assignment-file> arg → usage, exit 2", () => {
    const result = runCli(["dispatch", "validate"]);
    expect(result.exitCode).toBe(2);
    expectUsageDiagnostic(result, "assignmentFile");
  });

  test("nonexistent assignment file → exit 1 with file error", () => {
    const result = runCli(["dispatch", "validate", "/no/such/assignment.md"]);
    expect(result.exitCode).toBe(1);
    expectEnvelope(result, "refused", "dispatch.validate.refused");
  });
});

describe("mstar dispatch validate — control writes", () => {
  function fixture(fn: (control: string, linked: string, file: string) => void, canonical = false): void {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-control-dispatch-")));
    const control = join(root, "control");
    const linked = join(root, "linked");
    mkdirSync(control);
    const git = (...args: string[]) => execFileSync("git", ["-C", control, ...args], {
      stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
    });
    try {
      git("init", "-b", "main");
      mkdirSync(join(control, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(control, ".gitignore"), canonical
        ? ".mstar/**\n!.mstar/AGENTS.md\n!.mstar/knowledge/\n!.mstar/knowledge/**\n!.mstar/specs/\n!.mstar/specs/**\n!.mstar/adr/\n!.mstar/adr/**\n"
        : ".mstar/plans/\n");
      if (canonical) writeFileSync(join(control, ".mstar", "specs", "spec.md"), "fixture\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      git("worktree", "add", "-b", "feature/fixture", linked);
      const file = join(control, "assignment.md");
      fn(control, linked, file);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("validates the control checkout from a linked worktree and refuses mismatches", () => {
    fixture((control, linked, file) => {
      const run = (overrides: Record<string, FixtureValue>) => {
        writeFileSync(file, assignment({ write_domain: "control", worktree_path: ".", working_branch: "main", control_write_paths: ".mstar/plans/run.md", ...overrides }));
        return runCli(["dispatch", "validate", file], { cwd: linked });
      };
      const clean = run({});
      expect(clean.exitCode).toBe(0);
      expectEnvelope(clean, "ok", "dispatch.validate.ok");
      const wrongPath = run({ worktree_path: linked });
      expect(wrongPath.exitCode).toBe(1);
      expect(violationCodes(wrongPath)).toContain("dispatch.control-write.worktree-not-control");
      const wrongBranch = run({ working_branch: "feature/fixture" });
      expect(wrongBranch.exitCode).toBe(1);
      expect(violationCodes(wrongBranch)).toContain("dispatch.control-write.branch-mismatch");
      const product = run({ write_domain: "work" });
      expect(product.exitCode).toBe(1);
      expect(violationCodes(product)).toContain("dispatch.default-branch.protected");
      const readOnly = run({ execute_as: "scout", worktree_path: linked });
      expect(readOnly.exitCode).toBe(0);
    });
  });
  test("accepts direct-on control branch and refuses a different branch", () => {
    fixture((control, linked, file) => {
      const run = (branch: string) => {
        const text = assignment({ write_domain: "control", worktree_path: ".", working_branch: undefined, control_write_paths: ".mstar/plans/run.md", branch_policy: `direct on ${branch} \u2014 maintenance` });
        writeFileSync(file, text);
        return runCli(["dispatch", "validate", file], { cwd: linked });
      };
      expect(run("main").exitCode).toBe(0);
      expect(violationCodes(run("feature/fixture"))).toContain("dispatch.control-write.branch-mismatch");
    });
  });


  test("probes the declared absent file rather than a synthetic child", () => {
    fixture((control, linked, file) => {
      writeFileSync(join(control, ".gitignore"), "*.md\n");
      const run = (target: string) => {
        writeFileSync(file, assignment({ write_domain: "control", worktree_path: control, working_branch: "main", control_write_paths: target }));
        return runCli(["dispatch", "validate", file], { cwd: linked });
      };
      expect(() => execFileSync("git", ["-C", control, "check-ignore", "-q", "--", "notes/run.md/"])).not.toThrow();
      const ignored = run("notes/run.md");
      expect(ignored.exitCode).toBe(0);
      expectEnvelope(ignored, "ok", "dispatch.validate.ok");
      const committable = run("notes/run.txt");
      expect(committable.exitCode).toBe(1);
      expect(violationCodes(committable)).toContain("dispatch.control-write.target-committable");
    });
  });

  test("probes an absent slash-less target under both ignore rules", () => {
    fixture((control, _linked, file) => {
      writeFileSync(join(control, ".gitignore"), ".mstar/**\n");
      const run = (target: string) => {
        writeFileSync(file, assignment({ write_domain: "control", worktree_path: control, working_branch: "main", control_write_paths: target }));
        return runCli(["dispatch", "validate", file], { cwd: control });
      };
      const fileTarget = run(".mstar/notes");
      expect(fileTarget.exitCode).toBe(0);
      expectEnvelope(fileTarget, "ok", "dispatch.validate.ok");
    });
  });

  test("refuses slash-less committable directories while accepting ignored targets", () => {
    fixture((control, linked, file) => {
      writeFileSync(join(control, ".gitignore"), ".mstar/**\n!.mstar/notes/\n!.mstar/notes/**\n");
      const run = (target: string) => {
        writeFileSync(file, assignment({ write_domain: "control", worktree_path: control, working_branch: "main", control_write_paths: target }));
        return runCli(["dispatch", "validate", file], { cwd: linked });
      };
      const unsafe = run(".mstar/notes");
      expect(unsafe.exitCode).toBe(1);
      expect(violationCodes(unsafe)).toContain("dispatch.control-write.target-committable");
      expect(run(".mstar/plans/run.md").exitCode).toBe(0);
    });
  });

  test("checks a declared absent directory using directory ignore rules", () => {
    fixture((control, linked, file) => {
      writeFileSync(join(control, ".gitignore"), ".mstar/**\n!.mstar/notes/\n!.mstar/notes/**\n");
      writeFileSync(file, assignment({ write_domain: "control", worktree_path: control, working_branch: "main", control_write_paths: ".mstar/notes/" }));
      const result = runCli(["dispatch", "validate", file], { cwd: linked });
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("dispatch.control-write.target-committable");
    });
  });

  test("checks each concrete target against the canonical ignore layout", () => {
    fixture((control, linked, file) => {
      const run = (targets: FixtureValue) => {
        writeFileSync(file, assignment({ write_domain: "control", worktree_path: control, working_branch: "main", control_write_paths: targets }));
        return runCli(["dispatch", "validate", file], { cwd: linked });
      };
      expect(run(".mstar/sdd/plan-x/report.md").exitCode).toBe(0);
      const tracked = run(".mstar/specs/spec.md");
      expect(tracked.exitCode).toBe(1);
      expect(violationCodes(tracked)).toContain("dispatch.control-write.target-committable");
      const outside = run(join(linked, ".mstar", "sdd", "report.md"));
      expect(outside.exitCode).toBe(1);
      expect(violationCodes(outside)).toContain("dispatch.control-write.target-outside-control");
      const missing = run("");
      expect(violationCodes(missing)).toContain("assignment.field.control-write-paths-missing");
      const multiple = run(".mstar/sdd/plan-x/report.md, .mstar/specs/spec.md");
      expect(violationCodes(multiple)).toContain("dispatch.control-write.target-committable");
    }, true);
  });
});
