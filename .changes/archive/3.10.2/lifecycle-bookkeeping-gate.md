---
category: Harness
packages: root
---

- The engine now **refuses delivery-tail evidence** (`compound`, PR identity, `merge`) at the `recordWorkflowDelivery` write seam while any plan row is not `Done` — enforcing the order the lifecycle contract already declared. The gate is write-time only: idempotent re-records skip it and existing snapshots that already carry evidence are unchanged.

- The **plan template**, PM required reading, and PM self-review now carry the scoped engine lifecycle sequence and the evidence order (`compound` / PR / `merge` recorded only after the row is `Done`).

- **Standalone `development` plans** now declare the read-only phase-6 gate output as a merge-ready precondition; iteration workflows keep their Phase 4/5 exit checklist unchanged.

- Residual **R2** (standalone plans cannot reach `Done` without integration anchors) remains open — the template states the honest stop at a submitted/accepted handoff instead of fabricating a terminal state.

<!-- CN -->
- 引擎现于 `recordWorkflowDelivery` 写入边界**拒绝交付尾证据**（`compound`、PR 标识、`merge`），只要任一 plan 行尚未 `Done`——执行生命周期契约已声明的顺序。门禁仅作用于写入：幂等重录跳过；已携带证据的快照不受影响。

- **计划模板**、PM 必读清单与 PM 自检现包含 scoped 引擎生命周期序列与证据顺序（`compound` / PR / `merge` 仅在行 `Done` 之后记录）。

- **独立 `development` 计划**现将只读 phase-6 门禁输出声明为 merge-ready 前置条件；迭代工作流仍沿用 Phase 4/5 退出清单。

- 残留项 **R2**（独立计划无集成锚点无法到达 `Done`）仍开放——模板明确在已提交/已接受交接处诚实停止，而非伪造终态。
