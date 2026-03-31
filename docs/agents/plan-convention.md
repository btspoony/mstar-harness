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

## 初始化 Plan 目录

当 @project-manager 判断某项目需要 plan 管理但尚无 plan 目录时：

1. 创建 `.agents/plans/` 目录（首选，因为对原有项目结构侵入最小）。
2. 在 `.agents/plans/` 下创建 `status.json`（空 plans 数组）。
3. 检查项目根目录的 `.gitignore`：若不存在则创建，若已存在则追加。确保包含以下条目：

```gitignore
# Agent managed plans
.agents/plans/
```

1. 如果项目已有 `plans/` 或 `.plans/` 目录，**不要再创建 `.agents/plans/`**，直接使用已有目录。

## `{PLAN_DIR}/status.json` 结构

`status.json` 是计划状态的**单一事实来源（SSOT）**。

```json
{
  "version": 1,
  "updated_at": "YYYY-MM-DD",
  "plans": [
    {
      "id": "plan-id",
      "title": "计划标题",
      "file": "{PLAN_DIR}/plan-id.md",
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
  ]
}
```

## Plan 文件（`{PLAN_DIR}/<name>.md`）

每个 plan 的详细内容（任务清单、决策、Sign-off）。
两者必须保持一致；不一致时以 `status.json` 为准并尽快纠正。

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
