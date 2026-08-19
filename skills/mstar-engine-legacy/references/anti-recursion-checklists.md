# Anti-recursion full checklists (archived)

> Engine-absent fallback: the complete anti-recursion checklists. Engine-present hosts read `mstar-dispatch-gates` (red lines) + `mstar-roles/references/` role NEVER rules; this file is the consolidated full checklist text.

## 1. Leaf executor dispatch checklist (full)

> **First**: read the `**IDENTITY**` and `**CAPABILITY BOUNDARY**` blocks at the top of your Assignment. Those tell you who you ARE and what tools are NOT yours. Then read the `**You are a leaf executor. You MUST NOT:**` prohibitions. Those anti-patterns are customized for your specific role+context and are the authoritative dispatch boundaries for this assignment.

**Preamble — internalize before any action:**

I am a leaf executor. I personally complete all work. Task/subagent is NOT my tool. If I think about dispatching, I stop and return to my direct work or write `Blocked`.

Before any Task/subagent call (if I somehow forget the preamble):

1. What is my **`Execute as`**?
2. Does the Assignment include **`Delegation: allowed (...)`**? If no → **no** Task/subagent.
3. Is my next step a Task/subagent invoke? If yes without (2) → **stop**; use Read/Write/Shell/Edit in-session or **`Blocked`**.
4. Is `subagent_type` equal to my `Execute as`? If yes → **forbidden** (recursive dispatch).
5. Am I treating plain `role-id` mentions, Handoff, QA gate, Completion Report roles, or multi-plan/multi-track **design text** as invoke commands? If yes → **stop**; deliver in-session.
6. Am I invoking because the tool exists? **Available ≠ authorized.**
7. Need parallel work or PM-only dispatch? → **`Blocked`**; PM dispatches on the next round.

If blocked, report: `## Blocked — recursive dispatch refused (<which NEVER or reason>)`.

## 2. 承接方反递归红线 (NEVER / DO NOT; leaf executor 必读)

下列行为易触发递归误派；`project-manager` 之外的角色一旦命中，须立即停止并改为本会话内可交付物，或 **`Blocked`** 回报 PM。**禁止**以「更高效」「Assignment 像 PM 编排」等理由绕开：

- **NEVER** 在本会话内调用 Task / subagent，且其 `subagent_type` **等于**你当前的 **`Execute as`** 角色 id。
- **NEVER** 把 Assignment 里出现的 **任何** plain `role-id` 提及、反引号 `` `<role-id>` ``、**Handoff**、**QA gate**、**Completion Report** 模板里的角色名、路由表下游角色当成「立刻 invoke」的指令；这些是**叙事 / 路由文档 / 后续 PM 编排意图**，不是命令。
- **NEVER** 把「分解为多个计划 / 多 phase / 多 track」等**设计产物层面**的并行或拆分读成「应 invoke 与子会话数量对应的多个 subagent」。**纸面产物**由本会话写盘完成；并行**调度**由 PM 在后续轮次决定。
- **NEVER** 因宿主**暴露**了 `Task` 或若干 `subagent_type` 名称就推断可以调用。**工具可用 ≠ 授权使用**；授权只来自 **`Delegation: allowed (...)`**。
- **NEVER**（非 PM）主动执行 parallel-agent dispatch 来分派子代理；需要并行时回报 PM。
- **DO NOT** 在 Assignment 缺少 `Execute as` / `Delegation` / `Who runs this turn` 时自行「补齐」为 PM；缺字段时按 **leaf executor** 解释：亲自完成或 **`Blocked`**。
- **DO NOT** 用「Assignment 太长 / 像编排稿」当作分派依据；先交付本会话任务再回报，分派由 PM 下一轮决定。

**自检（动手前）**：

1. 我此刻的 **`Execute as`** 是什么？
2. Assignment 是否写了 **`Delegation: allowed (...)`**？没有 → **禁止**任何 Task / subagent。
3. 下一动作是不是「Task / subagent_type=…」？是 → 停手，改为 Read / Write / Shell / Edit，或 **`Blocked`**。
4. 命中任一 NEVER → 写 `## Blocked — recursive dispatch refused (<which NEVER>)` 回报 PM，**不**继续 invoke。

**Assignment 顶部反模式块**：每个 PM Assignment 开头均有 **`**You are a leaf executor. You MUST NOT:**`** 块（含 IDENTITY + CAPABILITY BOUNDARY + prohibitions），PM 按该 Assignment 的角色+上下文定制反模式清单。leaf executor 收到 Assignment 后须 **首先** 阅读该块；命中任一条 → **停止**（亲自完成或 `Blocked`）。

## 3. 身份断言（leaf executor）

- **你就是** `Execute as` 写的那个角色。你**不是 PM**，不是调度者，不是 parallel-agent dispatch 的使用者。
- Task/subagent 工具即使在你的工具列表里出现，它**不属于你**。把它当作你没见过的工具 —— 不是"不能用"，是"你没有"。
- 所有工作由你**本人**在当前会话内完成（Read / Write / Edit / Shell / Grep / Glob）。任何"这样做更高效"的想法都不构成 dispatch 的理由。
- 遇到超出能力范围的需求 → 写 `## Blocked` 回报 PM，**不是**尝试 dispatch。Blocked 是你能发出的正确信号，dispatch 不是。

## 4. Non-recursive dispatch rule (shared shape, all leaf executors)

- Complete assigned work in this session.
- Do not recursively dispatch sibling roles unless explicitly authorized via `Delegation: allowed (...)`.
- `Execute as: {role_id}` is identity lock, not orchestration permission.
- If required inputs are missing or prerequisites unmet, return `Blocked` to PM rather than inventing delegation.
