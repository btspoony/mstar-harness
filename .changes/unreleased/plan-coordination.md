---
category: Harness
packages: root
---

- Added the **`mstar plan` scoped coordination transport**: `bind` (coordinator / workflow+plan / Assignment / `--resume`), `show`, `prepare`, `progress`, `residual-add`, `residual-close`, `handoff`, `accept`, `return`, `integration-start`, `integration-accept`, `complete` and `reconcile`, with JSON on stdout, diagnostics on stderr and the `0` ok / `1` engine refusal / `2` usage exit contract.
- Scoped verbs pin the active `FsStore` to the engine's resolved root before every call, so a process inside a linked feature checkout resolves the **main worktree's** harness instead of its own `.mstar`.
- `mstar harness scaffold` awaits the now-async, store-routed engine bootstrap and pins the store root it resolves.

<!-- CN -->
- 新增 **`mstar plan` 计划级协调传输层**：`bind`（coordinator / workflow+plan / Assignment / `--resume`）、`show`、`prepare`、`progress`、`residual-add`、`residual-close`、`handoff`、`accept`、`return`、`integration-start`、`integration-accept`、`complete`、`reconcile`；JSON 走 stdout、诊断走 stderr，退出码为 `0` 成功 / `1` 引擎拒绝 / `2` 用法错误。
- 计划级动词在每次调用前把活动 `FsStore` 固定到引擎解析出的根，因此在 linked feature checkout 内运行的进程解析到的是**主 worktree** 的 harness，而不是本地 `.mstar`。
- `mstar harness scaffold` 现在 await 异步且 store 路由的引擎引导，并固定其解析出的 store 根。
