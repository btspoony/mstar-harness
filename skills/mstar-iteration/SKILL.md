---
name: mstar-iteration
description: "Use when starting, driving, resuming, or closing a Morning Star iteration, or running an autonomous Phase 1–6 loop — including without a slash command (e.g. 'start an iteration', 'drive the iteration', 'run an autonomous loop'). Manages Phase 1 (default interactive direction lock; opt-in autonomous), Autonomous Execute, iteration-close (compound promotes knowledge), PR delivery, the PR merge-ready loop, and the Phase 6 post-merge close. Branch SSOT: store.db execution authority + compass frontmatter; snapshot files are migration sources only."
---

# mstar-iteration（迭代管理）

## Load order

**Read `mstar-harness-core` first.** Path symbols → **`mstar-conventions`**. Per-plan gates → **`mstar-phase-gates`**. Knowledge crystallization → **`mstar-compound`**. Phase 2 implement 波次（进入 per-plan implement 前）→ **`mstar-sdd`** + **`mstar-dispatch-gates`**；Phase 2 QC 前 → **`mstar-review-qc`**。Git/worktree 载体（有 git 写或 lease 时）→ **`mstar-branch-worktree`**。**Phase 1 角色派发 preflight**（每次 invoke 前的 assignment preflight；`enforcement: hard` fail-fast）→ **`references/command-shared-invariants.md`**（本 skill 直接触发时不依赖 command 层）。On conflict, **`mstar-harness-core` wins**.

**Phase detail 不在本 skill 正文**：按下方 **Phase route map** 只加载当前动作对应的一行 detail——**禁止**无条件通读全部 phase references。

The primary coordinator owns all rows of the selected iteration and dispatches ordinary leaf tasks. Row configuration remains revisable during active execution; `progress` records the start and review states, and direct `complete` verifies QC/QA and the actual serial merge before writing `Done`. No row-specific PM launch or binding is required. Command entry accepts no arguments; reject nonempty arguments instead of broadening their scope.

## 设计思路

mstar 实践模式通常是：一次迭代锁定几个 spec 点（`specify + clarify`），产生多个 `plan`，每个 plan 含多个 tasks。**per-plan 生命周期有完整的闭环**（Prepare → Execute → QC → Done）。Compound 不是 per-plan 活动——它是**迭代级收口**，在迭代内所有 plan Done 后，沉淀一轮知识。

本 skill 管理迭代 **Phase 1–6**（command 层可聚合编排，但 **不得**反向引用 command 名；第三方 helper 仅由 command 按需发现）：

```
Phase 1: start
     ↓
Phase 2: Autonomous Execute  —— [per-plan lifecycle × N]
     ↓
Phase 3: iteration-close
     ↓
Phase 4: PR delivery（开 PR）
     ↓
Phase 5: PR merge-ready loop —— 至 mergeable + CI 全绿 + reviews resolved
     ↓
Phase 6: post-merge close —— PR merged 后 §6.1–§6.4
     ↓
迭代交付完成
```

**关键定位**：

- **Phase 3** 在 integration 分支收口 compound / roadmap；**开 PR（Phase 4）≠ 迭代交付完成**。
- **Phase 5** 是 **merge-ready loop**（修复 → 等 CI/review 波次结束再 push → 再验证，至 §5.5 exit）；**Loop 理念与 push cadence SSOT 在本 skill**（§2.6；push cadence 细则 §5.1a → `references/phase-4-5-pr-delivery.md`）；宿主 command 可叠加额外 **non-`mstar-*`** helper（**优先** `babysit` / `*-babysit`；**`greploop` 可选**），但不写入 `mstar-*` load order。
- **Phase 6** 是 **post-merge close**（verified PR merged 后：terminal execution transition → DB root unregister → 投影对齐 → 显式 cleanup；细则 → `references/phase-6-post-merge-close.md`，cleanup 契约 → `mstar-branch-worktree`）。**§5.5 exit / PR mergeable ≠ 生命周期已关闭**。
- 一次迭代 = 一个 PR；compound 产物随 PR 合入 workflow `branch.target`（ACTIVE：执行行）。

## Phase route map（唯一路由表 — 按当前动作加载）

| 当前动作 | 必读 detail（按需加载，勿通读） |
|---------|--------------------------------|
| **start** (new iteration / reopen direction lock) | **`references/phase-1-prepare.md`** (§1.1–§1.6: context → direction lock/hook → §1.2.5 retained prototype and feedback loop → formal compass/plans/specs → registration → selected Review & Edit rounds with mandatory final writer). Interactive requires current-design HTML confirmation before authoring; explicit autonomous opt-in retains an appropriate prototype without routine human approval. |
| **execute / resume**（推进或恢复 per-plan 循环） | **`references/phase-2-worktree-lease.md`**（§2.0 五道闸、§2.1–§2.5 loop/dispatch、control root + integration worktree checklist） |
| **close**（全部 plan Done 后收口迭代） | **`references/phase-3-iteration-close.md`**（§3.0–§3.6：entry checklist、compound、roadmap、完成标记、exit checklist + commit） |
| **PR / merge-ready**（开 PR、推进合并就绪 loop） | **`references/phase-4-5-pr-delivery.md`**（§4–§5.2：开 PR、§5.1a push cadence、loop、exit checklist） |
| **Phase 6 / post-merge close**（PR merged 后关闭 lifecycle） | **`references/phase-6-post-merge-close.md`**（entry（verified merged）+ §6.1 terminal write → §6.2 unregister → §6.3 projection reconciliation → §6.4 cleanup：`mstar worktree cleanup`，dry-run 默认，`--apply` 才变更） |
| **Phase 5 helper discovery**（仅 command 层按需） | **`references/phase5-helper-discovery.md`**（babysit / greploop 发现） |

一次只加载当前 route 一行；phase 切换按下方 **Phase transition gates** 走。

## Phase transition gates（HARD — 防跳步）

| 边界 | 触发 | 必须 | 禁止 |
|------|------|------|------|
| **→ Phase 2**（entry / resume） | §2.0 五道闸全过（细则 → `references/phase-2-worktree-lease.md`） | 继续 Autonomous Execute per-plan loop（phase-2 reference §2.4）；主 worktree 驻留 = 记录的 **`Main worktree branch`**，integration 分支检出在专属 integration worktree | 五道闸任一 false 仍派发；branch metadata 缺失用 `main`/`master` 补位；把生命周期分支切到主 checkout |
| **→ Phase 3** | `mstar status validate` / `mstar plan show` 所读 ACTIVE `execution_plans` 中 compass 登记的全部 plan 均为 `Done` | 打印 `## Phase 3: iteration-close`；执行 §3.0→§3.5（`references/phase-3-iteration-close.md`）；host todo `phase-3-iteration-close` 保持 open 直至 §3.5；close commit 在 **integration worktree** 执行 | 开 PR；宣称迭代交付完成；仅依赖 final plan closure；在主 checkout 上 commit close 产物 |
| **→ Phase 4** | §3.5 exit checklist 全 `[x]`；frontmatter `status: completed` + `end_date` | 打印 `## Phase 4: PR delivery`；开 PR 到当前权威 workflow `branch.target`（§4 → `references/phase-4-5-pr-delivery.md`） | 跳过 §3.1 entry checklist 或 compound Phase 6 |
| **→ Phase 5** | Phase 4 PR 已创建 | 打印 `## Phase 5: PR merge-ready`；执行 §5 loop 至 §5.5 exit（含 §5.1a push cadence） | 开 PR 后停止；跳过 review resolve / CI loop；**CI/AI review 仍在跑时 push** |
| **→ Phase 6** | PR **已 merge**（verified merged；mergeable ≠ merged，由 PM 核实） | 打印 `## Phase 6: post-merge close`；按 §6.1→§6.4 执行（`references/phase-6-post-merge-close.md`）；todo `phase-6-post-merge-close` 保持 open 直至 §6.4 | mergeable 即视为 merged；未核实 merge 就调用 close；§6.1–§6.3 之间夹带 tracked commit |
| **→ 迭代交付完成** | Phase 6 §6.1–§6.4 完成（`references/phase-6-post-merge-close.md`） | store workflow `completed` + `ended_at`；DB 根 register（`execution_registry`）条目注销（`mstar status workflow-close --workflow <id>` 的所属 authority 形态 exit 0）；投影一致 | §5.5 exit 或 PR merge 即宣称交付完成；为 close 释放 lease 或伪造 Done/关闭 residual |
| **start → integration branch** | §1.2.5 prototype checkpoint + §1.6 Review & Edit (`references/phase-1-prepare.md`) | Retained confirmed interactive HTML or reasoned autonomous prototype; formal documents aligned to that baseline; PM records product/architect include/omit rationale; actual selected roles edit sequentially, mandatory writer last; package specs/hygiene, marker closure, per-plan Prepare gates and compass `status: locked` | Formal authoring before prototype disposition; stale design approval; fake skip receipts; unresolved gaps hidden by omission; PM replacing specialist edits/writer; parallel shared-document editing; new knowledge or prototype-as-spec/acceptance evidence |

> **Engine check (when available):** run `mstar iteration gate --workflow <id> --compass <delivery-compass.md> --branch "$(git branch --show-current)" --integration <spec_integration_branch> --target <target_branch>` (or import `evaluatePhaseGate`) against the ACTIVE execution authority (DB). Verify branch probes **before** §3.5 commit; `EXIT_BRANCH_MISMATCH` / `EXIT_PR_BASE_MISMATCH` block it. During `transition: phase-3-close`, exit 1 pending §3.4 `completed` + `end_date` is expected close work pending, not permission to skip Phase 3; the exit checklist gates Phase 4. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

**误判信号**：对话里出现 compound 摘要、roadmap 更新、或「所有 plan 已完成」但 **未** 打印 §3.1 / §3.5 checklist → 视为 **Phase 3 未执行**，回到 `references/phase-3-iteration-close.md` §3.0。

**per-plan 状态 SSOT**：ACTIVE 为 `{HARNESS_DIR}/store.db` 的 `execution_plans` 行（Todo/InProgress/InReview/Done）；`execution_registry` 登记活跃 lifecycle。读取经 `mstar status validate` / `mstar plan show`，写入只经公共 `mstar workflow …` / `mstar plan …` 动词。Phase 6 保留 workflow 终态（`completed` + `ended_at`），注销 DB 根 register 条目。`{WORKFLOW_DIR}/<id>/snapshot.json` 与根 `status.json` 仅为迁移源（由保留的 `mstar` 迁移工具 engine 内部写入），不是读写路线；这些文件（含 `sessions/*.json`）在 runtime consumer 下的读写分别被 `execution.consumer-not-ready` / `execution.direct-write-refused` 拒绝。
**迭代状态**：执行状态权威在 store.db；`{ITERATION_DIR}/<id>/delivery-compass.md` frontmatter 是 authored 叙事镜像，catalog 登记身份与关系。`{ITERATION_DIR}/README.md` 仅作散文，不维护登记行。
**迭代分支 SSOT**：ACTIVE workflow 执行行的 `branch.base`（= `iteration_base_branch`）、`branch.target`（= `target_branch`）、`branch.integration`（= `spec_integration_branch`）与 `integration_worktree_path`。compass frontmatter 镜像同名锚点。解析顺序见 phase-2 reference §2.3。**禁止**默认 `main`/`master`。**`branch.base` 不是驻留事实**——主 worktree（control root）驻留分支由 PM 记录为主 plan 头的 **`Main worktree branch`**，全程不切换；integration 分支检出在专属 integration worktree。

## 产物存储位置

**SSOT**: `mstar-conventions/references/artifact-storage-paths.md`. Iteration package → `{ITERATION_DIR}/<iteration-id>/`: `prototypes/` is retained design context created before formal `delivery-compass.md`, `guides/` and `specs/`; optional package/root README prose. Legacy flat `{ITERATION_DIR}/<id>-delivery-compass.md` is read-only compatibility.

## 2.6 Continuous execution + push 纪律（Phase 2–5 通用 SSOT）

**Continuous execution（HARD）**：Phase 2 Autonomous Execute 经 Phase 5 merge-ready exit 全程 — 不向用户做例行 yes/no check-in。

- 不因 harness 流程问题常问「是否继续」「要不要现在启动」—— **决策、记录、dispatch**
- 进度汇报 / subagent Completion Report 后，下一条必须是 **dispatch 或下一 gate 动作**，不得以确认问句收束 turn
- 未知 → 读 `mstar-*`；仅 **`Blocked`**、secrets、不可逆范围缺口、branch metadata 缺失、或 Phase 5 多轮仍 blocked 时升级用户
- Actual Git differs from recorded source scope → same-round ordinary correction through `mstar plan prepare` / `mstar plan progress` with real facts, updating the current authoritative row, applicable working-branch information and plan projections; never hand-edit state or recreate a per-row claim.
- **跨 plan implement 并行安全闸**与 **integration merge 串行** → `references/phase-2-worktree-lease.md` §2.0 #5 /「Multi-plan parallelism」（**无论** `Worktree mode: waived`）
- plan 内 SDD 独立 ready tasks **并行**，真实依赖与共享写目标串行 — phase-2 reference §2.4、§2.5、`mstar-sdd` Ready-task scheduling
- **allow-residual（默认）**：open finding 先经 `mstar plan issue-add`（计划外 `mstar issue add`）捕获为 store issue，且各决策面披露（id + issue severity + 跟踪位置；close 面另含 blocker-defer 标记）；unresolved `critical` 仍阻断 Approve；`zero-residual` 为显式 opt-in（可修当轮清干净，仅真 blocker-defer + Durable Roadmap）— 捕获与披露职责 → **`mstar-artifacts`** Findings cleanup modes
- iteration 命令共享的 PM invariants / preflight / todos / STOP → **`references/command-shared-invariants.md`**

**Push cadence（§5.1a HARD）**：本地可提前修，**禁止**在 CI / AI review 波次未结束时 `git push` — 细则 → `references/phase-4-5-pr-delivery.md` §5.1a。

## 迭代 compass 模板

完整模板见 `references/iteration-compass-template.md`。

## 与其它技能的关系

完整 topic-skill 索引见 **`mstar-harness-core`**。本 skill 迭代级关键引用：

- **`mstar-compound`** — iteration-close 中触发知识结晶（**唯一**默认 knowledge 新增路径）
- **`references/phase-1-prepare.md`** — start route detail（§1.1–§1.6）
- references/phase-2-worktree-lease.md — direct coordinator execution, isolated feature/integration checkouts, atomic writes and real serial merge proof
- **`references/autonomous-direction-lock.md`** — §1.2 autonomous direction lock、scale budget、branch resolve
- **`references/iteration-artifact-boundaries.md`** — Phase 1 specs / iteration package / knowledge 分工
- **`references/iteration-corpus-hygiene.md`** — §1.6 writing-specialist specs 卫生细则

## NOT to do

共享反递归红线全清单见 **`mstar-roles/references/_shared/leaf-executor-core.md`**「Shared anti-recursion NEVER」。迭代级高频陷阱（其余各 Phase 内已含对应 hard rule）：

- **不要将 Phase 4 开 PR 等同于迭代交付完成** — 必须完成 Phase 5 §5.2 merge-ready loop
- **不要将 §5.5 exit 或 PR merge 当作生命周期终点** — merged 后必须进入 Phase 6（`references/phase-6-post-merge-close.md` §6.1–§6.4）；禁止为通过 close 释放 lease 或伪造 Done/关闭 residual
- **不要在 Phase 5 CI 仍跑或 AI review 波次未结束时 push**（§5.1a）— 本地可提前修，push 等 idle
- **不要在 integration worktree 或主 checkout（control root）上直接编辑产品代码** — Phase 5 修复走 fix feature worktree，review 后 merge 回 integration worktree（`phase-4-5-pr-delivery.md` §5.0）
- **不要在缺 `iteration_base_branch` / `target_branch` 时默认 `main` / `master`**
- **不要在 Phase 1 §1.6 由 product/architect 向 `{KNOWLEDGE_DIR}/` 新增**（知识 → iteration-close **`mstar-compound`**）
- **不要在 per-plan Done 后立即 compound** — 等 iteration-close 统一做

## Workflow

Phase 1–6 总览见上文 **`## 设计思路`** 图。执行时按 **`## Phase route map`** 选当前动作的一行 detail：`start`（范围 + compass + §1.6 Review & Edit 链）→ `Autonomous Execute`（五道闸 → §2.4 per-plan 循环：分支 → 实现 → QC → QA gate → Done → 串行 merge）→ `iteration-close`（§3.1–§3.5 + `mstar-compound`）→ `PR delivery`（Phase 4）→ `PR merge-ready loop`（Phase 5 至 §5.5 exit）→ `post-merge close`（Phase 6，PR merged 后 §6.1–§6.4）。每波用 §2.1 session todos 设护栏防范围漂移；phase 切换以上方 **Phase transition gates** 为准。

## Evidence

迭代交付完成 = Phase 5 §5.5 exit checklist 全 `[x]` **且 PR merged 已核实** **且 Phase 6 §6.1–§6.4 完成**（store workflow `completed` + `ended_at`、DB 根 register 条目注销、投影一致；`references/phase-6-post-merge-close.md`）。Phase 3 完成标志 = compass frontmatter `status: completed` + `end_date`（§3.4）+ §3.5 exit checklist。authored close 证据保留在 compass / plans / specs；catalog 与执行 metadata 在 store.db，不要求单独迭代审查报告。
