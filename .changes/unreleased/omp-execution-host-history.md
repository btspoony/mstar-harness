---
category: Changed
packages: omp
---

- Added the **pure OMP hidden-history reader/exporter** (`packages/omp/src/execution-history.ts`): `readExecutionHostHistory` classifies one session ledger by the five exact hidden `customType` literals (`mstar:phase2`, `mstar:phase2-continuation`, `mstar:phase2-checkpoint`, `mstar:phase2-launch-reservation`, `mstar:model-handoff`), keeps native order/entry id, preserves every payload verbatim with its canonical sha256 digest, and decodes an advisory view (schema generation, checkpoint/operation identity, dedup key, cancellation and one-shot handoff state) that stays separate from the raw evidence. `exportExecutionHostHistory` serializes the history as canonical evidence.
- Nothing here is authority: the reader takes no session argument, produces no `ExecutionBinding`, and retains a stale or foreign `coordinatorSessionPath` as provenance only. Unrelated entry types stay unrelated, and a recognized hidden entry that cannot be decoded is retained and diagnosed (`payload-not-object`, `payload-unsupported`, `payload-version-invalid`, `payload-kind-invalid`, `payload-state-invalid`, `session-identity-missing`, `entry-id-missing`, `entry-shape`) instead of being guessed into a session or another type. Native extension wiring lands with the OMP adoption task.

<!-- CN -->
- 新增**纯 OMP hidden-history 读取/导出模块**（`packages/omp/src/execution-history.ts`）：`readExecutionHostHistory` 按五个精确 hidden `customType` 字面量（`mstar:phase2`、`mstar:phase2-continuation`、`mstar:phase2-checkpoint`、`mstar:phase2-launch-reservation`、`mstar:model-handoff`）分类单个 session ledger，保留原生顺序与 entry id，逐条原样保留 payload 及其 canonical sha256 摘要，并解出与原始证据分离的 advisory view（schema generation、checkpoint/operation 身份、dedup key、取消与一次性 handoff 状态）；`exportExecutionHostHistory` 将该历史序列化为 canonical 证据。
- 该模块不构成任何权威：读取不接受 session 参数、不产出 `ExecutionBinding`，陈旧或外来的 `coordinatorSessionPath` 仅作为 provenance 保留。无关 entry 类型保持无关；无法解码的已识别 hidden entry 会被保留并诊断（`payload-not-object`、`payload-unsupported`、`payload-version-invalid`、`payload-kind-invalid`、`payload-state-invalid`、`session-identity-missing`、`entry-id-missing`、`entry-shape`），而不会被猜成某个 session 或另一种类型。原生扩展接线随 OMP adoption 任务落地。
