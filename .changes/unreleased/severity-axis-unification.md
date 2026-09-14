---
category: Harness
packages: root
---

- Unified the harness's blocking judgement behind one **reachability axis**: the cross-chain vocabulary table (register `severity` / audit Merge class / plan-QC report section / L2 task review) now lives in the register SSOT — `mstar-artifacts` `references/status-and-residuals.md` §5 Cross-chain vocabulary.
- `mstar-audit` `references/pr-review.md` § Merge class now qualifies `must-fix` as the same class as register `critical` (unsafe **and** reachable in the reviewed change) and places `should-fix` on the same axis (unreachable-unsafe / significant tech debt / substantive non-blocking), with a pointer to that table instead of a restated definition.
- Gave `Critical` / `Important` / `Minor` their missing definition at `mstar-roles` `references/code-reviewer.md` § Issue severity (Mode A) — thresholds keyed to the axis, `Critical`/`Important` as per-task fix-loop drivers, `Minor` handed to `## Minor (for plan QC)` — and pointed the L2 dispatch prompt (`mstar-sdd` `references/task-reviewer-prompt.md`) at it. Audit and PR-review modes keep classifying with the audit chain's Merge class.
- No enum, verdict rule, tally/score rule, tier or budget mechanic, or routing behaviour changed — labels remain projections of the one judgement.

<!-- CN -->
- 将 harness 的阻塞判定统一到同一条**可达性轴**：跨链词汇表（register `severity` / 审计 Merge class / plan-QC report section / L2 task review）落位到 register SSOT —— `mstar-artifacts` `references/status-and-residuals.md` §5 Cross-chain vocabulary。
- `mstar-audit` `references/pr-review.md` § Merge class 现将 `must-fix` 限定为与 register `critical` 同类（不安全**且**在本次审查变更中可达），并把 `should-fix` 置于同一轴上（不可达的不安全 / 显著技术债 / 实质性非阻塞），同时指向该表而非重述定义。
- 为 `Critical` / `Important` / `Minor` 补上缺失的定义（`mstar-roles` `references/code-reviewer.md` § Issue severity (Mode A)）：阈值对齐轴，`Critical`/`Important` 驱动 per-task 修复循环，`Minor` 交给 `## Minor (for plan QC)`；L2 派发提示词（`mstar-sdd` `references/task-reviewer-prompt.md`）指向该定义。审计与 PR review 模式仍用审计链的 Merge class 分类。
- 枚举、verdict 规则、tally/score 规则、tier 与 budget 机制、路由行为均未改变 —— 标签始终是同一判定的投影。
