/**
 * CLI `mstar dispatch validate <assignment-file>` — thin engine-backed
 * wrapper over `validateAssignmentFields` + `assertDefaultBranchProtected`
 * (mstar-dispatch-gates Assignment field contract; mstar-branch-worktree
 * branch-form + default-protected-branch gates).
 *
 * Exit codes: 0 = OK, 1 = violations / file errors, 2 = usage (missing
 * <assignment-file> arg, slice-2 in-handler convention). The default-branch
 * gate branch is DERIVED FROM THE ASSIGNMENT (create-form name / Working
 * branch / Branch policy branch — qc2 W-1 / qc3 F-2); `--branch` and
 * `$MSTAR_WORKING_BRANCH` are context fallbacks for assignments without a
 * branch form. Read-only roles (scout/explore) skip both branch gates
 * (qc3 F-1 / qc2 S-5). A well-formed `Branch policy: direct on <branch> —
 * <reason>` exception is honored only when its branch matches the checked
 * branch.
 *
 * Each case runs the real CLI as a subprocess against a temp assignment
 * fixture and asserts the exit code + reported violation codes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

/**
 * Spawn env with ambient harness env vars pinned out (qc3 F-4): the CLI
 * resolves harness dirs from MSTAR_HARNESS_DIR ahead of probing, and
 * `dispatch validate` reads the branch from MSTAR_WORKING_BRANCH — an
 * ambient value would redirect every fixture spuriously.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR" || key === "MSTAR_WORKING_BRANCH") {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test. */
function runCli(args: string[], opts: { env?: Record<string, string> } = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: { ...cliEnv(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
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

describe("mstar dispatch validate — Assignment field + default-branch gate", () => {
  test("valid writable assignment → OK, exit 0", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("dispatch validate: OK");
      expect(result.stderr).toBe("");
    });
  });

  test("missing Execute as (agent field) → assignment.field.missing-execute-as, exit 1", () => {
    withAssignment(assignment({ "Execute as": "" }).replace("**Execute as**: ", ""), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("assignment.field.missing-execute-as");
      expect(result.stdout).not.toContain("OK");
    });
  });

  test("missing Working branch → assignment.field.branch-missing, exit 1", () => {
    withAssignment(assignment({ "Working branch": "" }).replace("**Working branch**: ", ""), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("assignment.field.branch-missing");
    });
  });

  test("create-form Working branch without <base> → assignment.field.branch-missing-base, exit 1", () => {
    withAssignment(assignment({ "Working branch": "create feature/new" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("assignment.field.branch-missing-base");
    });
  });

  test("dangling create form 'create feature/x from' → assignment.field.branch-missing-base, exit 1 (qc2 S-1)", () => {
    withAssignment(assignment({ "Working branch": "create feature/x from" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("assignment.field.branch-missing-base");
    });
  });

  // --- gate-branch derivation (qc2 W-1 / qc3 F-2): the checked branch comes
  // from the Assignment's own branch forms ---

  test("Working branch: main (no exception) → dispatch.default-branch.protected, exit 1 — derived from the Assignment", () => {
    withAssignment(assignment({ "Working branch": "main" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("dispatch.default-branch.protected");
    });
  });

  test("create form 'create feature/x from main' (no --branch) → exit 0 — checked branch is feature/x, not main", () => {
    withAssignment(assignment({ "Working branch": "create feature/x from main" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("dispatch validate: OK");
      expect(result.stderr).not.toContain("dispatch.default-branch.protected");
    });
  });

  test("legal 'create feature/x from main' + --branch main → exit 0 (branch checked = feature/x)", () => {
    withAssignment(assignment({ "Working branch": "create feature/x from main" }), (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("dispatch.default-branch.protected");
    });
  });

  test("Assignment branch form wins over --branch (feature/foo + --branch main → exit 0)", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
      expect(result.stderr).not.toContain("dispatch.default-branch.protected");
    });
  });

  test("Assignment branch form wins over MSTAR_WORKING_BRANCH env (feature/foo + env main → exit 0)", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file], { env: { MSTAR_WORKING_BRANCH: "main" } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    });
  });

  test("Branch policy direct on main — reason (no --branch) → exit 0 — derived exception branch matches the exception", () => {
    withAssignment(
      assignment({ "Working branch": "", "Branch policy": "direct on main -- team hotfix convention" }),
      (file) => {
        const result = runCli(["dispatch", "validate", file]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("dispatch validate: OK");
      },
    );
  });

  test("Branch policy direct on main + --branch main → exit 0 (direct-on exception honored)", () => {
    withAssignment(
      assignment({ "Working branch": "", "Branch policy": "direct on main -- team hotfix convention" }),
      (file) => {
        const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("dispatch validate: OK");
        expect(result.stderr).not.toContain("dispatch.default-branch.protected");
      },
    );
  });

  test("Branch policy without reason → assignment.field.branch-policy-missing-reason + protected, exit 1 (no exception)", () => {
    withAssignment(assignment({ "Working branch": "", "Branch policy": "direct on main" }), (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("assignment.field.branch-policy-missing-reason");
      expect(result.stderr).toContain("dispatch.default-branch.protected");
    });
  });

  test("Working branch main + Branch policy direct on main-tmp — reason → protected, exit 1 (exception branch mismatch)", () => {
    withAssignment(
      assignment({ "Working branch": "main", "Branch policy": "direct on main-tmp -- other work" }),
      (file) => {
        const result = runCli(["dispatch", "validate", file]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("dispatch.default-branch.protected");
      },
    );
  });

  test("--branch main without an assignment branch form → dispatch.default-branch.protected, exit 1 (context fallback)", () => {
    withAssignment(assignment({ "Working branch": "" }).replace("**Working branch**: ", ""), (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("assignment.field.branch-missing");
      expect(result.stderr).toContain("dispatch.default-branch.protected");
    });
  });

  test("MSTAR_WORKING_BRANCH=main env fallback without an assignment branch form → protected, exit 1", () => {
    withAssignment(assignment({ "Working branch": "" }).replace("**Working branch**: ", ""), (file) => {
      const result = runCli(["dispatch", "validate", file], { env: { MSTAR_WORKING_BRANCH: "main" } });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("assignment.field.branch-missing");
      expect(result.stderr).toContain("dispatch.default-branch.protected");
    });
  });

  test("--branch feature/x → exit 0 (default-branch gate passes)", () => {
    withAssignment(assignment({ "Working branch": "" }).replace("**Working branch**: ", ""), (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "feature/x"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("assignment.field.branch-missing");
      expect(result.stderr).not.toContain("dispatch.default-branch.protected");
    });
  });

  // --- read-only roles (qc3 F-1 / qc2 S-5): scout/explore skip both branch
  // gates, so the preflight passes read-only Assignments without branch forms

  test("scout assignment without Working branch → exit 0 (read-only skips the branch gates)", () => {
    const scout = `## Assignment

**Execute as**: scout
**Delegation**: forbidden
**Task category**: deep
`;
    withAssignment(scout, (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("dispatch validate: OK");
      expect(result.stderr).toBe("");
    });
  });

  test("scout assignment without Working branch + --branch main → exit 0 (no gate on read-only work)", () => {
    const scout = `## Assignment

**Execute as**: scout
**Delegation**: forbidden
**Task category**: deep
`;
    withAssignment(scout, (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
      expect(result.exitCode).toBe(0);
    });
  });

  test("read-only role match is case-insensitive (Execute as: Scout)", () => {
    const scout = `## Assignment

**Execute as**: Scout
**Delegation**: forbidden
**Task category**: deep
`;
    withAssignment(scout, (file) => {
      const result = runCli(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
    });
  });

  test("missing <assignment-file> arg → usage, exit 2", () => {
    const result = runCli(["dispatch", "validate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: dispatch validate");
  });

  test("nonexistent assignment file → exit 1 with file error", () => {
    const result = runCli(["dispatch", "validate", "/no/such/assignment.md"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("assignment file not found");
  });
});
