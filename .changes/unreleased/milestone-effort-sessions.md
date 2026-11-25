---
category: Breaking
packages: root, engine, commands, dsh
---

- **The dashboard screens the effort field before any write.** The effort input keeps the raw text (a plain numeric-mode input, not a sanitising `type="number"` field); an empty field sends `effortSessions: null`, a whole number is sent as that number (the engine still owns the range, so `0` is refused by the engine, not the UI), and non-integer text is refused at the screen instead of being coerced into a cleared estimate. An estimated milestone renders `<n> sessions`; an unestimated one renders a word, matching the prototype.

- **Project milestones carry a count of standard sessions instead of a calendar date.** `project_milestones.target` is replaced by `effort_sessions` (null = unestimated, or an integer of at least 1); `milestone add|update` take `--effort-sessions <n>` and `--clear-effort-sessions` in place of the date flags, the roadmap export and the dashboard show `<n> sessions` or "unestimated", and the milestone timeline orders by `ordinal`. An existing target becomes **unestimated** on `store upgrade` — it is not converted, and a `local`/`mirror` lane advances through `store upgrade` while `remote bind` replaces a pre-current remote cache (refused as `remote.effect-pending` while it holds an unsettled outbox intent). An observe document that still carries `target` — the milestone rows ride the observe submission; bind's document is the check batch — is refused with `remote.input-invalid`.

<!-- CN -->
- **仪表盘在写入前筛查会话数输入。** 输入框保留原始文本(数字模式的文本框,不再用会吞掉非法文本的 `type="number"`);留空发送 `effortSessions: null`,整数按该数值发送(范围仍由 engine 裁决,`0` 由 engine 拒绝而非 UI 拦截),非整数文本在界面直接拒绝,不会被强转为清空估算。已估算的里程碑显示 `<n> sessions`,未估算的显示文字,与原型一致。

- **项目里程碑改存标准会话计数,不再携带日历日期。** `project_milestones.target` 由 `effort_sessions` 取代(null = 未估算,或至少为 1 的整数);`milestone add|update` 以 `--effort-sessions <n>` 与 `--clear-effort-sessions` 取代日期旗标,路线图导出与仪表盘显示 `<n> sessions` 或「未估算」,里程碑时间线按 `ordinal` 排序。既有 target 在 `store upgrade` 后变为**未估算**——不做转换;`local`/`mirror` lane 经 `store upgrade` 推进,而 `remote bind` 替换 pre-current 的远程缓存(仍持有未结算 outbox 意图时以 `remote.effect-pending` 拒绝)。仍携带 `target` 的 observe 文档以 `remote.input-invalid` 拒绝(里程碑行随 observe 提交;bind 的文档是 check batch)。
