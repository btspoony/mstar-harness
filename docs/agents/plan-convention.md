# 计划管理约定

本文档定义了 agent 体系中计划（plan）目录的发现、初始化和使用规范。
所有 agent 共享此约定；各角色提示词中不再重复描述，仅引用本文档。

## Plan 目录发现

Agent 在项目中按以下优先级查找 plan 目录（找到第一个即停止）：

1. `.agents/plans/`
2. `.plans/`
3. `plans/`

如果以上目录均不存在，则视为**该项目未启用 plan 管理**。此时 agent 仍可正常工作，只是不维护 plan 文档和 status.json，任务进度通过对话和回报传递。

> **约定**：将发现到的目录称为 `{PLAN_DIR}`，后续文档中 `{PLAN_DIR}/status.json`、`{PLAN_DIR}/<name>.md` 等均指实际解析到的路径。

## 目录布局（推荐）

与审查留档、并行 QC、归档分层的典型布局如下（`{PLAN_DIR}` 为解析结果，常为 `.agents/plans/`）：

```text
{PLAN_DIR}/
├── <plan-id>-<plan-name>.md   # 主计划文件
├── status.json                 # 状态 + residual_findings SSOT
├── reports/                    # 审查类补充报告（只读历史留档）
│   ├── README.md               # 说明本目录用途与命名（建议初始化时创建）
│   └── <plan-id>/              # 按 plan 分目录
│       ├── <plan-id>-review.md
│       ├── <plan-id>-qc1.md
│       ├── <plan-id>-qc2.md
│       ├── <plan-id>-qc3.md
│       └── <plan-id>-qc-consolidated.md
├── archived/                   # 可选：已关闭计划的快照或搬迁
└── knowledge/                  # 可选：与计划相关的长期知识片段
```

- **主计划**：技术方案、任务清单、Sign-off 仍以 `<plan-id>-<plan-name>.md` 与 `status.json` 为权威。
- **reports/**：架构评审、QC 分报告、QC 汇总结论；**视为只读历史**，不在此反复改写同一结论（修正走新报告或回写主计划 / `status.json`）。
- **residual findings**：**一律**登记在 `status.json` 的 `metadata.residual_findings[<plan-id>]`（见下文），勿仅留在对话或分散在多个 markdown 中。

### 与项目文档「可到达性」对齐

若项目根 `AGENTS.md`（或其它已提交文档）要求：**fresh clone 后读者能打开文内引用的路径**（且不引用仓库外绝对路径），则：

- 需要 handoff 的 plan / reports 应**被 Git 跟踪**，或改为不依赖被 ignore 的路径写进已提交文档。
- 若将 `{PLAN_DIR}` **整体**加入 `.gitignore`，则**不得**在已提交的 `docs/`、`README`、`AGENTS.md` 中把该目录下文件当作唯一权威引用。

## 初始化 Plan 目录

当 @project-manager 判断某项目需要 plan 管理但尚无 plan 目录时：

1. 创建 `.agents/plans/` 目录（首选，因为对原有项目结构侵入最小）。
2. 在 `.agents/plans/` 下创建 `status.json`（见下文完整结构：含 `metadata.residual_findings`）。
3. 创建 `{PLAN_DIR}/reports/README.md`，用途与命名约定与仓库内其它说明一致即可（可参考各业务仓库 `reports/README.md` 模板）。
4. **Git 策略（与项目 `AGENTS.md` 一致）**
   - **推荐（团队交付 / agent handoff）**：**不要**将 `{PLAN_DIR}` 整体加入 `.gitignore`，以便 clone 后计划与报告路径可达。
   - **仅本机私密**：若必须 ignore 整个 `{PLAN_DIR}`，则按上文「可到达性」约束已提交文档；敏感片段另用密钥或私密渠道管理。
5. 如果项目已有 `plans/` 或 `.plans/` 目录，**不要再创建 `.agents/plans/`**，直接使用已有目录，并视需要补建 `reports/` 与 `metadata` 结构。

## 与 Superpowers `writing-plans`（提示词门限）

上游 **Superpowers** 插件自带的 `writing-plans` 技能默认将计划保存到 `docs/superpowers/plans/`，与本节 **`{PLAN_DIR}`** 约定冲突。

**Harness 门限（优于技能正文中的保存路径）：** 任一角色在加载并执行 **`writing-plans`** 时，须将新计划写入按上文解析到的 **`{PLAN_DIR}`**（推荐文件名 **`<plan-id>-<plan-name>.md`**，或与项目既有 plan 命名一致；亦可用 `YYYY-MM-DD-<feature-name>.md` 等可追溯形式），**禁止**在业务仓库中默认使用 `docs/superpowers/plans/`。需要新建目录、`status.json`、`reports/README.md`、Git 策略时，按本节 **「初始化 Plan 目录」**；`status.json` 的登记与状态仍由 @project-manager 按本文档负责。

各角色提示词中对本门限有短引用（见 `~/.config/opencode/agents/project-manager.md`、`product-manager.md`、`architect.md`）；完整消解表见 `superpowers-skills.md`。

## `{PLAN_DIR}/status.json` 结构

`status.json` 是计划条目状态与 **residual findings** 的**单一事实来源（SSOT）**。

```json
{
  "version": 1,
  "updated_at": "YYYY-MM-DD",
  "plans": [
    {
      "id": "plan-id",
      "title": "计划标题",
      "file": "{PLAN_DIR}/plan-id-feature-name.md",
      "status": "Todo | InProgress | InReview | Blocked | Done",
      "owner": "@project-manager",
      "agents": ["@fullstack-dev"],
      "progress": 0,
      "tags": [],
      "created_at": "YYYY-MM-DD",
      "updated_at": "YYYY-MM-DD",
      "done_at": null,
      "notes": ""
    }
  ],
  "metadata": {
    "residual_findings": {
      "plan-id": [
        {
          "id": "R1",
          "title": "Finding title",
          "severity": "critical | high | medium | low | warning",
          "source": "QC-#1, QC-#3, review, …",
          "scope": "Affected file or component",
          "decision": "defer | accept | risk-accepted",
          "owner": "@fullstack-dev",
          "target": "Before plan 02 / YYYY-MM-DD / milestone",
          "tracking": "Issue URL or null"
        }
      ]
    }
  }
}
```

- 初始化时若尚无 findings，使用 `"metadata": { "residual_findings": {} }`。
- **`plans[].id`** 与 **`metadata.residual_findings`** 的键应对齐（同一 `plan-id`），便于 `jq` 与报告目录 `reports/<plan-id>/` 一致。
- **严重等级**（与 `review-harness.md` 门禁对齐）：`critical` / `high` 为合并前须处理或显式升级；`medium` / `low` / `warning` 可作为 residual 跟踪。

### 常用查询示例

```bash
# Replace .agents/plans with your resolved {PLAN_DIR} if different.
jq '.plans[] | select(.id == "01-data-infrastructure")' .agents/plans/status.json
jq '.metadata.residual_findings["01-data-infrastructure"]' .agents/plans/status.json
```

## Plan 文件（`{PLAN_DIR}/<name>.md`）

每个 plan 的详细内容（任务清单、决策、Sign-off）。

**命名（推荐）**：`<plan-id>-<plan-name>.md`（例：`01-data-infrastructure.md`）。`status.json` 中 `file` 字段填相对仓库根或 `{PLAN_DIR}` 下的实际路径。

**审查报告文件**（置于 `{PLAN_DIR}/reports/<plan-id>/`）：

| 类型 | 文件名 |
|------|--------|
| 架构/设计评审 | `<plan-id>-review.md` |
| QC 并行报告 | `<plan-id>-qc1.md`、`-qc2.md`、`-qc3.md` |
| QC 汇总结论 | `<plan-id>-qc-consolidated.md` |

Plan 正文与 `status.json` 必须保持一致；不一致时以 `status.json` 的条目状态为准并尽快纠正正文或登记 notes。

### Done 标记方式

1. **Frontmatter**（首选）：添加 `status: Done` 和可选的 `done_at: YYYY-MM-DD`。
2. **文件名**（备选）：重命名为 `DONE__<name>.md` 或 `<name>.done.md`。

同时更新 `status.json` 对应条目。

## 状态值

- `Todo` — 待开始
- `InProgress` — 进行中
- `InReview` — 待审查
- `Blocked` — 阻塞
- `Done` — 完成

## 生命周期与产物位置（摘要）

| 阶段 | 含义 | 典型产物 |
|------|------|----------|
| `Todo` | 已登记，未开工 | 主 plan 文件 + `status.json` 条目 |
| `InProgress` | 实现或准备阶段进行中 | 更新的主 plan、`tasks` 勾选 |
| `InReview` | 审查与验证中 | `{PLAN_DIR}/reports/<plan-id>/` 下 `*-review.md`、`*-qc*.md`、`*-qc-consolidated.md`（见上文命名表） |
| `Done` | 已合并/收口 | 主 plan Sign-off、`status.json` 的 `done_at`；未关闭项进入 `metadata.residual_findings` |
| `Blocked` | 等待外部输入或决策 | `notes` 写明原因与解除条件 |

## 状态更新权限

- **Done** 只能由 @project-manager 或 @qa-engineer 设置。
- 可写盘 agent（dev / qa / ops）完成任务后可将状态更新为 `InReview`。
- **@product-manager**、**@architect** 可写 plan 文档中各自负责部分，但**不**应擅自将整条计划在 `status.json` 中改为 `InReview` 或 `Done`（除非 Assignment 明确授权且与 PM 对齐）； **`Done` 仍仅限** PM/QA。
- 只读 agent（qc-specialist / market-expert）将更新内容转达 @project-manager 代为写盘。

## 未启用 Plan 管理时的工作方式

当项目中不存在 plan 目录时：

- @project-manager 通过对话和回报传递任务进度，不创建 plan 文件。
- 各 agent 在 Completion Report 中汇报状态，不引用 plan 路径。
- 如果任务复杂度增加到需要持久化追踪，@project-manager 可建议用户启用 plan 管理（按上述初始化流程创建目录）。
- 所有门禁和审查流程照常运行，不受 plan 目录有无影响。

## 各角色与 Plan 的关系

- **@project-manager**：负责发现 plan 目录、创建/登记 plan、分配任务、推进状态、Done 收口。分配时须告知 subagent plan 目录的实际路径；涉及业务 Git 仓库写操作时须在 Assignment 中写明 **`Working branch`** 或 **`Branch policy`**（见 `harness-loop.md`「Git 功能分支门禁」）。
- **可写盘 agent**（dev / qa / ops）：完成任务后直接更新 plan 文档 + `status.json`。
- **@product-manager**：可更新 plan 文档中需求/验收/用户故事等产品负责部分；**不得**将 `status.json` 中计划状态设为 `Done`；如需改 `progress`/`notes`，以 Assignment 为准或交由 PM 收口。
- **@architect**：可更新 plan 文档中架构、接口契约、技术里程碑等章节；**不得**将 `status.json` 中计划状态设为 `Done`；一般不擅自将整条计划改为 `InReview`（与 PM 对齐）。
- **只读 agent**（qc-specialist / market-expert）：将更新内容转达 @project-manager 代为写盘。
- **所有 agent**：完成后提醒 @project-manager 同步 plan 状态。
