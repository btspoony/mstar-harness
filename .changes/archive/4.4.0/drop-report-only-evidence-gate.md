---
category: Harness
packages: root, engine, commands
---

- **The report-only fulfilment gate is gone.** `verification/report-only` no longer requires a recorded `delivery.completion` block before `plan complete` or the terminal close. The `completion` member is deleted from `WorkflowDeliveryEvidence`, the structural validator and the `mstar workflow evidence` payload; recording it is refused as an unused member.
- **`completion_policy` stays a registration-time declaration.** The registered policy declares what the deliverable is; it is not a runtime artifact to fulfil with a sentence nothing verifies. `verifyDeliveryEvidence` returns the pure consultation result for this route — no Git proof, no fulfilment lookup.
- **What `completed` means on this route is now explicit:** every row `Done` plus QC/QA. Report-only `completed` no longer claims a recorded self-attestation, and real-environment or external-artifact proof is outside this route rather than mimed by a string.
- **Stored blocks stay readable.** A snapshot recorded under the previous shape keeps its `delivery.completion` as history: persisted-state validation drops it (the same read tolerance `delivery.pr` and the free-text `merge` get) while every write path refuses it.
- Updated `mstar-artifacts/references/plan-workflow-lifecycle-contract.md` (§1, §3 route table, §4g, §7, binding negatives), `mstar-roles/references/project-manager/plan-management.md`, `mstar-iteration/references/phase-6-post-merge-close.md`, and `mstar-use-cli/references/plan-and-workflow.md`.

<!-- CN -->
- **report-only 的履行门禁删除。** `verification/report-only` 不再要求在 `plan complete` 或终端 close 之前记录 `delivery.completion`。`completion` 成员从 `WorkflowDeliveryEvidence`、结构校验器与 `mstar workflow evidence` 载荷中删除；记录它会被当作未使用成员拒绝。
- **`completion_policy` 保留为注册期声明。** 注册的策略声明交付物是什么，而不是一个用无人校验的自述句去履行的运行时产物。该路由的 `verifyDeliveryEvidence` 只返回纯 consult 结果——没有 Git 证明，也没有履行查询。
- **该路由上 `completed` 的含义现在是明确的：** 所有行 `Done` 加 QC/QA。report-only 的 `completed` 不再声称存在已记录的自述证据；真实环境或外部产物证明不在本路由范围内，也不再被一个字符串模仿。
- **已存记录保持可读。** 旧形状写入的快照保留其 `delivery.completion` 作为历史：持久状态校验会丢弃它（与 `delivery.pr`、自由文本 `merge` 相同的读兼容），而所有写路径都拒绝它。
- 更新 `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`（§1、§3 路由表、§4g、§7、绑定负面清单）、`mstar-roles/references/project-manager/plan-management.md`、`mstar-iteration/references/phase-6-post-merge-close.md` 与 `mstar-use-cli/references/plan-and-workflow.md`。
