---
category: Changed
packages: cli
---

- **The `plan` family purpose describes the surface, not one host's native tool.** The published line named `mstar_plan_bind`, which only one host mounts and which a model reading any other host's `tools/list` cannot call. It now says that `bind` writes the engine row only and that a host keeping its own ledger uses that host's own binding entry point — the same fact, without an id that is absent on the other surfaces publishing the family.
- **The published-surface budget test says what to do when it trips.** Its comment named the ceiling as a product decision but gave no procedure: measure the new surface in the checkout that holds the change, decide whether the growth is intended, and re-take the ceiling with that reason recorded — never silently raise the number to go green.

<!-- CN -->
- **`plan` family 的 purpose 描述的是这个表面，而不是某个宿主特有的工具。** 发布的那一行点名了 `mstar_plan_bind`，而只有某一个宿主挂载它；在其它宿主读 `tools/list` 的模型根本调不到。现在写明 `bind` 只写引擎行，宿主若自己维护 ledger 则用它自己的绑定入口——事实相同，但不再出现一个在发布同一 family 的其他表面上并不存在的 id。
- **发布面预算测试在触发时给出处置方式。** 其注释把 ceiling 称作产品决定，却没有说明怎么做：在承载该改动的检出里测量新表面，判断增长是否有意，并在记录理由后重取 ceiling——绝不为转绿而静默抬高数字。
