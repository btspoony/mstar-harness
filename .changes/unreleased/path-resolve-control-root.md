---
category: Harness
packages: root
---

- **`mstar path resolve` reports the control facts.** Alongside the local probe it now returns `controlRoot` (the Git main worktree), `controlHarnessDir` (that checkout's `{HARNESS_DIR}`, or `null`) and `linkedWorktree`. Inside a linked worktree the top-level members are the effective answers — `harnessDir` and the four directory members resolve from the control root — and the checkout's own probe stays under `local`; the non-Git / independent-repository answers are unchanged. When a linked checkout's main worktree cannot be read, the command **refuses** (`coordination.not-in-git`, exit 1) and carries the cause as `controlUnavailable` in the refusal details — it never falls back to the local probe. The discovery path is published in `mstar-conventions`, `mstar-use-cli/references/preconditions.md`, and `mstar-branch-worktree`.

<!-- CN -->
- **`mstar path resolve` 现在报告 control 事实。** 除本地探测结果外，它新增 `controlRoot`（Git 主 worktree）、`controlHarnessDir`（该检出的 `{HARNESS_DIR}`，或 `null`）与 `linkedWorktree`。在 linked worktree 中，顶层成员即生效答案——`harnessDir` 与四个目录成员均从 control root 解析——本 checkout 自身的探测留在 `local` 下；非 Git 与独立仓库的答案与以往一致。当 linked checkout 的主 worktree 不可读时，命令**拒绝**（`coordination.not-in-git`，exit 1），原因以 `controlUnavailable` 放在拒绝的 details 中——绝不回退到本地探测。发现路径已写入 `mstar-conventions`、`mstar-use-cli/references/preconditions.md` 与 `mstar-branch-worktree`。
