---
category: Harness
packages: root
---

- **A repeated `neutral` has no authorization exit, and the §5.3 policy re-record is an escalation, not one.** The §5.1b conclusion matrix and the §5.3 `reviewed-bot` STOP bullet now say what a re-record actually does: it changes which gate governs the PR, while an attached bot's own passing bar keeps applying under `reviewed-auto` and `owner-gated` and detaching it to reach merge-ready stays forbidden — so the head still needs a real bot verdict. The only ways to proceed are a new head carrying real content or the bot's documented retrigger; a bare `neutral` has no finding or score to waive.

<!-- CN -->
- **重复 `neutral` 没有任何授权出口，§5.3 的 policy 重录是升级而非授权。** §5.1b 结论矩阵与 §5.3 的 `reviewed-bot` STOP 条目现在写明重录的实际作用：它改变的是门禁归属，而挂载 bot 自身的通过线在 `reviewed-auto` 与 `owner-gated` 下依旧适用、为达成 merge-ready 而脱离它仍被禁止——该 head 因此仍需要一个真实 bot verdict。可推进的路径只有含真实内容的新 head，或按 bot 文档化方式重触发；裸 `neutral` 没有 finding 或分数可 waive。
