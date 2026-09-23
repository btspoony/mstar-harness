# Execution F3 — durable selection and active ledger targets

- Persist session selection and exclusion floors separately from rebuildable engine-status emissions.
- Store only canonical C1 `ExecutionBinding` authority witnesses; validate current SQL session admission before returning an active ledger target.
- Refuse stale, revoked, missing, corrupt, or scope-mismatched authority without falling back to root or newest workflow.
- Take the same `.execution-maintenance` exclusion the engine's activation/migration/restore takes before either store write, and report a bounded advisory refusal instead of writing inside that window.
- Preserve the legacy target route only when no active execution authority exists.

<!-- CN -->

# Execution F3 — 持久化选择与活动 ledger 目标

- 将 session 选择与排除下限独立于可重建的 engine-status 派生 emission 持久化。
- 仅保存 C1 canonical `ExecutionBinding` authority witness；返回活动 ledger 目标前校验当前 SQL session 准入。
- 对过期、撤销、缺失、损坏或 scope 不匹配的 authority 拒绝写入，不回退到 root 或最新 workflow。
- 两处 store 写入前取与 engine activation/migration/restore 相同的 `.execution-maintenance` 排除锁，窗口内返回有界 advisory refusal，而不是写入。
- 仅在不存在活动 execution authority 时保留 legacy target 路径。
