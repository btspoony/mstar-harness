# ADR: Iteration control worktree + plan execution lease

**Status**: Accepted for implementation by plan `20260722-iter-wt-lease`  
**Date**: 2026-07-22  
**plan_id**: `20260722-iter-wt-lease`

Normative terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as
requirements. This ADR fixes the schema and protocol that runtime skills must
implement; it does not itself change those skills.

## Context

Iteration Phase 2 historically ran **one plan at a time** and only required Git
worktrees for **within-plan** multi-writable tracks. Iteration commands now need
to support multiple sessions implementing different plans concurrently without
allowing duplicate plan ownership or concurrent integration merges.

The protocol is cooperative coordination through the control worktree's
`{HARNESS_DIR}/status.json`. It is not a distributed lock service and does not
claim hard exclusion against non-cooperating processes.

## Locked decisions

This ADR implements clarify decisions A1-A6 without reopening them:

1. The control worktree is established at **Phase 2 entry**, not during Phase 1.
2. The control worktree's `status.json` and SDD tree are the shared SSOT.
3. A plan-row `execution_lease` is the claim/hold/release SSOT.
4. Feature work may run in parallel across plans; integration merge is serial.
5. L1 cross-plan isolation and existing L2 within-plan isolation coexist.
6. Iteration commands may waive these defaults only on explicit user instruction
   in the current turn.

## Status schema

The fields below are additive to `status.json` version 1. Writers MUST preserve
unrelated and unknown fields.

### Root metadata

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `metadata.control_worktree_path` | absolute path string | During iteration Phase 2 | Canonical repository worktree used for coordination and integration. It MUST be checked out to the active iteration's `spec_integration_branch`. |
| `metadata.integration_merge_lease` | object | Only while a merge operation is owned | Single global lease authorizing one plan feature branch to be integrated. Absence means unclaimed. Writers MUST delete the key on release rather than write `null`. |

`control_worktree_path` MUST identify the repository root, not `{HARNESS_DIR}`.
Writers SHOULD canonicalize symlinks before recording the path; all sessions
MUST compare canonical absolute paths.

No root `spec_integration_branch` field is introduced. The branch remains the
existing `plans[].metadata.spec_integration_branch` contract (and iteration
compass contract where present). All plans participating in one iteration MUST
resolve to the same integration branch before Phase 2 parallel work starts.

### Plan execution lease

`plans[].execution_lease` is optional when a plan is not owned and required
while a Phase 2 session owns writable execution for that plan.

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `holder` | non-empty string | Yes | Opaque cooperative owner identity. Recommended format: `<host>:<stable-session-id>`, for example `cursor:bc-1234`. It MUST remain stable for the lifetime of the claim and MUST NOT contain credentials. |
| `claimed_at` | RFC 3339 UTC timestamp string | Yes | Time the current holder acquired the lease, written with an explicit `Z` offset. It is audit data, not an expiry clock. |
| `worktree_path` | absolute path string | Yes | Dedicated feature-worktree root for this plan. It MUST differ from `control_worktree_path`. |
| `working_branch` | non-empty string | Yes | Feature branch checked out at `worktree_path`; it MUST agree with the plan/Assignment working-branch contract. |
| `session_label` | string | No | Human-readable display label only. It MUST NOT be used for ownership comparison or authorization. |

Example plan row fragment:

```json
{
  "id": "plan-a",
  "status": "InProgress",
  "execution_lease": {
    "holder": "cursor:bc-1234",
    "claimed_at": "2026-07-22T02:30:00Z",
    "worktree_path": "/repo-worktrees/plan-a",
    "working_branch": "feature/plan-a",
    "session_label": "Plan A implementation"
  },
  "metadata": {
    "spec_integration_branch": "iteration/2026-07",
    "merge_target": "iteration/2026-07"
  }
}
```

### Integration merge lease

`metadata.integration_merge_lease` has this exact v1 shape:

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `holder` | non-empty string | Yes | Opaque owner identity using the same format and comparison rules as an execution lease. |
| `claimed_at` | RFC 3339 UTC timestamp string | Yes | Acquisition time for audit only. |
| `plan_id` | non-empty string | Yes | `plans[].id` or legacy `plans[].plan_id` of the feature being integrated. |
| `source_branch` | non-empty string | Yes | Plan feature branch to integrate. |
| `target_branch` | non-empty string | Yes | The resolved `spec_integration_branch`; no other target is valid under this lease. |
| `session_label` | string | No | Human-readable display label only. |

Example root fragment:

```json
{
  "metadata": {
    "control_worktree_path": "/repo",
    "integration_merge_lease": {
      "holder": "cursor:bc-1234",
      "claimed_at": "2026-07-22T04:00:00Z",
      "plan_id": "plan-a",
      "source_branch": "feature/plan-a",
      "target_branch": "iteration/2026-07",
      "session_label": "Integrate plan A"
    }
  }
}
```

## Path and read rules

At Phase 2 entry:

1. Resolve or create the control worktree and verify its current branch equals
   the iteration's `spec_integration_branch`.
2. Record its canonical absolute repository-root path in
   `metadata.control_worktree_path`.
3. Resolve the coordination files from that root:
   - status SSOT:
     `<control_worktree_path>/{HARNESS_DIR}/status.json`
   - SDD handoff/review tree:
     `<control_worktree_path>/{HARNESS_DIR}/sdd/<plan-id>/`

The repository-maintenance harness root in this repository is `.harness/`;
consumer projects continue to resolve `{HARNESS_DIR}` using the existing
`.mstar/`-first conventions.

Feature worktree rules:

- Each concurrently active plan MUST use a distinct absolute feature-worktree
  path and dedicated feature branch based on the resolved integration branch.
- The absolute `Worktree path` MUST be present in the writable Assignment and
  the execution lease before first writable implementation dispatch.
- Product/source edits and plan-local commands run from the feature worktree.
  Status and SDD coordination reads/writes run through the control path. A
  feature worktree's same-looking `{HARNESS_DIR}` path is not the SSOT.
- Default L1 capacity is one writable track per plan. If one plan uses multiple
  concurrent writable tracks, each track additionally follows existing L2
  `parallel-writable-pre-dispatch` isolation; L1 does not replace L2.

Every session MUST reread the control copy of `status.json` immediately before
claim, release, transfer, plan-status transition, or merge-lease mutation. It
MUST NOT rely on a cached plan row. A writer MUST preserve unrelated plan rows,
root metadata, and residual findings.

## Execution lease protocol

### Claim

A Phase 2 session MUST claim before it moves a plan from `Todo` or `Blocked` to
`InProgress`, and before any writable dispatch for that plan:

1. Read the control copy of `status.json` and locate exactly one matching plan
   row (read compatibility accepts `id` or `plan_id`).
2. If `execution_lease` exists, stop as **Blocked**. No timestamp makes it
   stealable.
3. Create or verify the dedicated feature worktree and branch.
4. Re-read `status.json`. If the row, status, or lease state changed, restart
   the claim.
5. In one complete-file update, set `status: "InProgress"` and write the full
   `execution_lease` object. Write a temporary file in the same directory and
   atomically replace `status.json`; never expose partial JSON.
6. Re-read the stored row and verify that `holder`, `worktree_path`, and
   `working_branch` exactly match the attempted claim. Writable dispatch is
   forbidden until this verification succeeds.

This read-check-replace-verify sequence reduces lost updates but is still
cooperative, not a compare-and-swap guarantee. If two writers race or any
unrelated field is lost, both MUST stop, restore a coherent status file from
the latest complete state, and obtain explicit human/PM ownership resolution
before implementation continues.

### Hold and release

- A lease remains active across `InProgress` and `InReview`, including review
  fix rounds, unless ownership is deliberately released or transferred.
- Normal release deletes `execution_lease`; `null` and tombstone objects are
  invalid writes.
- The holder MAY release on voluntary abandonment. A blocked abandonment MUST
  set `status: "Blocked"` and delete the lease in the same complete-file update.
- The authority that sets `status: "Done"` MUST delete any execution lease in
  the same update. This does not change existing Done ownership rules.
- A temporary blockage MAY retain the lease only when the same holder remains
  responsible and the plan record explains the next action.
- The releasing session MUST re-read and confirm that the stored `holder`
  exactly matches itself. A mismatch is **Blocked**, not permission to delete.

### Handoff and override

A cooperative handoff MAY replace the lease holder in one complete-file update
only when the current holder explicitly agrees and the receiving worktree and
branch have been verified. Otherwise, the old holder releases and the new
holder follows the normal claim protocol.

An active lease MUST NOT be stolen. Only an explicit user override in the
current turn may remove or replace another holder's lease. The override update
MUST append an audit entry to the existing plan `notes` convention containing
the timestamp, prior holder, new holder (or release), and the fact that the
user authorized the override. An agent may not infer override authorization
from age, inactivity, `Blocked` status, or a failed session.

## Expiry policy

Version 1 uses **manual release only**:

- `expires_at`, TTL, heartbeat, and automatic stale detection are out of scope.
- V1 writers MUST omit `expires_at`; readers MUST NOT treat an unknown or
  draft-era `expires_at` value as authority to steal or release a lease.
- Clock skew, sleeping IDE sessions, and long review/fix rounds make a short
  default TTL more likely to create duplicate ownership than to recover safely.

A future TTL requires a separate schema decision covering heartbeat ownership,
clock tolerance, stale detection, and override audit semantics.

## Serial integration merge protocol

Feature implementation may proceed concurrently across different plan IDs, but
all mutations of `spec_integration_branch` are serialized:

1. From the control worktree, verify a clean working tree and verify the checked
   out branch equals the plan's resolved `spec_integration_branch`.
2. Reread root `metadata`. If `integration_merge_lease` exists, stop as
   **Blocked**; it cannot expire or be stolen.
3. Re-read and then claim the merge lease using the same complete-file
   read-check-replace-verify discipline as execution claims. The source branch
   and plan ID MUST match the feature being integrated; the target MUST match
   `spec_integration_branch`.
4. Only the exact stored merge-lease holder may run the integration operation,
   and it MUST run from `control_worktree_path`.
5. On successful integration, record the resulting commit/evidence through the
   existing plan/status conventions, then delete
   `metadata.integration_merge_lease` in a complete-file update.
6. On conflict or failed integration, retain the merge lease while resolving or
   aborting so another session cannot begin a second merge. If abandoned, mark
   the affected plan blocked as appropriate and manually release the merge
   lease after the control worktree is returned to a clean, known state.

Execution and merge leases may coexist. The merge lease is global and permits
exactly one integration operation; it does not grant execution ownership for
the source plan.

## Waiver

For iteration commands, the control worktree, per-plan feature worktree,
execution lease, and serial merge lease are hard Phase 2 defaults. They may be
waived only by explicit user instruction in the current turn, expressed in the
Assignment as `Worktree mode: waived`, `Plan parallelism: serial`, or an
equally unambiguous statement. No persistent waiver schema is added here, and
iteration commands MUST NOT infer a waiver from missing worktrees or a
single-session start.

## CLI helper scope

A CLI lease helper is **out of scope for this plan**. It is not required for the
v1 cooperative protocol, and a helper that only rewrites JSON would not create
a true cross-machine atomic lock. Runtime skills may describe safe temporary
file replacement and post-write verification without depending on a new CLI.
If hard atomicity becomes a requirement, it needs a separately designed
lock/CAS service and failure model rather than an incidental helper command.

## Consequences

- Routing evaluation must allow cross-plan parallelism only when distinct
  feature worktrees and verified per-plan leases are present.
- Double claim, writable dispatch before a verified claim, and concurrent merge
  attempts are hard failures.
- Phase 1 Review & Edit may remain on the primary checkout; the control-worktree
  gate begins at Phase 2 entry.
- Stale leases require manual human/PM resolution. This operational cost is
  accepted to avoid unsafe automatic ownership transfer.
- Additive optional fields keep `status.json` at version 1.

## Alternatives rejected

- **Short default TTL**: unsafe for sleeping sessions and long review rounds.
- **File `flock` as primary SSOT**: brittle across hosts, operating systems, and
  machines; it also does not provide the required durable ownership record.
- **CLI JSON helper in this plan**: does not solve distributed atomicity and
  adds a runtime dependency before the cooperative semantics are validated.
- **Parallel merge into integration**: creates non-deterministic conflicts and
  invalidates the single integration snapshot used by review.
- **Single PM session only**: does not meet the multi-session acceleration goal.
