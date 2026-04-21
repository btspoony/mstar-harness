---
name: mstar-superpowers-align
description: Morning Star (启明星) harness 与 Superpowers 技能的对齐与消解契约 —— 未装插件时的加载方式（Read SKILL.md 执行）、优先级（harness > 技能正文）、最小技能声明契约（Superpowers 行需含 Trigger + Expected evidence）、`Delegation` 与 `subagent-driven-development` 的互斥规则（默认 forbidden 不得叠该技能）、编排触发短语表（`dispatching-parallel-agents` / `using-git-worktrees` / `systematic-debugging` / `verification-before-completion` 等）、`subagent-driven-development` 上游 implementer-prompt / reviewer 模板降权为可选技巧、per-task 双审禁用 `@qc-specialist*`（改用 `@general` / `generalPurpose` / informal `@qa-engineer`）、QC 三审与 `using-git-worktrees` 的叠用约束、与 @explore 的关系、快速去歧义规则。`@project-manager` 在 Assignment 写 `Superpowers` 行前必读；任何承接方遇到 Superpowers 技能名前必读以判定是否冲突；`@prompt-engineer` 修改技能相关规则前必读。按角色必用/宜用详表与张力/消解对照见 references/。
---

# Morning Star × Superpowers 对齐契约

本 skill 将 **Superpowers** 插件中的技能（`~/.config/opencode/opencode.json` 中 `plugin` 已启用时）映射到 `~/.config/opencode/agents/*.md` 业务流程，并定义冲突时的消解规则。

## 未安装插件时

若当前环境没有 Superpowers（`skill` 里看不到、`plugin` 未配置）：拉取并按官方说明操作即可。

- **安装说明（英文）**: `https://raw.githubusercontent.com/obra/superpowers/refs/heads/main/.opencode/INSTALL.md`  
- **改 `~/.config/opencode/opencode.json` 须先征得用户同意**（见 `mstar-harness-core` 护栏）；不同意就只口述步骤，不代写。

**Agent 可照做的英文一句**：

`Fetch and follow https://raw.githubusercontent.com/obra/superpowers/refs/heads/main/.opencode/INSTALL.md for your code-agent host (e.g. OpenCode); get user approval before editing ~/.config/opencode/opencode.json.`

## 如何"使用"技能

- 各角色在对应任务阶段应 **显式加载并遵循** 相应技能的完整内容（在支持 `/skill-name` 或少样本名称的环境中，通过技能名调用；以**宿主客户端**实际能力为准，见 `mstar-host-opencode` / `.cursor/skills/mstar-host/`）。
- **优先级（本仓库强制）**：**用户显式指令**（含项目 `AGENTS.md` / `CLAUDE.md`）> **`~/.config/opencode/AGENTS.md` 与 `mstar-*` skills 中的 harness 不变量**（状态机与门禁、plan 约定、review 基线、branch 协作等）> **Superpowers 技能正文中的流程、阶段划分与审查模型** > 一般惯例。当技能描述的顺序、谁可派 subagent、何时审查与 **harness 不一致**时，**以 harness 与 PM Assignment 为准**，技能仅保留**不冲突**的技巧（例如自检清单、模型分档、提问纪律）。若用户禁止 TDD，则不得强制 `test-driven-development`。
- **`writing-plans` 保存路径（门限）**：`mstar-plan-conventions` 中的 **`{PLAN_DIR}`**（主 plan Markdown；与 **`{HARNESS_DIR}`** 分层见同 skill）优先于上游技能正文中的 `docs/superpowers/plans/`；执行该技能时仍须将计划落在 **`{PLAN_DIR}`**，**`{HARNESS_DIR}/status.json`**、**`{HARNESS_DIR}/notes.json`**、**`{HARNESS_DIR}/archived/`**、**`{HARNESS_DIR}/knowledge/`** 等仍按 **`{HARNESS_DIR}`**。
- **与 harness 的关系**：不改变 `mstar-harness-core` 的阶段顺序；技能规定的是**每个阶段内的做法**（例如排障前先走系统化调试、宣称完成前先有验证证据）——**但不得用技能覆盖 harness 的门禁**（见下节「`subagent-driven-development` 与上游模板」）。

## 最小技能声明契约（减少歧义）

为降低"技能已提及但执行动作不一致"的情况，`@project-manager` 在 Assignment 中应按下列最小结构声明（可简写）：

```markdown
Superpowers:
- <skill-id> — Trigger: <why now>; Expected evidence: <what output proves it ran>
```

语言约定（与 `agents/project-manager.md` 对齐）：

- 字段名（如 `Task`、`Scope`、`Acceptance Criteria`、`Report Format`）保持英文键名。
- 字段值中的任务描述正文可优先使用中文（便于编排与减少歧义）。
- `Expected evidence` 及最终执行回报保持英文，确保跨角色可读性一致。

示例：

```markdown
Superpowers:
- systematic-debugging — Trigger: intermittent 500s with unknown root cause; Expected evidence: repro steps + narrowed hypothesis + log slice
- verification-before-completion — Trigger: before sign-off; Expected evidence: command/output or reproducible QA proof
```

约束：

- 不写"泛口号式"技能名（例如只写 `use superpowers`）。
- `Expected evidence` 必须可核对；不能是"done""looks good"这类不可验证描述。
- 若同一任务包含多个技能，按"流程技能 → 实现技能"排序，避免承接方误判先后。

### `Delegation` 与 Superpowers 清单一致

`Assignment` 的 **`Delegation`** 优先于技能梗。**默认 `forbidden`** 时 **勿**在 **`Superpowers`** 写 **`subagent-driven-development`**（易与「不得 Task」冲突）；大单轨用 **`executing-plans` + `verification-before-completion`**（+ 视情 TDD / `systematic-debugging`）。要 per-task informal 子审须 **`Delegation: allowed (to @general / generalPurpose, informal only; 非 QC 报告)`** 后方可写该项。并行多轨用 **`dispatching-parallel-agents`** + 分 Assignment，**勿**用该技能顶替并行。承接方：无 `allowed` 即不得 spawn；不得因技能名含 subagent 强行 Task；难事 **Blocked** 请 PM 分批或显式 `allowed`。

## 编排触发短语表（PM Assignment / Status Update）

`@project-manager` 在 **对用户说明**、**Status Update**、**Assignment** 中应混用下列**英文短语或技能 ID**（可与中文并列），与 Superpowers 技能描述用语一致，便于宿主/插件匹配。其他角色只需按 Assignment 中的 `Superpowers` 行执行。

| 意图 | 建议写入的自然语言 / 技能 ID（示例） | 对应技能 |
|------|-----------------------------------|---------|
| 编排总览、技能先后顺序 | `using superpowers`；`load skills in order`；先流程再实现 | using-superpowers |
| 0→1、目标含糊、多方案取舍 | `brainstorming`；`brainstorm before we build`；脑暴后再定范围 | brainstorming |
| 多阶段、动代码前先书面拆解 | `writing-plans`；`write the plan first`；里程碑与依赖写清再开发 | writing-plans |
| 锁 plan 推进（单执行者顺序、或跨会话检查点） | `executing-plans`；`execute plan`；`checkpoints` | executing-plans |
| 由 PM 会话内顺序多代理，或已 `Delegation: allowed` 的 informal 子步 | `subagent-driven-development`；**勿**与默认 `forbidden` 同条 | subagent-driven-development |
| 多独立任务并行分派 | `dispatching parallel agents`；`dispatch parallel agents`；并行分派、无依赖任务并行 | dispatching-parallel-agents |
| Bug/间歇性/排障 | `systematic debugging`；`no fix before root cause`；RCA 与证据链；先调查再修复 | systematic-debugging |
| 未禁止 TDD 时的实现方式 | `test-driven development`；`TDD`；先写失败测试再过绿 | test-driven-development |
| 大块合并前作者侧 | `requesting code review` | requesting-code-review |
| 按 QC 结论改代码 | `receiving code review`；对照 review 结论逐项核实再改 | receiving-code-review |
| Gate 前必须有证据 | `verification before completion`；`verify before claiming done`；须附命令与输出/复现步骤 | verification-before-completion |
| 合并/删分支/发布收口 | `finishing a development branch`；merge / cleanup 选项与风险 | finishing-a-development-branch |
| 并行实验、同仓多代理隔离检出 | `git worktree`；`using git worktrees`（**同仓多可写并发时必用**，与 `dispatching-parallel-agents` 叠用；**仍须** Assignment 已批准的 **`Working branch`** / **`Branch policy`** 与 **检出路径约定**；不得在 worktree 内擅自新建/切换未授权分支；见 `references/tension-table.md`） | using-git-worktrees |
| 技能/Prompt 工程 | `writing-skills`（通常随 @prompt-engineer 任务写出） | writing-skills |

## 技能清单（简称）

| 技能名 | 用途摘要 |
|--------|---------|
| `using-superpowers` | 何时加载技能、流程类与实现类技能顺序 |
| `brainstorming` | 创造性工作之前澄清意图、范围与设计 |
| `writing-plans` | 多步任务在动代码前先写可执行计划 |
| `executing-plans` | 在**另一次会话**按书面计划执行并设检查点 |
| `subagent-driven-development` | **本会话**内按任务拆步执行；**审查与分派仍以 harness 为准**（见下文专节），上游 per-task 双审与 `implementer-prompt` 模板**不替代** QC 三审与 PM Assignment |
| `dispatching-parallel-agents` | 多个互不依赖任务并行分派 |
| `test-driven-development` | 实现前先写/tests 失败再过绿（若适用） |
| `systematic-debugging` | Bug / 异常行为：先调查再修 |
| `using-git-worktrees` | 同仓多可写 **并发** 时代理各自独立检出目录；或大重构/并行实验隔离 |
| `requesting-code-review` | 重大改动或合并请求前发起规范审查 |
| `receiving-code-review` | 处理审查意见时先核实再改 |
| `finishing-a-development-branch` | 实现完毕后的合并 / 清理选项 |
| `verification-before-completion` | 宣称完成、通过 gate、合并前必须有可核对证据 |
| `writing-skills` | 编写、编辑、验证 Agent 技能文档 |

## `subagent-driven-development` 与上游 `implementer-prompt` / reviewer 模板（重要）

Superpowers 插件内该技能附带 **`implementer-prompt.md`**、**`spec-reviewer-prompt.md`**、**`code-quality-reviewer-prompt.md`** 等模板（部分宿主以 `/implementer-prompt` 等名称暴露）。正文还描述「每任务后 spec 审 + code quality 审」与示例路径 **`docs/superpowers/plans/`**。在本仓库中须按下述方式 **降权为可选技巧**，**不得覆盖 harness**。

- **权威上下文**：实现与审查的 **分支、检出路径、plan、状态机** 以 **`mstar-harness-core`**、**`mstar-plan-conventions`**、**`mstar-review-qc`** 及 **`@project-manager` 的 Assignment** 为准；**不要用上游模板替代 Assignment 结构**（`Execute as` / `Delegation` 写法见 `agents/project-manager.md` §1.3；另含 `Working branch`、`Review cwd` / `Worktree path`、`plan_id`、`Review range` / `Diff basis` 等）。
- **谁可以派 subagent**：仅 `@project-manager` 可增加或并行 subagent；Assignment 未写 **`Delegation: allowed (...)`** 时，承接方 **不得** 依该技能自行连续派发「implementer / reviewer」子代理（见 `mstar-harness-core` SKILL.md「调度防串扰」）。
- **per-task 双审（spec + code quality）用谁**：这是**任务级、会话内快速自检**，**禁止**把 `@qc-specialist` / `@qc-specialist-2` / `@qc-specialist-3` 当作这两步子代理的承接方——QC 角色绑定 **`mstar-review-qc`** 与 **`{PLAN_DIR}/reports/<plan-id>/`** 正式产出，与「每任务后快速过一遍」冲突，易造成误派与多余文档。**推荐**用 **`@general`**（OpenCode 等宿主内置）或宿主并行 Task 的 **`generalPurpose`** subagent，仅借用上游 `spec-reviewer-prompt` / `code-quality-reviewer-prompt` 的检查思路；回报限本会话内简短结论（要点 / 阻塞项），不写 QC Completion Report、不落 `reports/<plan-id>/`。可选用 **`@qa-engineer`** 做同一类 informal pass（侧重可测性、验收对齐、smoke 建议）时，PM 须在 Assignment 写明 **`Informal per-task review only`**（本轮**不**套用正式 QC/QA 的 `plan_id` + `Review range` 三审门禁、**不向** `reports/` 落盘）；**feature 完成后的正式验证**仍按 harness 另派，字段与 QC 对齐。
- **正式审查门禁**：**QC 三审 + @qa-engineer 验证** 在 **feature / 整 plan 开发完成后**按默认节奏执行（多 batch 默认不每 batch 全套三审）；上游技能的 **per-task 双 reviewer 子代理** 若使用，**最多视为作者侧或会话内自检**，**不可替代** `{PLAN_DIR}/reports/<plan-id>/` 下按 **`mstar-review-qc`** 产出的 QC 报告，也不得绕过 **`plan_id` / `Review range` 三份逐字相同** 的约定。
- **完成态**：实现方将工作置 **`InReview`**；**`Done`** 仅 `@project-manager` 或 `@qa-engineer` 设定（`mstar-harness-core`）。上游模板中的「任务完成」**不等于** harness 的 **Done / sign-off**。
- **并行**：上游技能默认 **不并行多个 implementer**；若 PM 已按 harness 分配 **多写入流** 且 **同仓并发**，则 **必须** **`using-git-worktrees`** + Assignment 检出约定（见 `references/tension-table.md`）。**以 Assignment 与 harness 为准**，不因上游「禁止并行 implementer」而拒绝已批准的并行分派。
- **计划路径**：一律以 **`{PLAN_DIR}`** 为准，**禁止**把示例 `docs/superpowers/plans/` 当作落盘位置。
- **澄清**：需要结构化取舍时，**若宿主提供** `question` 类工具则优先（`mstar-harness-core` SKILL.md、`mstar-host-opencode`），与上游「自由提问」可并存；**宿主约定优先**（Cursor 见 `.cursor/skills/mstar-host/`）。

PM 在 Assignment 的 `Superpowers` 中引用 `subagent-driven-development` 时，建议加一行 **Expected evidence** 或备注，标明 *「per-task 子代理审查非正式 gate；承接方用 @general / generalPurpose（或 PM 标明的 informal @qa-engineer），勿用 @qc-specialist；正式 QC/QA 仍按 harness」*，避免承接方把上游流程当作 SSOT 或误派 QC 产正式报告。

## 与内置 `@explore` 的关系（宿主支持时）

- **摸底**：由 `@project-manager` 在分派前调用 `@explore` 并写入 Assignment 为推荐模式；**已分派的承接方**不得用 `@explore` 代做实现/测试/审查/文档等交付，仅可短只读导航（见 `mstar-harness-core` SKILL.md「内置 `@explore` 能力边界」）。Superpowers 不改变路由表。
- `dispatching-parallel-agents` / `subagent-driven-development` 用于 **PM 拆分子任务** 或 **多代理并行**，与 `@explore` 可并列使用。
- **`dispatching-parallel-agents` 与 informal 复查**：上游技能是 **多独立域并行 investig/fix** 与 **Review and Integrate**（读各轨摘要、核对是否冲突），**不**附带 `implementer-prompt` 的 **per-task spec + code-quality 双模板**。若 PM/承接方仍给**某一并行轨**加「会话内快速过一遍」子步，**同样禁止**用 **`@qc-specialist*`**，适用 **「per-task 双审（spec + code quality）用谁」** 中的 `@general` / `generalPurpose` / informal `@qa-engineer` 约定；**正式 QC/QA** 仍在 feature / plan 完成后按 harness。

## 快速去歧义规则（建议直接复用到 Assignment）

- `QA mode: report-only` 与 `QA: skipped` 互斥，不能同时出现。
- `Hotfix` 与 `RCA complete before code changes` 互斥：热修可先最小修复，但必须补"事后 RCA"项。
- `QC: skipped` 只用于已定义例外（product-docs only / tech-spec only）；否则默认进入 QC 路径。
- **`Delegation: forbidden`** 与 Superpowers 里的 `subagent-driven-development` **互斥**（除非已 `allowed` 且范围覆盖）——见上文专节。
- `Working branch` 与 `Branch policy` 只能二选一；两者同写时，以 PM 明确改写为准后再执行。
- **`QC 三审`**：三份 Assignment 的 **`plan_id`** 与 **`Review range` / `Diff basis`** 必须 **完全一致**（可复制粘贴）；缺一项则 **不得**将 gate 汇总为 `Approve`，须 `Blocked` 后补 Assignment 或补报告（见 `mstar-harness-core` `references/branch-and-worktree.md`）。

## References

- `references/per-role-matrix.md` — 按角色列出的必用/宜用技能矩阵（PM / product-manager / architect / dev 三角 / QA / QC / ops / prompt-engineer / market-expert），含每种角色的补充执行约束。
- `references/tension-table.md` — `mstar-*` 流程与 Superpowers 技能的张力与消解对照表（缺陷与 RCA、热修、完成与证据、Plan 形态、并行开发、`subagent-driven-development` 与 implementer-prompt、TDD、`git worktree` / 多工作目录、升级与重复失败）。
