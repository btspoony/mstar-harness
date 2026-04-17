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
├── notes.json                  # 可选：程序里程碑 / 时间线日志（减轻 status.json 体积）
├── reports/                    # 审查类补充报告（只读历史留档）
│   ├── README.md               # 说明本目录用途与命名（建议初始化时创建）
│   └── <plan-id>/              # 按 plan 分目录
│       ├── <plan-id>-review.md
│       ├── <plan-id>-qc1.md
│       ├── <plan-id>-qc2.md
│       ├── <plan-id>-qc3.md
│       └── <plan-id>-qc-consolidated.md
├── archived/                   # 可选：已关闭 residual、可选 Done 计划行冷快照
│   ├── residuals/              # 已关闭的 residual 按 plan 分文件（推荐，见「生命周期」）
│   │   └── <plan-id>.json
│   ├── plans/                  # 可选：Done 时完整 `plans[]` 元素快照（见下文「冷快照」）
│   │   └── <plan-id>.json
│   └── plans-done.json         # 可选（Profile B）：Done 计划最小索引（见下文 profile 说明）
└── knowledge/                  # 可选：开发过程知识库（见下文「knowledge 专节」）
```

- **主计划**：技术方案、任务清单、Sign-off 仍以 `<plan-id>-<plan-name>.md` 与 `status.json` 为权威。
- **reports/**：架构评审、QC 分报告、QC 汇总结论；**视为只读历史**，不在此反复改写同一结论（修正走新报告或回写主计划 / `status.json`）。
- **knowledge/**：规格修订、架构评审产出、设计决策与 gap 分析等**实施上下文**；与面向用户的 `docs/` 分工见下节。
- **residual findings（未关闭）**：**当前仍待跟踪**的条目写在 `status.json` 的 `metadata.residual_findings[<plan-id>]`（**仅 `open`**，见下文）；**已验证关闭**的条目应迁出至 **`{PLAN_DIR}/archived/residuals/<plan-id>.json`**，避免 `status.json` 无限膨胀。

### 已提交文档与计划产物的可到达性（强制建议）

凡是**会进入 Git**且用于贡献者阅读或 **agent handoff** 的文档（例如根目录 `README`、`docs/`、`AGENTS.md`、主 plan 正文），以及落在 **`{PLAN_DIR}` 且被跟踪**的计划与报告，应满足：

- **不得**引用仅在本机存在、被 `.gitignore` 排除、或 **`git clone` 后默认不存在**的路径；读者按文内引用应能在仓库内打开对应文件。
- **不得**引用**本仓库根目录以外**的路径（例如 `~/.config/...`、用户主目录绝对路径、任意未作为子模块/子树纳入的「兄弟目录」）。若必须依赖外部上下文：**将要点摘入本仓库**，或给出**稳定、可公开访问**的 URL（并注明适用范围与版本）。
- 违反上述约定会破坏 **onboarding** 与跨环境交接；若项目将 `{PLAN_DIR}` **整体**加入 `.gitignore`，则已提交的 `docs/`、`README`、`AGENTS.md` 等**不得**把该目录下文件当作**唯一**权威引用（与下文「Git 策略」一致）。
- 需要 handoff 的 plan / `reports/` / **`knowledge/`** 宜 **Git 跟踪**；若某路径刻意不提交，则不要在已提交文档中写死为必读单一来源。

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
3. 可选：创建 **`{PLAN_DIR}/notes.json`**（空 `entries: []` 或按专节模板），用于程序里程碑，避免日后向 `status.json` 堆日志。
4. 创建 `{PLAN_DIR}/reports/README.md`，用途与命名约定与仓库内其它说明一致即可（可参考各业务仓库 `reports/README.md` 模板）。
5. 若启用 **`{PLAN_DIR}/knowledge/`**：创建目录及 **`knowledge/README.md`** 空索引表（见上文「knowledge 专节」）。
6. **Git 策略（与项目 `AGENTS.md` 一致）**
   - **推荐（团队交付 / agent handoff）**：**不要**将 `{PLAN_DIR}` 整体加入 `.gitignore`，以便 clone 后计划与报告路径可达。
   - **仅本机私密**：若必须 ignore 整个 `{PLAN_DIR}`，则按上文「可到达性」约束已提交文档；敏感片段另用密钥或私密渠道管理。
7. 如果项目已有 `plans/` 或 `.plans/` 目录，**不要再创建 `.agents/plans/`**，直接使用已有目录，并视需要补建 `reports/`、`knowledge/`、`archived/residuals/`（可附 **`archived/residuals/README.md`** 一句说明）、可选 **`notes.json`** 与 `metadata` 结构。

## 与 Superpowers `writing-plans`（提示词门限）

上游 **Superpowers** 插件自带的 `writing-plans` 技能默认将计划保存到 `docs/superpowers/plans/`，与本节 **`{PLAN_DIR}`** 约定冲突。

**Harness 门限（优于技能正文中的保存路径）：** 任一角色在加载并执行 **`writing-plans`** 时，须将新计划写入按上文解析到的 **`{PLAN_DIR}`**（推荐文件名 **`<plan-id>-<plan-name>.md`**，或与项目既有 plan 命名一致；亦可用 `YYYY-MM-DD-<feature-name>.md` 等可追溯形式），**禁止**在业务仓库中默认使用 `docs/superpowers/plans/`。需要新建目录、`status.json`、可选 **`notes.json`**、`reports/README.md`、可选 `knowledge/README.md`、Git 策略时，按本节 **「初始化 Plan 目录」**；`status.json` 的登记与状态仍由 @project-manager 按本文档负责。

各角色提示词中对本门限有短引用（见 `~/.config/opencode/agents/project-manager.md`、`product-manager.md`、`architect.md`）；完整消解表见 `superpowers-skills.md`。

## `tasks` 拆解：并行标记与 Superpowers（示例）

`harness-loop.md` 要求 `tasks` 产出含 **依赖顺序**、**并行标记** 与完成判据。若 @project-manager 将 **≥2 条实现轨同时** 分派（同 plan、无串行依赖），须在 **Status Update** 与各实现方 Assignment 的 **`Superpowers`** 中显式写入 **`dispatching-parallel-agents`**（或 `superpowers-skills.md` 表中同义短语）；**同一业务仓库** 上 **≥2 名可写承接方并发** 时还须叠 **`using-git-worktrees`**（或同义短语）并写明各流 **检出路径约定**（见 `agents/project-manager.md`「条件加载」、`harness-loop.md`「同仓并发写入」）。

**编排面**：PM 须在 Status Update 发与主 plan 对齐的 **`PM Task Board`**，implement Assignment 写 **`PM Task Board coverage`**（见 `agents/project-manager.md` 同标题节）。

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
          "severity": "critical | high | medium | low | nit",
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

### Residual findings：severity（SSOT，机器字段）

`metadata.residual_findings[<plan-id>][]` 里每条记录的 **`severity`** 只能是本节定义的枚举值。QC 报告 Markdown 里的 **Critical / Warning / Suggestion** 是**章节标题**，**不得**原样当作 JSON 里的 `severity`（二者关系见下表）。

#### 1. 允许取值

仅此五种，**必须小写英文**：

`critical`、`high`、`medium`、`low`、`nit`

#### 2. 全序（从重到轻）

`critical` ＞ `high` ＞ `medium` ＞ `low` ＞ `nit`

- **`nit` 恒轻于 `low`**，禁止把两档颠倒或等同。
- **禁止**把 `severity` 写成 `warning`、`Major`、中文或其它未列出的字符串。

#### 3. 各档含义与门禁关系

| `severity` | 含义要点 |
|------------|----------|
| `critical` | 合并阻断级；与 QC 报告 **Critical** findings 对应。 |
| `high` | 非阻断但影响大（安全、正确性、数据、显著技术债）；须修复、显式升级决策，或 open residual 并由 PM 明确跟进。 |
| `medium` | 当前或下一里程碑应处理；可 open residual。 |
| `low` | 影响面小、修复成本低；可 open residual。 |
| `nit` | 最低档：风格、命名偏好、措辞、非行为文档笔误等；**轻于 `low`**。PM 判断无需跟踪时可不写入 `residual_findings`。 |

与 `review-harness.md` 的对应关系（摘要）：未解决的 **`critical`** 通常导致 `Request Changes`；**`high`** 常与「合并前须处理或显式拍板」同列；**`medium` / `low` / `nit`** 可作为带 residual 的跟踪项（具体 **Verdict** 以 PM 汇总为准）。

#### 4. QC 报告小节 → JSON 里写什么 `severity`

QC 报告模板见 `review-harness.md`。把 finding 登记进 **`metadata.residual_findings`** 时，按下表选择字段值：

| 报告 Findings 小节 | 写入 JSON 的 `severity` |
|--------------------|-------------------------|
| **Critical** | 默认 `critical`。若 PM 明确记录「本次不阻断但须尽快跟进」，可记 `high` 并在 `title`/`scope` 写清理由。 |
| **Warning** | `high` 或 `medium`：偏安全/正确性/数据 → `high`；其它实质性非阻断 → `medium`；**不确定时取 `high`**。 |
| **Suggestion** | `low` 或 `nit`：有实质改进 → `low`；纯风格/可有可无 → `nit`。 |

**易错点**：报告里的 **Warning** 不是合法 `severity` 字符串；合法值里**没有** `warning`（见第 5 节历史兼容）。

#### 5. 历史数据中的 `"severity": "warning"`

旧 JSON 若出现 **`"severity": "warning"`**：读取、汇总、`tech_debt_summary` 统计时**一律视为 `low`**。**禁止**在新条目中使用该值。

---

- 每条 `plans[]` 可带 **`metadata` 对象**（可选）；见下表 **标准可选字段**。无扩展需求时可省略该键或置 `{}`。
- 初始化时若尚无 findings，使用 `"metadata": { "residual_findings": {} }`。**程序时间线**请用可选 **`{PLAN_DIR}/notes.json`**（见下文专节），**勿**在 `status.json` 根级 `metadata` 中长期堆 `notes` 数组（遗留仓库若已有 `metadata.notes`，可择机迁出后删键）。
- **`plans[].id`** 与 **`metadata.residual_findings`** 的键应对齐（同一 `plan-id`），便于 `jq` 与报告目录 `reports/<plan-id>/` 一致。**不要**再存 `residual_findings_plan_id`（与 `id` 重复）。
- **`metadata.residual_findings` 空键**：某 `plan-id` 下**已无 open 条目**时，应从 **`metadata.residual_findings`** 中 **删除该键**（勿保留 `"plan-id": []` 空数组），减少噪声与误读。**注意**：这仅指 residual 映射对象上的键；**`plans[]` 是否仍保留该 plan 行**由团队决定（Done 瘦行、冷快照与「滚动保留」见下文），二者独立。
- **`residual_summary`（可选）**：单行人类可读摘要；**仅描述仍留在** `metadata.residual_findings[<plan-id>]` **中的 open 项**（已关闭项应在 `archived/residuals/` 与可选 **`notes.json`** 中体现）。

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
2. 从 **`metadata.residual_findings[<plan-id>]`** 数组中 **删除**该条（主列表**只保留 open**）。若删除后该数组为空，**删除** **`metadata.residual_findings`** 下的该 **`plan-id` 键**（见上文「空键」约定）。
3. 更新根级 **`updated_at`**；可选在 **`{PLAN_DIR}/notes.json`** 追加一条里程碑（**优先**于根级 `metadata.notes`，见「`notes.json`」专节）。

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
| `notes` | array | **遗留/不推荐**：曾用于程序级时间线；**新仓库请用** **`{PLAN_DIR}/notes.json`**，以免 `status.json` 随日志变长。若仍存在，可与 `notes.json` 并存直至迁出 |
| `residual_findings_history` | object | **遗留/不推荐**：同型剪切区；**新归档请用** `{PLAN_DIR}/archived/residuals/<plan-id>.json` |
| `tech_debt_summary` | object | **可选**：技术债**一览/rollup**，与 **`residual_findings` 互补**（见下专节）；由 **@project-manager** 维护 |

### `{PLAN_DIR}/notes.json`（可选·程序时间线）

**定位**：**追加型**程序日志，记录合并收口、批量归档、`tech_debt_summary` 刷新等里程碑，**不**与 **`plans[].status` / open residual** 争 SSOT；目的是让 **`status.json` 保持短小**、仍可被 agent 按路径单独读取。

**推荐结构**（字段可按项目增减）：

```json
{
  "schema_version": 1,
  "updated_at": "YYYY-MM-DD",
  "entries": [
    {
      "at": "2026-04-08",
      "message": "Short milestone description",
      "plan_id": "01-data-infrastructure"
    }
  ]
}
```

- **`entries`**：**按时间追加**；`plan_id` 可选（跨 plan 事件可省略或写多个说明在 `message` 内）。
- **`updated_at`**：建议与**最后一条** `entries[].at` 同步，便于扫读。
- **维护**：**@project-manager**（与写回 `status.json` 同权限节奏）。**禁止**为「改历史叙述」而重写已提交条目正文；更正走**新 `entries` 条**说明勘误。
- **与 `plans[].notes`**：`plans[].notes` 仍是**单条计划**的短字符串（可选）；本文件承载**跨计划 / 跨里程碑**的日志，二者不重复长文。

### `metadata.tech_debt_summary`（可选·技术债一览）

**定位**：在 **`metadata.residual_findings`**（按 `plan-id` 分列的 **open** R#）之上，提供**跨 plan 的聚合视图**，便于路线图、排期与「还有多少 open」一眼扫读。**不替代**单条 R# 的权威字段；新增/关闭 R# 时仍以 `residual_findings` 与 `archived/residuals/` 为准。

**维护**：**@project-manager** 在重大里程碑后更新（例如 QC 波次结束、批量归档 resolved、版本封板前）。可选在 **`notes.json`** 记一条「已刷新 `tech_debt_summary`」。

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
      "nit": 1
    },
    "by_target": {
      "V1.0": 5,
      "V1.1": 18
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

- **`total_open` / `by_*`**：应与当前 **`metadata.residual_findings`** 中所有 **open**（未归档）条目的数量与严重度**大致一致**；若有意的「跨 plan 合并视角」导致计数口径不同，在 **`notes.json`** 或 `cross_cutting` 中说明。
- **`by_plan`**：键可为 **短标签** 或 **`plans[].id` 前缀**，与仓库约定一致即可。
- **`cross_cutting`**：用于**跨多 plan / 多条 R#** 的主题债（架构层、重复实现等）；**`relates_to`** 列出对应 **`id`**（与 `residual_findings` 内 R# 对齐），避免与单条 R# 重复叙述时可只在此处保留总述。

### 可选：`Done` 计划行冷快照（`{PLAN_DIR}/archived/plans/`）与 `status.json` 瘦身

**背景**：多条 `Done` 的 `plans[]` 行常带大块 `metadata`（`gates`、QC 摘要、`tests`、`commits`、长 `scope`/`description`），`status.json` 会无限膨胀；而 **`metadata.residual_findings` 中 open 项**宜保持有界（已关闭项应迁出至 `archived/residuals/`，见上文）。

**定位**：根 `status.json` 仍为**当前执行**的 SSOT（非终态计划、根 `metadata`、**open** 的 `residual_findings`）。本节为**可选**做法：在**不破坏可到达性**（快照文件须提交进仓库）的前提下给热文件瘦身。

**冷存储路径**：`{PLAN_DIR}/archived/plans/<plan-id>.json`

**快照内容**：将该 plan 标为 `Done` 时，**完整的**对应 `plans[]` 元素（含当时全部 `metadata`），供审计与 handoff。

**与 residual 归档的关系**：`archived/residuals/<plan-id>.json` 存**已关闭 finding 行**；`archived/plans/<plan-id>.json` 存**计划行快照**。不要把计划快照当作 **open** `residual_findings` 的第二份权威来源。

**Profile A（默认）— 热文件保留瘦 `Done` 行**：

- **最小集**（机器导航够用）：**`id`**、**`status`**（`Done`）、**`file`**（主 plan 路径）、**`metadata`** 仅含：
  - **`archived_record`**：相对 `{PLAN_DIR}` 的路径，例如 `archived/plans/<plan-id>.json`（冷快照内为**完整**当时 `plans[]` 元素，含臃肿字段）
  - 若该 `plan-id` 在 **`metadata.residual_findings`** 中仍有 **open** 行，在 **`metadata`** 内保留 **`residual_summary`**（语义见上文 **`residual_summary`（可选）** 小节）
- **可选**（人类扫表友好，非必须）：**`title`** 一行、**`done_at`**；勿把长叙述塞回热行——放进 **`notes.json`** 或依赖冷快照 / `reports/`。
- 一旦快照已写入，热行**不得**再承载完整 `gates`、`qc_status`、`tests`、`commits`、长 `description`/`scope` 等；**以 `archived_record` 指向文件为准**。
- 单条 **`plans[].notes`** 字符串若仍在用，保持**极短**（如指向 `reports/<plan-id>/`）；**不要**重复 QC 报告大段原文。

**Profile B（可选）— 热文件不保留任何 `Done` 行（统一压缩）**：

- **Done 快照路径**：`{PLAN_DIR}/archived/plans/<plan-id>.json`（保存完整 `plans[]` 行快照）。
- **Done 目录路径**：`{PLAN_DIR}/archived/plans-done.json`（最小索引，便于统一发现已完成计划）。
- **`plans-done.json` 推荐最小字段**：`id`、`title`、`done_at`、`plan_file`、`archived_record`。
- **热文件行为**：`status.json.plans[]` 只保留非 `Done`（`Todo` / `InProgress` / `InReview` / `Blocked`）；计划变为 `Done` 后，从热文件移除该行。
- **读取约定**：当前执行状态读取 `status.json`；历史 `Done` 列表读取 `archived/plans-done.json`，详情读取 `archived/plans/<plan-id>.json`。

**原子更新约束（Profile A / B 通用）**：

- 将计划标记为 `Done` 时，冷快照写入与 `status.json` 更新应在**同一变更集**完成（或紧随合并后一次性完成）。
- 采用 **Profile B** 时，必须在同一变更集中同时完成：  
  1) 写入/更新 `archived/plans/<plan-id>.json`，  
  2) 写入/更新 `archived/plans-done.json`，  
  3) 从 `status.json.plans[]` 删除该 `Done` 行。  
- 若无法满足以上三步，视为未完成 `Done` 收口，不应宣称已完成压缩迁移。

**可选索引**：`{PLAN_DIR}/archived/plans/_index.json` — `plan-id` → 相对路径，便于不依赖 glob 的工具。

**可选滚动保留**：进一步缩小 `plans[]` 时，可只在热文件中保留**最近窗口**的瘦 `Done` 行，更旧 id 仅出现在 `_index.json` 与快照文件中；若采用，须在项目 `AGENTS.md` 中写明，并检查依赖「热文件中必有全部历史 id」的脚本。

**采纳说明**：

- 未写快照、热文件中仍保留完整 `Done` 行在历史仓库里依然可读；但新落地时建议先确定并固定使用 **Profile A** 或 **Profile B**，避免同仓混跑。
- 从 Profile A 迁到 Profile B 前，先检查依赖 `status.json.plans[]` 扫描全部历史 `Done` 的脚本与流程，必要时先切换读取源到 `archived/plans-done.json`。

**仓库级采用声明模板（贴到项目 `AGENTS.md`）**：

- **Template A（默认，保留瘦 Done 行）**

```markdown
### Plan compaction profile (this repository)

This repository uses **Profile A** from `~/.config/opencode/docs/agents/plan-convention.md`.

- `status.json.plans[]` keeps active plans and may keep **slim `Done` rows**.
- `archived/plans/<plan-id>.json` is used as cold snapshot when available.
- Historical tooling may read both `status.json.plans[]` and `archived/plans/`.
```

- **Template B（统一压缩，不保留 Done 行）**

```markdown
### Plan compaction profile (this repository)

This repository uses **Profile B** from `~/.config/opencode/docs/agents/plan-convention.md`.

- `status.json.plans[]` keeps **non-`Done`** plans only.
- Every `Done` plan MUST be represented in:
  - `archived/plans/<plan-id>.json` (full snapshot), and
  - `archived/plans-done.json` (minimal catalog).
- Historical `Done` discovery MUST read `archived/plans-done.json`, not `status.json.plans[]`.
```

### 合并前：`status.json` 须反映事实（建议门禁）

在合并关闭计划相关工作的分支或打开 PR 前，**@project-manager**（或项目约定角色）宜核对：`plans[].status`、`plans[].metadata.gates`（若热行仍保留）、**`metadata.residual_findings`**、**`metadata.tech_debt_summary`**（若使用）、**`notes.json`**（若使用）与审查结论、CI/测试结果一致。**SSOT 与事实不一致时，不宜视为可合并**，应先修正。

**常见疏漏**（与业务无关的通用项）：

- 关闭或新增 R# 后 **`tech_debt_summary` 未刷新**（`total_open`、`by_severity` 与 open 列表脱节）。
- 仅在 **`plans[].notes`** 或对话中描述 finding，**未**写入 **`metadata.residual_findings[<plan-id>]`**（open 条目的权威位置）。
- 团队若用 **`notes.json`**（或遗留 **`metadata.notes`**）作程序时间线：重大合并或批量归档后**未**追加条目，导致后续 agent 缺少上下文。

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

### QC 分报告与 consolidated：可否只留一份？

- **不要删除** `<plan-id>-qc1.md`、`-qc2.md`、`-qc3.md`**只因为**已写入 `<plan-id>-qc-consolidated.md`。`reports/` 在此约定下是**只读历史 / 审计链**：分 reviewer 原文保留**证据出处、分歧与独立视角**；**consolidated** 是 PM 的**门控摘要**，二者**叠加**，**不互为替代**。
- **极窄例外**（须团队显式采纳并承担审计缺口）：例如仓库体积极敏感时，仅保留 consolidated + 指向外部归档的链接——**不在**本默认 harness 中推荐；默认仍保留三份 `-qc*.md`。

### Residual findings（R#）：权威在哪、和主 plan 谁先谁后？

- **Open 条目的单一事实来源（SSOT）**是 **`{PLAN_DIR}/status.json`** → **`metadata.residual_findings[<plan-id>]`**（字段结构见上文 JSON 示例）。跨会话 handoff、关闭与归档流程**以该数组为准**。
- **推荐操作顺序**（避免 plan 与 JSON 两套 ID 漂移）：
  1. @project-manager 读完三份 QC 报告并完成「QC 三审轻量汇总」：对 finding **去重合并**，为每条待跟踪项分配**稳定 `id`**（如 `R1`、`R2`，全 plan 内唯一）。
  2. **立即**将上述条目写入 **`metadata.residual_findings[<plan-id>]`**（含 `source` 指向哪位 QC / 哪份报告文件名，便于回溯）。
  3. **可选**：在主 plan 中增加 **「Residual findings（索引）」** 小节，**仅复述** `id` + 短标题 + 决策摘要，并写明「**权威列表见** `status.json` → `metadata.residual_findings[<plan-id>]`」。**不要**只在主 plan 里「发明」R# 而不写回 SSOT。
- **不要**反过来把主 plan 当作唯一登记处：若仅更新 plan、`status.json` 未同步，下一任 agent **无法**依赖 SSOT 继承债务状态。

### QC 三审触发时机（单 plan · 多 batch）

- **默认（推荐）**：同一 **`plan_id`** 下，**完整 QC 三审**（`qc1` + `qc2` + `qc3` 并行）**仅在 dev team 按该 plan 约定范围全部交付之后**执行**一次**，再进入 @project-manager 汇总与 @qa-engineer 验证。**不要**在每个中间 **batch** / 子里程碑都跑全套三审：否则 `reports/<plan-id>/` 会堆积多套并列报告，**`Review range` / `Diff basis` 与结论**易混淆，handoff 成本高。
- **batch 之间**：依赖实现方 **`verification-before-completion`**、主 plan 任务勾选与 PM 协调；需要书面中间意见时，用对话、主 plan 批注或**非三审**的定向检查（如单审、架构 review），**不**默认等同「又一轮完整三审」。
- **Request Changes 后复验**：若须再跑一轮完整三审，使用**新文件名**落盘，避免覆盖首轮报告，例如 `<plan-id>-qc1-rev2.md` … `<plan-id>-qc3-rev2.md`（或团队约定的 `wave2-` 前缀）；@project-manager 在 `QC Consolidated Decision` 中写明**当前以哪一波次为准**。
- **显式例外**：仅当用户与 PM 书面同意**中间门禁**时，在 Assignment 写清 **`QC gate: incremental — <scope>`**（或等价），并仍须保证该次三审的 **`plan_id` + `Review range` / `Diff basis`** 三份一致；**优先**用子范围专用标签或子目录，避免与「整 plan 终局」那套 `-qc*.md` 混名。
- **同仓多 worktree 并行 dev**：**推荐**在排各 batch / 各轨 worktree 前确立 **plan 集成分支** 与各轨 topic 线及 **merge 靶**（见 `harness-loop.md` **「推荐默认编排：先建 plan 集成分支，再挂各 worktree」**）。终局（或增量）三审派单前，PM 仍须满足 **单一待审 `Working branch` / `HEAD`** 或已按上条 **拆 scope**；**不得**假设「整 plan 一次三审」可只靠某一个开发 worktree 路径覆盖未合并的其他并行轨。见同文件 **「多 worktree 并行开发与 QC / QA 的门禁衔接」** 全文。

**QC 落盘与宿主权限**：`@qc-specialist` / `@qc-specialist-2` / `@qc-specialist-3` 在支持路径白名单的宿主上（如 OpenCode 的 **`permission.edit`**），**仅可** Write/Edit **`{PLAN_DIR}/reports/`** 下 **`.md`**（全局 agent 提示词中已配置 `.agents/plans/reports/**`、`.plans/reports/**`、`plans/reports/**` 相对路径）。报告文件**必须**以 YAML **frontmatter** 开头（键见各 QC agent 提示词）。**若** 项目的 `{PLAN_DIR}` 不落在上述三种根下，须在**项目级**宿主配置（如 OpenCode）中为 QC 角色追加对应的 `edit` allow 规则。

**QC 报告与 Git**：报告落盘后，各 QC 角色须在业务仓内对**本次报告文件**执行 **`git add` + `git commit`**（细则与 bash 权限见 `agents/qc-specialist*.md`）；**禁止**仅落盘不提交导致 `clone` 后不可见。**PM / architect / product-manager** 对 `{PLAN_DIR}` 与主 plan 的创建与更新亦须在业务仓内 **commit**（见 `agents/project-manager.md` Plan 初始化与 PM 职责、`agents/architect.md` / `agents/product-manager.md` Git 小节）。

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
