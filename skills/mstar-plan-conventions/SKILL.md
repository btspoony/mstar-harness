---
name: mstar-plan-conventions
description: Morning Star (启明星) harness 的计划目录约定 —— {HARNESS_DIR}、{PLAN_DIR}、{ITERATION_DIR}、{KNOWLEDGE_DIR}、{SPECS_DIR} 的发现与初始化、docs/ 与 harness 子树内容边界、status.json 的 SSOT 结构与状态权限、residual findings 登记/归档/生命周期、severity 枚举（SSOT，机器字段）、notes.json 程序时间线、tech_debt_summary 技术债一览、reports/ 审查留档命名、QC 三审触发时机、主 plan Done 标记、archived/plans Profile A/B、工期预估（仅 agent-oriented）、**Spec 集成分支 + 多 Plan 实现分支** 的 Git 对齐与 **Spec 完成后须经 PR 合入 main** 门禁。任何角色在读写 .agents/、创建/更新 plan 文件、登记 residual finding、QC/QA 报告入库、Done 收口、写工期预估时必读；`@project-manager` 编排任一含 plan 的任务前必读；实现角色开工前须读本 skill 以对齐 metadata.primary_spec/spec_refs 与 knowledge/iterations 目录。
---

## Load order（必读顺序）

**在同一会话或任务中首次 Read 本 skill 时：必须先 Read `mstar-harness-core` skill（SKILL.md，以及本任务将涉及的 `mstar-harness-core/references/`，尤其是并行 / worktree / QC-QA 检出时读 `references/branch-and-worktree.md`）。** 本 skill 只约定 `{HARNESS_DIR}` / `{PLAN_DIR}`、`status.json`、residuals、reports 等**计划资产**形态；**不得**突破 harness 的状态机、门禁与路由。冲突时 **以 `mstar-harness-core` 为准**。

**摘要**：`mstar-harness-core` — 全局 SSOT 与「Morning Star Skill 索引」；本 skill — plan 目录、SSOT JSON、归档与工期口径的专题展开。**派发 QC 或处理 `InReview` 闸门**：还须 Read **`mstar-review-qc`**（本 skill 不承载 QC 清单与 verdict 规则）。

# Morning Star Plan Conventions（计划管理约定）

本 skill 定义 Morning Star harness 中**计划（plan）目录的发现、初始化和使用规范**，所有 agent 共享此约定；角色提示词中不再重复描述，仅引用本 skill 与其 `references/`。

## Harness 与 Plan 目录发现

引入 **Harness 根目录** 与若干**路径符号**（与 Nexus 等采用 Morning Star 的业务仓库对齐；项目可在 `{HARNESS_DIR}/AGENTS.md` 复述下表并声明本地偏差）：

| 符号 | 含义 | 默认路径 |
|------|------|----------|
| `{HARNESS_DIR}` | Agent 计划与编排产物根 | `.agents/` |
| `{PLAN_DIR}` | 主 plan 正文与按 `plan-id` 的审查留档 | `{HARNESS_DIR}/plans/` |
| `{ITERATION_DIR}` | 迭代/版本级 program compass、交付范围与遗留规划快照 | `{HARNESS_DIR}/iterations/` |
| `{KNOWLEDGE_DIR}` | 实施细节 SSOT、可复用技术设计（**不**替代冻结规格） | `{HARNESS_DIR}/knowledge/` |
| `{SPECS_DIR}` | 冻结规格目录别名（见下节解析） | `{HARNESS_DIR}/specs/` 或 `{HARNESS_DIR}/designs/` |

- **`{HARNESS_DIR}`**：承载 SSOT、时间线、迭代 compass、知识库、归档、冻结规格等**非「单文件 plan 正文 + 审查报告」**类资产。
- **`{PLAN_DIR}`**：**仅**存放主 plan Markdown、按 `plan-id` 分目录的 **`reports/`** 等**计划与审查留档**；**默认** `{PLAN_DIR} = {HARNESS_DIR}/plans/`。
- **`{ITERATION_DIR}`**（可选）：**迭代/版本维度**的交付罗盘（如 `*-delivery-compass-*.md`、`*-program-compass-*.md`）、gap 分析、遗留 `v1.*` 规划快照；**不**放可跨版本复用的实现 SSOT（那些进 `{KNOWLEDGE_DIR}`）。须维护 **`{ITERATION_DIR}/README.md`** 索引（见 `references/knowledge-and-designs.md`）。
- **`{KNOWLEDGE_DIR}`**（可选）：**实现向**长寿命技术上下文（架构细则、契约说明、跨版本 tracker、性能基线等）；须维护 **`{KNOWLEDGE_DIR}/README.md`** 索引。下文凡写 `knowledge/` 均指 **`{KNOWLEDGE_DIR}`**。
- **`{SPECS_DIR}`**：规格文档目录别名，用于统一表示 `{HARNESS_DIR}/specs` 与 `{HARNESS_DIR}/designs` 两种标准，减少规则与模板中的硬编码路径。

### `{SPECS_DIR}` 解析规则

1. 若存在 `{HARNESS_DIR}/specs/`：`{SPECS_DIR} = {HARNESS_DIR}/specs/`（优先）。
2. 否则若存在 `{HARNESS_DIR}/designs/`：`{SPECS_DIR} = {HARNESS_DIR}/designs/`（兼容旧标准）。
3. 若两者都不存在：默认建议新建 `{HARNESS_DIR}/specs/`，并令 `{SPECS_DIR} = {HARNESS_DIR}/specs/`。

> 并存兼容：当 `specs/` 与 `designs/` 同时存在时，`primary_spec` 推荐挂到 `{SPECS_DIR}`（即 `specs/`）；`spec_refs` 可同时引用两处路径。

### 解析顺序（找到 harness 即停止）

1. 若存在 **`.agents/`** 目录： **`{HARNESS_DIR} = .agents/`**， **`{PLAN_DIR} = .agents/plans/`**（若尚无 `plans/` 子目录，初始化时创建）。
2. 否则若存在 **`.plans/`** 目录：**遗留同目录布局** — **`{HARNESS_DIR} = {PLAN_DIR} = .plans/`**（`status.json`、主 plan、`reports/` 等与旧版一致，共处于同一目录树）。
3. 否则若存在 **`plans/`** 目录：**遗留同目录布局** — **`{HARNESS_DIR} = {PLAN_DIR} = plans/`**。
4. 若以上均不存在：视为**该项目未启用 plan 管理**。此时 agent 仍可正常工作，只是不维护 plan 文档和 `status.json`，任务进度通过对话和回报传递。

**并存目录**：若仓库中**同时**存在 **`.agents/`** 与 **`.plans/`**（或根目录 **`plans/`**），仍按上表**优先级 1** 采用 **`.agents/`** 作为 **`{HARNESS_DIR}`**；其余路径可能为迁移残留，宜合并或重命名，避免误读两套 harness。

> **约定**：下文凡写 **`{HARNESS_DIR}/…`**、**`{PLAN_DIR}/…`**、**`{ITERATION_DIR}/…`**、**`{KNOWLEDGE_DIR}/…`** 均指上表解析后的实际路径。推荐布局下 **`{PLAN_DIR}` 绝不等于** 仓库根，而是 **`{HARNESS_DIR}` 下的 `plans/` 子目录**。

## 内容边界：`docs/` 与 harness 子树（推荐）

与 Nexus harness 分层一致；项目根 `AGENTS.md` 宜用短表指向本节，避免在多处维护长文。

| 区域 | 典型内容 | 受众 / 权威 |
|------|----------|-------------|
| **`docs/`**（或项目约定的用户文档根） | 安装、quickstart、稳定架构概览、贡献指南 | 人类贡献者与终端用户；clone 后应可读 |
| **`{SPECS_DIR}`**（可选） | 冻结 **v1-spec**、ADR、program **roadmap** — 产品/API 行为最高权威 | 全员；变更须显式版本/评审流程 |
| **`{ITERATION_DIR}`**（可选） | 某交付版本/迭代的 **compass**（范围、里程碑、验收、风险）、gap 分析、遗留规划快照 | Agent handoff；**不**替代 `{SPECS_DIR}` |
| **`{KNOWLEDGE_DIR}`**（可选） | 实现细节 SSOT、可复用技术设计、跨版本 tracker | Agent handoff；**不**覆盖 `{SPECS_DIR}` 中的规范性条款 |
| **`{PLAN_DIR}/`** | 单 plan 执行：主 plan、`reports/`、可选 `residuals/` | 计划级 SSOT 与审查留档 |

**不应**放入 `docs/` 的内容：作为**特定 plan 输入/输出**的评审结论、迭代 compass 正文、未稳定规格草案、QC 报告 —— 分别落 `{KNOWLEDGE_DIR}`、`{ITERATION_DIR}`、`{SPECS_DIR}` 或 `{PLAN_DIR}/reports/`（见 `references/knowledge-and-designs.md`）。

## 目录布局（推荐）

与审查留档、并行 QC、归档分层的典型布局如下（**推荐**：`{HARNESS_DIR}` 常为 **`.agents/`**，`{PLAN_DIR}` 常为 **`.agents/plans/`**）：

```text
{HARNESS_DIR}/                   # 默认 .agents/
├── status.json                   # SSOT：plans[] + open residual（已关闭见 archived/residuals/）
├── notes.json                    # 可选：程序里程碑 / 时间线（减轻 status.json 体积）
├── specs/                        # 可选：规格主目录（推荐）；若存在则作为 {SPECS_DIR}
├── designs/                      # 可选：兼容旧目录；当 specs/ 不存在时可作为 {SPECS_DIR}
├── iterations/                   # 可选：{ITERATION_DIR} — 迭代/版本级 compass（见 references/knowledge-and-designs.md）
│   └── README.md
├── knowledge/                    # 可选：{KNOWLEDGE_DIR} — 实施知识库（见 references/knowledge-and-designs.md）
│   └── README.md
├── archived/                     # 可选：已关闭 residual、Done 计划行冷快照
│   ├── residuals/
│   │   └── <plan-id>.json
│   ├── plans/
│   │   └── <plan-id>.json
│   ├── plans-done.json           # 可选（Profile B）
│   └── plans/_index.json         # 可选索引
└── plans/                        # {PLAN_DIR} — 主 plan、reports/，及可选 residuals/
    ├── <plan-id>-<plan-name>.md  # 主计划文件
    ├── reports/                  # 审查类补充报告（只读历史留档）
    │   ├── README.md
    │   └── <plan-id>/ …
    └── residuals/                # 可选：open residual 散文详情（与 SSOT 配套）
        └── <plan-id>/
            └── <finding-id>-<short-label>.md
```

- **主计划**：技术方案、任务清单、Sign-off 仍以 **`{PLAN_DIR}/<plan-id>-<plan-name>.md`** 与 **`{HARNESS_DIR}/status.json`** 为权威。
- **`{PLAN_DIR}/reports/`**：架构评审、QC 分报告、QC 汇总结论；**视为只读历史**，不在此反复改写同一结论（修正走新报告或回写主计划 / `status.json`）。
- **`{PLAN_DIR}/residuals/<plan-id>/`**（可选）：对仍 **open** 的 residual 提供**长于 JSON 字段**的散文说明；**不替代**根级 `residual_findings` 的 SSOT（见上文「`status.json` 与 open residual」），见 `references/knowledge-and-designs.md`「open residual 散文详情」。
- **`{ITERATION_DIR}`**：**版本/迭代维度**的交付罗盘与规划快照；与 `{KNOWLEDGE_DIR}`、`{SPECS_DIR}` 分工见上文「内容边界」与 `references/knowledge-and-designs.md`。
- **`{KNOWLEDGE_DIR}`**：规格修订、架构评审产出、设计决策与 gap 分析等**实施上下文**（**非**迭代 compass 的首选落点）；与 `docs/`、`{ITERATION_DIR}` 分工见 `references/knowledge-and-designs.md`。
- **`{SPECS_DIR}`**（可选）：规格目录别名，支持 `{HARNESS_DIR}/specs/` 与 `{HARNESS_DIR}/designs/`；用于冻结规格、少变基线或可对外参考文档（具体分工见 `references/knowledge-and-designs.md`）。
- **residual findings（未关闭）**：**当前仍待跟踪**的条目写在 **`{HARNESS_DIR}/status.json`** 根级 `residual_findings[<plan-id>]`（canonical 见上文）；**已验证关闭**的条目迁出至 **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**，避免 `status.json` 无限膨胀。详见 `references/status-and-residuals.md`。

## `status.json` 与 open residual（canonical）

- **Canonical**：**`{HARNESS_DIR}/status.json`** 根级 **`residual_findings`**（`plan-id` → open 条目数组），与 **`plans`** **平级**；**新写入**只维护此处。
- **`metadata.residual_findings`**：仅**未迁移的旧文件**上的**读取 fallback**，**不是**第二套 SSOT；**不要**为新工作再建一套嵌套映射。读取可先根级、再 fallback；关闭/迁移时勿与根级**双写**长期并存（操作与 `jq` 见 `references/status-and-residuals.md`）。

## 已提交文档与计划产物的可到达性（强制建议）

凡是**会进入 Git**且用于贡献者阅读或 **agent handoff** 的文档（例如根目录 `README`、`docs/`、`AGENTS.md`、主 plan 正文），以及落在 **`{HARNESS_DIR}` / `{PLAN_DIR}` 且被跟踪**的计划与报告，应满足：

- **不得**引用仅在本机存在、被 `.gitignore` 排除、或 **`git clone` 后默认不存在**的路径；读者按文内引用应能在仓库内打开对应文件。
- **不得**引用**本仓库根目录以外**的路径（例如 `~/.config/...`、用户主目录绝对路径、任意未作为子模块/子树纳入的「兄弟目录」）。若必须依赖外部上下文：**将要点摘入本仓库**，或给出**稳定、可公开访问**的 URL（并注明适用范围与版本）。
- 违反上述约定会破坏 **onboarding** 与跨环境交接；若项目将 **`{HARNESS_DIR}`**（或遗留模式下整个 `{PLAN_DIR}`）**整体**加入 `.gitignore`，则已提交的 `docs/`、`README`、`AGENTS.md` 等**不得**把被忽略路径下的文件当作**唯一**权威引用。
- 需要 handoff 的 plan / `{PLAN_DIR}/reports/` / **`{ITERATION_DIR}`** / **`{KNOWLEDGE_DIR}`** 宜 **Git 跟踪**；若某路径刻意不提交，则不要在已提交文档中写死为必读单一来源。

## 初始化 Plan 目录

当 `@project-manager` 判断某项目需要 plan 管理但尚无 plan 目录时：

1. 创建 **`.agents/`** 作为 **`{HARNESS_DIR}`**（首选，对原有项目结构侵入小）。
2. 创建 **`{PLAN_DIR}`** = **`.agents/plans/`**（子目录）。
3. 在 **`{HARNESS_DIR}/`** 下创建 **`status.json`**：可复制本仓库 **`templates/status.empty.json`**；字段与 residual 生命周期见 `references/status-and-residuals.md`（canonical 见本 SKILL 开篇）。
4. 可选：创建 **`{HARNESS_DIR}/notes.json`**：可复制 **`templates/notes.empty.json`**（或空 `entries: []`），用于程序里程碑，避免日后向 `status.json` 堆日志。模板索引见 **`templates/README.md`**。
5. 创建 **`{PLAN_DIR}/reports/README.md`**，用途与命名约定与仓库内其它说明一致即可。
6. 可选：若采用 **`{PLAN_DIR}/residuals/<plan-id>/`** 散文详情，在**首次**需要长文补充某 open R# 时再创建对应 **`residuals/<plan-id>/`** 子目录；无需为空 plan 预建占位目录。
7. 若启用 **`{KNOWLEDGE_DIR}`**：创建目录及 **`{KNOWLEDGE_DIR}/README.md`** 空索引表（见 `references/knowledge-and-designs.md`）。
8. 若启用 **`{ITERATION_DIR}`**：创建目录及 **`{ITERATION_DIR}/README.md`** 空索引表（delivery compass / program compass 等；见 `references/knowledge-and-designs.md`）。
9. 可选：创建 **`{HARNESS_DIR}/specs/`**（推荐）或 **`{HARNESS_DIR}/designs/`**（兼容），并维护简短 **`README.md`**；后续统一按 `{SPECS_DIR}` 引用。
10. **Git 策略（与项目 `AGENTS.md` 一致）**
   - **推荐（团队交付 / agent handoff）**：**不要**将 **`{HARNESS_DIR}`** 整体加入 `.gitignore`，以便 clone 后计划与报告路径可达。
   - **仅本机私密**：若必须 ignore 整个 **`{HARNESS_DIR}`**，则按上文「可到达性」约束已提交文档；敏感片段另用密钥或私密渠道管理。
11. 如果项目已有 **`.plans/`** 或 **`plans/`** 目录（遗留同目录布局），**不要再创建** **`.agents/`**，直接使用已有目录作为 **`{HARNESS_DIR} = {PLAN_DIR}`**，并视需要补建 **`reports/`**、**`residuals/`**、**`{KNOWLEDGE_DIR}`**、**`{ITERATION_DIR}`**、**`archived/residuals/`**、可选 **`notes.json`** 与 `metadata` 结构。

## Spec 文档驱动的分支模型（多 Plan 归属同一 Spec）

当 **`metadata.primary_spec`**（及可选 **`spec_refs`**）指向**单一规格主线**，且 PM 将工作拆成 **多个 `plan_id`** 并行或串行交付时，业务仓库的 Git 拓扑建议按下述对齐，避免「实现分支直接打 main」与「多 Plan 无集成靶」两类漂移。**同仓 worktree、QC 前归并到单一 `HEAD` 等强制条款**仍以 **`mstar-harness-core`** `references/branch-and-worktree.md` 为准；本节只补充 **Spec ↔ 分支** 的命名级契约。

### 分支角色

| 概念 | 含义 |
|------|------|
| **Spec 文档** | 该次交付冻结或主规格（常为 `{SPECS_DIR}` / `knowledge/` 下路径；与 `primary_spec` 对齐）。 |
| **Spec 集成分支** | **一条**与「该 Spec 所覆盖的全部 Plans」对应的 **集成线**：各 Plan 实现成果 **merge 回** 此分支后，才视为该 Spec 在代码侧已集成。 |
| **Plan 实现分支** | **每个 `plan_id`** 一条（或 PM 书面拆分的子轨）；**仅**承载该 Plan 范围内的提交与 QC/QA 前归并。 |

### 工作流（默认推荐）

1. **开线**：由 **`@project-manager`** 与用户确认后，建立 **Spec 集成分支**（Assignment 写明 `Working branch: create <spec-integration-branch> from <base>` 或等价；`<base>` 见 `branch-and-worktree.md`，**禁止**未授权默认）。
2. **拆 Plan**：每个从该 Spec 拆出的 plan 使用 **各自的 Plan 实现分支**（通常 `create <plan-feature-branch> from <spec-integration-branch>` 或 PM 规定的等价拓扑）；**实现 / QA / 运维等可写角色**在本 Plan 周期内 **只操作 Assignment 写明的该 Plan 分支**（及 PM 授权的 worktree 检出），**不得**擅自把未授权提交直接堆到默认保护分支。
3. **Plan 收口**：该 Plan 完成 **QC 三审 + QA** 等 harness 要求后，将其变更 **merge（或团队书面约定的 rebase/cherry-pick）回 Spec 集成分支**；**不是**在「仅完成单个 Plan」时默认直接 merge 进 `main`/`master`，除非 Assignment 含显式 **`Branch policy`** 例外。
4. **与 `mstar-harness-core` 的「plan 集成分支」关系**：**同仓、同一 plan、多并行轨**时，该 skill 推荐的 **plan 集成分支** 在「多 Plan、同源 Spec」场景下 **即** 本条所述 **Spec 集成分支**；各 Plan 的 topic 线 **merge 靶** 优先为 **Spec 集成分支**，而非彼此随意交叉除非 PM 书面约定。

### 合入默认保护分支（main）：必须经 PR

当 **归属该 Spec 的全部 Plans** 已在计划状态上完成（且代码变更已按团队流程 **汇总到 Spec 集成分支**）时：

- **禁止**将 Spec 集成分支 **直接本地 merge / fast-forward push** 到 **`main`/`master`**（或项目约定的其它默认保护分支）作为**常规完成路径**。
- **必须**通过 **Pull Request（或宿主平台等价的受控合入流程）** 将 Spec 集成分支合入默认分支，以满足 **审查、CI、权限与审计** 等团队门禁。

**窄例外**（须 **Assignment 显式** **`Branch policy: direct on <branch> — <reason>`**，与 `mstar-harness-core` 一致）：例如已批准的热修、或用户与团队书面采用的无 PR 流程。**不得**由 agent 自行认定「可以跳过 PR」。

### 登记建议

在 **`{HARNESS_DIR}/status.json`** 的 **`plans[].metadata`**（或根级 **`metadata.versioning`** 等团队约定节）中记录 **`spec_integration_branch`**、各 plan 的 **`working_branch`**，以及 **`merge_target`**（对 Plan 实现分支通常为 **Spec 集成分支名**，而非 `main`）。字段表见 `references/status-and-residuals.md`。

## Harness 初始化蓝图（含 `AGENTS.md` 分层策略）

当仓库从 0 到 1 启用 harness，建议按下面顺序初始化，避免后续出现规则散落与双轨 SSOT：

1. 建 `{HARNESS_DIR}`（默认 `.agents/`）与 `{PLAN_DIR}`（默认 `.agents/plans/`），并初始化 `status.json`（见 **`templates/status.empty.json`**）、可选 `notes.json`（**`templates/notes.empty.json`**）、`reports/README.md`。
2. 在 `{HARNESS_DIR}` 下新增 **`.agents/AGENTS.md`**（harness 子树规则），只放 **harness 资产约束**：目录语义、状态机映射、QC/QA 落盘门禁、residual 生命周期、归档策略。
3. 在仓库根保留 **`AGENTS.md`**（项目级规则），只放 **代码库约束**：技术栈边界、构建/测试入口、安全与分支约束、规范文档路由，不复制 harness 细则。
4. 当子目录存在显著边界（如 `contracts/`、`gateway/`、`sdk/`、`examples/`）时，再新增目录级 `AGENTS.md`，仅覆盖该目录的增量规则，禁止重复根规则或 `.agents/AGENTS.md` 细则。
5. 每个目录级 `AGENTS.md` 必须显式写 `Source Priority`，确保冲突裁决可预测（用户指令 > 根规则 > 本目录规则 > `.agents/AGENTS.md`）。

### `.agents/AGENTS.md` 应保存什么

- harness 结构与路径契约：`{HARNESS_DIR}`、`{PLAN_DIR}`、`{ITERATION_DIR}`、`{KNOWLEDGE_DIR}`、`{SPECS_DIR}` 的实际路径约定；`docs/` 与 harness 子树内容边界（可引用本 skill「内容边界」表）。
- plan/status 生命周期门禁：`Todo/InProgress/InReview/Blocked/Done` 的推进与角色权限映射。
- QC/QA 证据契约：三审独立性、同一 `plan_id` + `Review range` 对齐、报告落盘目录与命名。
- residual 管理契约：severity 枚举、open/closed/archived 流转、归档路径。
- profile 选择（如 Done 压缩 Profile A/B）与仓库级采纳声明。

### 根/分目录 `AGENTS.md` 不应保存什么

- 动态状态：里程碑日志、当前进度、commit 列表、PR 号（应进 `status.json` / `notes.json`）。
- 单次计划细节：某一 plan 的临时决策与实施笔记（应进主 plan、reports 或 knowledge）。
- 与 harness SSOT 重复的完整规则正文（应引用 `.agents/AGENTS.md` 或 `mstar-*` skills）。

### 分目录 `AGENTS.md` 何时创建（最小策略）

- **创建**：目录有独立技术边界、独立发布面或独立风险模型（例如合约、网关、SDK）。
- **不创建**：目录仅是实现细分且无新增约束（沿用根规则即可）。
- **拆分深度**：默认只到一级业务边界目录；除非出现稳定且长期的二级差异，不继续下钻。
- **体积控制**：目录级文件目标 60-150 行，强调“边界 + 禁区 + 接口命令”，避免复制大段通用规范。

## 与 Superpowers `writing-plans`（提示词门限）

上游 **Superpowers** 插件自带的 `writing-plans` 技能默认将计划保存到 `docs/superpowers/plans/`，与本 skill `{PLAN_DIR}` 约定冲突。

**Harness 门限（优于技能正文中的保存路径）**：任一角色在加载并执行 **`writing-plans`** 时，须将新计划写入按上文解析到的 **`{PLAN_DIR}`**（推荐文件名 **`<plan-id>-<plan-name>.md`**，或与项目既有 plan 命名一致；亦可用 `YYYY-MM-DD-<feature-name>.md` 等可追溯形式），**禁止**在业务仓库中默认使用 `docs/superpowers/plans/`。需要新建 **`{HARNESS_DIR}`** / **`{PLAN_DIR}`**、**`{HARNESS_DIR}/status.json`**、可选 **`{HARNESS_DIR}/notes.json`**、**`{PLAN_DIR}/reports/README.md`**、可选 **`{KNOWLEDGE_DIR}/README.md`** / **`{ITERATION_DIR}/README.md`**、Git 策略时，按上文 **「初始化 Plan 目录」**；`status.json` 的登记与状态仍由 `@project-manager` 负责。

各角色提示词中对本门限有短引用（见 `mstar-roles` skill 的 `project-manager` 角色、`product-manager.md`、`architect.md`）；完整消解表见 `mstar-superpowers-align`。

## `tasks` 拆解：并行标记与 Superpowers（示例）

`mstar-harness-core` 要求 `tasks` 产出含 **依赖顺序**、**并行标记** 与完成判据。若 `@project-manager` 将 **≥2 条实现轨同时** 分派（同 plan、无串行依赖），须在 **Status Update** 与各实现方 Assignment 的 **`Superpowers`** 中显式写入 **`dispatching-parallel-agents`**（或 `mstar-superpowers-align` 表中同义短语）；**同一业务仓库** 上 **≥2 名可写承接方并发** 时还须叠 **`using-git-worktrees`**（或同义短语）并写明各流 **检出路径约定**（见 `agents/project-manager.md`「条件加载」、`mstar-harness-core` `references/branch-and-worktree.md`）。

**编排面**：PM 须在 Status Update 发与主 plan 对齐的 **`PM Task Board`**，implement Assignment 写 **`PM Task Board coverage`**（见 `agents/project-manager.md`）。

**QC pre-dispatch gate (mandatory)**: before PM dispatches any QC task (`@qc-specialist*`), PM must read **`mstar-review-qc`** skill (including relevant `references/`) **in the same coordination round**, then issue QC assignments. **Rationale**: `mstar-plan-conventions` alone does **not** carry QC checklists, report YAML, verdict rules, or tri-review field parity — skipping `mstar-review-qc` is a common cause of missed or batched-wrong QC.

**InReview backlog gate (mandatory for PM orchestration)**: whenever **`{HARNESS_DIR}/status.json`** has one or more `plans[]` rows with **`status: InReview`**, PM must **not** treat plan orchestration as “implement-only”. Either **dispatch per-`plan_id` QC → QA** (per rules below) or set **`Blocked`** / user-approved deferral **in writing** in the same Status Update. Silent continuation into new implement waves while multiple plans sit `InReview` without QC artifacts is **`Blocked`-class drift**.

以下为 plan 正文内 **tasks** 片段示例（字段名可按团队习惯调整，语义对齐即可）：

```markdown
## Tasks

| ID | Task | Depends on | Parallel | Owner (planned) | Done criteria |
|----|------|------------|----------|-----------------|---------------|
| T1 | Lock export API contract (OpenAPI snippet in plan) | — | no | @architect | Contract section merged into plan |
| T2 | Implement `GET /orders/export` | T1 | **yes** | @fullstack-dev | API + tests green locally |
| T3 | Export entry UI + download flow | T1 | **yes** | @frontend-dev | UI wired; happy path manual check |

**Parallelism**: `parallel — 2 tracks` (T2 ∥ T3 after T1).

**Superpowers (for implement Assignments when plugin on)**:
- `dispatching parallel agents` — two independent implement tracks after T1.
- `using git worktrees` — same business repo; **Track A** worktree `…/repo-wt-api`, **Track B** `…/repo-wt-ui`; same **`Working branch`** unless PM branches per track.
```

Assignment 模板中的 **`Parallelism`** 行应与上表 **`Parallelism`** / **Dev routing** 一致，避免「plan 写并行、Assignment 未声明」。

## 状态值

- `Todo` — 待开始
- `InProgress` — 进行中
- `InReview` — 待审查
- `Blocked` — 阻塞
- `Done` — 完成

## 状态更新权限

- 主 plan 内 **Markdown 任务勾选**（checkbox）规则见 `references/plan-files-and-reports.md`「主 plan 内任务清单」；与 `status.json` 的**计划级**状态字段分离管理。
- **Done** 只能由 `@project-manager` 或 `@qa-engineer` 设置。
- 可写盘 agent（dev / qa / ops）完成任务后可将状态更新为 `InReview`。
- **`@product-manager`**、**`@architect`** 可写 plan 文档中各自负责部分（含本人任务 checkbox），但**不**应擅自将整条计划在 `status.json` 中改为 `InReview` 或 `Done`（除非 Assignment 明确授权且与 PM 对齐）；**`Done` 仍仅限** PM/QA。
- **`@qc-specialist`** / **`@qc-specialist-2`** / **`@qc-specialist-3`**：可按宿主白名单**直接写入** `{PLAN_DIR}/reports/**/*.md`；**不得**改主 plan checkbox；**其它路径**仍转达 `@project-manager`。
- **PM report-to-status gate（mandatory）**：PM receives any implementation/review/QA `Completion Report v2` and must update `{HARNESS_DIR}/status.json` in the same coordination turn (at minimum: status/progress/notes or residual linkage relevant to that report). If not updated in-turn, mark `Blocked` and do not proceed to the next dispatch.

## 未启用 Plan 管理时的工作方式

当项目中不存在 plan 目录时：

- `@project-manager` 通过对话和回报传递任务进度，不创建 plan 文件。
- 各 agent 在 Completion Report 中汇报状态，不引用 plan 路径。
- 如果任务复杂度增加到需要持久化追踪，`@project-manager` 可建议用户启用 plan 管理（按上述初始化流程创建目录）。
- 所有门禁和审查流程照常运行，不受 plan 目录有无影响。

## 生命周期与产物位置（摘要）

| 阶段 | 含义 | 典型产物 |
|------|------|----------|
| `Todo` | 已登记，未开工 | 主 plan 文件 + `status.json` 条目 |
| `InProgress` | 实现或准备阶段进行中 | 更新的主 plan、`tasks` 勾选；编码前已读 `metadata` 指向的 **`{KNOWLEDGE_DIR}`** / **`{ITERATION_DIR}`** / `{SPECS_DIR}` 文档（若有） |
| `InReview` | 审查与验证中 | `{PLAN_DIR}/reports/<plan-id>/` 下 `*-review.md`、`*-qc*.md`、`*-qc-consolidated.md`（见 `references/plan-files-and-reports.md`） |
| `Done` | 已合并/收口 | 主 plan Sign-off、**`{HARNESS_DIR}/status.json`** 的 `done_at`；仍 open 的 R# 留在根级 `residual_findings`（见本 SKILL 开篇），已关闭的已迁入 **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`** |
| `Blocked` | 等待外部输入或决策 | 顶层 `notes` + 建议填 `plans[].metadata.blocked_*` / `blocked_by_plan_id` |

## InReview 与 QC+QA：多 plan 编排硬门禁（`@project-manager`）

**典型反模式**：多个 **`plan_id`** 已进入 **`InReview`**，PM 仍持续派发**新的**实现单（下一 topic / 其它 plan），或试图把多个 plan **攒成一次 QC**、混用单一 `plan_id` / 单一 `Review range` —— 均偏离 harness，易导致 **QC 被跳过或审错范围**。

1. **`InReview` 语义**：该 **`plan_id`** 的实现约定范围**已交付待闸**；下一协调动作应进入 **QC 三审 →（汇总）→ QA → `Done`** 管线，或显式 **`Blocked` / 延期说明**。**禁止**长期 `InReview` 却无 `{PLAN_DIR}/reports/<plan-id>/` 下有效 `-qc*.md` 波次且无解释。
2. **一 plan 一套三审（默认）**：每个 **`plan_id`** **单独**一组 QC Assignment：`plan_id`、`Review cwd` / `Worktree path`、`Working branch`、`Review range` / `Diff basis` **仅对应该 plan 的待审变更**；三份 QC + 后续 QA **逐字对齐同一组字段**。**禁止**用一次三审 Assignment 覆盖多个不同 `plan_id` 的合并 diff（若需「多 plan 同一发布火车」，须拆成**显式** scope 与用户同意的集成策略，仍须每 plan 可审计的 QC 产物或书面豁免）。
3. **多 plan 同时 InReview**：允许 **并行**派发多组三审（每组不同 `plan_id`、不同 `reports/<plan-id>/`），**不**等于省略某一 plan 的 QC；也**不**要求强行「一个大 QC session」串所有 plan。若资源上必须串行，**顺序**由 PM 写明，但**每个** `plan_id` 仍须完整三审 + QA，不得合并为单套 `Review range`。
4. **与「仅读 plan skill」的关系**：编排 `InReview`、写 QC/QA Assignment、或解释 `reports/<plan-id>/` 时，**必须**已读 **`mstar-review-qc`**（见上文 **QC pre-dispatch gate**）。**仅加载 `mstar-plan-conventions`** 不能替代 QC 基线。

## 各角色与 Plan 的关系

- **`@project-manager`**：负责发现 plan 目录、创建/登记 plan、分配任务、推进状态、Done 收口。分配时须告知 subagent plan 目录的实际路径；涉及业务 Git 仓库写操作时须在 Assignment 中写明 **`Working branch`** 或 **`Branch policy`**（见 `mstar-harness-core` `references/branch-and-worktree.md`）。启用 **`{KNOWLEDGE_DIR}`** / **`{ITERATION_DIR}`** 时维护对应 **README** 索引，并在 Assignment 中点名 **`primary_spec` / `spec_refs`**（及本轮相关的 iteration compass 路径，若适用）。**多 Plan 归属同一 Spec 时**：按上文 **「Spec 文档驱动的分支模型」** 声明 **Spec 集成分支**、各 **Plan 实现分支** 与 **merge 靶**；在 `status.json` 登记 **`spec_integration_branch` / `merge_target`**（见 `references/status-and-residuals.md`）；**全部 Plans 完成后** 合入 `main`/`master` **走 PR**，不得默认直接 merge。**维护 `status.json` 时**：若存在 **`InReview`** 行，每轮 Status Update **自检**是否对该 `plan_id` 已派或未派 QC；派发前 **Read `mstar-review-qc`**。
- **`@architect`** / **`@product-manager`**：产出规格或评审结论若适合跨会话复用，写入 **`{KNOWLEDGE_DIR}`**、**`{ITERATION_DIR}`**（迭代 compass）或 **`{SPECS_DIR}`**（冻结规格），并更新对应 **README**；建议由 PM 在 `plans[].metadata` 挂接路径。
- **可写盘 agent**（dev / qa / ops）：完成任务后更新主 plan 中**本人负责**的任务 checkbox（见 `references/plan-files-and-reports.md`）、相关 Sign-off 栏位，并更新 `status.json`（权限见上）。**实现前**若 `plans[].metadata` 含 `primary_spec` / `spec_refs`，须先阅读对应文件（见 `references/knowledge-and-designs.md`）。
- **`@product-manager`**：可更新 plan 文档中需求/验收/用户故事等产品负责部分，并在交付后勾选**与之对应**的主 plan 任务 checkbox；**不得**将 `status.json` 中计划状态设为 `Done`；如需改 `progress`/`notes`，以 Assignment 为准或交由 PM 收口。
- **`@architect`**：可更新 plan 文档中架构、接口契约、技术里程碑等章节，并在交付后勾选**与之对应**的主 plan 任务 checkbox；**不得**将 `status.json` 中计划状态设为 `Done`；一般不擅自将整条计划改为 `InReview`（与 PM 对齐）。
- **`@qc-specialist*`**：仅可写 **`{PLAN_DIR}/reports/**/*.md`**；**不**修改主 plan checkbox；其它落盘转达 `@project-manager`。
- **所有 agent**：完成后提醒 `@project-manager` 同步 plan 状态。

## References

- 本 SKILL **「Spec 文档驱动的分支模型（多 Plan 归属同一 Spec）」** — Spec 集成分支、Plan 实现分支、merge 回集成线、**全部完成后经 PR 合入 main**（与 `mstar-harness-core` `references/branch-and-worktree.md` 并用）。
- `references/status-and-residuals.md` — `{HARNESS_DIR}/status.json` SSOT 结构、`plans[].metadata` 标准字段、根级 `metadata` 字段、residual findings 的 **severity** 枚举（SSOT）、生命周期（open → closed → archived）、`notes.json` 程序时间线、`tech_debt_summary` 技术债一览、常用 jq 查询。
- `references/knowledge-and-designs.md` — `{KNOWLEDGE_DIR}` / `{ITERATION_DIR}` / `{SPECS_DIR}` 分工与索引、`{PLAN_DIR}/residuals/<plan-id>/` open residual 散文详情、与 `reports/` 的分工。
- `references/plan-files-and-reports.md` — 主 plan 文件命名、审查报告命名表、QC 分报告与 consolidated 保留原则、**QC 三审触发时机（单 plan · 多 batch）**、**多 `plan_id` 同时 `InReview` 的 QC 编排**、residual findings 权威位置与顺序、主 plan Markdown checkbox 规则、Done 标记方式、QC 落盘宿主权限。
- `references/done-compaction.md` — `Done` 计划行冷快照（`{HARNESS_DIR}/archived/plans/`）、Profile A（瘦 Done 行）/ Profile B（不留 Done 行）、原子更新约束、仓库级采用声明模板、合并前 SSOT 与事实一致门禁。
- `references/effort-estimation.md` — Agent-oriented 工期与工作量预估（T 恤尺码 + agent 会话带）；**禁止**混入人天 / FTE / 人类日历；Assignment / PRD / 架构文档字段名建议。
- `references/harness-bootstrap-and-agents-layering.md` — 新仓初始化蓝图：`{HARNESS_DIR}` 建立步骤、根与 `.agents/AGENTS.md` 职责切分、分目录 `AGENTS.md` 触发条件与模板。
