---
category: Harness
packages: root
---

- **dsh plugin**: panel F4.2 agent-view layout (plan `20260811-panel-f4-agent-view`) — the 代理执行 canvas drops the standalone **general bucket column** (5 columns now: 4 stages + on-demand; `data-canvas-column` never emits `general`): the single `general` bucket card renders at the **bottom INSIDE the `sdd-implement` column** (stable partition — dev cards first, general card below — with a dashed separator + small in-bucket `general` label, idle placeholder preserved, `data-agent-bucket="general"`); the `sdd-implement` ↔ `general` **SDD loop back-edge is removed** — no more curved double-arrow below the column band and no `data-agent-edge-loop` anchor (`AgentEdge.loop` / `solveLoopBow` / `LOOP_BOW_MARGIN` / `GENERAL_COLUMN` dead code cleaned); the 3 forward skeleton arrows, in-column handoff arrows and the animated next edge are unchanged, and the on-demand column (ops-engineer / prompt-engineer) is untouched. Evidence-driven "dynamic lines" for the review cycle are a later roadmap iteration.

<!-- CN -->
- **dsh 插件**：面板 F4.2 代理视图布局（plan `20260811-panel-f4-agent-view`）——「代理执行」画布移除独立 **general 桶列**（现为 5 列：4 阶段 + on-demand；`data-canvas-column` 不再出现 `general`）：唯一 `general` 桶卡渲染于 **`sdd-implement` 桶内底部**（稳定分区——dev 卡在前、general 卡在后，虚线分隔 + 桶内小 `general` 标签，idle 占位保留，`data-agent-bucket="general"`）；`sdd-implement` ↔ `general` 的 **SDD 回环边移除**——列带下方不再绘制弯曲双向箭头、无 `data-agent-edge-loop` 锚点（`AgentEdge.loop` / `solveLoopBow` / `LOOP_BOW_MARGIN` / `GENERAL_COLUMN` 死代码清理）；3 条前向骨架箭头、同列交接箭头与带动画的 next 边不变，on-demand 桶（ops-engineer / prompt-engineer）不动。按真实派发证据的「动态线」为后续迭代路线。
