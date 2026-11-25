---
category: Fixed
packages: engine
---

- **A frozen pre-upgrade write with a milestone target settles.** The outbox reads a stored request under
  the contract that froze it: a milestone carrying the retired calendar `target` reads as unestimated
  (`effortSessions: null`), because a date is not a count of sessions. A new submission carrying
  `target` is still refused at the boundary.

<!-- CN -->
- **含 milestone target 的冻结旧版写入可结算。** outbox 按冻结当时的契约读取已存请求：携带已退役日历
  `target` 的 milestone 读作未估算（`effortSessions: null`），因为日期不是会话数量。新提交携带
  `target` 仍在边界处被拒。
