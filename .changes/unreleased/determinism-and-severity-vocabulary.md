---
category: Fix
packages: judgment, skills
---

- **Deterministic shadow-pack identity**: source ordering now uses locale-independent code-unit comparison, so identical frozen inputs produce the same `packId` regardless of locale behavior.
- **One residual severity vocabulary**: documentation now matches the engine values `critical`, `high`, `medium`, `low`, and `info`; out-of-enum values are refused with the accepted list.

<!-- CN -->
- **影子 pack 身份确定性**：来源排序现在使用不受 locale 影响的 code-unit 比较，因此相同的冻结输入无论 locale 行为如何都会生成相同的 `packId`。
- **统一 residual severity 词汇**：文档现在与引擎枚举 `critical`、`high`、`medium`、`low` 和 `info` 一致；枚举外的值会被拒绝，并列出可接受值。
