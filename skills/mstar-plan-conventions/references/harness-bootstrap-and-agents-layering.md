# Harness 初始化与 `AGENTS.md` 分层策略（Morning Star）

> **Load order**：使用本参考初始化仓库前，须先 Read `mstar-harness-core` 与 `mstar-plan-conventions`；冲突以 `mstar-harness-core` 为准。

## 目标

给新仓或迁移仓提供一套可复制的启动方式，确保：

- `status.json` / residual / reports 有唯一落点；
- 根规则与 harness 规则不互相覆盖；
- 目录级 `AGENTS.md` 只承载增量边界，不变成重复手册。

## Bootstrap 最小步骤

1. 创建 `{HARNESS_DIR}`（推荐 `.agents/`）与 `{PLAN_DIR}`（推荐 `.agents/plans/`）。
2. 初始化 `status.json`：推荐从 **`mstar-plan-conventions/templates/status.empty.json`** 复制；residual canonical 见 **`mstar-status-residuals` SKILL.md**；字段与生命周期见 **`mstar-status-residuals/references/status-and-residuals.md`**。
3. 初始化可选 `notes.json`（可复制 **`mstar-plan-conventions/templates/notes.empty.json`**）与 `plans/reports/README.md`。
4. 可选：创建 `{ITERATION_DIR}`（`iterations/` + `README.md`）与 `{KNOWLEDGE_DIR}`（`knowledge/` + `README.md`）；内容边界见 `mstar-plan-conventions` SKILL.md 与 `references/knowledge-and-designs.md`。
5. 创建 `.agents/AGENTS.md`（harness 子树规则）：符号表可复述 `{HARNESS_DIR}`、`{PLAN_DIR}`、`{ITERATION_DIR}`、`{KNOWLEDGE_DIR}`、`{SPECS_DIR}` 与 `docs/` 分工（参考 Nexus `.agents/AGENTS.md`）。
6. 校准根 `AGENTS.md`：只保留仓库级长期约束，显式引用 `.agents/AGENTS.md` 作为 harness SSOT。
7. 仅在确有稳定边界时新增目录级 `AGENTS.md`（如 `contracts/`、`gateway/`、`sdk/`）。

## 三层 `AGENTS.md` 职责切分

### 根 `AGENTS.md`（项目层）

- 放：仓库身份、技术边界、构建/测试接口、安全与分支策略、规格路由表。
- 不放：动态状态、当前批次进展、R# 明细、QC 单次结论。

### `.agents/AGENTS.md`（harness 层）

- 放：`{HARNESS_DIR}`/`{PLAN_DIR}`/`{ITERATION_DIR}`/`{KNOWLEDGE_DIR}`/`{SPECS_DIR}` 契约、`docs/` 与 harness 子树内容边界、状态推进门禁、QC/QA 对齐规则、residual 生命周期、Done compaction profile。
- 不放：语言/框架编码细节、业务模块实现约束。

### `<subdir>/AGENTS.md`（边界层）

- 放：该目录独有的边界、禁区、接口命令与升级触发。
- 不放：根级通用规则复写、harness 全量规则拷贝。

## 分目录 `AGENTS.md` 创建准入

仅当满足任一条件时创建：

- 目录具备独立风险模型（如链上合约 vs 网关服务）；
- 目录有单独发布面或对外 API 面；
- 目录有稳定且长期存在的专属约束（构建、依赖、数据/安全边界）。

若仅是代码组织而无新增约束，不创建目录级 `AGENTS.md`。

## 推荐模板骨架（目录级）

```markdown
# AGENTS.md — `<dir>/`

## Source Priority
1. Current user instruction
2. Root `AGENTS.md`
3. This file
4. `.agents/AGENTS.md`

## Boundary Rules
- ...

## Build & Test (interface)
- ...

## Escalation Triggers
- ...
```

## 反模式与修正

- 反模式：在根 `AGENTS.md` 维护当前计划进展与 commit 列表。  
  修正：迁移到 `status.json` 的 `plans[].metadata` 与 `notes.json`。

- 反模式：每个子目录复制一份完整 harness 规则。  
  修正：保留一行引用 `.agents/AGENTS.md`，仅写本目录增量约束。

- 反模式：目录级规则未声明 Source Priority，冲突时不可裁决。  
  修正：统一四级优先级模板并在每个目录级文件开头声明。
