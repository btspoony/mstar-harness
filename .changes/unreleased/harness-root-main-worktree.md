---
category: Harness
packages: root, cli, engine, commands
---

- **Harness roots resolve from the main worktree only.** `resolveHarnessDir` no longer adopts a linked worktree's tracked `.mstarc` copy: a start path whose Git checkout differs from the main worktree resolves through the main root, so a worktree can never look like a process root. Subdirectories of the main checkout keep their existing upward rungs, and `opts.localProbe` keeps the local probe for callers that ask about the caller checkout itself.
- **Tracked results follow the caller's checkout.** `resolveTrackedResultDir` (used by `mstar path resolve`, `mstar path check` and the catalog) computes the target as the main checkout sees it, then applies that repo-relative path to the caller's checkout when Git does not ignore it there. Gitignored targets, targets inside the harness dir, and another repository's checkout stay on the main one. `StoreContext` gained an optional `checkoutRoot` for catalog roots.

<!-- CN -->
- **harness 根只从主 worktree 解析。** `resolveHarnessDir` 不再采用 linked worktree 里被跟踪的 `.mstarc` 副本：起点所在的 Git checkout 与主 worktree 不同时经主根解析，worktree 不会再被当成进程根。主 checkout 的子目录保持原有向上探测阶梯，`opts.localProbe` 保留"只看调用方 checkout"的本地探测。
- **tracked 结果跟随调用方 checkout。** `resolveTrackedResultDir`（`mstar path resolve`、`mstar path check` 与 catalog 使用）先按主 checkout 计算目标，再在该路径未被 Git 忽略时映射到调用方 checkout；被忽略的目标、harness 目录内的目标，以及另一仓库的 checkout 都留在主 checkout。`StoreContext` 新增可选 `checkoutRoot` 供 catalog 根使用。
