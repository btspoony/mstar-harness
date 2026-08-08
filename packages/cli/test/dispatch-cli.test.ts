/**
 * CLI `mstar dispatch validate <assignment-file>` — thin engine-backed
 * wrapper over `validateAssignmentFields` + `assertDefaultBranchProtected`
 * (mstar-dispatch-gates Assignment field contract; mstar-branch-worktree
 * branch-form + default-protected-branch gates).
 *
 * Exit codes: 0 = OK, 1 = violations / file errors, 2 = usage (missing
 * <assignment-file> arg, slice-2 in-handler convention). The default-branch
 * gate reads `--branch` first, then `$MSTAR_WORKING_BRANCH`.
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

  test("--branch main on a writable assignment → dispatch.default-branch.protected, exit 1", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "main"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("dispatch.default-branch.protected");
    });
  });

  test("--branch feature/x → exit 0 (default-branch gate passes)", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file, "--branch", "feature/x"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    });
  });

  test("MSTAR_WORKING_BRANCH=main env fallback → dispatch.default-branch.protected, exit 1", () => {
    withAssignment(VALID_ASSIGNMENT, (file) => {
      const result = runCli(["dispatch", "validate", file], { env: { MSTAR_WORKING_BRANCH: "main" } });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("dispatch.default-branch.protected");
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
