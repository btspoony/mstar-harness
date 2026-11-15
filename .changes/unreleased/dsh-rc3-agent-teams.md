---
packages: root, dsh, engine, commands
---

- **The dsh plugin and host skills now gate and describe the rc.3 Agent Teams surface.** `@mstar-harness/dsh` records the three Team carriers (`team_task_create` / `team_task_update` `description`, `send_message.message`) as non-terminal, so a board write or an inbox acceptance no longer fabricates a delegation outcome; a durable teammate is created by the ordinary `subagent` / `subagent_fork` dispatch (`{ kind: 'activation', name }`, settled only from the child's `subagent/end`), and member identity resolves through the subagent catalog (`namesOf` / `resolveName` / `listDescendants`).
- **Removed with no compatibility shim:** `spawn_teammate`, the Team roster read, the roster-era member-name grammar, the `provisioning` / `failed` live member states, the `{ sent: true }` send result and the `noProgress` wait result. The injected prompt contract, the dispatch and ledger gates, the dsh READMEs and the delegation-channel knowledge note follow; a contract-lint leg refuses the removed carrier name if it reappears in the carrier map or `dsh-agent-teams.md`.
- **Host-detect vocabulary no longer accepts the retired tool.** `ToolSignal` and `mstar host detect --signals` accept only rc.3's dsh channels (`subagent`, `team_task_create`); the removed carrier is now an unknown token with the ordinary usage refusal.

<!-- CN -->
- **dsh 插件与宿主技能现按 rc.3 的 Agent Teams 接口把关与描述。** `@mstar-harness/dsh` 将三个 Team 载体（`team_task_create` / `team_task_update` 的 `description`、`send_message.message`）记录为非终结载体，任务板写入与 inbox 接收不再伪造委派结果；durable teammate 由普通 `subagent` / `subagent_fork` 派发创建（`{ kind: 'activation', name }`，仅由子 agent 的 `subagent/end` 结算），成员身份经 subagent catalog（`namesOf` / `resolveName` / `listDescendants`）解析。
- **无兼容层的删除项：** `spawn_teammate`、Team roster 读取、roster 时代的成员命名文法、`provisioning` / `failed` 两个在线成员状态、`{ sent: true }` 发送结果与 `noProgress` 等待结果。注入的提示契约、派发与台账闸门、dsh 的两份 README、委派通道知识笔记随之更新；contract-lint 新增一条负向腿，被移除的载体名一旦重新出现在载体映射或 `dsh-agent-teams.md` 中即拒绝。
- **宿主检测词表不再接受已移除的工具。** `ToolSignal` 与 `mstar host detect --signals` 只接受 rc.3 的 dsh 通道（`subagent`、`team_task_create`）；被移除的载体现在是未知 token，走既有的 usage 拒绝。
