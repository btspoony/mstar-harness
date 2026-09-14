---
category: Fixed
packages: root, cli
---

- `mstar worktree cleanup` no longer aborts on an unrelated workflow's broken snapshot, and no longer drops that snapshot's safeguards. A sibling whose JSON parses but fails validation enters the safety set in **degraded form** — only protective declarations survive (branch base/integration/target, lifecycle worktree path, merge/execution leases, row ownership metadata) with lifecycle and row states forced non-terminal, so it can only ADD keep/refuse verdicts. A sibling that cannot be parsed at all leaves the safety set incomplete, so every removal is withheld as `cleanup.refuse.unreadable-snapshot` (the plan still prints whole) unless the operator asserts `--ignore-unreadable-snapshots`. The selected snapshot stays fail-loud (exit 1), and no broken snapshot is ever repaired, rewritten or removed. Contract documented in `mstar-branch-worktree`「Worktree / branch cleanup」.

<!-- CN -->
- `mstar worktree cleanup` 不再因**无关** workflow 的坏 snapshot 而中止，也不再丢失该 snapshot 的护栏。JSON 可解析但校验失败的 sibling 以**降级形态**进入安全集——只保留具保护性的声明（`branch.base`/`integration`/`target`、lifecycle worktree path、merge/execution lease、行 ownership 元数据），并把 lifecycle 与行状态一律强制为非终态，因此只会**增加** keep/refuse 判定。完全无法解析的 sibling 使安全集信息不完整，故默认 **withhold 全部 remove**（改判 `cleanup.refuse.unreadable-snapshot`，plan 仍完整打印），除非操作者给出 `--ignore-unreadable-snapshots` 断言。选中 snapshot 仍 fail-loud（exit 1），坏 snapshot 的字节永不被修复、改写或删除。契约见 `mstar-branch-worktree`「Worktree / branch cleanup」。
