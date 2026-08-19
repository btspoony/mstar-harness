# Lease claim protocol (full prose, archived)

> Engine-absent fallback: the full lease protocol prose displaced from `mstar-iteration` / `mstar-plan-artifacts` when engine validators (`validateExecutionLease` / `validateIntegrationMergeLease` / CLI `mstar lease verify --workflow <id>`) took over the same contract. Engine-present hosts read the runtime skills' engine-check pointers instead.

## When it applies

**Iteration Phase 2 only** (after control-worktree entry, or primary checkout when `Worktree mode: waived`). Defaults are **hard** unless the current turn explicitly waives via Assignment `Worktree mode: waived` (or equivalent user instruction). `Plan parallelism: serial` is **not** a waiver — it only forces serial cross-plan **implement** scheduling while control worktree + leases remain required. Phase 1 Review & Edit may stay on the primary checkout; the control-worktree gate starts at **Phase 2 entry**. **`Worktree mode: waived` does not waive the cross-plan parallel safety gate**.

## Coordination SSOT and lock discipline

Lease mutations happen on the **control copy** of the coordination file (v1: `{HARNESS_DIR}/status.json`; v2: `{WORKFLOW_DIR}/<id>/snapshot.json`). This is cooperative, not a distributed lock service — non-cooperating processes are out of scope.

**Same-host exclusive write lock** — all control-path lease mutations (claim, release, transfer, plan-status transitions that touch leases, merge-lease claim/release) MUST run inside a same-host exclusive write lock for the full **read-check-replace-verify** sequence. Hold from first read through post-write verify; release on all exit paths.

- Preferred (same machine, shared filesystem): advisory lock via `flock` (or equivalent) on `{HARNESS_DIR}/.status-write.lock`.
- Alternative when `flock` unavailable: atomic `mkdir` on `{HARNESS_DIR}/.status-write.lockdir/` — success acquires; existing dir → **Blocked** (another writer holds the lock); remove the directory only after successful verify or explicit rollback.
- Engine writers handle this automatically (`writeWorkflowSnapshot` / `registerWorkflow` acquire `<status-file dir>/.status-write.lockdir/` next to the file). Do **not** invent a distributed CAS CLI.

```bash
CONTROL_ROOT="<metadata.control_worktree_path>"
HARNESS=".mstar"   # or resolved {HARNESS_DIR}
STATUS="$CONTROL_ROOT/$HARNESS/status.json"
LOCK="$CONTROL_ROOT/$HARNESS/.status-write.lock"
(
  flock -x 9 || exit 1
  # read → mutate → temp file + atomic replace → re-read verify
) 9>"$LOCK"
```

**Pre-dispatch re-verify:** immediately before **any** writable implement dispatch, re-read the coordination file and confirm this session still passes verify-held-lease (`holder`, `worktree_path`, `working_branch` match Assignment). Mismatch or absent lease ⇒ **STOP** — do not dispatch.

## Claim-before-`InProgress` (execution lease)

A Phase 2 session **MUST** claim before moving a plan from `Todo`/`Blocked` to `InProgress` and before any writable dispatch for that plan:

1. Re-read the coordination copy; locate exactly one plan row (`id` read compatibility).
2. **Resume (not steal):** if `execution_lease` exists and `holder` **equals this session** → verify-held: confirm `worktree_path` and `working_branch` match the Assignment; continue (not Blocked, not a new claim).
3. **Blocked:** if `execution_lease` exists and `holder` **differs** → stop. No timestamp, TTL, or inactivity makes it stealable.
4. **Orphan:** if `status` is `InProgress` but `execution_lease` is absent → **STOP** (see Orphan recovery). Do not writable-dispatch or invent a lease.
5. Create or verify the dedicated feature worktree and branch (`worktree_path` ≠ `control_worktree_path`).
6. Acquire the same-host write lock (above); re-read the coordination file; if row/status/lease changed, restart from step 1.
7. In **one complete-file update** (under lock), set `status: "InProgress"` and write the full `execution_lease` object. Use a temp file in the same directory + atomic replace; never expose partial JSON.
8. Re-read the stored row; verify `holder`, `worktree_path`, `working_branch` exactly match the attempted claim. Writable dispatch is forbidden until verification succeeds.

V1: **manual release only** — omit `expires_at`; readers **MUST NOT** treat unknown/draft `expires_at` as authority to steal or release.

## Hold, release, and override

- Lease remains active across `InProgress` and `InReview` (including review fix rounds) unless deliberately released or transferred.
- **Release:** re-read coordination file; stored `holder` must match this session (mismatch ⇒ **Blocked**, not permission to delete). Delete `execution_lease` in the same complete-file update — never `null`.
- Voluntary abandonment: may set `status: "Blocked"` and delete the lease in one update.
- **Done authority** deletes `execution_lease` in the **same** complete-file update as `status: "Done"` — **only after** successful integration merge when the lease gate is not waived. After QC/QA pass the plan stays **`InReview`** with lease retained until merge succeeds.
- Temporary blockage may retain the lease when the same holder remains responsible and the plan record explains the next action.
- **Override (only exception to no-steal):** explicit **user instruction in the current turn** may remove or replace another holder's lease. Append an audit note (prior holder, new holder/release, user authorized) to `plans[].notes` / `notes.jsonl`. Agents **MUST NOT** infer override from age, inactivity, `Blocked` status, or a failed session.
- Cooperative handoff: current holder explicitly agrees; receiving worktree/branch verified; one complete-file update — otherwise old holder releases and new holder follows normal claim.

## Integration merge protocol

Feature implementation may run in parallel across plan IDs **only when** the cross-plan parallel hard gate is satisfied (same-host lock on the coordination file, default `Plan parallelism: serial`, or current-turn `Cross-host lease race: accepted` + audit — **not** by `Worktree mode: waived` alone); when the lease gate is active, each plan also needs a verified `execution_lease` and distinct feature worktree. Mutations of `spec_integration_branch` are **serial**. Plan status after QC/QA is `InReview` with `execution_lease` retained until merge succeeds (when lease gate active); `Done` + lease deletion happen **after** the integration merge commit is recorded.

1. From `control_worktree_path`: clean working tree; checked-out branch = resolved `spec_integration_branch`.
2. Re-read the coordination file under the same-process write lock. If `integration_merge_lease` exists:
   - **Resume (not steal):** `holder` equals this session → verify `plan_id`, `source_branch`, `target_branch` match the intended merge; confirm control worktree state; continue (not Blocked).
   - **Blocked:** `holder` differs → stop. No timestamp, TTL, or inactivity makes it stealable.
3. If unclaimed, claim the merge lease with the same read-check-replace-verify discipline as execution claims. `source_branch`/`plan_id` must match the feature; `target_branch` must match `spec_integration_branch`.
4. Only the stored merge-lease holder runs integration from `control_worktree_path`.
5. On success: record merge commit/evidence; **delete** `integration_merge_lease`; in the **same** locked update set plan `status: "Done"` and **delete** `execution_lease`.
6. On conflict/failure: retain both leases; plan stays `InReview` — do not set `Done`. Release the merge lease only after the control worktree is clean and in a known state.

Execution and merge leases may coexist; the merge lease does not grant execution ownership for the source plan.

## Orphan recovery (`InProgress` without `execution_lease`)

Runtime skills that detect this state **STOP** and defer recovery — they must not silently add a lease or writable-dispatch. **Immediate gate:** no writable dispatch until recovery completes and a verified `execution_lease` exists (or the plan returns to a non-active status). **Resolver:** `@project-manager` (or explicit human/PM ownership resolution after race or corruption).

| Path | When | Actions |
| ---- | ---- | ------- |
| **Reset to `Todo`** | Work abandoned, unknown owner, or safe to restart claim | One complete-file update under write lock: `status: "Todo"`; ensure `execution_lease` absent; append audit note (timestamp, reason, actor). |
| **Recover with claim (same holder)** | Legitimate in-progress work; worktree/branch verified on disk; **this session's stable `holder`** matches the prior owner | Unattended recovery permitted only for the **same** stable `holder`. Follow claim from step 5 under write lock; append audit note (orphan recovery, same holder, paths verified). |
| **Recover with claim (different holder)** | New session must take over live work | **Blocked** for unattended recovery. Requires verified quiescence of the prior writer (no live writable work on the feature branch/worktree) **and** explicit cooperative handoff from the prior holder, **or** current-turn user override + audit note. Then normal claim under write lock. |
| **Escalate / `Blocked`** | Ambiguous ownership, conflicting worktrees, or partial/corrupt state | Set `status: "Blocked"` with `metadata.blocked_reason`; do not writable-dispatch until human/PM resolves. Restore coherent state from the latest complete version if needed. |

After any recovery path, the next session must pass verify-held before writable dispatch.

## Lease prohibitions (SSOT)

- **MUST NOT** steal or overwrite an active `execution_lease` or `integration_merge_lease` (no TTL, age, or inactivity authority).
- **MUST NOT** writable-dispatch without a verified `execution_lease` for that plan (resume counts only when same `holder` passes verify-held).
- **MUST NOT** write `null` or tombstone objects for lease keys — **delete** the key on release.
- **PM NEVER** steals an active lease without explicit current-turn user override + audit note (full list → `mstar-roles/references/project-manager.md`).
- Writers **MUST preserve** unrelated plan rows, root metadata, and residual data on every lease mutation.
