---
category: Harness
packages: root
---

- Added a front-loaded **delegation-channel decision** to `mstar-host/references/dsh.md`: read the live toolset (not the profile name) before delegating, because an Agent Teams profile and an agent preset that re-inserts `subagent` can be mounted at the same time.
- Corrected the claim that the shipped Team profile exposes exactly one direct-delegation surface: a preset layered after it can re-insert the direct rows, so the channel table now reads the live toolset. On a profile that mounts the Team layer, `list_agents` / `send_message` / `interrupt_agent` resolve roster targets only and a `subagent` child refuses with `TEAM_MEMBER_NOT_FOUND`; on a direct-only profile those same names reach the child (`send_message` takes `agent_id`).

<!-- CN -->
- 在 `mstar-host/references/dsh.md` 前置**派发通道选择**：先读实况工具集而非 profile 名，因为 Agent Teams profile 与重新插入 `subagent` 的 agent preset 可能同时挂载。
- 纠正「shipped Team profile 只暴露一个直接派发面」的断言：在其后叠加的 preset 可重新插入直接派发行，因此通道表改为读取实况工具集。**挂载 Team 层**时，`list_agents` / `send_message` / `interrupt_agent` 只解析 roster 目标，对 `subagent` 子会话会以 `TEAM_MEMBER_NOT_FOUND` 拒绝；**仅挂 direct 层**时，同样三个名字可直达子会话（`send_message` 取 `agent_id`）。
