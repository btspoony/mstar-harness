# `{KNOWLEDGE_DIR}`、`{ITERATION_DIR}` 与 `{SPECS_DIR}` / `residuals/` 散文（Morning Star）

> **Load order（与其它 `mstar-*` skill 一致）**：依赖本 reference 维护知识库 / 迭代 compass / 规格挂接前，须已 Read **`mstar-harness-core`** skill（SKILL.md；仓库写操作与分支门禁见 **`mstar-branch-worktree`**）。冲突以 **`mstar-harness-core`** 为准。

**路径符号（默认）**：`**{KNOWLEDGE_DIR}** = **{HARNESS_DIR}/knowledge/**`；`**{ITERATION_DIR}** = **{HARNESS_DIR}/iterations/**`。完整符号表见 `mstar-plan-conventions` SKILL.md「Harness 与 Plan 目录发现」。

本节将「用户文档」与「agent / 实施用知识」分开，**与具体业务仓库无关**；项目可在根目录 `AGENTS.md` 用一小段指向本 reference 或复述分界关键词，避免重复维护长文。

## 与公开文档目录的分工（典型为 `docs/`）


| 区域 | 典型内容 | 受众 / 权威 |
|------|----------|-------------|
| **`docs/`**（或项目约定的用户文档根） | 安装/quickstart、稳定架构概览、贡献指南、对外 API 说明 | 人类贡献者与终端用户；clone 后应可读 |
| **`{SPECS_DIR}`**（可选） | 冻结 v1-spec、ADR、program roadmap | 产品/API 规范性最高权威；变更须显式流程 |
| **`{ITERATION_DIR}`**（可选） | `*-delivery-compass-*`、`*-program-compass-*`、版本范围/验收/风险、遗留 `v1.*` 规划快照 | Agent handoff；**不**替代 `{SPECS_DIR}` |
| **`{KNOWLEDGE_DIR}`**（可选） | 实现细节 SSOT、架构细则、契约说明、跨版本 tracker、性能基线 | Agent handoff；**不**覆盖 `{SPECS_DIR}` 中的规范性条款 |
| **`{PLAN_DIR}/`** | 单 plan 主文件、`reports/`、可选 `residuals/` | 计划执行与审查留档 |


**不应**放入 `docs/` 的内容：迭代 compass 正文、作为**特定 plan 输入/输出**的评审结论、实施笔记、未稳定规格草案、QC 报告 —— 分别落 `{ITERATION_DIR}`、`{KNOWLEDGE_DIR}`、`{SPECS_DIR}` 或 `{PLAN_DIR}/reports/`。

## `{ITERATION_DIR}`（可选·迭代/版本级 compass）

- **物理路径**：`**{ITERATION_DIR}/**`（推荐布局下常为 `**.agents/iterations/**`，与 `{KNOWLEDGE_DIR}`、`{PLAN_DIR}` 并列）。
- **放什么**：某一**交付版本或迭代**的范围、里程碑、验收、风险、program 备注；命名示例 `v1.15-delivery-compass-v1.md`、`*-program-compass-*.md`；遗留非标准 `v1.*` 规划快照可保留于此并列入索引。
- **不放什么**：可跨版本复用的实现 SSOT（进 `{KNOWLEDGE_DIR}`）；冻结产品/API 规范（进 `{SPECS_DIR}`）；单 plan 的 QC 留档（进 `{PLAN_DIR}/reports/`）。
- **索引**：**必须**维护 `**{ITERATION_DIR}/README.md**`：至少 **Document**、**Version / iteration**、**Description**；可按「Delivery compasses」与「Legacy artifacts」分表（参考 Nexus `.agents/iterations/README.md`）。
- **与 plan 的链接**：在 `**plans[].metadata**` 中可用 `**iteration_compass**`（单文件）或 `**iteration_refs**`（`string[]`）登记仓库内相对路径；PM 在 Assignment 点名本轮须读的 compass。
- **维护**：`@product-manager` / `@architect` 起草；`**@project-manager**` 维护 README 与 metadata 挂接；compass 定稿后**少改多版本**（新版本优先新文件名 `v<N>` 或新 compass 文件）。

## `{KNOWLEDGE_DIR}`（可选·实施知识库）

- `{SPECS_DIR}` 定义：优先 `{HARNESS_DIR}/specs/`，否则 `{HARNESS_DIR}/designs/`；若两者都不存在，建议新建 `{HARNESS_DIR}/specs/`。
- **必须**维护 `**{KNOWLEDGE_DIR}/README.md**` 作为**目录索引**：至少包含表格列 **Document（链接）**、**Source Plan（`plans[].id`）**、**Description**、**Status**（如 `Active` / `Superseded by implementation (<plan-id>)` / `Archived`）。
- 可选：目录级 `**{KNOWLEDGE_DIR}/AGENTS.md**` 承载命名、维护节奏、与 `{SPECS_DIR}` 的权威边界（Nexus 模式）；harness 宽规则仍以 `mstar-plan-conventions` 与本 reference 为准。
- 初始化启用知识库时：创建空表头的 `README.md`，随文档递增行。

## 文件命名

- 推荐：`<topic>-<qualifier>-v<N>.md`（例：`sync-contract-gap-analysis-v1.md`），便于同主题多版共存。
- 避免与主 plan 文件名混淆：主 plan 仍建议 `<plan-id>-<plan-name>.md` 且放在 `{PLAN_DIR}/` 根下，而非塞进 `{KNOWLEDGE_DIR}` 根（除非团队明确约定）。
- 迭代 compass 文件名宜带版本/迭代标识，放在 `{ITERATION_DIR}/`，**不要**与 `{KNOWLEDGE_DIR}` 中跨版本 SSOT 混放同一命名空间。

## 与 `status.json` 的链接

- 某 plan 的**权威设计输入**在知识库、迭代 compass 或规格目录中时，在 `**plans[].metadata**` 中登记路径，推荐使用已列标准键：`**primary_spec**`（单文件）、`**spec_refs**`（`string[]`）、`**iteration_compass**` / `**iteration_refs**`（迭代级，可选）。路径为**仓库内相对路径**（推荐布局下常写作 `**.agents/knowledge/....md**`、`**.agents/iterations/....md**` 或 `**.agents/specs/....md**`；兼容旧目录时也可为 `**.agents/designs/....md**`）。
- 执行方在 **implement 前**须按 metadata 读取这些文件，并与主 plan 核对；不得在未读链接文档的情况下**静默偏离**其中已写明的决策（若需偏离，先回写 knowledge 或 plan 并走 PM/architect 门禁）。

## 维护规则

1. **新增**：按命名规则添加 `.md` → 在 `{KNOWLEDGE_DIR}/README.md` 或 `{ITERATION_DIR}/README.md` 索引表增加一行 → 在相关 `plans[].metadata` 更新 `primary_spec` / `spec_refs` / `iteration_*`（若该文档为本 plan 输入/输出）。
2. **阅读**：开发类 agent 在开始编码前，**必须**阅读当前 plan 在 `metadata` 中指向的 knowledge 文档（若存在）；`@project-manager` 在 Assignment 中可再次点名路径。
3. **修订**：评审或规格变更若改动了 knowledge 文件，同步更新 README 中 **Status** 或 Description；版本迭代优先新文件名 `v<N+1>` 或保留旧版并标明 Superseded。
4. **归档**：当文档内容已完全反映到已合并代码中时：**保留文件不删除**（保留设计考据）；将索引 **Status** 标为 `Superseded by implementation (...)` 或 `Archived`。**不要**把知识库产物搬进 `**{HARNESS_DIR}/archived/plans/`**（该处用于**计划行**冷快照）；知识库用索引状态表达生命周期即可。

## 与 `reports/`、`{PLAN_DIR}/residuals/` 的区分

- `**reports/<plan-id>/`**：偏 **审查流程留档**（review、QC1/2/3、consolidated），只读历史。
- `**{PLAN_DIR}/residuals/<plan-id>/`**：偏 **仍 open 的 R# 长文补充**（与根级 `**residual_findings**` 配套，canonical 见 `mstar-plan-conventions` **SKILL.md** 开篇）；见下文「open residual 散文详情」。
- `**{KNOWLEDGE_DIR}/**`：偏 **可复用的实现向设计上下文**（架构细则、决策、分析），可被后续 plan 或多会话反复引用。
- `**{ITERATION_DIR}/**`：偏 **某一迭代/版本** 的 compass 与规划快照，通常按版本索引而非按单 plan 长期复用。
- 四者（reports / residuals / knowledge / iterations）可互链，但职责不混写。

---

## `{PLAN_DIR}/residuals/<plan-id>/`（可选·open residual 散文详情）

当某条 open residual 需要**多于** open 列表（根级 `residual_findings[<plan-id>][]`；若仅存 legacy 侧则同口径）里结构化字段所能承载的叙述时，可在本目录增加 **Markdown 散文**，作为 **SSOT 的补充**（**不替代** JSON；**权威仍以** `**{HARNESS_DIR}/status.json`** 中的 open 条目为准）。


| 与相邻目录的分工                                  | 典型内容                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `**{PLAN_DIR}/reports/<plan-id>/**`       | QC / review **流程留档**（`-qc*.md`、consolidated 等），只读历史链                  |
| **本目录 `{PLAN_DIR}/residuals/<plan-id>/`** | 针对**仍 open** 的某一 R#：defer 背景、遗留原因、代码锚点、后续接手提示等**长文**                  |
| `**{KNOWLEDGE_DIR}/**`            | 可跨 plan 复用的**实现向**设计上下文、规格修订、gap 分析（若文中顺带提到 residual，仍以 JSON + residuals 为跟踪权威） |
| `**{ITERATION_DIR}/**`            | 迭代/版本级 compass；**不**替代 `{KNOWLEDGE_DIR}` 中的跨版本 SSOT |


**文件命名（推荐）**：`<finding-id>-<short-label>.md`，其中 `**finding-id`** 与该条在 **open 列表**（根级 `**residual_findings**`，见 `mstar-plan-conventions` **SKILL.md** 开篇）中的 `**id**`（如 `R1`）或团队约定的 `**td-*` 等技术债编号**一致，便于 `detail_doc` 与目录互查。

**登记**：在对应 open 条目中填写可选 `**detail_doc`**（仓库内相对路径，常形如 `**{PLAN_DIR}/residuals/<plan-id>/R1-….md**`）。**禁止**只写散文、不在 SSOT 中登记 open 行。

**维护**：`**@project-manager`**（或与 Assignment 一致的可写角色）；`**@qc-specialist***` 宿主白名单通常**不含**本目录——审查结论仍以 `**reports/`** 为准，散文由 PM/实现方据结论整理。

**关闭与归档**：当该条从 **open 列表**（根级 **`residual_findings[<plan-id>]`**；若仅存 legacy 侧则从该处）移除并**追加**至 `**{HARNESS_DIR}/archived/residuals/<plan-id>.json`** 时，应将对应 `**.md**` 一并收口：可迁入 `**{HARNESS_DIR}/archived/knowledge/**`（若视为历史考据）、或团队约定的 `**{HARNESS_DIR}/archived/residuals/**` 子路径（与 `**.json**` 同批变更可追溯）；并在归档条目的 `**closure_evidence` / `closure_note**`（或团队约定字段）中**写明散文最终路径**。勿长期保留「JSON 已关闭而散文仍留在 `residuals/` 且声称仍 open」的状态。