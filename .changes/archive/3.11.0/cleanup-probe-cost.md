---
category: Changed
packages: cli
---

- `mstar worktree cleanup` merge-evidence probing is now bounded: evidence bases resolve once, membership sweeps run at most once per distinct base OID with an immutable in-pass memo — no per-pair `merge-base --is-ancestor` spawns; `--verbose` adds per-pair ancestry diagnostics without changing candidates or decisions.
- The default candidate scope is now the selected workflow's recorded claims; pass `--all-workflows` for the previous full sweep, and `--worktree <path>` additionally narrows branch candidates to the asserted worktrees' exact recorded owners.

<!-- CN -->
- `mstar worktree cleanup` 的合并证据探测改为**有界**：证据 base 只解析一次，membership sweep 按去重后的 base OID 至多各跑一组，并在 pass 内使用不可变备忘录——不再逐对执行 `merge-base --is-ancestor`；`--verbose` 追加逐对 ancestry 诊断，不改变候选与判定。
- 默认候选范围收窄为**选中 workflow 的记录归属**；传 `--all-workflows` 恢复全量扫，`--worktree <path>` 额外把本地分支候选收窄到断言 worktree 的精确保留 owner。
