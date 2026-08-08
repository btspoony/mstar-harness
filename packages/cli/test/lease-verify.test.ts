/**
 * CLI `mstar lease verify` — execution_lease SSOT-location matrix.
 *
 * The engine validates the lease object itself; the CLI decides *where* a
 * lease may live (status-and-residuals.md § `plans[].execution_lease`; ADR
 * 2026-07-22-iteration-worktree-plan-lease.md A3 — the plan row is SSOT):
 * - Row-level `plans[].execution_lease` valid → exit 0 (OK).
 * - Metadata-only (`plans[].metadata.execution_lease`) → high-severity
 *   `lease.verify.non-ssot-location`, exit 1 (legacy read-compat fallback is
 *   NOT equivalent to SSOT success; no documented compat mode).
 * - Both locations → `lease.verify.dual-write`, exit 1 (row-level wins and
 *   is validated).
 * - Neither → `lease.verify.missing` (non-InProgress) / `lease.verify.orphan`
 *   (InProgress), exit 1.
 *
 * Each case runs the real CLI as a subprocess against a temp status.json
 * fixture and asserts the exit code + reported violation codes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Write a temp harness dir with the given status.json document. */
function makeFixture(doc: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "mstar-lease-verify-"));
  writeFileSync(join(dir, "status.json"), JSON.stringify(doc, null, 2));
  return dir;
}

function runVerify(fixtureDir: string, planId = "plan-a"): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(
    [process.execPath, "run", "src/index.ts", "lease", "verify", planId, "--harness", fixtureDir],
    { cwd: CLI_ROOT, env: cliEnv(), stdout: "pipe", stderr: "pipe" },
  );
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function planRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { plan_id: "plan-a", title: "Plan A", status: "InProgress", ...overrides };
}

function withFixture(doc: Record<string, unknown>, fn: (dir: string) => void): void {
  const dir = makeFixture(doc);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("CLI lease-verify wrapper (qc1 F-001)", () => {
  test("re-exports the engine gate unchanged (thin wrapper, no CLI-side logic)", () => {
    expect(cliVerify).toBe(verifyPlanExecutionLease);
    expect(cliLocations).toBe(planExecutionLeaseLocations);
  });
});

describe("mstar lease verify — execution_lease location matrix", () => {
  test("row-level plans[].execution_lease valid → OK, exit 0", () => {
    withFixture({ plans: [planRow({ execution_lease: VALID_LEASE })] }, (dir) => {
      const result = runVerify(dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK plan plan-a");
      expect(result.stdout).toContain("holder omp-pm-session-test");
      expect(result.stderr).toBe("");
    });
  });

  test("metadata-only lease → lease.verify.non-ssot-location, exit 1 (not SSOT success)", () => {
    withFixture(
      { plans: [planRow({ metadata: { execution_lease: VALID_LEASE } })] },
      (dir) => {
        const result = runVerify(dir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("lease.verify.non-ssot-location");
        expect(result.stdout).not.toContain("OK plan");
      },
    );
  });

  test("both row-level and metadata leases → lease.verify.dual-write, exit 1 (row wins)", () => {
    withFixture(
      {
        plans: [
          planRow({
            execution_lease: VALID_LEASE,
            metadata: { execution_lease: { ...VALID_LEASE, holder: "stale-metadata-holder" } },
          }),
        ],
      },
      (dir) => {
        const result = runVerify(dir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("lease.verify.dual-write");
        expect(result.stdout).not.toContain("OK plan");
      },
    );
  });

  test("neither location, non-InProgress plan → lease.verify.missing, exit 1", () => {
    withFixture({ plans: [planRow({ status: "Todo" })] }, (dir) => {
      const result = runVerify(dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lease.verify.missing");
    });
  });

  test("neither location, InProgress plan → lease.verify.orphan, exit 1", () => {
    withFixture({ plans: [planRow({})] }, (dir) => {
      const result = runVerify(dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lease.verify.orphan");
    });
  });

  test("row-level lease with shape violations → FAIL with engine violation codes, exit 1", () => {
    withFixture(
      { plans: [planRow({ execution_lease: { ...VALID_LEASE, worktree_path: "relative/worktree" } })] },
      (dir) => {
        const result = runVerify(dir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("lease.execution-lease.invalid-worktree-path");
        expect(result.stdout).not.toContain("OK plan");
      },
    );
  });
});
