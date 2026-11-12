---
packages: engine
---

- **Label discovery follows the listing cursor**: `discoverLabels` reads every page the
  provider advertises (`hasNextPage` + `cursor`) instead of trusting a single 250-row page, so a
  workspace with more labels than one page no longer reports a false `linear.label-unresolved`
  for a label that exists. The walk stops at 20 pages and refuses by that same
  `linear.label-unresolved` code when more pages remain, naming the bound rather than resolving
  items against a set it knows is truncated.

<!-- CN -->
- **标签发现跟随列表游标**：`discoverLabels` 会读完提供方声明的所有页（`hasNextPage` + `cursor`），
  不再只信任单个 250 行页，标签数超过一页的工作区不会再对真实存在的标签误报
  `linear.label-unresolved`。遍历在 20 页处停止；仍有更多页时以同一
  `linear.label-unresolved` 码拒绝并指明该上限，而不是用明知不完整的集合去解析条目。
