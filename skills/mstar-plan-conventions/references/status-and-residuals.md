# `{HARNESS_DIR}/status.json` 与 Residual Findings（Morning Star）

`status.json` 位于 **`{HARNESS_DIR}/status.json`**，是 **`plans[]` 行状态**与 **仍处 `open` 的 residual findings** 的**单一事实来源（SSOT）**。  
**已关闭**的 residual **不应长期堆在**本文件中；权威档案见 **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**（见「Residual findings 生命周期」）。

**编排语义（为何不是「多写几个字」）**：open 列表与 `archived/residuals/` 是跨会话、跨 agent 的**风险与决策交接面**。若非阻断结论只留在对话或单次 QC 报告里、**不进 SSOT**，下一任实现/审查方**无法可靠继承**已 defer、已风险接受或待跟进的约定；`Done` 也会与「已知债是否对仓库可见」**脱钩**，复盘或线上问题时常出现**无单一事实可引用**。因此 **`@project-manager`** 宜在审查收口后尽快把应跟踪项**登记为 open**；**`@qa-engineer`** 与 PM 宜在验证或豁免决策明确后**及时关闭并归档**——节奏可按里程碑灵活安排，但**不应默认「口头说过即可」**。

## 基本结构

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
          "tracking": "Issue URL or null",
          "detail_doc": "{PLAN_DIR}/residuals/plan-id/R1-short-label.md"
        }
      ]
    }
  }
}
```

**已关闭条目**在以上字段之外补充：`lifecycle`、`closed_at`、`closure_note`；可选 `closure_evidence`、`superseded_by`。语义见下「Residual findings 生命周期」。

**Open 条目可选 `detail_doc`**：仓库内相对路径，指向 **`{PLAN_DIR}/residuals/<plan-id>/`** 下与该条 **`id`**（如 `R1`）配套的散文 `.md`（若启用散文层，见 `knowledge-and-designs.md`）；未使用散文层则**省略**该键。

## Residual findings：severity（SSOT，机器字段）

`metadata.residual_findings[<plan-id>][]` 里每条记录的 **`severity`** 只能是本节定义的枚举值。QC 报告 Markdown 里的 **Critical / Warning / Suggestion** 是**章节标题**，**不得**原样当作 JSON 里的 `severity`（二者关系见下表）。

### 1. 允许取值

仅此五种，**必须小写英文**：

`critical`、`high`、`medium`、`low`、`nit`

### 2. 全序（从重到轻）

`critical` ＞ `high` ＞ `medium` ＞ `low` ＞ `nit`

- **`nit` 恒轻于 `low`**，禁止把两档颠倒或等同。
- **禁止**把 `severity` 写成 `warning`、`Major`、中文或其它未列出的字符串。

### 3. 各档含义与门禁关系

| `severity` | 含义要点 |
|------------|----------|
| `critical` | 合并阻断级；与 QC 报告 **Critical** findings 对应。 |
| `high` | 非阻断但影响大（安全、正确性、数据、显著技术债）；须修复、显式升级决策，或 open residual 并由 PM 明确跟进。 |
| `medium` | 当前或下一里程碑应处理；可 open residual。 |
| `low` | 影响面小、修复成本低；可 open residual。 |
| `nit` | 最低档：风格、命名偏好、措辞、非行为文档笔误等；**轻于 `low`**。PM 判断无需跟踪时可不写入 `residual_findings`。 |

与 `mstar-review-qc` 的对应关系（摘要）：未解决的 **`critical`** 通常导致 `Request Changes`；**`high`** 常与「合并前须处理或显式拍板」同列；**`medium` / `low` / `nit`** 可作为带 residual 的跟踪项（具体 **Verdict** 以 PM 汇总为准）。

### 4. QC 报告小节 → JSON 里写什么 `severity`

QC 报告模板见 `mstar-review-qc`。把 finding 登记进 **`metadata.residual_findings`** 时，按下表选择字段值：

| 报告 Findings 小节 | 写入 JSON 的 `severity` |
|--------------------|-------------------------|
| **Critical** | 默认 `critical`。若 PM 明确记录「本次不阻断但须尽快跟进」，可记 `high` 并在 `title`/`scope` 写清理由。 |
| **Warning** | `high` 或 `medium`：偏安全/正确性/数据 → `high`；其它实质性非阻断 → `medium`；**不确定时取 `high`**。 |
| **Suggestion** | `low` 或 `nit`：有实质改进 → `low`；纯风格/可有可无 → `nit`。 |

**易错点**：报告里的 **Warning** 不是合法 `severity` 字符串；合法值里**没有** `warning`（见第 5 节历史兼容）。

### 5. 历史数据中的 `"severity": "warning"`

旧 JSON 若出现 **`"severity": "warning"`**：读取、汇总、`tech_debt_summary` 统计时**一律视为 `low`**。**禁止**在新条目中使用该值。

---

## `plans[].metadata` 标准可选字段

与业务仓库实践对齐的推荐键（均为可选；项目可只选子集）：

| 键 | 类型 | 用途 |
|----|------|------|
| `working_branch` | string | 本 plan 实现所用分支名，与 Assignment **`Working branch`** 对齐（SSOT） |
| `merge_target` | string | 预期合并目标分支（如 `main`）；默认分支以项目约定为准 |
| `branch_policy` | string | 与 `mstar-harness-core` 一致的一行策略说明（如 `direct on main — <reason>` 或 `create feature/x from main`） |
| `phase` | string | 程序/路线图阶段标签（如 `Phase 0`、`v1.0`） |
| `priority` | `high` \| `medium` \| `low` | PM 编排优先级 |
| `description` / `scope` | string | 一句话范围或目标；**同一仓库内择一**为主，避免两键长期混填不同内容 |
| `gates` | object | 门禁结果摘要；**推荐子键**（按需）：`qc`、`qa`、`typecheck`、`tests`、`lint`… 值为短字符串（如 `PASS (…)`、`FAIL — see report`） |
| `blocked_since` | `YYYY-MM-DD` | 当 `status` 为 `Blocked` 时建议填写 |
| `blocked_reason` | string | 阻塞原因（可与顶层 `notes` 互引，metadata 便于机器过滤） |
| `blocked_by_plan_id` | string | 若阻塞来自另一计划，填对方 **`plans[].id`** |
| `dependency` | string | 其它依赖说明（接口、外部团队）；与 `blocked_by_plan_id` 互补 |
| `next_action` | string | 当前解锁后或审查后的下一步（给谁、做什么） |
| `primary_spec` | string | 主规格/设计文档路径（仓库内相对路径；**常为** `{HARNESS_DIR}/knowledge/...` 或 `{HARNESS_DIR}/designs/...`）；多文档可用 `spec_refs`（string[]） |
| `qc_status` / `tests` / `commits` | string | **InReview / Done** 前后的可验证快照（结论摘要、测试统计、commit 提示），**非**替代正式报告文件 |

## 根级 `metadata` 标准可选字段

除 **`residual_findings`**（SSOT）外，推荐可选：

| 键 | 类型 | 用途 |
|----|------|------|
| `versioning` | object | 跨 plan 约定，如 `phase_1_branch_prefix`、`release` 等（自由键，团队自定） |
| `notes` | array | **遗留/不推荐**：曾用于程序级时间线；**新仓库请用** **`{HARNESS_DIR}/notes.json`**，以免 `status.json` 随日志变长。若仍存在，可与 `notes.json` 并存直至迁出 |
| `residual_findings_history` | object | **遗留/不推荐**：同型剪切区；**新归档请用** `{HARNESS_DIR}/archived/residuals/<plan-id>.json` |
| `tech_debt_summary` | object | **可选**：技术债**一览/rollup**，与 **`residual_findings` 互补**（见下专节）；由 **`@project-manager`** 维护 |

## 通用约束

- 每条 `plans[]` 可带 **`metadata` 对象**（可选）。无扩展需求时可省略该键或置 `{}`。
- 初始化时若尚无 findings，使用 `"metadata": { "residual_findings": {} }`。**程序时间线**请用可选 **`{HARNESS_DIR}/notes.json`**（见下），**勿**在 `status.json` 根级 `metadata` 中长期堆 `notes` 数组（遗留仓库若已有 `metadata.notes`，可择机迁出后删键）。
- **`plans[].id`** 与 **`metadata.residual_findings`** 的键应对齐（同一 `plan-id`），便于 `jq` 与报告目录 `reports/<plan-id>/` 一致。**不要**再存 `residual_findings_plan_id`（与 `id` 重复）。
- **`metadata.residual_findings` 空键**：某 `plan-id` 下**已无 open 条目**时，应从 **`metadata.residual_findings`** 中 **删除该键**（勿保留 `"plan-id": []` 空数组），减少噪声与误读。**注意**：这仅指 residual 映射对象上的键；**`plans[]` 是否仍保留该 plan 行**由团队决定（Done 瘦行、冷快照与「滚动保留」见 `done-compaction.md`），二者独立。
- **`residual_summary`（可选）**：单行人类可读摘要；**仅描述仍留在** `metadata.residual_findings[<plan-id>]` **中的 open 项**（已关闭项应在 **`{HARNESS_DIR}/archived/residuals/`** 与可选 **`{HARNESS_DIR}/notes.json`** 中体现）。

---

## Residual findings 生命周期（关闭、归档、移除）

本节约定技术债条目在**已修复、已豁免、被替代或误登**之后如何更新 JSON，与「登记」流程闭环。

### 条目状态 `lifecycle`（可选，默认视为 open）

| `lifecycle` | 含义 | 关闭时 `closure_note` 应说明 |
|---------------|------|------------------------------|
| `open` | 未关闭（**省略该字段时按 open 处理**，兼容旧数据） | — |
| `resolved` | 已在代码/配置/文档中解决，且**已验证** | 改了什么、如何验证（可与 `closure_evidence` 互指） |
| `waived` | 经明确决策**不修复**（承担风险或产品接受） | 谁决策、为何不修、是否登记 `tracking` Issue |
| `superseded` | 被新 finding、新规格或重构方案取代 | 指向 `superseded_by`（另一条 `id` 或知识库路径） |
| `duplicate` | 重复录入或与另一 R# 实质相同 | 指向 canonical 的 `id` 或说明误登 |

**关闭必填**：凡 `lifecycle` 为 `resolved` / `waived` / `superseded` / `duplicate`，须填写 **`closed_at`**（`YYYY-MM-DD`）与 **`closure_note`**（一句即可）。**推荐**填写 **`closure_evidence`**（PR、commit、测试结果、文档锚点），以满足可审计与 `verification-before-completion` 一致。

### 谁更新、何时更新

| 动作 | 建议负责方 | 时机 |
|------|------------|------|
| 实现修复 | `@fullstack-dev` / 对应 owner | Completion Report 中说明对应 R# 与证据 |
| 验证 | `@qa-engineer` | 回归或验收中确认 R# 已满足 |
| 写回 `status.json` | **`@project-manager`** 或 **`@qa-engineer`**（与 Done 收口权限一致） | 验证通过后同一提交或紧随其后；豁免/替代由 PM 与用户或架构对齐后写回 |

**不得**在未落盘的情况下，仅从对话或主 plan 文案中宣称「R3 已修」而不更新 SSOT。

**对 `@project-manager` / `@qa-engineer` 的预期（可灵活，须诚实）**：PM 在 **`Approve with residuals`** 或 consolidated QC 后**主动补齐** open 登记（或与 QC 报告交叉引用且 SSOT 中可追溯）；QA 在验收叙述中**显式交代**每条相关 R#（仍 open / 本次已验证 resolved / 需 PM 与用户裁决豁免），避免「只写测试通过」而 SSOT 与报告对不上。长期 open 与已关闭双写、或主列表与归档文件**长期不一致**，会削弱 handoff 可信度，应在本里程碑内收敛。

### 推荐策略：关闭后迁入 `archived/residuals/<plan-id>.json`（控制 `status.json` 体积）

为避免 **`status.json` 随已关闭 R# 无限膨胀**，在 **`closed_at` / `closure_note`（及推荐 `closure_evidence`）已齐备** 且 **`@qa-engineer`** 或 **`@project-manager`** 已确认可关闭后：

1. **追加**到 **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**（文件名与 **`plans[].id`** 一致；遗留同目录布局下全路径可能为 **`plans/archived/residuals/<plan-id>.json`** 等，视解析结果而定）。
2. 从 **`metadata.residual_findings[<plan-id>]`** 数组中 **删除**该条（主列表**只保留 open**）。若删除后该数组为空，**删除** **`metadata.residual_findings`** 下的该 **`plan-id` 键**（见上文「空键」约定）。
3. 更新根级 **`updated_at`**；可选在 **`{HARNESS_DIR}/notes.json`** 追加一条里程碑（**优先**于根级 `metadata.notes`，见「`notes.json`」专节）。

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

### 临时原位关闭（仅短过渡）

在写入归档文件**之前**，可先在 `metadata.residual_findings` 内补全 `lifecycle` / `closed_*`（便于同一次 PR 内 diff）；**应在同一里程碑内**完成「迁入 **`{HARNESS_DIR}/archived/residuals/`** + 从主列表删除」，避免长期双写。

### 遗留：`metadata.residual_findings_history`（不推荐）

根级 **`residual_findings_history`** 曾用于在单文件内剪切已关闭项；**新仓库请优先**使用 **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**，以免 `status.json` 仍随历史变长。若仓库已存在 `residual_findings_history`，可由 **`@project-manager`** 择机迁到 **`{HARNESS_DIR}/archived/residuals/`** 后删除该键。

### 移除（硬删除）

- **禁止**对 **`open`** 条目从 `status.json` **硬删**。
- 已归档条目**不要**从 `archived/residuals/*.json` **删除**；错关时追加更正说明条目或新开 R# 引用原 `id`。
- 仅**误登且未进入任何留档**时，经 **`@project-manager`** 可从 `residual_findings` 删除；更稳妥为标 **`duplicate`** 后走关闭归档流程。

### 查询 open 项与已归档（示例）

```bash
jq '.metadata.residual_findings["01-data-infrastructure"]' .agents/status.json
jq '.entries[] | select(.id == "R1")' .agents/archived/residuals/01-data-infrastructure.json
jq '.metadata.tech_debt_summary' .agents/status.json
```

---

## `{HARNESS_DIR}/notes.json`（可选·程序时间线）

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
- **维护**：**`@project-manager`**（与写回 `status.json` 同权限节奏）。**禁止**为「改历史叙述」而重写已提交条目正文；更正走**新 `entries` 条**说明勘误。
- **与 `plans[].notes`**：`plans[].notes` 仍是**单条计划**的短字符串（可选）；本文件承载**跨计划 / 跨里程碑**的日志，二者不重复长文。

---

## `metadata.tech_debt_summary`（可选·技术债一览）

**定位**：在 **`metadata.residual_findings`**（按 `plan-id` 分列的 **open** R#）之上，提供**跨 plan 的聚合视图**，便于路线图、排期与「还有多少 open」一眼扫读。**不替代**单条 R# 的权威字段；新增/关闭 R# 时仍以 `residual_findings` 与 **`{HARNESS_DIR}/archived/residuals/`** 为准。

**维护**：**`@project-manager`** 在重大里程碑后更新（例如 QC 波次结束、批量归档 resolved、版本封板前）。可选在 **`{HARNESS_DIR}/notes.json`** 记一条「已刷新 `tech_debt_summary`」。

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

- **`total_open` / `by_*`**：应与当前 **`metadata.residual_findings`** 中所有 **open**（未归档）条目的数量与严重度**大致一致**；若有意的「跨 plan 合并视角」导致计数口径不同，在 **`{HARNESS_DIR}/notes.json`** 或 `cross_cutting` 中说明。
- **`by_plan`**：键可为 **短标签** 或 **`plans[].id` 前缀**，与仓库约定一致即可。
- **`cross_cutting`**：用于**跨多 plan / 多条 R#** 的主题债（架构层、重复实现等）；**`relates_to`** 列出对应 **`id`**（与 `residual_findings` 内 R# 对齐），避免与单条 R# 重复叙述时可只在此处保留总述。

---

## 合并前：`status.json` 须反映事实（建议门禁）

在合并关闭计划相关工作的分支或打开 PR 前，**`@project-manager`**（或项目约定角色）宜核对：`plans[].status`、`plans[].metadata.gates`（若热行仍保留）、**`metadata.residual_findings`**、**`metadata.tech_debt_summary`**（若使用）、**`{HARNESS_DIR}/notes.json`**（若使用）与审查结论、CI/测试结果一致。**SSOT 与事实不一致时，不宜视为可合并**，应先修正。

**常见疏漏**（与业务无关的通用项）：

- 关闭或新增 R# 后 **`tech_debt_summary` 未刷新**（`total_open`、`by_severity` 与 open 列表脱节）。
- 仅在 **`plans[].notes`** 或对话中描述 finding，**未**写入 **`metadata.residual_findings[<plan-id>]`**（open 条目的权威位置）。
- 团队若用 **`notes.json`**（或遗留 **`metadata.notes`**）作程序时间线：重大合并或批量归档后**未**追加条目，导致后续 agent 缺少上下文。

## 常用查询示例

```bash
# Replace .agents with your resolved {HARNESS_DIR} if different.
jq '.plans[] | select(.id == "01-data-infrastructure")' .agents/status.json
jq '.metadata.residual_findings["01-data-infrastructure"]' .agents/status.json
```
