---
category: Harness
packages: root
---

- **One bot-binding rule at every authorization site.** The `reviewed-bot` evidence cell, the Phase 5 exit checklist, and the §5.3 predicate now match §5.1b: every artifact the bot actually publishes binds to the head, only a bot that publishes the `publication:v1` marker needs the comment `sha=` and may inherit an empty increment, and a marker-less bot (Greptile) binds through its check's `head_sha` plus that check's own bound conclusion with no inheritance path; its score must come from a head-bound artifact, and an unbound score is unsettled.
- **A repeated-`neutral` waiver does not authorize merge.** A `neutral` head has no finding or score to waive, so the written waiver is a documented escalation only; the only authorization route after a repeated `neutral` is the Phase 1 `pr_merge_policy` re-record.

<!-- CN -->
- **所有授权点统一为一条 bot 绑定规则。** `reviewed-bot` 证据格、Phase 5 exit checklist 与 §5.3 谓词现与 §5.1b 一致：bot 实际发布的每个 artifact 都绑定当前 head；只有发布 `publication:v1` marker 的 bot 才需 comment `sha=`，才可继承空增量；无 marker 的 bot（Greptile）仅凭 check 的 `head_sha` 加该 check 自身绑定的 conclusion 绑定，没有继承路径；其分数须来自绑定该 head 的 artifact，未绑定的分数不算 settled。
- **重复 `neutral` 的 waive 不构成 merge 授权。** `neutral` 的 head 没有可被 waive 的 finding 或分数，书面 waive 仅是升级记录；重复 `neutral` 之后唯一的授权路径是 Phase 1 `pr_merge_policy` 重录。
