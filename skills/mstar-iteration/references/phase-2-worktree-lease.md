# Phase 2: Autonomous Execute — per-plan loop + integration worktree + lease

> Loaded by `mstar-iteration` SKILL.md on the **execute / resume** route, and by the Phase 2+ command layer. **Read `mstar-harness-core` first.** Entry = §2.0 五道闸全过；continuous execution / push 纪律（§2.6）的 SSOT 仍在 `mstar-iteration` SKILL.md。

Normative field names → field SSOT
`mstar-artifacts/references/status-and-residuals.md`; the **full lease
protocol prose** (single canonical copy) → `mstar-engine-legacy/references/lease-protocol.md`
(engine-absent fallback). This reference is the **iteration-command execution
checklist** — do not invent alternate lease field names; do not re-state the
full protocol here.

**Scoped primary route**（`/iteration-drive --assignment|--workflow/--plan|--resume`）: this file is the **whole-iteration** execution checklist. On the scoped route every handwritten snapshot / register mutation below is replaced by a frozen `mstar plan …` state verb (which owns the same-host lock) → **`plan-scoped-pm.md`**. The §2.0 gates, per-plan loop, worktree layout and read-only validators still apply; the plan session's finish is a **handoff**, not `Done`.

## When it applies

**Phase 2**（SKILL.md execute/resume route + `iteration-drive` / `iteration-loop`
command layer；`iteration-start` ends before this）. Defaults are **hard** unless the current turn
explicitly waives via Assignment `Worktree mode: waived` (or equivalent user
instruction), within the limited scope in § Waiver; main residency and the
dedicated integration checkout remain mandatory. `Plan parallelism: serial` is **not** a waiver — it only forces
serial cross-plan **implement** scheduling while the worktree + lease gates remain
required.

Phase 1 Review & Edit may edit uncommitted docs on the primary checkout under the Prepare policy (bounded exception; the main worktree never switches branch). The integration-worktree + lease gate
starts at **Phase 2 entry** — Phase 1 did walk §2.3's integration-worktree checklist once at its end (`iteration-start` §6, which carries the `phase-1-lock` marker), but the gate those steps guard opens only when Phase 2's per-plan loop begins.

**Phase scope**：本参考仅约束 **Phase 2**（含 serial integration merge 与「control root / integration worktree 禁止产品编辑 / 每 plan feature worktree」）。**Phase 5** PR merge-ready 修复同样 **不**直接在 integration checkout 上改——产品修复走独立 fix feature worktree，review 后 merge 回 integration worktree → **`phase-4-5-pr-delivery.md`** §5.0。

**本 Phase 定义 per-plan 派发循环的完整流程**：前置条件检查、session todos、backlog 读取、integration 分支管理、per-plan dispatch 循环（分支→实现→QC→**QA gate**→Done→合并）、dispatch-first 约束。PM 读取本 Phase（含 §2.0–§2.5 与下方 lease 细则）即可执行迭代。

**Findings cleanup（默认）**：Phase 2 每个 plan Assignment 默认 **`Findings cleanup: allow-residual`**（open R# 先登记 project register，再离 InReview；各决策面披露 id/severity/跟踪位置；unresolved `critical` 仍阻断 Approve）。compass 或 Assignment 可显式覆写为 `zero-residual`（可修 findings 当轮 fix→re-review 清干净；仅真 blocker-defer + Durable Roadmap 可留 open R#，`critical` 不属 defer）。登记与披露职责 SSOT → **`mstar-artifacts`**「Findings cleanup modes」。

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

每个 plan wave 启动前设定 host session todos，防止范围漂移（具体 todo / plan UI 工具名 → active host reference）：

| 宿主会话 | 工具 | 最小集合 |
|----------|------|---------|
| 任意宿主（有 session todo / plan UI 时） | 宿主自身的 session todo / plan UI | 当前 `plan_id`；下一批 gates（implement/QC/**QA gate**）；分支 checkpoint；**仅剩 1 个非 Done plan 时追加 `phase-3-iteration-close`**（open 直至 §3.5）；Phase 4 后 **`phase-5-pr-merge-ready`**（open 直至 §5.5） |

SSOT = `{WORKFLOW_DIR}/<id>/snapshot.json` + `{PLAN_DIR}/`。todos 只追踪本轮下一步。

Phase/gate 转换时按 **`mstar-host`**「Phase-transition todo refresh (host-agnostic)」刷新：先按 snapshot / plan 证据勾掉已完成条目，保留未决 gate 条目，再追加下一批条目；todos 只是投影，不授权状态转换。

**Scoped route**：todos 是 **plan-local 任务列表**（本 plan 的 task / gate），**不**追加 `phase-3-*` / `phase-4-*` / `phase-5-*` / `phase-6-*`；scoped finish = handoff → **`plan-scoped-pm.md`** §4–§5。

## 2.2 Read backlog

1. 读 `mstar-artifacts` + workflow snapshot（`{WORKFLOW_DIR}/<id>/snapshot.json`）与根 `status.json`
2. 列出 snapshot 中 `status` ∈ `{Todo, InProgress, InReview, Blocked}` 的 plan（优先级：`InProgress` → `InReview` → `Todo` → unblock `Blocked`）
3. 读 snapshot `branch.base` / `branch.target`，以及 plan `metadata.spec_integration_branch` / `merge_target` / `primary_spec` 链接

**Scoped route**：backlog **就是 `bind` 返回的那一行**（`--workflow/--plan` 从 `row.coordination.prepared.assignment_path` 解析）——**禁止**按「第一个未完成 plan」或整迭代优先级列表选择。

## 2.3 Branch anchors + integration branch + integration worktree（Phase 2 入口）

本节的 integration-worktree checklist **也被 Phase 1 路线复用**（`iteration-start` §6）—— 在该路线上它承载 `phase-1-lock` marker，且**不**触发 `phase-2-entry`。

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

<!-- host-hook: phase-1-lock -->
> Execute the active host reference's `## Host hooks` declaration for `phase-1-lock`; this file defines no host action.
>
> 本 anchor 在 **Phase 1 路线**上触发**一次**，且只在本 checklist 走完 push 之后：步骤 3–5 已建立独立的 integration checkout 并记录 `integration_worktree_path`，已 review 的改动在该 checkout 上 commit，`spec_integration_branch` 已 push（Phase 1 的 `iteration-start` §6 复用的就是本 checklist）。Phase 2 resume 走到同一 section 时**不**重新触发，也**不**需要重新调用 —— 该 anchor 已在 Phase 1 完成（精确的重复调用语义与拒绝码 → active host reference）。

### Same-host exclusive write lock

All control-path lease mutations (claim, release, transfer, merge-lease
claim/release) **MUST** run inside a same-host exclusive write lock for the full
read-check-replace-verify sequence. Engine writers acquire the lock
automatically (`writeWorkflowSnapshot` / `registerWorkflow` use
`<status-file dir>/.status-write.lockdir/` — for snapshots the lockdir lands
inside `workflows/<id>/`); when no engine writer is available, prefer the read-only engine-check commands
(`mstar lease verify --workflow <id>`, `mstar worktree check`) over hand-rolled
`flock`, and never substitute them for a mutation verb. The atomic-mkdir alternative (`.status-write.lockdir/` in the same
directory as the file) remains the documented fallback for the whole-iteration
route when no engine writer exists. Do **not** invent a distributed CAS CLI.

**Scoped route (plan-scoped primary).** The lock is **available and required**
here too — but it is **not sufficient**, and the atomic-mkdir / hand-rolled
`flock` fallback above does **not** re-open a manual path on this route. The
lock is acquired **inside** the `mstar plan …` state verbs, which replace every
handwritten snapshot mutation:

| Snapshot mutation | Scoped call（owns the lock） |
| --- | --- |
| execution claim / resume | `mstar plan bind` |
| progress / residual rows | `mstar plan progress` / `residual-add` / `residual-close` |
| plan finish（no ownership change） | `mstar plan handoff` |
| ownership transfer | `mstar plan accept` / `return` |
| integration attempt + atomic completion | `mstar plan integration-start` → Git merge → `integration-accept` → `complete` |
| crash recovery | `mstar plan reconcile` |

Holding this lock, or passing the **read-only** validators (`mstar lease
verify` / `mstar worktree check` — still required), **does not** authorize a raw
snapshot write, `--force`, a takeover, or a manual lease release. Scoped route
details → **`plan-scoped-pm.md`**; field semantics → **`mstar-artifacts/references/status-and-residuals.md`**.

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

<!-- host-hook: phase-2-entry -->
> Execute the active host reference's `## Host hooks` declaration for `phase-2-entry`; this file defines no host action.
>
> 这是 **Phase 2 execute/resume entry**：§2.0 五道闸与 §2.3 的 branch / worktree 解析之后的第一个 Phase 2 动作，位于 per-plan loop 之前。Phase 1 的 `iteration-start` §6 只**复用** §2.3 的 integration-worktree 步骤，**不**触发本 anchor。

## 2.4 Per-plan loop（直到全部 Done）

**跨 plan 默认**（**无论** `Worktree mode: waived`）：**不同 `plan_id` 可并行 implement** 须满足 §2.0 #5 跨 plan 并行安全闸——(a) coordination 路径 same-host 独占写锁可用且每次 status/协调变更持锁，或 (b) **`Plan parallelism: serial`**（waived 时默认），或 (c) 用户本轮 `Cross-host lease race: accepted` + audit `notes`；否则 Assignment 仍写并行 → **Blocked**。**merge 入 `spec_integration_branch` 仍串行**（snapshot 顶层 `integration_merge_lease`；waived 时无 merge lease 仍须串行 merge）。未 waive 时 **禁止**无 verified `execution_lease` 的跨 plan 可写派发。

### Rescheduling checkpoint（主动调度检查点）

<!-- host-hook: rescheduling-checkpoint -->
> Execute the active host reference's `## Host hooks` declaration for `rescheduling-checkpoint`; this file defines no host action.

Phase 2 缺的不是新调度器，而是一个**具名的重新评估时刻** —— `Rescheduling checkpoint` 就是它。本文件是 procedure 的**唯一 home**：**不**新增 scheduler / DAG / 第二 ready-state register，判断仍由 PM 按下列步骤做出，结果只落在 PM 正常 transcript / ledger。

**五个冻结 reason**（checkpoint 触发词；宿主若在 `rescheduling-checkpoint` 锚点声明 receipt，消费的是**同一词汇** —— 该 receipt 只记录「已按本 procedure 评估」的事实 + decision/reason，**不**推断依赖就绪、**不**选择派发；**禁止**自造同义词 —— 锚点契约 → **`mstar-host`**「Host hooks (anchor contract)」）：

| reason | 触发时刻 |
| --- | --- |
| `before-wait` | 进入任何 wait **之前** |
| `result-settled` | 结果落定后：子任务完成、review 返回，或消费已返回结果 |
| `dependency-changed` | 依赖事实变化（例如已审 prerequisite 已进入 dependent 的 assigned base） |
| `ownership-changed` | ownership 事实变化（lease claim / release / transfer、handoff / accept、作用域 holder 变化） |
| `capacity-changed` | 容量事实变化（槽位因完成释放、primary 起停、可选 transport 可用性变化） |

**决策步骤**（每次 checkpoint 按序执行）：

1. **用户 steering 与真实 blocker 优先于**任何调度续行；已返回结果**只消费一次**并判定其 acceptance —— **禁止**把 job completion 当作 accepted work。
2. **确定作用域**：iteration coordinator 同时考虑其**已准备的独立 plan** 与 plan 本地 task；scoped plan primary 只考虑**自己的 tasks**（`plan-scoped-pm.md`）。任一方都**不得**把自己提升为对方的权限。
3. **排除不可派发项**：已派发 / 已有 owner / 已终结 / 未准备 / 契约已漂移 / 真依赖未满足。prerequisite 仅在**已审 / 已接受 commit 进入 dependent task 的 assigned base** 时才满足（`mstar-sdd` § Dependent-task readiness）。活动 Assignment 的 scope 与 `BASE_SHA` **不可变**；**仅未派发**工作可 re-split / 重排，且依赖 / 接口变化须在派发前写回。
4. **对剩余有用工作套用约束**：当前用户 / plan 的 serial 策略、task 容量、plan-primary 容量、engine scope / revision / lease 校验、same-host 锁与 L1/L2 隔离（首段 §2.0 #5）。**成立的具体串行边**：共享文件 / session / ledger、缺集成接口；**不成立**：task 编号、无关的 QC / QA。
5. **启动完整已授权 ready batch**：默认传输是**原生 background task** —— transport 被禁用 / 不可用**不**关闭 task 并发；已准备的独立 plan 可走条件性 primary transport。只有 coordinator 的 integration merge 串行。
6. **没有有用且已授权动作 → native wait 一次**，并写下真实 wait reason：`dependency` / `ownership` / `capacity` / `user-blocked` / `no-ready-work`。

**结果记录**：正常 PM transcript / ledger 的一行即可 —— checkpoint reason、考虑过的作用域、已派发 ID 或具体 wait / block reason。**禁止**：重复完成投递、tick 计数、「still waiting」报告、对**不变的空 ready 集合**反复自证或重跑同一推理、为保持忙碌而造工作、timer / 轮询循环。等待是合法结论 —— 同一组未变事实**只陈述一次**；只有新事实（显式用户消息、新的已接受结果、dependency / ownership / capacity 观察变化）才重新打开 checkpoint，「turn 结束」不是理由。

**checkpoint 不放宽任何既有安全条件**：

- 原生 background task 仍是默认 task 传输；额外 primary 是可选 plan 级工具，只受其自身配置 gate。
- `ctx.isIdle()` 仅表示未在流式输出，**不**代表没有未落定的 task / bash / eval job 或 plan primary；native adaptive wait 与 completion delivery 仍由宿主控制，**禁止**自建轮询替代。
- lease / revision / ownership 语义不变：**禁止**重复 owned / running / completed 工作、偷 lease、改活动 base；pane idle / age / 终端标签**不是** ownership 或完成依据（§ Execution lease · Hold, release, override）。
- integration merge 入 `spec_integration_branch` 仍**串行**；跨 plan 并行仍受本节首段跨 plan 安全闸约束。
- `execution_policy` 取值（如 `serial`）是 accepted-but-opaque：**禁止**描述为引擎强制的线性调度器；实际策略从当前用户 / plan 推导，并保留显式 serial 约束。

对每个本轮要推进的 active `plan_id`（**可交错 / 并行**是默认读法：非强制 plan A 全 Done 再 plan B，plan 编号或 task 编号本身都不是串行理由）：

1. **Claim / resume — execution lease**（§2.0 #5 未 waive）：按下方「Execution lease」claim/resume 规则——同 `holder` → resume（校验 `worktree_path` / `working_branch` 与 Assignment 一致）；异 `holder` → **Blocked**；`InProgress` 无 lease → **STOP** 升级（孤儿恢复 → **`mstar-artifacts`**）；verify 通过前 **禁止**可写派发。**Scoped route**：fresh claim 的唯一入口是 `mstar plan bind`（`--assignment` / `--workflow --plan`）——同 plan 的第二个 fresh 形态 → `coordination.duplicate-holder`；续接只经 `mstar plan bind --resume`，且为**只读校验**（不重新获取 ownership、不重启执行、不改 revision；无自动 attach / fallback plan / TTL 夺取）。
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
   - **整迭代路线**：每次 Completion Report 后更新 snapshot（`workflows/<id>/snapshot.json`）+ 主 plan。**Scoped route**：每次 Completion Report 后的 row 更新只经 `mstar plan progress --session <plan-session> --file <abs-json> --expect <revision>`（仅 `InProgress` / `InReview` / `Blocked` 子集；**禁止** `Todo` / `Done` / lease 删除）；leaf 与 plan 会话**不得**直接写 snapshot / 根 register。
4. **QC → QA gate**（plan 保持 **`InReview`**；**保留** `execution_lease`）：per-plan 审查链 → **`mstar-sdd`**（L1–L2）+ **`mstar-review-qc/references/review-responsibility-boundaries.md`**（L3 tri / inline 单席；raw reports in `{SDD_DIR}/review/`，durable summary in main plan/snapshot）+ **`QA gate`**（`mandatory` → `qa-engineer`；`pm-acceptance` → PM checklist）。**禁止**在 integration merge 成功前设 `Done` 或删除 `execution_lease`。**Scoped route**：QA 证据齐备后的写点是 `mstar plan handoff --session <plan-session> --file <abs-json> --expect <revision>`，随后 **STOP**（row 保持 `InReview`、保留 lease）——`Done` 与 lease 释放不是 plan 会话的动作。
5. **Plan complete — serial merge back**（§2.0 #5 未 waive；**整迭代路线**，语义未变 —— scoped route 见紧随其后的冻结序列，plan 会话不得执行本步骤）：自 **integration worktree** claim/resume snapshot 顶层 `integration_merge_lease` → 将 plan feature branch 合并入 `spec_integration_branch`（仅 merge-lease holder；细则 → 下方「Integration merge lease」）→ 记录 merge commit 证据 → 释放 merge lease；**同轮**设 `Done` 并删除 `execution_lease`（此即 owner 的 lease 释放动作），并在**同一 locked update** 内把 `metadata.working_branch` / `metadata.worktree_path` 持久化到该 plan 行（归属生产者义务；语义唯一 home → `mstar-branch-worktree`「Worktree / branch cleanup」Ownership）。merge 失败：保持 `InReview` + 保留 lease，不得标 `Done`。merge 成功即打开该 plan 的**同轮 cleanup 资格**（timing lane 1 → 下方「Same-round plan cleanup」）。

   **Scoped route（冻结调用序列 — 取代上面的手工步骤；仅 coordinator 席位执行）**：

   1. `mstar plan accept --session <coordinator-session> --plan <id> --handoff <id> --expect <revision>` — 所有权移交（`submitted → accepted`；**不是**合并验收，worktree/branch 不变）。
   2. `mstar plan integration-start --session <coordinator-session> --plan <id> --handoff <id> --expect <revision>` — 在干净、检出 `snapshot.branch.integration` 的 integration checkout 上固定 `base_sha` + source pin，且**先于** Git；拒绝外来 merge lease。
   3. **coordinator 显式执行唯一 Git 动作**（参数数组、字符串直传、不拼接 shell）：`git -C <integration-worktree-path> merge --no-ff --no-edit <pinned-source-sha>` — 无 squash / rebase / 按分支名合并；CLI 状态动词**从不**代跑 merge。
   4. `mstar plan integration-accept …` → `mstar plan complete …` — 验证证据后**一次原子完成**：`status: Done`、保留 `metadata.working_branch` / `metadata.worktree_path` 与既有 track branches、删除该行 `execution_lease` **与** coordinator 的 `integration_merge_lease`。

   **Plan 会话不执行以上任何一步**（`accept` / `integration-*` / `complete` 对 plan session 被拒绝）。失败恢复**只用** `mstar plan reconcile --session <coordinator-session> --plan <id> --handoff <id> --expect <revision>`：回退到 `accepted` + 释放本次 merge lease（`retry-ready`）／已具备唯一合并证据则补记证据并原子完成（`completed`，**不重复 merge**）；`integrating` 且存在 `MERGE_HEAD`、冲突或脏树 → `coordination.integration-unresolved`，全部状态与 lease 保留；无法证明的图 → `coordination.integration-diverged`。**禁止**传调用方成功标志、**禁止**重复 merge。
6. **Cross-plan 进度同步**：更新 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` 的 `## Plans` 表状态列
7. **Next plan / parallel wave** 从步骤 1 继续（可并行推进其他已 claim 的 plan；merge 仍排队串行）

全部 plan `Done` → **Phase transition gate**（见 `mstar-iteration` SKILL.md **Phase transition gates** 表）：

1. **STOP** per-plan loop — 禁止 merge 后继续下一 plan、禁止开 PR、禁止会话结束语。
2. 打印 **`## Phase 3: iteration-close`**。
3. 按 **`references/phase-3-iteration-close.md`** §3.0 起独立执行至 §3.5。final plan 的 Assignment / closure 仅作输入，**不能**替代 Phase 3 gate。

### Same-round plan cleanup（timing lane 1；merge 成功同轮）

integration merge 成功且 plan 行 `Done`、`execution_lease` 已删除的**同一轮**，即可回收该 plan/track 的 feature worktree + 已合并分支 —— **父迭代仍在运行不影响资格**：不存在「父须终结」的一刀切，这是 cleanup 的明确设计而非遗漏。命令与守卫契约本体（ownership、合并证据、refusals、apply 顺序）→ **`mstar-branch-worktree`**「Worktree / branch cleanup」（唯一 home；本节只放 call site）：

```text
mstar worktree cleanup --workflow <id> [--harness <path>] [--apply] [--worktree <path>]
```

- 先 dry-run 看 `verdict | kind | ref | reason`（merge 刚完成 → 该 Done 行 eligible）；`--apply` 才变更。lane 1 只清**本地面**（无 `--remote`；远端残留留给 Phase 6）。
- 分支可能仍被该 Done-child worktree 检出 → apply 内部先移 worktree，再 re-probe / re-plan 删分支（**worktree 移除 ≠ 分支删除**；细则 → 契约本体）。
- **lease 释放不在 cleanup 范围内，scoped route 也没有手工释放动作**：scoped route 由 coordinator 的 `mstar plan complete` 在**一次原子写入**中同时删除该行 `execution_lease` 与 `integration_merge_lease`；整迭代路线仍是步骤 5 的 owner 同轮 `Done` + 删 lease（未变）。cleanup **从不**替 owner 释放任何 lease，也**不**依赖已删除的 lease 判断归属（归属由保留的行 `metadata.working_branch` / `metadata.worktree_path` 与 track Assignments 追溯）。standalone plan（无 integration）以 `branch.target` 为证据 base，且须**先 terminal close**。
- **禁止**为让 cleanup 通过而推进/终结父迭代或改 snapshot 状态；受保护行保持 `refuse` 是正确行为，不是失败。

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
- **`Findings cleanup: allow-residual`（默认）**：open R# 先登记 project register，且各决策面披露（清单 + severity + 跟踪位置；close 面另含 blocker-defer 标记），`Approve with residuals` 仅当无 unresolved `critical`；`zero-residual` 仍为显式 opt-in —— QC 后可修 Warning/Suggestion → fix→targeted re-review 直至 clean `Approve` 或仅剩真 blocker-defer（`critical` 不属 defer —— 定义与登记/披露职责 → **`mstar-artifacts`**「Findings cleanup modes」）

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

**Scoped route — fresh bind:** steps 1–6 are executed **inside** `mstar plan bind`
(`--assignment` / `--workflow --plan`) under its own lock — no handwritten
complete-file update and no hand-rolled atomic replace. A second **fresh** bind
on a row already held → `coordination.duplicate-holder` (with the active holder,
workflow and plan).

**Scoped route — `--resume`:** `mstar plan bind --resume` is **read-only** and is
the only continuation path for the original session: it validates the pinned
binding (the current session plus lease `worktree_path` / `working_branch`) and
continues — it never re-runs step 5, never re-acquires ownership, never restarts
execution and never changes the row revision. It may report handed-off /
accepted / completed context read-only, and a released lease is never
reacquired. Cross-primary references are **absolute control-root paths**
(`local://` is not a portable handoff address).

### Hold, release, override

- Lease stays active across `InProgress` and `InReview` (including post-QC/QA
  ready-to-merge) unless released or transferred. **Scoped route:** a plan
  session's normal exit is `mstar plan handoff` — it **keeps** the lease and the
  row stays `InReview`; a lease is never dropped at handoff.
- Normal release: re-read the control snapshot under write lock; confirm stored `holder` matches
  this session — mismatch → **Blocked**; then **delete** `execution_lease`
  (never `null` or tombstone). **Scoped route:** there is **no standalone
  release verb** — release happens only inside a state verb: `mstar plan accept`
  / `return` (ownership transfer) or `mstar plan complete` (deletes
  `execution_lease` **and** the coordinator's `integration_merge_lease` in one
  atomic write).
- `Done` authority deletes `execution_lease` in the same update as `status: "Done"`
  — **only after** successful integration merge (when lease gate not waived).
  **Scoped route:** that authority is the coordinator's `mstar plan complete`
  (after `integration-accept`, whose pinned verified Git result proves the
  merge); the plan session **cannot** set `Done` or delete a lease.
- Override of another holder requires **explicit user instruction this turn** +
  audit note on snapshot plan `notes` / `notes.jsonl` (prior holder, new holder/release, user authorized).
  **Scoped route:** there is **no** `--force`, takeover, or automatic abandonment
  flag; an abandoned active owner needs explicit human recovery outside these
  commands.
- V1: **manual release only** — no `expires_at`, TTL, or heartbeat authority.
  **Scoped route:** no pane-state, idle, TTL, or terminal-label basis for
  releasing or stealing a lease.

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

**Scoped route:** steps 1–6 are the **coordinator's** `mstar plan
integration-start` → explicit Git merge → `integration-accept` → `complete`
(§2.4 step 5). `integration-start` pins `base_sha` + the source pin **before**
Git runs and refuses a foreign merge lease; `reconcile` is the **only** recovery
verb (never a caller-supplied success flag, never a second merge). A plan
session can neither claim, resume, nor release this lease.

Execution and merge leases may coexist; merge lease does not grant execution
ownership for the source plan.

## Waiver

Explicit `Worktree mode: waived` (or equivalent user instruction) this turn
waives **only**:

- Per-plan feature worktree defaults. The dedicated integration coordination
  checkout remains required; the primary checkout keeps its recorded branch
  and remains the process-SSOT holder via absolute control-root paths.
- Snapshot lease claim/hold/release defaults (`plans[].execution_lease` and top-level `integration_merge_lease`) — **scoped route 不可豁免**：该路线本就不做手工 lease 写入（只经 `mstar plan …`），waiver 也不解除其 CLI 前置（CLI 缺失 → fail closed）

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
