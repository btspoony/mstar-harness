---
category: Changed
packages: engine
---

- **Terminal adoption no longer requires a recorded stop reason.** `adoptTerminalWorkflow` refuses a stopped/failed header whose `state.stop_reason` is missing no more — nothing in the engine ever writes that field, so the guard stranded every normally stopped workflow's ACTIVE coordinator session row behind a hand-edited SQLite row. The terminal-status check, registry membership, revision CAS, self-settlement refusal, adoption-record read-back and per-header ACTIVE-session coverage are unchanged, and the retired recovery branch is gone from the CLI refusal vocabulary.

<!-- CN -->
- **终态采纳不再要求记录停止原因。** `adoptTerminalWorkflow` 不再拒绝缺少 `state.stop_reason` 的 `stopped`/`failed` header——引擎中没有任何代码写入该字段，该门禁使每个经正常路径停止的 workflow 的 ACTIVE coordinator 会话行被困住，只能靠手工改 SQLite 脱困。终态状态检查、注册表成员、修订号 CAS、自结算拒绝、采纳记录回读与逐 header 的 ACTIVE 会话覆盖均保持不变；CLI 拒绝词汇中已移除失效的恢复分支。
