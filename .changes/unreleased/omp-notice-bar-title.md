---
category: Harness
packages: root, omp
---

- Changed the coordinator-visible OMP notice **bar titles** to the shared types: the phase-2 diagnostic notice and the model-handoff notice now send `customType` `mstar:notice`, and the bounded phase-2 advisory sends `mstar:advisory` (previously `mstar:phase2-notice` / `mstar:model-handoff-notice` / `mstar:phase2-advisory`). The bar header prints the sent type, so the visible title now matches the shared Morning Star notice family.
- Unchanged: the hidden durable ledger identities `mstar:phase2` / `mstar:model-handoff`, their restore and dedup identity, the observed body workflow id/status/fallback, the delivery/continuation options and every machine refusal code (`phase2.workflow-terminal` included). A visible title rename is not a ledger or refusal-code change.
- Source-level change to the emitted values plus the matching host-reference paragraph; the emitted body states its own workflow status once. No installed UI, renderer registration, bundled host copy or publication is claimed by this entry.

<!-- CN -->
- 调整协调者可见的 OMP 通知**标题栏类型**为共享类型：phase-2 诊断通知与 model-handoff 通知现发送 `customType` `mstar:notice`，有界 phase-2 advisory 发送 `mstar:advisory`（原为 `mstar:phase2-notice` / `mstar:model-handoff-notice` / `mstar:phase2-advisory`）。标题栏打印所发送的类型，因此可见标题现在与共享的 Morning Star 通知族一致。
- 保持不变：隐藏的持久账本标识 `mstar:phase2` / `mstar:model-handoff`、其恢复与去重标识、正文观察到的 workflow id/status/fallback、投递/续接选项以及全部机器拒绝码（含 `phase2.workflow-terminal`）。可见标题改名不是账本或拒绝码变更。
- 仅改动所发送的值与其对应的 host 参考段落；正文只陈述自身 workflow 状态一次。本条目不声称任何已安装 UI、渲染器注册、已打包宿主副本或发布。
