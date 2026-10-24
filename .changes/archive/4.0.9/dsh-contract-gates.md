---
category: Harness
packages: root, engine
---

- Added `scripts/dsh-contract-lint.ts` (run by the `drift-lint` CI job) — three machine gates over the tracked dsh host documents: review-seat `Budget` + `Return shape` bounding, carrier-field vocabulary, and the `packages/dsh` README language-pair pin. Each violation is one named `file:line` row.
- Exported `REVIEW_SEAT_ROLES`, `BUDGET_LABELS` and `RETURN_SHAPE_LABELS` from the engine dispatch module and source entry so the checker reads the same authorities the Assignment parser consumes instead of restating them.
- Fixed the dsh workflow-script seat templates: their `Budget (review / QC seats)` / `Return shape (review / QC seats)` labels are now bold, the only parenthesized form the engine parser accepts — the plain form was silently rejected at dispatch.

<!-- CN -->
- 新增 `scripts/dsh-contract-lint.ts`（由 `drift-lint` CI 任务执行）：对受跟踪的 dsh 宿主文档做三道机器门禁 —— 审查席位的 `Budget` + `Return shape` 必填、carrier 字段词表、以及 `packages/dsh` README 语言对哈希 pin。每条违规输出一行 `file:line` 具名记录。
- 从 engine dispatch 模块与源码入口导出 `REVIEW_SEAT_ROLES`、`BUDGET_LABELS`、`RETURN_SHAPE_LABELS`，使检查器读取 Assignment 解析器消费的同一份权威，而不是重写一份。
- 修正 dsh workflow 脚本中的席位模板：`Budget (review / QC seats)` / `Return shape (review / QC seats)` 标签改为加粗形式 —— 这是引擎解析器唯一接受的括号形式，此前的普通形式在派发时被静默拒绝。
