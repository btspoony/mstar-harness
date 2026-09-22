# Execution H3 — native DSh identity and awaited ledger admission

- Derive execution identity only from the carrying DSh session header, then resume the canonical C1 session before returning an active F3 ledger target.
- Register F3's awaited `resolveExecutionLedgerTarget` at the production DSh workflow-ledger boundary; resolver failure pauses attribution without fallback or automatic clear.
- Keep DSh agent ids as lease-holder evidence only; caller/model identity arguments cannot impersonate a native session.

<!-- CN -->

# Execution H3 — DSh 原生身份与 awaited ledger 准入

- 仅从承载事件的 DSh session header 获取 execution identity，并在返回活动 F3 ledger target 前恢复 canonical C1 session。
- 在 DSh workflow-ledger 生产注册边界接入 F3 awaited `resolveExecutionLedgerTarget`；resolver 失败只暂停归因，不回退也不自动 clear。
- DSh agent id 仅作为 lease-holder 证据；caller/model 身份参数不能冒充原生 session。