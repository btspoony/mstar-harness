---
name: mstar-iteration
description: Morning Star 迭代管理 —— iteration-start（specs + `<iteration-id>/` workspace；禁止直写 knowledge）、Autonomous Execute、iteration-close（compound 提升 workspace → knowledge）、PR 交付、PR merge-ready loop。分支 SSOT：`status.json` + compass frontmatter。
---

# mstar-iteration（迭代管理）

## Load order

**Read `mstar-harness-core` first.** Path symbols → **`mstar-plan-conventions`**. Per-plan gates → **`mstar-phase-gates`**. Knowledge crystallization → **`mstar-compound`**. **Phase 2 implement 波次**（进入 per-plan implement 前）→ **`mstar-sdd`** + **`mstar-dispatch-gates`**。Phase 2 QC 前 → **`mstar-review-qc`**。On conflict, **`mstar-harness-core` wins**.

## 设计思路

mstar 实践模式通常是：一次迭代锁定几个 spec 点（`specify + clarify`），产生多个 `plan`，每个 plan 含多个 tasks。**per-plan 生命周期有完整的闭环**（Prepare → Execute → QC → Done）。Compound 不是 per-plan 活动——它是**迭代级收口**，在迭代内所有 plan Done 后，沉淀一轮知识。

本 skill 管理迭代 **Phase 1–5**（command 层可聚合编排，但 **不得**反向引用 command 名；第三方 helper 仅由 command 按需发现）：

```
Phase 1: iteration-start
     ↓
Phase 2: Autonomous Execute  —— [per-plan lifecycle × N]
     ↓
Phase 3: iteration-close
     ↓
Phase 4: PR delivery（开 PR）
     ↓
Phase 5: PR merge-ready loop —— 至 mergeable + CI 全绿 + reviews resolved
     ↓
迭代交付完成
```

**关键定位**：

- **Phase 3** 在 integration 分支收口 compound / roadmap；**开 PR（Phase 4）≠ 迭代交付完成**。
- **Phase 5** 是 **merge-ready loop**：修复 → push → 再验证，直至 §5.5 exit。**Loop 理念 SSOT 在本 skill**；宿主 command 可叠加额外 helper，但不写入 `mstar-*` load order。
- 一次迭代 = 一个 PR；compound 产物随 PR 合入 `metadata.target_branch`。

## Phase transition gates（HARD — 防跳步）

| 边界 | 触发 | 必须 | 禁止 |
|------|------|------|------|
| **→ Phase 3** | `status.json` 中 compass 登记的全部 plan 均为 `Done` | 打印 `## Phase 3: iteration-close`；执行 §3.0→§3.5；host todo `phase-3-iteration-close` 保持 open 直至 §3.5 | 开 PR；宣称迭代交付完成；仅依赖 final plan closure |
| **→ Phase 4** | §3.5 exit checklist 全 `[x]`；frontmatter `status: completed` + `end_date` | 打印 `## Phase 4: PR delivery`；开 PR 到 `metadata.target_branch`（§4） | 跳过 §3.1 entry checklist 或 compound Phase 6 |
| **→ Phase 5** | Phase 4 PR 已创建 | 打印 `## Phase 5: PR merge-ready`；执行 §5 loop 至 §5.5 exit | 开 PR 后停止；跳过 review resolve / CI loop |
| **→ 迭代交付完成** | §5.5 exit checklist 全 `[x]` | PR mergeable；required CI 全绿；reviews resolved | Phase 4 开 PR 即宣称完成 |
| **iteration-start → integration branch** | §1.6 Review & Edit chain | 三角色按序 invoke；**specs** 为主产出；**禁止** start 链向 `{KNOWLEDGE_DIR}/` 新增；writing-specialist corpus hygiene + compass `status: locked` | PM 代做专业编辑；并行三角色；product/architect 写 knowledge；临时笔记进 specs |

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

**Direction lock**：compass/plans 初稿落盘前，PM 须与用户逐问收敛**单一**迭代方向、成功标准、非目标，并确认 delivery branch policy；决策写入 compass `## Scope` / `## Acceptance Criteria` / `## Non-Goals` 与 Delivery Branch Policy。

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

### 1.5.5 产物边界（specs · iterations · knowledge）

Phase 1 与 §1.6 须遵守 **`references/iteration-artifact-boundaries.md`**（HARD）：

| 树 | iteration-start 主责 | 说明 |
|----|---------------------|------|
| **`{SPECS_DIR}/`** | product-manager、architect | **长期**规范性产出：锁定规格、ADR、契约；plan `primary_spec` / `spec_refs` 主要挂此处 |
| **`{ITERATION_DIR}/`** | product-manager、architect、PM | compass（根）+ **`<iteration-id>/` workspace**（迭代级 specs & guides） |
| **`{KNOWLEDGE_DIR}/`** | **非** start/execute 直写；**`mstar-compound`** @ iteration-close（含 workspace **提升**） | 可复用实施 SSOT |

**禁止**：product/architect 在 §1.6 向 `{KNOWLEDGE_DIR}/` **新增**；把迭代级草案写入 `{SPECS_DIR}/`（应进 `<iteration-id>/specs/` 或 guides）。

### 1.6 Review & Edit chain（integration 分支前强制）

**Phase 1 在 PM lock 前不算完成**——compass/plans 初稿落盘 ≠ Done。

派发机制 → **`mstar-dispatch-gates`**（specialist review-and-edit dispatch，**顺序链**）。PM **不得**将迭代 harness 文档 commit 到 `spec_integration_branch`，直到：

1. **product-manager** → **architect** → **writing-specialist** 已按序 invoke 编辑 compass、plans、`{SPECS_DIR}/` 与 **`{ITERATION_DIR}/<iteration-id>/`** workspace（guides/specs，按需）；**不得**在 start 链向 `{KNOWLEDGE_DIR}/` 新增
2. **writing-specialist** 完成 **corpus hygiene**：全库 `{SPECS_DIR}/` + 既有 `{KNOWLEDGE_DIR}/` 卫生；错放迁回 **`<iteration-id>/`** workspace；细则 → **`iteration-corpus-hygiene.md`**、**`iteration-artifact-boundaries.md`**
3. PM 将 compass `status` 设为 `locked`，并确认各 plan 的 Prepare gate（specify / clarify / plan）

**顺序理由**：产品范围与优先级 → 架构与长期契约（specs）→ 行文、规格库卫生与错放纠正（须在 PM/architect 定稿后扫全库 specs）。并行会导致后手重复劳动或覆盖前手未定稿内容。OpenCode：plain role id — **`mstar-host/references/opencode.md`** § Role-mention hygiene。

**完成证据** = 磁盘上的 compass / plans / specs / iteration 文档修订 + specs（与既有 knowledge）卫生/归档（如有）+ 索引与 metadata 更新 + compass `status: locked`。**不**要求单独的迭代审查报告——迭代审查的 SSOT 是被编辑的文档本身，无 per-plan QC 式审计链。

**反模式**：PM 线程代替三角色完成全部编辑而不 invoke；或将本链三角色并行派发 —— 见 **`mstar-harness-core`** 反模式索引。

---

## Phase 2: Autonomous Execute（per-plan 派发驱动）

**本 Phase 是本 skill 的核心**——定义 per-plan 派发循环的完整流程：前置条件检查、session todos、backlog 读取、integration 分支管理、per-plan dispatch 循环（分支→实现→QC→**QA gate**→Done→合并）、dispatch-first 约束、push 纪律。PM 读取本 Phase 即可执行迭代。

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
| **Cursor** | `TodoWrite` / CreatePlan todos | 当前 `plan_id`；下一批 gates（implement/QC/**QA gate**）；分支 checkpoint；**仅剩 1 个非 Done plan 时追加 `phase-3-iteration-close`**（open 直至 §3.5）；Phase 4 后 **`phase-5-pr-merge-ready`**（open 直至 §5.5） |
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

1. **Plan start — feature branch**：Assignment 用 `Working branch: create <plan-feature-branch> from <spec_integration_branch>`。一个 plan 一条专用实现分支；plan 内多可写并行轨 → **`mstar-branch-worktree`** **`references/parallel-writable-pre-dispatch.md`**
2. **Implement → InReview**（`§ 2.5`）：
   - **默认 `Execution mode: sdd`**（多 task plan；hotfix 可 `inline`）。
   - PM 载入 **`mstar-sdd`** 后，按 plan task 顺序 **串行** per-task 循环（**不是**一次派发 dev 做全部 tasks）：
     1. `sdd-workspace <plan-id>` → `{SDD_DIR}`
     2. `task-brief <plan-file> N` → `{SDD_DIR}/task-N-brief.md`；记录 `BASE_SHA`
     3. Dispatch **one** implementer subagent（`references/implementer-prompt.md`：brief 路径 + report 路径 + `Model tier`；**禁止**贴整份 plan）
     4. Implementer `DONE` → `review-package BASE HEAD` → task diff 文件
     5. Dispatch **one** task reviewer subagent（brief + report + diff + Global Constraints）
     6. Fix loop 直至 review clean；append `{SDD_DIR}/progress.md`；更新 `status.json` / plan checkbox
     7. Next task
   - 每次 Completion Report v2 后更新 `status.json` + 主 plan
3. **QC → QA gate → Done**：per-plan 审查链 → **`mstar-sdd`**（L1–L2）+ **`mstar-review-qc/references/review-responsibility-boundaries.md`**（L3 tri / inline 单席；raw reports in `{SDD_DIR}/review/`，durable summary in main plan/status）+ **`QA gate`**（`mandatory` → `qa-engineer`；`pm-acceptance` → PM checklist）。
4. **Plan complete — merge back**：合并 plan feature branch → `spec_integration_branch`；在下一 plan 或 QC 前解决冲突
5. **Cross-plan 进度同步**：更新 `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` 的 `## Plans` 表状态列
6. **Next plan** 从步骤 1 继续

全部 plan `Done` → **Phase transition gate**（见上文 **Phase transition gates**）：

1. **STOP** per-plan loop — 禁止 merge 后继续下一 plan、禁止开 PR、禁止会话结束语。
2. 打印 **`## Phase 3: iteration-close`**。
3. 按 §3.0 起独立执行至 §3.5。final plan 的 Assignment / closure 仅作输入，**不能**替代 Phase 3 gate。

### 2.5 Dispatch-first（implement 派发约束）

派发纪律 SSOT → **`mstar-dispatch-gates`** · **`mstar-sdd`** · **`mstar-host/references/parallel-dispatch.md`**。

**SDD implement（Phase 2 默认）** — PM **已载入 `mstar-sdd`** 后执行：

| 规则 | 说明 |
|------|------|
| 串行 | 同一 plan 内 **one implementer at a time**；每 task 后 **one fresh task reviewer** |
| Sticky（可选） | Assignment **`SDD implementer session: sticky`** + `implementer-session.json`；implementer **resume**，reviewer **fresh** — `mstar-sdd/references/sticky-implementer-session.md` |
| 文件交接 | brief / report / diff / `progress.md` 在 `{SDD_DIR}`；dispatch prompt **只给路径**，不贴 plan 全文或 task 历史 |
| Assignment 字段 | 每个 implement dispatch 须含 `Execution mode: sdd`、`SDD dir`、`Model tier`；**禁止**省略 `Model tier` |
| 大包 inline | **禁止**把 T1–Tn 或整份 plan 写进 **一个** `fullstack-dev` leaf Assignment 冒充 SDD |
| 分支 diff | 全部 task 完成后 `review-package MERGE_BASE HEAD` → `{SDD_DIR}/review/` branch diff → plan QC tri（N=3） |

Iteration Phase 2 附加：

- PM **NEVER** 在 PM 线程实现产品代码（delegate dev；hotfix 例外见 **`mstar-phase-gates`**）
- `Subagent invokes issued: 0` 而 Assignment 已写出 → **`dispatch incomplete`**；下一条补发 invoke，禁止 PM 顶替
- QC 初轮：**SDD → N=3**；**inline → N=1**；plan QC tri 三席 **同条消息 N=3**（非 implement 轨数）

### 2.6 Push 纪律（Autonomous Execute）

**Continuous execution（HARD）**：Phase 2 Autonomous Execute 经 Phase 5 merge-ready exit 全程 — 不向用户做例行 yes/no check-in。

- 不因 harness 流程问题常问「是否继续」「要不要现在启动」—— **决策、记录、dispatch**
- 进度汇报 / subagent Completion Report 后，下一条必须是 **dispatch 或下一 gate 动作**，不得以确认问句收束 turn
- 未知 → 读 `mstar-*`；仅 **`Blocked`**、secrets、不可逆范围缺口、branch metadata 缺失、或 Phase 5 多轮仍 blocked 时升级用户
- 实际 Git ≠ `working_branch` → **同轮**更新 plan + status
- Per-plan loop **串行**（plan A Done 后再 plan B）；plan 内 SDD task **串行** — 见 §2.4、§2.5、`mstar-sdd` Continuous execution

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
| `## Quality Gate Summary` | 按模板补占位，§3.4 填写 |
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

**Compound 在此执行，不在 per-plan Done 后独立执行。** 工作流 SSOT → **`mstar-compound`**（Q1–Q8 自检、Phase 1–7、Phase 6 索引登记强制）。

PM 批量触发后须：

1. 收集本迭代 plan 实现 / debug / review 素材，筛候选知识
2. **盘点** `{ITERATION_DIR}/<iteration-id>/**` workspace（`guides/`、`specs/`）— **`mstar-compound`**「Iteration workspace promotion」；提升值得保留者进 `{KNOWLEDGE_DIR}/`
3. 逐条过 `mstar-compound` 自检；跳过项记入 compass `## Compound Round Summary`
4. 写入或更新 `{KNOWLEDGE_DIR}/<category>/<slug>.md`；新领域词更新 `CONCEPTS.md`
5. **每篇**新 doc 完成 Phase 6（`{KNOWLEDGE_DIR}/README.md` 登记）

若无结晶且无 workspace 提升，仍在 `## Compound Round Summary` 写明 `无可结晶知识` / workspace 盘点结论及原因。

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
3. 填充 compass `## Quality Gate Summary`、`## Compound Round Summary` 与 `## Iteration Retrospective (minimal)`（见模板）

### 3.5 Close exit checklist + commit

**Precondition**: §3.1 checklist `[x]`；§3.4 frontmatter `completed` + `end_date` 已写。

PM 打印 **iteration-close exit checklist**；全部为 `[x]` 后方可 `git commit`；然后进入 **Phase 4**（§4）：

- [ ] §3.1 前置 gate 已打印并满足
- [ ] §3.2 compound 完成；**`<iteration-id>/` workspace 已盘点**（提升 / 保留 / 跳过已记入 Compound Summary）；新增 knowledge doc 均已登记 `{KNOWLEDGE_DIR}/README.md`（或已记录无可结晶原因）
- [ ] §3.3 `## Roadmap Position` current iteration 已标 `delivered`；tracker / STRATEGY 已按需更新
- [ ] §3.4 frontmatter `status: completed` + `end_date`；Quality Gate Summary + Compound Summary + Retrospective 已填
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

## Phase 4: PR delivery（开 PR）

**Precondition**: Phase 3 §3.5 exit 全 `[x]`；close commit 已 push 到 `spec_integration_branch`。

1. 打印 **`## Phase 4: PR delivery`**
2. Resolve target：`metadata.target_branch`（compass frontmatter 镜像）；缺失 → **STOP**，问用户
3. 创建 PR：`spec_integration_branch` → `target_branch`
4. 记录 PR URL / number（Phase 5 会话 SSOT）
5. **Immediately** 进入 **Phase 5** — **Phase 4 exit ≠ 迭代交付完成**

---

## Phase 5: PR merge-ready loop

**Precondition**: Phase 4 PR 已创建且 head = `spec_integration_branch`。

**Loop 理念**（mstar SSOT）：PR 开完后进入 **验证—修复—再验证** 循环，直至 PR 可合并。与 Phase 2 per-plan loop 类似，但对象是 **PR 级** merge 门禁（CI、review、冲突），不是 plan 实现。

### 5.0 Phase boundary

- Phase 5 在 PR head（`spec_integration_branch`）上 push 修复；**禁止**另开替代分支
- 产品代码修复 → PM **dispatch** dev/ops（`mstar-dispatch-gates`）；PM 线程不代写实现
- 禁止为「让 CI 变绿」而改 workflow，除非用户明确授权

### 5.1 Loop（repeat until §5.5 exit）

1. **Status** — PR mergeable？required CI？unresolved review threads？
2. **Merge conflicts** — blocking 则在 integration 分支解决 → push（意图冲突 → **Blocked**）
3. **Reviews** — fetch unresolved threads；triage；dispatch 修复 → push
4. **CI** — 失败项在 PR 范围内修复 → push
5. **Review fix hygiene**（每次因 review 而 push 后）：
   - 在同 thread **comment**（改动 + 验证）
   - **Resolve** when addressed
6. Return to step 1

### 5.2 Phase 5 exit checklist（迭代交付完成）

打印 **`## Phase 5 exit checklist`**；全 `[x]` 后方可宣称 **迭代交付完成**：

- [ ] PR mergeable（无 blocking merge conflicts）
- [ ] All **required** CI checks green on latest head
- [ ] All review threads **resolved**（或用户书面 waive 特定 thread）
- [ ] §5.1 review comment + resolve 已覆盖本轮所有 addressed feedback
- [ ] Host todo `phase-5-pr-merge-ready` 可勾选

PR **merge** 本身可仍由用户手动执行，除非 Assignment 明确授权 auto-merge。

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
| `mstar-sdd` | SDD implement 波次 — per-plan loop |
| `mstar-review-qc` | SDD 强制 plan QC tri — per-plan loop |
| `mstar-branch-worktree` | 分支/merge/worktree 隔离 |
| `mstar-compound` | iteration-close 中触发知识结晶（**唯一**默认 knowledge 新增路径） |
| `mstar-compound-refresh` | iteration-close 后可触发知识维护 |
| `references/iteration-artifact-boundaries.md` | Phase 1 specs / iterations workspace / knowledge 分工 |
| `references/iteration-workspace-readme-template.md` | `<iteration-id>/README.md` 可选模板 |
| `references/iteration-corpus-hygiene.md` | §1.6 writing-specialist specs 卫生细则 |
| `mstar-strategy` | iteration-start 时读 `STRATEGY.md` 对齐方向 |

## NOT to do

- 不要在 per-plan Done 后立即单独 compound——等 iteration-close 统一做
- 不要在 Autonomous Execute（Phase 2）中修改 per-plan gate 判定
- **不要在 Phase 2 用 inline 大包 Assignment 替代 SDD per-task 循环**（除非 plan 显式 `Execution mode: inline` / hotfix）
- 不要用 compass 替代 `status.json` 作为 plan 状态 SSOT
- 不要在没有完成 per-plan 前置检查的情况下进入 iteration-close
- 不要在缺少 `iteration_base_branch` / `target_branch` 时默认使用 `main` / `master`
- 不要将 Phase 3 折叠进 final plan closure——须显式 §3.0→§3.5
- 不要用 prose completion status 替代 compass frontmatter `status: completed` + `end_date`
- 不要跳过 compound Phase 6（`{KNOWLEDGE_DIR}/README.md` 索引）——即使只结晶一篇文档
- 不要跳过 compound——如果本迭代确实没有可结晶的知识，在 compass `## Compound Round Summary` 写 `无可结晶知识（原因：<简述>）`
- 不要将 **Phase 4 开 PR** 等同于 **迭代交付完成** — 必须完成 **Phase 5** §5.5 merge-ready loop
- **不要在 iteration-start §1.6 由 product/architect 向 `{KNOWLEDGE_DIR}/` 新增文档**（知识 → iteration-close **`mstar-compound`**）
- **不要把迭代级草案写入 `{SPECS_DIR}/`**（应进 `{ITERATION_DIR}/<iteration-id>/specs/` 或 `guides/`）
- **不要在 iteration-close 跳过 `<iteration-id>/` workspace 盘点**（compound 提升 SSOT → **`mstar-compound`**）
- **不要在 iteration-start §1.6 跳过 writing-specialist 全库 specs corpus hygiene**（仅改当轮 compass/plans 而不扫 `{SPECS_DIR}/`）
- **不要在 SDD plan 上以单席 `qc.md` 收尾**（除非用户书面 `QC mode: single — override`）
