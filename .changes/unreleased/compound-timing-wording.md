---
category: Harness
packages: root
---

- **Compound now runs once per plan.** Every plan's `Done` is followed by a `created` / `updated` / reasoned `skipped` disposition — an iteration row writes and commits tracked knowledge/CONCEPTS on the integration branch and records the disposition in the plan; a standalone development plan records `delivery.compound` before the PR head. `iteration-close` is now **specs/ADR promotion** only (contract → `mstar-doc-corpus`), with the compass summary renamed `## Corpus Promotion Summary`. Removed the "Iteration package promotion" inventory from `mstar-knowledge`, collapsed the duplicated phase-gate rule, and corrected the plan template's claim that an engine write gate enforces the order (it does not; the terminal close consults delivery evidence only for a standalone `type: plan` workflow).

<!-- CN -->
- **compound 改为每个 plan 执行一次**：每个 plan `Done` 后都产出 `created` / `updated` / reasoned `skipped`——迭代行在 integration worktree 写入并提交 tracked knowledge/CONCEPTS，disposition 记入该 plan；独立 development plan 在 PR head 前记录 `delivery.compound`。`iteration-close` 改为只做 **specs/ADR 提升**（契约 → `mstar-doc-corpus`），compass 摘要字段改为 `## Corpus Promotion Summary`。删除 `mstar-knowledge` 的「Iteration package promotion」盘点，合并 phase-gates 重复规则，并修正 plan 模板中“引擎写入闸强制顺序”的过时声明（该闸不存在；terminal close 只对独立 `type: plan` workflow 咨询证据）。
