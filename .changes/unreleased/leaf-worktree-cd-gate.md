---
category: Harness
packages: root
---

- Added an **executor-side worktree checkout gate**: when an Assignment carries `Worktree path`, leaf roles must `cd` there and verify the checkout root with `git rev-parse --show-toplevel` before the first repo write or commit, and disclose `Worktree path used` (absolute) in the Completion Report — closing the gap where subagents inherited the primary checkout and wrote product files into it.
- Updated `mstar-branch-worktree` (可写角色执行规则 + 回报要求), the shared `mstar-roles/references/_shared/leaf-executor-core.md` Git NEVER block, and the `frontend-dev` / `ops-engineer` role files to match the existing `fullstack-dev-shared.md` instruction.

<!-- CN -->
- 新增**承接方侧 worktree 检出门禁**：Assignment 含 `Worktree path` 时，leaf 角色须在首次仓库写入或提交前 `cd` 到该目录并用 `git rev-parse --show-toplevel` 校验检出根一致，并在 Completion Report 回报 `Worktree path used`（绝对路径）——修复 subagent 继承宿主 cwd 而误写 primary checkout 的缺口。
- 更新 `mstar-branch-worktree`（可写角色执行规则 + 回报要求）、共享块 `mstar-roles/references/_shared/leaf-executor-core.md` Git NEVER 段，以及 `frontend-dev` / `ops-engineer` 角色文件，与既有 `fullstack-dev-shared.md` 指令对齐。
