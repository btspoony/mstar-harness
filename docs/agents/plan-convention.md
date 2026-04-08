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
├── status.json                 # 状态 + open residual（已关闭见 archived/residuals/）
├── reports/                    # 审查类补充报告（只读历史留档）
│   ├── README.md               # 说明本目录用途与命名（建议初始化时创建）
│   └── <plan-id>/              # 按 plan 分目录
│       ├── <plan-id>-review.md
│       ├── <plan-id>-qc1.md
│       ├── <plan-id>-qc2.md
│       ├── <plan-id>-qc3.md
│       └── <plan-id>-qc-consolidated.md
├── archived/                   # 可选：计划快照、已关闭 residual 等
│   └── residuals/              # 已关闭的 residual 按 plan 分文件（推荐，见「生命周期」）
│       └── <plan-id>.json
└── knowledge/                  # 可选：开发过程知识库（见下文「knowledge 专节」）
```

- **主计划**：技术方案、任务清单、Sign-off 仍以 `<plan-id>-<plan-name>.md` 与 `status.json` 为权威。
- **reports/**：架构评审、QC 分报告、QC 汇总结论；**视为只读历史**，不在此反复改写同一结论（修正走新报告或回写主计划 / `status.json`）。
- **knowledge/**：规格修订、架构评审产出、设计决策与 gap 分析等**实施上下文**；与面向用户的 `docs/` 分工见下节。
- **residual findings（未关闭）**：**当前仍待跟踪**的条目写在 `status.json` 的 `metadata.residual_findings[<plan-id>]`（**仅 `open`**，见下文）；**已验证关闭**的条目应迁出至 **`{PLAN_DIR}/archived/residuals/<plan-id>.json`**，避免 `status.json` 无限膨胀。

### 与项目文档「可到达性」对齐

若项目根 `AGENTS.md`（或其它已提交文档）要求：**fresh clone 后读者能打开文内引用的路径**（且不引用仓库外绝对路径），则：

- 需要 handoff 的 plan / reports / **knowledge** 应**被 Git 跟踪**，或改为不依赖被 ignore 的路径写进已提交文档。
- 若将 `{PLAN_DIR}` **整体**加入 `.gitignore`，则**不得**在已提交的 `docs/`、`README`、`AGENTS.md` 中把该目录下文件当作唯一权威引用。

## `{PLAN_DIR}/knowledge/` 开发过程知识库（通用约定）

本节将「用户文档」与「agent / 实施用知识」分开，**与具体业务仓库无关**；项目可在根目录 `AGENTS.md` 用一小段指向本节或复述分界关键词，避免重复维护长文。

### 与公开文档目录的分工（典型为 `docs/`）

| 区域 | 典型内容 | 受众 |
|------|----------|------|
| **`docs/`**（或项目约定的用户文档根） | 安装/quickstart、稳定架构概览、贡献指南、对外 API 说明 | 人类贡献者与终端用户；clone 后应可读 |
| **`{PLAN_DIR}/knowledge/`** | 架构评审报告、规格修订稿、gap 分析、约束清单、**某一 plan 的输入/输出设计材料** | Agent handoff、跨会话连续；**不**默认当作对外产品文档 |

**不应**放入用户文档树的内容（宜放 `knowledge/` 或主 plan）：作为**特定 plan 的输入/输出**的评审结论、实施笔记、未稳定的规格草案。

### 目录与索引

- 知识库物理路径：**`{PLAN_DIR}/knowledge/`**（若 `{PLAN_DIR}` 为 `.agents/plans/`，则与「`.agents/knowledge/`」不是同一路径；**以 `{PLAN_DIR}` 为准**）。
- **必须**维护 **`{PLAN_DIR}/knowledge/README.md`** 作为**目录索引**：至少包含表格列 **Document（链接）**、**Source Plan（`plans[].id`）**、**Description**、**Status**（如 `Active` / `Superseded by implementation (<plan-id>)` / `Archived`）。
- 初始化启用知识库时：创建空表头的 `README.md`，随文档递增行。

### 文件命名

- 推荐：`<topic>-<qualifier>-v<N>.md`（例：`sync-contract-gap-analysis-v1.md`），便于同主题多版共存。
- 避免与主 plan 文件名混淆：主 plan 仍建议 `<plan-id>-<plan-name>.md` 且放在 `{PLAN_DIR}/` 根下，而非塞进 `knowledge/` 根（除非团队明确约定）。

### 与 `status.json` 的链接

- 某 plan 的**权威设计输入**在知识库中时，在 **`plans[].metadata`** 中登记路径，推荐使用已列标准键：**`primary_spec`**（单文件）或 **`spec_refs`**（`string[]`）。路径为**仓库内相对路径**（常写作 `.agents/plans/knowledge/....md` 或 `plans/knowledge/....md`，视 `{PLAN_DIR}` 解析结果而定）。
- 执行方在 **implement 前**须按 metadata 读取这些文件，并与主 plan 核对；不得在未读链接文档的情况下**静默偏离**其中已写明的决策（若需偏离，先回写 knowledge 或 plan 并走 PM/architect 门禁）。

### 维护规则

1. **新增**：按命名规则添加 `.md` → 在 `knowledge/README.md` 索引表增加一行 → 在相关 `plans[].metadata` 更新 `primary_spec` / `spec_refs`（若该文档为本 plan 输入/输出）。
2. **阅读**：开发类 agent 在开始编码前，**必须**阅读当前 plan 在 `metadata` 中指向的 knowledge 文档（若存在）；@project-manager 在 Assignment 中可再次点名路径。
3. **修订**：评审或规格变更若改动了 knowledge 文件，同步更新 README 中 **Status** 或 Description；版本迭代优先新文件名 `v<N+1>` 或保留旧版并标明 Superseded。
4. **归档**：当文档内容已完全反映到已合并代码中时：**保留文件不删除**（保留设计考据）；将索引 **Status** 标为 `Superseded by implementation (...)` 或 `Archived`。**不要**把知识库产物搬进 `{PLAN_DIR}/archived/`，后者用于**计划主文件**快照；知识库用索引状态表达生命周期即可。

### 与 `reports/` 的区分

- **`reports/<plan-id>/`**：偏 **审查流程留档**（review、QC1/2/3、consolidated），只读历史。
- **`knowledge/`**：偏 **可复用的设计上下文**（规格、决策、分析），可被后续 plan 或多会话反复引用；二者可互链，但职责不混写。

## 初始化 Plan 目录

当 @project-manager 判断某项目需要 plan 管理但尚无 plan 目录时：

1. 创建 `.agents/plans/` 目录（首选，因为对原有项目结构侵入最小）。
2. 在 `.agents/plans/` 下创建 `status.json`（见下文完整结构：含 `metadata.residual_findings`）。
3. 创建 `{PLAN_DIR}/reports/README.md`，用途与命名约定与仓库内其它说明一致即可（可参考各业务仓库 `reports/README.md` 模板）。
4. 若启用 **`{PLAN_DIR}/knowledge/`**：创建目录及 **`knowledge/README.md`** 空索引表（见上文「knowledge 专节」）。
5. **Git 策略（与项目 `AGENTS.md` 一致）**
   - **推荐（团队交付 / agent handoff）**：**不要**将 `{PLAN_DIR}` 整体加入 `.gitignore`，以便 clone 后计划与报告路径可达。
   - **仅本机私密**：若必须 ignore 整个 `{PLAN_DIR}`，则按上文「可到达性」约束已提交文档；敏感片段另用密钥或私密渠道管理。
6. 如果项目已有 `plans/` 或 `.plans/` 目录，**不要再创建 `.agents/plans/`**，直接使用已有目录，并视需要补建 `reports/`、`knowledge/`、`archived/residuals/`（可附 **`archived/residuals/README.md`** 一句说明）与 `metadata` 结构。

## 与 Superpowers `writing-plans`（提示词门限）

上游 **Superpowers** 插件自带的 `writing-plans` 技能默认将计划保存到 `docs/superpowers/plans/`，与本节 **`{PLAN_DIR}`** 约定冲突。

**Harness 门限（优于技能正文中的保存路径）：** 任一角色在加载并执行 **`writing-plans`** 时，须将新计划写入按上文解析到的 **`{PLAN_DIR}`**（推荐文件名 **`<plan-id>-<plan-name>.md`**，或与项目既有 plan 命名一致；亦可用 `YYYY-MM-DD-<feature-name>.md` 等可追溯形式），**禁止**在业务仓库中默认使用 `docs/superpowers/plans/`。需要新建目录、`status.json`、`reports/README.md`、可选 `knowledge/README.md`、Git 策略时，按本节 **「初始化 Plan 目录」**；`status.json` 的登记与状态仍由 @project-manager 按本文档负责。

各角色提示词中对本门限有短引用（见 `~/.config/opencode/agents/project-manager.md`、`product-manager.md`、`architect.md`）；完整消解表见 `superpowers-skills.md`。

## `{PLAN_DIR}/status.json` 结构

`status.json` 是 **`plans[]` 行状态**与 **仍处 `open` 的 residual findings** 的**单一事实来源（SSOT）**。  
**已关闭**的 residual **不应长期堆在**本文件中；权威档案见 **`{PLAN_DIR}/archived/residuals/<plan-id>.json`**（见「Residual findings 生命周期」）。

**编排语义（为何不是「多写几个字」）**：open 列表与 `archived/residuals/` 是跨会话、跨 agent 的**风险与决策交接面**。若非阻断结论只留在对话或单次 QC 报告里、**不进 SSOT**，下一任实现/审查方**无法可靠继承**已 defer、已风险接受或待跟进的约定；`Done` 也会与「已知债是否对仓库可见」**脱钩**，复盘或线上问题时常出现**无单一事实可引用**。因此 **@project-manager** 宜在审查收口后尽快把应跟踪项**登记为 open**；**@qa-engineer** 与 PM 宜在验证或豁免决策明确后**及时关闭并归档**——节奏可按里程碑灵活安排，但**不应默认「口头说过即可」**。

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
      "notes": "",
      "metadata": {}
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

**已关闭条目**在以上字段之外补充：`lifecycle`、`closed_at`、`closure_note`；可选 `closure_evidence`、`superseded_by`。语义见本节下「Residual findings 生命周期」。

- 每条 `plans[]` 可带 **`metadata` 对象**（可选）；见下表 **标准可选字段**。无扩展需求时可省略该键或置 `{}`。
- 初始化时若尚无 findings，使用 `"metadata": { "residual_findings": {} }`；可同时初始化 `"metadata": { "residual_findings": {}, "notes": [] }` 等根级字段。
- **`plans[].id`** 与 **`metadata.residual_findings`** 的键应对齐（同一 `plan-id`），便于 `jq` 与报告目录 `reports/<plan-id>/` 一致。**不要**再存 `residual_findings_plan_id`（与 `id` 重复）。
- **严重等级**（与 `review-harness.md` 门禁对齐）：`critical` / `high` 为合并前须处理或显式升级；`medium` / `low` / `warning` 可作为 residual 跟踪。
- **`residual_summary`（可选）**：单行人类可读摘要；**仅描述仍留在** `metadata.residual_findings[<plan-id>]` **中的 open 项**（已关闭项应在归档文件与可选 `metadata.notes` 中体现）。

### Residual findings 生命周期（关闭、归档、移除）

本节约定技术债条目在**已修复、已豁免、被替代或误登**之后如何更新 JSON，与「登记」流程闭环。

#### 条目状态 `lifecycle`（可选，默认视为 open）

| `lifecycle` | 含义 | 关闭时 `closure_note` 应说明 |
|---------------|------|------------------------------|
| `open` | 未关闭（**省略该字段时按 open 处理**，兼容旧数据） | — |
| `resolved` | 已在代码/配置/文档中解决，且**已验证** | 改了什么、如何验证（可与 `closure_evidence` 互指） |
| `waived` | 经明确决策**不修复**（承担风险或产品接受） | 谁决策、为何不修、是否登记 `tracking` Issue |
| `superseded` | 被新 finding、新规格或重构方案取代 | 指向 `superseded_by`（另一条 `id` 或知识库路径） |
| `duplicate` | 重复录入或与另一 R# 实质相同 | 指向 canonical 的 `id` 或说明误登 |

**关闭必填**：凡 `lifecycle` 为 `resolved` / `waived` / `superseded` / `duplicate`，须填写 **`closed_at`**（`YYYY-MM-DD`）与 **`closure_note`**（一句即可）。**推荐**填写 **`closure_evidence`**（PR、commit、测试结果、文档锚点），以满足可审计与 `verification-before-completion` 一致。

#### 谁更新、何时更新

| 动作 | 建议负责方 | 时机 |
|------|------------|------|
| 实现修复 | `@fullstack-dev` / 对应 owner | Completion Report 中说明对应 R# 与证据 |
| 验证 | `@qa-engineer` | 回归或验收中确认 R# 已满足 |
| 写回 `status.json` | **@project-manager** 或 **@qa-engineer**（与 Done 收口权限一致） | 验证通过后同一提交或紧随其后；豁免/替代由 PM 与用户或架构对齐后写回 |

**不得**在未落盘的情况下，仅从对话或主 plan 文案中宣称「R3 已修」而不更新 SSOT（见下「文件归档」）。

**对 @project-manager / @qa-engineer 的预期（可灵活，须诚实）**：PM 在 **`Approve with residuals`** 或 consolidated QC 后**主动补齐** open 登记（或与 QC 报告交叉引用且 SSOT 中可追溯）；QA 在验收叙述中**显式交代**每条相关 R#（仍 open / 本次已验证 resolved / 需 PM 与用户裁决豁免），避免「只写测试通过」而 SSOT 与报告对不上。长期 open 与已关闭双写、或主列表与归档文件**长期不一致**，会削弱 handoff 可信度，应在本里程碑内收敛。

#### 推荐策略：关闭后迁入 `archived/residuals/<plan-id>.json`（控制 `status.json` 体积）

为避免 **`status.json` 随已关闭 R# 无限膨胀**，在 **`closed_at` / `closure_note`（及推荐 `closure_evidence`）已齐备** 且 **@qa-engineer** 或 **@project-manager** 已确认可关闭后：

1. **追加**到 **`{PLAN_DIR}/archived/residuals/<plan-id>.json`**（文件名与 **`plans[].id`** 一致；若 `{PLAN_DIR}` 为仓库根下 `plans/`，则全路径为 `plans/archived/residuals/<plan-id>.json`）。
2. 从 **`metadata.residual_findings[<plan-id>]`** 数组中 **删除**该条（主列表**只保留 open**）。
3. 更新根级 **`updated_at`**；可选在 **`metadata.notes`** 追加一条里程碑。

**归档文件格式**（每个 `plan-id` 一个 JSON 文件，可多次追加 `entries`）：

```json
{
  "plan_id": "01-data-infrastructure",
  "schema_version": 1,
  "entries": [
    {
      "id": "R1",
      "title": "…",
      "severity": "medium",
      "source": "QC-#1",
      "scope": "…",
      "decision": "defer",
      "owner": "@fullstack-dev",
      "target": "…",
      "tracking": null,
      "lifecycle": "resolved",
      "closed_at": "2026-04-06",
      "closure_note": "…",
      "closure_evidence": "PR #42 / commit …",
      "archived_at": "2026-04-07"
    }
  ]
}
```

- **首次**为该 `plan-id` 归档时创建文件；**后续**关闭项 **append** 到同一文件的 `entries`（合并时读入—追加—写回，注意 JSON 格式化与冲突）。
- 每条归档对象 **必须**含 **`archived_at`**（迁入文件当日 `YYYY-MM-DD`），与 `closed_at` 可不同。
- **审计**：已关闭记录**只存在于**上述文件（及 QC `reports/` 原文）；`status.json` 不再承载该条。
- **一览**：若使用 **`metadata.tech_debt_summary`**，批量归档或关闭后应**刷新**聚合数字，与仍 open 的 R# 对齐（见「`metadata.tech_debt_summary`」专节）。

#### 临时原位关闭（仅短过渡）

在写入归档文件**之前**，可先在 `metadata.residual_findings` 内补全 `lifecycle` / `closed_*`（便于同一次 PR 内 diff）；**应在同一里程碑内**完成「迁入 `archived/residuals` + 从主列表删除」，避免长期双写。

#### 遗留：`metadata.residual_findings_history`（不推荐）

根级 **`residual_findings_history`** 曾用于在单文件内剪切已关闭项；**新仓库请优先**使用 **`archived/residuals/<plan-id>.json`**，以免 `status.json` 仍随历史变长。若仓库已存在 `residual_findings_history`，可由 **@project-manager** 择机迁到 `archived/residuals/` 后删除该键。

#### 移除（硬删除）

- **禁止**对 **`open`** 条目从 `status.json` **硬删**。
- 已归档条目**不要**从 `archived/residuals/*.json` **删除**；错关时追加更正说明条目或新开 R# 引用原 `id`。
- 仅**误登且未进入任何留档**时，经 **@project-manager** 可从 `residual_findings` 删除；更稳妥为标 **`duplicate`** 后走关闭归档流程。

#### 查询 open 项与已归档（示例）

```bash
jq '.metadata.residual_findings["01-data-infrastructure"]' .agents/plans/status.json
jq '.entries[] | select(.id == "R1")' .agents/plans/archived/residuals/01-data-infrastructure.json
jq '.metadata.tech_debt_summary' .agents/plans/status.json
```

### `plans[].metadata` 标准可选字段

与业务仓库实践对齐的推荐键（均为可选；项目可只选子集）：

| 键 | 类型 | 用途 |
|----|------|------|
| `working_branch` | string | 本 plan 实现所用分支名，与 Assignment **`Working branch`** 对齐（SSOT） |
| `merge_target` | string | 预期合并目标分支（如 `main`）；默认分支以项目约定为准 |
| `branch_policy` | string | 与 `harness-loop.md` 一致的一行策略说明（如 `direct on main — <reason>` 或 `create feature/x from main`） |
| `phase` | string | 程序/路线图阶段标签（如 `Phase 0`、`v1.0`） |
| `priority` | `high` \| `medium` \| `low` | PM 编排优先级 |
| `description` / `scope` | string | 一句话范围或目标；**同一仓库内择一**为主，避免两键长期混填不同内容 |
| `gates` | object | 门禁结果摘要；**推荐子键**（按需）：`qc`、`qa`、`typecheck`、`tests`、`lint`… 值为短字符串（如 `PASS (…)`、`FAIL — see report`） |
| `blocked_since` | `YYYY-MM-DD` | 当 `status` 为 `Blocked` 时建议填写 |
| `blocked_reason` | string | 阻塞原因（可与顶层 `notes` 互引，metadata 便于机器过滤） |
| `blocked_by_plan_id` | string | 若阻塞来自另一计划，填对方 **`plans[].id`** |
| `dependency` | string | 其它依赖说明（接口、外部团队）；与 `blocked_by_plan_id` 互补 |
| `next_action` | string | 当前解锁后或审查后的下一步（给谁、做什么） |
| `primary_spec` | string | 主规格/设计文档路径（仓库内相对路径；**常为** `{PLAN_DIR}/knowledge/...`）；多文档可用 `spec_refs`（string[]） |
| `qc_status` / `tests` / `commits` | string | **InReview / Done** 前后的可验证快照（结论摘要、测试统计、commit 提示），**非**替代正式报告文件 |

### 根级 `metadata` 标准可选字段

除 **`residual_findings`**（SSOT）外，推荐可选：

| 键 | 类型 | 用途 |
|----|------|------|
| `versioning` | object | 跨 plan 约定，如 `phase_1_branch_prefix`、`release` 等（自由键，团队自定） |
| `notes` | array | **程序级时间线**：元素建议 `{ "updated_at": "YYYY-MM-DD", "message": "…" }`，用于里程碑叙述（区别于单条 plan 的 `notes` 字符串） |
| `residual_findings_history` | object | **遗留/不推荐**：同型剪切区；**新归档请用** `{PLAN_DIR}/archived/residuals/<plan-id>.json` |
| `tech_debt_summary` | object | **可选**：技术债**一览/rollup**，与 **`residual_findings` 互补**（见下专节）；由 **@project-manager** 维护 |

### `metadata.tech_debt_summary`（可选·技术债一览）

**定位**：在 **`metadata.residual_findings`**（按 `plan-id` 分列的 **open** R#）之上，提供**跨 plan 的聚合视图**，便于路线图、排期与「还有多少 open」一眼扫读。**不替代**单条 R# 的权威字段；新增/关闭 R# 时仍以 `residual_findings` 与 `archived/residuals/` 为准。

**维护**：**@project-manager** 在重大里程碑后更新（例如 QC 波次结束、批量归档 resolved、版本封板前）。可选在 **`metadata.notes`** 记一条「已刷新 `tech_debt_summary`」。

**推荐结构**（字段可按项目删减；`cross_cutting` 可省略）：

```json
{
  "tech_debt_summary": {
    "updated_at": "YYYY-MM-DD",
    "total_open": 29,
    "by_severity": {
      "critical": 0,
      "high": 10,
      "medium": 10,
      "low": 5,
      "warning": 1
    },
    "by_target": {
      "V1.0 GA": 5,
      "V1.1": 18,
      "implementation-start": 1
    },
    "by_plan": {
      "domain-models": 4,
      "cli-daemon-foundation": 11,
      "cross-cutting": 1
    },
    "cross_cutting": [
      {
        "id": "DEBT-X1",
        "title": "Short cross-plan theme (e.g. shared DB pooling)",
        "severity": "high",
        "scope": "crates/foo, crates/bar",
        "target": "V1.1 — unified strategy",
        "relates_to": ["CLI-R9", "SYNC-R4"]
      }
    ]
  }
}
```

- **`total_open` / `by_*`**：应与当前 **`metadata.residual_findings`** 中所有 **open**（未归档）条目的数量与严重度**大致一致**；若有意的「跨 plan 合并视角」导致计数口径不同，在 `metadata.notes` 或 `cross_cutting` 中说明。
- **`by_plan`**：键可为 **短标签** 或 **`plans[].id` 前缀**，与仓库约定一致即可。
- **`cross_cutting`**：用于**跨多 plan / 多条 R#** 的主题债（架构层、重复实现等）；**`relates_to`** 列出对应 **`id`**（与 `residual_findings` 内 R# 对齐），避免与单条 R# 重复叙述时可只在此处保留总述。

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

### QC 三审触发时机（单 plan · 多 batch）

- **默认（推荐）**：同一 **`plan_id`** 下，**完整 QC 三审**（`qc1` + `qc2` + `qc3` 并行）**仅在 dev team 按该 plan 约定范围全部交付之后**执行**一次**，再进入 @project-manager 汇总与 @qa-engineer 验证。**不要**在每个中间 **batch** / 子里程碑都跑全套三审：否则 `reports/<plan-id>/` 会堆积多套并列报告，**`Review range` / `Diff basis` 与结论**易混淆，handoff 成本高。
- **batch 之间**：依赖实现方 **`verification-before-completion`**、主 plan 任务勾选与 PM 协调；需要书面中间意见时，用对话、主 plan 批注或**非三审**的定向检查（如单审、架构 review），**不**默认等同「又一轮完整三审」。
- **Request Changes 后复验**：若须再跑一轮完整三审，使用**新文件名**落盘，避免覆盖首轮报告，例如 `<plan-id>-qc1-rev2.md` … `<plan-id>-qc3-rev2.md`（或团队约定的 `wave2-` 前缀）；@project-manager 在 `QC Consolidated Decision` 中写明**当前以哪一波次为准**。
- **显式例外**：仅当用户与 PM 书面同意**中间门禁**时，在 Assignment 写清 **`QC gate: incremental — <scope>`**（或等价），并仍须保证该次三审的 **`plan_id` + `Review range` / `Diff basis`** 三份一致；**优先**用子范围专用标签或子目录，避免与「整 plan 终局」那套 `-qc*.md` 混名。

**QC 落盘与宿主权限**：`@qc-specialist` / `@qc-specialist-2` / `@qc-specialist-3` 使用 OpenCode **`permission.edit`** 路径白名单，**仅可** Write/Edit **`{PLAN_DIR}/reports/`** 下 **`.md`**（全局 agent 提示词中已配置 `.agents/plans/reports/**`、`.plans/reports/**`、`plans/reports/**` 相对路径）。报告文件**必须**以 YAML **frontmatter** 开头（键见各 QC agent 提示词）。**若** 项目的 `{PLAN_DIR}` 不落在上述三种根下，须在**项目级** OpenCode 配置中为 QC 角色追加对应的 `edit` allow 规则。

### 主 plan 内任务清单（Markdown checkbox）

- **谁应更新**：`@fullstack-dev` / `@frontend-dev` / `@fullstack-dev-2`、`@qa-engineer`、`@ops-engineer`、`@architect`、`@product-manager` 在**完成本人 Assignment 范围内的工作后**，须在主 plan（`<plan-id>-<plan-name>.md`）中把**对应条目**的 Markdown 任务标记为已完成（常见：`- [ ]` → `- [x]`；若项目用其它清单记号，保持同文件内一致）。与 Completion Report **并列**，作为跨会话可核对的**落盘痕迹**。
- **范围**：**只勾选与当前任务直接对应、且已由本角色交付证据支撑的条目**；不得代为勾选他人负责或未完工项。若正文用分段、Owner 或角色标签区分任务，以 Assignment 与文内约定为准。
- **与 `status.json` / frontmatter 的关系**：勾选任务**不**等于整条计划收口。`plans[].status` 及主 plan frontmatter 的 **`Done`** 仍**仅** `@project-manager` / `@qa-engineer`（见「状态更新权限」）。`@architect` / `@product-manager` **不得**擅自将整条计划标为 `Done`；是否将 `status.json` 推进为 `InReview` 等仍按下文「状态更新权限」与 Assignment。
- **`@qc-specialist*`**：**不得**修改主 plan（宿主仅允许 `{PLAN_DIR}/reports/**/*.md`）；审查结论落在 `reports/<plan-id>/` 内。若主 plan 需新增或勾选与审查相关的条目，由 `@project-manager` 或 Assignment 明确授权的角色据报告回写。
- **只读角色**（如 `@market-expert`）：不直接改主 plan；将建议交给 `@project-manager` 代为更新清单。

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
| `InProgress` | 实现或准备阶段进行中 | 更新的主 plan、`tasks` 勾选；编码前已读 `metadata` 指向的 **`knowledge/`** 文档（若有） |
| `InReview` | 审查与验证中 | `{PLAN_DIR}/reports/<plan-id>/` 下 `*-review.md`、`*-qc*.md`、`*-qc-consolidated.md`（见上文命名表） |
| `Done` | 已合并/收口 | 主 plan Sign-off、`status.json` 的 `done_at`；仍 open 的 R# 留在 `metadata.residual_findings`，已关闭的已迁入 **`archived/residuals/<plan-id>.json`** |
| `Blocked` | 等待外部输入或决策 | 顶层 `notes` + 建议填 `plans[].metadata.blocked_*` / `blocked_by_plan_id` |

## 状态更新权限

- 主 plan 内 **Markdown 任务勾选**（checkbox）规则见上文「主 plan 内任务清单（Markdown checkbox）」；与 `status.json` 的**计划级**状态字段分离管理。
- **Done** 只能由 @project-manager 或 @qa-engineer 设置。
- 可写盘 agent（dev / qa / ops）完成任务后可将状态更新为 `InReview`。
- **@product-manager**、**@architect** 可写 plan 文档中各自负责部分（含本人任务 checkbox），但**不**应擅自将整条计划在 `status.json` 中改为 `InReview` 或 `Done`（除非 Assignment 明确授权且与 PM 对齐）； **`Done` 仍仅限** PM/QA。
- **@qc-specialist** / **@qc-specialist-2** / **@qc-specialist-3**：可按宿主白名单**直接写入** `{PLAN_DIR}/reports/**/*.md`；**不得**改主 plan checkbox；**其它路径**仍转达 @project-manager。
- **@market-expert** 等只读角色：将更新内容转达 @project-manager 代为写盘。

## 未启用 Plan 管理时的工作方式

当项目中不存在 plan 目录时：

- @project-manager 通过对话和回报传递任务进度，不创建 plan 文件。
- 各 agent 在 Completion Report 中汇报状态，不引用 plan 路径。
- 如果任务复杂度增加到需要持久化追踪，@project-manager 可建议用户启用 plan 管理（按上述初始化流程创建目录）。
- 所有门禁和审查流程照常运行，不受 plan 目录有无影响。

## 各角色与 Plan 的关系

- **@project-manager**：负责发现 plan 目录、创建/登记 plan、分配任务、推进状态、Done 收口。分配时须告知 subagent plan 目录的实际路径；涉及业务 Git 仓库写操作时须在 Assignment 中写明 **`Working branch`** 或 **`Branch policy`**（见 `harness-loop.md`「Git 功能分支门禁」）。启用 **`knowledge/`** 时维护索引 README，并在 Assignment 中点名 **`primary_spec` / `spec_refs`**（若本轮依赖知识库）。
- **@architect** / **@product-manager**：产出规格或评审结论若适合跨会话复用，写入 **`{PLAN_DIR}/knowledge/`** 并更新 **`knowledge/README.md`**，建议由 PM 在 `plans[].metadata` 挂接路径。
- **可写盘 agent**（dev / qa / ops）：完成任务后更新主 plan 中**本人负责**的任务 checkbox（见「主 plan 内任务清单」）、相关 Sign-off 栏位，并更新 `status.json`（权限见「状态更新权限」）。**实现前**若 `plans[].metadata` 含 `primary_spec` / `spec_refs`，须先阅读对应文件（见上文「knowledge 专节」）。
- **@product-manager**：可更新 plan 文档中需求/验收/用户故事等产品负责部分，并在交付后勾选**与之对应**的主 plan 任务 checkbox；**不得**将 `status.json` 中计划状态设为 `Done`；如需改 `progress`/`notes`，以 Assignment 为准或交由 PM 收口。
- **@architect**：可更新 plan 文档中架构、接口契约、技术里程碑等章节，并在交付后勾选**与之对应**的主 plan 任务 checkbox；**不得**将 `status.json` 中计划状态设为 `Done`；一般不擅自将整条计划改为 `InReview`（与 PM 对齐）。
- **@qc-specialist\***：仅可写 **`{PLAN_DIR}/reports/**/*.md`**（见「状态更新权限」）；**不**修改主 plan checkbox；其它落盘转达 @project-manager。
- **@market-expert**（只读）：将更新内容转达 @project-manager 代为写盘。
- **所有 agent**：完成后提醒 @project-manager 同步 plan 状态。
