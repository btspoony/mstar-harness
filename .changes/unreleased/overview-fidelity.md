---
category: Changed
packages: root,cli
---

- Restored the **issue-flow trend** to the Overview: two cumulative step lines drawn from
  `overview.issueFlow` (captured solid, retired dashed, so greyscale keeps them apart), the
  first/middle/last date axis, a legend carrying the dated and recorded open counts, the
  dated-history gap note, and the same buckets as a `Dated history` table in a disclosure. The
  read model never changed — only the view was missing. Fewer than two dated buckets renders the
  shared empty arm and a failed read renders the unavailable arm with the store's reason, so an
  empty chart is never drawn.
- Made the Overview **two columns above 900px**, `minmax(0, 1.85fr) minmax(0, 1fr)` as the
  prototype has it: work and its trend left, residuals and milestones right, the latest iteration
  across both. Below the floor it is the sidebar's single run in the same order. The previous
  single-column form was read from the prototype's narrow presentation.
- Extended the render gate: the column ratio at 1900 and 1280, the fold at 720, the trend's two
  series and its text alternative, and an unavailable flow member rendering the unavailable arm.

<!-- CN -->
- Overview 恢复**问题走势**：两条累计阶梯线由 `overview.issueFlow` 绘制（捕获实线、退役虚线，灰度下仍可区分），含首/中/末日期轴、带「有日期未关闭 / 记录未关闭」两个计数的图例、有日期差距说明，以及同一批 bucket 的 `有日期历史` 表格（折叠展示）。读模型从未改变，缺的只是视图。有日期 bucket 少于两个时走共享 empty 臂，读取失败时走 unavailable 臂并带上 store 的原因，绝不画空图。
- Overview 在 900px 以上改为**两列** `minmax(0, 1.85fr) minmax(0, 1fr)`：工作与其走势在左，遗留项与里程碑在右，最近迭代横跨两列；窄于阈值时按同一阅读顺序回到侧栏单列。此前的单列形态来自原型的窄屏呈现。
- 渲染门新增：1900 与 1280 的列比例、720 的折行、走势的两条线与文本替代、以及 flow 成员不可用时渲染 unavailable 臂。
