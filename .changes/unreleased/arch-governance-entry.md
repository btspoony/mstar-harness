---
category: Added
packages: root
---

- Added **`/codebase-arch-governance [path|subsystem] [dry-run] [rounds N]`**: converge a codebase toward the shape its current requirements would have produced, one closed batch at a time — lowest-total-complexity move, every caller migrated, the replaced path deleted in the same batch, the settled rule locked on the strongest available constraint. `dry-run` publishes the prioritised batches and their baseline without editing; `rounds N` (a positive integer, one by default) bounds the batches one invocation completes.
- Added `mstar-coding-behavior` → `references/architecture-governance.md` and a Decision Rules subsection that loads it: the seven properties with their existing owners, the closed-batch conditions, batch selection, rejected moves, and stop conditions — no second copy of the deep-module, constraint-ladder or issue-capture methods.
- Registered the command on every surface: `docs/commands.md`, the root README pair, `docs/runtime-reference.md`, and the Codex project-scope command skills.

<!-- CN -->
- 新增 **`/codebase-arch-governance [path|subsystem] [dry-run] [rounds N]`**：把代码库分闭环批次收敛到其当前需求本应产出的形态——每批只做总复杂度最低的改动，迁移全部调用方，在同一批次内删除被替代的实现，并把已确立的规则固化到当前可用的最强约束上。`dry-run` 只发布排序后的批次与基线，不改代码；`rounds N`（正整数，默认 1）限定一次调用可完成的批次数。
- 新增 `mstar-coding-behavior` → `references/architecture-governance.md` 及加载它的 Decision Rules 小节：七项属性及其既有 owner、批次收敛条件、批次选择、被拒改动与停止条件；deep-module、constraint-ladder 与 issue capture 的方法不再复制第二份。
- 该命令已登记到全部表面：`docs/commands.md`、根 README 双语对、`docs/runtime-reference.md`，以及 Codex 项目级命令 skill。
