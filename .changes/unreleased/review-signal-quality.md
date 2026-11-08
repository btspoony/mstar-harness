---
category: Harness
packages: root, engine, commands, cli
---

- **PR review admits defects, not polish.** Findings must identify an observable wrong outcome introduced or worsened by the change, with one narrow exception for diff-introduced, exemplar-cited, behavior-neutral convention `nit`s; test/document wrong-artifact restrictions still apply. Missing or weak tests, coverage requests, documentation polish, naming, formatting or abstraction preferences, and execution-dependent claims are excluded. Synthesis applies admissibility before evidence verification for `may-fix` and `nit`.
- **Removed the `unverified` result channel from the engine, commands family and CLI.** The `--unverified` flag, report key, tally bucket, score deduction and display row are gone. Runtime proof belongs to CI, QA and explicitly requested E2E; the review no longer retains or scores claims that need execution to settle.

<!-- CN -->
- **PR 审查只接纳缺陷，不收润色建议。** Finding 必须指出本次变更新增或加剧的可观察错误后果，唯一例外是本次变更新增、有仓库范例引用且修复不改变行为的约定不一致 `nit`；测试和文档仍须满足错误产物限制。缺失或薄弱测试、覆盖率要求、文档润色、命名、格式或抽象偏好，以及依赖执行才能确定的声明均不接纳。合成阶段对 `may-fix` 和 `nit` 先判断准入，再核对证据。
- **从 engine、commands 命令族及 CLI 移除 `unverified` 结果通道。** 删除 `--unverified` 参数、报告键、计数桶、扣分及展示行。运行时证明归 CI、QA 和显式请求的 E2E；审查不再保留或计分依赖执行才能确定的声明。
