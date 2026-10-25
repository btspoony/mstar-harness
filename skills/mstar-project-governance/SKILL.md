---
name: mstar-project-governance
description: 项目治理：roadmap 内容在 `{HARNESS_DIR}/store.db` 的权威读写（import/export、revision-guarded replace）、milestone 结构化目标与 issue 关联、issue capture、`_default` 归属。
---

# mstar-project-governance（项目治理层：roadmap + register）

## Load Order

- 先 Read **`mstar-harness-core`**（SKILL.md；冲突时以 core 为准）。
- 路径符号（`{PROJECT_DIR}` / `{WORKFLOW_DIR}` 解析与 `.mstarc` 声明）→ **`mstar-conventions`**。
- 字段语义 SSOT（severity 含义、findings cleanup modes、close 协议全文、engine-check 查询）→ **`mstar-artifacts`**（`references/status-and-residuals.md`）。本 skill 只承载**编写约定与生命周期规则**，不重复字段全文。

## Scope

项目层 = `{PROJECT_DIR}/<id>/`（默认 `{HARNESS_DIR}/projects/<id>/`；`.mstarc` `project_dir` 声明时用声明值）：

| 文件 | 内容 |
|------|------|
| `roadmap.md` | 遗留文件 / Markdown import、export 候选与历史；不是项目 roadmap 的实时读写权威 |
| `residuals.json` | Migration history only; shape → **`mstar-engine-legacy`** `references/migration-source-shapes.md`. Open items are store issues (→ § Issue capture); retain the file as a contract §7 migration-mapping source. |
| `references/` | 主题化研究语料（surveys / epic 备注 / 第三方 notes）。与 `{SPECS_DIR}`（冻结规格/ADR）、`{KNOWLEDGE_DIR}`（compound 结晶实现 SSOT）、`{ITERATION_DIR}`（迭代 package）**不同**；engine 只列文件名（`listProjectReferenceFiles`），**不做** markdown schema 校验 |

- **`_default` 回退**：无项目流程（未指定 project id 的 plan / 单 plan / hotfix）落到 **`projects/_default/`**（engine `_DEFAULT_PROJECT`）。项目归属由 plan 的 project id 决定；未归属即 `_default`。
- Roadmap 正文的唯一权威是 `{HARNESS_DIR}/store.db` 中按 catalog project id 唯一定位的 `project_roadmaps` 记录；catalog 存项目身份与路径，不把文件路径或 Markdown 当正文权威。下述 frontmatter 与 body 约定仍由 engine 内容校验，读写/迁移走 roadmap 域边界。

## Roadmap 内容权威与编写约定

- **读**：先确定 catalog project id（未指定项目的流程使用 `_default`）；通过 roadmap 域读取该项目的内容、project revision、roadmap revision 与 hash。已知项目无 roadmap 记录是明确的 absence，不从 `projects/<id>/roadmap.md`、catalog 路径或其他文件静默回退；未知项目是拒绝，不当作空内容。
- **Initial import**: `mstar roadmap import` previews an absolute Markdown candidate read-only and saves a review containing provenance source hash and observed project/roadmap revisions. Apply rereads that reviewed path and imports its current valid content without source-byte drift refusal; project/roadmap numeric revision conflicts still refuse. Legacy v1 `roadmap.md` is a reviewable transport candidate, not an automatically effective seed; scaffold/migration presence does not redirect readers to it.
- **日常修改**：先读 store 的当前内容与版本；有记录时用 `mstar roadmap export` 导出**独立 Markdown 候选**，无记录时明确创建候选并预期 absent。编辑、复核候选后用 `mstar roadmap replace` 做整份正文的 revision-guarded replacement（同时校验 project 与 roadmap revision）。冲突重新读权威并复核候选，绝不覆盖 live `roadmap.md` 代替写入。export 也可输出 JSON transport，供跨环境 handoff；导出文件不随写入自动同步，也不反向成为权威。具体命令选项与 payload → built `mstar roadmap --help` 及各动词 `--help`，本 skill 不复写 flags。
- **校验**：engine 统一校验 import/replace 的 Markdown 正文；frontmatter `project_id`（非空且与目标 catalog project 一致）、`title`（非空）、`status`（`active | paused | completed`）、`created_at`（`YYYY-MM-DD`）为 machine-checkable；`milestones` 可选非空字符串列表（空字段按缺省），`residuals_ref` 可选非空字符串（如迁移 register 文件名）。正文宜有 `## Direction` 与目标 task-list（`- [ ]` / `- [x]`）；缺少正文约定只报 warnings，不将 `ok` 翻成 false。目标与 residual 不自动关联；`residuals_ref` 只是迁移文件引用，不恢复 register 写权威。

`projects/<id>/roadmap.md` 的旧 frontmatter / `milestones` 与 body 格式是 import/export/historical Markdown 的表示法，不是文件写作协议，也不是 live milestone 机制（→ 下节）。项目归属和路径解析 → `mstar-conventions`；ACTIVE 执行态权威在 store.db 的 `execution_*` 表（可重建 workflow 视图）；snapshot 文件仅为迁移源（由保留的 `mstar` 迁移工具 engine 内部写入，runtime consumer 不读不写）；open findings → 下文 Issue capture。

## Milestone（结构化路线目标）

- **唯一机制**：项目路线的结构化目标是 `{HARNESS_DIR}/store.db` 的 `project_milestones` 记录 + `issues.milestone_id` 关联。`mstar milestone add | update` 写元数据（name / target / ordinal / status，CAS 于 store revision）；`mstar milestone assign` 是 issue 关联的**唯一**写入面（同项目约束，explicit move / clear，走 issue 的特权 mutation 校验，不落 roadmap 的宽松 authoring 面）；issue 自身的项目不对时，先用 `mstar issue move` 把它移到目标项目（重算 project-scoped identity、清空原 milestone）再 assign——两侧必须同项目；`list | status` 只读并给出 open / resolved / other-retired rollup。动词与标志以 `mstar milestone --help` 为准，本 skill 不复写。
- **roadmap 语句引用 milestone**：Direction 与后续路线写 milestone ID + 关联 issue 的 acceptance / owner / dependency / trigger 证据；不用 `roadmap.md` stub 的 checkbox / frontmatter 名称表达目标状态。Direction 正文（`project_roadmaps.content_markdown`）与 milestone 是同一 read envelope 的两个组成，互不取代；已知项目无 roadmap 记录仍是明确 absence，milestone 数据不依赖 Markdown 正文存在。
- **交付判定**：`delivered` 的必要条件是至少一个关联 issue 且零 open（同事务校验）；交付只经显式状态变更，从不自动触发，也从不关闭 issue。retired（waived / duplicate / superseded）≠ resolved，rollup 分列展示，不把退役计成已完成工作。
- **export / dashboard 是 reporting transport**：`mstar roadmap export`（JSON v2 / 分组 Markdown）与 dashboard 由同一 envelope 组合 Direction 与 milestones；`import | replace | show` 只改 Markdown 内容权威，**从不**修改 milestone 记录。

## Issue capture（`{HARNESS_DIR}/store.db`）

**本节是 capture duty 的唯一权威**：下方两段是 issue-store contract §6 的规范文本（逐字）；其余 skill（`mstar-artifacts` / `mstar-audit` / `mstar-review-qc` / `mstar-audit/references/pr-review.md` / `mstar-harness-core`）只做指针引用，**不复述**本契约。引文中的 §4 / §7 指该契约的「Lifecycle and closure authority」与「Migration, activation and retirement」两节。

> A confirmed finding becomes an issue in `{HARNESS_DIR}/store.db` at the moment it is confirmed — before, and independently of, any decision to plan it. Capture records **evidence** (source identity, location, observed behaviour, discovery time) and never a disposition; **disposition is a separate authorized act** per §4. A recurrence of a confirmed finding **appends an occurrence** to the existing issue — deduplication is by source identity + root cause, never by title — and never opens a second issue. Issues are plan-independent: they exist before, during and after any plan; only the closure authorities in §4 retire one.

**授权（谁捕获）**

> The seat that owns the confirmed outcome captures it: the PM seat (dispatch/consolidation, QC tri, iteration close) and the main agent of a PR-review round at Stage 3 synthesis. Leaf audit/QC/QA seats **return evidence and never write the store** (survey §7 step 4). Capture goes through the `mstar issue` verbs; flags live in `--help` and are never restated in skill texts.

- 计划内捕获走 `mstar plan issue-add`（仍在活跃 plan session 内），计划外确认发现走 `mstar issue add`；同一 finding 再次出现用 `mstar issue occurrence` 追加 occurrence —— **不**新开第二个 issue。所有 `mstar issue` 写动词（包括 `link`）均为 actor-only store write（`--actor` + `--operation-id`）；每个写入都要求 payload（`--payload` 或 `--file`），而 `triage`、终态处置和 `link` 的 row-CAS 均要求 `--expect`（缺失时 `issue.revision-conflict`）；具体选项以各命令组 `--help` 为准。
- **捕获 ≠ 处置**：关闭是独立授权动作，只由契约 §4 的关闭权威执行（`mstar issue close | waive | duplicate | supersede`，计划内 `mstar plan issue-close`）；捕获席位**不**自授关闭权。`mstar issue link` 的 plan/iteration target 作为来源标签记录，不做目标存在性校验。
- **激活边界**：store 接受普通捕获/查询、并作为唯一权威，以契约 §7 的 activation 完成为准 —— staged store 会被拒（`store.not-active`）。live 切换（apply → activate → retire）归 cutover plan 的授权 ops 任务，skill 文本不代替该门禁。
- issue 与 plan 解耦（plan 外的确认发现同样可捕获）；store 的路径与权威分界 → **`mstar-conventions`**。

Payload authoring: consult `mstar-harness schema CaptureInput` for `issue add`, `OccurrenceInput` for recurrence, `IssueTriage` for triage, `ClosureEvidence` for each terminal disposition, and `IssueLink` for provenance/relation links. The schema lists required and disposition-specific fields; the verb's help supplies flags. Prepare complete JSON from observed evidence before writing, never guess a minimal payload through successive refusal messages. The actor and intended operation are not derivable from the payload and remain explicit.

## Register 生命周期（`projects/<id>/residuals.json`）

> **本节的定位**：register 是**迁移历史**，open item 的 SSOT 是 **issue store**（→ 上文 § Issue capture）——`mstar status backlog-register` / `backlog-close` 已退役并指向 issue 动词。下面的字段与生命周期规则保留为契约 §7 的**迁移映射来源**（preview / apply / retire 按此把 register 行映射为 issue）。

### Historical register fields and closure

Register shape, required fields/enums, provenance and historical in-place closure → **`mstar-engine-legacy`** `references/migration-source-shapes.md`; this is a migration mapping, never a live writer.

Live capture and closure use § Issue capture and the contract §4 closure authority; `QA gate: mandatory` requires QA verification, otherwise PM acceptance. Current severity, cleanup and issue closure → **`mstar-artifacts`** `references/status-and-residuals.md`.


### Findings cleanup（与 Assignment 联动）

- Assignment **`Findings cleanup: zero-residual | allow-residual`** 是唯一 mode 来源（`metadata.findings_cleanup` mirror 已删）；迭代 Phase 2 默认 `allow-residual`。
- `allow-residual`（默认）：仅 unresolved **critical** 阻止 Approve；离 InReview 前须把每条剩余 open finding 捕获为**本 plan 的 linked open issue**（machine-enum `severity`），并在各决策面披露（issue id + severity + 跟踪位置；close 面另含 blocker-defer 标记）—— 捕获与披露职责全文 → **`mstar-artifacts`**「Findings cleanup modes」。
- `zero-residual`（显式 opt-in）：可修 findings 当轮 fix → re-review 清干净；仅真 blocker 可 defer 且须 Durable Roadmap + `target`（`critical` 不属 defer —— 定义 → **`mstar-artifacts`**「Findings cleanup modes」）；`nit` 必须当场修或删；waived/risk-accepted 必须关闭，不得留 open。
- mode 全文与 enforcement → **`mstar-artifacts`** `references/status-and-residuals.md`（「Findings cleanup modes」+ 其 engine check）。

## Workflow

1. 确定 catalog 项目归属（无项目 → `_default`）；从 roadmap 域读现有内容与版本，absence 不走文件 fallback。
2. 首次文件导入走 preview → review → apply；后续编辑走独立候选 → revision-guarded replace；文件只作为 transport。校验 frontmatter 及 body warnings 按上文。
3. 路线目标：结构化目标建 milestone 并显式关联 issue（§ Milestone）；roadmap 语句引用 milestone ID + 关联 issue 证据，不用文件 stub 表达状态。
4. 捕获 finding：走 § Issue capture 的 issue 动词（计划内 `mstar plan issue-add`，计划外 `mstar issue add`）；register 是迁移历史，**不再**是写入目标。
5. 关闭：由契约 §4 的关闭权威执行（`mstar issue close | waive | duplicate | supersede`，计划内 `mstar plan issue-close`）。
6. 汇总：`mstar status tech-debt` 打印 store 的 open-issue rollup（`total_open` / `by_severity` / `by_project`）。

## Decision Rules

- **Issue store only**: new captures write issues (→ § Issue capture); historical registers remain read-only and must never be dual-written. Migration field history → **`mstar-engine-legacy`** `references/migration-source-shapes.md`.
- **fail-loud handoff**：捕获前必须过 engine 校验；malformed → reject + rewrite，绝不静默降级写入。
- **severity 是机器字段**：QC 报告的 Critical / Warning / Suggestion 是**章节标题**，不得逐字抄入 JSON `severity`。
- **`_default` 不豁免校验**：无项目流程同样走 issue store（`project_id = _default`），字段与关闭权威不变。

## Evidence

正确结果 = roadmap 域读取当前内容或明确 absence；reviewed import / replacement 返回新 revision 与 hash（冲突拒绝，无 live 文件覆盖）；milestone 写入返回 receipt（同请求 replay 幂等、冲突/stale 拒绝且无变更），`mstar milestone list | status` 的 rollup 与 store 一致；register 迁移文档过 `validateProjectRegister`、`mstar status findings-cleanup <plan-id>` 按 Assignment mode 绿、`mstar status tech-debt` 输出与 store 的 open issues 一致。拒绝「仅对话声称」。

## References

- **`mstar-artifacts`**（`references/status-and-residuals.md`）— 字段语义 SSOT：severity 含义与门禁关系、findings cleanup modes 全文、close 协议、engine-check 查询示例
- **`mstar-engine-legacy`** `references/migration-source-shapes.md` — historical register shape, required fields/enums, provenance and closure mapping; no execution route or live writer
- **`mstar-conventions`** — `{PROJECT_DIR}` / `{WORKFLOW_DIR}` 路径符号、`.mstarc` 声明、gitignore 策略
- **`mstar-review-qc`** — PM QC 编排与 findings 捕获 / QC gate（PM 同轮必读）
