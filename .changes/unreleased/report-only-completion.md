---
category: Changed
packages: engine, cli
---

- Standalone `verification/report-only` workflows now complete without a PR, a merge, an integration branch or a checkout: an accepted handoff plus a recorded fulfilment of the registered completion policy complete the row, and the terminal close consults the same evidence. This works on both the JSON/file and the DB transports.
- The recorded fulfilment is frozen once the row is `Done` on both transports — a re-pointed evidence reference refuses with the same stable code — because that record is the basis `Done` was authorized against. An identical re-record stays the idempotent no-op it always was, and the development tail remains write-time-only.
- `validateStandaloneCompletedCoherence` now requires the completed handoff state **positively** for a `Done` standalone row instead of returning early for every other state, so the integration-contamination, `integration_worktree_path` / `branch.integration` and no-lease refusals apply to a rewritten handoff on both transports. Previously flipping one word of stored state disabled all of them, and the close could write `completed`, stamp `ended_at`, unregister the root entry and pass the phase-6 gate on a document that was still `accepted`.
- Completion ordering follows the declared kind: the completion evidence is recorded **before** `Done` for report-only, while the compound/PR/merge tail stays **after** `Done` for development, and the development Git proofs and the iteration merge proof are preserved.
- The deferred installed JSON/CLI `failed`/`stopped` exposure is documented rather than implemented: a workflow that must become terminal on that path is reported as a named blocker, never hand-edited or closed as `completed`.

<!-- CN -->
- 独立的 `verification/report-only` workflow 现在无需 PR、无需合并、无需集成分支或检出即可完成：已接受的交接 + 已登记的 completion policy 履行记录即让该行完成，终态 close 咨询同一份证据；JSON/文件传输与 DB 传输都支持。
- 履行记录在该行 `Done` 之后于两种传输上**冻结**——重新指向证据引用会以同一稳定码拒绝——因为该记录正是 `Done` 被授权的依据。完全相同的重录仍是无副作用的幂等操作，development 尾段仍只在写入期发生。
- `validateStandaloneCompletedCoherence` 现在对 `Done` 的 standalone 行**正向要求** completed 交接状态（不再对其它状态早退），因此 integration 污染、`integration_worktree_path` / `branch.integration` 与「无租约」三项拒绝在两种传输上同样适用于被改写的交接。此前改写一个词即可令它们全部失效，close 会在仍是 `accepted` 的文档上写入 `completed`、落 `ended_at`、注销根条目并通过 phase-6 门禁。
- 完成顺序随声明的 kind：report-only 的完成证据记录在 `Done` **之前**，development 的 compound/PR/merge 尾段仍在 `Done` **之后**；development 的 Git 证明与迭代合并证明均保留。
- 被推迟的「已安装 JSON/CLI 的 `failed`/`stopped` 暴露」只做文档记录、不做实现：必须经该路径进入终态的 workflow 会被报告为具名阻塞项，绝不手改、也不以 `completed` 关闭。
