---
packages: root, cli, engine
---

- Added a **PR review time-budget system**: engine constant table `PR_REVIEW_TIER_BUDGETS` (wall-clock target + per-seat caps per tier) is the numeric SSOT, rendered as a budget block in `prReviewSeatPrompt` seat prompts.
- Added a **`mstar pr-review budget`** CLI command printing the per-tier budget table (`quick`/`default`/`deep`) for humans and drift checks.
- Added a **Budget column and a time-budget degradation ladder** (①read-depth ②seat topology ③display, with a never-degrade list) to `mstar-audit` PR-review prose and the `/amazing-pr-review` command.

<!-- CN -->
- 新增 **PR 评审时间预算体系**：engine 常量表 `PR_REVIEW_TIER_BUDGETS`（每档墙钟目标 + 席位上限）作为数字 SSOT，并在 `prReviewSeatPrompt` 席位提示中渲染预算块。
- 新增 **`mstar pr-review budget`** CLI 命令，打印 `quick`/`default`/`deep` 三档预算表，供人工查看与漂移检查。
- `mstar-audit` PR 评审文档与 `/amazing-pr-review` 命令新增 **Budget 列与时间预算降级阶梯**（①读深度 ②席位拓扑 ③展示，附永不降级清单）。
