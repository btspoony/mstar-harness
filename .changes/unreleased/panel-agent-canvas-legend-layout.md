---
category: Harness
packages: root
---

- **dsh plugin**: agent-canvas legend + Phase layout simplification (plan `20260813-panel-agent-canvas-legend-layout`) — (1) the canvas **legend is simplified to the 3 role-card status entries** (`agent-running` running glow / `agent-settled` settled — the standalone GREEN done frame + ✓, never on off-tier roles / `agent-idle` idle dashed); the 7 collaboration-edge / layout entries (`flow-actual` / `port` / `group` / `sub-bucket` / `supervise` / `on-demand` / `unknown`) are removed from the legend copy (the canvas itself keeps the edges / ports / partitions — only the legend copy drops them); (2) the **Phase 1 / Phase 2 groups now sit SIDE BY SIDE** — Phase 1 (review-edit-chain) on the LEFT, Phase 2 (sdd-implement → qc-tri → qa-gate) on the RIGHT, top-aligned — instead of stacked top/bottom, saving vertical canvas space. Docs synced: dsh.md SSOT + bundle mirrors + README.md / README.zh.md / bundle/README.md.

<!-- CN -->
- **dsh 插件**：代理 canvas 图例精简 + Phase 布局优化（plan `20260813-panel-agent-canvas-legend-layout`）——(1) 图例**精简为 3 条角色卡状态条目**（`agent-running` 执行中发光 / `agent-settled` 已完成——独立绿框 + ✓，off 档角色不显示 / `agent-idle` 未工作虚线）；7 条协作边/布局技术条目（`flow-actual` / `port` / `group` / `sub-bucket` / `supervise` / `on-demand` / `unknown`）从图例文案移除（canvas 本身仍保留这些边/端口/分区——仅图例文案精简）；(2) **Phase 1 / Phase 2 两组改为左右并排**——Phase 1（review-edit-chain）在左、Phase 2（sdd-implement → qc-tri → qa-gate）在右，顶部对齐——取代原先的上下堆叠，显著节省纵向画布空间。文档同步：dsh.md SSOT + bundle 镜像 + README.md / README.zh.md / bundle/README.md。
