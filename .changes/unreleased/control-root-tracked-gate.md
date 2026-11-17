---
category: Harness
packages: root
---

- **Control root tracked-change gate** — writable dispatches and `mstar worktree check --control-clean` now refuse while the Git main worktree (control root) carries committable changes (`worktree.main.tracked-changes`, untracked files included); tracked corpus writes belong to the checkout that carries the target branch, the check takes no other selector, and a control root that resolves no `{HARNESS_DIR}` skips it.

<!-- CN -->
- **控制根跟踪变更门禁** —— 当 Git 主工作树（控制根）存在可提交变更（含未跟踪文件）时，可写派发与 `mstar worktree check --control-clean` 现在会拒绝（`worktree.main.tracked-changes`）；跟踪语料写入属于承载目标分支的检出，该检查不接受其他选择器，解析不到 `{HARNESS_DIR}` 的控制根跳过检查。
