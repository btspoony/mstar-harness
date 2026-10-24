# Phase 5 requires both review surfaces

**English**

Phase 5 (PR merge-ready) now treats an attached external AI review bot (Greptile, Bugbot or equivalent) as a second, independent review surface. Merge-ready and the merge authorization both require the internal PR loop's settled `ship it` **and** the external review settled green on the current head, with no unresolved blocking finding. A failing bot check is never green — retrigger it or obtain a written waiver naming the surface, finding and head.

**中文**

Phase 5（PR merge-ready）现在把附带的外部 AI review bot（Greptile、Bugbot 或同类）视为第二个独立 review 面。merge-ready 与合并授权都要求：自家 PR loop 在当前 head 上 settled 的 `ship it`，**并且** 外部 review 在当前 head 不失败、无未解决的 blocking finding。bot 检查失败不因基础设施原因视为通过——重触发，或取得写明 review 面、finding 与 head 的书面 waive。
