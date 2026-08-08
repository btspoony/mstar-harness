/**
 * CLI `mstar worktree check` — thin engine-backed wrapper over
 * `l1PreDispatchCheck` (control/feature isolation + lease worktree
 * existence + branch alignment from status.json) and `l2PreDispatchCheck`
 * (parallel writable tracks) — mstar-branch-worktree L1/L2 tables.
 *
 * Exit codes: 0 = OK, 1 = violations / status errors, 2 = usage (missing
 * plan-id/--plan in L1, missing/invalid --tracks JSON in L2; slice-2
 * in-handler convention).
 *
 * Each case runs the real CLI as a subprocess against temp fixtures: a
 * real git repo + linked worktree for branch probes, plain dirs otherwise.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

/**
 * Spawn env with ambient harness env vars pinned out (qc3 F-4): the CLI
 * resolves harness dirs from MSTAR_HARNESS_DIR ahead of probing — an
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
function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Create a git repo at `root` (base commit) + a linked worktree at
 * `root/linked` on branch `feature/plan-a`. Returns the linked worktree
 * path; the repo root doubles as the control-worktree path in fixtures.
 */
function worktreeFixture(root: string): string {
  git(["init", "-q"], root);
  git(["config", "user.email", "worktree-cli-test@example.com"], root);
  git(["config", "user.name", "Worktree CLI Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  const linked = join(root, "linked");
  git(["worktree", "add", "-q", linked, "-b", "feature/plan-a"], root);
  return linked;
}

/** Write status.json into `dir`; returns the status file path. */
function writeStatus(dir: string, doc: Record<string, unknown>): string {
  const statusPath = join(dir, "status.json");
  writeFileSync(statusPath, JSON.stringify(doc, null, 2));
  return statusPath;
}

const LEASE = (worktreePath: string, workingBranch = "feature/plan-a") => ({
  holder: "worktree-cli-test",
  claimed_at: "2026-08-08",
  worktree_path: worktreePath,
  working_branch: workingBranch,
});

describe("mstar worktree check — L1 (control/feature isolation + branch alignment)", () => {
  test("real control fixture: lease worktree exists on the lease branch → OK, exit 0", () => {
    const root = tmpRoot("mstar-wt-l1-ok-");
    try {
      const linked = worktreeFixture(root);
      const statusPath = writeStatus(root, {
        metadata: { control_worktree_path: root },
        plans: [{ id: "plan-a", title: "Plan A", status: "InProgress", execution_lease: LEASE(linked) }],
      });
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--status", statusPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lease worktree equals control path → worktree.l1.lease-equals-control, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-eq-");
    try {
      const statusPath = writeStatus(root, {
        metadata: { control_worktree_path: root },
        plans: [{ id: "plan-a", title: "Plan A", status: "InProgress", execution_lease: LEASE(root) }],
      });
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--status", statusPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.lease-equals-control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lease worktree directory missing → worktree.l1.feature-missing, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-miss-");
    try {
      const missing = join(root, "no-such-worktree");
      const statusPath = writeStatus(root, {
        metadata: { control_worktree_path: root },
        plans: [{ id: "plan-a", title: "Plan A", status: "InProgress", execution_lease: LEASE(missing) }],
      });
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--status", statusPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.feature-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("branch mismatch in the lease worktree → worktree.l1.branch-mismatch, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-br-");
    try {
      const linked = worktreeFixture(root);
      const statusPath = writeStatus(root, {
        metadata: { control_worktree_path: root },
        plans: [{ id: "plan-a", title: "Plan A", status: "InProgress", execution_lease: LEASE(linked, "feature/wrong") }],
      });
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--status", statusPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.branch-mismatch");
      expect(result.stderr).toContain("feature/plan-a");
      expect(result.stderr).toContain("feature/wrong");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no plan row → worktree.l1.plan-not-found, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-noplan-");
    try {
      const statusPath = writeStatus(root, { plans: [] });
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--status", statusPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.plan-not-found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--control override wins over status.json metadata", () => {
    const root = tmpRoot("mstar-wt-l1-ctrl-");
    try {
      const linked = worktreeFixture(root);
      // metadata records a bogus control path; --control pins the real one.
      const statusPath = writeStatus(root, {
        metadata: { control_worktree_path: join(root, "bogus-control") },
        plans: [{ id: "plan-a", title: "Plan A", status: "InProgress", execution_lease: LEASE(linked) }],
      });
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--status", statusPath, "--control", root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("positional plan-id: worktree check <plan-id> --status <path> → OK, exit 0", () => {
    const root = tmpRoot("mstar-wt-l1-pos-");
    try {
      const linked = worktreeFixture(root);
      const statusPath = writeStatus(root, {
        metadata: { control_worktree_path: root },
        plans: [{ id: "plan-a", title: "Plan A", status: "InProgress", execution_lease: LEASE(linked) }],
      });
      const result = runCli(["worktree", "check", "plan-a", "--status", statusPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two matching plan rows (id + plan_id) → worktree.l1.ambiguous, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-amb-");
    try {
      const statusPath = writeStatus(root, {
        metadata: { control_worktree_path: root },
        plans: [
          { id: "plan-a", title: "Plan A", status: "InProgress", execution_lease: LEASE(root) },
          { plan_id: "plan-a", title: "Plan A (legacy)", status: "InProgress", execution_lease: LEASE(root) },
        ],
      });
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--status", statusPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.ambiguous");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no --control and no metadata.control_worktree_path → worktree.l1.control-missing, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-ctrlmiss-");
    try {
      const statusPath = writeStatus(root, {
        plans: [{ id: "plan-a", title: "Plan A", status: "InProgress", execution_lease: LEASE(root) }],
      });
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--status", statusPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.control-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing plan-id and --plan → usage, exit 2", () => {
    const result = runCli(["worktree", "check"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: worktree check <plan-id>");
  });
});

describe("mstar worktree check — L2 (parallel writable tracks)", () => {
  test("tracks with existing worktrees on the right branches → OK, exit 0", () => {
    const root = tmpRoot("mstar-wt-l2-ok-");
    try {
      const linked = worktreeFixture(root);
      const tracks = JSON.stringify([{ worktreePath: linked, workingBranch: "feature/plan-a" }]);
      const result = runCli(["worktree", "check", "--l2", "--tracks", tracks]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L2 check: OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing track worktree dir → worktree.l2.track-missing, exit 1", () => {
    const root = tmpRoot("mstar-wt-l2-miss-");
    try {
      const missing = join(root, "no-such-track");
      const tracks = JSON.stringify([{ worktreePath: missing, workingBranch: "feature/plan-a" }]);
      const result = runCli(["worktree", "check", "--l2", "--tracks", tracks]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l2.track-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("track branch mismatch → worktree.l2.branch-mismatch, exit 1", () => {
    const root = tmpRoot("mstar-wt-l2-br-");
    try {
      const linked = worktreeFixture(root);
      const tracks = JSON.stringify([{ worktreePath: linked, workingBranch: "feature/other" }]);
      const result = runCli(["worktree", "check", "--l2", "--tracks", tracks]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l2.branch-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty tracks array → worktree.l2.no-tracks, exit 1", () => {
    const result = runCli(["worktree", "check", "--l2", "--tracks", "[]"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("worktree.l2.no-tracks");
  });

  test("--l2 without --tracks → usage, exit 2", () => {
    const result = runCli(["worktree", "check", "--l2"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: worktree check --l2 --tracks");
  });

  test("--tracks invalid JSON → usage, exit 2", () => {
    const result = runCli(["worktree", "check", "--l2", "--tracks", "{not json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid JSON");
  });

  test("--tracks not an array → usage, exit 2", () => {
    const result = runCli(["worktree", "check", "--l2", "--tracks", '{"worktreePath": "/x"}' ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("expected a JSON array");
  });

  test("--tracks entry missing workingBranch → usage, exit 2", () => {
    const result = runCli(["worktree", "check", "--l2", "--tracks", '[{"worktreePath": "/abs/path"}]']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("every track needs string worktreePath + workingBranch");
  });
});
