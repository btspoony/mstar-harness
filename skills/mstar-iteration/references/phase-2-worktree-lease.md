# Phase 2: Autonomous Execute — per-plan loop + integration worktree + lease

> Loaded by `mstar-iteration` SKILL.md on the **execute / resume** route, and by the Phase 2+ command layer. **Read `mstar-harness-core` first.** Entry = §2.0 五道闸全过；continuous execution / push 纪律（§2.6）的 SSOT 仍在 `mstar-iteration` SKILL.md。

Normative field names → field SSOT
`mstar-artifacts/references/status-and-residuals.md`; the **full lease
protocol prose** (single canonical copy) → `mstar-engine-legacy/references/lease-protocol.md`
(engine-absent fallback). This reference is the **iteration-command execution
checklist** — do not invent alternate lease field names; do not re-state the
full protocol here.

## When it applies

**Phase 2**（SKILL.md execute/resume route + `iteration-drive` / `iteration-loop`
command layer；`iteration-start` ends before this）. Defaults are **hard** unless the current turn
explicitly waives via Assignment `Worktree mode: waived` (or equivalent user
instruction), within the limited scope in § Waiver; main residency and the
dedicated integration checkout remain mandatory. `Plan parallelism: serial` is **not** a waiver — it only forces
serial cross-plan **implement** scheduling while the worktree + lease gates remain
required.

Phase 1 Review & Edit may edit uncommitted docs on the primary checkout under the Prepare policy (bounded exception; the main worktree never switches branch). The integration-worktree + lease gate
starts at **Phase 2 entry**.

**Phase scope**：本参考仅约束 **Phase 2**（含 serial integration merge 与「control root / integration worktree 禁止产品编辑 / 每 plan feature worktree」）。**Phase 5** PR merge-ready 修复同样 **不**直接在 integration checkout 上改——产品修复走独立 fix feature worktree，review 后 merge 回 integration worktree → **`phase-4-5-pr-delivery.md`** §5.0。

**本 Phase 定义 per-plan 派发循环的完整流程**：前置条件检查、session todos、backlog 读取、integration 分支管理、per-plan dispatch 循环（分支→实现→QC→**QA gate**→Done→合并）、dispatch-first 约束。PM 读取本 Phase（含 §2.0–§2.5 与下方 lease 细则）即可执行迭代。

**Findings cleanup（默认）**：Phase 2 每个 plan Assignment 默认 **`Findings cleanup: zero-residual`**（可修 findings 当轮 fix→re-review 清干净；仅真 blocker-defer + Durable Roadmap 可留 open R#）。compass 或 Assignment 可显式覆写为 `allow-residual`。SSOT → **`mstar-artifacts`**「Findings cleanup modes」。

## 2.0 前置条件（五道闸）

进入 Autonomous Execute 前必须满足：

1. workflow snapshot（`{WORKFLOW_DIR}/<id>/snapshot.json`）中至少一条 plan `status` ≠ `Done`；根 `status.json` `workflows[]` 含该 iteration entry
2. **Pre-implement gate = GO**：plan 已 locked、tasks ready（见 `mstar-phase-gates`）
3. 用户意图为 **continue Autonomous Execute**（推进迭代 Execute、继续 per-plan 循环等）
4. **Branch metadata gate**：snapshot `branch.base`（`iteration_base_branch`）、`branch.target`（`target_branch`）已登记，且至少一条 active plan 有 `metadata.spec_integration_branch`（或可从 compass 同轮 backfill）。**缺失 → STOP**，不得用 `main`/`master` 补位。
5. **Worktree + lease defaults**（iteration 命令；waiver 范围见下方「Waiver」）：所有模式的 Phase 2 **必须**在入口确认 control root（= **主 checkout / main worktree**，进程 SSOT；其驻留分支 = 主 plan 头记录的 **`Main worktree branch`**，且非任何未终结 workflow 的分支）并建立独立 integration worktree、经 control 绝对路径读写默认 gitignored 的 harness 进程产物（根 `status.json`、`workflows/`、`projects/`、`{PLAN_DIR}`、`{ITERATION_DIR}`、`{SDD_DIR}` 等），；未 waive 时在可写派发前 claim workflow snapshot 的 `plans[].execution_lease` / 顶层 `integration_merge_lease`。可写 Assignment 须含绝对 feature **`Worktree path`** + 绝对 control 系 **`Plan Path`** / **`SDD dir`**（见 **`mstar-branch-worktree`**「Harness path SSOT under default gitignore」三域表）。**禁止**因 feature worktree 在默认 gitignore 下看不到 plans 而推断 `Worktree mode: waived`。`Plan parallelism: serial` **不** waive 本闸——仅强制跨 plan **implement** 串行调度；integration worktree + lease 仍须满足（**串行不豁免 worktree**）。**跨 plan 并行安全闸**（**不可**被 `Worktree mode: waived` 豁免）：跨 plan **并行可写 implement** 须满足下列之一——(a) coordination 路径（control root = 主 checkout `{HARNESS_DIR}/` 下 snapshot / `status.json`）上 **same-host 独占写锁可用且每次 status/协调变更持锁**；(b) 默认 **`Plan parallelism: serial`**（**waived 时尤其优先默认串行**；**无 flock / 无共享锁时只触发本条，不豁免 worktree**）；(c) 用户本轮显式 `Cross-host lease race: accepted`（或等价）+ `plans[].notes` 审计。**禁止**将 `Worktree mode: waived` 当作跨主机无锁并行的授权。细则 → 下方「Integration worktree (Phase 2 entry)」「Execution lease」「Multi-plan parallelism」「Waiver」各节。

> **Engine-check（lease verify / verify-integration）唯一规范体：** `mstar-artifacts` `SKILL.md`（Engine check lease 行；standalone 保证同文）。

任一 false → **stop**。Phase 1 / Prepare 未完成 → 先完成 Phase 1 或 per-plan Prepare，再进入本 Phase。

## 2.1 Session todos（派发前设护栏）

每个 plan wave 启动前设定 host todos，防止范围漂移：

| Host | 工具 | 最小集合 |
|------|------|---------|
| **Cursor** | `TodoWrite` / CreatePlan todos | 当前 `plan_id`；下一批 gates（implement/QC/**QA gate**）；分支 checkpoint；**仅剩 1 个非 Done plan 时追加 `phase-3-iteration-close`**（open 直至 §3.5）；Phase 4 后 **`phase-5-pr-merge-ready`**（open 直至 §5.5） |
| **Codex** | `update_plan` / Goal UI | 同上 |
| **OpenCode** | host todo/plan UI（如有） | 同上 |

SSOT = `{WORKFLOW_DIR}/<id>/snapshot.json` + `{PLAN_DIR}/`。todos 只追踪本轮下一步。

## 2.2 Read backlog

1. 读 `mstar-artifacts` + workflow snapshot（`{WORKFLOW_DIR}/<id>/snapshot.json`）与根 `status.json`
2. 列出 snapshot 中 `status` ∈ `{Todo, InProgress, InReview, Blocked}` 的 plan（优先级：`InProgress` → `InReview` → `Todo` → unblock `Blocked`）
3. 读 snapshot `branch.base` / `branch.target`，以及 plan `metadata.spec_integration_branch` / `merge_target` / `primary_spec` 链接

## 2.3 Branch anchors + integration branch + integration worktree（Phase 2 入口）

**Branch anchors 解析顺序**（任一环节缺失则 STOP，**禁止**默认 `main`/`master`）：

1. workflow snapshot → `branch.base`（`iteration_base_branch`）、`branch.target`（`target_branch`）、`branch.integration`（`spec_integration_branch`）；plan 行 → `metadata.spec_integration_branch`
2. 若 (1) 缺字段 → 读当前迭代 compass frontmatter 同名键：优先 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`；若无则 legacy `{ITERATION_DIR}/<iteration-id>-delivery-compass.md`
3. 若 compass 有值而 snapshot 无 → **同轮 backfill** snapshot `branch`
4. 仍缺 → 向用户确认 base / PR target；**不得**因 `git symbolic-ref refs/remotes/origin/HEAD` 指向 `main` 就自动采用
5. 所有参与本轮迭代的 active plan **必须**解析到**同一** `spec_integration_branch`；不一致 → **STOP**

**Integration worktree（所有模式 — HARD）**按下方「Integration worktree (Phase 2 entry)」checklist 执行（integration 分支不存在时**必须**从记录的 base 创建，命令见下方）。

**Git 操作（含 `Worktree mode: waived`）**：

1. 在主 checkout 按需 `git fetch` 确认记录的 `iteration_base_branch` 存在；主 checkout 保持记录分支。
2. 用 `git worktree add <integration-path> <spec_integration_branch>` 建立独立 integration checkout；分支不存在时用 `git worktree add -b <spec_integration_branch> <integration-path> <iteration_base_branch>`。
3. `git -C <integration-path> branch --show-current` 确认 integration 分支；后续 merge 仅在该 checkout。waiver 仅豁免每 plan feature worktree 默认，不豁免 integration 协调 checkout；产品写入仍须避开主 checkout 和 integration checkout。

`spec_integration_branch` 是本迭代内所有 plan feature branch 的 merge target。QC **`Review range` / `Diff basis`** 的 merge-base 参照优先用 snapshot `branch.target`（或 PM 书面指定的 base ref），**禁止**无 Assignment 依据写死 `origin/main`。

## Integration worktree (Phase 2 entry) + control root

1. Resolve all active plans' `metadata.spec_integration_branch` to the **same**
   integration branch (STOP if mismatch).
2. Resolve the **control root** = the **primary checkout** (main worktree) via
   Git (`readMainWorktree`); verify its attached branch equals the recorded
   **`Main worktree branch`** from the main plan header and is not owned by any
   non-terminal workflow — mismatch → **STOP** (never switch main; never
   substitute `branch.base`).
3. Create the dedicated **integration worktree**:
   `git worktree add <path> <spec_integration_branch>` (create the branch from
   the recorded base first if absent) — a linked checkout **distinct from the
   main worktree**; never reuse the primary checkout for integration.
4. Verify `git -C <integration> branch --show-current` equals
   `spec_integration_branch`; working tree clean before merge operations.
5. Record canonical absolute repository-root path in the workflow snapshot
   top-level `integration_worktree_path` (not `{HARNESS_DIR}`; canonicalize
   symlinks). The main worktree is **not** recorded in the snapshot — it is
   derived from Git every session.
6. Resolve coordination paths from the **control root** (default-gitignored process artifacts live on the **main-worktree filesystem**, not as Git blobs):
   - status register: `<main-repo-root>/{HARNESS_DIR}/status.json` (v2 root — active workflow entries)
   - snapshot SSOT: `<main-repo-root>/{WORKFLOW_DIR}/<id>/snapshot.json` (plan rows + leases + branch anchors)
   - project register: `<main-repo-root>/{PROJECT_DIR}/<id>/residuals.json`
   - plans SSOT: `<main-repo-root>/{PLAN_DIR}/`
   - iterations SSOT: `<main-repo-root>/{ITERATION_DIR}/`
   - SDD tree: `<main-repo-root>/{HARNESS_DIR}/sdd/<plan-id>/`

All sessions MUST reread the **control-root copy** of the workflow snapshot immediately before
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
used for every coordination mutation** in that Phase 2 session (the snapshot
under the **control root** = the primary checkout / main worktree — waived
included). Agents on **different hosts** or with **no shared flock/lockdir** →
default **`Plan parallelism: serial`** (preferred when waived). **No flock
does not waive** the integration worktree / feature worktree / leases — serial
scheduling only. Assignment still
claiming cross-plan parallel without lock availability → **Blocked** until PM
sets serial scheduling or the user gives current-turn override
`Cross-host lease race: accepted` (or equivalent) + audit on snapshot plan
`notes` / `notes.jsonl`.
**`Worktree mode: waived` alone is not** this override.

Immediately before **any** writable implement dispatch, re-read the control
snapshot and re-verify `execution_lease` holder + paths match this session;
mismatch → **STOP**.

> **Lease Engine-check:** canonical callout lives in `mstar-artifacts` `SKILL.md`（Engine-check lease 行）— this file carries the execution checklist only.

## 2.4 Per-plan loop（直到全部 Done）

**跨 plan 默认**（**无论** `Worktree mode: waived`）：**不同 `plan_id` 可并行 implement** 须满足 §2.0 #5 跨 plan 并行安全闸——(a) coordination 路径 same-host 独占写锁可用且每次 status/协调变更持锁，或 (b) **`Plan parallelism: serial`**（waived 时默认），或 (c) 用户本轮 `Cross-host lease race: accepted` + audit `notes`；否则 Assignment 仍写并行 → **Blocked**。**merge 入 `spec_integration_branch` 仍串行**（snapshot 顶层 `integration_merge_lease`；waived 时无 merge lease 仍须串行 merge）。未 waive 时 **禁止**无 verified `execution_lease` 的跨 plan 可写派发。

对每个本轮要推进的 active `plan_id`（可交错/并行，非强制 plan A 全 Done 再 plan B）：

1. **Claim / resume — execution lease**（§2.0 #5 未 waive）：按下方「Execution lease」claim/resume 规则——同 `holder` → resume（校验 `worktree_path` / `working_branch` 与 Assignment 一致）；异 `holder` → **Blocked**；`InProgress` 无 lease → **STOP** 升级（孤儿恢复 → **`mstar-artifacts`**）；verify 通过前 **禁止**可写派发
2. **Plan start — feature worktree + branch**：创建/校验 dedicated feature worktree（默认 `<repoRoot>/.worktrees/<plan-id>-<slug>`）；Assignment 须含绝对 `Worktree path` + `Working branch`（与 lease 一致）。plan 内多可写并行轨 → **`mstar-branch-worktree`** **`references/parallel-writable-pre-dispatch.md`**
3. **Implement → InReview**（产品编辑在 feature worktree；plans / snapshot / iterations / SDD 经 control root 绝对路径）：
   - **默认 `Execution mode: sdd`**（多 task plan；hotfix 可 `inline`）。
   - PM 载入 **`mstar-sdd`** 后，按依赖与 ownership 派发 **独立 ready tasks 并行** 的 per-task 循环（**不是**一次派发 dev 做全部 tasks）：
     1. `mstar sdd workspace <plan-id>` → `{SDD_DIR}`
     2. `mstar sdd task-brief <plan-file> N` → `{SDD_DIR}/task-N-brief.md`；记录 `BASE_SHA`
     3. Dispatch **one** implementer subagent（`references/implementer-prompt.md`：brief 路径 + report 路径 + `Model tier`；**禁止**贴整份 plan）
     4. Implementer `DONE` → `mstar sdd review-package BASE HEAD` → task diff 文件
     5. Dispatch **one** task reviewer subagent（brief + report + diff + Global Constraints）
     6. Fix loop 直至 review clean；append `{SDD_DIR}/progress.md`；更新 snapshot plan 行 / plan checkbox
     7. 放行已满足依赖的 next task；不等待无依赖任务，PM 独占共享 progress / snapshot 写入
   - 每次 Completion Report 后更新 snapshot（`workflows/<id>/snapshot.json`）+ 主 plan
4. **QC → QA gate**（plan 保持 **`InReview`**；**保留** `execution_lease`）：per-plan 审查链 → **`mstar-sdd`**（L1–L2）+ **`mstar-review-qc/references/review-responsibility-boundaries.md`**（L3 tri / inline 单席；raw reports in `{SDD_DIR}/review/`，durable summary in main plan/snapshot）+ **`QA gate`**（`mandatory` → `qa-engineer`；`pm-acceptance` → PM checklist）。**禁止**在 integration merge 成功前设 `Done` 或删除 `execution_lease`。
5. **Plan complete — serial merge back**（§2.0 #5 未 waive）：自 **integration worktree** claim/resume snapshot 顶层 `integration_merge_lease` → 将 plan feature branch 合并入 `spec_integration_branch`（仅 merge-lease holder；细则 → 下方「Integration merge lease」）→ 记录 merge commit 证据 → 释放 merge lease；**同轮**设 `Done` 并删除 `execution_lease`。merge 失败：保持 `InReview` + 保留 lease，不得标 `Done`。
6. **Cross-plan 进度同步**：更新 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` 的 `## Plans` 表状态列
7. **Next plan / parallel wave** 从步骤 1 继续（可并行推进其他已 claim 的 plan；merge 仍排队串行）

全部 plan `Done` → **Phase transition gate**（见 `mstar-iteration` SKILL.md **Phase transition gates** 表）：

1. **STOP** per-plan loop — 禁止 merge 后继续下一 plan、禁止开 PR、禁止会话结束语。
2. 打印 **`## Phase 3: iteration-close`**。
3. 按 **`references/phase-3-iteration-close.md`** §3.0 起独立执行至 §3.5。final plan 的 Assignment / closure 仅作输入，**不能**替代 Phase 3 gate。

## 2.5 Dispatch-first（implement 派发约束）

派发纪律 SSOT → **`mstar-dispatch-gates`** · **`mstar-sdd`** · **`mstar-host/references/parallel-dispatch.md`**。

**SDD implement（Phase 2 默认）** — PM **已载入 `mstar-sdd`** 后执行：

| 规则 | 说明 |
|------|------|
| 并行 | 独立 ready tasks 各自 fresh implementer + 隔离 worktree；单一 canonical per-plan SDD root 内分离 task artifact 路径，context/progress 仅 PM 串行写；leaf 直接消费不可变绝对路径，不调用共享 context helper；每 task 后一位 fresh reviewer；真实依赖与 merge 串行（`mstar-sdd`） |
| Sticky（可选） | Assignment **`SDD implementer session: sticky`** + `implementer-session.json`；implementer **resume**，reviewer **fresh** — `mstar-sdd/references/sticky-implementer-session.md` |
| 文件交接 | brief / report / diff / `progress.md` 在 `{SDD_DIR}`；dispatch prompt **只给路径**，不贴 plan 全文或 task 历史 |
| Assignment 字段 | 每个 implement dispatch 须含 `Execution mode: sdd`、`SDD dir`、`Model tier`；§2.0 #5 未 waive 时还须含绝对 `Worktree path` + verified `execution_lease`；**禁止**省略 `Model tier` |
| 大包 inline | **禁止**把 T1–Tn 或整份 plan 写进 **一个** `fullstack-dev` leaf Assignment 冒充 SDD |
| 分支 diff | 全部 task 完成后 `mstar sdd review-package MERGE_BASE HEAD` → `{SDD_DIR}/review/` branch diff → plan QC tri（N=3） |

Iteration Phase 2 附加：

- PM **NEVER** 在 PM 线程实现产品代码（delegate dev；hotfix 例外见 **`mstar-phase-gates`**）
- `Subagent invokes issued: 0` 而 Assignment 已写出 → **`dispatch incomplete`**；下一条补发 invoke，禁止 PM 顶替
- QC 初轮：**SDD → N=3**；**inline → N=1**；plan QC tri 三席 **同条消息 N=3**（非 implement 轨数）
- **`Findings cleanup: zero-residual`（默认）**：QC 后可修 Warning/Suggestion → 继续 fix→targeted re-review，直至 clean `Approve` 或仅剩真 blocker-defer；**禁止**把可修项登记为 open residual 草草 `Approve with residuals`

## Feature worktree (per plan)

- Each concurrently active plan uses a **distinct** absolute feature-worktree
  path and dedicated feature branch from `spec_integration_branch`.
- `execution_lease.worktree_path` MUST differ from the main worktree (control
  root) and from snapshot `integration_worktree_path` — never product-edit
  either the primary checkout or the integration checkout.
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
3. Create or verify dedicated feature worktree + branch (default `<repoRoot>/.worktrees/<plan-id>-<slug>`).
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
Recovery semantics → `mstar-artifacts` (not iteration skill).

## Multi-plan parallelism

**Cross-plan parallel safety gate** applies **whether or not** `Worktree mode:
waived` is in effect — waiver does **not** authorize lockless cross-host parallel.

- **Feature implementation** MAY proceed in parallel across **different plan IDs**
  only when **one** of:
  1. Same-host exclusive write lock is available on the coordination
     snapshot path under the **control root** (the primary checkout /
     main worktree — waived included) and used for every coordination
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

1. From the **integration worktree** (`integration_worktree_path`): clean tree; branch = `spec_integration_branch`. Never run the merge from the primary checkout.
2. Under write lock, re-read the snapshot. If `integration_merge_lease` exists:
   - **Same `holder` as this session** → **resume**: verify `plan_id`,
     `source_branch`, `target_branch` match intended merge; confirm integration
     worktree state; continue (not steal/block).
   - **Different `holder`** → **Blocked** (cannot expire or steal).
3. If unclaimed, claim merge lease (same read-check-replace-verify as execution claim).
4. Only merge-lease holder runs integration from `integration_worktree_path`.
5. On success: record merge commit/evidence; delete merge lease; set plan
   **`Done`** and delete `execution_lease` in the same locked update.
6. On conflict/failure: retain leases; plan stays **`InReview`** — do not set
   `Done`. Release merge lease only after the integration worktree is clean and known state.

Execution and merge leases may coexist; merge lease does not grant execution
ownership for the source plan.

## Waiver

Explicit `Worktree mode: waived` (or equivalent user instruction) this turn
waives **only**:

- Per-plan feature worktree defaults. The dedicated integration coordination
  checkout remains required; the primary checkout keeps its recorded branch
  and remains the process-SSOT holder via absolute control-root paths.
- Snapshot lease claim/hold/release defaults (`plans[].execution_lease` and top-level `integration_merge_lease`)

It does **not** waive the **cross-plan parallel safety gate**. Under waiver,
cross-plan **parallel writable** implement still requires same-host exclusive
write lock on the coordination snapshot path, default **`Plan parallelism:
serial`**, or current-turn `Cross-host lease race: accepted` + audit
snapshot plan `notes` / `notes.jsonl`. **Prefer serial scheduling when waived**; parallel under waiver
only with the race-accepted override (or same-host lock when mutating shared
state).

`Plan parallelism: serial` does **not** waive the worktree or lease gates.

Iteration commands MUST NOT infer waiver from missing worktrees or single-session
starts. Explicit override this turn only.
