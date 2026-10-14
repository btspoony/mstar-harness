---
category: Fix
packages: engine
---

- **Terminal adoption stamps fresh lifecycle timestamps on a header it terminalizes.** When `adoptTerminalWorkflow` settles an unregistered header that never closed, the adoption instant now becomes both `ended_at` and the snapshot's `updated_at`, instead of reusing an `ended_at` an imported non-terminal snapshot may still have carried and leaving `updated_at` at the import-time value. Projections and audits no longer read an end time that predates later recorded activity. An already-terminal header keeps its recorded `status`, `ended_at` and `updated_at` byte-for-byte, as before.

<!-- CN -->
- **终态采纳为其终结的 header 写入全新的生命周期时间戳。** 当 `adoptTerminalWorkflow` 结算一个从未关闭的未注册 header 时，采纳时刻现同时成为 `ended_at` 与快照自身的 `updated_at`，而不再复用导入的非终态快照可能仍携带的 `ended_at`、也不再让 `updated_at` 停留在导入时刻。投影与审计不再读到早于后续已记录活动的结束时间。已处于终态的 header 仍逐字节保持其记录的 `status`、`ended_at` 与 `updated_at`。
