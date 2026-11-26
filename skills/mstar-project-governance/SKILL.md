---
name: mstar-project-governance
description: 项目治理：milestone 结构化目标与 issue 关联、issue capture、portable 项目身份与 `_default` 归属。
---

# mstar-project-governance（项目治理层：milestones + issues + portable identity）

## Load Order

- 先 Read **`mstar-harness-core`**（SKILL.md；冲突时以 core 为准）。
- 路径符号（`{PROJECT_DIR}` / `{WORKFLOW_DIR}` 解析与 `.mstarc` 声明）→ **`mstar-conventions`**。
- 字段语义 SSOT（severity 含义、findings cleanup modes、close 协议全文、engine-check 查询）→ **`mstar-artifacts`**（`mstar-artifacts/references/status-and-residuals.md`）。本 skill 只承载**编写约定与生命周期规则**，不重复字段全文。

## Scope

项目层 = `{PROJECT_DIR}/<id>/`（默认 `{HARNESS_DIR}/projects/<id>/`；`.mstarc` `project_dir` 声明时用声明值）：

| 文件 | 内容 |
|------|------|
| `residuals.json` | Migration history only. Open items are store issues (→ § Issue capture); retain the file as a contract §7 migration-mapping source. |
| `references/` | 主题化研究语料（surveys / epic 备注 / 第三方 notes）。与 `{SPECS_DIR}`（冻结规格/ADR）、`{KNOWLEDGE_DIR}`（compound 结晶实现 SSOT）、`{ITERATION_DIR}`（迭代 package）**不同**；engine 只列文件名（`listProjectReferenceFiles`），**不做** markdown schema 校验 |

- **`_default` 回退**：无项目流程（未指定 project id 的 plan / 单 plan / hotfix）落到 **`projects/_default/`**（engine `_DEFAULT_PROJECT`）。项目归属由 plan 的 project id 决定；未归属即 `_default`。
- catalog 存项目身份与路径；项目的结构化目标与 issue 关联的权威是 collaboration 存储的 milestone 记录与 issue（→ 下两节），不写文件正文权威。

## Milestone（结构化路线目标）

- **唯一机制**：项目路线的结构化目标是 collaboration 存储的 milestone 记录 + `issues.milestone_id` 关联——milestone 行在 user-level collaboration 库（`<user home>/.mstar/repos/<host>/<owner>/<repo>/collaboration.db`，以 `mstar path resolve` 输出的 `dbPath` 为准）的 `project_milestones` 表，local / mirror / remote 三种模式同一落点、无模式分支，不在 `{HARNESS_DIR}/store.db`；local 与 mirror 下该库即权威，remote 下权威是 bound provider、该库是可重建的 observation。`mstar milestone add | update` 写元数据（name / effort_sessions / ordinal / status，CAS 于 store revision；`effort_sessions` 的估算口径与量表 → **`mstar-conventions/references/effort-estimation.md`**，本 skill 不复述）；`mstar milestone assign` 是 issue milestone 归属（`issues.milestone_id`）的唯一设置/变更面（同项目约束，explicit move / clear），授权与 `mstar issue` 直连写入一致：`--actor` 须为 `project-manager` 席位，并以 `--expect-issue` / `--expect-store` 对 issue 与 store revision 做 CAS（同一写事务内校验），不需要 workflow session，也不接受 `--session-id` / `--session-ref`；issue 自身的项目不对时，先用 `mstar issue move` 把它移到目标项目（重算 project-scoped identity；项目变更会清除 milestone 关联——`issues_milestone_project_update` 不允许保留异项目 milestone——被清除的 milestone id 记在 move 收据的 `clearedMilestoneId` 上）再 assign——两侧必须同项目；`list | status` 只读并给出 open / resolved / other-retired rollup。动词与标志以 `mstar milestone --help` 为准，本 skill 不复写。
- **交付判定**：`delivered` 的必要条件是至少一个关联 issue 且零 open（同事务校验）；交付只经显式状态变更，从不自动触发，也从不关闭 issue。retired（waived / duplicate / superseded）≠ resolved，rollup 分列展示，不把退役计成已完成工作。

## Issue capture（`{HARNESS_DIR}/store.db`）

**本节是 capture duty 的唯一权威**：下方两段是 issue-store contract §6 的规范文本（逐字）；其余 skill（`mstar-artifacts` / `mstar-audit` / `mstar-review-qc` / `mstar-audit/references/pr-review.md` / `mstar-harness-core`）只做指针引用，**不复述**本契约。引文中的 §4 / §7 指该契约的「Lifecycle and closure authority」与「Migration, activation and retirement」两节。

> A confirmed finding becomes an issue in `{HARNESS_DIR}/store.db` at the moment it is confirmed — before, and independently of, any decision to plan it. Capture records **evidence** (source identity, location, observed behaviour, discovery time) and never a disposition; **disposition is a separate authorized act** per §4. A recurrence of a confirmed finding **appends an occurrence** to the existing issue — deduplication is by source identity + root cause, never by title — and never opens a second issue. Issues are plan-independent: they exist before, during and after any plan; only the closure authorities in §4 retire one.

**授权（谁捕获）**

> The seat that owns the confirmed outcome captures it: the PM seat (dispatch/consolidation, QC tri, iteration close) and the main agent of a PR-review round at Stage 3 synthesis. Leaf audit/QC seats **return evidence and never write the store** (survey §7 step 4). Capture goes through the `mstar issue` verbs; flags live in `--help` and are never restated in skill texts.

- 计划内捕获走 `mstar plan issue-add`（仍在活跃 plan session 内），计划外确认发现走 `mstar issue add`；同一 finding 再次出现用 `mstar issue occurrence` 追加 occurrence —— **不**新开第二个 issue。所有 `mstar issue` 写动词（包括 `link`）均为 actor-only store write（`--actor` + `--operation-id`）；每个写入都要求 payload（`--payload` 或 `--file`），而 `triage`、终态处置和 `link` 的 row-CAS 均要求 `--expect`（缺失时 `issue.revision-conflict`）；具体选项以各命令组 `--help` 为准。
- **捕获 ≠ 处置**：关闭是独立授权动作，只由契约 §4 的关闭权威执行（`mstar issue close | waive | duplicate | supersede`，计划内 `mstar plan issue-close`）；捕获席位**不**自授关闭权。`mstar issue link` 的 plan/iteration target 作为来源标签记录，不做目标存在性校验。
- **激活边界**：store 接受普通捕获/查询、并作为唯一权威，以契约 §7 的 activation 完成为准 —— staged store 会被拒（`store.not-active`）。live 切换（apply → activate → retire）归 cutover plan 的授权 ops 任务，skill 文本不代替该门禁。
- issue 与 plan 解耦（plan 外的确认发现同样可捕获）；store 的路径与权威分界 → **`mstar-conventions`**。

Payload authoring: consult `mstar-harness schema CaptureInput` for `issue add`, `OccurrenceInput` for recurrence, `IssueTriage` for triage, `ClosureEvidence` for each terminal disposition, and `IssueLink` for provenance/relation links. The schema lists required and disposition-specific fields; the verb's help supplies flags. Prepare complete JSON from observed evidence before writing, never guess a minimal payload through successive refusal messages. The actor and intended operation are not derivable from the payload and remain explicit.

## Register 生命周期（`projects/<id>/residuals.json`）

> **本节的定位**：register 是**迁移历史**，open item 的 SSOT 是 **issue store**（→ 上文 § Issue capture）——`mstar status backlog-register` / `backlog-close` 已退役并指向 issue 动词。下面的字段与生命周期规则保留为契约 §7 的**迁移映射来源**（preview / apply / retire 按此把 register 行映射为 issue）。

### Historical register fields and closure

Register shape, required fields/enums, provenance and historical in-place closure → `references/migration-source-shapes.md`; this is a migration mapping, never a live writer.

Live capture and closure use § Issue capture and contract §4 closure authority; PM Acceptance owns verification/disposition for all plans, with specialist evidence as needed. Severity, cleanup and issue closure → **`mstar-artifacts`** `mstar-artifacts/references/status-and-residuals.md`; acceptance → **`mstar-roles/references/project-manager/acceptance.md`**.


### Findings cleanup（与 Assignment 联动）

- Assignment **`Findings cleanup: zero-residual | allow-residual`** 是唯一 mode 来源（`metadata.findings_cleanup` mirror 已删）；迭代 Phase 2 默认 `allow-residual`。
- `allow-residual`（默认）：仅 unresolved **critical** 阻止 Approve；离 InReview 前须把每条剩余 open finding 捕获为**本 plan 的 linked open issue**（machine-enum `severity`），并在各决策面披露（issue id + severity + 跟踪位置；close 面另含 blocker-defer 标记）—— 捕获与披露职责全文 → **`mstar-artifacts`**「Findings cleanup modes」。
- `zero-residual`（显式 opt-in）：可修 findings 当轮 fix → re-review 清干净；仅真 blocker 可 defer 且须 Durable Roadmap + `target`（`critical` 不属 defer —— 定义 → **`mstar-artifacts`**「Findings cleanup modes」）；`nit` 必须当场修或删；waived/risk-accepted 必须关闭，不得留 open。
- mode 全文与 enforcement → **`mstar-artifacts`** `mstar-artifacts/references/status-and-residuals.md`（「Findings cleanup modes」+ 其 engine check）。

## Workflow

1. 确定 catalog 项目归属（无项目 → `_default`）。
2. 路线目标：结构化目标建 milestone 并显式关联 issue（§ Milestone），不用文件 stub 表达状态。
3. 捕获 finding：走 § Issue capture 的 issue 动词（计划内 `mstar plan issue-add`，计划外 `mstar issue add`）；register 是迁移历史，**不再**是写入目标。
4. 关闭：由契约 §4 的关闭权威执行（`mstar issue close | waive | duplicate | supersede`，计划内 `mstar plan issue-close`）。
5. 汇总：`mstar status tech-debt` 打印 store 的 open-issue rollup（`total_open` / `by_severity` / `by_project`）。

## Decision Rules

- **Issue store only**: new captures write issues (→ § Issue capture); historical registers remain read-only and must never be dual-written.
- **fail-loud handoff**：捕获前必须过 engine 校验；malformed → reject + rewrite，绝不静默降级写入。
- **severity 是机器字段**：QC 报告的 Critical / Warning / Suggestion 是**章节标题**，不得逐字抄入 JSON `severity`。
- **`_default` 不豁免校验**：无项目流程同样走 issue store（`project_id = _default`），字段与关闭权威不变。

## Evidence

正确结果 = milestone 写入返回 receipt（同请求 replay 幂等、冲突/stale 拒绝且无变更），`mstar milestone list | status` 的 rollup 与 store 一致；register 迁移文档过 `validateProjectRegister`、`mstar status findings-cleanup <plan-id>` 按 Assignment mode 绿、`mstar status tech-debt` 输出与 store 的 open issues 一致。拒绝「仅对话声称」。

## References

- **`mstar-artifacts`**（`mstar-artifacts/references/status-and-residuals.md`）— 需要 severity/lifecycle 语义、findings cleanup mode 全文或 close 协议时打开；字段语义 SSOT：severity 含义与门禁关系、findings cleanup modes 全文、close 协议、engine-check 查询示例
- `references/migration-source-shapes.md` — 审查 `mstar store upgrade` 迁移映射、需要 historical register 形状与 closure 映射时打开；historical register shape, required fields/enums, provenance and closure mapping; no execution route or live writer
- **`mstar-conventions`** — `{PROJECT_DIR}` / `{WORKFLOW_DIR}` 路径符号、`.mstarc` 声明、gitignore 策略
- **`mstar-review-qc`** — PM QC 编排与 findings 捕获 / QC gate（PM 同轮必读）
