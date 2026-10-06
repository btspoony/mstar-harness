# Phase 2: Autonomous Execute — per-plan loop + integration worktree + lease

> Loaded by `mstar-iteration` SKILL.md on the **execute / resume** route, and by the Phase 2+ command layer. **Read `mstar-harness-core` first.** Entry = §2.0 五道闸全过；continuous execution / push 纪律（§2.6）的 SSOT 仍在 `mstar-iteration` SKILL.md。

Normative field names → field SSOT
`mstar-artifacts/references/status-and-residuals.md`; the **full lease
protocol prose** (single canonical copy) → `mstar-engine-legacy/references/lease-protocol.md`
(engine-absent fallback). This reference is the **iteration-command execution
checklist** — do not invent alternate lease field names; do not re-state the
full protocol here.

**Scoped primary route**（`/iteration-drive --assignment|--workflow/--plan|--resume`）: this file is the **whole-iteration** execution checklist. Both routes use public `mstar plan …` / `mstar workflow …` verbs, never handwritten state mutations. ACTIVE uses session reference + full scope execution token + operation id under an independently acquired identity; pre-activation uses session envelope + row revision → **`plan-scoped-pm.md`**. The plan session finishes with **handoff**, not `Done`.

Normal scoped transition: PM/coordinator runs the intended public plan verb under its own identity and reads the applied/partial/replay receipt. Do not force a separate state-repair, rebind or token-copy step when the authority derives its projection and composes entailed bookkeeping. An unresolved foreign holder, ambiguous target or authorization gap is action-local: name the missing fact and continue independent ready work. The leaf receives only paths/scope, never session credentials.

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

**Findings cleanup（默认）**：Phase 2 Assignment 默认 **`Findings cleanup: allow-residual`**；open finding 先经 `mstar plan issue-add` 捕获为 store issue，再离 InReview，并披露 id / issue severity / 跟踪位置。`zero-residual` 为显式 opt-in；清理与披露权威 → **`mstar-artifacts`**「Findings cleanup modes」。project register 无条件退役为迁移历史。

## 2.0 前置条件（五道闸）

进入 Autonomous Execute 前必须满足：

1. ACTIVE `execution_plans` 至少一条 plan `status` ≠ `Done`，且 `execution_registry` 含该 iteration（经 `mstar status validate` / `mstar plan show` 读取）；仅 pre-activation / engine-absent 回退读取 snapshot 与根 `status.json`
2. **Pre-implement gate = GO**：plan 已 locked、tasks ready（见 `mstar-phase-gates`）
3. 用户意图为 **continue Autonomous Execute**（推进迭代 Execute、继续 per-plan 循环等）
4. **Branch metadata gate**：当前权威 workflow `branch.base` / `branch.target` 已登记，且至少一条 active plan 有 `metadata.spec_integration_branch`；缺失处理见 §2.3。**缺失 → STOP**，不得默认 `main`/`master`。
5. **Worktree + lease defaults**（waiver 见下方）：确认 control root（主 checkout，驻留于记录的 **`Main worktree branch`**）并建立独立 integration worktree。ACTIVE 状态、session、冻结执行输入与 lease 经公共动词读写 control `{HARNESS_DIR}/store.db`（`execution_leases` / `execution_integration_leases`）；仍存活的 authored plans / assignments / iteration package、SDD 与 append-only `notes.jsonl` 用绝对 control 路径。未 waive 时可写派发前须有效 claim。Assignment 须含绝对 feature **`Worktree path`** 与 control **`Plan Path`** / **`SDD dir`**。缺少 feature 中的 gitignored plans 不产生 waiver；`Plan parallelism: serial` 只限制调度，不豁免本闸。

> **Engine-check（lease verify / verify-integration）唯一规范体：** `mstar-artifacts` `SKILL.md`（Engine check lease 行；standalone 保证同文）。

任一 false → **stop**。Phase 1 / Prepare 未完成 → 先完成 Phase 1 或 per-plan Prepare，再进入本 Phase。

## 2.1 Session todos（派发前设护栏）

每个 plan wave 启动前设定 host session todos，防止范围漂移（具体 todo / plan UI 工具名 → active host reference）：

| 宿主会话 | 工具 | 最小集合 |
|----------|------|---------|
| 任意宿主（有 session todo / plan UI 时） | 宿主自身的 session todo / plan UI | 当前 `plan_id`；下一批 gates（implement/QC/**QA gate**）；分支 checkpoint；**仅剩 1 个非 Done plan 时追加 `phase-3-iteration-close`**（open 直至 §3.5）；Phase 4 后 **`phase-5-pr-merge-ready`**（open 直至 §5.5） |

SSOT = ACTIVE store.db 执行行 + `{PLAN_DIR}/` authored plans；pre-activation 才使用 snapshot 文件。todos 只追踪本轮下一步。

Phase/gate 转换按 **`mstar-host`**「Phase-transition todo refresh (host-agnostic)」刷新；依据当前权威行与 plan 证据勾掉完成项，保留未决 gate 并追加下一批。todos 只是投影，不授权转换。

**Scoped route**：todos 是 **plan-local 任务列表**（本 plan 的 task / gate），**不**追加 `phase-3-*` / `phase-4-*` / `phase-5-*` / `phase-6-*`；scoped finish = handoff → **`plan-scoped-pm.md`** §4–§5。

## 2.2 Read backlog

1. 读 `mstar-artifacts`；ACTIVE 经 `mstar status validate` / `mstar plan show` 读取执行行与 DB 根 register，pre-activation 才读 snapshot / `status.json`
2. 列出当前权威 `status` ∈ `{Todo, InProgress, InReview, Blocked}` 的 plan（优先级：`InProgress` → `InReview` → `Todo` → unblock `Blocked`）
3. 读 workflow `branch.base` / `branch.target` 与 plan `metadata.spec_integration_branch` / `merge_target` / `primary_spec`

**Scoped route**：backlog **就是 `bind` 返回的那一行**（`--workflow/--plan` 从 `row.coordination.prepared.assignment_path` 解析）——**禁止**按「第一个未完成 plan」或整迭代优先级列表选择。

## 2.3 Branch anchors + integration branch + integration worktree（Phase 2 入口）

本节的 integration-worktree checklist **也被 Phase 1 路线复用**（`iteration-start` §6）—— 在该路线上它承载 `phase-1-lock` marker，且**不**触发 `phase-2-entry`。

**Branch anchors 解析顺序**（任一环节缺失则 STOP，**禁止**默认 `main`/`master`）：

1. ACTIVE workflow 执行行 → `branch.base` / `branch.target` / `branch.integration`；plan 行 → `metadata.spec_integration_branch`（pre-activation：snapshot 对应字段）
2. 若缺字段 → 读当前 compass frontmatter 同名键：优先 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`，否则 legacy flat compass
3. compass 有值而当前权威无值 → 经受守卫公共 workflow 动词处理（Prepare 注册/修订见 Phase 1 §1.5）；没有合法修订路径则升级，不手写 DB 或 snapshot。仅 pre-activation / engine-absent 文件路由才可按其协议 backfill snapshot `branch`
4. 仍缺 → 向用户确认 base / PR target；**不得**因 `git symbolic-ref refs/remotes/origin/HEAD` 指向 `main` 就自动采用
5. 所有参与本轮迭代的 active plan **必须**解析到**同一** `spec_integration_branch`；不一致 → **STOP**

**Integration worktree（所有模式 — HARD）**按下方「Integration worktree (Phase 2 entry)」checklist 执行（integration 分支不存在时**必须**从记录的 base 创建，命令见下方）。

**Git 操作（含 `Worktree mode: waived`）**：

1. 在主 checkout 按需 `git fetch` 确认记录的 `iteration_base_branch` 存在；主 checkout 保持记录分支。
2. 用 `git worktree add <integration-path> <spec_integration_branch>` 建立独立 integration checkout；分支不存在时用 `git worktree add -b <spec_integration_branch> <integration-path> <iteration_base_branch>`。
3. `git -C <integration-path> branch --show-current` 确认 integration 分支；后续 merge 仅在该 checkout。waiver 仅豁免每 plan feature worktree 默认，不豁免 integration 协调 checkout；产品写入仍须避开主 checkout 和 integration checkout。

`spec_integration_branch` 是本迭代 plan feature branch 的 merge target。QC merge-base 参照优先用当前权威 workflow `branch.target`（ACTIVE：执行行；pre-activation：snapshot；或 PM 书面指定 base），不无依据写死 `origin/main`。

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
5. 经 `mstar workflow integration-worktree` 记录 canonical absolute repository-root
   `integration_worktree_path` 到 ACTIVE workflow 执行行（pre-activation：
   snapshot 顶层字段；形状以 help 为准）。主 worktree 由 Git 派生，不是该字段。
6. 从 **control root** 解析协调面：
   - ACTIVE authority: `<main-repo-root>/{HARNESS_DIR}/store.db`（root register、workflow / plan、session、冻结输入及两类 lease）
   - authored plans: `<main-repo-root>/{PLAN_DIR}/`
   - authored iteration package: `<main-repo-root>/{ITERATION_DIR}/`
   - SDD tree: `<main-repo-root>/{HARNESS_DIR}/sdd/<plan-id>/`
   - retained append-only notes: `<main-repo-root>/{WORKFLOW_DIR}/<id>/notes.jsonl`
   - pre-activation / engine-absent only: root `status.json` / workflow `snapshot.json` / session envelopes；ACTIVE 读写被拒
   - project `residuals.json` 无条件退役为迁移历史；findings 权威始终是 store issues
7. **Phase 1 route — push the branch.** Push the newly created
   `spec_integration_branch` (`git push -u origin <branch>` — upstream setup
   only). Phase 1 writes only default-gitignored paths: compass / plans / the
   `<iteration-id>/` package; the global `{SPECS_DIR}` is written at Phase 3
   iteration-close promotion (`phase-3-iteration-close.md` §3.5) and joins the
   integration branch with the close commit. The branch
   tip stays at the recorded base, so the pushed remote tip equals the live
   integration HEAD — the readiness fact the `phase-1-lock` anchor below
   re-checks. The primary checkout keeps its uncommitted Phase 1 docs, never
   switches branch, and carries no docs or unrelated user changes into the
   integration worktree (Phase-1 bounded exception → `phase-1-prepare.md`
   §1.6).
   **Every Phase 2 entry — first execute and resume alike, including the first
   entry after an auto-continued Phase 1 (which has already pushed the branch)
   — never repeats this push**: verify the checkout instead (branch =
   `spec_integration_branch`, clean tree, remote tip already equal to the live
   integration HEAD), do **not** push again here, and do **not** repeat the
   `phase-1-lock` anchor below — its binding is terminal by then (repeat-call
   semantics and refusal codes → active host reference). On the Phase 1 route the
   anchor instead requires that pushed remote tip to equal the live integration
   HEAD, so it must not be executed before this step's push.

ACTIVE 公共动词通过 `withExecutionTransaction` 在 SQLite 事务内重读当前状态与 lease，并检查执行令牌；仅 pre-activation 文件路由须在 claim / release / transfer / 状态转换前重读 control-root snapshot。

**Do not** set `Worktree mode: waived` because a feature worktree lacks
`plans/` under default gitignore — keep feature worktrees and pass absolute
control **`Plan Path`** / **`SDD dir`** in Assignments
(`mstar-branch-worktree` 「Harness path SSOT under default gitignore」).

<!-- host-hook: phase-1-lock -->
> Execute the active host reference's `## Host hooks` declaration for `phase-1-lock`; this file defines no host action.
>
> **`phase-1-lock` 恰好触发一次**：只在 **Phase 1 路线**、且在 checklist **step 7 的 branch push**（`git push -u` 新建的 `spec_integration_branch`；Phase 1 的写入目标均为 gitignored 本地工件，全局 `{SPECS_DIR}` 在 Phase 3 提升时写入）之后 —— 该 anchor 的就绪合取要求已 push 的 remote tip 等于 live integration HEAD，因此**不得**在 step 7 之前执行。此后任何**再次走过 §2.3 的路线**（Phase 2 entry 首次 execute 或 resume，包括 auto-continue 进入的第一次 Phase 2 entry）都**不**触发它：那时 binding 已 terminal，也**不**需要重新调用（精确的重复调用语义与拒绝码 → active host reference）。

### Coordination transactions（ACTIVE）与 pre-activation 文件锁

ACTIVE 的并发安全由 control `store.db` 的 SQLite 事务（`withExecutionTransaction`）+ scope execution-token CAS + `execution_leases` / `execution_integration_leases` 仲裁。所有状态写点只经公共动词；不以 snapshot 路径的 flock / lockdir 作为 ACTIVE 安全证明。

仅 **pre-activation / engine-absent** 文件路由使用 same-host exclusive lock 覆盖 read-check-replace-verify；engine file writers 自动获取 `.status-write.lockdir/`，engine-absent 档案协议 → `mstar-engine-legacy/references/lease-protocol.md`。文件锁不重开 scoped 手写状态通道。

| 状态动作 | 公共动词 |
| --- | --- |
| execution claim / resume | `mstar plan bind` |
| progress / finding capture / closure | `mstar plan progress` / `mstar plan issue-add` / `mstar issue close`（或 `waive` / `duplicate` / `supersede`） |
| plan finish（保留 lease） | `mstar plan handoff` |
| ownership transfer | `mstar plan accept` / `return` |
| integration + atomic completion | `mstar plan integration-start` → Git merge → `integration-accept` → `complete` |
| crash recovery | `mstar plan reconcile` |

只读 `mstar lease verify` / `mstar worktree check` 不授权 raw 状态写入、force、takeover 或手工 lease 删除。传输与 scope → **`plan-scoped-pm.md`**；字段权威 → **`mstar-artifacts/references/status-and-residuals.md`**。

**Cross-plan parallel hard gate**（包括 waived）：ACTIVE 经同一 control DB 的事务 / token 仲裁，且依赖、写所有权与 worktree 隔离成立、每个未 waive plan 持有效独立 lease，才可并行；跨 host 不以“无共享 flock”自动改 serial，也不得绕过 DB 仲裁。pre-activation 必须共享 same-host 文件锁，否则默认 **`Plan parallelism: serial`**；当前轮显式接受文件路由 race 时仅在 `notes.jsonl` 追加审计，不双写 snapshot notes。waiver 本身不是 race 授权。integration merge 始终串行。

每次可写 implement 派发前，经所属 authority 读取并验证 lease holder + paths 与本会话相符；mismatch → **STOP**。

> **Lease Engine-check:** canonical callout lives in `mstar-artifacts` `SKILL.md`（Engine-check lease 行）— this file carries the execution checklist only.

<!-- host-hook: phase-2-entry -->
> Execute the active host reference's `## Host hooks` declaration for `phase-2-entry`; this file defines no host action.
>
> 这是 **Phase 2 execute/resume entry**：§2.0 五道闸与 §2.3 的 branch / worktree 解析之后的第一个 Phase 2 动作，位于 per-plan loop 之前。Phase 1 的 `iteration-start` §6 只**复用** §2.3 的 integration-worktree 步骤，**不**触发本 anchor。

## 2.4 Per-plan loop（直到全部 Done）

**跨 plan 默认**（包括 waived）：依照上文 **Cross-plan parallel hard gate** 判定；ACTIVE 由 DB 事务 / token / lease 仲裁，pre-activation 才是共享文件锁或 serial / 显式 race 接受。**merge 始终串行**。

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

1. **Claim / resume — execution lease**（§2.0 #5 未 waive）：按下方 **Execution / integration lease checklist** 校验 holder / paths；fresh claim 只经 `mstar plan bind`（ACTIVE：`--execution --workflow <id> --plan <id> --expect <plan-execution-token> --operation <id>`；pre-activation：Assignment / workflow-plan 地址）。第二个 fresh bind 拒 duplicate-holder；原会话只读 resume（ACTIVE：`--execution --resume-ref <wire>`；pre-activation：`--resume`），不重新 claim、不更改状态、不当作 recovery。外来 holder 或 orphan InProgress 不授权可写派发；恢复 → `mstar-artifacts`。
2. **Plan start — feature worktree + branch**：创建/校验 dedicated feature worktree（默认 `../<repo>.worktrees/<plan-id>-<slug>`，相对于 Git top-level 的 realpath，`<repo>` 为仓库 basename）；Assignment 须含绝对 `Worktree path` + `Working branch`（与 lease 一致）。plan 内多可写并行轨 → **`mstar-branch-worktree`** **`references/parallel-writable-pre-dispatch.md`**
3. **Implement → InReview**（产品编辑在 feature worktree；authored plans / iterations / SDD 经绝对 control 路径；执行状态经公共动词）：
   - **默认 `Execution mode: sdd`**（多 task plan；hotfix 可 `inline`）。
   - PM 载入 **`mstar-sdd`** 后，按依赖与 ownership 派发 **独立 ready tasks 并行** 的 per-task 循环（**不是**一次派发 dev 做全部 tasks）：
     1. `mstar sdd workspace <plan-id>` → `{SDD_DIR}`
     2. `mstar sdd task-brief <plan-file> N` → `{SDD_DIR}/task-N-brief.md`；记录 `BASE_SHA`
     3. Dispatch **one** implementer subagent（`references/implementer-prompt.md`：brief 路径 + report 路径；**禁止**贴整份 plan）
     4. Implementer `DONE` → `mstar sdd review-package BASE HEAD` → task diff 文件
     5. Dispatch **one** task reviewer subagent（brief + report + diff + Global Constraints）
     6. Fix loop 直至 review clean；append `{SDD_DIR}/progress.md`；经 `mstar plan progress` 更新权威行并更新 authored plan checkbox
     7. 放行已满足依赖的 next task；不等待无依赖任务，PM 独占共享 progress，状态只经公共动词
   - **两条路线**：每次 Completion Report 后的 row 更新只经 `mstar plan progress`（ACTIVE：session reference + 完整 plan token + operation id；pre-activation：session envelope + revision），并更新主 plan。只允许 `InProgress` / `InReview` / `Blocked` 子集；不授权 `Todo` / `Done` / lease 释放或字段移除，也不手写 snapshot / 根 register。
4. **QC → QA gate**（plan 保持 **`InReview`**；**保留** `execution_lease`）：per-plan 审查链 → **`mstar-sdd`**（L1–L2）+ **`mstar-review-qc/references/review-responsibility-boundaries.md`**（L3 tri / inline 单席；raw reports in `{SDD_DIR}/review/`，durable summary in main plan/snapshot）+ **`QA gate`**（`mandatory` → `qa-engineer`；`pm-acceptance` → PM checklist）。**禁止**在 integration merge 成功前设 `Done` 或释放 / 移除 `execution_lease`。**Scoped route**：QA 证据齐备后的写点是 `mstar plan handoff`（active：`--session-ref <plan-wire> --file <abs-json> --expect <plan-execution-token> --operation <id>`；pre-activation：`--session <plan-session> --file <abs-json> --expect <revision>`），随后 **STOP**（row 保持 `InReview`、保留 lease）——`Done` 与 lease 释放不是 plan 会话的动作。
5. **Plan complete — serial merge back**：两条路线均由 coordinator 执行以下公共动词序列；从 integration worktree 固定 merge attempt，merge 失败保持 `InReview` + lease，不标 `Done`。成功经 `mstar plan complete` 原子设置 Done、持久化工作分支 / worktree metadata，并处置两类 lease：ACTIVE 经 `applyCompletionFrame` 在同一原子 DB 事务内**释放**（release）execution lease 与 integration merge lease；UPDATE 保留 `status: released` tombstone、revision、owner epoch 与释放证据，公共 view 仍返回 released 行供审计读回；pre-activation / engine-absent 文件协议才在动词内部移除 snapshot 中的 lease 字段。同轮打开 cleanup 资格。plan 会话不得执行此步骤。

   **Coordinator 序列**。每一写点使用当前 scope 的 CAS：ACTIVE `--session-ref <coordinator-wire> --expect <完整执行令牌> --operation <id>`；pre-activation `--session <coordinator-session> --expect <revision>`。完整形状 → **`plan-scoped-pm.md`** §6。

   1. `mstar plan accept …` — 所有权移交（`submitted → accepted`；**不是**合并验收，worktree/branch 不变）。
   2. `mstar plan integration-start …` — 在干净、检出当前权威 `branch.integration` 的 integration checkout 上固定 `base_sha` + source pin，且**先于** Git；拒绝外来 merge lease。
   3. **coordinator 显式执行唯一 Git 动作**（参数数组、字符串直传、不拼接 shell）：`git -C <integration-worktree-path> merge --no-ff --no-edit <pinned-source-sha>` — 无 squash / rebase / 按分支名合并；CLI 状态动词**从不**代跑 merge。
   4. `mstar plan integration-accept …` → `mstar plan complete …` — 验证证据后**一次原子完成**：`status: Done`、保留 `metadata.working_branch` / `metadata.worktree_path` 与既有 track branches；ACTIVE 在同一 DB 事务内释放该行 execution lease **与** coordinator 的 integration merge lease，保留 released tombstone 与审计证据；pre-activation / engine-absent 文件协议则移除 snapshot 中的 `execution_lease` 与 `integration_merge_lease` 字段。

   **Plan 会话不执行以上任何一步**（`accept` / `integration-*` / `complete` 对 plan session 被拒绝）。失败恢复**只用** `mstar plan reconcile …`（同一传输的 CAS）：回退到 `accepted` + 释放本次 merge lease（`retry-ready`）／已具备唯一合并证据则补记证据并原子完成（`completed`，**不重复 merge**）；`integrating` 且存在 `MERGE_HEAD`、冲突或脏树 → `coordination.integration-unresolved`，全部状态与 lease 保留；无法证明的图 → `coordination.integration-diverged`。**禁止**传调用方成功标志、**禁止**重复 merge。
6. **Cross-plan 进度同步**：更新 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` 的 `## Plans` 表状态列
7. **Next plan / parallel wave** 从步骤 1 继续（可并行推进其他已 claim 的 plan；merge 仍排队串行）

全部 plan `Done` → **Phase transition gate**（见 `mstar-iteration` SKILL.md **Phase transition gates** 表）：

1. **STOP** per-plan loop — 禁止 merge 后继续下一 plan、禁止开 PR、禁止会话结束语。
2. 打印 **`## Phase 3: iteration-close`**。
3. 按 **`references/phase-3-iteration-close.md`** §3.0 起独立执行至 §3.5。final plan 的 Assignment / closure 仅作输入，**不能**替代 Phase 3 gate。

### Same-round plan cleanup（timing lane 1；merge 成功同轮）

integration merge 成功且 plan 行 `Done`、execution lease 已释放（ACTIVE 保留 released tombstone；pre-activation / engine-absent 移除 snapshot 字段）的**同一轮**，即可回收该 plan/track 的 feature worktree + 已合并分支 —— **父迭代仍在运行不影响资格**：不存在「父须终结」的一刀切，这是 cleanup 的明确设计而非遗漏。命令与守卫契约本体（ownership、合并证据、refusals、apply 顺序）→ **`mstar-branch-worktree`**「Worktree / branch cleanup」（唯一 home；本节只放 call site）：

```text
mstar worktree cleanup --workflow <id> [--harness <path>] [--apply] [--remote] [--worktree <path>] [--all-workflows] [--verbose] [--ignore-unreadable-snapshots]
```

- 先 dry-run 看 `verdict | kind | ref | reason`（merge 刚完成 → 该 Done 行 eligible）；`--apply` 才变更。lane 1 只清**本地面**（无 `--remote`；远端残留留给 Phase 6）。
- 分支可能仍被该 Done-child worktree 检出 → apply 内部先移 worktree，再 re-probe / re-plan 删分支（**worktree 移除 ≠ 分支删除**；细则 → 契约本体）。
- **lease 释放不在 cleanup 范围内**：coordinator 的 `mstar plan complete` 原子完成 Done 与两类 lease 处置（ACTIVE：同一 DB 事务内释放并保留 released tombstone；pre-activation / engine-absent：文件协议移除 snapshot 字段）；cleanup 不替 owner 释放，也不依赖 lease 行 / 字段消失判断归属（归属保留在行 metadata / track Assignments）。standalone plan 无 integration 时以 `branch.target` 为证据 base，且须先 terminal close。
- **禁止**为让 cleanup 通过而推进/终结父迭代或改 snapshot 状态；受保护行保持 `refuse` 是正确行为，不是失败。

## 2.5 Dispatch-first（implement 派发约束）

派发纪律 SSOT → **`mstar-dispatch-gates`** · **`mstar-sdd`** · **`mstar-host/references/parallel-dispatch.md`**。

**SDD implement（Phase 2 默认）** — PM **已载入 `mstar-sdd`** 后执行：

| 规则 | 说明 |
|------|------|
| 并行 | 独立 ready tasks 各自 fresh implementer + 隔离 worktree；单一 canonical per-plan SDD root 内分离 task artifact 路径，context/progress 仅 PM 串行写；leaf 直接消费不可变绝对路径，不调用共享 context helper；每 task 后一位 fresh reviewer；真实依赖与 merge 串行（`mstar-sdd`） |
| Sticky（可选） | Assignment **`SDD implementer session: sticky`** + `implementer-session.json`；implementer **resume**，reviewer **fresh** — `mstar-sdd/references/sticky-implementer-session.md` |
| 文件交接 | brief / report / diff / `progress.md` 在 `{SDD_DIR}`；dispatch prompt **只给路径**，不贴 plan 全文或 task 历史 |
| Assignment 字段 | 每个 implement dispatch 须含 `Execution mode: sdd`、`SDD dir`；§2.0 #5 未 waive 时还须含绝对 `Worktree path` + verified `execution_lease`；**禁止**省略 `Execution mode` / `SDD dir` |
| 大包 inline | **禁止**把 T1–Tn 或整份 plan 写进 **一个** `fullstack-dev` leaf Assignment 冒充 SDD |
| 分支 diff | 全部 task 完成后 `mstar sdd review-package MERGE_BASE HEAD` → `{SDD_DIR}/review/` branch diff → plan QC tri（N=3） |

Iteration Phase 2 附加：

- PM **NEVER** 在 PM 线程实现产品代码（delegate dev；hotfix 例外见 **`mstar-phase-gates`**）
- `Subagent invokes issued: 0` 而 Assignment 已写出 → **`dispatch incomplete`**；下一条补发 invoke，禁止 PM 顶替
- QC 初轮：**SDD → N=3**；**inline → N=1**；plan QC tri 三席 **同条消息 N=3**（非 implement 轨数）
- **`Findings cleanup: allow-residual`（默认）**：open finding 经 `mstar plan issue-add` 捕获为 store issue，并在各决策面披露 id / issue severity / 跟踪位置；`zero-residual` 显式 opt-in。处置、blocker-defer 与披露规则 → **`mstar-artifacts`**「Findings cleanup modes」，不使用退役 project register。

## Feature worktree (per plan)

- Each concurrently active plan uses a **distinct** absolute feature-worktree
  path and dedicated feature branch from `spec_integration_branch`.
- `execution_lease.worktree_path` MUST differ from the main and integration
  worktrees (integration path from ACTIVE workflow execution row;
  pre-activation: snapshot). Never product-edit either coordination checkout.
- Writable Assignment `Worktree path` MUST match the authoritative lease
  before first implement dispatch (ACTIVE: execution lease row).
- Product edits run from feature worktree; authored plans / iteration package /
  SDD use absolute control paths, and state uses public verbs against the control
  authority, never feature-cwd relative `.mstar/...`.
- Assignment MUST include absolute feature **`Worktree path`** and absolute
  control **`Plan Path`** / **`SDD dir`** before writable implement dispatch.
- Default **L1**: one writable track per plan. Within-plan multi-writable tracks
  still follow L2 `parallel-writable-pre-dispatch` (`mstar-branch-worktree`).

## Execution / integration lease checklist

- ACTIVE lease 权威为 `execution_leases` / `execution_integration_leases`；经公共 plan 动词 claim / progress / handoff / transfer / complete / release，不编辑 DB 或 snapshot。传输与 owner / coordinator 边界 → **`plan-scoped-pm.md`**。
- 可写 dispatch 前校验 holder、feature worktree 与 working branch；外来 holder 或无有效 lease 的 orphan InProgress 不授权实现，按 **`mstar-artifacts`** 的 recovery 规则处理。
- integration checkout 必须干净并检出记录的 integration 分支；仅 coordinator 按 §2.4 step 5 固定 attempt → 显式 Git merge → 验证 → 原子 complete；失败经 `mstar plan reconcile`，不重复 merge。
- lease 可共存，但 merge lease 不授予 source plan 的执行所有权。audit notes 只 append `notes.jsonl`。
- **pre-activation / engine-absent** 的完整文件 lease 协议（字段、锁、claim/release/override 与 integration）唯一正文 → **`mstar-engine-legacy/references/lease-protocol.md`**；本处不复述。

## Multi-plan parallelism

并行安全条件唯一见上文 **Cross-plan parallel hard gate**；integration merge 始终串行。每 plan 使用独立 feature worktree 与有效 lease（未 waive 时），依赖与共享写目标仍决定调度。

## Waiver

Explicit `Worktree mode: waived` (or equivalent user instruction) this turn
waives **only**:

- Per-plan feature worktree defaults. The dedicated integration coordination
  checkout remains required; the primary checkout keeps its recorded branch
  and remains the process-SSOT holder via absolute control-root paths.
- Lease claim/hold/release defaults（ACTIVE：execution 表；pre-activation：snapshot 字段）—— **scoped route 不可豁免**：waiver 不解除公共动词前置；CLI 缺失 fail closed

It does **not** waive the **cross-plan parallel safety gate** above. ACTIVE remains DB-arbitrated; pre-activation requires the documented shared file lock, serial scheduling, or explicit current-turn race acceptance + append-only `notes.jsonl` audit. **Prefer serial scheduling when waived**.

`Plan parallelism: serial` does **not** waive the worktree or lease gates.

Iteration commands MUST NOT infer waiver from missing worktrees or single-session
starts. Explicit override this turn only.
