/**
 * Engine cleanup module — pure worktree/branch cleanup planner.
 *
 * `planWorktreeCleanup` is the ONE planner ( — no `planBranchCleanup`, no
 * injected callback/git probe, no IO/time/env access): immutable facts in,
 * one stable decision per candidate out, in input order, facts never
 * mutated. The CLI alone probes Git/state and applies current decisions;
 * the planner only classifies.
 *
 * Spec sources (behavior contract, verbatim where locked):
 * - Locked interface block, candidate ownership/attribution, decision
 *   precedence, two timing lanes and every `cleanup.*` machine code:
 *   iteration spec worktree-write-model § "Locked interfaces (P3 engine)"
 *   + § "Stable machine codes"; plan 20260912-cleanup-tool-sweep Task 1.
 * - Reuses the P1 canonical snapshot shape (`WorkflowSnapshot`) and the P2
 *   terminal predicate (`isTerminalSnapshot`); snapshot/terminal semantics
 *   are never re-derived here.
 *
 * Locked decision precedence (first match wins):
 *   1. main-worktree keep            → cleanup.keep.main-worktree
 *   2. default/base-ref keep         → cleanup.keep.protected-ref
 *   3. active execution/merge lease  → cleanup.refuse.active-lease
 *   4. missing/foreign ownership     → cleanup.refuse.foreign-worktree /
 *                                      cleanup.refuse.foreign-branch
 *   5. non-terminal integration or non-Done plan
 *                                    → cleanup.refuse.non-terminal
 *   6. branch checked out anywhere   → cleanup.refuse.checked-out
 *   7. unmerged/missing evidence     → cleanup.refuse.unmerged
 *   8. dirty/locked worktree         → cleanup.refuse.dirty-worktree /
 *                                      cleanup.refuse.locked-worktree
 *   9. eligible                      → cleanup.remove.merged
 *
 * Guard scoping locked by the spec: the checked-out guard applies to branch
 * deletion (local and remote candidates), never to removal of the eligible
 * owned worktree (otherwise physical cleanup could never remove a normal
 * attached worktree — dry-run correctly prints worktree `remove` plus its
 * branch `refuse` until the post-removal re-plan). Merged evidence is a
 * branch-deletion precondition; removing a clean owned worktree loses no
 * commits, so worktree decisions are gated by ownership/eligibility and
 * cleanliness/lock only. Non-terminal integration branches/worktrees and
 * non-Done plan/track branches stay protected across ALL supplied
 * lifecycles, not only the selected one; a main worktree is never removed
 * and its branch candidate is independently protected by the ordinary
 * rules.
 */
import { isTerminalSnapshot, type WorkflowSnapshot } from "./workflow.js";

export type CleanupTargetKind = "worktree" | "local-branch" | "remote-branch";
export type CleanupTarget = {
  kind: CleanupTargetKind;
  ref: string;
  branch: string;
  tip: string;
  owner: { workflowId: string; planId?: string } | null;
};
export type CleanupDecision = {
  kind: CleanupTargetKind;
  ref: string;
  verdict: "remove" | "keep" | "refuse";
  reason: string;
};
export type CleanupFacts = {
  targets: readonly CleanupTarget[];
  worktrees: readonly {
    path: string;
    branch: string | null;
    isMain: boolean;
    clean: boolean;
    locked: boolean;
  }[];
  snapshots: readonly WorkflowSnapshot[];
  defaultBranch: string;
  mergedLocalBranches: Readonly<Record<string, readonly string[]>>;
  remoteEvidence: readonly {
    branch: string;
    tip: string;
    base: string;
    ancestor: boolean;
    prMerged: boolean | null;
  }[];
};

/** Stable machine codes ( — § "Stable machine codes"; never renamed ad hoc). */
const REASON = {
  keepMainWorktree: "cleanup.keep.main-worktree",
  keepProtectedRef: "cleanup.keep.protected-ref",
  refuseActiveLease: "cleanup.refuse.active-lease",
  refuseForeignWorktree: "cleanup.refuse.foreign-worktree",
  refuseForeignBranch: "cleanup.refuse.foreign-branch",
  refuseNonTerminal: "cleanup.refuse.non-terminal",
  refuseCheckedOut: "cleanup.refuse.checked-out",
  refuseUnmerged: "cleanup.refuse.unmerged",
  refuseDirtyWorktree: "cleanup.refuse.dirty-worktree",
  refuseLockedWorktree: "cleanup.refuse.locked-worktree",
  removeMerged: "cleanup.remove.merged",
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plan rows match their id the same way the SDD lookup does (`id` or `plan_id`). */
function rowMatchesPlanId(row: unknown, planId: string): row is Record<string, unknown> {
  return isPlainObject(row) && (row.id === planId || row.plan_id === planId);
}

/**
 * The safety-check universe: every supplied lifecycle plus the selected one
 * ( — `facts.snapshots` includes the selected snapshot; keep that promise
 * even against a malformed caller).
 */
function safetySnapshots(snapshot: WorkflowSnapshot, facts: CleanupFacts): readonly WorkflowSnapshot[] {
  return facts.snapshots.some((doc) => doc.id === snapshot.id) ? facts.snapshots : [...facts.snapshots, snapshot];
}

/** Resolve the attributed owner's lifecycle snapshot; `undefined` = unresolvable. */
function ownerSnapshot(
  snapshots: readonly WorkflowSnapshot[],
  snapshot: WorkflowSnapshot,
  owner: NonNullable<CleanupTarget["owner"]>,
): WorkflowSnapshot | undefined {
  return snapshots.find((doc) => doc.id === owner.workflowId) ?? (owner.workflowId === snapshot.id ? snapshot : undefined);
}

/**
 * Rule 3 — any active execution/integration lease referencing the target,
 * by path and by branch, across all supplied snapshots. Presence is active:
 * writers delete the key on release and terminal snapshots cannot validly
 * carry leases, so any lease shape found is fail-closed.
 */
function leaseRefusesTarget(snapshots: readonly WorkflowSnapshot[], target: CleanupTarget): boolean {
  for (const doc of snapshots) {
    const merge = doc.integration_merge_lease;
    if (merge && (merge.source_branch === target.branch || merge.target_branch === target.branch)) return true;
    if (!Array.isArray(doc.plans)) continue;
    for (const row of doc.plans) {
      if (!isPlainObject(row)) continue;
      const lease = row.execution_lease;
      if (isPlainObject(lease) && (lease.worktree_path === target.ref || lease.working_branch === target.branch)) return true;
    }
  }
  return false;
}

/** Rule 2 — default branch or any explicit `branch.base` across all snapshots. */
function protectedRefReason(snapshots: readonly WorkflowSnapshot[], facts: CleanupFacts, target: CleanupTarget): string | null {
  if (target.branch === facts.defaultBranch) return REASON.keepProtectedRef;
  for (const doc of snapshots) {
    if (doc.branch?.base === target.branch) return REASON.keepProtectedRef;
  }
  return null;
}

/**
 * Rule 5 — non-terminal protection, across ALL supplied lifecycles.
 * Independent of attribution: the integration branch/worktree of any
 * non-terminal lifecycle refuses, as does any branch recorded by a non-Done
 * row (lease `working_branch`, retained `metadata.working_branch` /
 * `metadata.track_branches`). Attribution then decides the positive lane:
 * lifecycle-owned targets need valid terminal close; iteration plan/track
 * rows need only row `Done` while the parent still runs (lock decision 4);
 * a standalone plan is the whole lifecycle, so terminal close is required
 * first ( — lane 1 wording). An unresolvable owner lifecycle or a missing
 * owner row refuses — probe failure/malformed state never substitutes an
 * empty-safe verdict.
 */
function nonTerminalRefuses(
  snapshots: readonly WorkflowSnapshot[],
  target: CleanupTarget,
  ownerDoc: WorkflowSnapshot | undefined,
): boolean {
  for (const doc of snapshots) {
    if (isTerminalSnapshot(doc)) continue;
    if (doc.branch?.integration !== undefined && doc.branch.integration === target.branch) return true;
    if (doc.integration_worktree_path !== undefined && doc.integration_worktree_path === target.ref) return true;
  }
  for (const doc of snapshots) {
    if (!Array.isArray(doc.plans)) continue;
    for (const row of doc.plans) {
      if (!isPlainObject(row) || row.status === "Done") continue;
      const lease = row.execution_lease;
      if (isPlainObject(lease) && lease.working_branch === target.branch) return true;
      const meta = row.metadata;
      if (isPlainObject(meta)) {
        if (meta.working_branch === target.branch) return true;
        if (Array.isArray(meta.track_branches) && meta.track_branches.includes(target.branch)) return true;
      }
    }
  }
  if (ownerDoc === undefined) return true;
  if (target.owner?.planId !== undefined) {
    const planId = target.owner.planId;
    let row: Record<string, unknown> | undefined;
    for (const candidate of ownerDoc.plans) {
      if (rowMatchesPlanId(candidate, planId)) {
        row = candidate;
        break;
      }
    }
    if (!row || row.status !== "Done") return true;
    if (ownerDoc.type === "plan") return !isTerminalSnapshot(ownerDoc);
    return false;
  }
  return !isTerminalSnapshot(ownerDoc);
}

/**
 * Correct merged-evidence base for the candidate's owner
 * ( — plan/track → `branch.integration`; standalone plan/integration →
 * `branch.target`). `null` = no base anchor recorded; evidence cannot be
 * evaluated and the candidate refuses.
 */
function mergedEvidenceBase(ownerDoc: WorkflowSnapshot, owner: NonNullable<CleanupTarget["owner"]>): string | null {
  if (owner.planId !== undefined && ownerDoc.type === "iteration") return ownerDoc.branch?.integration ?? null;
  return ownerDoc.branch?.target ?? null;
}

/**
 * Rule 7 — matching merged evidence for branch candidates.
 * Local: exact `git branch --merged <base>` membership, no squash-merge
 * inference (a squash-only local branch retains). Remote: the evidence must
 * bind the same branch incarnation `{branch, tip, base}` — an old merged PR
 * or stale ancestry for a moved ref matches nothing and refuses;
 * `prMerged: false` refuses even with ancestry, `null` (no PR record)
 * permits the verified ancestor-only historical-residue route.
 */
function mergedEvidenceRefuses(
  facts: CleanupFacts,
  ownerDoc: WorkflowSnapshot,
  owner: NonNullable<CleanupTarget["owner"]>,
  target: CleanupTarget,
): boolean {
  const base = mergedEvidenceBase(ownerDoc, owner);
  if (base === null || base === "") return true;
  if (target.kind === "local-branch") {
    const merged = facts.mergedLocalBranches[base];
    return !Array.isArray(merged) || !merged.includes(target.ref);
  }
  if (target.kind === "remote-branch") {
    const evidence = facts.remoteEvidence.find(
      (entry) => entry.branch === target.branch && entry.tip === target.tip && entry.base === base,
    );
    if (!evidence) return true;
    if (evidence.prMerged === false) return true;
    if (evidence.prMerged === true) return false;
    return !evidence.ancestor;
  }
  return false; // worktree removal is not gated by merged evidence ( — see module header)
}

/**
 * Pure cleanup planner ( — locked interface). Consumes immutable facts,
 * returns exactly one decision per candidate in input order, never mutates
 * its inputs and never touches Git, the filesystem, the clock or the
 * environment.
 */
export function planWorktreeCleanup(snapshot: WorkflowSnapshot, facts: CleanupFacts): CleanupDecision[] {
  const snapshots = safetySnapshots(snapshot, facts);
  return facts.targets.map((target): CleanupDecision => {
    const decide = (verdict: CleanupDecision["verdict"], reason: string): CleanupDecision => ({
      kind: target.kind,
      ref: target.ref,
      verdict,
      reason,
    });
    // 1. main-worktree keep — a main worktree is never removed.
    if (target.kind === "worktree" && facts.worktrees.some((wt) => wt.path === target.ref && wt.isMain)) {
      return decide("keep", REASON.keepMainWorktree);
    }
    // 2. default/base-ref keep — protected regardless of lifecycle state.
    const protectedReason = protectedRefReason(snapshots, facts, target);
    if (protectedReason !== null) return decide("keep", protectedReason);
    // 3. any active execution/merge lease, by path and branch, all snapshots.
    if (leaseRefusesTarget(snapshots, target)) return decide("refuse", REASON.refuseActiveLease);
    // 4. missing/foreign ownership — `owner` is the CLI's verified
    // attribution; unknown/ambiguous is `null`, never inferred.
    if (target.owner === null) {
      return decide("refuse", target.kind === "worktree" ? REASON.refuseForeignWorktree : REASON.refuseForeignBranch);
    }
    // Past this point `target.owner` is non-null; resolve its lifecycle once.
    const ownerDoc = ownerSnapshot(snapshots, snapshot, target.owner);
    // 5. non-terminal integration or non-Done plan, across all lifecycles.
    if (nonTerminalRefuses(snapshots, target, ownerDoc)) return decide("refuse", REASON.refuseNonTerminal);
    // 6. branch checked out anywhere — branch deletion only; the eligible
    // owned attached worktree is removed first, then the branch re-plans.
    if (target.kind !== "worktree" && facts.worktrees.some((wt) => wt.branch !== null && wt.branch === target.branch)) {
      return decide("refuse", REASON.refuseCheckedOut);
    }
    // 7. unmerged/missing merge evidence — branch candidates only.
    // (Unreachable with an unresolvable owner: rule 5 already refused.)
    if (target.kind !== "worktree" && ownerDoc !== undefined && mergedEvidenceRefuses(facts, ownerDoc, target.owner, target)) {
      return decide("refuse", REASON.refuseUnmerged);
    }
    // 8. dirty/locked worktree — a missing probe record fails closed
    // (cleanliness unprovable), never an empty-safe removal.
    if (target.kind === "worktree") {
      const record = facts.worktrees.find((wt) => wt.path === target.ref);
      if (!record || !record.clean) return decide("refuse", REASON.refuseDirtyWorktree);
      if (record.locked) return decide("refuse", REASON.refuseLockedWorktree);
    }
    // 9. owned, eligible, protected-state checks passed.
    return decide("remove", REASON.removeMerged);
  });
}
