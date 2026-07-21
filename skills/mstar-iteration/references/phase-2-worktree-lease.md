# Phase 2 control worktree + execution lease

Normative field names and claim/release/merge semantics → maintenance ADR
`.harness/docs/2026-07-22-iteration-worktree-plan-lease.md` (this repo) or
`mstar-plan-artifacts/references/status-and-residuals.md` (runtime SSOT after
plan-artifacts sync). This reference is the **iteration-command execution
checklist**; do not invent alternate lease field names.

## When it applies

**Iteration commands only** (`iteration-start` ends before this; `iteration-drive`
/ `iteration-loop` Phase 2+). Defaults are **hard** unless the current turn
explicitly waives via Assignment `Worktree mode: waived`, `Plan parallelism:
serial`, or equivalent user instruction.

Phase 1 Review & Edit may stay on the primary checkout. The control-worktree gate
starts at **Phase 2 entry**.

## Control worktree (Phase 2 entry)

1. Resolve all active plans' `metadata.spec_integration_branch` to the **same**
   integration branch (STOP if mismatch).
2. Resolve or create the **control worktree** (usually primary checkout or
   PM-designated path) checked out to that `spec_integration_branch`.
3. Verify `git branch --show-current` equals `spec_integration_branch`; working
   tree clean before merge operations.
4. Record canonical absolute repository-root path in
   `metadata.control_worktree_path` (not `{HARNESS_DIR}`; canonicalize symlinks).
5. Resolve coordination paths from that root:
   - status SSOT: `<control_worktree_path>/{HARNESS_DIR}/status.json`
   - SDD tree: `<control_worktree_path>/{HARNESS_DIR}/sdd/<plan-id>/`

All sessions MUST reread the **control copy** of `status.json` immediately before
claim, release, transfer, plan-status transition, or merge-lease mutation.

## Feature worktree (per plan)

- Each concurrently active plan uses a **distinct** absolute feature-worktree
  path and dedicated feature branch from `spec_integration_branch`.
- `Worktree path` MUST appear in the writable Assignment and in
  `plans[].execution_lease.worktree_path` before first writable implement dispatch.
- Product/source edits run from the feature worktree; status and SDD
  coordination reads/writes run through the control path.
- Default **L1**: one writable track per plan. Within-plan multi-writable tracks
  still follow L2 `parallel-writable-pre-dispatch` (`mstar-branch-worktree`).

## Execution lease (`plans[].execution_lease`)

Required shape (v1): `holder`, `claimed_at` (RFC 3339 UTC with `Z`),
`worktree_path`, `working_branch`; optional `session_label` (display only).

### Claim (before `InProgress` or writable dispatch)

1. Read control `status.json`; locate exactly one plan row (`id` or `plan_id`).
2. If `execution_lease` exists:
   - **Same `holder` as this session** → **resume**: verify `worktree_path` and
     `working_branch` match the Assignment; continue (not steal/block).
   - **Different `holder`** → **Blocked** (no timestamp makes it stealable).
3. Create or verify dedicated feature worktree + branch.
4. Re-read `status.json`; if row/status/lease changed, restart claim.
5. One complete-file update: `status: "InProgress"` + full `execution_lease`.
   Use temp file + atomic replace; never expose partial JSON.
6. Re-read and verify `holder`, `worktree_path`, `working_branch` match before
   any writable dispatch.

### Hold, release, override

- Lease stays active across `InProgress` and `InReview` unless released or
  transferred.
- Normal release **deletes** `execution_lease` (never `null` or tombstone).
- `Done` authority deletes lease in the same update.
- Override of another holder requires **explicit user instruction this turn** +
  audit note on plan `notes` (prior holder, new holder/release, user authorized).
- V1: **manual release only** — no `expires_at`, TTL, or heartbeat authority.

### Orphan `InProgress` without lease

If a plan row is `InProgress` but has **no** `execution_lease`, STOP and
escalate — do not invent a lease or writable-dispatch. Recovery semantics →
`mstar-plan-artifacts` (not iteration skill).

## Multi-plan parallelism

- **Feature implementation** MAY proceed in parallel across **different plan IDs**
  when each holds a verified, distinct `execution_lease` and feature worktree.
- **Integration merge** into `spec_integration_branch` is **serial** (one at a time).

## Integration merge lease (`metadata.integration_merge_lease`)

Required shape (v1): `holder`, `claimed_at`, `plan_id`, `source_branch`,
`target_branch` (= resolved `spec_integration_branch`); optional `session_label`.

1. From control worktree: clean tree; branch = `spec_integration_branch`.
2. If `integration_merge_lease` exists → **Blocked** (cannot expire or steal).
3. Claim merge lease (same read-check-replace-verify as execution claim).
4. Only merge-lease holder runs integration from `control_worktree_path`.
5. On success: record evidence per plan/status conventions; delete merge lease.
6. On conflict/failure: retain lease while resolving; release only after control
   worktree is clean and known state.

Execution and merge leases may coexist; merge lease does not grant execution
ownership for the source plan.

## Waiver

Iteration commands MUST NOT infer waiver from missing worktrees or single-session
starts. Explicit override this turn only.
