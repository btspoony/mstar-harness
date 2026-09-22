---
category: Harness
packages: root
---

- Documented the standalone `verification/report-only` completion route end to end: an **accepted handoff plus a recorded fulfilment of the registered `completion_policy`** complete the row (`Done`), and the terminal close consults the same evidence — no PR, no merge, no integration branch or checkout.
- Recorded the completion ordering per declared kind (`completion` evidence **before** `Done` for report-only, the compound/PR/merge tail **after** `Done` for development) and the preserved `development` Git proofs and iteration merge proof.
- Recorded the deferred **installed JSON/CLI `failed`/`stopped` exposure** (the DB lifecycle's existing terminal branch is neither reimplemented nor expanded), so a workflow that must become terminal on that deferred path is reported as a named blocker rather than hand-edited or closed as `completed`.
- Added the real-CLI regression chain (`packages/cli/test/plan-coordination.test.ts`): register → bind → prepare → progress → handoff → accept → policy evidence → complete → close → phase-6 projection, plus the missing-policy and mismatched-policy refusals.

<!-- CN -->
- 完整记录独立 `verification/report-only` 完成路由：**已接受 handoff + 已登记 `completion_policy` 的完成证据**即可完成该行（`Done`），终态 close 复用同一证据——无 PR、无 merge、无 integration 分支或检出。
- 记录按交付类型的完成顺序（report-only 的 `completion` 证据在 `Done` **之前**，development 的 compound/PR/merge 尾段在 `Done` **之后**），并保留 development 的 Git 证明与 iteration 的 merge 证明。
- 如实记录**被延期的 installed JSON/CLI `failed`/`stopped` 曝光**（DB lifecycle 既有终态分支不重实现、不扩展）：必须走该路径进入终态的工作流作为具名阻塞上报，而非手改快照或伪称 `completed`。
- 新增真实 CLI 回归链（`packages/cli/test/plan-coordination.test.ts`）：register → bind → prepare → progress → handoff → accept → 策略证据 → complete → close → phase-6 投影，并覆盖缺失策略与策略不匹配的拒绝路径。
