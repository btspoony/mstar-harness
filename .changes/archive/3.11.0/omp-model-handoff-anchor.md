---
category: Changed
packages: omp
---

- Made `mstar_model_handoff {operation:"start"}` reachable for an already-registered, own, not-yet-armed workflow: the extension now selects the reservation or attachment branch from the validated root register itself, while coordinator authority stays derived solely from host/engine facts (`deriveStartAuthority`). A foreign coordinator of the named workflow now refuses with `already-bound` on the attach path; every other refusal code and the unregistered reservation path are byte-identical.
- Aligned all model-handoff coordinator notices with the shared Morning Star title shape: status-bearing titles state the observed workflow id and status from its own snapshot; snapshot-free sites (suspension, start refusal, in-flight navigation refusal) use a fallback title that asserts no workflow status. `mstar:model-handoff-notice` and `mstar:model-handoff` literals are unchanged.

<!-- CN -->
- 使 `mstar_model_handoff {operation:"start"}` 对已注册、本人、尚未武装的工作流可用：扩展现在自行从已校验的根登记表选择保留或附加分支，而协调者权威仍只来自宿主/引擎事实推导（`deriveStartAuthority`）。在附加路径上，被命名工作流的外来协调者现在以 `already-bound` 拒绝；其余拒绝码与未注册保留路径逐字节不变。
- 所有模型交接协调者通知统一为 Morning Star 共享标题形状：含状态标题陈述从工作流自身快照观察到的 id 与状态；无快照站点（挂起、启动拒绝、导航拒绝）使用断言无工作流状态的回退标题。`mstar:model-handoff-notice` 与 `mstar:model-handoff` 字面量不变。
