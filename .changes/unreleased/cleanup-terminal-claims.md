---
category: Fixed
packages: cli
---

- Fixed worktree cleanup attribution after stopped and failed (cancelled-terminal) registrations are superseded: the terminal owner no longer makes a shared worktree/branch appear foreign. The real-store dry-run now plans the merged worktree for removal; branch deletion remains deferred until the worktree is removed and cleanup is replanned.

<!-- CN -->
- 修复停止和失败（终态取消）的注册被新注册取代后的 worktree cleanup 归属判定：终态 owner 不再导致共享 worktree/branch 被误判为 foreign。真实存储 dry-run 现在会将已合并的 worktree 规划为移除；分支删除仍须等 worktree 移除后重新规划。
