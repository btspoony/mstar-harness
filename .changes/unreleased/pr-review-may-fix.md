---
category: Harness
packages: root, engine, commands
---

- **PR review gains a fourth merge class, `may-fix`, with a surface gate.** Test and documentation findings can no longer be `must-fix` or `should-fix`: they are capped at `may-fix` however serious the underlying gap reads. `may-fix` is counted, listed in full, captured as an issue and deducted from the score, but it never selects a verdict — a review whose only findings are tests or docs still returns `ship it`. Implementation findings keep the previous bands (`critical` → `must-fix`; `high` / `medium` → `should-fix`; `low` → `may-fix`). The locked deduction schedule gains `may-fix` `max(6 − 2·(n−1), 1)` → 6,4,2,1,1… with a class cap of 15. The chat header and report tally gain the `may-fix` count; a report or envelope written before the class existed stays valid and reads `may-fix` as 0.

<!-- CN -->
- **PR 评审新增第四类合并等级 `may-fix`，并引入表面门禁。** 测试类与文档类 finding 不再可能被判为 `must-fix` 或 `should-fix`：无论底层缺口看起来多严重，上限一律为 `may-fix`。`may-fix` 会计数、完整列出、落为 issue 并从分数中扣分，但**不参与 verdict 推导**——一次评审若只有测试/文档类 finding，结论仍是 `ship it`。实现类 finding 沿用原有档位（`critical` → `must-fix`；`high` / `medium` → `should-fix`；`low` → `may-fix`）。锁定扣分表新增 `may-fix` `max(6 − 2·(n−1), 1)` → 6,4,2,1,1…，类上限 15。聊天头部与报告 tally 增加 `may-fix` 计数；该类出现之前写下的报告与 envelope 仍然有效，读取为 0。
