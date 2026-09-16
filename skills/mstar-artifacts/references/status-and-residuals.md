# `{HARNESS_DIR}/status.json` (v2), Workflow Snapshots and Project Registers (Morning Star)

> **Load order (same as other `mstar-*` skills):** Before changing SSOT / residual fields using this reference, Read **`mstar-harness-core`** (SKILL.md; same-repo branches and worktrees → **`mstar-branch-worktree`**). On conflict, **`mstar-harness-core` wins**; skill index in that SKILL.md.

v3 布局把 v1 的「单文件 `status.json`（根 `plans[]` + 根级 `residual_findings` + `metadata`）」拆成三层。**只使用 v2 地址；v1 地址（根 `plans[]` / 根级 `residual_findings` / `archived/residuals/`）由 `mstar migrate` 一次性迁移，不再读写**。v1 字段形状/历史全文（v1 行表、v1 `metadata` 表、jq/flock 读路径示例）→ **`mstar-engine-legacy`** `references/status-field-history.md`（engine-absent 历史 + fallback）；本文件只保留 v2 地址与一次性 legacy 只读警告。

- **根 `{HARNESS_DIR}/status.json`（v2）** — 活跃生命周期登记：`{ "version": 2, "updated_at", "workflows": [...] }`。只登记 **active**（`running` / `paused`）lifecycle；terminal 时先写 snapshot 再从根列表移除（removal-at-terminal）。由 engine `validateStatus`（v2）/ `registerWorkflow` / `unregisterWorkflow` 读写。PM-facing unregister caller：post-merge close `mstar status workflow-close --workflow <id>`（ordering 固定：terminal snapshot → unregister；细序 → `mstar-iteration/references/phase-6-post-merge-close.md` §6.1–§6.2）。
- **`{WORKFLOW_DIR}/<id>/snapshot.json`** — 每 lifecycle 的运行态快照（`schema_version: 1`）：**`plans[]` 行（legacy PlanRow 形状逐字保留）**、per-row **`execution_lease`**、顶层 **`integration_merge_lease`** / **`execution_policy`** / **`branch` anchors** / **`integration_worktree_path`** / `compass_ref`。`<id>` = plan id 或 iteration id。
- **`{PROJECT_DIR}/<id>/roadmap.md` + `residuals.json`** — 项目层：roadmap frontmatter（machine-checkable）+ residual **register**（`entries[<plan-id>]` 数组；severity 枚举与 lifecycle 语义**逐字保留**）。无项目的流程回落到 `_default` 项目。

`status.json`（根）、workflow snapshot 与 project register 都是 **SSOT**：plan 行状态与 lease 在 snapshot，open residual 在 register。  
Canonical vs legacy residual definitions → **`mstar-artifacts` SKILL.md**（"`status.json`, workflow snapshots, and open residual (summary)"）；本文件 covers **fields, severity, lifecycle, v2 地址与 engine-check 命令**。  
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
  "id": "iter-demo",
  "type": "iteration",
  "status": "running",
  "started_at": "2026-08-30",
  "updated_at": "2026-08-30",
  "phase": "phase-2-execute",
  "plans": [
    {
      "id": "plan-id",
      "title": "Plan title",
      "file": "{PLAN_DIR}/plan-id-feature-name.md",
      "status": "InProgress",
      "owner": "@project-manager",
      "agents": ["@fullstack-dev"],
      "progress": 0,
      "tags": [],
      "created_at": "2026-08-29",
      "updated_at": "2026-08-30",
      "done_at": null,
      "notes": [],
      "metadata": {},
      "execution_lease": {
        "holder": "omp:demo-session",
        "claimed_at": "2026-08-30T02:30:00Z",
        "worktree_path": ".worktrees/demo-plan",
        "working_branch": "feature/demo-plan"
      }
    }
  ],
  "execution_policy": {
    "plan_parallelism": "serial",
    "worktree_mode": "",
    "push_policy": ""
  },
  "integration_merge_lease": {
    "holder": "omp:demo-session",
    "claimed_at": "2026-08-30T03:00:00Z",
    "plan_id": "plan-id",
    "source_branch": "feature/demo-plan",
    "target_branch": "iteration/iter-demo"
  },
  "branch": { "base": "main", "integration": "iteration/iter-demo", "target": "main" },
  "integration_worktree_path": "/abs/repo/.worktrees/iter-demo-integration",
  "legacy_metadata": {},
  "compass_ref": "iterations/iter-demo/delivery-compass.md"
}
```

- The example above depicts the **held** state (both leases populated, illustrative placeholder values) and passes `validateWorkflowSnapshot`; the released state is **key absence** (delete-key-on-release below), never `null` or `{}`, and enum scalars (`type` / `status` / plan-row `status`) are always single values — the full enum sets are `type`: `plan | iteration`, snapshot `status`: `running | paused | completed | failed | stopped`, plan-row `status`: `Todo | InProgress | InReview | Blocked | Done`.

- `plans[]` rows are the **legacy PlanRow shape verbatim** (unknown row fields preserved, never re-bucketed). Per-row `execution_lease` stays on the row; `integration_merge_lease` is **top-level** (the v1 root-`metadata` home is gone).
- **Scoped coordination (optional):** top-level `coordination.coordinator` plus per-row `coordination` (`revision` / `prepared` / `session` / `progress` / `handoff`) appear only on the scoped route — field table, session envelopes and version rules → § Plan-scoped coordination below.
- Terminal statuses (`completed` / `failed` / `stopped`) require `ended_at` and no dangling leases.
- **Completed close (Phase 6)** runs `mstar status workflow-close --workflow <id> [--harness <path>] [--ended-at <date>]`: engine `closeWorkflow` rereads the latest snapshot under the snapshot write lock, refuses any dangling lease / non-`Done` row (fail-loud, bytes unchanged), writes `completed` + `ended_at`, then unregisters the root entry. Unregister failure after the snapshot write is a reported **partial close** — retry finishes unregister without rewriting `ended_at`; a fully closed retry rewrites neither file. An already-terminal `failed` / `stopped` snapshot keeps its actual status (close never fabricates `completed`).
- **Delivery-evidence consultation before the close (seam S3):** a `type: plan` snapshot's registered delivery kind is consulted **before** the terminal write (`completed` closes only — a `failed`/`stopped` close is never demanded delivery evidence, §5) — an incomplete `development` delivery (no compound disposition / PR identity / PM-recorded verified-merge evidence, or a PR whose `head`/`target` are not the registered `branch.source`/`branch.target`), or an unfulfilled `verification/report-only` completion policy, refuses with the `PHASE6_DELIVERY_*` codes, leaving the snapshot `running` and the root entry registered (bytes unchanged, workflow resumable). Record the missing evidence with `mstar workflow evidence --workflow <id> --file <payload.json> [--session <path>]` — the same coordinator-session gate as the close, idempotent (identical evidence rewrites nothing) and stage-by-stage mergeable; the PR identity (§4d) is recorded **once** (a different pair is refused), the compound disposition and the merge record stay updatable. It refuses an already-terminal lifecycle plus a non-`plan` snapshot without a registered kind. The read-only `mstar iteration gate --phase 6` shares this same consultation, so gate and close never disagree.
- **Delivery kind is declared at registration by every producer** (§1/§4a): `mstar workflow register` (normal entry), `mstar audit promote --delivery-kind <kind>` (required flag) and `mstar migrate --delivery-kind <kind>` (a lift that would create an ACTIVE kind-less plan snapshot is refused as usage, exit 2) all declare it explicitly — never inferred, never defaulted in code — and one shared rule pairs `development` with `--branch-source`/`--branch-target` and `verification/report-only` with `--completion-policy`. An **ACTIVE** `type: plan` snapshot that predates this (the historical audit-promotion / v1-lift population) is repaired once with `mstar workflow evidence --workflow <id> --declare-kind <development|verification/report-only> [--branch-source <b> --branch-target <b> | --completion-policy <text>] [--session <path>]`: the declaration is one-time (a second one, even with the same kind, is refused) and refuses a terminal snapshot — a legacy **terminal** kind-less snapshot keeps its documented owner-amendment path.
- **Physical cleanup is out of close's scope**: it is the separate `mstar worktree cleanup --workflow <id> …` verb (dry-run default), run in its own timing lane — same-round after a plan's integration merge (Phase 2) or after §6.1–§6.3 + PR merged (Phase 6). Close and cleanup never release leases — on the scoped route the plan row's lease is moved/deleted by `mstar plan accept | return | complete` (never by close or cleanup, and never by a standalone release verb); on the whole-iteration route the owner releases before either. Guard/decision codes (`cleanup.keep.*`, `cleanup.refuse.*`, `cleanup.remove.merged`) → **`mstar-branch-worktree`**「Worktree / branch cleanup」.
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

Findings must pass engine validation **before** registration into the project register: `validateResidual(entry)` per entry, `validateProjectRegister(doc)` for the whole register, `validateWorkflowSnapshot(doc)` for the snapshot, `validateStatus` for the v2 root (`mstar status validate <path>` / engine import). Malformed entries — **non-object**, missing any of the nine required fields (`id`, `title`, `severity`, `source`, `scope`, `decision`, `owner`, `target`, `tracking` — mirroring engine `RESIDUAL_REQUIRED_FIELDS` in `packages/engine/src/status.ts`), or **`severity`** / **`decision`** outside their enums (`status.residual.invalid-severity` / `status.residual.invalid-decision`) — are **rejected** (`ok:false` + violation): fix and rewrite — never silent pass-through, downgrade-write, or “write then patch”. A *lifecycle* value such as `"resolved"` in `decision` leaves the **whole register unwritable** — `validateProjectRegister(doc)` then fails the document, so the engine refuses every subsequent write to that register, not just that entry.

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
| `critical` | **Unsafe to ship, reachable on this merge** — correctness bug, security hole, data loss, or broken public contract whose unsafe outcome can be triggered here; merge-blocking. Maps to QC **Critical** findings. |
| `high` | Not blocking — the same unsafe-to-ship classes whose unsafe outcome is **not reachable on this merge** (narrow reach, unreachable path, or already mitigated), **or significant tech debt**; fix, escalate, or open a residual with PM follow-up. |
| `medium` | Should address this or next milestone; may be open residual. |
| `low` | Small impact, cheap fix; may be open residual. |
| `nit` | Style, naming, wording, non-behavior doc nits; **lighter than `low`**. PM may omit from the register if no tracking needed. |

Summary vs `mstar-review-qc`: unresolved **`critical`** → usually `Request Changes`; **`high`** often “fix or explicit decision before merge”; **`medium` / `low` / `nit`** may ship with residual tracking (final **Verdict** = PM consolidation).

### 4. QC report section → JSON `severity`

Grade by **what would happen if the finding is true**, never by how uncertain you are. Whether a finding blocks turns on whether its unsafe outcome is **reachable on this merge** — the axis defined in §3 — and not on the report section (Critical / Warning / Suggestion) it was filed under; the filing is a routing hint, not a severity decision. Two classes reach `high` or above: (a) **unsafe to ship** — correctness, security, data loss, broken public contract → `critical` / `high` even at low confidence; (b) **significant tech debt** → `high`. Everything else stays below: documentation accuracy, citations/line numbers, naming, wording, and test polish are `low` / `nit` — including inside a normative document — **unless the defect would itself drive an unsafe outcome** (a normative instruction that leads an executor into a correctness, security, or data failure), in which case it grades by that consequence. Evidence confidence belongs in the report (`Confidence`), not encoded by inflating `severity`. When the uncertainty is about **scope** (reachability) rather than severity class, record the worst-case class among the plausible ones and state the open question in the entry's `scope`.

When registering into the project register (template in `mstar-review-qc`):

| Report Findings section | JSON `severity` |
| ----------------------- | --------------- |
| **Critical** | Default `critical`. PM may record `high` only when the §3 axis puts the unsafe outcome outside reachability on this merge, with the reasoning stated in `title`/`scope`. |
| **Warning** | `medium` for ordinary substantive non-blocking items. A security/correctness/data finding follows the same §3 reachability axis as the **Critical** row: `high` when the unsafe outcome is not reachable on this merge, `critical` when it is — note the Warning filing in `title`/`scope`. |
| **Suggestion** | `low` or `nit`: substantive improvement → `low`; pure style/optional → `nit`. |

**Common mistake:** report **Warning** is not a valid `severity` string; there is no `warning` in the enum (see legacy below).

### 5. Cross-chain vocabulary (one axis, four labels)

The blocking judgement is decided **once**, on the §3 axis. Each chain's label set is a different projection of that one decision — map by **axis band**, never by label shape:

| Blocking judgement (§3 axis) | register `severity` | audit Merge class | plan-QC report section | L2 task review |
| ---------------------------- | ------------------- | ----------------- | ---------------------- | -------------- |
| **Blocking** — unsafe outcome reachable on this change/merge | `critical` | `must-fix` | **Critical** | `Critical` |
| High impact, non-blocking — unsafe but not reachable here, or significant tech debt | `high` | `should-fix` | **Warning** | `Important` |
| Substantive, non-blocking — below the above | `medium` | `should-fix` | **Warning** | `Important` |
| Small and cheap | `low` | `nit` | **Suggestion** | `Minor` |
| Style / naming / wording | `nit` | `nit` | **Suggestion** | `Minor` |

**A cross-chain translation never changes the judgement** — a label is a projection of the axis, so moving a finding between chains must not promote or demote it.

### 6. Legacy `"severity": "warning"`

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
| Formal **iteration Phase 2** (Autonomous Execute) | `allow-residual` (compass or Assignment may still override, including to `zero-residual`) |
| Standalone `/pm`, hotfix, `Execution mode: inline` | `allow-residual` |

### `zero-residual` (clean-session)

Intent: clear findings in the current plan session whenever possible. Open residuals only for **true blocker-defers**.

1. After QC: default path is **fix-now + targeted re-review**, not `Approve with residuals`.
2. Do **not** register open R# for items that can be fixed in this session.
3. **`nit`**: fix in-session **or** drop with no R# (existing “no tracking needed”); **never** open residual for style-only nits.
4. **`Approve with residuals`** only when every remaining open item is a true blocker-defer (`decision: defer`, `target` = next iteration/milestone, Durable Roadmap Gate written) — **except `critical`** (unsafe outcome reachable on this merge, §3): a `critical` is fixed now, or the risk is explicitly accepted and the entry is **closed** per item 6, never left open as the approval's remaining item.
5. **True defer** only: external dependency; product/scope decision for a later iteration; or explicit **current-turn** user defer — plus Durable Roadmap Gate.
6. **`waived` / `risk-accepted`**: still require PM + user/architect alignment; **close in the register** (do not leave open). Prefer a cheap fix over waive-as-shortcut.
7. Plan **Done**: prefer an empty `entries[<plan_id>]` in the register. If any open entries remain, **every** one must be blocker-defer + roadmap and none may be `critical` (item 4); otherwise keep `InReview` / `Blocked`.

### `allow-residual`

Non-blocking register entries — `severity` below `critical` on the §3 axis — may ship with open entries and `Approve with residuals` when no unresolved `critical` remains (existing residual lifecycle unchanged). This is the default mode (see Defaults above; `zero-residual` is the explicit opt-in). Registration and disclosure are hard duties under `allow-residual` — they replace the speed-vs-discipline tradeoff, not the audit trail:

1. **Register before InReview exit**: every open R# is entered in the project register `{PROJECT_DIR}/<id>/residuals.json` → `entries[<plan-id>]` with machine-enum `severity` before the plan leaves InReview.
2. **Disclose on every decision surface**: every consolidated QC decision, Completion Report, and Status Update states the residual situation — the list, each entry's `severity`, and its tracking location. Silence about open residuals is a gate violation, not a style issue; when nothing is open, say `N/A — none open`.
3. **Critical still blocks**: an unresolved `critical` blocks `Approve`; `medium` / `low` / `nit` may be registered and carried (fix-now remains preferred when cheap).
4. **Close-time disclosure**: close-time artifacts carry the same residual list with `id` + `severity` + tracking location + blocker-defer flag — each plan's durable `## Review Gate Summary` (main plan), the iteration compass `## Quality Gate Summary`, and the PR delivery body (`N/A — none open` when empty). A close without these disclosures is not a close. Disclosure does not override critical-blocking, explicit `zero-residual` requirements, or register lifecycle rules: terminalizing a workflow never silently closes its open findings. `mstar status tech-debt` remains the cross-iteration visibility rollup.

> **Engine check (when available):** run `mstar status findings-cleanup <plan-id> [--project <id>] [--mode zero-residual|allow-residual]` (or import `findingsCleanupGate` from `@mstar-harness/engine` in a host hook) to enforce the mode above against the plan's register entries. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

---

## Snapshot plan-row fields (`plans[].metadata` standard optional fields)

Snapshot plan rows keep the v1 PlanRow shape verbatim; the standard optional `metadata` keys below are unchanged from v1:

| Key | Type | Purpose |
| --- | --- | --- |
| `working_branch` | string | Implementation branch; aligns with Assignment **`Working branch`** (SSOT) |
| `spec_integration_branch` | string | (Multi-plan same **Spec**) integration branch name; created from snapshot `branch.base` / `execution_policy` context; plan branches merge here before final PR (`mstar-conventions`) |
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
| `knowledge_refs` | string[] | Optional knowledge-doc references (e.g. `{KNOWLEDGE_DIR}/…` paths or doc ids) linked from this plan; written by `mstar-compound` Phase 6 / `mstar-compound-refresh` Phase 4; v1 root `status.json` metadata references are legacy read-only |
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
| `worktree_path` | absolute path string | Yes | Dedicated feature-worktree root; **MUST** differ from the main worktree (control root) and snapshot `integration_worktree_path`. |
| `working_branch` | non-empty string | Yes | Feature branch at `worktree_path`; MUST agree with Assignment **`Working branch`**. |
| `session_label` | string | No | Human display only — **MUST NOT** authorize or compare ownership. |

Writers **delete** `execution_lease` on release; `null` and tombstone objects are invalid. On the scoped route the deletion happens **only** through `mstar plan accept | return | complete` (§ Plan-scoped coordination) — never by hand.

**Ownership survives release**: later `mstar worktree cleanup` attributes a released plan row through the retained row `metadata.working_branch` / `metadata.worktree_path` and retained track Assignments — never by branch-name inference. Guard codes and the cleanup contract → **`mstar-branch-worktree`**「Worktree / branch cleanup」.

V1: **manual release only** — omit `expires_at`; readers **MUST NOT** treat unknown or draft `expires_at` as authority to steal or release. There is also **no standalone release verb / flag**: on the scoped route a plan session's lease moves only through the `accept` → (`integration-start` → `integration-accept`) → `complete` sequence, or returns to the plan session on `return`; `--force`, takeover and TTL/idle theft do not exist.

### Snapshot top-level fields

| Field | Type | Semantics |
| --- | --- | --- |
| `integration_merge_lease` | object | While one integration merge is owned; **absent** = unclaimed. Writers **delete** the key on release — never `null` or tombstones |
| `execution_policy` | object | `plan_parallelism` / `worktree_mode` / `push_policy` — first-class (copied from v1 root `metadata` at migrate; values accepted-but-opaque this iteration) |
| `branch` | object | Iteration branch anchors: `base` (from `iteration_base_branch`), `integration` (the `spec_integration_branch`), `target` (final PR target) |
| `integration_worktree_path` | absolute path string | Iteration Phase 2: canonical **repository root** (not `{HARNESS_DIR}`) of the dedicated integration checkout, on the `branch.integration` branch, **distinct from the main worktree**; sole merge cwd. Canonical writers emit only this key; a raw v1 legacy worktree-path key is a **read-alias** (reader normalizes in memory + medium diagnostic `workflow.snapshot.legacy-control-worktree-path`) — migrate on the next authorized write; both keys present is a high violation, and writes never accept the old key. The main worktree (control root) is **not** a snapshot field — it is derived from Git (`readMainWorktree`). |
| `compass_ref` | string | Relative pointer to the iteration delivery compass |
| `legacy_metadata` | object | Catch-all for unmapped v1 root-`metadata` keys at migrate |

### Snapshot `notes` vs `{WORKFLOW_DIR}/<id>/notes.jsonl`

- `plans[].notes`: per-plan timeline — **legacy verbatim copy** (read-only; preserved at migrate; never a dual-write target).
- `{WORKFLOW_DIR}/<id>/notes.jsonl`: **runtime notes ledger** — append-only; new notes go here only (`kind` + `ts` + `text` JSON lines; `mstar migrate` seeds it from v1 arrays).

---

## Iteration execution leases (Phase 2)

Leases live in the **workflow snapshot** `{WORKFLOW_DIR}/<id>/snapshot.json` (`plans[].execution_lease` per row; `integration_merge_lease` top-level). Coordination happens through the **control-root copy** (the primary checkout / main worktree) of that file. This is cooperative, not a distributed lock service — non-cooperating processes are out of scope.

**When fields apply:** iteration Phase 2 (after integration-worktree entry). Worktree + lease fields are waived only by explicit current-turn user instruction (`Worktree mode: waived` or equivalent); the process SSOT still lives on the primary checkout in all modes. `Plan parallelism: serial` does **not** waive leases. **`Worktree mode: waived` does not waive the cross-plan parallel safety gate.**

**Path SSOT:** Default-gitignored process artifacts — `status.json`, `workflows/`, `projects/`, `plans/`, `iterations/`, `sdd/` — read/write via `<main-repo-root>/{HARNESS_DIR}/…` (absolute; control root = the primary checkout / main worktree). A feature worktree's same-looking `{HARNESS_DIR}` path is **not** the SSOT. Missing plans under a feature checkout (gitignore) is **not** grounds for `Worktree mode: waived` — keep feature worktrees and use control absolute **`Plan Path`** / **`SDD dir`**. The three-domain table (process SSOT / tracked results / product source) → **`mstar-branch-worktree`** 「Harness path SSOT under default gitignore」.

**Protocol home (single canonical copy):** the full lease protocol prose — same-host exclusive write lock, hard gate, claim-before-`InProgress`, hold/release/override, integration merge protocol, orphan recovery, lease prohibitions — lives in **`mstar-engine-legacy`** `references/lease-protocol.md` (engine-absent fallback). The Phase 2 iteration-command **execution checklist** → **`mstar-iteration`** `references/phase-2-worktree-lease.md`. This file carries the **field semantics** only (tables below + the lockdir location summary).

**Same-host exclusive write lock (snapshot / root):** all control-path lease mutations (execution claim/release/transfer, plan-status transitions that touch leases, `integration_merge_lease` claim/release) **MUST** run inside a same-host exclusive write lock for the full read-check-replace-verify sequence. Engine writers handle this automatically (`writeWorkflowSnapshot` / `registerWorkflow` acquire `<status-file dir>/.status-write.lockdir/` next to the file — for snapshots the lockdir lands inside `workflows/<id>/`). The lock protects only callers that **actually acquire it**: scoped verbs run their whole read-check-replace-verify inside the same lockdir, whereas a hand-written update that bypasses `writeWorkflowSnapshot` is both unprotected and unauthorized (`coordination.direct-write-refused`). Prefer the engine-check commands below over hand-rolled `flock` snippets; the atomic-mkdir alternative (`.status-write.lockdir/` in the same directory as the file) remains the documented fallback when no engine writer exists. On the **scoped route** that fallback does not reopen a manual path: the verbs own the lock (`mstar plan bind | progress | residual-add | residual-close | handoff | accept | return | integration-start | integration-accept | complete | reconcile`), a missing CLI **fails closed** instead of degrading to hand-written flock/atomic-mkdir, and read-only validators stay checks — never mutation substitutes. Hard gate, cross-host exception and pre-dispatch re-verify → `mstar-engine-legacy/references/lease-protocol.md`.

> **Lease Engine-check:** single canonical callout in `mstar-artifacts` `SKILL.md`（Engine-check lease 行）— pointer only, do not re-vendor.

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

### Claim-before-`InProgress`, hold/release/override, integration merge, orphan recovery, prohibitions

These are **full-protocol prose** — the single canonical copy lives in **`mstar-engine-legacy`** `references/lease-protocol.md` (engine-absent fallback); the Phase 2 iteration-command **execution checklist** is **`mstar-iteration`** `references/phase-2-worktree-lease.md`. This file carries the field semantics (tables above) and the engine checks only — do not re-state the protocol here. `V1: manual release only` — omit `expires_at`; readers **MUST NOT** treat unknown or draft `expires_at` as authority to steal or release (see the `execution_lease` field table). On the **scoped route** this prose is executed only through the verbs — `bind` (claim), `accept` / `return` (transfer / give-back), `integration-start` → `integration-accept` (merge), `complete` (release both) — with **no** override / `--force` / TTL path and no standalone release verb; the runtime contract is § Plan-scoped coordination above, and the legacy prose is the engine-absent fallback only.

---

## Plan-scoped coordination (bind / revision / session / handoff) — sole runtime field home

The scoped route（`/iteration-drive --assignment | --workflow <id> --plan <id> | --resume <session.json>` → `mstar plan …`）keeps **one process authority**: the same workflow snapshot (`workflows/<id>/snapshot.json`) and the same root `status.json` — no per-plan snapshot clone, database, daemon or second status copy. This section is the **single runtime home** for the coordination / session / handoff / revision fields; command flags and exit codes → `docs/cli.md`; route semantics → **`mstar-iteration`** `references/plan-scoped-pm.md`; engine API shapes → `packages/engine/src/coordination.ts`.

### Snapshot fields

| Level | Field | Type | Semantics |
| --- | --- | --- | --- |
| top | `coordination.coordinator` | object | `{ session_id, session_file, bound_at }` — one coordinator per workflow; a second fresh coordinator bind fails exactly like a duplicate plan holder. Created only from the verified main worktree or the recorded integration worktree, with a registered running iteration. |
| row | `coordination.revision` | nonnegative integer | Optimistic-concurrency token; absent `coordination` = `0`. **`--expect <revision>` always means this row value** — never snapshot `schema_version` or a date. |
| row | `coordination.prepared` | object | `{ assignment_path, assignment_sha256, plan_sha256, qa_gate, findings_cleanup, prepared_by, prepared_at }` — the reviewed-Assignment authorization. Hashes are SHA-256 of the exact UTF-8 bytes; after claim the Assignment is immutable and every show/resume/mutation rechecks its hash — a changed file fails `coordination.assignment-stale` without changing state. |
| row | `coordination.session` | object | `{ session_id, session_file, bound_at }` — the bound plan-PM session; the UUID is engine-allocated, never derived from plan, assignment path, PID or terminal label. |
| row | `coordination.progress` | object | `{ status, summary, evidence_paths[], track_branches? }`; `status` ∈ `InProgress` / `InReview` / `Blocked` only; nonblank `summary`; evidence paths must be existing canonical absolute artifacts inside this plan's resolved plan/SDD area; `track_branches` must belong to its recorded L2 Assignments/worktrees. |
| row | `coordination.handoff` | object | Immutable submitted handoff record: engine-generated UUID / attempt / timestamps plus Git pins and evidence hashes. Input can never set state, holder or target. |

### Session envelopes and credentials

- Session JSON lives at `<resolved-workflow-dir>/<workflow-id>/sessions/<session-id>.json`, created exclusively, mode `0600`.
- It is a **credential / pointer**, not a second process-SSOT copy: session identity, resolved harness root and pointers — never copied snapshot state, never a portable handoff address. Cross-primary handoff references are readable absolute **control-root filesystem paths**; `local://` is not portable.
- Session paths and `--expect` revisions stay with the dispatching PM/coordinator and are **never** handed to a leaf implementer/reviewer (`mstar-dispatch-gates` § Plan 作用域与 credential 不下发).
- Supported writers are cooperative same-machine interfaces, not a filesystem sandbox: copying a session file or editing protected files by hand is not prevented, and is not an authorized path.

### Revision and version protocol

- `--expect <revision>` (row) and `--expect-register <version>` (register; artifact version = `sha256:<64 lowercase hex>`, missing = `absent`) are required by every mutating verb. `bind` is the only exception: it checks and claims atomically against current ownership without a caller snapshot, and `--resume` returns context without changing ownership or revision.
- Every row operation **except residual-only writes** increments only that row's revision. A sibling plan's mutation leaves this row's revision untouched; a stale same-row expectation fails `coordination.version-conflict`.
- Global coordinator binding takes the snapshot lock but increments no row revision — it changes only top `coordination.coordinator` and `updated_at`.
- No automatic retry / rebase exists for caller replacements: missing version = `coordination.expected-version-required`, mismatch = version conflict, and no mtime / date / schema version is ever used as CAS.
- Residual writes touch only `entries[<planId>]` and bump no snapshot revision, so there is no two-document commit pretending to be atomic.

### Verbs and row / register ownership

| Actor | May write |
| --- | --- |
| coordinator — `mstar plan prepare · accept · return · integration-start · integration-accept · complete · reconcile` | selected row `coordination.prepared` and handoff transitions, `status`, both coordination leases, `Done` |
| plan session — `mstar plan progress · residual-add · residual-close · handoff` | its own row `status` + `coordination.progress`, `metadata.track_branches`, its `entries[<planId>]` register bucket, and the handoff record |
| anyone else | nothing scoped — sibling rows, lifecycle anchors, root register, `execution_policy`, `compass_ref`, shared indexes, the iteration PR and Phase 3–6 stay on the coordinator / global route |

- **State machine:** `Todo → InProgress` (bind) → `InReview` (handoff; lease kept) → `accepted` → `integrating` → `merged` → `completed` ⇒ `Done`. `progress` allows only `InProgress → InProgress | InReview | Blocked`, `Blocked → Blocked | InProgress`, and `InReview → InReview | InProgress | Blocked` **before** handoff — never `Todo` / `Done` / lease removal. After handoff, all scoped progress/residual mutations are rejected until `return`.
- **`complete` is the one atomic write** that sets `Done` (with verified Git proof and the findings gate), retains row `metadata.working_branch` / `metadata.worktree_path` and existing `track_branches`, and deletes the row `execution_lease` plus the coordinator's `integration_merge_lease`. `accept` is ownership transfer only — no merge, no `Done`; `integration-accept` keeps both leases and `InReview` until `complete`.
- **Legacy helpers refuse coordinated keys:** `appendProjectRegisterEntries` / `closeProjectRegisterEntry` / backlog next-free-key and `persist` replacements reject an existing coordinated plan bucket with `coordination.scoped-writer-required` (directing the caller to `residual-add` / `residual-close`), and hand writes to protected snapshot / register / root targets are refused with `coordination.direct-write-refused`. Root and global lifecycle operations stay on the existing coordinator route and are never `mutatePlanCoordination` targets.
- Read-only validators (`mstar lease verify`, `mstar lease verify-integration`, `mstar worktree check`, `mstar status validate`) remain **checks** — never mutation substitutes.

### Reconcile outcomes (crash recovery)

Per-state `reconcile` outcome **and** the recovery action it requires are **route semantics, not fields**: single canonical copy → **`mstar-iteration`** `references/plan-scoped-pm.md` §6.7（outcome table）with §7（`show` refresh before a stale retry）. The `retry-ready` path therefore resumes `show` → `integration-start`（re-pin `base_sha`, re-acquire the merge lease）→ the coordinator's `git merge --no-ff` → `integration-accept` — **never a bare merge**.

Reconciliation observes **Git ancestry / HEAD facts** in the recorded repository and never trusts a caller's success flag, and never performs a second merge. A crash after `complete` but before CLI output is handled by `show` + `reconcile`; a crash before the session binding leaves only an inert envelope. `return` after a failed merge requires an explicit Git abort plus reconcile first — a merge lease is never discarded while Git may still be in flight. Lost credentials or an abandoned active owner need explicit human recovery outside the normal verbs; no automatic takeover flag is introduced.

### Prepare workflow amendment (guarded Prepare-only structural delta)

**Coordinator authority only.** The amendment is addressed by the workflow's **coordinator** session envelope (`mstar plan bind --coordinator --workflow <id>` → `top.coordination.coordinator`); identity is never a flag, and the envelope's own harness root / workflow id are the only address. A plan session, an unbound or foreign workflow, a mismatched envelope, or an unregistered / non-`running` root entry refuses before any mutation. The top-level coordinator binding is the sole permitted coordination state.

**When it is lawful** (all of it, evaluated inside the snapshot write lock): `status: running` in `phase: phase-1-prepare`, the root register entry still **`running`** (`paused` is active in the register but not admissible here — the refusal reports the observed entry status), and **no execution ownership anywhere** — every row `Todo` with progress 0, no row `execution_lease`, no row `coordination` block (preparation, session binding, progress/QC evidence, handoff and reconcile state all live there), and no top-level `integration_merge_lease`. Resetting a row to `Todo` would erase nothing — it is exactly what this entry must not do, so an evidence-bearing row refuses instead.

**What it may change** (minimum delta): append explicitly approved **unique Todo** plan rows — constructed by the engine, never supplied with runtime row state — and fill the reviewed `integration_worktree_path`; the sole editable policy key is `execution_policy.plan_parallelism` (`serial` | `parallel`). Every prior row, unknown field, timestamp, revision, history, root entry and other workflow survives **by value**; only the appended rows, those two requested projections and the snapshot `updated_at` are new. It creates and switches nothing, is not a scheduler, and is not a general snapshot replacement. **One engine-owned exception to that enumeration:** a stored legacy `control_worktree_path` is normalized in memory by the canonical snapshot reader, so this authorized write emits the canonical `integration_worktree_path` and drops the legacy key with the value preserved — the migration the engine's own `workflow.snapshot.legacy-control-worktree-path` diagnostic prescribes (writers emit only the canonical key).

**Both byte tokens, always.** The amendment carries the current raw-byte SHA-256 of the **snapshot bytes** and of the workflow's reviewed **compass Markdown bytes** (`sha256:<64 lowercase hex>`, read from the read-only `show-prepare`); both are required even on the first amendment, and neither is a per-plan `coordination.revision`. The compass token binds the reviewed declaration: the resulting plan-id **set** must equal the compass `plans:` list exactly, and its `spec_integration_branch` / `integration_worktree_path` declarations must agree with what the call would leave recorded. The compass is re-read immediately before the single atomic commit.

**Refusals are mutation-free.** `coordination.prepare-amendment.{stale, invalid-patch, not-prepare, execution-started, duplicate-plan, invalid-plan, compass-mismatch, invalid-worktree}` (`coordination-write.ts`), plus the existing auth/scope errors; when each fires, the exact exit code and payload → `docs/cli.md` § `mstar-harness workflow`. The protected snapshot, root register, other workflows and the compass stay byte-identical.

**Prepare-only, no force.** Recovery from a `stale` token is re-read `show-prepare` → review again → retry with the fresh tokens. There is no force, no replacement snapshot, no reset and no hand-editing workaround for a workflow that has left Prepare or already owns execution.

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
| Write the register | **`@project-manager`** or **`@qa-engineer`** | After verification; waivers after PM + user/architect alignment. On the scoped route the write is the `residual-add` / `residual-close` verb, never a hand edit |

Do not claim “R3 fixed” in chat/plan only without SSOT update.

PM should register open items after **`Approve with residuals`**; QA should state each related R# (open / resolved this round / needs waiver).

### Close in place (the only close path)

After **`closed_at`**, **`closure_note`**, and PM/QA confirm close:

1. Close through the **domain call**: `mstar plan residual-close --session <plan-session> --entry <id> --note <text> --expect <revision> --expect-register <version>` on the scoped route (legacy `closeProjectRegisterEntry` under lock elsewhere). It sets `lifecycle` / `closed_at` / `closure_note` **in place** in `entries[<plan-id>]`, requires a nonblank evidence-bearing note, and bumps no snapshot revision. A coordinated plan bucket rejects the legacy helper with `coordination.scoped-writer-required`; hand edits are not an authorized path.
2. Optional: delete the entry from the register instead when the team prefers an empty open list — the closed record's `lifecycle` + `closed_at` is the durable record either way. (A coordinated bucket keeps its entries; close, do not delete.)
3. Delete empty **`plan-id`** keys; update root `updated_at`; optional milestone entry in the workflow `notes.jsonl`.

Closed records live in the register + durable plan summaries; raw review bundles are ephemeral and not part of the long-term record.

### Short in-place close (transition only)

May set `lifecycle` / `closed_*` in the register for one PR — through `mstar plan residual-close` (or `residual-add` with a new entry) when the plan is coordinated; same milestone close/delete as above.

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
