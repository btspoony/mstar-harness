---
name: mstar-host-cursor
description: Morning Star (启明星) harness 在 Cursor 宿主上的加载方式、入口与专属能力 —— Cursor 不会自动注入 `~/.config/opencode/AGENTS.md`，须通过规则或手动 Read 加载；`/pm` 等指令让主代理按 `~/.config/opencode/agents/project-manager.md` 执行；Task 工具并行拉起子代理实现与 OpenCode harness 同构的 QC 三审；单会话多帽 / 多窗口模式；implement 子代理内禁止递归 Task（与 `Execute as` 对齐）；澄清无 `question` 工具时用结构化 Markdown；与 OpenCode 的入口差异。Cursor 使用者在会话开始前必读；任何涉及 QC 三审 Task 并行拉起的角色必读；需要与 Cursor 项目规则、`/pm` 指令、Composer 行为协调时必读。流程与门禁权威仍在 `~/.config/opencode/skills/mstar-harness-core/` 等 mstar-* skills（按绝对路径 Read）。
---

# Morning Star × Cursor Host Adapter

本 skill 描述在 **Cursor** 中使用 Morning Star harness 时的 **入口、加载顺序与能力差异**。流程规则仍以 **`~/.config/opencode/skills/mstar-*/`** 下的各 skill 为准；此处只补「Cursor 上怎么接」。

## 推荐入口

1. **全局规则与 skill 索引**：`~/.config/opencode/AGENTS.md`（与 OpenCode 共用同一份**中性** harness；Cursor **不会自动注入**，需通过规则或手动 Read）。
2. **Morning Star 核心 skills**：手动 Read 下列绝对路径（Cursor 主代理或 Task 子代理均可），与 OpenCode 行为对齐：
   - `~/.config/opencode/skills/mstar-harness-core/SKILL.md`（及 `references/`）
   - `~/.config/opencode/skills/mstar-plan-conventions/SKILL.md`
   - `~/.config/opencode/skills/mstar-review-qc/SKILL.md`
   - `~/.config/opencode/skills/mstar-routing-eval/SKILL.md`
   - `~/.config/opencode/skills/mstar-coding-behavior/SKILL.md`
   - `~/.config/opencode/skills/mstar-superpowers-align/SKILL.md`
   - （OpenCode 特定入口在 Cursor 不强制加载；与 Cursor 有关的宿主差异以**本 skill**为准）
3. **项目经理行为**：`~/.config/opencode/agents/project-manager.md`（用户可通过 **`/pm`** 等指令让主代理按 PM 角色执行时读取）。

## Task 工具与并行子代理（QC 三审）

在 **Cursor 当前环境**中，主代理可以使用 **`Task` 工具**并行拉起子代理，**能够**落实与 OpenCode harness 同构的 **QC 三审**分派。

- **`subagent_type`** 可选用 `qc-specialist`、`qc-specialist-2`、`qc-specialist-3`，语义上对应 PM 下发的 **三条独立 Assignment**（三名 reviewer）。
- **与 harness 对齐的硬性字段**：三份子任务中的 **`plan_id`**、**`Review cwd` / Worktree path**、**`Review range` / Diff basis** 必须与 OpenCode 流程 **逐字相同**（见 `~/.config/opencode/skills/mstar-harness-core/references/branch-and-worktree.md`、`~/.config/opencode/skills/mstar-plan-conventions/SKILL.md`、`~/.config/opencode/skills/mstar-review-qc/SKILL.md`）。
- **同仓曾多 worktree 并行开发**：Task 工具 **并行拉起三名 QC** 只解决「三名 reviewer 同时跑」；**不**表示三人应分别进入 **不同** 开发 worktree 各审一段。三份 Task 的 `Review cwd` 等字段仍 **逐字相同**，且该检出必须对应 **已含全部待审提交** 的 **单一** `Working branch` / `HEAD`（多流未合并时须先集成或拆 scope）。**编排侧** 推荐 PM 在并行开发前建立 **plan 集成分支** 再挂各轨 worktree，见 `~/.config/opencode/skills/mstar-harness-core/references/branch-and-worktree.md` 同节 **「推荐默认编排：先建 plan 集成分支，再挂各 worktree」**。
- **和 OpenCode 的差别**：主要在 **宿主能力**——会话工具集、`question` 等交互、日志与 **artifact / 报告落盘路径** 的约定，**不是**「不能派三审」或「必须降级为单人扮演三票」。

PM 在 Status Update 中可简要注明本次三审是 **Task 并行子代理** 执行，便于审计与复盘。

## 何时仍用单会话或多窗口（补充模式）

下列情况可作为 **Task 并行** 的补充或备选（在 Status Update 中说明所用模式）：

### 模式 A — 单会话多帽

同一对话中由**主代理**顺序执行：先以 PM 规划并写出 Assignment，再在同一会话用**显式声明**切换执行身份，例如：

- `Acting as role: fullstack-dev — executing Assignment …`
- 执行前 **Read** 对应 `~/.config/opencode/agents/<role>.md`，严格按该文件的产出与门禁执行。

若在未使用 Task 子代理时做 QC/QA，可在同一会话内分轮次 Read `agents/qc-specialist*.md` / `agents/qa-engineer.md`，字段对齐要求不变。

### 模式 B — 多窗口 / 多会话扮演

将某条 Assignment 放到**新聊天**，在首轮消息中粘贴 Assignment 并要求代理 Read 对应 `agents/<role>.md`。适合长实现、避免单会话上下文挤压；PM 在主线会话汇总证据与状态。

### 模式 C — 与 worktree / 写入并发的关系

即使用 Task 并行子代理，仍须遵守 `~/.config/opencode/skills/mstar-harness-core/references/branch-and-worktree.md`：**同仓 ≥2 可写者并发修改** 时 **`git worktree`**（或等价隔离）与 Assignment 中的分支/路径约定；不要将「能并行跑 QC」与「能多代理共用一个可写 cwd」混为一谈；亦不要将「Task 并行 QC」与「QC 应使用多个不同 `Review cwd`」混为一谈（见同 reference **「多 worktree 并行开发与 QC / QA 的门禁衔接」**）。

### implement 子代理内禁止递归 Task（与 `Execute as` 对齐）

已通过 Task 收到 Assignment 的子代理 **即** `Execute as` 所指执行者：**禁止**同会话再 Task 同名 dev（或同单套其他 dev 轨）代做。`Execute as` 行用纯 id（旧文带 `@` 仍表绑定，非「再派一名」）。外层与 Assignment（亲自完成、`Delegation: forbidden`）冲突时以 Assignment 为准；主会话勿叠同角色 Task。**OpenCode** dev 常 `permission.task` deny；**Cursor** 可 Task 时须守本条与 `~/.config/opencode/agents/fullstack-dev.md`。

## 澄清交互

- **无 `question` 工具时**：用结构化 Markdown（标题、选项列表）在正文中提问，或用 Cursor 支持的等价交互；原则与 `~/.config/opencode/skills/mstar-harness-core/references/phase-gate-playbook.md` 的 `clarify` 一致。
- **不要把「能问」当成「已澄清」**：高影响歧义未收敛仍须 `Blocked` 或升级人工。

## Superpowers 与技能

无内置 Skill 工具时：按 `~/.config/opencode/skills/mstar-superpowers-align/SKILL.md` **「未安装插件时」**，用 **Read** 打开上游 `SKILL.md` 再执行步骤。

## 与项目规则的关系

自 cwd 向上的项目 `AGENTS.md` / `CLAUDE.md` 优先于全局 harness；与 `project-manager-mode` 等 Cursor 规则冲突时以项目规则与用户当轮指令为准。

## 库文档检索（Cursor 视角）

优先使用 Cursor 已启用的 Context7 MCP（例如 `user-context7`）；协议与 OpenCode 版本相同（**单一路径、禁双跑**），详见 `~/.config/opencode/skills/mstar-host-opencode/SKILL.md` 「库文档检索（Context7；单一协议）」。

## OpenCode 对照

OpenCode 下的加载与子代理语义见 **`~/.config/opencode/skills/mstar-host-opencode/SKILL.md`**。
