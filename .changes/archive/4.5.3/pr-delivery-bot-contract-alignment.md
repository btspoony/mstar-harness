---
category: Harness
packages: root
---

- **Head binding is per provider.** `reviewed-bot` no longer demands a `publication:v1 … sha=` marker from every bot: the bot check's `head_sha` plus that check's own bound conclusion always bind, and only a bot that publishes the marker must also match its comment `sha=`; a marker-less bot (Greptile) binds through its check alone and has no inheritance path.
- **The bot's passing bar applies under every policy.** The Phase 5 exit checklist now restates §5.3's per-bot bar for attached bots under `reviewed-auto` and `owner-gated` too — a non-failing check, a local `ship it`, or owner approval never substitutes for it.
- **A repeated `neutral` names its exits.** A second `neutral` on the same head points at the written waiver naming surface and exact head, or the Phase 1 `pr_merge_policy` re-record — no endless retriggering and no PM-issued waiver.

<!-- CN -->
- **Head 绑定按 provider 判定。** `reviewed-bot` 不再要求每个 bot 都发布 `publication:v1 … sha=` marker：bot check 的 `head_sha` 加该 check 自身绑定的 conclusion 始终构成绑定；只有确实发布 marker 的 bot 才需其 comment `sha=` 同样匹配；无 marker 的 bot（Greptile）仅凭 check 绑定，且没有继承路径。
- **bot 的通过线在所有 policy 下适用。** Phase 5 exit checklist 现以 §5.3 的逐 bot 通过线覆盖 `reviewed-auto` 与 `owner-gated`：一张「不失败」的 check、本地 `ship it` 或 owner 批准都不能替代它。
- **重复 `neutral` 必须点名出口。** 同一 head 上第二次 `neutral` 指向写明 surface 与确切 head 的书面 waive，或 Phase 1 `pr_merge_policy` 重新记录——不是无限重触发，也不是 PM 自签 waive。
