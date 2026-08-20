/**
 * CLI `mstar lease verify` — execution_lease verification over the v3
 * workflow snapshot plan row.
 *
 * The engine validates the lease object itself; the CLI resolves
 * `--workflow <id>` to `{HARNESS_DIR}/workflows/<id>/snapshot.json` and
 * feeds the engine the row. v3 hard cutover (compass ruling 7): the
 * snapshot plan row `plans[].execution_lease` is the ONLY lease location —
 * the v1-era `metadata.execution_lease` legacy read-compat and the
 * metadata/dual-write branches were deleted with the v1 read path
 * (engine `planExecutionLeaseLocations` is `{ row }` now):
 * - Row-level `plans[].execution_lease` valid → exit 0 (OK).
 * - Neither → `lease.verify.missing` (non-InProgress) /
 *   `lease.verify.orphan` (InProgress), exit 1.
 * - `--plan` selects the row; omitted → the snapshot's sole plan row is
 *   used (0 rows / 2+ rows without --plan → clear error, exit 1/2).
 *
 * Each case runs the real CLI as a subprocess against a temp harness with
 * `workflows/<id>/snapshot.json` and asserts the exit code + reported
 * violation codes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planExecutionLeaseLocations, verifyPlanExecutionLease } from "@mstar-harness/engine";
import {
  planExecutionLeaseLocations as cliLocations,
  verifyPlanExecutionLease as cliVerify,
} from "../src/lease-verify";

/**
 * Spawn env with ambient MSTAR_HARNESS_DIR pinned out (qc3 F-4): the CLI
 * resolves harness dirs from that env var ahead of probing, so an ambient
 * value would redirect every fixture to the env dir and fail spuriously.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Valid lease by engine rules (claimed_at dual-format read-compat included). */
const VALID_LEASE = {
  holder: "omp-pm-session-test",
  claimed_at: "2026-08-08",
  worktree_path: "/repo-worktrees/plan-a",
  working_branch: "feature/plan-a",
};

const CLI_ROOT = resolve(import.meta.dir, "..");

function runVerify(
  fixtureDir: string,
  args: string[] = [],
  planId = "plan-a",
  workflowId = "wf-1",
): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(
    [process.execPath, "run", "src/index.ts", "lease", "verify", "--workflow", workflowId, "--plan", planId, "--harness", fixtureDir, ...args],
    { cwd: CLI_ROOT, env: cliEnv(), stdout: "pipe", stderr: "pipe" },
  );
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function planRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { plan_id: "plan-a", title: "Plan A", status: "InProgress", ...overrides };
}

function snapshot(plans: unknown[]): Record<string, unknown> {
  return { schema_version: 1, id: "wf-1", type: "plan", status: "running", started_at: "2026-08-08", updated_at: "2026-08-08", plans };
}

function withFixture(snapshot: Record<string, unknown>, fn: (dir: string) => void, workflowId = "wf-1"): void {
  const dir = makeHarnessWithSnapshot(snapshot, workflowId);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeHarnessWithSnapshot(snapshot: Record<string, unknown>, workflowId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mstar-lease-verify-"));
  const workflowDir = join(dir, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  return dir;
}

describe("CLI lease-verify wrapper (qc1 F-001)", () => {
  test("re-exports the engine gate unchanged (thin wrapper, no CLI-side logic)", () => {
    expect(cliVerify).toBe(verifyPlanExecutionLease);
    expect(cliLocations).toBe(planExecutionLeaseLocations);
  });
});

describe("mstar lease verify — workflow snapshot plan-row execution_lease", () => {
  test("row-level plans[].execution_lease valid → OK, exit 0", () => {
    withFixture(snapshot([planRow({ execution_lease: VALID_LEASE })]), (dir) => {
      const result = runVerify(dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK plan plan-a");
      expect(result.stdout).toContain("holder omp-pm-session-test");
      expect(result.stderr).toBe("");
    });
  });

  test("--plan omitted uses the snapshot's sole plan row → OK, exit 0", () => {
    withFixture(snapshot([planRow({ execution_lease: VALID_LEASE })]), (dir) => {
      const proc = Bun.spawnSync(
        [process.execPath, "run", "src/index.ts", "lease", "verify", "--workflow", "wf-1", "--harness", dir],
        { cwd: CLI_ROOT, env: cliEnv(), stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toContain("OK plan plan-a");
    });
  });

  test("no plan rows and no --plan → clear error (exit 1), never a silent pass", () => {
    withFixture(snapshot([]), (dir) => {
      const proc = Bun.spawnSync(
        [process.execPath, "run", "src/index.ts", "lease", "verify", "--workflow", "wf-1", "--harness", dir],
        { cwd: CLI_ROOT, env: cliEnv(), stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("no plan rows");
      expect(proc.stderr.toString()).toContain("--plan");
    });
  });

  test("2+ plan rows without --plan → clear error asking for --plan (exit 1)", () => {
    withFixture(snapshot([planRow(), planRow({ plan_id: "plan-b" })]), (dir) => {
      const proc = Bun.spawnSync(
        [process.execPath, "run", "src/index.ts", "lease", "verify", "--workflow", "wf-1", "--harness", dir],
        { cwd: CLI_ROOT, env: cliEnv(), stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("2 plan rows");
      expect(proc.stderr.toString()).toContain("--plan");
    });
  });

  test("neither location, non-InProgress plan → lease.verify.missing, exit 1", () => {
    withFixture(snapshot([planRow({ status: "Todo" })]), (dir) => {
      const result = runVerify(dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lease.verify.missing");
    });
  });

  test("neither location, InProgress plan → lease.verify.orphan, exit 1", () => {
    withFixture(snapshot([planRow({})]), (dir) => {
      const result = runVerify(dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lease.verify.orphan");
    });
  });

  test("row-level lease with shape violations → FAIL with engine violation codes, exit 1", () => {
    withFixture(
      snapshot([planRow({ execution_lease: { ...VALID_LEASE, worktree_path: "relative/worktree" } })]),
      (dir) => {
        const result = runVerify(dir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("lease.execution-lease.invalid-worktree-path");
        expect(result.stdout).not.toContain("OK plan");
      },
    );
  });

  test("plan row missing from the snapshot → lease.verify.plan-not-found, exit 1", () => {
    withFixture(snapshot([planRow({ plan_id: "plan-b" })]), (dir) => {
      const result = runVerify(dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lease.verify.plan-not-found");
    });
  });

  test("missing workflow snapshot → exit 1 with snapshot path", () => {
    withFixture(snapshot([]), (dir) => {
      const proc = Bun.spawnSync(
        [process.execPath, "run", "src/index.ts", "lease", "verify", "--workflow", "no-such-wf", "--plan", "plan-a", "--harness", dir],
        { cwd: CLI_ROOT, env: cliEnv(), stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("workflow snapshot not found");
    });
  });

  test("missing --workflow is a usage error (exit 2)", () => {
    const proc = Bun.spawnSync(
      [process.execPath, "run", "src/index.ts", "lease", "verify", "--plan", "plan-a"],
      { cwd: CLI_ROOT, env: cliEnv(), stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("usage: lease verify --workflow <id>");
  });

  test("hostile workflow id (path traversal) is rejected, exit 1", () => {
    const dir = makeHarnessWithSnapshot(snapshot([]), "wf-1");
    try {
      const proc = Bun.spawnSync(
        [process.execPath, "run", "src/index.ts", "lease", "verify", "--workflow", "../../etc", "--plan", "plan-a", "--harness", dir],
        { cwd: CLI_ROOT, env: cliEnv(), stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("invalid workflow id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("custom `.mstarc` workflow_dir: the snapshot is read at the DECLARED location (Phase-5 F1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-lease-custom-"));
    try {
      writeFileSync(join(dir, ".mstarc"), "[config]\nworkflow_dir=custom-wf\n", "utf8");
      const workflowDir = join(dir, "custom-wf", "wf-1");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        join(workflowDir, "snapshot.json"),
        JSON.stringify(snapshot([planRow({ execution_lease: VALID_LEASE })]), null, 2),
      );
      const proc = Bun.spawnSync(
        [process.execPath, "run", "src/index.ts", "lease", "verify", "--workflow", "wf-1", "--harness", dir],
        { cwd: CLI_ROOT, env: cliEnv(), stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toContain("OK plan plan-a");
      // The hardcoded default-layout dir is NEVER consulted.
      expect(existsSync(join(dir, "workflows"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
