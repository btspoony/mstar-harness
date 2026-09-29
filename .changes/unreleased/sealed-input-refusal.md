---
category: Harness
packages: root
---

- A missing sealed input now reports as a structured `coordination.assignment-stale` refusal everywhere: the pre-activation bind's stale-pin adoption refuses with `plan document <path> changed or is gone` when the plan half of the pair `prepare` sealed has been deleted or moved, instead of letting a raw filesystem error escape the decision, and `assertPreparedFresh` / `assertSealedInputsUnchanged` share one `changed or is gone` message family so a changed or absent Assignment and plan document read the same on both transports.

<!-- CN -->
- 缺失的 sealed 输入现在统一以结构化的 `coordination.assignment-stale` 拒绝：pre-activation bind 的 stale-pin adoption 在 `prepare` 封存对的 plan 半边被删除或移动时，以 `plan document <path> changed or is gone` 拒绝，而不再让原始文件系统错误逃出该判定；`assertPreparedFresh` / `assertSealedInputsUnchanged` 共用同一 `changed or is gone` 文案族，使 Assignment 与 plan 文档的改动/缺失在两条 transport 上表述一致。
