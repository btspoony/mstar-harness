---
category: Harness
packages: root
---

- **Safer worktree cleanup ownership:** Completion retains the plan's exact branch and worktree path after lease release. Cleanup can also recover a claim from a valid completed Done-row handoff; degraded parseable snapshots preserve handoff resources as protective, nonterminal metadata but never authorize removal. Unreadable snapshots withhold removals unless explicitly ignored. Applying cleanup re-plans after deferred integration worktrees are removed before deleting newly-unchecked-out branches. Ambiguous ownership still refuses removal.
- **Ignored-content cleanup:** Ignored-only files no longer make a worktree dirty for cleanup. Applying an eligible removal deletes those ignored files without a Git recovery backstop; tracked changes and non-ignored untracked files still block removal, and cleanup never forces it.

<!-- CN -->
- **更可靠的工作树回收归属：** 完成计划时，在释放租约后仍保留其准确的分支与工作树路径。回收也可从有效的已完成 Done 行交接记录恢复归属；可解析但无效的快照会将交接资源保留为保护性、非终态元数据，但绝不授权删除。除非显式忽略，否则无法读取的快照会阻止删除。执行回收时，在移除延后处理的集成工作树后重新规划，再删除因此解除检出的分支。归属冲突仍拒绝移除。
- **忽略文件的回收：** 仅有被忽略文件时，工作树不再被判为脏。执行符合条件的移除会删除这些文件，且 Git 不提供恢复保障；已跟踪改动和非忽略的未跟踪文件仍阻止移除，回收绝不强制执行。
