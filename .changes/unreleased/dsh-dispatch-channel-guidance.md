---
category: Harness
packages: root
---

- Added a front-loaded **delegation-channel decision** to `mstar-host/references/dsh.md`: read the live toolset (not the profile name) before delegating, because an Agent Teams profile and an agent preset that re-inserts `subagent` can be mounted at the same time.
- Corrected the claim that the shipped Team profile exposes exactly one direct-delegation surface, and stated that `list_agents` / `send_message` / `interrupt_agent` resolve roster targets only — a `subagent` child refuses with `TEAM_MEMBER_NOT_FOUND`.

<!-- CN -->
- 在 `mstar-host/references/dsh.md` 前置**派发通道选择**：先读实况工具集而非 profile 名，因为 Agent Teams profile 与重新插入 `subagent` 的 agent preset 可能同时挂载。
- 纠正「shipped Team profile 只暴露一个直接派发面」的断言，并说明 `list_agents` / `send_message` / `interrupt_agent` 只解析 roster 目标 —— 对 `subagent` 子会话会以 `TEAM_MEMBER_NOT_FOUND` 拒绝。
