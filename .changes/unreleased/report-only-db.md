# Report-only DB completion

- Add policy-backed DB completion and completed reconciliation for the standalone `verification/report-only` route.
- Revalidate accepted handoff, prepared assignment/QA, pins, policy evidence and own lease at the transaction boundary; atomically mark Done and release only the plan's own lease without Git or merge proof.
- Preserve development and iteration Git witnesses, replay receipts, terminal timestamps, and terminal unregister behavior.

# 仅报告 DB 完成

- 为独立 `verification/report-only` 路由增加基于策略的 DB 完成与已完成 reconcile。
- 在事务边界重新校验已接受 handoff、已准备 Assignment/QA、pins、策略证据与本行 lease；原子写入 Done 并仅释放本行 lease，不要求 Git 或 merge proof。
- 保留 development 与 iteration 的 Git witness、重放 receipt、终态时间戳及终态注销行为。
