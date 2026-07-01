---
name: mstar-iteration
description: Morning Star 迭代管理 —— iteration-start（显式 `iteration_base_branch` / `target_branch`、Review & Edit chain 硬门禁）、Autonomous Execute（per-plan 派发；禁止默认 `main`）、iteration-close（独立 Phase gate）。compass：`{ITERATION_DIR}/`；分支 SSOT：`status.json` metadata + compass frontmatter。
---

# mstar-iteration（迭代管理）

## Load order

**Read `mstar-harness-core` first.** Path symbols → **`mstar-plan-conventions`**. Per-plan gates → **`mstar-phase-gates`**. Knowledge crystallization → **`mstar-compound`**. On conflict, **`mstar-harness-core` wins**.

## 设计思路

mstar 实践模式通常是：一次迭代锁定几个 spec 点（`specify + clarify`），产生多个 `plan`，每个 plan 含多个 tasks。**per-plan 生命周期有完整的闭环**（Prepare → Execute → QC → Done）。Compound 不是 per-plan 活动——它是**迭代级收口**，在迭代内所有 plan Done 后，沉淀一轮知识。

本 skill 管理三个迭代节点：

```
iteration-start → [per-plan lifecycle × N] → iteration-close → PR → merge
     │                                               │
     │ 锁定范围、创建 compass                        │ compound、更新 roadmap
     │ Review & Edit chain → PM lock                 │ 标记迭代完成
     │ 创建 integration 分支                          │ commit 到 integration 分支
     │                                               │
     └──────── Phase 2（Autonomous Execute）────────┘
```

**关键定位**：Phase 3 iteration-close 是 **Autonomous Execute 之后的独立 Phase**，在 integration 分支上执行，**完成后再创建 PR**。所有 compound 产物（knowledge docs、compass 更新、CONCEPTS.md）作为迭代交付的一部分随 PR 合入已记录的 `target_branch`。一次迭代 = 一个 PR。

## Phase transition gates（HARD — 防跳步）

| 边界 | 触发 | 必须 | 禁止 |
|------|------|------|------|
| **→ Phase 3** | `status.json` 中 compass 登记的全部 plan 均为 `Done` | 打印 `## Phase 3: iteration-close`；执行 §3.0→§3.5；host todo `phase-3-iteration-close` 保持 open 直至 §3.5 | 开 PR；宣称 iteration 完成；仅依赖 final plan closure |
| **→ PR** | §3.5 exit checklist 全 `[x]`；frontmatter `status: completed` + `end_date` | commit integration 分支 → PR 到 `metadata.target_branch` | 跳过 §3.1 entry checklist 或 compound Phase 6 |
| **iteration-start → integration branch** | §1.6 Review & Edit chain | 三角色 **按序** invoke 完成 + compass `status: locked` | PM 线程代做三角色编辑；并行三角色；review 前 commit |

**误判信号**：对话里出现 compound 摘要、roadmap 更新、或「所有 plan 已完成」但 **未** 打印 §3.1 / §3.5 checklist → 视为 **Phase 3 未执行**，回到 §3.0。

**per-plan 状态 SSOT**：`{HARNESS_DIR}/status.json`（per-plan Todo/InProgress/InReview/Done）。
**迭代状态 SSOT**：`{ITERATION_DIR}/<id>-delivery-compass.md` frontmatter `status` + `{ITERATION_DIR}/README.md` 索引。
**迭代分支 SSOT**：root `metadata.iteration_base_branch` + `metadata.target_branch`（`status.json`）；compass frontmatter 镜像同名字段。解析顺序见 §2.3。**禁止**因仓库存在 `main`/`master` 就假定 base 或 PR 目标。

## 产物存储位置

**SSOT**: `mstar-plan-conventions/references/artifact-storage-paths.md`。迭代 compass → `{ITERATION_DIR}/<iteration-id>-delivery-compass.md`；迭代索引 → `{ITERATION_DIR}/README.md`。

---

## Phase 1: iteration-start（启动迭代）

PM 在新迭代启动时执行。

### 1.1 收集上下文

1. 读 `{ITERATION_DIR}/README.md`（若存在），了解历史迭代
2. 读 `STRATEGY.md`（若存在），对齐战略方向（见 `mstar-strategy`）
3. 如果有未完成的 roadmap 残余（上一迭代标记为 `next` 的 plan），纳入本次迭代范围候选

### 1.2 定义迭代范围

与用户/产品对齐后，确定：

| 字段 | 说明 |
|------|------|
| **Iteration ID** | 唯一标识，推荐 `v<major>.<minor>` 或 `iter-<YYYY-QN>` |
| **范围** | 本迭代要锁定的 spec 点（问题陈述清单） |
| **Plans** | 预期在本迭代中完成的 plan 列表（允许中途增减） |
| **里程碑** | 关键节点与日期 |
| **验收标准** | 迭代级别的 Done 定义 |
| **非目标** | 明确排除在本次迭代外的事项 |
| **Roadmap 上下文** | 本迭代在整体 roadmap 中的位置（current iteration / next iteration） |
| **Delivery branch policy** | `iteration_base_branch`（integration 分支从何处分出）、`spec_integration_branch`、`target_branch`（最终 PR 目标） |

**Branch policy gate**：若用户、现有 roadmap、或项目约定未明确 `iteration_base_branch` / `target_branch`，PM 必须检查当前分支并向用户确认。**不得**因为存在 `main` / `master` 就默认从默认分支开 iteration 或向默认分支提 PR。

### 1.3 创建迭代 compass

写入 `{ITERATION_DIR}/<iteration-id>-delivery-compass.md`。**必须**使用 `references/iteration-compass-template.md` 完整结构（YAML frontmatter + `## Roadmap Position` + close 占位节）。`end_date` 仅在 iteration-close 填入；禁止用正文 completion prose 替代 frontmatter `status`。

```markdown
---
iteration_id: <id>
start_date: YYYY-MM-DD
status: active
iteration_base_branch: <branch-or-ref>
target_branch: <branch>
plans: []
---

# <iteration-id> Delivery Compass

## Scope
<本迭代要锁定的 spec 点>

## Plans

| plan_id | Name | Status | Notes |
|---------|------|--------|-------|
| <id> | <name> | Todo | |
| ... | ... | ... | |

## Milestones
| Milestone | Target date | Status |
|-----------|-------------|--------|

## Acceptance Criteria
- <迭代级验收项>

## Non-Goals
- <明确排除的事项>

## Roadmap Position
- Current iteration: <what this iteration delivers>
- Next iteration: <what comes next, owner, trigger>

## Delivery Branch Policy

| Field | Value |
|-------|-------|
| iteration_base_branch | <branch-or-ref> |
| spec_integration_branch | iteration/<iteration-id> |
| target_branch | <PR target> |
```

### 1.4 更新索引

在 `{ITERATION_DIR}/README.md` 中添加一行（首次创建时建立表头）：

| Document | Iteration | Description | Status |
|----------|-----------|-------------|--------|
| `<iteration-id>-delivery-compass.md` | `<iteration-id>` | `<简短描述>` | `active` |

### 1.5 登记到 status.json（formal iteration 必填）

iteration 正式全流程**必须**写入 `{HARNESS_DIR}/status.json`：

- root `metadata.iteration_base_branch` — 创建 `spec_integration_branch` 的祖先 ref（**不是**隐式 `main`）
- root `metadata.target_branch` — iteration-close 后 PR 的目标分支
- 各 plan `metadata.iteration_refs`、`spec_integration_branch`、`merge_target`（`merge_target` 通常为 `spec_integration_branch`）

compass frontmatter 的 `iteration_base_branch` / `target_branch` **必须与** `status.json` 一致；若仅写在 compass 而 status 缺失，§2.3 同轮 backfill。

### 1.6 Review & Edit chain（integration 分支前强制）

**Phase 1 在 PM lock 前不算完成**——compass/plans 初稿落盘 ≠ Done。

派发机制 → **`mstar-dispatch-gates`**（specialist review-and-edit dispatch，**顺序链**）。PM **不得**将迭代 harness 文档 commit 到 `spec_integration_branch`，直到：

1. **@product-manager** → **@architect** → **@writing-specialist** 已按序通过宿主 invoke **直接编辑**（非仅评论）compass、plans 及受影响 specs；每一环基于上一环落盘修订
2. PM 将 compass `status` 设为 `locked`，并确认各 plan 的 Prepare gate（specify / clarify / plan）

**顺序理由**：产品范围与优先级 → 架构与契约 → 术语与行文；并行会导致后手重复劳动或覆盖前手未定稿内容。

**完成证据** = 磁盘上的 compass / plans / specs 修订 + compass `status: locked`。**不**要求 `reports/<iteration-id>/` 审查报告——迭代审查的 SSOT 是被编辑的文档本身，无 per-plan QC 式审计链。

**反模式**：PM 线程代替三角色完成全部编辑而不 invoke；或将本链三角色并行派发 —— 见 **`mstar-harness-core`** 反模式索引。

---

## Phase 2: Autonomous Execute（per-plan 派发驱动）

**本 Phase 是本 skill 的核心**——定义 per-plan 派发循环的完整流程：前置条件检查、session todos、backlog 读取、integration 分支管理、per-plan dispatch 循环（分支→实现→QC→QA→Done→合并）、dispatch-first 约束、push 纪律。PM 读取本 Phase 即可执行迭代。

### 2.0 前置条件（四道闸）

进入 Autonomous Execute 前必须满足：

1. `{HARNESS_DIR}/status.json` 中至少一条 plan `status` ≠ `Done`
2. **Pre-implement gate = GO**：plan 已 locked、tasks ready（见 `mstar-phase-gates`）
3. 用户意图为 **continue Autonomous Execute**（推进迭代 Execute、继续 per-plan 循环等）
4. **Branch metadata gate**：root `metadata.iteration_base_branch`、`metadata.target_branch` 已登记，且至少一条 active plan 有 `metadata.spec_integration_branch`（或可从 compass 同轮 backfill）。**缺失 → STOP**，不得用 `main`/`master` 补位。

任一 false → **stop**。Phase 1 / Prepare 未完成 → 先完成 Phase 1 或 per-plan Prepare，再进入本 Phase。

### 2.1 Session todos（派发前设护栏）

每个 plan wave 启动前设定 host todos，防止范围漂移：

| Host | 工具 | 最小集合 |
|------|------|---------|
| **Cursor** | `TodoWrite` / CreatePlan todos | 当前 `plan_id`；下一批 gates（implement/QC/QA）；分支 checkpoint；**仅剩 1 个非 Done plan 时追加 `phase-3-iteration-close`**（Done 后保持 open 直至 §3.5） |
| **Codex** | `update_plan` / Goal UI | 同上 |
| **OpenCode** | host todo/plan UI（如有） | 同上 |

SSOT = `{HARNESS_DIR}/status.json` + `{PLAN_DIR}/`。todos 只追踪本轮下一步。

### 2.2 Read backlog

1. 读 `mstar-plan-artifacts` + `{HARNESS_DIR}/status.json`
2. 列出 `status` ∈ `{Todo, InProgress, InReview, Blocked}` 的 plan（优先级：`InProgress` → `InReview` → `Todo` → unblock `Blocked`）
3. 读 root `metadata.iteration_base_branch` / `metadata.target_branch`，以及 plan `metadata.spec_integration_branch` / `merge_target` / `primary_spec` 链接

### 2.3 Integration branch

**Metadata 解析顺序**（任一环节缺失则 STOP，**禁止**默认 `main`/`master`）：

1. `{HARNESS_DIR}/status.json` → `metadata.iteration_base_branch`、`metadata.target_branch`；plan → `metadata.spec_integration_branch`
2. 若 (1) 缺字段 → 读当前迭代 `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` frontmatter 同名键
3. 若 compass 有值而 `status.json` 无 → **同轮 backfill** `status.json`
4. 仍缺 → 向用户确认 base / PR target；**不得**因 `git symbolic-ref refs/remotes/origin/HEAD` 指向 `main` 就自动采用

**Git 操作**：

1. `git fetch`（按需）确认 `iteration_base_branch` 存在
2. **checkout 或创建** `spec_integration_branch`：
   - 已存在 → `git checkout <spec_integration_branch>`
   - 不存在 → `git checkout -b <spec_integration_branch> <iteration_base_branch>`（**必须**从记录的 base 创建，不是从当前未记录的 `main` 检出）
3. `git branch --show-current` 确认在 `spec_integration_branch`

此分支是本迭代内所有 plan feature branch 的 merge target。QC **`Review range` / `Diff basis`** 的 merge-base 参照优先用 `metadata.target_branch`（或 PM 书面指定的 base ref），**禁止**无 Assignment 依据写死 `origin/main`。

### 2.4 Per-plan loop（直到全部 Done）

对每个 active `plan_id`：

1. **Plan start — feature branch**：Assignment 用 `Working branch: create <plan-feature-branch> from <spec_integration_branch>`。一个 plan 一条专用实现分支；内部并行 → topic branches + worktrees（`mstar-branch-worktree`）
2. **Implement → InReview**：dispatch-only 循环（`§ 2.5`）；每次 Completion Report v2 后更新 `status.json` + 主 plan
3. **QC → QA → Done**：三审 + QA（`mstar-review-qc`）；gate 全部通过后 PM 标记 `Done`
4. **Plan complete — merge back**：合并 plan feature branch → `spec_integration_branch`；在下一 plan 或 QC 前解决冲突
5. **Cross-plan 进度同步**：更新 `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` 的 `## Plans` 表状态列
6. **Next plan** 从步骤 1 继续

全部 plan `Done` → **Phase transition gate**（见上文 **Phase transition gates**）：

1. **STOP** per-plan loop — 禁止 merge 后继续下一 plan、禁止开 PR、禁止会话结束语。
2. 打印 **`## Phase 3: iteration-close`**。
3. 按 §3.0 起独立执行至 §3.5。final plan 的 Assignment / closure 仅作输入，**不能**替代 Phase 3 gate。

### 2.5 Dispatch-first（implement 派发约束）

**派发回合纪律**（Cursor Task / 具名 invoke 宿主）：

1. 准备 Assignment 的消息可只含 read/bash — **不计入**派发。
2. **下一条派发消息**的第一动作 = 发出全部 `Task`（QC 初轮 **N=3** 同条消息；双轨 implement **N=2**）。
3. `Subagent invokes issued: 0` 而 Assignment 已写出 → **`dispatch incomplete`**；下一条必须补发 invoke，**禁止** PM 线程亲自实现顶替。

| Do | Don't |
|----|------|
| **Loop:** `## Assignment` → invoke → Completion Report v2 → 更新 status → next | PM 亲自 Write/Edit/Shell 产品代码 |
| 1 Assignment ⇒ 1 invoke | Assignment 只写 markdown 不 invoke |
| merge/branch/handoff 写入 Assignment | 因"上下文已有"而跳过 subagent |

- **NEVER** implement while staying PM — 实现一律 delegate dev 角色
- Delegate scope：`mstar-roles` → PM Execution Boundary
- 例外：用户显式要求 PM thread 实现；hotfix（`mstar-phase-gates`）

### 2.6 Push 纪律

- 不因 harness 基础问题常问"是否继续"—— 决策、记录、**dispatch**
- 未知 → 读 `mstar-*`；**`Blocked`** 或仅对 stop/secrets/不可逆范围缺口/冲突后升级
- 实际 Git ≠ `working_branch` → **同轮**更新 plan + status

---

## Phase 3: iteration-close（收口迭代）

PM 在迭代内全部 plan Done 后执行。**本 Phase 在 integration 分支上运行**，产出物 commit 到 integration 分支，随迭代 PR 合入 root `metadata.target_branch`。入口：Phase 2 全部 plan `Done` 后按 **Phase transition gates** 进入。

**Close Done 定义**：§3.1→§3.5 全部完成；compass frontmatter 写入 `status: completed` + `end_date`；每篇新增 knowledge doc 已登记 `{KNOWLEDGE_DIR}/README.md`。只在 final plan 中写了 compound / roadmap / PR 说明，不算 iteration-close 完成。

### 3.0 Phase boundary（HARD）

- Phase 3 是 iteration 级收口，不是任一 plan 的子任务。
- final plan closure、plan notes、plan compaction 可作为输入，但不能替代 §3.1→§3.5。
- 读过 `mstar-iteration` / `mstar-compound` 不等于执行 gate；必须打印 checklist 并写入产物。

### 3.0.5 Compass shape normalization（legacy 漂移修复）

进入 §3.1 前，先确认 compass 具有 close 可写入的结构。若缺失，PM 在本 thread 做最小规范化，不委派、不重写无关内容。

| 检查 | 缺则补齐 |
|------|----------|
| YAML frontmatter：`iteration_id`, `start_date`, `status` | 从文件名 / 正文提取；收口前 `status` 保持 `active` 或 `locked` |
| `## Roadmap Position` | 从 general context / roadmap prose 迁移为本节 |
| `## Compound Round Summary` | 按模板补占位，§3.4 填写 |
| `## Iteration Retrospective (minimal)` | 按模板补占位，§3.4 填写 |

正文 completion status 只能作为历史注释；最终状态必须写入 frontmatter `status: completed` + `end_date`。

### 3.1 Close entry checklist（HARD GATE）

**STOP**: 打印下方 checklist，且全部为 `[x]` 后，才可进入 §3.2 Compound。

- [ ] 所有 compass 中登记的 plan 在 `{HARNESS_DIR}/status.json` 均为 `Done`
- [ ] 所有 plan 的 residual findings 已收口（closed 或 accepted；见 `mstar-plan-artifacts`）
- [ ] compass `## Plans` 表状态列已与 `status.json` 同步
- [ ] 迭代 `## Acceptance Criteria` 已达成或显式豁免（compass 或对话记录原因）
- [ ] compass shape 已满足（frontmatter + `## Roadmap Position` + close 占位节）

PM **必须**在对话中打印本 checklist；不得默认同过。

### 3.2 知识结晶（Compound）—— 迭代级核心收口

**Compound 在此执行，不在 per-plan Done 后独立执行。**

PM 触发 `mstar-compound`（可批量）：

1. **收集素材**：回顾本迭代所有 plan 的实现、debug、review 过程，识别以下类型的可结晶知识：
   - 非平凡 bug 修复及其诊断过程
   - 新引入的架构模式或约定
   - 工具链决策及其理由
   - 跨 plan 重复出现的模式
   - 有价值的排错经验

2. **逐条判定**：对每条候选知识，回答 `mstar-compound` 的 Q1-Q8 自检；跳过项要在 compass `## Compound Round Summary` 记录原因。

3. **写入或更新**：值得结晶的条目按 `mstar-compound` Phase 1-7 写入 `{KNOWLEDGE_DIR}/<category>/<slug>.md`，或在高重叠时更新已有文档。

4. **CONCEPTS.md 协同**：若迭代中引入了新的领域词汇，更新 `<repo-root>/CONCEPTS.md`（`mstar-compound` Phase 5）

5. **索引登记（强制）**：每新增一篇 knowledge doc，必须完成 `mstar-compound` Phase 6，在 `{KNOWLEDGE_DIR}/README.md` 登记一行。Lightweight compound 不豁免 Phase 6。

若本轮没有值得结晶的知识，仍须在 `## Compound Round Summary` 写明 `无可结晶知识` 及原因。

### 3.3 更新 roadmap

1. 更新 compass **`## Roadmap Position`**（§3.0.5 已确保本节存在）：
   - current iteration 行标记为 **`delivered`**（或等价明确措辞）
   - next iteration 更新为即将开始的内容、触发条件、owner
2. 若 `status.json` 中有 `plans[].metadata.roadmap` 字段，同步更新
3. 若存在 deferred-features / roadmap tracker 类文档，按项目惯例刷新
4. 若 `STRATEGY.md` 存在，可更新 `## Decision Log`（重大架构决策时）

### 3.4 标记迭代完成

1. compass **YAML frontmatter**：`status: completed`，`end_date: YYYY-MM-DD`（必须；见 §3.0.5）
2. 更新 `{ITERATION_DIR}/README.md` 索引中该迭代行 Status 为 `completed`
3. 填充 compass `## Compound Round Summary` 与 `## Iteration Retrospective (minimal)`（见模板）

### 3.5 Close exit checklist + commit

**Precondition**: §3.1 checklist `[x]`；§3.4 frontmatter `completed` + `end_date` 已写。

PM 打印 **iteration-close exit checklist**；全部为 `[x]` 后方可 `git commit` / 开 PR：

- [ ] §3.1 前置 gate 已打印并满足
- [ ] §3.2 compound 完成；新增 knowledge doc 均已登记 `{KNOWLEDGE_DIR}/README.md`（或已记录无可结晶原因）
- [ ] §3.3 `## Roadmap Position` current iteration 已标 `delivered`；tracker / STRATEGY 已按需更新
- [ ] §3.4 frontmatter `status: completed` + `end_date`；Compound Summary + Retrospective 已填
- [ ] 当前分支是 `spec_integration_branch`
- [ ] PR base = `metadata.target_branch`（与 compass frontmatter 一致）；**不是**未记录的 `main`

**Commit 到 integration 分支**：

```bash
git add {ITERATION_DIR}/<id>-delivery-compass.md {ITERATION_DIR}/README.md {KNOWLEDGE_DIR}/ CONCEPTS.md
git commit -m "chore(iteration): close <iteration-id> — compound round, roadmap update"
git push origin <spec_integration_branch>
```

PR 目标使用 root `metadata.target_branch`；缺失时停止并补齐，不得默认 `main`。

### 3.6 可选：触发 compound-refresh

若本轮 compound 新增了较多知识文档，或 compass 标记了可能过时的旧知识，触发 `mstar-compound-refresh` 对有重叠的知识文档做维护。

---

## 迭代 compass 模板

完整模板见 `references/iteration-compass-template.md`。

## 与其它技能的关系

| 技能 | 关系 |
|------|------|
| `mstar-dispatch-gates` | Dispatch rules — per-plan loop 引用 |
| `mstar-phase-gates` | per-plan gate 判定 |
| `mstar-plan-conventions` | 路径符号（`{ITERATION_DIR}`、`{HARNESS_DIR}`） |
| `mstar-plan-artifacts` | `status.json` SSOT、`{ITERATION_DIR}` 索引维护 |
| `mstar-review-qc` | QC 三审 — per-plan loop 引用 |
| `mstar-branch-worktree` | 分支/merge/worktree 隔离 |
| `mstar-compound` | iteration-close 中触发知识结晶 |
| `mstar-compound-refresh` | iteration-close 后可触发知识维护 |
| `mstar-strategy` | iteration-start 时读 `STRATEGY.md` 对齐方向 |

## NOT to do

- 不要在 per-plan Done 后立即单独 compound——等 iteration-close 统一做
- 不要在 Autonomous Execute（Phase 2）中修改 per-plan gate 判定
- 不要用 compass 替代 `status.json` 作为 plan 状态 SSOT
- 不要在没有完成 per-plan 前置检查的情况下进入 iteration-close
- 不要在缺少 `iteration_base_branch` / `target_branch` 时默认使用 `main` / `master`
- 不要将 Phase 3 折叠进 final plan closure——须显式 §3.0→§3.5
- 不要用 prose completion status 替代 compass frontmatter `status: completed` + `end_date`
- 不要跳过 compound Phase 6（`{KNOWLEDGE_DIR}/README.md` 索引）——即使只结晶一篇文档
- 不要跳过 compound——如果本迭代确实没有可结晶的知识，在 compass `## Compound Round Summary` 写 `无可结晶知识（原因：<简述>）`
