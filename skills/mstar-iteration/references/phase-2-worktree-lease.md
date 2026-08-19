# Phase 2 control worktree + execution lease

Normative field names and claim/release/merge semantics → runtime SSOT
`mstar-plan-artifacts/references/status-and-residuals.md`. This reference is
the **iteration-command execution checklist**; do not invent alternate lease
field names.

## When it applies

**Iteration commands only** (`iteration-start` ends before this; `iteration-drive`
/ `iteration-loop` Phase 2+). Defaults are **hard** unless the current turn
explicitly waives via Assignment `Worktree mode: waived` (or equivalent user
instruction). `Plan parallelism: serial` is **not** a waiver — it only forces
serial cross-plan **implement** scheduling while control worktree + leases remain
required.

Phase 1 Review & Edit may stay on the primary checkout. The control-worktree gate
starts at **Phase 2 entry**.

**Phase scope**：本参考仅约束 **Phase 2**（含 serial integration merge 与「control 禁止产品编辑 / 每 plan feature worktree」）。**Phase 5** PR merge-ready 修复 **不**沿用该产品编辑隔离——直接在 control / `spec_integration_branch` 上改，**禁止**另开 Phase 5 fix worktree → **`phase-4-5-pr-delivery.md`** §5.0。

## Control worktree (Phase 2 entry)

1. Resolve all active plans' `metadata.spec_integration_branch` to the **same**
   integration branch (STOP if mismatch).
2. Resolve or create the **control worktree** (usually primary checkout or
   PM-designated path) checked out to that `spec_integration_branch`.
3. Verify `git branch --show-current` equals `spec_integration_branch`; working
   tree clean before merge operations.
4. Record canonical absolute repository-root path in
   `metadata.control_worktree_path` (not `{HARNESS_DIR}`; canonicalize symlinks).
5. Resolve coordination paths from that root (default-gitignored process artifacts live on the **control filesystem**, not as Git blobs):
   - status register: `<control_worktree_path>/{HARNESS_DIR}/status.json` (v2 root — active workflow entries)
   - snapshot SSOT: `<control_worktree_path>/{WORKFLOW_DIR}/<id>/snapshot.json` (plan rows + leases + branch anchors)
   - project register: `<control_worktree_path>/{PROJECT_DIR}/<id>/residuals.json`
   - plans SSOT: `<control_worktree_path>/{PLAN_DIR}/` (or `<control>/{HARNESS_DIR}/plans/`)
   - iterations SSOT: `<control_worktree_path>/{ITERATION_DIR}/`
   - SDD tree: `<control_worktree_path>/{HARNESS_DIR}/sdd/<plan-id>/`

All sessions MUST reread the **control copy** of the workflow snapshot immediately before
claim, release, transfer, plan-status transition, or merge-lease mutation.

**Do not** set `Worktree mode: waived` because a feature worktree lacks
`plans/` under default gitignore — keep feature worktrees and pass absolute
control **`Plan Path`** / **`SDD dir`** in Assignments
(`mstar-branch-worktree` 「Harness path SSOT under default gitignore」).

### Same-host exclusive write lock

All control-path lease mutations (claim, release, transfer, merge-lease
claim/release) **MUST** run inside a same-host exclusive write lock for the full
read-check-replace-verify sequence. Engine writers acquire the lock
automatically (`writeWorkflowSnapshot` / `registerWorkflow` use
`<status-file dir>/.status-write.lockdir/` — for snapshots the lockdir lands
inside `workflows/<id>/`); for manual edits prefer the engine-check commands
(`mstar lease verify --workflow <id>`, `mstar worktree check`) over hand-rolled
`flock`. The atomic-mkdir alternative (`.status-write.lockdir/` in the same
directory as the file) remains the documented fallback. Do **not** invent a
distributed CAS CLI.

**Cross-plan parallel hard gate:** Applies **whether or not** `Worktree mode: waived`.
Lease-gated **cross-plan parallel** writable implement is allowed **only when**
this same-host lock is **available on the coordination snapshot path and
used for every coordination mutation** in that Phase 2 session (control path
when lease gate active; primary checkout `{HARNESS_DIR}/status.json` + snapshot
when waived). Agents on **different hosts** or with **no shared flock/lockdir** →
default **`Plan parallelism: serial`** (preferred when waived). **No flock
does not waive** control worktree / feature worktree / leases — serial
scheduling only. Assignment still
claiming cross-plan parallel without lock availability → **Blocked** until PM
sets serial scheduling or the user gives current-turn override
`Cross-host lease race: accepted` (or equivalent) + audit on snapshot plan
`notes` / `notes.jsonl`.
**`Worktree mode: waived` alone is not** this override.

Immediately before **any** writable implement dispatch, re-read the control
snapshot and re-verify `execution_lease` holder + paths match this session;
mismatch → **STOP**.

## Feature worktree (per plan)

- Each concurrently active plan uses a **distinct** absolute feature-worktree
  path and dedicated feature branch from `spec_integration_branch`.
- `execution_lease.worktree_path` MUST differ from
  `control_worktree_path` (never reuse the control checkout for product
  edits).
- `Worktree path` MUST appear in the writable Assignment and in the snapshot
  plan row's `execution_lease.worktree_path` before first writable implement dispatch.
- Product/source edits run from the feature worktree; plans, iterations,
  status, and SDD coordination reads/writes run through **absolute control
  paths** (never relative `.mstar/...` from the feature cwd when L1 is active).
- Assignment MUST include absolute feature **`Worktree path`** and absolute
  control **`Plan Path`** / **`SDD dir`** before writable implement dispatch.
- Default **L1**: one writable track per plan. Within-plan multi-writable tracks
  still follow L2 `parallel-writable-pre-dispatch` (`mstar-branch-worktree`).

## Execution lease (`plans[].execution_lease` in the workflow snapshot)

Required shape (v1): `holder`, `claimed_at` (RFC 3339 UTC with `Z`),
`worktree_path`, `working_branch`; optional `session_label` (display only).
Lives on the snapshot plan row — `{WORKFLOW_DIR}/<id>/snapshot.json` → `plans[]`.

### Claim (before `InProgress` or writable dispatch)

1. Read the control snapshot; locate exactly one plan row (`id` read compatibility).
2. If `execution_lease` exists:
   - **Same `holder` as this session** → **resume**: verify `worktree_path` and
     `working_branch` match the Assignment; continue (not steal/block).
   - **Different `holder`** → **Blocked** (no timestamp makes it stealable).
3. Create or verify dedicated feature worktree + branch.
4. Re-read the snapshot under write lock; if row/status/lease changed, restart claim.
5. One complete-file update (still under lock): `status: "InProgress"` + full `execution_lease`.
   Use temp file + atomic replace; never expose partial JSON.
6. Re-read and verify `holder`, `worktree_path`, `working_branch` match before
   any writable dispatch.

### Hold, release, override

- Lease stays active across `InProgress` and `InReview` (including post-QC/QA
  ready-to-merge) unless released or transferred.
- Normal release: re-read the control snapshot under write lock; confirm stored `holder` matches
  this session — mismatch → **Blocked**; then **delete** `execution_lease`
  (never `null` or tombstone).
- `Done` authority deletes `execution_lease` in the same update as `status: "Done"`
  — **only after** successful integration merge (when lease gate not waived).
- Override of another holder requires **explicit user instruction this turn** +
  audit note on snapshot plan `notes` / `notes.jsonl` (prior holder, new holder/release, user authorized).
- V1: **manual release only** — no `expires_at`, TTL, or heartbeat authority.

### Orphan `InProgress` without lease

If a plan row is `InProgress` but has **no** `execution_lease` in the snapshot, STOP and
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
     snapshot path (control path when lease gate active; primary checkout
     `{HARNESS_DIR}/status.json` + snapshot when waived) and used for every coordination
     mutation in that session; **and** when lease gate is not waived, each plan
     holds a verified, distinct `execution_lease` and feature worktree.
  2. **`Plan parallelism: serial`** (default when waived; preferred default under
     waiver).
  3. Current-turn `Cross-host lease race: accepted` (or equivalent) + audit
     snapshot plan `notes` / `notes.jsonl`.
  Cross-host / no shared lock without (2) or (3) → **Blocked** if Assignment still
  claims cross-plan parallel writable implement.
- **Integration merge** into `spec_integration_branch` is **serial** (one at a time),
  with or without lease gate.

## Integration merge lease (snapshot top-level `integration_merge_lease`)

Required shape (v1): `holder`, `claimed_at`, `plan_id`, `source_branch`,
`target_branch` (= resolved `spec_integration_branch`); optional `session_label`.
Lives top-level on the snapshot — `{WORKFLOW_DIR}/<id>/snapshot.json`.

1. From control worktree: clean tree; branch = `spec_integration_branch`.
2. Under write lock, re-read the snapshot. If `integration_merge_lease` exists:
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
- Snapshot lease claim/hold/release defaults (`plans[].execution_lease` and top-level `integration_merge_lease`)

It does **not** waive the **cross-plan parallel safety gate**. Under waiver,
cross-plan **parallel writable** implement still requires same-host exclusive
write lock on the coordination snapshot path, default **`Plan parallelism:
serial`**, or current-turn `Cross-host lease race: accepted` + audit
snapshot plan `notes` / `notes.jsonl`. **Prefer serial scheduling when waived**; parallel under waiver
only with the race-accepted override (or same-host lock when mutating shared
state).

`Plan parallelism: serial` does **not** waive control worktree or leases.

Iteration commands MUST NOT infer waiver from missing worktrees or single-session
starts. Explicit override this turn only.
