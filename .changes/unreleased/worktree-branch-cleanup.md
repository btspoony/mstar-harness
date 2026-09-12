---
packages: root, engine, cli
---

- Added the **guarded `mstar worktree cleanup` verb** with the pure `planWorktreeCleanup` engine planner: dry-run by default prints `verdict | kind | ref | reason` per worktree/branch candidate; `--apply` removes eligible worktrees (ordinary `git worktree remove`, never force), re-probes/re-plans, then deletes newly unchecked-out branches (`git branch -d`, never `-D`) and runs expected-OID `--force-with-lease` remote compare-and-delete. Active leases, branches checked out anywhere and foreign ownership refuse; protected refs are never removed (default and `branch.base` refs are kept, non-terminal owners refuse); merged evidence is a hard precondition (squash-only residue is retained and reported, never force-deleted).
- Wired the two cleanup timing lanes into the skill corpus: a new **`mstar-branch-worktree`「Worktree / branch cleanup」** contract home (ownership from snapshot row metadata/retained track Assignments or verified `--worktree` assertions — never naming inference), a same-round post-merge call in `mstar-iteration` Phase 2 (a Done plan is eligible while its parent iteration still runs), and the Phase 6 §6.4 call after terminal close + PR merged.
- Worktree dirtiness now counts ignored files: an ignored-content worktree (e.g. a local-only `.env`) is refused (`cleanup.refuse.dirty-worktree`) instead of being removed.

<!-- CN -->
- 新增**带守卫的 `mstar worktree cleanup` 命令**与纯函数 `planWorktreeCleanup` 引擎规划器：默认 dry-run 逐候选打印 `verdict | kind | ref | reason`；`--apply` 先以普通 `git worktree remove`（永不 force）移除 eligible worktree，重新探测/规划后删除现已未检出的分支（`git branch -d`，永不 `-D`），远端走 expected-OID `--force-with-lease` compare-and-delete。active lease、任意检出分支与 foreign 归属一律 refuse；protected refs 一律不移除（默认分支与 `branch.base` 为 keep，非终结 owner 为 refuse）；合并证据是硬前置（squash-only 残留保留并报告，绝不强删）。
- 将两条 cleanup 时序车道接入技能语料：新增 **`mstar-branch-worktree`「Worktree / branch cleanup」** 契约本体（归属来自 snapshot 行元数据/retained track Assignments 或已验证 `--worktree` 断言——禁止命名推断）、`mstar-iteration` Phase 2 的 merge 同轮调用（父迭代仍在运行即可回收 Done plan），以及 Phase 6 §6.4 在 terminal close + PR merged 后的调用。
- worktree 脏检查现在计入 ignored 文件：含 ignored 内容的 worktree（如本地独有 `.env`）会被拒绝（`cleanup.refuse.dirty-worktree`）而不是被移除。
