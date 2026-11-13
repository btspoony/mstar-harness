---
packages: dsh, engine
---

- **A milestone write refused in the gateway envelope keeps only the transport's own code.** `milestoneWrite` now passes through the `gateway/*` family the transport emits (`gateway/internal` for a thrown handler, `gateway/cancelled` for an aborted carrier) and maps every other envelope code to `transport-error`, so the retry channel keeps the operation id instead of settling on a code it does not own. Engine refusals (`milestone.invalid-input`, `store.revision-conflict`, `milestone.not-empty`) are unaffected: they arrive as the method's value and are decoded there, messages included.
- **The branch-ownership projection refuses a plan row that carries a second authority.** `readActiveLifecycleBranchDocs` applies the same plan-level `state_json` guard `readWorkflowView` already applies: a row state carrying `coordination` or `execution_lease` is `store.corrupt` ("owned by `coordination_json`, not by the row state") instead of being read as the row.

<!-- CN -->
- **经网关信封被拒的 milestone 写只保留传输层自己的 code。** `milestoneWrite` 现在原样返回传输层发出的 `gateway/*` 家族（handler 抛错的 `gateway/internal`、carrier 被取消的 `gateway/cancelled`），其余信封 code 一律映射为 `transport-error`，重试通道因此保留 operation id，不会因一个它并不拥有的 code 而终结本次写。引擎自身的拒绝（`milestone.invalid-input`、`store.revision-conflict`、`milestone.not-empty`）不受影响：它们作为方法返回值到达并在那里解码，message 亦然。
- **分支归属投影拒绝携带第二权威的 plan 行。** `readActiveLifecycleBranchDocs` 现在应用与 `readWorkflowView` 相同的 plan 级 `state_json` 守卫：行状态里出现 `coordination` 或 `execution_lease` 即 `store.corrupt`（"owned by `coordination_json`, not by the row state"），不再当作行状态读取。
