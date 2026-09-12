/**
 * CLI `mstar worktree check` — thin engine-backed wrapper over
 * `l1PreDispatchCheck` (main-worktree residency + integration topology +
 * feature/lease isolation) and `l2PreDispatchCheck` (parallel writable
 * tracks) — mstar-branch-worktree L1/L2 tables.
 *
 * L1 input in v3 comes from the workflow snapshot through the canonical
 * reader (`readWorkflowSnapshot` — the v1 `control_worktree_path` key is
 * accepted as an in-memory alias with a medium migration advisory): plan
 * rows (with `plans[].execution_lease`), `integration_worktree_path` +
 * `branch.integration`, and the Git-derived main worktree. `--integration`
 * overrides the snapshot integration path; `--control` is the deprecated
 * one-release alias (stderr notice; both flags together are usage exit 2).
 * `--main-branch` transports the RECORDED main-worktree branch (plan
 * header); the expectation falls back to the explicit `branch.base`, never
 * to the branch observed at check time. Process-harness resolution starts
 * at the verified main worktree, so a tracked-results `.mstar/` in a linked
 * feature checkout cannot win discovery. L2 is unchanged.
 *
 * Exit codes: 0 = OK, 1 = violations / status errors, 2 = usage.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const WORKFLOW_ID = "wf-1";

/**
 * Spawn env with ambient harness env vars pinned out: the CLI
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
function runCli(args: string[], cwd: string = CLI_ROOT): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd,
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
 * path; the repo root doubles as the main worktree in fixtures.
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

/**
 * Three-domain topology fixture: main repo at `root` on its default branch
 * (the recorded residency), a feature worktree at `root/linked` on
 * `feature/plan-a` (optionally nested under an arbitrary folder — the
 * documented `.worktrees` layout), and the dedicated integration worktree
 * at `root/integration` on `iteration/<WORKFLOW_ID>`.
 */
function topologyFixture(
  root: string,
  opts: { nested?: boolean } = {},
): { linked: string; integration: string; mainBranch: string; featureBranch: string; integrationBranch: string } {
  git(["init", "-q"], root);
  git(["config", "user.email", "worktree-cli-test@example.com"], root);
  git(["config", "user.name", "Worktree CLI Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  const mainBranch = git(["branch", "--show-current"], root);
  const linked = opts.nested === true ? join(root, "nested-checkouts", "wt-plan-a") : join(root, "linked");
  git(["worktree", "add", "-q", linked, "-b", "feature/plan-a"], root);
  const integration = join(root, "integration");
  const integrationBranch = `iteration/${WORKFLOW_ID}`;
  git(["worktree", "add", "-q", integration, "-b", integrationBranch], root);
  return { linked, integration, mainBranch, featureBranch: "feature/plan-a", integrationBranch };
}

/** Write `workflows/<id>/snapshot.json` into `dir`; returns the snapshot path. */
function writeSnapshot(dir: string, doc: Record<string, unknown>): string {
  const workflowDir = join(dir, "workflows", WORKFLOW_ID);
  mkdirSync(workflowDir, { recursive: true });
  const snapshotPath = join(workflowDir, "snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(doc, null, 2));
  return snapshotPath;
}

/** Base snapshot doc: single running workflow with the given plans. */
function snapshotDoc(plans: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "iteration",
    status: "running",
    started_at: "2026-08-08",
    updated_at: "2026-08-08",
    plans,
    ...extra,
  };
}

/** Full-iteration snapshot over a topology: branch anchors + integration path. */
function iterationSnapshotDoc(
  topo: ReturnType<typeof topologyFixture>,
  plans: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return snapshotDoc(plans, {
    branch: { base: topo.mainBranch, integration: topo.integrationBranch },
    integration_worktree_path: topo.integration,
    ...extra,
  });
}

/** Standalone-plan snapshot: main vs feature only (no integration topology). */
function standaloneSnapshotDoc(mainBranch: string, plans: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return snapshotDoc(plans, { type: "plan", branch: { base: mainBranch }, ...extra });
}

const LEASE = (worktreePath: string, workingBranch = "feature/plan-a") => ({
  holder: "worktree-cli-test",
  claimed_at: "2026-08-08",
  worktree_path: worktreePath,
  working_branch: workingBranch,
});

const PLAN_A = (worktreePath: string, workingBranch = "feature/plan-a") => ({
  id: "plan-a",
  title: "Plan A",
  file: "plans/plan-a.md",
  status: "InProgress",
  execution_lease: LEASE(worktreePath, workingBranch),
});

describe("mstar worktree check — L1 (main residency + integration + feature isolation)", () => {
  test("full topology: lease worktree on the lease branch → OK, exit 0, prints main residency", () => {
    const root = tmpRoot("mstar-wt-l1-ok-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(root, iterationSnapshotDoc(topo, [PLAN_A(topo.linked)]));
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", topo.mainBranch],
        root,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
      expect(result.stdout).toContain("main worktree:");
      expect(result.stdout).toContain(topo.mainBranch);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("switched main refuses → worktree.main.residency-switched, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-switched-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(root, iterationSnapshotDoc(topo, [PLAN_A(topo.linked)]));
      git(["checkout", "-q", "-b", "feature/main-switch"], root);
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", topo.mainBranch],
        root,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.main.residency-switched");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no --main-branch and no snapshot branch.base → worktree.main.expected-branch-missing, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-noexp-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(root, snapshotDoc([PLAN_A(topo.linked)], { integration_worktree_path: topo.integration }));
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root],
        root,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.main.expected-branch-missing");
      expect(result.stderr).not.toContain("worktree.main.residency-switched");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recorded main branch falls back to the explicit snapshot branch.base", () => {
    const root = tmpRoot("mstar-wt-l1-basefallback-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(root, iterationSnapshotDoc(topo, [PLAN_A(topo.linked)]));
      const result = runCli(["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root], root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
      expect(result.stdout).toContain(topo.mainBranch);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("v1 control_worktree_path snapshot reads through the canonical reader (advisory, exit 0)", () => {
    const root = tmpRoot("mstar-wt-l1-legacy-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(
        root,
        snapshotDoc([PLAN_A(topo.linked)], {
          branch: { base: topo.mainBranch, integration: topo.integrationBranch },
          control_worktree_path: topo.integration,
        }),
      );
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", topo.mainBranch],
        root,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
      expect(result.stderr).toContain("workflow.snapshot.legacy-control-worktree-path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--integration override wins over the snapshot integration_worktree_path", () => {
    const root = tmpRoot("mstar-wt-l1-int-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(
        root,
        iterationSnapshotDoc(topo, [PLAN_A(topo.linked)], { integration_worktree_path: join(root, "bogus-integration") }),
      );
      const result = runCli(
        [
          "worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root,
          "--main-branch", topo.mainBranch, "--integration", topo.integration,
        ],
        root,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deprecated --control alias behaves identically and warns on stderr", () => {
    const root = tmpRoot("mstar-wt-l1-alias-flag-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(
        root,
        iterationSnapshotDoc(topo, [PLAN_A(topo.linked)], { integration_worktree_path: join(root, "bogus-integration") }),
      );
      const result = runCli(
        [
          "worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root,
          "--main-branch", topo.mainBranch, "--control", topo.integration,
        ],
        root,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
      expect(result.stderr).toContain("--control");
      expect(result.stderr).toContain("deprecated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--integration together with --control → usage, exit 2", () => {
    const root = tmpRoot("mstar-wt-l1-bothflags-");
    try {
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--integration", root, "--control", root],
        root,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage: worktree check <plan-id>");
      expect(result.stderr).toContain("--control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lease worktree is the main worktree → worktree.l1.lease-equals-main, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-eqmain-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(root, iterationSnapshotDoc(topo, [PLAN_A(root, topo.mainBranch)]));
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", topo.mainBranch],
        root,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.lease-equals-main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lease worktree directory missing → worktree.l1.feature-missing, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-miss-");
    try {
      const linked = worktreeFixture(root);
      const mainBranch = git(["branch", "--show-current"], root);
      writeSnapshot(root, standaloneSnapshotDoc(mainBranch, [PLAN_A(join(root, "no-such-worktree"))]));
      const result = runCli(
        ["worktree", "check", "--plan", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", mainBranch],
        root,
      );
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
      const mainBranch = git(["branch", "--show-current"], root);
      writeSnapshot(root, standaloneSnapshotDoc(mainBranch, [PLAN_A(linked, "feature/wrong")]));
      const result = runCli(
        ["worktree", "check", "--plan", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", mainBranch],
        root,
      );
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
      writeSnapshot(root, snapshotDoc([]));
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.plan-not-found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("iteration snapshot without integration_worktree_path → worktree.l1.integration-missing, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-intmiss-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(root, snapshotDoc([PLAN_A(topo.linked)], { branch: { base: topo.mainBranch } }));
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", topo.mainBranch],
        root,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.integration-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hostile workflow id (path traversal) is rejected before any read, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-traversal-");
    try {
      writeSnapshot(root, snapshotDoc([]));
      for (const bad of ["../../etc", "a/b", "..", "."]) {
        const result = runCli(["worktree", "check", "--plan", "plan-a", "--workflow", bad, "--harness", root]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("invalid workflow id");
        expect(result.stderr).not.toContain("workflow snapshot not found");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("positional plan-id: worktree check <plan-id> --workflow <id> → OK, exit 0", () => {
    const root = tmpRoot("mstar-wt-l1-pos-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(root, iterationSnapshotDoc(topo, [PLAN_A(topo.linked)]));
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", topo.mainBranch],
        root,
      );
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
      writeSnapshot(
        root,
        snapshotDoc(
          [
            { id: "plan-a", title: "Plan A", file: "plans/plan-a.md", status: "InProgress", execution_lease: LEASE(root) },
            { plan_id: "plan-a", title: "Plan A (legacy)", file: "plans/plan-a.md", status: "InProgress", execution_lease: LEASE(root) },
          ],
          { control_worktree_path: root },
        ),
      );
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.ambiguous");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested linked worktree inside the main checkout → OK, exit 0 (arbitrary folder name)", () => {
    const root = tmpRoot("mstar-wt-l1-nested-");
    try {
      const topo = topologyFixture(root, { nested: true });
      writeSnapshot(root, iterationSnapshotDoc(topo, [PLAN_A(topo.linked)]));
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", topo.mainBranch],
        root,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plain subdirectory of the main checkout as lease → worktree.l1.lease-equals-main, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-subdir-");
    try {
      git(["init", "-q"], root);
      git(["config", "user.email", "worktree-cli-test@example.com"], root);
      git(["config", "user.name", "Worktree CLI Test"], root);
      writeFileSync(join(root, "base.txt"), "base\n");
      git(["add", "-A"], root);
      git(["commit", "-q", "-m", "base commit"], root);
      const subdir = join(root, "plain-subdir");
      mkdirSync(subdir);
      const mainBranch = git(["branch", "--show-current"], root);
      writeSnapshot(root, standaloneSnapshotDoc(mainBranch, [PLAN_A(subdir, mainBranch)]));
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", mainBranch],
        root,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.lease-equals-main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlink alias of the main checkout as lease → worktree.l1.lease-equals-main, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-symlink-");
    try {
      git(["init", "-q"], root);
      git(["config", "user.email", "worktree-cli-test@example.com"], root);
      git(["config", "user.name", "Worktree CLI Test"], root);
      writeFileSync(join(root, "base.txt"), "base\n");
      git(["add", "-A"], root);
      git(["commit", "-q", "-m", "base commit"], root);
      const alias = join(root, "alias");
      symlinkSync(root, alias);
      const mainBranch = git(["branch", "--show-current"], root);
      writeSnapshot(root, standaloneSnapshotDoc(mainBranch, [PLAN_A(alias, mainBranch)]));
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", mainBranch],
        root,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.l1.lease-equals-main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar worktree check — process-harness discovery starts at the verified main worktree", () => {
  test("linked cwd resolves the primary process harness even with tracked-results .mstar/ present", () => {
    const root = tmpRoot("mstar-wt-l1-discovery-");
    try {
      git(["init", "-q"], root);
      git(["config", "user.email", "worktree-cli-test@example.com"], root);
      git(["config", "user.name", "Worktree CLI Test"], root);
      // Tracked-results domain committed BEFORE the worktree add, so the
      // linked checkout legitimately shows .mstar/knowledge/ — it must not
      // win process-harness discovery (no feature-local fallback).
      mkdirSync(join(root, ".mstar", "knowledge"), { recursive: true });
      writeFileSync(join(root, ".mstar", "knowledge", "note.md"), "tracked knowledge\n");
      writeFileSync(join(root, "base.txt"), "base\n");
      git(["add", "-A"], root);
      git(["commit", "-q", "-m", "base commit"], root);
      const mainBranch = git(["branch", "--show-current"], root);
      const linked = join(root, "linked");
      git(["worktree", "add", "-q", linked, "-b", "feature/plan-a"], root);
      const integration = join(root, "integration");
      const integrationBranch = `iteration/${WORKFLOW_ID}`;
      git(["worktree", "add", "-q", integration, "-b", integrationBranch], root);
      // Process SSOT written only at the MAIN root (default gitignored layout).
      writeSnapshot(
        join(root, ".mstar"),
        snapshotDoc(
          [PLAN_A(linked)],
          { branch: { base: mainBranch, integration: integrationBranch }, integration_worktree_path: integration },
        ),
      );
      // No --harness: discovery must start at the verified main worktree.
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--main-branch", mainBranch],
        linked,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("worktree L1 check: OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar status validate — canonical snapshot reader advisory", () => {
  test("legacy-only snapshot: medium advisory on stderr, exit 0, source bytes unchanged", () => {
    const root = tmpRoot("mstar-status-legacy-");
    try {
      const workflowDir = join(root, "workflows", "wf-legacy");
      mkdirSync(workflowDir, { recursive: true });
      const snapshotPath = join(workflowDir, "snapshot.json");
      const raw = JSON.stringify(
        {
          schema_version: 1,
          id: "wf-legacy",
          type: "plan",
          status: "running",
          started_at: "2026-08-08",
          updated_at: "2026-08-08",
          plans: [],
          control_worktree_path: join(root, "integration"),
        },
        null,
        2,
      );
      writeFileSync(snapshotPath, raw);
      const result = runCli(["status", "validate", snapshotPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`${snapshotPath}: OK`);
      expect(result.stderr).toContain("workflow.snapshot.legacy-control-worktree-path");
      expect(readFileSync(snapshotPath, "utf8")).toBe(raw); // advisory never rewrites the source
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
