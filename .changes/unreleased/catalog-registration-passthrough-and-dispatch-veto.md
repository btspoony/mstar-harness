---
category: Fixed
packages: root
---

- **A journal lane this checkout does not hold no longer refuses workflow selection, and a pending registration now vetoes the workflow/ralph dispatch instead of degrading to an unreadable read.** A bound remote checkout whose private cache is absent, or a scope with no collaboration store yet, carries no `catalog_operations` row, so it gets the same pre-activation pass-through `store.not-active` already had instead of `collaboration.not-initialized`. A registered workflow with a genuinely pending registration still refuses `catalog.registration-pending`, the verdict now runs on the source read the host actually uses (`readExecutionWorkflowSource`), and that read carries the verdict as its own field: the fan-out gate denies the call under `warn`, `ask` and `hard` alike rather than reporting "cannot read the store" and allowing it, so `ralph` cannot start work beside a lifecycle whose catalog registration never committed. Genuinely unreadable sources keep their documented fail-open.

<!-- CN -->
- **本检出并不持有的 journal lane 不再拒绝 workflow 选择，而 pending 注册现在会否决 workflow/ralph 派发，而不是退化成“读取失败”。** 已绑定但私有 cache 缺失的 remote 检出，或尚无协作库的作用域，都不含 `catalog_operations` 行，因此获得与 `store.not-active` 相同的前置放行，而不是 `collaboration.not-initialized`。已注册 workflow 若确有 pending 注册仍以 `catalog.registration-pending` 拒绝；该判定现在跑在宿主真正使用的源读取（`readExecutionWorkflowSource`）上，并把判定作为独立字段随读取结果返回：fan-out 闸门在 `warn`、`ask`、`hard` 下统一否决该调用，而不再把它当作“读不到库”放行，因此 `ralph` 无法在一个 catalog 注册从未提交的 lifecycle 旁开工。真正不可读的源仍保留既有的 fail-open 行为。
