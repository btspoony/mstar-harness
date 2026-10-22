---
category: Harness
packages: root
---

- Added **`mstar-pr-loop`**, an opt-in review → fix loop for an existing ready PR, with tally-derived verdict transitions, isolated fix worktrees and idle-wave push discipline. It is not an automatic plan/iteration step.
- Registered the skill in the core, PM preset and runtime-reference discovery tables; reused existing review and delivery contracts without adding a command or changing the engine or CLI.

<!-- CN -->
- 新增 **`mstar-pr-loop`**：仅在用户显式请求时，为已有 ready PR 执行评审 → 修复循环，遵循 tally 派生结论、隔离修复 worktree 和波次空闲后推送纪律；不会自动进入 plan/iteration 流程。
- 在核心索引、PM preset 与运行时参考表中登记该 skill；复用现有评审和交付契约，不新增 command，也不修改 engine 或 CLI。
