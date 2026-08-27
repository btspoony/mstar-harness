---
category: Harness
packages: root, opencode
---

- Reworked `amazing-pr-review` batch semantics to **one session = one PR**: when multiple PRs are passed in, only the **first** runs the full three-stage deep review; the rest are registered as audit todos in `{PROJECT_DIR}/_default/residuals.json` (`decision: defer`, `target: next session`, `tracking: pr-deep-review backlog`) and the report suggests opening one session per remaining PR. The old four-seat N/4 batch fan-out is removed.

<!-- CN -->
- 重构 `amazing-pr-review` 批量语义为**一个 session = 一个 PR**：传入多个 PR 时只对**第一个**执行完整三阶段深审；其余 PR 登记为 `{PROJECT_DIR}/_default/residuals.json` 中的 audit todos（`decision: defer`、`target: next session`、`tracking: pr-deep-review backlog`），并在报告中建议为每个剩余 PR 开独立 session。移除旧的四坐席 N/4 批量扇出模型。
