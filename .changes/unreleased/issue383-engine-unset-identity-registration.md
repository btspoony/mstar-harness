---
category: Changed
packages: engine
---

- **ACTIVE registration no longer requires a session identity (issue #383c).** `workflow register` / `iteration.register` over the active DB route accept a caller with no session id and write a NULL `creator_session_id`; an explicit id is still recorded as attribution when the transport supplies one. The trust boundary is unchanged and now tested end to end from real unset-identity creation: the first coordinator bind adopts a NULL-creator workflow once, later adoption is refused once any coordinator record exists, and the creator fence plus duplicate-holder/holder-matching gates are untouched.
- `validateExecutionIdentity` gained one explicit registration-only relaxation (`allowUnsetSessionId`): the normalized empty string passes as "unset" for the create path, every other consumer keeps the acquired-identity rule, and the identity-missing refusal now names the exact supplies (CLI `--session-id`; MCP: the host passes `sessionId` per call).

<!-- CN -->
- **ACTIVE 注册不再强制会话身份（issue #383c）。** `workflow register` / `iteration.register` 在 ACTIVE DB 路径上接受无会话身份的调用者并写入 NULL `creator_session_id`；传输层提供了显式 id 时仍照常记录为归属。信任边界不变且有端到端回归：首个 coordinator bind 独家收养 NULL-creator 工作流，存在任何 coordinator 记录后再次收养被拒，creator fence 与 duplicate-holder/holder 匹配门禁原样保留。
- `validateExecutionIdentity` 新增仅限注册的显式放宽（`allowUnsetSessionId`）：归一化后的空字符串在创建路径上视为"未设置"，其余所有调用方仍遵守"身份必须显式获取"的规则；identity-missing 拒绝信息现在逐字写明供给路径（CLI `--session-id`；MCP：宿主每次调用传 `sessionId`）。
