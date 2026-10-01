---
category: Harness
packages: root, engine
---

- **Sealed prepare recovery**: byte-identical ordinary prepare reissues by the coordinator or authenticated bound claimant answer `already-satisfied` without rewriting the plan seal or advancing its revision. An eligible coordinator can reseal changed reviewed input on an unbound, unleased Todo row without an active handoff; both routes identify the previous seal, and active exact retries retain that immutable provenance. Active transactions retain action-local operation receipts, exact retries replay, and stale tokens remain conflicts. Bound, leased, handed-off and terminal rows retain their protection; bind-time byte-only adoption is unchanged.

<!-- CN -->
- **已封存 prepare 恢复**：coordinator 或已认证的绑定 claimant 对字节完全相同的普通 prepare 重发返回 `already-satisfied`，不重写计划封存或推进其 revision。符合条件的 coordinator 可对未绑定、无 lease、无活跃 handoff 的 Todo 行重封存已评审的变更输入；两条路由均标明旧封存身份，活跃事务的精确重试保留该不可变来源记录。活跃事务保留动作级 operation 收据，精确重试仍为 replay，过期 token 仍为冲突。已绑定、持有 lease、已 handoff 及终态行继续受保护；bind 时的纯字节 adoption 保持不变。
