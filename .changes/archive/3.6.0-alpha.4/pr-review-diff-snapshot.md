---
packages: root, cli
---

- **PR review diff snapshot**: `mstar pr-review worktree-setup` now pins the review diff basis to a snapshot file beside the sidecar (`<parent-of-worktree>/.<wt-dirname>.prreview.diff`, printed as `diffFile` in setup output; `null` for `--diff` / `--working-tree` modes) so every Stage 1/2 seat reads one pinned diff instead of re-running git — `mstar pr-review seat-prompt` passes it through as `--diff-file` and the prompt gains a "read the pinned diff snapshot FIRST" ingredient; cleanup removes the snapshot with the sidecar, and snapshot capture is wrapped in the worktree rollback so a failed setup never orphans a worktree.
- **Worktree convention + ownership**: review worktrees now default under `<repoRoot>/.worktrees/review-…` (the `mstar-branch-worktree` convention; `.worktrees/` is added to `.git/info/exclude` when the target repo does not ignore it) instead of a sibling directory beside the repo, and `worktree-cleanup` only deletes files whose identity (dev/ino/mtime, link count) matches the snapshot recorded at setup — a replaced or foreign file at the snapshot path is left in place, and a pre-existing sidecar makes setup refuse with a `worktree-cleanup` hint instead of deleting it.

<!-- CN -->
- **PR review diff 快照**：`mstar pr-review worktree-setup` 现在把 review diff 基准固定为 sidecar 旁的快照文件（`<parent-of-worktree>/.<wt-dirname>.prreview.diff`，setup 输出以 `diffFile` 打印；`--diff` / `--working-tree` 模式为 `null`），使每个 Stage 1/2 seat 读取同一份固定 diff 而非重跑 git —— `mstar pr-review seat-prompt` 以 `--diff-file` 透传，prompt 增加「先读 pinned diff 快照」ingredient；cleanup 随 sidecar 一并删除快照，快照捕获纳入 worktree rollback，失败的 setup 不会遗留孤儿 worktree。
- **Worktree 约定与所有权**：review worktree 默认落在 `<repoRoot>/.worktrees/review-…`（`mstar-branch-worktree` 约定；目标仓库未忽略 `.worktrees/` 时自动写入 `.git/info/exclude`），不再用 repo 根的兄弟目录；`worktree-cleanup` 只删除身份（dev/ino/mtime、链接数）与 setup 记录一致的快照——路径上的替换文件或外来文件一律原地保留，已存在的 sidecar 会让 setup 拒绝并提示 `worktree-cleanup`，而不是删除它。
