---
category: Changed
packages: engine
---

- Added a competing-write regression for the coordinator plan path: two writers presenting the same plan
  token commit exactly once and the other is refused with the existing `execution.stale-token` CAS code,
  leaving one revision advance and one receipt.

<!-- CN -->
- 为 coordinator 计划路径新增同 token 竞争写回归：两个写入方提交同一 plan token 时恰好一个提交成功，
  另一个以既有 `execution.stale-token` CAS 码被拒绝，只留下一次 revision 递增与一条 receipt。
