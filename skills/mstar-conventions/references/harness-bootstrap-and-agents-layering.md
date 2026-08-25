# Harness 初始化与 `AGENTS.md` 分层策略（Morning Star）

> **Load order**：使用本参考初始化仓库前，须先 Read `mstar-harness-core` 与 `mstar-conventions`；冲突以 `mstar-harness-core` 为准。

## 目标

给新仓或迁移仓提供一套可复制的启动方式，确保：

- `status.json` / residual / review bundle 有唯一落点；
- 根规则与 harness 规则不互相覆盖；
- 目录级 `AGENTS.md` 只承载增量边界，不变成重复手册。

## Bootstrap 最小步骤

1. 创建 `{HARNESS_DIR}`（推荐 `.mstar/`）与 `{PLAN_DIR}`（推荐 `.mstar/plans/`）。
2. 初始化 `status.json`：从 **`mstar-artifacts/templates/status.empty.json`** 复制（**v2 形状**：`version: 2` + `workflows: []`）；residual canonical 见 **`mstar-artifacts` SKILL.md**；字段与生命周期见 **`mstar-artifacts/references/status-and-residuals.md`**。`projects/_default/`（`roadmap.md` + 空 `residuals.json`）由 **`scaffoldHarness` / `mstar harness scaffold` 预建**；其余 project id 与 `workflows/` 子目录由 engine writers 按需创建（**不**在 bootstrap 预建）。
3. `sdd/` 空目录占位（per-plan 子目录由 **`mstar-sdd`** → `mstar sdd workspace <plan-id>` 创建）。
4. 项目根 `.gitignore` 追加 Morning Star **进程产物**忽略集（canonical snippet → `mstar-conventions` SKILL.md「Git 跟踪策略」；legacy `.agents/` 有等价表）。
5. 可选：创建 `{ITERATION_DIR}`（`iterations/` + `README.md`）与 `{KNOWLEDGE_DIR}`（`knowledge/` + `README.md`）；`{HARNESS_DIR}/specs/`（解析后的 `{SPECS_DIR}` 默认落点）；内容边界见 `mstar-conventions` SKILL.md 与 `references/knowledge-and-designs.md`。
6. 创建 `{HARNESS_DIR}/AGENTS.md`（harness 子树规则；**tracked**）：符号表可复述 `{HARNESS_DIR}`、`{PLAN_DIR}`、`{ITERATION_DIR}`、`{KNOWLEDGE_DIR}`、`{SPECS_DIR}` 与 `docs/` 分工；新项目推荐 `.mstar/AGENTS.md`，已有项目可继续使用 `.agents/AGENTS.md`。
7. 校准根 `AGENTS.md`：只保留仓库级长期约束，显式引用 `{HARNESS_DIR}/AGENTS.md` 作为 harness SSOT。
8. 仅在确有稳定边界时新增目录级 `AGENTS.md`（如 `contracts/`、`gateway/`、`sdk/`）。

**程序化路径**：`mstar harness scaffold [path]`（CLI，默认 cwd）一次性完成步骤 1–2（含 `projects/_default/`）、4 与 6 —— 调用 engine `scaffoldHarness`、追加 canonical gitignore snippet（已存在则跳过）、写最小 `{HARNESS_DIR}/AGENTS.md`（已存在则跳过）；幂等，重跑只补缺失件。步骤 3、5、7、8 仍按需手工。

## Git 跟踪策略（进程 vs 结果）

**原则**：进程留在本地；结果与团队共享。完整规则与 canonical `.gitignore` snippet → **`mstar-conventions` SKILL.md「Git 跟踪策略」**。

| 类别 | 默认 tracked | 默认 gitignored |
|------|--------------|-----------------|
| 结果（跨 clone handoff） | `{HARNESS_DIR}/AGENTS.md`、`{KNOWLEDGE_DIR}/**`、`{SPECS_DIR}/**` | — |
| 进程（本地会话 SSOT） | — | `plans/`、`iterations/`、`status.json`、`workflows/`、`projects/`、`sdd/`、`archived/` |

跨 clone 须持久的 residual 或决策：经 **`mstar-compound`** 提升入 `{KNOWLEDGE_DIR}/`、写入 `{SPECS_DIR}/`，或记入 tracked `{HARNESS_DIR}/AGENTS.md` — **勿**默认 `git add` `status.json` / `plans/`。

## 三层 `AGENTS.md` 职责切分

### 根 `AGENTS.md`（项目层）

- 放：仓库身份、技术边界、构建/测试接口、安全与分支策略、规格路由表。
- 不放：动态状态、当前批次进展、R# 明细、QC 单次结论。

### `{HARNESS_DIR}/AGENTS.md`（harness 层）

- 放：`{HARNESS_DIR}`/`{PLAN_DIR}`/`{ITERATION_DIR}`/`{KNOWLEDGE_DIR}`/`{SPECS_DIR}` 契约、`docs/` 与 harness 子树内容边界、状态推进门禁、QC/QA 对齐规则、residual 生命周期。
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
4. `{HARNESS_DIR}/AGENTS.md`

## Boundary Rules
- ...

## Build & Test (interface)
- ...

## Escalation Triggers
- ...
```

## 反模式与修正

- 反模式：在根 `AGENTS.md` 维护当前计划进展与 commit 列表。  
  修正：迁移到 workflow snapshot 的 `plans[].metadata` 与 `workflows/<id>/notes.jsonl`。

- 反模式：每个子目录复制一份完整 harness 规则。  
  修正：保留一行引用 `{HARNESS_DIR}/AGENTS.md`，仅写本目录增量约束。

- 反模式：目录级规则未声明 Source Priority，冲突时不可裁决。  
  修正：统一四级优先级模板并在每个目录级文件开头声明。
