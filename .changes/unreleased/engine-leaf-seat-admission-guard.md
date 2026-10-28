---
category: Harness
packages: engine
---

- **Engine leaf-seat admission guard (#548):** a trusted adapter can now attest `leafSeat: true` on its §3.1 execution identity; `validateExecutionIdentity` then refuses with the stable `coordination.leaf-seat` code before any coordinator registration, bind, recovery or adoption runs — even when the ambient identity would satisfy the call. The refusal names the leaf condition (session header origin "subagent" or `delegationDepth > 0`) and the recovery: the non-leaf coordinating session performs the registration itself.

<!-- CN -->
- **引擎 leaf-seat 准入守卫（#548）：** 受信适配器可在 §3.1 执行身份上声明 `leafSeat: true`；`validateExecutionIdentity` 即以稳定的 `coordination.leaf-seat` 代码拒绝，任何协调者注册、bind、恢复或采纳都不会执行——即使环境身份本身满足调用。拒绝信息说明 leaf 条件（会话头 origin 为 "subagent" 或 `delegationDepth > 0`）与恢复路径：由非 leaf 的协调会话自行执行注册。
