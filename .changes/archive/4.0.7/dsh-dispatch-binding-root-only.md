---
category: Fixed
packages: dsh
---

- `dispatchBinding` is now read ONLY for a ROOT calling session. A child session never inherits the configured binding: its anti-recursion caller is empty whatever the field says, so an Assignment-shaped dispatch from a leaf fails closed with `dispatch.anti-recursion.empty-binding` instead of being compared against the configured coordinator. Previously an explicit binding won for every caller, which let any leaf that could dispatch borrow the configured coordinator identity and defeat the anti-recursion precheck. Within a root session the field keeps its semantics — an explicit value wins verbatim, an explicitly blank value fails closed, and no explicit value reads as `project-manager` — and the exec-less host `beforeDispatch` hook falls back to an empty caller like any other unreadable session, never to the configured value.
- Consequence, documented instead of worked around: a deployment whose coordinator is NOT the root session cannot be served by this field, and the README sentences inviting such a deployment to set it explicitly are removed. Updated the dsh README (EN/ZH), the bundle README, and the host dispatch reference.
- The exec-less path is documented as reachable only from a host hook that supplies no calling session (in-repo, only tests drive it) — every production dispatch carries its calling agent — so an embedder wiring such a hook must resolve a session before dispatching; `dispatchBinding` is not its recovery. The root read also trusts `session.header.parentSession`, and a host provider that does not stamp a child's parent would be read as root.

<!-- CN -->
- `dispatchBinding` 现在**只**对**根会话**的调用读取。子会话永不继承已配置的绑定：无论该字段写什么，其反递归 caller 都是空，因此叶子发出的 Assignment 形态派发会以 `dispatch.anti-recursion.empty-binding` fail-closed，而不再拿已配置的协调者身份去比较。此前显式绑定对**每个**调用方生效，使任何能派发的叶子都能借用协调者身份、绕过反递归前置检查。在根会话内该字段语义不变——显式值原样生效、显式置空 fail-closed、未显式设置读作 `project-manager`；而无 exec 的宿主 `beforeDispatch` 钩子与其它读不到会话的路径一样回落到空 caller，绝不回落到已配置的值。
- 随之而来的结论写进文档而非绕开：协调者不是根会话的部署无法用该字段承载，README 中邀请此类部署显式设置该字段的句子已删除。同步更新 dsh README（中英）、bundle README 与 host 派发参考。
- 无 exec 的路径已写明只能由不提供调用会话的宿主钩子触达（本仓库内只有测试驱动它）——每一条生产派发都携带调用方 agent——因此接入此类钩子的嵌入方必须在派发前解析出会话，`dispatchBinding` 不是它的恢复手段。根会话判定同时信任 `session.header.parentSession`，不为子会话标记该字段的宿主 provider 会被读作根会话。
