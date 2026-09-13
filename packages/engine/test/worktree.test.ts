/**
 * Engine worktree module — main-worktree discovery + residency, L1/L2
 * pre-dispatch checklists, main/integration/feature checkout identity,
 * branch alignment probe, QC/QA field alignment.
 *
 * Spec sources (each test cites the skill/spec section it enforces):
 * - L1/L2 layer split + stacking — main control root + integration checkout
 * + per-plan feature worktrees + `plans[].execution_lease` (L1); within-plan
 * parallel writable tracks need their own distinct worktrees (L2, L1 does
 * not replace L2): `mstar-branch-worktree` SKILL.md § "Worktree isolation
 * layers (L1 vs L2)" § "Stacking rules" + iteration spec
 * worktree-write-model § "Locked interfaces (P1 engine)".
 * - Primary residency — the expectation is the branch RECORDED at lifecycle
 * start (never the branch observed at check time as its own expected value);
 * main on any active lifecycle-owned branch is refused; detached/unresolved
 * main fails closed: spec § "Primary residency" + § "Stable machine codes".
 * - Main control root vs feature — `execution_lease.worktree_path` MUST be a
 * Git checkout distinct from the MAIN worktree; pairwise main/integration/
 * feature identity via the canonical per-worktree git dir: SKILL.md
 * § "Control worktree vs feature worktree (iteration / L1)" § "Hard rules".
 * - L2 pre-dispatch checklist — per-track worktree dirs exist and
 * `git -C <path> branch --show-current` matches the Assignment Working
 * branch before the first concurrent writable dispatch; N parallel invokes
 * ≠ isolation; emit zero until ready:
 * `mstar-branch-worktree` `references/parallel-writable-pre-dispatch.md`
 * § "Pre-dispatch checklist (HARD)".
 * - QC/QA alignment — `plan_id` + `Review range`/`Diff basis` byte-identical
 * (逐字相同) across the QC tri + QA assignments; single review snapshot
 * precondition (all reviewable commits on ONE Working branch HEAD before
 * QC tri + QA):
 * SKILL.md § "QC / QA 检出对齐与多 worktree 门禁衔接" § 对齐字段契约 +
 * § "单一待审 Git 快照（派 QC 前置条件）".
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GateResult } from "../src/core.js";
import {
  assertBranchAlignment,
  assertControlVsFeaturePath,
  assertMainWorktreeResidency,
  assertQcAlignment,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  readMainWorktree,
  singleReviewSnapshot,
  type MainWorktreeInfo,
} from "../src/worktree.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Init a git repo with one commit at `root/repo`; returns the repo path.
 */
function gitRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q"], repo);
  git(["config", "user.email", "worktree-test@example.com"], repo);
  git(["config", "user.name", "Worktree Test"], repo);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  return repo;
}

/** Hand-build or probe the MainWorktreeInfo for a real main checkout. */
function mainInfo(repo: string): MainWorktreeInfo {
  return { root: realpathSync(repo), branch: git(["branch", "--show-current"], repo) };
}

/**
 * Create a temp git repo with an initial commit and one linked worktree per
 * branch via real `git worktree add` (L1/L2 probe realism). Returns
 * branch → absolute worktree path.
 */
function worktreeFixture(root: string, branches: readonly string[]): Map<string, string> {
  const repo = gitRepo(root);
  const paths = new Map<string, string>();
  for (const branch of branches) {
    const path = join(root, `wt-${branch}`);
    git(["worktree", "add", "-q", "-b", branch, path], repo);
    paths.set(branch, path);
  }
  return paths;
}

/**
 * Nested variant: linked worktrees created INSIDE the repo checkout (the
 * documented `.worktrees` layout) under an arbitrary folder name — the
 * checkout-identity gate must accept them without a name special-case.
 */
function nestedWorktreeFixture(root: string, branches: readonly string[]): { repo: string; paths: Map<string, string> } {
  const repo = gitRepo(root);
  const paths = new Map<string, string>();
  for (const branch of branches) {
    const path = join(repo, "nested-checkouts", `wt-${branch.replace(/\//g, "-")}`);
    git(["worktree", "add", "-q", "-b", branch, path], repo);
    paths.set(branch, path);
  }
  return { repo, paths };
}

/** Add a detached-HEAD linked worktree (branch --show-current prints nothing). */
function detachedWorktree(repo: string, root: string): string {
  const path = join(root, "wt-detached");
  git(["worktree", "add", "-q", "--detach", path, "HEAD"], repo);
  return path;
}

function codesOf(result: GateResult): string[] {
  return result.violations.map((v) => v.code);
}

function severitiesOf(result: GateResult): string[] {
  return result.violations.map((v) => v.severity);
}

function findViolation(result: GateResult, code: string): (typeof result.violations)[number] | undefined {
  return result.violations.find((v) => v.code === code);
}

describe("readMainWorktree — first-record main-worktree discovery", () => {
  test("probes the main worktree (first porcelain record) with refs/heads stripped", () => {
    const root = tmpRoot("worktree-main-ok-");
    try {
      const wts = worktreeFixture(root, ["feature/a"]);
      const repo = join(root, "repo");
      expect(wts.size).toBe(1);
      const main = readMainWorktree(repo);
      expect(main).toEqual({ root: realpathSync(repo), branch: git(["branch", "--show-current"], repo) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovery from a linked checkout still reaches the main worktree (first record, not the linked cwd)", () => {
    const root = tmpRoot("worktree-main-linked-");
    try {
      const wts = worktreeFixture(root, ["feature/a"]);
      const repo = join(root, "repo");
      const main = readMainWorktree(wts.get("feature/a")!);
      expect(main).toEqual({ root: realpathSync(repo), branch: git(["branch", "--show-current"], repo) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("paths with spaces survive the porcelain NUL form", () => {
    const root = tmpRoot("worktree-main-space-");
    try {
      const dir = join(root, "my repo");
      mkdirSync(dir);
      const repo = join(dir, "repo");
      mkdirSync(repo);
      git(["init", "-q"], repo);
      git(["config", "user.email", "worktree-test@example.com"], repo);
      git(["config", "user.name", "Worktree Test"], repo);
      writeFileSync(join(repo, "README.md"), "fixture\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "initial"], repo);
      const main = readMainWorktree(repo);
      expect(main?.root).toBe(realpathSync(repo));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detached main yields branch \"\" (residency must fail)", () => {
    const root = tmpRoot("worktree-main-detached-");
    try {
      const repo = gitRepo(root);
      git(["checkout", "-q", "--detach"], repo);
      const main = readMainWorktree(repo);
      expect(main).not.toBeNull();
      expect(main!.branch).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-repo directory, bare repository and failed probes yield null (fail closed)", () => {
    const root = tmpRoot("worktree-main-null-");
    try {
      const dir = join(root, "not-a-repo");
      mkdirSync(dir);
      expect(readMainWorktree(dir)).toBeNull();
      const bare = join(root, "bare.git");
      mkdirSync(bare);
      git(["init", "-q", "--bare"], bare);
      expect(readMainWorktree(bare)).toBeNull();
      expect(readMainWorktree(join(root, "does-not-exist"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assertMainWorktreeResidency — recorded-branch equality primitive", () => {
  test("main on the recorded branch passes", () => {
    const result = assertMainWorktreeResidency({ root: "/repo/main", branch: "develop" }, "develop");
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("main on a different branch than the recorded expectation → worktree.main.residency-switched (high)", () => {
    const result = assertMainWorktreeResidency({ root: "/repo/main", branch: "feature/x" }, "main");
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(["worktree.main.residency-switched"]);
    expect(severitiesOf(result)).toEqual(["high"]);
    expect(result.violations[0]!.message).toContain("feature/x");
    expect(result.violations[0]!.message).toContain("main");
  });

  test("detached main (empty branch) → worktree.main.residency-switched", () => {
    const result = assertMainWorktreeResidency({ root: "/repo/main", branch: "" }, "main");
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("worktree.main.residency-switched");
  });
});

describe("l1PreDispatchCheck — L1 cross-plan checklist (main / integration / feature)", () => {
  test("passes for an iteration with distinct main/integration/feature checkouts and aligned branches (real git worktrees)", () => {
    const root = tmpRoot("worktree-l1-ok-");
    try {
      const wts = worktreeFixture(root, ["iteration/int", "feature/a"]);
      const repo = join(root, "repo");
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "iteration",
        integrationWorktreePath: wts.get("iteration/int")!,
        integrationBranch: "iteration/int",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: ["iteration/int", "feature/a"],
        leaseWorktreePath: wts.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes for a standalone plan without integration (empty integration fields — main vs feature only)", () => {
    const root = tmpRoot("worktree-l1-standalone-");
    try {
      const wts = worktreeFixture(root, ["feature/a"]);
      const repo = join(root, "repo");
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "plan",
        integrationWorktreePath: "",
        integrationBranch: "",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: ["feature/a"],
        leaseWorktreePath: wts.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("standalone plan with only one integration field supplied → worktree.l1.integration-missing", () => {
    const result = l1PreDispatchCheck({
      workflowType: "plan",
      integrationWorktreePath: "",
      integrationBranch: "iteration/int",
      mainWorktree: { root: "/repo/main", branch: "main" },
      expectedMainBranch: "main",
      lifecycleBranches: [],
      leaseWorktreePath: "/tmp/lease",
      leaseWorkingBranch: "feature/a",
      planId: "p-1",
    });
    expect(codesOf(result)).toContain("worktree.l1.integration-missing");
    expect(result.ok).toBe(false);
  });

  test("iteration without integration fields → worktree.l1.integration-missing (both required)", () => {
    const result = l1PreDispatchCheck({
      workflowType: "iteration",
      integrationWorktreePath: "",
      integrationBranch: "",
      mainWorktree: { root: "/repo/main", branch: "main" },
      expectedMainBranch: "main",
      lifecycleBranches: [],
      leaseWorktreePath: "/tmp/lease",
      leaseWorkingBranch: "feature/a",
      planId: "p-1",
    });
    expect(codesOf(result)).toContain("worktree.l1.integration-missing");
    expect(result.ok).toBe(false);
  });

  test("nonexistent integration worktree → worktree.l1.integration-missing (absent or unusable)", () => {
    const root = tmpRoot("worktree-l1-intmissing-");
    try {
      const wts = worktreeFixture(root, ["feature/a"]);
      const result = l1PreDispatchCheck({
        workflowType: "iteration",
        integrationWorktreePath: join(root, "no-such-integration"),
        integrationBranch: "iteration/int",
        mainWorktree: mainInfo(join(root, "repo")),
        expectedMainBranch: mainInfo(join(root, "repo")).branch,
        lifecycleBranches: ["iteration/int", "feature/a"],
        leaseWorktreePath: wts.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(codesOf(result)).toContain("worktree.l1.integration-missing");
      expect(result.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration branch misalignment → worktree.branch-mismatch (real git worktrees)", () => {
    const root = tmpRoot("worktree-l1-intalign-");
    try {
      const wts = worktreeFixture(root, ["iteration/int", "feature/a"]);
      const repo = join(root, "repo");
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "iteration",
        integrationWorktreePath: wts.get("iteration/int")!,
        integrationBranch: "iteration/other",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: ["iteration/int", "feature/a"],
        leaseWorktreePath: wts.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.branch-mismatch");
      expect(findViolation(result, "worktree.branch-mismatch")?.message).toContain("iteration/other");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("null main discovery → worktree.main.unresolved (a failure, never a skipped row)", () => {
    const result = l1PreDispatchCheck({
      workflowType: "plan",
      integrationWorktreePath: "",
      integrationBranch: "",
      mainWorktree: null,
      expectedMainBranch: "main",
      lifecycleBranches: [],
      leaseWorktreePath: "/tmp/lease",
      leaseWorkingBranch: "feature/a",
      planId: "p-1",
    });
    expect(codesOf(result)).toContain("worktree.main.unresolved");
    expect(result.ok).toBe(false);
  });

  test("empty expectedMainBranch → worktree.main.expected-branch-missing (never the observed branch as its own expectation)", () => {
    const result = l1PreDispatchCheck({
      workflowType: "plan",
      integrationWorktreePath: "",
      integrationBranch: "",
      mainWorktree: { root: "/repo/main", branch: "main" },
      expectedMainBranch: "",
      lifecycleBranches: [],
      leaseWorktreePath: "/tmp/lease",
      leaseWorkingBranch: "feature/a",
      planId: "p-1",
    });
    expect(codesOf(result)).toContain("worktree.main.expected-branch-missing");
    expect(codesOf(result)).not.toContain("worktree.main.residency-switched");
    expect(result.ok).toBe(false);
  });

  test("main switched away from the recorded branch → worktree.main.residency-switched", () => {
    const root = tmpRoot("worktree-l1-switched-");
    try {
      const wts = worktreeFixture(root, ["feature/a"]);
      const repo = join(root, "repo");
      const result = l1PreDispatchCheck({
        workflowType: "plan",
        integrationWorktreePath: "",
        integrationBranch: "",
        mainWorktree: { root: realpathSync(repo), branch: "release/other" },
        expectedMainBranch: "main",
        lifecycleBranches: ["feature/a"],
        leaseWorktreePath: wts.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.main.residency-switched");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("main on a lifecycle-owned branch is refused even when the recorded expectation matches it", () => {
    const root = tmpRoot("worktree-l1-owned-");
    try {
      const repo = gitRepo(root);
      git(["checkout", "-q", "-b", "iteration/owned"], repo);
      const paths = new Map<string, string>();
      for (const branch of ["iteration/int", "feature/a"]) {
        const path = join(root, `wt-${branch.replace(/\//g, "-")}`);
        git(["worktree", "add", "-q", "-b", branch, path], repo);
        paths.set(branch, path);
      }
      const result = l1PreDispatchCheck({
        workflowType: "iteration",
        integrationWorktreePath: paths.get("iteration/int")!,
        integrationBranch: "iteration/int",
        mainWorktree: { root: realpathSync(repo), branch: "iteration/owned" },
        expectedMainBranch: "iteration/owned",
        lifecycleBranches: ["iteration/owned", "iteration/int", "feature/a"],
        leaseWorktreePath: paths.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toEqual(["worktree.main.residency-switched"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("main on recorded develop with base release/x passes when develop is not lifecycle-owned", () => {
    const root = tmpRoot("worktree-l1-develop-");
    try {
      const repo = gitRepo(root);
      git(["checkout", "-q", "-b", "develop"], repo);
      const paths = new Map<string, string>();
      for (const branch of ["iteration/int", "feature/a"]) {
        const path = join(root, `wt-${branch.replace(/\//g, "-")}`);
        git(["worktree", "add", "-q", "-b", branch, path], repo);
        paths.set(branch, path);
      }
      const result = l1PreDispatchCheck({
        workflowType: "iteration",
        integrationWorktreePath: paths.get("iteration/int")!,
        integrationBranch: "iteration/int",
        mainWorktree: { root: realpathSync(repo), branch: "develop" },
        expectedMainBranch: "develop",
        lifecycleBranches: ["iteration/int", "feature/a"],
        leaseWorktreePath: paths.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration checkout is the main worktree → worktree.l1.integration-equals-main (critical)", () => {
    const root = tmpRoot("worktree-l1-inteqmain-");
    try {
      const wts = worktreeFixture(root, ["feature/a"]);
      const repo = join(root, "repo");
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "iteration",
        integrationWorktreePath: repo,
        integrationBranch: main.branch,
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: ["feature/a"],
        leaseWorktreePath: wts.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.l1.integration-equals-main");
      expect(severitiesOf(result)).toContain("critical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lease worktree equals the main worktree → worktree.l1.lease-equals-main (critical)", () => {
    const root = tmpRoot("worktree-l1-eqmain-");
    try {
      const repo = gitRepo(root);
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "plan",
        integrationWorktreePath: "",
        integrationBranch: "",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: [],
        leaseWorktreePath: repo,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.l1.lease-equals-main");
      expect(severitiesOf(result)).toContain("critical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lease worktree equals the integration checkout → worktree.l1.lease-equals-integration (critical)", () => {
    const root = tmpRoot("worktree-l1-eqint-");
    try {
      const wts = worktreeFixture(root, ["iteration/int"]);
      const repo = join(root, "repo");
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "iteration",
        integrationWorktreePath: wts.get("iteration/int")!,
        integrationBranch: "iteration/int",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: ["iteration/int"],
        leaseWorktreePath: wts.get("iteration/int")!,
        leaseWorkingBranch: "iteration/int",
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.l1.lease-equals-integration");
      expect(severitiesOf(result)).toContain("critical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plain subdirectory of the main checkout as lease → worktree.l1.lease-equals-main", () => {
    const root = tmpRoot("worktree-l1-subdir-");
    try {
      const repo = gitRepo(root);
      const subdir = join(repo, "plain-subdir");
      mkdirSync(subdir);
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "plan",
        integrationWorktreePath: "",
        integrationBranch: "",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: [],
        leaseWorktreePath: subdir,
        leaseWorkingBranch: main.branch,
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.l1.lease-equals-main");
      expect(severitiesOf(result)).toContain("critical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlink alias of the integration checkout as lease → worktree.l1.lease-equals-integration", () => {
    const root = tmpRoot("worktree-l1-alias-");
    try {
      const wts = worktreeFixture(root, ["iteration/int"]);
      const repo = join(root, "repo");
      const alias = join(root, "integration-alias");
      symlinkSync(wts.get("iteration/int")!, alias);
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "iteration",
        integrationWorktreePath: wts.get("iteration/int")!,
        integrationBranch: "iteration/int",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: ["iteration/int"],
        leaseWorktreePath: alias,
        leaseWorkingBranch: "iteration/int",
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.l1.lease-equals-integration");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path aliases of the main worktree refuse without a probe (normalization fast path)", () => {
    for (const alias of ["/a/b/", "/a/b/../b"]) {
      const result = l1PreDispatchCheck({
        workflowType: "plan",
        integrationWorktreePath: "",
        integrationBranch: "",
        mainWorktree: { root: "/a/b", branch: "main" },
        expectedMainBranch: "main",
        lifecycleBranches: [],
        leaseWorktreePath: alias,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(codesOf(result)).toContain("worktree.l1.lease-equals-main");
    }
  });

  test("empty lease worktree path → worktree.l1.lease-missing", () => {
    const result = l1PreDispatchCheck({
      workflowType: "plan",
      integrationWorktreePath: "",
      integrationBranch: "",
      mainWorktree: { root: "/repo/main", branch: "main" },
      expectedMainBranch: "main",
      lifecycleBranches: [],
      leaseWorktreePath: "",
      leaseWorkingBranch: "feature/a",
      planId: "p-1",
    });
    expect(codesOf(result)).toContain("worktree.l1.lease-missing");
  });

  test("empty lease working branch → worktree.l1.lease-branch-missing", () => {
    const result = l1PreDispatchCheck({
      workflowType: "plan",
      integrationWorktreePath: "",
      integrationBranch: "",
      mainWorktree: { root: "/repo/main", branch: "main" },
      expectedMainBranch: "main",
      lifecycleBranches: [],
      leaseWorktreePath: "/tmp/lease",
      leaseWorkingBranch: "",
      planId: "p-1",
    });
    expect(codesOf(result)).toContain("worktree.l1.lease-branch-missing");
  });

  test("missing feature worktree dir → worktree.l1.feature-missing", () => {
    const result = l1PreDispatchCheck({
      workflowType: "plan",
      integrationWorktreePath: "",
      integrationBranch: "",
      mainWorktree: { root: "/repo/main", branch: "main" },
      expectedMainBranch: "main",
      lifecycleBranches: [],
      leaseWorktreePath: "/tmp/does-not-exist",
      leaseWorkingBranch: "feature/a",
      planId: "p-1",
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("worktree.l1.feature-missing");
  });

  test("branch at feature path != lease working branch → worktree.l1.branch-mismatch (real git worktrees)", () => {
    const root = tmpRoot("worktree-l1-branch-");
    try {
      const wts = worktreeFixture(root, ["feature/a", "feature/b"]);
      const repo = join(root, "repo");
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "plan",
        integrationWorktreePath: "",
        integrationBranch: "",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: ["feature/a", "feature/b"],
        leaseWorktreePath: wts.get("feature/a")!,
        leaseWorkingBranch: "feature/b",
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.l1.branch-mismatch");
      expect(findViolation(result, "worktree.l1.branch-mismatch")?.message).toContain("feature/b");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("precomputed branchOf opt skips the branch probe (purity; identity probes still real)", () => {
    const root = tmpRoot("worktree-l1-pure-");
    try {
      const wts = worktreeFixture(root, ["feature/a"]);
      const repo = join(root, "repo");
      const main = mainInfo(repo);
      const base = {
        workflowType: "plan" as const,
        integrationWorktreePath: "",
        integrationBranch: "",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: ["feature/a"],
        leaseWorktreePath: wts.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      };
      const branchOf = () => "feature/a";
      expect(l1PreDispatchCheck(base, { branchOf }).ok).toBe(true);
      const mismatch = l1PreDispatchCheck(base, { branchOf: () => "feature/other" });
      expect(codesOf(mismatch)).toContain("worktree.l1.branch-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-repo lease dir probe fails closed → worktree.l1.checkout-probe-failed + branch-probe-failed", () => {
    const root = tmpRoot("worktree-l1-probe-");
    try {
      const lease = join(root, "lease");
      mkdirSync(lease);
      // The main control root exists (as `readMainWorktree` output always
      // does) but is not a repo — the pairwise identity probe fails closed.
      const control = join(root, "control");
      mkdirSync(control);
      const result = l1PreDispatchCheck({
        workflowType: "plan",
        integrationWorktreePath: "",
        integrationBranch: "",
        mainWorktree: { root: control, branch: "main" },
        expectedMainBranch: "main",
        lifecycleBranches: [],
        leaseWorktreePath: lease,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(codesOf(result)).toContain("worktree.l1.checkout-probe-failed");
      expect(codesOf(result)).toContain("worktree.l1.branch-probe-failed");
      expect(result.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested linked worktree inside the main checkout passes (arbitrary folder name, no .worktrees special-case)", () => {
    const root = tmpRoot("worktree-l1-nested-");
    try {
      const { repo, paths } = nestedWorktreeFixture(root, ["feature/a"]);
      const main = mainInfo(repo);
      const result = l1PreDispatchCheck({
        workflowType: "plan",
        integrationWorktreePath: "",
        integrationBranch: "",
        mainWorktree: main,
        expectedMainBranch: main.branch,
        lifecycleBranches: ["feature/a"],
        leaseWorktreePath: paths.get("feature/a")!,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("l2PreDispatchCheck — within-plan parallel track checklist", () => {
  test("fewer than 1 track → worktree.l2.no-tracks", () => {
    const result = l2PreDispatchCheck({ tracks: [] });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("worktree.l2.no-tracks");
  });

  test("passes when every track dir exists on its Working branch (real git worktrees)", () => {
    const root = tmpRoot("worktree-l2-ok-");
    try {
      const wts = worktreeFixture(root, ["track/a", "track/b"]);
      const result = l2PreDispatchCheck({
        tracks: [
          { worktreePath: wts.get("track/a")!, workingBranch: "track/a" },
          { worktreePath: wts.get("track/b")!, workingBranch: "track/b" },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing per-track dir → worktree.l2.track-missing (others still checked)", () => {
    const root = tmpRoot("worktree-l2-missing-");
    try {
      const wts = worktreeFixture(root, ["track/a"]);
      const result = l2PreDispatchCheck({
        tracks: [
          { worktreePath: wts.get("track/a")!, workingBranch: "track/a" },
          { worktreePath: join(root, "track-b"), workingBranch: "track/b" },
        ],
      });
      expect(codesOf(result)).toContain("worktree.l2.track-missing");
      expect(result.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("branch mismatch on one track → worktree.l2.branch-mismatch", () => {
    const root = tmpRoot("worktree-l2-branch-");
    try {
      const wts = worktreeFixture(root, ["track/a", "track/b"]);
      const result = l2PreDispatchCheck({
        tracks: [
          { worktreePath: wts.get("track/a")!, workingBranch: "track/a" },
          { worktreePath: wts.get("track/b")!, workingBranch: "track/a" },
        ],
      });
      expect(codesOf(result)).toContain("worktree.l2.branch-mismatch");
      expect(result.violations.filter((v) => v.code === "worktree.l2.branch-mismatch")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("duplicate worktreePath across tracks → worktree.l2.track-path-collision (real git worktrees; distinct paths → ok covered by the ok test above)", () => {
    const root = tmpRoot("worktree-l2-collision-");
    try {
      const wts = worktreeFixture(root, ["track/a"]);
      const shared = wts.get("track/a")!;
      const result = l2PreDispatchCheck({
        tracks: [
          { worktreePath: shared, workingBranch: "track/a" },
          { worktreePath: shared, workingBranch: "track/a" },
        ],
      });
      expect(result.ok).toBe(false);
 // exactly one collision violation, nothing else — the duplicate short-circuits before dir/probe checks
      expect(codesOf(result)).toEqual(["worktree.l2.track-path-collision"]);
      expect(severitiesOf(result)).toEqual(["high"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("relative track worktreePath → worktree.l2.track-path-relative", () => {
    const result = l2PreDispatchCheck({
      tracks: [{ worktreePath: "worktrees/track-a", workingBranch: "track/a" }],
    });
    expect(result.ok).toBe(false);
 // the relative path short-circuits before dir/probe checks — no track-missing
    expect(codesOf(result)).toEqual(["worktree.l2.track-path-relative"]);
    const v = findViolation(result, "worktree.l2.track-path-relative");
    expect(v?.severity).toBe("high");
  });

  test("trailing-slash alias of a track path collides → worktree.l2.track-path-collision (normalization)", () => {
    const root = tmpRoot("worktree-l2-cols-");
    try {
      const wts = worktreeFixture(root, ["track/a"]);
      const a = wts.get("track/a")!;
      const result = l2PreDispatchCheck({
        tracks: [
          { worktreePath: `${a}/`, workingBranch: "track/a" },
          { worktreePath: a, workingBranch: "track/a" },
        ],
      });
      expect(result.ok).toBe(false);
 // exactly one collision violation, nothing else — the duplicate short-circuits
      expect(codesOf(result)).toEqual(["worktree.l2.track-path-collision"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dot-dot alias of a track path collides → worktree.l2.track-path-collision (normalization)", () => {
    const root = tmpRoot("worktree-l2-cold-");
    try {
      const wts = worktreeFixture(root, ["track/a"]);
      const a = wts.get("track/a")!;
 // a == <root>/wt-track/a; <root>/wt-track/../wt-track/a is the same
 // directory via a dot-dot segment.
      const alias = join(a, "..", "..", "wt-track", "a");
      expect(resolve(alias)).toBe(resolve(a));
      const result = l2PreDispatchCheck({
        tracks: [
          { worktreePath: alias, workingBranch: "track/a" },
          { worktreePath: a, workingBranch: "track/a" },
        ],
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toEqual(["worktree.l2.track-path-collision"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normalized-distinct sibling paths do not collide", () => {
    const result = l2PreDispatchCheck({
      tracks: [
        { worktreePath: "/a/b", workingBranch: "track/a" },
        { worktreePath: "/a/b/c", workingBranch: "track/b" },
      ],
    });
    expect(codesOf(result)).not.toContain("worktree.l2.track-path-collision");
  });

  test("relative path on one track does not skip the other track's checks", () => {
    const root = tmpRoot("worktree-l2-relmixed-");
    try {
      const wts = worktreeFixture(root, ["track/a"]);
      const result = l2PreDispatchCheck({
        tracks: [
          { worktreePath: wts.get("track/a")!, workingBranch: "track/a" },
          { worktreePath: "relative/track-b", workingBranch: "track/b" },
        ],
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toEqual(["worktree.l2.track-path-relative"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("precomputed branchOf opt works per track (purity)", () => {
    const root = tmpRoot("worktree-l2-pure-");
    try {
      const a = join(root, "track-a");
      const b = join(root, "track-b");
      mkdirSync(a);
      mkdirSync(b);
      const branchOf = (p: string) => (p === a ? "track/a" : p === b ? "track/b" : undefined);
      const result = l2PreDispatchCheck(
        {
          tracks: [
            { worktreePath: a, workingBranch: "track/a" },
            { worktreePath: b, workingBranch: "track/b" },
          ],
        },
        { branchOf },
      );
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detached track worktree fails closed → worktree.l2.branch-probe-failed", () => {
    const root = tmpRoot("worktree-l2-detached-");
    try {
      const repo = join(root, "repo");
      mkdirSync(repo);
      git(["init", "-q"], repo);
      git(["config", "user.email", "worktree-test@example.com"], repo);
      git(["config", "user.name", "Worktree Test"], repo);
      writeFileSync(join(repo, "README.md"), "fixture\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "initial"], repo);
      const path = detachedWorktree(repo, root);
      const result = l2PreDispatchCheck({ tracks: [{ worktreePath: path, workingBranch: "track/a" }] });
      expect(codesOf(result)).toContain("worktree.l2.branch-probe-failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assertControlVsFeaturePath — lease worktree must be a distinct Git checkout", () => {
  test("same checkout → worktree.control-feature.same (critical)", () => {
    const root = tmpRoot("worktree-cvf-same-");
    try {
      const repo = gitRepo(root);
      const result = assertControlVsFeaturePath(repo, repo);
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.control-feature.same");
      expect(severitiesOf(result)).toContain("critical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("both empty → worktree.control-feature.same", () => {
    const result = assertControlVsFeaturePath("", "");
    expect(codesOf(result)).toContain("worktree.control-feature.same");
  });

  test("one empty → ok (nothing to compare; the lease validator owns empty lease paths)", () => {
    expect(assertControlVsFeaturePath("/repo/control", "").ok).toBe(true);
    expect(assertControlVsFeaturePath("", "/repo/feature").ok).toBe(true);
  });

  test("distinct linked worktrees → ok (real git worktrees)", () => {
    const root = tmpRoot("worktree-cvf-ok-");
    try {
      const wts = worktreeFixture(root, ["feature/a"]);
      const result = assertControlVsFeaturePath(join(root, "repo"), wts.get("feature/a")!);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested linked worktree inside the control checkout → ok (arbitrary folder name)", () => {
    const root = tmpRoot("worktree-cvf-nested-");
    try {
      const { repo, paths } = nestedWorktreeFixture(root, ["feature/a"]);
      expect(assertControlVsFeaturePath(repo, paths.get("feature/a")!).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plain subdirectory of the control checkout → worktree.control-feature.same", () => {
    const root = tmpRoot("worktree-cvf-subdir-");
    try {
      const repo = gitRepo(root);
      const subdir = join(repo, "plain-subdir");
      mkdirSync(subdir);
      expect(codesOf(assertControlVsFeaturePath(repo, subdir))).toContain("worktree.control-feature.same");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlink alias of the control checkout → worktree.control-feature.same", () => {
    const root = tmpRoot("worktree-cvf-alias-");
    try {
      const repo = gitRepo(root);
      const alias = join(root, "alias");
      symlinkSync(repo, alias);
      expect(codesOf(assertControlVsFeaturePath(repo, alias))).toContain("worktree.control-feature.same");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path aliases of the same dir collide → worktree.control-feature.same (normalization)", () => {
    const root = tmpRoot("worktree-cvf-norm-");
    try {
      const repo = gitRepo(root);
      expect(codesOf(assertControlVsFeaturePath(`${repo}/`, repo))).toContain("worktree.control-feature.same");
      expect(codesOf(assertControlVsFeaturePath(join(repo, "..", "repo"), repo))).toContain("worktree.control-feature.same");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-repo dir fails closed → worktree.control-feature.same", () => {
    const root = tmpRoot("worktree-cvf-nonrepo-");
    try {
      const dir = join(root, "not-a-repo");
      mkdirSync(dir);
      expect(codesOf(assertControlVsFeaturePath(dir, join(root, "other")))).toContain("worktree.control-feature.same");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assertBranchAlignment — git branch probe vs expected Working branch", () => {
  test("matching branch → ok (real git worktree)", () => {
    const root = tmpRoot("worktree-align-ok-");
    try {
      const wts = worktreeFixture(root, ["feature/x"]);
      const result = assertBranchAlignment(wts.get("feature/x")!, "feature/x");
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mismatch → worktree.branch-mismatch (high)", () => {
    const root = tmpRoot("worktree-align-mismatch-");
    try {
      const wts = worktreeFixture(root, ["feature/x"]);
      const result = assertBranchAlignment(wts.get("feature/x")!, "feature/y");
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.branch-mismatch");
      expect(severitiesOf(result)).toContain("high");
      expect(findViolation(result, "worktree.branch-mismatch")?.message).toContain("feature/x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("precomputed branchOf opt skips the git probe (purity)", () => {
    const result = assertBranchAlignment("/any/path", "feature/z", { branchOf: () => "feature/z" });
    expect(result.ok).toBe(true);
    const mismatch = assertBranchAlignment("/any/path", "feature/z", { branchOf: () => "feature/w" });
    expect(codesOf(mismatch)).toContain("worktree.branch-mismatch");
  });

  test("non-repo dir probe fails closed → worktree.branch-probe-failed", () => {
    const root = tmpRoot("worktree-align-probe-");
    try {
      const dir = join(root, "not-a-repo");
      mkdirSync(dir);
      const result = assertBranchAlignment(dir, "feature/x");
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.branch-probe-failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detached HEAD probe fails closed → worktree.branch-probe-failed", () => {
    const root = tmpRoot("worktree-align-detached-");
    try {
      const repo = join(root, "repo");
      mkdirSync(repo);
      git(["init", "-q"], repo);
      git(["config", "user.email", "worktree-test@example.com"], repo);
      git(["config", "user.name", "Worktree Test"], repo);
      writeFileSync(join(repo, "README.md"), "fixture\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "initial"], repo);
      const path = detachedWorktree(repo, root);
      const result = assertBranchAlignment(path, "feature/x");
      expect(codesOf(result)).toContain("worktree.branch-probe-failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("assertQcAlignment — byte-identical plan_id + Review range + Diff basis across tri + QA", () => {
  const TRI_QA = [
    { planId: "20260808-p1", reviewRange: "merge-base: main", diffBasis: "tip: HEAD" },
    { planId: "20260808-p1", reviewRange: "merge-base: main", diffBasis: "tip: HEAD" },
    { planId: "20260808-p1", reviewRange: "merge-base: main", diffBasis: "tip: HEAD" },
    { planId: "20260808-p1", reviewRange: "merge-base: main", diffBasis: "tip: HEAD" },
  ] as const;

  test("four identical assignments (tri + QA) → ok", () => {
    const result = assertQcAlignment([...TRI_QA]);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("plan_id differs in one assignment → qc.alignment.mismatch (high) naming plan_id", () => {
    const result = assertQcAlignment([
      ...TRI_QA.slice(0, 3),
      { planId: "20260808-p2", reviewRange: "merge-base: main", diffBasis: "tip: HEAD" },
    ]);
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(["qc.alignment.mismatch"]);
    expect(severitiesOf(result)).toEqual(["high"]);
    expect(result.violations[0]!.message).toContain("plan_id");
  });

  test("Review range differs → qc.alignment.mismatch naming Review range", () => {
    const result = assertQcAlignment([
      ...TRI_QA.slice(0, 3),
      { planId: "20260808-p1", reviewRange: "rev-range: abc..def", diffBasis: "tip: HEAD" },
    ]);
    expect(codesOf(result)).toEqual(["qc.alignment.mismatch"]);
    expect(result.violations[0]!.message).toContain("Review range");
  });

  test("Diff basis differs → qc.alignment.mismatch naming Diff basis", () => {
    const result = assertQcAlignment([
      ...TRI_QA.slice(0, 3),
      { planId: "20260808-p1", reviewRange: "merge-base: main", diffBasis: "tip: HEAD~1" },
    ]);
    expect(codesOf(result)).toEqual(["qc.alignment.mismatch"]);
    expect(result.violations[0]!.message).toContain("Diff basis");
  });

  test("byte-identical is strict — trailing whitespace counts as mismatch", () => {
    const result = assertQcAlignment([
      ...TRI_QA.slice(0, 3),
      { planId: "20260808-p1", reviewRange: "merge-base: main", diffBasis: "tip: HEAD " },
    ]);
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("qc.alignment.mismatch");
  });

  test("two differing fields → one violation per field", () => {
    const result = assertQcAlignment([
      ...TRI_QA.slice(0, 2),
      { planId: "20260808-p2", reviewRange: "merge-base: develop", diffBasis: "tip: HEAD" },
      { planId: "20260808-p1", reviewRange: "merge-base: main", diffBasis: "tip: HEAD" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.filter((v) => v.code === "qc.alignment.mismatch")).toHaveLength(2);
  });

  test("single assignment and empty set are trivially aligned", () => {
    expect(assertQcAlignment([TRI_QA[0]!]).ok).toBe(true);
    expect(assertQcAlignment([]).ok).toBe(true);
  });
});

describe("singleReviewSnapshot — one review snapshot precondition (派 QC 前置条件)", () => {
  const BASE = { planId: "20260808-p1", reviewRange: "merge-base: main", diffBasis: "tip: HEAD" };

  test("same precomputed head across assignments → ok", () => {
    const result = singleReviewSnapshot([
      { ...BASE, head: "a".repeat(40) },
      { ...BASE, head: "a".repeat(40) },
      { ...BASE, head: "a".repeat(40) },
    ]);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("different heads → qc.alignment.single-snapshot (high)", () => {
    const result = singleReviewSnapshot([
      { ...BASE, head: "a".repeat(40) },
      { ...BASE, head: "b".repeat(40) },
    ]);
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(["qc.alignment.single-snapshot"]);
    expect(severitiesOf(result)).toEqual(["high"]);
  });

  test("missing precomputed head → qc.alignment.snapshot-missing", () => {
    const result = singleReviewSnapshot([
      { ...BASE, head: "a".repeat(40) },
      { ...BASE },
      { ...BASE, head: "a".repeat(40) },
    ]);
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("qc.alignment.snapshot-missing");
  });

  test("empty-string head counts as missing", () => {
    const result = singleReviewSnapshot([{ ...BASE, head: "" }]);
    expect(codesOf(result)).toContain("qc.alignment.snapshot-missing");
  });

  test("empty set → ok", () => {
    expect(singleReviewSnapshot([]).ok).toBe(true);
  });
});

describe("git probe timeout — bounded probes fail closed ", () => {
  /**
 * A deliberately slow fake `git` executable: sleeps far beyond the probe
 * timeout so the probe must be killed by the engine's bounded timeout.
 */
  function slowGitFixture(fn: (gitPath: string, lease: string) => void): void {
    const root = tmpRoot("worktree-probe-timeout-");
    try {
      const gitPath = join(root, "fake-git");
      writeFileSync(gitPath, "#!/bin/sh\nsleep 30\nexit 0\n", { mode: 0o755 });
      chmodSync(gitPath, 0o755);
      const lease = join(root, "lease");
      mkdirSync(lease);
      const control = join(root, "control");
      mkdirSync(control);
      fn(gitPath, lease);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("per-call timeoutMs bounds the probe → checkout-probe-failed + branch-probe-failed with timeout detail", () => {
    slowGitFixture((gitPath, lease) => {
      const result = l1PreDispatchCheck(
        {
          workflowType: "plan",
          integrationWorktreePath: "",
          integrationBranch: "",
          mainWorktree: { root: join(lease, "..", "control"), branch: "main" },
          expectedMainBranch: "main",
          lifecycleBranches: [],
          leaseWorktreePath: lease,
          leaseWorkingBranch: "feature/a",
          planId: "p-1",
        },
        { gitPath, timeoutMs: 300 },
      );
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toEqual(["worktree.l1.checkout-probe-failed", "worktree.l1.branch-probe-failed"]);
      expect(findViolation(result, "worktree.l1.checkout-probe-failed")?.message).toMatch(/timed out after 300ms/);
      expect(findViolation(result, "worktree.l1.branch-probe-failed")?.message).toMatch(/timed out after 300ms/);
    });
  });

  test("env override MSTAR_GIT_PROBE_TIMEOUT_MS bounds the probe", () => {
    const previous = process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
    try {
      process.env.MSTAR_GIT_PROBE_TIMEOUT_MS = "300";
      slowGitFixture((gitPath, lease) => {
        const result = l1PreDispatchCheck(
          {
            workflowType: "plan",
            integrationWorktreePath: "",
            integrationBranch: "",
            mainWorktree: { root: join(lease, "..", "control"), branch: "main" },
            expectedMainBranch: "main",
            lifecycleBranches: [],
            leaseWorktreePath: lease,
            leaseWorkingBranch: "feature/a",
            planId: "p-1",
          },
          { gitPath },
        );
        expect(codesOf(result)).toEqual(["worktree.l1.checkout-probe-failed", "worktree.l1.branch-probe-failed"]);
        expect(findViolation(result, "worktree.l1.checkout-probe-failed")?.message).toMatch(/timed out after 300ms/);
        expect(findViolation(result, "worktree.l1.branch-probe-failed")?.message).toMatch(/timed out after 300ms/);
      });
    } finally {
      if (previous === undefined) delete process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
      else process.env.MSTAR_GIT_PROBE_TIMEOUT_MS = previous;
    }
  });

  test("invalid env value falls back to the default timeout (fast git still probes fine)", () => {
    const previous = process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
    try {
      process.env.MSTAR_GIT_PROBE_TIMEOUT_MS = "not-a-number";
      const root = tmpRoot("worktree-probe-default-");
      try {
        const wts = worktreeFixture(root, ["feature/x"]);
        const repo = join(root, "repo");
        const main = mainInfo(repo);
        const result = l1PreDispatchCheck({
          workflowType: "plan",
          integrationWorktreePath: "",
          integrationBranch: "",
          mainWorktree: main,
          expectedMainBranch: main.branch,
          lifecycleBranches: ["feature/x"],
          leaseWorktreePath: wts.get("feature/x")!,
          leaseWorkingBranch: "feature/x",
          planId: "p-1",
        });
        expect(result.ok).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
      else process.env.MSTAR_GIT_PROBE_TIMEOUT_MS = previous;
    }
  });
});


test("L1 identity probes are once per checkout per invocation, never cached across checks", () => {
  const root = tmpRoot("wt-probe-memo-");
  try {
    const wts = worktreeFixture(root, ["iteration/a", "feature/a"]);
    const repo = join(root, "repo");
    const main = mainInfo(repo);
    const log = join(root, "calls");
    const shim = join(root, "git-shim");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const input = { workflowType: "iteration" as const, integrationWorktreePath: wts.get("iteration/a")!, integrationBranch: "iteration/a", mainWorktree: main, expectedMainBranch: main.branch, lifecycleBranches: ["iteration/a", "feature/a"], leaseWorktreePath: wts.get("feature/a")!, leaseWorkingBranch: "feature/a", planId: "plan-a" };
    expect(l1PreDispatchCheck(input, { gitPath: shim }).ok).toBe(true);
    expect(readFileSync(log, "utf8").split("\n").filter((line) => line.endsWith("rev-parse --git-dir"))).toHaveLength(3);
    expect(l1PreDispatchCheck(input, { gitPath: shim }).ok).toBe(true);
    expect(readFileSync(log, "utf8").split("\n").filter((line) => line.endsWith("rev-parse --git-dir"))).toHaveLength(6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
