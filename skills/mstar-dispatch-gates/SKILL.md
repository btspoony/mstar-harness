---
name: mstar-dispatch-gates
description: Morning Star 派发与委派门禁 —— 仅 PM 可增派 subagent、`Execute as` 与 `Delegation`、承接方反递归 NEVER 红线、同条消息 N 次 invoke、QC 三审禁止串行 rollout、Assignment 文案≠派发（invoke 条数须对齐）、未齐不发（emit zero until batch-ready）。**必须**在 `@project-manager` 每轮派发、QC 三审并发、双轨 implement、或 leaf 角色疑惑能否 Task 时 Read；所有非 PM 承接方动手前必读反递归与自检。同仓 worktree 与 QC 检出对齐见 `mstar-branch-worktree`。Superpowers 并行短语见 `mstar-superpowers-align`。宿主细则见 `mstar-host-opencode` / `mstar-host-cursor`。
---

## Load order（必读顺序）

**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。** 同仓 worktree、QC/QA 检出字段 → **`mstar-branch-worktree`**。冲突时 **以 `mstar-harness-core` 为准**。

## 调度防串扰（强制）

- 只有 **`@project-manager`** 可以决定增加/并行 subagent；承接方**默认不得二次分派**。
- **`Execute as: <role-id>`** = 承接方**亲自**完成本单，**不是**再起同名 subagent 或嵌套同 `subagent_type` 的 Task（禁止**递归误派**）。
- 额外代理仅以 **`Delegation: allowed (...)`** 为准；未显式写时视为 **`Delegation: forbidden`**。
- Assignment 正文中的 `@xxx` 默认按「文本引用」解释，**不**视为自动调用命令。
- 承接方若判断必须增加 subagent，应先回报 **`Blocked`** 请 PM 重分派。
- **Superpowers `subagent-driven-development`**：per-task 子步**勿**用 `@qc-specialist*`；用 `@general` / `generalPurpose` 或 PM 标明的 informal `@qa-engineer`。详见 **`mstar-superpowers-align`**。

## 承接方反递归红线（NEVER / DO NOT；leaf executor 必读）

下列行为易触发递归误派；`@project-manager` 之外的角色一旦命中，须立即停止并改为本会话内可交付物，或 **`Blocked`** 回报 PM。**禁止**以「更高效」「Assignment 像 PM 编排」等理由绕开：

- **NEVER** 在本会话内调用 Task / subagent，且其 `subagent_type` **等于**你当前的 **`Execute as`** 角色 id。
- **NEVER** 把 Assignment 里出现的 **任何** `@<role>`、反引号 `` `<role-id>` ``、**Handoff**、**QA note**、**Completion Report** 模板里的角色名、路由表下游角色当成「立刻 invoke」的指令；这些是**叙事 / 路由文档 / 后续 PM 编排意图**，不是命令。
- **NEVER** 把「分解为多个计划 / 多 phase / 多 track」等**设计产物层面**的并行或拆分读成「应 invoke 与子会话数量对应的多个 subagent」。**纸面产物**由本会话写盘完成；并行**调度**由 PM 在后续轮次决定。
- **NEVER** 因宿主**暴露**了 `Task` 或若干 `subagent_type` 名称就推断可以调用。**工具可用 ≠ 授权使用**；授权只来自 **`Delegation: allowed (...)`**。
- **NEVER**（非 PM）主动执行 `dispatching-parallel-agents` 来分派子代理；需要并行时回报 PM。
- **DO NOT** 在 Assignment 缺少 `Execute as` / `Delegation` / `Who runs this turn` 时自行「补齐」为 PM；缺字段时按 **leaf executor** 解释：亲自完成或 **`Blocked`**。
- **DO NOT** 用「Assignment 太长 / 像编排稿」当作分派依据；先交付本会话任务再回报，分派由 PM 下一轮决定。

**自检（动手前）**：

1. 我此刻的 **`Execute as`** 是什么？
2. Assignment 是否写了 **`Delegation: allowed (...)`**？没有 → **禁止**任何 Task / subagent。
3. 下一动作是不是「Task / subagent_type=…」？是 → 停手，改为 Read / Write / Shell / Edit，或 **`Blocked`**。
4. 命中任一 NEVER → 写 `## Blocked — recursive dispatch refused (<which NEVER>)` 回报 PM，**不**继续 invoke。

## 并发分派完整性门禁（PM 强制）

当 PM 声明「并发分派」时，须同时满足**文案并发**与**工具并发**：

- **工具并发**：同一调度轮次内，多个 subagent 调用须在**同一条 assistant 消息**里一次性发出（宿主允许时）。
- **QC 三审硬门禁**：`qc-specialist` / `qc-specialist-2` / `qc-specialist-3` 须**同一条消息**全部发起；只发其中一个 = **`dispatch incomplete`**，不得写「三审已并行启动」。
- **先自检再发送**：发送前核对「Assignment 条数 = 本条消息中的实际 **派发** 调用条数」。
- **前置步骤与派发回合分离（防串行 rollout）**：为派发准备的 **`bash` / `read` / `glob` / `grep`**（如 `merge-base`、`Review range`、`git rev-parse`）**不计入** `N` 次派发；可在上一条仅含准备的消息完成。准备完成后，**下一条派发消息**须**一次性**含 **`N` 次** Task / subagent invoke。**禁止**先发 `1` 次、等返回再补发其余 `N-1` 次。
- **未齐不发（emit zero until batch-ready）**：需并发 `N≥2` 而当前只能发 `1` 条时，本条应发 **`0` 条派发 invoke`**（可继续 read/bash 补齐），**禁止**「先发一个顶一下」；`N` 份 payload 就绪后**单次消息发满 `N`**。OpenCode 见 **`mstar-host-opencode`**「OpenCode PM: dispatch order」。

### 具名 subagent 宿主：文案分派 ≠ 调度完成

在支持具名角色 / Task 的宿主上，`## Assignment` **正文不会**拉起子会话。PM 须在**同一条 assistant 消息**（或宿主等价机制）发出与 Assignment **条数一致**的 invoke / Task；仅打印 Markdown = **分派未完成**。**几条 Assignment ⇒ 几次 tool 调用**（默认同消息并行）。

## 并行规则（摘要）

- 独立模块可并行；避免写操作归属重叠；跨领域变更先锁接口契约再并行编码。
- **QC 三审**在 feature 开发完成后执行；三名 reviewer 共用同一组 `Review cwd` / `Working branch` / `plan_id` / `Review range` / `Diff basis`（**`mstar-branch-worktree`**）。
- **同一 plan 多 batch**：默认整 plan 交付完成跑一轮完整三审；复验波次用新文件名（**`mstar-plan-artifacts`**、**`mstar-review-qc`**）。

## 反模式（派发）

- QC 三审拆在多条消息或等 #1 返回再发 #2/#3。
- 仅 1 次 invoke 却声称「并行三审已启动」。
- 递归同角色 subagent；把 Handoff / 多轨编排措辞当 invoke。

## References

- `references/leaf-executor-checklist.md` — 承接方一页自检清单。
