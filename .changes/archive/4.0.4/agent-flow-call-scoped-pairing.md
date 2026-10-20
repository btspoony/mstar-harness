---
category: Harness
packages: dsh
---

- **A native `plan bind` with an explicit `harness` adopts into THAT harness.** The durable execution-binding slot and the engine resume now resolve from the harness the bind itself selected (the explicit per-call `harness` when present, the workspace harness otherwise), so a bind naming a different control root no longer leaves its coordinator seat in one store and its binding slot in another — ledger attribution reads the root the bind actually committed in.
- **Agent-flow settle/continuation pairing is call-scoped.** The durable dispatch, settle, and continuation ledger rows carry the live tool-call id at write time, and the panel projection pairs on the exact `(agent, role, planId, taskId, callId)` identity, so two concurrent same-identity dispatches each keep their own settle and continuation attribution instead of the later dispatch absorbing the earlier call's continuation.
- **The exported agent-flow event union includes `continuation`.** `AgentFlowView.events` now carries the nonterminal `continuation` member (`state` / `reason` / `callId`) as a typed union element, the internal `as AgentFlowView` escape is removed, and typed consumers narrow per kind instead of casting.
- **A team member's early `subagent/end` is buffered even before any pairing write exists.** The end-buffer admission is roster-gated rather than pairing-map-gated, so a teammate whose initial turn settles before the first spawn pairing write is reconciled and settled by that write instead of silently dropped.

<!-- CN -->
- **带显式 `harness` 的原生 `plan bind` 采纳进该 harness。** 持久执行绑定槽位与引擎 resume 现在从 bind 自身选择的 harness 解析（有显式按调 `harness` 用它，否则用 workspace harness），因此点名另一个 control root 的 bind 不再把 coordinator 席位留在一个 store、把绑定槽位写在另一个——台账归因读取 bind 实际提交的 root。
- **Agent-flow 的 settle/continuation 配对升级为按调用作用域。** dispatch、settle、continuation 三类持久台账行在写入时携带实时 tool-call id，面板投影按精确的 `(agent, role, planId, taskId, callId)` 身份配对——两个同身份并发 dispatch 各自保留自己的 settle 与 continuation 归因，后发 dispatch 不再吸收先发调用的 continuation。
- **导出的 agent-flow 事件联合包含 `continuation`。** `AgentFlowView.events` 现在以类型联合成员携带非终结 `continuation` 行（`state` / `reason` / `callId`），内部 `as AgentFlowView` 断言已移除，类型化消费者按 kind 收窄而不再强转。
- **团队成员早到的 `subagent/end` 在任何配对写入之前也会被缓冲。** end 缓冲的准入以 roster 为门而不是以配对 map 为门，因此在首个 spawn 配对写入之前就结算的成员会由该写入完成 reconcile 与 settle，而不是被静默丢弃。
