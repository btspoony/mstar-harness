---
category: Changed
packages: engine,commands,dsh
---

- **`milestone assign` authorizes like every other issue write.** The sole writer of `issues.milestone_id` now takes `--actor project-manager` plus the `--expect-issue` / `--expect-store` revision CAS inside its write transaction, instead of resolving an acquired workflow coordinator session — so a milestone can be assigned or cleared with no workflow bound. A non-`project-manager` actor is still refused `issue.scope-refused`, and stale revisions still refuse with their existing codes.
- **The session selector is gone on both routes.** `milestone.assign` publishes no `sessionId` context option, no `--session-id` and no `--session-ref` on the CLI or over MCP; the issue write boundary drops `MutationContext.sessionRef` together with the scoped-session resolver and the ACTIVE binding re-check they fed. `--actor`, `--expect-issue`, `--expect-store`, `--operation` and the idempotent replay are unchanged.
- **The dsh panel assign channel no longer needs a coordinator binding.** It passes only the resolved harness root, so a workspace with no active workflow writes instead of being refused; an unresolvable target is answered as the adapter's own `store.not-active`, like every other panel write.

<!-- CN -->
- **`milestone assign` 的授权与其他 issue 写入一致。** `issues.milestone_id` 的唯一写入面改为 `--actor project-manager` + `--expect-issue` / `--expect-store` revision CAS（在同一写事务内校验），不再解析已获取的 workflow coordinator session——没有绑定 workflow 也能 assign / clear。非 `project-manager` 席位仍以 `issue.scope-refused` 拒绝，过期 revision 仍按原有拒绝码拒绝。
- **两条路由都不再提供 session 选项。** `milestone.assign` 在 CLI 与 MCP 上均不再发布 `sessionId` 上下文选项、`--session-id` 与 `--session-ref`；issue 写边界同时删除 `MutationContext.sessionRef`，以及为其提供输入的 scoped-session 解析与 ACTIVE binding 复核。`--actor`、`--expect-issue`、`--expect-store`、`--operation` 与幂等 replay 不变。
- **dsh 面板的 assign 通道不再需要 coordinator binding。** 它只传已解析的 harness root，无活跃 workflow 的工作区照常写入；目标无法解析时按适配器自身的 `store.not-active` 应答，与其他面板写入一致。
