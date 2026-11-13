---
category: Harness
packages: root
---

- **The retired judgment collection chain is gone.** `runReviewAdvice` and the WeakSet attestation module (`evaluator-channel-trust.ts`) are deleted, along with the CLI result types and input-collection helpers only that entrypoint used; `connectEvaluatorChannel` now returns the mailbox channel directly after its supervisor mount check. `evaluateNative`, `connectEvaluatorChannel`, the shadow supervisor and `review-advice.ts` are unchanged.
- **One container-probe kit for the judgment lane.** The three probe launchers now share `dockerIsolationArgs` and `sha256File`, and both gate sinks share `createOnlySinkWrite` (`container-probe.ts`). Per-gate mounts, path validators and error codes are untouched, so the annotation-only protected root and the one-versus-two allowed sinks still hold.

<!-- CN -->
- **移除已退役的 judgment 收集链路。** 删除 `runReviewAdvice` 与 WeakSet 认证模块（`evaluator-channel-trust.ts`），以及只有该入口使用的 CLI 结果类型与输入采集辅助函数；`connectEvaluatorChannel` 现在在 supervisor mount 校验后直接返回邮箱通道。`evaluateNative`、`connectEvaluatorChannel`、shadow supervisor 与 `review-advice.ts` 保持不变。
- **judgment 泳道收敛为一套 container-probe。** 三个 probe launcher 共享 `dockerIsolationArgs` 与 `sha256File`，两个 gate sink 共享 `createOnlySinkWrite`（`container-probe.ts`）。各 gate 的 mount、路径校验与错误码未动，annotation 专属受保护根与「一个对两个允许 sink」的约束仍然成立。
