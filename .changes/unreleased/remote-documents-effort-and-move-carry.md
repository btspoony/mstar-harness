---
category: Fixed
packages: engine
---

- **The published observation document matches the runtime parser.** The `inputDocument` descriptor an agent
  discovers through the schema command now types a milestone row as `effortSessions` (null or an integer of
  at least 1) with the retired `target` member gone, so a submission built from the advertised shape is the
  one the runtime accepts instead of one it refuses.
- **A cache replacement keeps a move-only ledger.** The successor now carries the settled ledger when either
  the outbox intents or the move rows are non-empty, so a staged move recorded before any intent exists
  survives the replacement instead of being dropped with the handoff it belongs to.

<!-- CN -->
- **发布的 observation 文档与运行时解析器一致。** schema 命令发布的 `inputDocument` 描述符现在把
  milestone 行类型定为 `effortSessions`（null 或至少为 1 的整数）并移除已退役的 `target` 成员，
  因此按所宣传形状构造的提交正是运行时接受的形状，而非被拒绝的形状。
- **缓存替换保留仅含 move 的台账。** 后继库现在在意图或 move 行任一非空时搬运已结台账，
  因此在任何意图存在之前记录的 staged move 能随替换保留，不再连同其 handoff 一起丢失。
