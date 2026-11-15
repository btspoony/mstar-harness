---
category: Changed
packages: dsh
---

- **ACTIVE-only engine status**: the dsh pre-step listener appends the `<mstar_engine_status>` catalog row **only when the rendered selection is an ACTIVE workflow**: no workflow or an unresolvable selection (`no-active`, `unbound-multi-active`, `status.missing`, `store.not-initialized`, terminal history) injects no model row, while the persisted `dsh_status_emissions` panel snapshot still carries the verdict.
- **System prompt follows the same predicate**: without an ACTIVE workflow context the `mstar:engine-status` context is empty (**version line included**) and the `mstar:harness-rules` section carries only the Agent Teams delegation contract (nothing when that layer is unmounted) — so a workspace with no mstar business context gets no mstar state or harness-rules injection (the delegation contract stays: it governs dispatch, not a workflow).

<!-- CN -->
- **仅 ACTIVE 工作流注入状态**：dsh 的 pre-step 监听器**仅在渲染的选择是 ACTIVE 工作流时**追加 `<mstar_engine_status>` catalog 行：无工作流或无法解析的选择（`no-active`、`unbound-multi-active`、`status.missing`、`store.not-initialized`、终态历史）不再注入模型行，但持久化的 `dsh_status_emissions` 面板快照仍携带该判定。
- **system prompt 跟随同一判定**：无 ACTIVE 工作流上下文时 `mstar:engine-status` context 为空（**连版本行也不保留**），`mstar:harness-rules` section 只保留 Agent Teams 派发契约（该层未挂载时为空串）——因此没有 mstar 业务上下文的工作区不出现 mstar 状态或 harness 规则注入（派发契约保留：它管辖派发而非工作流）。
