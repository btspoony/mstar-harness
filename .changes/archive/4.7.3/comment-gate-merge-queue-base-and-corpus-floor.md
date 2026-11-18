---
category: Harness
packages: root
---

- **Comment gate hardening** — the comment-and-guard workflow now also runs on a merge queue (`merge_group`), and its ratchet compares against the group's own base, so a batched group is judged by the increment it adds rather than by every pull request in it. The whole-tree corpus assertion became a floor per root (14,000 under `packages/`, 800 under `scripts/`): one root's scanner can collapse while the other keeps a summed total above a single threshold. The comment classifier also gates the semicolon introducer on the dialect — it ends a statement in C-family code, so it opens comment content only where the dialect reads it as one.

<!-- CN -->
- **注释门禁加固** —— 注释与守卫工作流现在也在合并队列（`merge_group`）上运行，其 ratchet 以该组自身的 base 比较，因此一批合并的组只按其新增的增量判定，而不是组内每个 PR。全树语料断言改为**按根**的地板（`packages/` 14,000、`scripts/` 800）：单个根的扫描器可能崩塌，而另一根仍让合计数高于单一阈值。注释分类器同时按方言限制分号引导符——分号在 C 系代码中终止语句，因此只在把分号读作引导符的方言里开启注释内容。
