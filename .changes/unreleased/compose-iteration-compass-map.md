---
category: Changed
packages: engine
---

- The iteration views build one compass row map per read instead of scanning the projection per
  iteration: `readIterationList` builds `Map<iterationId, compass row>` once before the page loop, passes
  the row into `composeIteration`, and the membership helper reuses the same map. The list path no longer
  re-scans the compass rows for every row it composes, and `composeIteration` no longer calls `.find` on
  `generated.compasses`. First-row-wins semantics for a duplicated compass row are unchanged.

<!-- CN -->
- iteration 视图每次读取只构建一次 compass 行映射，不再按每个 iteration 扫描投影：`readIterationList`
  在分页循环前构建一次 `Map<iterationId, compass row>`，将行传入 `composeIteration`，membership 辅助函数复用
  同一映射。列表路径不再为它组合的每一行重扫 compass 行，`composeIteration` 也不再对
  `generated.compasses` 调用 `.find`。重复 compass 行的「首行胜出」语义保持不变。
