---
category: Harness
packages: root, cli, engine, commands
---

- **One bounded Git-probe implementation.** The path resolver, `path check`, the worktree checks and the host write gates now share `engine/src/git-probe.ts` instead of three divergent copies: `mainWorktreeRoot` parses `git worktree list --porcelain -z` (so a C-quoted path never yields a bogus root), `checkoutRoot` is the single `rev-parse --show-toplevel` probe, and `gitIgnored` keeps its explicit "Git could not answer" state. Every probe is bounded by `MSTAR_GIT_PROBE_TIMEOUT_MS`.
- **Probe failure is fail-closed.** `resolveHarnessDir` runs the main/checkout probes only where they can change the answer (`localProbe`/`workspaceRoot` short-circuit), and when the caller's checkout is known but the main root is unreadable it answers no harness root instead of silently adopting the worktree's own.
- **The catalog `repository` root follows the caller's checkout.** A linked-worktree invocation resolves `repository` in its own checkout (same repository only); `harness`, `plans` and `iterations` stay on the control checkout, so one catalog operation answers from one checkout.

<!-- CN -->
- **Git 探测收敛为一份实现。** 路径解析器、`path check`、worktree 检查与 host 写入门禁共用 `engine/src/git-probe.ts`，取代三份分歧副本：`mainWorktreeRoot` 解析 `git worktree list --porcelain -z`（C-quote 路径不再产生错误根），`checkoutRoot` 是唯一的 `rev-parse --show-toplevel` 探测，`gitIgnored` 保留明确的"Git 无法回答"状态。所有探测受 `MSTAR_GIT_PROBE_TIMEOUT_MS` 约束。
- **探测失败 fail-closed。** `resolveHarnessDir` 只在能改变答案时运行主根/checkout 探测（`localProbe`/`workspaceRoot` 短路）；当调用方 checkout 已知而主根不可读时返回无 harness 根，而不是静默采用 worktree 自身。
- **catalog 的 `repository` 根跟随调用方 checkout。** linked worktree 调用在同仓库时按自己的 checkout 解析 `repository`；`harness`、`plans`、`iterations` 仍在 control checkout，一次 catalog 操作只回答一个 checkout。
