---
category: Changed
packages: omp, commands
---

- Inject the omp session's native identity into eligible Morning Star MCP calls and diagnose a missing ACTIVE-workflow identity injection path.
- **omp now supplies the Morning Star MCP `sessionId` per call (issue #383a).** The new `mcp-identity` extension (registered in `omp.extensions`) revises eligible `mcp__morning_star_mstar_*` `tool_call` inputs to `{ ...input, sessionId: <native id> }`, so a standalone plan workflow chain — `workflow register -> coordinator bind -> plan prepare -> progress` — carries the calling session's identity without the agent passing ids by hand. Eligibility is schema-aware: a tool qualifies only when its declared `ToolInfo.parameters` schema declares `sessionId` (the host revalidates revised inputs, so an undeclared key would be rejected host-side); the name prefix is a prefilter only. Injection is additive-only: an explicit caller id is never overridden, `block` is never set, and the id is read per event from `ctx.sessionManager.getSessionId()`, so leaf sessions carry their own id.

<!-- CN -->
- omp 为符合条件的 Morning Star MCP 调用注入宿主原生会话身份，并在 ACTIVE workflow 身份注入路径缺失时给出诊断指引。
- **omp 现按调用为 Morning Star MCP `sessionId` 供给原生会话 id（issue #383a）。** 新增 `mcp-identity` 扩展（注册进 `omp.extensions`），把符合条件的 `mcp__morning_star_mstar_*` `tool_call` 输入修订为 `{ ...input, sessionId: <原生 id> }`，使独立 plan 工作流链路——`workflow register -> coordinator bind -> plan prepare -> progress`——无需 agent 手工传 id 即可携带调用方身份。资格判定是 schema 感知的：仅当工具声明的 `ToolInfo.parameters` schema 声明了 `sessionId` 才注入（宿主会按 schema 复检修订后的输入，未声明的键会被宿主侧拒绝）；名称前缀只是预过滤。注入仅做增量：不覆盖显式传入的 id，绝不设置 `block`，且每次事件从 `ctx.sessionManager.getSessionId()` 读取，叶子会话携带自己的 id。
