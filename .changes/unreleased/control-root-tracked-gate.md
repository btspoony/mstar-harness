---
category: Harness
packages: root
---

- **Control root tracked-change gate** — writable dispatches and `mstar worktree check --control-clean` now refuse while the Git main worktree (control root) carries committable changes (`worktree.main.tracked-changes`); tracked corpus writes belong to the checkout that carries the target branch, and a repository with no harness skips the check.

<!-- CN -->
- **控制根跟踪变更门禁** —— 当 Git 主工作树（控制根）存在可提交变更时，可写派发与 `mstar worktree check --control-clean` 现在会拒绝（`worktree.main.tracked-changes`）；跟踪语料写入属于承载目标分支的检出，无 harness 的仓库跳过该检查。
