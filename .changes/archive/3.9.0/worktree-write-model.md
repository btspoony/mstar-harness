---
category: Harness
packages: root
---

- Renamed the workflow-snapshot integration field `control_worktree_path` to **`integration_worktree_path`**: writers emit only the canonical key, the canonical reader accepts the v1 alias with a medium migration advisory (normalized in memory, never rewritten in place), strict validation refuses documents carrying both keys, and `mstar migrate` lifts the rename.
- **`mstar worktree check`** now validates main-worktree residency — the process SSOT (`status.json` / `workflows/`) resolves from the verified main worktree root and is never recorded in the snapshot.
- Renamed the `worktree check` flag `--control` to **`--integration`**; `--control` remains as a deprecated alias for one release (stderr migration notice).
- Cut the **dsh / omp / opencode** host surfaces (gates, tools, hooks) over to the canonical write model.
- Rewrote the runtime skill corpus to the **three-domain worktree write model** (control / feature / integration residency) and refreshed all bundled mirrors.

<!-- CN -->
- 工作流快照集成字段 `control_worktree_path` 更名为 **`integration_worktree_path`**：writer 只输出规范键；canonical reader 以 medium 迁移建议接受 v1 别名（仅内存归一化，绝不原地改写）；严格校验拒绝同时携带两键的文档；`mstar migrate` 完成更名迁移。
- **`mstar worktree check`** 现校验主 worktree 驻留——进程 SSOT（`status.json` / `workflows/`）从验证过的主 worktree 根解析，不再记录进快照。
- `worktree check` 旗标 `--control` 更名为 **`--integration`**；`--control` 作为弃用别名保留一个发布周期（stderr 迁移提示）。
- **dsh / omp / opencode** 宿主面（gates、tools、hooks）切换到规范写模型。
- 运行时技能语料改写为**三域 worktree 写模型**（control / feature / integration 驻留），并刷新全部打包镜像。
