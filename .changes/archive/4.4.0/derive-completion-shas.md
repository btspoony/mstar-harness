---
category: Harness
packages: root, engine
---

- **`plan complete` derives the source and review commits from the recorded worktree.** `source_sha` and `review_head` were two names for the checkout `HEAD` the engine already re-read before accepting a completion: both are now optional in the evidence document, and the derived `HEAD` is what lands in the completion record.
- **`review_base` is optional provenance, not a required pin.** A supplied base is still verified as a commit of the checkout and an ancestor of the source; an omitted base records `null` instead of inventing a merge-base that is wrong once the target is merged into the branch.
- A supplied commit is verified, never trusted: `source_sha`/`review_head` must equal the worktree `HEAD` and a supplied `review_base` must be an ancestor, or complete refuses with `coordination.git-proof`; format is still checked for every supplied value. Iteration and report-only routes keep their existing proof/no-proof split.
- Updated `mstar-use-cli/references/plan-and-workflow.md` (complete payload) and `mstar-roles/references/project-manager/plan-management.md` (row completion routes).

<!-- CN -->
- **`plan complete` 从记录的工作树推导 source/review 提交。** `source_sha` 与 `review_head` 原本是引擎在放行完成前就已重读的 checkout `HEAD` 的两个名字：两者在证据文档中改为可选，写入完成记录的是推导出的 `HEAD`。
- **`review_base` 变为可选出处，不再是必需锚点。** 提供时仍校验其为该 checkout 的提交且为 source 的祖先；省略时记录 `null`，不再凭空生成一个在目标分支合入后就错误的 merge-base。
- **提供的提交只做校验、不被信任：** `source_sha`/`review_head` 必须等于工作树 `HEAD`，提供的 `review_base` 必须是祖先，否则 complete 以 `coordination.git-proof` 拒绝；任何提供值仍校验格式。迭代与 report-only 路由保持原有的「需证明 / 无需证明」划分。
- 更新 `mstar-use-cli/references/plan-and-workflow.md`（complete 载荷）与 `mstar-roles/references/project-manager/plan-management.md`（行完成路由）。
