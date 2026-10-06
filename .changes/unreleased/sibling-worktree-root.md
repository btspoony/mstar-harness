---
category: Harness
packages: root
---

- **Sibling worktree root**: moved the default for feature/L2 worktrees and `pr-review worktree-setup` to `<parent>/<repo>.worktrees/`, outside the checkout. The repository root is the realpath of the Git top-level; in-repo `.worktrees/` remains a legal manual/override location. Removed the default setup's `.git/info/exclude` append, which is obsolete outside the repository.
- **Convention alignment**: updated the skills and `AGENTS.md` to teach the sibling-root convention, keeping linked checkouts out of the repository scan/edit surface and permission guidance independent of cwd or unverified glob semantics.

<!-- CN -->
- **同级 worktree 根目录**：feature/L2 worktree 与 `pr-review worktree-setup` 的默认位置改为 checkout 外的 `<parent>/<repo>.worktrees/`。仓库根目录为 Git top-level 的 realpath；仓库内 `.worktrees/` 仍是合法的手动或覆盖位置。移除默认创建流程对 `.git/info/exclude` 的追加，因为仓库外的位置不再需要它。
- **约定对齐**：更新 skills 与 `AGENTS.md`，统一教授同级根目录约定，避免仓库扫描或编辑触及 linked checkout，并使权限指导不依赖 cwd 或未经验证的 glob 解析语义。
