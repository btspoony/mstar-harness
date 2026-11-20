---
category: Harness
packages: root, engine, cli, commands, omp, opencode, dsh
---

- **Fixed harness root:** `{HARNESS_DIR}` is now `<git main worktree root>/.mstar`, derived from Git only. `harness_dir` in `.mstarc`, `MSTAR_HARNESS_DIR`, and the legacy `.agents/` / `.plans/` / `plans/` candidates are retired; a declaration or a legacy-only checkout is refused with a named recovery (`mstar harness scaffold`, `mstar store upgrade`), and a CLI launch outside Git names the root with `--harness`.
- **MCP carries no connection root:** `mstar mcp --harness` and the environment no longer pin a repository. Every call that touches process state passes `harness` naming the fixed `<main worktree>/.mstar`; the server refuses a missing selector, a relative path, or a linked worktree's `.mstar`.
- **Scaffold** no longer writes `harness_dir`; a `.mstarc` it creates carries only the corpus and sub-directory keys that differ from the defaults.
- **PM root resolution:** the project-manager prompt resolves `controlHarnessDir` before reading or writing process state, so a session started in a linked worktree no longer looks for `store.db` under its own checkout.
- Decision record: `docs/adr/proposed/architecture/2026-11-20-fixed-harness-root.md`.

<!-- CN -->
- **固定 harness 根**：`{HARNESS_DIR}` 现为 `<git main worktree root>/.mstar`，只由 Git 派生。`.mstarc` 的 `harness_dir`、`MSTAR_HARNESS_DIR` 与 legacy `.agents/` / `.plans/` / `plans/` 候选全部退役；声明或仅有 legacy 目录的仓库按具名恢复拒绝（`mstar harness scaffold`、`mstar store upgrade`），Git 之外的 CLI 启动用 `--harness` 指定。
- **MCP 连接不再携带根**：`mstar mcp --harness` 与环境变量都不再指定仓库。每次触碰进程状态的调用都传 `harness` 指向固定的 `<main worktree>/.mstar`；服务端拒绝缺失选择器、相对路径或 linked worktree 的 `.mstar`。
- **scaffold** 不再写 `harness_dir`；它创建的 `.mstarc` 只写与默认不同的 corpus / 子目录键。
- **PM 根解析**：project-manager 提示词在读写进程状态前先解析 `controlHarnessDir`，在 linked worktree 中启动的会话不再去自己的目录找 `store.db`。
- 决策记录：`docs/adr/proposed/architecture/2026-11-20-fixed-harness-root.md`。
