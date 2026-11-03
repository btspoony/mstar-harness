---
category: Changed
packages: engine,root
---

- Added **`renderReviewMarkdown(review, { surface })`** to the engine: one layout owner for the `mstar.review/v1` envelope's `github-comment` and `local-report` bodies (verdict, tally, incomplete fact pair, findings by class).
- Removed the engine's fabricated review summary: `summary_md` is now an optional seat narrative, so no surface publishes the verdict header twice.
- Renamed the blank-narrative violation code **`review.missing-summary` → `review.blank-summary`**: a missing `summary_md` is legal now, so the code names the only condition it still reports (a present-but-empty value). Machine consumers keyed on the old code must switch.

<!-- CN -->
- 引擎新增 **`renderReviewMarkdown(review, { surface })`**：`mstar.review/v1` 信封的 `github-comment` 与 `local-report` 正文由同一布局所有者渲染（verdict、tally、incomplete 事实对、按类分组的 findings）。
- 移除引擎伪造的 review summary：`summary_md` 现在只是可选的席位叙述，各面不再重复发布 verdict 头。
- 空叙述的校验码由 **`review.missing-summary` 更名为 `review.blank-summary`**：缺少 `summary_md` 现已合法，该码只表示它仍在报告的唯一条条件（存在但为空）。依赖旧码的机器消费者需要同步切换。
