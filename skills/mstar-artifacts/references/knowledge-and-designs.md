# 过程产物边界（Morning Star）

> **Load order**：写入或定位过程产物前，须已 Read **`mstar-harness-core`** skill（SKILL.md；仓库写操作与分支门禁见 **`mstar-branch-worktree`**）。冲突以 **`mstar-harness-core`** 为准。
>
> **三层语料契约不在此文件**：`{KNOWLEDGE_DIR}`（工程经验）、`{SPECS_DIR}`（当前状态）、`{ADR_DIR}`（决策记录）的层间边界、文档骨架、命名、生命周期与可选校验器只在 **`mstar-doc-corpus`**（SKILL.md § The three layers 与 `references/specs.md` / `references/adr.md` / `references/knowledge-format.md`）。本文件只拥有**过程产物**。

**路径符号（默认）**：`**{KNOWLEDGE_DIR}** = **.agents/knowledge/**`，`**{ITERATION_DIR}** = **{HARNESS_DIR}/iterations/**`；`{SPECS_DIR}` / `{ADR_DIR}` 的默认值（`.agents/specs` / `.agents/adr`）与 `.mstarc` 覆盖 → **`mstar-doc-corpus`** SKILL.md § Layout defaults；完整发现链（`.mstarc` 权威 → `.agents/` → `docs/specs/`、`docs/adr/`、legacy `designs/` 与 `{HARNESS_DIR}/<kind>/` 只读）→ **`mstar-conventions`** SKILL.md「路径符号」。写入这三层前先解析符号，不要自行拼默认路径。

本文件将「agent / 实施过程产物」与「三层语料」分开，**与具体业务仓库无关**；项目可在根目录 `AGENTS.md` 用一小段指向本 reference 或复述分界关键词，避免重复维护长文。

## 过程产物 vs 三层语料

过程产物**不进入**三层语料，三层内容也**不迁入**过程产物。**本表是过程产物边界表的唯一权威**（哪个区域放什么、受众与权威）；三写域（process SSOT / tracked results / product source）的可写性 → **`mstar-branch-worktree`** § Harness path SSOT under default gitignore。

| 过程产物 | 典型内容 | 权威 / 生命周期 |
|----------|----------|-----------------|
| `{ITERATION_DIR}/<iteration-id>/` | `delivery-compass.md`、`guides/`、`specs/`、`prototypes/` | Agent handoff 与迭代级草稿；close 时经 compound **提升** |
| `{PLAN_DIR}/` | 主 plan、durable gate summary、可选 `residuals/` | 计划执行与长期门禁决策留档 |
| `{SDD_DIR}/review/` | review package、QC1/2/3、consolidated、PM Acceptance | **流程临时证据**，gitignored，Done 后可丢失 |
| `{PROJECT_DIR}/<id>/references/` | surveys、epic roadmaps、第三方 notes | 与项目绑定；engine 只列文件名，**无 markdown schema** |
| `{PLAN_DIR}/residuals/<plan-id>/` | 仍 open finding 的长文补充 | 只补充、**不替代** store issue |

**不应**放入 `docs/` 的内容：迭代 compass 正文、作为特定 plan 输入/输出的评审结论、实施笔记、未稳定规格草案、QC/PM Acceptance 原始过程报告。人类文档在 `docs/`（安装、quickstart、贡献指南）。

## `{ITERATION_DIR}` 与 `{PROJECT_DIR}/<id>/references/`

- **`{ITERATION_DIR}/<iteration-id>/`**：`delivery-compass.md`（authored 迭代范围输入，非运行状态权威）、`guides/`、`specs/`、`prototypes/`、可选 package `README.md`。ACTIVE 运行状态在 store `execution_*` 行。**不放**已锁定的仓库级规范（→ `{SPECS_DIR}/`）、已提升的跨迭代经验（→ `{KNOWLEDGE_DIR}/`）、单 plan 原始 QC 报告（→ `{SDD_DIR}/review/`）。
- **登记**：迭代 identity、compass 位置、description、project 归属与 package 内文档关系都是 catalog 行；根 `README.md` 与 package `README.md` 保留为**散文**，不维护「一行 = 一次迭代」的登记行。
- **Compass 路径**：canonical `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`；legacy flat `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` 仅兼容读，**不要**新写。
- **`{PROJECT_DIR}/<id>/references/`**：主题化研究（surveys、epic roadmaps、第三方 notes），与项目绑定（项目缺失用 `_default`）。**不放**当前状态规格 / ADR、compound 经验、迭代草稿；研究**不**迁入三层语料，三层内容也**不**迁入此处。
- **engine 边界**：`listProjectReferenceFiles(projectDir)` 只返回文件名（相对路径、`/` 分隔、code-unit 排序；跳过根级 `roadmap.md` / `residuals.json`；缺失目录 → `[]`），**不**读正文、**不**做 markdown schema 校验——归属语义是本 reference 的契约。harness 根 `.mstar/references/` 已退役。

## 与执行 plan 行及 catalog 的链接

- plan 的**权威设计输入**在规格或迭代 compass 中时，经公共 prepare 域边界冻结到 store 执行 plan 行的 `metadata`：**`primary_spec` / `spec_refs`** → 优先 `{SPECS_DIR}/`；**`iteration_compass` / `iteration_refs`** → `{ITERATION_DIR}/`。知识关联载体是 catalog relations（`catalog link`）；snapshot `plans[].metadata.knowledge_refs` 仅迁移源只读，不推定新的 engine 行为。
- implement 前：先查 catalog（`mstar catalog list`，按 kind / document kind / lifecycle 过滤）发现当轮相关 `active` 文档（发现式阅读，不要求通读全库）；再按 metadata 读取已登记路径；均与主 plan 核对。不得在未读链接文档的情况下**静默偏离**其中已写明的决策（需偏离时先回写 knowledge 或 plan 并走 PM/architect 门禁）。
- catalog 与文件同步：文件删除或迁入本地归档时，对应行置 `superseded` / `archived` 或移除；**不允许**「文件已删而 catalog 行仍 active」。

## 与 review bundle、residuals 的区分

- `{SDD_DIR}/review/`：审查**流程临时证据**（review package、QC1/2/3、consolidated、PM Acceptance），gitignored，可在 Done 后丢失。
- 主 plan **gate summary**：长期门禁决策摘要（verdict、review range、R#、PM Acceptance gate），随主 plan 追踪。
- `{PLAN_DIR}/residuals/<plan-id>/`：仍 open finding 的**长文补充**，与 plan-linked store issue 配套，**不替代** store issue 权威；命名 `<issue-id>-<short-label>.md`。先经 `mstar plan issue-add` / `mstar issue add` 捕获 issue，再附散文路径证据；issue 关闭后同批收口散文（迁入 `{HARNESS_DIR}/archived/knowledge/` 或在关闭证据写明最终路径），不留「issue 已关闭而散文仍声称 open」。
- 四者可互链，但职责不混写：knowledge 说经验，specs 说现状，ADR 说取舍，review bundle 说过程（三层语料边界 → **`mstar-doc-corpus`**）。
