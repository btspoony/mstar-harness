---
category: Changed
packages: commands
---

- **`plan issue-add` publishes its entry array as a typed schema.** The `entries` payload is now the engine's `CaptureInput` registry as an array item (minus the plan-derived `projectId`) instead of an array of free-form objects, so `mstar schema --command plan.issue-add` states every per-entry field, its enum values and its requiredness. One inline `--entries` value with several incomplete entries is refused once, naming every missing field of every entry (`entries[<i>].<field>`) in a single usage envelope; `--file` keeps the engine's aggregated per-entry problems.
- **`workflow execution-policy` publishes its policy document.** The command now declares the `policy` payload — the transport mirror of the engine's `WorkflowExecutionPolicy` (`plan_parallelism`, `worktree_mode`, `push_policy`, all optional) — so `mstar schema --command workflow.execution-policy` shows the shape `--file` accepts, and the `--file` help names that lookup. The engine's `coordination.forbidden-field` guard on unknown keys remains the authority.
- **The unused generic `input`/`policy` payload records are removed** from the workflow family's publication path; a workflow payload key is now published from a declared schema or not at all.

<!-- CN -->
- **`plan issue-add` 的条目数组改为类型化 schema。** `entries` 载荷现在是引擎 `CaptureInput` 注册表作为数组元素（去掉由计划派生的 `projectId`），不再是一组自由对象，因此 `mstar schema --command plan.issue-add` 会列出每个条目字段、枚举值与必填性。一个含多条不完整条目的内联 `--entries` 值只会被拒绝一次，在同一个 usage envelope 中点名每个条目的每个缺失字段（`entries[<i>].<field>`）；`--file` 仍走引擎的逐条聚合问题。
- **`workflow execution-policy` 公布其 policy 文档。** 该命令现在声明 `policy` 载荷——引擎 `WorkflowExecutionPolicy` 的传输镜像（`plan_parallelism`、`worktree_mode`、`push_policy`，全部可选）——因此 `mstar schema --command workflow.execution-policy` 会展示 `--file` 接受的形状，`--file` 帮助也指向该查询。未知键的权威仍是引擎的 `coordination.forbidden-field` 守卫。
- **移除 workflow 家族中未使用的通用 `input`/`policy` 载荷记录**；workflow 的载荷键现在只在声明了 schema 时发布。
