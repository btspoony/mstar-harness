---
category: Harness
packages: dsh
---

- **The mstar-audit fan-out stays inside the child pool.** The workflow-based audit template fired all nine category seats in a single `parallel()` barrier, which the host subagent pool (8 active by default, over-cap activations hard-rejected) exceeds on hosts where the `workflow` tool's own `min(16, cores - 2)` concurrency is larger. The template now launches seats in sequential chunks of `Math.min(8, categories.length)`, keeping in-flight children ≤ 8 on any host; the returned envelope preserves the original category order.
- **A `subagent` activation return is now "started, not settled".** The agent-flow ledger settled a dispatch `ok` the moment the activation call returned — 61–268 ms after dispatch, long before the child did any work. The real settle now follows the child's completion through the existing stop-reason mapping, and an activation whose child end never arrives stays open instead of being falsely settled.

<!-- CN -->
- **mstar-audit 扇出不再超出子代理池。** 基于 `workflow` 的 audit 模板此前用单个 `parallel()` 屏障一次性发射全部九个类别 seat，在 `workflow` 工具自身并发（`min(16, cores - 2)`）高于宿主子代理池（默认 8 个活跃，超限激活被硬拒绝）的机器上会超池。模板现在按 `Math.min(8, categories.length)` 分批顺序发射，任何主机上在途子代理 ≤ 8；返回的 envelope 保持原类别顺序。
- **`subagent` 激活返回现在按"已启动、未结算"处理。** 此前 agent-flow 台账在激活调用返回的那一刻就把派发结算为 `ok` —— 距派发仅 61–268 ms，远早于子代理实际工作。真实结算现在跟随子代理完成、走既有 stop-reason 映射；子代理 end 永不到来的激活保持 open，不再被虚假结算。

