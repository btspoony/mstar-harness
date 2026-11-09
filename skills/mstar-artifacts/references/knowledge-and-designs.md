# `{KNOWLEDGE_DIR}`、`{SPECS_DIR}`、`{ADR_DIR}` 与过程产物（Morning Star）

> **Load order（与其它 `mstar-*` skill 一致）**：依赖本 reference 维护知识库 / 规格 / 决策记录前，须已 Read **`mstar-harness-core`** skill（SKILL.md；仓库写操作与分支门禁见 **`mstar-branch-worktree`**）。冲突以 **`mstar-harness-core`** 为准。

**路径符号（默认）**：`**{KNOWLEDGE_DIR}** = **{HARNESS_DIR}/knowledge/**`，`**{ITERATION_DIR}** = **{HARNESS_DIR}/iterations/**`；`{SPECS_DIR}` / `{ADR_DIR}` 的候选链见下两节。完整符号表见 `mstar-conventions` SKILL.md「路径符号」。

本节将「用户文档」与「agent / 实施用语料」分开，**与具体业务仓库无关**；项目可在根目录 `AGENTS.md` 用一小段指向本 reference 或复述分界关键词，避免重复维护长文。

## 与公开文档目录的分工（典型为 `docs/`）

**本表是产物边界表的唯一权威**（哪个区域放什么、受众与权威）；三写域（process SSOT / tracked results / product source）的可写性 → **`mstar-branch-worktree`** § Harness path SSOT under default gitignore。

| 层 | Job（一句话） | 放什么 | 不放什么 | 更新义务 |
|----|--------------|--------|----------|----------|
| **`{KNOWLEDGE_DIR}`** | 从工作中提炼、可跨 plan 复用的**工程经验与方法论** | 模式、教训、how-to、分析手法、被验证的取舍经验 | 当前状态描述、决策过程、实施计划 | iteration-close 经 `mstar-knowledge` 结晶；过时即删除；确需旧经验对照才 `-v<N>` + catalog `superseded` |
| **`{SPECS_DIR}`** | 项目**当前有效状态**的规范性描述 | 架构分层、边界、契约、数据流、当前路径与命令 | plan 文本、验收清单、本地 plan/iteration ID、决策过程 | 同一 PR 随代码更新；失效即删除或移入 `{HARNESS_DIR}/archived/specs/`；latest-only，**无版本后缀** |
| **`{ADR_DIR}`** | **单一决策**及其真实备选与代价 | Problem / Decision / Alternatives / Consequences | 现状描述、实施计划、验收清单 | implemented 记录随现状保持为真；决策改变 → 新记录 + 双向 `Supersedes:`；完全失效且不再指导未来 → `archived/` 冻结 |

一句话关系：**`{SPECS_DIR}` 说现在是什么，`{KNOWLEDGE_DIR}` 说怎么做事与学到什么，`{ADR_DIR}` 说当初为什么选这条、放弃了什么。** 唯一交叉规则：specs 可引用 ADR；ADR 不复制现状；knowledge 不描述现状。

过程产物**不进入**这三层语料，三层内容也**不迁入**过程产物：

| 过程产物 | 典型内容 | 权威 / 生命周期 |
|----------|----------|-----------------|
| `{ITERATION_DIR}/<iteration-id>/` | `delivery-compass.md`、`guides/`、`specs/` | Agent handoff 与迭代级草稿；close 时经 compound **提升** |
| `{PLAN_DIR}/` | 主 plan、durable gate summary、可选 `residuals/` | 计划执行与长期门禁决策留档 |
| `{SDD_DIR}/review/` | review package、QC1/2/3、consolidated、PM Acceptance | **流程临时证据**，gitignored，Done 后可丢失 |
| `{PROJECT_DIR}/<id>/references/` | surveys、epic roadmaps、第三方 notes | 与项目绑定；engine 只列文件名，**无 markdown schema** |
| `{PLAN_DIR}/residuals/<plan-id>/` | 仍 open finding 的长文补充 | 只补充、**不替代** store issue |

**不应**放入 `docs/` 的内容：迭代 compass 正文、作为特定 plan 输入/输出的评审结论、实施笔记、未稳定规格草案、QC/PM Acceptance 原始过程报告。

## `{SPECS_DIR}`（可选·当前状态规格）

- **解析**（非空即停）：`.mstarc` `specs_dir` → `{HARNESS_DIR}/specs/` → `.agents/specs/` → `docs/specs/` → 仓库根 `specs/` → legacy `{HARNESS_DIR}/designs/`、根 `designs/`（仅非空可用）；皆无或皆空则 init 创建 `{HARNESS_DIR}/specs/`。细则 → `mstar-conventions` SKILL.md「`{SPECS_DIR}` 解析」。
- **准入三条件**（同时成立）：① 已锁定，不再随手改；② 跨迭代成立，不是本轮一次性探索；③ plan 的 **`primary_spec` / `spec_refs`** 是指向此处的权威链接。
- **写入时机**：**Phase 3 iteration-close** 提升；**Phase 1 不写** `{SPECS_DIR}`——迭代内规格留在 `<iteration-id>/specs/`。不属于任何 plan 的仓库级现状补录按同一骨架写。
- **骨架**（固定小节，让「现状描述」可审、可 diff）：

  ```markdown
  # <Layer>: <topic>

  ## Scope              这篇覆盖什么、不覆盖什么
  ## Current state      现在是什么：分层、边界、契约、数据流
  ## Invariants         改动不得破坏的约束（可验证）
  ## Where it lives     权威路径 / 命令 / 表（repo-relative）
  ## Change obligations 哪些改变必须同 PR 更新本页
  ```

- **不放什么**：本迭代-only 探索（→ `<iteration-id>/guides/`）；迭代级 spec 草案（→ `<iteration-id>/specs/`）；决策过程（→ `{ADR_DIR}`）；实施踩坑原文（→ plan 素材，close 时 compound 提升）。
- **退化**：原地更新；失效即删除，需人工比对时移入 `{HARNESS_DIR}/archived/specs/`（本地、gitignored）。tracked 层**不保留旧版**——历史在 git 与 ADR，specs 只是当前状态的快速查询层。
- **登记**：identity / path / kind 与 provenance 关系是 `{HARNESS_DIR}/store.db` 的 catalog 行（查询 `mstar catalog list` / `show`；登记走 reviewed `catalog discover` + `import` 或 `catalog register` / `link`）。`{SPECS_DIR}/README.md` 只是散文索引（每篇一行链接），**不是**登记表。

> **Engine check:** `mstar lint <{SPECS_DIR}> --type specs` (engine `lintSpecsDoc` / `lintSpecsTree`) — checks the fixed skeleton, ADR-only sections (`## Problem` / `## Decision` / `## Acceptance criteria` …), a `-v<N>` suffix or date prefix in the filename, a history directory, the README index links, and local-path disclosure (`.mstar/`, `plan_id:`). On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

## `{KNOWLEDGE_DIR}`（可选·经验方法论）

- **放什么**：从工作中提炼的**工程经验与方法论**——可复用模式、教训、how-to、分析手法；**不**放项目当前状态（→ `{SPECS_DIR}`）与决策史（→ `{ADR_DIR}`）。
- **写入 SSOT**：**iteration-close** 时经 **`mstar-knowledge`**（`## Workflow — Capture`）；**iteration-start §1.6 禁止** product/architect 新增（→ `mstar-iteration/references/iteration-artifact-boundaries.md`）。
- **权威**：identity / path / kind / description、provenance 与 catalog 生命周期（`active` / `archived` / `superseded`）是 store.db catalog 行；**不再**要求维护 `README.md` 目录索引行（README 可留作散文导览，表格不构成登记）。查询/登记命令与拒绝语义同 `{SPECS_DIR}`：store 未初始化/未激活时查询**拒绝**（`store.not-initialized` / `store.not-active`），**不**读作「无 knowledge」。
- **退化**：默认原地更新，过时即删除；确需旧经验作对照才保留 `<topic>-v<N>.md` 并把 catalog 置 `superseded`（或移入 `{HARNESS_DIR}/archived/knowledge/`）——保留不是义务，只为对照，不是权威。
- 可选：目录级 `{KNOWLEDGE_DIR}/AGENTS.md` 承载命名与维护节奏；harness 宽规则仍以 `mstar-conventions` 与本 reference 为准；初始化时由 `mstar harness scaffold` 建目录，**不**预建空表头 README 登记表。

## `{ADR_DIR}`（可选·决策记录）

- **解析**（非空即停）：`.mstarc` `adr_dir` → `{HARNESS_DIR}/adr/` → `.agents/adr/` → `docs/adr/`；创建规则 → `mstar-conventions` SKILL.md「`{KNOWLEDGE_DIR}` / `{ADR_DIR}` 解析」。
- **放什么**：**单一决策**及其真实备选与代价。合同细节（目录 shape、class、模板、header 行、门禁能查与不能查）只在 **`docs/adr/README.md`**，本文件不复述。
- **四态生命周期**（同一变更内完成；文件名 `yyyy-mm-dd-topic.md` 跨桶永不改）：
  - `proposed → implemented`：改 `Status`，`Proposal` 改写为现在时 `Decision`，`Acceptance criteria` / `Risks` 折叠进 `Consequences`。
  - `proposed → rejected`：只改 `Status`，正文冻结。
  - `implemented → archived`：插入 `Archived: YYYY-MM-DD — <reason>` 行，正文不动。
- **archived 准入（三条同时成立）**：① 决策已被后续记录完全取代，或对应机制已从系统移除；② 不再指导未来工作；③ 仍有历史追问价值。**不满足 ③ 就直接删除，不归档**。
- **冻结**：归档后正文只读——不更新路径、不改结论、不重译；唯一允许的编辑是修复指向它的入站链接。归档记录**不再是当前行为权威**，审计不把其陈旧路径当 finding。
- **与 `superseded` 的区别**：`superseded` = 有替代、旧记录仍须保持为真且可参考；`archived` = 不再权威、冻结为历史；两者都保留双向 `Supersedes:` / `Superseded-by:`。
- **退化**：决策改变 → 写新记录 + 双向链接，旧记录不改写成相反结论；已发布事实漂移 → implemented 记录内原地更新（不改决策、不记流水账）。

> **Engine check:** `mstar lint <{ADR_DIR}> --type adr` (engine `lintAdrTree`) — checks bucket membership (`proposed` / `implemented` / `rejected` / `archived`), class, `Status` agreeing with the directory, the `Archived:` line on archived records, required and banned sections, filename shape and fence closure. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

## `{ITERATION_DIR}` 与 `{PROJECT_DIR}/<id>/references/`

- **`{ITERATION_DIR}/<iteration-id>/`**：`delivery-compass.md`（authored 迭代范围输入，非运行状态权威）、`guides/`、`specs/`、可选 package `README.md`。ACTIVE 运行状态在 store `execution_*` 行。**不放**已锁定的仓库级规范（→ `{SPECS_DIR}/`）、已提升的跨迭代经验（→ `{KNOWLEDGE_DIR}/`）、单 plan 原始 QC 报告（→ `{SDD_DIR}/review/`）。
- **登记**：迭代 identity、compass 位置、description、project 归属与 package 内文档关系都是 catalog 行；根 `README.md` 与 package `README.md` 保留为**散文**，不维护「一行 = 一次迭代」的登记行。
- **Compass 路径**：canonical `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`；legacy flat `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` 仅兼容读，**不要**新写。
- **`{PROJECT_DIR}/<id>/references/`**：主题化研究（surveys、epic roadmaps、第三方 notes），与项目绑定（项目缺失用 `_default`）。**不放**当前状态规格 / ADR、compound 经验、迭代草稿；研究**不**迁入三层语料，三层内容也**不**迁入此处。
- **engine 边界**：`listProjectReferenceFiles(projectDir)` 只返回文件名（相对路径、`/` 分隔、code-unit 排序；跳过根级 `roadmap.md` / `residuals.json`；缺失目录 → `[]`），**不**读正文、**不**做 markdown schema 校验——归属语义是本 reference 的契约。harness 根 `.mstar/references/` 已退役。

## 文件命名（按层）

- **`{SPECS_DIR}`**：`<class>/<topic>.md`，**无版本后缀、无日期前缀**；同目录不并存旧版。
- **`{KNOWLEDGE_DIR}`**：默认原地更新；确需旧经验对照才 `<topic>-<qualifier>-v<N>.md`（例 `sync-contract-gap-analysis-v1.md`）+ catalog `superseded`。
- **`{ADR_DIR}`**：`{bucket}/{class}/yyyy-mm-dd-topic.md`；日期是记录原始日期，跨桶 move 不改名。
- 避免与主 plan 混淆：主 plan 仍是 `{PLAN_DIR}/<plan-id>-<plan-name>.md`，不塞进 `{KNOWLEDGE_DIR}` 根；compass 不与跨版本 SSOT 共用命名空间。

## 与执行 plan 行及 catalog 的链接

- plan 的**权威设计输入**在规格或迭代 compass 中时，经公共 prepare 域边界冻结到 store 执行 plan 行的 `metadata`：**`primary_spec` / `spec_refs`** → 优先 `{SPECS_DIR}/`；**`iteration_compass` / `iteration_refs`** → `{ITERATION_DIR}/`。知识关联载体是 catalog relations（`catalog link`）；snapshot `plans[].metadata.knowledge_refs` 仅迁移源只读，不推定新的 engine 行为。
- implement 前：先查 catalog（`mstar catalog list`，按 kind / document kind / lifecycle 过滤）发现当轮相关 `active` 文档（发现式阅读，不要求通读全库）；再按 metadata 读取已登记路径；均与主 plan 核对。不得在未读链接文档的情况下**静默偏离**其中已写明的决策（需偏离时先回写 knowledge 或 plan 并走 PM/architect 门禁）。
- catalog 与文件同步：文件删除或迁入本地归档时，对应行置 `superseded` / `archived` 或移除；**不允许**「文件已删而 catalog 行仍 active」。

## 维护规则（新增 / 修订 / 归档 / 结晶）

1. **新增**：specs → 文件落 `{SPECS_DIR}/<class>/` + catalog document 行 + `primary_spec` / `spec_refs`；迭代 package → `<iteration-id>/guides|specs/` + catalog 行与 `belongs-to`/`documents` 关系 + `iteration_refs`；knowledge → **`mstar-knowledge`** @ iteration-close（含 package 提升）+ catalog 行，写入位置 SSOT 见 `mstar-conventions/references/artifact-storage-paths.md`；ADR → `{ADR_DIR}/{bucket}/{class}/`。
2. **修订**：knowledge 内容变更同批更新 catalog 行（`catalog update`；identity 不可改）；specs 随代码原地更新，**不**新版本文件；implemented ADR 随事实漂移原地更新。
3. **归档**：**iteration-start（强制）** 以 `{SPECS_DIR}/` 全库卫生为主，对既有 `{KNOWLEDGE_DIR}/` 仅归档/错放纠正、**不**新增 knowledge（细则 → `mstar-iteration/references/iteration-corpus-hygiene.md`）；其它时机按各层退化规则处理。
4. **结晶（Compound）**：PM 在 **iteration-close** 触发 **`mstar-knowledge`**（`## Workflow — Capture`）：plan 素材 + `<iteration-id>/` package 提升 → `{KNOWLEDGE_DIR}/`。不在 per-plan Done 后单独执行。

## 与 review bundle、residuals 的区分

- `{SDD_DIR}/review/`：审查**流程临时证据**（review package、QC1/2/3、consolidated、PM Acceptance），gitignored，可在 Done 后丢失。
- 主 plan **gate summary**：长期门禁决策摘要（verdict、review range、R#、PM Acceptance gate），随主 plan 追踪。
- `{PLAN_DIR}/residuals/<plan-id>/`：仍 open finding 的**长文补充**，与 plan-linked store issue 配套，**不替代** store issue 权威；命名 `<issue-id>-<short-label>.md`。先经 `mstar plan issue-add` / `mstar issue add` 捕获 issue，再附散文路径证据；issue 关闭后同批收口散文（迁入 `{HARNESS_DIR}/archived/knowledge/` 或在关闭证据写明最终路径），不留「issue 已关闭而散文仍声称 open」。
- 四者可互链，但职责不混写：knowledge 说经验，specs 说现状，ADR 说取舍，review bundle 说过程。
