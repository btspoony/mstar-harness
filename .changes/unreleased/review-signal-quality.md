---
category: Harness
packages: root, engine, cli
---

- **PR review admits defects, not polish.** Findings must identify an observable wrong outcome introduced or worsened by the change. Missing or weak tests, coverage requests, documentation polish, naming or abstraction preferences, and execution-dependent claims are excluded; test findings are limited to four wrong-artifact classes, and documentation findings to wrong content that changes reader action. Synthesis applies admissibility before evidence verification for `may-fix` and `nit`.
- **Removed the `unverified` result channel.** The `--unverified` flag, report key, tally bucket, score deduction and display row are gone. Runtime proof belongs to CI, QA and explicitly requested E2E; the review no longer retains or scores claims that need execution to settle.

<!-- CN -->
- **PR 审查只接纳缺陷，不收润色建议。** Finding 必须指出本次变更新增或加剧的可观察错误后果。缺失或薄弱测试、覆盖率要求、文档润色、命名或抽象偏好，以及依赖执行才能确定的声明均不接纳；测试 finding 仅限四类错误产物，文档 finding 仅限会改变读者行动的错误内容。合成阶段对 `may-fix` 和 `nit` 先判断准入，再核对证据。
- **移除 `unverified` 结果通道。** 删除 `--unverified` 参数、报告键、计数桶、扣分及展示行。运行时证明归 CI、QA 和显式请求的 E2E；审查不再保留或计分依赖执行才能确定的声明。
