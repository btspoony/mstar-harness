---
packages: engine, root
---

- Replaced the refs-only completion witness with a **sealed Git proof** (`captureGitProofWitness` / `revalidateGitProofWitness`): canonical checkout/git/common-dir identity, `HEAD` and the refs it names, the index and its shared index, every tracked path's content/mode/symlink target, the directory listings a new untracked path changes, the merge/rebase sentinels and the loose/packed object inventory are all read before SQLite ownership.
- The DB completion re-reads that proof from the filesystem — no child process, no await — immediately before the completion transaction, so a worktree, index, untracked or object-store change inside the preflight→commit window refuses without a `Done`, a receipt or a released lease. A nested-repository or alternate-object-store topology refuses instead of producing a weaker proof.

<!-- CN -->
- 以 **sealed Git proof**（`captureGitProofWitness` / `revalidateGitProofWitness`）取代仅比对 ref 的完成态见证：canonical checkout/git/common-dir 身份、`HEAD` 及其指向的 ref、index 与其 shared index、每条 tracked 路径的内容/模式/符号链接目标、新 untracked 文件会改变的目录条目清单、merge/rebase 哨兵文件，以及 loose/packed 对象清单，全部在取得 SQLite 归属前读取。
- DB 完成在提交事务前**仅从文件系统**重读该证明（无子进程、无 await）：preflight 到 commit 之间工作树、index、untracked 或对象库的任何变化都会被拒绝，不产生 `Done`、回执或释放租约；嵌套仓库或 alternate 对象库拓扑直接拒绝，而不是给出更弱的证明。
