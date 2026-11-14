---
category: Changed
packages: engine, commands
---

- **Split the scratch-write refusal from the Git-read one.** `coordination.git-scratch-unavailable` now covers a failed delivery-diff scratch write with `{ path, cause }`; `coordination.git-unavailable` keeps the Git-read and probe-warning meaning. `workflowCloseRecovery` selects its recovery by code alone.
- **One `state_json` guard chain.** `readWorkflowView` and `readActiveLifecycleBranchDocs` share the same checks in the same order, and every refusal the projection keeps has a direct test.
- **The store-db suite no longer reports interpreter-only failures.** A raw read-only open retries a quiesced WAL store with `?immutable=1`, and an unsupported interpreter is named in the failure output.

<!-- CN -->
- **拆开 scratch 写入与 Git 读取两类拒绝码。** `coordination.git-scratch-unavailable` 覆盖 delivery-diff 临时文件写入失败（`{ path, cause }`）；`coordination.git-unavailable` 保留 Git 读取与探测告警语义。`workflowCloseRecovery` 只按拒绝码选择恢复文案。
- **`state_json` 守卫链合并为一处。** 两个读取器按同样顺序执行同样的检查，投影保留的每条拒绝都有直接用例。
- **store-db 套件不再上报仅在本地解释器出现的失败。** 原始只读打开对 quiesced WAL 形态回退 `?immutable=1`；不支持的解释器在失败输出中被点名。
