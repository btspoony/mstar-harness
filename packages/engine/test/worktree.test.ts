/**
 * Engine worktree module — L1/L2 pre-dispatch checklists, control-vs-feature
 * path gate, branch alignment probe, QC/QA field alignment.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - L1/L2 layer split + stacking — control worktree + per-plan feature
 *   worktrees + `plans[].execution_lease` (L1); within-plan parallel writable
 *   tracks need their own distinct worktrees (L2, L1 does not replace L2):
 *   `mstar-branch-worktree` SKILL.md § "Worktree isolation layers (L1 vs L2)"
 *   § "Stacking rules".
 * - Control vs feature worktree roles — `execution_lease.worktree_path` MUST
 *   differ from `metadata.control_worktree_path`; the feature worktree is the
 *   required cwd for product edits (control checkout is Forbidden for
 *   writable edits); never bootstrap a second plans/status/SDD tree under the
 *   feature checkout (harness SSOT resolves from the control worktree):
 *   SKILL.md § "Control worktree vs feature worktree (iteration / L1)" +
 *   § "Harness path SSOT under default gitignore (L1)" § "Hard rules".
 * - L2 pre-dispatch checklist — per-track worktree dirs exist and
 *   `git -C <path> branch --show-current` matches the Assignment Working
 *   branch before the first concurrent writable dispatch; N parallel invokes
 *   ≠ isolation; emit zero until ready:
 *   `mstar-branch-worktree` `references/parallel-writable-pre-dispatch.md`
 *   § "Pre-dispatch checklist (HARD)".
 * - QC/QA alignment — `plan_id` + `Review range`/`Diff basis` byte-identical
 *   (逐字相同) across the QC tri + QA assignments; single review snapshot
 *   precondition (all reviewable commits on ONE Working branch HEAD before
 *   QC tri + QA):
 *   SKILL.md § "QC / QA 检出对齐与多 worktree 门禁衔接" § 对齐字段契约 +
 *   § "单一待审 Git 快照（派 QC 前置条件）".
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateResult } from "../src/core.js";
import {
  assertBranchAlignment,
  assertControlVsFeaturePath,
  assertQcAlignment,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  singleReviewSnapshot,
} from "../src/worktree.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Create a temp git repo with an initial commit and one linked worktree per
 * branch via real `git worktree add` (L1/L2 probe realism). Returns
 * branch → absolute worktree path.
 */
function worktreeFixture(root: string, branches: readonly string[]): Map<string, string> {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q"], repo);
  git(["config", "user.email", "worktree-test@example.com"], repo);
  git(["config", "user.name", "Worktree Test"], repo);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  const paths = new Map<string, string>();
  for (const branch of branches) {
    const path = join(root, `wt-${branch}`);
    git(["worktree", "add", "-q", "-b", branch, path], repo);
    paths.set(branch, path);
  }
  return paths;
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

describe("l1PreDispatchCheck — L1 cross-plan checklist", () => {
  test("passes when control path recorded, lease worktree exists on the lease branch (real git worktree)", () => {
    const root = tmpRoot("worktree-l1-ok-");
    try {
      const wts = worktreeFixture(root, ["feature/a"]);
      const control = join(root, "control");
      mkdirSync(control);
      const result = l1PreDispatchCheck({
        controlWorktreePath: control,
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

  test("lease worktree equal to control path → worktree.l1.lease-equals-control (critical)", () => {
    const root = tmpRoot("worktree-l1-eq-");
    try {
      const path = join(root, "same");
      mkdirSync(path);
      const result = l1PreDispatchCheck({
        controlWorktreePath: path,
        leaseWorktreePath: path,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("worktree.l1.lease-equals-control");
      expect(severitiesOf(result)).toContain("critical");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty control path → worktree.l1.control-missing (control not recorded)", () => {
    const result = l1PreDispatchCheck({
      controlWorktreePath: "",
      leaseWorktreePath: "/tmp/lease",
      leaseWorkingBranch: "feature/a",
      planId: "p-1",
    });
    expect(codesOf(result)).toContain("worktree.l1.control-missing");
    expect(result.ok).toBe(false);
  });

  test("empty lease worktree path → worktree.l1.lease-missing", () => {
    const result = l1PreDispatchCheck({
      controlWorktreePath: "/tmp/control",
      leaseWorktreePath: "",
      leaseWorkingBranch: "feature/a",
      planId: "p-1",
    });
    expect(codesOf(result)).toContain("worktree.l1.lease-missing");
  });

  test("empty lease working branch → worktree.l1.lease-branch-missing", () => {
    const result = l1PreDispatchCheck({
      controlWorktreePath: "/tmp/control",
      leaseWorktreePath: "/tmp/lease",
      leaseWorkingBranch: "",
      planId: "p-1",
    });
    expect(codesOf(result)).toContain("worktree.l1.lease-branch-missing");
  });

  test("missing feature worktree dir → worktree.l1.feature-missing", () => {
    const result = l1PreDispatchCheck({
      controlWorktreePath: "/tmp/control",
      leaseWorktreePath: "/tmp/does-not-exist",
      leaseWorkingBranch: "feature/a",
      planId: "p-1",
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("worktree.l1.feature-missing");
  });

  test("branch at feature path != lease working branch → worktree.l1.branch-mismatch (real git worktree)", () => {
    const root = tmpRoot("worktree-l1-branch-");
    try {
      const wts = worktreeFixture(root, ["feature/a", "feature/b"]);
      const result = l1PreDispatchCheck({
        controlWorktreePath: join(root, "control"),
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

  test("precomputed branchOf opt skips the git probe (purity)", () => {
    const root = tmpRoot("worktree-l1-pure-");
    try {
      const lease = join(root, "lease");
      mkdirSync(lease);
      const base = {
        controlWorktreePath: join(root, "control"),
        leaseWorktreePath: lease,
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

  test("non-repo lease dir probe fails closed → worktree.l1.branch-probe-failed", () => {
    const root = tmpRoot("worktree-l1-probe-");
    try {
      const lease = join(root, "lease");
      mkdirSync(lease);
      const result = l1PreDispatchCheck({
        controlWorktreePath: join(root, "control"),
        leaseWorktreePath: lease,
        leaseWorkingBranch: "feature/a",
        planId: "p-1",
      });
      expect(codesOf(result)).toContain("worktree.l1.branch-probe-failed");
      expect(result.ok).toBe(false);
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

describe("assertControlVsFeaturePath — lease worktree ≠ control path", () => {
  test("same path → worktree.control-feature.same (critical)", () => {
    const result = assertControlVsFeaturePath("/repo/control", "/repo/control");
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("worktree.control-feature.same");
    expect(severitiesOf(result)).toContain("critical");
  });

  test("both empty → worktree.control-feature.same", () => {
    const result = assertControlVsFeaturePath("", "");
    expect(codesOf(result)).toContain("worktree.control-feature.same");
  });

  test("different paths → ok", () => {
    const result = assertControlVsFeaturePath("/repo/control", "/worktrees/p-1");
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
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
