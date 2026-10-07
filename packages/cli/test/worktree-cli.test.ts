/**
 * CLI `mstar worktree check` — thin engine-backed wrapper over
 * `l1PreDispatchCheck` (main-worktree residency + integration topology +
 * feature/lease isolation) and `l2PreDispatchCheck` (parallel writable
 * tracks) — mstar-branch-worktree L1/L2 tables.
 * A sibling `worktree qc-alignment` group verifies assignment alignment
 * fields independently of worktree isolation and topology.
 *
 * L1 input comes from the workflow snapshot through the canonical reader
 * (`readWorkflowSnapshot` — the v1 `control_worktree_path` key is accepted as
 * an in-memory alias with a medium migration advisory): prepared plan metadata
 * (`worktree_path`, `working_branch`), `integration_worktree_path` +
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli as runOwnerCli, withTempDir } from "./harness";
import { cliEnvelope, violationCodes } from "./support/cli-assertions";

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


interface CommandOutput {
  version: number;
  command: string;
  status: string;
  code: string;
  exitCode: number;
  message?: string;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

function commandOutput(result: RunResult): CommandOutput {
  const value: unknown = JSON.parse(result.stdout);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected command envelope on stdout, received ${JSON.stringify(result.stdout)}`);
  }
  return value as CommandOutput;
}

function expectOutput(
  result: RunResult,
  status: string,
  code: string,
  exitCode: number,
  command = "worktree.check",
): CommandOutput {
  const output = commandOutput(result);
  expect(output).toMatchObject({ version: 1, command, status, code, exitCode });
  return output;
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
function writeSnapshot(dir: string, doc: Record<string, unknown>, workflowId: string = WORKFLOW_ID): string {
  const workflowDir = join(dir, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  const snapshotPath = join(workflowDir, "snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(doc, null, 2));
  return snapshotPath;
}

/**
 * Write the v2 root register (`status.json` — `workflows[]` holds ACTIVE
 * lifecycles only) listing the given workflow ids as active.
 */
function writeRegister(dir: string, ids: string[]): string {
  const registerPath = join(dir, "status.json");
  writeFileSync(
    registerPath,
    JSON.stringify(
      {
        version: 2,
        updated_at: "2026-08-08",
        workflows: ids.map((id) => ({ id, type: "plan", started_at: "2026-08-08", dir: `workflows/${id}` })),
      },
      null,
      2,
    ),
  );
  return registerPath;
}

/** Base snapshot doc: single running workflow with the given plans. */
function snapshotDoc(plans: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "iteration",
    status: "running",
    // The real producer stamps PREPARE_PHASE at registration; a fixture that
    // omits it makes every reader advertise the derived-phase diagnostic on
    // stderr instead of exercising the L1 checks silently.
    phase: "phase-1-prepare",
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

const PLAN_A = (worktreePath: string, workingBranch = "feature/plan-a") => ({
  id: "plan-a",
  title: "Plan A",
  file: "plans/plan-a.md",
  status: "InProgress",
  metadata: { worktree_path: worktreePath, working_branch: workingBranch },
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
      const output = expectOutput(result, "ok", "worktree.check.ok", 0);
      expect(output.data).toMatchObject({ ok: true, violations: [] });
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
      expectOutput(result, "refused", "worktree.main.residency-switched", 1);
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
      expectOutput(result, "refused", "worktree.main.expected-branch-missing", 1);
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
      expectOutput(result, "ok", "worktree.check.ok", 0);
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
      expectOutput(result, "ok", "worktree.check.ok", 0);
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
      expectOutput(result, "ok", "worktree.check.ok", 0);
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
      expectOutput(result, "ok", "worktree.check.ok", 0);
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
      const output = expectOutput(result, "usage", "usage", 2);
      expect(output.message).toContain("usage: worktree check <plan-id>");
      expect(output.message).toContain("--control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("feature worktree is the main worktree → worktree.l1.feature-equals-main, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-eqmain-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(root, iterationSnapshotDoc(topo, [PLAN_A(root, topo.mainBranch)]));
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", topo.mainBranch],
        root,
      );
      const output = expectOutput(result, "refused", "worktree.l1.feature-equals-main", 1);
      expect(output.details?.violations).toContainEqual(expect.objectContaining({ code: "worktree.l1.feature-equals-main", severity: "critical" }));
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
      expectOutput(result, "refused", "worktree.l1.feature-missing", 1);
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
      expectOutput(result, "refused", "worktree.l1.branch-mismatch", 1);
      expect(commandOutput(result).message).toContain("feature/plan-a");
      expect(commandOutput(result).message).toContain("feature/wrong");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no plan row → worktree.l1.plan-not-found, exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-noplan-");
    try {
      writeSnapshot(root, snapshotDoc([]));
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root]);
      expectOutput(result, "refused", "worktree.l1.plan-not-found", 1);
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
      expectOutput(result, "refused", "worktree.l1.integration-missing", 1);
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
        const output = expectOutput(result, "refused", "worktree.check.refused", 1);
        expect(output.message).toContain("invalid workflow id");
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
      expectOutput(result, "ok", "worktree.check.ok", 0);
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
            PLAN_A(root),
            { plan_id: "plan-a", title: "Plan A (legacy)", file: "plans/plan-a.md", status: "InProgress", metadata: PLAN_A(root).metadata },
          ],
          { control_worktree_path: root },
        ),
      );
      const result = runCli(["worktree", "check", "--plan", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root]);
      expectOutput(result, "refused", "worktree.l1.ambiguous", 1);
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
      expectOutput(result, "ok", "worktree.check.ok", 0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plain subdirectory of the main checkout as feature → worktree.l1.feature-equals-main, exit 1", () => {
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
      const output = expectOutput(result, "refused", "worktree.l1.feature-equals-main", 1);
      expect(output.details?.violations).toContainEqual(expect.objectContaining({ code: "worktree.l1.feature-equals-main", severity: "critical" }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlink alias of the main checkout as feature → worktree.l1.feature-equals-main, exit 1", () => {
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
      const output = expectOutput(result, "refused", "worktree.l1.feature-equals-main", 1);
      expect(output.details?.violations).toContainEqual(expect.objectContaining({ code: "worktree.l1.feature-equals-main", severity: "critical" }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar worktree check — lifecycle-owned branches from ALL active workflows (L1 caller policy)", () => {
  test("a sibling active workflow's integration branch is collected — main on it refuses (residency-switched)", () => {
    const root = tmpRoot("mstar-wt-l1-sibling-int-");
    try {
      // Standalone governing plan (no integration topology of its own).
      const linked = worktreeFixture(root);
      const mainBranch = git(["branch", "--show-current"], root);
      writeSnapshot(root, standaloneSnapshotDoc(mainBranch, [PLAN_A(linked)]));
      // A second ACTIVE workflow whose branch.integration IS the branch main
      // currently sits on — the ownership evidence must come from the
      // sibling snapshot, not only the governing one.
      writeSnapshot(root, snapshotDoc([], { id: "wf-2", type: "plan", branch: { integration: mainBranch } }), "wf-2");
      writeRegister(root, [WORKFLOW_ID, "wf-2"]);
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", mainBranch],
        root,
      );
      const output = expectOutput(result, "refused", "worktree.main.residency-switched", 1);
      expect(output.message).toContain("owned by an active lifecycle");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed sibling snapshot refuses the check (fail-closed probe), exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-sibling-bad-");
    try {
      const linked = worktreeFixture(root);
      const mainBranch = git(["branch", "--show-current"], root);
      writeSnapshot(root, standaloneSnapshotDoc(mainBranch, [PLAN_A(linked)]));
      // Registered active sibling with an unreadable snapshot — incomplete
      // lifecycle evidence must refuse, never silently skip.
      mkdirSync(join(root, "workflows", "wf-2"), { recursive: true });
      writeFileSync(join(root, "workflows", "wf-2", "snapshot.json"), "{ not json");
      writeRegister(root, [WORKFLOW_ID, "wf-2"]);
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", mainBranch],
        root,
      );
      expectOutput(result, "refused", "worktree.l1.lifecycle-snapshot-unreadable", 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("multi-snapshot pass: registered siblings collect, unregistered retained snapshots do not (exit 0)", () => {
    const root = tmpRoot("mstar-wt-l1-sibling-ok-");
    try {
      const topo = topologyFixture(root);
      writeSnapshot(root, iterationSnapshotDoc(topo, [PLAN_A(topo.linked)]));
      // A second active workflow with its own integration anchor (distinct
      // from main) — registered, collected, check still passes.
      writeSnapshot(root, snapshotDoc([], { id: "wf-2", type: "plan", branch: { integration: "iteration/wf-2" } }), "wf-2");
      // An UNREGISTERED retained snapshot is not an active lifecycle — even
      // one whose integration anchor is the branch main sits on must not
      // refuse the check (the register decides the active set).
      writeSnapshot(root, snapshotDoc([], { id: "wf-old", type: "plan", branch: { integration: topo.mainBranch } }), "wf-old");
      writeRegister(root, [WORKFLOW_ID, "wf-2"]);
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", topo.mainBranch],
        root,
      );
      expectOutput(result, "ok", "worktree.check.ok", 0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unreadable root register refuses the check (active set cannot be enumerated), exit 1", () => {
    const root = tmpRoot("mstar-wt-l1-register-bad-");
    try {
      const linked = worktreeFixture(root);
      const mainBranch = git(["branch", "--show-current"], root);
      writeSnapshot(root, standaloneSnapshotDoc(mainBranch, [PLAN_A(linked)]));
      writeFileSync(join(root, "status.json"), "{ not json");
      const result = runCli(
        ["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root, "--main-branch", mainBranch],
        root,
      );
      expectOutput(result, "refused", "worktree.l1.lifecycle-register-unreadable", 1);
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
      expectOutput(result, "ok", "worktree.check.ok", 0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar status validate — canonical snapshot reader advisory", () => {
  test("legacy-only snapshot: JSON advisory preserved, exit 0, source bytes unchanged", () => {
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
      const output = expectOutput(result, "ok", "status.ok", 0, "status.validate");
      expect(output.data).toMatchObject({ path: snapshotPath });
      const diagnostics = output.data?.diagnostics as Array<{ code: string }>;
      expect(diagnostics.some((diagnostic) => diagnostic.code === "workflow.snapshot.legacy-control-worktree-path")).toBe(true);
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
      expectOutput(result, "ok", "worktree.check.ok", 0);
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
      expectOutput(result, "refused", "worktree.l2.track-missing", 1);
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
      expectOutput(result, "refused", "worktree.l2.branch-mismatch", 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty tracks array → worktree.l2.no-tracks, exit 1", () => {
    const result = runCli(["worktree", "check", "--l2", "--tracks", "[]"]);
    expectOutput(result, "refused", "worktree.l2.no-tracks", 1);
  });

  test("--l2 without --tracks → usage, exit 2", () => {
    const result = runCli(["worktree", "check", "--l2"]);
    const output = expectOutput(result, "usage", "usage", 2);
    expect(output.message).toContain("usage: worktree check --l2 --tracks");
  });

  test("--tracks invalid JSON → usage, exit 2", () => {
    const result = runCli(["worktree", "check", "--l2", "--tracks", "{not json"]);
    const output = expectOutput(result, "usage", "command.invalid-input", 2);
    const diagnostics = output.details?.diagnostics as Array<{ path: string; code: string }>;
    expect(diagnostics).toMatchObject([{ path: "tracks", code: "invalid_json" }]);
  });

  test("--tracks not an array → usage, exit 2", () => {
    const result = runCli(["worktree", "check", "--l2", "--tracks", '{"worktreePath": "/x"}' ]);
    const output = expectOutput(result, "usage", "command.invalid-input", 2);
    const diagnostics = output.details?.diagnostics as Array<{ path: string; code: string }>;
    expect(diagnostics).toMatchObject([{ path: "tracks", code: "invalid_type" }]);
  });

  test("--tracks entry missing workingBranch → usage, exit 2", () => {
    const result = runCli(["worktree", "check", "--l2", "--tracks", '[{"worktreePath": "/abs/path"}]']);
    const output = expectOutput(result, "usage", "command.invalid-input", 2);
    const diagnostics = output.details?.diagnostics as Array<{ path: string; code: string }>;
    expect(diagnostics).toMatchObject([{ path: "tracks[0].workingBranch", code: "invalid_type" }]);
  });
});


test("retained track ownership refuses main and ordinary progress repairs retired tracks", () => {
  const root = tmpRoot("mstar-retained-track-");
  try {
    const linked = worktreeFixture(root);
    const mainBranch = git(["branch", "--show-current"], root);
    const row = { ...PLAN_A(linked), metadata: { ...PLAN_A(linked).metadata, track_branches: [mainBranch] } };
    const snapshot = writeSnapshot(root, standaloneSnapshotDoc(mainBranch, [row]));
    const register = writeRegister(root, [WORKFLOW_ID]);
    const beforeSnapshot = readFileSync(snapshot, "utf8");
    const beforeRegister = readFileSync(register, "utf8");
    const result = runCli(["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root], root);
    const output = expectOutput(result, "refused", "worktree.main.residency-switched", 1);
    expect(output.details?.violations).toContainEqual(expect.objectContaining({ code: "worktree.main.residency-switched", severity: "high" }));
    expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
    expect(readFileSync(register, "utf8")).toBe(beforeRegister);

    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", "plan-a.md"), `# Plan A\n\n**plan_id:** plan-a\n**Main worktree branch:** ${mainBranch}\n**Working branch:** feature/plan-a\n`);
    const bound = commandOutput(runCli(["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--harness", root, "--session-id", "retained-track-coordinator"], root));
    if (bound.status !== "ok" || typeof bound.data?.session_file !== "string") throw new Error(`coordinator bind failed: ${JSON.stringify(bound)}`);
    const session = bound.data.session_file;
    const shown = commandOutput(runCli(["plan", "show", "--session", session, "--plan", "plan-a", "--harness", root], root));
    if (shown.status !== "ok" || typeof shown.data?.revision !== "number") throw new Error(`plan show failed: ${JSON.stringify(shown)}`);
    const foreignRoot = join(root, "foreign-control");
    mkdirSync(foreignRoot);
    const beforeForeignRead = readFileSync(snapshot, "utf8");
    expectOutput(runCli(["plan", "show", "--session", session, "--plan", "plan-a", "--harness", foreignRoot], root), "refused", "coordination.scope-mismatch", 1, "plan.show");
    expect(readFileSync(snapshot, "utf8")).toBe(beforeForeignRead);
    expect(existsSync(join(foreignRoot, "store.db"))).toBe(false);
    const corrected = commandOutput(runCli([
      "plan", "progress", "--session", session, "--plan", "plan-a", "--harness", root, "--expect", String(shown.data.revision),
      "--progress", JSON.stringify({ status: "InProgress", summary: "retire the mistaken main track", evidence_paths: [], track_branches: [] }),
    ], root));
    if (corrected.status !== "ok") throw new Error(`track correction failed: ${JSON.stringify(corrected)}`);
    const repairedRow = (JSON.parse(readFileSync(snapshot, "utf8")).plans as Array<{ id: string; metadata: Record<string, unknown> }>).find((plan) => plan.id === "plan-a")!;
    expect(repairedRow.metadata).toMatchObject({ worktree_path: linked, working_branch: "feature/plan-a", track_branches: [] });
    expectOutput(runCli(["worktree", "check", "plan-a", "--workflow", WORKFLOW_ID, "--harness", root], root), "ok", "worktree.check.ok", 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("degraded Git refuses a linked checkout marker before local harness discovery", () => {
  const root = tmpRoot("mstar-degraded-linked-");
  try {
    writeFileSync(join(root, ".git"), "gitdir: /unavailable/worktrees/linked\n");
    mkdirSync(join(root, ".mstar"));
    const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, "status", "validate"], {
      cwd: root, env: { ...cliEnv(), PATH: root }, stdout: "pipe", stderr: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    // The refusal text is engine-owned (`resolveProcessHarnessDir` in
    // engine/coordination.ts): the CLI no longer rewords the linked-checkout
    // marker, so the assertion tracks the engine's own reason string.
    expect(proc.stderr.toString()).toContain("whose main worktree is unreadable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// mstar worktree qc-alignment — byte-identical alignment fields (audit-004)
// ---------------------------------------------------------------------------

/** One QC Assignment fixture with the three alignment fields — canonical
 * combined `Review range / Diff basis` label form (the PM template shape,
 * real QC/QA packs use it). */
function qcAssignmentFixture(planId: string, range: string): string {
  return `## Assignment
**Execute as**: qc-specialist
**Task category**: logic
**plan_id**: ${planId}
**Review range / Diff basis**: ${range}
`;
}

/** Separate-label Assignment fixture (non-canonical form, still accepted). */
function qcAssignmentSeparateFixture(planId: string, range: string): string {
  return `## Assignment
**Execute as**: qc-specialist
**Task category**: logic
**plan_id**: ${planId}
**Review range**: ${range}
**Diff basis**: ${range}
`;
}

describe("mstar worktree qc-alignment — QC/QA alignment fields (audit-004)", () => {
  test("real-shape tri pack: 3 assignments, canonical combined label, byte-identical (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      for (const name of ["qc1.md", "qc2.md", "qc3.md"]) {
        writeFileSync(join(dir, name), qcAssignmentFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      }
      const result = runOwnerCli(["worktree", "qc-alignment", join(dir, "qc1.md"), join(dir, "qc2.md"), join(dir, "qc3.md")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "worktree.qc-alignment.ok").data?.assignments).toHaveLength(3);
    });
  });

  test("separate-label form still parses as aligned (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "qc1.md"), qcAssignmentSeparateFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      writeFileSync(join(dir, "qc2.md"), qcAssignmentSeparateFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      const result = runOwnerCli(["worktree", "qc-alignment", join(dir, "qc1.md"), join(dir, "qc2.md")]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "worktree.qc-alignment.ok").data?.assignments).toHaveLength(2);
    });
  });

  test("a differing Diff basis fails with qc.alignment.mismatch (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "qc1.md"), qcAssignmentFixture("20260816-audit-004", "merge-base: main + tip: HEAD"));
      writeFileSync(join(dir, "qc2.md"), qcAssignmentFixture("20260816-audit-004", "merge-base: main + tip: HEAD~1"));
      const result = runOwnerCli(["worktree", "qc-alignment", join(dir, "qc1.md"), join(dir, "qc2.md")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toEqual(["qc.alignment.mismatch", "qc.alignment.mismatch"]);
    });
  });
  test("assignment missing an alignment field fails with qc.alignment.field.missing (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      // Separate-label variant with the Diff basis line removed (the combined
      // form cannot drop a single range field).
      const incomplete = qcAssignmentSeparateFixture("20260816-audit-004", "merge-base: main + tip: HEAD").replace(
        "**Diff basis**: merge-base: main + tip: HEAD\n",
        "",
      );
      writeFileSync(join(dir, "qc1.md"), incomplete);
      const result = runOwnerCli(["worktree", "qc-alignment", join(dir, "qc1.md")]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toEqual(["qc.alignment.field.missing"]);
    });
  });

  test("no assignment files is a usage error (exit 2)", () => {
    const result = runOwnerCli(["worktree", "qc-alignment"]);
    expect(result.exitCode).toBe(2);
    expect(String(cliEnvelope(result, "usage").message)).toContain("missing required argument 'files'");
  });
});
