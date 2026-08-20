---
category: Harness
packages: dsh
---

- **Engine-status digest join caps**: the `mstar:engine-status` runtime-context digest (`engineStatusSummary` in `packages/dsh/src/gates/system-prompt.ts`) now renders at most 8 plan rows and 4 lease rows in catalog-array order, appending a final `+N more` overflow marker when the list is longer — the digest stays a bounded snapshot and truncation stays visible. At-or-under-cap output and the empty `none` / `none active` copy are unchanged; per-item `stripInterpolationHazard` screening and the compact residuals counts are untouched. The caps are module-level constants, deliberately not re-exported. The sibling `<mstar_engine_status>` pre-step catalog row (`renderEngineStatusCatalog`, `packages/dsh/src/gates/catalog.ts:288` plans join / `:300` leases join) stays uncapped by design: sharing the constants would close a `system-prompt.ts ↔ catalog.ts` import cycle, and duplicating them would fork the values — the sibling follow-up is registered on the v3.1.0 roadmap.

<!-- CN -->
- **Engine-status 摘要 join 上限**：`mstar:engine-status` 运行时上下文摘要（`packages/dsh/src/gates/system-prompt.ts` 的 `engineStatusSummary`）现按目录数组顺序最多渲染 8 条计划行与 4 条租约行，列表更长时在末尾追加 `+N more` 溢出标记——摘要保持有界快照，截断可见。等于上限时的输出与空数组的 `none` / `none active` 文案均不变；逐项 `stripInterpolationHazard` 屏蔽与紧凑的 residuals 计数保持不变。上限为模块级常量，刻意不导出。兄弟 `<mstar_engine_status>` pre-step 目录行（`renderEngineStatusCatalog`，`packages/dsh/src/gates/catalog.ts:288` 计划 join / `:300` 租约 join）按设计保持无上限：共享常量会闭合 `system-prompt.ts ↔ catalog.ts` 导入环，复制常量又会分叉取值——兄弟行后续工作已登记在 v3.1.0 roadmap 上。
