---
packages: engine, dsh
---

- **The dispatch L1 gate reads branch ownership instead of the whole execution graph.** `worktreeL1Violations` called `readExecutionState` and then mapped every workflow's full state and plan payload down to the four facts `collectActiveLifecycleBranches` reads. `readActiveLifecycleBranchDocs` (engine) is that projection in one pass: the same registry membership, workflow headers and plan rows with the same refusals, but only `id`, `branch` and each row's `id`/`metadata`, so the cost follows the ownership question instead of the tokens, sessions, merge leases, frozen inputs and receipts nobody at that call reads. Every active lifecycle is still collected — dropping siblings would hide a cross-lifecycle `worktree.main.residency-switched` collision, which `tests/worktree-l2.spec.ts` now covers with a sibling-owned branch.

<!-- CN -->
- **dispatch 的 L1 门禁读分支归属，而不是整张执行图。** `worktreeL1Violations` 原先调用 `readExecutionState`，再把每个 workflow 的完整 state 与 plan 载荷映射成 `collectActiveLifecycleBranches` 实际读的四项事实。engine 的 `readActiveLifecycleBranchDocs` 就是这一投影的单趟读取：同样的注册表成员、workflow header 与 plan 行，同样的拒绝语义，但只取 `id`、`branch` 以及每行的 `id`/`metadata`，开销随归属问题而非 tokens、sessions、merge lease、frozen input 与回执走。所有 ACTIVE lifecycle 仍被收集——丢掉兄弟 lifecycle 会掩盖跨 lifecycle 的 `worktree.main.residency-switched` 冲突，`tests/worktree-l2.spec.ts` 现以一个兄弟持有的分支覆盖该情形。
