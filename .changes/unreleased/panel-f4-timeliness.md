---
category: Harness
packages: root
---

- **dsh plugin**: panel F4.1 timeliness (plan `20260811-panel-f4-timeliness`) — the 代理执行 canvas now reflects REAL subagent completion: settles are recorded only from verified completion signals — `tools/post-execute` (the dsh-tools registry dispatches it for every tool call, verified against the upstream source) settles foreground dispatch-tool calls, and `ctx.tasks.onTaskDone` terminals settle background subagents (`completed → ok` / `killed → denied` / `failed → error`); every paired settle carries its dispatch's identity (`role`/`planId`/`taskId`, same fields + semantics as the dispatch event), so under QC-tri N=3 concurrency each card settles on its own, the `N 执行中` count derives from the ledger, and unpaired/non-dispatch calls record nothing (never fabricated). A ledger record (dispatch/settle) now invalidates the workspace's TTL-cached catalog row immediately, so the panel refreshes per step during active orchestration instead of waiting up to the 60 s TTL (idle gaps keep the last snapshot — documented limit).

<!-- CN -->
- **dsh 插件**：面板 F4.1 时效性（plan `20260811-panel-f4-timeliness`）——「代理执行」画布现反映**真实**子代理完成状态：settle 仅来自已验证的完成信号——`tools/post-execute`（dsh-tools registry 对每次工具调用都会发出，已对上游源码验证）结算前台派发工具调用，`ctx.tasks.onTaskDone` 终态结算后台子代理（`completed → ok` / `killed → denied` / `failed → error`）；每个配对 settle 携带其派发的标识（`role`/`planId`/`taskId`，与派发事件同字段同语义），QC tri N=3 并发下各卡各自结算、「N 执行中」计数由 ledger 派生，未配对/非派发调用不记录（绝不捏造）。ledger 记录（派发/结算）现会**立即失效**工作区 TTL 缓存的 catalog 行——活跃编排期间面板按步刷新，不再受 60s TTL 延迟上限约束（空闲间隔保持最后快照——已文档化的限制）。
