---
category: Added
packages: root, engine, commands
---

- **PR-review seat prompts are dispatched with the tier and the shared time budget.** `mstar pr-review seat-prompt` now opens each seat's `## Budget` block with the resolved tier and the **whole-review** soft wall-clock cap (`PR_REVIEW_TIER_BUDGETS[tier].wallClockMinutes`) plus, when given, the minutes left of that one clock at dispatch (`--remaining-minutes <n>` — negative renders as minutes *over*). A seat is never handed a fresh per-seat allowance, and the soft-cap bullet promises a partial return with declared truncated coverage at the deadline instead of a hard stop.
- **Seat supervision while seats run.** New engine constant `PR_REVIEW_NUDGE_CADENCE` (`normalSeconds` / `overrunSeconds`), printed by `mstar pr-review budget` alongside the tier table, gives the main agent one cadence to nudge still-running seats with their remaining budget — the faster tick once the shared cap is passed. The wording (dispatch, nudge, stop-at-completion, overrun-is-not-a-kill, and the host difference where seats cannot be messaged mid-run — the dsh `mstar-pr-seats` script now requires an explicit `budgetLine`, refusing without the recovery text) lives in `mstar-audit` `references/pr-review.md` **§ Seat supervision (progress nudges)**; `commands/amazing-pr-review.md` requires the loop in its Execute steps.

<!-- CN -->
- **PR review 席位 prompt 现在带上强度与共享时间预算。** `mstar pr-review seat-prompt` 在每个席位的 `## Budget` 块开头给出已解析 tier、**整场 review** 的墙钟软上限（`PR_REVIEW_TIER_BUDGETS[tier].wallClockMinutes`），并在提供时给出派发时刻这只共享时钟的剩余分钟（`--remaining-minutes <n>`，负值渲染为已超出分钟数）。席位不再各自获得一份新额度；软上限条目约定到点返回部分结果并在 payload 尾部声明截断，而不是硬停。
- **席位运行期间的监督。** 新增 engine 常量 `PR_REVIEW_NUDGE_CADENCE`（`normalSeconds` / `overrunSeconds`），由 `mstar pr-review budget` 与 tier 表一并打印，为主 agent 提供统一节奏向仍在运行的席位催办剩余预算——共享上限过后切换到更快节奏。措辞（派发、催办、返回即停、超时不等于硬停，以及席位无法中途投递消息的 host 差异——dsh 的 `mstar-pr-seats` 脚本现在要求显式 `budgetLine`，缺失即拒绝并给出恢复文本）位于 `mstar-audit` `references/pr-review.md` 的 **§ Seat supervision (progress nudges)**；`commands/amazing-pr-review.md` 在 Execute 步骤中要求执行该循环。
