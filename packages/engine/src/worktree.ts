/**
 * Engine worktree module — L1/L2 pre-dispatch checklists, control-vs-feature
 * path gate, git branch alignment probe, QC/QA field alignment.
 *
 * Spec sources (semantic SSOT — the skills stay authoritative; this module
 * implements their deterministic rules without forking semantics):
 * - L1/L2 layer split + stacking — control worktree + per-plan feature
 *   worktrees + `plans[].execution_lease` (L1); within-plan parallel writable
 *   tracks need their own distinct worktrees and L1 does not replace L2:
 *   `mstar-branch-worktree` SKILL.md § "Worktree isolation layers (L1 vs L2)"
 *   § "Stacking rules".
 * - Control vs feature worktree roles — `execution_lease.worktree_path` MUST
 *   differ from `metadata.control_worktree_path`; the feature worktree is the
 *   required cwd for product edits (control checkout is Forbidden for
 *   writable edits); never bootstrap a second plans/status/SDD tree under the
 *   feature checkout (harness SSOT resolves from the control worktree):
 *   SKILL.md § "Control worktree vs feature worktree (iteration / L1)" +
 *   § "Harness path SSOT under default gitignore (L1)" § "Hard rules".
 * - L2 pre-dispatch checklist — per-track worktree dirs exist, `worktreePath`
 *   values are absolute and distinct (one Worktree per track; N parallel
 *   invokes ≠ isolation) and `git -C <path> branch --show-current` matches
 *   the Assignment Working branch before the first concurrent writable
 *   dispatch; emit zero until ready:
 *   `mstar-branch-worktree` `references/parallel-writable-pre-dispatch.md`
 *   § "Pre-dispatch checklist (HARD)".
 * - QC/QA alignment — `plan_id` + `Review range`/`Diff basis` byte-identical
 *   (逐字相同) across the QC tri + QA assignments; single review snapshot
 *   precondition (all reviewable commits on ONE Working branch HEAD before
 *   QC tri + QA):
 *   SKILL.md § "QC / QA 检出对齐与多 worktree 门禁衔接" § 对齐字段契约 +
 *   § "单一待审 Git 快照（派 QC 前置条件）".
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GateResult, ValidationResult, Severity } from "./core.js";

/** One L2 parallel implement track (mstar-branch-worktree L2 table). */
export type WorktreeTrack = {
  /** Absolute worktree checkout path for the track. */
  worktreePath: string;
  /** PM-approved Working branch checked out in that worktree. */
  workingBranch: string;
};

/**
 * L1 pre-dispatch checklist input — mirrors the status.json L1 fields
 * (`metadata.control_worktree_path` + `plans[].execution_lease`).
 */
export type L1PreDispatchInput = {
  /** `metadata.control_worktree_path` — harness coordination SSOT checkout. */
  controlWorktreePath: string;
  /** `execution_lease.worktree_path` — the plan's feature worktree. */
  leaseWorktreePath: string;
  /** `execution_lease.working_branch` — the plan's Working branch. */
  leaseWorkingBranch: string;
  /** Plan id (`status.json.plans[].id` / `{SDD_DIR}` segment) — message context. */
  planId: string;
};

/** L2 pre-dispatch checklist input — the plan's parallel writable tracks. */
export type L2PreDispatchInput = {
  tracks: readonly WorktreeTrack[];
};

/** Git branch probe options — keep checks pure by precomputing probe inputs. */
export type BranchProbeOptions = {
  /** git executable to invoke (default `git`). */
  gitPath?: string;
  /**
   * Precomputed branch lookup keyed by absolute worktree path; return
   * `undefined` to fall back to a real `git -C <path> branch --show-current`
   * probe. Lets callers (tests, host hooks) inject probe inputs without a
   * subprocess.
   */
  branchOf?: (worktreePath: string) => string | undefined;
};

/**
 * QC/QA alignment fields — `plan_id` + `Review range`/`Diff basis` must be
 * byte-identical across the QC tri + QA assignments (逐字相同).
 */
export type QcAlignmentAssignment = {
  planId: string;
  reviewRange: string;
  diffBasis: string;
};

/** `singleReviewSnapshot` input — alignment fields plus a precomputed review HEAD. */
export type QcSnapshotAssignment = QcAlignmentAssignment & {
  /** Precomputed review HEAD (full SHA preferred) for that assignment. */
  head?: string;
};

type BranchProbe = { branch: string } | { error: string };

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

function gate(violations: ValidationResult[]): GateResult {
  return { ok: violations.length === 0, violations };
}

/**
 * Probe the checked-out branch of a worktree via
 * `git -C <path> branch --show-current` (parallel-writable-pre-dispatch
 * checklist step 4). `opts.branchOf` precomputes the answer and skips the
 * subprocess entirely (purity); the probe fails closed — a non-repo path or
 * a detached HEAD (empty stdout) is an error, never a branch match.
 */
function probeBranch(worktreePath: string, opts: BranchProbeOptions): BranchProbe {
  const precomputed = opts.branchOf?.(worktreePath);
  if (precomputed !== undefined) return { branch: precomputed };
  try {
    const stdout = execFileSync(opts.gitPath ?? "git", ["-C", worktreePath, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const branch = stdout.trim();
    if (branch === "") return { error: `no branch checked out (detached HEAD?) at "${worktreePath}"` };
    return { branch };
  } catch (err) {
    const e = err as { message?: string; stderr?: string | Buffer; status?: number };
    const detail = (e.stderr !== undefined ? e.stderr.toString().trim() : "") || e.message || "git probe failed";
    return { error: detail };
  }
}

/**
 * L1 cross-plan pre-dispatch checklist (mstar-branch-worktree L1 table +
 * Harness path SSOT hard rules): control path recorded, feature worktree
 * exists, lease worktree ≠ control path, and the branch checked out at the
 * feature worktree matches `execution_lease.working_branch`.
 */
export function l1PreDispatchCheck(input: L1PreDispatchInput, opts: BranchProbeOptions = {}): GateResult {
  const violations: ValidationResult[] = [];
  const { controlWorktreePath, leaseWorktreePath, leaseWorkingBranch, planId } = input;

  if (controlWorktreePath.trim() === "") {
    violations.push(
      violation(
        "high",
        "worktree.l1.control-missing",
        "metadata.control_worktree_path is not recorded — the L1 control worktree (integration-branch checkout) must be recorded in status.json before writable dispatch",
        "record the control worktree path in status.json metadata.control_worktree_path",
      ),
    );
  }
  if (leaseWorktreePath.trim() === "") {
    violations.push(
      violation(
        "high",
        "worktree.l1.lease-missing",
        `execution_lease.worktree_path is empty for plan "${planId}" — no verified execution_lease to dispatch against`,
        "claim the execution_lease with an absolute feature worktree path before dispatch",
      ),
    );
  }
  if (leaseWorkingBranch.trim() === "") {
    violations.push(
      violation(
        "high",
        "worktree.l1.lease-branch-missing",
        `execution_lease.working_branch is empty for plan "${planId}"`,
        "record the lease working_branch before dispatch",
      ),
    );
  }
  if (controlWorktreePath !== "" && controlWorktreePath === leaseWorktreePath) {
    violations.push(
      violation(
        "critical",
        "worktree.l1.lease-equals-control",
        `execution_lease.worktree_path "${leaseWorktreePath}" equals metadata.control_worktree_path — the feature worktree MUST differ from the control worktree (L1 isolation; product edits never land in the control checkout)`,
        "use a distinct feature worktree for the plan (git worktree add <path> <branch>) and update the lease",
      ),
    );
  }

  if (leaseWorktreePath !== "" && !existsSync(leaseWorktreePath)) {
    violations.push(
      violation(
        "high",
        "worktree.l1.feature-missing",
        `feature worktree directory "${leaseWorktreePath}" does not exist for plan "${planId}"`,
        `create it before dispatch: git worktree add ${leaseWorktreePath} <working-branch>`,
      ),
    );
  } else if (leaseWorktreePath !== "" && leaseWorkingBranch !== "") {
    const probe = probeBranch(leaseWorktreePath, opts);
    if ("error" in probe) {
      violations.push(
        violation(
          "high",
          "worktree.l1.branch-probe-failed",
          `cannot probe branch at "${leaseWorktreePath}" for plan "${planId}": ${probe.error}`,
          "verify the path is a git worktree checkout on the lease working branch (not detached)",
        ),
      );
    } else if (probe.branch !== leaseWorkingBranch) {
      violations.push(
        violation(
          "high",
          "worktree.l1.branch-mismatch",
          `feature worktree "${leaseWorktreePath}" is on branch "${probe.branch}", expected execution_lease.working_branch "${leaseWorkingBranch}" (plan "${planId}")`,
          `checkout ${leaseWorkingBranch} in the feature worktree`,
        ),
      );
    }
  }

  return gate(violations);
}

/**
 * L2 within-plan pre-dispatch checklist (parallel-writable-pre-dispatch.md):
 * every parallel writable track's `worktreePath` must be absolute and
 * distinct (one Worktree per track — N parallel invokes ≠ isolation), the
 * worktree dir must exist, and `git -C <path> branch --show-current` must
 * match its Working branch — before the first concurrent writable dispatch.
 * Fewer than one track is itself a violation (the checklist needs something
 * to verify).
 */
export function l2PreDispatchCheck(input: L2PreDispatchInput, opts: BranchProbeOptions = {}): GateResult {
  const violations: ValidationResult[] = [];
  const tracks = input.tracks ?? [];
  const seenPaths = new Set<string>();

  if (tracks.length < 1) {
    violations.push(
      violation(
        "high",
        "worktree.l2.no-tracks",
        "no parallel writable tracks — the L2 pre-dispatch checklist requires at least one track with an absolute worktreePath and Working branch",
        "pass each track's absolute Worktree path and PM-approved Working branch",
      ),
    );
  }

  tracks.forEach((track, index) => {
    if (track.worktreePath.trim() === "" || track.workingBranch.trim() === "") {
      violations.push(
        violation(
          "high",
          "worktree.l2.track-invalid",
          `track ${index + 1} is missing worktreePath and/or workingBranch`,
          "fill both fields for every track",
        ),
      );
      return;
    }
    if (!isAbsolute(track.worktreePath)) {
      violations.push(
        violation(
          "high",
          "worktree.l2.track-path-relative",
          `track ${index + 1} worktreePath "${track.worktreePath}" is not an absolute path — L2 tracks MUST use absolute worktree checkout paths (consistent with the lease validator's absolute worktree_path enforcement)`,
          `use an absolute path for track ${index + 1} (e.g. /Users/<you>/worktrees/<branch>)`,
        ),
      );
      return;
    }
    if (seenPaths.has(track.worktreePath)) {
      violations.push(
        violation(
          "high",
          "worktree.l2.track-path-collision",
          `duplicate worktreePath "${track.worktreePath}" across parallel tracks — L2 parallel-writable isolation requires a distinct absolute Worktree path per track (N parallel invokes ≠ isolation)`,
          "give every parallel track its own git worktree checkout",
        ),
      );
      return;
    }
    seenPaths.add(track.worktreePath);
    if (!existsSync(track.worktreePath)) {
      violations.push(
        violation(
          "high",
          "worktree.l2.track-missing",
          `track worktree directory "${track.worktreePath}" does not exist`,
          `create it before dispatch: git worktree add ${track.worktreePath} ${track.workingBranch}`,
        ),
      );
      return;
    }
    const probe = probeBranch(track.worktreePath, opts);
    if ("error" in probe) {
      violations.push(
        violation(
          "high",
          "worktree.l2.branch-probe-failed",
          `cannot probe branch at "${track.worktreePath}": ${probe.error}`,
          "verify the path is a git worktree checkout on its Working branch (not detached)",
        ),
      );
    } else if (probe.branch !== track.workingBranch) {
      violations.push(
        violation(
          "high",
          "worktree.l2.branch-mismatch",
          `track worktree "${track.worktreePath}" is on branch "${probe.branch}", expected Working branch "${track.workingBranch}"`,
          `checkout ${track.workingBranch} in that worktree`,
        ),
      );
    }
  });

  return gate(violations);
}

/**
 * L1 hard rule (Harness path SSOT): `execution_lease.worktree_path` MUST
 * differ from `metadata.control_worktree_path`. String equality on the two
 * paths — canonical absolute paths are the caller's contract (the lease
 * validator already requires `worktree_path` to be absolute).
 */
export function assertControlVsFeaturePath(controlWorktreePath: string, featureWorktreePath: string): GateResult {
  const violations: ValidationResult[] = [];
  if (controlWorktreePath === featureWorktreePath) {
    violations.push(
      violation(
        "critical",
        "worktree.control-feature.same",
        `control worktree path equals feature/lease worktree path "${controlWorktreePath}" — execution_lease.worktree_path MUST differ from metadata.control_worktree_path`,
        "use a distinct feature worktree for the plan's product edits",
      ),
    );
  }
  return gate(violations);
}

/**
 * Assert the branch checked out at `worktreePath` matches `expectedBranch`
 * (the Assignment Working branch). Probe = `git -C <path> branch
 * --show-current`; precompute via `opts.branchOf` for purity. Fail-closed on
 * probe errors and detached HEAD.
 */
export function assertBranchAlignment(worktreePath: string, expectedBranch: string, opts: BranchProbeOptions = {}): GateResult {
  const violations: ValidationResult[] = [];
  const probe = probeBranch(worktreePath, opts);
  if ("error" in probe) {
    violations.push(
      violation(
        "high",
        "worktree.branch-probe-failed",
        `cannot probe branch at "${worktreePath}": ${probe.error}`,
        "verify the path is a git worktree checkout on the expected branch (not detached)",
      ),
    );
  } else if (probe.branch !== expectedBranch) {
    violations.push(
      violation(
        "high",
        "worktree.branch-mismatch",
        `worktree "${worktreePath}" is on branch "${probe.branch}", expected "${expectedBranch}" (Assignment Working branch)`,
        `checkout ${expectedBranch} in that worktree`,
      ),
    );
  }
  return gate(violations);
}

const QC_ALIGNMENT_FIELDS: ReadonlyArray<{ key: keyof QcAlignmentAssignment; label: string }> = [
  { key: "planId", label: "plan_id" },
  { key: "reviewRange", label: "Review range" },
  { key: "diffBasis", label: "Diff basis" },
];

/**
 * QC/QA 对齐字段契约: `plan_id` + `Review range`/`Diff basis` must be
 * byte-identical (逐字相同 — no trimming, no normalization) across every
 * assignment in the set, so the QC tri + QA review the same plan/feature and
 * the same diff range. One violation per field that differs.
 */
export function assertQcAlignment(assignments: readonly QcAlignmentAssignment[]): GateResult {
  const violations: ValidationResult[] = [];
  const list = assignments ?? [];

  for (const { key, label } of QC_ALIGNMENT_FIELDS) {
    const distinct = [...new Set(list.map((a) => a[key]))];
    if (distinct.length > 1) {
      violations.push(
        violation(
          "high",
          "qc.alignment.mismatch",
          `QC/QA alignment field "${label}" is not byte-identical across ${list.length} assignments: ${distinct
            .map((v) => `"${v}"`)
            .join(" vs ")}`,
          `copy the same ${label} value verbatim into every QC tri and QA Assignment`,
        ),
      );
    }
  }
  return gate(violations);
}

/**
 * Single review snapshot precondition (派 QC 前置条件): all reviewable
 * commits must sit on ONE Working branch HEAD before the QC tri + QA are
 * dispatched. `head` is precomputed per assignment (full SHA preferred);
 * different heads → violation; a missing head cannot confirm the snapshot →
 * violation (fail-closed).
 */
export function singleReviewSnapshot(assignments: readonly QcSnapshotAssignment[]): GateResult {
  const violations: ValidationResult[] = [];
  const list = assignments ?? [];

  list.forEach((a, index) => {
    if ((a.head ?? "").trim() === "") {
      violations.push(
        violation(
          "high",
          "qc.alignment.snapshot-missing",
          `review head not provided for assignment ${index + 1} (plan_id "${a.planId}") — cannot confirm the single review snapshot precondition`,
          "precompute and pass the review HEAD (full SHA) for every assignment",
        ),
      );
    }
  });

  const distinct = [...new Set(list.map((a) => a.head ?? "").filter((h) => h.trim() !== ""))];
  if (distinct.length > 1) {
    violations.push(
      violation(
        "high",
        "qc.alignment.single-snapshot",
        `assignments cover ${distinct.length} different review heads (${distinct.join(", ")}) — all reviewable commits must sit on ONE Working branch HEAD before QC tri + QA`,
        "merge the parallel tracks to a single Working branch HEAD, then re-derive the heads",
      ),
    );
  }
  return gate(violations);
}
