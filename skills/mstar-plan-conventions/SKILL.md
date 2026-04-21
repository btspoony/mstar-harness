---
name: mstar-plan-conventions
description: Morning Star (启明星) harness 的计划目录约定 —— {HARNESS_DIR} 与 {PLAN_DIR} 的发现与初始化、status.json 的 SSOT 结构与状态权限、residual findings 登记/归档/生命周期、severity 枚举（SSOT，机器字段）、notes.json 程序时间线、tech_debt_summary 技术债一览、knowledge/ 开发过程知识库、reports/ 审查留档命名、QC 三审触发时机、主 plan Done 标记、archived/plans Profile A/B、工期预估（仅 agent-oriented）。任何角色在读写 .agents/、创建/更新 plan 文件、登记 residual finding、QC/QA 报告入库、Done 收口、写工期预估时必读；`@project-manager` 编排任一含 plan 的任务前必读；实现角色开工前须读本 skill 以对齐 metadata.primary_spec/spec_refs 与 knowledge 目录。
---

# Morning Star Plan Conventions（计划管理约定）

本 skill 定义 Morning Star harness 中**计划（plan）目录的发现、初始化和使用规范**，所有 agent 共享此约定；角色提示词中不再重复描述，仅引用本 skill 与其 `references/`。

## Harness 与 Plan 目录发现

引入 **Harness 根目录** `{HARNESS_DIR}` 与 **计划文件目录** `{PLAN_DIR}` 两层概念：

- **`{HARNESS_DIR}`**：agent 计划与编排产物的根（默认 **`.agents/`**）。承载 SSOT、时间线、知识库、归档、冻结规格等**非「单文件 plan 正文 + 审查报告」**类资产。
- **`{PLAN_DIR}`**：**仅**存放主 plan Markdown、按 `plan-id` 分目录的 **`reports/`** 等**计划与审查留档**；**默认** `{PLAN_DIR} = {HARNESS_DIR}/plans/`。

### 解析顺序（找到 harness 即停止）

1. 若存在 **`.agents/`** 目录： **`{HARNESS_DIR} = .agents/`**， **`{PLAN_DIR} = .agents/plans/`**（若尚无 `plans/` 子目录，初始化时创建）。
2. 否则若存在 **`.plans/`** 目录：**遗留同目录布局** — **`{HARNESS_DIR} = {PLAN_DIR} = .plans/`**（`status.json`、主 plan、`reports/` 等与旧版一致，共处于同一目录树）。
3. 否则若存在 **`plans/`** 目录：**遗留同目录布局** — **`{HARNESS_DIR} = {PLAN_DIR} = plans/`**。
4. 若以上均不存在：视为**该项目未启用 plan 管理**。此时 agent 仍可正常工作，只是不维护 plan 文档和 `status.json`，任务进度通过对话和回报传递。

**并存目录**：若仓库中**同时**存在 **`.agents/`** 与 **`.plans/`**（或根目录 **`plans/`**），仍按上表**优先级 1** 采用 **`.agents/`** 作为 **`{HARNESS_DIR}`**；其余路径可能为迁移残留，宜合并或重命名，避免误读两套 harness。

> **约定**：下文凡写 **`{HARNESS_DIR}/…`**、**`{PLAN_DIR}/…`** 均指上表解析后的实际路径。推荐布局下 **`{PLAN_DIR}` 绝不等于** 仓库根，而是 **`{HARNESS_DIR}` 下的 `plans/` 子目录**。

### 从「全在 plans 下」迁移（推荐）

若仓库曾把 **`status.json`、`notes.json`、`archived/`、`knowledge/`** 放在 **`{PLAN_DIR}/`**（例如旧版 `.agents/plans/`）：

- 将上述文件/目录 **上移到 `{HARNESS_DIR}/`**（例如 `.agents/status.json`、`.agents/knowledge/`）。
- **`{PLAN_DIR}/`** 仅保留 **`<plan-id>-*.md`** 与 **`reports/`**（及 `reports/README.md`）。
- 更新文档内引用、`plans[].metadata` 中的 **`primary_spec` / `spec_refs`** 路径、以及脚本中的 `jq` 路径。

## 目录布局（推荐）

与审查留档、并行 QC、归档分层的典型布局如下（**推荐**：`{HARNESS_DIR}` 常为 **`.agents/`**，`{PLAN_DIR}` 常为 **`.agents/plans/`**）：

```text
{HARNESS_DIR}/                   # 默认 .agents/
├── status.json                   # SSOT：plans[] + open residual（已关闭见 archived/residuals/）
├── notes.json                    # 可选：程序里程碑 / 时间线（减轻 status.json 体积）
├── designs/                      # 可选：冻结规格 / 对外基线（与 knowledge 分工见 references/knowledge-and-designs.md）
├── knowledge/                    # 可选：开发过程知识库（见 references/knowledge-and-designs.md）
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
- **`{PLAN_DIR}/residuals/<plan-id>/`**（可选）：对仍 **open** 的 residual 提供**长于 JSON 字段**的散文说明；**不替代** **`metadata.residual_findings`** 的 SSOT，见 `references/knowledge-and-designs.md`「open residual 散文详情」。
- **`{HARNESS_DIR}/knowledge/`**：规格修订、架构评审产出、设计决策与 gap 分析等**实施上下文**；与面向用户的 `docs/` 分工见 `references/knowledge-and-designs.md`。
- **`{HARNESS_DIR}/designs/`**（可选）：**冻结**、少变、可对外的规格或基线文档；与迭代中的 `knowledge/` 区分。
- **residual findings（未关闭）**：**当前仍待跟踪**的条目写在 **`{HARNESS_DIR}/status.json`** 的 `metadata.residual_findings[<plan-id>]`（**仅 `open`**）；**已验证关闭**的条目迁出至 **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**，避免 `status.json` 无限膨胀。详见 `references/status-and-residuals.md`。

### 已提交文档与计划产物的可到达性（强制建议）

凡是**会进入 Git**且用于贡献者阅读或 **agent handoff** 的文档（例如根目录 `README`、`docs/`、`AGENTS.md`、主 plan 正文），以及落在 **`{HARNESS_DIR}` / `{PLAN_DIR}` 且被跟踪**的计划与报告，应满足：

- **不得**引用仅在本机存在、被 `.gitignore` 排除、或 **`git clone` 后默认不存在**的路径；读者按文内引用应能在仓库内打开对应文件。
- **不得**引用**本仓库根目录以外**的路径（例如 `~/.config/...`、用户主目录绝对路径、任意未作为子模块/子树纳入的「兄弟目录」）。若必须依赖外部上下文：**将要点摘入本仓库**，或给出**稳定、可公开访问**的 URL（并注明适用范围与版本）。
- 违反上述约定会破坏 **onboarding** 与跨环境交接；若项目将 **`{HARNESS_DIR}`**（或遗留模式下整个 `{PLAN_DIR}`）**整体**加入 `.gitignore`，则已提交的 `docs/`、`README`、`AGENTS.md` 等**不得**把被忽略路径下的文件当作**唯一**权威引用。
- 需要 handoff 的 plan / `{PLAN_DIR}/reports/` / **`{HARNESS_DIR}/knowledge/`** 宜 **Git 跟踪**；若某路径刻意不提交，则不要在已提交文档中写死为必读单一来源。

## 初始化 Plan 目录

当 `@project-manager` 判断某项目需要 plan 管理但尚无 plan 目录时：

1. 创建 **`.agents/`** 作为 **`{HARNESS_DIR}`**（首选，对原有项目结构侵入小）。
2. 创建 **`{PLAN_DIR}`** = **`.agents/plans/`**（子目录）。
3. 在 **`{HARNESS_DIR}/`** 下创建 **`status.json`**（完整结构见 `references/status-and-residuals.md`：含 `metadata.residual_findings`）。
4. 可选：创建 **`{HARNESS_DIR}/notes.json`**（空 `entries: []` 或按模板），用于程序里程碑，避免日后向 `status.json` 堆日志。
5. 创建 **`{PLAN_DIR}/reports/README.md`**，用途与命名约定与仓库内其它说明一致即可。
6. 可选：若采用 **`{PLAN_DIR}/residuals/<plan-id>/`** 散文详情，在**首次**需要长文补充某 open R# 时再创建对应 **`residuals/<plan-id>/`** 子目录；无需为空 plan 预建占位目录。
7. 若启用 **`{HARNESS_DIR}/knowledge/`**：创建目录及 **`knowledge/README.md`** 空索引表（见 `references/knowledge-and-designs.md`）。
8. 可选：创建 **`{HARNESS_DIR}/designs/`** 及简短 **`README.md`**，说明冻结规格与 `knowledge/` 的分工。
9. **Git 策略（与项目 `AGENTS.md` 一致）**
   - **推荐（团队交付 / agent handoff）**：**不要**将 **`{HARNESS_DIR}`** 整体加入 `.gitignore`，以便 clone 后计划与报告路径可达。
   - **仅本机私密**：若必须 ignore 整个 **`{HARNESS_DIR}`**，则按上文「可到达性」约束已提交文档；敏感片段另用密钥或私密渠道管理。
10. 如果项目已有 **`.plans/`** 或 **`plans/`** 目录（遗留同目录布局），**不要再创建** **`.agents/`**，直接使用已有目录作为 **`{HARNESS_DIR} = {PLAN_DIR}`**，并视需要补建 **`reports/`**、**`residuals/`**、**`knowledge/`**、**`archived/residuals/`**、可选 **`notes.json`** 与 `metadata` 结构。

## 与 Superpowers `writing-plans`（提示词门限）

上游 **Superpowers** 插件自带的 `writing-plans` 技能默认将计划保存到 `docs/superpowers/plans/`，与本 skill `{PLAN_DIR}` 约定冲突。

**Harness 门限（优于技能正文中的保存路径）**：任一角色在加载并执行 **`writing-plans`** 时，须将新计划写入按上文解析到的 **`{PLAN_DIR}`**（推荐文件名 **`<plan-id>-<plan-name>.md`**，或与项目既有 plan 命名一致；亦可用 `YYYY-MM-DD-<feature-name>.md` 等可追溯形式），**禁止**在业务仓库中默认使用 `docs/superpowers/plans/`。需要新建 **`{HARNESS_DIR}`** / **`{PLAN_DIR}`**、**`{HARNESS_DIR}/status.json`**、可选 **`{HARNESS_DIR}/notes.json`**、**`{PLAN_DIR}/reports/README.md`**、可选 **`{HARNESS_DIR}/knowledge/README.md`**、Git 策略时，按上文 **「初始化 Plan 目录」**；`status.json` 的登记与状态仍由 `@project-manager` 负责。

各角色提示词中对本门限有短引用（见 `~/.config/opencode/agents/project-manager.md`、`product-manager.md`、`architect.md`）；完整消解表见 `mstar-superpowers-align`。

## `tasks` 拆解：并行标记与 Superpowers（示例）

`mstar-harness-core` 要求 `tasks` 产出含 **依赖顺序**、**并行标记** 与完成判据。若 `@project-manager` 将 **≥2 条实现轨同时** 分派（同 plan、无串行依赖），须在 **Status Update** 与各实现方 Assignment 的 **`Superpowers`** 中显式写入 **`dispatching-parallel-agents`**（或 `mstar-superpowers-align` 表中同义短语）；**同一业务仓库** 上 **≥2 名可写承接方并发** 时还须叠 **`using-git-worktrees`**（或同义短语）并写明各流 **检出路径约定**（见 `agents/project-manager.md`「条件加载」、`mstar-harness-core` `references/branch-and-worktree.md`）。

**编排面**：PM 须在 Status Update 发与主 plan 对齐的 **`PM Task Board`**，implement Assignment 写 **`PM Task Board coverage`**（见 `agents/project-manager.md`）。

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
- **`@market-expert`** 等只读角色：将更新内容转达 `@project-manager` 代为写盘。

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
| `InProgress` | 实现或准备阶段进行中 | 更新的主 plan、`tasks` 勾选；编码前已读 `metadata` 指向的 **`knowledge/`** 文档（若有） |
| `InReview` | 审查与验证中 | `{PLAN_DIR}/reports/<plan-id>/` 下 `*-review.md`、`*-qc*.md`、`*-qc-consolidated.md`（见 `references/plan-files-and-reports.md`） |
| `Done` | 已合并/收口 | 主 plan Sign-off、**`{HARNESS_DIR}/status.json`** 的 `done_at`；仍 open 的 R# 留在 `metadata.residual_findings`，已关闭的已迁入 **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`** |
| `Blocked` | 等待外部输入或决策 | 顶层 `notes` + 建议填 `plans[].metadata.blocked_*` / `blocked_by_plan_id` |

## 各角色与 Plan 的关系

- **`@project-manager`**：负责发现 plan 目录、创建/登记 plan、分配任务、推进状态、Done 收口。分配时须告知 subagent plan 目录的实际路径；涉及业务 Git 仓库写操作时须在 Assignment 中写明 **`Working branch`** 或 **`Branch policy`**（见 `mstar-harness-core` `references/branch-and-worktree.md`）。启用 **`knowledge/`** 时维护索引 README，并在 Assignment 中点名 **`primary_spec` / `spec_refs`**（若本轮依赖知识库）。
- **`@architect`** / **`@product-manager`**：产出规格或评审结论若适合跨会话复用，写入 **`{HARNESS_DIR}/knowledge/`**（或团队约定的 **`{HARNESS_DIR}/designs/`**）并更新对应 **README**，建议由 PM 在 `plans[].metadata` 挂接路径。
- **可写盘 agent**（dev / qa / ops）：完成任务后更新主 plan 中**本人负责**的任务 checkbox（见 `references/plan-files-and-reports.md`）、相关 Sign-off 栏位，并更新 `status.json`（权限见上）。**实现前**若 `plans[].metadata` 含 `primary_spec` / `spec_refs`，须先阅读对应文件（见 `references/knowledge-and-designs.md`）。
- **`@product-manager`**：可更新 plan 文档中需求/验收/用户故事等产品负责部分，并在交付后勾选**与之对应**的主 plan 任务 checkbox；**不得**将 `status.json` 中计划状态设为 `Done`；如需改 `progress`/`notes`，以 Assignment 为准或交由 PM 收口。
- **`@architect`**：可更新 plan 文档中架构、接口契约、技术里程碑等章节，并在交付后勾选**与之对应**的主 plan 任务 checkbox；**不得**将 `status.json` 中计划状态设为 `Done`；一般不擅自将整条计划改为 `InReview`（与 PM 对齐）。
- **`@qc-specialist*`**：仅可写 **`{PLAN_DIR}/reports/**/*.md`**；**不**修改主 plan checkbox；其它落盘转达 `@project-manager`。
- **`@market-expert`**（只读）：将更新内容转达 `@project-manager` 代为写盘。
- **所有 agent**：完成后提醒 `@project-manager` 同步 plan 状态。

## References

- `references/status-and-residuals.md` — `{HARNESS_DIR}/status.json` SSOT 结构、`plans[].metadata` 标准字段、根级 `metadata` 字段、residual findings 的 **severity** 枚举（SSOT）、生命周期（open → closed → archived）、`notes.json` 程序时间线、`tech_debt_summary` 技术债一览、常用 jq 查询。
- `references/knowledge-and-designs.md` — `{HARNESS_DIR}/knowledge/` 开发过程知识库（目录、索引、命名、维护）、`{HARNESS_DIR}/designs/` 冻结规格、`{PLAN_DIR}/residuals/<plan-id>/` open residual 散文详情、与 `reports/` 的分工。
- `references/plan-files-and-reports.md` — 主 plan 文件命名、审查报告命名表、QC 分报告与 consolidated 保留原则、**QC 三审触发时机（单 plan · 多 batch）**、residual findings 权威位置与顺序、主 plan Markdown checkbox 规则、Done 标记方式、QC 落盘宿主权限。
- `references/done-compaction.md` — `Done` 计划行冷快照（`{HARNESS_DIR}/archived/plans/`）、Profile A（瘦 Done 行）/ Profile B（不留 Done 行）、原子更新约束、仓库级采用声明模板、合并前 SSOT 与事实一致门禁。
- `references/effort-estimation.md` — Agent-oriented 工期与工作量预估（T 恤尺码 + agent 会话带）；**禁止**混入人天 / FTE / 人类日历；Assignment / PRD / 架构文档字段名建议。
