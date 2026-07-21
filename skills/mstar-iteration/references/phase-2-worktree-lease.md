# Phase 2 control worktree + execution lease

Normative field names and claim/release/merge semantics → maintenance ADR
`.harness/docs/2026-07-22-iteration-worktree-plan-lease.md` (this repo) or
`mstar-plan-artifacts/references/status-and-residuals.md` (runtime SSOT after
plan-artifacts sync). This reference is the **iteration-command execution
checklist**; do not invent alternate lease field names.

## When it applies

**Iteration commands only** (`iteration-start` ends before this; `iteration-drive`
/ `iteration-loop` Phase 2+). Defaults are **hard** unless the current turn
explicitly waives via Assignment `Worktree mode: waived` (or equivalent user
instruction). `Plan parallelism: serial` is **not** a waiver — it only forces
serial cross-plan **implement** scheduling while control worktree + leases remain
required.

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

### Same-host exclusive write lock

All control-path lease mutations (claim, release, transfer, merge-lease
claim/release) **MUST** run inside a same-host exclusive write lock for the full
read-check-replace-verify sequence. Prefer `flock` on
`{HARNESS_DIR}/.status-write.lock`; alternative: atomic `mkdir` on
`{HARNESS_DIR}/.status-write.lockdir/`. Do **not** invent a distributed CAS CLI.

**Cross-plan parallel hard gate:** Applies **whether or not** `Worktree mode: waived`.
Lease-gated **cross-plan parallel** writable implement is allowed **only when**
this same-host lock is **available on the coordination `status.json` path and
used for every status/coordination mutation** in that Phase 2 session (control
path when lease gate active; primary checkout `{HARNESS_DIR}/status.json` when
waived). Agents on **different hosts** or with **no shared flock/lockdir** →
default **`Plan parallelism: serial`** (preferred when waived). Assignment still
claiming cross-plan parallel without lock availability → **Blocked** until PM
sets serial scheduling or the user gives current-turn override
`Cross-host lease race: accepted` (or equivalent) + audit on `plans[].notes`.
**`Worktree mode: waived` alone is not** this override.

Immediately before **any** writable implement dispatch, re-read control
`status.json` and re-verify `execution_lease` holder + paths match this session;
mismatch → **STOP**.

## Feature worktree (per plan)

- Each concurrently active plan uses a **distinct** absolute feature-worktree
  path and dedicated feature branch from `spec_integration_branch`.
- `execution_lease.worktree_path` MUST differ from
  `metadata.control_worktree_path` (never reuse the control checkout for product
  edits).
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
4. Re-read `status.json` under write lock; if row/status/lease changed, restart claim.
5. One complete-file update (still under lock): `status: "InProgress"` + full `execution_lease`.
   Use temp file + atomic replace; never expose partial JSON.
6. Re-read and verify `holder`, `worktree_path`, `working_branch` match before
   any writable dispatch.

### Hold, release, override

- Lease stays active across `InProgress` and `InReview` (including post-QC/QA
  ready-to-merge) unless released or transferred.
- Normal release: re-read control `status.json` under write lock; confirm stored `holder` matches
  this session — mismatch → **Blocked**; then **delete** `execution_lease`
  (never `null` or tombstone).
- `Done` authority deletes `execution_lease` in the same update as `status: "Done"`
  — **only after** successful integration merge (when lease gate not waived).
- Override of another holder requires **explicit user instruction this turn** +
  audit note on plan `notes` (prior holder, new holder/release, user authorized).
- V1: **manual release only** — no `expires_at`, TTL, or heartbeat authority.

### Orphan `InProgress` without lease

If a plan row is `InProgress` but has **no** `execution_lease`, STOP and
escalate — do not invent a lease or writable-dispatch. Unattended "Recover with
claim" is permitted **only** for the **same** stable `holder`; different holder
requires verified quiescence + handoff or current-turn user override + audit.
Recovery semantics → `mstar-plan-artifacts` (not iteration skill).

## Multi-plan parallelism

**Cross-plan parallel safety gate** applies **whether or not** `Worktree mode:
waived` is in effect — waiver does **not** authorize lockless cross-host parallel.

- **Feature implementation** MAY proceed in parallel across **different plan IDs**
  only when **one** of:
  1. Same-host exclusive write lock is available on the coordination
     `status.json` path (control path when lease gate active; primary checkout
     `{HARNESS_DIR}/status.json` when waived) and used for every status/coordination
     mutation in that session; **and** when lease gate is not waived, each plan
     holds a verified, distinct `execution_lease` and feature worktree.
  2. **`Plan parallelism: serial`** (default when waived; preferred default under
     waiver).
  3. Current-turn `Cross-host lease race: accepted` (or equivalent) + audit
     `plans[].notes`.
  Cross-host / no shared lock without (2) or (3) → **Blocked** if Assignment still
  claims cross-plan parallel writable implement.
- **Integration merge** into `spec_integration_branch` is **serial** (one at a time),
  with or without lease gate.

## Integration merge lease (`metadata.integration_merge_lease`)

Required shape (v1): `holder`, `claimed_at`, `plan_id`, `source_branch`,
`target_branch` (= resolved `spec_integration_branch`); optional `session_label`.

1. From control worktree: clean tree; branch = `spec_integration_branch`.
2. Under write lock, reread root `metadata`. If `integration_merge_lease` exists:
   - **Same `holder` as this session** → **resume**: verify `plan_id`,
     `source_branch`, `target_branch` match intended merge; confirm control
     worktree state; continue (not steal/block).
   - **Different `holder`** → **Blocked** (cannot expire or steal).
3. If unclaimed, claim merge lease (same read-check-replace-verify as execution claim).
4. Only merge-lease holder runs integration from `control_worktree_path`.
5. On success: record merge commit/evidence; delete merge lease; set plan
   **`Done`** and delete `execution_lease` in the same locked update.
6. On conflict/failure: retain leases; plan stays **`InReview`** — do not set
   `Done`. Release merge lease only after control worktree is clean and known state.

Execution and merge leases may coexist; merge lease does not grant execution
ownership for the source plan.

## Waiver

Explicit `Worktree mode: waived` (or equivalent user instruction) this turn
waives **only**:

- Control worktree establishment and control-path SSOT routing
- Per-plan feature worktree defaults
- `plans[].execution_lease` and `metadata.integration_merge_lease` claim/hold/release
  defaults

It does **not** waive the **cross-plan parallel safety gate**. Under waiver,
cross-plan **parallel writable** implement still requires same-host exclusive
write lock on the coordination `status.json` path, default **`Plan parallelism:
serial`**, or current-turn `Cross-host lease race: accepted` + audit
`plans[].notes`. **Prefer serial scheduling when waived**; parallel under waiver
only with the race-accepted override (or same-host lock when mutating shared
status).

`Plan parallelism: serial` does **not** waive control worktree or leases.

Iteration commands MUST NOT infer waiver from missing worktrees or single-session
starts. Explicit override this turn only.
