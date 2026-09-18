---
category: Harness
packages: omp
---

- Reshaped the **OMP diagnostic notices** onto one shared title shape (`packages/omp/src/notices.ts`): a status-bearing title states the observed workflow's `id` and `status` verbatim from a successfully read snapshot, and a fallback title names the observed condition while asserting no workflow status. The Phase-2 adapter now carries the typed observed id/status through its internal probe/sampling/diagnostic path instead of emitting the fixed `Phase-2 observation inactive` prefix, keeps the refusal code in the detail, and preserves the one-diagnostic-per-code-per-generation bound. The notice custom-type literals are declared only in the shared module.

<!-- CN -->
- **OMP 诊断通知**统一到共享标题形状（`packages/omp/src/notices.ts`）：状态标题逐字携带从成功读取的快照中观察到的 workflow `id` 与 `status`；回退标题只描述观察到的条件，不断言任何 workflow 状态。Phase-2 适配器将类型化的观察 id/status 贯穿其内部 probe/sampling/diagnostic 路径，删除了固定的 `Phase-2 observation inactive` 前缀，拒绝码保留在 detail 中，并维持「每代码每代一条诊断」的边界。通知 custom-type 字面量仅在共享模块中声明。
