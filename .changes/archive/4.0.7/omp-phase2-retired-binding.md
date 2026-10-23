---
packages: omp
---

- **A normal workflow close no longer reads as a Phase-2 authority failure.** The `mstar_phase2` extension now classifies a `coordination.workflow-not-found` probe refusal through the cleanup read: a retained terminal lifecycle returns the new `phase2.workflow-retired` code and stays silent on `agent_end`, while a genuinely unknown id, a foreign root, a stale epoch and an unreadable store keep their existing diagnostics. The retired code is the only one suppressed — the once-per-code-per-generation latch is unchanged.
- **Both refusals now name one executable action.** `checkpoint` against a retired binding says the workflow ended and points at `{operation:"export-history", workflowId}` instead of asking for a rebind that would refuse again; `bind` says the workflow ended and names `mstar status validate` for listing ACTIVE lifecycles, and the unknown-id refusal carries the same pointer.
- **Retired silence is a regression test, not a forwarding echo.** The new case drives the public route end to end — create, bind, record the report-only fulfilment, the ordinary `completed` close, then `agent_end` — and asserts no notice is sent; the unknown-id case appends a format-legal bind record and asserts the diagnostic and refusal text still appear.

<!-- CN -->
- **正常的 workflow 关闭不再被读成 Phase-2 授权失败。** `mstar_phase2` extension 现在会通过 cleanup 读把 `coordination.workflow-not-found` 的探测拒绝再分类一次：保留的终态生命周期返回新的 `phase2.workflow-retired`，并且在 `agent_end` 上保持静默；而真正未知的 id、外部 root、过期 epoch 与不可读 store 全部保持原有诊断。只有 retired 这一个码被静默——「每代每码一次」的闩锁未改动。
- **两处拒绝都会指向一个可执行动作。** 对已 retired 的绑定调用 `checkpoint` 会说明该 workflow 已结束，并指向 `{operation:"export-history", workflowId}`，而不是要求一次注定再次被拒的 rebind；`bind` 说明 workflow 已结束，并给出 `mstar status validate` 以列出 ACTIVE 生命周期，未知 id 的拒绝也带上同一指引。
- **retired 静默是一条真实回归测试，不是转发回声。** 新用例端到端地驱动公开路径——创建、绑定、记录 report-only 履约、普通的 `completed` 关闭，然后 `agent_end`——并断言没有发出任何 notice；未知 id 用例追加一条格式合法的绑定记录，断言诊断与拒绝文本仍然出现。
