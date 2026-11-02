---
category: Harness
packages: root
---

- **`mstar path resolve` reports the control facts.** Alongside the local probe it now returns `controlRoot` (the Git main worktree), `controlHarnessDir` (that checkout's `{HARNESS_DIR}`, or `null`), `linkedWorktree`, and `controlUnavailable` when a linked checkout's main worktree cannot be read. Inside a linked worktree the four directory members resolve from the control root, and the start directory's own answers stay available under `local`; the local probe keeps its existing `harnessDir` meaning, and the non-Git / independent-repository answers are unchanged. The discovery path is published in `mstar-conventions`, `mstar-use-cli/references/preconditions.md`, and `mstar-branch-worktree`.

<!-- CN -->
- **`mstar path resolve` 现在报告 control 事实。** 除本地探测结果外，它新增 `controlRoot`（Git 主 worktree）、`controlHarnessDir`（该检出的 `{HARNESS_DIR}`，或 `null`）、`linkedWorktree`，以及主 worktree 不可读时的 `controlUnavailable`。在 linked worktree 中，四个目录成员从 control root 解析，起始目录自身的答案保留在 `local` 下；本地探测的 `harnessDir` 语义不变，非 Git 与独立仓库的答案也与以往一致。发现路径已写入 `mstar-conventions`、`mstar-use-cli/references/preconditions.md` 与 `mstar-branch-worktree`。
