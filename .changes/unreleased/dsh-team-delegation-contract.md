---
category: Changed
packages: dsh
---

- **Team delegation contract**: the injected Agent Teams contract now names the real channels — writable work defaults to one durable teammate per writable track (`subagent` / `subagent_fork`, legacy `spawn_teammate`) reused via `send_message`; 1–2 read-only seats go to `subagent` only (a fork inherits the conversation), and a 1–2-seat dispatch on a Team-mode root joins the roster, so it is budgeted per track and reused via `send_message`; fan-out of 3+ goes to `workflow`, whose children never join the roster; and a profile that disables the direct `subagent` rows carries read-only work of any size through `workflow`, whose script is chosen by the work.

<!-- CN -->
- **Team 派发契约**：注入的 Agent Teams 契约改为点名真实通道——可写工作默认按可写轨道复用一个耐久 teammate（`subagent` / `subagent_fork`，旧名 `spawn_teammate`），用 `send_message` 复用；1–2 个只读席位只走 `subagent`（fork 继承会话上下文），且 Team-mode root 上的 1–2 席位派发会占用 roster，故按轨道预算并用 `send_message` 复用；3+ 只读扇出走 `workflow`（其子级不入 roster）；直接 `subagent` 行被禁用的 profile 则以 `workflow` 承担任意规模的只读工作（按工作类型选脚本）。
