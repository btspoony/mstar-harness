/**
 * CLI `mstar review seats <assignment-file>` — thin engine-backed wrapper
 * over `executionModeToN` (+ `assertTriIdentity` when mode=sdd with an
 * initial-wave reviewer list) — mstar-dispatch-gates N→seat mapping and
 * tri identity (exactly qc-specialist / qc-specialist-2 / qc-specialist-3).
 *
 * Exit codes: 0 = seat count printed, 1 = violations (unknown mode, missing
 * mode/seats, too many seats, bad tri identity), 2 = usage (missing
 * <assignment-file> arg, slice-2 in-handler convention). `--mode` overrides
 * the Assignment's `Execution mode` header field; `--reviewers` feeds both
 * the targeted seats and the sdd tri-identity check.
 *
 * Each case runs the real CLI as a subprocess against a temp assignment
 * fixture and asserts the exit code + printed seat count / violation codes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

/** Spawn env with ambient harness env vars pinned out (qc3 F-4). */
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
function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Write an assignment fixture and return its path. */
function withAssignment(assignmentText: string, fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mstar-review-cli-"));
  const file = join(dir, "assignment.md");
  writeFileSync(file, assignmentText);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Assignment carrying an `Execution mode` header field. */
function assignmentWithMode(mode: string): string {
  return `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: ${mode}
**Working branch**: feature/foo
`;
}

describe("mstar review seats — execution-mode → QC seat count matrix", () => {
  test("sdd → 3 seats, exit 0", () => {
    withAssignment(assignmentWithMode("sdd"), (file) => {
      const result = runCli(["review", "seats", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("seats: 3");
      expect(result.stderr).toBe("");
    });
  });

  test("inline → 1 seat, exit 0", () => {
    withAssignment(assignmentWithMode("inline"), (file) => {
      const result = runCli(["review", "seats", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("seats: 1");
    });
  });

  test("--mode override wins over the Assignment field", () => {
    withAssignment(assignmentWithMode("inline"), (file) => {
      const result = runCli(["review", "seats", file, "--mode", "sdd"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("seats: 3");
    });
  });

  test("targeted with 2 listed reviewers → 2 seats, exit 0", () => {
    withAssignment(assignmentWithMode("targeted"), (file) => {
      const result = runCli(["review", "seats", file, "--reviewers", "qc-specialist, qc-specialist-2"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("seats: 2");
    });
  });

  test("targeted without listed reviewers → dispatch.execution-mode.missing-seats, exit 1", () => {
    withAssignment(assignmentWithMode("targeted"), (file) => {
      const result = runCli(["review", "seats", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("dispatch.execution-mode.missing-seats");
    });
  });

  test("unknown mode → dispatch.execution-mode.unknown, exit 1", () => {
    withAssignment(assignmentWithMode("parallel"), (file) => {
      const result = runCli(["review", "seats", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("dispatch.execution-mode.unknown");
    });
  });

  test("targeted with 4 reviewers → dispatch.execution-mode.too-many-seats, exit 1", () => {
    withAssignment(assignmentWithMode("targeted"), (file) => {
      const result = runCli(["review", "seats", file, "--reviewers", "a,b,c,d"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("dispatch.execution-mode.too-many-seats");
    });
  });

  test("assignment without Execution mode → dispatch.execution-mode.missing, exit 1", () => {
    withAssignment(
      `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/foo
`,
      (file) => {
        const result = runCli(["review", "seats", file]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("dispatch.execution-mode.missing");
      },
    );
  });

  test("sdd with wrong initial-wave reviewers → dispatch.tri-identity.invalid, exit 1", () => {
    withAssignment(assignmentWithMode("sdd"), (file) => {
      const result = runCli(["review", "seats", file, "--reviewers", "qc-specialist, qc-specialist-2"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("dispatch.tri-identity.invalid");
    });
  });

  test("sdd with the exact tri roles → seats: 3, exit 0", () => {
    withAssignment(assignmentWithMode("sdd"), (file) => {
      const result = runCli(["review", "seats", file, "--reviewers", "qc-specialist, qc-specialist-2, qc-specialist-3"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("seats: 3");
    });
  });

  test("missing <assignment-file> arg → usage, exit 2", () => {
    const result = runCli(["review", "seats"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: review seats");
  });

  test("nonexistent assignment file → exit 1 with file error", () => {
    const result = runCli(["review", "seats", "/no/such/assignment.md"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("assignment file not found");
  });
});
