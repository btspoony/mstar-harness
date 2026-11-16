---
category: Changed
packages: engine, commands
---

- **`reloaded` is documented for a stateless per-invocation consumer.** The `AttestationDisposition` doc comment in `packages/engine/src/store-activation.ts` and the published `activationAttestationDocumentConstraints` text in `packages/commands/src/activation-attestation.ts` now state the rule: a stateless per-invocation consumer (the CLI) is attested `reloaded` although no reload event occurs — nothing of it outlives an invocation, so its next invocation under the current epoch is the whole reload, and the value attests that no old process survived the barrier.
- Documentation only: no disposition value, payload shape or validation branch changed. The constraint row reaches operators through the `--help` text built in `packages/commands/src/families/store.ts` and `families/workflow.ts`, and through the schema description.

<!-- CN -->
- **`reloaded` 现在对无状态、按次调用的消费者有明文定义。** `packages/engine/src/store-activation.ts` 的 `AttestationDisposition` 文档注释与 `packages/commands/src/activation-attestation.ts` 中公开的 `activationAttestationDocumentConstraints` 文本现在写明该规则：无状态、按次调用的消费者（CLI）即便没有发生 reload 事件也记为 `reloaded`——它没有任何部分跨越单次调用存活，因此它在当前 epoch 下的下一次调用本身就是整次 reload，该取值表明没有旧进程越过屏障。
- 仅文档变更：disposition 取值、载荷结构与校验分支均未改变。该约束行通过 `packages/commands/src/families/store.ts` 与 `families/workflow.ts` 生成的 `--help` 文本以及 schema description 呈现给操作者。
