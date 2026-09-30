---
category: Harness
packages: root
---

- Added **architect design minimality through ablation**: remove proposed components unless their removal breaks a named, confirmed requirement (including the approved long-term target state or recorded non-functional constraints); record one evidence line for each non-obvious retained component. Keep the smallest design aligned with the long-term target state, not a temporary hack.
- Authorized **architecture template pruning**: mark sections inapplicable at the task's scale as `N/A — <one-line reason>` in both Prepare & Plan and Architecture Spec outputs instead of inventing filler; reference `mstar-coding-behavior` §2 for the implementation-level playbook.

<!-- CN -->
- 新增**架构师的消融式设计最小化纪律**：若移除候选组件不会破坏已确认且明确具名的需求（含已批准的长期目标态或已记录的非功能约束），则删除该组件；为每个非显然必要的保留组件记录一行证据。最小设计仍须对齐长期目标状态，而非临时补丁。
- 授权**裁剪架构输出模板**：在 Prepare & Plan 和 Architecture Spec 两类输出中，将不适用于当前任务规模的章节标记为 `N/A — <one-line reason>`，不编造填充内容；实现层操作指引引用 `mstar-coding-behavior` §2。
