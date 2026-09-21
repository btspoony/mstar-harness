---
category: Changed
packages: engine, cli, omp
---

- **Coordinator identity is acquired, never generated.** A fresh coordinator bind now requires an explicitly acquired session id: the engine refuses an omitted id with `coordination.identity-missing` before any write instead of minting a UUID, and `plan bind --coordinator` no longer accepts the inherited `MSTAR_HOST_SESSION_ID` as authorization. Plain local operators pass `--session-id`; managed host sessions use the new host-owned tool.
- **One adapter-only `ExecutionIdentity` type** (`packages/engine/src/session-identity.ts`): the `(canonical harness root, workflowId, role, planId, sessionId)` tuple plus `validateExecutionIdentity`, shared by engine, CLI and host adapters instead of a second per-consumer shape.
- **New host-owned `mstar_coordinator` tool** (`bind`): the extension derives the native session id from the host and the canonical control root from the host cwd, refuses leaf/scoped-plan callers, and accepts no session id, root, caller role, authority flag or credential path.
- **Retired the blanket bare-`bash` env revision.** A managed `plan bind --coordinator` attempted through `bash`/`functions.bash` is blocked before shell execution with a redirect to `mstar_coordinator`; unrelated shell calls are unchanged and an absent or unsupported `env` field no longer produces an input revision.

<!-- CN -->
- **协调者身份必须显式获取，不再生成。** 新的协调者绑定必须显式提供 session id：引擎在写入前以 `coordination.identity-missing` 拒绝缺失身份，而不是生成 UUID；`plan bind --coordinator` 不再把继承的 `MSTAR_HOST_SESSION_ID` 当作授权。本地操作者显式传入 `--session-id`；托管宿主会话使用新的宿主工具。
- **新增仅适配器使用的 `ExecutionIdentity` 类型**（`packages/engine/src/session-identity.ts`）：`(规范 harness 根, workflowId, role, planId, sessionId)` 元组与 `validateExecutionIdentity`，供引擎、CLI 与宿主适配器共用，避免各自声明第二份形状。
- **新增宿主自有工具 `mstar_coordinator`（`bind`）**：扩展从宿主取得原生 session id、从宿主 cwd 推导规范控制根，拒绝 leaf/scoped-plan 调用者，且不接受 session id、root、调用者角色、授权标志或凭据路径。
- **移除对裸 `bash` 的环境变量注入。** 通过 `bash`/`functions.bash` 发起的托管 `plan bind --coordinator` 会在执行前被拦截并重定向到 `mstar_coordinator`；无关 shell 调用保持不变，缺失或不支持的 `env` 字段不再产生输入修订。
