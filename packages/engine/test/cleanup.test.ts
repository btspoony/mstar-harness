/**
 * Engine cleanup planner tests — pure facts→decisions planner
 * (`planWorktreeCleanup`, one function, no `planBranchCleanup`).
 *
 * Spec sources (each test cites the contract it enforces):
 * - Locked interface + decision precedence + timing lanes — iteration spec
 *   worktree-write-model § "Locked interfaces (P3 engine)" + § "Stable
 *   machine codes"; plan 20260912-cleanup-tool-sweep T1 (Step 1 fixtures).
 * - Non-terminal integration refuse is scoped to the integration owner, not
 *   to all children: a Done plan row under a running parent iteration is
 *   eligible (lock decision 4, two timing lanes).
 * - Checked-out guard applies to branch deletion, not to removal of the
 *   eligible owned worktree: dry-run prints worktree `remove` plus its
 *   branch `refuse` (`cleanup.refuse.checked-out`).
 * - Merged evidence: local membership from `mergedLocalBranches[base]`
 *   (plan/track → `branch.integration`, standalone/integration →
 *   `branch.target`); remote evidence binds {branch, tip, base} —
 *   `prMerged: false` refuses even with ancestry, `null` permits the
 *   ancestor-only historical-residue route, a tip mismatch refuses (the
 *   evidence does not name the observed branch incarnation).
 * - Protected refs: default branch and every explicit `branch.base` across
 *   all supplied snapshots; a main worktree is never removed.
 * - Purity: values in / decisions out, one decision per target in input
 *   order, facts never mutated.
 */
import { describe, expect, test } from "bun:test";
import { planWorktreeCleanup, type CleanupFacts, type CleanupTarget } from "../src/cleanup.js";
import type { WorkflowSnapshot } from "../src/workflow.js";

const TIP_MERGED = "1111111111111111111111111111111111111111";
const TIP_OTHER = "2222222222222222222222222222222222222222";
const TIP_MOVED = "3333333333333333333333333333333333333333";

const MAIN_WT = "/repo";
const INT_WT = "/repo/.worktrees/iter-parent";

function snap(overrides: Partial<WorkflowSnapshot> & Pick<WorkflowSnapshot, "id" | "type" | "status">): WorkflowSnapshot {
  return {
    schema_version: 1,
    started_at: "2026-09-12",
    updated_at: "2026-09-12",
    plans: [],
    ...overrides,
  };
}

function worktree(path: string, branch: string | null, extra: { isMain?: boolean; clean?: boolean; locked?: boolean } = {}) {
  return { path, branch, isMain: extra.isMain ?? false, clean: extra.clean ?? true, locked: extra.locked ?? false };
}

function target(overrides: Partial<CleanupTarget> & Pick<CleanupTarget, "kind" | "ref" | "branch">): CleanupTarget {
  return { tip: TIP_MERGED, owner: null, ...overrides };
}

/** Running parent iteration: Done plan-1, leased plan-2, InReview plan-6, unmerged-Done plan-5. */
const iterParent = snap({
  id: "iter-parent",
  type: "iteration",
  status: "running",
  branch: { base: "main", integration: "iteration/iter-parent", target: "main" },
  integration_worktree_path: INT_WT,
  plans: [
    { id: "plan-1", status: "Done", metadata: { working_branch: "feature/plan-1", worktree_path: "/repo/.worktrees/plan-1" } },
    {
      id: "plan-2",
      status: "InProgress",
      execution_lease: { holder: "dev-2", claimed_at: "2026-09-12", worktree_path: "/repo/.worktrees/plan-2", working_branch: "feature/plan-2" },
    },
    { id: "plan-5", status: "Done", metadata: { working_branch: "feature/plan-5", worktree_path: "/repo/.worktrees/plan-5" } },
    { id: "plan-6", status: "InReview", metadata: { working_branch: "feature/plan-6" } },
  ],
});

function lane1Facts(worktrees: ReturnType<typeof worktree>[]): CleanupFacts {
  return {
    targets: [],
    worktrees,
    snapshots: [iterParent],
    defaultBranch: "main",
    mergedLocalBranches: {
      main: ["main", "iteration/iter-parent"],
      "iteration/iter-parent": ["feature/plan-1", "iteration/iter-parent"],
    },
    remoteEvidence: [],
  };
}

describe("planWorktreeCleanup", () => {
  test("keeps the main worktree and protected refs (default branch + every explicit branch.base)", () => {
    const soloDone = snap({
      id: "plan-solo",
      type: "plan",
      status: "completed",
      ended_at: "2026-09-12",
      branch: { base: "release/9", target: "main" },
    });
    const facts: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true })]),
      snapshots: [iterParent, soloDone],
      targets: [
        target({ kind: "worktree", ref: MAIN_WT, branch: "main", owner: null }),
        target({ kind: "local-branch", ref: "main", branch: "main", owner: null }),
        target({ kind: "remote-branch", ref: "origin/main", branch: "main", owner: null }),
        target({ kind: "local-branch", ref: "release/9", branch: "release/9", owner: null }),
      ],
    };
    expect(planWorktreeCleanup(iterParent, facts)).toEqual([
      { kind: "worktree", ref: MAIN_WT, verdict: "keep", reason: "cleanup.keep.main-worktree" },
      { kind: "local-branch", ref: "main", verdict: "keep", reason: "cleanup.keep.protected-ref" },
      { kind: "remote-branch", ref: "origin/main", verdict: "keep", reason: "cleanup.keep.protected-ref" },
      { kind: "local-branch", ref: "release/9", verdict: "keep", reason: "cleanup.keep.protected-ref" },
    ]);
  });

  test("refuses the non-terminal integration owner without refusing its Done children (active-parent/Done-child eligibility)", () => {
    const facts: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true })]),
      targets: [
        target({ kind: "local-branch", ref: "iteration/iter-parent", branch: "iteration/iter-parent", owner: { workflowId: "iter-parent" } }),
        target({ kind: "worktree", ref: INT_WT, branch: "iteration/iter-parent", owner: { workflowId: "iter-parent" } }),
        target({ kind: "local-branch", ref: "feature/plan-1", branch: "feature/plan-1", owner: { workflowId: "iter-parent", planId: "plan-1" } }),
      ],
    };
    expect(planWorktreeCleanup(iterParent, facts)).toEqual([
      { kind: "local-branch", ref: "iteration/iter-parent", verdict: "refuse", reason: "cleanup.refuse.non-terminal" },
      { kind: "worktree", ref: INT_WT, verdict: "refuse", reason: "cleanup.refuse.non-terminal" },
      { kind: "local-branch", ref: "feature/plan-1", verdict: "remove", reason: "cleanup.remove.merged" },
    ]);
  });

  test("removes the owned attached worktree while its branch stays refused as checked-out until replan", () => {
    const facts: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true }), worktree("/repo/.worktrees/plan-1", "feature/plan-1")]),
      targets: [
        target({ kind: "worktree", ref: "/repo/.worktrees/plan-1", branch: "feature/plan-1", owner: { workflowId: "iter-parent", planId: "plan-1" } }),
        target({ kind: "local-branch", ref: "feature/plan-1", branch: "feature/plan-1", owner: { workflowId: "iter-parent", planId: "plan-1" } }),
      ],
    };
    expect(planWorktreeCleanup(iterParent, facts)).toEqual([
      { kind: "worktree", ref: "/repo/.worktrees/plan-1", verdict: "remove", reason: "cleanup.remove.merged" },
      { kind: "local-branch", ref: "feature/plan-1", verdict: "refuse", reason: "cleanup.refuse.checked-out" },
    ]);
  });

  test("refuses targets referenced by an active execution lease, by path and by branch", () => {
    const facts: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true }), worktree("/repo/.worktrees/plan-2", "feature/plan-2")]),
      targets: [
        target({ kind: "worktree", ref: "/repo/.worktrees/plan-2", branch: "feature/plan-2", owner: { workflowId: "iter-parent", planId: "plan-2" } }),
        target({ kind: "local-branch", ref: "feature/plan-2", branch: "feature/plan-2", owner: { workflowId: "iter-parent", planId: "plan-2" } }),
      ],
    };
    expect(planWorktreeCleanup(iterParent, facts)).toEqual([
      { kind: "worktree", ref: "/repo/.worktrees/plan-2", verdict: "refuse", reason: "cleanup.refuse.active-lease" },
      { kind: "local-branch", ref: "feature/plan-2", verdict: "refuse", reason: "cleanup.refuse.active-lease" },
    ]);
  });

  test("refuses targets referenced by an active integration merge lease, before the non-terminal check", () => {
    const iterMerging = snap({
      id: "iter-m",
      type: "iteration",
      status: "running",
      branch: { base: "main", integration: "iteration/iter-m", target: "main" },
      integration_merge_lease: { holder: "pm", claimed_at: "2026-09-12", plan_id: "plan-7", source_branch: "feature/plan-7", target_branch: "iteration/iter-m" },
      plans: [{ id: "plan-7", status: "Done", metadata: { working_branch: "feature/plan-7" } }],
    });
    const facts: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true })]),
      snapshots: [iterMerging],
      targets: [
        target({ kind: "local-branch", ref: "feature/plan-7", branch: "feature/plan-7", owner: { workflowId: "iter-m", planId: "plan-7" } }),
        target({ kind: "local-branch", ref: "iteration/iter-m", branch: "iteration/iter-m", owner: { workflowId: "iter-m" } }),
      ],
    };
    expect(planWorktreeCleanup(iterMerging, facts)).toEqual([
      { kind: "local-branch", ref: "feature/plan-7", verdict: "refuse", reason: "cleanup.refuse.active-lease" },
      { kind: "local-branch", ref: "iteration/iter-m", verdict: "refuse", reason: "cleanup.refuse.active-lease" },
    ]);
  });

  test("refuses foreign ownership for worktrees and branches (owner null)", () => {
    const facts: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true })]),
      targets: [
        target({ kind: "worktree", ref: "/repo/.worktrees/foreign", branch: "feature/foreign", owner: null }),
        target({ kind: "local-branch", ref: "feature/orphan", branch: "feature/orphan", owner: null }),
      ],
    };
    expect(planWorktreeCleanup(iterParent, facts)).toEqual([
      { kind: "worktree", ref: "/repo/.worktrees/foreign", verdict: "refuse", reason: "cleanup.refuse.foreign-worktree" },
      { kind: "local-branch", ref: "feature/orphan", verdict: "refuse", reason: "cleanup.refuse.foreign-branch" },
    ]);
  });

  test("refuses dirty and locked worktrees", () => {
    const iterParentWithDone34: WorkflowSnapshot = {
      ...iterParent,
      plans: [
        ...iterParent.plans,
        { id: "plan-3", status: "Done", metadata: { working_branch: "feature/plan-3", worktree_path: "/repo/.worktrees/plan-3" } },
        { id: "plan-4", status: "Done", metadata: { working_branch: "feature/plan-4", worktree_path: "/repo/.worktrees/plan-4" } },
      ],
    };
    const facts: CleanupFacts = {
      ...lane1Facts([
        worktree(MAIN_WT, "main", { isMain: true }),
        worktree("/repo/.worktrees/plan-3", "feature/plan-3", { clean: false }),
        worktree("/repo/.worktrees/plan-4", "feature/plan-4", { locked: true }),
      ]),
      snapshots: [iterParentWithDone34],
      mergedLocalBranches: {
        ...lane1Facts([]).mergedLocalBranches,
        "iteration/iter-parent": ["feature/plan-1", "feature/plan-3", "feature/plan-4", "iteration/iter-parent"],
      },
      targets: [
        target({ kind: "worktree", ref: "/repo/.worktrees/plan-3", branch: "feature/plan-3", owner: { workflowId: "iter-parent", planId: "plan-3" } }),
        target({ kind: "worktree", ref: "/repo/.worktrees/plan-4", branch: "feature/plan-4", owner: { workflowId: "iter-parent", planId: "plan-4" } }),
      ],
    };
    expect(planWorktreeCleanup(iterParentWithDone34, facts)).toEqual([
      { kind: "worktree", ref: "/repo/.worktrees/plan-3", verdict: "refuse", reason: "cleanup.refuse.dirty-worktree" },
      { kind: "worktree", ref: "/repo/.worktrees/plan-4", verdict: "refuse", reason: "cleanup.refuse.locked-worktree" },
    ]);
  });

  test("refuses a non-Done row's branch even without an active lease", () => {
    const facts: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true })]),
      targets: [
        target({ kind: "local-branch", ref: "feature/plan-6", branch: "feature/plan-6", owner: { workflowId: "iter-parent", planId: "plan-6" } }),
      ],
    };
    expect(planWorktreeCleanup(iterParent, facts)).toEqual([
      { kind: "local-branch", ref: "feature/plan-6", verdict: "refuse", reason: "cleanup.refuse.non-terminal" },
    ]);
  });

  test("refuses a local branch without matching merged membership at its correct base", () => {
    const facts: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true })]),
      targets: [
        target({ kind: "local-branch", ref: "feature/plan-5", branch: "feature/plan-5", owner: { workflowId: "iter-parent", planId: "plan-5" } }),
      ],
    };
    expect(planWorktreeCleanup(iterParent, facts)).toEqual([
      { kind: "local-branch", ref: "feature/plan-5", verdict: "refuse", reason: "cleanup.refuse.unmerged" },
    ]);
  });

  test("standalone plan requires terminal close first and evaluates evidence against branch.target", () => {
    const soloRunning = snap({ id: "plan-solo", type: "plan", status: "running", branch: { base: "main", target: "main" } });
    const soloDone = snap({ id: "plan-solo", type: "plan", status: "completed", ended_at: "2026-09-12", branch: { base: "main", target: "main" } });
    const base: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true })]),
      mergedLocalBranches: { main: ["main", "feature/solo"] },
    };
    const runningRefused = planWorktreeCleanup(soloRunning, {
      ...base,
      snapshots: [soloRunning],
      targets: [target({ kind: "local-branch", ref: "feature/solo", branch: "feature/solo", owner: { workflowId: "plan-solo" } })],
    });
    expect(runningRefused).toEqual([
      { kind: "local-branch", ref: "feature/solo", verdict: "refuse", reason: "cleanup.refuse.non-terminal" },
    ]);
    const doneEligible = planWorktreeCleanup(soloDone, {
      ...base,
      snapshots: [soloDone],
      targets: [target({ kind: "local-branch", ref: "feature/solo", branch: "feature/solo", owner: { workflowId: "plan-solo" } })],
    });
    expect(doneEligible).toEqual([{ kind: "local-branch", ref: "feature/solo", verdict: "remove", reason: "cleanup.remove.merged" }]);
  });

  test("removes the terminal integration worktree while its branch stays refused as checked-out until replan", () => {
    const iterDone = snap({
      id: "iter-done",
      type: "iteration",
      status: "completed",
      ended_at: "2026-09-12",
      branch: { base: "main", integration: "iteration/iter-done", target: "main" },
      integration_worktree_path: "/repo/.worktrees/iter-done",
    });
    const facts: CleanupFacts = {
      targets: [
        target({ kind: "worktree", ref: "/repo/.worktrees/iter-done", branch: "iteration/iter-done", owner: { workflowId: "iter-done" } }),
        target({ kind: "local-branch", ref: "iteration/iter-done", branch: "iteration/iter-done", owner: { workflowId: "iter-done" } }),
      ],
      worktrees: [worktree(MAIN_WT, "main", { isMain: true }), worktree("/repo/.worktrees/iter-done", "iteration/iter-done")],
      snapshots: [iterDone, iterParent],
      defaultBranch: "main",
      mergedLocalBranches: {
        main: ["main", "iteration/iter-done"],
        "iteration/iter-parent": ["feature/plan-1", "iteration/iter-parent"],
      },
      remoteEvidence: [],
    };
    expect(planWorktreeCleanup(iterDone, facts)).toEqual([
      { kind: "worktree", ref: "/repo/.worktrees/iter-done", verdict: "remove", reason: "cleanup.remove.merged" },
      { kind: "local-branch", ref: "iteration/iter-done", verdict: "refuse", reason: "cleanup.refuse.checked-out" },
    ]);
  });

  test("integration branch + remote evidence after the worktree removal replan: merged, known-unmerged, ancestor-only, moved tip, missing evidence", () => {
    const iterDone = snap({
      id: "iter-done",
      type: "iteration",
      status: "completed",
      ended_at: "2026-09-12",
      branch: { base: "main", integration: "iteration/iter-done", target: "main" },
      integration_worktree_path: "/repo/.worktrees/iter-done",
    });
    const facts: CleanupFacts = {
      targets: [
        target({ kind: "local-branch", ref: "iteration/iter-done", branch: "iteration/iter-done", owner: { workflowId: "iter-done" } }),
        target({ kind: "remote-branch", ref: "origin/iteration/iter-done", branch: "iteration/iter-done", tip: TIP_MERGED, owner: { workflowId: "iter-done" } }),
        target({ kind: "remote-branch", ref: "origin/iteration/iter-unmerged", branch: "iteration/iter-unmerged", tip: TIP_MERGED, owner: { workflowId: "iter-done" } }),
        target({ kind: "remote-branch", ref: "origin/iteration/iter-ancestor-only", branch: "iteration/iter-ancestor-only", tip: TIP_MERGED, owner: { workflowId: "iter-done" } }),
        target({ kind: "remote-branch", ref: "origin/iteration/iter-no-ancestor", branch: "iteration/iter-no-ancestor", tip: TIP_MERGED, owner: { workflowId: "iter-done" } }),
        target({ kind: "remote-branch", ref: "origin/iteration/iter-squashed", branch: "iteration/iter-squashed", tip: TIP_OTHER, owner: { workflowId: "iter-done" } }),
        target({ kind: "remote-branch", ref: "origin/iteration/iter-moved", branch: "iteration/iter-moved", tip: TIP_MOVED, owner: { workflowId: "iter-done" } }),
        target({ kind: "remote-branch", ref: "origin/iteration/iter-no-evidence", branch: "iteration/iter-no-evidence", tip: TIP_MERGED, owner: { workflowId: "iter-done" } }),
      ],
      worktrees: [worktree(MAIN_WT, "main", { isMain: true })],
      snapshots: [iterDone, iterParent],
      defaultBranch: "main",
      mergedLocalBranches: {
        main: ["main", "iteration/iter-done"],
        "iteration/iter-parent": ["feature/plan-1", "iteration/iter-parent"],
      },
      remoteEvidence: [
        { branch: "iteration/iter-done", tip: TIP_MERGED, base: "main", ancestor: true, prMerged: true },
        { branch: "iteration/iter-unmerged", tip: TIP_MERGED, base: "main", ancestor: true, prMerged: false },
        { branch: "iteration/iter-ancestor-only", tip: TIP_MERGED, base: "main", ancestor: true, prMerged: null },
        { branch: "iteration/iter-no-ancestor", tip: TIP_MERGED, base: "main", ancestor: false, prMerged: null },
        { branch: "iteration/iter-squashed", tip: TIP_OTHER, base: "main", ancestor: false, prMerged: true },
        { branch: "iteration/iter-moved", tip: TIP_MERGED, base: "main", ancestor: true, prMerged: true },
      ],
    };
    expect(planWorktreeCleanup(iterDone, facts)).toEqual([
      { kind: "local-branch", ref: "iteration/iter-done", verdict: "remove", reason: "cleanup.remove.merged" },
      { kind: "remote-branch", ref: "origin/iteration/iter-done", verdict: "remove", reason: "cleanup.remove.merged" },
      { kind: "remote-branch", ref: "origin/iteration/iter-unmerged", verdict: "refuse", reason: "cleanup.refuse.unmerged" },
      { kind: "remote-branch", ref: "origin/iteration/iter-ancestor-only", verdict: "remove", reason: "cleanup.remove.merged" },
      { kind: "remote-branch", ref: "origin/iteration/iter-no-ancestor", verdict: "refuse", reason: "cleanup.refuse.unmerged" },
      { kind: "remote-branch", ref: "origin/iteration/iter-squashed", verdict: "remove", reason: "cleanup.remove.merged" },
      { kind: "remote-branch", ref: "origin/iteration/iter-moved", verdict: "refuse", reason: "cleanup.refuse.unmerged" },
      { kind: "remote-branch", ref: "origin/iteration/iter-no-evidence", verdict: "refuse", reason: "cleanup.refuse.unmerged" },
    ]);
  });

  test("emits one decision per target in input order and never mutates facts", () => {
    const facts: CleanupFacts = {
      ...lane1Facts([worktree(MAIN_WT, "main", { isMain: true }), worktree("/repo/.worktrees/plan-1", "feature/plan-1")]),
      targets: [
        target({ kind: "worktree", ref: "/repo/.worktrees/plan-1", branch: "feature/plan-1", owner: { workflowId: "iter-parent", planId: "plan-1" } }),
        target({ kind: "local-branch", ref: "feature/plan-1", branch: "feature/plan-1", owner: { workflowId: "iter-parent", planId: "plan-1" } }),
        target({ kind: "worktree", ref: MAIN_WT, branch: "main", owner: null }),
        target({ kind: "local-branch", ref: "feature/orphan", branch: "feature/orphan", owner: null }),
      ],
    };
    const before = JSON.stringify(facts);
    const decisions = planWorktreeCleanup(iterParent, facts);
    expect(decisions.map((d) => `${d.kind}:${d.ref}:${d.verdict}:${d.reason}`)).toEqual([
      `worktree:/repo/.worktrees/plan-1:remove:cleanup.remove.merged`,
      `local-branch:feature/plan-1:refuse:cleanup.refuse.checked-out`,
      `worktree:/repo:keep:cleanup.keep.main-worktree`,
      `local-branch:feature/orphan:refuse:cleanup.refuse.foreign-branch`,
    ]);
    expect(JSON.stringify(facts)).toBe(before);
  });
});
