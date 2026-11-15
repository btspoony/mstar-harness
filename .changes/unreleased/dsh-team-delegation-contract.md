---
category: Changed
packages: dsh
---

- **Team delegation contract**: the injected Agent Teams contract now names the real channels — writable work defaults to one durable teammate per writable track (`subagent` / `subagent_fork`, legacy `spawn_teammate`) reused via `send_message`; 1–2 read-only seats default to `subagent`, read-only fan-out of 3+ goes to `workflow`, and a single seat uses a one-seat `workflow` run only when nothing else can carry it.

<!-- CN -->
- **Team 派发契约**：注入的 Agent Teams 契约改为点名真实通道——可写工作默认按可写轨道复用一个耐久 teammate（`subagent` / `subagent_fork`，旧名 `spawn_teammate`），用 `send_message` 复用；1–2 个只读席位默认走 `subagent`，3+ 只读扇出走 `workflow`，单席位只有在别无选择时才用 one-seat `workflow` 运行。
