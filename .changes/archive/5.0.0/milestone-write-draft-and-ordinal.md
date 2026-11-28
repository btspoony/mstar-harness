---
category: Fixed
packages: root
---

- **A new milestone now sorts after the existing ones, and a refused estimate no longer throws away the operator's other edits.** Creating a milestone on a deletion-gapped board (ordinals 0, 2) assigns one past the highest ordinal instead of the milestone count, so the board and timeline place it last rather than alongside existing work; and when the engine refuses a count (zero, negative, or over the safe range), the milestone editor and the create form stay open with the typed name/effort/status intact — the store's own refusal message arrives beside the still-open draft, and the draft closes or clears only when the write is accepted.

<!-- CN -->
- **新建里程碑现在排在既有里程碑之后,被拒绝的估算不再丢弃操作员的其他编辑。** 在有删除空缺(序号 0、2)的面板上创建里程碑时,取最高序号加一而非里程碑计数,面板与时间线因此将其排到最后而非夹在既有工作之间;当 engine 拒绝计数(零、负数或超出安全范围)时,里程碑编辑器与创建表单保持打开并保留已输入的名称/估算/状态——存储的拒绝原文在仍打开的草稿旁呈现,只有写入被接受时草稿才关闭或清空。
