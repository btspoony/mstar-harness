---
category: Harness
packages: root
---

- **Orchestration skill text is channel-neutral on dsh.** The dispatch, SDD, QC, iteration and PM-role guidance no longer assume the `subagent` tool is the only delegation channel: the transport is selected per work shape — one-shot Assignment → `subagent`; multi-seat / role-persistent / multi-round work → Agent Teams (`spawn_teammate` + task board + `wait_agent` + `send_message`); read-only N≥3 fan-out → `workflow` — with caps and wake semantics left to `mstar-host/references/dsh-agent-teams.md` instead of restated per skill. SDD implementer/reviewer dispatches, tri-review QC seats and the Phase 2 loop now run on the active channel; sticky sessions map to durable teammates resumed by name in Agent Teams mode.
- **Wake discipline is a hard rule in `mstar-iteration`.** On dsh Agent Teams, readiness never starts the owner: completing a blocker does not start it, the Lead must `send_message` (or `reassign` + one message) to start the next seat, and inactive is not completion — plan-row evidence is read before recording done. Phase 2 progression tracks child settle notifications on the native-workflow route without assuming a goal-round loop.

<!-- CN -->
- **dsh 编排技能文本改为通道中立。** 派发、SDD、QC、迭代与 PM 角色指引不再假设 `subagent` 是唯一委派通道：按工作形态选择传输——一次性 Assignment → `subagent`；多席位 / 角色持续 / 多轮工作 → Agent Teams（`spawn_teammate` + 任务板 + `wait_agent` + `send_message`）；只读 N≥3 扇出 → `workflow`——容量与唤醒语义归 `mstar-host/references/dsh-agent-teams.md` 所有，各技能只链接不复述。SDD 实现/评审派发、三审 QC 席位与 Phase 2 循环均在活动通道上运行；sticky 会话在 Agent Teams 模式下映射为按名续接的持久 teammate。
- **唤醒纪律成为 `mstar-iteration` 硬规则。** dsh Agent Teams 上就绪绝不启动归属者：blocker 完成不会启动它，Lead 必须 `send_message`（或 `reassign` + 一条消息）启动下一席位，且 inactive 不是完成——记录 done 前先读 plan 行证据。Phase 2 推进在 native-workflow 路线上跟随子任务 settle 通知，不再假设 goal-round 循环。
