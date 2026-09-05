---
packages: root, engine
---

- PR review synthesis now uses a **tiered three-way vet**: must-fix / should-fix findings get the full attack (counter-example, simpler explanation, evidence verifiability); nits get evidence-verify only (open the cited file, confirm `file:line` supports the claim). Domain seats keep their full three-way attack — tiering applies to the main-agent synthesis pass only.
- Stage 2 domain seats now return a **fixed findings block per finding** in the result payload — field names verbatim from `finding-format.md`, `Merge class` immediately after `Confidence` (lint-enforced), a one-line `Fix sketch` — staying lint-compatible with the single validator (`mstar lint --type finding --pr-variant` → `validateFindingDoc`), and declare truncated coverage in the payload tail when a budget cap stopped expansion.
- The posted review body gains a **soft cap (~150 lines)** triggering degradation ③ of the time-budget ladder: past the cap, nits fold into the summary body (display only — findings are never dropped) and the fold is declared in the report `- notes:`.
- Added an **optional `elapsed` field** to the PR-review report frontmatter: `validatePrReviewReport` accepts a non-negative integer minutes value (absent = valid for legacy reports; malformed = violation), and the `/amazing-pr-review` command records the start time at worktree-setup and writes the measured wall-clock minutes into the frontmatter.

<!-- CN -->
- PR 评审综合阶段改为**分层三向 vet**：must-fix / should-fix 走完整三向攻击（反例、更简解释、证据可验证）；nit 仅做证据核验（打开被引文件，确认 `file:line` 支撑论断）。领域席位保持完整三向攻击——分层仅作用于主代理综合阶段。
- Stage 2 领域席位现按**每条发现一块固定字段块**返回载荷——字段名与 `finding-format.md` 逐字一致，`Merge class` 紧跟 `Confidence`（lint 强制），`Fix sketch` 一行——保持与唯一校验器（`mstar lint --type finding --pr-variant` → `validateFindingDoc`）lint 兼容；预算上限截断扩展时在载荷尾部声明截断覆盖。
- 发布的评审正文新增**软上限（约 150 行）**，超出即触发时间预算阶梯的降级 ③：nit 折叠进摘要正文（仅展示层——发现绝不丢弃），并在报告 `- notes:` 中声明。
- PR 评审报告 frontmatter 新增**可选 `elapsed` 字段**：`validatePrReviewReport` 接受非负整数分钟（缺省对历史报告合法；格式非法即违规），`/amazing-pr-review` 命令在 worktree-setup 记录起始时间，并把实测墙钟分钟写入 frontmatter。
