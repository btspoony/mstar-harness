---
packages: root, engine
---

- **A historical iteration's missing compass no longer reads as a current failure, and the overview absence notice is a bounded summary.** The projection excludes a missing compass from its required source set only when the owning iteration is positively historical — catalog-archived/superseded, or its authoritative iteration workflow is terminal and no longer actively registered. An actively registered iteration still reports, unknown or not-yet-executing iterations stay required, and invalid/inaccessible compasses stay errors. The overview now states a distinct affected/missing source count, at most three named sources and how many are not named, in both locales; raw diagnostic messages, internal paths and unbounded lists never reach the notice.

<!-- CN -->
- **已归档迭代缺失的 compass 不再被渲染成当前失败，总览页的缺失通知改为有界摘要。** 仅当所属迭代可确证为历史（catalog 已归档/已取代，或对应权威迭代 workflow 已终止且不再活跃注册）时，投影才把缺失 compass 从必需来源集合中排除；仍活跃注册的迭代照常报错，未知或尚未执行的迭代仍为必需，invalid/inaccessible 仍报错。总览页现在只给出受影响/缺失来源的去重计数、至多三个具名来源与未列出的数量，两种语言均如此；原始诊断消息、内部路径与无界列表不再进入该通知。
