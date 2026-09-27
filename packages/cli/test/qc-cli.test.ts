/**
 * CLI `mstar qc validate-report` — thin engine-backed wrapper over the QC
 * seat-report contract (`validateQcReport`; `mstar-review-qc` SKILL.md
 * § 席位预算与截断 / report-template.md § Report body template / § Findings).
 *
 * Exit codes: 0 = conforming report, 1 = violations printed (or bad input).
 * Each case runs the real CLI as a subprocess against temp fixtures.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entry as a subprocess. */
function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function envelope(result: RunResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Temp scratch file cleaned up after `fn`. */
function withReport(text: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mstar-qc-cli-"));
  try {
    const path = join(dir, "qc.md");
    writeFileSync(path, text);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Synthetic, contract-conforming seat report (ids are synthetic, never real). */
const VALID_REPORT = `---
report_kind: "qc"
reviewer: "qc-specialist-2"
reviewer_index: 2
plan_id: "20990101-synthetic"
verdict: "Approve"
generated_at: "2099-01-01"
---
# Code Review Report

## Summary

| Severity | Count |
| --- | --- |
| \ud83d\udd34 Critical | 0 |
| \ud83d\udfe1 Warning | 0 |
| \ud83d\udfe2 Suggestion | 1 |
| \u26aa Unconfirmed | 0 |

## Findings

### \ud83d\udd34 Critical

None.

### \ud83d\udfe1 Warning

None.

### \ud83d\udfe2 Suggestion

- **S-1** inline the single-use helper.

### \u26aa Unconfirmed

None.

**Verdict**: Approve. Nothing blocking survived.
`;

describe("mstar qc validate-report", () => {
  test("conforming report returns zero violations", () => {
    withReport(VALID_REPORT, (path) => {
      const result = runCli(["qc", "validate-report", path]);
      expect(result.exitCode).toBe(0);
      expect(envelope(result)).toMatchObject({ status: "ok", data: { ok: true, violations: [] } });
    });
  });


  test("stale Summary counts exit 1 with the violation code and a fix", () => {
    withReport(VALID_REPORT.replace("| \ud83d\udfe2 Suggestion | 1 |", "| \ud83d\udfe2 Suggestion | 0 |"), (path) => {
      const result = runCli(["qc", "validate-report", path]);
      expect(result.exitCode).toBe(1);
      const response = envelope(result);
      expect(response.status).toBe("refused");
      expect(response.code).toBe("qcreview.report.summary-count-mismatch");
      expect((response.details as { violations: Array<{ fix: string }> }).violations[0]?.fix).toContain("recount");
    });
  });

  test("a report with no frontmatter exits 1", () => {
    withReport("# Code Review Report\n\n**Verdict**: Approve\n", (path) => {
      const result = runCli(["qc", "validate-report", path]);
      expect(result.exitCode).toBe(1);
      expect(envelope(result).code).toBe("qcreview.report.missing-frontmatter");
    });
  });
});
