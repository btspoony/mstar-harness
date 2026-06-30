---
name: mstar-iteration
description: Morning Star 迭代管理 —— iteration-start（锁定迭代范围与 roadmap）、iteration-drive（跨 plan 进度追踪）、iteration-close（收口知识结晶 `mstar-compound`、更新 roadmap、标记迭代完成）。触发：PM 启动新迭代、跨 plan 编排时、或迭代内所有 plan Done 后。迭代 compass 落盘 `{ITERATION_DIR}/<iteration-id>-delivery-compass.md`；compound 状态记录在 compass 中。适用于一次迭代锁定几个 spec 点（specify+clarify）、多个 plan、每个 plan 多个 tasks 的实践模式。
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
     │ 登记 plans 到 compass                         │ 标记迭代完成
     │ 创建 integration 分支                          │ commit 到 integration 分支
     │                                               │
     └──────── iteration-drive（跨 plan 追踪）────────┘
```

**关键定位**：iteration-close 是 iteration-drive 命令的**最后一个 Phase**，在 integration 分支上执行，**完成后再创建 PR**。所有 compound 产物（knowledge docs、compass 更新、CONCEPTS.md）作为迭代交付的一部分随 PR 合入 main。一次迭代 = 一个 PR。

**per-plan 状态 SSOT**：`{HARNESS_DIR}/status.json`（per-plan Todo/InProgress/InReview/Done）。
**迭代状态 SSOT**：`{ITERATION_DIR}/<id>-delivery-compass.md` frontmatter `status` + `{ITERATION_DIR}/README.md` 索引。

## 产物存储位置

**SSOT**: `mstar-plan-conventions/references/artifact-storage-paths.md`。迭代 compass → `{ITERATION_DIR}/<iteration-id>-delivery-compass.md`；迭代索引 → `{ITERATION_DIR}/README.md`。

---

## Phase 1: iteration-start（启动迭代）

PM 在新迭代启动时执行。

### 1.1 收集上下文

1. 读 `{ITERATION_DIR}/README.md`（若存在），了解历史迭代
2. 读 `STRATEGY.md`（若存在），对齐战略方向
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
| **Roadmap 上下文** | 本迭代在整体 roadmap 中的位置（本批做什么 / 下批做什么） |

### 1.3 创建迭代 compass

写入 `{ITERATION_DIR}/<iteration-id>-delivery-compass.md`：

```markdown
---
iteration_id: <id>
start_date: YYYY-MM-DD
status: active
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
- 本批：<what this iteration delivers>
- 下批：<what comes next, owner, trigger>
```

### 1.4 更新索引

在 `{ITERATION_DIR}/README.md` 中添加一行（首次创建时建立表头）：

| Document | Iteration | Description | Status |
|----------|-----------|-------------|--------|
| `<iteration-id>-delivery-compass.md` | `<iteration-id>` | `<简短描述>` | `active` |

### 1.5 登记到 status.json（可选）

若使用 `status.json`，在 `plans[].metadata` 中为受影响的 plan 设置 `iteration_refs`。

---

## Phase 2: iteration-drive（跨 plan 进度追踪）

PM 在迭代进行中定期执行（每次 Status Update 或 plan 状态变更时）。

### 2.1 同步 plan 状态

1. 读 `{ITERATION_DIR}/<current-iteration-id>-delivery-compass.md`
2. 对 compass 中列出的每个 plan_id，检查 `status.json` 中的实际状态
3. 更新 compass 中的 `## Plans` 表格状态列

### 2.2 检查跨 plan 协调

- 是否有 plan 之间的依赖被阻塞？
- 是否有 plan 需要拆分为多条或合并？
- 是否有新的 plan 需要加入本次迭代？
- 里程碑是否需要调整？

### 2.3 更新 compass

对 compass 做最小增量更新：
- 状态字段
- 新 plan 加入
- 里程碑状态
- Notes 列中记录阻塞或偏离

### 2.4 不在 iteration-drive 中做的事

- **不**触发 compound（留给 iteration-close）
- **不**修改 per-plan gate 判定（那是 PM 在 per-plan 层面的活）
- **不**替代 `status.json` 作为 SSOT——compass 是摘要视图

---

## Phase 3: iteration-close（收口迭代）

PM 在迭代内全部 plan Done 后执行。**本 Phase 在 integration 分支上运行，在 iteration-drive 命令中作为创建 PR 前的最后一步**。产出物（compass、knowledge docs、CONCEPTS.md）commit 到 integration 分支，随 PR 合入 main。

### 3.1 前置检查

确认以下条件全部满足后，方可进入 iteration-close：

- [ ] 所有 compass 中登记的 plan 状态均为 `Done`
- [ ] 所有 plan 的 residual findings 已收口（closed 或 accepted）
- [ ] `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` 各 plan 状态已同步到最新
- [ ] 迭代验收标准已达成或显式豁免

### 3.2 知识结晶（Compound）—— 迭代级核心收口

**Compound 在此执行，不在 per-plan Done 后独立执行。**

PM 触发 `mstar-compound`（可批量）：

1. **收集素材**：回顾本迭代所有 plan 的实现、debug、review 过程，识别以下类型的可结晶知识：
   - 非平凡 bug 修复及其诊断过程
   - 新引入的架构模式或约定
   - 工具链决策及其理由
   - 跨 plan 重复出现的模式
   - 有价值的排错经验

2. **逐条结晶**：对每条识别出的知识，调用 `mstar-compound` 写入 `{KNOWLEDGE_DIR}/<category>/<slug>.md`

3. **是否值得结晶**：PM 使用 `mstar-compound` 中的「是否值得结晶」自检清单逐条评估（见 `mstar-compound` § 是否值得结晶）。

4. **CONCEPTS.md 协同**：若迭代中引入了新的领域词汇，更新 `<repo-root>/CONCEPTS.md`

### 3.3 更新 roadmap

1. 更新 compass 中的 `## Roadmap Position`：
   - 本批状态标记为 `delivered`
   - 下批更新为即将开始的内容
2. 若 `status.json` 中有 `plans[].metadata.roadmap` 字段，同步更新
3. 若 `STRATEGY.md` 存在，可建议更新 `## Decision Log`（若有重大架构决策）

### 3.4 标记迭代完成 + Commit

1. 将 compass frontmatter `status` 更新为 `completed`，添加 `end_date`
2. 更新 `{ITERATION_DIR}/README.md` 索引中该迭代行的 Status 为 `completed`
3. compass 正文末尾追加 Compound Round Summary 和 Retrospective（见 compass 模板）

**Commit 到 integration 分支**：iteration-close 产出的所有 harness 制品必须 commit 到当前 integration 分支，随迭代 PR 合入 main：

```bash
git add {ITERATION_DIR}/<id>-delivery-compass.md {ITERATION_DIR}/README.md {KNOWLEDGE_DIR}/ CONCEPTS.md
git commit -m "chore(iteration): close <iteration-id> — compound round, roadmap update"
git push origin <spec_integration_branch>
```

### 3.5 可选：触发 compound-refresh

若本轮 compound 新增了较多知识文档，或 compass 标记了可能过时的旧知识，触发 `mstar-compound-refresh` 对有重叠的知识文档做维护。

---

## 迭代 compass 模板

完整模板见 `references/iteration-compass-template.md`。

## 与其它技能的关系

| 技能 | 关系 |
|------|------|
| `mstar-harness-core` | 状态机、护栏——per-plan 生命周期不因迭代而改变 |
| `mstar-phase-gates` | per-plan 门禁——迭代不覆盖 per-plan gate |
| `mstar-plan-conventions` | 路径符号（`{ITERATION_DIR}`） |
| `mstar-plan-artifacts` | `status.json` / `{ITERATION_DIR}` 维护规则 |
| `mstar-compound` | iteration-close 中触发知识结晶 |
| `mstar-compound-refresh` | iteration-close 后可触发知识维护 |
| `mstar-strategy` | 迭代启动时读 `STRATEGY.md` 对齐方向 |

## NOT to do

- 不要在 per-plan Done 后立即单独 compound——等 iteration-close 统一做
- 不要在 iteration-drive 中修改 per-plan gate 判定
- 不要用 compass 替代 `status.json` 作为 plan 状态 SSOT
- 不要在没有完成 per-plan 前置检查的情况下进入 iteration-close
- 不要跳过 compound——如果本迭代确实没有可结晶的知识，在 compass 中写 `Compound Round Summary: 无可结晶知识（原因：<简述>）`
