---
category: Harness
packages: root
---

- Documented the **phase-transition `todo` refresh discipline** as a host-agnostic rule: refresh session todos at every phase/gate transition before the next action or dispatch, close only completed entries, preserve pending gates and seed the next phase — todos stay a projection of the snapshot/plan state, never a second store.

<!-- CN -->
- 将**阶段转换 `todo` 刷新纪律**沉淀为宿主无关规则：在每个阶段/门禁转换后、下一个动作或派发前刷新会话 todos，只关闭已完成条目，保留未决门禁并播种下一阶段——todos 始终是 snapshot/plan 状态的投影，不是第二状态存储。
