---
category: Changed
packages: engine, commands
---

- **`plan_parallelism` has one authority.** The engine's `PLAN_PARALLELISM_VALUES` is now an `as const` tuple re-exported from the package entry, and the command transport builds its `--file` policy schema's `z.enum` from it instead of a hand-copied literal. `mstar schema --command workflow.execution-policy` still publishes exactly `serial` | `parallel` and still refuses any other value; the two values now have one spelling in the repository, so the transport and the engine's `execution-policy` re-validation cannot drift.

<!-- CN -->
- **`plan_parallelism` 只有一个权威。** 引擎的 `PLAN_PARALLELISM_VALUES` 现为 `as const` 元组并从包入口再导出，命令传输层 `--file` policy schema 的 `z.enum` 直接由它构造，不再手抄一份字面量。`mstar schema --command workflow.execution-policy` 仍只发布 `serial` | `parallel`，仍拒绝其它取值；这两个值在整个仓库中只有一处拼写，因此传输层与引擎 `execution-policy` 的复校验不会相互漂移。
