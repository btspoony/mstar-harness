---
category: Harness
packages: root
---

- **Tracked-product fixes stay out of the integration worktree.** The iteration close record for that round now names one deviation: on 2026-10-23, a CI bundle-freshness fix rebuilt and pushed `hooks/*.mjs` from the integration worktree during the Phase-5 loop, instead of a fix feature worktree merged back after review. The preventing check already exists — the control-root / integration-worktree product-edit ban in `skills/mstar-iteration/references/phase-2-worktree-lease.md`, stated in the Phase-scope line under "When it applies" and again in §2.3 step 3, restated with its Phase-5 twin in `skills/mstar-iteration/references/phase-4-5-pr-delivery.md` §5.0 — and this record adds no new guard.

<!-- CN -->
- **产品修复不落在 integration worktree。** 该轮迭代的 close record 现在记录了一处偏离：2026-10-23，一次 CI bundle 新鲜度修复在 Phase-5 循环中从 integration worktree 重建并推送 `hooks/*.mjs`，而非走 fix feature worktree、经 review 后合并回来。防止复发的检查已经存在——`skills/mstar-iteration/references/phase-2-worktree-lease.md` 的「When it applies」Phase-scope 行与 §2.3 step 3 中的 control-root / integration-worktree 产品编辑禁令，其 Phase-5 对应条款在 `skills/mstar-iteration/references/phase-4-5-pr-delivery.md` §5.0——本记录不新增任何 guard。
