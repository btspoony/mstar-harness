---
category: Harness
packages: root, cli, commands, engine
---

- **PR-review score is now a diminishing-deduction score with bands.** `computePrTally` deducts per finding within a class — must-fix 45 then 15 each additional; should-fix `max(12 − 3·(n−1), 2)` → 12,9,6,3,2,2…; nit 2 then 1 each (class cap 8); unverified 5 each (class cap 15) — floors `score_pct` at 0, and annotates the result with a **score band**: `mergeable` ≥ 90 · `good` 80–89 · `pass` 60–79 · `fail` < 60. Verdict derivation is unchanged (count-driven, 3 tokens) and score/band never override it. New engine exports `PrScoreBand` / `PR_SCORE_BANDS` / `scoreBand()`; `PrTallyResult` gains `band`.
- The chat display header is now `{verdict} · {score_pct}% ({band})`, and the posted report's Verdict heading reads `· Score <score_pct>% (<band>)` — the derived number is labeled **Score** (the per-finding `- **Confidence**:` evidence field is a different concept and stays unchanged).
- `mstar pr-review validate-report` recomputes `score_pct` from the same locked schedule (no second formula), and `mstar.review/v1` envelopes accept an optional `tally.band` — absent stays valid, present must be a valid band token.
- Updated `mstar-audit/references/pr-review.md` (deduction schedule table, band definition, worked-example check table, display contract), `commands/amazing-pr-review.md` and `docs/commands.md`.

<!-- CN -->
- **PR 审查分数改为递减扣分制并引入分数档位。** `computePrTally` 按类内逐条发现递减扣分——must-fix 首条 45、此后每条 15；should-fix `max(12 − 3·(n−1), 2)` → 12,9,6,3,2,2…；nit 首条 2、此后每条 1（类上限 8）；unverified 每条 5（类上限 15）——`score_pct` 下限为 0，并为结果标注**分数档位**：`mergeable` ≥ 90 · `good` 80–89 · `pass` 60–79 · `fail` < 60。verdict 推导不变（按计数、三个 token），分数与档位永不覆盖 verdict。engine 新增导出 `PrScoreBand` / `PR_SCORE_BANDS` / `scoreBand()`；`PrTallyResult` 新增 `band`。
- chat 显示首行现为 `{verdict} · {score_pct}% ({band})`，GitHub 报告结论标题现为 `· Score <score_pct>% (<band>)`——该推导值标注为 **Score**（每条发现证据字段中的 `- **Confidence**:` 属另一概念，保持不变）。
- `mstar pr-review validate-report` 依据同一套锁定扣分表重算 `score_pct`（不存在第二套公式）；`mstar.review/v1` 信封接受可选的 `tally.band`——缺省仍合法，存在时必须是合法档位 token。
- 更新 `mstar-audit/references/pr-review.md`（扣分表、档位定义、worked-example 校验表、显示契约）、`commands/amazing-pr-review.md` 与 `docs/commands.md`。
