---
category: Harness
packages: root
---

- Added a **`pr_merge_policy`** question to iteration Phase 1, recorded in compass frontmatter with exactly two values: `reviewed-auto` routes Phase 5 through the PR-level review loop and merges only on its settled, posted `ship it` report at the current PR head; `owner-gated` runs no PR-level review loop and stops at merge-ready for the owner's explicit written approval of the current PR head.
- Made **merge a separately authorized act**: merge-ready, green CI, QC Approve and a review `ship it` no longer authorize a merge on their own, and a missing `pr_merge_policy` is a hard stop that returns to Phase 1 instead of inferring a default.
- Widened **`mstar-pr-loop`**'s single activation context: it may now be selected at iteration Phase 1 as that iteration's `reviewed-auto` review path, while staying opt-in for every other context and never merging a PR.

<!-- CN -->
- 迭代 Phase 1 新增 **`pr_merge_policy`** 问题，答案记入 compass frontmatter，取值仅两个：`reviewed-auto` 让 Phase 5 走 PR 级 review 循环，且只在当前 PR head 上产生、已定稿并发布的 `ship it` 报告下 merge；`owner-gated` 不跑 PR 级 review 循环，停在 merge-ready 等 owner 对当前 PR head 的显式书面批准。
- 把 **merge 变为独立的授权动作**：merge-ready、CI 绿、QC Approve 与 review `ship it` 都不再单独构成 merge 授权；`pr_merge_policy` 缺失即硬停并回到 Phase 1，不得推断默认值。
- 扩宽 **`mstar-pr-loop`** 的唯一新进入场景：现可在迭代 Phase 1 被选定为该次迭代的 `reviewed-auto` review 路径；其余场景仍是 opt-in，且从不执行 merge。
