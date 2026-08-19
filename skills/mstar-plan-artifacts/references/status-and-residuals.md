# `{HARNESS_DIR}/status.json` (v2), Workflow Snapshots and Project Registers (Morning Star)

> **Load order (same as other `mstar-*` skills):** Before changing SSOT / residual fields using this reference, Read **`mstar-harness-core`** (SKILL.md; same-repo branches and worktrees → **`mstar-branch-worktree`**). On conflict, **`mstar-harness-core` wins**; skill index in that SKILL.md.

v3 布局把 v1 的「单文件 `status.json`（根 `plans[]` + 根级 `residual_findings` + `metadata`）」拆成三层。**只使用 v2 地址；v1 地址（根 `plans[]` / 根级 `residual_findings` / `archived/residuals/`）由 `mstar migrate` 一次性迁移，不再读写**：

- **根 `{HARNESS_DIR}/status.json`（v2）** — 活跃生命周期登记：`{ "version": 2, "updated_at", "workflows": [...] }`。只登记 **active**（`running` / `paused`）lifecycle；terminal 时先写 snapshot 再从根列表移除（removal-at-terminal）。由 engine `validateStatus`（v2）/ `registerWorkflow` / `unregisterWorkflow` 读写。
- **`{WORKFLOW_DIR}/<id>/snapshot.json`** — 每 lifecycle 的运行态快照（`schema_version: 1`）：**`plans[]` 行（legacy PlanRow 形状逐字保留）**、per-row **`execution_lease`**、顶层 **`integration_merge_lease`** / **`execution_policy`** / **`branch` anchors** / **`control_worktree_path`** / `compass_ref`。`<id>` = plan id 或 iteration id。
- **`{PROJECT_DIR}/<id>/roadmap.md` + `residuals.json`** — 项目层：roadmap frontmatter（machine-checkable）+ residual **register**（`entries[<plan-id>]` 数组；severity 枚举与 lifecycle 语义**逐字保留**）。无项目的流程回落到 `_default` 项目。

`status.json`（根）、workflow snapshot 与 project register 都是 **SSOT**：plan 行状态与 lease 在 snapshot，open residual 在 register。  
Canonical vs legacy residual definitions → **`mstar-plan-artifacts` SKILL.md**（"`status.json`, workflow snapshots, and open residual (summary)"）；本文件 covers **fields, severity, lifecycle, v2 地址与 engine-check 命令**。  
**Closed** residuals close **in place** in the register（`lifecycle` / `closed_at` / `closure_note`）— v1 的 `archived/residuals/<plan-id>.json` 归档路径与 `archive-residuals` 已移除（`mstar status archive-residuals` 在 v3 仅报错并指向 register 状态变更）。

**Why this matters:** Within a working copy, the workflow snapshot and project registers are the **local session SSOT** for risk and decisions. Non-blocking conclusions that stay only in chat or a gitignored review bundle **without local SSOT update** cannot be inherited reliably in that session; `Done` drifts from visible known debt. **`@project-manager`** should register trackable open items soon after review closure; close after verification per **`QA gate`** (`qa-engineer` when `mandatory`, else PM acceptance checklist).

**Cross-clone handoff** (default git policy): tracked `{HARNESS_DIR}/AGENTS.md`, `{KNOWLEDGE_DIR}/**`, `{SPECS_DIR}/**`, and root `CONCEPTS.md` / `STRATEGY.md` when used. Residuals that must survive clone must be **promoted** (compound) or written into those tracked results — do not treat `status.json` / `workflows/` / `projects/` / `plans/` as the default clone handoff surface.

## Basic structure

**Root `{HARNESS_DIR}/status.json` (v2)** — active lifecycle register:

```json
{
  "version": 2,
  "updated_at": "YYYY-MM-DD",
  "workflows": [
    {
      "id": "<plan-id-or-iteration-id>",
      "type": "plan | iteration",
      "started_at": "YYYY-MM-DD",
      "dir": "workflows/<id>"
    }
  ]
}
```

- `dir` is **harness-relative** (`workflows/<id>`), never absolute.
- Terminal writers unregister AFTER the snapshot write (removal-at-terminal): terminal snapshots are **not** listed in the root.

**`workflows/<id>/snapshot.json`** — lifecycle snapshot (`schema_version: 1`; engine `validateWorkflowSnapshot` / `writeWorkflowSnapshot`):

```json
{
  "schema_version": 1,
  "id": "<plan-id-or-iteration-id>",
  "type": "plan | iteration",
  "status": "running | paused | completed | failed | stopped",
  "started_at": "YYYY-MM-DD",
  "ended_at": null,
  "updated_at": "YYYY-MM-DD",
  "phase": "phase-2-execute",
  "plans": [
    {
      "id": "plan-id",
      "title": "Plan title",
      "file": "{PLAN_DIR}/plan-id-feature-name.md",
      "status": "Todo | InProgress | InReview | Blocked | Done",
      "owner": "@project-manager",
      "agents": ["@fullstack-dev"],
      "progress": 0,
      "tags": [],
      "created_at": "YYYY-MM-DD",
      "updated_at": "YYYY-MM-DD",
      "done_at": null,
      "notes": [],
      "metadata": {},
      "execution_lease": {}
    }
  ],
  "execution_policy": {
    "plan_parallelism": "serial",
    "worktree_mode": "",
    "push_policy": ""
  },
  "integration_merge_lease": {},
  "branch": { "base": "", "integration": "", "target": "" },
  "control_worktree_path": "/abs/repo/root",
  "legacy_metadata": {},
  "compass_ref": "iterations/<iteration-id>/delivery-compass.md"
}
```

- `plans[]` rows are the **legacy PlanRow shape verbatim** (unknown row fields preserved, never re-bucketed). Per-row `execution_lease` stays on the row; `integration_merge_lease` is **top-level** (the v1 root-`metadata` home is gone).
- Terminal statuses (`completed` / `failed` / `stopped`) require `ended_at` and no dangling leases.
- `execution_policy` keys are copied from v1 root `metadata` at migrate; values are accepted-but-opaque this iteration (no semantic gate).
- `notes`: a plan row's `notes` array is the **legacy verbatim copy** preserved at migrate; the **runtime ledger is `notes.jsonl`** in the workflow dir (see `workflows/<id>/notes.jsonl` below). New notes append to the ledger only — never dual-write the row `notes`.

**`projects/<id>/residuals.json`** — project register (entries keyed by plan id, each an ARRAY):

```json
{
  "entries": {
    "plan-id": [
      {
        "id": "R1",
        "title": "Finding title",
        "severity": "critical | high | medium | low | nit",
        "source": "QC-#1 qc1.md F-001 @ <review-range>, QA qa.md, review, …",
        "scope": "Affected file or component",
        "decision": "defer | accept | risk-accepted",
        "owner": "@fullstack-dev",
        "target": "Before plan 02 / YYYY-MM-DD / milestone",
        "tracking": "Issue URL or null",
        "detail_doc": "{PLAN_DIR}/residuals/plan-id/R1-short-label.md",
        "source_plan": "plan-id",
        "registered_at": "YYYY-MM-DD",
        "lifecycle_id": "<workflow id when owned by an iteration>"
      }
    ]
  }
}
```

- `entries[<plan-id>]` values are **arrays** — v1 `residual_findings[plan-id]` multi-finding semantics preserved verbatim (a plan may hold 2+ open residuals).
- Register entries = the v1 residual entry **verbatim** + provenance: `source_plan` (must equal its entries key), `registered_at` (`YYYY-MM-DD`), optional `lifecycle_id` (owning workflow id when an iteration owns the plan).
- Project-less flows use the fallback **`_default`** project (`projects/_default/`).
- Register document validation delegates verbatim to `validateResidual` (severity enum + lifecycle states preserved at the new address).

**`projects/<id>/roadmap.md`** — roadmap frontmatter (engine `validateRoadmap`):

```markdown
---
project_id: <id>
title: <title>
status: active | paused | completed
created_at: YYYY-MM-DD
milestones: [ ... ]        # optional
residuals_ref: residuals.json  # optional
---

# <title>

## Direction
...
```

Body conventions (`## Direction` + goal items as `- [ ]` / `- [x]` markdown task-list items) are **warnings only** — never a hard gate.

**Empty-repo template:** **`templates/status.empty.json`** — the v2 shape (`version: 2`, `updated_at`, `workflows: []`). See **`templates/README.md`**.

**Closed entries** add: `lifecycle`, `closed_at`, `closure_note`; optional `closure_evidence`, `superseded_by`. See “Residual findings lifecycle”.

**Open `detail_doc` (optional):** repo-relative path under **`{PLAN_DIR}/residuals/<plan-id>/`** matching **`id`** (e.g. `R1`); omit if prose layer unused (`knowledge-and-designs.md`).

## Fail-loud handoff contract

Findings must pass engine validation **before** registration into the project register: `validateResidual(entry)` per entry, `validateProjectRegister(doc)` for the whole register, `validateWorkflowSnapshot(doc)` for the snapshot, `validateStatus` for the v2 root (`mstar status validate <path>` / engine import). Malformed entries — **non-object**, missing any of the nine required fields (`id`, `title`, `severity`, `source`, `scope`, `decision`, `owner`, `target`, `tracking` — mirroring engine `RESIDUAL_REQUIRED_FIELDS` in `packages/engine/src/status.ts`), or **severity** outside the enum — are **rejected** (`ok:false` + violation): fix and rewrite — never silent pass-through, downgrade-write, or “write then patch”.

dsh-derived findings map their keys per the engine-residual validation verification spec §5; dsh keys never enter the schema.

---

## Residual findings: `severity` (SSOT, machine field)

Each register entry (`projects/<id>/residuals.json` → `entries[<plan-id>][]`)’s **`severity`** must be from this enum. QC report Markdown **Critical / Warning / Suggestion** are **section titles** — **do not** copy them verbatim into JSON `severity`.

### 1. Allowed values

Only these five, **lowercase English**:

`critical`, `high`, `medium`, `low`, `nit`

### 2. Total order (heavy → light)

`critical` > `high` > `medium` > `low` > `nit`

- **`nit` is always lighter than `low`** — never invert or equate.
- **Forbidden** in JSON: `warning`, `Major`, non-English, or any value not listed.

### 3. Meaning and gate relationship

| `severity` | Meaning |
| ---------- | ------- |
| `critical` | Merge-blocking; maps to QC **Critical** findings. |
| `high` | Not blocking but high impact (security, correctness, data, significant tech debt); fix, escalate, or open residual with PM follow-up. |
| `medium` | Should address this or next milestone; may be open residual. |
| `low` | Small impact, cheap fix; may be open residual. |
| `nit` | Style, naming, wording, non-behavior doc nits; **lighter than `low`**. PM may omit from the register if no tracking needed. |

Summary vs `mstar-review-qc`: unresolved **`critical`** → usually `Request Changes`; **`high`** often “fix or explicit decision before merge”; **`medium` / `low` / `nit`** may ship with residual tracking (final **Verdict** = PM consolidation).

### 4. QC report section → JSON `severity`

When registering into the project register (template in `mstar-review-qc`):

| Report Findings section | JSON `severity` |
| ----------------------- | --------------- |
| **Critical** | Default `critical`. PM may record `high` if “not blocking this merge but follow up soon” — state reason in `title`/`scope`. |
| **Warning** | `high` or `medium`: security/correctness/data → `high`; other substantive non-blocking → `medium`; **when unsure, use `high`**. |
| **Suggestion** | `low` or `nit`: substantive improvement → `low`; pure style/optional → `nit`. |

**Common mistake:** report **Warning** is not a valid `severity` string; there is no `warning` in the enum (see legacy below).

### 5. Legacy `"severity": "warning"`

In old JSON, **`"severity": "warning"`** is read and rolled up as **`low`**. **Forbidden** on new entries.

---

## Findings cleanup modes

Plan-level policy for whether non-blocking QC/QA findings may remain as open residual entries or must be cleared in the current plan session.

### Assignment (SSOT)

| Surface | Values |
| ------- | ------ |
| Assignment **`Findings cleanup`** | `zero-residual` \| `allow-residual` |

The v1 `plans[].metadata.findings_cleanup` mirror is **deleted** in v3 — no dual-track. Assignment wins; the register is the only residual store.

**Defaults**

| Context | Default |
| ------- | ------- |
| Formal **iteration Phase 2** (Autonomous Execute) | `zero-residual` (compass or Assignment may override to `allow-residual`) |
| Standalone `/pm`, hotfix, `Execution mode: inline` | `allow-residual` |

### `zero-residual` (clean-session)

Intent: clear findings in the current plan session whenever possible. Open residuals only for **true blocker-defers**.

1. After QC: default path is **fix-now + targeted re-review**, not `Approve with residuals`.
2. Do **not** register open R# for items that can be fixed in this session.
3. **`nit`**: fix in-session **or** drop with no R# (existing “no tracking needed”); **never** open residual for style-only nits.
4. **`Approve with residuals`** only when every remaining open item is a true blocker-defer (`decision: defer`, `target` = next iteration/milestone, Durable Roadmap Gate written).
5. **True defer** only: external dependency; product/scope decision for a later iteration; or explicit **current-turn** user defer — plus Durable Roadmap Gate.
6. **`waived` / `risk-accepted`**: still require PM + user/architect alignment; **close in the register** (do not leave open). Prefer a cheap fix over waive-as-shortcut.
7. Plan **Done**: prefer an empty `entries[<plan_id>]` in the register. If any open entries remain, **every** one must be blocker-defer + roadmap; otherwise keep `InReview` / `Blocked`.

### `allow-residual` (legacy default)

Non-blocking Warning/Suggestion may ship with open register entries and `Approve with residuals` when no unresolved Critical remains (existing residual lifecycle unchanged).

> **Engine check (when available):** run `mstar status findings-cleanup <plan-id> [--project <id>] [--mode zero-residual|allow-residual]` (or import `findingsCleanupGate` from `@mstar-harness/engine` in a host hook) to enforce the mode above against the plan's register entries. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

---

## Snapshot plan-row fields (`plans[].metadata` standard optional fields)

Snapshot plan rows keep the v1 PlanRow shape verbatim; the standard optional `metadata` keys below are unchanged from v1:

| Key | Type | Purpose |
| --- | --- | --- |
| `working_branch` | string | Implementation branch; aligns with Assignment **`Working branch`** (SSOT) |
| `spec_integration_branch` | string | (Multi-plan same **Spec**) integration branch name; created from snapshot `branch.base` / `execution_policy` context; plan branches merge here before final PR (`mstar-plan-conventions`) |
| `merge_target` | string | Next merge target; multi-plan + Spec → usually `spec_integration_branch`; final PR target is snapshot `branch.target` |
| `branch_policy` | string | One-line policy per `mstar-harness-core` |
| `phase` | string | Program/roadmap label |
| `priority` | `high` \| `medium` \| `low` | PM scheduling |
| `description` / `scope` | string | One-line scope; pick one key per repo |
| `gates` | object | Gate summary (`qc`, `qa`, `typecheck`, `tests`, `lint`, …) |
| `blocked_since` | `YYYY-MM-DD` | When `status` is `Blocked` |
| `blocked_reason` | string | Block reason |
| `blocked_by_plan_id` | string | Blocking **`plans[].id`** |
| `dependency` | string | Other dependencies |
| `next_action` | string | Next step after unblock/review |
| `primary_spec` | string | Main spec path (`{KNOWLEDGE_DIR}/…`, `{SPECS_DIR}/…`) |
| `iteration_compass` | string | Optional `{ITERATION_DIR}/…` |
| `iteration_refs` | string[] | Optional multiple compass paths |
| `qc_status` / `tests` / `commits` | string | InReview/Done snapshots; not a substitute for durable plan gate summaries or the project register |
| `sdd_dir` | string | SDD scratch path, e.g. `{HARNESS_DIR}/sdd/<plan-id>/` (gitignored; `mstar-sdd`) |
| `sdd_progress` | string | Optional pointer to `{SDD_DIR}/progress.md` ledger |
| `review_bundle` | string | Optional pointer to `{SDD_DIR}/review/` for current ephemeral QC/QA evidence |
| `task_commits` | array\<object\> | SDD recovery: `{ "task_id": "T1", "base": "<sha>", "head": "<sha>" }` per completed task — recorded on the snapshot plan row |

### `plans[].execution_lease` (iteration Phase 2)

Optional when a plan is not owned; **required** while a Phase 2 session owns writable execution for that plan. Normative protocol below; iteration command checklist → `mstar-iteration/references/phase-2-worktree-lease.md`.

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `holder` | non-empty string | Yes | Opaque cooperative owner identity (recommended `<host>:<stable-session-id>`, e.g. `cursor:bc-1234`). Stable for claim lifetime; **no credentials**; used for ownership comparison — not `session_label`. |
| `claimed_at` | RFC 3339 UTC (`Z`) | Yes | Acquisition time (audit only; **not** an expiry clock). |
| `worktree_path` | absolute path string | Yes | Dedicated feature-worktree root; **MUST** differ from `control_worktree_path`. |
| `working_branch` | non-empty string | Yes | Feature branch at `worktree_path`; MUST agree with Assignment **`Working branch`**. |
| `session_label` | string | No | Human display only — **MUST NOT** authorize or compare ownership. |

Writers **delete** `execution_lease` on release; `null` and tombstone objects are invalid.

### Snapshot top-level fields

| Field | Type | Semantics |
| --- | --- | --- |
| `integration_merge_lease` | object | While one integration merge is owned; **absent** = unclaimed. Writers **delete** the key on release — never `null` or tombstones |
| `execution_policy` | object | `plan_parallelism` / `worktree_mode` / `push_policy` — first-class (copied from v1 root `metadata` at migrate; values accepted-but-opaque this iteration) |
| `branch` | object | Iteration branch anchors: `base` (from `iteration_base_branch`), `integration` (the `spec_integration_branch`), `target` (final PR target) |
| `control_worktree_path` | absolute path string | Iteration Phase 2: canonical **repository root** (not `{HARNESS_DIR}`) checked out to the `branch.integration` branch; coordination + serial merge cwd |
| `compass_ref` | string | Relative pointer to the iteration delivery compass |
| `legacy_metadata` | object | Catch-all for unmapped v1 root-`metadata` keys at migrate |

### Snapshot `notes` vs `{WORKFLOW_DIR}/<id>/notes.jsonl`

- `plans[].notes`: per-plan timeline — **legacy verbatim copy** (read-only; preserved at migrate; never a dual-write target).
- `{WORKFLOW_DIR}/<id>/notes.jsonl`: **runtime notes ledger** — append-only; new notes go here only (`kind` + `ts` + `text` JSON lines; `mstar migrate` seeds it from v1 arrays).

---

## Iteration execution leases (Phase 2)

Leases live in the **workflow snapshot** `{WORKFLOW_DIR}/<id>/snapshot.json` (`plans[].execution_lease` per row; `integration_merge_lease` top-level). Coordination happens through the **control worktree** copy of that file. This is cooperative, not a distributed lock service — non-cooperating processes are out of scope. **Same-host** writers use an exclusive write lock (below) around lease mutations; **cross-plan parallel writable implement** is permitted only when that lock is available on the coordination path and held for every lease mutation (see hard gate below).

**When fields apply:** iteration Phase 2 (after control worktree entry, or primary checkout when `Worktree mode: waived`). Control worktree + lease fields are waived only by explicit current-turn user instruction (`Worktree mode: waived` or equivalent). `Plan parallelism: serial` does **not** waive leases. **`Worktree mode: waived` does not waive the cross-plan parallel safety gate** (see hard gate below).

**Path SSOT:** Default-gitignored process artifacts — `status.json`, `workflows/`, `projects/`, `plans/`, `iterations/`, `sdd/` — read/write via `<control_worktree_path>/{HARNESS_DIR}/…` (absolute). A feature worktree's same-looking `{HARNESS_DIR}` path is **not** the SSOT. Missing plans under a feature checkout (gitignore) is **not** grounds for `Worktree mode: waived` — keep feature worktrees and use control absolute **`Plan Path`** / **`SDD dir`**. Detail → **`mstar-branch-worktree`** 「Harness path SSOT under default gitignore」.

### Same-host exclusive write lock (snapshot / root)

Lease mutations on the **control** copies — execution claim/release/transfer, plan-status transitions that touch leases, and `integration_merge_lease` claim/release — **MUST** run inside a **same-host exclusive write lock** for the full read-check-replace-verify sequence.

Engine writers handle this automatically (`writeWorkflowSnapshot` / `registerWorkflow` acquire `<status-file dir>/.status-write.lockdir/` next to the file — for snapshots the lockdir lands inside `workflows/<id>/`). Prefer the **engine-check commands** in this reference over hand-rolled `flock` snippets for manual/PM-driven coordination edits; the atomic-mkdir alternative (`.status-write.lockdir/` in the same directory as the file) remains the documented fallback when no engine writer exists.

**Hard gate — cross-plan parallel writable implement:** Applies **whether or not** `Worktree mode: waived`. Lease-gated **cross-plan parallel** writable implement (when lease gate active) is allowed **only when** a same-host exclusive write lock is **available on the coordination path and held for every coordination mutation** in that Phase 2 session (control snapshot when lease gate active). When waived, the coordination path is primary checkout `{HARNESS_DIR}/status.json` (root) + snapshot — the same lock discipline applies to any shared mutation before parallel writable dispatch. If agents span hosts or the coordination path has **no shared lockdir/flock** → default **`Plan parallelism: serial`** (or **Blocked** if the Assignment still claims parallel). No flock does **not** waive control/feature worktree or leases — serial scheduling only.

**Exception — documented cross-host residual:** explicit **current-turn** user instruction such as `Cross-host lease race: accepted` (or equally unambiguous equivalent) **plus** audit entry on snapshot plan `notes` / notes ledger (timestamp, hosts/sessions involved, residual race risk acknowledged) permits cooperative multi-host cross-plan parallel with documented residual risk.

**Pre-dispatch re-verify:** Immediately before **any** writable implement dispatch, re-read the control snapshot and confirm this session still passes verify-held-lease (`holder`, `worktree_path`, `working_branch` match Assignment). Mismatch or absent lease → **STOP** — do not dispatch.

### `integration_merge_lease` (snapshot top-level)

Single global lease authorizing one plan feature branch integration into `branch.integration` (the `spec_integration_branch`).

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `holder` | non-empty string | Yes | Same format and comparison rules as `execution_lease.holder`. |
| `claimed_at` | RFC 3339 UTC (`Z`) | Yes | Acquisition time (audit only). |
| `plan_id` | non-empty string | Yes | `plans[].id` of the feature being integrated. |
| `source_branch` | non-empty string | Yes | Plan feature branch to integrate. |
| `target_branch` | non-empty string | Yes | Resolved `spec_integration_branch` — no other target is valid. |
| `session_label` | string | No | Display only. |

### Claim-before-`InProgress` (execution lease)

A Phase 2 session **MUST** claim **before** moving a plan from `Todo` or `Blocked` to `InProgress` and **before** any writable dispatch for that plan:

1. Re-read the control copy of the snapshot; locate exactly one plan row (`id` read compatibility).
2. **Resume (not steal):** if `execution_lease` exists and `holder` **equals this session** → verify-held: confirm `worktree_path` and `working_branch` match the Assignment; continue (this is **not** Blocked and **not** a new claim).
3. **Blocked:** if `execution_lease` exists and `holder` **differs** → stop. No timestamp, TTL, or inactivity makes it stealable.
4. **Orphan:** if `status` is `InProgress` but `execution_lease` is absent → **STOP** (see “Orphan recovery” below). Do not writable-dispatch or invent a lease.
5. Create or verify the dedicated feature worktree and branch (`worktree_path` ≠ `control_worktree_path`).
6. Acquire same-host write lock (see above); re-read the snapshot; if row, status, or lease state changed, restart from step 1.
7. In **one complete-file update** (under lock), set `status: "InProgress"` and write the full `execution_lease` object.
8. Re-read the stored row; verify `holder`, `worktree_path`, and `working_branch` exactly match the attempted claim. Writable dispatch is forbidden until verification succeeds.

V1: **manual release only** — omit `expires_at`; readers **MUST NOT** treat unknown or draft `expires_at` as authority to steal or release.

### Hold, release, and override

- Lease remains active across `InProgress` and `InReview` (including review fix rounds) unless deliberately released or transferred.
- **Release:** re-read control snapshot; stored `holder` must match this session (mismatch → **Blocked**, not permission to delete). Delete `execution_lease` in the same complete-file update — never `null`.
- Voluntary abandonment: may set `status: "Blocked"` and delete the lease in one update.
- **`Done` authority** deletes any `execution_lease` in the **same** complete-file update as `status: "Done"` — **only after** successful integration merge into `spec_integration_branch` when Phase 2 lease gate is not waived (see “Integration merge protocol” and `mstar-iteration` §2.4). After QC/QA pass, plan stays **`InReview`** with lease retained until merge succeeds.
- Temporary blockage may retain the lease when the same holder remains responsible and the plan record explains the next action.
- **Override (only exception to no-steal):** explicit **user instruction in the current turn** may remove or replace another holder's lease. Append an audit entry to the snapshot plan `notes` (or the `notes.jsonl` ledger) with timestamp, prior holder, new holder (or release), and that the user authorized the override. Agents **MUST NOT** infer override from age, inactivity, `Blocked` status, or a failed session.
- Cooperative handoff: current holder explicitly agrees; receiving worktree/branch verified; one complete-file update — otherwise old holder releases and new holder follows normal claim.

### Integration merge protocol

Feature implementation may run in parallel across plan IDs **only when** the cross-plan parallel hard gate above is satisfied (same-host lock on coordination snapshot, default **`Plan parallelism: serial`**, or current-turn `Cross-host lease race: accepted` + audit — **not** by `Worktree mode: waived` alone); when lease gate is active, each plan also needs a verified `execution_lease` and distinct feature worktree. Mutations of `spec_integration_branch` are **serial**. Plan status after QC/QA is **`InReview`** with `execution_lease` retained until merge succeeds (when lease gate active); **`Done`** + lease deletion happen **after** the integration merge commit is recorded.

1. From `control_worktree_path`: clean working tree; checked-out branch = resolved `branch.integration` (`spec_integration_branch`).
2. Re-read snapshot under the same-host write lock (above). If `integration_merge_lease` exists:
   - **Resume (not steal):** `holder` **equals this session** → verify: `plan_id`, `source_branch`, `target_branch` match the intended merge; confirm control worktree state; continue (not Blocked).
   - **Blocked:** `holder` **differs** → stop. No timestamp, TTL, or inactivity makes it stealable.
3. If unclaimed, claim the merge lease with the same read-check-replace-verify discipline as execution claims. `source_branch` and `plan_id` must match the feature; `target_branch` must match `spec_integration_branch`.
4. Only the stored merge-lease `holder` runs integration from `control_worktree_path`.
5. On success: record the merge commit/evidence per plan/status conventions; **delete** `integration_merge_lease`; in the **same** locked update set plan `status: "Done"` and **delete** `execution_lease`.
6. On conflict/failure: retain both leases; plan stays **`InReview`** — do **not** set `Done`. Release the merge lease only after the control worktree is clean and in a known state.

Execution and merge leases may coexist; the merge lease does not grant execution ownership for the source plan.

### Orphan recovery (`InProgress` without `execution_lease`)

Runtime skills that detect this state (e.g. `mstar-iteration`) **STOP** and defer recovery here — they **MUST NOT** silently add a lease or writable-dispatch.

**Immediate gate:** no writable dispatch until recovery completes and a verified `execution_lease` exists (or plan returns to a non-active status).

**Resolver:** `@project-manager` (or explicit human/PM ownership resolution after race or corruption).

| Path | When | Actions |
| ---- | ---- | ------- |
| **Reset to `Todo`** | Work abandoned, unknown owner, or safe to restart claim | One complete-file update under write lock: `status: "Todo"`; ensure `execution_lease` absent; append audit note to snapshot plan `notes` / `notes.jsonl` (timestamp, reason, actor). |
| **Recover with claim (same holder)** | Legitimate in-progress work; feature worktree/branch verified on disk; **this session's stable `holder`** matches the prior owner | Unattended recovery permitted **only** for the **same** stable `holder`. Follow claim-before-`InProgress` from step 5 under write lock; append audit note (orphan recovery, same `holder`, paths verified). |
| **Recover with claim (different holder)** | New session must take over live work | **Blocked** for unattended recovery. Requires **verified quiescence** of the prior writer (no live writable work on the feature branch/worktree) **and** explicit cooperative handoff from the prior holder, **or** **current-turn user override** + audit note (prior holder, new holder, user authorized). Then normal claim under write lock. |
| **Escalate / `Blocked`** | Ambiguous ownership, conflicting worktrees, or partial/corrupt snapshot | Set `status: "Blocked"` with `metadata.blocked_reason`; do **not** writable-dispatch until human/PM resolves. Restore a coherent snapshot from the latest complete state if needed. |

After any recovery path, the next session must pass verify-held-lease before writable dispatch.

### Lease prohibitions (SSOT)

- **MUST NOT** steal or overwrite an active `execution_lease` or `integration_merge_lease` (no TTL, age, or inactivity authority in v1).
- **MUST NOT** writable-dispatch without a verified `execution_lease` for that plan (resume counts only when same `holder` passes verify-held).
- **MUST NOT** write `null` or tombstone objects for lease keys — **delete** the key on release.
- **PM NEVER** steal an active lease without explicit current-turn user override + audit note (full list → `mstar-roles/references/project-manager.md` § PM-Specific NEVER Rules).

Preservation: writers **MUST** preserve unrelated snapshot rows, the register, and other project data on every mutation.

---

## General constraints

- Each snapshot `plans[]` row may include optional **`metadata`** (`{}` or omit).
- A workflow root entry is **active only** (`running` | `paused`); terminal writers unregister the root entry after the snapshot write (removal-at-terminal).
- **`plans[].id`** keys must align with register `entries` keys and `{SDD_DIR}` plan-id segments. Do not store `residual_findings_plan_id`.
- **Empty `plan-id` key:** when no open entries remain, **delete** the key from the register (`entries`) — no `"plan-id": []`.
- **`residual_summary` (optional):** one-line human summary of **open** entries only.

---

## Residual findings lifecycle (close, archive, remove)

### `lifecycle` (optional; default open)

| `lifecycle` | Meaning | `closure_note` should explain |
| ----------- | ------- | ----------------------------- |
| `open` | Not closed (omit field = open) | — |
| `resolved` | Fixed in code/config/docs and **verified** | What changed; how verified |
| `waived` | Explicit decision not to fix | Who decided; why; optional `tracking` Issue |
| `superseded` | Replaced by new finding/spec/refactor | `superseded_by` |
| `duplicate` | Duplicate of another R# | Canonical `id` or mistake note |

**On close:** set **`closed_at`** (`YYYY-MM-DD`) and **`closure_note`**; recommend **`closure_evidence`** (PR, commit, test, doc anchor).

### Who updates when

| Action | Owner | When |
| ------ | ----- | ---- |
| Implement fix | `@fullstack-dev` / assignee | Completion Report cites R# + evidence |
| Verify | `@qa-engineer` when **`QA gate: mandatory`**; else PM per acceptance checklist | Regression / acceptance; open R# close requires verify before close |
| Write the register | **`@project-manager`** or **`@qa-engineer`** | After verification; waivers after PM + user/architect alignment |

Do not claim “R3 fixed” in chat/plan only without SSOT update.

PM should register open items after **`Approve with residuals`**; QA should state each related R# (open / resolved this round / needs waiver).

### Close in place (the only close path)

After **`closed_at`**, **`closure_note`**, and PM/QA confirm close:

1. Set `lifecycle` / `closed_at` / `closure_note` on the entry **in place** in the register (`projects/<id>/residuals.json` → `entries[<plan-id>]`).
2. Optional: delete the entry from the register instead when the team prefers an empty open list — the closed record's `lifecycle` + `closed_at` is the durable record either way.
3. Delete empty **`plan-id`** keys; update root `updated_at`; optional milestone entry in the workflow `notes.jsonl`.

Closed records live in the register + durable plan summaries; raw review bundles are ephemeral and not part of the long-term record.

### Short in-place close (transition only)

May set `lifecycle` / `closed_*` in the register for one PR; same milestone close/delete as above.

### Hard delete

- **Forbidden** for **open** entries.
- Do not delete closed entries; correct via new entry or new R# referencing old `id`.
- Mistaken open-only entry: PM may delete or mark **`duplicate`** then close.

### Query open and closed (examples)

```bash
# Engine-check (read-only): validate the register / rollup / cleanup gate
mstar status validate <path-to-residuals-or-root.json>   # schema
mstar status tech-debt <project-dir>                     # rollup over registers
mstar status findings-cleanup <plan-id> --project <id>   # mode gate
```

- The v1 read paths (root `residual_findings` / `metadata.residual_findings` / `archived/residuals/<plan-id>.json`) are **legacy read-only** — `mstar migrate` moved open entries into the register; old files may remain for history.

---

## `{WORKFLOW_DIR}/<id>/notes.jsonl` (per-workflow notes ledger)

Append-only JSON-lines log for merge closure, batch close, register refreshes, etc. Does not compete with **snapshot `plans[].status`** / open residual SSOT.

```jsonl
{"kind": "note", "ts": "2026-04-08", "text": "Short milestone"}
```

- **`@project-manager`** maintains; do not rewrite past lines — add a correction as a new line.
- **`plans[].notes`**: per-plan legacy verbatim array; **`notes.jsonl`**: runtime ledger — new notes append here only (no dual-write).

---

## `mstar status tech-debt` (project-register rollup)

**Role:** Cross-plan aggregate over **open** register entries across every `{PROJECT_DIR}/<id>/residuals.json` register. Does **not** replace per-entry SSOT. The v1 stored-summary drift check (`metadata.tech_debt_summary`) is a **v1 dead path** — the register is the source of truth, so `stored` is always null and the retained `checks`/`overall` fields report DRIFT (export-surface compatibility).

**Compute (canonical):** engine / CLI (do **not** hand-count):

```ts
// Engine check (when available) — pass the project dir (default: resolved {PROJECT_DIR})
import { techDebtRollup } from "@mstar-harness/engine";
const rollup = techDebtRollup("{HARNESS_DIR}/projects"); // { computed, stored: null, checks, overall }
// CLI form (same output; informational exit 0): mstar status tech-debt <path> (default: {PROJECT_DIR})
```

- Prints computed `total_open`, `by_severity`, `by_target`, `by_plan` (`by_plan` keyed by plan id — the snapshot/register plan linkage; legacy `"warning"` → `low`, `null`/`""` → `medium`; closed entries skipped; missing `target` groups under `"unspecified"`).
- The engine call **does not write** anything.

---

## Pre-merge: snapshot + register should match reality

Before merge/PR, **`@project-manager`** (or delegate) should verify: snapshot `plans[].status`, `metadata.gates`, project register (no accidental leftovers), vs review/CI.

**Common gaps:**

- R# added/closed but the register was not updated.
- Finding only in `plans[].notes` or chat, not in the register `entries[<plan-id>]`.
- Major milestone with no `notes.jsonl` entry when team uses the workflow ledger.

## Compatibility: plan key names

- Read: accept `id` or `plan_id` (v1 rows / entries read compatibility).
- Write: one canonical key (prefer `id`).
- Document the canonical key in `{HARNESS_DIR}/AGENTS.md` if migrating.

## Common queries

```bash
# Engine-check (recommended): validate any v2 artifact
mstar status validate .mstar/status.json                  # root v2
mstar status validate .mstar/workflows/<id>/snapshot.json # snapshot
mstar status tech-debt .mstar/projects                     # register rollup
```
v1 trees (root `plans[]` / `residual_findings`) are migrated first: `mstar migrate [--dry-run] [--path <root>]`.
