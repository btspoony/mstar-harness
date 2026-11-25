---
category: Changed
packages: root
---

- **Autonomous iterations now resolve merge policy by evidence, not by asking.** Phase 1 keeps `pr_merge_policy` mandatory, but an explicit `autonomous` opt-in lets PM recommend it from existing evidence (`reviewed-bot` when a review bot is attached, else `reviewed-auto`) and record the rationale, instead of stopping for owner confirmation. `owner-gated` is never recommended autonomously.
- Updated `mstar-iteration` Phase 1, the compass template, and `autonomous-direction-lock.md` so branch and merge-policy resolution share one **Autonomous policy resolve** section.

<!-- CN -->
- **autonomous 迭代改为按证据解析 merge policy，不再停下询问用户。** Phase 1 仍强制记录 `pr_merge_policy`，但在显式 `autonomous` opt-in 下由 PM 按证据推荐（挂载 review bot 时 `reviewed-bot`，否则 `reviewed-auto`）并落盘 rationale；`owner-gated` 不在 autonomous 下推荐。
- 更新 `mstar-iteration` Phase 1、compass 模板与 `autonomous-direction-lock.md`，branch 与 merge-policy 解析合并为 **Autonomous policy resolve** 一节。
