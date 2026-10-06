# Phase 2: Autonomous Execute — per-plan loop + integration worktree + lease

> Loaded by `mstar-iteration` SKILL.md on the **execute / resume** route, and by the Phase 2+ command layer. **Read `mstar-harness-core` first.** Entry = §2.0 五道闸全过；continuous execution / push 纪律（§2.6）的 SSOT 仍在 `mstar-iteration` SKILL.md。

Field semantics → `mstar-artifacts/references/status-and-residuals.md`; public parameter shapes and recovery → `mstar-use-cli/references/plan-and-workflow.md`. The primary coordinator uses ordinary plan domain operations on both file and ACTIVE DB routes. Atomic writes, CAS and operation receipts belong inside those actions; no per-plan identity, claim or transfer step is required. Leaf executors receive only assigned paths/scope, never coordinator session references. This reference owns the iteration execution checklist, not another field or transport protocol.

## When it applies

**Phase 2**（SKILL.md execute/resume route + `iteration-drive` / `iteration-loop`
command layer；`iteration-start` ends before this）. Defaults are **hard** unless the current turn
explicitly waives via Assignment `Worktree mode: waived` (or equivalent user
instruction), within the limited scope in § Waiver; main residency and the
dedicated integration checkout remain mandatory. `Plan parallelism: serial` is **not** a waiver — it only forces
serial cross-plan **implement** scheduling while checkout isolation, atomic coordination
and workflow-wide serial integration safety remain required.

Phase 1 Review & Edit may edit uncommitted docs on the primary checkout under the Prepare policy (bounded exception; the main worktree never switches branch). The integration-worktree safety gate
starts at **Phase 2 entry** — Phase 1 did walk §2.3's integration-worktree checklist once at its end (`iteration-start` §6, which carries the `phase-1-lock` marker), but the gate those steps guard opens only when Phase 2's per-plan loop begins.

**Phase scope**：本参考仅约束 **Phase 2**（含 serial integration merge 与「control root / integration worktree 禁止产品编辑 / 每 plan feature worktree」）。**Phase 5** PR merge-ready 修复同样 **不**直接在 integration checkout 上改——产品修复走独立 fix feature worktree，review 后 merge 回 integration worktree → **`phase-4-5-pr-delivery.md`** §5.0。

This Phase owns the complete per-plan dispatch loop: entry checks, session todos, backlog, integration branch/checkout management, isolated implementation, QC, QA, real serial merge, direct Done and dispatch-first discipline. Read §2.0–§2.5 and the workflow merge-exclusion guidance below before iteration execution.

**Findings cleanup（默认）**：Phase 2 Assignment 默认 **`Findings cleanup: allow-residual`**；open finding 先经 `mstar plan issue-add` 捕获为 store issue，再离 InReview，并披露 id / issue severity / 跟踪位置。`zero-residual` 为显式 opt-in；清理与披露权威 → **`mstar-artifacts`**「Findings cleanup modes」。project register 无条件退役为迁移历史。

## 2.0 前置条件（五道闸）

进入 Autonomous Execute 前必须满足：

1. ACTIVE `execution_plans` 至少一条 plan `status` ≠ `Done`，且 `execution_registry` 含该 iteration（经 `mstar status validate` / `mstar plan show` 读取）；仅 pre-activation / engine-absent 回退读取 snapshot 与根 `status.json`
2. **Pre-implement gate = GO**：plan 已 locked、tasks ready（见 `mstar-phase-gates`）
3. 用户意图为 **continue Autonomous Execute**（推进迭代 Execute、继续 per-plan 循环等）
4. **Branch metadata gate:** current authoritative workflow `branch.base` / `branch.target` and at least one active plan's `metadata.spec_integration_branch` are registered; resolve missing facts through §2.3. Missing → **STOP**; never default to `main` / `master`.
5. **Worktree and concurrent-write safety:** confirm the main checkout/control root and its recorded `Main worktree branch`; establish a separate integration checkout and distinct feature checkouts before writable dispatch. Record missing or corrected source branch/worktree through ordinary prepare. ACTIVE execution state is read/written through public verbs against control `{HARNESS_DIR}/store.db`; authored plans, Assignments, iteration package, SDD and append-only `notes.jsonl` use absolute control paths. Leaf Assignments include absolute feature `Worktree path`, `Working branch`, control `Plan Path` and `SDD dir`. Shared coordination writes use the engine's same-host file lock or DB transaction/CAS; independent writable tasks use L1/L2 isolation. Missing gitignored plans in a feature checkout never justify waiver. Serial scheduling does not waive checkout isolation; integration merges always remain serial.

> **Engine-check pointer:** `mstar-artifacts` `SKILL.md` owns the worktree/isolation and `lease verify-integration` callout; these checks do not confer row authority.

任一 false → **stop**。Phase 1 / Prepare 未完成 → 先完成 Phase 1 或 per-plan Prepare，再进入本 Phase。

## 2.1 Session todos（派发前设护栏）

每个 plan wave 启动前设定 host session todos，防止范围漂移（具体 todo / plan UI 工具名 → active host reference）：

| 宿主会话 | 工具 | 最小集合 |
|----------|------|---------|
| 任意宿主（有 session todo / plan UI 时） | 宿主自身的 session todo / plan UI | 当前 `plan_id`；下一批 gates（implement/QC/**QA gate**）；分支 checkpoint；**仅剩 1 个非 Done plan 时追加 `phase-3-iteration-close`**（open 直至 §3.5）；Phase 4 后 **`phase-5-pr-merge-ready`**（open 直至 §5.5） |

SSOT = ACTIVE store.db 执行行 + `{PLAN_DIR}/` authored plans；pre-activation 才使用 snapshot 文件。todos 只追踪本轮下一步。

Phase/gate 转换按 **`mstar-host`**「Phase-transition todo refresh (host-agnostic)」刷新；依据当前权威行与 plan 证据勾掉完成项，保留未决 gate 并追加下一批。todos 只是投影，不授权转换。

## 2.2 Read backlog

1. 读 `mstar-artifacts`；ACTIVE 经 `mstar status validate` / `mstar plan show` 读取执行行与 DB 根 register，pre-activation 才读 snapshot / `status.json`
2. 列出当前权威 `status` ∈ `{Todo, InProgress, InReview, Blocked}` 的 plan（优先级：`InProgress` → `InReview` → `Todo` → unblock `Blocked`）
3. 读 workflow `branch.base` / `branch.target` 与 plan `metadata.spec_integration_branch` / `merge_target` / `primary_spec`

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
   - ACTIVE authority: `<main-repo-root>/{HARNESS_DIR}/store.db` (root register, workflow/plan rows, coordinator sessions, registered inputs and workflow-wide merge exclusion)
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

The coordinator refreshes the authoritative control-root workflow view before a plan mutation or integration action. ACTIVE public verbs re-read state and merge exclusion in the DB transaction and check scope CAS; pre-activation domain writers re-read under their same-host file lock. No row claim/release/transfer step is introduced.

**Do not** set `Worktree mode: waived` because a feature worktree lacks
`plans/` under default gitignore — keep feature worktrees and pass absolute
control **`Plan Path`** / **`SDD dir`** in Assignments
(`mstar-branch-worktree` 「Harness path SSOT under default gitignore」).

<!-- host-hook: phase-1-lock -->
> Execute the active host reference's `## Host hooks` declaration for `phase-1-lock`; this file defines no host action.
>
> **`phase-1-lock` 恰好触发一次**：只在 **Phase 1 路线**、且在 checklist **step 7 的 branch push**（`git push -u` 新建的 `spec_integration_branch`；Phase 1 的写入目标均为 gitignored 本地工件，全局 `{SPECS_DIR}` 在 Phase 3 提升时写入）之后 —— 该 anchor 的就绪合取要求已 push 的 remote tip 等于 live integration HEAD，因此**不得**在 step 7 之前执行。此后任何**再次走过 §2.3 的路线**（Phase 2 entry 首次 execute 或 resume，包括 auto-continue 进入的第一次 Phase 2 entry）都**不**触发它：那时 binding 已 terminal，也**不**需要重新调用（精确的重复调用语义与拒绝码 → active host reference）。

### Atomic coordination writes

The plan/workflow domain writers own the complete read-check-write transaction. File authority uses its same-host exclusive lock and atomic replacement; ACTIVE control DB authority uses transactions, scope CAS and operation receipts, never snapshot lockdirs as proof. All state writes use public domain verbs. Read-only validators do not authorize raw snapshot edits or replace a mutation.

**Cross-plan parallel safety gate** (including waived): dependencies, independent write ownership and L1/L2 checkout isolation must hold. ACTIVE writers use the same control DB transaction/CAS authority; cross-host execution does not bypass that authority or automatically force serial scheduling merely because no shared file lock exists. Pre-activation writers require a shared same-host file lock; otherwise use `Plan parallelism: serial`. An explicit current-turn acceptance of file-route cross-host race is recorded only in append-only `notes.jsonl`, never dual-written into snapshot notes; waiver alone supplies no race authorization.

Before writable dispatch, verify the actual source checkout/branch against ordinary row metadata and the leaf Assignment, not a row holder/session. Never steal another workflow's write or merge claim; direct completion releases only applicable exclusion for its verified attempt. Integration merges always remain serial.


<!-- host-hook: phase-2-entry -->
> Execute the active host reference's `## Host hooks` declaration for `phase-2-entry`; this file defines no host action.
>
> 这是 **Phase 2 execute/resume entry**：§2.0 五道闸与 §2.3 的 branch / worktree 解析之后的第一个 Phase 2 动作，位于 per-plan loop 之前。Phase 1 的 `iteration-start` §6 只**复用** §2.3 的 integration-worktree 步骤，**不**触发本 anchor。

## 2.4 Per-plan loop（直到全部 Done）

Cross-plan ready work follows the **Cross-plan parallel safety gate** above, including under an explicit worktree waiver. Integration stays serial. No per-row execution lease/bind/claim qualification exists.

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
| `ownership-changed` | Assigned writable paths, source branches or checkout ownership change |
| `capacity-changed` | Native leaf capacity changes as tasks start or settle |

**决策步骤**（每次 checkpoint 按序执行）：

1. **用户 steering 与真实 blocker 优先于**任何调度续行；已返回结果**只消费一次**并判定其 acceptance —— **禁止**把 job completion 当作 accepted work。
2. **Select work:** consider ready rows and their local tasks within the selected workflow. Only the primary coordinator changes row/workflow state.
3. **Exclude unavailable work:** dispatched, already owned, terminal, contract-not-ready or genuinely dependent work. A prerequisite is ready only after its reviewed commit enters the dependent task's assigned base (`mstar-sdd` § Dependent-task readiness). Active leaf scope and `BASE_SHA` remain fixed; revise undispatched work before dispatch.
4. **Apply constraints:** current user/plan serial policy, native leaf capacity, engine CAS, atomic coordination and L1/L2 isolation. Shared files/session/ledger or missing integration interfaces create serial edges; numbering and unrelated QC/QA do not.
5. **Dispatch the full authorized ready batch:** use native leaf dispatch; no secondary primary PM transport. Only the coordinator's integration merge is serial.
6. **没有有用且已授权动作 → native wait 一次**，并写下真实 wait reason：`dependency` / `ownership` / `capacity` / `user-blocked` / `no-ready-work`。

**结果记录**：正常 PM transcript / ledger 的一行即可 —— checkpoint reason、考虑过的作用域、已派发 ID 或具体 wait / block reason。**禁止**：重复完成投递、tick 计数、「still waiting」报告、对**不变的空 ready 集合**反复自证或重跑同一推理、为保持忙碌而造工作、timer / 轮询循环。等待是合法结论 —— 同一组未变事实**只陈述一次**；只有新事实（显式用户消息、新的已接受结果、dependency / ownership / capacity 观察变化）才重新打开 checkpoint，「turn 结束」不是理由。

**checkpoint 不放宽任何既有安全条件**：

- Native background leaf tasks remain the task transport.
- Host idle status is not evidence that all tasks/jobs settled; native wait/completion delivery remains host-owned, never a polling loop.
- Never duplicate owned/running/completed work or change an active assigned base. Checkout names, idle age and terminal labels confer no authority.
- integration merge 入 `spec_integration_branch` 仍**串行**；跨 plan 并行仍受本节首段跨 plan 安全闸约束。
- `execution_policy` 取值（如 `serial`）是 accepted-but-opaque：**禁止**描述为引擎强制的线性调度器；实际策略从当前用户 / plan 推导，并保留显式 serial 约束。

对每个本轮要推进的 active `plan_id`（**可交错 / 并行**是默认读法：非强制 plan A 全 Done 再 plan B，plan 编号或 task 编号本身都不是串行理由）：

1. **Configure/source facts:** use `show` for the explicitly selected workflow/plan. Create or verify the feature checkout/branch and record missing or corrected facts with revisable `prepare`; QA defaults to mandatory, cleanup to allow-residual. No prepare record is required when defaults and recorded metadata suffice.
2. **Start:** record `Todo → InProgress` through ordinary `progress` before writable dispatch. Leaf Assignments include absolute Worktree path, Working branch and control-root Plan Path/SDD dir; parallel tracks additionally satisfy L2 isolation.
3. **Implement → InReview** (product edits in the feature worktree; authored plans, iteration package and SDD use absolute control paths; execution state uses public domain verbs):
   - **默认 `Execution mode: sdd`**（多 task plan；hotfix 可 `inline`）。
   - PM 载入 **`mstar-sdd`** 后，按依赖与 ownership 派发 **独立 ready tasks 并行** 的 per-task 循环（**不是**一次派发 dev 做全部 tasks）：
     1. `mstar sdd workspace <plan-id>` → `{SDD_DIR}`
     2. `mstar sdd task-brief <plan-file> N` → `{SDD_DIR}/task-N-brief.md`；记录 `BASE_SHA`
     3. Dispatch **one** implementer subagent（`references/implementer-prompt.md`：brief 路径 + report 路径；**禁止**贴整份 plan）
     4. Implementer `DONE` → `mstar sdd review-package BASE HEAD` → task diff 文件
     5. Dispatch **one** task reviewer subagent（brief + report + diff + Global Constraints）
     6. Fix until task review is clean; append `{SDD_DIR}/progress.md`; update the authoritative row through `mstar plan progress` and the authored plan checkbox.
     7. Release ready dependent tasks without waiting for unrelated tasks; PM alone writes shared progress, and state changes use public verbs.
   - After each accepted Completion Report, the primary coordinator updates the row through `mstar plan progress` and the main plan. Status is `InProgress`, `InReview` or `Blocked`, never `Done`; paths remain within the resolved plan/SDD area. Leaves never write snapshots/root registers.
4. **QC → QA gate:** keep the row InReview; run the SDD task reviews, then plan QC tri (inline single-seat exception) and mandatory QA or qualified PM acceptance. Raw reports live in `{SDD_DIR}/review/`, with durable summaries in the main plan. Capture/disclose findings under the effective cleanup configuration.
5. **Direct completion after the real serial merge:** from the clean recorded integration checkout on the authoritative workflow's `branch.integration` (pre-activation: snapshot), record the actual base SHA and explicitly run `git -C <integration-worktree-path> merge --no-ff --no-edit <reviewed-source-sha>` once. Supply QC/QA/source-review evidence and `integration: {base_sha, result_sha}` to `mstar plan complete`. The engine verifies the actual checkout, merge/source/review ancestry and result reachability, re-witnesses Git at commit, then atomically writes Done/completion evidence and retains source ownership metadata. It releases only applicable write/merge exclusion. No pre-merge state record or ownership-transfer sequence is required.
   - On merge conflict, retain InReview and resolve or explicitly abort Git in that same checkout; do not invent Done. After a completed merge, retry complete with the same actual SHAs, never repeat the merge because a response was lost. Exact operation replay does not re-run Git or rewrite timestamps. Missing scope facts use ordinary prepare; actual Git conflicts must be resolved, not suppressed by state edits.
6. **Cross-plan 进度同步**：更新 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` 的 `## Plans` 表状态列
7. **Next ready row/wave:** continue from step 1; rows may interleave, while all integration writes remain serial.

全部 plan `Done` → **Phase transition gate**（见 `mstar-iteration` SKILL.md **Phase transition gates** 表）：

1. **STOP** per-plan loop — 禁止 merge 后继续下一 plan、禁止开 PR、禁止会话结束语。
2. 打印 **`## Phase 3: iteration-close`**。
3. 按 **`references/phase-3-iteration-close.md`** §3.0 起独立执行至 §3.5。final plan 的 Assignment / closure 仅作输入，**不能**替代 Phase 3 gate。

### Same-round plan cleanup（timing lane 1；merge 成功同轮）

After successful real integration and row Done, recover the owned merged feature/track checkout in the same round; an active parent does not make its Done child ineligible. No per-row execution lease is an admission requirement. Guarded ownership/merge/refusal/order semantics live only in `mstar-branch-worktree`'s cleanup section.

```text
mstar worktree cleanup --workflow <id> [--harness <path>] [--apply] [--remote] [--worktree <path>] [--all-workflows] [--verbose] [--ignore-unreadable-snapshots]
```

- 先 dry-run 看 `verdict | kind | ref | reason`（merge 刚完成 → 该 Done 行 eligible）；`--apply` 才变更。lane 1 只清**本地面**（无 `--remote`；远端残留留给 Phase 6）。
- 分支可能仍被该 Done-child worktree 检出 → apply 内部先移 worktree，再 re-probe / re-plan 删分支（**worktree 移除 ≠ 分支删除**；细则 → 契约本体）。
- Cleanup never releases exclusion or advances state; direct complete owns that transaction. Ownership remains in row source metadata and retained track Assignments, not presence/absence of historical lease fields. Standalone plans use `branch.target` as evidence base and require terminal close before physical cleanup.
- **禁止**为让 cleanup 通过而推进/终结父迭代或改 snapshot 状态；受保护行保持 `refuse` 是正确行为，不是失败。

## 2.5 Dispatch-first（implement 派发约束）

派发纪律 SSOT → **`mstar-dispatch-gates`** · **`mstar-sdd`** · **`mstar-host/references/parallel-dispatch.md`**。

**SDD implement（Phase 2 默认）** — PM **已载入 `mstar-sdd`** 后执行：

| 规则 | 说明 |
|------|------|
| 并行 | 独立 ready tasks 各自 fresh implementer + 隔离 worktree；单一 canonical per-plan SDD root 内分离 task artifact 路径，context/progress 仅 PM 串行写；leaf 直接消费不可变绝对路径，不调用共享 context helper；每 task 后一位 fresh reviewer；真实依赖与 merge 串行（`mstar-sdd`） |
| Sticky（可选） | Assignment **`SDD implementer session: sticky`** + `implementer-session.json`；implementer **resume**，reviewer **fresh** — `mstar-sdd/references/sticky-implementer-session.md` |
| 文件交接 | brief / report / diff / `progress.md` 在 `{SDD_DIR}`；dispatch prompt **只给路径**，不贴 plan 全文或 task 历史 |
| Assignment fields | Every implement dispatch includes `Execution mode: sdd`, absolute `SDD dir`, source Worktree path/Working branch and inherited control-root Plan Path. |
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
- Row `metadata.worktree_path` MUST differ from the main/control and registered integration checkouts (ACTIVE workflow view; pre-activation snapshot).
- Record Worktree path and Working branch on the row through prepare when missing or corrected, and match them to actual checkout facts and writable leaf Assignments before dispatch.
- Product edits run from the feature worktree; authored plans / iteration package /
  SDD use absolute control paths, and state uses public verbs against the control
  authority, never feature-cwd relative `.mstar/...`.
- Assignment MUST include absolute feature **`Worktree path`** and absolute
  control **`Plan Path`** / **`SDD dir`** before writable implement dispatch.
- Default **L1**: one writable track per plan. Within-plan multi-writable tracks
  still follow L2 `parallel-writable-pre-dispatch` (`mstar-branch-worktree`).

## Concurrent-write exclusion

Row state writes use coordinator transaction/CAS/receipts and validated source metadata, not a retained per-row execution lease. An InProgress row without a historical lease is not an orphan admission failure. Recovery concerns actual coordinator identity, source facts or transaction conflict.

## Multi-plan parallelism

The **Cross-plan parallel safety gate** above applies whether or not `Worktree mode: waived` is in effect. Feature checkouts/branches and write ownership remain distinct; waiver never silently authorizes lockless cross-host writes. Integration into `spec_integration_branch` stays serial.

## Serial integration safety

Workflow-wide merge exclusion (ACTIVE: `execution_integration_leases`; pre-activation: `integration_merge_lease`) protects actual concurrent integration writers; it never grants a new per-plan seat. The coordinator verifies the clean recorded integration checkout, performs one explicit merge at a time and supplies the real base/result to direct complete. Existing foreign claims are not stealable by age, idle status or labels. Complete releases the verified attempt's applicable merge claim atomically with Done. A failed/in-flight Git merge remains unresolved until Git is clean and its result is provable; never clear protection or repeat a successful merge to manufacture state.


## Waiver

Explicit `Worktree mode: waived` (or equivalent user instruction) this turn
waives **only**:

- Per-plan feature worktree defaults. The dedicated integration coordination
  checkout remains required; the primary checkout keeps its recorded branch
  and remains the process-SSOT holder via absolute control-root paths.

It does **not** waive the **cross-plan parallel safety gate** above. ACTIVE remains DB-arbitrated; pre-activation requires the documented shared file lock, serial scheduling, or explicit current-turn race acceptance + append-only `notes.jsonl` audit. **Prefer serial scheduling when waived**.

Serial policy does not waive checkout isolation, coordinator transaction/CAS or real serial integration safety.

Iteration commands MUST NOT infer waiver from missing worktrees or single-session
starts. Explicit override this turn only.
