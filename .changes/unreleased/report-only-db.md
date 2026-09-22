# Report-only DB completion

- Add policy-backed DB completion and completed reconciliation for the standalone `verification/report-only` route.
- Revalidate accepted handoff, prepared assignment/QA, pins, policy evidence and own lease at the transaction boundary; atomically mark Done and release only the plan's own lease without Git or merge proof.
- Pin the delivery route and registered completion policy before the transaction and re-check them inside it, so a header rewrite in the window cannot make a changed policy judge itself.
- Re-run the completed replay's stored invariants and pinned QC/QA digests inside the reconcile transaction, so a report edited after the preflight read refuses with no receipt, revision or timestamp change.
- Preserve development and iteration Git witnesses, replay receipts, terminal timestamps, and terminal unregister behavior.

# 仅报告 DB 完成

- 为独立 `verification/report-only` 路由增加基于策略的 DB 完成与已完成 reconcile。
- 在事务边界重新校验已接受 handoff、已准备 Assignment/QA、pins、策略证据与本行 lease；原子写入 Done 并仅释放本行 lease，不要求 Git 或 merge proof。
- 事务前 pin 交付路由与已登记 completion policy，并在事务内复检，避免窗口内改写后让变更后的策略自我比对。
- 在 reconcile 事务内复检已完成重放的存储不变量与 pinned QC/QA digest；preflight 读取后被改写的报告将拒绝，且 receipt、revision、时间戳均不变。
- 保留 development 与 iteration 的 Git witness、重放 receipt、终态时间戳及终态注销行为。
