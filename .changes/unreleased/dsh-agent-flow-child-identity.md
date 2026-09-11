---
packages: dsh
---

- **dsh plugin**: background subagent dispatches now pair their settle on the registry **`jobId`** carried by the `{ kind: 'background', jobId }` tool result (the upstream rename away from `taskId`) — the terminal arrives via `ctx.inject(['jobs'])` → `jobs.onJobDone` (`completed → ok` / `killed → denied` / `failed → error`), so a background dispatch no longer stays `running` with no paired settle.
- **dsh plugin**: the ledger now carries child-session identity — a settle row carries an optional `childId` (a foreground `runId`, or a background child id the catalog join already supplied) and `taskRef` (the registry job id, distinct from the Assignment `Task N` tag `taskId`), and a new **nonterminal `subagent-link` row** correlates the parent-owned `subagent/catalog` child id back to the dispatch identity (`role` / `planId` / `taskId`, plus `taskRef` for a background one-shot) through a per-dispatch call-window join — an IDENTITY record, never a completion, so a running child is labellable.
- **dsh plugin**: role text is normalized at the write boundary (trimmed, ONE leading `@` stripped), so `@explore` and `explore` are one actor across the dispatch, settle and link rows.
- **dsh plugin**: the event log's detail rows show the **child session id** (missing → 「—」, never a guessed value), and an agents window holding only link rows is classified link-only rather than settle-only.

<!-- CN -->
- **dsh 插件**：后台 subagent 派发现在按 `{ kind: 'background', jobId }` 工具结果携带的注册表 **`jobId`** 配对结算（上游已由 `taskId` 更名为该字段）——终态经 `ctx.inject(['jobs'])` → `jobs.onJobDone` 到达（`completed → ok` / `killed → denied` / `failed → error`），后台派发不再永远停留在 `running` 且无配对结算。
- **dsh 插件**：账本新增子会话身份——结算行携带可选 `childId`（前台 `runId`，或 catalog 关联已提供的后台子会话 id）与 `taskRef`（注册表 job id，区别于 Assignment 的 `Task N` 标签 `taskId`）；新增的**非终态 `subagent-link` 行**通过逐派发的调用窗口关联，把父会话自有的 `subagent/catalog` 子会话 id 关联回派发身份（`role` / `planId` / `taskId`，后台 one-shot 另带 `taskRef`）——它是身份记录而非完成，故运行中的子会话可被标注。
- **dsh 插件**：`role` 文本在写入边界归一化（去首尾空白 + 剥掉一个前导 `@`），`@explore` 与 `explore` 在派发、结算与 link 行中是同一 actor。
- **dsh 插件**：事件记录的详情行展示**子会话 ID**（缺失时为「—」，绝不猜测）；仅含 link 行的 agents 窗口被归类为 link-only 而非 settle-only。
