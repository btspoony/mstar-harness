---
category: Harness
packages: root
---

- **Phase 5 now requires the external AI review loop alongside the internal PR loop.** An attached review bot (Greptile, Bugbot or equivalent) is a second review surface with its own loop: it must reach its passing bar on the current head (Greptile: the 5/5 score), keep a non-failing check, and leave no unresolved blocking finding — in addition to the PR loop's settled, posted `ship it`. A `ship it` never waives an unresolved or sub-threshold external review, and a bot that is red blocks the merge even when the internal loop is green. A bot failure for infrastructure reasons is still not green — retrigger it or obtain a written waiver naming the surface, finding/score and head.

<!-- CN -->
- **Phase 5 现在要求外部 AI review loop 与自家 PR loop 同时满足。** 附带的 review bot（Greptile、Bugbot 或同类）是第二个 review 面，且是一个 loop：它必须在当前 head 上达到自身通过线（Greptile 为 5/5 分数）、检查不失败、且没有未解决的 blocking finding，此外还要有 PR loop 在当前 head 上 settled、已 posted 的 `ship it`。`ship it` 不能豁免未解决或未达线的外部结论；即使自家 loop 通过，bot 为红也不得 merge。因基础设施原因失败同样不算通过——需重新触发，或取得写明 review 面、finding/分数与 head 的书面 waive。
