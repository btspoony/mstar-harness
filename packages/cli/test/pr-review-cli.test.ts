/**
 * CLI `mstar pr-review` — thin engine-backed wrappers over the Task 1/3
 * engine APIs (`computePrTally` / `prReviewReportPath` /
 * `validatePrReviewReport`, pr-review.md § Tally / § Local report archive /
 * § Output shape).
 *
 * Exit codes: 0 = success, 1 = violations / bad input, 2 = usage (missing
 * required option, bad --target / --stage / --slug pairing).
 *
 * Each case runs the real CLI as a subprocess against temp fixtures and
 * asserts the exit code + printed output.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Run the real CLI entry as a subprocess. */
function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Temp scratch dir cleaned up after `fn`. */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mstar-pr-review-cli-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("mstar pr-review tally", () => {
  test("happy path prints the two-line chat header + structured tally (exit 0)", () => {
    withTempDir((dir) => {
      const findings = join(dir, "findings.json");
      writeFileSync(findings, JSON.stringify([{ mergeClass: "should-fix" }, { mergeClass: "nit" }, { mergeClass: "nit" }]));
      const result = runCli(["pr-review", "tally", "--findings", findings, "--unverified", "1"]);
      expect(result.exitCode).toBe(0);
      // § Display contract verbatim two-liner: 100 - 15 - 6 - 10 = 69.
      expect(result.stdout).toContain("needs fixes · 69%");
      expect(result.stdout).toContain("must-fix=0 should-fix=1 nit=2 unverified=1");
      expect(result.stdout).toContain('"verdict": "needs fixes"');
      expect(result.stdout).toContain('"scorePct": 69');
    });
  });

  test("unmet-AC flags feed the increments (--unmet-ac-unsafe → must_fix)", () => {
    withTempDir((dir) => {
      const findings = join(dir, "findings.json");
      writeFileSync(findings, "[]");
      const result = runCli([
        "pr-review",
        "tally",
        "--findings",
        findings,
        "--unmet-ac-unsafe",
        "1",
        "--unmet-ac-safe",
        "2",
      ]);
      expect(result.exitCode).toBe(0);
      // blocked · 60% (unsafe AC → must_fix), safe ACs × 15 → score floor at 0+... 100-40-30 = 30
      expect(result.stdout).toContain("blocked · 30%");
      expect(result.stdout).toContain("must-fix=1 should-fix=2 nit=0 unverified=0");
    });
  });

  test("bad mergeClass exits 1 with the offending index named", () => {
    withTempDir((dir) => {
      const findings = join(dir, "findings.json");
      writeFileSync(findings, '[{"mergeClass":"blocker"}]');
      const result = runCli(["pr-review", "tally", "--findings", findings]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('findings[0].mergeClass "blocker"');
      expect(result.stderr).toContain("must-fix | should-fix | nit");
    });
  });

  test("missing findings file exits 1", () => {
    withTempDir((dir) => {
      const result = runCli(["pr-review", "tally", "--findings", join(dir, "absent.json")]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not found");
    });
  });

  test("malformed findings JSON exits 1 (plan-QC F-003)", () => {
    withTempDir((dir) => {
      const findings = join(dir, "findings.json");
      writeFileSync(findings, "{");
      const result = runCli(["pr-review", "tally", "--findings", findings]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--findings is not valid JSON");
    });
  });

  test("non-array findings JSON (object) exits 1 (plan-QC F-003)", () => {
    withTempDir((dir) => {
      const findings = join(dir, "findings.json");
      writeFileSync(findings, '{"mergeClass":"must-fix"}');
      const result = runCli(["pr-review", "tally", "--findings", findings]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must be a JSON array");
    });
  });

  test.each(["1e2", "0x10", "-3"])("count flag %s rejected with exit 1 — digits-only grammar (plan-QC F-004)", (raw) => {
    withTempDir((dir) => {
      const findings = join(dir, "findings.json");
      writeFileSync(findings, "[]");
      const result = runCli(["pr-review", "tally", "--findings", findings, "--unverified", raw]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--unverified must be a non-negative integer");
    });
  });

  test("count flags over the 50-entry cap exit 1 (plan-QC S-02)", () => {
    withTempDir((dir) => {
      const findings = join(dir, "findings.json");
      writeFileSync(findings, "[]");
      const result = runCli(["pr-review", "tally", "--findings", findings, "--unmet-ac-unsafe", "51"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("too many --unmet-ac-unsafe values (cap 50)");
    });
  });
});

describe("mstar pr-review report-path", () => {
  test("pr target resolves <date>-pr<N>.md and escalates to -r2 on collision", () => {
    withTempDir((dir) => {
      const reportsDir = join(dir, "reports");
      mkdirSync(reportsDir);
      writeFileSync(join(reportsDir, "2026-08-24-pr134.md"), "prior report — never overwritten");
      const first = runCli(["pr-review", "report-path", "--reports-dir", reportsDir, "--target", "pr:134", "--date", "2026-08-24"]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout.trim()).toBe(join(reportsDir, "2026-08-24-pr134-r2.md"));
    });
  });

  test("fresh directory yields the plain stem (never overwrites)", () => {
    withTempDir((dir) => {
      const reportsDir = join(dir, "empty");
      const result = runCli(["pr-review", "report-path", "--reports-dir", reportsDir, "--target", "pr:9", "--date", "2026-08-24"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(join(reportsDir, "2026-08-24-pr9.md"));
    });
  });

  test("branch / diff-sha / bare diff targets resolve per SSOT Filename bullet", () => {
    withTempDir((dir) => {
      const reportsDir = join(dir, "reports");
      mkdirSync(reportsDir);
      for (const [target, expected] of [
        ["branch:feat-x", "2026-08-24-feat-x.md"],
        ["diff:abc1234def5678", "2026-08-24-diff-abc1234.md"],
        ["diff", "2026-08-24-diff.md"], // empty dir → no -rN escalation; never fabricates a SHA segment
      ] as const) {
        const fresh = join(dir, `reports-${target.replace(/[^a-z0-9]+/gi, "-")}`);
        mkdirSync(fresh);
        const result = runCli(["pr-review", "report-path", "--reports-dir", fresh, "--target", target, "--date", "2026-08-24"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(join(fresh, expected));
      }
    });
  });

  test("--stage without --slug is a usage error (exit 2)", () => {
    withTempDir((dir) => {
      const result = runCli([
        "pr-review",
        "report-path",
        "--reports-dir",
        join(dir, "r"),
        "--target",
        "pr:7",
        "--stage",
        "1",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--stage and --slug go together");
    });
  });

  test("--stage with --slug composes the evidence-file stem", () => {
    withTempDir((dir) => {
      const reportsDir = join(dir, "evidence");
      const result = runCli([
        "pr-review",
        "report-path",
        "--reports-dir",
        reportsDir,
        "--target",
        "pr:7",
        "--date",
        "2026-08-24",
        "--stage",
        "2",
        "--slug",
        "backend-qc1",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(join(reportsDir, "2026-08-24-pr7-stage2-backend-qc1.md"));
    });
  });

  test("unknown target kind exits 2", () => {
    withTempDir((dir) => {
      const result = runCli(["pr-review", "report-path", "--reports-dir", join(dir, "r"), "--target", "sha:deadbeef"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("pr:<n> | branch:<slug> | diff:<sha> | diff");
    });
  });
});

/** Minimal valid report fixture (engine test parity); each test corrupts one facet. */
function report(frontmatter: string): string {
  return `---
type: pr-review
verdict: needs fixes
score_pct: 79
tally: { must-fix: 0, should-fix: 1, nit: 2, unverified: 0 }
comments: posted
review_url: https://github.com/example/repo/pull/134#pullrequestreview-1
generated_at: 2026-08-24
${frontmatter}---

body
`;
}

describe("mstar pr-review validate-report", () => {
  test("valid report passes (exit 0)", () => {
    withTempDir((dir) => {
      const file = join(dir, "report.md");
      writeFileSync(file, report(""));
      const result = runCli(["pr-review", "validate-report", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    });
  });

  test("score-mismatch report fails with violations printed (exit 1)", () => {
    withTempDir((dir) => {
      const file = join(dir, "report.md");
      writeFileSync(file, report("").replace("score_pct: 79", "score_pct: 90"));
      const result = runCli(["pr-review", "validate-report", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("FAIL");
      expect(result.stderr).toContain("prreview.report.score-mismatch");
    });
  });

  test("failed POST collapsed into n/a-no-pr is flagged high (exit 1)", () => {
    withTempDir((dir) => {
      const file = join(dir, "report.md");
      writeFileSync(
        file,
        report("")
          .replace("comments: posted", "comments: n/a-no-pr")
          .replace(
            "review_url: https://github.com/example/repo/pull/134#pullrequestreview-1",
            "review_url: failed: gh: Resource not accessible by integration",
          ),
      );
      const result = runCli(["pr-review", "validate-report", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("prreview.report.failed-comments-collapsed");
    });
  });

  test("no-frontmatter file fails (exit 1)", () => {
    withTempDir((dir) => {
      const file = join(dir, "plain.md");
      writeFileSync(file, "# just prose\n");
      const result = runCli(["pr-review", "validate-report", file]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("prreview.report.missing-frontmatter");
    });
  });
});
