---
category: Harness
packages: root, engine, commands
---

- **Per-call root validation:** a `persist` / `dashboard` `harness` selector inside a linked checkout is refused (`harness.root-not-main`) instead of writing process state the fixed-root resolver never reads; blank values stay absent and relative values resolve against the invocation cwd.
- **Cross-root json guard:** an absolute `json` key that targets another harness's `.mstar` / `.agents` / `.plans` documents is refused (`store.cross-root-refused`) rather than bypassing the selected root's authorization.
- **Linked scaffold guidance:** `harness scaffold` from a linked checkout now writes the main worktree's `.gitignore` snippet and `.agents/AGENTS.md`, matching the engine's main-worktree target.
- The validation applies to explicit selectors only: a retired `.mstarc` `harness_dir` and `MSTAR_HARNESS_DIR` are still parsed or read and ignored, never refused.
- Follow-up to the Devin / inspector findings on #780.

<!-- CN -->
- **按调用根校验**：`persist` / `dashboard` 的 `harness` 若指向 linked checkout 会被拒绝（`harness.root-not-main`），不再写入固定根解析器永远读不到的进程状态；空白值仍视为未提供，相对值按调用 cwd 解析。
- **跨根 json 防护**：指向另一个 harness 的 `.mstar` / `.agents` / `.plans` 文档的绝对 `json` key 会被拒绝（`store.cross-root-refused`），不能绕过所选根的授权。
- **linked scaffold 指引**：从 linked checkout 运行 `harness scaffold` 时，`.gitignore` 片段与 `.agents/AGENTS.md` 现在写到主 worktree，与 engine 的目标一致。
- 校验只作用于显式选择器：退役的 `.mstarc` `harness_dir` 与 `MSTAR_HARNESS_DIR` 仍只被解析/读取后忽略，不会报错。
- 这是 #780 上 Devin / inspector 发现的后续修复。
