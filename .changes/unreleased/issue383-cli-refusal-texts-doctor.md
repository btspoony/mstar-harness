---
category: Changed
packages: cli, engine
---

- **Identity-missing refusals name the supplies verbatim.** Every active route that refuses for a missing session identity — `plan bind` in all its forms (coordinator, identity session, sparse, resume), `plan show`, sparse plan operations, and workflow transitions/evidence/recovery — now states the exact supply paths in the refusal: CLI `--session-id` (or `MSTAR_HOST_SESSION_ID`), MCP: the host passes `sessionId` per call. The ACTIVE registration refusal was reshaped for the optional-creator contract: only `expect` and `operation` can be missing, and its text explains that an unset identity registers a NULL creator the first coordinator bind adopts.
- **`mstar doctor --target omp` now reports real plugin alignment.** The doctor's `pluginVersionNote` is fed by a new `detectPluginVersion` effect the CLI supplies from the existing per-host discovery (for omp: `omp plugin list`), so the stale-plugin guidance ("CLI X is newer than installed plugin Y — update the Morning Star plugin: omp plugin install @mstar-harness/omp") and the not-installed note reflect the actually detected version instead of always claiming no plugin was found.
- **ACTIVE registration no longer requires a session identity (issue #383c).** `workflow register` / `iteration.register` over the active DB route accept a caller with no session id and write a NULL `creator_session_id`; an explicit id is still recorded as attribution when the transport supplies one. The trust boundary is unchanged and now tested end to end from real unset-identity creation: the first coordinator bind adopts a NULL-creator workflow once, later adoption is refused once any coordinator record exists, and the creator fence plus duplicate-holder/holder-matching gates are untouched.
- `validateExecutionIdentity` gained one explicit registration-only relaxation (`allowUnsetSessionId`): the normalized empty string passes as "unset" for the create path, every other consumer keeps the acquired-identity rule.
- Reworded registration refusals to disclose state and the supported next action.

<!-- CN -->
- **identity-missing 拒绝信息逐字写明供给路径。** 所有因缺少会话身份而拒绝的 active 路由——各种形态的 `plan bind`（coordinator、identity session、稀疏、resume）、`plan show`、稀疏 plan 操作、workflow transitions/evidence/recovery——现在都在拒绝文本中写明供给方式：CLI `--session-id`（或 `MSTAR_HOST_SESSION_ID`），MCP：宿主每次调用传 `sessionId`。ACTIVE 注册拒绝文本随"creator 可选"契约重塑：只有 `expect` 和 `operation` 可能缺失，并说明未设置身份时将注册 NULL creator、由首个 coordinator bind 收养。
- **`mstar doctor --target omp` 现报告真实的插件对齐状态。** doctor 的 `pluginVersionNote` 改由新增的 `detectPluginVersion` 效应提供（CLI 侧复用既有按宿主发现逻辑；omp 走 `omp plugin list`），因此"CLI X 比已安装插件 Y 新——请更新插件：omp plugin install @mstar-harness/omp"的过期插件指引与未安装提示都基于实际探测到的版本，而不是永远声称未找到插件。
- **ACTIVE 注册不再强制会话身份（issue #383c）。** `workflow register` / `iteration.register` 在 ACTIVE DB 路径上接受无会话身份的调用者并写入 NULL `creator_session_id`；传输层提供了显式 id 时仍照常记录为归属。信任边界不变且有端到端回归：首个 coordinator bind 独家收养 NULL-creator 工作流，存在任何 coordinator 记录后再次收养被拒，creator fence 与 duplicate-holder/holder 匹配门禁原样保留。
- `validateExecutionIdentity` 新增仅限注册的显式放宽（`allowUnsetSessionId`）：归一化后的空字符串在创建路径上视为"未设置"，其余所有调用方仍遵守"身份必须显式获取"的规则。
- 改写注册拒绝信息，披露状态及受支持的下一步操作。
