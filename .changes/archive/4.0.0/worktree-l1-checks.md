---
category: Harness
packages: root, cli, engine, commands, omp
---

- **L1 worktree ownership:** ignore a row claiming the recorded main-worktree branch when checking residency and identify the owning workflow and plan for real ownership conflicts.
- **Plan preparation:** refuse to use the control checkout's current branch for any plan row, including report-only workflows, and fail closed when that branch cannot be resolved.
- **L1 worktree checks** now derive workflow, plan, lease, and lifecycle-branch inputs from the ACTIVE execution authority graph instead of retired snapshots and sibling scans.
- **Sibling worktree root**: moved the default for feature/L2 worktrees and `pr-review worktree-setup` to `<parent>/<repo>.worktrees/`, outside the checkout. The repository root is the realpath of the Git top-level; in-repo `.worktrees/` remains a legal manual/override location. Removed the default setup's `.git/info/exclude` append, which is obsolete outside the repository.
- **Convention alignment**: updated the skills and `AGENTS.md` to teach the sibling-root convention, keeping linked checkouts out of the repository scan/edit surface and permission guidance independent of cwd or unverified glob semantics.
- Added an **executor-side worktree checkout gate**: when an Assignment carries `Worktree path`, leaf roles must `cd` there and verify the checkout root with `git rev-parse --show-toplevel` before the first repo write or commit, and disclose `Worktree path used` (absolute) in the Completion Report — closing the gap where subagents inherited the primary checkout and wrote product files into it.
- Updated `mstar-branch-worktree` (可写角色执行规则 + 回报要求), the shared `mstar-roles/references/_shared/leaf-executor-core.md` Git NEVER block, and the `frontend-dev` / `ops-engineer` role files to match the existing `fullstack-dev-shared.md` instruction.
- Fixed worktree cleanup attribution after stopped and failed (cancelled-terminal) registrations are superseded: the terminal owner no longer makes a shared worktree/branch appear foreign. The real-store dry-run now plans the merged worktree for removal; branch deletion remains deferred until the worktree is removed and cleanup is replanned.
- **Safer worktree cleanup ownership:** Completion retains the plan's exact branch and worktree path after lease release. Cleanup can also recover a claim from a valid completed Done-row handoff; degraded parseable snapshots preserve handoff resources as protective, nonterminal metadata but never authorize removal. Unreadable snapshots withhold removals unless explicitly ignored. Applying cleanup re-plans after deferred integration worktrees are removed before deleting newly-unchecked-out branches. Ambiguous ownership still refuses removal.
- **Ignored-content cleanup:** Ignored-only files no longer make a worktree dirty for cleanup. Applying an eligible removal deletes those ignored files without a Git recovery backstop; tracked changes and non-ignored untracked files still block removal, and cleanup never forces it.

<!-- CN -->
- **L1 worktree 所有权：** 检查驻留状态时忽略声明为已记录主工作树分支的计划行；真实所有权冲突会指出所属 workflow 与计划。
- **计划准备：** 禁止任何计划行使用控制检出的当前分支（包括仅报告工作流）；无法解析该分支时也会安全拒绝。
- **L1 worktree 检查**现在从 ACTIVE 执行权限图派生 workflow、plan、lease 和生命周期分支输入，不再读取已退役快照或扫描兄弟快照。
- **同级 worktree 根目录**：feature/L2 worktree 与 `pr-review worktree-setup` 的默认位置改为 checkout 外的 `<parent>/<repo>.worktrees/`。仓库根目录为 Git top-level 的 realpath；仓库内 `.worktrees/` 仍是合法的手动或覆盖位置。移除默认创建流程对 `.git/info/exclude` 的追加，因为仓库外的位置不再需要它。
- **约定对齐**：更新 skills 与 `AGENTS.md`，统一教授同级根目录约定，避免仓库扫描或编辑触及 linked checkout，并使权限指导不依赖 cwd 或未经验证的 glob 解析语义。
- 新增**承接方侧 worktree 检出门禁**：Assignment 含 `Worktree path` 时，leaf 角色须在首次仓库写入或提交前 `cd` 到该目录并用 `git rev-parse --show-toplevel` 校验检出根一致，并在 Completion Report 回报 `Worktree path used`（绝对路径）——修复 subagent 继承宿主 cwd 而误写 primary checkout 的缺口。
- 更新 `mstar-branch-worktree`（可写角色执行规则 + 回报要求）、共享块 `mstar-roles/references/_shared/leaf-executor-core.md` Git NEVER 段，以及 `frontend-dev` / `ops-engineer` 角色文件，与既有 `fullstack-dev-shared.md` 指令对齐。
- 修复停止和失败（终态取消）的注册被新注册取代后的 worktree cleanup 归属判定：终态 owner 不再导致共享 worktree/branch 被误判为 foreign。真实存储 dry-run 现在会将已合并的 worktree 规划为移除；分支删除仍须等 worktree 移除后重新规划。
- **更可靠的工作树回收归属：** 完成计划时，在释放租约后仍保留其准确的分支与工作树路径。回收也可从有效的已完成 Done 行交接记录恢复归属；可解析但无效的快照会将交接资源保留为保护性、非终态元数据，但绝不授权删除。除非显式忽略，否则无法读取的快照会阻止删除。执行回收时，在移除延后处理的集成工作树后重新规划，再删除因此解除检出的分支。归属冲突仍拒绝移除。
- **忽略文件的回收：** 仅有被忽略文件时，工作树不再被判为脏。执行符合条件的移除会删除这些文件，且 Git 不提供恢复保障；已跟踪改动和非忽略的未跟踪文件仍阻止移除，回收绝不强制执行。
