---
category: Harness
packages: commands
---

- Usage-message construction for schema rejections is now **bounded**: when a rejected input produces more than 20 issues, the first-line message carries the first 20 causes plus an explicit `…and N more issues` pointer, while `details.diagnostics` keeps every diagnostic (uncapped, with the established secret-shape redaction). The `rejected` summary field reports only the first cause's flag/expected/received facts; the full per-issue facts remain in `details.diagnostics`.

<!-- CN -->
- schema 拒绝的 usage 消息构造现在**有界**：当被拒输入产生超过 20 条 issue 时，首行消息携带前 20 条原因加明确的 `…and N more issues` 指针，`details.diagnostics` 保留全部诊断（不设上限，沿用已有的 secret-shape 脱敏）。`rejected` 摘要字段只报告首条 cause 的 flag/expected/received 事实；逐条完整事实在 `details.diagnostics`。
