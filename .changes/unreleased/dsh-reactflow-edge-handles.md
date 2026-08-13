---
packages: root
---

- **dsh plugin**: fixed ReactFlow v12 silently dropping every edge whose endpoint node exposes no connection-point `<Handle>` — all 17 graph edges (phase ring 5 + state machine 5 + connector 1 + pipeline 6) render again in the real browser.

<!-- CN -->
- **dsh 插件**：修复 ReactFlow v12 自定义节点缺 Handle 导致边被静默丢弃的问题——整图 17 条边（阶段环 5 + 状态机 5 + connector 1 + pipeline 6）在真实浏览器中全部恢复渲染。
