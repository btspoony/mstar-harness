---
category: Harness
packages: root
---

- **Dashboard roadmap is now a milestone board**: the roadmap page lays each project's milestones out as columns (one column per milestone, in store ordinal order) with that milestone's assigned issues as the items inside it — mono id, disposition badge and stored title — instead of the previous vertical card list. The project's unassigned issues appear as an explicit, named trailing column; the count is named on the no-milestones branch too, so it is never silently dropped.
- **Direction demoted below the board**: the content authority's Direction and the stored historical document now render as collapsed sections under the board, each keeping its own heading and its existing "content authority ≠ milestone data" wording. Catalog facts and the store/projection freshness block are unchanged, and a refused roadmap read still renders its notice — never an empty board, never the empty-milestones state.

<!-- CN -->
- **Dashboard roadmap 改为里程碑看板**：roadmap 页面按 store 的 ordinal 顺序为每个里程碑渲染一列，列内即该里程碑已关联的 issue 条目（mono id、disposition 徽标、存储标题），取代原先的纵向卡片列表。项目的未分配 issue 以显式命名的尾列呈现；在没有里程碑的分支上也会写出计数，不会静默丢弃。
- **Direction 降级到看板下方**：内容权威的 Direction 与存储的历史文档改为看板下方的折叠区块，各自保留标题与原有“内容权威 ≠ 里程碑数据”的措辞。Catalog 事实与 store/projection 新鲜度区块保持不变；roadmap 读取被拒绝时仍渲染其通知——既不渲染空看板，也不进入"无里程碑"状态。
