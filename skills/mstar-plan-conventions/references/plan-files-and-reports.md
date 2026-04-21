# Plan 文件与 Reports 留档（Morning Star）

## Plan 文件（`{PLAN_DIR}/<name>.md`）

每个 plan 的详细内容（任务清单、决策、Sign-off）。

**命名（推荐）**：`<plan-id>-<plan-name>.md`（例：`01-data-infrastructure.md`）。`status.json` 中 `file` 字段填相对仓库根或 `{PLAN_DIR}` 下的实际路径。

**审查报告文件**（置于 `{PLAN_DIR}/reports/<plan-id>/`）：

| 类型 | 文件名 |
|------|--------|
| 架构/设计评审 | `<plan-id>-review.md` |
| QC 并行报告 | `<plan-id>-qc1.md`、`-qc2.md`、`-qc3.md` |
| QC 汇总结论 | `<plan-id>-qc-consolidated.md` |

## QC 分报告与 consolidated：可否只留一份？

- **不要删除** `<plan-id>-qc1.md`、`-qc2.md`、`-qc3.md`**只因为**已写入 `<plan-id>-qc-consolidated.md`。`reports/` 在此约定下是**只读历史 / 审计链**：分 reviewer 原文保留**证据出处、分歧与独立视角**；**consolidated** 是 PM 的**门控摘要**，二者**叠加**，**不互为替代**。
- **极窄例外**（须团队显式采纳并承担审计缺口）：例如仓库体积极敏感时，仅保留 consolidated + 指向外部归档的链接——**不在**本默认 harness 中推荐；默认仍保留三份 `-qc*.md`。

## Residual findings（R#）：权威在哪、和主 plan 谁先谁后？

- **Open 条目的单一事实来源（SSOT）**是 **`{HARNESS_DIR}/status.json`** → **`metadata.residual_findings[<plan-id>]`**（字段结构见 `status-and-residuals.md`）。跨会话 handoff、关闭与归档流程**以该数组为准**。
- **推荐操作顺序**（避免 plan 与 JSON 两套 ID 漂移）：
  1. `@project-manager` 读完三份 QC 报告并完成「QC 三审轻量汇总」：对 finding **去重合并**，为每条待跟踪项分配**稳定 `id`**（如 `R1`、`R2`，全 plan 内唯一）。
  2. **立即**将上述条目写入 **`metadata.residual_findings[<plan-id>]`**（含 `source` 指向哪位 QC / 哪份报告文件名，便于回溯）。
  3. **可选**：在主 plan 中增加 **「Residual findings（索引）」** 小节，**仅复述** `id` + 短标题 + 决策摘要，并写明「**权威列表见** `status.json` → `metadata.residual_findings[<plan-id>]`」。**不要**只在主 plan 里「发明」R# 而不写回 SSOT。
- **不要**反过来把主 plan 当作唯一登记处：若仅更新 plan、`status.json` 未同步，下一任 agent **无法**依赖 SSOT 继承债务状态。

## QC 三审触发时机（单 plan · 多 batch）

- **默认（推荐）**：同一 **`plan_id`** 下，**完整 QC 三审**（`qc1` + `qc2` + `qc3` 并行）**仅在 dev team 按该 plan 约定范围全部交付之后**执行**一次**，再进入 `@project-manager` 汇总与 `@qa-engineer` 验证。**不要**在每个中间 **batch** / 子里程碑都跑全套三审：否则 `reports/<plan-id>/` 会堆积多套并列报告，**`Review range` / `Diff basis` 与结论**易混淆，handoff 成本高。
- **batch 之间**：依赖实现方 **`verification-before-completion`**、主 plan 任务勾选与 PM 协调；需要书面中间意见时，用对话、主 plan 批注或**非三审**的定向检查（如单审、架构 review），**不**默认等同「又一轮完整三审」。
- **Request Changes 后复验**：若须再跑一轮完整三审，使用**新文件名**落盘，避免覆盖首轮报告，例如 `<plan-id>-qc1-rev2.md` … `<plan-id>-qc3-rev2.md`（或团队约定的 `wave2-` 前缀）；`@project-manager` 在 `QC Consolidated Decision` 中写明**当前以哪一波次为准**。
- **显式例外**：仅当用户与 PM 书面同意**中间门禁**时，在 Assignment 写清 **`QC gate: incremental — <scope>`**（或等价），并仍须保证该次三审的 **`plan_id` + `Review range` / `Diff basis`** 三份一致；**优先**用子范围专用标签或子目录，避免与「整 plan 终局」那套 `-qc*.md` 混名。
- **同仓多 worktree 并行 dev**：**推荐**在排各 batch / 各轨 worktree 前确立 **plan 集成分支** 与各轨 topic 线及 **merge 靶**（见 `mstar-harness-core` `references/branch-and-worktree.md` **「推荐默认编排：先建 plan 集成分支，再挂各 worktree」**）。终局（或增量）三审派单前，PM 仍须满足 **单一待审 `Working branch` / `HEAD`** 或已按上条 **拆 scope**；**不得**假设「整 plan 一次三审」可只靠某一个开发 worktree 路径覆盖未合并的其他并行轨。

**QC 落盘与宿主权限**：`@qc-specialist` / `@qc-specialist-2` / `@qc-specialist-3` 在支持路径白名单的宿主上（如 OpenCode 的 **`permission.edit`**），**仅可** Write/Edit **`{PLAN_DIR}/reports/`** 下 **`.md`**（全局 agent 提示词中已配置 `.agents/plans/reports/**`、`.plans/reports/**`、`plans/reports/**` 相对路径）。报告文件**必须**以 YAML **frontmatter** 开头（键见各 QC agent 提示词）。**若** 项目的 `{PLAN_DIR}` 不落在上述三种根下，须在**项目级**宿主配置（如 OpenCode）中为 QC 角色追加对应的 `edit` allow 规则。

**QC 报告与 Git**：报告落盘后，各 QC 角色须在业务仓内对**本次报告文件**执行 **`git add` + `git commit`**（细则与 bash 权限见 `agents/qc-specialist*.md`）；**禁止**仅落盘不提交导致 `clone` 后不可见。**PM / architect / product-manager** 对 **`{HARNESS_DIR}`** / **`{PLAN_DIR}`** 与主 plan 的创建与更新亦须在业务仓内 **commit**（见 `agents/project-manager.md` Plan 初始化与 PM 职责、`agents/architect.md` / `agents/product-manager.md` Git 小节）。

## 主 plan 内任务清单（Markdown checkbox）

- **谁应更新**：`@fullstack-dev` / `@frontend-dev` / `@fullstack-dev-2`、`@qa-engineer`、`@ops-engineer`、`@architect`、`@product-manager` 在**完成本人 Assignment 范围内的工作后**，须在主 plan（`<plan-id>-<plan-name>.md`）中把**对应条目**的 Markdown 任务标记为已完成（常见：`- [ ]` → `- [x]`；若项目用其它清单记号，保持同文件内一致）。与 Completion Report **并列**，作为跨会话可核对的**落盘痕迹**。
- **范围**：**只勾选与当前任务直接对应、且已由本角色交付证据支撑的条目**；不得代为勾选他人负责或未完工项。若正文用分段、Owner 或角色标签区分任务，以 Assignment 与文内约定为准。
- **与 `status.json` / frontmatter 的关系**：勾选任务**不**等于整条计划收口。`plans[].status` 及主 plan frontmatter 的 **`Done`** 仍**仅** `@project-manager` / `@qa-engineer`（见「状态更新权限」）。`@architect` / `@product-manager` **不得**擅自将整条计划标为 `Done`；是否将 `status.json` 推进为 `InReview` 等仍按下文「状态更新权限」与 Assignment。
- **`@qc-specialist*`**：**不得**修改主 plan（宿主仅允许 `{PLAN_DIR}/reports/**/*.md`）；审查结论落在 `reports/<plan-id>/` 内。若主 plan 需新增或勾选与审查相关的条目，由 `@project-manager` 或 Assignment 明确授权的角色据报告回写。
- **只读角色**（如 `@market-expert`）：不直接改主 plan；将建议交给 `@project-manager` 代为更新清单。

Plan 正文与 `status.json` 必须保持一致；不一致时以 `status.json` 的条目状态为准并尽快纠正正文或登记 notes。

## Done 标记方式

1. **Frontmatter**（首选）：添加 `status: Done` 和可选的 `done_at: YYYY-MM-DD`。
2. **文件名**（备选）：重命名为 `DONE__<name>.md` 或 `<name>.done.md`。

同时更新 `status.json` 对应条目。
