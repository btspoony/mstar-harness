---
name: mstar-review-qc
description: Morning Star QC/QA review baseline — **SDD plans: mandatory plan QC tri-review** (`qc1`…`qc3` + consolidated); inline/hotfix single-seat (`qc.md`); checklists, report template, targeted re-review, residual gate. Per-task review is **`mstar-sdd`** task reviewers (L2). Use when `qc-specialist*` review, `qa-engineer` verifies, or `project-manager` dispatches/consolidates QC.
---

## Load order（必读顺序）

**在同一会话或任务中首次 Read 本 skill 时：必须先 Read `mstar-harness-core` skill（SKILL.md），并按需 Read **`mstar-branch-worktree`**（`Review cwd` / `Working branch` / `Review range`）。** 本 skill 只定义 QC/QA **工作流与报告形态**；派发与三审同消息规则见 **`mstar-dispatch-gates`**；**同仓 worktree 与单一待审 `HEAD`** 以 **`mstar-branch-worktree`** 为准。冲突时 **以 `mstar-harness-core` 为准**。

**摘要**：`mstar-harness-core` — QC-QA 检出与派发门禁；本 skill — 审查清单、报告模板、verdict 与 residual 留档契约。职责分层 → **`references/review-responsibility-boundaries.md`**。

# Morning Star QC Review Baseline（QC 审查基线）

本 skill 定义所有 QC 审查员的共享基线。**`Execution mode: sdd` 时：plan 级强制 tri-review**（QC#1/#2/#3 交叉审整分支 → `qc1`…`qc3` + `qc-consolidated.md`）。**`inline` / hotfix** 可用单席 `qc.md`。职责分层 → **`references/review-responsibility-boundaries.md`**。三审共用正文以 **`mstar-roles`** `qc-specialist-shared` 为准。

## 分派时机（与 plan / batch 对齐）

- **`Execution mode: sdd`**（单 plan 与 iteration 均适用）：全部 task + L2 task reviewers 完成后 → **强制 tri-review**（`QC mode: full tri-review`，**N=3**）。Assignment 须含 **branch review-package** 路径。PM 汇总 `qc-consolidated.md`。
- **`Execution mode: inline`**：单席 `qc-specialist` → `qc.md`（**N=1**），或按 hotfix 路由跳过。
- **例外 `QC mode: full tri-review`**：三席并行 `qc1`…`qc3` + consolidated（见 `mstar-dispatch-gates`）。
- **After `Request Changes` (default)**：**Targeted re-review** — PM dispatches only QC seats that **raised** blocking findings for this fix round; each updates **the same** `{PLAN_DIR}/reports/<plan-id>/qcN.md` (e.g. `qc1.md` — no `<plan-id>` prefix in basename) (add `## Revalidation`, update verdict). **Do not** spawn `qcN-rev2.md` files on this path. Artifact naming and PM consolidated updates → **`mstar-plan-artifacts/references/plan-files-and-reports.md`** § QC 三审触发时机.
- **Full tri re-review (exception)**：Assignment must say **`QC re-review: full tri-review`**; then new basenames (`qc1-rev2.md` … `qc-consolidated-rev2.md`); PM marks **active wave** in consolidated decision.

## 三审身份与模型独立性门禁（PM 强制）

在 PM 发出 **initial** QC 三审后、进入汇总前，必须先完成以下校验（**targeted re-review** 仅校验 Assignment 列出的席位）：

- **Initial wave**：三个会话角色 ID 须分别为 `qc-specialist`、`qc-specialist-2`、`qc-specialist-3`；运行模型与 `opencode.json` 对应配置一致。
- **Targeted re-review**：仅校验 Assignment 列出的席位；缺席或角色/模型映射错误 → `dispatch invalid`，重派。
- 若宿主故障导致并行 QC 退化为同模型且无法即时修复，Status Update 标记 `degraded tri-review` 并请用户确认（默认不放行）。

## 共享基线（所有审查员）

每位 QC 审查员必须检查：

- 行为回归是否已被显式确认
- 阻塞级安全或数据一致性风险是否已被识别
- 变更行为的测试覆盖是否充分
- 若启用功能分支策略：变更分支与 Assignment 的 **`Working branch` / `Branch policy`** 是否一致；且审查在 Assignment 写明的 **`Review cwd` / `Worktree path`**（feature 检出上下文）上执行，而非未核对的默认 cwd；若曾同仓多流并行开发，还须核对 **`HEAD` 是否已含本 scope 全部待审提交**（见 `mstar-branch-worktree` **「多 worktree 并行开发与 QC / QA 的门禁衔接」**）
- **三审对齐**：Assignment 已写明 **`plan_id`**（或 `N/A` + **Feature / scope label**）与 **`Review range` / `Diff basis`**；报告 **Scope** 须 **逐字回写** PM 下发的这两字段，**禁止**与同伴 reviewer 使用不同范围或不同 plan 锚点

## 标准审查工作流

1. **对齐待审检出（feature 上下文）**：在动手审查前，按 Assignment 进入 **`Review cwd` / `Worktree path`**（若已写明）；执行 `git rev-parse --show-toplevel`、`git branch --show-current`（或等价）确认 **当前目录即待审 feature 的检出**，且分支与 **`Working branch`** 一致。核对 Assignment 中的 **`plan_id`**（或 `N/A` + **Feature / scope label**）与 **`Review range` / `Diff basis`** 已填写；缺任一项应向 `@project-manager` 申请补全，**禁止**自行假设审查范围。后续 **`git diff` / `git log`** 必须 **按 `Review range` / `Diff basis` 可复现地覆盖待审变更**（若与本地 `HEAD` 不一致，先回报 `Blocked`）。若 Assignment 未写 `Review cwd` / `Worktree path` 但开发回报了实现用 worktree，应先向 `@project-manager` 申请补全 Assignment，**禁止**在未核对路径与分支的情况下假设在审 `main` 或其它提交。细则见 `mstar-branch-worktree`「QC 三审、QA 验证与 feature 检出上下文」。**`@qa-engineer`** 对同一 feature 做验证时须使用 Assignment 中 **同一 `Review cwd` / `Worktree path`** 及 **同一 `plan_id` + `Review range` / `Diff basis`**（见该节 QA 条款）。
2. 用 `git diff` / `git show` 与内置 `glob` / `grep` / `read` 构建变更上下文；仅在跨模块或陌生路径需要快速导航时**可选**短调用 `@explore`。**禁止**把审查步骤、结论或清单执行外包给 `@explore`（见 `mstar-harness-core` SKILL.md「内置 `@explore` 能力边界」）。
3. 检查 `git diff` 及相关历史；若 Assignment 启用功能分支策略，再次核对当前分支与 **`Working branch` / `Branch policy`** 一致（无授权则不应在默认分支上堆功能改动）。
4. 运行对应语言的 lint 和静态分析。
5. 按本 skill 审查清单进行人工审查。
6. 产出带严重等级和证据的结构化发现。PM 将条目写入 **`{HARNESS_DIR}/status.json`** 根级 **`residual_findings[<plan-id>][]`**（canonical 见 `mstar-plan-artifacts` **SKILL.md** 开篇）时，其 **`severity`** **仅允许** `mstar-plan-artifacts` `references/status-and-residuals.md` 中 **「Residual findings：severity（SSOT，机器字段）」** 的枚举与映射表（报告小节 **Critical / Warning / Suggestion** → JSON 档位）；**不要**把报告标题字符串直接当作 `severity`。
7. **报告入库（Git）**：将 QC 报告 **`.md`** 写入 `{PLAN_DIR}/reports/<plan-id>/` 后，在业务仓根执行 **`git add`**（**仅**本次报告路径）与 **`git commit`**，并在 Completion Report 给出 **真实** `git log -1 --oneline`。**禁止**仅完成 Write/Edit 而不提交（权限与例外见各 `agents/qc-specialist*.md`）。
8. **禁止收尾套话**：报告与 commit 成功后，**不得**向终端用户追问「是否要交付报告」「下一步是否通知 PM」等；须在同一轮内输出完整 **Completion Report v2** 结束（见各 `agents/qc-specialist*.md` **「回合结束方式」**）。

### Deep Review 模式（自动触发，透镜制）

QC reviewer 在开工时按 `references/deep-review-personas.md` § 触发规则自行判定是否启用 deep review（≥2 条信号即触发）。**不派发子代理**，不依赖 PM 显式标注 mode。

- **触发信号**：变更规模、敏感模块、新领域、数据结构变更、plan 高风险声明、多模块耦合 —— 达 2 条即触发。
- **审查方式**：单人加载**透镜（lens）**——结构化检查表，逐项覆盖（如 Security Lens、Auth Lens、Data Migration Lens），不派发 persona subagent（反递归红线）。
- **透镜选择**：默认透镜 + 按触发信号追加。详见 `references/deep-review-personas.md`。
- **报告中体现**：`## Scope` 写 `Deep review: triggered (<signals>)` + `Lenses applied: <list>`；发现归入主报告 Findings，`Source Type` 标注为 `deep-lens: <lens-name>`。

## 共享审查清单

### 代码质量

- [ ] 命名清晰且一致。
- [ ] 职责没有过度混合。
- [ ] 错误处理显式且可执行。
- [ ] 注释说明意图，而非实现细节的琐碎描述。

### 安全与正确性

- [ ] 输入已验证，边界检查显式。
- [ ] 无明显的注入/路径遍历/权限问题。
- [ ] 敏感数据处理方式恰当。
- [ ] 不变量和状态转换逻辑连贯。
- [ ] LLM/Agent 边界：不可信输入未直接驱动特权操作；提示注入面已识别。

### 性能与可靠性

- [ ] 热路径避免了可避免的开销。
- [ ] 资源生命周期处理正确。
- [ ] 无界操作的风险已被处理。
- [ ] 退化和失败行为可观测。

### 可维护性

- [ ] 契约和接口仍然易于理解。
- [ ] 引入依赖有充分理由。
- [ ] 破坏性变更附带迁移指引。
- [ ] 优先复用而非重复逻辑。

## 标准输出模板

落盘到 **`{PLAN_DIR}/reports/<plan-id>/qc#.md`**（`qc1.md` … `qc3.md`；目录已含 `plan_id`，文件名勿再加前缀）时：文件**最上方**须为 YAML frontmatter（`report_kind`、`reviewer`、`reviewer_index`、`plan_id`、`verdict`、`generated_at` 等，见 `agents/qc-specialist*.md`），**紧接着**再写下列 Markdown 正文（可将 **Reviewer Metadata** 与 frontmatter 对齐，避免矛盾）。**Findings 下三节标题**（Critical / Warning / Suggestion）为**人类可读分类**；PM 将条目写入根级 **`residual_findings`**（见 `mstar-plan-artifacts` **SKILL.md** 开篇）时的 **`severity` 机器字段**以 `mstar-plan-artifacts/references/status-and-residuals.md` **「Residual findings：severity（SSOT，机器字段）」** 为准。

```markdown
# Code Review Report

## Reviewer Metadata
- Reviewer: @qc-specialist | @qc-specialist-2 | @qc-specialist-3
- Runtime Agent ID: {qc-specialist | qc-specialist-2 | qc-specialist-3}
- Runtime Model: {provider/model-id}
- Review Perspective: {role-specific primary focus}
- Report Timestamp: {ISO-8601}

## Scope
- plan_id: {same as Assignment — or `N/A` + Feature / scope label from Assignment}
- Review range / Diff basis: {exact copy from Assignment}
- Working branch (verified): {name}
- Review cwd (verified): {path from git rev-parse --show-toplevel}
- Files reviewed: {count}
- Commit range (if not identical to Review range line, explain): {hash..hash}
- Tools run: {list}

## Findings
### 🔴 Critical
- {issue} -> {fix}

### 🟡 Warning
- {issue} -> {fix}

### 🟢 Suggestion
- {improvement}

## Source Trace
- Finding ID: {F-001}
- Source Type: {git-diff | linter | static-analysis | doc-rule | manual-reasoning}
- Source Reference: {command/snippet/file}
- Confidence: High | Medium | Low

## Summary
| Severity | Count |
|----------|-------|
| 🔴 Critical | {n} |
| 🟡 Warning | {n} |
| 🟢 Suggestion | {n} |

**Verdict**: Approve | Request Changes | Needs Discussion
```

## 高危变更与破坏性操作（运维 / 数据 / 生产）

适用于：`@ops-engineer` 主导的迁移、生产配置变更、数据删除或批量变更、证书轮转、共享环境上的破坏性脚本等。`@project-manager` 应在 Assignment 中标注 **high-risk** 并写清允许的目录与环境。

**最小检查（未满足则应 `Needs Discussion` 或 `Request Changes`）**

- [ ] 影响范围与维护窗口（或对用户的影响）已写明。
- [ ] 回滚步骤可执行且已评审。
- [ ] 备份、快照或等价恢复手段已确认（如适用）。
- [ ] 变更与验证步骤可审计（命令、流水线或 runbook 引用，而非一次性黑箱）。
- [ ] 涉及应用代码时仍走默认开发门禁（QC/QA），不因"只是运维"而跳过。

## 门禁规则

- 存在未解决的 `Critical` 或 `Warning` → `Request Changes`
- 无 `Critical` / `Warning`，但有高影响且未定案的取舍（通常来自 Suggestion 的架构级分歧）→ `Needs Discussion`
- 仅在 `Critical = 0` 且 `Warning = 0`（未解决项）时，方可 `Approve`

### CI 门禁补充（强制）

- 任何与本次变更范围相关的 CI 失败（编译、测试、lint、类型检查、构建、发布前校验）默认按 **>= Warning** 处理，进入本轮必须修复项。
- CI 失败未修复前，不得给出 `Approve`；应按上方门禁判定为 `Request Changes`。
- 若判断为 CI 环境波动而非代码问题，报告必须给出可复核证据（失败日志、复跑结果、隔离结论）并由 PM 明确记录处置决定；在未形成一致结论前，维持 `Needs Discussion` 或 `Request Changes`，不得直接放行。

## Residual Findings 留档门禁

- 当阻断项（`Critical`）修复后仍有未关闭 **Warning / Suggestion** 类问题或技术债，不得仅在对话中口头说明，必须留档；登记 **`severity`** 时遵守 `mstar-plan-artifacts` `references/status-and-residuals.md` **「Residual findings：severity（SSOT，机器字段）」**。
- **启用 plan 管理且存在 `plan-id` 时**：**待跟踪（open）** residual 的 **SSOT** 为 **`{HARNESS_DIR}/status.json`** 根级 **`residual_findings[<plan-id>]`**（与 `plans` 平级；canonical 见 `mstar-plan-artifacts` **SKILL.md** 开篇）；PM 在 consolidated 决策中分配 **稳定 `id`（R1…）** 后须**写入该数组**（`source` 指回 `qc1.md` 等）。**已关闭**条目归档至 **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**（字段与严重等级见 `mstar-plan-conventions`），与 **`{PLAN_DIR}/reports/<plan-id>/`** 交叉引用。
- **主 plan**：仅作**人类可读索引**（可选）——复述 `id` 与摘要并指向 **`{HARNESS_DIR}/status.json`**；**不得**作为与 SSOT 脱钩的唯一登记处（见 `mstar-plan-conventions` `references/plan-files-and-reports.md`「Residual findings：权威在哪」）。
- 可选：`@project-manager` 维护 **`metadata.tech_debt_summary`** 作为跨 plan 聚合视图（与 `residual_findings` 互补，见 `mstar-plan-conventions`）。
- 若无 `{PLAN_DIR}`：写入项目认可的进度载体或根级 `notes`（结构化条目），仍须含 `id` 与跟踪字段。
- 每条 residual finding 至少包含：`id`、`title`、`severity`、`source`、`scope`、`decision`（defer/accept/risk-accepted）、`owner`、`target milestone/date`、`tracking link`。
- `Approve with residuals` 仅在无未关闭 `Critical` 时允许，且 PM 汇总结论中必须包含 residual 清单与跟踪位置。
- 未完成 residual 留档，不应进入最终 `Done` 收口。

### Residual 关闭与验证（与 `mstar-plan-conventions` 对齐）

- 后续轮次中若某 R# 已修复：审查/QA 结论应**指向**可复核证据（diff、测试、复现步骤）；**`@project-manager`** 或 **`@qa-engineer`** 补全关闭字段后，将条目 **追加**至 **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**，并从 **open 列表**（根级 **`residual_findings[<plan-id>]`**；若仅存 legacy 侧则从该处）中**移除**（主列表仅保留 **open**）。
- **`waived` / `superseded` / `duplicate`** 须在 `closure_note`（及必要时 `superseded_by`）中写清依据；豁免类应与产品/风险口径一致，不得由执行方单方面静默关闭。
- **不得**从主列表删除仍为 **open** 的项；**不推荐**把已关闭项长期留在 **`{HARNESS_DIR}/status.json`**（应用文件归档减负，见 `mstar-plan-conventions`）。

## 证据规则

- Critical 发现必须包含触发条件、影响范围和修复建议。
- 低置信度发现必须包含后续验证步骤。
- 跨任务反复出现的发现应标记为重复模式。
