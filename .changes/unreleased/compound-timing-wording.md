---
category: Harness
packages: root
---

- Made the compound timing unambiguous everywhere it is routed: a standalone `development` plan records its disposition **after the row is `Done` and before the PR head is finalized** (lifecycle contract §4c, plan template, knowledge skill, PM sequence), while an iteration keeps one batch at `iteration-close`. Replaced the "close-time promotion" label with "delivery-tail disposition", scoped the "never at per-plan Done" and "not a per-plan activity" statements to iteration rows, collapsed the duplicated phase-gate paragraphs, and removed the plan template's claim that the engine refuses delivery evidence before `Done` — that write gate no longer exists, so the template now states the close's consultation instead.

<!-- CN -->
- 统一 compound 时机的表述：独立 `development` plan 在**自身行 `Done` 之后、PR head 定稿之前**记录 disposition（生命周期契约 §4c、plan 模板、knowledge skill、PM 序列）；迭代仍在 `iteration-close` 一次性完成。删除 "close-time promotion" 措辞并改为 "delivery-tail disposition"，把 "per-plan Done 从不触发" 与 "compound 不是 per-plan 活动" 限定到迭代行，合并 phase-gates 中重复的两段，并删除 plan 模板里已不存在的 "引擎在行 Done 前拒绝交付证据" 声明——该写入闸已移除，模板改为陈述 close 的咨询行为。
