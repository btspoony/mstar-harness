---
category: Harness
packages: root, engine
---

- **L1 worktree ownership:** ignore a row claiming the recorded main-worktree branch when checking residency and identify the owning workflow and plan for real ownership conflicts.
- **Plan preparation:** refuse to use the control checkout's current branch for any plan row, including report-only workflows, and fail closed when that branch cannot be resolved.

<!-- CN -->
- **L1 worktree 所有权：** 检查驻留状态时忽略声明为已记录主工作树分支的计划行；真实所有权冲突会指出所属 workflow 与计划。
- **计划准备：** 禁止任何计划行使用控制检出的当前分支（包括仅报告工作流）；无法解析该分支时也会安全拒绝。
