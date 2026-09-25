---
category: Harness
packages: root
---

- **Safer worktree cleanup ownership:** Completion retains the plan's exact branch and worktree path after lease release. Cleanup can also recover a claim from a valid completed Done-row handoff; degraded sibling handoffs protect resources but never authorize removal. Ambiguous ownership still refuses removal.
- **Ignored-content cleanup:** Ignored-only files no longer make a worktree dirty for cleanup. Applying an eligible removal deletes those ignored files without a Git recovery backstop; tracked changes and non-ignored untracked files still block removal, and cleanup never forces it.

<!-- CN -->
- **更可靠的工作树回收归属：** 完成计划时，在释放租约后仍保留其准确的分支与工作树路径。回收也可从有效的已完成 Done 行交接记录恢复归属；降级的同级快照交接声明只提供保护，不授权删除。归属冲突仍拒绝移除。
- **忽略文件的回收：** 仅有被忽略文件时，工作树不再被判为脏。执行符合条件的移除会删除这些文件，且 Git 不提供恢复保障；已跟踪改动和非忽略的未跟踪文件仍阻止移除，回收绝不强制执行。
