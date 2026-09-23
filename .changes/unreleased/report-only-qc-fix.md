---
category: Harness
packages: root
---

- **A rewritten `accepted` handoff no longer reaches the terminal close** (plan `#270` QC seat 2 F-1): `validateStandaloneCompletedCoherence` required the `completed` handoff state POSITIVELY for a `Done` standalone row instead of returning early for every other state, so the report-only integration-contamination, `integration_worktree_path` / `branch.integration` and no-lease refusals now apply to the JSON/file transport exactly as the DB transport's completed replay (`requireHandoffState(handoff, ["completed"], …)`) already applied them. Flipping one word of stored state used to disable all five checks: the close then wrote `completed`, stamped `ended_at`, unregistered the root entry and passed the phase-6 gate on a document that was still `accepted`.
- **The recorded report-only fulfilment is frozen once the row is `Done`** (plan `#270` QC seat 2 F-2): `delivery.completion` joins the post-`Done` immutability set on BOTH transports (`recordWorkflowDelivery` and the execution authority's `applyDeliveryEvidence`), refusing a re-pointed evidence reference with the same stable code (`coordination.invalid-transition`) — the fulfilment is recorded BEFORE the row is marked `Done` (contract §1), so it is the basis that `Done` was authorized against. An identical re-record stays the idempotent no-op it always was, and the `development` tail remains write-time-only.

<!-- CN -->
- **被改写的 `accepted` handoff 不再能抵达终态 close**（plan `#270` QC 第 2 席 F-1）：`validateStandaloneCompletedCoherence` 对 `Done` 的 standalone 行**正向要求** completed 状态（不再对其它状态早退），因此 report-only 的 integration 污染、`integration_worktree_path` / `branch.integration` 与「无租约」拒绝在 JSON/文件传输上与 DB 传输的 completed 重放（`requireHandoffState(handoff, ["completed"], …)`）同构。此前改写一个词即可令这五项检查全部失效：close 会写入 `completed`、落 `ended_at`、注销 root 条目，并让仍是 `accepted` 的文档通过 phase-6 门禁。
- **report-only 完成证据在该行 `Done` 后冻结**（plan `#270` QC 第 2 席 F-2）：`delivery.completion` 并入两条传输的 post-`Done` 禁改集（`recordWorkflowDelivery` 与执行权威的 `applyDeliveryEvidence`），以同一稳定拒绝码（`coordination.invalid-transition`）拒绝被重新指向的证据——该完成证据在行标记 `Done` **之前**记录（契约 §1），故其正是该 `Done` 被授权所依据的基础。完全相同的重录仍是幂等 no-op，`development` 尾段仍保持仅写入期门禁。
