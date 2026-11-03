---
category: Changed
packages: engine,root
---

- Added **`renderReviewMarkdown(review, { surface })`** to the engine: one layout owner for the `mstar.review/v1` envelope's body (verdict head, tally table, incomplete fact pair, `## 📋 Review`, `### Findings` in the envelope's impact order). Both `surface` values render that same template body — the option exists for caller compatibility, not to select a layout, because § Local report archive keeps the archived body identical to the posted one.
- The engine no longer **fabricates** a review summary. `summary_md` is an optional seat narrative: absent means no seat produced one, and a caller-supplied narrative is published verbatim — the engine neither strips nor duplicates it. A supplied value that is blank or not a string is a `TypeError` rather than a silent drop.
- Renamed the blank-narrative violation code **`review.missing-summary` → `review.blank-summary`**: a missing `summary_md` is legal now, so the code names the only condition it still reports (a present-but-empty value). Machine consumers keyed on the old code must switch.

<!-- CN -->
- 引擎新增 **`renderReviewMarkdown(review, { surface })`**：`mstar.review/v1` 信封的正文由同一布局所有者渲染（verdict 头、tally 表、incomplete 事实对、`## 📋 Review`、按信封影响序排列的 `### Findings`）。`surface` 的两个取值渲染同一个模板正文——该选项只为调用方兼容而保留，并不用于选择布局，因为 § Local report archive 要求归档正文与已发布正文逐字一致。
- 引擎不再**自行生成** review summary。`summary_md` 是可选的席位叙述：缺失即表示没有席位产出，调用方提供的叙述则原样发布——引擎既不会剥离也不会复制它。若提供的值为空白或非字符串，则抛出 `TypeError`，而不是静默丢弃。
- 空叙述的校验码由 **`review.missing-summary` 更名为 `review.blank-summary`**：缺少 `summary_md` 现已合法，该码只表示它仍在报告的唯一条条件（存在但为空）。依赖旧码的机器消费者需要同步切换。
